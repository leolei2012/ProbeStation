import assert from 'node:assert/strict'
import { HISTORY_EXPORT_RAW_LIMIT, HistoryExportLimitError } from '../packages/core/src/history-export-policy.ts'
import { Sink } from '../packages/sink/src/index.ts'
import Fastify from 'fastify'
import ExcelJS from 'exceljs'
import { DuckDBStore } from '../packages/store/src/index.ts'
import { registerHistoryExport } from '../packages/api/src/history-export.ts'
import { captureHistoryExport, fetchHistoryExport } from '../apps/web/src/history-export.ts'

const point = { ts: '2026-11-06 00:00:00', timestampMs: Date.parse('2026-11-06T00:00:00Z'), objectId: 1, area: 'holding-register', address: 0, rawValue: 7, quality: 'good', batchId: 'A' }
const rows = Array.from({ length: HISTORY_EXPORT_RAW_LIMIT + 1 }, () => point)
const limitRegister = { id: 1, startAddress: 0, functionCode: 3, dataType: 'uint16', alias: 'limit-test' }
let rawCount = rows.length, ordinaryQueries = 0
const sink = new Sink({ config: { listRegistersByObject: () => [limitRegister] }, store: {
  queryObject: async () => { ordinaryQueries++; return rows.slice(0, HISTORY_EXPORT_RAW_LIMIT) },
  queryObjectForExport: async () => rows.slice(0, rawCount),
} })
await assert.rejects(sink.exportCsv(1, '2026-11-06T00:00:00Z', '2026-11-06T00:01:00Z'), HistoryExportLimitError, 'oversized exports must not silently produce a partial file')
await assert.rejects(sink.exportXlsx(1, '2026-11-06T00:00:00Z', '2026-11-06T00:01:00Z'), HistoryExportLimitError)
assert.equal(HISTORY_EXPORT_RAW_LIMIT, 200000)
const app = Fastify()
registerHistoryExport(app, sink)
const query = '?object_id=1&start=2026-11-06T00:00:00Z&end=2026-11-06T00:01:00Z'
try {
  for (rawCount of [HISTORY_EXPORT_RAW_LIMIT - 1, HISTORY_EXPORT_RAW_LIMIT]) {
    for (const format of ['csv', 'xlsx']) {
      const response = await app.inject('/api/export/' + format + query)
      assert.equal(response.statusCode, 200, `${rawCount} raw rows is not truncation`)
      assert.match(String(response.headers['content-disposition']), /attachment/)
      if (format === 'csv') assert.match(response.body, /^timestamp/)
      else { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(response.rawPayload as any); assert.ok(wb.getWorksheet('data')) }
    }
  }
  rawCount = HISTORY_EXPORT_RAW_LIMIT + 1
  for (const format of ['csv', 'xlsx']) {
    const response = await app.inject('/api/export/' + format + query)
    assert.equal(response.statusCode, 413)
    assert.equal(response.json().code, 'HISTORY_EXPORT_LIMIT')
    assert.equal(response.json().limit, HISTORY_EXPORT_RAW_LIMIT)
    assert.match(response.json().error, /截断.*停止生成文件/)
    assert.equal(response.headers['content-disposition'], undefined, 'an error must not be disguised as a downloadable file')
    assert.equal(response.headers['cache-control'], 'no-store')
  }
  rawCount = 0
  assert.equal((await app.inject('/api/export/csv' + query)).body.split('\n').length, 1, 'empty export remains a header-only file')
  rawCount = 1
  assert.equal((await app.inject('/api/export/csv' + query)).statusCode, 200, 'narrowing the range can recover')
  assert.equal(ordinaryQueries, 0, 'export always uses explicit lookahead, never an ambiguous capped query')
} finally { await app.close() }

// The real DuckDB boundary, without touching a user database or any instrument.
const store = new DuckDBStore({ dbPath: ':memory:', flushIntervalMs: 0, flushBatchSize: 1000, retentionSeconds: 0, retentionCheckMs: 0 })
try {
  const conn = await (store as any).ready
  await conn.run(`INSERT INTO poll_data (object_id, area, address, ts, raw_value, quality, batch_id)
    SELECT 1, 'holding-register', 0, TIMESTAMP '2026-11-06 00:00:00' + i * INTERVAL '1 millisecond', 7, 'good', 'probe-' || i
    FROM range(200001) r(i)`)
  const start = '2026-11-06T00:00:00Z', base = Date.parse(start)
  for (const count of [HISTORY_EXPORT_RAW_LIMIT - 1, HISTORY_EXPORT_RAW_LIMIT, HISTORY_EXPORT_RAW_LIMIT + 1]) {
    const result = await store.queryObjectForExport(1, start, new Date(base + count - 1).toISOString())
    assert.equal(result.length, count)
    assert.equal(result.at(-1)!.timestampMs, base + count - 1)
    assert.equal(result.at(-1)!.batchId, 'probe-' + (count - 1))
    assert.equal(result.at(-1)!.area, 'holding-register')
  }
  assert.equal((await store.queryObject(1, start, new Date(base + HISTORY_EXPORT_RAW_LIMIT).toISOString(), HISTORY_EXPORT_RAW_LIMIT + 1)).length, HISTORY_EXPORT_RAW_LIMIT, 'ordinary API raw-query cap remains unchanged')
  const realSink = new Sink({ config: { listRegistersByObject: () => [limitRegister] }, store })
  await assert.rejects(realSink.exportCsv(1, start, new Date(base + HISTORY_EXPORT_RAW_LIMIT).toISOString()), HistoryExportLimitError)
} finally {
  await (store as any).mutations
  const conn = await (store as any).ready; conn.closeSync(); (store as any).instance.closeSync()
}

const request = captureHistoryExport(1, { start: point.timestampMs, end: point.timestampMs + 1000 }, [1], 0, 'full')
const signal = new AbortController().signal
const fetchResponse = (response: Response) => (async () => response) as typeof fetch
for (const format of ['csv', 'xlsx'] as const) {
  await assert.rejects(fetchHistoryExport(format, request, signal, fetchResponse(new Response(JSON.stringify({ code: 'HISTORY_EXPORT_LIMIT', limit: 200000 }), { status: 413 }))), HistoryExportLimitError)
}
await assert.rejects(fetchHistoryExport('csv', request, signal, fetchResponse(new Response('failure', { status: 503 }))), /HTTP 503/)
await assert.rejects(fetchHistoryExport('csv', request, signal, fetchResponse(new Response('null', { status: 500 }))), /HTTP 500/)
await assert.rejects(fetchHistoryExport('csv', request, signal, fetchResponse(new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }))), /Unexpected export/)
const csvBlob = await fetchHistoryExport('csv', request, signal, fetchResponse(new Response('timestamp\n', { headers: { 'content-type': 'text/csv' } })))
assert.equal(await csvBlob.text(), 'timestamp\n')
let finishLate!: (response: Response) => void
const cancel = new AbortController()
const pending = fetchHistoryExport('csv', request, cancel.signal, (() => new Promise<Response>(resolve => { finishLate = resolve })) as typeof fetch)
cancel.abort()
finishLate(new Response('timestamp\n', { headers: { 'content-type': 'text/csv' } }))
await assert.rejects(pending, error => error instanceof DOMException && error.name === 'AbortError', 'cancelled late files cannot reach the save step')
console.log('EXPORT LIMIT OK: real DuckDB 199999/200000/200001 boundaries, CSV/XLSX, 413 without attachment, empty/retry, frontend errors and cancellation')
