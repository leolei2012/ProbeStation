import assert from 'node:assert/strict'
import { HistoryNavigation } from '../apps/web/src/history-navigation.ts'

const target = { deviceId: 1, view: 'history', registerId: 11, start: '2026-11-06T00:00:00Z', end: '2026-11-06T01:00:00Z', token: 1 }
const navigation = new HistoryNavigation()
assert.ok(navigation.consume(target, 1, [11], true)?.range)
assert.equal(navigation.consume({ ...target }, 1, [11, 12], true), null, 'a refreshed point list must not replay the old navigation and reset user analysis')
assert.equal(navigation.consume(target, 1, [], false), null, 'later configuration loading never reopens an already consumed range')
assert.ok(navigation.consume({ ...target, token: 2 }, 1, [11], true)?.range, 'an explicit repeated click is a new intent, even with identical dates/point')
const loading = new HistoryNavigation()
const first = loading.consume(target, 1, [], false)!
assert.ok(first.range); assert.deepEqual(first.focus, { state: 'waiting', id: 11 })
assert.equal(loading.consume(target, 1, [], false), null, 'loading rerenders do not reset the range repeatedly')
const focused = loading.consume(target, 1, [11, 12], true)!
assert.equal(focused.range, undefined, 'late definitions focus only the point; manually changed time and table/chart mode stay intact')
assert.deepEqual(focused.focus, { state: 'found', id: 11 })
assert.equal(loading.consume(target, 1, [11, 12, 13], true), null)
const manual = new HistoryNavigation()
manual.consume(target, 1, [], false); manual.cancelPending()
assert.equal(manual.consume(target, 1, [11, 12], true), null, 'explicit point choice supersedes deferred focus')
const missing = new HistoryNavigation()
missing.consume(target, 1, [], false)
const absent = missing.consume(target, 1, [12], true)!
assert.equal(absent.range, undefined); assert.deepEqual(absent.focus, { state: 'missing', id: 11 })
assert.equal(missing.consume(target, 1, [11], true), null, 'missing IDs are not silently remapped or retried on later unrelated configuration changes')
assert.deepEqual(missing.consume({ ...target, token: 3 }, 1, [11], true)?.focus, { state: 'found', id: 11 })
const empty = new HistoryNavigation().consume(target, 1, [], true)!
assert.deepEqual(empty.focus, { state: 'missing', id: 11 }, 'a loaded empty table is distinct from definitions still loading')
const cleared = new HistoryNavigation()
cleared.consume(target, 1, [], false); cleared.consume(null, 1, [], false)
assert.equal(cleared.consume(target, 1, [11], true), null, 'clearing a target cancels its pending focus')
for (const other of [{ ...target, view: 'live' }, { ...target, view: 'diagnostics' }, { ...target, deviceId: 2 }, { ...target, start: undefined }, { ...target, end: undefined }]) {
  assert.equal(new HistoryNavigation().consume(other, 1, [11], true), null)
}
for (const bad of [{ ...target, start: 'bad date' }, { ...target, end: target.start }, { ...target, start: target.end, end: target.start }, ...[0, -1, NaN, Infinity, 1.5].map(registerId => ({ ...target, registerId }))]) {
  const gate = new HistoryNavigation()
  assert.deepEqual(gate.consume(bad, 1, [11], true), { invalid: true })
  assert.equal(gate.consume(bad, 1, [11], true), null, 'an invalid event is reported once rather than replayed on refresh')
}
const all = new HistoryNavigation().consume({ ...target, registerId: undefined }, 1, [], true)!
assert.ok(all.range); assert.equal(all.focus, undefined, 'general ranged history links preserve the existing selection')
const legacy = new HistoryNavigation(), noToken = { ...target, token: undefined }
assert.ok(legacy.consume(noToken, 1, [11], true)?.range)
assert.equal(legacy.consume({ ...noToken }, 1, [11, 12], true), null)
const before = JSON.stringify(target)
new HistoryNavigation().consume(Object.freeze(target), 1, Object.freeze([11]), true)
assert.equal(JSON.stringify(target), before)
// Exercise applying the same actions as HistoryView, with simulated manual analysis in between.
const view = { range: 'default', mode: 'table', selected: [12], resets: 0 }, gate = new HistoryNavigation()
const apply = (action: ReturnType<HistoryNavigation['consume']>) => {
  if (action?.range) { view.range = String(action.range.start); view.mode = 'chart'; view.resets++ }
  if (action?.focus) view.selected = action.focus.state === 'found' ? [action.focus.id] : []
}
apply(gate.consume(target, 1, [], false)); view.range = 'manual range'; view.mode = 'table'
apply(gate.consume(target, 1, [11, 12], true))
assert.deepEqual(view, { range: 'manual range', mode: 'table', selected: [11], resets: 1 })
view.selected = [12]; gate.cancelPending(); apply(gate.consume(target, 1, [11, 12], true))
assert.deepEqual(view.selected, [12])
apply(gate.consume({ ...target, token: 99 }, 1, [11, 12], true))
assert.equal(view.resets, 2); assert.deepEqual(view.selected, [11])
console.log('HISTORY NAVIGATION OK: one-shot range intent, late definitions without time/mode reset, manual selection override, loaded-empty/missing IDs, explicit repeat, wrong scope, invalid events and immutable targets; pure state simulation, no DOM or model calls')
const rawTarget = { ...target, valueMode: 'raw' as const }, rawGate = new HistoryNavigation()
assert.equal(rawGate.consume(rawTarget, 1, [], false)!.valueMode, 'raw')
assert.equal(rawGate.consume(rawTarget, 1, [11], true)!.valueMode, undefined, 'late focus never repeats a value-mode change')
assert.equal(rawGate.consume({ ...rawTarget, valueMode: 'physical' }, 1, [11], true)!.valueMode, 'physical', 'explicit mode is part of the intent identity')
assert.equal(new HistoryNavigation().consume(target, 1, [11], true)!.valueMode, undefined, 'old targets preserve the current value mode')
for (const valueMode of ['other', '', null, 0]) assert.deepEqual(new HistoryNavigation().consume({ ...target, valueMode } as any, 1, [11], true), { invalid: true })
