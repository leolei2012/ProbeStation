import assert from 'node:assert/strict'
import { historyQueryPlan, startHistoryQuery, type HistoryQueryEvent } from '../apps/web/src/history-query-task.ts'
import { HistoryQueryTimeoutError } from '../apps/web/src/history-query.ts'

const input = { objectId: 1, start: Date.parse('2026-11-06T00:00:00Z'), end: Date.parse('2026-11-06T01:00:00Z'), mode: 'table' as const, page: 0, registerIds: [] as number[] }
assert.equal(historyQueryPlan(input), null, 'clearing the selected points must not schedule a full-device table query')
assert.equal(historyQueryPlan({ ...input, mode: 'chart' }), null)
const selected = [2, 1, 2], plan = historyQueryPlan({ ...input, registerIds: selected })!
selected.push(3)
assert.equal(plan.selectionKey, '1,2', 'request captures a canonical selection without keeping a mutable reference')
assert.equal(historyQueryPlan({ ...input, registerIds: [1, 2] })!.url, plan.url)
const url = new URL(plan.url, 'http://mock.invalid')
assert.equal(url.pathname, '/api/data/object/page'); assert.equal(url.searchParams.get('register_ids'), '1,2')
assert.equal(url.searchParams.get('page_size'), '200')
for (const override of [{ objectId: 2 }, { start: input.start + 1 }, { end: input.end + 1 }, { page: 1 }, { mode: 'chart' as const }, { registerIds: [1] }]) {
  assert.notEqual(historyQueryPlan({ ...input, registerIds: [1, 2], ...override })!.url, plan.url, 'device/range/page/mode/point changes have different result identities')
}
for (const override of [{ start: NaN }, { end: Infinity }, { end: input.start }, { start: input.end + 1 }, { objectId: 0 }, { page: -1 }, { page: 0.5 }, { registerIds: [NaN] }, { registerIds: [0] }]) {
  assert.equal(historyQueryPlan({ ...input, registerIds: [1], ...override }), null)
}
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
let calls = 0
const emptyEvents: HistoryQueryEvent<string>[] = []
startHistoryQuery(historyQueryPlan(input), async () => { calls++; return 'unexpected' }, e => emptyEvents.push(e))
assert.deepEqual(emptyEvents, [{ status: 'idle' }]); assert.equal(calls, 0, 'empty selection needs neither a timer nor a request')

const queued: HistoryQueryEvent<string>[] = []
const queuedTask = startHistoryQuery(plan, async () => { calls++; return 'unexpected' }, e => queued.push(e), { delayMs: 20 })
queuedTask.cancel(); queuedTask.cancel(); await sleep(25)
assert.equal(calls, 0, 'cancel during debounce prevents fetch entirely')
assert.deepEqual(queued.map(e => e.status), ['loading', 'idle'])
const unmounted: string[] = []
const removed = startHistoryQuery(plan, async () => { calls++; return 'unexpected' }, e => unmounted.push(e.status), { delayMs: 20 })
removed.dispose(); await sleep(25)
assert.equal(calls, 0); assert.deepEqual(unmounted, ['loading'], 'cleanup is silent and cannot set state after unmount')

const started = deferred<AbortSignal>(), late = deferred<string>(), oldEvents: string[] = []
const old = startHistoryQuery(plan, async (_url, signal) => { started.resolve(signal); return late.promise }, e => oldEvents.push(e.status), { delayMs: 0 })
const oldSignal = await started.promise
old.dispose(); assert.equal(oldSignal.aborted, true)
const cleared: string[] = []
startHistoryQuery(null, async () => 'unexpected', e => cleared.push(e.status))
assert.deepEqual(cleared, ['idle'])
const result = deferred<HistoryQueryEvent<string>>(), newEvents: string[] = []
startHistoryQuery(plan, async (_url, signal) => { assert.equal(signal.aborted, false); return 'new result' }, e => { newEvents.push(e.status); if (e.status !== 'loading') result.resolve(e) }, { delayMs: 0 })
const done = await result.promise
assert.equal(done.status, 'done'); if (done.status === 'done') { assert.equal(done.data, 'new result'); assert.equal(done.plan.url, plan.url) }
late.resolve('old result'); await turn()
assert.deepEqual(oldEvents, ['loading']); assert.deepEqual(newEvents, ['loading', 'done'], 'late old response cannot overwrite a reselected/refreshed query, even with the same URL')

const running = deferred<AbortSignal>(), cancelledEvents: string[] = []
const inFlight = startHistoryQuery(plan, async (_url, signal) => { running.resolve(signal); return new Promise<string>(() => {}) }, e => cancelledEvents.push(e.status), { delayMs: 0 })
const runningSignal = await running.promise
inFlight.cancel(); await turn()
assert.equal(runningSignal.aborted, true); assert.deepEqual(cancelledEvents, ['loading', 'idle'])
for (const timeout of [false, true]) {
  const finished = deferred<HistoryQueryEvent<string>>()
  let signal!: AbortSignal
  startHistoryQuery(plan, async (_url, next) => { signal = next; if (timeout) return new Promise<string>(() => {}); throw new Error('mock 503') }, e => { if (e.status !== 'loading') finished.resolve(e) }, { delayMs: 0, timeoutMs: 5 })
  const error = await finished.promise
  assert.equal(error.status, 'error')
  if (error.status === 'error') assert.ok(timeout ? error.error instanceof HistoryQueryTimeoutError : error.error instanceof Error && error.error.message === 'mock 503')
  if (timeout) assert.equal(signal.aborted, true)
}
const recovered = deferred<HistoryQueryEvent<{ points: [] }>>()
startHistoryQuery(plan, async () => ({ points: [] }), e => { if (e.status !== 'loading') recovered.resolve(e) }, { delayMs: 0 })
assert.equal((await recovered.promise).status, 'done', 'empty server results and retry after cancel/error/timeout complete normally')
console.log('HISTORY QUERY TASK OK: empty/invalid selection skips I/O, canonical result identity, debounce cancel, silent cleanup, in-flight abort, stale same-URL rejection, reselect/retry/empty/failure/timeout recovery; mock promises only')
