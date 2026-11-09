import assert from 'node:assert/strict'
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api'
import { ensurePollDataSchema } from '../packages/store/src/schema.ts'
import { DuckDBStore, type PollPoint } from '../packages/store/src/index.ts'
import { CurveSampler } from '../packages/store/src/curve-sampling.ts'
import { decodeHistoricalSample, type HistoryVerification } from '../packages/core/src/history-integrity.ts'
import { registerWidth } from '../packages/core/src/codec.ts'

// Opt-in prototype only: fixed synthetic fixtures, public in-memory DB APIs.
// No application, real path, listener, driver, poller, provider or browser.
assert.deepEqual(process.argv.slice(2), ['--synthetic'], 'Only --synthetic is accepted; no file/database/URL option exists')
interface Definition { id: number; functionCode: number; startAddress: number; dataType: string; slaveId?: number; sourceAmbiguous?: boolean }
interface Range { start: number; end: number }
interface Evidence { pointId: number; slaveId: number | null; time: number; previousTime: number | null; kind: 'unplottable' | 'unverified' | 'interval'; reason: string; verification: HistoryVerification; deltaMs: number | null; thresholdMs: number | null }
interface Snapshot { context: string; events: readonly Readonly<Evidence>[]; total: number; truncated: boolean; observations: number }
const origin = Date.parse('2026-11-01T00:00:00Z'), range = { start: origin, end: origin + 100000000 }
const definitions: Definition[] = [1, 2].map(slaveId => ({ id: slaveId, functionCode: 3, startAddress: 0, dataType: 'uint32', slaveId, sourceAmbiguous: true }))
const owners = new WeakMap<Snapshot, DuckDBConnection>(), open = new WeakSet<DuckDBConnection>()
const area = (fc: number) => fc === 1 ? 'coil' : fc === 2 ? 'discrete-input' : fc === 4 ? 'input-register' : 'holding-register'
const context = (defs: readonly Definition[], window: Range) => JSON.stringify([window, defs])
const reasons = new Set(['invalid-source', 'ambiguous-legacy-source', 'mixed-sources', 'missing-or-duplicate-words', 'invalid-word-or-quality', 'mixed-or-incomplete-response', 'nonfinite-value', 'source-identity-unavailable', 'response-identity-unavailable'])

/** Mirrors the current grouped SQL/decoder/sampler, adding bounded evidence in the SAME stream.
 * Deliberately not exported or wired to production. A retained-event cap is not a scan limit. */
async function scan(conn: DuckDBConnection, defs: readonly Definition[], window: Range, cap: number | undefined, signal?: AbortSignal, onBatch?: () => void) {
  assert(open.has(conn)); assert(Number.isFinite(window.start) && Number.isFinite(window.end) && window.start < window.end)
  assert(defs.length > 0 && defs.length <= 8 && new Set(defs.map(def => def.id)).size === defs.length)
  assert(cap === undefined || Number.isSafeInteger(cap) && cap >= 0 && cap <= 1024)
  signal?.throwIfAborted()
  const params: Record<string, number | string | null> = { object: 1, start: new Date(window.start).toISOString(), end: new Date(window.end).toISOString() }
  const tuples = defs.map((def, i) => {
    assert([1, 2, 3, 4].includes(def.functionCode))
    Object.assign(params, { ['id' + i]: def.id, ['area' + i]: area(def.functionCode), ['addr' + i]: def.startAddress, ['width' + i]: registerWidth(def.dataType), ['slave' + i]: def.slaveId ?? null })
    return `($id${i}, $area${i}, $addr${i}, $width${i}, CAST($slave${i} AS INTEGER))`
  }).join(',')
  const samples = new Map(defs.map(def => [def.id, new CurveSampler(window.start, Math.max(1, Math.ceil((window.end - window.start) / 200)))]))
  const byId = new Map(defs.map(def => [def.id, def])), previous = new Map<number, { time: number; segment: number; threshold: number | null }>()
  const events: Readonly<Evidence>[] = []; let total = 0, observations = 0, largestWordGroup = 0
  const emit = (event: Evidence | null) => { if (cap === undefined) return; total++; if (event && events.length < cap) events.push(Object.freeze(event)) }
  const interrupt = () => conn.interrupt(); signal?.addEventListener('abort', interrupt, { once: true })
  try {
    const result = await conn.stream(`WITH grouped AS (
      SELECT r.id, date_diff('millisecond', DATE '1970-01-01', p.ts) AS time,
        list(p.raw_value ORDER BY p.address) AS words, list(p.quality ORDER BY p.address) AS qualities,
        list(p.address ORDER BY p.address) AS addresses, list(p.batch_id ORDER BY p.address) AS batches, list(p.slave_id ORDER BY p.address) AS slaves
      FROM poll_data p JOIN (VALUES ${tuples}) AS r(id, area, addr, width, slave_id)
      ON p.area=r.area AND p.address>=r.addr AND p.address<r.addr+r.width AND (r.slave_id IS NULL OR p.slave_id=r.slave_id OR p.slave_id IS NULL)
      WHERE p.object_id=$object AND p.ts >= $start AND p.ts <= $end GROUP BY r.id,p.ts
    ), timed AS (SELECT *, time-lag(time) OVER (PARTITION BY id ORDER BY time) AS interval_ms FROM grouped)
    SELECT *, median(CASE WHEN interval_ms>0 THEN interval_ms END) OVER (PARTITION BY id) AS cadence
    FROM timed ORDER BY time,id`, params)
    const items = (value: unknown) => (value as { items: unknown[] }).items
    for await (const rows of result.yieldRowObjects()) {
      signal?.throwIfAborted(); onBatch?.(); signal?.throwIfAborted()
      for (const row of rows) {
        signal?.throwIfAborted()
        const id = Number(row.id), time = Number(row.time), def = byId.get(id)!, raw = items(row.words).map(Number), qualities = items(row.qualities).map(String), addresses = items(row.addresses).map(Number), batches = items(row.batches), slaves = items(row.slaves)
        largestWordGroup = Math.max(largestWordGroup, raw.length); observations++
        const decoded = decodeHistoricalSample(def, raw.map((rawValue, i) => ({ address: addresses[i], rawValue, quality: qualities[i], batchId: batches[i] == null ? null : String(batches[i]), slaveId: slaves[i] == null ? null : Number(slaves[i]) })))
        const unsafe = typeof decoded.value === 'bigint' && (decoded.value > BigInt(Number.MAX_SAFE_INTEGER) || decoded.value < BigInt(Number.MIN_SAFE_INTEGER))
        const value = decoded.value === null || unsafe ? NaN : Number(decoded.value), verification = Number.isFinite(value) ? decoded.verification : 'unknown'
        const old = previous.get(id), state = old ?? { time, segment: 0, threshold: Number(row.cadence) > 0 ? Number(row.cadence) * 3 : null }
        const base = cap === undefined || events.length >= cap ? null : { pointId: id, slaveId: def.slaveId ?? null, time, previousTime: old?.time ?? null, verification }
        if (old && state.threshold !== null && time - old.time > state.threshold) {
          state.segment++; if (cap !== undefined) emit(base ? { ...base, kind: 'interval', reason: 'query-median-threshold', deltaMs: time - old.time, thresholdMs: state.threshold } : null)
        }
        if (!Number.isFinite(value)) {
          state.segment++; if (cap !== undefined) emit(base ? { ...base, kind: 'unplottable', reason: unsafe ? 'unsafe-display-integer' : reasons.has(decoded.reason) ? decoded.reason : 'not-plottable', deltaMs: null, thresholdMs: null } : null)
        } else if (verification === 'unverified' && cap !== undefined) emit(base ? { ...base, kind: 'unverified', reason: reasons.has(decoded.reason) ? decoded.reason : 'identity-unavailable', deltaMs: null, thresholdMs: null } : null)
        samples.get(id)!.add({ time, value: Number.isFinite(value) ? value : null, words: raw, qualities, verification, segment: state.segment })
        state.time = time; previous.set(id, state)
      }
    }
    signal?.throwIfAborted()
    const series = defs.map(def => { const sampler = samples.get(def.id)!, retained = sampler.samples(); return { id: def.id, samples: retained.map(point => [point.time, point.value] as [number, number | null]), segments: retained.map(point => [point.time, point.segment!] as const), sourceGapMs: previous.get(def.id)?.threshold ?? null, integrity: sampler.integrity(), summary: sampler.summary() } })
    const snapshot: Snapshot = Object.freeze({ context: context(defs, window), events: Object.freeze(events), total, truncated: total > events.length, observations })
    owners.set(snapshot, conn)
    return { series, snapshot, largestWordGroup }
  } finally { signal?.removeEventListener('abort', interrupt) }
}
function page(conn: DuckDBConnection, snapshot: Snapshot, expectedContext: string, offset: number, size: number) {
  assert(open.has(conn) && owners.get(snapshot) === conn && snapshot.context === expectedContext, 'Unknown/closed/copied/context-mismatched prototype snapshot')
  assert(Number.isSafeInteger(offset) && offset >= 0 && offset <= snapshot.events.length && Number.isSafeInteger(size) && size > 0 && size <= 32)
  const rows = snapshot.events.slice(offset, offset + size), end = offset + rows.length
  return Object.freeze({ rows: Object.freeze(rows), offset, total: snapshot.total, retained: snapshot.events.length, truncated: snapshot.truncated, hasMoreRetained: end < snapshot.events.length, sourceExhausted: !snapshot.truncated && end === snapshot.events.length })
}
async function insert(conn: DuckDBConnection, rows: PollPoint[]) {
  for (let start = 0; start < rows.length; start += 256) {
    const params: Record<string, number | string | null> = {}
    const values = rows.slice(start, start + 256).map((row, i) => {
      Object.assign(params, { ['o' + i]: row.objectId, ['a' + i]: row.area, ['d' + i]: row.address, ['t' + i]: row.timestamp, ['v' + i]: row.rawValue, ['q' + i]: row.quality, ['b' + i]: row.batchId ?? null, ['s' + i]: row.slaveId ?? null })
      return `($o${i},$a${i},$d${i},CAST($t${i} AS TIMESTAMP),$v${i},$q${i},$b${i},$s${i})`
    }).join(',')
    await conn.run(`INSERT INTO poll_data VALUES ${values}`, params)
  }
}
async function fixture<T>(rows: PollPoint[], work: (conn: DuckDBConnection) => Promise<T>) {
  const db = await DuckDBInstance.create(':memory:'), conn = await db.connect(); open.add(conn)
  const errors: unknown[] = []; let result!: T
  try { await ensurePollDataSchema(conn); await insert(conn, rows); result = await work(conn) } catch (error) { errors.push(error) }
  open.delete(conn)
  try { conn.closeSync() } catch (error) { errors.push(error) }
  try { db.closeSync() } catch (error) { errors.push(error) }
  if (errors.length) throw new AggregateError(errors, 'Synthetic prototype/cleanup failed')
  return result
}
const word = (offset: number, address: number, slaveId: number | null, quality = 'good', batchId: string | null = 'PRIVATE-OPAQUE-' + offset): PollPoint => ({ objectId: 1, area: 'holding-register', address, timestamp: new Date(origin + offset).toISOString(), rawValue: address ? 10 : 0, quality, batchId, slaveId })
const pair = (time: number, source: number | null, batch?: string | null) => [word(time, 0, source, 'good', batch), word(time, 1, source, 'good', batch)]
const rows: PollPoint[] = []
for (const time of [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 12000]) {
  rows.push(...pair(time, 2))
  if (time === 1000) rows.push(word(time, 0, 1))
  else if (time === 2000) rows.push(word(time, 0, 1), word(time, 1, 1, 'bad'))
  else if (time === 3000) rows.push(word(time, 0, 1), word(time, 1, 1, 'good', 'PRIVATE-MIXED'))
  else if (time === 4000) rows.push(...pair(time, 1, null))
  else if (time === 5000) rows.push(...pair(time, null))
  else if (time === 6000) rows.push(...pair(time, 1), word(time, 0, 1))
  else if (time === 7000) rows.push({ ...word(time, 0, 1), rawValue: 65536 }, word(time, 1, 1))
  else if (time === 12000) rows.push(...pair(time, 1).map(row => ({ ...row, quality: 'bad' })))
  else rows.push(...pair(time, 1))
}
let groups = 0
let retired: { conn: DuckDBConnection; snapshot: Snapshot } | undefined
await fixture(rows, async conn => {
  const result = await scan(conn, definitions, range, 64), store = new DuckDBStore({ dbPath: ':memory:', flushIntervalMs: 0, flushBatchSize: 100000, retentionSeconds: 0, retentionCheckMs: 0 })
  try {
    store.write(rows); await store.flush()
    const actual = await store.queryRegisterCurve(1, new Date(range.start).toISOString(), new Date(range.end).toISOString(), definitions)
    assert.deepEqual(result.series, actual.series.map(({ id, samples, segments, sourceGapMs, integrity, summary }) => ({ id, samples, segments, sourceGapMs, integrity, summary })))
  } finally { await store.close() }
  const all = result.snapshot.events
  assert.equal(all.filter(event => event.pointId === 1 && event.time === origin + 12000).length, 2, 'one observation can produce interval and unplottable evidence; not two faults')
  for (const reason of ['missing-or-duplicate-words', 'invalid-word-or-quality', 'mixed-or-incomplete-response', 'response-identity-unavailable', 'ambiguous-legacy-source', 'query-median-threshold']) assert(all.some(event => event.reason === reason), reason)
  assert.equal(all.filter(event => event.pointId === 2 && event.kind !== 'interval').length, 0, 'other source does not inherit invalid or legacy evidence')
  const json = JSON.stringify(page(conn, result.snapshot, context(definitions, range), 0, 32))
  assert(!/PRIVATE-|rawValue|batchId|mock.invalid|serialPath|password|apiKey/.test(json)); assert(all.every(event => Object.isFrozen(event))); groups++
  console.log('EVIDENCE PROTOTYPE OK: production curve parity, source/quality/legacy reasons and output allowlist')
  for (const cap of [0, 1, all.length - 1, all.length, all.length + 1]) {
    const snap = (await scan(conn, definitions, range, cap)).snapshot; assert.equal(snap.total, all.length); assert.equal(snap.events.length, Math.min(cap, all.length)); assert.equal(snap.truncated, all.length > cap)
    const pages: Readonly<Evidence>[] = []; for (let offset = 0; offset < snap.events.length; offset += 2) pages.push(...page(conn, snap, snap.context, offset, 2).rows)
    assert.deepEqual(pages, all.slice(0, cap)); const last = page(conn, snap, snap.context, snap.events.length, 2); assert.equal(last.hasMoreRetained, false); assert.equal(last.sourceExhausted, !snap.truncated)
    assert.throws(() => page(conn, { ...snap }, snap.context, 0, 2)); assert.throws(() => page(conn, snap, context([{ ...definitions[0], slaveId: 3 }], range), 0, 2))
    for (const [offset, size] of [[-1, 2], [0.5, 2], [snap.events.length + 1, 2], [0, 0], [0, 33]]) assert.throws(() => page(conn, snap, snap.context, offset, size))
  }
  const snapshot = result.snapshot, frozen = JSON.stringify(page(conn, snapshot, snapshot.context, 0, 32))
  await conn.run('DELETE FROM poll_data'); assert.equal(JSON.stringify(page(conn, snapshot, snapshot.context, 0, 32)), frozen); assert.equal((await scan(conn, definitions, range, 64)).snapshot.total, 0)
  await insert(conn, rows); groups++; console.log('EVIDENCE PROTOTYPE OK: caps, retained-only pagination, copied/context rejection, mutation after capture and empty reread')
  const abort = new AbortController(); abort.abort(); await assert.rejects(scan(conn, definitions, range, 64, abort.signal))
  const mid = new AbortController(); await assert.rejects(scan(conn, definitions, range, 64, mid.signal, () => mid.abort())); assert.equal((await conn.runAndReadAll('SELECT 1 AS ok')).getRowObjects()[0].ok, 1)
  assert.equal((await scan(conn, definitions, range, 64)).snapshot.total, all.length); retired = { conn, snapshot }; groups++; console.log('EVIDENCE PROTOTYPE OK: pre/mid-stream cancellation publishes no partial snapshot and next query recovers')
})
assert(retired); assert.throws(() => page(retired!.conn, retired!.snapshot, retired!.snapshot.context, 0, 2))
await fixture([], async conn => { assert.throws(() => page(conn, retired!.snapshot, retired!.snapshot.context, 0, 2)); groups++; console.log('EVIDENCE PROTOTYPE OK: closed and foreign connection ownership cannot read retained snapshot') })
await fixture([word(1000, 0, 1)], async conn => { const result = await scan(conn, [definitions[0]], range, 64); assert.equal(result.snapshot.events.length, 1); assert.equal(result.snapshot.events[0].previousTime, null); assert.equal(result.snapshot.events[0].time, origin + 1000); assert.equal(result.snapshot.events[0].kind, 'unplottable'); groups++; console.log('EVIDENCE PROTOTYPE OK: first incomplete observation keeps unknown previous boundary; no invented query-edge interval') })
// Counts/runtimes are small-scale, same-process warm comparisons, not production capacity claims.
const median = (times: number[]) => [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)]
const measurements: object[] = []
for (const timestamps of [1000, 5000, 20000]) {
  const input = Array.from({ length: timestamps }, (_, i) => definitions.flatMap(def => pair(i + (i >= timestamps / 2 ? 10000 : 0), def.slaveId!).map(row => ({ ...row, quality: i % 2 ? 'bad' : 'good' })))).flat()
  await fixture(input, async conn => {
    const timings = { curve: [] as number[], evidence: [] as number[] }; let serialized = 0, total = 0, rss = process.memoryUsage().rss, heap = process.memoryUsage().heapUsed
    await scan(conn, definitions, range, undefined); await scan(conn, definitions, range, 64)
    const sampler = setInterval(() => { const used = process.memoryUsage(); rss = Math.max(rss, used.rss); heap = Math.max(heap, used.heapUsed) }, 5)
    try {
      for (let repeat = 0; repeat < 3; repeat++) for (const mode of (repeat % 2 ? ['evidence', 'curve'] : ['curve', 'evidence']) as Array<'curve' | 'evidence'>) {
        const begin = performance.now(), result = await scan(conn, definitions, range, mode === 'curve' ? undefined : 64); timings[mode].push(performance.now() - begin)
        if (mode === 'evidence') { assert.equal(result.snapshot.events.length, 64); assert.equal(result.snapshot.truncated, true); serialized = Buffer.byteLength(JSON.stringify(page(conn, result.snapshot, result.snapshot.context, 0, 32))); total = result.snapshot.total }
      }
    } finally { clearInterval(sampler) }
    measurements.push({ timestampsPerSource: timestamps, rawWords: input.length, curveMedianMs: +median(timings.curve).toFixed(2), curveEvidenceMedianMs: +median(timings.evidence).toFixed(2), totalEvents: total, retained: 64, firstPageBytes: serialized, sampledProcessRssBytes: rss, sampledProcessHeapBytes: heap })
  })
}
groups++; console.log('EVIDENCE PROTOTYPE MEASUREMENTS ' + JSON.stringify(measurements))
const duplicates = Array.from({ length: 5000 }, () => word(0, 0, 1))
await fixture(duplicates, async conn => { const result = await scan(conn, [definitions[0]], range, 1); assert.equal(result.snapshot.events.length, 1); assert.equal(result.largestWordGroup, 5000); groups++; console.log('EVIDENCE PROTOTYPE LIMIT: retained cap 1 still materializes 5000 words in one aggregate; SQL/median/group memory is not bounded by event cap') })
console.log(`EVIDENCE PROTOTYPE OK: ${groups} synthetic groups; experimental only, no production integration, HTTP cursor, fault claim, real data/device, listener, browser or model`)
