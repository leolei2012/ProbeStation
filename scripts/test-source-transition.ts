import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as codec from '../packages/core/src/codec.ts'
import { sameResponseBatch } from '../packages/core/src/sample-batch.ts'
import { sourceKey, configuredSourceSample as sourceSample, sourceSample as legacySourceSample, validSlaveId, withRegisterSources } from '../packages/core/src/sample-source.ts'
import { displayNumber, physicalValue } from '../apps/web/src/physical-value.ts'
import { evaluateLivePoints, livePointFilterResult } from '../apps/web/src/live-point-filter.ts'
import { pickerSources } from '../apps/web/src/register-picker.ts'
import { pointHealth, sampleTime } from '../apps/web/src/observation.ts'
import { readDeviceGroups } from '../apps/web/src/config-read.ts'
import { captureLiveSnapshot, downloadLiveSnapshot, liveSnapshotJson } from '../apps/web/src/live-snapshot.ts'
import { LiveSnapshotPanel } from '../apps/web/src/LiveSnapshotPanel.tsx'
import { LivePointFilters } from '../apps/web/src/LivePointFilters.tsx'
import { readPointAlarmObservation } from '../apps/web/src/alarm-value.ts'
import { alarmHistoryState } from '../apps/web/src/alarm-history.ts'
import { HistoryNavigation, historyPointSourceKey } from '../apps/web/src/history-navigation.ts'
import { historyQueryPlan } from '../apps/web/src/history-query-task.ts'
import { captureHistoryExport, downloadHistoryExport, HistoryExportContextChangedError } from '../apps/web/src/history-export.ts'
import { historyReadContextKey } from '../apps/web/src/history-read-context.ts'

// Actual UI expressions with controlled configuration/cache/callbacks; no App mount,
// fetch, WebSocket, timers, listener, store, hardware, physical file download or model.
const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function find(node: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node | undefined { if (predicate(node)) return node; let result: ts.Node | undefined; ts.forEachChild(node, child => { result ??= find(child, predicate) }); return result }
const evaluate = (node: ts.Node, env: Record<string, unknown>) => new Function(...Object.keys(env), ts.transpileModule('return (' + node.getText(source) + ')', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React } }).outputText)(...Object.values(env))
const declaration = (name: string) => (find(source, node => ts.isFunctionDeclaration(node) && node.name?.text === name) as ts.FunctionDeclaration)
const buildViews = new Function('sourceSample', 'sameResponseBatch', 'displayNumber', 'physicalValue', ...Object.keys(codec), ts.transpileModule(['areaForFunctionCode', 'enumLabelOf', 'buildRegViews'].map(name => declaration(name).getText(source)).join('\n') + '\nreturn buildRegViews', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText)(sourceSample, sameResponseBatch, displayNumber, physicalValue, ...Object.values(codec))
const table = declaration('LiveTable'), history = declaration('HistoryView')
const capture = find(table, node => ts.isCallExpression(node) && node.expression.getText(source) === 'captureLiveSnapshot')!
const captureView = (env: Record<string, unknown>): ReturnType<typeof captureLiveSnapshot> => evaluate(capture, env)
const consume = find(history, node => ts.isCallExpression(node) && node.expression.getText(source) === 'navigation.consume')!
const effect = find(history, node => ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect' && node.arguments[0]?.getText(source).includes('navigation.consume')) as ts.CallExpression
const now = 1800000000000, device = { id: 1, name: 'synthetic', mode: 'master', isActive: 1, slaveId: 9 }
const point = { id: 7, objectId: 1, groupId: 9, alias: 'same ID', startAddress: 0, functionCode: 3, dataType: 'uint32' }
const group = { id: 9, objectId: 1, name: 'logical group', isActive: 1, slaveId: 1, functionCode: 3, startAddress: 0, quantity: 2, registers: [point] }
const rule = { id: 1, registerId: 7, operator: '>', threshold: 65535, message: null }
const words = (slaveId: number, value: number, objectId = 1) => Object.fromEntries(codec.encodeRegister('uint32', value).map((rawValue, address) => [sourceKey(objectId, 'holding-register', address, slaveId), { rawValue, slaveId, quality: 'good', timestamp: new Date(now).toISOString(), batchId: 'batch-' + objectId + '-' + slaveId }]))
const latest = { ...words(1, 65536), ...words(2, 12), ...words(2, 99999, 2) }, groups = [group]
const selected = (rows = groups, obj = device) => withRegisterSources(rows.flatMap(g => g.registers), rows, obj)
const state = (rows = groups, cache = latest, obj = device) => {
  const views = buildViews(rows, cache, obj.id, obj.mode === 'slave' ? obj.slaveId : undefined)
  const pointStates = evaluateLivePoints(rows, views, cache, obj, [rule], {}, now, 5000)
  return evaluate(capture, { captureLiveSnapshot, device: obj, groups: rows, filteredPoints: { visibleIds: new Set([7]) }, views, pointStates, latest: cache, search: '', activeSource: '', pointFilter: 'all', alarmRulesReady: true, now, Date: { now: () => now }, threshold: 5000 }) as ReturnType<typeof captureLiveSnapshot>
}
const first = state(), json = liveSnapshotJson(first), changed = [{ ...group, slaveId: 2 }]
let passed = 0
async function check(name: string, fn: () => void | Promise<void>) { await fn(); passed++; console.log('SOURCE TRANSITION OK: ' + name) }
await check('actual capture and frozen JSON retain old source, new capture uses only new source', async () => {
  assert.equal(first.points[0].display.raw, '65536'); assert.equal(first.points[0].observedAlarm.active, true)
  const second = state(changed)
  assert.equal(second.points[0].configuredSlaveId, 2); assert.equal(second.points[0].display.raw, '12'); assert.equal(second.points[0].observedAlarm.active, false)
  assert.equal(first.points[0].configuredSlaveId, 1); assert.equal(liveSnapshotJson(first), json)
  for (const english of [false, true]) {
    const html = renderToStaticMarkup(React.createElement(LiveSnapshotPanel, { snapshot: first, close() {}, english }))
    assert(html.includes(english ? 'Slave 1' : '从站 1')); assert(html.includes('65536')); assert(!html.includes(english ? 'Slave 2' : '从站 2'))
  }
  let blob!: Blob, clicked = 0
  const link = { href: '', download: '', click() { clicked++ }, remove() {} }
  downloadLiveSnapshot(first, { createElement: () => link, body: { appendChild() {} } } as any, { createObjectURL: value => { assert(value instanceof Blob); blob = value; return 'blob:synthetic' }, revokeObjectURL() {} }, fn => fn())
  assert.equal(clicked, 1); assert.equal(await blob.text(), json)
})
await check('new-source absence or mixed words never borrow old-source display/alarm', () => {
  const noTarget = state(changed, words(1, 65536))
  assert.equal(noTarget.points[0].display.raw, null); assert.equal(noTarget.points[0].health.missing, true); assert.equal(noTarget.points[0].observedAlarm.unknown, true); assert(noTarget.points[0].words.every(w => w.sample === null))
  const mixed = { ...latest, [sourceKey(1, 'holding-register', 1, 2)]: { ...latest[sourceKey(1, 'holding-register', 1, 2)], batchId: 'partial' } }
  const invalid = state(changed, mixed); assert.equal(invalid.points[0].display.raw, null); assert.equal(invalid.points[0].observedAlarm.unknown, true)
  assert.equal(state(changed, latest, { ...device, id: 2 }).points[0].display.raw, '99999', 'other device reads only its own namespace')
})
await check('history export rejects late old response after observed slave change', async () => {
  const context = (rows: typeof groups) => ({ definitions: historyReadContextKey(device, rows, selected(rows))!, device: 'logical-device-1' })
  let current = context(groups), release!: (blob: Blob) => void, enter!: () => void, saved = 0
  const entered = new Promise<void>(resolve => { enter = resolve }), body = new Promise<Blob>(resolve => { release = resolve })
  const request = captureHistoryExport(1, { start: now - 1000, end: now }, [7], 0, 'full', current)
  const pending = downloadHistoryExport('csv', request, new AbortController().signal, () => current, async () => ({ ok: true, headers: new Headers({ 'content-type': 'text/csv' }), blob: () => { enter(); return body } } as Response), () => { saved++ })
  await entered; current = context(changed); release(new Blob(['old slave 1 data']))
  await assert.rejects(pending, HistoryExportContextChangedError); assert.equal(saved, 0)
})
const observed = readPointAlarmObservation(point, latest, device, group, now, 5000, false)!
const reference = alarmHistoryState(observed, rule, point, 1, true, true, now, 5000)
assert.equal(reference.kind, 'ready'); if (reference.kind !== 'ready') throw Error('reference precondition')
const target = { ...reference.target, token: 1 }
function navigate(navigation: HistoryNavigation, rows = groups, ready = true, next = target) {
  return evaluate(consume, { navigation, target: next, device, registers: selected(rows), configurationReady: ready }) as ReturnType<HistoryNavigation['consume']>
}
await check('pending alarm reference cannot focus same ID after its source changes', () => {
  const gate = new HistoryNavigation()
  assert.equal(navigate(gate, groups, false)?.focus?.state, 'waiting')
  assert.equal(navigate(gate, changed)?.focus?.state, 'changed', 'alarm sample from slave 1 must not select slave 2 after configuration loading')
  assert.equal(navigate(gate, groups), null, 'changed reference must not silently retry on later refresh')
})
await check('immediate mismatch, missing or ambiguous context fail closed; old links remain compatible', () => {
  assert.equal(navigate(new HistoryNavigation(), changed)?.focus?.state, 'changed')
  const rows = selected()
  for (const change of [{ slaveId: 2 }, { slaveId: undefined }, { functionCode: 4 }, { startAddress: 1 }, { dataType: 'int32' }]) {
    const next = [{ ...rows[0], ...change }]
    assert.equal(new HistoryNavigation().consume(target, 1, [7], true, next)?.focus?.state, 'changed')
  }
  assert.equal(new HistoryNavigation().consume(target, 1, [7], true)?.focus?.state, 'changed', 'guarded reference cannot be checked using IDs alone')
  assert.equal(new HistoryNavigation().consume(target, 1, [7], true, [rows[0], rows[0]])?.focus?.state, 'changed', 'duplicate context is not guessed')
  assert.equal(new HistoryNavigation().consume(target, 1, [], true, rows)?.focus?.state, 'missing')
  assert.equal(new HistoryNavigation().consume(target, 2, [7], true, rows), null)
  assert.equal(navigate(new HistoryNavigation())?.focus?.state, 'found')
  const { pointSource: _source, ...legacy } = target
  assert.equal(new HistoryNavigation().consume(legacy, 1, [7], true)?.focus?.state, 'found', 'old general history links remain unguarded and compatible')
  for (const pointSource of [null, 0, {}, '']) assert.deepEqual(new HistoryNavigation().consume({ ...target, pointSource } as any, 1, [7], true, rows), { invalid: true })
  assert.deepEqual(new HistoryNavigation().consume({ ...target, registerId: undefined }, 1, [7], true, rows), { invalid: true })
  for (const slaveId of [0, 1, 255]) assert(historyPointSourceKey({ ...point, slaveId }))
  for (const slaveId of [undefined, NaN, -1, 256]) assert.equal(historyPointSourceKey({ ...point, slaveId }), null)
})
await check('actual history effect clears selection, shows bilingual mismatch, creates no selected-point query', () => {
  let ids = new Set([7]), notice: { kind: string; id?: number } | null = null
  const run = (rows: typeof groups, next = target, navigation = new HistoryNavigation()) => evaluate(effect.arguments[0], {
    navigation, target: next, device, registers: selected(rows), configurationReady: true,
    setNavigationNotice: (value: typeof notice) => { notice = value }, setSelected: (value: Set<number>) => { ids = value },
    setRange: () => {}, setValueMode: () => {}, setPreset: () => {}, setPage: () => {}, setMode: () => {}, setCurveRange: () => {}, setNavigationRevision: () => {}, setRefresh: () => {},
  })()
  run(changed); assert.deepEqual([...ids], []); assert.deepEqual(notice, { kind: 'changed', id: 7 })
  assert.equal(historyQueryPlan({ objectId: 1, start: now - 300000, end: now, mode: 'chart', page: 0, registerIds: [...ids] }), null)
  const messagesNode = (find(source, node => ts.isVariableDeclaration(node) && node.name.getText(source) === 'I18N') as ts.VariableDeclaration).initializer!
  assert(!find(messagesNode, ts.isCallExpression)); const messages = evaluate(messagesNode, {})
  const paragraph = find(history, node => ts.isBinaryExpression(node) && node.left.getText(source) === 'navigationNotice' && node.getText(source).includes('histNavigationMissing'))!
  for (const lang of ['zh', 'en']) {
    const html = renderToStaticMarkup(evaluate(paragraph, { navigationNotice: notice, React, t: (key: string) => messages[lang][key] }))
    assert(html.includes('role="alert"')); assert(html.includes(messages[lang].histNavigationChanged.replace('{id}', '7')))
  }
  const newObservation = readPointAlarmObservation(point, words(2, 65536), device, changed[0], now, 5000, false)!
  const reference = alarmHistoryState(newObservation, rule, point, 1, true, true, now, 5000)
  assert.equal(reference.kind, 'ready'); if (reference.kind !== 'ready') throw Error('new reference precondition')
  const next = { ...reference.target, token: 2 }
  run(changed, next); assert.deepEqual([...ids], [7]); assert.equal(notice, null, 'explicit new current-source alarm reference can recover')
})
await check('source guard survives JSON and local slave source mapping without changing observations', () => {
  assert(Object.isFrozen(reference.target)); assert.equal(observed.value, 65536); assert.equal(observed.slaveId, 1)
  const parsed = JSON.parse(JSON.stringify(target))
  assert.equal(navigate(new HistoryNavigation(), groups, true, parsed)?.focus?.state, 'found')
  assert.equal(navigate(new HistoryNavigation(), changed, true, parsed)?.focus?.state, 'changed')
  const localDevice = { ...device, mode: 'slave', slaveId: 2 }, localPoint = selected(changed, localDevice)[0]
  const observation = readPointAlarmObservation(point, words(2, 65536), localDevice, group, now, 5000, false)!
  const state = alarmHistoryState(observation, rule, point, 1, true, true, now, 5000)
  if (state.kind !== 'ready') throw Error('local slave precondition')
  assert.equal(new HistoryNavigation().consume(state.target, 1, [7], true, [localPoint])?.focus?.state, 'found')
  assert.equal(new HistoryNavigation().consume(state.target, 1, [7], true, [{ ...localPoint, slaveId: 9 }])?.focus?.state, 'changed')
  assert.equal(liveSnapshotJson(first), json, 'neither navigation nor exports relabel the frozen source')
})
await check('unverified source metadata cannot decode legacy cache while filter and frozen age report unknown', async () => {
  const variable = (scope: ts.Node, name: string) => (find(scope, node => ts.isVariableDeclaration(node) && node.name.getText(source) === name) as ts.VariableDeclaration).initializer!
  const view = declaration('DeviceView'), messages = evaluate(variable(source, 'I18N'), {})
  const legacy = Object.fromEntries(Object.values(words(1, 65536)).map((sample, index) => [`1:holding-register:${index}`, sample]))
  assert(legacySourceSample(legacy, 1, 'holding-register', 0), 'the general legacy lookup contract is deliberately retained')
  for (const missing of [undefined, null, -1, 256, '1']) {
    const metadata = JSON.parse(JSON.stringify({ ...group, slaveId: missing })), requests: string[] = []
    const rows = await readDeviceGroups<any>(device.id, new AbortController().signal, async url => { requests.push(url); return url.includes('monitor_objects') ? [metadata] : [point] })
    assert.equal(requests.length, 2, 'exercise the accepted metadata graph path, not a manually bypassed parser')
    const override = evaluate(variable(table, 'deviceSlaveId'), { device }), views = buildViews(rows, legacy, device.id, override)
    assert.equal(views.get(7).invalid, true, 'unknown configured source cannot decode a legacy unscoped value')
    const states = evaluateLivePoints(rows, views, legacy, device, [rule], {}, now, 5000), sources = pickerSources(rows, override)
    assert.deepEqual(sources, ['?']); assert.equal(states.get(7)!.health.ageSeconds, null)
    const filtered = livePointFilterResult(rows, states, '', '?', 'data', override); assert.deepEqual([...filtered.visibleIds], [7])
    const summaries = evaluate(variable(table, 'summaries'), { groups: rows, latest: legacy, device, now, threshold: 5000, views, groupErrors: {}, pointHealth, sourceSample, validSlaveId, areaForFunctionCode: evaluate(declaration('areaForFunctionCode'), {}) })
    assert.equal(summaries.get(group.id).status, 'sourceUnverified'); assert.equal(summaries.get(group.id).timestamp, null)
    const header = find(table, node => ts.isJsxElement(node) && node.getText(source).includes('· 从站') && node.getText(source).includes('· 起始') && node.openingElement.tagName.getText(source) === 'span')!
    assert(renderToStaticMarkup(evaluate(header, { React, g: rows[0], configuredSource: rows[0].slaveId, validSlaveId })).includes('从站 ?'))
    const times = evaluate(variable(view, 'times'), { groups: rows, latest: legacy, device, sampleTime, sourceSample, areaForFunctionCode: evaluate(declaration('areaForFunctionCode'), {}) }); assert.equal(evaluate(variable(view, 'lastSample'), { times }), null)
    const frozen = captureView({ captureLiveSnapshot, device, groups: rows, filteredPoints: filtered, views, pointStates: states, latest: legacy, search: '', activeSource: '?', pointFilter: 'data', alarmRulesReady: true, now, Date: { now: () => now }, threshold: 5000 })
    assert.equal(frozen.points[0].configuredSlaveId, null); assert.equal(frozen.points[0].display.raw, null); assert(frozen.points[0].words.every(word => word.sample === null))
    for (const english of [false, true]) { const html = renderToStaticMarkup(React.createElement(LiveSnapshotPanel, { snapshot: frozen, english, close() {}, download() {} })); assert(html.includes(english ? 'Slave ?' : '从站 ?')); assert(html.includes(english ? 'Unknown' : '未知')); assert(!html.includes('65536')); assert(messages[english ? 'en' : 'zh'].sourceUnverified) }
  }
})
await check('known sources retain zero age and legacy compatibility; invalid slave override cannot inherit group source', () => {
  const variable = (name: string) => (find(table, node => ts.isVariableDeclaration(node) && node.name.getText(source) === name) as ts.VariableDeclaration).initializer!
  for (const slaveId of [0, 1, 255]) {
    const rows = [{ ...group, slaveId }], cache = Object.fromEntries(Object.values(words(slaveId, 65536)).map((sample, index) => [`1:holding-register:${index}`, sample]))
    const views = buildViews(rows, cache, device.id), states = evaluateLivePoints(rows, views, cache, device, [], {}, now, 5000)
    assert.equal(views.get(7).value, '65536'); assert.equal(states.get(7)!.health.ageSeconds, 0); assert.equal(livePointFilterResult(rows, states, '', String(slaveId), 'data').visibleIds.size, 0)
  }
  for (const slaveId of [undefined, null, -1, 256]) {
    // Deliberately malformed runtime metadata, outside the nominal DTO contract.
    const owner = JSON.parse(JSON.stringify({ ...device, mode: 'slave', slaveId })) as typeof device, override = evaluate(variable('deviceSlaveId'), { device: owner })
    const views = buildViews(groups, latest, owner.id, override), states = evaluateLivePoints(groups, views, latest, owner, [], {}, now, 5000)
    assert.equal(views.get(7).invalid, true, 'invalid device slave source must not fall back to the group source')
    assert.deepEqual(pickerSources(groups, override), ['?']); assert.equal(states.get(7)!.health.ageSeconds, null)
    const frozen = captureView({ captureLiveSnapshot, device: owner, groups, filteredPoints: { visibleIds: new Set([7]) }, views, pointStates: states, latest, search: '', activeSource: '?', pointFilter: 'data', alarmRulesReady: true, now, Date: { now: () => now }, threshold: 5000 })
    assert.equal(frozen.points[0].configuredSlaveId, null); assert.equal(frozen.points[0].display.raw, null)
  }
})
await check('frozen age, real display and freshness filters agree across quality/batch/source transitions', () => {
  const variable = (name: string) => (find(table, node => ts.isVariableDeclaration(node) && node.name.getText(source) === name) as ts.VariableDeclaration).initializer!
  const areaForFunctionCode = evaluate(declaration('areaForFunctionCode'), {}), walk = (node: any): any[] => Array.isArray(node) ? node.flatMap(walk) : React.isValidElement(node) ? [node, ...walk((node.props as any).children)] : []
  const kinds = ['fresh', 'old', 'bad', 'mixed', 'partial', 'future', 'paused', 'fault', 'other-source', 'source-switch'] as const
  for (const kind of kinds) {
    const rows = [{ ...group, ...(kind === 'paused' ? { isActive: 0 } : {}), ...(kind === 'source-switch' ? { slaveId: 2 } : {}) }], cache = { ...words(1, 65536), ...words(2, 12) }, errors = kind === 'fault' ? { [group.id]: 'synthetic fault' } : {}
    const first = sourceKey(1, 'holding-register', 0, 1), second = sourceKey(1, 'holding-register', 1, 1)
    if (kind === 'old' || kind === 'source-switch') for (const sample of Object.values(cache)) if (sample.slaveId === (kind === 'old' ? 1 : 2)) sample.timestamp = new Date(now - 6000).toISOString()
    if (kind === 'bad') cache[first].quality = 'bad'
    if (kind === 'mixed') cache[second].batchId = 'other-batch'
    if (kind === 'partial' || kind === 'other-source') delete cache[second]
    if (kind === 'other-source') delete cache[first]
    if (kind === 'future') cache[first].timestamp = new Date(now + 60000).toISOString()
    const views = buildViews(rows, cache, device.id), states = evaluateLivePoints(rows, views, cache, device, [rule], errors, now, 5000), configuredSource = rows[0].slaveId, sourceLabel = String(configuredSource)
    const all = livePointFilterResult(rows, states, '', sourceLabel, 'all'), expectedAge = kind === 'future' || kind === 'other-source' ? null : kind === 'old' || kind === 'source-switch' ? 6 : 0
    const summaries = evaluate(variable('summaries'), { groups: rows, latest: cache, device, now, threshold: 5000, views, groupErrors: errors, pointHealth, sourceSample, validSlaveId, areaForFunctionCode })
    assert.equal(states.get(7)!.health.ageSeconds, expectedAge); assert.equal(summaries.get(group.id).status === 'fresh', kind === 'fresh')
    const frozen = captureView({ captureLiveSnapshot, device, groups: rows, filteredPoints: all, views, pointStates: states, latest: cache, search: '', activeSource: sourceLabel, pointFilter: 'all', alarmRulesReady: true, now, Date: { now: () => now }, threshold: 5000 }), original = liveSnapshotJson(frozen)
    assert.equal(frozen.points[0].health.ageSeconds, expectedAge); assert.equal(frozen.points[0].configuredSlaveId, configuredSource)
    if (kind === 'fresh') { assert.equal(states.get(7)!.alarmActive, true); assert.equal(all.counts.alarm, 1); assert.equal(all.counts.data, 0, 'freshness and a triggered value alarm are separate read-only dimensions') }
    if (kind === 'source-switch') { assert.equal(frozen.points[0].display.raw, '12'); assert(frozen.points[0].words.every(word => word.sample?.slaveId === 2)) }
    for (const english of [false, true]) {
      let mode: any = 'all', callbacks = 0
      const filters = LivePointFilters({ search: '', source: sourceLabel, sources: [sourceLabel], mode, counts: all.counts, rulesReady: true, ruleError: false, english, onSearch() { assert.fail('no search change') }, onSource() { assert.fail('no source change') }, onClear() { assert.fail('no clearing') }, onMode(value) { mode = value; callbacks++ } })
      const button = walk(filters).find(node => node.type === 'button' && String(node.props.children?.[0]).includes(english ? 'Invalid / stale' : '数据异常'))
      assert.equal(button.props.type, 'button'); button.props.onClick(); assert.equal(callbacks, 1); assert.equal(mode, 'data')
      const selected = livePointFilterResult(rows, states, '', sourceLabel, mode); assert.equal(selected.visibleIds.size, kind === 'fresh' ? 0 : 1, kind)
      const html = renderToStaticMarkup(React.createElement(LiveSnapshotPanel, { snapshot: frozen, english, close() {}, download() {} })), cells = [...html.match(/<tbody><tr>([\s\S]*?)<\/tr><\/tbody>/)![1].matchAll(/<td(?: [^>]*)?>([\s\S]*?)<\/td>/g)]
      assert.equal(cells[3][1].split('<')[0], expectedAge === null ? english ? 'Unknown' : '未知' : String(expectedAge)); assert(html.includes((english ? 'Slave ' : '从站 ') + configuredSource))
      if (kind === 'partial') assert(cells[3][1].includes(english ? 'Available words only' : '仅已有字'))
      if (kind === 'mixed') assert(html.includes(english ? 'Mixed or missing batch IDs' : '批次混杂或缺失'))
      assert.equal(liveSnapshotJson(frozen), original)
    }
  }
})
await check('full-group freshness and a filtered zero-age freeze retain their explicitly different scopes', () => {
  const points = [{ ...point, dataType: 'uint16' }, { ...point, id: 8, startAddress: 1, dataType: 'uint16' }], rows = [{ ...group, registers: points }], cache = words(1, 65536)
  cache[sourceKey(1, 'holding-register', 1, 1)].timestamp = new Date(now - 9000).toISOString()
  const views = buildViews(rows, cache, device.id), states = evaluateLivePoints(rows, views, cache, device, [], {}, now, 5000)
  const variable = (name: string) => (find(table, node => ts.isVariableDeclaration(node) && node.name.getText(source) === name) as ts.VariableDeclaration).initializer!
  const summaries = evaluate(variable('summaries'), { groups: rows, latest: cache, device, now, threshold: 5000, views, groupErrors: {}, pointHealth, sourceSample, validSlaveId, areaForFunctionCode: evaluate(declaration('areaForFunctionCode'), {}) })
  assert.equal(summaries.get(group.id).ageSeconds, 9); assert.equal(summaries.get(group.id).status, 'groupOldValues')
  for (const english of [false, true]) {
    let search = ''
    const all = livePointFilterResult(rows, states, search, '1', 'all'), controls = LivePointFilters({ search, source: '1', sources: ['1'], mode: 'all', counts: all.counts, rulesReady: true, ruleError: false, english, onSearch(value) { search = value }, onSource() {}, onMode() {}, onClear() {} })
    const walk = (node: any): any[] => Array.isArray(node) ? node.flatMap(walk) : React.isValidElement(node) ? [node, ...walk((node.props as any).children)] : []
    walk(controls).find(node => node.type === 'input').props.onChange({ target: { value: 'id:7' } })
    const filtered = livePointFilterResult(rows, states, search, '1', 'all'); assert.deepEqual([...filtered.visibleIds], [7]); assert.equal(filtered.counts.data, 0)
    assert(renderToStaticMarkup(controls).includes(english ? 'group summaries cover full groups' : '分组摘要仍代表完整分组'))
    const frozen = captureView({ captureLiveSnapshot, device, groups: rows, filteredPoints: filtered, views, pointStates: states, latest: cache, search, activeSource: '1', pointFilter: 'all', alarmRulesReady: true, now, Date: { now: () => now }, threshold: 5000 })
    assert.equal(frozen.points.length, 1); assert.equal(frozen.scope.availablePoints, 2); assert.equal(frozen.scope.search, 'id:7'); assert.equal(frozen.points[0].health.ageSeconds, 0); assert.equal(frozen.points[0].health.stale, false)
    assert.equal(summaries.get(group.id).ageSeconds, 9, 'freezing matches cannot recompute or hide the full-group stale summary')
  }
})
console.log('SOURCE TRANSITION TEST OK: ' + passed + ' combined actual-capture/navigation, frozen download and export cases; synthetic only')
