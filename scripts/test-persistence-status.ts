import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { DuckDBInstance } from '@duckdb/node-api'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DuckDBStore } from '../packages/store/src/index.ts'
import { registerPersistenceStatus } from '../packages/api/src/persistence-status.ts'
import { parseSamplePersistence, InvalidPersistenceStatusError } from '../packages/core/src/sample-persistence.ts'
import { PersistenceStatusRead } from '../apps/web/src/persistence-status-read.ts'
import { PersistenceStatusView, PersistenceStatus } from '../apps/web/src/PersistenceStatus.tsx'

const config = { dbPath: ':memory:', flushIntervalMs: 0, flushBatchSize: 1000, retentionSeconds: 0, retentionCheckMs: 0 }
const point = (objectId: number) => ({ objectId, area: 'holding-register' as const, address: 0, timestamp: new Date().toISOString(), rawValue: 1, quality: 'good', batchId: 'mock', slaveId: 1 })
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const close = async (store: DuckDBStore) => { await (store as any).mutations; const conn = await (store as any).ready.catch(() => null); conn?.closeSync(); (store as any).instance?.closeSync() }
const store = new DuckDBStore(config, undefined, () => {}), app = Fastify()
registerPersistenceStatus(app, () => store)
let failedSnapshot: any, recoveredSnapshot: any
try {
  assert.equal((store.getSamplePersistenceStatus() as any).phase, 'initializing')
  await (store as any).ready; await (store as any).mutations
  assert.equal((store.getSamplePersistenceStatus() as any).phase, 'ready'); assert.equal((store.getSamplePersistenceStatus() as any).lastCommitAt, null)
  store.write([point(1), point(2), point(2)])
  // Failed against 3c9196a: device 1 incorrectly reported the global count 3.
  assert.equal((await store.statsByObject(1)).bufferPending, 1, 'a device statistic must not count another device pending rows')
  assert.equal((await store.statsByObject(2)).bufferPending, 2); assert.equal((await store.stats()).bufferPending, 3)
  const instance = (store as any).instance, connect = instance.connect.bind(instance)
  instance.connect = async () => { const writer = await connect(), run = writer.run.bind(writer); writer.run = async (sql: string, ...args: any[]) => { if (sql.startsWith('INSERT INTO poll_data')) throw new Error('PRIVATE synthetic SQL/file detail'); return run(sql, ...args) }; return writer }
  await assert.rejects(store.flush(), /PRIVATE synthetic/)
  failedSnapshot = parseSamplePersistence(store.getSamplePersistenceStatus(1), 1) as any
  assert.equal(failedSnapshot.phase, 'failed'); assert.equal(failedSnapshot.failure, 'flush-failed'); assert.equal(failedSnapshot.pendingRows, 1); assert.equal(failedSnapshot.globalPendingRows, 3); assert.equal(failedSnapshot.lastCommitAt, null); assert(failedSnapshot.lastFailureAt)
  assert.match(store.getPersistenceStatus().error!, /PRIVATE/); assert(!JSON.stringify(failedSnapshot).includes('PRIVATE'))
  const flush = store.flush.bind(store), cleanup = store.cleanup.bind(store), write = store.write.bind(store)
  store.flush = async () => { throw new Error('status must not flush') }; store.cleanup = async () => { throw new Error('status must not clean') }; store.write = () => { throw new Error('status must not write') }
  try {
    const response = await app.inject('/api/storage/persistence-status?object_id=1')
    assert.equal(response.statusCode, 200); assert.equal(response.headers['cache-control'], 'no-store'); assert(!response.body.includes('PRIVATE')); assert.equal(response.json().pendingRows, 1)
    const empty = (await app.inject('/api/storage/persistence-status?object_id=3')).json(); assert.equal(empty.pendingRows, 0); assert.equal(empty.globalPendingRows, 3); assert.equal(empty.phase, 'failed', 'selected zero does not hide the shared service failure')
    assert.equal((store.getSamplePersistenceStatus() as any).lastFailureAt, failedSnapshot.lastFailureAt, 'status reads do not change failure records')
  } finally { store.flush = flush; store.cleanup = cleanup; store.write = write }
  const entered = deferred<void>(), commit = deferred<void>(); let waiting = true
  instance.connect = async () => { const writer = await connect(), run = writer.run.bind(writer); writer.run = async (sql: string, ...args: any[]) => { if (sql === 'COMMIT' && waiting) { waiting = false; entered.resolve(); await commit.promise }; return run(sql, ...args) }; return writer }
  const pending = store.flush(); await entered.promise
  const submitting = store.getSamplePersistenceStatus(1) as any; assert.equal(submitting.flushing, true); assert.equal(submitting.phase, 'failed'); assert.equal(submitting.lastCommitAt, null, 'a started COMMIT is not a successful commit')
  store.write([point(1)]); assert.equal((store.getSamplePersistenceStatus(1) as any).pendingRows, 2); assert.equal((store.getSamplePersistenceStatus() as any).pendingRows, 4)
  commit.resolve(); await pending
  recoveredSnapshot = store.getSamplePersistenceStatus(1) as any
  assert.equal(recoveredSnapshot.phase, 'ready'); assert.equal(recoveredSnapshot.failure, null); assert.equal(recoveredSnapshot.flushing, false); assert.equal(recoveredSnapshot.pendingRows, 1); assert.equal(recoveredSnapshot.globalPendingRows, 1); assert(recoveredSnapshot.lastCommitAt); assert.equal(recoveredSnapshot.lastFailureAt, failedSnapshot.lastFailureAt)
  instance.connect = connect; await store.flush(); assert.deepEqual(store.getPersistenceStatus(), { pendingRows: 0, error: null }, 'old diagnostic contract stays unchanged')
  assert.equal((await store.queryObject(1, '2000-01-01T00:00:00Z', '2100-01-01T00:00:00Z')).length, 2)
  const opening = deferred<void>(), release = deferred<void>(), rawFlush = store.flush.bind(store)
  store.flush = async () => { opening.resolve(); await release.promise; await rawFlush() }
  const reopen = store.reopen(':memory:'); await opening.promise; assert.equal((store.getSamplePersistenceStatus() as any).phase, 'switching')
  release.resolve(); await reopen; store.flush = rawFlush
  const fresh = store.getSamplePersistenceStatus() as any; assert.equal(fresh.phase, 'ready'); assert.equal(fresh.pendingRows, 0); assert.equal(fresh.lastCommitAt, null); assert.equal(fresh.lastFailureAt, null, 'timestamps do not leak from the previous opened database')
  for (const raw of ['0', '-1', '1.5', '01', 'x', '9007199254740992', '1&object_id=2']) assert.equal((await app.inject('/api/storage/persistence-status?object_id=' + raw)).statusCode, 400)
} finally { await app.close(); await close(store) }
const blocked = new DuckDBStore(config, undefined, () => {})
try {
  await (blocked as any).ready; await (blocked as any).mutations
  const instance = (blocked as any).instance, connect = instance.connect.bind(instance)
  instance.connect = async () => { const writer = await connect(), run = writer.run.bind(writer); writer.run = async (sql: string, ...args: any[]) => { if (sql.startsWith('INSERT INTO poll_data') || sql === 'ROLLBACK') throw new Error('PRIVATE rollback failure'); return run(sql, ...args) }; return writer }
  blocked.write([point(1)]); await assert.rejects(blocked.flush(), /uncertain/)
  const status = blocked.getSamplePersistenceStatus() as any; assert.equal(status.phase, 'blocked'); assert.equal(status.failure, 'write-uncertain'); assert.equal(status.pendingRows, 1); assert.equal(status.flushing, false)
  assert.throws(() => blocked.write([point(1)]), /uncertain/); assert(!JSON.stringify(status).includes('PRIVATE'))
} finally { await close(blocked) }
const create = DuckDBInstance.create
let failedInit: DuckDBStore | undefined
try {
  DuckDBInstance.create = (async () => { throw new Error('PRIVATE initialization detail') }) as any
  failedInit = new DuckDBStore(config, undefined, () => {})
  await assert.rejects((failedInit as any).ready, /PRIVATE/)
  const status = parseSamplePersistence(failedInit.getSamplePersistenceStatus(), null) as any; assert.equal(status.phase, 'blocked'); assert.equal(status.failure, 'initialization-failed'); assert.equal(status.pendingRows, 0); assert.equal(status.lastCommitAt, null); assert.throws(() => failedInit!.write([point(1)]), /PRIVATE/)
} finally { DuckDBInstance.create = create; if (failedInit) await close(failedInit) }
const unavailable = Fastify(); registerPersistenceStatus(unavailable, () => undefined)
try { assert.deepEqual((await unavailable.inject('/api/storage/persistence-status')).json(), { version: 1, available: false, objectId: null }) } finally { await unavailable.close() }
const badService = Fastify(); registerPersistenceStatus(badService, () => { throw new Error('PRIVATE service error') })
try { const r = await badService.inject('/api/storage/persistence-status'); assert.equal(r.statusCode, 503); assert(!r.body.includes('PRIVATE')) } finally { await badService.close() }

const valid = { ...recoveredSnapshot, objectId: null, pendingRows: recoveredSnapshot.globalPendingRows }
for (const value of [null, {}, { ...valid, version: 2 }, { ...valid, phase: 'healthy' }, { ...valid, checkedAt: 'bad' }, { ...valid, pendingRows: -1 }, { ...valid, pendingRows: '1' }, { ...valid, pendingRows: 999 }, { ...valid, lastCommitAt: 2 }, { ...valid, phase: 'ready', failure: 'flush-failed' }, { ...valid, phase: 'blocked', failure: null }, { ...valid, phase: 'failed', failure: null }, { ...valid, stateScope: 'device' }]) assert.throws(() => parseSamplePersistence(value, null), InvalidPersistenceStatusError)
assert.throws(() => parseSamplePersistence(valid, 1), InvalidPersistenceStatusError)
assert(!JSON.stringify(parseSamplePersistence({ ...valid, error: 'PRIVATE', dbPath: 'PRIVATE' }, null)).includes('PRIVATE'))
assert(Object.isFrozen(parseSamplePersistence(valid, null)))
let reads = 0, result: any = valid
const reader = new PersistenceStatusRead(null), get = async () => { reads++; if (result instanceof Error) throw result; return result }
assert.equal(reads, 0); assert.equal(reader.snapshot().value, undefined)
await reader.refresh(get); const previous = reader.snapshot().value; result = new Error('PRIVATE HTTP detail'); await reader.refresh(get)
assert.equal(reader.snapshot().phase, 'error'); assert.equal(reader.snapshot().value, previous); assert.equal(reader.snapshot().error, 'request')
result = { ...valid, pendingRows: 999 }; await reader.refresh(get); assert.equal(reader.snapshot().error, 'invalid'); assert.equal(reader.snapshot().value, previous)
result = valid; await reader.refresh(get); assert.equal(reader.snapshot().phase, 'ready')
const old = deferred<any>(), next = deferred<any>(); let requests = 0, firstSignal: AbortSignal | undefined
const ordered = new PersistenceStatusRead(null)
const fetch = (url: string, signal: AbortSignal) => { assert.equal(url, '/api/storage/persistence-status'); if (++requests === 1) { firstSignal = signal; return old.promise }; return next.promise }
const first = ordered.refresh(fetch); await new Promise(resolve => setTimeout(resolve, 0)); await ordered.refresh(fetch); assert.equal(requests, 1, 'polls coalesce instead of starving the deadline')
const second = ordered.refresh(fetch, true); await new Promise(resolve => setTimeout(resolve, 0)); assert(firstSignal!.aborted); next.resolve(valid); await second; old.resolve({ ...valid, pendingRows: 999 }); await first; assert.equal(ordered.snapshot().phase, 'ready')
const hung = deferred<any>(), timed = new PersistenceStatusRead(1); let timeoutSignal: AbortSignal | undefined
await timed.refresh(async (url, signal) => { assert(url.endsWith('?object_id=1')); timeoutSignal = signal; return hung.promise }, false, 15)
assert.equal(timed.snapshot().error, 'timeout'); assert(timeoutSignal!.aborted)
await timed.refresh(async () => recoveredSnapshot); hung.resolve({}); await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(timed.snapshot().phase, 'ready')
const late = deferred<any>(), cancelled = timed.refresh(async () => late.promise); await new Promise(resolve => setTimeout(resolve, 0)); timed.cancel(); const beforeCancel = timed.snapshot(); late.resolve({}); await cancelled; assert.equal(timed.snapshot(), beforeCancel)
assert.equal(new PersistenceStatusRead(2).snapshot().value, undefined, 'a new device scope does not reuse another scope result')
let clicked = 0
const initial = renderToStaticMarkup(createElement(PersistenceStatusView, { state: { phase: 'loading' }, refresh: () => clicked++ }))
assert(!initial.includes('暂无待写样本')); assert(!initial.includes('>0<'))
for (const english of [false, true]) {
  const html = renderToStaticMarkup(createElement(PersistenceStatusView, { state: { phase: 'error', value: failedSnapshot, error: 'timeout' }, refresh: () => clicked++, english }))
  assert(html.includes(english ? 'Previous' : '上次')); assert(html.includes(english ? '10 seconds' : '10秒')); assert(!html.includes('PRIVATE')); assert(html.includes(english ? 'service' : '全服务'))
}
const zero = renderToStaticMarkup(createElement(PersistenceStatusView, { state: { phase: 'ready', value: { ...failedSnapshot, objectId: 3, pendingRows: 0 } }, refresh: () => clicked++ }))
assert(zero.includes('写入失败')); assert(zero.includes('全服务待写')); assert(!zero.includes('暂无待写样本'))
const ssr = renderToStaticMarkup(createElement(PersistenceStatus, { objectId: 1, get: async () => { reads++; throw new Error('SSR must not request') } })); assert(ssr.includes('正在读取'))
assert.equal(clicked, 0)
console.log('PERSISTENCE STATUS OK: real memory store scoped-count repro, initialization/in-flight commit/failure/recovery/blocked rollback/reopen metadata, read-only redacted API/unsupported/error/scope validation, immutable strict client parse, coalescing/cancel/timeout/late/scope recovery and bilingual SSR; no real DB, listeners, hardware or model')
