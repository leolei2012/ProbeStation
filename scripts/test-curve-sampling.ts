import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { DuckDBStore } from '../packages/store/src/index.ts'
import { ConfigStore } from '../packages/config/src/index.ts'
import { registerCurve } from '../packages/api/src/curve.ts'
import { encodeRegister } from '../packages/core/src/codec.ts'
import { CurveSampler } from '../packages/store/src/curve-sampling.ts'

const invalidSampler = new CurveSampler(0, 1000)
for (let time = 0; time < 100; time++) invalidSampler.add({ time, value: null, words: [], qualities: ['bad'] })
assert.deepEqual(invalidSampler.summary(), { sourceSamples: 100, validSamples: 0, invalidSamples: 100 }, 'all-invalid data retains exact counts even when display samples collapse')
assert(invalidSampler.samples().length < 100)

const store = new DuckDBStore({ dbPath: ':memory:', flushIntervalMs: 0, flushBatchSize: 1000000, retentionSeconds: 0, retentionCheckMs: 0 })
const cfg = new ConfigStore({ dbPath: ':memory:' })
const app = Fastify()
registerCurve(app, cfg, store)
const start = '2026-10-01T00:00:00Z', end = '2026-10-01T00:04:00Z', t = Date.parse(start)
try {
  const d = cfg.createObject('No hardware', '', 502)
  const g = cfg.createGroup(d.id, 'test', 3, 0, 4)
  const r = cfg.createRegister(g.id, d.id, 'raw', 3, 0, 'uint16')
  const wide = cfg.createRegister(g.id, d.id, 'float', 3, 1, 'float32-LE')
  const covered = cfg.createRegister(g.id, d.id, 'covered', 3, 2, 'int16')
  const input = cfg.createRegister(g.id, d.id, 'input', 4, 0, 'uint16')
  cfg.createGroup(d.id, 'Empty group advances IDs', 3, 50, 1)
  const other = cfg.createObject('Other offline device', '', 502)
  const otherGroup = cfg.createGroup(other.id, 'Other group', 3, 0, 1)
  const otherReg = cfg.createRegister(otherGroup.id, other.id, 'Other value', 3, 0, 'uint16')
  const conn = await (store as any).ready
  await conn.run(`INSERT INTO poll_data (object_id, area, address, ts, raw_value, quality) SELECT $id, 'holding-register', 0, TIMESTAMP '2026-10-01 00:00:00' + i * INTERVAL '1 millisecond', CASE WHEN i = 100001 THEN 60000 WHEN i = 210000 THEN 65000 ELSE 10 END, 'good' FROM range(210001) AS n(i)`, { id: d.id })
  for (const [i, value] of [1, -20, 250.5, 2].entries()) {
    const words = encodeRegister('float32-LE', value)
    store.write(words.map((word, offset) => ({ objectId: d.id, area: 'holding-register', address: 1 + offset, rawValue: word, quality: 'good', timestamp: new Date(t + i * 1000).toISOString() })))
  }
  store.write([{ objectId: d.id, area: 'holding-register', address: 1, rawValue: 123, quality: 'good', timestamp: new Date(t + 4000).toISOString() }, { objectId: d.id, area: 'holding-register', address: 0, rawValue: 999, quality: 'bad', timestamp: new Date(t + 220000).toISOString() }, { objectId: d.id, area: 'input-register', address: 0, rawValue: 42, quality: 'good', timestamp: new Date(t).toISOString() }])
  await store.flush()
  const result = await store.queryRegisterCurve(d.id, start, end, [r, wide, input], 20)
  assert.equal(result.complete, true)
  assert.equal(result.downsampled, true)
  assert.equal(result.sourceSamples, 210008)
  const raw = result.series.find(s => s.id === r.id)!.samples
  assert.deepEqual(result.series.find(s => s.id === r.id)!.summary, { sourceSamples: 210002, validSamples: 210001, invalidSamples: 1 }, 'quality counts cover every source sample, not just displayed points')
  assert.deepEqual(result.series.find(s => s.id === wide.id)!.summary, { sourceSamples: 5, validSamples: 4, invalidSamples: 1 }, 'incomplete multiword samples count as invalid')
  assert(raw.some(([time, value]) => time === t + 100001 && value === 60000), 'short spike retains its actual sample time')
  assert(raw.some(([time, value]) => time === t + 210000 && value === 65000), 'tail beyond 200k rows is included')
  assert(raw.some(([, value]) => value === null), 'bad quality breaks the line')
  const floats = result.series.find(s => s.id === wide.id)!.samples
  assert(floats.some(([, value]) => value === -20))
  assert(floats.some(([, value]) => value === 250.5), 'extrema are decoded values, not raw word extrema')
  assert(floats.some(([, value]) => value === null), 'missing adjacent word stays invalid')
  assert.deepEqual(result.series.find(s => s.id === input.id)!.samples, [[t, 42]])
  const params = `object_id=${d.id}&start=${start}&end=${end}&register_ids=${wide.id},${covered.id}&max_points=20`
  const api = await app.inject('/api/data/object/series?' + params)
  assert.equal(api.statusCode, 200, api.body)
  assert.deepEqual(api.json().series[0].summary, { sourceSamples: 5, validSamples: 4, invalidSamples: 1 }, 'API exposes complete quality summary')
  assert.deepEqual(api.json().series.map((s: any) => s.id), [wide.id], 'covered placeholder excluded')
  store.write([{ objectId: other.id, area: 'holding-register', address: 0, rawValue: 77, quality: 'good', timestamp: start }])
  await store.flush()
  const otherParams = `object_id=${other.id}&start=${start}&end=${end}&register_ids=${otherReg.id}&max_points=20`
  const otherResponse = await app.inject('/api/data/object/series?' + otherParams)
  assert.equal(otherResponse.statusCode, 200, 'device ID must not be used as a group ID: ' + otherResponse.body)
  assert.deepEqual(otherResponse.json().series.map((s: any) => s.id), [otherReg.id])
  assert.deepEqual(otherResponse.json().series[0].samples, [[t, 77]])
  const allOther = await app.inject(`/api/data/object/series?object_id=${other.id}&start=${start}&end=${end}&max_points=20`)
  assert.deepEqual(allOther.json().series.map((s: any) => s.id), [otherReg.id], 'unfiltered curve returns every point of the selected device only')
  assert.equal((await app.inject('/api/data/object/series?' + otherParams.replace(`register_ids=${otherReg.id}`, `register_ids=${r.id}`))).statusCode, 400, 'points belonging to a different device must remain rejected')
  const detail = await store.queryRegisterCurve(d.id, new Date(t + 100000).toISOString(), new Date(t + 100004).toISOString(), [r], 1200)
  assert.equal(detail.downsampled, false)
  assert.equal(detail.sourceSamples, 5)
  assert.deepEqual(detail.series[0].summary, { sourceSamples: 5, validSamples: 5, invalidSamples: 0 }, 'zoom counts only the queried interval')
  const empty = await store.queryRegisterCurve(d.id, '2026-10-02T00:00:00Z', '2026-10-02T00:01:00Z', [r], 20)
  assert.deepEqual(empty.series[0].summary, { sourceSamples: 0, validSamples: 0, invalidSamples: 0 })
  const abort = new AbortController(); abort.abort()
  await assert.rejects(store.queryRegisterCurve(d.id, start, end, [r], 20, abort.signal))
  assert.equal((await app.inject('/api/data/object/series?object_id=1&start=bad&end=bad')).statusCode, 400)
  assert.equal((await app.inject('/api/data/object/series?' + params.replace(`register_ids=${wide.id},${covered.id}`, 'register_ids=999'))).statusCode, 400)
  console.log('CURVE SAMPLING OK: 210k+ rows, exact extrema/timestamps, multiword LE coherence, quality, zoom detail, selection and cancellation')
} finally {
  await app.close(); (cfg as any).db.close()
  const conn = await (store as any).ready; conn.closeSync(); (store as any).instance.closeSync()
}
