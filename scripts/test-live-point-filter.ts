import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { evaluateLivePoints, livePointFilterResult, matchesLivePointFilter } from '../apps/web/src/live-point-filter.ts'
import { LivePointFilters } from '../apps/web/src/LivePointFilters.tsx'
import { sourceKey } from '../packages/core/src/sample-source.ts'
import { readPointAlarmValue } from '../apps/web/src/alarm-value.ts'
import { alarmMatches } from '../packages/core/src/alarm.ts'
import { encodeRegister } from '../packages/core/src/codec.ts'
import type { Sample } from '../apps/web/src/observation.ts'

const now = Date.parse('2026-11-06T00:00:00Z'), device = { id: 1, isActive: 1, mode: 'master', slaveId: 9 }, threshold = 5000
const point = (id: number, startAddress: number, dataType = 'uint16') => ({ id, startAddress, dataType, functionCode: 3, alias: id === 2 || id === 7 ? '温度' : 'point-' + id })
const groups = [
  { id: 1, name: '冷机组', slaveId: 1, isActive: 1, functionCode: 3, registers: [point(1, 0), point(2, 1), point(3, 2, 'uint32'), point(4, 3), point(5, 4), point(6, 5)] },
  { id: 2, name: '第二来源', slaveId: 2, isActive: 1, functionCode: 3, registers: [point(7, 1), point(8, 2)] },
  { id: 3, name: '已暂停', slaveId: 3, isActive: 0, functionCode: 3, registers: [point(9, 0)] },
  { id: 4, name: '来源未知', slaveId: undefined, isActive: 1, functionCode: 3, registers: [point(10, 0)] },
]
const sample = (slaveId: number, rawValue: number, time = now, batchId = 'batch-' + slaveId): Sample => ({ slaveId, rawValue, quality: 'good', timestamp: new Date(time).toISOString(), timestampMs: time, batchId })
const latest: Record<string, Sample> = {}
for (const [source, address, value, time, batch] of [[1, 0, 10, now, 'a'], [1, 1, 200, now, 'a'], [1, 2, 1, now, 'a'], [1, 3, 0, now, 'b'], [1, 4, 200, now - 6000, 'a'], [2, 1, 10, now, 'c'], [2, 2, 1, now + 2000, 'c'], [3, 0, 200, now, 'd']] as const) latest[sourceKey(1, 'holding-register', address, source)] = sample(source, value, time, batch)
const views = new Map(groups.flatMap(g => g.registers).map(p => [p.id, { covered: p.id === 4, invalid: [3, 6, 10].includes(p.id) }]))
const rules = groups.flatMap(g => g.registers).map(p => ({ id: p.id, registerId: p.id, operator: '>', threshold: [1, 2, 5, 7, 9].includes(p.id) ? 100 : 0, message: null }))
const before = JSON.stringify({ groups, latest, views: [...views], rules })
const states = evaluateLivePoints(groups, views, latest, device, rules, {}, now, threshold)
assert.equal(states.get(2)!.health.stale || views.get(2)!.invalid, false, 'old issues-only predicate hides this fresh alarm')
assert.equal(states.get(2)!.alarmActive, true); assert.equal(states.get(2)!.attention, true, 'fresh triggered alarms must remain in attention')
assert.equal(states.get(7)!.alarmActive, false, 'same-address other source does not borrow the triggered value')
assert.equal(states.get(8)!.alarmUnknown, true, 'future samples stay unknown under existing alarm checks')
assert.equal(states.get(4)!.attention, false, 'covered placeholder rules do not enter attention counts')
const unknownLegacy = evaluateLivePoints([groups[3]], views, { ...latest, '1:holding-register:0': sample(1, 200) }, device, rules, {}, now, threshold)
assert.equal(unknownLegacy.get(10)!.alarmActive, false, 'unknown configured source must not borrow any legacy source to trigger a rule')
assert.equal(unknownLegacy.get(10)!.alarmUnknown, true)
for (const slaveId of [NaN, -1, 256]) assert.equal(evaluateLivePoints([{ ...groups[1], slaveId }], views, latest, device, rules, {}, now, threshold).get(7)!.alarmActive, false)
const matchedLegacy = evaluateLivePoints([groups[1]], views, { '1:holding-register:1': sample(2, 200) }, device, rules, {}, now, threshold)
assert.equal(matchedLegacy.get(7)!.alarmActive, true, 'legacy keys remain compatible only when metadata explicitly matches the configured source')
const rawSemantics = evaluateLivePoints(groups.map(g => ({ ...g, registers: g.registers.map(p => ({ ...p, factor: 0, offset: -999 })) })), views, latest, device, rules, {}, now, threshold)
assert.equal(rawSemantics.get(2)!.alarmActive, true, 'display scaling/offset never changes raw-value alarm comparisons')
const all = livePointFilterResult(groups, states, '', '', 'all')
assert.deepEqual(all.counts, { all: 10, attention: 7, alarm: 1, data: 5, unknown: 6 })
assert.deepEqual([...livePointFilterResult(groups, states, '', '', 'alarm').visibleIds], [2])
assert.deepEqual([...livePointFilterResult(groups, states, '', '', 'attention').visibleIds], [2, 3, 5, 6, 8, 9, 10])
assert.deepEqual([...livePointFilterResult(groups, states, ' 温度 ', '', 'all').visibleIds], [2, 7])
assert.deepEqual(livePointFilterResult(groups, states, '温度', '', 'alarm').counts, { all: 2, attention: 1, alarm: 1, data: 0, unknown: 0 }, 'counts apply search/source before status, not after')
assert.deepEqual([...livePointFilterResult(groups, states, '0x0001', '2', 'all').visibleIds], [7])
assert.deepEqual([...livePointFilterResult(groups, states, 'slave:2 id:7', '', 'all').visibleIds], [7])
assert.deepEqual([...livePointFilterResult(groups, states, '#7', '', 'all').visibleIds], [7])
assert.equal(livePointFilterResult(groups, states, 'id:70', '', 'all').counts.all, 0)
assert.equal(livePointFilterResult(groups, states, '冷机组', '', 'all').counts.all, 6)
assert.deepEqual([...livePointFilterResult(groups, states, '', '?', 'all').visibleIds], [10])
assert.equal(matchesLivePointFilter(undefined, 'alarm'), false)
assert.deepEqual(livePointFilterResult([], new Map(), '', '', 'all').counts, { all: 0, attention: 0, alarm: 0, data: 0, unknown: 0 })
assert.equal(JSON.stringify({ groups, latest, views: [...views], rules }), before, 'evaluation/filtering never mutates cache, definitions or rules')
for (const group of groups) for (const reg of group.registers) if (!views.get(reg.id)!.covered) {
  const value = readPointAlarmValue(reg, latest, device, group, now, threshold, false)
  assert.equal(states.get(reg.id)!.alarmActive, alarmMatches(value, '>', rules.find(rule => rule.registerId === reg.id)!.threshold), 'filter and existing source-qualified alarm evaluator agree')
}
const fault = evaluateLivePoints(groups, views, latest, device, rules, { 1: 'mock fault' }, now, threshold)
assert.equal(fault.get(2)!.alarmActive, false); assert.equal(fault.get(2)!.alarmUnknown, true); assert.equal(fault.get(2)!.dataIssue, true)
const otherDevice = evaluateLivePoints(groups, views, latest, { ...device, id: 2 }, rules, {}, now, threshold)
assert.equal(otherDevice.get(2)!.alarmActive, false); assert.equal(otherDevice.get(2)!.alarmUnknown, true, 'a different device cannot borrow this device cache')
const badQuality = evaluateLivePoints(groups, views, { ...latest, [sourceKey(1, 'holding-register', 1, 1)]: { ...latest[sourceKey(1, 'holding-register', 1, 1)], quality: 'bad' } }, device, rules, {}, now, threshold)
assert.equal(badQuality.get(2)!.alarmActive, false); assert.equal(badQuality.get(2)!.alarmUnknown, true); assert.equal(badQuality.get(2)!.dataIssue, true)
const paused = evaluateLivePoints(groups, views, latest, { ...device, isActive: 0 }, rules, {}, now, threshold)
assert.equal(paused.get(2)!.alarmActive, false); assert.equal(paused.get(2)!.dataIssue, true)
const recovery = structuredClone(latest)
recovery[sourceKey(1, 'holding-register', 3, 1)].batchId = 'a'
recovery[sourceKey(1, 'holding-register', 4, 1)] = sample(1, 200)
recovery[sourceKey(1, 'holding-register', 5, 1)] = sample(1, 1)
recovery[sourceKey(1, 'holding-register', 2, 2)] = sample(2, 1)
recovery[sourceKey(1, 'holding-register', 0, 4)] = sample(4, 1)
const recoveredGroups = groups.map(g => ({ ...g, isActive: 1, slaveId: g.slaveId ?? 4 })), recoveredViews = new Map([...views].map(([id, view]) => [id, { ...view, invalid: false }]))
const recovered = evaluateLivePoints(recoveredGroups, recoveredViews, recovery, device, rules, {}, now, threshold)
assert.equal(livePointFilterResult(recoveredGroups, recovered, '', '', 'unknown').counts.unknown, 0)
assert.equal(recovered.get(3)!.alarmActive, true, 'a complete valid batch restores rule evaluation')
assert.equal(recovered.get(9)!.alarmActive, true)
for (const dataType of ['uint32', 'uint32-LE', 'uint64', 'uint64-LE', 'float32']) {
  const words = encodeRegister(dataType, dataType.includes('64') ? 1152921504606846976n : 65536)
  const group = { ...groups[1], registers: [point(7, 0, dataType)] }, cache: Record<string, Sample> = {}
  words.forEach((value, i) => { cache[sourceKey(1, 'holding-register', i, 2)] = sample(2, value) })
  const state = () => evaluateLivePoints([group], new Map([[7, { covered: false, invalid: false }]]), cache, device, rules, {}, now, threshold).get(7)!
  assert.equal(state().alarmActive, true)
  cache[sourceKey(1, 'holding-register', words.length - 1, 2)].batchId = 'different'
  assert.equal(state().alarmActive, false); assert.equal(state().alarmUnknown, true)
}
for (const [functionCode, area] of [[1, 'coil'], [2, 'discrete-input'], [3, 'holding-register'], [4, 'input-register']] as const) {
  const group = { ...groups[1], functionCode, registers: [{ ...point(7, 0), functionCode }] }
  const state = evaluateLivePoints([group], views, { [sourceKey(1, area, 0, 2)]: sample(2, 200) }, device, rules, {}, now, threshold).get(7)!
  assert.equal(state.alarmActive, true)
}
const localCache = { [sourceKey(1, 'holding-register', 1, 9)]: sample(9, 200) }
assert.equal(evaluateLivePoints([groups[1]], views, localCache, { ...device, mode: 'slave' }, rules, {}, now, threshold).get(7)!.alarmActive, true)
assert.deepEqual([...livePointFilterResult([groups[1]], states, 'slave:9', '9', 'all', 9).visibleIds], [7, 8], 'local slave filters use device source, not group metadata')
const noRules = evaluateLivePoints(groups, views, latest, device, [], {}, now, threshold)
assert.equal(noRules.get(2)!.attention, false); assert.equal(noRules.get(8)!.alarmUnknown, false, 'unknown-rule counts refer only to loaded rules, never guessed rules')

const largePoints = Array.from({ length: 10000 }, (_, i) => point(i + 1, i)), largeGroup = { ...groups[0], registers: largePoints }, largeCache: Record<string, Sample> = {}
for (const p of largePoints) largeCache[sourceKey(1, 'holding-register', p.startAddress, 1)] = sample(1, 1)
const largeViews = new Map(largePoints.map(p => [p.id, { covered: false, invalid: false }])), largeRules = largePoints.filter(p => p.id % 1000 === 0).map(p => ({ id: p.id, registerId: p.id, operator: '>', threshold: 0, message: null }))
const largeStates = evaluateLivePoints([largeGroup], largeViews, largeCache, device, largeRules, {}, now, threshold)
assert.equal(livePointFilterResult([largeGroup], largeStates, '', '', 'alarm').visibleIds.size, 10)
assert.deepEqual([...livePointFilterResult([largeGroup], largeStates, 'id:10000', '', 'all').visibleIds], [10000])

let actions = 0
const render = (rulesReady = true, ruleError = false, english = false) => renderToStaticMarkup(createElement(LivePointFilters, { search: '<search>', source: '2', sources: ['1', '2', '?'], mode: 'alarm', counts: all.counts, rulesReady, ruleError, english, onSearch() { actions++ }, onSource() { actions++ }, onMode() { actions++ }, onClear() { actions++ } }))
assert.match(render(), /已触发告警/); assert.match(render(), /&lt;search&gt;/); assert.match(render(), /aria-pressed="true"/)
assert.match(render(false), /规则尚未载入/); assert.match(render(true, true), /数量为0不代表无告警/)
assert.match(render(true, false, true), /Triggered alarms/)
assert.match(render(), /临时展开匹配分组/); assert.equal(actions, 0)
console.log('LIVE POINT FILTER OK: fresh alarm regression, loaded-rule unknown states, source/device/area and coherent 32/64-bit checks, pause/fault/recovery, scoped counts/search/IDs, placeholders, 10000 points, immutable input and SSR; no hardware, database, API or network')
