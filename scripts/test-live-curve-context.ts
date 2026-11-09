import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as curve from '../apps/web/src/live-curve.ts'
import { curveValue, displayNumber } from '../apps/web/src/physical-value.ts'
import { sourceKey, withRegisterSources } from '../packages/core/src/sample-source.ts'
import { decodeRegister, encodeRegister } from '../packages/core/src/codec.ts'
import { historyVerificationLabel } from '../packages/core/src/history-integrity.ts'
import { nearestHistorySample } from '../apps/web/src/history-curve.ts'
import { evaluateLivePoints } from '../apps/web/src/live-point-filter.ts'
import { captureLiveSnapshot, liveSnapshotJson } from '../apps/web/src/live-snapshot.ts'

// Execute actual LiveCurve render expressions and interval/button callbacks with local inputs.
// No browser, network, timers, storage, driver or hardware is created.
const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function find(node: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node | undefined {
  if (predicate(node)) return node
  let result: ts.Node | undefined
  ts.forEachChild(node, child => { result ??= find(child, predicate) })
  return result
}
const component = find(source, node => ts.isFunctionExpression(node) && node.name?.text === 'LiveCurve')!
assert(component)
const declaration = (name: string) => (find(component, node => ts.isVariableDeclaration(node) && node.name.getText(source) === name) as ts.VariableDeclaration).initializer!
const interval = find(component, node => ts.isCallExpression(node) && node.expression.getText(source) === 'setInterval') as ts.CallExpression
const button = find(component, node => ts.isArrowFunction(node) && node.getText(source).includes('setFrozen(frozen ? null : frame)'))!
const evaluate = (node: ts.Node, env: Record<string, unknown>) => new Function(...Object.keys(env), ts.transpileModule('return (' + node.getText(source) + ')', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React } }).outputText)(...Object.values(env))
const now = 1800000000000
const device = { id: 1, isActive: true, mode: 'master' }
const register = { id: 7, groupId: 9, startAddress: 0, functionCode: 3, dataType: 'uint16' }
const group = { id: 9, startAddress: 0, quantity: 2, functionCode: 3, slaveId: 1, isActive: true, registers: [register] }
const chosenFor = (slaveId: number) => withRegisterSources([register], [{ ...group, slaveId }], device)
const values = (slaveId: number, value: number, time = now, objectId = 1) => ({ [sourceKey(objectId, 'holding-register', 0, slaveId)]: { rawValue: value, slaveId, quality: 'good', timestamp: new Date(time).toISOString(), batchId: 'batch-' + slaveId + '-' + time } })
const initial = curve.sampleCurve({}, chosenFor(1), values(1, 111), 1, now, 5000, new Set())
type Frame = { buffer: curve.CurveBuffer; now: number }
function render(visible: Frame, chosen = chosenFor(1), objectId = 1, cursorTime: number | null = null) {
  const env: Record<string, unknown> = { visible, chosen, device: { ...device, id: objectId }, startTime: visible.now - 60000, endTime: visible.now, curveValue, displayNumber, valueMode: 'raw', CHART_COLORS: ['red'], curveTrackFor: (curve as any).curveTrackFor, curveDisplayPoints: curve.curveDisplayPoints }
  // The optional declarations are introduced by the fix; before-fix uses raw visible.buffer.
  for (const name of ['visibleBuffer', 'displayTracks', 'timeReordered', 'sourceChanged']) { const node = find(component, node => ts.isVariableDeclaration(node) && node.name.getText(source) === name) as ts.VariableDeclaration | undefined; if (node) env[name] = evaluate(node.initializer!, env) }
  const series = evaluate(declaration('series'), env)
  const readings = evaluate(declaration('liveReadings'), { ...env, series, cursorTime, threshold: 5000, pointLabels: new Map([[7, { name: 'current source' }]]) })
  return { series, readings, sourceChanged: env.sourceChanged, timeReordered: env.timeReordered }
}
let count = 0
function check(name: string, fn: () => void) { fn(); count++; console.log('OK ' + name) }
check('unchanged source remains readable', () => {
  const view = render({ buffer: initial, now })
  assert.deepEqual(view.series[0].points, [[now, 111]])
  assert.equal(view.readings[0].value, '111')
})
check('source switch hides old curve AND cursor before next timer tick', () => {
  const view = render({ buffer: initial, now }, chosenFor(2))
  assert.deepEqual(view.series[0].points, [], 'slave 2 must not display the frozen slave 1 value 111')
  assert.equal(view.readings[0].value, '—')
  assert.equal(view.readings[0].point, null)
  assert.equal(view.sourceChanged, true)
})
check('freeze, source change, background tick, resume and valid new frame', () => {
  let frame: Frame = { buffer: initial, now }, frozen: Frame | null = null
  const press = () => evaluate(button, { frame, frozen, setFrozen: (value: Frame | null) => { frozen = value }, setHover: () => {} })()
  press(); assert.equal(frozen, frame)
  const buffer = { current: initial }, inputs = { current: { chosen: chosenFor(2), latest: values(2, 222, now + 250), device, groups: [{ ...group, slaveId: 2 }], groupErrors: {}, threshold: 5000, active: true, frozen } }
  const tick = () => evaluate(interval.arguments[0], { inputs, buffer, sampleCurve: curve.sampleCurve, Date: { now: () => now + 250 }, document: { visibilityState: 'visible' }, setFrame: (value: Frame) => { frame = value } })()
  tick(); assert.equal(buffer.current[7].points.at(-1)?.[1], 222)
  const visible = () => evaluate(declaration('visible'), { frozen, frame }) as Frame
  assert.deepEqual(render(visible(), chosenFor(2)).series[0].points, [])
  press(); inputs.current.frozen = frozen
  assert.deepEqual(render(visible(), chosenFor(2)).series[0].points, [], 'resume cannot briefly expose the old published frame')
  tick(); const view = render(visible(), chosenFor(2))
  assert.deepEqual(view.series[0].points, [[now + 250, 222]])
  assert.equal(view.readings[0].value, '222')
  assert.equal(view.sourceChanged, false)
})
check('area, address, type and logical device changes invalidate both display paths', () => {
  for (const change of [{ functionCode: 4 }, { startAddress: 1 }, { dataType: 'int16' }]) {
    const view = render({ buffer: initial, now }, [{ ...chosenFor(1)[0], ...change }])
    assert.deepEqual(view.series[0].points, []); assert.equal(view.readings[0].value, '—')
  }
  const other = render({ buffer: initial, now }, chosenFor(1), 2)
  assert.deepEqual(other.series[0].points, []); assert.equal(other.readings[0].value, '—')
  const view = find(source, node => ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'DeviceView') as ts.JsxSelfClosingElement
  const key = view.attributes.properties.find(node => ts.isJsxAttribute(node) && node.name.getText(source) === 'key') as ts.JsxAttribute
  assert.equal(evaluate((key.initializer as ts.JsxExpression).expression!, { selected: { id: 2 } }), 2, 'actual device view is keyed by logical device')
})
check('sampler isolates devices and late old-source data, clear does not replay', () => {
  const other = curve.sampleCurve(initial, chosenFor(1), values(1, 333, now + 250, 2), 2, now + 250, 5000, new Set())
  assert.deepEqual(other[7].points, [[now + 250, 333]], 'sampler cannot carry device 1 history into device 2')
  const changed = curve.sampleCurve(initial, chosenFor(2), values(1, 444, now + 250), 1, now + 250, 5000, new Set())
  assert.deepEqual(changed[7].points, [], 'late slave 1 sample cannot fill slave 2')
  const recovered = curve.sampleCurve(changed, chosenFor(2), values(2, 222, now + 500), 1, now + 500, 5000, new Set())
  const cleared = { 7: { ...recovered[7], points: [] } }
  assert.deepEqual(curve.sampleCurve(cleared, chosenFor(2), values(2, 222, now + 500), 1, now + 750, 5000, new Set())[7].points, [])
  assert.deepEqual(initial[7].points, [[now, 111]], 'paused history remains immutable')
})
check('mismatched source does not discard another matching track', () => {
  const second = { ...chosenFor(1)[0], id: 8 }
  const both = curve.sampleCurve({}, [chosenFor(1)[0], second], values(1, 111), 1, now, 5000, new Set())
  const view = render({ buffer: both, now }, [chosenFor(2)[0], second])
  assert.deepEqual(view.series.map((s: any) => s.points), [[], [[now, 111]]])
  assert.deepEqual(view.readings.map((r: any) => r.value), ['—', '111'])
})
check('actual bilingual status explains hidden frozen tracks without claiming recovery', () => {
  const messageNode = (find(source, node => ts.isVariableDeclaration(node) && node.name.getText(source) === 'I18N') as ts.VariableDeclaration).initializer!
  assert(!find(messageNode, ts.isCallExpression))
  const messages = evaluate(messageNode, {})
  const notice = find(component, node => ts.isBinaryExpression(node) && node.left.getText(source) === 'sourceChanged' && node.getText(source).includes("t('curveSourceChanged')"))!
  assert(notice)
  for (const lang of ['zh', 'en']) {
    const text = messages[lang].curveSourceChanged
    const html = renderToStaticMarkup(evaluate(notice, { sourceChanged: true, React, t: (key: string) => messages[lang][key] }))
    assert(html.includes('role="status"')); assert(html.includes(text))
    assert.equal(renderToStaticMarkup(evaluate(notice, { sourceChanged: false, React, t: () => { throw Error('hidden notice must not translate') } })), '')
    assert(/暂停|frozen/.test(text)); assert(/隐藏|hidden/.test(text))
  }
})
check('missing, bad quality, stale data and valid zero remain distinct from a fabricated zero', () => {
  const chosen = chosenFor(1), zero = curve.sampleCurve({}, chosen, values(1, 0), 1, now, 5000, new Set())
  assert.equal(render({ buffer: zero, now }).readings[0].value, '0')
  for (const [label, latest, at] of [
    ['missing', {}, now],
    ['bad quality', Object.fromEntries(Object.entries(values(1, 0)).map(([key, value]) => [key, { ...value, quality: 'bad' }])), now],
    ['stale', values(1, 0), now + 5001]
  ] as const) {
    const buffer = curve.sampleCurve({}, chosen, latest, 1, at, 5000, new Set())
    assert.deepEqual(buffer[7].points, [], label); assert.equal(render({ buffer, now: at }).readings[0].value, '—', label)
  }
  const blocked = curve.sampleCurve(zero, chosen, values(1, 0, now + 250), 1, now + 250, 5000, new Set([7]))
  assert.deepEqual(blocked[7].points, [[now, 0], [now + 250, null]]); assert.equal(render({ buffer: blocked, now: now + 250 }).readings[0].value, '—')
})
check('isolated valid zero before and after a quality gap has a visible SVG marker', () => {
  const chosen = chosenFor(1), first = curve.sampleCurve({}, chosen, values(1, 0), 1, now, 5000, new Set())
  const bad = Object.fromEntries(Object.entries(values(1, 0, now + 250)).map(([key, value]) => [key, { ...value, quality: 'bad' }]))
  const gap = curve.sampleCurve(first, chosen, bad, 1, now + 250, 5000, new Set()), recovered = curve.sampleCurve(gap, chosen, values(1, 0, now + 500), 1, now + 500, 5000, new Set())
  assert.deepEqual(recovered[7].points, [[now, 0], [now + 250, null], [now + 500, 0]])
  const view = render({ buffer: recovered, now: now + 500 }); assert.equal(view.readings[0].value, '0')
  const drawn = find(component, node => ts.isCallExpression(node) && node.expression.getText(source) === 'series.map' && node.getText(source).includes('data-live-series'))!
  const env = { React, series: view.series, threshold: 5000, x: (time: number) => time - now, y: (value: number) => value, isolatedCurvePoints: (curve as any).isolatedCurvePoints }
  const markerPathFor = evaluate(declaration('markerPathFor'), env)
  const svg = renderToStaticMarkup(React.createElement('svg', null, evaluate(drawn, { ...env, markerPathFor, pathFor: evaluate(declaration('pathFor'), env) })))
  assert(!/d="[^"]*L/.test(svg), 'null gaps stay unconnected')
  const markerPath = /data-live-markers="7" d="([^"]*)"/.exec(svg)?.[1]; assert(markerPath)
  assert.equal((markerPath.match(/M/g) ?? []).length, 2, 'each isolated zero must have its own visible marker shape')
  assert.equal((markerPath.match(/a3,3/g) ?? []).length, 4, 'two semicircles per marker, without connecting the gap')
  const dense = Array.from({ length: 2400 }, (_, i) => [now + i, i % 2 ? null : 0] as [number, number | null])
  const denseSvg = renderToStaticMarkup(React.createElement('svg', null, evaluate(drawn, { ...env, series: [{ ...view.series[0], points: dense }], markerPathFor, pathFor: evaluate(declaration('pathFor'), env) })))
  assert.equal((denseSvg.match(/<path/g) ?? []).length, 2, 'marker DOM remains bounded even with 1200 isolated points')
  assert.equal((markerPathFor(dense).match(/Z/g) ?? []).length, 1200)
})
check('hover preserves zero, never bridges quality gaps or stale/source-mismatched readings', () => {
  const chosen = chosenFor(1), first = curve.sampleCurve({}, chosen, values(1, 0), 1, now, 5000, new Set())
  const bad = Object.fromEntries(Object.entries(values(1, 0, now + 250)).map(([key, value]) => [key, { ...value, quality: 'bad' }]))
  const gap = curve.sampleCurve(first, chosen, bad, 1, now + 250, 5000, new Set()), recovered = curve.sampleCurve(gap, chosen, values(1, 2, now + 500), 1, now + 500, 5000, new Set())
  for (const [time, value] of [[now - 1, '—'], [now, '0'], [now + 100, '0'], [now + 250, '—'], [now + 400, '—'], [now + 500, '2']] as const) {
    const reading = render({ buffer: recovered, now: now + 500 }, chosen, 1, time).readings[0]
    assert.equal(reading.value, value); assert.equal(reading.point === null, value === '—'); if (value === '0') assert.deepEqual(reading.point, [now, 0])
  }
  assert.equal(render({ buffer: recovered, now: now + 6000 }, chosen, 1, now + 6000).readings[0].value, '—')
  const switched = render({ buffer: recovered, now: now + 500 }, chosenFor(2), 1, now)
  assert.equal(switched.readings[0].value, '—'); assert.deepEqual(switched.series[0].points, []); assert.equal(curve.isolatedCurvePoints(switched.series[0].points, 5000).length, 0)
})
check('distinct batches at identical zero coordinates still have one visible marker', () => {
  const chosen = chosenFor(1), first = curve.sampleCurve({}, chosen, values(1, 0), 1, now, 5000, new Set())
  const later = Object.fromEntries(Object.entries(values(1, 0)).map(([key, value]) => [key, { ...value, batchId: 'distinct-coincident-response' }]))
  const buffer = curve.sampleCurve(first, chosen, later, 1, now + 250, 5000, new Set())
  assert.deepEqual(buffer[7].points, [[now, 0], [now, 0]], 'both response observations are retained')
  assert.equal(render({ buffer, now: now + 250 }).readings[0].value, '0')
  assert.deepEqual(curve.isolatedCurvePoints(buffer[7].points, 5000), [[now, 0]], 'a zero-length connected run needs a marker, without duplicating coincident dots')
})
check('maximum selected series keep marker nodes bounded and construction measurable', () => {
  const zero = curve.sampleCurve({}, chosenFor(1), values(1, 0), 1, now, 5000, new Set()), view = render({ buffer: zero, now: now + 2400 })
  const dense = Array.from({ length: 2400 }, (_, i) => [now + i, i % 2 ? null : 0] as [number, number | null])
  const series = Array.from({ length: 8 }, (_, i) => ({ ...view.series[0], r: { ...view.series[0].r, id: 7 + i }, points: dense }))
  const env = { React, series, threshold: 5000, x: (time: number) => time - now, y: (value: number) => value, isolatedCurvePoints: curve.isolatedCurvePoints }
  const markerPathFor = evaluate(declaration('markerPathFor'), env), elapsed: number[] = []; let encoded: string[] = []
  for (let i = 0; i < 3; i++) { const start = performance.now(); encoded = series.map(s => markerPathFor(s.points)); elapsed.push(Number((performance.now() - start).toFixed(2))) }
  const drawn = find(component, node => ts.isCallExpression(node) && node.expression.getText(source) === 'series.map' && node.getText(source).includes('data-live-series'))!
  const svg = renderToStaticMarkup(React.createElement('svg', null, evaluate(drawn, { ...env, markerPathFor, pathFor: evaluate(declaration('pathFor'), env) })))
  assert.equal((svg.match(/<path/g) ?? []).length, 16); assert.equal(encoded.reduce((n, path) => n + (path.match(/Z/g) ?? []).length, 0), 9600)
  assert.deepEqual(curve.isolatedCurvePoints(Array.from({ length: 2400 }, () => [now, 0] as const), 5000), [[now, 0]], 'coincident runs do not create 2400 overlapping markers')
  console.log('LIVE CURVE MARKER COST:', JSON.stringify({ points: 19200, markerShapes: 9600, seriesPaths: 16, markerBytes: encoded.reduce((n, path) => n + Buffer.byteLength(path), 0), constructionMs: elapsed, scope: 'synthetic Node path construction, not browser paint or peak memory' }))
})
check('tiny nonzero ticks and illegal tick values are never labelled zero', () => {
  const functions = Object.fromEntries(['niceStep', 'yTicks', 'tickNum'].map(name => [name, find(source, node => ts.isFunctionDeclaration(node) && node.name?.text === name)!]))
  const niceStep = evaluate(functions.niceStep, {}), yTicks = evaluate(functions.yTicks, { niceStep }), tickNum = evaluate(functions.tickNum, {})
  assert.notEqual(tickNum(1e-12), '0', 'a small finite nonzero tick must retain its magnitude')
  assert.notEqual(tickNum(-1e-12), '0'); assert.equal(tickNum(0), '0')
  for (const value of [NaN, Infinity, -Infinity]) assert.equal(tickNum(value), '—')
  for (const [min, max] of [[0, 2e-12], [Number.MIN_VALUE, Number.MIN_VALUE * 2], [-Number.MAX_VALUE, Number.MAX_VALUE]]) {
    const ticks = yTicks(min, max, 5) as number[]; assert(ticks.length > 0 && ticks.length <= 100); assert(ticks.every(Number.isFinite)); assert(ticks.some(value => value !== 0))
  }
  assert.deepEqual(yTicks(NaN, 1, 5), []); assert.deepEqual(yTicks(0, 1, 1000000), [])
  assert.notEqual(Number(displayNumber(1e-12)), 0); assert.equal(curveValue(NaN, { dataType: 'uint16', factor: 0 }, 'physical'), null); assert.equal(curveValue(Infinity, { dataType: 'uint16', factor: 0 }, 'physical'), null)
})
check('overflowing live/history scales fail visibly without emitting invalid SVG geometry', () => {
  const math = (body: ts.Block, first: string, last: string, env: Record<string, unknown>, result: string) => {
    const declares = (statement: ts.Statement, name: string) => ts.isVariableStatement(statement) && statement.declarationList.declarations.some(d => d.name.getText(source) === name)
    const start = body.statements.findIndex(s => declares(s, first)), guard = body.statements.findIndex(s => declares(s, 'scaleValid')), fallback = body.statements.findIndex(s => declares(s, last))
    assert(start >= 0 && fallback >= 0)
    const code = body.statements.slice(start, (guard >= 0 ? guard : fallback) + 1).map(s => s.getText(source)).join('\n') + '\nreturn {' + result + ', renderable: typeof scaleValid === "undefined" ? true : scaleValid};'
    return new Function(...Object.keys(env), ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText)(...Object.values(env))
  }
  const points: Array<[number, number | null]> = [[now, -Number.MAX_VALUE], [now + 1, Number.MAX_VALUE]]
  const live = math((component as ts.FunctionExpression).body, 'low', 'y', { series: [{ points }], size: { w: 800, h: 360 }, startTime: now - 60000, endTime: now }, 'low, high, y')
  assert.equal(live.renderable, false, 'overflowing live bounds must not be silently plotted')
  for (const values of [[0], [0, 1e-12]]) { const safe = math((component as ts.FunctionExpression).body, 'low', 'y', { series: [{ points: values.map((value, i) => [now + i, value]) }], size: { w: 800, h: 360 }, startTime: now - 60000, endTime: now }, 'low, high, y'); assert.equal(safe.renderable, true); assert(values.every(value => Number.isFinite(safe.y(value)))) }
  const historical = find(source, node => ts.isFunctionDeclaration(node) && node.name?.text === 'ChartBody') as ts.FunctionDeclaration
  const env = { visibleSeries: [{ id: 1, samples: points, min: -Number.MAX_VALUE, max: Number.MAX_VALUE }], hidden: new Set(), yView: null, relative: false, T: 16, ph: 300 }
  for (const relative of [false, true]) assert.equal(math(historical.body!, 'minimum', 'displayValue', { ...env, relative }, 'yMin, yMax, y').renderable, false)
  const manual = { ...env, yView: { min: -1, max: 1 } }; assert.equal(math(historical.body!, 'minimum', 'displayValue', manual, 'yMin, yMax, y').renderable, false)
  const safeHistory = { ...env, visibleSeries: [{ id: 1, min: 0, max: 1e-12 }] }; assert.equal(math(historical.body!, 'minimum', 'displayValue', safeHistory, 'yMin, yMax, y').renderable, true)
  const constantRelative = { ...env, relative: true, visibleSeries: [{ id: 1, min: Number.MAX_VALUE, max: Number.MAX_VALUE }] }; assert.equal(math(historical.body!, 'minimum', 'displayValue', constantRelative, 'yMin, yMax, y').renderable, true)
  const combined = [
    { id: 7, samples: [[now, 0], [now + 1, 1e-12]], min: 0, max: 1e-12, gapMs: 5000, color: 'red', verification: [[now, 'verified'], [now + 1, 'verified']] },
    { id: 8, samples: [[now, Number.MAX_VALUE], [now + 1, Number.MAX_VALUE]], min: Number.MAX_VALUE, max: Number.MAX_VALUE, gapMs: 5000, color: 'blue', verification: [[now, 'verified'], [now + 1, 'verified']] }
  ], original = structuredClone(combined)
  let relative = false, currentYView: { min: number; max: number } | null = { min: -1, max: 1 }
  const toggle = find(historical, node => ts.isArrowFunction(node) && node.getText(source).includes('setRelative(e.target.checked)'))!
  const press = evaluate(toggle, { setRelative(value: boolean) { relative = value }, setYView(value: typeof currentYView) { currentYView = value } })
  const historicalValue = (name: string) => (find(historical, node => ts.isVariableDeclaration(node) && node.name.getText(source) === name) as ts.VariableDeclaration).initializer!
  const reading = evaluate(historicalValue('reading'), { displayNumber, valueMode: 'raw' })
  const rowsFor = (hidden: Set<number>) => evaluate(historicalValue('readoutRows'), { visibleSeries: combined, hidden, registers: [{ id: 7 }, { id: 8 }], hover: null, reading, pointLabels: new Map([[7, { name: 'tiny' }], [8, { name: 'extreme' }]]), historyVerificationLabel, nearestHistorySample })
  for (const value of [false, true, false]) {
    press({ target: { checked: value } }); assert.equal(currentYView, null, 'actual relative toggle clears a prior manual Y viewport')
    assert.equal(math(historical.body!, 'minimum', 'displayValue', { ...env, visibleSeries: combined, relative, yView: currentYView }, 'yMin, yMax, y').renderable, value)
    const rows = rowsFor(new Set()); assert(rows[0].value.startsWith(displayNumber(1e-12) + ' [')); assert(rows[1].value.startsWith(displayNumber(Number.MAX_VALUE) + ' ['))
  }
  const hidden = new Set([8]); assert.equal(math(historical.body!, 'minimum', 'displayValue', { ...env, visibleSeries: combined, hidden }, 'yMin, yMax, y').renderable, true); assert.equal(rowsFor(hidden).length, 1)
  assert.deepEqual(combined, original, 'range protection/toggle/legend exclusion never rewrites source samples or verification')
  const floating = { ...register, alias: 'extreme snapshot', dataType: 'float64' }, floatGroups = [{ ...group, name: 'synthetic float', isActive: 1, quantity: 4, registers: [floating] }]
  const floatChosen = (slaveId: number) => withRegisterSources([floating], floatGroups.map(g => ({ ...g, slaveId })), device)
  const floatLatest = (value: number, slaveId: number, at: number) => Object.fromEntries(encodeRegister('float64', value).map((rawValue, i) => [sourceKey(1, 'holding-register', i, slaveId), { rawValue, slaveId, quality: 'good', timestamp: new Date(at).toISOString(), batchId: 'float-' + slaveId }]))
  const latest = floatLatest(Number.MAX_VALUE, 1, now), buffer = curve.sampleCurve({}, floatChosen(1), latest, 1, now, 5000, new Set()), saved = structuredClone(buffer), displayed = render({ buffer, now }, floatChosen(1))
  assert.equal(math((component as ts.FunctionExpression).body, 'low', 'y', { series: displayed.series, size: { w: 800, h: 360 }, startTime: now - 60000, endTime: now }, 'low, high, y').renderable, false)
  assert.equal(displayed.readings[0].value, displayNumber(Number.MAX_VALUE))
  const snapshotDevice = { ...device, isActive: 1, name: 'synthetic numeric snapshot' }, views = new Map([[7, { value: displayed.readings[0].value as string, label: null, covered: false, invalid: false }]])
  const capture = captureLiveSnapshot({ device: snapshotDevice, groups: floatGroups, latest, views, states: evaluateLivePoints(floatGroups, views, latest, snapshotDevice, [], {}, now, 5000), visibleIds: new Set([7]), filters: { search: '', source: '', mode: 'all' }, rulesReady: false, observedAt: now, capturedAt: now, thresholdMs: 5000 })
  const json = JSON.parse(liveSnapshotJson(capture)); assert.equal(json.points[0].display.raw, displayNumber(Number.MAX_VALUE)); assert.equal(decodeRegister('float64', json.points[0].words.map((word: any) => word.sample.rawValue)), Number.MAX_VALUE); assert.equal(json.automaticEligible, false)
  const switched = render({ buffer, now }, floatChosen(2)); assert.deepEqual(switched.series[0].points, []); assert.equal(switched.readings[0].value, '—')
  const switchedScale = math((component as ts.FunctionExpression).body, 'low', 'y', { series: switched.series, size: { w: 800, h: 360 }, startTime: now - 60000, endTime: now }, 'hasData, y'); assert.equal(switchedScale.renderable, true); assert.equal(switchedScale.hasData, false, 'new source without samples must not retain the old extreme-range failure')
  const recovered = curve.sampleCurve(buffer, floatChosen(2), floatLatest(0, 2, now + 250), 1, now + 250, 5000, new Set()); assert.equal(render({ buffer: recovered, now: now + 250 }, floatChosen(2)).readings[0].value, '0'); assert.deepEqual(buffer, saved)
  console.log('CURVE SCALE COMPOSITION OK: absolute/relative/manual reset, hidden extreme with zero/tiny data, preserved readouts/JSON words, source switch and valid-zero recovery; synthetic callbacks only.')
  const dictionary = evaluate((find(source, node => ts.isVariableDeclaration(node) && node.name.getText(source) === 'I18N') as ts.VariableDeclaration).initializer!, {})
  for (const owner of [component, historical]) {
    const gate = find(owner, node => ts.isConditionalExpression(node) && node.condition.getText(source) === 'scaleValid' && node.getText(source).includes("t('curveScaleUnavailable')")); assert(gate)
    for (const lang of ['zh', 'en']) { const html = renderToStaticMarkup(evaluate(gate, { scaleValid: false, React, t: (key: string) => dictionary[lang][key] })); assert(html.includes('role="status"')); assert(!/<svg|<path|<circle/.test(html)); assert(html.includes(dictionary[lang].curveScaleUnavailable)) }
  }
})
check('delayed recovery keeps a later unknown marker effective for hover and line breaks', () => {
  const chosen = chosenFor(1), first = curve.sampleCurve({}, chosen, values(1, 0), 1, now, 5000, new Set())
  const bad = Object.fromEntries(Object.entries(values(1, 0, now + 1000)).map(([key, value]) => [key, { ...value, quality: 'bad' }]))
  const gap = curve.sampleCurve(first, chosen, bad, 1, now + 2000, 5000, new Set())
  const delayed = curve.sampleCurve(gap, chosen, values(1, 2, now + 1500), 1, now + 2250, 5000, new Set())
  const recovered = curve.sampleCurve(delayed, chosen, values(1, 3, now + 2500), 1, now + 2500, 5000, new Set()), original = structuredClone(recovered)
  assert.deepEqual(recovered[7].points, [[now, 0], [now + 2000, null], [now + 1500, 2], [now + 2500, 3]], 'arrival records retain their original timestamps/order')
  const view = render({ buffer: recovered, now: now + 2500 }, chosen, 1, now + 2100)
  assert.equal(view.readings[0].value, '—', 'a late older sample must not overwrite the later-in-time unknown interval')
  assert.deepEqual(view.series[0].points, [[now, 0], [now + 1500, null], [now + 1500, 2], [now + 2000, null], [now + 2500, 3]], 'chronological view retains both original quality breaks and later unknown markers')
  const path = evaluate(declaration('pathFor'), { threshold: 5000, x: (time: number) => time - now, y: (value: number) => value })(view.series[0].points)
  assert(!path.includes('L'), 'sorting must not reconnect observations separated by the original quality break')
  assert.equal(render({ buffer: recovered, now: now + 2500 }, chosen, 1, now + 1750).readings[0].value, '2')
  assert.equal(render({ buffer: recovered, now: now + 2500 }, chosen, 1, now + 2500).readings[0].value, '3'); assert.deepEqual(recovered, original)
  assert.equal(view.timeReordered, true)
  const notice = find(component, node => ts.isBinaryExpression(node) && node.left.getText(source) === 'timeReordered' && node.getText(source).includes("t('curveTimeReordered')"))!
  const dictionary = evaluate((find(source, node => ts.isVariableDeclaration(node) && node.name.getText(source) === 'I18N') as ts.VariableDeclaration).initializer!, {})
  for (const language of ['zh', 'en']) { const html = renderToStaticMarkup(evaluate(notice, { React, timeReordered: true, t: (key: string) => dictionary[language][key] })); assert(html.includes('role="status"')); assert(/不等同设备故障|does not establish a device fault/.test(html)) }
})
console.log('LIVE CURVE CONTEXT OK: ' + count + ' actual-render/synthetic-event groups; no browser or hardware')
