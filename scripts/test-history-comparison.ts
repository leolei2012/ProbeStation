import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { captureHistoryAnchor, compareHistoryAnchors, historyComparisonContext, updateHistoryComparison } from '../apps/web/src/history-comparison.ts'
import { HistoryComparison } from '../apps/web/src/HistoryComparison.tsx'
import type { HistorySeries } from '../apps/web/src/history-curve.ts'
import { curveValue } from '../apps/web/src/physical-value.ts'

const series: HistorySeries[] = [1, 2].map(id => ({ id, samples: [[1000, id * 10], [2000, id * 20], [3000, id * 30]], gapMs: 3000,
  segments: [[1000, 0], [2000, 0], [3000, 0]], verification: [[1000, 'verified'], [2000, id === 1 ? 'verified' : 'unverified'], [3000, 'verified']] }))
const before = JSON.stringify(series), a = captureHistoryAnchor(1500, series), b = captureHistoryAnchor(2500, series)
assert.equal(a.time, 1500); assert.equal(a.readings[0].time, 1000, 'ties choose an actual earlier display sample without interpolation')
assert.equal(a.readings[0].value, 10)
assert.deepEqual(compareHistoryAnchors(a, b).map(row => [row.id, row.difference, row.elapsed]), [[1, 10, 1000], [2, 20, 1000]], 'same-name/source points are compared only by their own ID')
assert.equal(b.readings[1].verification, 'unverified', 'compatibility endpoint status stays visible, never promoted to verified')
assert.deepEqual(compareHistoryAnchors(b, a).map(row => row.difference), [-10, -20])
assert.equal(compareHistoryAnchors(a, a)[0].difference, 0)
assert.equal(compareHistoryAnchors(b, a)[0].elapsed, -1000)
assert.equal(compareHistoryAnchors(a, captureHistoryAnchor(2200, series))[0].elapsed, 1000, 'actual sample elapsed is independent of cursor elapsed (700ms here)')
assert.equal(compareHistoryAnchors(a, null)[0].difference, null)
assert.deepEqual(compareHistoryAnchors(null, null), [])
assert.equal(JSON.stringify(series), before)
series[0].samples[0][1] = 999
assert.equal(a.readings[0].value, 10, 'later zoom/refresh data cannot change a captured endpoint')
assert.ok(Object.isFrozen(a)); assert.ok(Object.isFrozen(a.readings[0]))
for (const time of [0, 4000]) assert.equal(captureHistoryAnchor(time, series).readings[0].value, null, 'no extrapolation outside queried samples')
const gap: HistorySeries = { id: 1, samples: [[0, 1], [10000, 20]], gapMs: 30000, segments: [[0, 0], [10000, 1]] }
assert.equal(captureHistoryAnchor(5000, [gap]).readings[0].value, null, 'source segments prevent bridging a gap even when downsample spacing is large')
assert.equal(captureHistoryAnchor(10000, [gap]).readings[0].value, 20)
assert.equal(captureHistoryAnchor(5000, [{ ...gap, segments: [[0, 0], [10000, 0]], sourceGapMs: 3 }]).readings[0].time, 0, 'continuous downsampled data selects a retained sample and exposes its real time')
assert.equal(captureHistoryAnchor(5000, [{ ...gap, segments: undefined, gapMs: 1000 }]).readings[0].value, null)
assert.equal(captureHistoryAnchor(5000, [{ ...gap, segments: undefined, gapMs: Infinity }]).readings[0].value, null, 'unknown spacing cannot imply continuity')
assert.equal(captureHistoryAnchor(0, [{ ...gap, segments: undefined, gapMs: Infinity }]).readings[0].value, 1)
const invalidMiddle: HistorySeries = { id: 1, samples: [[0, 1], [1000, null], [2000, 3]], gapMs: 3000 }
assert.equal(captureHistoryAnchor(500, [invalidMiddle]).readings[0].value, null, 'do not associate a sample across an invalid boundary')
assert.equal(captureHistoryAnchor(1500, [invalidMiddle]).readings[0].value, null)
for (const samples of [[[0, null]], [[0, NaN]], [[0, Infinity]], [[1, 1], [0, 2]], [[0, 1], [0, 2]]] as Array<Array<[number, number | null]>>) {
  assert.equal(captureHistoryAnchor(0, [{ id: 1, samples, gapMs: 1000 }]).readings[0].value, null)
}
assert.equal(captureHistoryAnchor(1000, [{ ...gap, samples: [[1000, 3]], verification: [[1000, 'unknown']] }]).readings[0].value, null)
assert.equal(captureHistoryAnchor(0, [gap, gap]).readings[0].value, null, 'ambiguous duplicate series IDs remain unknown')
assert.equal(captureHistoryAnchor(0, []).readings.length, 0)
assert.throws(() => captureHistoryAnchor(NaN, series))
const hugeA = captureHistoryAnchor(0, [{ id: 1, samples: [[0, -Number.MAX_VALUE]], gapMs: 1 }]), hugeB = captureHistoryAnchor(0, [{ id: 1, samples: [[0, Number.MAX_VALUE]], gapMs: 1 }])
assert.equal(compareHistoryAnchors(hugeA, hugeB)[0].difference, null, 'non-finite differences are not reported as measurements')
const physical = series.map(s => ({ ...s, samples: s.samples.map(([time, value]): [number, number | null] => [time, curveValue(value, { dataType: 'uint16', factor: .1, offset: -5 }, 'physical')]) }))
assert.equal(compareHistoryAnchors(captureHistoryAnchor(2000, physical), captureHistoryAnchor(3000, physical))[0].difference, 1)

const points = [1, 2].map(id => ({ id, alias: '温度', slaveId: id, dataType: 'uint16', functionCode: 3, startAddress: 0, factor: 0, offset: 1, unit: '℃', decimalPlaces: 1 }))
const key = historyComparisonContext(points, { start: 0, end: 4000 }, 'raw', new Set())
assert.equal(historyComparisonContext([...points].reverse(), { start: 0, end: 4000 }, 'raw', new Set()), key)
for (const change of [{ factor: 1 }, { slaveId: 3 }, { dataType: 'float32' }, { alias: 'changed' }, { sourceAmbiguous: true }]) assert.notEqual(historyComparisonContext([{ ...points[0], ...change }, points[1]], { start: 0, end: 4000 }, 'raw', new Set()), key)
assert.notEqual(historyComparisonContext(points, { start: 0, end: 4000 }, 'physical', new Set()), key)
assert.notEqual(historyComparisonContext(points, { start: 0, end: 4001 }, 'raw', new Set()), key)
assert.notEqual(historyComparisonContext(points, { start: 0, end: 4000 }, 'raw', new Set([1])), key)
let state = { context: key, a: null, b: null } as Parameters<typeof updateHistoryComparison>[0]
state = updateHistoryComparison(state, { type: 'capture', context: key, slot: 'a', anchor: a })
state = updateHistoryComparison(state, { type: 'capture', context: key, slot: 'b', anchor: b })
assert.equal(updateHistoryComparison(state, { type: 'context', context: key }), state, 'same-context query refresh keeps frozen snapshots')
assert.equal(updateHistoryComparison(state, { type: 'context', context: 'changed' }).a, null)
assert.equal(updateHistoryComparison(state, { type: 'clear', context: key }).b, null)
const changedCapture = updateHistoryComparison(state, { type: 'capture', context: 'changed', slot: 'b', anchor: b })
assert.equal(changedCapture.a, null); assert.equal(changedCapture.b, b)
let mutations = 0
const render = (pair = state, canCapture = true) => renderToStaticMarkup(createElement(HistoryComparison, { state: pair, canCapture,
  t: key => key, pointLabels: new Map(points.map(p => [p.id, { name: '<温度>', detail: `配置从站 ${p.slaveId} · #${p.id}`, qualified: true }])), formatTime: time => new Date(time).toISOString(), formatValue: (_id, value) => value + ' ℃', onCapture() { mutations++ }, onClear() { mutations++ } }))
const html = render()
assert.match(html, /配置从站 1/); assert.match(html, /配置从站 2/); assert.match(html, /10 ℃/); assert.match(html, /1\.000 s/)
assert.match(html, /批次\/来源未验证/); assert.match(html, /&lt;温度&gt;/)
assert.match(render({ context: key, a: null, b: null }, false), /disabled=""/)
assert.match(render({ ...state, b: null }), /histCompareNoSample/)
const opened = renderToStaticMarkup(createElement(HistoryComparison, { state, canCapture: false, t: key => key, pointLabels: new Map(), formatTime: String, formatValue: (_id, value) => String(value), onCapture() {}, onClear() {}, open: true, onOpenChange() { mutations++ } }))
assert.match(opened, /open=""/)
assert.equal(mutations, 0, 'rendering cannot request data, write configuration or change anchors')
console.log('HISTORY COMPARISON OK: frozen actual displayed endpoints, signed per-ID/time differences, gaps/invalid/unknown metadata, downsampling/physical values, context invalidation and SSR states; no databases, models, hardware or network')
