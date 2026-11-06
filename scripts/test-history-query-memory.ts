import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { HistoryQueryMemory, QueryMemoryError, queryMemoryContext, rememberedQueryCompatibility, type RememberedQueryInput } from '../apps/web/src/history-query-memory.ts'
import { HistoryQueryMemoryView, HistoryQueryMemoryPanel } from '../apps/web/src/HistoryQueryMemory.tsx'
import { historyTimeRange, resolveHistoryTimeRange } from '../apps/web/src/history-time-range.ts'
import { historyQueryPlan } from '../apps/web/src/history-query-task.ts'

const device = { id: 7, mode: 'master', transport: 'tcp', ip: 'synthetic.invalid', port: 502, serialPath: null, baudRate: 9600, parity: 'none', stopBits: 1, dataBits: 8, flowControl: 'none', slaveId: 1 }
const points = [1, 2].map(n => ({ id: n * 101, objectId: 7, groupId: n * 10, alias: '温度', functionCode: 3, startAddress: 0, dataType: 'uint32', slaveId: n, factor: 0, offset: 2, unit: '℃', enumJson: null, decimalPlaces: 2 }))
const input: RememberedQueryInput = { start: Date.parse('2026-11-06T00:00:00.123Z'), end: Date.parse('2026-11-06T00:00:00.987Z'), mode: 'chart', valueMode: 'physical', inputZone: 'local', scope: 'viewport', registerIds: [202, 101] }
const context = queryMemoryContext(device, points), book = new HistoryQueryMemory(7), before = JSON.stringify({ device, points, input })
let notifications = 0
const unsubscribe = book.subscribe(() => notifications++)
const saved = book.save('  故障窗口  ', input, context, true, input.end)
assert.equal(saved.added, true); assert.equal(saved.entry.name, '故障窗口'); assert.equal(notifications, 1)
assert.deepEqual(saved.entry.points.map(p => [p.id, p.source]), [[101, 1], [202, 2]], 'same alias/address from different sources retain exact IDs')
assert.equal(JSON.stringify({ device, points, input }), before, 'capture does not mutate caller state')
assert.ok(Object.isFrozen(saved.entry) && Object.isFrozen(saved.entry.points) && Object.isFrozen(saved.entry.points[0]) && Object.isFrozen(book.snapshot()))
assert.equal(book.save('故障窗口', { ...input, registerIds: [101, 202] }, queryMemoryContext(device, [...points].reverse()), true).entry, saved.entry)
assert.equal(notifications, 1, 'double-save and catalog order do not duplicate conditions')
assert.equal(book.save('其他名称', input, context, true).added, true)
assert.equal(book.save('故障窗口', { ...input, end: input.end + 1 }, context, true).added, true)
unsubscribe()
const remount = book.snapshot(); let remountNotices = 0
const unsubscribeAgain = book.subscribe(() => remountNotices++)
assert.equal(book.snapshot(), remount, 'unsubscribe/remount retains device-owned memory')
assert.equal(new HistoryQueryMemory(8).snapshot().length, 0, 'another device has an independent empty lifetime')
let restored = 0
book.restore(saved.entry.id, context, true, q => {
  restored++
  const range = resolveHistoryTimeRange(historyTimeRange(q.start, q.end, q.inputZone))
  assert.equal(range.end - range.start, 864)
  const plan = historyQueryPlan({ objectId: q.deviceId, start: range.start, end: range.end, mode: q.mode, page: 0, registerIds: q.points.map(p => p.id) })
  const url = new URL(plan.url, 'http://example.invalid')
  assert.equal(url.searchParams.get('start'), '2026-11-06T00:00:00.123Z'); assert.equal(url.searchParams.get('end'), '2026-11-06T00:00:00.987Z')
})
assert.equal(restored, 1)
const draft = { unchanged: true }
function rejected(next = context, ready = true, code = 'points-changed') {
  assert.throws(() => book.restore(saved.entry.id, next, ready, () => { draft.unchanged = false }), e => e instanceof QueryMemoryError && e.code === code)
  assert.equal(draft.unchanged, true, 'incompatible restoration must not apply any part of the query')
}
rejected(queryMemoryContext(device, points.slice(1)))
rejected(queryMemoryContext(device, [{ ...points[0], id: 999 }, points[1]]))
for (const patch of [{ slaveId: 2 }, { sourceAmbiguous: true }, { groupId: 999 }, { functionCode: 4 }, { startAddress: 1 }, { dataType: 'uint16' }, { factor: 1 }, { offset: 0 }, { unit: 'K' }, { enumJson: '{"0":"off"}' }, { decimalPlaces: 0 }, { alias: 'renamed' }]) rejected(queryMemoryContext(device, [{ ...points[0], ...patch }, points[1]]))
for (const patch of [{ mode: 'slave' }, { transport: 'rtu' }, { ip: 'other.invalid' }, { port: 503 }, { serialPath: 'MOCK-A' }, { baudRate: 19200 }, { parity: 'even' }, { stopBits: 2 }, { dataBits: 7 }, { flowControl: 'rtscts' }]) rejected(queryMemoryContext({ ...device, ...patch }, points), true, 'device-changed')
rejected(queryMemoryContext({ ...device, id: 8 }, []), true, 'device-changed')
rejected(queryMemoryContext(device, []), false, 'waiting')
rejected(queryMemoryContext(device, [...points, points[0]]))
assert.deepEqual(rememberedQueryCompatibility(saved.entry, queryMemoryContext(device, [points[1]]), true).missing, [101])
const unrelated = queryMemoryContext({ ...device, name: 'renamed', isActive: 0, pollIntervalMs: 999 } as typeof device, [...points, { ...points[0], id: 303 }])
assert.equal(rememberedQueryCompatibility(saved.entry, unrelated, true).kind, 'ready', 'unselected additions and sampling state do not change a condition template')
assert.equal(rememberedQueryCompatibility(saved.entry, queryMemoryContext({ ...device, slaveId: 2 }, points), true).kind, 'ready', 'master source follows points, not device default')
const slaveContext = queryMemoryContext({ ...device, mode: 'slave' }, points), slaveBook = new HistoryQueryMemory(7)
const slaveQuery = slaveBook.save('slave', input, slaveContext, true).entry
assert.equal(rememberedQueryCompatibility(slaveQuery, queryMemoryContext({ ...device, mode: 'slave', slaveId: 2 }, points), true).kind, 'device-changed')
const stable = book.snapshot()
for (const bad of [{ start: NaN }, { end: input.start }, { start: 0.1 }, { end: Infinity }, { mode: 'unknown' }, { valueMode: 'unknown' }, { inputZone: 'unknown' }, { scope: 'unknown' }, { mode: 'table', scope: 'viewport' }, { registerIds: [] }, { registerIds: [101, 101] }, { registerIds: [999] }, { registerIds: [0] }, { registerIds: ['101'] }]) {
  assert.throws(() => book.save('bad', { ...input, ...bad } as RememberedQueryInput, context, true), QueryMemoryError)
  assert.equal(book.snapshot(), stable)
}
assert.throws(() => book.save('  ', input, context, true), e => e instanceof QueryMemoryError && e.code === 'invalid-name')
assert.throws(() => book.save('wait', input, context, false), e => e instanceof QueryMemoryError && e.code === 'waiting')
assert.throws(() => book.save('other', input, queryMemoryContext({ ...device, id: 8 }, []), true))
assert.throws(() => book.save('invalid', input, queryMemoryContext(device, [{ ...points[0], factor: NaN }, points[1]]), true))
book.remove(99999); assert.equal(book.snapshot(), stable)
assert.equal(remountNotices, 0)
book.remove(saved.entry.id); assert.equal(remountNotices, 1)
assert.throws(() => book.restore(saved.entry.id, context, true, () => assert.fail('removed')), e => e instanceof QueryMemoryError && e.code === 'missing')
unsubscribeAgain()

const projected = queryMemoryContext({ ...device, apiKey: 'PRIVATE-EXTRA' } as typeof device, points.map(p => ({ ...p, rawValue: 'PRIVATE-EXTRA' })))
assert.ok(!JSON.stringify(new HistoryQueryMemory(7).save('known-fields', input, projected, true).entry).includes('PRIVATE-EXTRA'), 'no arbitrary device fields or sample values captured')
const unknownPoints = points.map(p => ({ ...p, slaveId: undefined, sourceAmbiguous: true }))
const unknownBook = new HistoryQueryMemory(7), unknown = unknownBook.save('unknown', input, queryMemoryContext(device, unknownPoints), true)
assert.ok(unknown.entry.points.every(p => p.source === null && p.sourceAmbiguous))
assert.equal(rememberedQueryCompatibility(unknown.entry, queryMemoryContext(device, points), true).kind, 'points-changed', 'unknown configured identity is never inferred later')
const priorTZ = process.env.TZ
try {
  process.env.TZ = 'America/New_York'
  const dst = new HistoryQueryMemory(7).save('repeat', { ...input, start: Date.parse('2026-11-01T05:30:00.000Z'), end: Date.parse('2026-11-01T06:30:00.000Z') }, context, true).entry
  process.env.TZ = 'Asia/Kathmandu'
  const dstRange = resolveHistoryTimeRange(historyTimeRange(dst.start, dst.end, dst.inputZone))
  assert.equal(dstRange.start, dst.start); assert.equal(dstRange.end - dstRange.start, 3600000)
} finally { if (priorTZ === undefined) delete process.env.TZ; else process.env.TZ = priorTZ }

let actions = 0
const props = { entries: unknownBook.snapshot(), context: queryMemoryContext(device, unknownPoints), ready: true, canSave: true, canViewport: true, onSave: () => { actions++; return { added: true } }, onRestore: () => actions++, onRemove: () => actions++ }
const render = (extra = {}) => renderToStaticMarkup(createElement(HistoryQueryMemoryView, { ...props, ...extra }))
assert.ok(render({ entries: [] }).includes('尚无暂存条件'))
assert.ok(render().includes('配置来源<!-- -->') || render().includes('配置来源'))
assert.ok(render().includes('未知')); assert.ok(render().includes('视窗→完整区间'))
assert.ok(render({ english: true }).includes('Apply and query again'))
assert.ok(render({ ready: false }).includes('配置尚未就绪'))
assert.ok(render({ context: queryMemoryContext(device, []) }).includes('缺失: 2'))
assert.ok(render({ context: queryMemoryContext({ ...device, port: 503 }, unknownPoints) }).includes('设备连接配置已变化'))
const largePoints = Array.from({ length: 10000 }, (_, i) => ({ ...points[0], id: i + 1 })), largeContext = queryMemoryContext(device, largePoints), largeBook = new HistoryQueryMemory(7)
for (let i = 0; i < 7; i++) largeBook.save(i === 6 ? '<script>alert(1)</script>' : 'query-' + i, { ...input, registerIds: largePoints.map(p => p.id) }, largeContext, true)
const markup = render({ entries: largeBook.snapshot(), context: largeContext })
assert.equal(largeBook.snapshot()[0].points.length, 10000, 'metadata is not silently truncated')
assert.equal((markup.match(/class="query-memory-entry"/g) ?? []).length, 5, 'query cards are paginated')
assert.equal((markup.match(/<li>/g) ?? []).length, 100, 'point definitions are paginated per card')
assert.ok(markup.includes('10000')); assert.ok(markup.includes('1/2')); assert.ok(markup.includes('1/500'))
assert.ok(markup.includes('&lt;script&gt;')); assert.ok(!markup.includes('<script>'))
assert.ok(renderToStaticMarkup(createElement(HistoryQueryMemoryPanel, { ...props, memory: unknownBook })).includes('unknown'))
assert.equal(actions, 0, 'rendering and compatibility checks never invoke query actions')
console.log('History query memory: exact ranges, device lifetime, all-or-nothing compatibility, sources, validation, projection, pagination and bilingual SSR passed.')
