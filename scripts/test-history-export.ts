import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ExcelJS from 'exceljs'
import { captureHistoryExport, historyExportRangeLabel, historyExportUrl } from '../apps/web/src/history-export.ts'
import { HistoryExportModal } from '../apps/web/src/HistoryExportModal.tsx'
import { createOfflineTestApp } from './offline-test-app.ts'
import { Sink } from '../packages/sink/src/index.ts'
import { encodeRegister } from '../packages/core/src/codec.ts'

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
// Plot-only unavailable/relative/legend states must never trim or normalize exported source values.
{
  const device = { id: 7, mode: 'master' }, group = { id: 10, slaveId: 1, functionCode: 3, startAddress: 0, quantity: 8 }
  const points = [0, 4].map((startAddress, i) => ({ id: 101 + i, objectId: 7, groupId: 10, alias: i ? 'extreme' : 'zero and tiny', functionCode: 3, startAddress, dataType: 'float64' }))
  const data = [1, 2].flatMap(slaveId => [0, 1, 2].flatMap(i => points.flatMap((point, index) => encodeRegister('float64', index ? (slaveId === 1 ? Number.MAX_VALUE : -Number.MAX_VALUE) : i === 1 ? (slaveId === 1 ? 1e-12 : -1e-12) : 0).map((rawValue, offset) => ({ objectId: 7, area: 'holding-register', address: point.startAddress + offset, slaveId, rawValue, quality: 'good', ts: new Date(t + i * 100).toISOString(), timestampMs: t + i * 100, batchId: slaveId + '-' + i + '-' + point.id })))))
  const before = structuredClone(data); let reads = 0
  const sink = new Sink({ config: { getObject: () => device, listGroups: () => [group], listRegistersByObject: () => points }, store: { async queryObjectForExport(_id: number, _start: string, _end: string, ranges: any[]) { reads++; assert(ranges.every(range => range.slaveId === group.slaveId)); return data.filter(row => ranges.some(range => range.area === row.area && range.slaveId === row.slaveId && row.address >= range.startAddress && row.address <= range.endAddress)) } } })
  for (const slaveId of [1, 2]) {
    group.slaveId = slaveId
    const request = captureHistoryExport(7, { start: t, end: t + 200 }, [101, 102], 0, 'full'), url = new URL(historyExportUrl('csv', request), 'http://test.invalid')
    for (const flag of ['relative', 'hidden', 'scaleValid', 'max_points']) assert.equal(url.searchParams.has(flag), false, 'export is selected raw history, not the plot presentation')
    const expected = ['0', slaveId === 1 ? '1e-12' : '-1e-12', '0'], extreme = String(slaveId === 1 ? Number.MAX_VALUE : -Number.MAX_VALUE)
    const csv = (await sink.exportCsv(7, request.start, request.end, request.registerIds)).split('\n').map(row => row.split(',')); assert.equal(csv.length, 4)
    assert.deepEqual(csv.slice(1).map(row => row[1]), expected); assert.deepEqual(csv.slice(1).map(row => row[4]), [extreme, extreme, extreme]); assert(csv.slice(1).every(row => row[2] === '批次/来源已验证' && row[3] === 'true' && row[5] === '批次/来源已验证' && row[6] === 'true'))
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(await sink.exportXlsx(7, request.start, request.end, request.registerIds) as any); const sheet = workbook.getWorksheet('data')!
    assert.deepEqual([2, 3, 4].map(row => sheet.getCell('B' + row).value), expected); assert.deepEqual([2, 3, 4].map(row => sheet.getCell('E' + row).value), [extreme, extreme, extreme])
  }
  assert.equal(reads, 4); assert.deepEqual(data, before, 'export source changes do not rewrite either source data')
  console.log('HISTORY NUMERIC EXPORT OK: actual CSV/XLSX retain zero, tiny and +/-MAX strings, source identity/eligibility and all selected raw rows; plot flags absent; synthetic query only.')
}
{
  const group = { id: 10, slaveId: 1, functionCode: 3, startAddress: 0, quantity: 1 }, point = { id: 101, objectId: 7, groupId: 10, alias: 'timestamp observations', functionCode: 3, startAddress: 0, dataType: 'uint16' }
  const data = [{ at: 0, value: 1, quality: 'good' }, { at: 0, value: 2, quality: 'good' }, { at: 1000, value: 0, quality: 'bad' }, { at: 750, value: 3, quality: 'good' }, { at: 1500, value: 4, quality: 'good' }].map((event, index) => ({ objectId: 7, area: 'holding-register', address: 0, slaveId: 1, rawValue: event.value, quality: event.quality, ts: new Date(t + event.at).toISOString(), timestampMs: t + event.at, batchId: 'arrival-' + index }))
  const before = structuredClone(data), sink = new Sink({ config: { getObject: () => ({ id: 7, mode: 'master' }), listGroups: () => [group], listRegistersByObject: () => [point] }, store: { async queryObjectForExport() { return data.slice() } } })
  const start = new Date(t).toISOString(), end = new Date(t + 1500).toISOString(), csv = (await sink.exportCsv(7, start, end, [101])).split('\n').map(row => row.split(','))
  assert.deepEqual(csv.slice(1).map(row => row[0]), [0, 1000, 750, 1500].map(offset => new Date(t + offset).toISOString().replace('T', ' ').replace('Z', '')), 'decoded export retains first-seen query timestamp order, independent of plot sorting')
  assert.deepEqual(csv.slice(1).map(row => row[1]), ['', '', '3', '4']); assert.deepEqual(csv.slice(1).map(row => row[2]), ['未知', '未知', '批次/来源已验证', '批次/来源已验证']); assert.deepEqual(csv.slice(1).map(row => row[3]), ['false', 'false', 'true', 'true'])
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(await sink.exportXlsx(7, start, end, [101]) as any); const sheet = workbook.getWorksheet('data')!
  assert.deepEqual([2, 3, 4, 5].map(row => String(sheet.getCell('B' + row).value ?? '')), ['', '', '3', '4'])
  assert.deepEqual([2, 3, 4, 5].map(row => sheet.getCell('A' + row).value), csv.slice(1).map(row => row[0]))
  assert.deepEqual(data, before); assert.equal(data.length, 5, 'decoded export never rewrites/deduplicates the original query observations')
  assert.equal(data.filter(row => row.timestampMs === t).length, 2)
  console.log('HISTORY TIME EXPORT OK: raw query and first-seen timestamp order retained, same-time conflicts stay unknown in decoded CSV/XLSX, quality gap remains unknown; not a raw-record replay format.')
}
console.log('HISTORY EXPORT OK: exact range/selection/milliseconds/timezones, real CSV/XLSX, batch status/empty/failure/retry, and actual Sink in-flight mutable definition/source/width isolation versus fresh export; isolated temporary or pure mock data only, no production service/device/model I/O')
