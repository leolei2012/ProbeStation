/** Test-only conditional Sink candidate. Intentionally proves remaining gaps; NOT a production capability. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import Fastify from 'fastify'
import ExcelJS from 'exceljs'
import { ConfigStore } from '../packages/config/src/index.ts'
import { DuckDBStore } from '../packages/store/src/index.ts'
import { Sink } from '../packages/sink/src/index.ts'
import { registerHistoryExport } from '../packages/api/src/history-export.ts'

if (process.argv.slice(2).join(' ') !== '--memory') throw new Error('只接受 --memory，不接受地址或文件库路径。')
const start = '2026-11-07T00:00:00.123Z', end = '2026-11-07T00:00:01.123Z'
const request = Object.freeze({ objectId: 1, start, end, ids: Object.freeze([1]), tz: 0 })
const mismatch = () => Object.assign(new Error('audit candidate condition mismatch'), { code: 'AUDIT_CONDITION_MISMATCH', statusCode: 409 })
const changed = (error: unknown) => (error as any)?.code === 'AUDIT_CONDITION_MISMATCH'
const defer = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
async function memory(run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const f = await fixture()
  try { await run(f) }
  finally { await f.app.close(); await (f.store as any).mutations; const conn = await (f.store as any).ready.catch(() => null); conn?.closeSync(); (f.store as any).instance?.closeSync(); (f.cfg as any).db.close() }
}
async function fixture() {
  const cfg = new ConfigStore({ dbPath: ':memory:' })
  const store = new DuckDBStore({ dbPath: ':memory:', flushIntervalMs: 0, flushBatchSize: 10000, retentionSeconds: 0, retentionCheckMs: 0 }, cfg)
  await (store as any).ready
  const seed = () => { const device = cfg.createObject('synthetic', 'mock.invalid', 502), group = cfg.createGroup(device.id, 'group', 3, 0, 2, 'read', 1); cfg.createRegister(group.id, device.id, 'point', 3, 0, 'uint16') }
  seed()
  const write = async (rawValue: number) => { store.write([{ objectId: 1, area: 'holding-register', address: 0, timestamp: start, rawValue, slaveId: 1, batchId: 'response', quality: 'good' }]); await store.flush() }
  await write(10)
  const ctx = { config: cfg, store }, app = Fastify()
  let queries = 0, afterRead: (() => Promise<void>) | undefined
  const capture = () => {
    const config = ctx.config, data = ctx.store, graph = config.getHistoryExportConfiguration(request.objectId), handle = data.captureExportReadHandle()
    const digest = createHash('sha256').update(JSON.stringify([request, graph, handle.storeScope])).digest('hex')
    return { config, data, graph, handle, digest }
  }
  const preview = () => capture().digest
  // Candidate exists only in this audit. It consumes exactly the compared graph via immutable providers.
  const candidate = async (format: 'csv' | 'xlsx', expected: string) => {
    const owned = capture()
    if (owned.digest !== expected) throw mismatch()
    const validate = () => {
      if (ctx.config !== owned.config || ctx.store !== owned.data) throw mismatch()
      try { owned.data.validateExportReadHandle(owned.handle); if (capture().digest !== expected) throw mismatch() }
      catch { throw mismatch() }
    }
    validate()
    const frozenSink = new Sink({ config: { listRegistersByObject: () => owned.graph.registers, listGroups: () => owned.graph.groups, getObject: () => owned.graph.device }, store: {
      async queryObjectForExport(...args: Parameters<DuckDBStore['queryObjectForExport']>) {
        validate(); queries++; const rows = await owned.data.queryObjectForExportWithHandle(owned.handle, ...args)
        await afterRead?.(); return rows
      },
    } })
    const args: [number, string, string, number[], number] = [request.objectId, request.start, request.end, [...request.ids], request.tz]
    const body = format === 'csv' ? await frozenSink.exportCsv(...args) : await frozenSink.exportXlsx(...args)
    validate(); return { body, validate }
  }
  return { cfg, store, ctx, app, seed, write, preview, candidate, get queries() { return queries }, set afterRead(hook: (() => Promise<void>) | undefined) { afterRead = hook } }
}
const readValue = async (format: 'csv' | 'xlsx', body: string | Buffer) => {
  if (format === 'csv') return String(body).split('\n')[1].split(',')[1]
  const book = new ExcelJS.Workbook(); await book.xlsx.load(body as any); return book.getWorksheet('data')!.getCell('B2').value
}

for (const format of ['csv', 'xlsx'] as const) {
  await memory(async f => {
    const expected = f.preview(), exported = await f.candidate(format, expected)
    assert.equal(await readValue(format, exported.body), '10'); exported.validate()
    f.cfg.updateGroup(1, { slaveId: 2 }); const before = f.queries
    await assert.rejects(f.candidate(format, expected), changed); assert.equal(f.queries, before, 'stale source must reject before raw SQL')
  })
  for (const edit of [(cfg: ConfigStore) => cfg.updateRegister(1, { alias: 'renamed' }), (cfg: ConfigStore) => cfg.updateRegister(1, { factor: 0 }), (cfg: ConfigStore) => cfg.updateRegister(1, { dataType: 'uint32' }), (cfg: ConfigStore) => cfg.updateGroup(1, { slaveId: 2 })]) {
    await memory(async f => {
      const expected = f.preview(), scope = f.cfg.getHistoryExportConfigurationScope(), entered = defer(), release = defer()
      f.afterRead = async () => { entered.resolve(); await release.promise }
      const pending = f.candidate(format, expected), rejection = assert.rejects(pending, changed)
      await entered.promise
      try { edit(f.cfg); assert.equal(f.cfg.getHistoryExportConfigurationScope(), scope, 'ordinary editing does not rotate scope') }
      finally { release.resolve() }
      await rejection
    })
  }
}

// Real XLSX bytes are generated first; edit while writeBuffer is withheld, before candidate postcheck.
await memory(async f => {
  const prototype = Object.getPrototypeOf(new ExcelJS.Workbook().xlsx), original = prototype.writeBuffer, entered = defer(), release = defer()
  prototype.writeBuffer = async function (...args: unknown[]) { const bytes = await original.apply(this, args); entered.resolve(); await release.promise; return bytes }
  try {
    const pending = f.candidate('xlsx', f.preview()), rejection = assert.rejects(pending, changed)
    await entered.promise; f.cfg.updateRegister(1, { alias: 'after XLSX bytes' }); release.resolve(); await rejection
  } finally { release.resolve(); prototype.writeBuffer = original }
})

for (const kind of ['config', 'store'] as const) await memory(async f => {
  const expected = f.preview()
  if (kind === 'config') { f.cfg.reopen(':memory:'); f.seed() }
  else { await f.store.reopen(':memory:'); await f.write(200) }
  await assert.rejects(f.candidate('csv', expected), changed)
})
// Current-content conditions do not promise that no intermediate edit occurred (ABA).
await memory(async f => {
  const expected = f.preview()
  f.afterRead = async () => { f.cfg.updateRegister(1, { alias: 'temporary' }); f.cfg.updateRegister(1, { alias: 'point' }) }
  assert.equal(await readValue('csv', (await f.candidate('csv', expected)).body), '10')
})

// Known gap 1: candidate postcheck ends before the existing async route receives/attaches its return value.
await memory(async f => {
  const expected = f.preview()
  registerHistoryExport(f.app, { async exportCsv() { const result = await f.candidate('csv', expected); f.cfg.updateRegister(1, { alias: 'between Sink and route' }); return result.body as string }, async exportXlsx() { throw new Error('not invoked') } })
  const response = await f.app.inject(`/api/export/csv?object_id=1&start=${start}&end=${end}&register_ids=1`)
  assert.equal(response.statusCode, 200); assert(response.headers['content-disposition']); assert.match(response.body.split('\n')[0], /point/)
  assert.notEqual(f.preview(), expected, 'configuration changed before the shared route attached the file')
})
// Test-only proposed post-await route check closes that specific gap; not a production route/protocol.
await memory(async f => {
  const expected = f.preview()
  f.app.get('/audit/checked', async (_req, reply) => { const result = await f.candidate('csv', expected); f.cfg.updateRegister(1, { alias: 'between Sink and route' }); result.validate(); return reply.header('Content-Disposition', 'attachment').send(result.body) })
  const response = await f.app.inject('/audit/checked'); assert.equal(response.statusCode, 409); assert.equal(response.headers['content-disposition'], undefined)
})
// Known gap 2: fresh conditions can bless already mismatched lifetimes; no startup ownership is established.
await memory(async f => {
  const oldScope = f.cfg.getHistoryExportConfigurationScope(), old = f.preview()
  await f.store.reopen(':memory:'); await f.write(200)
  assert.equal(f.cfg.getHistoryExportConfigurationScope(), oldScope); await assert.rejects(f.candidate('csv', old), changed)
  const fresh = await f.candidate('csv', f.preview()); assert.equal(await readValue('csv', fresh.body), '200'); fresh.validate()
})
console.log(JSON.stringify({ audit: 'CONDITIONAL SINK CANDIDATE; REMAINING GAPS REPRODUCED; NOT A SAFETY PASS', proved: ['CSV/XLSX normal', 'stale source before SQL', 'same-scope alias/factor-zero/dtype/source edits during read', 'XLSX generation edit', 'config/store reopen after preview'], remaining: ['existing route accepts edits between Sink return and attachment', 'fresh preview accepts independently reopened store with old config', 'no deployed preview/checked capability or acknowledgment/client handshake'], currentContentCondition: 'ABA accepted, not a monotonic revision', proposedRoutePostcheck: '409 without attachment in test-only route', productionIntegration: false, database: ':memory: only', listeners: false, workspaceLoaded: false }))
