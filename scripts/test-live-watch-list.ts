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
import * as codec from '../packages/core/src/codec.ts'
import { sameResponseBatch } from '../packages/core/src/sample-batch.ts'
import { displayNumber, physicalValue } from '../apps/web/src/physical-value.ts'
import { addVisiblePickerPoints, filterPickerGroups, pickerSource, pickerSources } from '../apps/web/src/register-picker.ts'
import { LiveSnapshotComparison } from '../apps/web/src/LiveSnapshotComparison.tsx'
import { sourceKey, sourceSample, withRegisterSources } from '../packages/core/src/sample-source.ts'
import { hookDriver } from './fixtures/component-hook-driver.ts'
import { pointHealth } from '../apps/web/src/observation.ts'
import { historyQueryPlan, startHistoryQuery, type HistoryQueryTask } from '../apps/web/src/history-query-task.ts'
import { reduceHistoryRead, type HistoryReadState } from '../apps/web/src/history-read-context.ts'
import { draftEditor, draftSurface, syntheticDevice } from './fixtures/draft-navigation-driver.ts'

const scope = Symbol('synthetic'), now = 1800000000000, device = { ...syntheticDevice, isActive: 1 }
const groups = [1, 2].map(slaveId => ({ id: slaveId, objectId: 1, name: '<group>' + slaveId, isActive: 1, slaveId, functionCode: 3, startAddress: 0, quantity: 20, registers: Array.from({ length: 20 }, (_, i) => ({ id: slaveId * 100 + i, groupId: slaveId, objectId: 1, alias: '<point>' + i, startAddress: i, functionCode: 3, dataType: 'uint16' })) }))
const matches = new Set(groups.flatMap(group => group.registers.map(point => point.id))), choose = (ids = [100, 200], token: symbol | null = scope) => captureLiveWatch(token, new Set(ids), groups)!
const t = (key: string) => ({ selectRegisters: 'Select points', pickerSource: 'Slave', cancel: 'Cancel', save: 'Apply', curveSelectLimit: 'Select up to {n} points' }[key] ?? key)
let passed = 0
async function check(name: string, fn: () => void | Promise<void>) { await fn(); passed++; console.log('LIVE WATCH OK: ' + name) }
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
await check('actual App rejects ambiguous cross-slave IDs visibly without replacing the existing selection', () => {
  const node = find(table, node => ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'LiveWatchList') as ts.JsxSelfClosingElement
  const attr = (node.attributes.properties.find(node => ts.isJsxAttribute(node) && node.name.getText(source) === 'onSelect') as ts.JsxAttribute).initializer as ts.JsxExpression
  for (const english of [false, true]) {
    const old = choose([100]), changes: unknown[] = [], notices: Array<{ error: boolean; text: string }> = []
    const apply = (rows = groups) => run(attr.expression!, { captureLiveWatch, groups: rows, setWatchSelection: (value: unknown) => changes.push(value), setWatchOnly: (value: unknown) => changes.push(value), operation: { setNotice: (value: { error: boolean; text: string }) => notices.push(value) }, t: (key: string) => key === 'cancel' ? english ? 'Cancel' : '取消' : key })
    const ambiguous = groups.map(group => ({ ...group, registers: [{ ...group.registers[0], id: 100 }] })); assert.equal(captureLiveWatch(scope, new Set([100]), ambiguous), null)
    apply(ambiguous)(scope, new Set([100])); assert.equal(changes.length, 0); assert.deepEqual(old.ids, [100]); assert.equal(notices.length, 1); assert.equal(notices[0].error, true); assert(notices[0].text.includes(english ? 'Watch list was not applied' : '观察清单未应用'))
    apply()(scope, new Set([...matches].slice(0, 33))); assert.equal(changes.length, 0); assert.equal(notices.length, 2)
    apply()(scope, new Set([100, 200])); assert.equal((changes[0] as LiveWatchSelection).scope, scope); assert.deepEqual((changes[0] as LiveWatchSelection).ids, [100, 200]); assert.equal(changes[1], true)
    changes.length = 0; apply()(scope, new Set()); assert.deepEqual(changes, [null, false]); assert.equal(notices.length, 2)
  }
})
const compile = (text: string) => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
const buildViews = new Function('sourceSample', 'sameResponseBatch', 'displayNumber', 'physicalValue', ...Object.keys(codec), compile(['areaForFunctionCode', 'enumLabelOf', 'buildRegViews'].map(name => find(source, node => ts.isFunctionDeclaration(node) && node.name?.text === name)!.getText(source)).join('\n') + '\nreturn buildRegViews'))(sourceSample, sameResponseBatch, displayNumber, physicalValue, ...Object.values(codec))
function data(id = 1, step = 0, sourceShift = 0) {
  const rows = groups.map(group => ({ ...group, objectId: id, slaveId: group.slaveId + sourceShift, registers: group.registers.map(point => ({ ...point, objectId: id })) }))
  const cache = Object.fromEntries(rows.flatMap(group => group.registers.map(point => [sourceKey(id, 'holding-register', point.startAddress, group.slaveId), { slaveId: group.slaveId, rawValue: id * 10 + group.slaveId + step / 1000, quality: 'good', batchId: 'batch-' + id + '-' + group.slaveId + '-' + step, timestampMs: now + step, timestamp: new Date(now + step).toISOString() }])))
  return { device: { ...device, id }, groups: rows, latest: cache, now: now + step }
}
function scopes() {
  let last: unknown, saved: unknown, initialized = false
  return (value: ReturnType<typeof data>) => {
    const key = run(variable('snapshotComparisonKey'), { useMemo: (fn: () => unknown) => fn(), liveSnapshotComparisonKey, device: value.device, groups: value.groups })
    return run(variable('snapshotComparisonScope'), { snapshotComparisonKey: key, useMemo(fn: () => unknown, deps: unknown[]) { if (!initialized || !Object.is(last, deps[0])) { initialized = true; last = deps[0]; saved = fn() }; return saved } }) as symbol
  }
}
const freezeButton = find(table, node => ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === 'button' && node.openingElement.getText(source).includes('captureLiveSnapshot')) as ts.JsxElement
const freezeAttr = (name: string) => ((freezeButton.openingElement.attributes.properties.find(node => ts.isJsxAttribute(node) && node.name.getText(source) === name) as ts.JsxAttribute).initializer as ts.JsxExpression).expression!
function combined(value: ReturnType<typeof data>, token: symbol, selected: LiveWatchSelection, current: { value: ReturnType<typeof captureLiveSnapshot> | null; notices: number }, search = '') {
  const actualViews = buildViews(value.groups, value.latest, value.device.id), pointStates = evaluateLivePoints(value.groups, actualViews, value.latest, value.device, [], {}, value.now, 5000)
  const base = run(variable('baseFilteredPoints'), { useMemo: (fn: () => unknown) => fn(), livePointFilterResult, groups: value.groups, pointStates, search, activeSource: '', pointFilter: 'all', deviceSlaveId: undefined })
  const watch = run(variable('watchResult'), { liveWatchResult, watchSelection: selected, snapshotComparisonScope: token, watchOnly: true, baseFilteredPoints: base }), filteredPoints = run(variable('filteredPoints'), { baseFilteredPoints: base, watchResult: watch })
  return { watch, disabled: run(freezeAttr('disabled'), { filteredPoints }), click: run(freezeAttr('onClick'), { captureLiveSnapshot, device: value.device, groups: value.groups, filteredPoints, views: actualViews, pointStates, latest: value.latest, search, activeSource: '', pointFilter: 'all', alarmRulesReady: true, now: value.now, Date: { now: () => value.now }, threshold: 5000, snapshotComparisonScope: token, setSnapshotCapture: (next: { snapshot: ReturnType<typeof captureLiveSnapshot> }) => { current.value = next.snapshot }, operation: { setNotice() { current.notices++ } }, t }) }
}
await check('actual watch-filter-freeze-compare flow preserves frozen results across empty filters and changed selection', () => {
  const context = scopes(), first = data(), token = context(first), selected = captureLiveWatch(token, new Set([100, 200]), first.groups)!, current = { value: null as ReturnType<typeof captureLiveSnapshot> | null, notices: 0 }, before = JSON.stringify(first)
  combined(first, token, selected, current).click(); const a = { scope: token, snapshot: current.value! }, oldJson = liveSnapshotJson(a.snapshot)
  const component = hookDriver('LiveSnapshotComparison.tsx', 'LiveSnapshotComparison', { compareLiveSnapshots, useMemo: (fn: () => unknown) => fn() }, { current: a, scope: token })
  try {
    component.one('button', p => String(p.children).includes('设为基线')).props.onClick(); component.render(); const next = data(1, 1000); assert.equal(context(next), token); combined(next, token, selected, current).click(); const b = { scope: token, snapshot: current.value! }; component.render({ current: b, scope: token }); assert.deepEqual(compareLiveSnapshots(a, b, token).counts, { changed: 2, unchanged: 0, unknown: 0 }); assert.deepEqual(b.snapshot.points.map(point => [point.id, point.configuredSlaveId, point.display.raw]), [[100, 1, '12'], [200, 2, '13']])
    const html = renderToStaticMarkup(component.tree), frozen = current.value, zero = combined(data(1, 2000), token, selected, current, 'id:999'); assert.equal(zero.disabled, true); assert.equal(zero.watch.visibleIds.size, 0); zero.click(); assert.equal(current.value, frozen); assert.equal(current.notices, 1); component.render({ current: b, scope: token }); assert.equal(renderToStaticMarkup(component.tree), html); assert.equal(liveSnapshotJson(a.snapshot), oldJson)
    const subset = captureLiveWatch(token, new Set([200]), next.groups)!; combined(next, token, subset, current).click(); const c = { scope: token, snapshot: current.value! }; component.render({ current: c, scope: token }); assert.equal(compareLiveSnapshots(a, c, token).status, 'selection'); assert(!renderToStaticMarkup(component.tree).includes('<tr>')); assert.equal(JSON.stringify(first), before)
  } finally { component.dispose(); assert.equal(component.lateWrites, 0) }
})
await check('source reassignment device reuse and A-B-A invalidate watch and comparison even when IDs stay equal', () => {
  const context = scopes(), first = data(), initial = context(first), selected = captureLiveWatch(initial, new Set([100, 200]), first.groups)!, current = { value: null as ReturnType<typeof captureLiveSnapshot> | null, notices: 0 }; combined(first, initial, selected, current).click(); const frozen = { scope: initial, snapshot: current.value! }, json = liveSnapshotJson(frozen.snapshot)
  for (const next of [data(1, 1000, 1), data(2, 1000), data(1, 2000)]) {
    const token = context(next); assert.notEqual(token, initial); const blocked = combined(next, token, selected, current); assert.equal(blocked.watch.status, 'changed'); assert.equal(blocked.disabled, true); blocked.click(); assert.equal(liveSnapshotJson(current.value!), json)
    const freshSelection = captureLiveWatch(token, new Set([100, 200]), next.groups)!; next.latest = { ...first.latest, ...next.latest }; combined(next, token, freshSelection, current).click(); const replacement = { scope: token, snapshot: current.value! }; assert.equal(compareLiveSnapshots(frozen, replacement, token).status, 'context'); assert.equal(replacement.snapshot.device.id, next.device.id); assert.equal(replacement.snapshot.points[0].display.raw, String(next.device.id * 10 + next.groups[0].slaveId + (next.now - now) / 1000)); current.value = frozen.snapshot
  }
  const view = find(source, node => ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'DeviceView') as ts.JsxSelfClosingElement
  const key = (view.attributes.properties.find(node => ts.isJsxAttribute(node) && node.name.getText(source) === 'key') as ts.JsxAttribute).initializer as ts.JsxExpression; assert.equal(run(key.expression!, { selected: { id: 1 } }), 1); assert.equal(run(key.expression!, { selected: { id: 2 } }), 2)
  const empty = hookDriver('LiveSnapshotComparison.tsx', 'LiveSnapshotComparison', { compareLiveSnapshots, useMemo: (fn: () => unknown) => fn() }, { current: null, scope: Symbol('new mount') }); try { assert.equal(renderToStaticMarkup(empty.tree), '') } finally { empty.dispose() }
})
await check('actual picker enforces 32 while sampling input stays at 40 and deselection or clear recovers', () => {
  let applied = new Set<number>(), focuses = 0
  const picker = hookDriver('RegisterPicker.tsx', 'RegisterSelectModal', { addVisiblePickerPoints, filterPickerGroups, pickerSource, pickerSources, document: { activeElement: { focus() { focuses++ } } } }, { t, groups, initial: new Set(), max: 32, onClose() {}, onApply(ids: Set<number>) { applied = ids } })
  try {
    const before = JSON.stringify({ groups, latest })
    for (let index = 0; index < 32; index++) { picker.one('input', p => p.type === 'checkbox' && !p.checked && !p.disabled).props.onChange(); picker.render() }
    const extra = picker.one('input', p => p.type === 'checkbox' && !p.checked); assert.equal(extra.props.disabled, true); extra.props.onChange(); picker.render(); picker.one('button', p => p.children === 'Apply').props.onClick(); assert.equal(applied.size, 32)
    picker.one('input', p => p.type === 'checkbox' && p.checked).props.onChange(); picker.render(); assert.equal(picker.one('input', p => p.type === 'checkbox' && !p.checked).props.disabled, false); picker.one('button', p => p.children === 'Apply').props.onClick(); assert.equal(applied.size, 31)
    const value = data(), token = scopes()(value), selected = captureLiveWatch(token, applied, value.groups)!, current = { value: null as ReturnType<typeof captureLiveSnapshot> | null, notices: 0 }; combined(value, token, selected, current).click(); assert.equal(current.value!.points.length, 31); assert.equal(current.value!.scope.availablePoints, 40); assert.equal(JSON.stringify({ groups, latest }), before)
    picker.one('button', p => p.children === 'pickerClearSelection').props.onClick(); picker.render(); picker.one('button', p => p.children === 'Apply').props.onClick(); assert.equal(applied.size, 0)
  } finally { picker.dispose(); assert.equal(focuses, 1); assert.equal(picker.lateWrites, 0) }
})
await check('actual parent and watch controls avoid whole-table copies when unused and bound watch-only work', () => {
  let walked = 0, probes = 0
  const all = new Proxy(new Set(Array.from({ length: 10000 }, (_, i) => i + 1)), { get(target, key) { if (key === Symbol.iterator) return function* () { for (const id of target.values()) { walked++; yield id } }; if (key === 'has') return (id: number) => { probes++; return target.has(id) }; const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value } })
  const parent = (selection: LiveWatchSelection | null, only: boolean) => run(variable('watchResult'), { liveWatchResult, watchSelection: selection, snapshotComparisonScope: scope, watchOnly: only, baseFilteredPoints: { visibleIds: all } })
  const initial = parent(null, false), control = hookDriver('LiveWatchList.tsx', 'LiveWatchList', { liveWatchResult, LIVE_WATCH_LIMIT, RegisterSelectModal }, { selection: null, scope, only: false, matches: all, groups, t, onSelect() {}, onOnly() {}, onClear() {} })
  try { assert.equal(walked, 0, 'unused watch layer must not iterate/copy the complete matched table twice'); assert.equal(initial.visibleIds, all); assert.equal(probes, 0) } finally { control.dispose() }
  const selection = { scope, ids: Object.freeze(Array.from({ length: 32 }, (_, i) => i + 1)) }; walked = 0; probes = 0
  const chosen = parent(selection, true), active = hookDriver('LiveWatchList.tsx', 'LiveWatchList', { liveWatchResult, LIVE_WATCH_LIMIT, RegisterSelectModal }, { selection, scope, only: true, matches: all, groups, t, onSelect() {}, onOnly() {}, onClear() {} })
  try { assert.equal(chosen.visibleIds.size, 32); assert.equal(walked, 0); assert(probes <= 128, 'membership checks depend on at most 32 watched points in each caller, not 10000 table rows') } finally { active.dispose() }
  assert.equal(all.size, 10000)
})
function mountedTable(registration?: ReturnType<ReturnType<typeof draftSurface>['registration']>) {
  let clock = now; const notices: unknown[] = [], noAction = () => assert.fail('No business operation or network is allowed'), leaf = () => null
  const props = (value = data()) => ({ draftScope: registration, t: (key: string) => key === 'cancel' ? '取消' : key, device: value.device, groups: value.groups, latest: value.latest, groupErrors: {}, now: value.now, threshold: 5000, onRefresh: noAction })
  const driver = hookDriver('App.tsx', 'LiveTable', hooks => ({ useMemo(fn: () => unknown, deps: unknown[]) { const ref = (hooks.useRef as Function)({ ready: false, deps: [], value: undefined }); if (!ref.current.ready || deps.length !== ref.current.deps.length || deps.some((value, i) => !Object.is(value, ref.current.deps[i]))) ref.current = { ready: true, deps, value: fn() }; return ref.current.value }, Date: class extends Date { static now() { return clock } }, liveSnapshotComparisonKey, captureLiveSnapshot, captureLiveWatch, liveWatchResult, useAlarmRules: () => ({ rules: [], ready: true, error: null, reading: false, retry: noAction }), useDisplayColumns: () => [{ address: true, type: true, raw: true, physical: true, action: false }, noAction], useOperation: () => ({ busy: false, run: noAction, setNotice(value: unknown) { notices.push(value) } }), pickerSources, buildRegViews: buildViews, evaluateLivePoints, livePointFilterResult, pointHealth, sourceSample, areaForFunctionCode: (fc: number) => fc === 1 ? 'coil' : fc === 2 ? 'discrete-input' : fc === 4 ? 'input-register' : 'holding-register', formatLocalTs: (value: string) => value, ColumnControl: leaf, LivePointFilters, LiveWatchList, LiveSnapshotComparison, LiveSnapshotPanel: 'mock-snapshot-panel', GroupFold: leaf }), props())
  return { driver, notices, render(value = data()) { clock = value.now; driver.render(props(value)) }, watch: () => driver.one(LiveWatchList).props, comparison: () => driver.one(LiveSnapshotComparison).props, freeze() { driver.one('button', p => String(p.children).includes('冻结当前')).props.onClick(); driver.render() } }
}
await check('actual LiveTable survives cancelled history navigation then remounts without watch or frozen baseline', () => {
  const page = draftSurface(), live = mountedTable(page.registration()), editor = draftEditor('point', page.registration())
  let comparison: ReturnType<typeof hookDriver> | undefined, fresh: ReturnType<typeof mountedTable> | undefined
  try {
    live.watch().onSelect(live.watch().scope, new Set([200, 100])); live.render(); assert.equal(live.watch().only, true); live.freeze(); const a = live.comparison().current; assert.deepEqual(a.snapshot.points.map((point: { id: number }) => point.id), [100, 200], 'table/freeze order follows groups even if selected IDs are reversed')
    comparison = hookDriver('LiveSnapshotComparison.tsx', 'LiveSnapshotComparison', { compareLiveSnapshots, useMemo: (fn: () => unknown) => fn() }, live.comparison()); comparison.one('button', p => String(p.children).includes('设为基线')).props.onClick(); comparison.render()
    live.render(data(1, 1000)); live.freeze(); const b = live.comparison().current; comparison.render(live.comparison()); assert.deepEqual(compareLiveSnapshots(a, b, live.watch().scope).counts, { changed: 2, unchanged: 0, unknown: 0 })
    live.driver.one('button', p => p.children === 'configure').props.onClick(); live.render(data(1, 1000)); editor.change('KEEP LIVE DRAFT'); page.localTab(2); assert.equal(page.state().tab, 0); assert.equal(live.comparison().current, b); assert.equal(editor.value(), 'KEEP LIVE DRAFT'); assert.equal(editor.calls.save, 0); assert.deepEqual(live.watch().selection.ids, [200, 100])
    page.setAnswer(true); page.localTab(2); assert.equal(page.state().tab, 2); editor.driver.dispose(); live.driver.dispose(); comparison.dispose()
    const view = find(source, node => ts.isFunctionDeclaration(node) && node.name?.text === 'DeviceView')!, branch = (tag: string) => find(view, node => ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && ts.isJsxSelfClosingElement(node.right) && node.right.tagName.getText(source) === tag)!
    const evaluate = (node: ts.Node, env: Record<string, unknown>) => new Function(...Object.keys(env), ts.transpileModule('return (' + node.getText(source) + ')', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React } }).outputText)(...Object.values(env))
    const registers = withRegisterSources(groups.flatMap(group => group.registers), groups, device), env = { React, tab: 2, LiveTable: 'live', HistoryView: 'history', draftScope: page.registration(), t, device, groups, latest, groupErrors: {}, now, threshold: 5000, onRefresh() {}, historyNavigation: { current: {} }, queryMemory: { current: {} }, configurationReady: true, target: null, registers }
    assert.equal(evaluate(branch('LiveTable'), env), false); const history = evaluate(branch('HistoryView'), env); assert.equal(history.props.registers.length, 40); assert(!('watchSelection' in history.props))
    const selectionFn = find(source, node => ts.isFunctionDeclaration(node) && node.name?.text === 'useRegisterSelection')!, storage = new Map([['ps-regs-1', '[101,201]']])
    const historySelection = run(selectionFn, { useState: (init: () => unknown) => [init(), () => {}], useMemo: (fn: () => unknown) => fn(), useCallback: (fn: unknown) => fn, localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) } })(1, registers)
    assert.deepEqual([...historySelection[0]], [101, 201]); historySelection[1](new Set([102, 202])); assert.equal(storage.get('ps-regs-1'), '[102,202]')
    page.localTab(0); fresh = mountedTable(page.registration()); assert.equal(fresh.watch().selection, null); assert.equal(fresh.watch().only, false); assert.equal(fresh.comparison().current, null)
    const empty = hookDriver('LiveSnapshotComparison.tsx', 'LiveSnapshotComparison', { compareLiveSnapshots, useMemo: (fn: () => unknown) => fn() }, fresh.comparison()); try { assert.equal(renderToStaticMarkup(empty.tree), '') } finally { empty.dispose() }
    assert.equal(live.driver.lateWrites, 0); assert.equal(fresh.notices.length, 0)
  } finally { editor.driver.dispose(); live.driver.dispose(); comparison?.dispose(); fresh?.driver.dispose() }
})
await check('actual HistoryView cleanup aborts an old read without updating a newly mounted live table', async () => {
  const history = find(source, node => ts.isFunctionDeclaration(node) && node.name?.text === 'HistoryView')!, effect = find(history, node => ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect' && !!node.arguments[0]?.getText(source).includes('startHistoryQuery')) as ts.CallExpression
  const plan = historyQueryPlan({ objectId: 1, start: now, end: now + 10000, mode: 'chart', page: 0, registerIds: [101, 201] })!, queryTask: { current: HistoryQueryTask | null } = { current: null }
  let state: HistoryReadState<unknown> | null = null, writes = 0, signal: AbortSignal | undefined, resolve!: (value: unknown) => void
  const pending = new Promise<unknown>(done => { resolve = done })
  const cleanup = run(effect.arguments[0], { plan, queryTask, startHistoryQuery: (p: Parameters<typeof startHistoryQuery>[0], fetcher: Parameters<typeof startHistoryQuery>[1], changed: Parameters<typeof startHistoryQuery>[2]) => startHistoryQuery(p, fetcher, changed, { delayMs: 0, timeoutMs: 1000 }), request: (_url: string, options: { signal: AbortSignal }) => { signal = options.signal; return pending }, reduceHistoryRead, setReadState: (update: (old: HistoryReadState<unknown> | null) => HistoryReadState<unknown> | null) => { state = update(state); writes++ } })()
  const live = mountedTable()
  try {
    await new Promise(done => setTimeout(done, 10)); assert(signal); cleanup(); assert.equal(signal.aborted, true); assert.equal(queryTask.current, null)
    live.watch().onSelect(live.watch().scope, new Set([100])); live.render(); live.freeze(); const snapshot = live.comparison().current, frozen = liveSnapshotJson(snapshot.snapshot), before = writes
    resolve({ points: [], series: [], total: 0 }); await new Promise(done => setTimeout(done, 10)); live.render(); assert.equal(writes, before); assert.equal(live.comparison().current, snapshot); assert.equal(liveSnapshotJson(snapshot.snapshot), frozen); assert.deepEqual(live.watch().selection.ids, [100]); assert.equal(live.notices.length, 0)
  } finally { cleanup(); resolve({ points: [] }); live.driver.dispose() }
})
await check('watch controls associate stable unique descriptions with counts invalidation and recovery', () => {
  for (const english of [false, true]) {
    const view = model(english)
    try {
      const choose = () => view.driver.one('button', p => String(p.children).includes(english ? 'Choose watch' : '选择观察'))
      const ids = choose().props['aria-describedby']; assert.equal(typeof ids, 'string', 'watch opener must describe its scope/limit and current invalidation state')
      const references = ids.split(/\s+/); assert.equal(references.length, 2); for (const id of references) assert(view.driver.one('p', p => p.id === id))
      assert.equal(view.driver.one('input', p => p.type === 'checkbox').props['aria-describedby'], references[1]); assert.equal(view.driver.one('p', p => p.id === references[1]).props.role, 'status'); assert.equal(view.driver.one('p', p => p.id === references[1]).props['aria-atomic'], true)
      choose().props.onClick(); view.render(); view.driver.one(RegisterSelectModal).props.onApply(new Set([100, 200])); view.render(); assert.equal(view.driver.one('input', p => p.type === 'checkbox').props.disabled, false)
      view.change(Symbol('changed')); assert.equal(choose().props['aria-describedby'], ids); assert(view.html().includes(english ? 'old watch list is invalid' : '原观察清单已失效')); assert.equal(view.driver.one('input', p => p.type === 'checkbox').props.disabled, false, 'checked watch-only remains focusable to exit after invalidation')
      view.change(null); assert.equal(choose().props.disabled, true); const clear = view.driver.one('button', p => String(p.children).includes(english ? 'Clear watch' : '清空观察')); assert.equal(clear.props.disabled, false); assert.equal(clear.props['aria-describedby'], references[1])
      clear.props.onClick(); view.render(); assert.equal(view.only, false); assert.equal(view.selection, null)
    } finally { view.driver.dispose() }
  }
  const props = { selection: choose(), scope, only: true, matches, groups, t, onSelect() {}, onOnly() {}, onClear() {} }, html = renderToStaticMarkup(React.createElement(React.Fragment, null, React.createElement(LiveWatchList, props), React.createElement(LiveWatchList, props))), ids = [...html.matchAll(/id="([^"]+-(?:hint|status))"/g)].map(match => match[1]); assert.equal(ids.length, 4); assert.equal(new Set(ids).size, 4)
})
await check('actual picker describes limit and keeps removals keyboard-reachable without closing IME composition', () => {
  for (const english of [false, true]) {
    let closes = 0, applies = 0, restored = 0, firstFocus = 0, lastFocus = 0, prevented = 0, stopped = 0
    const opener = { focus() { restored++ } }, document = { activeElement: opener as unknown }, first = { focus() { firstFocus++ } }, last = { focus() { lastFocus++ } }
    const translate = (key: string) => key === 'cancel' ? english ? 'Cancel' : '取消' : key === 'curveSelectLimit' ? english ? 'Select up to {n} points' : '最多选择 {n} 个点位' : t(key)
    const picker = hookDriver('RegisterPicker.tsx', 'RegisterSelectModal', { addVisiblePickerPoints, filterPickerGroups, pickerSource, pickerSources, document }, { t: translate, groups, initial: new Set(), max: 1, onClose() { closes++ }, onApply() { applies++ } })
    try {
      const dialog = () => picker.one('div', p => p.role === 'dialog'), descriptions = dialog().props['aria-describedby']; assert.equal(typeof descriptions, 'string'); const refs = descriptions.split(/\s+/); assert.equal(refs.length, 2)
      assert.equal(picker.one('input', p => p.className === 'reg-picker-search').props.autoFocus, true); assert.equal(picker.one('input', p => p.type === 'checkbox').props['aria-describedby'], descriptions)
      const event = (key: string, composing = false, shiftKey = false) => ({ key, shiftKey, nativeEvent: { isComposing: composing }, preventDefault() { prevented++ }, stopPropagation() { stopped++ }, currentTarget: { querySelectorAll(selector: string) { assert(selector.includes(':not(:disabled)')); return [first, last] } } })
      dialog().props.onKeyDown(event('Escape', true)); assert.equal(closes, 0, 'IME cancellation must not discard the selection draft'); assert.equal(prevented, 0)
      picker.one('input', p => p.type === 'checkbox' && !p.checked).props.onChange(); picker.render(); const selected = picker.one('input', p => p.type === 'checkbox' && p.checked), extra = picker.one('input', p => p.type === 'checkbox' && !p.checked)
      assert.equal(selected.props.disabled, false); assert.notEqual(selected.props.tabIndex, -1); assert.equal(selected.props.onKeyDown, undefined, 'native checkbox activation stays native'); assert.equal(extra.props.disabled, true); assert(picker.one('span', p => p.id === refs[0]).props['aria-atomic']); assert(renderToStaticMarkup(picker.tree).includes(english ? 'Limit reached' : '已达上限'))
      assert.equal(picker.one('button', p => p.children === 'pickerSelectVisible').props['aria-describedby'], descriptions); selected.props.onChange(); picker.render(); assert.equal(picker.one('input', p => p.type === 'checkbox' && !p.checked).props.disabled, false); assert(!renderToStaticMarkup(picker.tree).includes(english ? 'Limit reached' : '已达上限')); assert.equal(dialog().props['aria-describedby'], descriptions)
      document.activeElement = last; dialog().props.onKeyDown(event('Tab')); assert.equal(firstFocus, 1); document.activeElement = first; dialog().props.onKeyDown(event('Tab', false, true)); assert.equal(lastFocus, 1); assert.equal(prevented, 2)
      document.activeElement = {}; dialog().props.onKeyDown(event('Tab')); assert.equal(prevented, 2)
      dialog().props.onKeyDown(event('Escape')); assert.equal(closes, 1); assert.equal(stopped, 1); assert.equal(prevented, 3); assert.equal(applies, 0)
    } finally { picker.dispose(); assert.equal(restored, 1); assert.equal(picker.lateWrites, 0) }
  }
})
console.log(`LIVE WATCH TEST OK: ${passed} pure/actual App and component groups; no requests, storage, database, collection, hardware, models or browser`)
