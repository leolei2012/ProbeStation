import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { registerCurve } from '../packages/api/src/curve.ts'
import { historyQueryPlan } from '../apps/web/src/history-query-task.ts'
import { startHistoryQuery } from '../apps/web/src/history-query-task.ts'
import { historyReadContextKey, reduceHistoryRead, historyReadView, type HistoryReadState } from '../apps/web/src/history-read-context.ts'
import { withRegisterSources } from '../packages/core/src/sample-source.ts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { HistoryReadNotice } from '../apps/web/src/HistoryReadNotice.tsx'

const input = { objectId: 7, start: Date.parse('2026-11-06T00:00:00.123Z'), end: Date.parse('2026-11-06T01:00:00.987Z'), mode: 'chart' as const, page: 0, registerIds: [101] }
let source = 1
const device = { id: 7, mode: 'master', slaveId: 9 }, point = { id: 101, objectId: 7, groupId: 10, alias: '同一ID', functionCode: 3, startAddress: 0, dataType: 'uint16', factor: 1, offset: 0, unit: null, enumJson: null }
const groups = () => [{ id: 10, name: '合成分组', slaveId: source, functionCode: 3, startAddress: 0, quantity: 2, isActive: 1 }]
let registry = [point]
const definitions = () => withRegisterSources(registry, groups(), device)
const context = () => historyReadContextKey(device, groups(), definitions())!
const app = Fastify()
registerCurve(app, { getObject: () => device, listGroups: groups, listRegistersByObject: () => registry }, {
  queryRegisterCurve: async (_id: number, _start: string, _end: string, registers: any[]) => ({ complete: true, points: [], series: registers.map(r => ({ id: r.id, samples: [[input.start, r.slaveId === 1 ? 10 : 200]], gapMs: 1000 })), sourceSamples: registers.length, displayedSamples: registers.length, downsampled: false }),
})
const oldContext = context(); source = 2; const newContext = context(); source = 1
const oldPlan = historyQueryPlan({ ...input, contextKey: oldContext })!, newPlan = historyQueryPlan({ ...input, contextKey: newContext })!
let oldBody: any, newBody: any
try {
  const old = await app.inject(oldPlan.url); source = 2; const next = await app.inject(newPlan.url)
  assert.equal(old.statusCode, 200); assert.equal(next.statusCode, 200)
  assert.equal(old.json().series[0].samples[0][1], 10); assert.equal(next.json().series[0].samples[0][1], 200)
  assert.equal(oldPlan.url, newPlan.url)
  oldBody = old.json(); newBody = next.json()
  const unseen = await app.inject(oldPlan.url)
  assert.equal(unseen.statusCode, 200); assert.equal(unseen.json().series[0].samples[0][1], 200, 'unchanged old client plan still receives the current backend source')
  const unseenState = reduceHistoryRead(reduceHistoryRead<any>(null, oldPlan, { status: 'loading' }), oldPlan, { status: 'done', plan: oldPlan, data: unseen.json() })
  assert.equal(historyReadView(oldPlan, unseenState).contextChanged, false, 'local result ownership cannot detect unreceived server definitions')
  assert.equal(unseen.headers.etag, undefined); assert.equal(unseen.headers['last-modified'], undefined)
  console.log('HISTORY UNSEEN CONFIG LIMIT: old plan URL returns new source 200 with no definition revision acknowledgment; client contextChanged=false. Known boundary, not a safety pass.')
  console.log('Reproduced with real in-memory API routing and mock provider: identical history URL, same point ID, source 1→2 changes decoded series 10→200. No databases, sockets or devices.')
  registry = [{ ...point, startAddress: 1 }, { ...point, id: 102, startAddress: 0, dataType: 'uint16' }]
  const beforeCoverage = context(), eligible = await app.inject(oldPlan.url)
  assert.deepEqual(eligible.json().series.map((s: any) => s.id), [101])
  registry = registry.map(p => p.id === 102 ? { ...p, dataType: 'uint32' } : p)
  const covered = await app.inject(oldPlan.url)
  assert.deepEqual(covered.json().series, []); assert.notEqual(context(), beforeCoverage, 'unselected definition changes affect selected-point eligibility in the real API')
} finally { await app.close() }
assert.notEqual(oldPlan.key, newPlan.key, 'different point-definition contexts need distinct client result identities even when their HTTP URL is identical')
assert.ok(!new URL(newPlan.url, 'http://mock.invalid').searchParams.has('contextKey')); assert.ok(!newPlan.url.includes(newContext), 'definition snapshot is client-only, never put in the URL')
assert.ok(Object.isFrozen(oldPlan))
let state = reduceHistoryRead<any>(null, oldPlan, { status: 'loading' })
state = reduceHistoryRead(state, oldPlan, { status: 'done', data: oldBody, plan: oldPlan })
assert.equal(historyReadView(oldPlan, state).data.series[0].samples[0][1], 10)
const beforeEffects = historyReadView(newPlan, state)
assert.equal(beforeEffects.status, 'loading'); assert.equal(beforeEffects.data, null); assert.equal(beforeEffects.contextChanged, true, 'old decoded series and quality counts are hidden before React effect cleanup')
state = reduceHistoryRead(state, newPlan, { status: 'loading' })
assert.equal(state!.data, null, 'loading frees old sample payload instead of retaining it under new labels')
const pending = state
assert.equal(reduceHistoryRead(state, oldPlan, { status: 'done', data: oldBody, plan: oldPlan }), pending)
assert.equal(reduceHistoryRead(state, oldPlan, { status: 'error', error: new Error('old failure') }), pending)
assert.equal(reduceHistoryRead(state, oldPlan, { status: 'idle' }), pending)
state = reduceHistoryRead(state, newPlan, { status: 'error', error: new Error('new failure') })
assert.equal(historyReadView(newPlan, state).status, 'error'); assert.equal(historyReadView(newPlan, state).contextChanged, true)
assert.equal(historyReadView(newPlan, state).data, null)
state = reduceHistoryRead(state, newPlan, { status: 'loading' })
state = reduceHistoryRead(state, newPlan, { status: 'done', data: newBody, plan: newPlan })
assert.equal(historyReadView(newPlan, state).data.series[0].samples[0][1], 200); assert.equal(historyReadView(newPlan, state).contextChanged, false)
const refresh = historyQueryPlan({ ...input, contextKey: newContext, revision: 1 })!
assert.equal(refresh.url, newPlan.url); assert.notEqual(refresh.key, newPlan.key)
assert.equal(historyReadView(refresh, state).status, 'loading', 'same-URL explicit refresh hides old success before effects')
state = reduceHistoryRead(state, refresh, { status: 'loading' })
assert.equal(reduceHistoryRead(state, newPlan, { status: 'done', data: newBody, plan: newPlan }), state)
state = reduceHistoryRead(state, refresh, { status: 'idle' }); assert.equal(historyReadView(refresh, state).status, 'idle'); assert.equal(state!.data, null)
state = reduceHistoryRead(state, refresh, { status: 'loading' }); state = reduceHistoryRead(state, refresh, { status: 'done', data: { series: [] }, plan: refresh })
assert.deepEqual(historyReadView(refresh, state).data.series, [], 'empty current results do not fall back to old values')
assert.equal(historyReadView(null, state).data, null); assert.equal(historyReadView(null, state).error, null)

const stableGroups = [{ id: 10, objectId: 7, name: 'G', slaveId: 2, functionCode: 3, startAddress: 0, quantity: 2 }, { id: 20, objectId: 7, name: 'other', slaveId: 3, functionCode: 4, startAddress: 0, quantity: 1 }]
const stablePoints = [{ ...point, slaveId: 2, decimalPlaces: 2 }, { ...point, id: 102, groupId: 20, slaveId: 3 }], stable = historyReadContextKey(device, stableGroups, stablePoints)!, untouched = JSON.stringify({ stableGroups, stablePoints })
assert.equal(historyReadContextKey({ ...device }, [...stableGroups].reverse(), [...stablePoints].reverse()), stable, 'reference/order-only refreshes keep the same query identity')
for (const patch of [{ slaveId: 3 }, { dataType: 'uint32-LE' }, { functionCode: 4 }, { startAddress: 1 }, { groupId: 20 }, { sourceAmbiguous: true }, { factor: 0 }, { offset: 1 }, { unit: 'K' }, { enumJson: '{"1":"on"}' }, { decimalPlaces: 0 }, { alias: 'renamed' }]) assert.notEqual(historyReadContextKey(device, stableGroups, [{ ...stablePoints[0], ...patch }, stablePoints[1]]), stable)
for (const patch of [{ quantity: 1 }, { startAddress: 1 }, { slaveId: 1 }, { functionCode: 4 }, { name: 'renamed group' }]) assert.notEqual(historyReadContextKey(device, [{ ...stableGroups[0], ...patch }, stableGroups[1]], stablePoints), stable)
assert.notEqual(historyReadContextKey({ ...device, mode: 'slave' }, stableGroups, stablePoints), stable)
assert.notEqual(historyReadContextKey({ ...device, slaveId: 8 }, stableGroups, stablePoints), stable)
assert.notEqual(historyReadContextKey(device, stableGroups, [stablePoints[0], { ...stablePoints[1], dataType: 'uint64' }]), stable)
assert.equal(historyReadContextKey({ ...device, name: 'ignored', isActive: 0, pollIntervalMs: 999, apiKey: 'PRIVATE-EXTRA' } as typeof device, stableGroups.map(g => ({ ...g, isActive: 0 })), stablePoints.map(p => ({ ...p, latestSample: 'PRIVATE-EXTRA' }))), stable, 'sampling state/arbitrary fields are not query definitions')
assert.ok(!stable.includes('PRIVATE-EXTRA')); assert.equal(JSON.stringify({ stableGroups, stablePoints }), untouched)
for (const bad of [[stablePoints[0], stablePoints[0]], [{ ...stablePoints[0], objectId: 8 }], [{ ...stablePoints[0], factor: NaN }], [{ ...stablePoints[0], enumJson: {} }], [null]]) assert.equal(historyReadContextKey(device, stableGroups, bad as any), null)
assert.equal(historyReadContextKey(device, [stableGroups[0], stableGroups[0]], stablePoints), null)
const many = Array.from({ length: 10000 }, (_, i) => ({ ...point, id: i + 1, slaveId: 2 }))
const manyKey = historyReadContextKey(device, stableGroups, many)!
assert.notEqual(historyReadContextKey(device, stableGroups, [...many.slice(0, -1), { ...many.at(-1)!, dataType: 'uint32' }]), manyKey, 'the last of 10000 definitions is not omitted')
for (const override of [{ revision: -1 }, { revision: 1.5 }, { revision: '1' }, { contextKey: null }]) assert.equal(historyQueryPlan({ ...input, ...override } as any), null)
assert.equal(historyQueryPlan(input)!.contextKey, '', 'legacy callers keep their HTTP contract')

const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const started = deferred<AbortSignal>(), late = deferred<any>(), finished = deferred<void>()
let live: HistoryReadState<any> | null = null
const oldTask = startHistoryQuery(oldPlan, async (_url, signal) => { started.resolve(signal); return late.promise }, event => { live = reduceHistoryRead(live, oldPlan, event) }, { delayMs: 0 })
const oldSignal = await started.promise
assert.equal(historyReadView(newPlan, live).data, null); oldTask.dispose(); assert.equal(oldSignal.aborted, true)
startHistoryQuery(newPlan, async () => newBody, event => { live = reduceHistoryRead(live, newPlan, event); if (event.status === 'done') finished.resolve() }, { delayMs: 0 })
await finished.promise; late.resolve(oldBody); await new Promise(resolve => setImmediate(resolve))
assert.equal(historyReadView(newPlan, live).data.series[0].samples[0][1], 200, 'real task cancellation and context-bound reducer prevent late old source data')
for (const reason of ['waiting', 'invalid', 'changed'] as const) {
  assert.ok(renderToStaticMarkup(createElement(HistoryReadNotice, { reason })).includes('role="status"'))
  assert.ok(renderToStaticMarkup(createElement(HistoryReadNotice, { reason, english: true })).includes('role="status"'))
}
assert.equal(renderToStaticMarkup(createElement(HistoryReadNotice, { reason: null })), '')
console.log('HISTORY READ CONTEXT OK: real API same-URL source/coverage regression, full stable projected definitions, 10000-point tail, private-field exclusion, context/revision ownership, before-effect hiding, stale success/error/cancel, empty/failure/retry, real task abort and bilingual SSR; no database/device/network/model.')
