import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ConfigStore } from '../packages/config/src/index.ts'
import { RuntimeLogs, RuntimeLogsView } from '../apps/web/src/RuntimeLogs.tsx'
import { filterRuntimeLogs, InvalidRuntimeLogs, parseRuntimeLogs, RuntimeLogsRead, RUNTIME_LOG_LIMIT } from '../apps/web/src/runtime-logs.ts'

// Actual log producer in memory only. Client GET is injected; no HTTP listener, model or real log access.
const cfg = new ConfigStore({ dbPath: ':memory:' }), log = cfg.log.bind(cfg)
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const reader = new RuntimeLogsRead(); let reads = 0
const get = async (url: string, signal: AbortSignal) => { assert.equal(url, '/api/logs?limit=200'); assert.equal(signal.aborted, false); reads++; return JSON.parse(JSON.stringify(cfg.listLogs(RUNTIME_LOG_LIMIT))) }
try {
  for (let i = 1; i <= 199; i++) log(i % 2 ? 'WARN' : 'INFO', 'mock-poller', 'synthetic message ' + i)
  cfg.clearLogs = () => { throw new Error('read must not clear') }; cfg.log = () => { throw new Error('read must not log or mutate') }
  assert.equal(reader.snapshot().phase, 'idle'); assert.equal(reads, 0)
  const unsubscribe = reader.subscribe(() => {}); unsubscribe(); assert.equal(reads, 0)
  await reader.refresh(get); assert.equal(reader.snapshot().rows!.length, 199); assert.equal(cfg.listLogs(1000).length, 199)
  const below = renderToStaticMarkup(createElement(RuntimeLogsView, { state: reader.snapshot(), refresh() {} })); assert(!below.includes('已达200条读取上限'))
  log('ODD_LEVEL', 'mock', 'exact boundary'); await reader.refresh(get)
  assert.equal(reader.snapshot().rows!.length, 200)
  const exact = renderToStaticMarkup(createElement(RuntimeLogsView, { state: reader.snapshot(), refresh() {} })); assert(exact.includes('可能还有更早日志'))
  log('all', 'mock-special', '<script>synthetic()</script>\nline 2')
  ;(cfg as any).db.prepare('UPDATE logs SET ts = ? WHERE id = 201').run('2026-11-07 12:34:56')
  await reader.refresh(get); const snapshot = reader.snapshot(), rows = snapshot.rows!
  assert.equal(rows.length, 200); assert.equal(rows[0].id, 201); assert.equal(rows.at(-1)!.id, 2); assert.equal(rows[0].ts, '2026-11-07 12:34:56', 'legacy timestamp text must not be guessed or converted')
  assert.equal(cfg.listLogs(1000).length, 201); assert.throws(() => parseRuntimeLogs(cfg.listLogs(201)), InvalidRuntimeLogs)
  assert(Object.isFrozen(snapshot)); assert(Object.isFrozen(rows)); assert(Object.isFrozen(rows[0]))
  assert.equal(filterRuntimeLogs(rows, 'all', '').length, 1); assert.equal(filterRuntimeLogs(rows, null, 'MOCK-SPECIAL line 2')[0].id, 201)
  assert.equal(filterRuntimeLogs(rows, 'INFO', 'mock-poller synthetic').length, 99)
  assert.equal(filterRuntimeLogs(rows, null, 'missing-keyword').length, 0); assert.equal(filterRuntimeLogs(rows, null, '.*').length, 0, 'search terms are literal, never regular expressions')
  for (const english of [false, true]) {
    const html = renderToStaticMarkup(createElement(RuntimeLogsView, { state: snapshot, refresh() {}, english }))
    assert(html.includes('&lt;script&gt;')); assert(!html.includes('<script>')); assert(html.includes('2026-11-07 12:34:56')); assert(html.includes(english ? 'service-wide' : '全服务'))
    assert(html.includes(english ? 'earlier logs may exist' : '可能还有更早日志')); assert.equal((html.match(/<tr>/g) ?? []).length, 21, 'only one 20-row page is rendered')
    const stale = renderToStaticMarkup(createElement(RuntimeLogsView, { state: { ...snapshot, phase: 'error', error: 'timeout' }, refresh() {}, english }))
    assert(stale.includes(english ? 'Previous read snapshot' : '上次读取快照')); assert(stale.includes(english ? '10 seconds' : '10秒'))
  }
  const previous = reader.snapshot().rows, received = reader.snapshot().receivedAt
  await reader.refresh(async () => { throw new Error('PRIVATE transport detail') }); assert.equal(reader.snapshot().error, 'request'); assert.equal(reader.snapshot().rows, previous); assert.equal(reader.snapshot().receivedAt, received)
  await reader.refresh(async () => [{ id: 1 }]); assert.equal(reader.snapshot().error, 'invalid'); assert.equal(reader.snapshot().rows, previous)
  await reader.refresh(async () => []); assert.equal(reader.snapshot().phase, 'ready'); assert.deepEqual(reader.snapshot().rows, [])
  const empty = renderToStaticMarkup(createElement(RuntimeLogsView, { state: reader.snapshot(), refresh() {} })); assert(empty.includes('不能据此判断设备或历史数据正常'))
  const staleEmpty = renderToStaticMarkup(createElement(RuntimeLogsView, { state: { ...reader.snapshot(), phase: 'error', error: 'request' }, refresh() {} })); assert(staleEmpty.includes('上次快照没有日志')); assert(!staleEmpty.includes('本次快照没有日志'))
} finally { reader.cancel(); (cfg as any).db.close() }

const row = { id: 2, ts: '', level: '', source: '', message: '' }
for (const input of [null, {}, [null], [{ ...row, id: 0 }], [{ ...row, id: 1.5 }], [{ ...row, source: null }], [row, row], [{ ...row, id: 1 }, row]]) assert.throws(() => parseRuntimeLogs(input), InvalidRuntimeLogs)
const input = [{ ...row, privateField: 'PRIVATE' }], parsed = parseRuntimeLogs(input); input[0].message = 'changed'; assert.equal(parsed[0].message, ''); assert(!JSON.stringify(parsed).includes('PRIVATE')); assert.equal(filterRuntimeLogs(parsed, '', '').length, 1)
const lifecycle = new RuntimeLogsRead(), old = deferred<unknown>(), next = deferred<unknown>(); let requests = 0, firstSignal: AbortSignal | undefined
const fetch = async (_url: string, signal: AbortSignal) => { requests++; if (requests === 1) { firstSignal = signal; return old.promise }; return next.promise }
const first = lifecycle.refresh(fetch); await turn(); await lifecycle.refresh(fetch); assert.equal(requests, 1, 'repeated clicks do not restart the read deadline')
lifecycle.cancel(); assert(firstSignal!.aborted); const second = lifecycle.refresh(fetch); await turn(); await first; await lifecycle.refresh(fetch); assert.equal(requests, 2, 'old finally cannot unlock a new read')
next.resolve([row]); await second; old.resolve([{ id: 'bad' }]); await turn(); assert.equal(lifecycle.snapshot().phase, 'ready'); assert.equal(lifecycle.snapshot().rows![0].id, 2)
const hung = deferred<unknown>(); let timeoutSignal: AbortSignal | undefined
await lifecycle.refresh(async (_url, signal) => { timeoutSignal = signal; return hung.promise }, 15); assert.equal(lifecycle.snapshot().error, 'timeout'); assert(timeoutSignal!.aborted)
await lifecycle.refresh(async () => []); hung.resolve([row]); await turn(); assert.deepEqual(lifecycle.snapshot().rows, [], 'late response cannot replace the recovered snapshot')
const cancelled = deferred<unknown>(), final = lifecycle.refresh(async () => cancelled.promise); await turn(); lifecycle.cancel(); const before = lifecycle.snapshot(); cancelled.resolve([row]); await final; assert.equal(lifecycle.snapshot(), before)
let ssrCalls = 0
const initial = renderToStaticMarkup(createElement(RuntimeLogs, { get: async () => { ssrCalls++; return [] } })); assert.equal(ssrCalls, 0); assert(initial.includes('尚未读取日志')); assert(!initial.includes('本次快照没有日志'))
const failedInitial = renderToStaticMarkup(createElement(RuntimeLogsView, { state: { phase: 'error', error: 'request' }, refresh() {} })); assert(failedInitial.includes('当前结果未核实')); assert(!failedInitial.includes('快照没有日志'))
console.log('RUNTIME LOGS OK: memory producer 199/200/201 boundary, exact bounded GET/read-only rows, legacy timestamps, immutable strict parsing, literal level/search, 20-row bilingual escaped SSR, empty vs unverified/old snapshots, coalescing/cancel/finalizer/timeout/late recovery and SSR no I/O; no real logs, listeners, model, browser storage or hardware')
