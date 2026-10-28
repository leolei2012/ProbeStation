import assert from 'node:assert/strict'
import { DuckDBStore } from '../packages/store/src/index.ts'
import { decodeHistoricalSample } from '../packages/core/src/history-integrity.ts'
import { encodeRegister } from '../packages/core/src/codec.ts'
import { decodeHistorySeries } from '../apps/web/src/history-curve.ts'
import { assistantHistoryPoints } from '../packages/api/src/history-assessment.ts'
import { Sink } from '../packages/sink/src/index.ts'
import ExcelJS from 'exceljs'
import { createOfflineTestApp } from './offline-test-app.ts'

const store = new DuckDBStore({ dbPath: ':memory:', flushIntervalMs: 0, flushBatchSize: 1000, retentionSeconds: 0, retentionCheckMs: 0 })
const start = '2026-10-01T00:00:00Z', end = '2026-10-01T00:01:00Z'
try {
  store.write([0, 1].map(address => ({ objectId: 1, area: 'holding-register' as const, address, timestamp: start, rawValue: address === 0 ? 1 : 0, quality: 'good', batchId: address === 0 ? 'A' : 'B' })))
  await store.flush()
  const curve = await store.queryRegisterCurve(1, start, end, [{ id: 1, functionCode: 3, startAddress: 0, dataType: 'uint32' }])
  assert.equal(curve.series[0].samples[0][1], null, 'mixed responses must remain unknown')
  assert.deepEqual(curve.series[0].integrity, { verified: 0, unverified: 0, unknown: 1 })
  for (const dataType of ['uint32', 'uint32-LE', 'float64', 'float64-LE']) {
    const reg = { id: 1, groupId: 1, functionCode: 3, startAddress: 0, dataType }
    const words = encodeRegister(dataType, 65536)
    const rows = words.map((rawValue, address) => ({ address, rawValue, quality: 'good', batchId: 'response', ts: start, timestampMs: Date.parse(start), area: 'holding-register' }))
    assert.equal(decodeHistoricalSample(reg, rows).verification, 'verified')
    const legacy = rows.map(p => ({ ...p, batchId: null }))
    assert.equal(decodeHistoricalSample(reg, legacy).value, 65536)
    assert.equal(decodeHistoricalSample(reg, legacy).automaticEligible, false)
    const frontend = decodeHistorySeries([reg], legacy, new Set([1]))[0]
    assert.deepEqual(frontend.samples, [[Date.parse(start), 65536]])
    assert.deepEqual(frontend.integrity, { verified: 0, unverified: 1, unknown: 0 })
    for (const broken of [rows.slice(1), [...rows, rows[0]], rows.map((p, i) => ({ ...p, batchId: String(i) })), rows.map((p, i) => ({ ...p, batchId: i ? null : 'response' })), rows.map((p, i) => ({ ...p, quality: i ? 'bad' : 'good' }))]) {
      assert.equal(decodeHistoricalSample(reg, broken).verification, 'unknown')
      assert.equal(decodeHistoricalSample(reg, broken).value, null)
      const base = broken.filter(p => p.address === 0)
      assert.ok(assistantHistoryPoints(reg, broken, base).every(p => p.value === null && !p.automaticEligible))
    }
    const automatic = assistantHistoryPoints(reg, rows, [rows[0]])[0]
    assert.equal(automatic.value, 65536); assert.equal(automatic.automaticEligible, true)
    const compatible = assistantHistoryPoints(reg, legacy, [legacy[0]])[0]
    assert.equal(compatible.value, null); assert.equal(compatible.compatibilityValue, 65536)
    assert.equal(compatible.automaticEligible, false)
  }
  const reg = { id: 1, groupId: 1, alias: 'test', functionCode: 3, startAddress: 0, dataType: 'uint32' }
  for (const [i, ids] of [[null, null], ['same', 'same'], ['A', 'B']].entries()) {
    const timestamp = new Date(Date.parse(start) + 1000 * (i + 1)).toISOString()
    store.write(ids.map((batchId, address) => ({ objectId: 1, area: 'holding-register' as const, address, timestamp, rawValue: address ? 0 : 1, quality: 'good', batchId })))
  }
  await store.flush()
  const rows = await store.queryObject(1, start, end)
  const frontend = decodeHistorySeries([reg], rows, new Set([1]))[0]
  const backend = (await store.queryRegisterCurve(1, start, end, [reg])).series[0]
  assert.deepEqual(frontend.samples, backend.samples)
  assert.deepEqual(frontend.integrity, backend.integrity)
  const sink = new Sink({ config: { listRegistersByObject: () => [reg] }, store })
  const csv = (await sink.exportCsv(1, start, end)).split('\n').map(line => line.split(','))
  assert.ok(csv[0].includes('test__batch_status')); assert.ok(csv[0].includes('test__automatic_eligible'))
  assert.deepEqual(csv.slice(1).map(row => row.slice(1)), [['', '未知', 'false'], ['65536', '批次未验证', 'false'], ['65536', '批次已验证', 'true'], ['', '未知', 'false']])
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await sink.exportXlsx(1, start, end) as any)
  assert.equal(wb.getWorksheet('data')!.getCell('C3').value, '批次未验证')
  assert.equal(wb.getWorksheet('data')!.getCell('D3').value, false)
  assert.equal(wb.getWorksheet('data')!.getCell('D4').value, true)
  assert.ok(wb.getWorksheet('历史身份说明'))
  // Local display timestamps omit milliseconds; raw epoch metadata must prevent false collisions.
  for (const [i, timestamp] of ['2026-10-01T00:00:30.100Z', '2026-10-01T00:00:30.200Z'].entries()) {
    store.write([0, 1].map(address => ({ objectId: 2, area: 'holding-register' as const, address, timestamp, rawValue: address ? i : 1, quality: 'good', batchId: 'millisecond-' + i })))
  }
  await store.flush()
  const precise = await store.queryObject(2, start, end)
  assert.deepEqual(decodeHistorySeries([reg], precise, new Set([1]))[0].samples, [[Date.parse('2026-10-01T00:00:30.100Z'), 65536], [Date.parse('2026-10-01T00:00:30.200Z'), 65537]])
  const preciseCsv = await sink.exportCsv(2, start, end)
  assert.match(preciseCsv, /30\.100,65536,批次已验证,true/)
  assert.match(preciseCsv, /30\.200,65537,批次已验证,true/)
} finally {
  await (store as any).mutations
  const conn = await (store as any).ready; conn.closeSync(); (store as any).instance.closeSync()
}

// Production query/export routes in a completely isolated test assembly, no model calls.
const edition = await createOfflineTestApp()
try {
  const { app, start, end, deviceId } = edition
  const q = `object_id=${deviceId}&start=${start}&end=${end}`
  const page = await app.inject('/api/data/object/page?' + q)
  assert.equal(page.statusCode, 200); assert.ok(page.json().points.length > 0)
  const curve = await app.inject('/api/data/object/series?' + q)
  assert.equal(curve.statusCode, 200)
  assert.deepEqual(curve.json().series[0].integrity, { verified: 20, unverified: 10, unknown: 30 })
  const invalid = await app.inject({ url: '/api/data/object/series?' + q, headers: { 'x-test-scenario': 'invalid' } })
  assert.deepEqual(invalid.json().series[0].integrity, { verified: 0, unverified: 0, unknown: 10 })
  assert.ok(invalid.json().series[0].samples.every((p: any) => p[1] === null))
  assert.equal((await app.inject('/api/data/object/curve?' + q)).statusCode, 410)
  assert.equal((await app.inject({ url: '/api/data/object/series?' + q, headers: { 'x-test-scenario': 'error' } })).statusCode, 503)
  assert.deepEqual((await app.inject({ url: '/api/data/object/page?' + q, headers: { cookie: 'probeTestScenario=empty' } })).json(), { points: [], total: 0 })
  assert.equal((await app.inject({ url: '/api/data/object/series?' + q, headers: { cookie: 'probeTestScenario=recovered' } })).json().series.length, 2)
  assert.equal((await app.inject({ method: 'POST', url: '/api/monitor_objects/1/poll' })).statusCode, 405)
  assert.equal((await app.inject({ method: 'POST', url: '/api/ai/sessions' })).statusCode, 405)
  const csv = await app.inject('/api/export/csv?' + q)
  assert.equal(csv.statusCode, 200); assert.match(csv.body, /__automatic_eligible/)
  const xlsx = await app.inject('/api/export/xlsx?' + q)
  assert.equal(xlsx.statusCode, 200); assert.ok(xlsx.rawPayload.length > 1000)
  const index = await app.inject('/')
  assert.equal(index.statusCode, 200); assert.match(index.body, /隔离测试版/)
  const asset = /src="([^"]+\.js)"/.exec(index.body)![1]
  assert.equal((await app.inject(asset)).statusCode, 200)
  const info = (await app.inject('/api/test-info')).json()
  assert.equal(info.realDataOpened, false); assert.equal(info.dataDir, edition.dataDir)
} finally { await edition.app.close() }
console.log('HISTORY INTEGRITY TEST OK: 32/64 BE/LE, legacy display, mixed/partial/quality rejection, frontend/store/export/assistant policy; isolated edition API/assets/error/recovery/write blocking')
