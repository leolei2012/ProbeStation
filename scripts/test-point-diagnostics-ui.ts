import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Fastify from 'fastify'
import { diagnosePointTable } from '../packages/core/src/point-diagnostics.ts'
import { registerPointDiagnostics } from '../packages/api/src/point-diagnostics.ts'
import { parsePointDiagnosticReport, PointDiagnosticsLoader, pointDiagnosticDownload, filterPointDiagnosticIssues, filterRelatedDiagnosticIds, type PointDiagnosticState, type PointDiagnosticSnapshot } from '../apps/web/src/point-diagnostics.ts'
import { PointDiagnosticsView } from '../apps/web/src/PointDiagnostics.tsx'
import { buildPointLabels } from '../apps/web/src/PointLabel.tsx'

const devices = [{ id: 7, mode: 'master', slaveId: 1 }]
const groups = [{ id: 10, objectId: 7, name: '冷机组', slaveId: 1, functionCode: 3, startAddress: 0, quantity: 2 }, { id: 20, objectId: 7, name: '第二来源', slaveId: 2, functionCode: 3, startAddress: 0, quantity: 2 }]
const points = [
  { id: 101, objectId: 7, groupId: 10, slaveId: 1, alias: '温度', dataType: 'uint32', functionCode: 3, startAddress: 1 },
  { id: 102, objectId: 7, groupId: 10, slaveId: 1, alias: '温度', dataType: 'uint16', functionCode: 3, startAddress: 1 },
  { id: 103, objectId: 7, groupId: 20, slaveId: 2, alias: '温度', dataType: 'uint16', functionCode: 3, startAddress: 1 },
]
const report = diagnosePointTable({ devices, groups, registers: points }), before = JSON.stringify(report)
assert.ok(report.summary.errors > 0 && report.summary.warnings > 0)
assert.deepEqual(parsePointDiagnosticReport(report, 7), report, 'real producer report preserves structure and all issue references')
const app = Fastify(), calls: string[] = []
registerPointDiagnostics(app, {
  getObject(id: number) { calls.push('device:' + id); return id === 7 ? devices[0] : null },
  listGroups(id: number) { calls.push('groups:' + id); return groups },
  listRegistersByObject(id: number) { calls.push('points:' + id); return points },
})
const actual = await app.inject('/api/monitor_objects/7/point-diagnostics')
assert.equal(actual.statusCode, 200); assert.deepEqual(parsePointDiagnosticReport(actual.json(), 7), report)
assert.deepEqual(calls, ['device:7', 'groups:7', 'points:7'], 'API needs only metadata ports, no drivers or history')
await app.close()
for (const invalid of [null, {}, { ...report, complete: false }, { ...report, scope: 'unknown' }, { ...report, ok: !report.ok }, { ...report, summary: { ...report.summary, errors: 0 } }, { ...report, summary: { ...report.summary, registers: '3' } }, { ...report, issues: [{ severity: 'error', code: 'X', message: 'm', objectId: 99 }] }]) assert.throws(() => parsePointDiagnosticReport(invalid, 7))
const changed = (patch: any) => ({ ...report, issues: report.issues.map((issue, index) => index === 0 ? { ...issue, ...patch } : issue) })
for (const patch of [{ registerIds: [0] }, { registerIds: ['101'] }, { groupId: -1 }, { path: {} }, { severity: 'fatal' }, { severity: ['error'] }, { area: ['coil'] }, { area: 'holding' }, { slaveId: 256 }, { message: null }]) assert.throws(() => parsePointDiagnosticReport(changed(patch), 7))
for (const area of ['coil', 'discrete-input', 'holding-register', 'input-register']) assert.ok(parsePointDiagnosticReport(changed({ area }), 7))
const projected = parsePointDiagnosticReport({ ...report, connectionSecret: 'private-extra', summary: { ...report.summary, private: 'private-extra' }, issues: report.issues.map(i => ({ ...i, private: 'private-extra' })) }, 7)
assert.ok(!JSON.stringify(projected).includes('private-extra'), 'only diagnostic allowlist fields enter the UI/export snapshot')

const labels = buildPointLabels(points, groups, key => ({ pointSource: '配置从站', colAddr: '地址' }[key] ?? key))
assert.deepEqual(filterRelatedDiagnosticIds([101, 102, 103, 999, 101], '', points, labels), [101, 102, 103, 999], 'unknown references remain visible, never remapped to another point')
assert.deepEqual(filterRelatedDiagnosticIds([101, 102, 103], '配置从站 2', points, labels), [103], 'same-name points can be located by configured source')
assert.deepEqual(filterRelatedDiagnosticIds([101, 102, 103, 999], '#999', points, labels), [999])
assert.deepEqual(filterRelatedDiagnosticIds([101, 102, 103], '#10', points, labels), [], 'exact IDs do not prefix-match')
assert.deepEqual(filterRelatedDiagnosticIds([101, 102, 103], 'uint32', points, labels), [101])
assert.equal(filterPointDiagnosticIssues(report, 'error', '', points, groups).length, report.summary.errors)
assert.equal(filterPointDiagnosticIssues(report, 'warning', '', points, groups).length, report.summary.warnings)
assert.ok(filterPointDiagnosticIssues(report, 'all', '#103', points, groups).some(i => i.registerIds?.includes(103)))
assert.deepEqual(filterPointDiagnosticIssues(report, 'all', '#999', points, groups), [])
assert.ok(filterPointDiagnosticIssues(report, 'all', '冷机组', points, groups).length)
assert.ok(filterPointDiagnosticIssues(report, 'all', 'WIDTH_OUTSIDE', points, groups).some(i => i.code === 'REGISTER_WIDTH_OUTSIDE_GROUP'))
assert.equal(filterPointDiagnosticIssues(report, 'all', '  温度 ', points, groups).length, filterPointDiagnosticIssues(report, 'all', '', points, groups).filter(i => i.registerIds?.length).length)
assert.equal(JSON.stringify(report), before, 'filtering cannot alter or repair definitions/report')

const states: PointDiagnosticState[] = [], loader = new PointDiagnosticsLoader(state => states.push(state), 1000)
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
let requestCount = 0, oldSignal: AbortSignal | undefined
const old = deferred<unknown>(), started = deferred<void>()
const first = loader.refresh(7, async (url, signal) => { requestCount++; assert.equal(url, '/api/monitor_objects/7/point-diagnostics'); oldSignal = signal; started.resolve(); return old.promise })
await started.promise
await loader.refresh(7, async () => { requestCount++; return report })
assert.equal(oldSignal?.aborted, true)
assert.equal(states.at(-1)?.status, 'ready')
const accepted = states.at(-1), acceptedCount = states.length
old.resolve({ invalid: true }); await first
assert.equal(states.length, acceptedCount, 'late obsolete response is ignored even if fetch ignores abort')
assert.equal(requestCount, 2, 'refresh never polls or writes')
assert.equal(accepted!.snapshot!.deviceId, 7)
assert.ok(Number.isFinite(Date.parse(accepted!.snapshot!.receivedAt)))
const switched = deferred<unknown>(), switching = deferred<void>()
const previousDevice = loader.refresh(7, async () => { switching.resolve(); return switched.promise })
await switching.promise
await loader.refresh(8, async () => diagnosePointTable({ devices: [{ ...devices[0], id: 8 }], groups: [], registers: [] }))
const atSwitch = states.length
switched.resolve(report); await previousDevice
assert.equal(states.length, atSwitch); assert.equal(states.at(-1)?.snapshot?.deviceId, 8, 'old device cannot publish a valid but wrong-device report')
await loader.refresh(8, async () => { throw new Error('mock HTTP 503 with private detail') })
assert.equal(states.at(-1)?.error, 'failed'); assert.equal(states.at(-1)?.snapshot, null, 'failed refresh cannot expose stale successful report')
assert.ok(!JSON.stringify(states.at(-1)).includes('private'))
await loader.refresh(7, async () => ({ ...report, complete: false }))
assert.equal(states.at(-1)?.error, 'invalid')
await loader.refresh(7, async () => report); assert.equal(states.at(-1)?.status, 'ready', 'failure recovers on explicit retry')
const pending = deferred<void>(), hanging = loader.refresh(7, async () => { pending.resolve(); return new Promise(() => {}) })
await pending.promise; loader.cancel(); const atCancel = states.length; await hanging
assert.equal(states.length, atCancel, 'unmount/device change prevents all later callbacks')
let badFetched = false
await loader.refresh(0, async () => { badFetched = true; return report }); assert.equal(badFetched, false)
const timeoutStates: PointDiagnosticState[] = [], timeoutLoader = new PointDiagnosticsLoader(state => timeoutStates.push(state), 5)
let timedSignal: AbortSignal | undefined
await timeoutLoader.refresh(7, async (_url, signal) => { timedSignal = signal; return new Promise(() => {}) })
assert.equal(timeoutStates.at(-1)?.error, 'timeout'); assert.equal(timedSignal?.aborted, true)
await timeoutLoader.refresh(7, async () => report); assert.equal(timeoutStates.at(-1)?.status, 'ready')

const snapshot: PointDiagnosticSnapshot = { deviceId: 7, requestedAt: '2026-11-06T01:00:00.000Z', receivedAt: '2026-11-06T01:00:01.000Z', report }
const downloaded = JSON.parse(pointDiagnosticDownload(snapshot))
assert.equal(downloaded.format, 'probestation-point-diagnostics'); assert.equal(downloaded.version, 1)
assert.deepEqual(downloaded.report, report, 'download keeps all errors/warnings regardless of UI filters/pages')
assert.deepEqual(Object.keys(downloaded).sort(), ['deviceId', 'format', 'receivedAt', 'report', 'requestedAt', 'version'])
let actions = 0
const render = (state: PointDiagnosticState, filter = { severity: 'all' as const, query: '' }, page = 0) => renderToStaticMarkup(createElement(PointDiagnosticsView, { state, points, groups, pointLabels: labels, refresh() { actions++ }, download() { actions++ }, filter, onFilter() { actions++ }, page, onPage() { actions++ } }))
const ready: PointDiagnosticState = { status: 'ready', snapshot, error: null }
assert.match(render(ready), /REGISTER_WIDTH_OUTSIDE_GROUP/)
assert.match(render(ready), /关联点位/); assert.match(render(ready), /配置快照/)
assert.match(render(ready, { severity: 'all', query: '#999' }), /筛选后无匹配问题/)
assert.match(render({ status: 'loading', snapshot: null, error: null }), /正在检查点表/)
for (const error of ['failed', 'invalid', 'timeout'] as const) {
  const html = render({ status: 'error', snapshot: null, error })
  assert.match(html, /role="alert"/); assert.match(html, /disabled=""/); assert.doesNotMatch(html, /REGISTER_WIDTH_OUTSIDE_GROUP/)
}
const emptyReport = diagnosePointTable({ devices, groups: [], registers: [] })
assert.match(render({ ...ready, snapshot: { ...snapshot, report: emptyReport } }), /未发现错误或警告/)
const largeReport = { ...report, issues: Array.from({ length: 45 }, (_, i) => ({ severity: 'warning' as const, code: 'WARN_' + i, message: i === 0 ? '<script>never execute</script>' : 'm' })), summary: { ...report.summary, errors: 0, warnings: 45 }, ok: true }
const large = { ...ready, snapshot: { ...snapshot, report: largeReport } }
assert.match(render(large), /&lt;script&gt;/); assert.doesNotMatch(render(large), /<script>/)
assert.doesNotMatch(render(large), /WARN_20/); assert.match(render(large, undefined, 1), /WARN_20/)
assert.match(render(large, undefined, 999), /WARN_44/, 'page clamps after result changes')
assert.equal(JSON.parse(pointDiagnosticDownload(large.snapshot!)).report.issues.length, 45)
assert.equal(actions, 0, 'SSR cannot perform requests, downloads, repairs or other actions')
assert.equal(JSON.stringify(report), before)
console.log('POINT DIAGNOSTICS UI OK: real read-only API contract, validation/projection, filtering, complete export, stale/unmount/timeout/retry guards, empty/error/paged/escaped SSR states; only mock metadata, no databases, hardware or network')
