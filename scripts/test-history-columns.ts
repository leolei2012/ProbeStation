import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import ExcelJS from 'exceljs'
import Fastify from 'fastify'
import { ConfigStore } from '../packages/config/src/index.ts'
import { Sink } from '../packages/sink/src/index.ts'
import { historyColumnNames } from '../packages/sink/src/history-columns.ts'
import { registerHistoryExport } from '../packages/api/src/history-export.ts'

// Memory metadata and mocked stored rows; no history database, service bootstrap or devices.
const cfg = new ConfigStore({ dbPath: ':memory:' })
try {
  const device = cfg.createObject('mock history headers', 'mock.invalid', 502)
  for (const source of [1, 2]) {
    const group = cfg.createGroup(device.id, 'source ' + source, 3, 0, 16, 'read', source)
    cfg.createRegister(group.id, device.id, '温度', 3, 0, 'uint16')
  }
  const start = '2026-11-06T00:00:00.123Z', end = '2026-11-06T00:00:01.123Z'
  let rows: any[] = [1, 2].map(slaveId => ({ objectId: device.id, ts: start, timestampMs: Date.parse(start), area: 'holding-register', address: 0, rawValue: slaveId * 10, quality: 'good', batchId: 'batch-' + slaveId, slaveId }))
  let calls = 0, fail = false
  const sink = new Sink({ config: cfg, store: { queryObjectForExport: async () => { calls++; if (fail) throw new Error('mock history failure'); return rows } } })
  const lines = (await sink.exportCsv(device.id, start, end)).split('\n').map(line => line.split(','))
  assert.equal(new Set(lines[0]).size, lines[0].length, 'duplicate aliases must not produce duplicate history headers that overwrite values in name-based readers')
  const definitions = cfg.listRegistersByObject(device.id), [a, b] = definitions
  assert.deepEqual([lines[0][1], lines[0][4]], [`温度 [slave=1 id=${a.id}]`, `温度 [slave=2 id=${b.id}]`])
  const keyed = Object.fromEntries(lines[0].map((key, i) => [key, lines[1][i]]))
  assert.equal(keyed[lines[0][1]], '10'); assert.equal(keyed[lines[0][4]], '20')
  assert.deepEqual(lines[1].slice(2, 4), ['批次/来源已验证', 'true'])
  assert.deepEqual(lines[1].slice(5, 7), ['批次/来源已验证', 'true'])
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await sink.exportXlsx(device.id, start, end) as any)
  const sheet = wb.getWorksheet('data')!, notes = wb.getWorksheet('历史身份说明')!
  assert.deepEqual([sheet.getCell('B1').value, sheet.getCell('E1').value], [lines[0][1], lines[0][4]])
  assert.deepEqual([sheet.getCell('B2').value, sheet.getCell('E2').value], ['10', '20'])
  assert.deepEqual([notes.getCell('B6').value, notes.getCell('D6').value, notes.getCell('F6').value], [a.id, 1, 0])
  assert.deepEqual([notes.getCell('B7').value, notes.getCell('D7').value], [b.id, 2])
  assert.equal(notes.getCell('A6').value, lines[0][1]); assert.equal(JSON.parse(String(notes.getCell('H6').value)), '温度')
  const group = cfg.listGroups(device.id)[0]
  for (const [i, alias] of ['温度__batch_status', 'timestamp(UTC)', 'speed', '', 'quoted,"label\rnext', 'literal\\u0000', 'literal\u0000'].entries()) cfg.createRegister(group.id, device.id, alias, 3, i + 1, 'uint16')
  const csvRows = async (text: string) => {
    const csvBook = new ExcelJS.Workbook(), ws = await csvBook.csv.read(Readable.from([text]), { map: value => value })
    return Array.from({ length: ws.rowCount }, (_, i) => Array.from({ length: ws.columnCount }, (_, j) => String(ws.getCell(i + 1, j + 1).value ?? '')))
  }
  const complete = await csvRows(await sink.exportCsv(device.id, start, end))
  assert.equal(complete.length, 2, 'an independent CSV reader handles quoted newlines and commas in labels')
  assert.equal(new Set(complete[0].map(s => s.toLowerCase())).size, complete[0].length)
  assert.equal(complete[0].length, cfg.listRegistersByObject(device.id).length * 3 + 1)
  assert.ok(complete[0].includes('speed')); assert.ok(complete[0].some(s => s.startsWith('reg')))
  assert.ok(complete[0].some(s => s === 'quoted,"label\nnext'))
  const current = new ExcelJS.Workbook(); await current.xlsx.load(await sink.exportXlsx(device.id, start, end) as any)
  const currentSheet = current.getWorksheet('data')!, currentNotes = current.getWorksheet('历史身份说明')!
  const xlsxHeaders = Array.from({ length: currentSheet.columnCount - 1 }, (_, i) => String(currentSheet.getCell(1, i + 2).value))
  assert.deepEqual(xlsxHeaders, complete[0].slice(1), 'both formats use exactly the same point labels')
  const allPoints = cfg.listRegistersByObject(device.id)
  for (const [i, point] of allPoints.entries()) {
    assert.equal(currentNotes.getCell(i + 6, 2).value, point.id)
    assert.equal(JSON.parse(String(currentNotes.getCell(i + 6, 8).value)), point.alias, 'JSON alias metadata preserves CR, quotes, blank names and controls')
  }
  const selected = await csvRows(await sink.exportCsv(device.id, start, end, [a.id]))
  assert.equal(selected[0][1], '温度', 'unique aliases within the selection retain their original header')
  const selectedBook = new ExcelJS.Workbook(); await selectedBook.xlsx.load(await sink.exportXlsx(device.id, start, end, [b.id]) as any)
  assert.equal(selectedBook.getWorksheet('历史身份说明')!.rowCount, 6)
  assert.equal(selectedBook.getWorksheet('历史身份说明')!.getCell('B6').value, b.id)
  const beforeEmpty = calls
  assert.equal((await csvRows(await sink.exportCsv(device.id, start, end, [99999])))[0].length, 1)
  assert.equal(calls, beforeEmpty, 'an empty selection does not query history')
  // Header qualification never turns source-unknown samples into verified data.
  rows = [{ ...rows[0], slaveId: null }]
  const unknown = await csvRows(await sink.exportCsv(device.id, start, end, [a.id, b.id]))
  assert.deepEqual(unknown[1].slice(1), ['', '未知', 'false', '', '未知', 'false'])
  rows = []
  assert.equal((await csvRows(await sink.exportCsv(device.id, start, end))).length, 1)
  const app = Fastify(); registerHistoryExport(app, sink)
  try {
    fail = true
    const failed = await app.inject(`/api/export/csv?object_id=${device.id}&start=${start}&end=${end}`)
    assert.equal(failed.statusCode, 500); assert.equal(failed.headers['content-disposition'], undefined)
    fail = false
    const recovered = await app.inject(`/api/export/csv?object_id=${device.id}&start=${start}&end=${end}`)
    assert.equal(recovered.statusCode, 200); assert.ok(recovered.headers['content-disposition'])
    assert.equal(new Set((await csvRows(recovered.body))[0].map(s => s.toLowerCase())).size, complete[0].length)
  } finally { await app.close() }
} finally { (cfg as any).db.close() }
const points = Object.freeze([{ id: 1, alias: 'A', slaveId: 1 }, { id: 2, alias: 'a', slaveId: 2 }, { id: 3, alias: 'A [slave=1 id=1]', slaveId: 1 }].map(Object.freeze))
const frozen = JSON.stringify(points), labels = historyColumnNames(points, ['timestamp(UTC)', 'timestamp (UTC)'])
assert.equal(JSON.stringify(points), frozen)
assert.equal(labels[0], 'A [slave=1 id=1] (2)'); assert.equal(labels[2], 'A [slave=1 id=1]')
assert.equal(new Set(labels.map(s => s.toLowerCase())).size, labels.length)
assert.ok(historyColumnNames([{ id: 4, alias: 'same' }, { id: 5, alias: 'same' }], []).every(s => s.includes('slave=unknown')))
assert.deepEqual(historyColumnNames([], ['timestamp']), [])
assert.deepEqual(historyColumnNames([{ id: 1, alias: 'ordinary' }], ['timestamp']), ['ordinary'])
console.log('HISTORY COLUMNS OK: source/point-qualified collision-free triplets, timestamp/status collisions, CSV reader/XLSX metadata, selection/empty/unknown quality, failure recovery and immutable labels; memory/mock only')
