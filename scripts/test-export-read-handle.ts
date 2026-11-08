import assert from 'node:assert/strict'
import { DuckDBStore, ExportReadHandleError } from '../packages/store/src/index.ts'
import { ConfigStore } from '../packages/config/src/index.ts'

const config = { dbPath: ':memory:', flushIntervalMs: 0, flushBatchSize: 10000, retentionSeconds: 0, retentionCheckMs: 0 }
const start = '2026-11-07T00:00:00Z', end = '2026-11-07T00:00:01Z'
const deferred = <T,>() => { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail }); return { promise, resolve, reject } }
const reader = (value: number, batch: string | null = 'mock', source: number | null = 1) => ({ getRowObjects: () => [{ ts: '2026-11-07 00:00:00', area: 'holding-register', address: 0, raw_value: value, quality: 'good', slave_id: source, batch_id: batch }] })
const connection = (value: number) => ({ queries: 0, closes: 0, params: {} as Record<string, unknown>, read: async () => reader(value), closeSync() { this.closes++ }, async runAndReadAll(_sql: string, params: Record<string, unknown>) { this.queries++; this.params = params; return this.read() } })
const proto = DuckDBStore.prototype as any, originalInit = proto.init, originalCleanup = proto.cleanup
const plans: Array<() => Promise<any>> = []
// Real constructor/reopen/read methods, but every native connection effect is mock.
proto.init = function () {
  assert.equal(this.dbPath, ':memory:'); const next = plans.shift(); assert(next, 'no fallback to a real database in mock fixtures'); this.initialization = 'opening'
  return next().then(value => { this.initialization = 'ready'; return value }, error => { this.initialization = 'failed'; this.initError = error; throw error })
}
proto.cleanup = async () => {}
const fake = (plan: () => Promise<any>) => {
  plans.push(plan); const store = new DuckDBStore(config, undefined, () => {})
  // Retain own mock methods even if a failing assertion restores the prototype.
  ;(store as any).init = proto.init; (store as any).cleanup = async () => {}; (store as any).flush = async () => {}; return store
}
try {
  const initial = deferred<any>(), old = connection(10), store = fake(() => initial.promise)
  assert.throws(() => store.captureExportReadHandle(), ExportReadHandleError); initial.resolve(old); await (store as any).ready
  const handle = store.captureExportReadHandle(); assert(Object.isFrozen(handle)); assert.deepEqual(Object.keys(handle).sort(), ['storeScope', 'version']); assert.equal(handle.version, 1); assert.equal(old.queries, 0)
  const heldMutation = deferred<void>(); (store as any).mutations = heldMutation.promise
  const ranges = [{ area: 'holding-register' as const, startAddress: 0, endAddress: 0, slaveId: 1 }]
  const first = store.queryObjectForExportWithHandle(handle, 1, start, end, ranges); ranges[0].slaveId = 2; heldMutation.resolve()
  assert.equal((await first)[0].rawValue, 10); assert.equal(old.params.exportSlave0, 1, 'copy range/source arguments before any await'); assert.equal(old.params.limit, 200001)
  const beforeEmpty = old.queries; assert.deepEqual(await store.queryObjectForExportWithHandle(handle, 1, start, end, []), []); assert.equal(old.queries, beforeEmpty)

  // Invalidate immediately at reopen start, while both the read and reopen await mutations.
  const mutation = deferred<void>(); (store as any).mutations = mutation.promise
  const waiting = store.queryObjectForExportWithHandle(handle, 1, start, end), refused = assert.rejects(waiting, ExportReadHandleError), next = connection(20)
  plans.push(async () => next); const reopening = store.reopen(':memory:'); assert.throws(() => store.captureExportReadHandle(), ExportReadHandleError)
  mutation.resolve(); await Promise.all([refused, reopening]); assert.equal(old.queries, beforeEmpty); assert.equal(next.queries, 0); assert.equal(old.closes, 1)
  const second = store.captureExportReadHandle(); assert.notEqual(second.storeScope, handle.storeScope)
  const entered = deferred<void>(), late = deferred<ReturnType<typeof reader>>(); next.read = async () => { entered.resolve(); return late.promise }
  const pending = store.queryObjectForExportWithHandle(second, 1, start, end), rejected = assert.rejects(pending, ExportReadHandleError)
  await entered.promise; const thirdConnection = connection(30); plans.push(async () => thirdConnection); const waitingReopen = store.reopen(':memory:')
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(next.closes, 0, 'reopen must not close the old connection while its SQL is still pending')
  late.resolve(reader(20)); await waitingReopen; await rejected
  assert.equal(thirdConnection.queries, 0, 'a late old result must not query or return replacement rows')
  const third = store.captureExportReadHandle(), errors = deferred<ReturnType<typeof reader>>(), errorEntered = deferred<void>()
  thirdConnection.read = async () => { errorEntered.resolve(); return errors.promise }
  const bad = store.queryObjectForExportWithHandle(third, 1, start, end), ignored = assert.rejects(bad, error => error instanceof ExportReadHandleError && !error.message.includes('PRIVATE'))
  await errorEntered.promise; const fourthConnection = connection(40); plans.push(async () => fourthConnection); const errorReopen = store.reopen(':memory:')
  errors.reject(new Error('PRIVATE obsolete driver error')); await errorReopen; await ignored

  const fourth = store.captureExportReadHandle(), nativeError = new Error('mock current SQL error')
  fourthConnection.read = async () => { throw nativeError }; await assert.rejects(store.queryObjectForExportWithHandle(fourth, 1, start, end), error => error === nativeError)
  fourthConnection.read = async () => reader(40, null, null)
  const unchanged = await store.queryObjectForExportWithHandle(fourth, 1, start, end)
  assert.deepEqual(unchanged, await store.queryObjectForExport(1, start, end)); assert.equal(unchanged[0].batchId, null); assert.equal(unchanged[0].slaveId, null)
  const other = fake(async () => connection(99)); await (other as any).ready; const foreign = other.captureExportReadHandle(), count = fourthConnection.queries
  for (const invalid of [null, undefined, {}, { ...fourth }, foreign, handle]) await assert.rejects(store.queryObjectForExportWithHandle(invalid as any, 1, start, end, []), ExportReadHandleError)
  assert.equal(fourthConnection.queries, count)

  ;(store as any).flush = async () => { throw new Error('mock reopen flush failure') }
  await assert.rejects(store.reopen(':memory:'), /mock reopen flush failure/); assert.throws(() => store.captureExportReadHandle(), ExportReadHandleError)
  await assert.rejects(store.queryObjectForExportWithHandle(fourth, 1, start, end), ExportReadHandleError)
  ;(store as any).flush = async () => {}; const final = connection(50); plans.push(async () => final); await store.reopen(':memory:')
  const recovered = store.captureExportReadHandle(); assert.equal((await store.queryObjectForExportWithHandle(recovered, 1, start, end))[0].rawValue, 50)
  const opening = deferred<any>(), openingEntered = deferred<void>(); plans.push(() => { openingEntered.resolve(); return opening.promise })
  const slowOpen = store.reopen(':memory:'); await openingEntered.promise
  assert.throws(() => store.captureExportReadHandle(), ExportReadHandleError); await assert.rejects(store.queryObjectForExportWithHandle(recovered, 1, start, end), ExportReadHandleError)
  await assert.rejects(store.reopen(':memory:'), /already reopening/); opening.resolve(connection(60)); await slowOpen
  assert.equal((await store.queryObjectForExportWithHandle(store.captureExportReadHandle(), 1, start, end))[0].rawValue, 60)
  const failed = fake(async () => { throw new Error('mock init failure') }); await assert.rejects((failed as any).ready, /mock init failure/); assert.throws(() => failed.captureExportReadHandle(), ExportReadHandleError)
  assert.equal(plans.length, 0)
} finally {
  proto.init = originalInit; proto.cleanup = originalCleanup
}

// Real configuration and DuckDB, both strictly :memory:, with no service bootstrap.
const cfg = new ConfigStore({ dbPath: ':memory:' }), store = new DuckDBStore(config, cfg)
try {
  const device = cfg.createObject('synthetic', 'mock.invalid', 502), group = cfg.createGroup(device.id, 'group', 3, 0, 1, 'read', 1)
  cfg.createRegister(group.id, device.id, 'point', 3, 0, 'uint16')
  await (store as any).ready
  const configuration = cfg.getHistoryExportConfiguration(device.id)
  const write = (rawValue: number) => store.write([{ objectId: device.id, area: 'holding-register', address: 0, timestamp: start, rawValue, quality: 'good', batchId: 'response', slaveId: 1 }])
  write(10); await store.flush(); const old = store.captureExportReadHandle()
  assert.deepEqual(await store.queryObjectForExportWithHandle(old, device.id, start, end), await store.queryObjectForExport(device.id, start, end))
  await store.reopen(':memory:'); write(200); await store.flush()
  await assert.rejects(store.queryObjectForExportWithHandle(old, device.id, start, end), ExportReadHandleError)
  const fresh = store.captureExportReadHandle(); assert.notEqual(fresh.storeScope, old.storeScope); assert.equal((await store.queryObjectForExportWithHandle(fresh, device.id, start, end))[0].rawValue, 200)
  assert.equal(cfg.getHistoryExportConfiguration(device.id).configurationScope, configuration.configurationScope, 'config and store lifetimes remain independent; no paired-workspace guarantee is implied')
} finally { await (store as any).mutations; const conn = await (store as any).ready.catch(() => null); conn?.closeSync(); (store as any).instance?.closeSync(); (cfg as any).db.close() }
console.log('EXPORT READ HANDLE OK: actual lifecycle with controlled connections, ready/mutation/query barriers, immediate revoke, captured ranges, late success/error isolation, foreign/copied/empty scopes, reopen failure recovery and init denial; real memory config/DuckDB parity and old-handle rejection; no API integration, files, hardware or model')
