import assert from 'node:assert/strict'
import Fastify from 'fastify'
import ExcelJS from 'exceljs'
import { Sink } from '../packages/sink/src/index.ts'
import { registerHistoryExport } from '../packages/api/src/history-export.ts'
import { HISTORY_EXPORT_RAW_LIMIT, HistoryExportLimitError } from '../packages/core/src/history-export-policy.ts'
import { captureHistoryExport, downloadHistoryExport } from '../apps/web/src/history-export.ts'

// Real encoders and routes, memory-only metadata/raw rows/files, no network listener or database.
const maxColumns = 16384, maxPoints = Math.floor((maxColumns - 1) / 3)
const definitions = Array.from({ length: maxPoints + 1 }, (_, i) => ({ id: i + 1, startAddress: i, functionCode: 3, dataType: 'uint16', alias: 'p' + i }))
const start = '2026-11-06T00:00:00Z', end = '2026-11-06T00:01:00Z', timestampMs = Date.parse(start)
const row = { ts: start, timestampMs, area: 'holding-register', address: 0, rawValue: 7, quality: 'good', batchId: 'synthetic' }
let registers = definitions, rows = [row], reads = 0
const sink = new Sink({ config: { listRegistersByObject: () => registers }, store: { async queryObjectForExport() { reads++; return rows } } })
const app = Fastify(); registerHistoryExport(app, sink)
const query = '?object_id=1&start=' + start + '&end=' + end
const failures: unknown[] = []; let passed = 0
async function check(name: string, test: () => Promise<void>) {
  try { await test(); passed++; console.log('HISTORY CAPACITY OK:', name) }
  catch (error) { failures.push(error); console.error('HISTORY CAPACITY FAILED:', name, error) }
  finally { registers = definitions; rows = [row] }
}
let boundary: Buffer | undefined
try {
  await check('impossible XLSX width rejects before any historical read, including empty results', async () => {
    for (const empty of [false, true]) {
      rows = empty ? [] : [row]; const before = reads
      await assert.rejects(sink.exportXlsx(1, start, end), error => {
        assert.equal((error as any).code, 'HISTORY_EXPORT_COLUMN_LIMIT')
        assert.equal((error as any).limit, maxColumns)
        assert.equal((error as any).pointLimit, maxPoints)
        return true
      })
      assert.equal(reads, before, 'cannot read or decode a file that the format cannot represent')
    }
  })
  await check('actual route returns actionable 413 without attachment and client does not save', async () => {
    const before = reads, response = await app.inject('/api/export/xlsx' + query)
    assert.equal(response.statusCode, 413)
    assert.equal(response.json().code, 'HISTORY_EXPORT_COLUMN_LIMIT')
    assert.equal(response.json().limit, maxColumns); assert.equal(response.json().pointLimit, maxPoints)
    assert.match(response.json().error, /5461.*CSV/)
    assert.equal(response.headers['content-disposition'], undefined)
    assert.equal(response.headers['cache-control'], 'no-store')
    const context = { definitions: 'synthetic', device: 'synthetic' }, request = captureHistoryExport(1, { start: timestampMs, end: timestampMs + 1000 }, [1], 0, 'full', context)
    let saved = 0
    await assert.rejects(downloadHistoryExport('xlsx', request, new AbortController().signal, () => context, (async () => new Response(response.rawPayload as any, { status: response.statusCode, headers: response.headers as any })) as typeof fetch, () => { saved++ }), /HTTP 413.*5461.*CSV/)
    assert.equal(saved, 0); assert.equal(reads, before)
  })
  await check('one below and exact maximum produce readable XLSX, exact last column is XFD', async () => {
    rows = []
    for (const count of [maxPoints - 1, maxPoints]) {
      registers = definitions.slice(0, count); const before = reads
      const buffer = await sink.exportXlsx(1, start, end), workbook = new ExcelJS.Workbook()
      await workbook.xlsx.load(buffer as any)
      const sheet = workbook.getWorksheet('data')!
      assert.equal(sheet.columnCount, 1 + count * 3); assert.equal(sheet.rowCount, 1)
      assert.equal(sheet.getCell(1, sheet.columnCount).value, 'p' + (count - 1) + '__automatic_eligible')
      assert.equal(reads, before + 1)
      if (count === maxPoints) { assert.equal(sheet.getCell('XFD1').value, 'p5460__automatic_eligible'); boundary = buffer }
    }
  })
  await check('limit counts selected definitions and preserves selection, CSV, and empty selection compatibility', async () => {
    const ids = [1, definitions.length, 1], buffer = await sink.exportXlsx(1, start, end, ids)
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(buffer as any)
    const sheet = workbook.getWorksheet('data')!
    assert.equal(sheet.columnCount, 7); assert.equal(sheet.rowCount, 2)
    assert.equal(sheet.getCell('B1').value, 'p0'); assert.equal(sheet.getCell('E1').value, 'p5461')
    assert.equal(sheet.getCell('B2').value, '7'); assert.equal(sheet.getCell('E2').value, null)
    const csv = await app.inject('/api/export/csv' + query)
    assert.equal(csv.statusCode, 200); assert.match(String(csv.headers['content-disposition']), /attachment/)
    assert.equal(csv.body.split('\n')[0].split(',').length, 1 + definitions.length * 3)
    const unknown = new ExcelJS.Workbook(); await unknown.xlsx.load(await sink.exportXlsx(1, start, end, [999999]) as any)
    assert.equal(unknown.getWorksheet('data')!.columnCount, 1)
    await assert.rejects(sink.exportXlsx(1, start, end, []), error => (error as any).code === 'HISTORY_EXPORT_COLUMN_LIMIT', 'legacy empty id selection still means all definitions')
  })
  await check('existing raw-row limit still rejects representable width before file generation', async () => {
    registers = definitions.slice(0, 1); rows = Array(HISTORY_EXPORT_RAW_LIMIT + 1).fill(row)
    for (const format of ['csv', 'xlsx'] as const) await assert.rejects(format === 'csv' ? sink.exportCsv(1, start, end) : sink.exportXlsx(1, start, end), HistoryExportLimitError)
  })
  await check('cancel before fetch skips work; late wide XLSX body after cancel cannot save', async () => {
    assert(boundary, 'maximum-width workbook must have been generated')
    const context = { definitions: 'synthetic', device: 'synthetic' }, request = captureHistoryExport(1, { start: timestampMs, end: timestampMs + 1000 }, [1], 0, 'full', context)
    let fetched = 0, saved = 0
    const pre = new AbortController(); pre.abort()
    await assert.rejects(downloadHistoryExport('xlsx', request, pre.signal, () => context, (async () => { fetched++; throw new Error('should not fetch') }) as typeof fetch, () => { saved++ }), error => error instanceof DOMException && error.name === 'AbortError')
    assert.equal(fetched, 0)
    let finish!: (value: Blob) => void, entered!: () => void
    const body = new Promise<Blob>(resolve => { finish = resolve }), waiting = new Promise<void>(resolve => { entered = resolve }), cancel = new AbortController()
    const fetcher: typeof fetch = async () => {
      const response = new Response(null, { headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } })
      response.blob = () => { entered(); return body }; return response
    }
    const pending = downloadHistoryExport('xlsx', request, cancel.signal, () => context, fetcher, () => { saved++ })
    await waiting; cancel.abort(); finish(new Blob([new Uint8Array(boundary)]))
    await assert.rejects(pending, error => error instanceof DOMException && error.name === 'AbortError')
    assert.equal(saved, 0)
  })
  await check('known boundary: cancel does not stop the actual route generation, late result is not saved', async () => {
    let release!: () => void, entered!: () => void, generated = 0, saved = 0
    const gate = new Promise<void>(resolve => { release = resolve }), waiting = new Promise<void>(resolve => { entered = resolve })
    const local = Fastify(), source = new Sink({ config: { listRegistersByObject: () => definitions.slice(0, 1) }, store: { async queryObjectForExport() { entered(); await gate; return [row] } } })
    registerHistoryExport(local, source)
    local.addHook('onSend', async (_req, _reply, payload) => { generated++; return payload })
    const context = { definitions: 'synthetic', device: 'synthetic' }, request = captureHistoryExport(1, { start: timestampMs, end: timestampMs + 1000 }, [1], 0, 'full', context), cancel = new AbortController()
    const fetcher: typeof fetch = async url => { const response = await local.inject(String(url)); assert.equal(response.statusCode, 200); return new Response(response.rawPayload as any, { status: response.statusCode, headers: response.headers as any }) }
    const pending = downloadHistoryExport('xlsx', request, cancel.signal, () => context, fetcher, () => { saved++ })
    const rejected = assert.rejects(pending, error => error instanceof DOMException && error.name === 'AbortError')
    try { await waiting; cancel.abort(); assert.equal(generated, 0); release(); await rejected; assert.equal(generated, 1); assert.equal(saved, 0) }
    finally { release(); await Promise.allSettled([pending]); await local.close() }
  })
} finally { await app.close() }
if (failures.length) throw new AggregateError(failures, `${failures.length} capacity cases failed; ${passed} passed`)
console.log(`HISTORY CAPACITY TEST OK: ${passed} synthetic encoder/route/client cases; no database, listener or browser downloads`)
