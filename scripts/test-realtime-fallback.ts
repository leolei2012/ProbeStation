import assert from 'node:assert/strict'
import { RealtimeFallbackRead } from '../apps/web/src/realtime-fallback.ts'
import { RequestTimeoutError } from '../apps/web/src/request-timeout.ts'
import { DuckDBStore } from '../packages/store/src/index.ts'

// Only controlled promises and one explicit memory store; no fetch, WebSocket, app or hardware.
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
const deferred = <T,>() => { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail }); return { promise, resolve, reject } }
function fixture(timeoutMs = 10000) {
  const calls: Array<{ objectId: number; signal: AbortSignal; reply: ReturnType<typeof deferred<number>> }> = [], accepted: Array<[number, number]> = [], failures: Array<[number, unknown]> = []
  const reader = new RealtimeFallbackRead<number>({ timeoutMs, read: async (objectId, signal) => { const reply = deferred<number>(); calls.push({ objectId, signal, reply }); return reply.promise }, accept: (id, value) => accepted.push([id, value]), failed: (id, error) => failures.push([id, error]) })
  return { reader, calls, accepted, failures }
}
{
  const { reader, calls, accepted, failures } = fixture()
  try {
    assert.equal(calls.length, 0); await reader.refresh(); assert.equal(calls.length, 0)
    reader.select(1); reader.setConnected(true); await reader.refresh(); assert.equal(calls.length, 0, 'no fallback while live channel is connected')
    reader.setConnected(false); const first = reader.refresh(); await turn()
    await reader.refresh(); await reader.refresh(); assert.equal(calls.length, 1, 'periodic ticks must not overlap or restart the same pending request')
    reader.setConnected(false); reader.select(1); assert.equal(calls[0].signal.aborted, false, 'unchanged context does not starve a slow read')
    calls[0].reply.resolve(100); await first
    const second = reader.refresh(); await turn(); calls[1].reply.resolve(300); await second
    assert.deepEqual(accepted, [[1, 100], [1, 300]]); assert.equal(failures.length, 0)
  } finally { reader.dispose() }
}
{
  const { reader, calls, accepted, failures } = fixture(15)
  try {
    reader.select(1); await reader.refresh()
    assert.equal(calls.length, 1); assert(calls[0].signal.aborted); assert(failures[0][1] instanceof RequestTimeoutError)
    const next = reader.refresh(); await turn(); calls[1].reply.resolve(300); await next
    calls[0].reply.resolve(100); await turn()
    assert.deepEqual(accepted, [[1, 300]], 'late timed-out response cannot overwrite the recovered snapshot')
    assert.equal(failures.length, 1)
  } finally { reader.dispose() }
}
{
  const { reader, calls, accepted, failures } = fixture()
  try {
    reader.select(1); const old = reader.refresh(); await turn()
    reader.setConnected(true); assert(calls[0].signal.aborted)
    reader.setConnected(false); const next = reader.refresh(); await turn(); await old
    await reader.refresh(); assert.equal(calls.length, 2, 'old finally cannot clear a new generation in-flight request')
    calls[1].reply.resolve(300); await next; calls[0].reply.resolve(100); await turn()
    assert.deepEqual(accepted, [[1, 300]], 'connected/disconnected ABA must invalidate the earlier fallback')
    assert.equal(failures.length, 0, 'abandoned channel request is not a new-generation failure')
  } finally { reader.dispose() }
}
{
  const { reader, calls, accepted, failures } = fixture()
  try {
    reader.select(1); const first = reader.refresh(); await turn()
    reader.select(2); const second = reader.refresh(); await turn()
    reader.select(1); const third = reader.refresh(); await turn()
    assert(calls[0].signal.aborted); assert(calls[1].signal.aborted)
    calls[2].reply.resolve(300); await third; calls[0].reply.resolve(100); calls[1].reply.reject(new Error('abandoned device error')); await Promise.all([first, second]); await turn()
    assert.deepEqual(calls.map(row => row.objectId), [1, 2, 1]); assert.deepEqual(accepted, [[1, 300]]); assert.equal(failures.length, 0)
    const fourth = reader.refresh(); await turn(); reader.select(null); await fourth; assert(calls[3].signal.aborted)
    calls[3].reply.resolve(0); await turn(); await reader.refresh(); assert.equal(calls.length, 4); assert.equal(accepted.length, 1)
  } finally { reader.dispose() }
}
{
  const { reader, calls, accepted, failures } = fixture()
  reader.select(2); const pending = reader.refresh(); await turn(); reader.dispose(); await pending
  calls[0].reply.reject(new Error('late unmount failure')); await turn()
  reader.select(1); reader.setConnected(true); reader.setConnected(false); await reader.refresh()
  assert(calls[0].signal.aborted); assert.equal(calls.length, 1); assert.equal(accepted.length, 0); assert.equal(failures.length, 0)
}
{
  const { reader, calls, accepted, failures } = fixture()
  try {
    reader.select(1); const pending = reader.refresh(); await turn(); calls[0].reply.reject(new Error('current read failed')); await pending
    assert.equal(failures.length, 1); assert.equal(failures[0][0], 1); assert.equal(accepted.length, 0)
    const retry = reader.refresh(); await turn(); calls[1].reply.resolve(0); await retry; assert.deepEqual(accepted, [[1, 0]], 'zero is a valid result after recovery')
  } finally { reader.dispose() }
}
const store = new DuckDBStore({ dbPath: ':memory:', flushIntervalMs: 0, flushBatchSize: 1000, retentionSeconds: 0, retentionCheckMs: 0 })
const snapshots: unknown[] = [], statuses: unknown[] = []
const reader = new RealtimeFallbackRead({ read: async id => store.getLatestByObjectAll(id), accept: (_id, snapshot) => snapshots.push(snapshot), failed: (_id, error) => statuses.push(error) })
try {
  await (store as any).ready; await (store as any).mutations
  reader.select(1); await reader.refresh(); assert.deepEqual(snapshots, [{}], 'empty backend cache is a valid complete snapshot')
  const timestamp = new Date().toISOString()
  store.write([{ objectId: 1, area: 'holding-register', address: 0, timestamp, rawValue: 0, quality: 'good', batchId: 'synthetic-a', slaveId: 1 }, { objectId: 1, area: 'holding-register', address: 0, timestamp, rawValue: 42, quality: 'bad', batchId: 'synthetic-b', slaveId: 2 }])
  const expected = store.getLatestByObjectAll(1); await reader.refresh(); assert.deepEqual(snapshots.at(-1), expected)
  const actual = snapshots.at(-1) as any; assert.equal(actual['slave:1:holding-register:0'].batchId, 'synthetic-a'); assert.equal(actual['slave:1:holding-register:0'].rawValue, 0); assert.equal(actual['slave:2:holding-register:0'].quality, 'bad'); assert.equal(actual['holding-register:0'], undefined)
  assert.equal(statuses.length, 0); assert.equal(store.getPersistenceStatus().pendingRows, 2, 'reading does not flush or alter buffered data')
} finally { reader.dispose(); await (store as any).mutations; const conn = await (store as any).ready.catch(() => null); conn?.closeSync(); (store as any).instance?.closeSync() }
assert.throws(() => new RealtimeFallbackRead({ read: async () => 0, accept() {}, failed() {}, timeoutMs: 0 }), /timeout/)
const invalid = fixture(); try { for (const id of [0, -1, 1.5, NaN, Infinity]) assert.throws(() => invalid.reader.select(id), /device/) } finally { invalid.reader.dispose() }
console.log('REALTIME FALLBACK OK: single-flight reads, timeout/recovery/late results, channel and selection ABA, old finalizers, failure isolation, unmount/no-device/connected gating, real memory-cache empty/zero/quality/batch/slave preservation; no fetch, sockets, hardware, real data, model or DOM automation')
