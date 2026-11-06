import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { planHistoryCurve } from '../packages/core/src/history-curve-plan.ts'
import { registerCurve } from '../packages/api/src/curve.ts'
import { historyQueryPlan, startHistoryQuery } from '../apps/web/src/history-query-task.ts'
import { HistoryCurveSelection } from '../apps/web/src/HistoryCurveSelection.tsx'
import { buildPointLabels } from '../apps/web/src/PointLabel.tsx'

const groups = [{ id: 10, name: 'G1', slaveId: 1, functionCode: 3, startAddress: 0, quantity: 6 }, { id: 20, name: 'G2', slaveId: 2, functionCode: 3, startAddress: 0, quantity: 4 }]
const p = (id: number, groupId: number, startAddress: number, dataType: string) => ({ id, objectId: 7, groupId, alias: '同名点', startAddress, dataType, functionCode: 3 })
const points = [p(1, 10, 0, 'uint32'), p(2, 10, 1, 'uint16'), p(3, 10, 2, 'hex16'), p(4, 10, 2, 'uint16'), p(5, 10, 4, 'uint64'), p(6, 10, 5, 'uint16'), p(7, 20, 0, 'bin32'), p(8, 20, 3, 'int16'), p(9, 999, 0, 'uint16')]
const before = JSON.stringify({ groups, points }), all = planHistoryCurve(groups, points)
assert.deepEqual(all.registers.map(r => r.id), [1, 8], 'same-address sources in separate groups are independent')
assert.deepEqual(all.entries, [
  { id: 1, reason: 'eligible' }, { id: 2, reason: 'covered', coveredBy: 1 }, { id: 3, reason: 'non-numeric' }, { id: 4, reason: 'covered', coveredBy: 3 },
  { id: 5, reason: 'past-group-end' }, { id: 6, reason: 'covered', coveredBy: 5 }, { id: 7, reason: 'non-numeric' }, { id: 8, reason: 'eligible' }, { id: 9, reason: 'missing-group' },
])
assert.equal(JSON.stringify({ groups, points }), before); assert.equal(all.registers[0], points[0], 'no rewriting or freezing of caller-owned point definitions')
assert.ok(Object.isFrozen(all) && Object.isFrozen(all.registers) && Object.isFrozen(all.entries) && Object.isFrozen(all.entries[0]))
const subset = planHistoryCurve(groups, points, [6, 4, 2, 3, 2, 999])
assert.deepEqual(subset.entries.map(entry => entry.id), [2, 3, 4, 6, 999])
assert.equal(subset.registers.length, 0); assert.equal(subset.entries.at(-1)!.reason, 'missing-point')
assert.equal(subset.entries.find(e => e.id === 2)!.coveredBy, 1, 'unselected definitions still participate in coverage')
assert.equal(subset.entries.find(e => e.id === 4)!.coveredBy, 3, 'a nonnumeric definition still blocks a later definition as before')
assert.equal(subset.entries.find(e => e.id === 6)!.coveredBy, 5, 'an overrun definition still blocks a later definition as before')
assert.deepEqual(planHistoryCurve(groups, points, []).entries, [])
assert.deepEqual(planHistoryCurve(groups, points, []).registers, [])
const reverseTie = planHistoryCurve(groups, [points[0], points[1], points[3], points[2], ...points.slice(4)])
assert.ok(reverseTie.registers.some(r => r.id === 4)); assert.equal(reverseTie.entries.find(e => e.id === 3)!.reason, 'covered', 'equal-address priority retains input order, never prefers a numeric point silently')
for (const dataType of ['uint16', 'float16', 'uint32', 'uint32-LE', 'float32-LE', 'uint64', 'uint64-LE', 'float64']) {
  const width = dataType.includes('64') ? 4 : dataType.includes('32') ? 2 : 1
  assert.equal(planHistoryCurve([{ id: 1, startAddress: 10, quantity: width }], [p(1, 1, 10, dataType)]).entries[0].reason, 'eligible')
  assert.equal(planHistoryCurve([{ id: 1, startAddress: 10, quantity: width }], [p(1, 1, 11, dataType)]).entries[0].reason, 'past-group-end')
}
for (const dataType of ['hex16', 'hex32-LE', 'hex64', 'bin16-LE', 'bin32', 'bin64-LE']) assert.equal(planHistoryCurve([{ id: 1, startAddress: 0, quantity: 4 }], [p(1, 1, 0, dataType)]).entries[0].reason, 'non-numeric')
assert.equal(planHistoryCurve([{ id: 1, startAddress: 10, quantity: 1 }], [p(1, 1, 0, 'uint16')]).entries[0].reason, 'eligible', 'preserve the old lower-bound behavior; this feature is not a protocol/configuration validator')
for (const [group, point] of [[{ id: 1, startAddress: 0, quantity: NaN }, p(1, 1, 0, 'uint16')], [{ id: 1, startAddress: NaN, quantity: 2 }, p(1, 1, 0, 'uint16')], [{ id: 1, startAddress: 0, quantity: 2 }, p(1, 1, NaN, 'uint16')]] as const) assert.equal(planHistoryCurve([group], [point]).registers.length, 0, 'an unordered boundary must retain the old <= rejection rather than becoming eligible')
const app = Fastify(), received: Array<Array<{ id: number; slaveId: number }>> = []
registerCurve(app, { getObject: (id: number) => id === 7 ? { id, mode: 'master', slaveId: 9 } : null, listGroups: () => groups, listRegistersByObject: () => points }, {
  queryRegisterCurve: async (_id: number, _start: string, _end: string, regs: Array<{ id: number; slaveId: number }>) => { assert.equal(Object.isFrozen(regs), false, 'the existing store port receives its own mutable register array'); received.push(regs); return { series: regs.map(r => ({ id: r.id, samples: [[0, r.slaveId * 10]], gapMs: null })), complete: true } },
})
const base = '/api/data/object/series?object_id=7&start=2026-11-06T00:00:00Z&end=2026-11-06T01:00:00Z'
try {
  const full = await app.inject(base); assert.equal(full.statusCode, 200); assert.deepEqual(full.json().series.map((s: any) => s.id), [1, 8])
  assert.deepEqual(received.at(-1)!.map(r => [r.id, r.slaveId]), [[1, 1], [8, 2]], 'API preserves configured source metadata and group order')
  const excluded = await app.inject(base + '&register_ids=2,3,5'); assert.equal(excluded.statusCode, 200); assert.deepEqual(excluded.json().series, [])
  assert.deepEqual(planHistoryCurve(groups, points, [2, 3, 5]).entries.map(e => e.reason), ['covered', 'non-numeric', 'past-group-end'], 'empty curve is explained by definition eligibility, not inferred missing history')
  const filtered = await app.inject(base + '&register_ids=8,1,1,3'); assert.deepEqual(filtered.json().series.map((s: any) => s.id), [1, 8])
  const normalized = await app.inject(base + '&register_ids=' + planHistoryCurve(groups, points, [8, 1, 1, 3]).registers.map(r => r.id).join(','))
  assert.deepEqual(normalized.json(), filtered.json(), 'sending only queryable IDs preserves the mixed-selection result')
  const empty = await app.inject(base + '&register_ids='); assert.deepEqual(empty.json().series, [])
  assert.equal((await app.inject(base + '&register_ids=999')).statusCode, 400, 'foreign/missing IDs remain a request error')
  assert.equal((await app.inject(base.replace('object_id=7', 'object_id=8'))).statusCode, 404)
} finally { await app.close() }
let fetches = 0
const queryInput = { objectId: 7, start: 1000, end: 2000, mode: 'chart' as const, page: 0, registerIds: planHistoryCurve(groups, points, [2, 3, 5]).registers.map(p => p.id) }
const noQuery = historyQueryPlan(queryInput); assert.equal(noQuery, null)
startHistoryQuery(noQuery, async () => { fetches++; return {} }, () => {})
assert.equal(fetches, 0, 'all-ineligible selection must not start even an empty curve read')
assert.equal(historyQueryPlan({ ...queryInput, mode: 'table', registerIds: [2, 3, 5] })!.selectionKey, '2,3,5', 'table keeps every selected ID rather than applying curve eligibility')
const mixed = planHistoryCurve(groups, points, [1, 2, 3, 8])
assert.equal(historyQueryPlan({ ...queryInput, registerIds: mixed.registers.map(p => p.id) })!.selectionKey, '1,8')
const t = (key: string) => ({ pointSource: '配置从站', colAddr: '地址', pointSourceUnknown: '来源未知' }[key] ?? key), labels = buildPointLabels(points, groups, t)
let actions = 0
const render = (plan = all, english = false, pointLabels = labels) => renderToStaticMarkup(createElement(HistoryCurveSelection, { plan, english, pointLabels, onTable: () => actions++ }))
assert.equal(render(planHistoryCurve(groups, points, [1, 8])), '')
const markup = render(); assert.ok(markup.includes('曲线选点说明')); assert.ok(markup.includes('未参与<!-- -->') || markup.includes('未参与'))
assert.ok(markup.includes('配置从站')); assert.ok(markup.includes('#1')); assert.ok(markup.includes('在历史表格查看'))
assert.ok(!markup.includes('<details class="history-curve-selection" open=""'), 'mixed exclusions are a compact expandable explanation')
const none = render(planHistoryCurve(groups, points, [2, 3, 5])); assert.ok(none.includes('open=""')); assert.ok(none.includes('未发起曲线读取')); assert.ok(none.includes('这不等于没有历史数据'))
assert.ok(render(all, true).includes('Curve selection details')); assert.ok(render(all, true).includes('Exact point ID not found'))
const many = Array.from({ length: 10000 }, (_, i) => p(i + 1, 10, i, 'hex16'))
const manyPlan = planHistoryCurve([{ id: 10, startAddress: 0, quantity: 10000 }], many)
assert.equal(manyPlan.entries.length, 10000)
const manyMarkup = render(manyPlan, false, new Map()); assert.equal((manyMarkup.match(/<li>/g) ?? []).length, 20); assert.ok(manyMarkup.includes('1/500')); assert.ok(manyMarkup.includes('10000'))
const escaped = buildPointLabels([{ ...points[2], alias: '<script>alert(1)</script>' }], groups, t)
assert.ok(render(planHistoryCurve(groups, [points[2]], [3]), false, escaped).includes('&lt;script&gt;'))
assert.equal(actions, 0, 'SSR never changes view/selection or starts any operation')
console.log('HISTORY CURVE SELECTION OK: explicit exclusion reasons, unchanged coverage/type/end precedence, exact boundaries/BE/LE, group/source isolation, real API parity/errors, all-ineligible skip, table preservation, 10000-point pagination and bilingual escaped SSR; mock only.')
