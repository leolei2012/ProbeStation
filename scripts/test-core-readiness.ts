import assert from 'node:assert/strict'
import { mkdtempSync, lstatSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import net from 'node:net'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { Context } from 'cordis'
import * as configPlugin from '../packages/config/src/index.ts'
import * as storePlugin from '../packages/store/src/index.ts'
import * as apiPlugin from '../packages/api/src/index.ts'
import { registerReadiness } from '../packages/api/src/readiness.ts'
import { registerResourceCleanup } from '../packages/core/src/resource-close.ts'

const tick = () => new Promise<void>(done => setImmediate(done))
const goodConfiguration = { version: 1, phase: 'ready', failure: null }
const goodStorage = { version: 1, available: true, objectId: null, stateScope: 'service', checkedAt: new Date().toISOString(), phase: 'ready', failure: null, flushing: false, pendingRows: 0, globalPendingRows: 0, lastCommitAt: null, lastFailureAt: null }
const passed: string[] = [], failures: string[] = [], denied: string[] = [], unhandled: unknown[] = []
const collect = (error: unknown) => { unhandled.push(error) }
async function check(name: string, action: () => Promise<void>) { try { await action(); passed.push(name); console.log('CORE READINESS OK: ' + name) } catch (error) { failures.push(name + ': ' + (error instanceof Error ? error.message : String(error))); console.log('CORE READINESS REPRO: ' + failures.at(-1)) } }
const listen = net.Server.prototype.listen, connect = net.Socket.prototype.connect, fetch = globalThis.fetch
const block = (name: string) => () => { denied.push(name); throw Error('Unexpected real I/O: ' + name) }
const snapshot = (cfg: configPlugin.ConfigStore) => (cfg as unknown as { getConfigurationReadinessStatus(): unknown }).getConfigurationReadinessStatus()
const native = (cfg: configPlugin.ConfigStore) => (cfg as unknown as { db: DatabaseSync }).db
const directory = () => mkdtempSync(join(tmpdir(), 'probestation-core-ready-'))
function remove(directory: string) { const target = resolve(directory); assert.equal(dirname(target).toLowerCase(), resolve(tmpdir()).toLowerCase()); assert(basename(target).startsWith('probestation-core-ready-')); assert(lstatSync(target).isDirectory() && !lstatSync(target).isSymbolicLink()); rmSync(target, { recursive: true, force: true }) }
const register = registerReadiness as unknown as (app: FastifyInstance, store: () => unknown, configuration?: () => unknown) => void
net.Server.prototype.listen = block('listen') as typeof listen; net.Socket.prototype.connect = block('connect') as typeof connect; globalThis.fetch = block('fetch') as typeof fetch; process.on('unhandledRejection', collect)
try {
  await check('configuration-status-metadata-lifecycle-and-recovery', async () => {
    let events = 0
    const dir = directory(), file = join(dir, 'synthetic.sqlite'), cfg = new configPlugin.ConfigStore({ dbPath: file }, () => { events++ })
    let db = native(cfg), exec = db.exec.bind(db), prepare = db.prepare.bind(db)
    try {
      db.exec = () => assert.fail('status must not execute SQL'); db.prepare = () => assert.fail('status must not prepare SQL')
      const ready = snapshot(cfg); assert.deepEqual(ready, goodConfiguration); assert(Object.isFrozen(ready))
      db.exec = exec; db.prepare = prepare
      const d = cfg.createObject('synthetic', 'mock.invalid', 502), g = cfg.createGroup(d.id, 'synthetic', 3, 0, 1); cfg.createRegister(g.id, d.id, 'synthetic', 3, 0)
      const notifications = events
      db.exec = sql => { if (sql === 'COMMIT' || sql === 'ROLLBACK') throw Error('PRIVATE transaction fault'); return exec(sql) }
      assert.throws(() => cfg.updateGroup(g.id, { quantity: 2 }), AggregateError); db.exec = exec
      db.prepare = () => assert.fail('quarantine metadata must not query pending rows')
      assert.deepEqual(snapshot(cfg), { version: 1, phase: 'quarantined', failure: 'connection-quarantined' }); db.prepare = prepare
      exec('ROLLBACK'); assert.equal((snapshot(cfg) as { phase: string }).phase, 'quarantined')
      assert.throws(() => cfg.reopen(dir)); assert.equal((snapshot(cfg) as { phase: string }).phase, 'quarantined')
      cfg.reopen(file); db = native(cfg); exec = db.exec.bind(db); prepare = db.prepare.bind(db)
      assert.deepEqual(snapshot(cfg), goodConfiguration)
      const close = cfg.close(); assert.deepEqual(snapshot(cfg), { version: 1, phase: 'unavailable', failure: 'lifecycle-unavailable' }); await close
      assert.deepEqual(snapshot(cfg), { version: 1, phase: 'unavailable', failure: 'lifecycle-unavailable' }); assert.equal(events, notifications)
    } finally { db.exec = exec; db.prepare = prepare; await cfg.close(); remove(dir) }
  })
  await check('legacy-contract-and-core-scope', async () => {
    const app = Fastify(); let configReads = 0, storeReads = 0
    register(app, () => ({ getSamplePersistenceStatus() { storeReads++; return goodStorage } }), () => ({ getConfigurationReadinessStatus() { configReads++; return goodConfiguration } }))
    try {
      const old = await app.inject('/ready'); assert.equal(old.statusCode, 200); assert.deepEqual(old.json(), { version: 1, status: 'ready', scope: 'sample-storage', storage: { phase: 'ready', failure: null } }); assert.equal(configReads, 0)
      const core = await app.inject('/ready/core?object_id=999&storage_only=true'); assert.equal(core.statusCode, 200); assert.equal(core.headers['cache-control'], 'no-store')
      assert.deepEqual(core.json(), { version: 1, status: 'ready', scope: 'configuration-and-sample-storage', storage: { phase: 'ready', failure: null }, configuration: { phase: 'ready', failure: null } }); assert.equal(configReads, 1); assert.equal(storeReads, 2)
    } finally { await app.close() }
  })
  await check('missing-configuration-is-unchecked-not-ready', async () => {
    const app = Fastify(); register(app, () => ({ getSamplePersistenceStatus: () => goodStorage }))
    try { assert.equal((await app.inject('/ready')).statusCode, 200); const core = await app.inject('/ready/core'); assert.equal(core.statusCode, 503); assert.deepEqual(core.json().configuration, { phase: 'unavailable', failure: 'unavailable' }) }
    finally { await app.close() }
  })
  await check('malformed-throwing-and-asynchronous-configuration', async () => {
    const app = Fastify(); let value: unknown = goodConfiguration, dynamic: (() => unknown) | undefined
    register(app, () => ({ getSamplePersistenceStatus: () => goodStorage }), () => ({ getConfigurationReadinessStatus() { if (dynamic) return dynamic(); if (value instanceof Error) throw value; return value } }))
    try {
      for (const bad of [null, [], {}, { ...goodConfiguration, version: 2 }, { ...goodConfiguration, phase: 'future' }, { ...goodConfiguration, failure: 'connection-quarantined' }, { version: 1, phase: 'quarantined', failure: null }, Error('PRIVATE path/detail')]) {
        value = bad; const response = await app.inject('/ready/core'); assert.equal(response.statusCode, 503); assert.deepEqual(response.json().configuration, { phase: 'unknown', failure: 'status-unverified' }); assert(!response.body.includes('PRIVATE')); await tick()
      }
      for (const factory of [() => Promise.reject(Error('PRIVATE async')), () => new Promise(() => {})]) { dynamic = factory; const response = await app.inject('/ready/core'); assert.equal(response.statusCode, 503); assert.equal(response.json().configuration.phase, 'unknown'); await tick() }; dynamic = undefined
      value = { ...goodConfiguration, privatePath: 'PRIVATE metadata' }; const response = await app.inject('/ready/core'); assert.equal(response.statusCode, 200); assert(!response.body.includes('PRIVATE'))
    } finally { await app.close() }
  })
  await check('configuration-and-storage-fail-independently', async () => {
    const app = Fastify(); let storage: unknown = goodStorage, configuration: unknown = goodConfiguration
    register(app, () => ({ getSamplePersistenceStatus: () => storage }), () => ({ getConfigurationReadinessStatus: () => configuration }))
    try {
      configuration = { version: 1, phase: 'quarantined', failure: 'connection-quarantined' }; let response = await app.inject('/ready/core'); assert.equal(response.statusCode, 503); assert.equal(response.json().storage.phase, 'ready'); assert.equal((await app.inject('/ready')).statusCode, 200)
      configuration = goodConfiguration; storage = { ...goodStorage, phase: 'failed', failure: 'flush-failed' }; response = await app.inject('/ready/core'); assert.equal(response.statusCode, 503); assert.equal(response.json().configuration.phase, 'ready'); assert.equal((await app.inject('/ready')).statusCode, 503)
      configuration = { version: 1, phase: 'unavailable', failure: 'lifecycle-unavailable' }; response = await app.inject('/ready/core'); assert.equal(response.statusCode, 503)
      storage = goodStorage; configuration = goodConfiguration; assert.equal((await app.inject('/ready/core')).statusCode, 200)
    } finally { await app.close() }
  })
  await check('admitted-core-request-during-close', async () => {
    const app = Fastify(); let admit!: () => void, proceed!: () => void, closing!: () => void, finish!: () => void, calls = 0
    const admitted = new Promise<void>(done => { admit = done }), continued = new Promise<void>(done => { proceed = done }), shutdown = new Promise<void>(done => { closing = done }), ended = new Promise<void>(done => { finish = done })
    app.addHook('preHandler', async request => { if (request.url === '/ready/core') { admit(); await continued } })
    register(app, () => { calls++; return { getSamplePersistenceStatus: () => goodStorage } }, () => { calls++; return { getConfigurationReadinessStatus: () => goodConfiguration } })
    app.addHook('preClose', async () => { closing(); await ended })
    let stop: Promise<void> | undefined
    try { const request = Promise.resolve(app.inject('/ready/core')); await admitted; stop = app.close(); await shutdown; proceed(); const response = await request; assert.equal(response.statusCode, 503); assert.equal(calls, 0); assert.equal(response.headers['cache-control'], 'no-store') }
    finally { proceed(); finish(); await (stop ?? app.close()) }
  })
  await check('real-plugin-quarantine-recovery-and-no-probe-side-effects', async () => {
    const dir = directory(), ctx = new Context(); let app: FastifyInstance | undefined, cfg: configPlugin.ConfigStore | undefined, store: storePlugin.DuckDBStore | undefined, db: DatabaseSync | undefined, exec: DatabaseSync['exec'] | undefined
    try {
      await ctx.plugin(configPlugin, { dbPath: join(dir, 'synthetic.sqlite') })
      await ctx.plugin(storePlugin, { dbPath: ':memory:', flushIntervalMs: 0, flushBatchSize: 1000, retentionSeconds: 0, retentionCheckMs: 0 })
      await ctx.plugin({ name: 'inert-core-readiness-services', apply(context: Context) { for (const name of ['poller', 'sink', 'importer', 'ota'] as const) context.provide(name, {} as never) } })
      cfg = ctx.get('config', false); store = ctx.get('store', false); assert(cfg && store)
      // Await initialization in the fixture; the probe itself must never await or trigger it.
      const startup = store as unknown as { ready: Promise<void>; mutations: Promise<void> }
      await startup.ready; await startup.mutations
      const d = cfg.createObject('synthetic', 'mock.invalid', 502), g = cfg.createGroup(d.id, 'synthetic', 3, 0, 1); cfg.createRegister(g.id, d.id, 'synthetic', 3, 0)
      await ctx.plugin(apiPlugin, { host: '127.0.0.1', port: 0, dataDir: dir }); app = ctx.get('api', false); assert(app); await app.ready()
      assert.equal((await app.inject('/ready')).statusCode, 200); const initiallyCore = await app.inject('/ready/core')
      db = native(cfg); exec = db.exec.bind(db)
      db.exec = sql => { if (sql === 'COMMIT' || sql === 'ROLLBACK') throw Error('PRIVATE uncertain transaction'); return exec!(sql) }
      assert.throws(() => cfg!.updateGroup(g.id, { quantity: 2 }), AggregateError); db.exec = exec
      const legacy = await app.inject('/ready'); assert.equal(legacy.statusCode, 200); assert.equal(legacy.json().scope, 'sample-storage'); assert.equal((await app.inject('/api/monitor_objects')).statusCode, 503)
      console.log('CORE READINESS REPRO EVIDENCE: actual API legacy /ready=200 while quarantined configuration read=503; legacy scope is sample-storage')
      assert.equal(initiallyCore.statusCode, 200)
      const before = store.getSamplePersistenceStatus(), methods = ['flush', 'cleanup', 'reopen', 'queryObject'] as const, saved = methods.map(name => store![name])
      const prepare = db.prepare.bind(db), rawExec = db.exec.bind(db); db.prepare = () => assert.fail('core readiness must not query configuration'); db.exec = () => assert.fail('core readiness must not recover configuration')
      for (const name of methods) store[name] = (() => assert.fail('core readiness must not call store.' + name)) as never
      try { const response = await app.inject('/ready/core'); assert.equal(response.statusCode, 503); assert.equal(response.json().configuration.phase, 'quarantined'); assert.equal(response.json().storage.phase, 'ready'); assert(!response.body.includes('PRIVATE')); assert.deepEqual(store.getSamplePersistenceStatus().available, before.available) }
      finally { db.prepare = prepare; db.exec = rawExec; methods.forEach((name, index) => { store![name] = saved[index] as never }) }
      exec('ROLLBACK'); assert.equal((await app.inject('/ready/core')).statusCode, 503)
      const instance = (store as unknown as { instance: { connect: () => Promise<import('@duckdb/node-api').DuckDBConnection> } }).instance, connect = instance.connect.bind(instance)
      let failWrite = true
      instance.connect = async () => { const writer = await connect(), run = writer.run.bind(writer); writer.run = (async (...args: Parameters<typeof run>) => { if (failWrite && String(args[0]).startsWith('INSERT INTO poll_data')) throw Error('PRIVATE storage path'); return run(...args) }) as typeof run; return writer }
      store.write([{ objectId: d.id, area: 'holding-register', address: 0, timestamp: new Date().toISOString(), rawValue: 1, quality: 'good', batchId: 'synthetic', slaveId: 1 }])
      await assert.rejects(store.flush(), /PRIVATE/)
      const bothFailed = await app.inject('/ready/core'); assert.equal(bothFailed.statusCode, 503); assert.equal(bothFailed.json().storage.failure, 'flush-failed'); assert.equal(bothFailed.json().configuration.phase, 'quarantined'); assert(!bothFailed.body.includes('PRIVATE'))
      assert.throws(() => cfg!.reopen(dir)); assert.equal((await app.inject('/ready/core')).statusCode, 503)
      cfg.reopen(join(dir, 'synthetic.sqlite')); const oneRecovered = await app.inject('/ready/core'); assert.equal(oneRecovered.statusCode, 503); assert.equal(oneRecovered.json().configuration.phase, 'ready'); assert.equal(oneRecovered.json().storage.failure, 'flush-failed')
      failWrite = false; await store.flush(); instance.connect = connect; assert.equal(store.getPendingPoints().length, 0); assert.equal((await app.inject('/ready/core')).statusCode, 200)
      let entered!: () => void, release!: () => void
      const held = new Promise<void>(done => { entered = done }), released = new Promise<void>(done => { release = done }), flush = store.flush.bind(store)
      store.flush = async () => { entered(); await released; await flush() }
      const reopening = store.reopen(':memory:')
      try {
        await held; let response = await app.inject('/ready/core'); assert.equal(response.statusCode, 503); assert.equal(response.json().storage.phase, 'switching')
        assert.throws(() => cfg!.reopen(dir)); response = await app.inject('/ready/core'); assert.equal(response.statusCode, 503); assert.equal(response.json().configuration.phase, 'quarantined'); assert.equal(response.json().storage.phase, 'switching'); assert(!response.body.includes(dir))
        cfg.reopen(join(dir, 'synthetic.sqlite')); response = await app.inject('/ready/core'); assert.equal(response.statusCode, 503); assert.equal(response.json().configuration.phase, 'ready'); assert.equal(response.json().storage.phase, 'switching')
      } finally { release(); await reopening; store.flush = flush }
      assert.equal((await app.inject('/ready/core')).statusCode, 200)
      assert.deepEqual((await app.inject('/health')).json(), { status: 'ok', version: '0.1.0' })
      await app.close(); await assert.rejects(app.inject('/ready/core'), { code: 'FST_ERR_REOPENED_CLOSE_SERVER' })
    } finally { if (db?.isOpen && exec) { db.exec = exec; if (db.isTransaction) exec('ROLLBACK') }; await ctx.fiber.dispose(); await app?.close(); await store?.close(); await cfg?.close(); remove(dir) }
  })
  await check('configuration-close-remains-unready-while-storage-recovers', async () => {
    const cfg = new configPlugin.ConfigStore({ dbPath: ':memory:' }), store = new storePlugin.DuckDBStore({ dbPath: ':memory:', flushIntervalMs: 0, flushBatchSize: 1000, retentionSeconds: 0, retentionCheckMs: 0 }), app = Fastify(), ctx = new Context()
    let entered!: () => void, release!: () => void
    const held = new Promise<void>(done => { entered = done }), released = new Promise<void>(done => { release = done })
    const stop = registerResourceCleanup(ctx, [cfg], async () => { entered(); await released })
    register(app, () => store, () => cfg)
    const startup = store as unknown as { ready: Promise<void>; mutations: Promise<void> }
    let closing: Promise<void> | undefined
    try {
      await startup.ready; await startup.mutations; assert.equal((await app.inject('/ready/core')).statusCode, 200)
      const db = native(cfg), instance = (store as unknown as { instance: { connect: () => Promise<import('@duckdb/node-api').DuckDBConnection> } }).instance, connect = instance.connect.bind(instance)
      let fail = true
      instance.connect = async () => { const writer = await connect(), run = writer.run.bind(writer); writer.run = (async (...args: Parameters<typeof run>) => { if (fail && String(args[0]).startsWith('INSERT INTO poll_data')) throw Error('PRIVATE close storage'); return run(...args) }) as typeof run; return writer }
      store.write([{ objectId: 1, area: 'holding-register', address: 0, timestamp: new Date().toISOString(), rawValue: 1, quality: 'good', batchId: 'synthetic', slaveId: 1 }]); await assert.rejects(store.flush(), /PRIVATE/)
      closing = cfg.close(); assert.equal(cfg.close(), closing); await held; assert.equal(db.isOpen, true, 'cleanup gate leaves physical connection open')
      let response = await app.inject('/ready/core'); assert.equal(response.statusCode, 503); assert.equal(response.json().configuration.failure, 'lifecycle-unavailable'); assert.equal(response.json().storage.failure, 'flush-failed'); assert(!response.body.includes('PRIVATE'))
      fail = false; await store.flush(); instance.connect = connect
      response = await app.inject('/ready/core'); assert.equal(response.statusCode, 503); assert.equal(response.json().storage.phase, 'ready'); assert.equal(response.json().configuration.phase, 'unavailable'); assert.equal((await app.inject('/ready')).statusCode, 200)
      assert.throws(() => cfg.reopen(':memory:'), /closing or closed/); assert.equal((await app.inject('/ready/core')).statusCode, 503)
      release(); await closing; assert.equal(db.isOpen, false); assert.equal((await app.inject('/ready/core')).statusCode, 503)
    } finally { release(); await (closing ?? cfg.close()); await stop(); await ctx.fiber.dispose(); await app.close(); await store.close() }
  })
  await check('completed-observation-is-not-a-response-delivery-lease', async () => {
    const cfg = new configPlugin.ConfigStore({ dbPath: ':memory:' }), app = Fastify()
    let observed!: () => void, release!: () => void, first = true
    const held = new Promise<void>(done => { observed = done }), released = new Promise<void>(done => { release = done })
    app.addHook('onSend', async (_request, reply, payload) => { if (first && reply.statusCode === 200) { first = false; observed(); await released }; return payload })
    register(app, () => ({ getSamplePersistenceStatus: () => goodStorage }), () => cfg)
    let response: Promise<Awaited<ReturnType<typeof app.inject>>> | undefined
    try {
      response = Promise.resolve(app.inject('/ready/core')); await held; await cfg.close()
      const after = await app.inject('/ready/core'); assert.equal(after.statusCode, 503); assert.equal(after.json().configuration.phase, 'unavailable')
      release(); const before = await response; assert.equal(before.statusCode, 200); assert.equal(before.json().configuration.phase, 'ready'); assert.equal(before.headers['cache-control'], 'no-store')
    } finally { release(); await response; await app.close(); await cfg.close() }
  })
  await check('real-plugin-dependency-unload-replacement-and-api-disposal', async () => {
    const dir = directory(), ctx = new Context(), apps: FastifyInstance[] = [], stores: storePlugin.DuckDBStore[] = []
    try {
      await ctx.plugin(configPlugin, { dbPath: join(dir, 'synthetic.sqlite') })
      await ctx.plugin({ name: 'inert-core-replacement-services', apply(context: Context) { for (const name of ['poller', 'sink', 'importer', 'ota'] as const) context.provide(name, {} as never) } })
      const options = { dbPath: ':memory:', flushIntervalMs: 0, flushBatchSize: 1000, retentionSeconds: 0, retentionCheckMs: 0 }
      let fork = await ctx.plugin(storePlugin, options)
      const api = await ctx.plugin(apiPlugin, { host: '127.0.0.1', port: 0, dataDir: dir })
      const current = async () => { const app = ctx.get('api', false), store = ctx.get('store', false); assert(app && store); apps.push(app); stores.push(store); const startup = store as unknown as { ready: Promise<void>; mutations: Promise<void> }; await startup.ready; await startup.mutations; await app.ready(); assert.equal((await app.inject('/ready/core')).statusCode, 200); return app }
      await api.await(); const old = await current(); await fork.dispose(); assert.equal(ctx.get('api', false), undefined)
      for (const route of ['/ready/core', '/ready']) await assert.rejects(old.inject(route), { code: 'FST_ERR_REOPENED_CLOSE_SERVER' })
      fork = await ctx.plugin(storePlugin, options); await api; const fresh = await current(); assert.notEqual(fresh, old)
      await assert.rejects(old.inject('/ready/core'), { code: 'FST_ERR_REOPENED_CLOSE_SERVER' })
      await api.dispose(); assert.equal(ctx.get('api', false), undefined); await assert.rejects(fresh.inject('/ready/core'), { code: 'FST_ERR_REOPENED_CLOSE_SERVER' }); await api.dispose(); await fork.dispose()
    } finally { await ctx.fiber.dispose(); for (const app of apps) await app.close(); for (const store of stores) await store.close(); remove(dir) }
  })
  await tick(); assert.deepEqual(unhandled, []); assert.deepEqual(denied, []); assert.deepEqual(failures, [])
} finally { net.Server.prototype.listen = listen; net.Socket.prototype.connect = connect; globalThis.fetch = fetch; process.off('unhandledRejection', collect) }
console.log('CORE READINESS TEST OK: ' + passed.length + ' metadata/legacy/new-scope/failure/close and real-plugin cases; no SQL probes, real data, listeners, drivers or models')
