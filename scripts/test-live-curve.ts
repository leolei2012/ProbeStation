import assert from 'node:assert/strict'
import { sampleCurve, CURVE_LIMIT, type CurveBuffer } from '../apps/web/src/live-curve.ts'

const now = Date.parse('2026-09-23T04:00:00Z')
const reg = { id: 1, startAddress: 0, dataType: 'uint16', functionCode: 3 }
const point = (rawValue: number, ms = now) => ({ rawValue, timestamp: new Date(ms).toISOString(), quality: 'good' })
const key = '1:holding-register:0'
let buffer = sampleCurve({}, [reg], { [key]: point(10) }, 1, now, 5000, new Set())
assert.deepEqual(buffer[1].points, [[now, 10]])
buffer = sampleCurve(buffer, [reg], { [key]: point(10) }, 1, now + 250, 5000, new Set())
assert.equal(buffer[1].points.length, 1, 'unchanged snapshots are not duplicated')
const frozen = buffer
buffer = sampleCurve(buffer, [reg], { [key]: point(20, now + 500) }, 1, now + 500, 5000, new Set())
assert.equal(frozen[1].points.length, 1, 'frozen frames remain immutable')
buffer = sampleCurve(buffer, [reg], { [key]: point(20, now + 500) }, 1, now + 1000, 5000, new Set([1]))
assert.equal(buffer[1].points.at(-1)![1], null, 'faults break the line')
assert.equal(sampleCurve({}, [reg], { [key]: point(10) }, 1, now + 6000, 5000, new Set())[1].points.length, 0)
assert.equal(sampleCurve({}, [{ ...reg, functionCode: 4 }], { [key]: point(10) }, 1, now, 5000, new Set())[1].points.length, 0, 'data areas are isolated')
const wide = { ...reg, dataType: 'uint32' }
const words = { [key]: point(1), '1:holding-register:1': point(2) }
let multi = sampleCurve({}, [wide], words, 1, now, 5000, new Set())
assert.equal(multi[1].points[0][1], 65538)
multi = sampleCurve(multi, [wide], { ...words, [key]: point(2, now + 500) }, 1, now + 500, 5000, new Set())
assert.equal(multi[1].points.length, 1, 'partial multiword updates are not decoded')
multi = sampleCurve(multi, [wide], { [key]: point(2, now + 500), '1:holding-register:1': point(3, now + 501) }, 1, now + 501, 5000, new Set())
assert.equal(multi[1].points.at(-1)![1], 131075)
let bounded: CurveBuffer = {}
for (let i = 0; i < CURVE_LIMIT + 5; i++) bounded = sampleCurve(bounded, [reg], { [key]: point(i, now + i) }, 1, now + i, 5000, new Set())
assert.equal(bounded[1].points.length, CURVE_LIMIT)
const cleared = { 1: { ...bounded[1], points: [] } }
assert.equal(sampleCurve(cleared, [reg], { [key]: point(2404, now + 2404) }, 1, now + 2405, 5000, new Set())[1].points.length, 0, 'clear does not replay old samples')
assert.equal(sampleCurve(buffer, [], {}, 1, now, 5000, new Set())[1], undefined)
const response = (rawValue: number, batchId: string, ms = now) => ({ ...point(rawValue, ms), batchId })
const complete = { [key]: response(0, 'A'), '1:holding-register:1': response(65535, 'A') }
const mixed = { ...complete, [key]: response(1, 'B', now + 100) }
assert.equal(sampleCurve({}, [wide], mixed, 1, now + 100, 5000, new Set())[1].points.length, 0, 'first frame rejects overlapping groups from different responses')
assert.equal(sampleCurve(sampleCurve({}, [wide], complete, 1, now, 5000, new Set()), [wide], { [key]: response(1, 'B', now + 100), '1:holding-register:1': response(65535, 'C', now + 200) }, 1, now + 200, 5000, new Set())[1].points.at(-1)?.[1] ?? null, null, 'both words advancing is insufficient when their response identities differ')
let tracked = sampleCurve({}, [wide], complete, 1, now, 5000, new Set())
tracked = sampleCurve(tracked, [wide], mixed, 1, now + 100, 5000, new Set())
assert.equal(tracked[1].points.at(-1)![1], null, 'a partial response breaks the line instead of inventing 131071')
const restored = { [key]: response(1, 'C', now + 100), '1:holding-register:1': response(0, 'C', now + 100) }
tracked = sampleCurve(tracked, [wide], restored, 1, now + 100, 5000, new Set())
assert.equal(tracked[1].points.at(-1)![1], 65536, 'a complete response recovers')
const sameMillisecond = { [key]: response(1, 'D', now + 100), '1:holding-register:1': response(1, 'D', now + 100) }
tracked = sampleCurve(tracked, [wide], sameMillisecond, 1, now + 100, 5000, new Set())
assert.equal(tracked[1].points.at(-1)![1], 65537, 'distinct responses in the same millisecond are sampled')
assert.equal(sampleCurve(tracked, [wide], JSON.parse(JSON.stringify(sameMillisecond)), 1, now + 100, 5000, new Set())[1].points.length, tracked[1].points.length, 'serialized unchanged response is not replayed')
console.log('LIVE CURVE TEST OK: deduplication, freeze, gaps, freshness, area isolation, multiword decoding, limits and clear')
