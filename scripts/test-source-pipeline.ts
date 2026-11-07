import assert from 'node:assert/strict'
import Fastify from 'fastify'
import ExcelJS from 'exceljs'
import { DuckDBStore } from '../packages/store/src/index.ts'
import { Sink } from '../packages/sink/src/index.ts'
import { encodeRegister } from '../packages/core/src/codec.ts'
import { sourceKey, sourceSample, withRegisterSources } from '../packages/core/src/sample-source.ts'
import { decodeHistoricalSample, decodeLatestSample } from '../packages/core/src/history-integrity.ts'
import { historyExportReadRanges, HistoryExportLimitError } from '../packages/core/src/history-export-policy.ts'
import { decodeHistorySeries } from '../apps/web/src/history-curve.ts'
import { sampleCurve } from '../apps/web/src/live-curve.ts'
import { readPointAlarmValue } from '../apps/web/src/alarm-value.ts'
import { assistantHistoryPoints } from '../packages/api/src/history-assessment.ts'
import { registerCurve } from '../packages/api/src/curve.ts'
import { registerHistoryExport } from '../packages/api/src/history-export.ts'
import { apply as applyPoller } from '../packages/poller/src/index.ts'
import { DeviceSlaves } from '../packages/slave/src/devices.ts'
import { withMockRecordingIntervals } from './fixtures/recording-config.ts'

const start = '2026-11-06T00:00:00Z', base = Date.parse(start), end = new Date(base + 300000).toISOString()
const groups = [1, 2].map(id => ({ id, slaveId: id, functionCode: 3, startAddress: 0, quantity: 4 }))
const definitions = groups.map(g => ({ id: g.id, groupId: g.id, functionCode: 3, startAddress: 0, dataType: 'uint32', alias: 'slave' + g.id }))
const cfg = { getObject: () => ({ id: 1, mode: 'master' }), listGroups: () => groups, listRegistersByObject: () => definitions }
const regs = () => withRegisterSources(definitions, groups, cfg.getObject())
const store = new DuckDBStore({ dbPath: ':memory:', flushIntervalMs: 0, flushBatchSize: 10000, retentionSeconds: 0, retentionCheckMs: 0 })
const sink = new Sink({ config: cfg, store })
const write = (slaveId: number | null, offset: number, words: number[], batchId: string | null, address = 0, area = 'holding-register') => {
  store.write(words.map((rawValue, i) => ({ objectId: 1, slaveId, area: area as any, address: address + i, timestamp: new Date(base + offset).toISOString(), rawValue, quality: 'good', batchId })))
}
const app = Fastify()
registerCurve(app, cfg, store); registerHistoryExport(app, sink)
try {
  // Same device/area/address/millisecond AND batch string; only the requested source differs.
  write(1, 0, [0, 5], 'same-response-id'); write(2, 0, [0, 100], 'same-response-id')
  await store.flush()
  await assert.rejects(store.queryObjectCurve(1, start, end), /disabled/)
  const hot = JSON.parse(JSON.stringify(store.getLatest()))
  assert.equal(hot['1:holding-register:0'], undefined)
  assert.equal(sourceSample(hot, 1, 'holding-register', 1, 1)?.rawValue, 5)
  assert.equal(sourceSample(hot, 1, 'holding-register', 1, 2)?.rawValue, 100)
  const alarmValue = (source: number, snapshot = store.getLatest(), now = base) => readPointAlarmValue(definitions[source - 1], snapshot, { id: 1, isActive: 1, mode: 'master' }, { ...groups[source - 1], isActive: 1 }, now, 5000, false)
  assert.equal(alarmValue(1, hot), 5); assert.equal(alarmValue(2, hot), 100, 'actual hot snapshot survives JSON serialization and remains evaluable by the top alarm panel without unscoped keys')
  assert.equal(sourceSample({ [sourceKey(1, 'holding-register', 0, 1)]: { slaveId: 2 } }, 1, 'holding-register', 0, 1), undefined)
  const cacheWords = [0, 1].map(address => ({ ...sourceSample<any>(hot, 1, 'holding-register', address, 1), address }))
  assert.equal(decodeLatestSample(regs()[0], cacheWords).automaticEligible, true)
  assert.equal(decodeLatestSample(regs()[0], cacheWords.map((p, i) => ({ ...p, timestampMs: base + i }))).value, null)
  let live = sampleCurve({}, regs(), hot, 1, base, 5000, new Set())
  assert.deepEqual(live[1].points, [[base, 5]]); assert.deepEqual(live[2].points, [[base, 100]])
  let curve = await store.queryRegisterCurve(1, start, end, regs(), 25000)
  assert.deepEqual(curve.series.map(s => s.samples), [[[base, 5]], [[base, 100]]])
  assert.ok(curve.series.every(s => s.integrity.verified === 1))
  const csv = (await sink.exportCsv(1, start, end)).split('\n').map(row => row.split(','))
  assert.deepEqual(csv[1].slice(1), ['5', '批次/来源已验证', 'true', '100', '批次/来源已验证', 'true'])
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await sink.exportXlsx(1, start, end) as any)
  assert.equal(wb.getWorksheet('data')!.getCell('B2').value, '5'); assert.equal(wb.getWorksheet('data')!.getCell('E2').value, '100')
  let response = await app.inject(`/api/data/object/series?object_id=1&start=${start}&end=${end}`)
  assert.equal(response.statusCode, 200); assert.deepEqual(response.json().series.map((s: any) => s.samples), curve.series.map(s => s.samples))

  write(null, 1000, [0, 50], 'old-batch-without-source') // Not attributable even though batch is complete.
  write(1, 2000, [1], 'cross-source'); write(2, 2000, [65535], 'cross-source', 1)
  write(1, 3000, [1], 'A'); write(1, 3000, [0], 'B', 1)
  assert.equal(alarmValue(1, store.getLatest(), base + 3000), null, 'mixed target batch cannot produce a displayed alarm state')
  assert.equal(alarmValue(2, store.getLatest(), base + 3000), null, 'partial foreign update cannot fill an older target response')
  write(1, 4000, [1, 0], 'recovered'); write(2, 4000, [0, 101], 'recovered-2')
  write(2, 5000, [0, 102], 'foreign-only')
  await store.flush()
  const raw = await store.queryObject(1, start, end)
  curve = await store.queryRegisterCurve(1, start, end, regs(), 25000)
  const frontend = decodeHistorySeries(regs(), raw, new Set([1, 2]))
  assert.deepEqual(frontend.map(s => s.samples), curve.series.map(s => s.samples))
  assert.deepEqual(frontend.map(s => s.integrity), curve.series.map(s => s.integrity))
  assert.deepEqual(curve.series[0].samples, [[base, 5], [base + 1000, null], [base + 2000, null], [base + 3000, null], [base + 4000, 65536]])
  assert.equal(decodeHistoricalSample(regs()[0], raw.filter(p => p.timestampMs === base + 1000)).reason, 'ambiguous-legacy-source')
  assert.equal(assistantHistoryPoints(regs()[0], raw, raw.filter(p => p.address === 0 && p.timestampMs === base + 1000))[0].value, null)
  const known = await store.query(1, 0, start, end, 'holding-register', 100, 1)
  assert.ok(known.every(p => p.slaveId === 1 || p.slaveId === null)); assert.ok(known.some(p => p.slaveId === null))
  assert.deepEqual(await store.queryWithOffset(1, 0, start, end, 'holding-register', 100, 0, 1), known)
  const unknownCsv = (await sink.exportCsv(1, start, end)).split('\n')[2].split(',')
  assert.deepEqual(unknownCsv.slice(1), ['', '未知', 'false', '', '未知', 'false'])

  // A unique historical definition may display missing source for compatibility, never for automation.
  const unique = withRegisterSources([definitions[0]], [groups[0]])[0]
  const oldRows = raw.filter(p => p.timestampMs === base + 1000)
  assert.deepEqual(decodeHistoricalSample(unique, oldRows), { value: 50, words: [0, 50], verification: 'unverified', automaticEligible: false, reason: 'source-identity-unavailable' })
  const ai = assistantHistoryPoints(unique, oldRows, [oldRows[0]])[0]
  assert.equal(ai.value, null); assert.equal(ai.compatibilityValue, 50); assert.equal(ai.slaveId, null)
  const both = [...oldRows, ...oldRows.map(p => ({ ...p, slaveId: 1, batchId: 'attributed' }))]
  const attributed = assistantHistoryPoints(unique, both, both.filter(p => p.address === 0))
  assert.equal(attributed.length, 1, 'legacy base rows must not duplicate or inherit verified values at the same timestamp')
  assert.equal(attributed[0].slaveId, 1); assert.equal(attributed[0].automaticEligible, true)
  assert.equal(decodeHistoricalSample({ ...unique, slaveId: undefined }, oldRows).automaticEligible, false)
  assert.equal(decodeHistoricalSample(unique, [{ ...oldRows[0], slaveId: 1 }, oldRows[1]]).value, null, 'known and unknown words never fill one another')
  assert.equal(decodeHistoricalSample(unique, oldRows.map((p, i) => ({ ...p, slaveId: i + 1 }))).value, null)
  for (const dtype of ['uint32-LE', 'float64', 'float64-LE']) {
    const words = encodeRegister(dtype, 42)
    const a = words.map((rawValue, address) => ({ address, rawValue, slaveId: 1, batchId: 'X', quality: 'good' }))
    const b = words.map((rawValue, address) => ({ address, rawValue: rawValue + 1, slaveId: 2, batchId: 'X', quality: 'good' }))
    assert.equal(decodeHistoricalSample({ ...unique, dataType: dtype }, [...b, ...a]).value, 42)
    assert.equal(decodeHistoricalSample({ ...unique, dataType: dtype }, a.map((p, i) => ({ ...p, slaveId: i ? 2 : 1 }))).value, null)
    assert.equal(decodeHistoricalSample({ ...unique, dataType: dtype }, a.map((p, i) => ({ ...p, quality: i ? 'bad' : 'good' }))).value, null)
  }
  const sameSource = withRegisterSources(definitions, groups.map(g => ({ ...g, slaveId: 1 })))
  assert.ok(sameSource.every(r => !r.sourceAmbiguous), 'same-source overlapping groups remain supported')
  assert.equal(withRegisterSources(definitions, groups, { mode: 'slave', slaveId: 7 })[1].slaveId, 7)
  const previous = { ...groups[0] }; groups[0].slaveId = 2
  const changed = (await store.queryRegisterCurve(1, start, end, regs(), 25000)).series[0]
  assert.equal(changed.samples[0][1], 100, 'current point source selects persisted source; no old-source cache reuse')
  live = sampleCurve(live, regs(), hot, 1, base, 5000, new Set())
  assert.deepEqual(live[1].points, [[base, 100]], 'source change resets the live curve buffer')
  Object.assign(groups[0], previous)

  // FC04 and 64-bit LE use the same source selector without changing address/area contracts.
  const inputReg = { ...unique, functionCode: 4, dataType: 'float64-LE' }
  write(1, 6000, encodeRegister(inputReg.dataType, 123.5), 'input1', 0, 'input-register')
  write(2, 6000, encodeRegister(inputReg.dataType, 456.5), 'input2', 0, 'input-register')
  await store.flush()
  assert.deepEqual((await store.queryRegisterCurve(1, start, end, [inputReg])).series[0].samples, [[base + 6000, 123.5]])
  const ranges = historyExportReadRanges(regs())
  assert.deepEqual(ranges.map(r => r.slaveId), [1, 2], 'overlapping addresses from different sources are never merged')
  // New samples from another known slave do not consume selected-source export quota.
  const conn = await (store as any).ready
  await conn.run(`INSERT INTO poll_data (object_id, area, address, ts, raw_value, quality, batch_id, slave_id)
    SELECT 1, 'holding-register', 0, TIMESTAMP '2026-11-06 00:00:10' + i * INTERVAL '1 millisecond', 7, 'good', 'bulk-' || i, 2 FROM range(200001) r(i)`)
  assert.ok((await sink.exportCsv(1, start, end, [1])).includes('65536'))
  await assert.rejects(sink.exportCsv(1, start, end, [2]), HistoryExportLimitError)
  response = await app.inject(`/api/export/csv?object_id=1&start=${start}&end=${end}&register_ids=1`)
  assert.equal(response.statusCode, 200)
  response = await app.inject(`/api/export/csv?object_id=1&start=${start}&end=${end}&register_ids=2`)
  assert.equal(response.statusCode, 413); assert.equal(response.headers['content-disposition'], undefined)
  // A failed transaction retains source and all pending words for an explicit retry.
  const instance = (store as any).instance, connect = instance.connect.bind(instance)
  write(1, 299000, [9, 9], 'retry-source')
  instance.connect = async () => {
    const writer = await connect(), run = writer.run.bind(writer)
    writer.run = async (sql: string, ...args: any[]) => { if (sql.includes('INSERT INTO poll_data')) throw new Error('injected source write failure'); return run(sql, ...args) }
    return writer
  }
  await assert.rejects(store.flush(), /injected source write failure/)
  assert.equal(store.getPersistenceStatus().pendingRows, 2)
  instance.connect = connect; await store.flush()
  assert.ok((await store.query(1, 0, start, end, 'holding-register', 100, 1)).some(p => p.batchId === 'retry-source' && p.slaveId === 1))
  // Exercise the actual producer's write/flush and JSON event path with a fully mock driver.
  let poller: any, wire: any
  const requested: number[] = []
  const driver = {
    connect: async (target: any) => assert.equal(target.ip, 'mock.invalid'), disconnect: async () => {},
    readHoldingRegisters: async (_address: number, _count: number, slaveId: number) => { requested.push(slaveId); return [0, slaveId === 1 ? 5 : 100, 0, 0] },
  }
  const onceCfg = withMockRecordingIntervals({ getObject: () => undefined, updateObject: () => {}, listRegisters: () => [] })
  const context = { config: onceCfg, store, modbus: { createDriver: () => driver }, on: () => {}, provide: (_name: string, service: any) => { poller = service }, emit: (_name: string, event: any) => { wire = JSON.parse(JSON.stringify(event)) } }
  applyPoller(context as any, { pollIntervalMs: 0, connectRetryMs: 0, watchdogTimeoutMs: 30000, autoResetFailThreshold: 0, autoResetCooldownMs: 0 })
  const from = new Date(Date.now() - 1000).toISOString()
  await poller.pollOnce({ id: 9, host: 'mock.invalid', port: 1502, groups })
  const to = new Date(Date.now() + 1000).toISOString()
  assert.deepEqual(requested, [1, 2]); assert.deepEqual(wire.points.map((p: any) => p.slaveId), [1, 1, 1, 1, 2, 2, 2, 2])
  const produced = await store.queryObject(9, from, to)
  assert.equal(produced.length, 8); assert.ok(produced.every(p => p.slaveId != null && p.batchId))
  assert.deepEqual((await store.queryRegisterCurve(9, from, to, regs())).series.map(s => s.samples[0][1]), [5, 100])
  assert.equal(sourceSample(store.getLatest(), 9, 'holding-register', 1, 1)?.rawValue, 5)
  // Call only the pure publish path, with a fake memory reader; never reconcile/start a listener.
  const localDevice = { id: 10, mode: 'slave', transport: 'tcp', slaveId: 7, isActive: 1 }
  const localCfg = withMockRecordingIntervals({ getObject: () => localDevice, updateObject: () => {}, listGroups: () => [{ ...groups[0], isActive: 1 }], listRegisters: () => [definitions[0]] })
  const local = new DeviceSlaves(localCfg, store, (_event, payload) => { if (payload.points) wire = payload })
  ;(local as any).publish(localDevice, { source: localCfg.captureRecordingSource(10), server: { read: () => [0, 77] } })
  await store.flush()
  assert.ok(wire.points.every((p: any) => p.slaveId === 7 && p.batchId === undefined), 'local slave memory retains its own source without inventing a response identity')
  const localHistory = await store.queryRegisterCurve(10, from, new Date(Date.now() + 1000).toISOString(), [{ ...regs()[0], slaveId: 7, sourceAmbiguous: false }])
  assert.equal(localHistory.series[0].samples[0][1], 77); assert.equal(localHistory.series[0].integrity.unverified, 1)
} finally {
  await app.close(); await (store as any).mutations
  const conn = await (store as any).ready; conn.closeSync(); (store as any).instance.closeSync()
}
console.log('SOURCE PIPELINE OK: same-ms/source cache/live/history/API/CSV/XLSX, NULL ambiguity, AI eligibility, mixed/partial/recovery, source changes, FC04/64LE, source quota and failed-write retry')
