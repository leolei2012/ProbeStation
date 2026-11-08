import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import Fastify from 'fastify'
import { Context } from 'cordis'
import ConsoleExporter from '@cordisjs/plugin-logger-console'
import * as apiPlugin from '../packages/api/src/index.ts'
import * as configPlugin from '../packages/config/src/index.ts'
import * as storePlugin from '../packages/store/src/index.ts'
import { DuckDBInstance } from '@duckdb/node-api'
import { DuckDBStore } from '../packages/store/src/index.ts'
import { registerReadiness } from '../packages/api/src/readiness.ts'

const config = { dbPath: ':memory:', flushIntervalMs: 0, flushBatchSize: 1000, retentionSeconds: 0, retentionCheckMs: 0 }
const close = async (store: DuckDBStore) => { await (store as any).mutations; const conn = await (store as any).ready.catch(() => null); conn?.closeSync(); (store as any).instance?.closeSync() }
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))
const source = ts.createSourceFile('api.ts', readFileSync(new URL('../packages/api/src/index.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
let health: ts.CallExpression | undefined
const walk = (node: ts.Node) => { if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'get' && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === '/health') health = node; ts.forEachChild(node, walk) }; walk(source); assert(health)
const addHealth = (app: ReturnType<typeof Fastify>) => new Function('fastify', ts.transpileModule(health!.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText)(app)
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { resolve, promise } }
const opened = deferred<void>(), create = DuckDBInstance.create
let store: DuckDBStore | undefined
const app = Fastify(); addHealth(app); registerReadiness(app, () => store)
try {
  assert.equal((await app.inject('/ready')).statusCode, 503)
  DuckDBInstance.create = (async (...args: any[]) => { await opened.promise; return (create as any)(...args) }) as any
  store = new DuckDBStore(config, undefined, () => {}); DuckDBInstance.create = create
  const initializing = await app.inject('/ready'); assert.equal(initializing.statusCode, 503); assert.equal(initializing.json().storage.phase, 'initializing'); assert.equal(initializing.headers['cache-control'], 'no-store')
  assert.deepEqual((await app.inject('/health')).json(), { status: 'ok', version: '0.1.0' }); assert.equal((await app.inject('/health')).statusCode, 200)
  opened.resolve(); await (store as any).ready; await (store as any).mutations
  const ready = await app.inject('/ready'); assert.equal(ready.statusCode, 200); assert.deepEqual(ready.json(), { version: 1, status: 'ready', scope: 'sample-storage', storage: { phase: 'ready', failure: null } })
  assert.equal(ready.headers['cache-control'], 'no-store')
  // A normal pending queue is not a failure and a GET never flushes it.
  const point = { objectId: 1, area: 'holding-register' as const, address: 0, timestamp: new Date().toISOString(), rawValue: 1, quality: 'good', batchId: 'synthetic', slaveId: 1 }
  store.write([point]); const before = store.getSamplePersistenceStatus(), methods = ['flush', 'cleanup', 'reopen', 'queryObject'] as const, saved = methods.map(name => (store as any)[name])
  for (const name of methods) (store as any)[name] = () => assert.fail('readiness must not call ' + name)
  try { assert.equal((await app.inject('/ready?object_id=999')).statusCode, 200); assert.equal((store.getSamplePersistenceStatus() as any).pendingRows, (before as any).pendingRows) }
  finally { methods.forEach((name, index) => { (store as any)[name] = saved[index] }) }
  const instance = (store as any).instance, connect = instance.connect.bind(instance); let fail = true
  instance.connect = async () => { const writer = await connect(), run = writer.run.bind(writer); writer.run = async (sql: string, ...args: any[]) => { if (fail && sql.startsWith('INSERT INTO poll_data')) throw new Error('PRIVATE synthetic write detail'); return run(sql, ...args) }; return writer }
  await assert.rejects(store.flush(), /PRIVATE/)
  const failed = await app.inject('/ready'); assert.equal(failed.statusCode, 503); assert.equal(failed.json().storage.failure, 'flush-failed'); assert(!failed.body.includes('PRIVATE')); assert.equal((store.getSamplePersistenceStatus() as any).pendingRows, 1)
  assert.equal((await app.inject('/ready?object_id=999')).statusCode, 503, 'query parameters cannot hide a whole-service storage failure')
  fail = false; await store.flush(); assert.equal((await app.inject('/ready')).statusCode, 200, 'a successful real retry clears the recorded flush failure')
  const entered = deferred<void>(), release = deferred<void>(), rawFlush = store.flush.bind(store)
  store.flush = async () => { entered.resolve(); await release.promise; await rawFlush() }
  const reopening = store.reopen(':memory:'); await entered.promise
  assert.equal((await app.inject('/ready')).statusCode, 503); release.resolve(); await reopening; store.flush = rawFlush
  assert.equal((await app.inject('/ready')).statusCode, 200)
  instance.connect = connect
} finally { DuckDBInstance.create = create; opened.resolve(); await app.close(); if (store) await close(store) }

let failedInit: DuckDBStore | undefined
try {
  DuckDBInstance.create = (async () => { throw new Error('PRIVATE init path') }) as any
  failedInit = new DuckDBStore(config, undefined, () => {}); await assert.rejects((failedInit as any).ready, /PRIVATE/)
  const blocked = Fastify(); addHealth(blocked); registerReadiness(blocked, () => failedInit)
  try { const result = await blocked.inject('/ready'); assert.equal(result.statusCode, 503); assert.deepEqual(result.json().storage, { phase: 'blocked', failure: 'initialization-failed' }); assert(!result.body.includes('PRIVATE')); assert.equal((await blocked.inject('/health')).statusCode, 200) }
  finally { await blocked.close() }
} finally { DuckDBInstance.create = create; if (failedInit) await close(failedInit) }

const valid = { version: 1, available: true, objectId: null, stateScope: 'service', checkedAt: new Date().toISOString(), phase: 'ready', failure: null, flushing: false, pendingRows: 0, globalPendingRows: 0, lastCommitAt: null, lastFailureAt: null }
let response: any = valid, getCalls = 0
const metadata = Fastify(); registerReadiness(metadata, () => ({ getSamplePersistenceStatus() { getCalls++; if (response instanceof Error) throw response; return response } }) as any)
try {
  for (const value of [null, {}, new Error('PRIVATE getter'), { ...valid, objectId: 1 }, { ...valid, phase: 'ready', failure: 'flush-failed' }, { ...valid, pendingRows: '0' }, new Promise(() => {})]) { response = value; const result = await metadata.inject('/ready'); assert.equal(result.statusCode, 503); assert.equal(result.json().storage.phase, 'unknown'); assert(!result.body.includes('PRIVATE')) }
  response = { version: 1, available: false, objectId: null }; assert.equal((await metadata.inject('/ready')).statusCode, 503)
  response = { ...valid, phase: 'blocked', failure: 'write-uncertain' }; assert.equal((await metadata.inject('/ready')).statusCode, 503)
  response = { ...valid, flushing: true, pendingRows: 4, globalPendingRows: 4 }; assert.equal((await metadata.inject('/ready')).statusCode, 200, 'healthy in-flight work is not unavailability')
  response = valid; assert.equal((await metadata.inject('/ready')).statusCode, 200); assert(getCalls > 0)
} finally { await metadata.close() }
const asynchronous = Fastify(), unhandled: unknown[] = [], onUnhandled = (error: unknown) => { unhandled.push(error) }
registerReadiness(asynchronous, () => ({ async getSamplePersistenceStatus() { throw new Error('PRIVATE incompatible async provider') } }) as any)
process.on('unhandledRejection', onUnhandled)
try { const result = await asynchronous.inject('/ready'); assert.equal(result.statusCode, 503); await tick(); assert.deepEqual(unhandled, [], 'an incompatible rejected metadata Promise must not become an unhandled rejection') }
finally { await asynchronous.close(); process.off('unhandledRejection', onUnhandled) }

// A request admitted before close must not report ready after shutdown has begun.
const draining = Fastify(), admitted = deferred<void>(), proceed = deferred<void>(), closing = deferred<void>(), finishClose = deferred<void>()
draining.addHook('preHandler', async request => { if (request.url === '/ready') { admitted.resolve(); await proceed.promise } })
registerReadiness(draining, () => ({ getSamplePersistenceStatus: () => valid }) as any)
draining.addHook('preClose', async () => { closing.resolve(); await finishClose.promise })
let closingApp: Promise<void> | undefined
try {
  const request = Promise.resolve(draining.inject('/ready')); await admitted.promise
  closingApp = draining.close(); await closing.promise; proceed.resolve()
  const result = await request; assert.equal(result.statusCode, 503, 'an admitted request must not turn green during close'); assert.equal(result.headers['cache-control'], 'no-store')
} finally { proceed.resolve(); finishClose.resolve(); await (closingApp ?? draining.close()) }
await assert.rejects(draining.inject('/ready'), { code: 'FST_ERR_REOPENED_CLOSE_SERVER' })

// Actual Cordis/API registration, with real memory databases and inert dependent services.
// Disposing the store removes the API provider; its retained Fastify reference must fail closed.
const dataDir = mkdtempSync(join(tmpdir(), 'probestation-readiness-')), ctx = new Context(), apps: ReturnType<typeof Fastify>[] = [], stores: DuckDBStore[] = []
const loggerFork = await ctx.plugin(ConsoleExporter)
const configFork = await ctx.plugin(configPlugin, { dbPath: ':memory:' })
const inert = await ctx.plugin({ name: 'readiness-inert-services', apply(context: Context) { for (const name of ['poller', 'sink', 'importer', 'ota']) context.provide(name as any, {} as any) } })
let storeFork = await ctx.plugin(storePlugin, config)
const apiFork = await ctx.plugin(apiPlugin, { host: '127.0.0.1', port: 0, dataDir })
try {
  await apiFork.await()
  assert.deepEqual(['config', 'store', 'poller', 'sink', 'importer', 'ota'].filter(name => !ctx.get(name as any, false)), [], 'all API dependencies must be registered')
  const old = ctx.get('api', false) as any, oldStore = ctx.get('store', false) as DuckDBStore; assert(old && oldStore); apps.push(old); stores.push(oldStore)
  await (oldStore as any).ready; await old.ready()
  assert.equal((await old.inject('/ready')).statusCode, 200)
  await storeFork.dispose(); assert.equal(ctx.get('api', false), undefined)
  const detached = await old.inject('/ready'); assert.equal(detached.statusCode, 503, 'a disposed provider cannot keep its captured store ready'); assert.equal(detached.json().storage.phase, 'unavailable')
  assert.deepEqual((await old.inject('/health')).json(), { status: 'ok', version: '0.1.0' }, 'legacy liveness is unchanged while this detached HTTP instance still exists')
  storeFork = await ctx.plugin(storePlugin, config); await apiFork
  const fresh = ctx.get('api', false) as any, freshStore = ctx.get('store', false) as DuckDBStore; assert(fresh && freshStore); apps.push(fresh); stores.push(freshStore)
  assert(fresh && fresh !== old, 'dependency recovery creates a new API instance')
  await (freshStore as any).ready; await fresh.ready(); assert.equal((await fresh.inject('/ready')).statusCode, 200)
  assert.equal((await old.inject('/ready')).statusCode, 503, 'replacement must not revive the detached API')
  await apiFork.dispose(); assert.equal((await fresh.inject('/ready')).statusCode, 503, 'direct API disposal must also invalidate readiness')
} finally {
  const cfg = ctx.get('config', false) as any
  await apiFork.dispose(); for (const instance of apps) await instance.close()
  await storeFork.dispose(); await inert.dispose(); await configFork.dispose()
  for (const instance of stores) await close(instance)
  cfg?.db.close()
  await loggerFork.dispose()
  rmSync(dataDir, { recursive: true, force: true })
}
assert.match(source.text, /registerReadiness\(fastify,/)
await tick()
console.log('READINESS OK: legacy health unchanged; metadata-only no-store readiness covers real initialization/flush/reopen recovery, malformed/async status, admitted requests during close, actual Cordis API/dependency disposal and replacement without reviving old instances; isolated memory data, no listeners/hardware/model')
