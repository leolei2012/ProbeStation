import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { GlobalRetentionFlow, retentionDraftValue, type RetentionApi } from '../apps/web/src/global-retention-state.ts'
import { GlobalRetentionView, GlobalRetentionSettings } from '../apps/web/src/GlobalRetentionSettings.tsx'

// Fake APIs only: the production retention setter schedules destructive cleanup and must not run here.
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
for (const input of ['', ' ', '-1', '0.1', 'NaN', 'Infinity', '9007199254740992']) assert.equal(retentionDraftValue(input), null)
for (const [input, expected] of [['0', 0], [' 3600 ', 3600], ['9007199254740991', Number.MAX_SAFE_INTEGER]] as const) assert.equal(retentionDraftValue(input), expected)
let reads = 0, writes = 0
const valid: RetentionApi = { async get(url, signal) { assert.equal(url, '/api/retention'); assert(signal instanceof AbortSignal); reads++; return { retention_seconds: 2592000 } }, async post(url, body) { assert.equal(url, '/api/retention'); writes++; return { ok: true, ...(body as object) } } }
const flow = new GlobalRetentionFlow()
assert.equal(flow.snapshot().seconds, null)
await flow.apply('0', true, valid); assert.equal(writes, 0, 'cannot write a guessed initial policy')
for (const value of [null, {}, { retention_seconds: '0' }, { retention_seconds: -1 }, { retention_seconds: 0.5 }, { retention_seconds: Number.MAX_SAFE_INTEGER + 1 }]) {
  const invalid = new GlobalRetentionFlow(); await invalid.read({ ...valid, async get() { return value } })
  assert.equal(invalid.snapshot().phase, 'read-error'); assert.equal(invalid.snapshot().seconds, null); assert.equal(invalid.snapshot().error, 'invalid')
  await invalid.apply('0', true, valid); assert.equal(writes, 0)
}
const timed = new GlobalRetentionFlow({ readTimeoutMs: 3 })
await timed.read({ ...valid, get: () => new Promise(() => {}) }); assert.equal(timed.snapshot().error, 'timeout'); assert.equal(timed.snapshot().seconds, null)
await timed.read(valid); assert.equal(timed.snapshot().phase, 'ready', 'explicit read recovers')
const opening = deferred<unknown>(), began = deferred<void>()
const loading = flow.read({ ...valid, get: async () => { began.resolve(); return opening.promise } }); await began.promise
await flow.apply('0', true, valid); assert.equal(writes, 0, 'cannot race an unfinished opening read with a save')
opening.resolve({ retention_seconds: 2592000 }); await loading
for (const [draft, ack] of [['0', false], ['2592000', true], ['', true], ['-1', true], ['0.2', true]] as const) await flow.apply(draft, ack, valid)
assert.equal(writes, 0)
await flow.apply('0', true, valid); assert.equal(writes, 1); assert.equal(flow.snapshot().seconds, 0); assert.equal(flow.snapshot().outcome, 'confirmed')
// Closing/reopening (including a cached lazy module) does not cancel/replay a write.
const pending = deferred<unknown>(), started = deferred<void>(), slow = new GlobalRetentionFlow({ slowWriteMs: 3 })
await slow.read(valid); let calls = 0
const pendingApi: RetentionApi = { ...valid, post: async (...args) => { assert.equal(args.length, 2, 'no abort signal or write timeout'); calls++; started.resolve(); return pending.promise } }
let notices = 0; const unsubscribe = slow.subscribe(() => notices++)
const saving = slow.apply('3600', true, pendingApi); await started.promise; unsubscribe(); const closedNotices = notices
slow.closeRead(); await slow.read(valid); await slow.apply('0', true, pendingApi); await pause(8)
assert.equal(calls, 1); assert.equal(slow.snapshot().phase, 'saving'); assert.equal(slow.snapshot().slow, true); assert.equal(slow.snapshot().seconds, 2592000)
pending.resolve({ ok: true, retention_seconds: 3600 }); await saving
assert.equal(slow.snapshot().seconds, 3600); assert.equal(slow.snapshot().outcome, 'confirmed'); assert.equal(notices, closedNotices)
const { GlobalRetentionFlow: SameFlow } = await import('../apps/web/src/global-retention-state.ts'); assert.equal(SameFlow, GlobalRetentionFlow)
// HTTP-200 validation bodies and mismatched acknowledgments cannot be reported as saved.
for (const result of [{ code: 400, error: 'invalid' }, {}, { ok: true }, { ok: true, retention_seconds: '0' }, { ok: true, retention_seconds: 3600 }, new Error('PRIVATE backend detail')]) {
  const uncertain = new GlobalRetentionFlow(); await uncertain.read(valid); let attempts = 0
  const api: RetentionApi = { ...valid, async post() { attempts++; if (result instanceof Error) throw result; return result } }
  await uncertain.apply('0', true, api)
  assert.equal(uncertain.snapshot().seconds, 2592000, 'failure never optimistically changes actual policy')
  assert.equal(uncertain.snapshot().outcome, 'uncertain'); assert.equal(uncertain.snapshot().phase, 'read-error'); assert(!JSON.stringify(uncertain.snapshot()).includes('PRIVATE'))
  await uncertain.apply('3600', true, api); await uncertain.read({ ...api, async get() { return { retention_seconds: 0 } } })
  assert.equal(uncertain.snapshot().seconds, 0); assert.equal(uncertain.snapshot().outcome, 'uncertain')
  await uncertain.apply('3600', true, api); assert.equal(attempts, 1, 'read cannot prove a prior mutation finished; no blind retry')
}
// A cancelled opening GET cannot overwrite a later snapshot, including its failure/finalizer.
const stale = new GlobalRetentionFlow(), late = deferred<unknown>(), entered = deferred<void>()
const old = stale.read({ ...valid, get: async () => { entered.resolve(); return late.promise } }); await entered.promise
stale.closeRead(); await stale.read({ ...valid, async get() { return { retention_seconds: 0 } } })
const snapshot = stale.snapshot(); late.resolve({ retention_seconds: 2592000 }); await old; assert.equal(stale.snapshot(), snapshot)
let callsDuringRender = 0
const renderApi: RetentionApi = { async get() { callsDuringRender++; return {} }, async post() { callsDuringRender++; return {} } }
renderToStaticMarkup(createElement(GlobalRetentionSettings, { api: renderApi, flow: new GlobalRetentionFlow() })); assert.equal(callsDuringRender, 0, 'SSR does not schedule cleanup or fetch')
for (const english of [false, true]) for (const state of [new GlobalRetentionFlow().snapshot(), { phase: 'reading', seconds: null, outcome: 'none' }, { phase: 'read-error', seconds: 2592000, outcome: 'none' }, { phase: 'saving', seconds: 2592000, outcome: 'none', slow: true }, { phase: 'ready', seconds: 0, outcome: 'uncertain' }, { phase: 'ready', seconds: 2592000, outcome: 'confirmed' }] as const) {
  const props = { state, draft: '3600', custom: false, acknowledged: true, onDraft() {}, onCustom() {}, onAcknowledge() {}, read() {}, apply() {}, english }
  const html = renderToStaticMarkup(createElement(GlobalRetentionView, props))
  assert(html.includes(english ? 'irreversible history removal' : '不可撤销的历史清理'))
  assert(html.includes(english ? 'no cross-user precondition' : '无跨用户条件保护'))
  assert(html.includes(english ? 'Proposed' : '拟修改')); assert(html.includes('type="button"'))
  const editable = state.phase === 'ready' && state.outcome !== 'uncertain'
  assert.equal(/<select[^>]* disabled=""/.test(html), !editable)
  assert.equal(/<button[^>]* disabled=""[^>]*>[^<]*(Confirm retention policy|确认应用保留策略)/.test(html), !editable)
  if (state.outcome === 'uncertain') assert(html.includes(english ? 'cannot establish' : '不能证明'))
}
assert(reads > 0)
console.log('GLOBAL RETENTION OK: actual reads only, invalid/timeout recovery, no opening-read/save race, explicit valid draft + acknowledgment, single pending write across close/reopen, strict acknowledgment, uncertain outcome never retried even after re-read, stale read isolation and bilingual SSR; fake APIs only, no cleanup/database/network/hardware')
