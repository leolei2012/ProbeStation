import assert from 'node:assert/strict'
import { DuckDBStore } from '../packages/store/src/index.ts'
import { Sink } from '../packages/sink/src/index.ts'
import { historyExportReadRanges, HistoryExportLimitError } from '../packages/core/src/history-export-policy.ts'
import { encodeRegister } from '../packages/core/src/codec.ts'
import type { ModbusArea } from '../packages/core/src/protocol.ts'
import Fastify from 'fastify'
import ExcelJS from 'exceljs'
import { registerHistoryExport } from '../packages/api/src/history-export.ts'

assert.deepEqual(historyExportReadRanges([
  { functionCode: 3, startAddress: 1, dataType: 'uint16' },
  { functionCode: 3, startAddress: 0, dataType: 'uint32' },
  { functionCode: 3, startAddress: 2, dataType: 'float64-LE' },
  { functionCode: 4, startAddress: 0, dataType: 'uint32-LE' },
]), [{ area: 'holding-register', startAddress: 0, endAddress: 5 }, { area: 'input-register', startAddress: 0, endAddress: 1 }])
assert.deepEqual(historyExportReadRanges([]), [])
assert.throws(() => historyExportReadRanges([{ functionCode: 3, startAddress: NaN, dataType: 'uint16' }]))

const store = new DuckDBStore({ dbPath: ':memory:', flushIntervalMs: 0, flushBatchSize: 1000, retentionSeconds: 0, retentionCheckMs: 0 })
const start = '2026-11-06T00:00:00Z', base = Date.parse(start), end = new Date(base + 300000).toISOString()
const registers = [
  { id: 1, startAddress: 0, functionCode: 3, dataType: 'uint32', alias: 'selected' },
  { id: 9, startAddress: 99, functionCode: 3, dataType: 'uint16', alias: 'unselected' },
]
try {
  const conn = await (store as any).ready
  await conn.run(`INSERT INTO poll_data (object_id, area, address, ts, raw_value, quality, batch_id)
    SELECT 1, 'holding-register', 99, TIMESTAMP '2026-11-06 00:00:00' + i * INTERVAL '1 millisecond', 7, 'good', 'unselected-' || i
    FROM range(200001) r(i)`)
  store.write([0, 1].map(address => ({ objectId: 1, area: 'holding-register' as const, address, timestamp: new Date(base + 250000).toISOString(), rawValue: address === 0 ? 1 : 2, quality: 'good', batchId: 'selected-response' })))
  await store.flush()
  const sink = new Sink({ config: { listRegistersByObject: () => registers }, store })
  const csv = await sink.exportCsv(1, start, end, [1])
  assert.equal(csv.split('\n').length, 2, 'unselected points must not consume export quota or create empty timestamps')
  assert.match(csv, /65538,批次已验证,true/)
  const overlap = await store.queryObjectForExport(1, start, end, [
    { area: 'holding-register', startAddress: 0, endAddress: 1 },
    { area: 'holding-register', startAddress: 1, endAddress: 1 },
  ])
  assert.equal(overlap.length, 2, 'overlapping ranges must not duplicate raw words')
  assert.ok(overlap.every(p => p.batchId === 'selected-response' && p.timestampMs === base + 250000))
  const manyRanges = Array.from({ length: 1001 }, (_, i) => ({ area: 'holding-register' as const, startAddress: i * 2, endAddress: i * 2 }))
  assert.equal((await store.queryObjectForExport(1, start, end, manyRanges)).length, 1, 'many disjoint ranges avoid a deeply nested OR expression')
  assert.deepEqual(await store.queryObjectForExport(1, start, end, []), [], 'empty scopes never mean all data')
  assert.deepEqual(await store.queryObjectForExport(1, start, end, [{ area: "holding-register' OR TRUE --" as any, startAddress: 0, endAddress: 65535 }]), [], 'area values are parameters, never SQL fragments')

  registers.push(
    { id: 2, startAddress: 1, functionCode: 3, dataType: 'uint16', alias: 'overlap' },
    { id: 3, startAddress: 4, functionCode: 3, dataType: 'float64-LE', alias: 'wide64' },
    { id: 4, startAddress: 0, functionCode: 4, dataType: 'uint32-LE', alias: 'input32' },
    { id: 5, startAddress: 0, functionCode: 1, dataType: 'uint16', alias: 'coil' },
    { id: 6, startAddress: 0, functionCode: 2, dataType: 'uint16', alias: 'discrete' },
  )
  const write = (area: ModbusArea, address: number, words: number[], offset: number, batchId: string) => store.write(words.map((rawValue, i) => ({ objectId: 1, area, address: address + i, timestamp: new Date(base + offset).toISOString(), rawValue, quality: 'good', batchId })))
  write('holding-register', 4, encodeRegister('float64-LE', 42.25), 250000, '64bit-response')
  write('input-register', 0, encodeRegister('uint32-LE', 123456), 250000, 'input-response')
  write('coil', 0, [1], 250000, 'coil-response')
  write('discrete-input', 0, [0], 250000, 'discrete-response')
  write('holding-register', 0, [3], 250020, 'partial-response')
  write('holding-register', 0, [4], 250021, 'mixed-high')
  write('holding-register', 1, [5], 250021, 'mixed-low')
  store.write([0, 1].map(address => ({ objectId: 1, area: 'holding-register' as const, address, timestamp: new Date(base + 250022).toISOString(), rawValue: address, quality: address === 0 ? 'bad' : 'good', batchId: 'bad-response' })))
  await store.flush()
  const scoped = (await sink.exportCsv(1, start, end, [1, 2, 3, 4, 5, 6])).split('\n').map(line => line.split(','))
  const value = (name: string) => scoped[1][scoped[0].indexOf(name)]
  assert.equal(value('selected'), '65538')
  assert.equal(value('overlap'), '2')
  assert.equal(value('wide64'), '42.25')
  assert.equal(value('input32'), '123456')
  assert.equal(value('coil'), '1')
  assert.equal(value('discrete'), '0')
  assert.ok(!scoped[0].includes('unselected'))
  const checked = (await sink.exportCsv(1, start, end, [1])).split('\n').map(line => line.split(','))
  assert.equal(checked.length, 5)
  assert.deepEqual(checked.slice(2).map(row => row.slice(1)), Array.from({ length: 3 }, () => ['', '未知', 'false']), 'missing/mixed/bad words remain unknown, never backfilled from unselected data')
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(await sink.exportXlsx(1, start, end, [3, 4]) as any)
  assert.equal(workbook.getWorksheet('data')!.rowCount, 2)
  assert.equal(workbook.getWorksheet('data')!.getCell('B2').value, '42.25')
  assert.ok(workbook.getWorksheet('历史身份说明'))
  await assert.rejects(sink.exportCsv(1, start, end, [9]), HistoryExportLimitError, 'selected raw rows remain capped')
  await assert.rejects(sink.exportCsv(1, start, end), HistoryExportLimitError, 'all-points export still enforces the cap')
  assert.equal((await sink.exportCsv(1, start, end, [999])).split('\n').length, 1, 'a nonmatching selection produces no unrelated timestamps')
  const emptySink = new Sink({ config: { listRegistersByObject: () => [] }, store: { queryObjectForExport: () => { throw new Error('no points must not read the database') } } })
  assert.equal((await emptySink.exportCsv(1, start, end)).split('\n').length, 1)
  const app = Fastify()
  registerHistoryExport(app, sink)
  try {
    const q = `?object_id=1&start=${start}&end=${end}`
    assert.equal((await app.inject('/api/export/csv' + q + '&register_ids=1')).statusCode, 200)
    assert.equal((await app.inject('/api/export/xlsx' + q + '&register_ids=3,4')).statusCode, 200)
    assert.equal((await app.inject('/api/export/csv' + q + '&register_ids=9')).statusCode, 413)
  } finally { await app.close() }
} finally {
  await (store as any).mutations
  const conn = await (store as any).ready; conn.closeSync(); (store as any).instance.closeSync()
}
console.log('EXPORT SELECTION OK: quota after filtering, area/32/64-bit LE coverage, overlap deduplication, 1001 ranges, parameter binding, invalid batches, empty selection and CSV/XLSX/API')
