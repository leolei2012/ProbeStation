import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { encodeRegister } from '../packages/core/src/codec.ts'
import { sourceKey } from '../packages/core/src/sample-source.ts'
import { readPointAlarmValue, readPointAlarmObservation, type AlarmObservation } from '../apps/web/src/alarm-value.ts'
import { alarmHistoryState, openAlarmHistory, type AlarmHistoryState } from '../apps/web/src/alarm-history.ts'
import { AlarmHistoryAction } from '../apps/web/src/AlarmHistoryAction.tsx'
import { HistoryNavigation } from '../apps/web/src/history-navigation.ts'
import { historyTimeRange, resolveHistoryTimeRange } from '../apps/web/src/history-time-range.ts'
import { historyQueryPlan } from '../apps/web/src/history-query-task.ts'
import type { Sample } from '../apps/web/src/observation.ts'

const now = Date.parse('2026-11-06T00:00:00.987Z'), device = { id: 7, isActive: 1, mode: 'master', slaveId: 9 }, group = { isActive: 1, slaveId: 2 }
const point = { id: 101, alias: '温度', dataType: 'uint16', functionCode: 3, startAddress: 0 }, rule = { id: 1, registerId: 101, operator: '>', threshold: 100, message: null }
const word = (rawValue: number, slaveId = 2): Sample => ({ rawValue, slaveId, timestamp: new Date(now).toISOString(), timestampMs: now, quality: 'good', batchId: 'batch-' + slaveId })
const cache = { [sourceKey(7, 'holding-register', 0, 1)]: word(10, 1), [sourceKey(7, 'holding-register', 0, 2)]: word(200) }, before = JSON.stringify(cache)
const observation = readPointAlarmObservation(point, cache, device, group, now, 5000, false)!
assert.equal(observation.value, readPointAlarmValue(point, cache, device, group, now, 5000, false)); assert.equal(observation.slaveId, 2); assert.equal(observation.sampledAt, now)
assert.ok(Object.isFrozen(observation)); assert.equal(JSON.stringify(cache), before)
const state = (obs: AlarmObservation | null = observation, at = now, configuration = true, rules = true) => alarmHistoryState(obs, rule, point, device.id, configuration, rules, at, 5000)
const ready = state(); assert.equal(ready.kind, 'ready'); if (ready.kind !== 'ready') throw new Error('test precondition')
assert.ok(Object.isFrozen(ready) && Object.isFrozen(ready.target))
assert.equal(ready.target.start, '2026-11-05T23:55:00.987Z'); assert.equal(ready.target.end, '2026-11-06T00:00:00.987Z'); assert.equal(ready.target.valueMode, 'raw'); assert.equal(ready.target.registerId, 101)
assert.equal(Date.parse(ready.target.end!) - Date.parse(ready.target.start!), 300000, 'ends exactly at the displayed sample, not now or a future window')
assert.equal(state(null).kind, 'inactive'); assert.equal(state(observation, now, false).kind, 'waiting'); assert.equal(state(observation, now, true, false).kind, 'rules')
assert.equal(state(observation, now + 5001).kind, 'time'); assert.equal(state(observation, now + 5000).kind, 'ready')
assert.equal(state({ ...observation, sampledAt: now + 1 }).kind, 'time'); assert.equal(state({ ...observation, sampledAt: now + 0.5 }).kind, 'time')
assert.equal(state({ ...observation, sampledAt: NaN }).kind, 'time'); assert.equal(state({ ...observation, sampledAt: null }).kind, 'time')
for (const patch of [{ objectId: 8 }, { registerId: 202 }, { functionCode: 4 }, { address: 1 }, { dataType: 'uint32' }, { slaveId: NaN }, { width: 2 }]) assert.equal(state({ ...observation, ...patch }).kind, 'identity')
assert.equal(alarmHistoryState(observation, { ...rule, registerId: 202 }, point, 7, true, true, now, 5000).kind, 'identity')
assert.equal(alarmHistoryState(observation, { ...rule, threshold: 300 }, point, 7, true, true, now, 5000).kind, 'inactive')
assert.equal(alarmHistoryState(observation, rule, { ...point, id: 202 }, 7, true, true, now, 5000).kind, 'identity', 'same alias/address never substitutes another ID')
const other = readPointAlarmObservation({ ...point, id: 202 }, cache, device, { ...group, slaveId: 1 }, now, 5000, false)!
assert.equal(other.value, 10); assert.equal(alarmHistoryState(other, { ...rule, registerId: 202 }, { ...point, id: 202 }, 7, true, true, now, 5000).kind, 'inactive')
assert.equal(readPointAlarmObservation(point, { '7:holding-register:0': word(200, 1) }, device, group, now, 5000, false), null, 'wrong-source compatibility keys cannot supply a sample')
for (const invalid of [{ ...word(200), quality: 'bad' }, { ...word(200), rawValue: NaN }, { ...word(200), timestampMs: now - 5001 }]) assert.equal(readPointAlarmObservation(point, { [sourceKey(7, 'holding-register', 0, 2)]: invalid }, device, group, now, 5000, false), null)
assert.equal(readPointAlarmObservation(point, cache, { ...device, isActive: 0 }, group, now, 5000, false), null)
assert.equal(readPointAlarmObservation(point, cache, device, { ...group, isActive: 0 }, now, 5000, false), null)
assert.equal(readPointAlarmObservation(point, cache, device, group, now, 5000, true), null)
const future = readPointAlarmObservation(point, { [sourceKey(7, 'holding-register', 0, 2)]: { ...word(200), timestampMs: now + 500 } }, device, group, now, 5000, false)!
assert.equal(future.value, 200, 'existing alarm future-tolerance semantics remain intact'); assert.equal(state(future).kind, 'time', 'historical navigation does not guess a future sample')
const singleLegacy = { ...observation, batchId: null }; assert.equal(state(singleLegacy).kind, 'ready')
for (const dataType of ['uint32', 'uint32-LE', 'uint64', 'uint64-LE']) {
  const value = dataType.includes('64') ? (1n << 60n) + 1n : 65536, words = encodeRegister(dataType, value), p = { ...point, dataType }, r = { ...rule, threshold: 65535 }
  const latest: Record<string, Sample> = Object.fromEntries(words.map((rawValue, i) => [sourceKey(7, 'holding-register', i, 2), { ...word(rawValue), batchId: 'complete' }]))
  const read = () => readPointAlarmObservation(p, latest, device, group, now, 5000, false)
  const action = () => alarmHistoryState(read(), r, p, 7, true, true, now, 5000)
  assert.equal(read()!.value, value); assert.equal(action().kind, 'ready')
  const last = sourceKey(7, 'holding-register', words.length - 1, 2), good = latest[last]
  delete latest[last]; assert.equal(action().kind, 'inactive')
  latest[last] = { ...good, batchId: 'different' }; assert.equal(action().kind, 'inactive')
  latest[last] = { ...good, timestampMs: now - 500 }; assert.equal(read()!.value, value, 'existing alarm time-spread tolerance preserved'); assert.equal(action().kind, 'time', 'do not invent one timestamp from differing words')
  latest[last] = good
  for (const sample of Object.values(latest)) sample.batchId = null
  assert.equal(read()!.value, value, 'legacy alarm evaluation remains compatible'); assert.equal(action().kind, 'batch')
  for (const sample of Object.values(latest)) sample.batchId = 'recovered'
  assert.equal(action().kind, 'ready')
}
for (const [functionCode, area] of [[1, 'coil'], [2, 'discrete-input'], [3, 'holding-register'], [4, 'input-register']] as const) {
  const p = { ...point, functionCode }, sample = readPointAlarmObservation(p, { [sourceKey(7, area, 0, 2)]: word(functionCode <= 2 ? 1 : 200) }, device, group, now, 5000, false)
  assert.equal(alarmHistoryState(sample, { ...rule, threshold: functionCode <= 2 ? 0 : 100 }, p, 7, true, true, now, 5000).kind, 'ready')
}
const local = readPointAlarmObservation(point, { [sourceKey(7, 'holding-register', 0, 7)]: word(200, 7) }, { ...device, mode: 'slave', slaveId: 7 }, group, now, 5000, false)!
assert.equal(local.slaveId, 7)
let opened = 0, resolved = 0
assert.equal(openAlarmHistory(() => { resolved++; return state(observation, now + 6000) }, () => opened++).kind, 'time'); assert.equal(opened, 0)
openAlarmHistory(() => { resolved++; return ready }, target => { opened++; assert.equal(target, ready.target) }); assert.equal(resolved, 2); assert.equal(opened, 1)
const gate = new HistoryNavigation(), target = { ...ready.target, token: 1 }
const action = gate.consume(target, 7, [101, 202], true)!
assert.equal(action.valueMode, 'raw'); assert.deepEqual(action.focus, { state: 'found', id: 101 })
const range = resolveHistoryTimeRange(historyTimeRange(action.range!.start, action.range!.end, 'local'))
const plan = historyQueryPlan({ objectId: 7, ...range, mode: 'chart', page: 0, registerIds: [action.focus!.id] })!
const params = new URL(plan.url, 'http://example.invalid').searchParams
assert.equal(params.get('register_ids'), '101'); assert.equal(params.get('end'), ready.sampledAt)
assert.equal(gate.consume(target, 7, [101, 202], true), null, 'metadata refresh does not reapply raw mode or the captured range')
assert.equal(gate.consume({ ...target, token: 2 }, 7, [101, 202], true)!.valueMode, 'raw', 'explicit repeated click is a new intent')
assert.deepEqual(new HistoryNavigation().consume(target, 7, [202], true)!.focus, { state: 'missing', id: 101 }, 'missing current ID is not remapped by address/alias')
const previousTZ = process.env.TZ
try {
  process.env.TZ = 'America/New_York'
  const secondOccurrence = Date.parse('2026-11-01T06:02:00.987Z'), dst = alarmHistoryState({ ...observation, sampledAt: secondOccurrence }, rule, point, 7, true, true, secondOccurrence, 5000)
  if (dst.kind !== 'ready') throw new Error('DST precondition')
  assert.equal(dst.target.start, '2026-11-01T05:57:00.987Z'); assert.equal(dst.target.end, '2026-11-01T06:02:00.987Z')
} finally { if (previousTZ === undefined) delete process.env.TZ; else process.env.TZ = previousTZ }
let uiActions = 0
const render = (s: AlarmHistoryState, english = false) => renderToStaticMarkup(createElement(AlarmHistoryAction, { state: s, resolve: () => { uiActions++; return s }, onOpen: () => uiActions++, english }))
assert.ok(render(ready).includes('配置从站')); assert.ok(render(ready).includes('#101')); assert.ok(render(ready).includes(ready.sampledAt)); assert.ok(render(ready).includes('查看采样前5分钟'))
assert.ok(render(state(observation, now, false)).includes('disabled=""')); assert.ok(render({ kind: 'batch' }).includes('多字样本批次未验证')); assert.ok(render({ kind: 'time' }).includes('已过期'))
assert.ok(render(ready, true).includes('View 5 minutes before sample')); assert.equal(uiActions, 0, 'rendering never resolves clicks, navigates or sends requests')
console.log('ALARM HISTORY OK: exact displayed sample/source/ID, FC01–04, 32/64-bit BE/LE, unchanged legacy alarms, strict navigation batch/time, click expiry, raw one-shot history intent, milliseconds/DST, missing ID and bilingual SSR; mock only.')
