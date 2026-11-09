import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { ConfigStore } from '../packages/config/src/index.ts'
import { DuckDBStore } from '../packages/store/src/index.ts'
import { registerCurve } from '../packages/api/src/curve.ts'
import { historyLineStarts } from '../apps/web/src/history-curve.ts'
import { curveValue } from '../apps/web/src/physical-value.ts'

// Evidence audit only. All databases are explicitly in memory; no bootstrap,
// listener, driver, poller, user path, browser, hardware or model is imported.
interface Word { offset: number; address: number; rawValue: number; quality: string; batchId?: string | null }
type Curve = Awaited<ReturnType<DuckDBStore['queryRegisterCurve']>>
const origin = Date.parse('2026-11-01T00:00:00Z')
async function fixture<T>(words: Word[], dataType: string, work: (query: (end?: number, maxPoints?: number) => Promise<Curve>) => Promise<T>): Promise<T> {
  const cfg = new ConfigStore({ dbPath: ':memory:' })
  const store = new DuckDBStore({ dbPath: ':memory:', flushIntervalMs: 0, flushBatchSize: 100000, retentionSeconds: 0, retentionCheckMs: 0 })
  const app = Fastify(), errors: unknown[] = []
  let value!: T
  try {
    const device = cfg.createObject('Synthetic history evidence only', 'mock.invalid', 502); cfg.updateObject(device.id, { isActive: 0 })
    const group = cfg.createGroup(device.id, 'Synthetic source', 3, 0, dataType === 'uint32' ? 2 : 1)
    const point = cfg.createRegister(group.id, device.id, 'Synthetic value', 3, 0, dataType)
    registerCurve(app, cfg, store)
    store.write(words.map(word => ({ objectId: device.id, area: 'holding-register' as const, address: word.address, rawValue: word.rawValue, quality: word.quality, batchId: word.batchId ?? null, slaveId: 1, timestamp: new Date(origin + word.offset).toISOString() })))
    await store.flush()
    value = await work(async (end = 600000, maxPoints = 1200) => {
      const params = new URLSearchParams({ object_id: String(device.id), register_ids: String(point.id), start: new Date(origin).toISOString(), end: new Date(origin + end).toISOString(), max_points: String(maxPoints) })
      const response = await app.inject('/api/data/object/series?' + params)
      assert.equal(response.statusCode, 200, response.body)
      return response.json<Curve>()
    })
  } catch (error) { errors.push(error) }
  for (const close of [() => app.close(), () => store.close(), () => cfg.close()]) { try { await close() } catch (error) { errors.push(error) } }
  if (errors.length) throw new AggregateError(errors, 'Synthetic history evidence audit/cleanup failed')
  return value
}
const starts = (series: Curve['series'][number]) => historyLineStarts(series.samples, series.gapMs ?? Infinity, series.segments).size
const one = (offset: number, quality = 'good'): Word => ({ offset, address: 0, rawValue: 10, quality, batchId: 'response-' + offset })
let passed = 0
async function check(name: string, work: () => Promise<unknown>) { const evidence = await work(); passed++; console.log('HISTORY BREAK EVIDENCE OK: ' + name + ' ' + JSON.stringify(evidence)) }
await check('different invalid causes have identical curve responses', async () => {
  const wide = (offset: number): Word[] => [0, 1].map(address => ({ offset, address, rawValue: address ? 1 : 0, quality: 'good', batchId: 'response-' + offset }))
  const bad = [...wide(0), ...wide(1000).map(word => ({ ...word, quality: word.address ? 'bad' : 'good' })), ...wide(2000)]
  const missing = [...wide(0), wide(1000)[0], ...wide(2000)]
  const mixed = [...wide(0), ...wide(1000).map(word => ({ ...word, batchId: 'part-' + word.address })), ...wide(2000)]
  assert.notDeepEqual(bad, missing); assert.notDeepEqual(missing, mixed)
  const a = await fixture(bad, 'uint32', query => query()), b = await fixture(missing, 'uint32', query => query()), c = await fixture(mixed, 'uint32', query => query())
  assert.deepEqual(a, b); assert.deepEqual(b, c); assert.equal(a.series[0].summary.invalidSamples, 1); assert(a.series[0].samples.some(sample => sample[1] === null))
  return { causes: ['bad-quality', 'missing-word', 'mixed-batch'], identicalResponses: true, summary: a.series[0].summary }
})
await check('downsampling preserves counts but not every invalid timestamp or segment boundary', async () => {
  const rows = Array.from({ length: 11 }, (_, i) => one(i * 100, i % 2 ? 'bad' : 'good'))
  return fixture(rows, 'uint16', async query => {
    const result = await query(600000, 5), series = result.series[0], nulls = series.samples.filter(sample => sample[1] === null)
    assert.deepEqual(series.summary, { sourceSamples: 11, validSamples: 6, invalidSamples: 5 }); assert.equal(nulls.length, 1); assert.equal(series.samples.length, 3); assert.equal(starts(series), 2); assert.equal(result.downsampled, true)
    assert.equal(series.segments.at(-1)![1], 5)
    return { sourceInvalid: 5, retainedInvalid: nulls.length, retainedSamples: series.samples.length, displayedLineStarts: starts(series), lastSourceSegment: 5 }
  })
})
await check('cadence-derived breaks can change with query range despite unchanged stored rows', async () => fixture([0, 1000, 2000, 12000, 22000, 32000].map(offset => one(offset)), 'uint16', async query => {
  const full = await query(32000), detail = await query(12000), a = full.series[0], b = detail.series[0]
  assert.equal(a.sourceGapMs, 30000); assert.equal(b.sourceGapMs, 3000); assert.equal(starts(a), 1); assert.equal(starts(b), 2); assert.equal(full.downsampled, false); assert.equal(detail.downsampled, false)
  assert.equal(a.summary.invalidSamples, 0); assert.equal(b.summary.invalidSamples, 0)
  return { fullThresholdMs: a.sourceGapMs, detailThresholdMs: b.sourceGapMs, fullStarts: starts(a), detailStarts: starts(b), invalidSamples: 0 }
}))
await check('regular slow samples and query-edge emptiness do not establish an expected sampling schedule', async () => {
  const slow = await fixture([60000, 120000, 180000, 240000, 300000].map(offset => one(offset)), 'uint16', query => query())
  assert.equal(slow.complete, true); assert.equal(slow.series[0].sourceGapMs, 180000); assert.equal(starts(slow.series[0]), 1); assert.equal(slow.series[0].samples[0][0], origin + 60000); assert.equal(slow.series[0].samples.at(-1)![0], origin + 300000)
  const empty = await fixture([], 'uint16', query => query()); assert.equal(empty.complete, true); assert.equal(empty.sourceSamples, 0); assert.deepEqual(empty.series[0].samples, []); assert.equal(empty.series[0].sourceGapMs, null)
  const single = await fixture([one(60000)], 'uint16', query => query()); assert.equal(single.series[0].sourceGapMs, null); assert.equal(starts(single.series[0]), 1)
  return { regularCadenceMs: 60000, inferredThresholdMs: 180000, regularStarts: 1, leadingUnobservedMs: 60000, trailingUnobservedMs: 300000, emptyComplete: true, singleThreshold: null }
})
await check('unverified legacy response identity is distinct from invalid numeric samples', async () => fixture([one(0), one(1000), one(2000)].map(word => ({ ...word, batchId: null })), 'uint16', async query => {
  const result = await query(), series = result.series[0]
  assert.deepEqual(series.summary, { sourceSamples: 3, validSamples: 3, invalidSamples: 0 }); assert.deepEqual(series.integrity, { verified: 0, unverified: 3, unknown: 0 }); assert(series.samples.every(sample => sample[1] !== null)); assert.equal(starts(series), 1)
  return { summary: series.summary, integrity: series.integrity, displayedLineStarts: starts(series) }
}))
await check('physical-display overflow can remove valid raw samples without changing source quality', async () => fixture([one(0), one(1000), one(2000)], 'uint16', async query => {
  const result = await query(), series = result.series[0]
  assert.deepEqual(series.summary, { sourceSamples: 3, validSamples: 3, invalidSamples: 0 })
  const physical = series.samples.map(([time, value]): [number, number | null] => [time, curveValue(value, { dataType: 'uint16', factor: Number.MAX_VALUE }, 'physical')])
  assert(series.samples.every(sample => sample[1] === 10)); assert(physical.every(sample => sample[1] === null)); assert.equal(historyLineStarts(physical, series.gapMs ?? Infinity, series.segments).size, 0)
  return { sourceValid: 3, sourceInvalid: 0, rawSamplesRetained: series.samples.length, physicalValuesPlottable: 0 }
}))
console.log(`HISTORY BREAK AUDIT OK: ${passed} actual memory-store/read-only-route cases; evidence boundaries only, no fault classification, browser, listener, real database, driver, hardware or model`)
