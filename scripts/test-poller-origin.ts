import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { registerRegisterWrite } from '../packages/api/src/register-write.ts'
import { ConfigStore, type DeviceRecord } from '../packages/config/src/index.ts'
import { apply } from '../packages/poller/src/index.ts'
import { Recorder } from '../packages/mcp/src/recorder.ts'
import { DeviceSlaves } from '../packages/slave/src/devices.ts'
import { captureAcquisitionOrigin, acquisitionOriginMatches } from '../packages/core/src/acquisition-origin.ts'

function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail }); return { promise, resolve, reject } }
const options = { pollIntervalMs: 1000, connectRetryMs: 0, watchdogTimeoutMs: 30000, autoResetFailThreshold: 0, autoResetCooldownMs: 0 }
async function scenario(run: (h: any) => Promise<void>, extra: Partial<DeviceRecord> = {}) {
  const listeners = new Map<string, ((event: any) => void)[]>(), stored: any[] = [], events: any[] = [], drivers: any[] = [], writes: any[] = []
  const hooks = { notify: true, beforeResult: undefined as undefined | (() => void), connect: async (_d: any) => {}, read: async (_d: any, _start: number, count: number) => Array(count).fill(7) }
  const emit = (name: string, event: any) => { if (name === 'poller/result') hooks.beforeResult?.(); events.push({ name, event }); for (const listener of listeners.get(name) ?? []) listener(event) }
  const cfg = new ConfigStore({ dbPath: ':memory:' }, (scope, id) => { if (hooks.notify) emit('config/changed', { scope, id }) })
  const device = cfg.createObject('mock origin', 'before.mock.invalid', 502, 'master', extra), group = cfg.createGroup(device.id, 'mock group', 3, 0, 1)
  let engine: any
  let dispose: (() => Promise<void>) | undefined
  const ctx: any = { config: cfg, store: { write: (points: any[]) => stored.push(...points), flush: async () => {} }, modbus: { createDriver: () => {
    const d = { connected: false, target: null as any, disconnects: 0, reads: 0,
      async connect(target: any) { d.target = { ...target }; await hooks.connect(d); d.connected = true },
      async disconnect() { d.disconnects++; d.connected = false }, isConnected: () => d.connected,
      readHoldingRegisters: (start: number, count: number) => { d.reads++; return hooks.read(d, start, count) },
      writeRegister: async (...args: unknown[]) => { writes.push({ target: { ...d.target }, args }) } }
    drivers.push(d); return d
  } }, on(name: string, fn: any) { listeners.set(name, [...listeners.get(name) ?? [], fn]) }, emit,
  provide(_name: string, value: any) { engine = value }, effect(setup: any) { dispose = setup() }, logger: () => ({ info() {}, warn() {} }) }
  const recorder = new Recorder(ctx, cfg)
  apply(ctx, options)
  const h = { cfg, device, group, engine, recorder, hooks, drivers, writes, stored, events, emit, ctx, dispose: () => dispose!(),
    start: () => recorder.startRecording(device.id, 10, 60000),
    poll: () => { engine.groupsByDevice.set(device.id, [group]); return engine.pollNextGroup(cfg.getObject(device.id)) } }
  try { await run(h) }
  finally { for (const s of recorder.listRecordings()) recorder.deleteRecording(s.id); await engine.stopAll(); (cfg as any).db.close() }
}

// Failed against 817fda1: the fresh recording contained the old value [99].
await scenario(async ({ cfg, device, recorder, hooks, start, poll, stored, drivers }) => {
  const entered = deferred<void>(), response = deferred<number[]>()
  hooks.read = () => { entered.resolve(); return response.promise }
  start(); const pending = poll(); await entered.promise
  cfg.updateObject(device.id, { ip: 'after.mock.invalid' }); const fresh = start()
  response.resolve([99]); await pending
  assert.equal(recorder.getRecording(fresh)!.samples.length, 0, 'old in-flight producer must not populate a new recording after the source changes')
  assert.equal(stored.length, 0, 'stale values must not enter latest/history either')
  hooks.read = async () => [77]; await poll()
  assert.deepEqual(recorder.getRecording(fresh)!.samples.map((p: any) => p.rawValue), [77])
  assert.equal(drivers.length, 2); assert.equal(drivers[0].disconnects, 1); assert.equal(drivers[1].target.ip, 'after.mock.invalid', 'new reads must not reuse the old TCP connection under the same object ID')
})
for (const action of ['aba', 'reconnect', 'stop', 'reopen', 'delete', 'disable', 'role', 'failure']) await scenario(async ({ cfg, device, group, engine, recorder, hooks, start, poll, stored, events }) => {
  const entered = deferred<void>(), response = deferred<number[]>()
  hooks.read = () => { entered.resolve(); return response.promise }
  const old = start(), pending = poll(); await entered.promise
  if (action === 'aba') { hooks.notify = false; cfg.updateObject(device.id, { ip: 'temporary.mock.invalid' }); cfg.updateObject(device.id, { ip: device.ip }) }
  if (action === 'reconnect') await engine.reconnectDevice(device.id)
  if (action === 'stop') await engine.stopAll()
  if (action === 'reopen') { cfg.reopen(':memory:'); const again = cfg.createObject('same numeric ID', device.ip, device.port); assert.equal(again.id, device.id); cfg.createGroup(again.id, 'new', 3, 0, 1) }
  if (action === 'delete') cfg.deleteObject(device.id)
  if (action === 'disable') cfg.updateObject(device.id, { isActive: 0 })
  if (action === 'role') cfg.updateObject(device.id, { mode: 'slave', ip: '0.0.0.0' })
  if (action === 'failure') { cfg.updateObject(device.id, { port: 1502 }); engine.groupErrors.set(group.id, 'current generation fault') }
  let fresh: string | undefined
  if (!['delete', 'disable', 'role'].includes(action)) { recorder.stopRecording(old); fresh = start() }
  const deadline = engine.nextAt.get(device.id)
  if (action === 'failure') response.reject(new Error('old private failure')); else response.resolve([99])
  await pending
  assert.equal(stored.length, 0, action); if (fresh) assert.equal(recorder.getRecording(fresh)!.samples.length, 0, action)
  assert(!events.some((e: any) => e.name === 'poller/group-error' && String(e.event.error).includes('private')))
  if (action === 'failure') assert.equal(engine.groupErrors.get(group.id), 'current generation fault')
  if (action === 'stop') assert.equal(engine.nextAt.get(device.id), deadline, 'old finalizer must not overwrite the current deadline')
})
await scenario(async ({ cfg, device, recorder, hooks, start, poll, stored }) => {
  const entered = deferred<void>(), response = deferred<number[]>()
  hooks.read = () => { entered.resolve(); return response.promise }; const id = start(), pending = poll(); await entered.promise
  cfg.updateObject(device.id, { name: 'metadata', pollIntervalMs: 55, timeoutMs: 500, serialPath: 'INACTIVE' })
  response.resolve([12]); await pending
  assert.equal(stored.length, 1); assert.equal(recorder.getRecording(id)!.samples.length, 1, 'metadata and interval changes remain compatible')
})
await scenario(async ({ device, engine, hooks, poll }) => {
  const firstEntered = deferred<void>(), firstResponse = deferred<number[]>(), nextEntered = deferred<void>(), nextResponse = deferred<number[]>()
  hooks.read = () => { firstEntered.resolve(); return firstResponse.promise }
  const old = poll(); await firstEntered.promise; await engine.reconnectDevice(device.id)
  hooks.read = () => { nextEntered.resolve(); return nextResponse.promise }
  const next = poll(); await nextEntered.promise
  firstResponse.resolve([99]); await old
  assert.equal(engine.nextAt.get(device.id), Infinity, 'old completion cannot unmark a newer in-flight read in the same lifecycle')
  nextResponse.resolve([7]); await next
  assert(Number.isFinite(engine.nextAt.get(device.id))); assert.equal(engine.pollJobs.size, 0)
})
await scenario(async ({ ctx, dispose, recorder, hooks, start, poll, stored }) => {
  const entered = deferred<void>(), response = deferred<number[]>()
  hooks.read = () => { entered.resolve(); return response.promise }
  const previous = start(), old = poll(); await entered.promise
  await dispose(); recorder.stopRecording(previous); apply(ctx, options); const fresh = start()
  hooks.read = async () => [77]; await poll(); response.resolve([99]); await old
  assert.deepEqual(stored.map((p: any) => p.rawValue), [77]); assert.deepEqual(recorder.getRecording(fresh)!.samples.map((p: any) => p.rawValue), [77], 'a disposed producer must not populate the replacement producer recording')
})
for (const action of ['reconnect', 'stop', 'source', 'failure']) await scenario(async ({ cfg, device, engine, hooks, drivers }) => {
  const entered = deferred<void>(), connected = deferred<void>(); let first = true
  hooks.connect = async () => { if (first) { first = false; entered.resolve(); await connected.promise } }
  const old = engine.getDriver(cfg.getObject(device.id)); const rejection = assert.rejects(old, /已变化/); await entered.promise
  if (action === 'reconnect' || action === 'failure') await engine.reconnectDevice(device.id)
  if (action === 'stop') await engine.stopAll()
  if (action === 'source') cfg.updateObject(device.id, { ip: 'new.mock.invalid' })
  const current = await engine.getDriver(cfg.getObject(device.id))
  if (action === 'failure') connected.reject(new Error('obsolete connect failure')); else connected.resolve()
  await rejection
  assert.equal(engine.drivers.get('tcp:' + device.id), current); assert.equal(drivers[0].disconnects, 1)
})
await scenario(async ({ cfg, device, engine, hooks, start, poll, drivers, recorder }) => {
  const queue = deferred<void>(); engine.rtuLocks.set('MOCK-ONLY', queue.promise)
  start(); const pending = poll(); cfg.updateObject(device.id, { baudRate: 19200 }); const fresh = start()
  queue.resolve(); await pending; assert.equal(drivers.length, 0, 'obsolete queued RTU work must not open a driver')
  hooks.read = async () => [88]; await poll()
  assert.equal(drivers[0].target.baudRate, 19200); assert.equal(recorder.getRecording(fresh)!.samples[0].rawValue, 88)
}, { transport: 'rtu', serialPath: 'MOCK-ONLY' })
await scenario(async ({ cfg, device, group, hooks, poll, stored, drivers }) => {
  group.quantity = 126
  hooks.read = async (_d: any, _start: number, count: number) => { cfg.updateObject(device.id, { port: 1502 }); return Array(count).fill(9) }
  await poll(); assert.equal(drivers[0].reads, 1, 'do not send later chunks after source invalidation'); assert.equal(stored.length, 0)
})
for (const configured of [true, false]) await scenario(async ({ cfg, device, group, engine, hooks, stored }) => {
  const entered = deferred<void>(), response = deferred<number[]>()
  hooks.read = () => { entered.resolve(); return response.promise }
  const id = configured ? device.id : device.id + 1
  const pending = engine.pollOnce({ id, host: device.ip, port: device.port, groups: [group] })
  const rejection = assert.rejects(pending, /已变化/); await entered.promise
  if (configured) cfg.updateObject(id, { ip: 'changed.mock.invalid' }); else assert.equal(cfg.createObject('new collision', device.ip, device.port).id, id)
  response.resolve([99]); await rejection; assert.equal(stored.length, 0)
})
for (const action of ['source', 'stop', 'reconnect']) await scenario(async ({ cfg, device, engine, recorder, hooks, start, poll, stored, emit }) => {
  const old = start(); let fresh = ''
  let stopping = Promise.resolve()
  hooks.beforeResult = () => {
    hooks.beforeResult = undefined
    if (action === 'source') cfg.updateObject(device.id, { ip: 'listener-edit.mock.invalid' })
    if (action === 'stop') stopping = engine.stopAll()
    if (action === 'reconnect') stopping = engine.reconnectDevice(device.id)
    recorder.stopRecording(old); fresh = start()
  }
  await poll(); await stopping
  assert.equal(recorder.getRecording(fresh)!.samples.length, 0, 'reentrant ' + action); assert.equal(stored.length, 0)
  const forged = { ...cfg.captureRecordingSource(device.id) }
  emit('poller/result', { objectId: device.id, points: [{ area: 'holding-register', address: 0, slaveId: 1, timestamp: new Date().toISOString(), quality: 'good', rawValue: 99 }], readOrigin: forged })
  assert.equal(recorder.getRecording(fresh)!.samples.length, 0, 'copied/serialized internal origin handles cannot authenticate a frame')
})
await scenario(async ({ cfg, device, group, engine, drivers }) => {
  const guard = cfg.captureRecordingSource(device.id)
  ;(cfg as any).db.prepare('UPDATE monitor_objects SET ip=? WHERE id=?').run('outside-store.mock.invalid', device.id)
  assert.equal(cfg.recordingSourceMatches(guard, device), false, 'a stale supplied snapshot cannot bypass the live configuration check')
  await assert.rejects(engine.pollOnce({ id: device.id, host: 'wrong.mock.invalid', port: device.port, groups: [group] }), /已变化/)
  assert.equal(drivers.length, 0, 'one-off configured targets must match before driver creation')
})
await scenario(async ({ cfg, hooks, start, poll, stored }) => {
  const entered = deferred<void>(), response = deferred<number[]>()
  hooks.read = () => { entered.resolve(); return response.promise }; start(); const pending = poll(); await entered.promise
  const match = cfg.recordingSourceMatches.bind(cfg); cfg.recordingSourceMatches = () => { throw new Error('synthetic unavailable configuration') }
  response.resolve([99]); await pending; cfg.recordingSourceMatches = match; assert.equal(stored.length, 0)
})
let current = true
const origin = captureAcquisitionOrigin(1, () => current)
assert.equal(acquisitionOriginMatches(origin, 1), true); assert.equal(acquisitionOriginMatches(origin, 2), false)
assert.equal(acquisitionOriginMatches({ ...origin }, 1), false); assert.equal(acquisitionOriginMatches(JSON.parse(JSON.stringify(origin)), 1), false)
current = false; assert.equal(acquisitionOriginMatches(origin, 1), false)
assert.equal(acquisitionOriginMatches(captureAcquisitionOrigin(1, () => { throw new Error('private') }), 1), false)
await scenario(async ({ cfg, device, engine, poll, drivers }) => {
  const capture = cfg.captureRecordingSource.bind(cfg)
  cfg.captureRecordingSource = () => { throw new Error('unavailable configuration') }
  const before = Date.now(); await poll(); cfg.captureRecordingSource = capture
  assert.equal(drivers.length, 0); assert(engine.nextAt.get(device.id) > before, 'failed origin capture must defer instead of scheduling a zero-delay busy loop')
})
// No listeners/sockets: injected server implements only in-memory lifecycle and memory reads.
await scenario(async ({ cfg, device, group, recorder, start, stored, emit }) => {
  cfg.updateObject(device.id, { mode: 'slave', ip: '0.0.0.0' }); cfg.createRegister(group.id, device.id, 'mock memory', 3, 0)
  const entered = deferred<void>(), opening = deferred<void>(); let first = true, running = false, starts = 0
  const server: any = { status: () => ({ tcp: { running }, rtu: { running } }),
    async start() { starts++; if (first) { first = false; entered.resolve(); await opening.promise }; running = true },
    async stop() { running = false }, read: () => [42] }
  const manager = new DeviceSlaves(cfg, { write: (points: any[]) => stored.push(...points) }, emit, undefined, () => server)
  try {
    start(); const sync = manager.sync(); await entered.promise
    cfg.updateObject(device.id, { port: 1502 }); const fresh = start(); opening.resolve(); await sync
    assert.equal(stored.length, 0); assert.equal(recorder.getRecording(fresh)!.samples.length, 0)
    await manager.sync(); assert.equal(starts, 2); assert.equal(stored.length, 1); assert.equal(recorder.getRecording(fresh)!.samples[0].rawValue, 42)
  } finally { await manager.stop() }
})
// Known write gap: even a route precheck cannot bind the eventual driver after an async wait.
for (const transport of ['tcp', 'rtu']) await scenario(async ({ cfg, device, group, engine, writes }) => {
  const entered = deferred<void>(), release = deferred<void>()
  engine.waitInflight = async () => { entered.resolve(); await release.promise }
  cfg.updateGroup(group.id, { slaveId: 7 })
  const point = cfg.createRegister(group.id, device.id, 'mock write', 3, 0, 'uint16'), app = Fastify()
  registerRegisterWrite(app, cfg, engine)
  try {
    const response = await app.inject({ method: 'POST', url: '/api/registers/' + point.id + '/write', payload: { value: 42, method: 'single' } })
    assert.equal(response.statusCode, 503); assert.equal(response.json().code, 'DEVICE_WRITE_BLOCKED'); assert.equal(writes.length, 0)
    // Internal service callers remain outside the REST/MCP fence; preserve this explicit counterexample.
    const checked = cfg.getObject(device.id)!, pending = engine.write(device.id, 0, [42], 'single', 7, 'holding-register')
    await entered.promise
    cfg.updateObject(device.id, transport === 'tcp' ? { ip: 'after-write-wait.mock.invalid' } : { serialPath: 'MOCK-NEW-ONLY' })
    assert.notDeepEqual(cfg.getObject(device.id), checked)
    release.resolve(); await pending
    assert.equal(writes.length, 1); assert.equal(writes[0].args[2], 7)
    assert.equal(transport === 'tcp' ? writes[0].target.ip : writes[0].target.serialPath, transport === 'tcp' ? 'after-write-wait.mock.invalid' : 'MOCK-NEW-ONLY')
    console.log('POLLER WRITE SOURCE GAP: ' + transport + ' REST refused; a direct internal service call still selects a changed spy driver after waiting. Internal bypass unprotected, not a safety pass.')
  } finally { release.resolve(); await app.close() }
}, transport === 'rtu' ? { transport: 'rtu', serialPath: 'MOCK-OLD-ONLY' } : {})
console.log('POLLER ORIGIN OK: old/new recording repro, TCP cache binding, RTU queue, source ABA/reopen/delete/role/disable, stop/reconnect/pending-connect ownership, stale errors/finalizers, chunk cancellation, one-off collision, reentrant dispatch and slave reconciliation; memory/mock only, no sockets')
