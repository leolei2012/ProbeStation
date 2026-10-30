import assert from 'node:assert/strict'
import { decodeHistorySeries, historySampleStats, historyLineStarts, historyQueryRange, nearestHistorySample, type HistoryPoint } from '../apps/web/src/history-curve.ts'

const t = Date.parse('2026-09-23T00:00:00Z')
// Request dates are serialized as ISO milliseconds. Completion must compare the same precision.
const fractional = historyQueryRange({ start: t + 145312.5, end: t + 154687.5 })
assert.equal(Date.parse(new Date(fractional.start).toISOString()), fractional.start, 'zoom start must match its completed request timestamp')
assert.equal(Date.parse(new Date(fractional.end).toISOString()), fractional.end, 'zoom end must match its completed request timestamp')
assert.deepEqual(historyQueryRange({ start: t, end: t + 1000 }), { start: t, end: t + 1000 })
let zoomRange = { start: t, end: t + 300000 }
for (let i = 0; i < 8; i++) {
  const width = Math.max(1000, (zoomRange.end - zoomRange.start) / 2), center = (zoomRange.start + zoomRange.end) / 2
  zoomRange = historyQueryRange({ start: center - width / 2, end: center + width / 2 })
  assert.equal(Date.parse(new Date(zoomRange.start).toISOString()), zoomRange.start, `repeat zoom ${i + 1} completes`)
  assert.equal(Date.parse(new Date(zoomRange.end).toISOString()), zoomRange.end)
}
for (const range of [{ start: t + 1234.567, end: t + 6789.123 }, { start: t + 500.25, end: t + 1500.75 }]) {
  const normalized = historyQueryRange(range)
  assert.deepEqual(historyQueryRange(normalized), normalized, 'drag/pan range normalization is stable')
  assert.ok(normalized.start < normalized.end)
  assert.ok(Math.abs(normalized.start - range.start) < 1 && Math.abs(normalized.end - range.end) < 1)
  assert.equal(Date.parse(new Date(normalized.start).toISOString()), normalized.start)
  assert.equal(Date.parse(new Date(normalized.end).toISOString()), normalized.end)
}
assert.deepEqual([...historyLineStarts([[0, 1], [18000, 2], [36000, 3]], 5400, [[0, 0], [18000, 0], [36000, 0]])], [0], 'sparse retained points in one source segment stay connected')
assert.deepEqual([...historyLineStarts([[0, 1], [18000, 2], [36000, 3]], 5400, [[0, 0], [18000, 1], [36000, 1]])], [0, 1], 'actual source gaps survive display downsampling')
assert.deepEqual([...historyLineStarts([[0, 1], [1000, null], [2000, 2]], 5400, [[0, 0], [1000, 1], [2000, 1]])], [0, 2], 'invalid readings still break the line')
assert.deepEqual([...historyLineStarts([[0, 1], [18000, 2]], 5400)], [0, 1], 'old server responses retain conservative fallback behavior')
assert.deepEqual([...historyLineStarts([[18000, 2], [36000, 3]], 5400, [[0, 0], [18000, 1], [36000, 1]])], [0], 'viewport filtering preserves source segment identity')
assert.deepEqual(historySampleStats([[t, 2], [t + 1000, 10], [t + 2000, null]]), { min: 2, max: 10, last: null }, 'invalid final sample must not reuse the last valid reading')
assert.deepEqual(historySampleStats([[t, null]]), { min: Infinity, max: -Infinity, last: null })
assert.deepEqual(historySampleStats([]), { min: Infinity, max: -Infinity, last: null })
assert.deepEqual(historySampleStats([[t, 0]]), { min: 0, max: 0, last: 0 })
assert.equal(historySampleStats([[t, null], [t + 1000, -5]]).last, -5, 'a later valid sample recovers the last reading')
const r = { id: 1, groupId: 1, startAddress: 0, dataType: 'uint16', functionCode: 3 }
const p = (offset: number, address: number, rawValue: number, area = 'holding-register'): HistoryPoint => ({ ts: new Date(t + offset).toISOString(), area, address, rawValue })
const result = decodeHistorySeries([r, { ...r, id: 2, groupId: 2, functionCode: 4 }], [p(1000, 0, 10), p(0, 0, 2), p(0, 0, 50, 'input-register')], new Set([1, 2]))
assert.deepEqual(result.find(s => s.id === 1)!.samples, [[t, 2], [t + 1000, 10]])
assert.deepEqual(result.find(s => s.id === 2)!.samples, [[t, 50]])
assert.deepEqual(nearestHistorySample(result[0].samples, t + 800), [t + 1000, 10])
assert.equal(nearestHistorySample([], t), undefined)
const wide = decodeHistorySeries([{ ...r, dataType: 'uint32' }], [p(0, 0, 1), p(0, 1, 2), p(1000, 0, 2)], new Set([1]))
assert.deepEqual(wide[0].samples, [[t, 65538], [t + 1000, null]], 'incomplete multiword data breaks the line')
assert.equal(decodeHistorySeries([{ ...r, dataType: 'hex16' }], [p(0, 0, 1)], new Set([1])).length, 0)
assert.equal(decodeHistorySeries([r], [p(0, 0, 1)], new Set()).length, 0)
assert.equal(decodeHistorySeries([r], [{ ...p(0, 0, 1), ts: 'invalid' }], new Set([1])).length, 0)
const gaps = decodeHistorySeries([r], [0, 1000, 2000, 3000, 60000].map(n => p(n, 0, n)), new Set([1]))
assert.equal(gaps[0].gapMs, 3000)
console.log('HISTORY CURVE TEST OK: area separation, ordered timestamps, nearest reads, partial words, missing data and gaps')
