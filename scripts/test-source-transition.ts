import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as codec from '../packages/core/src/codec.ts'
import { sameResponseBatch } from '../packages/core/src/sample-batch.ts'
import { sourceKey, sourceSample, withRegisterSources } from '../packages/core/src/sample-source.ts'
import { displayNumber, physicalValue } from '../apps/web/src/physical-value.ts'
import { evaluateLivePoints } from '../apps/web/src/live-point-filter.ts'
import { captureLiveSnapshot, downloadLiveSnapshot, liveSnapshotJson } from '../apps/web/src/live-snapshot.ts'
import { LiveSnapshotPanel } from '../apps/web/src/LiveSnapshotPanel.tsx'
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
console.log('SOURCE TRANSITION TEST OK: ' + passed + ' combined actual-capture/navigation, frozen download and export cases; synthetic only')
