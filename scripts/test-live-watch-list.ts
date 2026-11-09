import assert from 'node:assert/strict'
import fs from 'node:fs'
import ts from 'typescript'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { captureLiveWatch, liveWatchResult, LIVE_WATCH_LIMIT, type LiveWatchSelection } from '../apps/web/src/live-watch-list.ts'
import { LiveWatchList } from '../apps/web/src/LiveWatchList.tsx'
import { LivePointFilters } from '../apps/web/src/LivePointFilters.tsx'
import { RegisterSelectModal } from '../apps/web/src/RegisterPicker.tsx'
import { evaluateLivePoints, livePointFilterResult } from '../apps/web/src/live-point-filter.ts'
import { captureLiveSnapshot, liveSnapshotJson } from '../apps/web/src/live-snapshot.ts'
import { compareLiveSnapshots, liveSnapshotComparisonKey } from '../apps/web/src/live-snapshot-comparison.ts'
import { sourceKey } from '../packages/core/src/sample-source.ts'
import { hookDriver } from './fixtures/component-hook-driver.ts'
import { syntheticDevice } from './fixtures/draft-navigation-driver.ts'

const scope = Symbol('synthetic'), now = 1800000000000, device = { ...syntheticDevice, isActive: 1 }
const groups = [1, 2].map(slaveId => ({ id: slaveId, objectId: 1, name: '<group>' + slaveId, isActive: 1, slaveId, functionCode: 3, startAddress: 0, quantity: 20, registers: Array.from({ length: 20 }, (_, i) => ({ id: slaveId * 100 + i, groupId: slaveId, objectId: 1, alias: '<point>' + i, startAddress: i, functionCode: 3, dataType: 'uint16' })) }))
const matches = new Set(groups.flatMap(group => group.registers.map(point => point.id))), choose = (ids = [100, 200], token: symbol | null = scope) => captureLiveWatch(token, new Set(ids), groups)!
const t = (key: string) => ({ selectRegisters: 'Select points', pickerSource: 'Slave', cancel: 'Cancel', save: 'Apply', curveSelectLimit: 'Select up to {n} points' }[key] ?? key)
let passed = 0
async function check(name: string, fn: () => void) { fn(); passed++; console.log('LIVE WATCH OK: ' + name) }
await check('bounded immutable selection rejects unknown duplicate or invalid identities without mutating inputs', () => {
  const before = JSON.stringify(groups), ids = new Set([100, 200]), selected = captureLiveWatch(scope, ids, groups)!
  ids.clear(); assert.deepEqual(selected.ids, [100, 200]); assert(Object.isFrozen(selected)); assert(Object.isFrozen(selected.ids)); assert.equal(JSON.stringify(groups), before)
  assert.equal(choose([...matches].slice(0, LIVE_WATCH_LIMIT)).ids.length, 32)
  for (const list of [[], [...matches].slice(0, 33), [999], [0], [-1], [1.5], [NaN]]) assert.equal(captureLiveWatch(scope, new Set(list), groups), null)
  assert.equal(captureLiveWatch(null, new Set([100]), groups), null); assert.equal(captureLiveWatch(scope, new Set([100]), [...groups, groups[0]]), null)
  const large = [{ registers: Array.from({ length: 10000 }, (_, i) => ({ id: i + 1 })) }]; assert.deepEqual(captureLiveWatch(scope, new Set([1, 5000, 10000]), large)!.ids, [1, 5000, 10000])
})
await check('watch-only is an intersection and invalid or empty selection never silently shows all points', () => {
  const selected = choose(); assert.deepEqual([...liveWatchResult(selected, scope, true, matches).visibleIds], [100, 200])
  assert.deepEqual([...liveWatchResult(selected, scope, true, new Set([200, 201])).visibleIds], [200]); assert.equal(liveWatchResult(selected, scope, true, new Set([201])).matching, 0)
  for (const token of [null, Symbol('changed')]) { const value = liveWatchResult(selected, token, true, matches); assert.equal(value.visibleIds.size, 0); assert.notEqual(value.status, 'ready'); assert.equal(liveWatchResult(selected, token, false, matches).visibleIds.size, 40) }
  assert.equal(liveWatchResult(null, scope, true, matches).visibleIds.size, 0); assert.equal(liveWatchResult(null, scope, false, matches).visibleIds.size, 40)
  assert.deepEqual(selected.ids, [100, 200])
})
const latest = Object.fromEntries(groups.flatMap(group => group.registers.map(point => [sourceKey(1, 'holding-register', point.startAddress, group.slaveId), { slaveId: group.slaveId, rawValue: group.slaveId, quality: 'good', batchId: 'batch-' + group.slaveId, timestampMs: now, timestamp: new Date(now).toISOString() }])))
const views = new Map(groups.flatMap(group => group.registers.map(point => [point.id, { covered: false, invalid: false, value: String(group.slaveId), label: null }] as const)))
const states = evaluateLivePoints(groups, views, latest, device, [{ id: 1, registerId: 200, operator: '>', threshold: 1, message: null }], {}, now, 5000)
await check('existing search source and alarm counts remain independent and same-address slaves are explicit', () => {
  const all = livePointFilterResult(groups, states, '', '', 'alarm'), source = livePointFilterResult(groups, states, '', '1', 'all'), selected = choose()
  assert.deepEqual([...liveWatchResult(selected, scope, true, all.visibleIds).visibleIds], [200]); assert.equal(all.counts.all, 40); assert.equal(all.counts.alarm, 1)
  assert.deepEqual([...liveWatchResult(selected, scope, true, source.visibleIds).visibleIds], [100]); assert.equal(source.counts.all, 20)
  assert.deepEqual([...liveWatchResult(selected, scope, true, livePointFilterResult(groups, states, 'id:201', '', 'all').visibleIds).visibleIds], [])
})
function model(english = false) {
  let selection: LiveWatchSelection | null = null, token: symbol | null = scope, only = false, calls = 0
  const props = () => ({ selection, scope: token, only, matches, groups, t, english, onSelect(received: symbol, ids: Set<number>) { calls++; selection = captureLiveWatch(received, ids, groups); only = !!selection }, onOnly(value: boolean) { only = value }, onClear() { selection = null; only = false } })
  const driver = hookDriver('LiveWatchList.tsx', 'LiveWatchList', { liveWatchResult, LIVE_WATCH_LIMIT, RegisterSelectModal }, props())
  return { driver, render() { driver.render(props()) }, html: () => renderToStaticMarkup(driver.tree), change(next: symbol | null) { token = next; driver.render(props()) }, get selection() { return selection }, get only() { return only }, get calls() { return calls } }
}
await check('actual bilingual controls choose clear and retain list while toggling display without requests', () => {
  for (const english of [false, true]) { const f = model(english); try {
    assert(f.html().includes(english ? 'No watch points' : '尚未选择')); f.driver.one('button', props => String(props.children).includes(english ? 'Choose watch' : '选择观察')).props.onClick(); f.render()
    const picker = f.driver.one(RegisterSelectModal); assert.equal(picker.props.max, 32); assert.equal(picker.props.initial.size, 0); assert(f.html().includes('Slave 1')); assert(f.html().includes('Slave 2')); assert(f.html().includes('&lt;point&gt;'))
    picker.props.onApply(new Set([100, 200])); f.render(); assert.equal(f.calls, 1); assert.equal(f.only, true); assert.deepEqual(f.selection!.ids, [100, 200]); assert(f.html().includes(english ? '2 selected; 2 match' : '已选 2 点'))
    f.driver.one('input', props => props.type === 'checkbox').props.onChange({ target: { checked: false } }); f.render(); assert.equal(f.only, false); assert.equal(f.selection!.ids.length, 2)
    f.driver.one('button', props => String(props.children).includes(english ? 'Clear watch' : '清空观察')).props.onClick(); f.render(); assert.equal(f.selection, null); assert.equal(f.only, false)
  } finally { f.driver.dispose(); assert.equal(f.driver.lateWrites, 0) } }
})
await check('configuration change hides picker rejects its late apply and never reuses same IDs', () => {
  for (const english of [false, true]) { const f = model(english); try {
    const open = () => { f.driver.one('button', props => String(props.children).includes(english ? 'Choose watch' : '选择观察')).props.onClick(); f.render(); return f.driver.one(RegisterSelectModal) }
    open().props.onApply(new Set([100, 200])); f.render(); const old = open(), calls = f.calls; f.change(Symbol('same IDs new configuration'))
    assert(f.html().includes(english ? 'old watch list is invalid' : '原观察清单已失效')); assert(!f.html().includes('role="dialog"')); assert(f.html().includes(english ? 'does not prove normal' : '不代表设备正常'))
    old.props.onApply(new Set([101])); f.render(); assert.equal(f.calls, calls); assert.deepEqual(f.selection!.ids, [100, 200]); const replacement = open(); assert.equal(replacement.props.initial.size, 0); replacement.props.onApply(new Set([201])); f.render(); assert.deepEqual(f.selection!.ids, [201])
    f.change(null); assert(f.html().includes(english ? 'Source/configuration unverified' : '来源/配置未核实')); assert.equal(f.driver.one('button', props => String(props.children).includes(english ? 'Choose watch' : '选择观察')).props.disabled, true)
  } finally { f.driver.dispose() } }
})
const source = ts.createSourceFile('App.tsx', fs.readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function find(node: ts.Node, match: (node: ts.Node) => boolean): ts.Node | undefined { if (match(node)) return node; return ts.forEachChild(node, child => find(child, match)) }
const table = find(source, node => ts.isFunctionDeclaration(node) && node.name?.text === 'LiveTable')!
const variable = (name: string) => (find(table, node => ts.isVariableDeclaration(node) && node.name.getText(source) === name) as ts.VariableDeclaration).initializer!
const run = (node: ts.Node, env: Record<string, unknown>) => new Function(...Object.keys(env), ts.transpileModule('return (' + node.getText(source) + ')', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText)(...Object.values(env))
await check('actual App filter wiring drives folds freeze scope and clear-all without touching collection', () => {
  const base = run(variable('baseFilteredPoints'), { useMemo: (fn: () => unknown) => fn(), livePointFilterResult, groups, pointStates: states, search: '', activeSource: '', pointFilter: 'all', deviceSlaveId: undefined })
  const watch = run(variable('watchResult'), { liveWatchResult, watchSelection: choose(), snapshotComparisonScope: scope, watchOnly: true, baseFilteredPoints: base })
  const filtered = run(variable('filteredPoints'), { baseFilteredPoints: base, watchResult: watch }); assert.deepEqual([...filtered.visibleIds], [100, 200]); assert.equal(filtered.counts.all, 40)
  assert.equal(run(variable('hasPointFilters'), { search: '', activeSource: '', pointFilter: 'all', watchOnly: true }), true)
  const filterNode = find(table, node => ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'LivePointFilters') as ts.JsxSelfClosingElement
  const clear = (filterNode.attributes.properties.find(node => ts.isJsxAttribute(node) && node.name.getText(source) === 'onClear') as ts.JsxAttribute).initializer as ts.JsxExpression
  const events: unknown[] = []; run(clear.expression!, { setSearch: (value: unknown) => events.push(value), setSourceFilter: (value: unknown) => events.push(value), setPointFilter: (value: unknown) => events.push(value), setWatchOnly: (value: unknown) => events.push(value) })(); assert.deepEqual(events, ['', '', 'all', false]); assert(filterNode.getText(source).includes('extraFiltered={watchOnly}'))
  const props = { search: '', source: '', sources: [], mode: 'all' as const, counts: base.counts, rulesReady: true, ruleError: false, onSearch() {}, onSource() {}, onMode() {}, onClear() {} }
  const active = hookDriver('LivePointFilters.tsx', 'LivePointFilters', { LIVE_POINT_FILTERS: ['all', 'attention', 'alarm', 'data', 'unknown'] }, { ...props, extraFiltered: true })
  try { assert.equal(active.one('button', p => String(p.children).includes('清除全部筛选')).props.disabled, false) } finally { active.dispose() }
})
await check('actual freeze contains only shown watch intersections without changing v1 or comparison eligibility', () => {
  const capture = find(table, node => ts.isCallExpression(node) && node.expression.getText(source) === 'captureLiveSnapshot')!
  const snapshot = (ids: ReadonlySet<number>) => run(capture, { captureLiveSnapshot, device, groups, filteredPoints: { visibleIds: ids }, views, pointStates: states, latest, search: '', activeSource: '', pointFilter: 'all', alarmRulesReady: true, now, Date: { now: () => now }, threshold: 5000 }) as ReturnType<typeof captureLiveSnapshot>
  const a = snapshot(liveWatchResult(choose(), scope, true, matches).visibleIds), b = snapshot(new Set([200])); assert.deepEqual(a.points.map(point => [point.id, point.configuredSlaveId, point.display.raw]), [[100, 1, '1'], [200, 2, '2']]); assert.equal(a.scope.capturedPoints, 2); assert.equal(a.scope.availablePoints, 40); assert.equal(JSON.parse(liveSnapshotJson(a)).version, 1)
  assert.equal(compareLiveSnapshots({ scope, snapshot: a }, { scope, snapshot: b }, scope).status, 'selection'); assert.throws(() => snapshot(new Set()), /没有可冻结/)
  const key = liveSnapshotComparisonKey(device, groups); assert(key); assert.notEqual(liveSnapshotComparisonKey(device, groups.map(group => ({ ...group, slaveId: group.slaveId + 1 }))), key)
})
console.log(`LIVE WATCH TEST OK: ${passed} pure/actual App and component groups; no requests, storage, database, collection, hardware, models or browser`)
