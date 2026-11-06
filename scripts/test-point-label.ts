import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PointLabel, buildPointLabels, type LabelPoint } from '../apps/web/src/PointLabel.tsx'
import { HistoryQualitySummary } from '../apps/web/src/HistoryQualitySummary.tsx'
import type { HistorySeries } from '../apps/web/src/history-curve.ts'

// Pure render only: the same alias/address must remain identifiable after selection.
const render = (id: number, source: number) => renderToStaticMarkup(createElement(PointLabel, { label: { name: '温度', detail: `从站 ${source} · FC3 · 地址 0 · #${id}`, qualified: true } }))
assert.match(render(11, 1).replace(/<[^>]*>/g, ''), /从站 1.*#11/)
assert.match(render(22, 2).replace(/<[^>]*>/g, ''), /从站 2.*#22/)
assert.notEqual(render(11, 1), render(22, 2))

const t = (key: string) => ({ pointSource: '配置从站', pointSourceUnknown: '配置来源未知', colAddr: '地址' }[key] ?? key)
const groups = Object.freeze([{ id: 1, slaveId: 1 }, { id: 2, slaveId: 2 }, { id: 3 }].map(Object.freeze))
const points: readonly LabelPoint[] = Object.freeze([
  { id: 11, groupId: 1, alias: '温度', startAddress: 0, functionCode: 3 },
  { id: 22, groupId: 2, alias: '温度', startAddress: 0, functionCode: 3 },
  { id: 23, groupId: 2, alias: '温度', startAddress: 0, functionCode: 4 },
  { id: 24, groupId: 2, alias: '温度', startAddress: 0, functionCode: 3 },
  { id: 33, groupId: 3, alias: '速度', startAddress: 4, functionCode: 3 },
  { id: 34, groupId: 999, alias: ' 速度 ', startAddress: 4, functionCode: 3 },
  { id: 41, groupId: 1, alias: null, startAddress: 8, functionCode: 3 },
  { id: 42, groupId: 2, alias: ' ', startAddress: 8, functionCode: 3 },
  { id: 51, groupId: 1, alias: 'Unique', startAddress: 9, functionCode: 3 },
  { id: 52, groupId: 2, alias: 'unique', startAddress: 10, functionCode: 3 },
  { id: 61, groupId: 1, alias: 'A<&"' + '长名称'.repeat(60), startAddress: 12, functionCode: 3 },
].map(Object.freeze))
const before = JSON.stringify({ groups, points }), labels = buildPointLabels(points, groups, t)
const text = (id: number) => renderToStaticMarkup(createElement(PointLabel, { label: labels.get(id)! }))
assert.match(text(11), /配置从站 1.*#11/); assert.match(text(22), /配置从站 2.*#22/)
assert.match(text(23), /FC4/); assert.match(text(24), /#24/)
assert.notEqual(text(22), text(24), 'same source/address/function semantic definitions remain distinct by ID')
assert.ok([11, 22, 23, 24, 33, 34, 41, 42, 51, 52].every(id => labels.get(id)!.qualified))
assert.match(text(34), /配置来源未知/); assert.doesNotMatch(text(34), /配置从站 1/)
assert.equal(labels.get(41)!.name, '#8'); assert.equal(labels.get(42)!.name, '#8')
assert.equal(labels.get(61)!.qualified, false)
assert.doesNotMatch(text(61), /point-label-detail/, 'unique labels stay concise with complete identity in the tooltip')
assert.match(text(61), /A&lt;&amp;&quot;/)
assert.match(text(61), /title=.*配置从站 1.*#61/)
assert.equal(buildPointLabels([], groups, t).size, 0)
const local = buildPointLabels(points, groups, t, 7)
assert.ok([...local.values()].every(label => label.detail.startsWith('配置从站 7')))
assert.ok([...buildPointLabels(points, groups, t, NaN).values()].every(label => label.detail.startsWith('配置来源未知')))
assert.match(buildPointLabels(points, [{ id: 1, slaveId: 0 }], t).get(11)!.detail, /配置从站 0/)
assert.match(buildPointLabels(points, [{ id: 1, slaveId: 256 }], t).get(11)!.detail, /配置来源未知/)
assert.match(buildPointLabels(points, groups, key => ({ pointSource: 'Configured slave', colAddr: 'Address' }[key] ?? key)).get(22)!.detail, /Configured slave 2.*Address 0/)
// Stable labels are computed against the complete point list, not the selected/visible series.
assert.equal(labels.get(11)!.qualified, true)
assert.equal(JSON.stringify({ groups, points }), before, 'presentation cannot mutate current configuration')
const series: HistorySeries[] = [11, 22].map(id => ({ id, samples: [[1, null]], gapMs: 1000,
  summary: { sourceSamples: 1, validSamples: 0, invalidSamples: 1 }, integrity: { verified: 0, unverified: 0, unknown: 1 } }))
const seriesBefore = JSON.stringify(series)
const summary = renderToStaticMarkup(createElement(HistoryQualitySummary, { t, series, registers: [...points], pointLabels: labels }))
assert.match(summary.replace(/<[^>]*>/g, ''), /配置从站 1.*#11.*配置从站 2.*#22/)
assert.equal(JSON.stringify(series), seriesBefore, 'labels do not change sample values or integrity counts')
assert.equal(renderToStaticMarkup(createElement(HistoryQualitySummary, { t, series: [], registers: [] })), '')
console.log('POINT LABEL OK: source/FC/address/ID disambiguation, same-source definitions, stable duplicate names, unknown/local configuration, escaped long aliases, translations, quality-summary integration and unchanged sample integrity; pure SSR only')
