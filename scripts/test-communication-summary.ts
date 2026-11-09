import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { apply } from '../packages/poller/src/index.ts'
import { ModbusDiagnostics } from '../packages/modbus/src/diagnostics.ts'
import { communicationScope, parseCommunicationSummary, CommunicationSummaryRead } from '../apps/web/src/communication-summary.ts'
import { CommunicationSummary } from '../apps/web/src/CommunicationSummary.tsx'
import { CommunicationSummaryView } from '../apps/web/src/CommunicationSummaryView.tsx'

const tcp = { id: 1, transport: 'tcp', mode: 'master' }, rtu = { id: 2, transport: 'rtu', serialPath: 'COM_MOCK', mode: 'master' }, shared = { ...rtu, id: 3 }
const scope = communicationScope(tcp), serialScope = communicationScope(rtu), devices = [tcp, rtu, shared]
let engine: any, sideEffects = 0
apply({ on() {}, provide(_name: string, value: any) { engine = value }, config: { getObject: (id: number) => devices.find(device => device.id === id) }, modbus: { createDriver() { sideEffects++; throw new Error('must not create driver') } }, store: { write() { sideEffects++ } }, emit() { sideEffects++ } } as any, { pollIntervalMs: 0, connectRetryMs: 0, watchdogTimeoutMs: 30000, autoResetFailThreshold: 0, autoResetCooldownMs: 0 })
const tcpStats = new ModbusDiagnostics('tcp', 3, { deviceId: 1, channelKey: 'tcp:1' }), serialStats = new ModbusDiagnostics('rtu', 3, { channelKey: 'rtu:COM_MOCK' })
const driver = (stats: ModbusDiagnostics) => ({ isConnected: () => true, getDiagnostics: () => stats.snapshot(), connect() { sideEffects++ }, readHoldingRegisters() { sideEffects++ }, clearDiagnostics() { sideEffects++ }, getFrames() { sideEffects++ } })
engine.drivers.set('tcp:1', driver(tcpStats)); engine.drivers.set('rtu:COM_MOCK', driver(serialStats))
for (const device of [tcp, rtu]) engine.driverBindings.set(engine.drivers.get(engine.driverKey(device)), engine.connectionSignature(device))
tcpStats.recordFrame('tx', Buffer.from([0, 1, 0, 0, 0, 6, 1, 3, 0, 0, 0, 1])); tcpStats.recordFrame('rx', Buffer.from([0, 1, 0, 0, 0, 3, 1, 0x83, 2]))
tcpStats.recordSuccess(0); tcpStats.recordError(new Error('Timeout'), 20); tcpStats.recordError({ message: '<script>synthetic exception</script>', exceptionCode: 2 }, 40); tcpStats.recordSuccess(24)
serialStats.recordSuccess(12); serialStats.recordError(new Error('Timeout'), 30)
const before = JSON.stringify(tcpStats.snapshot()), raw = JSON.parse(JSON.stringify(engine.getDeviceDiagnostics(1))), parsed = parseCommunicationSummary(raw, scope, '2026-11-07T12:00:00.000Z')
assert.equal(parsed.metrics!.successCount, 2); assert.equal(parsed.metrics!.errorCount, 2); assert.equal(parsed.metrics!.timeoutCount, 1); assert.equal(parsed.metrics!.consecutiveErrors, 0); assert.equal(parsed.metrics!.recentErrorRate, 0.5); assert.equal(parsed.metrics!.averageResponseMs, 21); assert.equal(parsed.metrics!.lastError!.exceptionCode, 2)
assert(Object.isFrozen(parsed)); assert(Object.isFrozen(parsed.metrics)); assert(Object.isFrozen(parsed.metrics!.lastError)); assert.equal(JSON.stringify(tcpStats.snapshot()), before)
for (const device of [rtu, shared]) { const value = parseCommunicationSummary(JSON.parse(JSON.stringify(engine.getDeviceDiagnostics(device.id))), communicationScope(device)); assert.equal(value.scope, 'channel'); assert.equal(value.metrics!.timeoutCount, 1) }
assert.equal(sideEffects, 0, 'getter never creates/connects, reads/writes hardware, clears frames or emits')
engine.drivers.delete('tcp:1'); const unavailable = parseCommunicationSummary(engine.getDeviceDiagnostics(1), scope); assert.equal(unavailable.metrics, null); assert.equal(unavailable.connected, false)
const empty = parseCommunicationSummary({ ...raw, metrics: new ModbusDiagnostics('tcp', 3, { deviceId: 1, channelKey: 'tcp:1' }).snapshot() }, scope); assert.equal(empty.metrics!.lastResponseMs, null); assert.equal(empty.metrics!.successCount, 0)
const instantStats = new ModbusDiagnostics('tcp', 3, { deviceId: 1, channelKey: 'tcp:1' }); instantStats.recordSuccess(0)
const instant = parseCommunicationSummary({ ...raw, metrics: instantStats.snapshot() }, scope); assert.equal(instant.metrics!.lastResponseMs, 0); assert.equal(instant.metrics!.averageResponseMs, 0); assert.equal(instant.metrics!.maxResponseMs, 0)
for (const bad of [null, [], {}, { ...raw, objectId: 2 }, { ...raw, scope: 'channel' }, { ...raw, channelKey: 'tcp:2' }, { ...raw, connected: 'true' }, { ...raw, metrics: undefined }]) assert.throws(() => parseCommunicationSummary(bad, scope))
for (const [key, value] of [['successCount', -1], ['errorCount', '2'], ['timeoutCount', 3], ['consecutiveErrors', 3], ['bufferedFrames', NaN], ['txFrames', 1.5], ['rxFrames', Infinity], ['recentErrorRate', 1.1], ['recentErrorRate', NaN], ['averageResponseMs', Infinity], ['lastResponseMs', -1], ['lastSuccessTime', 'invalid'], ['scope', 'channel'], ['deviceId', 2], ['channelKey', 'wrong'], ['lastError', { code: 'timeout', message: '', retryable: 'yes' }]]) assert.throws(() => parseCommunicationSummary({ ...raw, metrics: { ...raw.metrics, [key as string]: value } }, scope))
assert.throws(() => communicationScope({ id: 0, transport: 'tcp' })); assert.throws(() => communicationScope({ id: 1, transport: 'other' }))
const deferred = () => { let resolve!: (value: any) => void, reject!: (error: Error) => void; const promise = new Promise<any>((done, fail) => { resolve = done; reject = fail }); return { promise, resolve, reject } }
const reader = new CommunicationSummaryRead(scope); let requests = 0, notifications = 0
const stop = reader.subscribe(() => notifications++), first = deferred()
const a = reader.refresh(async (url, signal) => { requests++; assert.equal(url, '/api/monitor_objects/1/diagnostics'); assert(signal instanceof AbortSignal); return first.promise })
await Promise.resolve(); await reader.refresh(async () => { requests++; return raw }); assert.equal(requests, 1, 'single-flight read')
first.resolve(raw); await a; assert.equal(reader.snapshot().phase, 'ready')
await reader.refresh(async () => { throw new Error('PRIVATE endpoint error') }); assert.equal(reader.snapshot().phase, 'error'); assert.equal(reader.snapshot().error, 'request'); assert.equal(reader.snapshot().value!.metrics!.errorCount, 2); assert(!JSON.stringify(reader.snapshot()).includes('PRIVATE'))
await reader.refresh(async () => ({ ...raw, channelKey: 'other' })); assert.equal(reader.snapshot().error, 'invalid')
const slow = deferred(); let timedSignal!: AbortSignal
await reader.refresh(async (_url, signal) => { timedSignal = signal; return slow.promise }, 5); assert.equal(reader.snapshot().error, 'timeout'); assert(timedSignal.aborted)
await reader.refresh(async () => raw); slow.resolve({ ...raw, connected: false }); await Promise.resolve(); assert.equal(reader.snapshot().phase, 'ready'); assert.equal(reader.snapshot().value!.connected, true)
const late = deferred(); const old = reader.refresh(async () => late.promise); await Promise.resolve(); reader.cancel(); assert.equal(reader.snapshot().phase, 'idle'); await reader.refresh(async () => ({ ...raw, connected: false })); late.resolve(raw); await old; assert.equal(reader.snapshot().value!.connected, false)
const oldError = deferred(), pending = reader.refresh(async () => oldError.promise); await Promise.resolve(); reader.cancel(); oldError.reject(new Error('obsolete')); await pending; assert.notEqual(reader.snapshot().phase, 'error'); assert(notifications > 0); stop(); const count = notifications; await reader.refresh(async () => raw); assert.equal(notifications, count)
let callbacks = 0
for (const english of [false, true]) {
  const render = (state: any) => renderToStaticMarkup(createElement(CommunicationSummaryView, { state, english, refresh() { callbacks++ } }))
  const html = render({ phase: 'ready', value: parsed }); assert(html.includes('50.00%')); assert(html.includes('24 / 21 / 40')); assert(html.includes('&lt;script&gt;synthetic')); assert(!html.includes('<script>')); assert(html.includes(english ? 'may have recovered' : '可能已恢复'))
  const serial = parseCommunicationSummary(engine.getDeviceDiagnostics(2), serialScope); assert(render({ phase: 'ready', value: serial }).includes(english ? 'cannot be attributed' : '不能归因'))
  assert(render({ phase: 'error', error: 'timeout', value: parsed }).includes(english ? 'previous result' : '上次结果'))
  assert(render({ phase: 'ready', value: unavailable }).includes(english ? 'No diagnostic counters' : '没有提供诊断计数'))
  const zero = render({ phase: 'ready', value: empty }); assert(zero.includes(english ? 'No completed requests' : '尚无完成请求')); assert(!zero.includes('0.00%')); assert(!zero.includes(english ? 'Backend time text' : '后台时间原文'), 'absent times do not acquire fabricated timestamp text')
  assert(render({ phase: 'ready', value: instant }).includes('0 / 0 / 0'))
  assert(render({ phase: 'loading' }).includes('disabled=""'))
}
const previousZone = process.env.TZ
let timeCases = 0
try {
  for (const zone of ['UTC', 'America/New_York', 'Europe/Berlin', 'Asia/Shanghai']) {
    process.env.TZ = zone
    for (const timestamp of ['2026-02-30T12:00:00.123Z', '2026-01-01T24:00:00Z', '03/08/2026 02:30:00', '2026-03-08T02:30:00.123', '2026-11-01T01:30:00.1-04:00', '2026-11-01T01:30:00.123456789-05:00', '2026-10-25T02:30:00.123+02:00', '2026-10-25T02:30:00.123+01:00']) {
      const source = { ...raw, metrics: { ...raw.metrics, lastSuccessTime: timestamp, lastErrorTime: timestamp } }, original = JSON.stringify(source)
      const value = parseCommunicationSummary(source, scope)
      assert.equal(value.metrics!.lastSuccessTime, timestamp); assert.equal(value.metrics!.lastErrorTime, timestamp)
      for (const english of [false, true]) for (const phase of ['ready', 'error'] as const) {
        const html = renderToStaticMarkup(createElement(CommunicationSummaryView, { state: { phase, value, ...(phase === 'error' ? { error: 'request' as const } : {}) }, english, refresh() { callbacks++ } }))
        assert(html.includes(timestamp), 'diagnostic time keeps its raw text and precision, including legacy tolerated formats')
        assert(html.includes(english ? 'Backend time text' : '后台时间原文'), 'tolerated calendar strings must not appear to be verified timestamps')
        assert(html.includes(english ? 'calendar, zone and clock accuracy are unverified' : '日历、时区和时钟准确性未核实'))
        assert(html.includes(english ? 'A missing zone is not inferred' : '未标时区不推断'))
        if (phase === 'error') assert(html.includes(english ? 'previous result' : '上次结果'))
      }
      assert.equal(JSON.stringify(source), original); timeCases++
    }
    const read = new CommunicationSummaryRead(scope)
    await read.refresh(async () => raw); const previous = read.snapshot().value
    await read.refresh(async () => ({ ...raw, metrics: { ...raw.metrics, lastErrorTime: 'not-a-date PRIVATE' } }))
    assert.equal(read.snapshot().phase, 'error'); assert.equal(read.snapshot().error, 'invalid'); assert.equal(read.snapshot().value, previous)
    for (const english of [false, true]) { const html = renderToStaticMarkup(createElement(CommunicationSummaryView, { state: read.snapshot(), english, refresh() { callbacks++ } })); assert(!html.includes('PRIVATE')); assert(html.includes(english ? 'previous result' : '上次结果')) }
    await read.refresh(async () => raw); assert.equal(read.snapshot().phase, 'ready'); read.cancel()
  }
} finally { if (previousZone === undefined) delete process.env.TZ; else process.env.TZ = previousZone }
assert.equal(process.env.TZ, previousZone); assert.equal(sideEffects, 0); assert.equal(callbacks, 0)
console.log(`DIAGNOSTIC TIME TEXT OK: ${timeCases} raw/legacy/DST cases across 4 zones, bilingual current/retained uncertainty labels, invalid response/recovery, TZ restored; no hardware`)
const hidden = renderToStaticMarkup(createElement(CommunicationSummary, { device: tcp, get: async () => { callbacks++; throw new Error('SSR must not read') } })); assert(hidden.includes('aria-expanded="false"')); assert.equal(callbacks, 0)
const unsupported = renderToStaticMarkup(createElement(CommunicationSummary, { device: { id: 1, transport: 'future' }, get: async () => { callbacks++; throw new Error('must not read unknown scope') } })); assert(unsupported.includes('role="alert"')); assert(unsupported.includes('未请求统计')); assert.equal(callbacks, 0)
await import('./test-communication-binding.ts')
console.log('COMMUNICATION SUMMARY OK: real in-memory diagnostics producer + poller getter, TCP and shared RTU scope, unavailable/zero/recovered errors, counter/parseable-time/identity checks, immutable projection, single-flight timeout/recovery/cancel/stale/unsubscribe and bilingual SSR; no real DB, files, hardware, network, model or DOM automation')
