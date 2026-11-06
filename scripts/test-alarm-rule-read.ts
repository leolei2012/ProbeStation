import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AlarmRulesReader, parseAlarmRules, readAlarmRules, InvalidAlarmRulesError, alarmRuleReadError } from '../apps/web/src/alarm-rule-read.ts'
import { AlarmRuleReadStatus, alarmRuleSummaryKey } from '../apps/web/src/AlarmRuleReadStatus.tsx'
import { AlarmPanel } from '../apps/web/src/AlarmPanel.tsx'
import { LivePointFilters } from '../apps/web/src/LivePointFilters.tsx'
import { RequestTimeoutError } from '../apps/web/src/request-timeout.ts'

const rule = { id: 1, registerId: 101, operator: '>', threshold: 0, message: null }
const original = [{ ...rule, unrelated: 'PRIVATE-EXTRA' }], parsed = parseAlarmRules(original)
assert.deepEqual(parsed, [rule]); assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed[0]))
assert.equal(original[0].unrelated, 'PRIVATE-EXTRA'); assert.ok(!JSON.stringify(parsed).includes('PRIVATE-EXTRA'))
for (const operator of ['>', '>=', '==', '<=', '<', '!=']) assert.equal(parseAlarmRules([{ ...rule, operator, threshold: -1.5, message: '' }])[0].threshold, -1.5)
assert.equal(parseAlarmRules([{ ...rule, threshold: 1e100 }])[0].threshold, 1e100, 'no invented threshold bound or precision conversion')
const many = Array.from({ length: 10000 }, (_, i) => ({ ...rule, id: i + 1 }))
assert.equal(parseAlarmRules(many).length, 10000, 'complete lists are not truncated')
assert.throws(() => parseAlarmRules([...many, { ...rule, id: 10001, operator: '?' }]), InvalidAlarmRulesError, 'invalid tail cannot turn a partial list into a complete snapshot')
for (const value of [null, {}, '[]', [rule, rule], [{ ...rule, id: 0 }], [{ ...rule, id: 1.5 }], [{ ...rule, registerId: -1 }], [{ ...rule, registerId: '101' }], [{ ...rule, operator: 'unknown' }], [{ ...rule, threshold: '0' }], [{ ...rule, threshold: NaN }], [{ ...rule, threshold: Infinity }], [{ ...rule, message: undefined }], [{ ...rule, message: {} }], [rule, null]]) assert.throws(() => parseAlarmRules(value), InvalidAlarmRulesError)

const deferred = <T,>() => { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const flush = () => new Promise(resolve => setTimeout(resolve, 0))
let calls = 0, now = Date.parse('2026-11-06T00:00:00.123Z'), response: unknown = [rule]
const reader = new AlarmRulesReader(async () => { calls++; if (response instanceof Error) throw response; return response }, 1000, () => now)
let notifications = 0
const unsubscribe = reader.subscribe(() => notifications++)
assert.equal(calls, 0, 'construction/render/subscription do not fetch')
assert.equal(alarmRuleSummaryKey(reader.snapshot(), 0, 0, 0), 'alarmRulesUnverified', 'initial empty state must not claim no rules')
const first = reader.refresh(); assert.equal(alarmRuleSummaryKey(reader.snapshot(), 0, 0, 0), 'alarmRulesReading')
await first
const good = reader.snapshot(); assert.equal(good.status, 'ready'); assert.equal(good.updatedAt, now)
assert.equal(alarmRuleSummaryKey(good, 0, 1, 0), 'alarmNormal'); assert.equal(alarmRuleSummaryKey(good, 1, 1, 0), 'alarmActive')
assert.equal(alarmRuleSummaryKey(good, 0, 1, 1), 'alarmWaiting'); assert.equal(alarmRuleSummaryKey(good, 0, 0, 0), 'alarmNone')
now += 1000; response = new Error('mock network failure'); await reader.refresh()
const failed = reader.snapshot(); assert.equal(failed.status, 'error'); assert.equal(failed.rules, good.rules); assert.equal(failed.updatedAt, good.updatedAt)
assert.equal(alarmRuleSummaryKey(failed, 0, 1, 0), 'alarmRulesUnverified', 'a failed refresh cannot claim not triggered with cached rules')
assert.equal(alarmRuleSummaryKey(failed, 0, 0, 0), 'alarmRulesUnverified', 'a cached empty list cannot prove no current rules after failure')
assert.equal(alarmRuleReadError(failed.error), 'request')
response = [rule, { ...rule, id: 2, operator: 'unsupported' }]; await reader.refresh()
assert.ok(reader.snapshot().error instanceof InvalidAlarmRulesError); assert.equal(reader.snapshot().rules, good.rules, 'one malformed row rejects the complete replacement')
response = []; await reader.refresh(); assert.equal(reader.snapshot().status, 'ready'); assert.equal(reader.snapshot().rules.length, 0); assert.equal(reader.snapshot().updatedAt, now)
reader.invalidate(); assert.equal(reader.snapshot().status, 'loading'); assert.equal(reader.snapshot().updatedAt, now)
assert.throws(() => reader.accept({}), InvalidAlarmRulesError); assert.equal(reader.snapshot().status, 'loading', 'malformed post-write readback leaves state unverified')
reader.accept([rule]); assert.equal(reader.snapshot().status, 'ready')
assert.ok(notifications > 0); unsubscribe()

const pending: Array<ReturnType<typeof deferred<unknown>> & { signal: AbortSignal }> = []
const ordered = new AlarmRulesReader(signal => { const task = deferred<unknown>(); pending.push({ ...task, signal }); return task.promise }, 1000)
let events = 0; ordered.subscribe(() => events++)
const old = ordered.refresh(); await flush(); await ordered.refresh(); assert.equal(pending.length, 1, 'poll ticks coalesce rather than resetting the deadline')
const fresh = ordered.refresh(true); await flush(); assert.equal(pending.length, 2); assert.equal(pending[0].signal.aborted, true)
pending[1].resolve([{ ...rule, threshold: 10 }]); await fresh
pending[0].resolve([{ ...rule, threshold: 999 }]); await old; await flush()
assert.equal(ordered.snapshot().rules[0].threshold, 10, 'late abort-ignoring read cannot overwrite explicit retry')
const duringWrite = ordered.refresh(); await flush(); ordered.invalidate(); const invalidatedEvents = events
pending[2].reject(new Error('late old read')); await duringWrite; assert.equal(events, invalidatedEvents)
assert.equal(ordered.snapshot().status, 'loading')
ordered.accept([{ ...rule, threshold: 20 }]); assert.equal(ordered.snapshot().rules[0].threshold, 20)
const unmounted = ordered.refresh(); await flush(); ordered.stop(); const stoppedEvents = events
pending[3].resolve([]); await unmounted; assert.equal(events, stoppedEvents, 'unmount causes no state notification from a late result')
const restarted = ordered.refresh(); await flush(); pending[4].resolve([rule]); await restarted
assert.equal(ordered.snapshot().status, 'ready', 'effect cleanup/setup can restart a stopped reader')
const otherDevice = new AlarmRulesReader(async () => []); assert.equal(otherDevice.snapshot().rules.length, 0); assert.equal(otherDevice.snapshot().updatedAt, null)

let timedSignal: AbortSignal | undefined, retryNumber = 0
const slow = deferred<unknown>(), timed = new AlarmRulesReader(signal => { timedSignal = signal; return ++retryNumber === 1 ? slow.promise : Promise.resolve([rule]) }, 15)
await timed.refresh(); assert.equal(timed.snapshot().status, 'error'); assert.ok(timed.snapshot().error instanceof RequestTimeoutError); assert.equal(timedSignal!.aborted, true)
assert.equal(alarmRuleReadError(timed.snapshot().error), 'timeout')
await timed.refresh(true); slow.resolve([]); await flush(); assert.equal(timed.snapshot().rules.length, 1, 'deadline/retry settles even for an abort-ignoring fetcher')
const controller = new AbortController(); controller.abort()
let cancelledCalls = 0; await assert.rejects(readAlarmRules(async () => { cancelledCalls++; return [] }, controller.signal), { name: 'AbortError' }); assert.equal(cancelledCalls, 0)

let clicked = 0
const statusMarkup = (state = failed, english = false) => renderToStaticMarkup(createElement(AlarmRuleReadStatus, { state, onRetry: () => clicked++, english }))
assert.ok(statusMarkup().includes('告警状态待核实')); assert.ok(statusMarkup().includes('2026-11-06T00:00:00.123Z'))
assert.ok(statusMarkup().includes('只读规则')); assert.ok(statusMarkup().includes('全设备'))
assert.ok(statusMarkup({ ...failed, error: new RequestTimeoutError() }).includes('30秒'))
assert.ok(statusMarkup({ ...failed, error: new InvalidAlarmRulesError() }).includes('未接受部分规则'))
assert.ok(statusMarkup(failed, true).includes('Alarm status is unverified'))
assert.ok(!statusMarkup({ ...good, reading: false }).includes('<button'))
assert.ok(statusMarkup({ ...good, reading: true }).includes('正在刷新规则'))
assert.equal(statusMarkup({ ...good, reading: false }).replace(/>[^<]*</g, '><'), statusMarkup({ ...good, reading: true }).replace(/>[^<]*</g, '><'), 'routine polling keeps the same reserved-line structure')
assert.ok(statusMarkup(new AlarmRulesReader(async () => []).snapshot()).includes('尚未取得完整规则'))
const t = (key: string) => ({ cancel: '取消', alarmLabel: '告警', alarmNone: '未设置规则', alarmNormal: '未触发', alarmRulesUnverified: '规则待核实', alarmRulesReading: '正在读取规则' }[key] ?? key)
const initialPanel = renderToStaticMarkup(createElement(AlarmPanel, { t, device: { id: 1, isActive: 1 }, groups: [], latest: {}, groupErrors: {}, now, threshold: 5000 }))
const badge = /class="alarm-count"[^>]*>(.*?)<\/span>/.exec(initialPanel)![1]
assert.ok(badge.includes('规则待核实')); assert.ok(!badge.includes('未设置规则') && !badge.includes('未触发'), 'actual production initial summary is neutral, not a false empty/normal assertion')
const editor = renderToStaticMarkup(createElement(AlarmPanel, { t, device: { id: 1, isActive: 1 }, groups: [{ id: 1, name: 'mock', isActive: 1, registers: [{ ...rule, id: 101, alias: 'mock', startAddress: 0, dataType: 'uint16', functionCode: 3 }] }], latest: {}, groupErrors: {}, now, threshold: 5000, point: { id: 101, alias: 'mock', startAddress: 0, dataType: 'uint16', functionCode: 3 } }))
assert.ok(!/<p class="alarm-hint">未设置规则<\/p>/.test(editor)); assert.ok(editor.includes('class="btn primary" disabled=""'), 'unverified editor cannot submit a write')
const filter = renderToStaticMarkup(createElement(LivePointFilters, { search: '', source: '', sources: [], mode: 'all', counts: { all: 0, attention: 0, alarm: 0, data: 0, unknown: 0 }, rulesReady: false, ruleError: true, readingRules: false, onRetryRules: () => clicked++, onSearch: () => {}, onSource: () => {}, onMode: () => {}, onClear: () => {} }))
assert.ok(filter.includes('重新读取规则')); assert.ok(filter.includes('数量为0不代表无告警'))
assert.equal(clicked, 0, 'SSR never reads or invokes any action')
console.log('ALARM RULE READ OK: complete-list validation, loading/failed summary truth, retained snapshots, timeout/retry/coalescing, stale reads, write invalidation/readback, cleanup/restart and production bilingual SSR; mock only, no API/database/device/model.')
