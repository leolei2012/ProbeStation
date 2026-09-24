import assert from 'node:assert/strict'
import { decodeHistorySeries, nearestHistorySample, type HistoryPoint } from '../apps/web/src/history-curve.ts'

const t = Date.parse('2026-09-23T00:00:00Z')
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
