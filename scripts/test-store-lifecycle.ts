import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from 'cordis'
import { DuckDBInstance } from '@duckdb/node-api'
import { DuckDBStore, type PollPoint } from '../packages/store/src/index.ts'
import * as configPlugin from '../packages/config/src/index.ts'
import * as storePlugin from '../packages/store/src/index.ts'
import { registerResourceCleanup, throwCleanupErrors } from '../packages/core/src/resource-close.ts'
import { Recorder } from '../packages/mcp/src/recorder.ts'
import { OtaEngine } from '../packages/ota/src/engine.ts'
import * as pollerPlugin from '../packages/poller/src/index.ts'
import { DeviceSlaves } from '../packages/slave/src/devices.ts'

const settings = { dbPath: ':memory:', flushIntervalMs: 0, flushBatchSize: 1000, retentionSeconds: 0, retentionCheckMs: 0 }
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const point: PollPoint = { objectId: 1, area: 'holding-register', address: 0, rawValue: 123, quality: 'good', timestamp: '2026-11-08T00:00:00.123Z', slaveId: 7, batchId: 'owned-close' }
const directory = mkdtempSync(join(tmpdir(), 'probestation-store-exit-')), stores: DuckDBStore[] = [], unhandled: unknown[] = [], onUnhandled = (error: unknown) => { unhandled.push(error) }
const create = (overrides = {}) => { const store = new DuckDBStore({ ...settings, ...overrides }, undefined, () => {}); stores.push(store); return store }
const contains = (error: unknown, target: unknown): boolean => error === target || error instanceof AggregateError && error.errors.some(child => contains(child, target))
process.on('unhandledRejection', onUnhandled)
try {
  const store = create({ dbPath: join(directory, 'flushed.duckdb'), flushIntervalMs: 60000, retentionCheckMs: 60000 })
  await (store as any).ready; await (store as any).mutations
  assert.equal(typeof store.close, 'function', 'real store must expose an owned shutdown instead of leaking timers and connections')
  store.write([point]); const handle = store.captureExportReadHandle(), timers = [(store as any).flushTimer, (store as any).retentionTimer]
  const conn = await (store as any).ready, run = conn.runAndReadAll.bind(conn), entered = deferred<void>(), release = deferred<void>()
  let held = true, mainClosed = 0; const closeMain = conn.closeSync.bind(conn)
  conn.runAndReadAll = async (...args: any[]) => { if (held && String(args[0]).startsWith('SELECT ts, area')) { held = false; entered.resolve(); await release.promise }; return run(...args) }
  conn.closeSync = () => { mainClosed++; return closeMain() }
  const read = store.queryObject(1, '2000-01-01', '2100-01-01'); await entered.promise
  const closing = store.close(); assert.equal(store.close(), closing); assert.deepEqual(store.getSamplePersistenceStatus(), { version: 1, available: false, objectId: null })
  assert(timers.every(timer => timer._destroyed)); assert.throws(() => store.write([point]), /closing or closed/); assert.throws(() => store.validateExportReadHandle(handle))
  await tick(); assert.equal(mainClosed, 0, 'close must wait for an accepted native query')
  release.resolve(); await read; await closing; assert.equal(mainClosed, 1); assert.equal(store.getPersistenceStatus().pendingRows, 0)
  await assert.rejects(store.queryObject(1, '2000-01-01', '2100-01-01'), /closing or closed/)
  await assert.rejects(store.queryObjectForExport(1, '2000-01-01', '2100-01-01', []), /closing or closed/)
  await assert.rejects(store.flush(), /closing or closed/); await assert.rejects(store.cleanup(), /closing or closed/); await assert.rejects(store.reopen(':memory:'), /closing or closed/)
  const reopened = create({ dbPath: join(directory, 'flushed.duckdb') }); await (reopened as any).ready
  const rows = await reopened.queryObject(1, '2000-01-01', '2100-01-01'); assert.equal(rows.length, 1); assert.equal(rows[0].batchId, point.batchId); assert.equal(rows[0].slaveId, 7); assert.equal(rows[0].rawValue, 123)
  await reopened.close()

  const bad = create(); await (bad as any).ready; await (bad as any).mutations; bad.write([point])
  const badConn = await (bad as any).ready, instance = (bad as any).instance, connect = instance.connect.bind(instance)
  const insertError = new Error('synthetic insert error'), writerError = new Error('synthetic writer close error'), connectionError = new Error('synthetic connection close error'), instanceError = new Error('synthetic instance close error')
  let inserts = 0, connectionAttempts = 0, instanceAttempts = 0
  instance.connect = async () => { const writer = await connect(), run = writer.run.bind(writer), close = writer.closeSync.bind(writer); writer.run = async (sql: string, ...args: any[]) => { if (sql.startsWith('INSERT INTO poll_data')) { inserts++; throw insertError }; return run(sql, ...args) }; writer.closeSync = () => { close(); throw writerError }; return writer }
  const closeBad = badConn.closeSync.bind(badConn), closeInstance = instance.closeSync.bind(instance)
  badConn.closeSync = () => { connectionAttempts++; closeBad(); throw connectionError }; instance.closeSync = () => { instanceAttempts++; closeInstance(); throw instanceError }
  const failed = bad.close()
  await assert.rejects(failed, error => [insertError, writerError, connectionError, instanceError].every(original => contains(error, original)))
  assert.equal(bad.close(), failed); await assert.rejects(bad.close()); assert.equal(inserts, 1); assert.equal(connectionAttempts, 1); assert.equal(instanceAttempts, 1)
  assert.equal(bad.getPersistenceStatus().pendingRows, 1); const pending = bad.getPendingPoints(); assert.deepEqual(pending, [point]); pending[0].rawValue = 999; assert.equal(bad.getPendingPoints()[0].rawValue, 123)

  const originalCreate = DuckDBInstance.create, opening = deferred<void>(), accepted = create
  try {
    DuckDBInstance.create = (async (...args: any[]) => { await opening.promise; return (originalCreate as any)(...args) }) as any
    const slow = accepted(); DuckDBInstance.create = originalCreate; slow.write([point]); const closed = slow.close(); assert.equal((slow.getSamplePersistenceStatus() as any).available, false); opening.resolve(); await closed; assert.equal(slow.getPersistenceStatus().pendingRows, 0)
  } finally { DuckDBInstance.create = originalCreate; opening.resolve() }
  const initError = new Error('synthetic native initialization error')
  try { DuckDBInstance.create = (async () => { throw initError }) as any; const failedInit = create(); DuckDBInstance.create = originalCreate; await assert.rejects((failedInit as any).ready, error => error === initError); await assert.rejects(failedInit.close(), error => error === initError) }
  finally { DuckDBInstance.create = originalCreate }

  const streamStore = create(); await (streamStore as any).ready; streamStore.write([point]); await streamStore.flush()
  const streamInstance = (streamStore as any).instance, connectStream = streamInstance.connect.bind(streamInstance), streamEntered = deferred<void>(), streamRelease = deferred<void>(), streamEvents: string[] = []
  streamInstance.connect = async () => { const reader = await connectStream(), stream = reader.stream.bind(reader), disconnect = reader.disconnectSync.bind(reader); reader.stream = async (...args: any[]) => { streamEntered.resolve(); await streamRelease.promise; return stream(...args) }; reader.disconnectSync = () => { streamEvents.push('reader disconnected'); disconnect() }; return reader }
  const streamMain = await (streamStore as any).ready, closeStreamMain = streamMain.closeSync.bind(streamMain)
  streamMain.closeSync = () => { streamEvents.push('main closed'); closeStreamMain() }
  const curve = streamStore.queryRegisterCurve(1, '2026-11-07T00:00:00Z', '2026-11-09T00:00:00Z', [{ id: 1, functionCode: 3, startAddress: 0, dataType: 'uint16', slaveId: 7 }], 100)
  await streamEntered.promise; const streamClosing = streamStore.close(); await tick(); assert.deepEqual(streamEvents, []); streamRelease.resolve(); await curve; await streamClosing; assert.deepEqual(streamEvents, ['reader disconnected', 'main closed'])

  const moving = create({ dbPath: join(directory, 'old.duckdb') }); await (moving as any).ready; moving.write([point])
  const moveInstance = (moving as any).instance, connectMove = moveInstance.connect.bind(moveInstance), commitEntered = deferred<void>(), commitRelease = deferred<void>(); let holdCommit = true
  moveInstance.connect = async () => { const writer = await connectMove(), run = writer.run.bind(writer); writer.run = async (sql: string, ...args: any[]) => { if (holdCommit && sql === 'COMMIT') { holdCommit = false; commitEntered.resolve(); await commitRelease.promise }; return run(sql, ...args) }; return writer }
  const move = moving.reopen(join(directory, 'new.duckdb')); await commitEntered.promise; const moveClose = moving.close(); commitRelease.resolve(); await move; await moveClose
  const saved = create({ dbPath: join(directory, 'old.duckdb') }); await (saved as any).ready; assert.equal((await saved.queryObject(1, '2000-01-01', '2100-01-01')).length, 1); await saved.close()

  const schemaError = new Error('synthetic SQLite schema failure'), sqliteCloseError = new Error('synthetic SQLite cleanup failure'), originalExec = DatabaseSync.prototype.exec, originalSqliteClose = DatabaseSync.prototype.close
  let capturedSqlite: DatabaseSync | undefined
  try {
    DatabaseSync.prototype.exec = function () { capturedSqlite = this; throw schemaError }
    DatabaseSync.prototype.close = function () { originalSqliteClose.call(this); throw sqliteCloseError }
    assert.throws(() => new configPlugin.ConfigStore({ dbPath: ':memory:' }), error => contains(error, schemaError) && contains(error, sqliteCloseError))
    assert.equal(capturedSqlite!.isOpen, false)
  } finally { DatabaseSync.prototype.exec = originalExec; DatabaseSync.prototype.close = originalSqliteClose }
  const connectError = new Error('synthetic DuckDB connect failure'), nativeCloseError = new Error('synthetic initialization cleanup failure'); let nativeAttempts = 0
  try {
    DuckDBInstance.create = (async () => ({ async connect() { throw connectError }, closeSync() { nativeAttempts++; throw nativeCloseError } })) as any
    const failedCleanup = create(); DuckDBInstance.create = originalCreate
    await assert.rejects((failedCleanup as any).ready, error => contains(error, connectError) && contains(error, nativeCloseError))
    await assert.rejects(failedCleanup.close(), error => contains(error, connectError) && contains(error, nativeCloseError)); assert.equal(nativeAttempts, 1)
  } finally { DuckDBInstance.create = originalCreate }

  // Prove explicit identity edges work even when the actual Cordis root disposes all plugins concurrently.
  const ctx = new Context(), events: string[] = [], stopping = deferred<void>(), finish = deferred<void>()
  await ctx.plugin(configPlugin, { dbPath: ':memory:' }); await ctx.plugin(storePlugin, { ...settings, flushIntervalMs: 60000, retentionCheckMs: 60000 })
  const cfg = ctx.get('config', false) as any, owned = ctx.get('store', false) as DuckDBStore; stores.push(owned); await (owned as any).ready; await (owned as any).mutations
  const originalConfigClose = cfg.db.close.bind(cfg.db); cfg.db.close = () => { events.push('config closed'); originalConfigClose() }
  const native = await (owned as any).ready, nativeClose = native.closeSync.bind(native); native.closeSync = () => { events.push('store closed'); nativeClose() }
  let stops = 0
  await ctx.plugin({ name: 'delayed-close-consumer', inject: ['config', 'store'], apply(context: Context) { registerResourceCleanup(context, [cfg, owned], async () => { stops++; stopping.resolve(); await finish.promise; assert(cfg.db.isOpen); events.push('consumer closed') }) } })
  owned.write([point]); const dispose = ctx.fiber.dispose(); await stopping.promise; await tick(); assert.deepEqual(events, []); assert(cfg.db.isOpen)
  finish.resolve(); await dispose; assert.deepEqual(events, ['consumer closed', 'store closed', 'config closed']); assert.equal(stops, 1); assert.equal(cfg.db.isOpen, false); await cfg.close(); await owned.close()

  // A failed consumer must not prevent either database from being attempted, and its error survives.
  const errorCtx = new Context(); await errorCtx.plugin(configPlugin, { dbPath: ':memory:' }); await errorCtx.plugin(storePlugin, settings)
  const errorCfg = errorCtx.get('config', false) as any, errorStore = errorCtx.get('store', false) as DuckDBStore; stores.push(errorStore); await (errorStore as any).ready
  const consumerError = new Error('synthetic consumer error')
  await errorCtx.plugin({ name: 'failing-close-consumer', apply(context: Context) { registerResourceCleanup(context, [errorCfg, errorStore], async () => { throw consumerError }) } })
  await assert.rejects(errorCfg.close(), error => contains(error, consumerError)); assert.equal(errorCfg.db.isOpen, false); await assert.rejects(errorStore.close(), error => contains(error, consumerError)); await errorCtx.fiber.dispose()

  const recordCfg = new configPlugin.ConfigStore({ dbPath: ':memory:' }), device = recordCfg.createObject('synthetic recorder', 'mock.invalid', 502), group = recordCfg.createGroup(device.id, 'synthetic', 3, 0, 1)
  recordCfg.createRegister(group.id, device.id, 'synthetic word', 3, 0)
  const callbacks = new Map<string, Function>(), recorder = new Recorder({ on(name: string, callback: Function) { callbacks.set(name, callback) } }, recordCfg)
  const id = recorder.startRecording(device.id, 100, 60000, undefined, 1), timer = (recorder as any).timers.get(id), done = recorder.close(); assert.equal(recorder.close(), done); await done; assert(timer._destroyed); assert.equal(recorder.getRecording(id)!.status, 'done'); assert.throws(() => recorder.startRecording(device.id, 100, 1000, undefined, 1), /closed/); await recordCfg.close(); callbacks.get('poller/result')?.({ objectId: device.id, points: [] })
  const ota = new OtaEngine({}), busy = deferred<void>(); (ota as any).busy.set(1, busy.promise); const otaClose = ota.close(); let finished = false; void otaClose.then(() => { finished = true }); await tick(); assert.equal(finished, false); assert.throws(() => ota.startUpgrade(1, 1), /closing or closed/); busy.resolve(); await otaClose; assert.equal(ota.close(), otaClose)
  const exchange = deferred<void>(); let resumes = 0, reconnects = 0
  const upgrading = new OtaEngine({ config: { getObject: () => ({ id: 1 }) }, poller: { pauseObject() {}, async getRawSocket() { await exchange.promise; throw new Error('synthetic accepted upgrade failure') }, resumeObject() { resumes++ }, async reconnectDevice() { reconnects++ } } })
  ;(upgrading as any).readFirmware = () => ({ content: Buffer.alloc(0), rec: {} })
  upgrading.startUpgrade(1, 1); const ending = upgrading.close(); exchange.resolve(); await ending
  assert.equal(upgrading.getStatus(1).state, 'failed'); assert.equal(resumes, 0); assert.equal(reconnects, 0, 'accepted OTA shutdown must not reconnect a producer being disposed')
  let engine: any, otherDriverStopped = 0
  pollerPlugin.apply({ on() {}, provide(_name: string, value: any) { engine = value } } as any, { pollIntervalMs: 1000 } as any)
  const disconnectError = new Error('synthetic driver disconnect error')
  engine.drivers.set('bad', { async disconnect() { throw disconnectError } }); engine.drivers.set('other', { async disconnect() { otherDriverStopped++ } })
  await assert.rejects(engine.stopAll(), error => error === disconnectError); assert.equal(otherDriverStopped, 1)
  const manager = new DeviceSlaves({}, {}, () => {}), chainError = new Error('synthetic reconcile error'), deviceCloseError = new Error('synthetic device stop error'); let otherDeviceStopped = 0
  ;(manager as any).chain = Promise.reject(chainError)
  ;(manager as any).entries.set(1, { transport: 'tcp', server: { async stop() { throw deviceCloseError } } })
  ;(manager as any).entries.set(2, { transport: 'tcp', server: { async stop() { otherDeviceStopped++ } } })
  const managerClose = manager.stop(); assert.equal(manager.stop(), managerClose)
  await assert.rejects(managerClose, error => contains(error, chainError) && contains(error, deviceCloseError)); assert.equal(otherDeviceStopped, 1)
  const first = new Error('first'), second = new Error('second'); assert.throws(() => throwCleanupErrors([first, first, second], 'all'), error => error instanceof AggregateError && error.errors[0] === first && error.errors[1] === second)
  await tick(); assert.deepEqual(unhandled, [])
} finally {
  for (const store of stores) {
    if (typeof store.close === 'function') await store.close().catch(() => {})
    else { clearInterval((store as any).flushTimer); clearInterval((store as any).retentionTimer); await (store as any).mutations; const conn = await (store as any).ready.catch(() => null); conn?.closeSync(); (store as any).instance?.closeSync() }
  }
  process.off('unhandledRejection', onUnhandled)
  assert(directory.startsWith(join(tmpdir(), 'probestation-store-exit-'))); rmSync(directory, { recursive: true, force: true })
}
console.log('STORE LIFECYCLE OK: terminal shared close, final flush/reopen persistence, accepted query drain, startup failure, original multi-stage errors, retained pending copy, real concurrent Cordis root ordering and best-effort database release, recorder timer/OTA wait; isolated data, no hardware/listeners/model')
