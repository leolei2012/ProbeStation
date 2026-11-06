import assert from 'node:assert/strict'
import { LatestConfigRead, readDeviceGroups, groupsForSelection } from '../apps/web/src/config-read.ts'

const reader = new LatestConfigRead()
let selected = 1, value = '', resolveOld!: (value: string) => void, initialSignal!: AbortSignal
const failed = (error: unknown) => { throw error }
const old = reader.run(signal => { initialSignal = signal; return new Promise<string>(resolve => { resolveOld = resolve }) }, next => { value = next }, failed, () => selected === 1)
await reader.run(async () => 'saved unit', next => { value = next }, failed, () => selected === 1)
assert.equal(initialSignal.aborted, true, 'a newer refresh cancels the old HTTP read')
resolveOld('old unit'); await old
assert.equal(value, 'saved unit', 'an older response from the same selected device must not revert newly refreshed metadata')
const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail }); return { promise, resolve, reject } }
let errors = 0, error = ''
const obsolete = deferred<string>(), pending = reader.run(signal => {
  signal.addEventListener('abort', () => { /* Deliberately ignore abort until the stale response is released. */ })
  return obsolete.promise
}, next => { value = next }, () => { errors++ })
await reader.run(async () => 'latest value', next => { value = next; error = '' }, () => { errors++ })
obsolete.reject(new Error('old failure')); await pending
assert.equal(errors, 0); assert.equal(value, 'latest value', 'old failures cannot replace a newer successful refresh')
await reader.run(async () => { throw new Error('latest failure') }, () => {}, next => { error = (next as Error).message })
assert.equal(error, 'latest failure')
await reader.run(async () => 'recovered', next => { value = next; error = '' }, failed)
assert.equal(error, ''); assert.equal(value, 'recovered')

selected = 2
const current = deferred<string>()
let activeSignal!: AbortSignal, ignoredCalls = 0
const forB = reader.run(signal => { activeSignal = signal; return current.promise }, next => { value = next }, failed, () => selected === 2)
await reader.run(async () => { ignoredCalls++; return 'obsolete A callback' }, () => { ignoredCalls++ }, failed, () => selected === 1)
assert.equal(ignoredCalls, 0); assert.equal(activeSignal.aborted, false, 'a late callback for another device cannot cancel the selected device read')
current.resolve('device B'); await forB
assert.equal(value, 'device B')
const switching = deferred<string>()
const switchRead = reader.run(() => switching.promise, next => { value = next }, failed, () => selected === 2)
selected = 3; switching.resolve('obsolete B'); await switchRead
assert.equal(value, 'device B', 'selection relevance is checked again before publishing')
const closed = deferred<string>()
let closedSignal!: AbortSignal, updates = 0
const closing = reader.run(signal => { closedSignal = signal; return closed.promise }, () => { updates++ }, () => { updates++ })
reader.cancel(); assert.equal(closedSignal.aborted, true); closed.resolve('closed result'); await closing
assert.equal(updates, 0)
await reader.run(async () => 'remounted', () => { updates++ }, failed)
assert.equal(updates, 1, 'cleanup does not permanently disable future reads')
const abortAware = reader.run(signal => new Promise<string>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })), () => { updates++ }, () => { updates++ })
reader.cancel(); await abortAware; assert.equal(updates, 1, 'normal aborts do not produce a load error')

const groups = [1, 2].map(id => Object.freeze({ id, name: 'g' + id, slaveId: id, functionCode: id === 1 ? 3 : 4, startAddress: 0, quantity: 2, isActive: 1 }))
const points = [[{ id: 11, alias: 'unit edited', dataType: 'uint32', factor: 0, unit: '℃' }], [{ id: 22, alias: 'other source', dataType: 'uint16', factor: 1, unit: null }]]
Object.freeze(groups); points.forEach(Object.freeze)
const before = JSON.stringify({ groups, points }), controller = new AbortController(), paths: string[] = []
const graph = await readDeviceGroups(5, controller.signal, async (url, signal) => {
  assert.equal(signal, controller.signal); paths.push(url)
  return url.includes('monitor_objects') ? groups : url.includes('/1/') ? points[0] : points[1]
})
assert.deepEqual(paths, ['/api/monitor_objects/5/groups', '/api/groups/1/registers', '/api/groups/2/registers'])
assert.deepEqual(graph, groups.map((group, i) => ({ ...group, registers: points[i] })))
assert.equal(JSON.stringify({ groups, points }), before, 'assembling metadata cannot modify responses')
assert.equal(groupsForSelection({ objectId: 5, groups: graph }, 5), graph)
assert.deepEqual(groupsForSelection({ objectId: 5, groups: graph }, 6), [], 'previous device groups are hidden immediately, before effect cleanup')
assert.deepEqual(groupsForSelection(null, null), [])

const first = deferred<unknown>(), started = deferred<void>(), calls: string[] = []
let accepted = 0, rejected = 0
const cancelledGraph = reader.run(signal => readDeviceGroups(5, signal, async url => {
  calls.push(url)
  if (url.includes('monitor_objects')) return groups
  started.resolve(); return first.promise
}), () => { accepted++ }, () => { rejected++ })
await started.promise; reader.cancel(); first.resolve(points[0]); await cancelledGraph
assert.deepEqual(calls, ['/api/monitor_objects/5/groups', '/api/groups/1/registers'])
assert.equal(accepted, 0); assert.equal(rejected, 0, 'cancelling a graph stops subsequent GETs and never publishes partial groups')
const second = deferred<unknown>(), atSecond = deferred<void>()
const wholeGraph = reader.run(signal => readDeviceGroups(5, signal, async url => {
  if (url.includes('monitor_objects')) return groups
  if (url.includes('/1/')) return points[0]
  atSecond.resolve(); return second.promise
}), () => { accepted++ }, failed)
await atSecond.promise; assert.equal(accepted, 0)
second.resolve(points[1]); await wholeGraph; assert.equal(accepted, 1)
await assert.rejects(readDeviceGroups(5, controller.signal, async url => url.includes('monitor_objects') ? groups : {}), /Invalid registers response/)
await assert.rejects(readDeviceGroups(5, controller.signal, async () => [{ id: 0 }]), /Invalid groups response/)
await assert.rejects(readDeviceGroups(5, controller.signal, async url => { if (url.includes('monitor_objects')) return groups; throw new Error('mock HTTP 503') }), /503/)
const preCancelled = new AbortController(); preCancelled.abort()
let fetched = 0
await assert.rejects(readDeviceGroups(5, preCancelled.signal, async () => { fetched++; return [] }))
assert.equal(fetched, 0)
assert.deepEqual(await readDeviceGroups(5, controller.signal, async () => []), [], 'empty configurations remain valid')
console.log('CONFIG READ OK: same-device stale success/error rejection, latest failure/retry, obsolete-device callbacks, abort/cleanup/remount, immediate snapshot ownership, complete graph publication, cancelled follow-up GETs and metadata preservation; mock promises only')
