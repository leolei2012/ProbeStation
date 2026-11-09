import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DuckDBStore } from '../packages/store/src/index.ts'
import { encodeRegister } from '../packages/core/src/codec.ts'
import { sourceKey } from '../packages/core/src/sample-source.ts'
import { evaluateLivePoints } from '../apps/web/src/live-point-filter.ts'
import { captureLiveSnapshot, downloadLiveSnapshot, liveSnapshotFilename, liveSnapshotJson, type SnapshotGroup, type SnapshotView } from '../apps/web/src/live-snapshot.ts'
import { LiveSnapshotPanel } from '../apps/web/src/LiveSnapshotPanel.tsx'

// Synthetic current values only; producer/cache uses explicit memory DB, no services or real device.
const now = Date.parse('2026-11-07T12:00:00.123Z'), sampled = new Date(now - 2000).toISOString()
const device = { id: 1, name: 'mock device', mode: 'master', isActive: 1, slaveId: 9 }
let forbiddenReads = 0
Object.defineProperty(device, 'ip', { get() { forbiddenReads++; throw new Error('connection fields must not be accessed') } })
const groups: SnapshotGroup[] = [
  { id: 10, name: 'source one', isActive: 1, slaveId: 1, functionCode: 3, registers: [
    { id: 1, alias: '<script>name</script>', startAddress: 0, functionCode: 3, dataType: 'uint32', factor: 0, offset: 5, unit: 'V' },
    { id: 2, alias: 'covered', startAddress: 1, functionCode: 3, dataType: 'uint16' },
    { id: 3, alias: 'large integer', startAddress: 4, functionCode: 3, dataType: 'uint64' },
  ] },
  { id: 20, name: 'source two', isActive: 1, slaveId: 2, functionCode: 3, registers: [{ id: 4, alias: 'same address', startAddress: 0, functionCode: 3, dataType: 'uint16' }] },
  { id: 30, name: 'input area', isActive: 1, slaveId: 1, functionCode: 4, registers: [{ id: 5, alias: 'input', startAddress: 0, functionCode: 4, dataType: 'uint16' }] },
  { id: 40, name: 'coil area', isActive: 1, slaveId: 1, functionCode: 1, registers: [{ id: 6, alias: 'zero coil', startAddress: 0, functionCode: 1, dataType: 'uint16' }] },
]
const views = new Map<number, SnapshotView>([
  [1, { value: '65536', label: 'scaled zero factor', covered: false, invalid: false, physical: { value: '5' } }],
  [2, { value: '—', label: null, covered: true, invalid: false }],
  [3, { value: '18446744073709551615', label: null, covered: false, invalid: false, physical: { value: '18446744073709551615' } }],
  [4, { value: '222', label: null, covered: false, invalid: false }], [5, { value: '333', label: null, covered: false, invalid: false }], [6, { value: '0', label: null, covered: false, invalid: false }],
])
const store = new DuckDBStore({ dbPath: ':memory:', flushIntervalMs: 0, flushBatchSize: 1000, retentionSeconds: 0, retentionCheckMs: 0 })
let snapshot!: ReturnType<typeof captureLiveSnapshot>
try {
  await (store as any).ready; await (store as any).mutations
  const points = [{ address: 0, rawValue: 1 }, { address: 1, rawValue: 0 }, ...encodeRegister('uint64', 18446744073709551615n).map((rawValue, i) => ({ address: i + 4, rawValue }))]
  store.write(points.map(point => ({ ...point, objectId: 1, area: 'holding-register', timestamp: sampled, quality: 'good', slaveId: 1, batchId: point.address < 4 ? 'u32' : 'u64' })))
  store.write([{ objectId: 1, area: 'holding-register', address: 0, timestamp: sampled, quality: 'good', slaveId: 2, batchId: 'other', rawValue: 222 }, { objectId: 1, area: 'input-register', address: 0, timestamp: sampled, quality: 'good', slaveId: 1, batchId: 'input', rawValue: 333 }, { objectId: 1, area: 'coil', address: 0, timestamp: sampled, quality: 'good', slaveId: 1, batchId: 'coil', rawValue: 0 }])
  const latest = store.getLatest(), states = evaluateLivePoints(groups, views, latest, device, [], {}, now, 5000)
  const input = { device, groups, visibleIds: new Set([1, 2, 3, 4, 5, 6]), views, states, latest, filters: { search: '', source: '', mode: 'all' }, rulesReady: true, observedAt: now, capturedAt: now + 123, thresholdMs: 5000 }
  snapshot = captureLiveSnapshot(input)
  assert.equal(snapshot.points.length, 6); assert.equal(snapshot.automaticEligible, false); assert.equal(snapshot.scope.includesCollapsedAndVirtualRows, true)
  assert.equal(snapshot.points[0].definition.factor, 0); assert.equal(snapshot.points[0].display.physical, '5'); assert.equal(snapshot.points[1].display.raw, null); assert.equal(snapshot.points[1].display.covered, true)
  assert.equal(snapshot.points[2].display.raw, '18446744073709551615'); assert.equal(snapshot.points[3].words[0].sample!.rawValue, 222); assert.equal(snapshot.points[4].words[0].sample!.rawValue, 333); assert.equal(snapshot.points[5].words[0].sample!.rawValue, 0)
  assert.equal(snapshot.points[0].batchRelationship, 'complete-same-batch-id'); assert.equal(snapshot.points[0].words[1].sample!.rawValue, 0); assert.equal(snapshot.points[0].words[0].sample!.timestampMs, now - 2000)
  const filtered = captureLiveSnapshot({ ...input, visibleIds: new Set([4]), filters: { search: 'same', source: '2', mode: 'all' } }); assert.equal(filtered.points.length, 1); assert.equal(filtered.scope.availablePoints, 6); assert.equal(filtered.points[0].configuredSlaveId, 2)
  const frozen = liveSnapshotJson(snapshot), key = sourceKey(1, 'holding-register', 0, 1)
  latest[key].rawValue = 999; views.get(1)!.value = 'changed'; groups[0].name = 'changed'; groups[0].registers[0].alias = 'changed'
  assert.equal(liveSnapshotJson(snapshot), frozen, 'future stream/config/display changes cannot mutate the captured snapshot')
  assert(Object.isFrozen(snapshot)); assert(Object.isFrozen(snapshot.points)); assert(Object.isFrozen(snapshot.points[0].words[0].sample)); assert.equal(forbiddenReads, 0)
  assert(!frozen.includes('"ip"')); assert(!frozen.includes('serialPath')); assert(!frozen.includes('apiKey')); assert.deepEqual(JSON.parse(frozen), snapshot)
  const legacy = { ...latest, [key]: { ...latest[key], batchId: undefined }, [sourceKey(1, 'holding-register', 1, 1)]: { ...latest[sourceKey(1, 'holding-register', 1, 1)], batchId: undefined } }
  assert.equal(captureLiveSnapshot({ ...input, latest: legacy }).points[0].batchRelationship, 'legacy-unverified')
  const mixed = { ...latest, [key]: { ...latest[key], batchId: 'mixed' } }
  assert.equal(captureLiveSnapshot({ ...input, latest: mixed }).points[0].batchRelationship, 'mixed-or-missing-batch-id')
  const missing = { ...latest }; delete missing[key]
  assert.equal(captureLiveSnapshot({ ...input, latest: missing }).points[0].batchRelationship, 'incomplete')
  const nonfinite = { ...latest, [key]: { ...latest[key], rawValue: NaN, quality: 'bad' } }
  const nan = captureLiveSnapshot({ ...input, latest: nonfinite }); assert.equal(nan.points[0].words[0].sample!.rawValue, null); assert.equal(nan.points[0].words[0].sample!.rawValueText, 'NaN'); assert.equal(nan.points[0].words[0].sample!.numericIssue, 'non-finite'); assert(liveSnapshotJson(nan).includes('"NaN"'))
  const paused = evaluateLivePoints(groups, views, latest, { ...device, isActive: 0 }, [], {}, now + 6000, 5000)
  assert.equal(captureLiveSnapshot({ ...input, device: { ...device, isActive: 0 }, states: paused }).points[0].health.stale, true)
  const unknownSources = groups.map(group => ({ ...group, slaveId: undefined }))
  const unknown = captureLiveSnapshot({ ...input, groups: unknownSources }); assert(unknown.points.every(point => point.configuredSlaveId === null && point.words.every(word => word.sample === null)), 'unknown sources never borrow unscoped or different-slave values')
  const malformed = { ...latest, [key]: { ...latest[key], rawValue: '13' as any } }
  assert.equal(captureLiveSnapshot({ ...input, latest: malformed }).points[0].words[0].sample!.numericIssue, 'not-number')
  const wrongSource = { ...latest, [key]: { ...latest[key], slaveId: 2 } }
  assert.equal(captureLiveSnapshot({ ...input, latest: wrongSource }).points[0].words[0].sample, null)
  const leWords = encodeRegister('uint64-LE', 9223372036854775809n), lePoint = { ...groups[0].registers[0], dataType: 'uint64-LE', startAddress: 40 }, leLatest = Object.fromEntries(leWords.map((rawValue, i) => [sourceKey(1, 'holding-register', 40 + i, 9), { rawValue, timestamp: sampled, timestampMs: now - 2000, slaveId: 9, batchId: 'le64', quality: 'good' }]))
  const le = captureLiveSnapshot({ ...input, device: { ...device, mode: 'slave' }, groups: [{ ...groups[0], registers: [lePoint] }], visibleIds: new Set([1]), latest: leLatest, views: new Map([[1, { value: '9223372036854775809', label: null, covered: false, invalid: false, physical: { value: null, issue: 'precision' } }]]) })
  assert.equal(le.points[0].configuredSlaveId, 9, 'slave mode uses device source, not group source'); assert.deepEqual(le.points[0].words.map(word => word.sample!.rawValue), leWords); assert.equal(le.points[0].definition.dataType, 'uint64-LE'); assert.equal(le.points[0].display.raw, '9223372036854775809'); assert.equal(le.points[0].display.physicalIssue, 'precision'); assert.equal(le.points[0].display.physical, null)
  const domain = captureLiveSnapshot({ ...input, latest: { ...latest, [key]: { ...latest[key], rawValue: 65536 } } }); assert.equal(domain.points[0].words[0].sample!.numericIssue, 'outside-word-domain'); assert.equal(domain.points[0].words[0].sample!.rawValue, 65536)
  assert.throws(() => captureLiveSnapshot({ ...input, visibleIds: new Set() })); assert.throws(() => captureLiveSnapshot({ ...input, visibleIds: new Set([999]) })); assert.throws(() => captureLiveSnapshot({ ...input, views: new Map() }))
  assert.equal(store.getPersistenceStatus().pendingRows, 9, 'capture never flushes or changes producer state')
} finally { await (store as any).mutations; const conn = await (store as any).ready.catch(() => null); conn?.closeSync(); (store as any).instance?.closeSync() }

for (const english of [false, true]) {
  const html = renderToStaticMarkup(createElement(LiveSnapshotPanel, { snapshot, close() {}, english, download() { throw new Error('SSR must not download') } }))
  assert(html.includes(english ? 'Frozen live observation' : '已冻结的实时观测')); assert(html.includes('18446744073709551615')); assert(html.includes('&lt;script&gt;name&lt;/script&gt;')); assert(!html.includes('<script>'))
  assert(html.includes(english ? 'Acquisition continues' : '采集仍继续')); assert(html.includes('PASS/FAIL'))
}
let ageCases = 0
for (const english of [false, true]) {
  for (const [name, delays, quality, batches, expected] of [
    ['zero', [0, 0], 'good', ['same', 'same'], 0], ['oldest', [9000, 2000], 'good', ['same', 'same'], 9],
    ['missing', [null, null], 'good', ['same', 'same'], null], ['future', [-60000, -60000], 'good', ['same', 'same'], null],
    ['partial', [5000, null], 'good', ['same', 'same'], 5], ['bad-quality', [0, 0], 'bad', ['same', 'same'], 0], ['mixed', [0, 0], 'good', ['a', 'b'], 0],
  ] as const) {
    const point = { id: 71, alias: name, startAddress: 0, functionCode: 3, dataType: 'uint32' }, owner = { id: 77, name: 'age fixture', mode: 'master', isActive: 1 }
    const groups = [{ id: 70, name: 'one source', slaveId: 1, functionCode: 3, isActive: 1, registers: [point] }]
    const latest = Object.fromEntries(delays.flatMap((delay, index) => delay === null ? [] : [[sourceKey(owner.id, 'holding-register', index, 1), { rawValue: 0, quality, timestamp: new Date(now - delay).toISOString(), timestampMs: now - delay, batchId: batches[index], slaveId: 1 }]]))
    latest[sourceKey(owner.id, 'holding-register', 0, 2)] = { rawValue: 999, quality: 'good', timestamp: new Date(now - 999000).toISOString(), timestampMs: now - 999000, batchId: 'other', slaveId: 2 }
    const views = new Map([[point.id, { value: delays.some(delay => delay === null) ? '—' : '0', label: null, covered: false, invalid: delays.some(delay => delay === null) }]])
    const states = evaluateLivePoints(groups, views, latest, owner, [], {}, now, 5000)
    const captured = captureLiveSnapshot({ device: owner, groups, views, states, latest, visibleIds: new Set([point.id]), filters: { search: '', source: '', mode: 'all' }, rulesReady: true, observedAt: now, capturedAt: now + 10000, thresholdMs: 5000 }), original = liveSnapshotJson(captured)
    assert.equal(captured.points[0].health.ageSeconds, expected, 'age uses the oldest known word at observedAt; missing/other-source/future is not fabricated as zero')
    const render = (value = captured) => renderToStaticMarkup(createElement(LiveSnapshotPanel, { snapshot: value, close() {}, english, download() { throw new Error('age rendering must not download') } }))
    const clock = Date.now
    let html: string
    try { Date.now = () => now + 600000; html = render(); Date.now = () => now + 86400000; assert.equal(render(), html, 'a frozen age does not advance with the current clock') } finally { Date.now = clock }
    assert(html!.includes(english ? 'Age at freeze (s)' : '冻结时年龄（秒）'), 'frozen preview must expose the already captured age instead of requiring JSON inspection')
    assert(html!.includes(english ? 'oldest available word' : '最早已知字')); assert(html!.includes(english ? 'does not increase after freezing' : '冻结后不会递增'))
    const row = html!.match(/<tbody><tr>([\s\S]*?)<\/tr><\/tbody>/)![1], cells = [...row.matchAll(/<td(?: [^>]*)?>([\s\S]*?)<\/td>/g)].map(match => match[1])
    assert.equal(cells.length, 5); assert.equal(cells[3].split('<')[0], expected === null ? english ? 'Unknown' : '未知' : String(expected))
    if (name === 'partial') assert(cells[3].includes(english ? 'Available words only' : '仅已有字'))
    if (name === 'missing') assert(!cells[3].includes(english ? 'Available words only' : '仅已有字'), 'no captured words must not be labelled as available words')
    if (name === 'bad-quality' || name === 'future') assert(cells[4].includes(english ? 'Stale/issue' : '旧值/异常'))
    if (name === 'mixed') assert(cells[4].includes(english ? 'Mixed or missing batch IDs' : '批次混杂或缺失'))
    assert.equal(liveSnapshotJson(captured), original); assert.equal(captured.automaticEligible, false); ageCases++
  }
  for (const invalidAge of [-1, Infinity, NaN]) {
    const value = { ...snapshot, points: [{ ...snapshot.points[0], health: { ...snapshot.points[0].health, ageSeconds: invalidAge } }] }
    const html = renderToStaticMarkup(createElement(LiveSnapshotPanel, { snapshot: value, close() {}, english, download() {} })), cells = [...html.match(/<tbody><tr>([\s\S]*?)<\/tr><\/tbody>/)![1].matchAll(/<td(?: [^>]*)?>([\s\S]*?)<\/td>/g)]
    assert.equal(cells[3][1].split('<')[0], english ? 'Unknown' : '未知')
  }
}
console.log(`FROZEN AGE OK: ${ageCases} bilingual zero/oldest/missing/future/partial/bad-quality/mixed-source-aware frozen displays, 6 invalid-age projections, clock independence and unchanged JSON; no device writes`)
const largePoints = Array.from({ length: 10000 }, (_, i) => ({ id: i + 1, alias: 'point ' + i, startAddress: i, functionCode: 3, dataType: 'uint16' }))
const emptyState = { health: { missing: true, stale: true, timestamp: null, ageSeconds: null }, alarmActive: false, alarmUnknown: false, dataIssue: true, attention: true }
const large = captureLiveSnapshot({ device: { id: 9, name: 'large synthetic', mode: 'master', isActive: 1 }, groups: [{ id: 9, name: 'logical rows', isActive: 1, slaveId: 1, functionCode: 3, registers: largePoints }], visibleIds: new Set(largePoints.map(point => point.id)), views: new Map(largePoints.map(point => [point.id, { value: '—', label: null, covered: false, invalid: true }])), states: new Map(largePoints.map(point => [point.id, emptyState])), latest: {}, filters: { search: '', source: '', mode: 'all' }, rulesReady: false, observedAt: now, capturedAt: now, thresholdMs: 5000 })
const largeHtml = renderToStaticMarkup(createElement(LiveSnapshotPanel, { snapshot: large, close() {}, download() {} })); assert.equal((largeHtml.match(/<tr>/g) ?? []).length, 21, 'preview renders 20 rows while the frozen data keeps every point'); assert.equal(large.points.length, 10000)
let blob!: Blob, clicks = 0, removed = 0; const revoked: string[] = [], queued: Array<() => void> = []
const link = { href: '', download: '', click() { clicks++ }, remove() { removed++ } }
const doc = { createElement: () => link, body: { appendChild() {} } } as any
const urls = { createObjectURL: (value: Blob) => { blob = value; return 'blob:synthetic' }, revokeObjectURL: (url: string) => revoked.push(url) }
downloadLiveSnapshot(snapshot, doc, urls, fn => queued.push(fn)); assert.equal(clicks, 1); assert.equal(removed, 1); assert.equal(link.download, liveSnapshotFilename(snapshot)); assert.deepEqual(JSON.parse(await blob.text()), snapshot); assert.equal(blob.type, 'application/json;charset=utf-8'); assert.equal(revoked.length, 0); queued.shift()!(); assert.deepEqual(revoked, ['blob:synthetic'])
link.click = () => { throw new Error('synthetic download blocked') }; assert.throws(() => downloadLiveSnapshot(snapshot, doc, urls, fn => queued.push(fn))); queued.shift()!(); assert.equal(removed, 2); assert.equal(revoked.length, 2)
assert.throws(() => downloadLiveSnapshot(snapshot, { createElement() { throw new Error('synthetic DOM failure') } } as any, urls, fn => queued.push(fn))); queued.shift()!(); assert.equal(revoked.length, 3)
console.log('LIVE SNAPSHOT OK: memory producer source/area/word identity, exact 64-bit/zero/scale displays, filter scope, covered/missing/legacy/mixed/nonfinite/paused metadata, immutable whitelist and JSON, 10000-row paged SSR, local download/revoke/failure adapters; no real files, fetch, hardware, model or DOM automation')
