import assert from 'node:assert/strict'
import { HistoryQueryTimeoutError, runHistoryQuery } from '../apps/web/src/history-query.ts'

const active = () => new AbortController()
assert.deepEqual(await runHistoryQuery(async () => ({ points: [1, 2] }), active().signal), { points: [1, 2] })
await assert.rejects(runHistoryQuery(async () => { throw new Error('HTTP 503') }, active().signal), /HTTP 503/)
const timeout = active()
let timedSignal: AbortSignal | undefined
await assert.rejects(runHistoryQuery(signal => { timedSignal = signal; return new Promise(() => {}) }, timeout.signal, 5), HistoryQueryTimeoutError)
assert.equal(timedSignal!.aborted, true, 'timeout aborts the underlying request')
assert.equal(timeout.signal.aborted, false, 'timeout remains distinguishable from user cancellation')
await assert.rejects(runHistoryQuery(signal => new Promise((_resolve, reject) => {
  signal.addEventListener('abort', () => reject(signal.reason), { once: true })
}), active().signal, 5), HistoryQueryTimeoutError, 'an abort-aware fetch keeps the timeout reason')

const cancelled = active(), reason = new DOMException('Query cancelled', 'AbortError')
let calls = 0
cancelled.abort(reason)
await assert.rejects(runHistoryQuery(async () => { calls++; return 1 }, cancelled.signal), error => error === reason)
assert.equal(calls, 0, 'pre-cancelled queries never reach fetch')

const previous = active()
let previousSignal!: AbortSignal, resolveLate!: (value: string) => void
const stale = runHistoryQuery(signal => { previousSignal = signal; return new Promise<string>(resolve => { resolveLate = resolve }) }, previous.signal)
const rejected = assert.rejects(stale, error => error === reason)
await Promise.resolve()
previous.abort(reason)
await rejected
assert.equal(previousSignal.aborted, true)
assert.equal(await runHistoryQuery(async () => 'new range', active().signal), 'new range')
resolveLate('old range')
await assert.rejects(stale, error => error === reason, 'a late response cannot complete a cancelled query')

let resolveTimedOut!: (value: string) => void
const expired = runHistoryQuery(() => new Promise<string>(resolve => { resolveTimedOut = resolve }), active().signal, 5)
await assert.rejects(expired, HistoryQueryTimeoutError)
resolveTimedOut('late result')
await assert.rejects(expired, HistoryQueryTimeoutError)
assert.equal(await runHistoryQuery(async () => 'recovered', active().signal), 'recovered', 'failure/cancel/timeout leave subsequent requests usable')
console.log('HISTORY QUERY OK: success, failure, timeout, underlying abort, pre-cancel, stale responses and retry')
