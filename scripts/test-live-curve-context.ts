import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as curve from '../apps/web/src/live-curve.ts'
import { curveValue, displayNumber } from '../apps/web/src/physical-value.ts'
import { sourceKey, withRegisterSources } from '../packages/core/src/sample-source.ts'

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
function render(visible: Frame, chosen = chosenFor(1), objectId = 1) {
  const env: Record<string, unknown> = { visible, chosen, device: { ...device, id: objectId }, startTime: visible.now - 60000, endTime: visible.now, curveValue, displayNumber, valueMode: 'raw', CHART_COLORS: ['red'], curveTrackFor: (curve as any).curveTrackFor }
  // The optional declarations are introduced by the fix; before-fix uses raw visible.buffer.
  for (const name of ['visibleBuffer', 'sourceChanged']) { const node = find(component, node => ts.isVariableDeclaration(node) && node.name.getText(source) === name) as ts.VariableDeclaration | undefined; if (node) env[name] = evaluate(node.initializer!, env) }
  const series = evaluate(declaration('series'), env)
  const readings = evaluate(declaration('liveReadings'), { ...env, series, cursorTime: null, threshold: 5000, pointLabels: new Map([[7, { name: 'current source' }]]) })
  return { series, readings, sourceChanged: env.sourceChanged }
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
console.log('LIVE CURVE CONTEXT OK: ' + count + ' actual-render/synthetic-event groups; no browser or hardware')
