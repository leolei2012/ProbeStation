import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import ExcelJS from 'exceljs'
import Fastify from 'fastify'
import { Sink } from '../packages/sink/src/index.ts'
import { DATA_TYPES, encodeRegister, registerWidth } from '../packages/core/src/codec.ts'
import { HistoryExportColumnLimitError, HistoryExportLimitError, HISTORY_EXPORT_RAW_LIMIT } from '../packages/core/src/history-export-policy.ts'
import { registerHistoryExport } from '../packages/api/src/history-export.ts'
import { candidateHistoryXlsx, type CandidateOptions } from './fixtures/history-streaming-candidate.ts'
import { captureHistoryExport, downloadHistoryExport } from '../apps/web/src/history-export.ts'

assert.deepEqual(process.argv.slice(2), ['--synthetic'], 'This is an opt-in synthetic candidate check, never an application entry')
const JSZip = createRequire(import.meta.url)('jszip')
const start = '2026-12-31T23:59:59.123Z', end = '2027-01-01T00:01:00Z', base = Date.parse(start)
const definitions: any[] = DATA_TYPES.map((dataType, i) => ({ id: i + 1, groupId: 1, functionCode: 3, startAddress: i * 4, dataType, alias: ['温度', 'timestamp(UTC)', 'quoted,"label\r\nnext\u0000', ''][i] ?? dataType }))
definitions.push({ id: 100, groupId: 2, functionCode: 3, startAddress: 0, dataType: 'uint16', alias: '温度' }, { id: 101, groupId: 3, functionCode: 4, startAddress: 0, dataType: 'uint32', alias: '温度__batch_status' })
let registers = definitions, rows: any[] = [], reads = 0
const groups = [{ id: 1, slaveId: 1, functionCode: 3, startAddress: 0, quantity: 512 }, { id: 2, slaveId: 2, functionCode: 3, startAddress: 0, quantity: 1 }, { id: 3, slaveId: 1, functionCode: 4, startAddress: 0, quantity: 2 }]
for (let frame = 0; frame < 7; frame++) for (const r of definitions) {
  const type = r.dataType, value = type.includes('64') && !type.includes('float') ? type.startsWith('int') ? -9007199254740993n : 9007199254740993n : type.startsWith('q') ? -0.25 : type.includes('float') ? -123.5 : 7
  const words = encodeRegister(type, value), timestampMs = base + frame * 1000
  words.forEach((rawValue, i) => {
    if (frame === 3 && words.length > 1 && i === words.length - 1) return
    const row = { timestampMs, ts: new Date(timestampMs).toISOString(), address: r.startAddress + i, area: r.functionCode === 4 ? 'input-register' : 'holding-register', slaveId: frame === 6 ? null : r.groupId === 2 ? 2 : 1, rawValue, quality: frame === 4 ? 'bad' : 'good', batchId: frame === 1 ? null : frame === 2 ? 'mixed-' + i : 'response-' + frame }
    rows.push(row); if (frame === 5 && i === 0) rows.push({ ...row })
  })
}
const originalRows = rows, sink = new Sink({ config: { getObject: () => ({ id: 1, mode: 'master' }), listGroups: () => groups, listRegistersByObject: () => registers }, store: { async queryObjectForExport() { reads++; return rows } } })
async function load(buffer: Buffer) {
  const zip = await JSZip.loadAsync(buffer, { checkCRC32: true })
  assert(zip.file('[Content_Types].xml') && zip.file('xl/workbook.xml') && zip.file('xl/worksheets/sheet1.xml') && zip.file('xl/worksheets/sheet2.xml'))
  const book = new ExcelJS.Workbook(); await book.xlsx.load(buffer as any); return book
}
function snapshot(book: ExcelJS.Workbook) { return book.worksheets.map(sheet => ({ name: sheet.name, rows: sheet.rowCount, columns: sheet.columnCount, widths: sheet.columns.map(c => c.width), views: (sheet.views ?? []).map(v => ({ state: v.state, xSplit: (v as any).xSplit ?? 0, ySplit: (v as any).ySplit ?? 0, topLeftCell: (v as any).topLeftCell ?? null })), values: Array.from({ length: sheet.rowCount }, (_, i) => Array.from({ length: sheet.columnCount }, (_, j) => { const c = sheet.getCell(i + 1, j + 1); return { value: c.value, type: c.type, bold: !!c.font?.bold } })) })) }
const failures: unknown[] = []; let passed = 0
async function check(name: string, action: () => Promise<void>) {
  try { await action(); passed++; console.log('STREAMING CANDIDATE OK:', name) }
  catch (error) { failures.push(error); console.error('STREAMING CANDIDATE FAILED:', name, error) }
  finally { registers = definitions; rows = originalRows }
}
await check('CRC-complete files preserve all dtype values/types, identity states, collisions, widths, notes, bold and frozen panes', async () => {
  for (const offset of [0, 480, -210, NaN, Infinity]) {
    const document = await load(await sink.exportXlsx(1, start, end, undefined, offset)), streaming = await load(await candidateHistoryXlsx(sink, [1, start, end, undefined, offset]))
    assert.deepEqual(snapshot(streaming), snapshot(document))
    const sheet = streaming.getWorksheet('data')!, values = sheet.getSheetValues().flatMap(value => Array.isArray(value) ? value : [])
    for (const state of ['批次/来源已验证', '批次/来源未验证', '未知']) assert(values.includes(state))
    assert(values.includes(true) && values.includes(false) && values.includes('-9007199254740993'))
    assert.equal(streaming.getWorksheet('历史身份说明')!.getCell('H8').value, JSON.stringify(definitions[2].alias))
  }
})
await check('empty/unknown/duplicate selection and invalid legacy time preserve readable files', async () => {
  for (const selection of [[1, 100, 1], [999999], []]) {
    rows = selection[0] === 1 ? originalRows : []
    assert.deepEqual(snapshot(await load(await candidateHistoryXlsx(sink, [1, start, end, selection]))), snapshot(await load(await sink.exportXlsx(1, start, end, selection))))
  }
  rows = [{ ...originalRows[0], ts: 'legacy-invalid-time', timestampMs: undefined }]
  assert.deepEqual(snapshot(await load(await candidateHistoryXlsx(sink, [1, start, end, [1]]))), snapshot(await load(await sink.exportXlsx(1, start, end, [1]))))
})
await check('existing row/column guards reject without partial output and maximum XFD header remains valid', async () => {
  registers = Array.from({ length: 5462 }, (_, i) => ({ id: i + 1, groupId: 1, functionCode: 3, startAddress: i, dataType: 'uint16', alias: 'p' + i })); rows = []
  const before = reads; await assert.rejects(candidateHistoryXlsx(sink, [1, start, end]), HistoryExportColumnLimitError); assert.equal(reads, before)
  registers = registers.slice(0, 5461)
  const book = await load(await candidateHistoryXlsx(sink, [1, start, end])); assert.equal(book.getWorksheet('data')!.getCell('XFD1').value, 'p5460__automatic_eligible')
  registers = definitions.slice(0, 1); rows = Array(HISTORY_EXPORT_RAW_LIMIT + 1).fill(originalRows[0])
  await assert.rejects(candidateHistoryXlsx(sink, [1, start, end]), HistoryExportLimitError)
})
await check('row and output-stream errors preserve originals, destroy unfinished output and return no bytes', async () => {
  for (const at of ['row', 'output', 'late-output']) {
    const reason = new Error('synthetic-' + at), cleanup: any[] = [], options: CandidateOptions = { onCleanup: state => cleanup.push(state) }
    if (at === 'row') options.onRow = () => { throw reason }; else options.outputError = reason
    if (at === 'late-output') options.failAfterOutputBytes = 1000
    await assert.rejects(candidateHistoryXlsx(sink, [1, start, end], options), error => error === reason)
    assert.equal(cleanup.length, 1); assert.equal(cleanup[0].returnedBytes, 0); assert.equal(cleanup[0].destroyed, true)
    if (at === 'late-output') assert(cleanup[0].bufferedBytes >= 1000)
  }
})
await check('candidate signal before read/after delayed collect and during yielded rows rejects without returning a partial file', async () => {
  const pre = new AbortController(); pre.abort(); const before = reads
  await assert.rejects(candidateHistoryXlsx(sink, [1, start, end], { signal: pre.signal }), error => (error as any).name === 'AbortError'); assert.equal(reads, before)
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), waiting = new Promise<void>(resolve => { entered = resolve }), delayed = new Sink({ config: { listRegistersByObject: () => definitions.slice(0, 1) }, store: { async queryObjectForExport() { entered(); await gate; return originalRows.slice(0, 1) } } }), cancel = new AbortController()
  const late = candidateHistoryXlsx(delayed, [1, start, end], { signal: cancel.signal }); const rejected = assert.rejects(late, error => (error as any).name === 'AbortError')
  await waiting; cancel.abort(); release(); await rejected
  registers = definitions.slice(0, 1); rows = Array.from({ length: 1000 }, (_, i) => ({ ...originalRows[0], timestampMs: base + i, ts: new Date(base + i).toISOString() }))
  const during = new AbortController(), cleanup: any[] = []; let seen = 0
  await assert.rejects(candidateHistoryXlsx(sink, [1, start, end], { signal: during.signal, onRow(count) { seen = count; if (count === 1) setImmediate(() => during.abort()) }, onCleanup: value => cleanup.push(value) }), error => (error as any).name === 'AbortError')
  assert(seen >= 1 && seen < 1000); assert.equal(cleanup[0].destroyed, true); assert.equal(cleanup[0].returnedBytes, 0)
  rows = originalRows
  const zipped = new AbortController(), zipCleanup: any[] = []; let commitEntered = false
  await assert.rejects(candidateHistoryXlsx(sink, [1, start, end], { signal: zipped.signal, beforeCommit: async () => { commitEntered = true }, onOutputChunk: bytes => { if (commitEntered && bytes >= 1000) zipped.abort() }, onCleanup: value => zipCleanup.push(value) }), error => (error as any).name === 'AbortError')
  assert(commitEntered); assert.equal(zipCleanup[0].returnedBytes, 0); assert(zipCleanup[0].bufferedBytes >= 1000); assert.equal(zipCleanup[0].destroyed, true)
})
await check('shared route retains no-attachment-on-failure and complete attachment on explicit retry', async () => {
  let fail = true
  const app = Fastify(); registerHistoryExport(app, { exportCsv: (...args) => sink.exportCsv(...args), exportXlsx: (...args) => candidateHistoryXlsx(sink, args, fail ? { outputError: new Error('synthetic output failure') } : {}) })
  try {
    const url = '/api/export/xlsx?object_id=1&start=' + start + '&end=' + end, rejected = await app.inject(url)
    assert.equal(rejected.statusCode, 500); assert.equal(rejected.headers['content-disposition'], undefined)
    fail = false; const recovered = await app.inject(url); assert.equal(recovered.statusCode, 200); assert.match(String(recovered.headers['content-disposition']), /attachment/); await load(recovered.rawPayload)
  } finally { await app.close() }
})
await check('no Buffer escapes before commit, successful ZIP passes CRC and truncated ZIP is rejected', async () => {
  let release!: () => void, entered!: () => void, returned = false
  const gate = new Promise<void>(resolve => { release = resolve }), waiting = new Promise<void>(resolve => { entered = resolve }), cleanup: any[] = []
  const pending = candidateHistoryXlsx(sink, [1, start, end], { beforeCommit: async () => { entered(); await gate }, onCleanup: state => cleanup.push(state) }).then(buffer => { returned = true; return buffer })
  try {
    await waiting; assert.equal(returned, false); release()
    const complete = await pending; await load(complete)
    assert.equal(cleanup[0].finished, true); assert.equal(cleanup[0].returnedBytes, complete.length)
    await assert.rejects(load(complete.subarray(0, complete.length - 22)))
  } finally { release(); await Promise.allSettled([pending]) }
})
await check('candidate without signal plumbing still finishes a route after client cancel; client saves nothing', async () => {
  let release!: () => void, entered!: () => void, generated = 0, saved = 0
  const gate = new Promise<void>(resolve => { release = resolve }), waiting = new Promise<void>(resolve => { entered = resolve })
  const source = new Sink({ config: { listRegistersByObject: () => definitions.slice(0, 1) }, store: { async queryObjectForExport() { entered(); await gate; return originalRows.slice(0, 1) } } }), app = Fastify()
  registerHistoryExport(app, { exportCsv: (...args) => source.exportCsv(...args), exportXlsx: (...args) => candidateHistoryXlsx(source, args) })
  app.addHook('onSend', async (_request, _reply, payload) => { generated++; return payload })
  const context = { definitions: 'synthetic', device: 'synthetic' }, request = captureHistoryExport(1, { start: base, end: base + 1000 }, [1], 0, 'full', context), cancel = new AbortController()
  const fetcher: typeof fetch = async url => { const response = await app.inject(String(url)); return new Response(response.rawPayload as any, { status: response.statusCode, headers: response.headers as any }) }
  const pending = downloadHistoryExport('xlsx', request, cancel.signal, () => context, fetcher, () => { saved++ }), rejected = assert.rejects(pending, error => (error as any).name === 'AbortError')
  try { await waiting; cancel.abort(); release(); await rejected; assert.equal(generated, 1); assert.equal(saved, 0) }
  finally { release(); await Promise.allSettled([pending]); await app.close() }
})
if (failures.length) throw new AggregateError(failures, `${failures.length} candidate cases failed; ${passed} passed`)
console.log(`STREAMING CANDIDATE TEST OK: ${passed} groups, memory-only ZIP CRC/ExcelJS readback and injected routes; production path untouched`)
