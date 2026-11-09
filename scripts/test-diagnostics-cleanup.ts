import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ConfigStore } from '../packages/config/src/index.ts'
import { apply } from '../packages/poller/src/index.ts'
import { ModbusDiagnostics } from '../packages/modbus/src/diagnostics.ts'
import { DiagnosticsCleanup, DiagnosticsCleanupRefused, DiagnosticsCleanupUncertain } from '../packages/poller/src/diagnostics-cleanup.ts'
import { diagnosticsCleanupTarget, parseDiagnosticsCleanupPreview, parseDiagnosticsCleanupResult } from '../packages/core/src/diagnostics-cleanup.ts'
import { registerDiagnosticsCleanup } from '../packages/api/src/diagnostics-cleanup.ts'
import { DiagnosticsCleanupFlow } from '../apps/web/src/diagnostics-cleanup-flow.ts'
import { DiagnosticsCleanupButton, DiagnosticsCleanupDialogView } from '../apps/web/src/DiagnosticsCleanupDialog.tsx'
import { RawFramesRead } from '../apps/web/src/raw-frames-read.ts'

const cfg = new ConfigStore({ dbPath: ':memory:' }), app = Fastify()
let engine: any, clears = 0, io = 0
apply({ on() {}, provide(_name: string, value: any) { engine = value }, config: cfg, modbus: { createDriver() { io++; throw new Error('no drivers') } }, store: { write() { io++ } }, emit() { io++ } } as any, { pollIntervalMs: 0, connectRetryMs: 0, watchdogTimeoutMs: 30000, autoResetFailThreshold: 0, autoResetCooldownMs: 0 })
registerDiagnosticsCleanup(app, engine)
const headers = { 'x-probestation-config': '1', host: 'mock.test:9090', origin: 'http://mock.test:9090' }
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
try {
  const a = cfg.createObject('<script>RTU one</script>', '', 502, 'master', { transport: 'rtu', serialPath: 'COM_MOCK' }), b = cfg.createObject('RTU two', '', 502, 'master', { transport: 'rtu', serialPath: 'COM_MOCK' }), c = cfg.createObject('TCP', 'mock.invalid', 502)
  cfg.createGroup(a.id, 'one', 3, 0, 1, 'read', 1); cfg.createGroup(b.id, 'two', 3, 0, 1, 'read', 2)
  const serial = new ModbusDiagnostics('rtu', 2000, { channelKey: 'rtu:COM_MOCK' }), tcp = new ModbusDiagnostics('tcp', 2000, { deviceId: c.id, channelKey: 'tcp:' + c.id })
  const makeDriver = (diag: ModbusDiagnostics) => ({ getDiagnostics: () => diag.snapshot(), getFrames: (n: number) => diag.getFrames(n), clearDiagnostics() { clears++; diag.clear() }, connect() { io++ }, readHoldingRegisters() { io++ }, writeRegister() { io++ } })
  const sd = makeDriver(serial), td = makeDriver(tcp); engine.drivers.set('rtu:COM_MOCK', sd); engine.drivers.set('tcp:' + c.id, td)
  for (const [target, driver] of [[a, sd], [c, td]] as const) engine.driverBindings.set(driver, engine.connectionSignature(target))
  const fill = () => { serial.recordFrame('tx', Buffer.from([1, 3, 0, 0])); serial.recordFrame('rx', Buffer.from([2, 3, 0, 0])); serial.recordSuccess(1); serial.recordError(new Error('timeout'), 10) }
  const post = (id: number, token: string, override: Record<string, string> = {}) => app.inject({ method: 'POST', url: `/api/monitor_objects/${id}/diagnostics/cleanup`, headers: { ...headers, ...override }, payload: { token } })
  const preview = async (id = a.id) => { const response = await app.inject(`/api/monitor_objects/${id}/diagnostics/cleanup-preview`); assert.equal(response.statusCode, 200); assert.equal(response.headers['cache-control'], 'no-store'); return parseDiagnosticsCleanupPreview(response.json(), id) }
  fill(); assert.equal(engine.getDeviceFrames(a.id).length, 1); assert.equal(engine.getDeviceFrames(b.id).length, 1)
  engine.clearDeviceDiagnostics(a.id)
  assert.equal(engine.getDeviceFrames(b.id).length, 0); assert.equal(serial.snapshot().successCount, 0); assert.equal(serial.snapshot().errorCount, 0, 'old clear is channel-wide and resets counters, not just visible frames')
  fill(); const metadata = JSON.stringify(cfg.exportBackup().devices), before = JSON.stringify(serial.snapshot()), first = await preview()
  assert.equal(first.scope, 'channel'); assert.equal(first.bufferedFrames, 2); assert.equal(JSON.stringify(serial.snapshot()), before); assert.equal(clears, 1)
  assert.equal((await post(a.id, first.token, { 'x-probestation-config': '' })).statusCode, 403); assert.equal((await post(a.id, first.token, { origin: 'http://other.test' })).statusCode, 403)
  assert.equal((await post(b.id, first.token)).statusCode, 409)
  assert.equal((await app.inject({ method: 'POST', url: `/api/monitor_objects/${a.id}/diagnostics/cleanup`, headers, payload: { token: first.token, extra: true } })).statusCode, 400)
  assert.equal((await app.inject({ method: 'POST', url: `/api/monitor_objects/${a.id}/diagnostics/cleanup`, headers, payload: { token: 'x'.repeat(17000) } })).statusCode, 413)
  serial.recordFrame('rx', Buffer.from([2, 3, 0, 1]))
  const results = await Promise.all([post(a.id, first.token), post(a.id, first.token)])
  for (const result of results) { assert.equal(result.statusCode, 200); assert.equal(parseDiagnosticsCleanupResult(result.json(), first).clearedFrames, 3) }
  assert.equal(clears, 2); assert.equal(serial.snapshot().bufferedFrames, 0); assert.equal(engine.getDeviceFrames(b.id).length, 0); assert.equal(JSON.stringify(cfg.exportBackup().devices), metadata)
  fill(); const replay = await post(a.id, first.token); assert.equal(replay.statusCode, 200); assert.equal(clears, 2); assert.equal(serial.snapshot().bufferedFrames, 2, 'replaying a completed token never clears new captures')
  const changed = await preview(); cfg.updateObject(a.id, { baudRate: 19200 }); assert.equal((await post(a.id, changed.token)).statusCode, 409); assert.equal(serial.snapshot().bufferedFrames, 2); cfg.updateObject(a.id, { baudRate: 9600 }); assert.equal((await post(a.id, changed.token)).statusCode, 409, 'a refused token stays consumed even when configuration changes back')
  const replaced = await preview(); engine.drivers.set('rtu:COM_MOCK', makeDriver(serial)); assert.equal((await post(a.id, replaced.token)).statusCode, 409); engine.drivers.set('rtu:COM_MOCK', sd)
  const role = await preview(); cfg.updateObject(a.id, { mode: 'slave' }); assert.equal((await post(a.id, role.token)).statusCode, 409); cfg.updateObject(a.id, { mode: 'master' })
  const unknown = await preview(), normalClear = sd.clearDiagnostics
  sd.clearDiagnostics = () => { normalClear(); throw new Error('PRIVATE after actual clear') }
  const uncertain = await post(a.id, unknown.token); assert.equal(uncertain.statusCode, 500); assert(!uncertain.body.includes('PRIVATE')); const n = clears
  fill(); assert.equal((await post(a.id, unknown.token)).statusCode, 500); assert.equal(clears, n); assert.equal(serial.snapshot().bufferedFrames, 2); sd.clearDiagnostics = normalClear
  // Post-clear readback failure is also consumed, even if the memory operation succeeded.
  const readback = await preview(), getter = sd.getDiagnostics; let afterClear = false
  sd.clearDiagnostics = () => { normalClear(); afterClear = true }; sd.getDiagnostics = () => { if (afterClear) throw new Error('PRIVATE readback'); return getter() }
  assert.equal((await post(a.id, readback.token)).statusCode, 500); const afterN = clears; assert.equal((await post(a.id, readback.token)).statusCode, 500); assert.equal(clears, afterN); sd.clearDiagnostics = normalClear; sd.getDiagnostics = getter
  const beforeReadFailure = await preview(), noClear = clears
  sd.getDiagnostics = () => { throw new Error('PRIVATE before write') }; assert.equal((await post(a.id, beforeReadFailure.token)).statusCode, 500); assert.equal(clears, noClear); sd.getDiagnostics = getter
  assert.equal((await post(a.id, beforeReadFailure.token)).statusCode, 500); assert.equal(clears, noClear, 'an uncertain attempt cannot later execute after the getter recovers')
  const tcpPreview = await preview(c.id); assert.equal(tcpPreview.bufferedFrames, 0); assert.equal((await post(c.id, tcpPreview.token)).statusCode, 200, 'zero-preview cleanup is still an explicit clear-at-execution operation')
  const adapter: typeof fetch = async (url, init) => { const response = await app.inject({ method: (init?.method ?? 'GET') as any, url: String(url), headers: { ...headers, ...(init?.headers as any) }, ...(init?.body ? { payload: String(init.body) } : {}) }); return new Response(response.body, { status: response.statusCode }) }
  fill(); const target = diagnosticsCleanupTarget(cfg.getObject(a.id)!), flow = new DiagnosticsCleanupFlow(adapter)
  await flow.preview(a.id); await flow.confirm('wrong current page'); assert.equal(flow.snapshot().phase, 'ready'); const oldClears = clears; await flow.confirm(target.targetKey); assert.equal(flow.snapshot().phase, 'completed'); assert.equal(clears, oldClears + 1); await flow.confirm(target.targetKey); assert.equal(clears, oldClears + 1)
  fill(); let writes = 0, lostToken = ''
  const lost = new DiagnosticsCleanupFlow(async (url, init) => { if (init?.method === 'POST') { writes++; lostToken = JSON.parse(String(init.body)).token; await adapter(url, init); throw new Error('synthetic response lost') }; return adapter(url, init) })
  await lost.preview(a.id); await lost.confirm(target.targetKey); assert.equal(lost.snapshot().phase, 'uncertain'); lost.closeRead(); await lost.confirm(target.targetKey); assert.equal(writes, 1)
  const reader = new RawFramesRead(cfg.getObject(a.id)!, 200); await reader.refresh(async () => engine.getDeviceFrames(a.id)); assert.equal(reader.snapshot().value!.frames.length, 0); assert.equal(lost.snapshot().phase, 'uncertain', 'an empty GET cannot prove the write response')
  fill(); assert.equal((await post(a.id, lostToken)).statusCode, 200); assert.equal(serial.snapshot().bufferedFrames, 2)
  const hold = deferred<Response>(); let posted: RequestInit | undefined, pendingWrites = 0
  const pendingFlow = new DiagnosticsCleanupFlow(async (url, init) => { if (init?.method === 'POST') { posted = init; pendingWrites++; return hold.promise }; return adapter(url, init) }, { slowWriteMs: 5 })
  await pendingFlow.preview(a.id); const pendingPreview = pendingFlow.snapshot().preview!, saving = pendingFlow.confirm(target.targetKey); await tick(); pendingFlow.closeRead(); await pendingFlow.preview(c.id); await pendingFlow.confirm(target.targetKey); await wait(8)
  assert.equal(pendingFlow.snapshot().phase, 'saving'); assert.equal(pendingFlow.snapshot().slow, true); assert.equal(pendingWrites, 1); assert.equal(posted!.signal, undefined); assert.equal(pendingFlow.snapshot().preview!.token, pendingPreview.token)
  hold.resolve(await adapter(`/api/monitor_objects/${a.id}/diagnostics/cleanup`, posted)); await saving; assert.equal(pendingFlow.snapshot().phase, 'completed')
  const badAck = new DiagnosticsCleanupFlow(async (url, init) => { if (init?.method === 'POST') { await adapter(url, init); return new Response(JSON.stringify({ ok: true })) }; return adapter(url, init) })
  await badAck.preview(a.id); await badAck.confirm(target.targetKey); assert.equal(badAck.snapshot().phase, 'uncertain')
  const conflict = new DiagnosticsCleanupFlow(async (url, init) => init?.method === 'POST' ? new Response('{}', { status: 409 }) : adapter(url, init)); await conflict.preview(a.id); await conflict.confirm(target.targetKey); assert.equal(conflict.snapshot().phase, 'rejected')
  const hang = new DiagnosticsCleanupFlow(async () => new Promise(() => {}), { previewTimeoutMs: 5 }); await hang.preview(a.id); assert.equal(hang.snapshot().phase, 'preview-error'); assert.equal(hang.snapshot().error, 'timeout')
  const late = deferred<Response>(), lateFlow = new DiagnosticsCleanupFlow(async () => late.promise); const oldRead = lateFlow.preview(a.id); await tick(); lateFlow.closeRead(); late.resolve(await adapter(`/api/monitor_objects/${a.id}/diagnostics/cleanup-preview`)); await oldRead; assert.equal(lateFlow.snapshot().phase, 'idle')
  reader.invalidate(); assert.equal(reader.snapshot().value, undefined)
  let callbacks = 0
  for (const english of [false, true]) {
    const render = (state: any, wanted = target, blocked = false) => renderToStaticMarkup(createElement(DiagnosticsCleanupDialogView, { state, wanted, blocked, english, preview() { callbacks++ }, confirm() { callbacks++ }, close() { callbacks++ } }))
    const html = render({ phase: 'ready', preview: first }); assert(html.includes(english ? 'Shared RTU' : '共享RTU')); assert(html.includes(english ? 'after preview' : '预览后新增')); assert(html.includes('&lt;script&gt;')); assert(!html.includes('<script>'))
    assert(render({ phase: 'uncertain', preview: first }).includes(english ? 'never replayed' : '不会重放'))
    assert(render({ phase: 'saving', preview: first, slow: true }).includes(english ? 'does not cancel' : '不会取消'))
    const blocked = render({ phase: 'ready', preview: first }, target, true); assert.equal((blocked.match(/disabled=""/g) ?? []).length, 2)
    const mismatch = render({ phase: 'ready', preview: first }, diagnosticsCleanupTarget(cfg.getObject(c.id)!)); assert(mismatch.includes(english ? 'differs' : '不同')); assert(mismatch.includes('disabled=""'))
  }
  renderToStaticMarkup(createElement(DiagnosticsCleanupButton, { device: cfg.getObject(a.id)!, flow, onCleared() { callbacks++ } })); assert.equal(callbacks, 0)
  const scopePreview = await preview(); cfg.reopen(':memory:'); cfg.createObject(a.name, '', 502, 'master', { transport: 'rtu', serialPath: 'COM_MOCK' }); assert.equal((await post(a.id, scopePreview.token)).statusCode, 409, 'identical IDs/connection in reopened memory workspace do not authorize the old preview')
  assert.equal(io, 0)
} finally { await app.close(); (cfg as any).db.close() }

const target = diagnosticsCleanupTarget({ id: 1, name: 'synthetic', transport: 'tcp', ip: 'mock.invalid', port: 502 }), diag = new ModbusDiagnostics('tcp', 3, { deviceId: 1, channelKey: 'tcp:1' })
let clock = 0, identity = 'first', single = 0
const held = { target, identity, configurationScope: Symbol(), driver: { getDiagnostics: () => diag.snapshot(), clearDiagnostics() { single++; diag.clear() } } }
const manager = new DiagnosticsCleanup(() => ({ ...held, identity }), { now: () => clock, ttlMs: 10, capacity: 2 })
const expired = manager.preview(1); clock = 10; assert.throws(() => manager.confirm(1, expired.token), DiagnosticsCleanupRefused)
const stale = manager.preview(1); identity = 'changed'; assert.throws(() => manager.confirm(1, stale.token), DiagnosticsCleanupRefused)
const ready = manager.preview(1); assert.throws(() => manager.preview(1), DiagnosticsCleanupRefused); manager.confirm(1, ready.token); diag.recordFrame('tx', Buffer.from([0])); manager.confirm(1, ready.token); assert.equal(single, 1); assert.equal(diag.snapshot().bufferedFrames, 1)
assert.throws(() => parseDiagnosticsCleanupPreview(ready, 2)); assert.throws(() => parseDiagnosticsCleanupResult({ ok: true }, ready))
assert.throws(() => diagnosticsCleanupTarget({ id: 1, name: 'slave', mode: 'slave', transport: 'tcp', ip: 'mock.invalid', port: 502 }))
console.log('DIAGNOSTICS CLEANUP OK: real memory config/diagnostics/poller and injected API shared-RTU repro, explicit all-at-confirm reset, replay/new-record preservation, connection/driver/workspace/role guards, expiry/capacity, thrown/readback unknown no replay, origin/body guards, client response-loss/single-write/slow/close/timeout recovery semantics, matching acknowledgments and bilingual SSR; no real data, sockets, hardware, model or DOM automation')
