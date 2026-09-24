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
console.log('LIVE CURVE TEST OK: deduplication, freeze, gaps, freshness, area isolation, multiword decoding, limits and clear')
