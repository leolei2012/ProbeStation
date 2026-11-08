import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ConfigStore } from '../packages/config/src/index.ts'
import { registerLogCleanup } from '../packages/api/src/log-cleanup.ts'
import { parseLogCleanupPreview, parseLogCleanupResult, type LogCleanupPreview } from '../packages/core/src/log-cleanup.ts'
import { LogCleanupFlow } from '../apps/web/src/log-cleanup-flow.ts'
import { LogCleanupDialog, LogCleanupDialogView } from '../apps/web/src/LogCleanupDialog.tsx'

// Explicit memory/new temporary databases and injected requests only; never run a real service.
const cfg = new ConfigStore({ dbPath: ':memory:' }), app = Fastify(); registerLogCleanup(app, cfg)
const headers = { 'x-probestation-config': '1', host: 'mock.test:9090', origin: 'http://mock.test:9090' }
const post = (expected: unknown, extra: Record<string, string> = {}) => app.inject({ method: 'POST', url: '/api/logs/cleanup', headers: { ...headers, ...extra }, payload: { expected } })
const errorCode = (code: number) => (error: any) => error.statusCode === code
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
let sample!: LogCleanupPreview
try {
  const device = cfg.createObject('memory-only', '', 502), backup = () => { const { createdAt: _time, ...data } = cfg.exportBackup(); return data }, before = backup()
  const empty = cfg.previewLogCleanup(); assert.equal(empty.count, 0); assert.equal(empty.throughId, 0); assert.equal((await post(empty)).statusCode, 400)
  cfg.log('INFO', 'mock', 'reviewed-a'); cfg.log('WARN', 'mock', 'reviewed-b')
  const previewResponse = await app.inject('/api/logs/cleanup-preview'); assert.equal(previewResponse.headers['cache-control'], 'no-store'); sample = parseLogCleanupPreview(previewResponse.json())
  assert.equal(sample.count, 2); assert(Object.isFrozen(sample)); assert.equal(cfg.listLogs().length, 2, 'preview is read-only')
  for (const change of [{ count: 1 }, { throughId: 999 }, { revision: 'v1:' + '0'.repeat(64) }]) assert.equal((await post({ ...sample, ...change })).statusCode, 409)
  assert.equal((await post(sample, { 'x-probestation-config': '' })).statusCode, 403)
  assert.equal((await post(sample, { origin: 'http://other.test' })).statusCode, 403)
  assert.equal((await post(sample, { origin: 'not-a-url' })).statusCode, 403)
  assert.equal(cfg.listLogs().length, 2)
  cfg.log('ERROR', 'mock', 'new-after-preview'); const newerId = cfg.listLogs()[0].id
  const response = await post(sample); assert.equal(response.statusCode, 200)
  const result = parseLogCleanupResult(response.json(), sample); assert.equal(result.deleted, 2); assert.equal(result.alreadyRemoved, 0); assert.equal(result.remaining, 1)
  assert.deepEqual(cfg.listLogs().map(row => row.id), [newerId]); assert.deepEqual(backup(), before); assert.equal(cfg.getObject(device.id)?.name, 'memory-only')
  cfg.log('INFO', 'mock', 'newer-again'); const afterReplay = cfg.listLogs().map(row => row.id)
  const replay = await post(sample); assert.equal(replay.statusCode, 200); assert.equal(replay.json().deleted, 0); assert.equal(replay.json().alreadyRemoved, 2); assert.deepEqual(cfg.listLogs().map(row => row.id), afterReplay, 'replay can never include higher IDs')
  const partiallyRemoved = cfg.previewLogCleanup(); (cfg as any).db.prepare('DELETE FROM logs WHERE id = ?').run(afterReplay[1])
  cfg.log('INFO', 'mock', 'keep after partial removal'); const partial = cfg.cleanupReviewedLogs({ expected: partiallyRemoved }); assert.equal(partial.deleted, 1); assert.equal(partial.alreadyRemoved, 1); assert.equal(cfg.listLogs().length, 1)
  const legacyBoundary = cfg.previewLogCleanup(); cfg.clearLogs(); cfg.log('WARN', 'mock', 'kept after old clear'); const legacyReplay = cfg.cleanupReviewedLogs({ expected: legacyBoundary }); assert.equal(legacyReplay.deleted, 0); assert.equal(cfg.listLogs().length, 1, 'AUTOINCREMENT protects the reviewed prefix after legacy deletion')
  const current = cfg.previewLogCleanup(); cfg.reopen(':memory:'); cfg.log('INFO', 'mock', 'different database scope')
  assert.throws(() => cfg.cleanupReviewedLogs({ expected: current }), errorCode(409)); assert.equal(cfg.listLogs().length, 1)
  const oversized = await app.inject({ method: 'POST', url: '/api/logs/cleanup', headers, payload: { expected: current, padding: 'x'.repeat(20000) } }); assert.equal(oversized.statusCode, 413); assert.equal(cfg.listLogs().length, 1)
} finally { await app.close(); (cfg as any).db.close() }

const legacy = new ConfigStore({ dbPath: ':memory:' })
try {
  legacy.log('INFO', 'mock', 'reviewed supported schema'); const expected = legacy.previewLogCleanup()
  ;(legacy as any).db.exec('DROP TABLE logs; CREATE TABLE logs (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, level TEXT, source TEXT, message TEXT)')
  legacy.log('INFO', 'mock', 'non-autoincrement schema')
  assert.throws(() => legacy.previewLogCleanup(), errorCode(409), 'unknown ID reuse behavior must block guarded cleanup without migrating a database')
  assert.throws(() => legacy.cleanupReviewedLogs({ expected }), errorCode(409), 'schema is rechecked inside the cleanup transaction before any deletion')
  assert.equal(legacy.listLogs().length, 1); legacy.clearLogs(); assert.equal(legacy.listLogs().length, 0, 'legacy method remains unchanged')
} finally { (legacy as any).db.close() }
const unavailable = Fastify(); registerLogCleanup(unavailable, { previewLogCleanup() { throw new Error('PRIVATE preview failure') }, cleanupReviewedLogs() { throw new Error('PRIVATE write failure') } })
try {
  const read = await unavailable.inject('/api/logs/cleanup-preview'); assert.equal(read.statusCode, 503); assert(!read.body.includes('PRIVATE'))
  const write = await unavailable.inject({ method: 'POST', url: '/api/logs/cleanup', headers, payload: { expected: sample } }); assert.equal(write.statusCode, 500); assert(!write.body.includes('PRIVATE'))
} finally { await unavailable.close() }

const failure = new ConfigStore({ dbPath: ':memory:' })
try {
  failure.log('INFO', 'mock', 'rollback'); const expected = failure.previewLogCleanup(), db = (failure as any).db, prepare = db.prepare.bind(db)
  db.prepare = (sql: string) => { if (sql === 'SELECT COUNT(*) AS count FROM logs') throw new Error('PRIVATE postdelete read failure'); return prepare(sql) }
  assert.throws(() => failure.cleanupReviewedLogs({ expected }), /postdelete/); db.prepare = prepare; assert.equal(failure.listLogs().length, 1, 'delete rolls back on failed readback')
  const exec = db.exec.bind(db)
  db.exec = (sql: string) => { if (sql === 'ROLLBACK') throw new Error('PRIVATE rollback failure'); return exec(sql) }
  db.prepare = (sql: string) => { if (sql === 'SELECT COUNT(*) AS count FROM logs') throw new Error('PRIVATE read failure'); return prepare(sql) }
  assert.throws(() => failure.cleanupReviewedLogs({ expected }), /回滚失败/)
  db.exec = exec; db.prepare = prepare; db.exec('ROLLBACK')
  assert.throws(() => failure.cleanupReviewedLogs({ expected }), errorCode(409), 'uncertain rollback invalidates old conditions')
  assert.throws(() => failure.previewLogCleanup(), /未确认/, 'uncertain transaction cannot issue a new authoritative cleanup preview')
  assert.throws(() => failure.listLogs(), /此连接已隔离/)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM logs').get().count, 1, 'raw isolated fixture confirms rollback; public reads remain quarantined')
  failure.reopen(':memory:'); assert.equal(failure.previewLogCleanup().count, 0, 'only explicit successful re-open releases the cleanup block')
} finally { (failure as any).db.close() }
// Two independent connections: each has distinct runtime scope, but writes to the same temporary DB.
const temp = mkdtempSync(join(tmpdir(), 'probestation-log-cleanup-')), path = join(temp, 'config.db'), a = new ConfigStore({ dbPath: path }), b = new ConfigStore({ dbPath: path })
try {
  a.log('INFO', 'mock', 'old'); const expected = a.previewLogCleanup(); b.log('INFO', 'mock', 'new from second connection')
  assert.throws(() => b.cleanupReviewedLogs({ expected }), errorCode(409))
  const result = a.cleanupReviewedLogs({ expected }); assert.equal(result.deleted, 1); assert.equal(a.listLogs()[0].message, 'new from second connection')
  const reopened = a.previewLogCleanup(); a.reopen(path); assert.throws(() => a.cleanupReviewedLogs({ expected: reopened }), errorCode(409)); assert.equal(a.listLogs().length, 1)
} finally { (a as any).db.close(); (b as any).db.close() }

for (const bad of [null, {}, { ...sample, count: '2' }, { ...sample, throughId: -1 }, { ...sample, count: 0 }, { ...sample, revision: 'bad' }, { ...sample, extra: 1 }]) assert.throws(() => parseLogCleanupPreview(bad))
assert.throws(() => parseLogCleanupResult({ ok: true }, sample))
const ok = { ok: true, throughId: sample.throughId, revision: sample.revision, deleted: sample.count, alreadyRemoved: 0, remaining: 1 }
for (const change of [{ throughId: 999 }, { revision: 'bad' }, { deleted: 999 }, { alreadyRemoved: 2 }, { remaining: -1 }]) assert.throws(() => parseLogCleanupResult({ ...ok, ...change }, sample))

let requests = 0; const pending = deferred<Response>(), calls: Array<{ url: string; init?: RequestInit }> = []
const flow = new LogCleanupFlow((async (url: string, init?: RequestInit) => { calls.push({ url, init }); requests++; return url.endsWith('cleanup-preview') ? new Response(JSON.stringify(sample)) : pending.promise }) as typeof fetch, { slowWriteMs: 15 })
assert.equal(requests, 0); const unsubscribe = flow.subscribe(() => {}); unsubscribe(); assert.equal(requests, 0)
await flow.preview(); assert.equal(flow.snapshot().phase, 'ready')
const saving = flow.confirm(); await flow.confirm(); await flow.preview(); assert.equal(requests, 2); assert.equal(flow.snapshot().phase, 'saving')
assert.equal(calls[1].init?.signal, undefined, 'writes are never aborted on dialog close or slow results'); assert.deepEqual(JSON.parse(String(calls[1].init?.body)), { expected: sample }); assert.equal((calls[1].init?.headers as any)['x-probestation-config'], '1')
flow.closeRead(); await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(flow.snapshot().phase, 'saving'); assert.equal(flow.snapshot().slow, true)
pending.resolve(new Response(JSON.stringify(ok))); await saving; assert.equal(flow.snapshot().phase, 'completed'); await flow.confirm(); assert.equal(requests, 2, 'completed journal cannot replay')
flow.closeRead(); assert.equal(flow.snapshot().phase, 'completed', 'closing does not discard the write result')
for (const status of [400, 403, 404, 409, 413, 415, 500]) {
  let posts = 0
  const rejected = new LogCleanupFlow((async (url: string) => { if (url.endsWith('cleanup-preview')) return new Response(JSON.stringify(sample)); posts++; return new Response('{}', { status }) }) as typeof fetch)
  await rejected.preview(); await rejected.confirm(); assert.equal(rejected.snapshot().phase, status === 500 ? 'uncertain' : 'rejected'); await rejected.confirm(); assert.equal(posts, 1)
}
const unknown = new LogCleanupFlow((async (url: string) => new Response(JSON.stringify(url.endsWith('cleanup-preview') ? sample : { ok: true }))) as typeof fetch)
await unknown.preview(); await unknown.confirm(); assert.equal(unknown.snapshot().phase, 'uncertain'); unknown.closeRead(); assert.equal(unknown.snapshot().phase, 'uncertain')
let lostWrites = 0
const lost = new LogCleanupFlow((async (url: string) => { if (url.endsWith('cleanup-preview')) return new Response(JSON.stringify(sample)); lostWrites++; throw new Error('synthetic connection lost') }) as typeof fetch)
await lost.preview(); await lost.confirm(); assert.equal(lost.snapshot().phase, 'uncertain'); assert.equal(lost.snapshot().error, undefined); await lost.confirm(); assert.equal(lostWrites, 1)
assert(!calls.some(call => call.url.endsWith('/clear')), 'no legacy destructive fallback')
const endToEnd = new ConfigStore({ dbPath: ':memory:' }), memoryApi = Fastify(); registerLogCleanup(memoryApi, endToEnd)
try {
  endToEnd.log('INFO', 'mock', 'old-one'); endToEnd.log('INFO', 'mock', 'old-two')
  const integrated = new LogCleanupFlow((async (url: string, init?: RequestInit) => {
    const response = await memoryApi.inject({ method: (init?.method ?? 'GET') as any, url, headers: init?.headers as any, ...(init?.body ? { payload: String(init.body) } : {}) })
    return new Response(response.body, { status: response.statusCode })
  }) as typeof fetch)
  await integrated.preview(); endToEnd.log('ERROR', 'mock', 'new-during-confirmation'); await integrated.confirm()
  assert.equal(integrated.snapshot().phase, 'completed'); assert.equal(integrated.snapshot().result?.deleted, 2); assert.equal(endToEnd.listLogs()[0].message, 'new-during-confirmation')
} finally { await memoryApi.close(); (endToEnd as any).db.close() }
let signal: AbortSignal | undefined
const hanging = new LogCleanupFlow((async (_url: string, init?: RequestInit) => { signal = init?.signal as AbortSignal; return new Promise(() => {}) }) as typeof fetch, { previewTimeoutMs: 15 })
await hanging.preview(); assert.equal(hanging.snapshot().error, 'timeout'); assert(signal!.aborted)
const old = deferred<Response>(), fresh = deferred<Response>(); let previews = 0
const reading = new LogCleanupFlow((async () => ++previews === 1 ? old.promise : fresh.promise) as typeof fetch)
const first = reading.preview(); await turn(); reading.closeRead(); const second = reading.preview(); fresh.resolve(new Response(JSON.stringify(sample))); await second; old.resolve(new Response('{}')); await first; assert.equal(reading.snapshot().phase, 'ready')

for (const english of [false, true]) for (const state of [flow.snapshot(), unknown.snapshot(), { phase: 'saving' as const, preview: sample, slow: true }, { phase: 'preview-error' as const, error: 'read' as const }, { phase: 'ready' as const, preview: sample, previewAt: '2026-11-07T00:00:00Z' }, { phase: 'ready' as const, preview: { ...sample, count: 0, throughId: 0 } }]) {
  const html = renderToStaticMarkup(createElement(LogCleanupDialogView, { state, preview() {}, confirm() {}, close() {}, english }))
  assert(html.includes('role="dialog"')); assert(html.includes('type="button"')); assert(html.includes(english ? 'subsequent logs are kept' : '新增日志会保留')); assert(!html.includes('PRIVATE'))
  if (state.phase !== 'ready' || !state.preview?.count) assert(html.includes('class="btn danger" disabled=""'))
}
let ssr = 0; const never = new LogCleanupFlow((async () => { ssr++; throw new Error('SSR must not request') }) as typeof fetch)
assert.equal(renderToStaticMarkup(createElement(LogCleanupDialog, { flow: never, onClose() {} })), ''); assert.equal(ssr, 0)
console.log('LOG CLEANUP OK: memory preview/prefix preservation/tamper/source/replay/empty/origin checks, transaction rollback + invalidation, temporary dual connection/reopen, strict frozen protocol, one-shot non-aborted write journal/slow/uncertain/rejected, preview timeout/late cancellation and bilingual SSR; no real data, listeners, hardware, model or DOM automation')
