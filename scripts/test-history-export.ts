import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ExcelJS from 'exceljs'
import { captureHistoryExport, historyExportRangeLabel, historyExportUrl } from '../apps/web/src/history-export.ts'
import { HistoryExportModal } from '../apps/web/src/HistoryExportModal.tsx'
import { createOfflineTestApp } from './offline-test-app.ts'
import { Sink } from '../packages/sink/src/index.ts'

const t = Date.parse('2026-11-06T00:00:00.123Z'), selection = [3, 1, 3]
const snapshot = captureHistoryExport(2, { start: t + .5, end: t + 1000.75 }, selection, 480, 'viewport')
selection.push(9)
assert.deepEqual(snapshot.registerIds, [1, 3], 'dialog selection is captured independently of later UI changes')
assert.equal(snapshot.start, '2026-11-06T00:00:00.123Z')
assert.equal(snapshot.end, '2026-11-06T00:00:01.123Z')
assert.equal(historyExportRangeLabel(snapshot), '2026-11-06 08:00:00.123 — 2026-11-06 08:00:01.123 (UTC+08:00)')
assert.match(historyExportRangeLabel(captureHistoryExport(2, { start: t, end: t + 1000 }, [1], -210, 'full')), /2026-11-05 20:30:00\.123.*UTC-03:30/)
for (const ids of [[], [0], [-1], [1.5], [NaN]]) assert.throws(() => captureHistoryExport(2, { start: t, end: t + 1000 }, ids, 0, 'full'))
for (const range of [{ start: t, end: t }, { start: t + 1, end: t }, { start: NaN, end: t }, { start: t, end: Infinity }]) assert.throws(() => captureHistoryExport(2, range, [1], 0, 'full'))
for (const objectId of [0, -1, 1.5, NaN]) assert.throws(() => captureHistoryExport(objectId, { start: t, end: t + 1000 }, [1], 0, 'full'))
assert.throws(() => historyExportUrl('html' as any, snapshot))
for (const format of ['csv', 'xlsx'] as const) {
  const url = new URL(historyExportUrl(format, snapshot), 'http://test.invalid')
  assert.equal(url.pathname, '/api/export/' + format)
  assert.equal(url.searchParams.get('register_ids'), '1,3')
  assert.equal(url.searchParams.get('start'), snapshot.start)
  assert.equal(url.searchParams.get('end'), snapshot.end)
  assert.equal(url.searchParams.get('tz'), '480')
  assert.equal(url.searchParams.has('max_points'), false, 'download uses raw history, not the display point limit')
}
const markup = renderToStaticMarkup(createElement(HistoryExportModal, { request: snapshot, t: key => ({ histExportSelected: '{n} selected' }[key] ?? key), onClose() {}, async onPick() {} }))
assert.match(markup, /role="dialog"/)
assert.match(markup, /histExportViewport/)
assert.match(markup, /08:00:00\.123/)
assert.match(markup, /2 selected/)

// Exercise generated download URLs against the real export implementation, using only new temporary databases.
const edition = await createOfflineTestApp()
try {
  const { app, deviceId, registerIds, start, end } = edition
  const all = captureHistoryExport(deviceId, { start: Date.parse(start), end: Date.parse(end) }, registerIds, 0, 'full')
  const fullCsv = await app.inject(historyExportUrl('csv', all))
  assert.equal(fullCsv.statusCode, 200)
  assert.equal(fullCsv.body.split('\n').length, 61, 'full export retains all 60 original timestamps')
  const series = (await app.inject(`/api/data/object/series?object_id=${deviceId}&start=${start}&end=${end}`)).json().series[0]
  const range = { start: series.samples[8][0] + 1, end: series.samples[13][0] }
  const viewport = captureHistoryExport(deviceId, range, [registerIds[0]], 0, 'viewport')
  const response = await app.inject(historyExportUrl('csv', viewport))
  assert.equal(response.statusCode, 200)
  const rows = response.body.split('\n').map(line => line.split(','))
  assert.equal(rows.length, 6, 'zoom export contains exactly timestamps 9 through 13, including the exact end boundary')
  assert.equal(rows[0].length, 4, 'one selected point exports only value/status/eligibility')
  assert.equal(rows[0][1], '32位测试值')
  assert.deepEqual(rows.slice(1).map(row => row.slice(2)), [['批次/来源已验证', 'true'], ...Array.from({ length: 4 }, () => ['批次/来源未验证', 'false'])])
  for (const row of rows.slice(1)) {
    const time = Date.parse(row[0].replace(' ', 'T') + 'Z')
    assert.ok(time >= range.start && time <= range.end, 'no rows from outside the visible time range')
  }
  const xlsx = await app.inject(historyExportUrl('xlsx', viewport))
  assert.equal(xlsx.statusCode, 200)
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(xlsx.rawPayload as any)
  assert.equal(workbook.getWorksheet('data')!.rowCount, 6)
  assert.equal(workbook.getWorksheet('data')!.columnCount, 4)
  assert.ok(workbook.getWorksheet('历史身份说明'))
  const empty = captureHistoryExport(deviceId, { start: Date.parse(end) + 1000, end: Date.parse(end) + 2000 }, [registerIds[0]], 0, 'viewport')
  assert.equal((await app.inject(historyExportUrl('csv', empty))).body.split('\n').length, 1, 'empty ranges produce headers without stale rows')
  assert.equal((await app.inject({ url: historyExportUrl('csv', viewport), headers: { 'x-test-scenario': 'error' } })).statusCode, 503)
  assert.equal((await app.inject(historyExportUrl('csv', viewport))).statusCode, 200, 'download retry recovers')
  const tooLarge = await app.inject({ url: historyExportUrl('csv', viewport), headers: { 'x-test-scenario': 'limit' } })
  assert.equal(tooLarge.statusCode, 413)
  assert.equal(tooLarge.json().code, 'HISTORY_EXPORT_LIMIT')
  assert.equal(tooLarge.headers['content-disposition'], undefined)
  assert.equal((await app.inject('/api/test-info')).json().realDataOpened, false)
} finally { await edition.app.close() }

// Change the same mutable configuration objects while the actual exporter awaits
// its raw query. Both formats must keep the definitions captured by that request.
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
for (const format of ['csv', 'xlsx'] as const) {
  const device = { id: 7, mode: 'master' }, group = { id: 10, slaveId: 1, functionCode: 3, startAddress: 0, quantity: 2 }
  const point = { id: 101, objectId: 7, groupId: 10, alias: 'before', functionCode: 3, startAddress: 0, dataType: 'uint16' }
  const entered = deferred<void>(), held = deferred<any[]>(); let ranges: any[] = [], reads = 0
  const data = [
    { objectId: 7, area: 'holding-register', address: 0, slaveId: 1, rawValue: 123, quality: 'good', ts: new Date(t).toISOString(), timestampMs: t, batchId: 'first-response' },
    ...[1, 0].map((rawValue, address) => ({ objectId: 7, area: 'holding-register', address, slaveId: 2, rawValue, quality: 'good', ts: new Date(t).toISOString(), timestampMs: t, batchId: 'second-response' })),
  ]
  const rowsFor = (selected: any[]) => data.filter(row => selected.some(range => range.area === row.area && range.slaveId === row.slaveId && row.address >= range.startAddress && row.address <= range.endAddress))
  const store = { async queryObjectForExport(id: number, start: string, end: string, selected: any[]) { reads++; assert.equal(id, 7); assert.equal(start, snapshot.start); assert.equal(end, snapshot.end); ranges = structuredClone(selected); entered.resolve(); return held.promise } }
  const sink = new Sink({ config: { listRegistersByObject: () => [point], listGroups: () => [group], getObject: () => device }, store })
  const run = () => format === 'csv' ? sink.exportCsv(7, snapshot.start, snapshot.end, [101]) : sink.exportXlsx(7, snapshot.start, snapshot.end, [101])
  const pending = run(); await entered.promise
  assert.deepEqual(ranges, [{ area: 'holding-register', startAddress: 0, endAddress: 0, slaveId: 1 }])
  group.slaveId = 2; point.alias = 'after'; point.dataType = 'uint32'
  held.resolve(rowsFor(ranges)); const first = await pending
  const cells = async (body: string | Buffer) => {
    if (typeof body === 'string') { const rows = body.split('\n').map(line => line.split(',')); return [rows[0][1], ...rows[1].slice(1)] }
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(body as any); const sheet = workbook.getWorksheet('data')!; return [sheet.getCell('B1').value, sheet.getCell('B2').value, sheet.getCell('C2').value, sheet.getCell('D2').value]
  }
  const eligible = format === 'csv' ? 'true' : true
  assert.deepEqual(await cells(first), ['before', '123', '批次/来源已验证', eligible], 'configuration changes during await must not relabel, widen or change the source of this file')
  store.queryObjectForExport = async (_id, _start, _end, selected) => { reads++; ranges = structuredClone(selected); return rowsFor(selected) }
  assert.deepEqual(await cells(await run()), ['after', '65536', '批次/来源已验证', eligible], 'a new export uses the new definition, not the prior request snapshot')
  assert.deepEqual(ranges, [{ area: 'holding-register', startAddress: 0, endAddress: 1, slaveId: 2 }]); assert.equal(reads, 2)
}
console.log('HISTORY EXPORT OK: exact range/selection/milliseconds/timezones, real CSV/XLSX, batch status/empty/failure/retry, and actual Sink in-flight mutable definition/source/width isolation versus fresh export; isolated temporary or pure mock data only, no production service/device/model I/O')
