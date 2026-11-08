import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as reads from '../apps/web/src/config-read.ts'
import { DraftNavigation } from '../apps/web/src/draft-navigation.ts'

const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const nodes: ts.VariableDeclaration[] = []
const visit = (node: ts.Node) => { if (ts.isVariableDeclaration(node)) nodes.push(node); ts.forEachChild(node, visit) }; visit(source)
const compile = (name: string, env: Record<string, unknown>) => {
  const node = nodes.find(node => node.name.getText(source) === name)!, callback = (node.initializer as ts.CallExpression).arguments[0]
  assert(callback)
  return new Function(...Object.keys(env), ts.transpileModule('return (' + callback.getText(source) + ')', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText)(...Object.values(env)) as (...args: any[]) => void
}
const tick = (ms = 25) => new Promise<void>(resolve => setTimeout(resolve, ms))
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const timeoutRead = (...args: any[]) => (reads as any).readConfigRequest(args[0], args[1], args[2], 5)
const classify = (error: unknown) => (reads as any).configReadFailure(error)

// Execute the actual production refresh callback, not a hand-written equivalent.
const deviceRead = { current: new reads.LatestConfigRead() }, signals: AbortSignal[] = []
const old = deferred<any>(), accepted: any[] = [], errors: unknown[] = [], connected: any[] = []
let get = (_url: string, options: RequestInit) => { signals.push(options.signal!); return old.promise }
const refreshDevices = compile('refreshDevices', { deviceRead, draftNavigation: new DraftNavigation(), setRetainedDrafts: (records: unknown[]) => { assert.deepEqual(records, []) }, request: (url: string, options: RequestInit) => { assert.equal(url, '/api/monitor_objects'); assert.equal(options.method, undefined); return get(url, options) }, readConfigRequest: timeoutRead, configReadFailure: classify, setDevices: (value: any) => accepted.push(value), setDeviceConnected: (value: any) => connected.push(value), setDeviceLoadError: (value: unknown) => errors.push(value) })
try {
  refreshDevices(); await tick()
  assert.equal(errors.at(-1), 'timeout', 'a hung actual device-list callback must reach a visible retryable error')
  assert.equal(signals[0].aborted, true); assert.equal(accepted.length, 0)
  get = async () => [{ id: 2, connected: true }]; refreshDevices(); await tick()
  assert.deepEqual(accepted.at(-1), [{ id: 2, connected: true }]); assert.deepEqual(connected.at(-1), { 2: true }); assert.equal(errors.at(-1), null)
  old.resolve([{ id: 1, connected: false }]); await tick(0); assert.equal(accepted.length, 1, 'late data after timeout cannot replace recovery')
  get = async () => { throw new Error('mock HTTP 503') }; refreshDevices(); await tick(); assert.equal(errors.at(-1), 'failed'); assert.equal(accepted.length, 1)
  get = async () => []; refreshDevices(); await tick(); assert.deepEqual(accepted.at(-1), []); assert.equal(errors.at(-1), null)
} finally { deviceRead.current.cancel() }

assert.equal((reads as any).CONFIG_READ_TIMEOUT_MS, 10000)
const groupRead = { current: new reads.LatestConfigRead() }, selectedIdRef = { current: 5 }, groups = [1, 2].map(id => ({ id, name: 'g', slaveId: 1, functionCode: 3, startAddress: 0, quantity: 1, isActive: 1 }))
const paths: string[] = [], snapshots: any[] = [], groupErrors: unknown[] = []
let held = deferred<any>()
let hang = true, hangGroup = 1
const refreshRegisters = compile('refreshRegisters', { groupRead, selectedIdRef, readDeviceGroups: reads.readDeviceGroups, readConfigRequest: timeoutRead, configReadFailure: classify, request: async (url: string, options: RequestInit) => { assert.equal(options.method, undefined); paths.push(url); return url.includes('monitor_objects') ? groups : hang && url.includes('/' + hangGroup + '/') ? held.promise : [] }, setGroupSnapshot: (value: any) => snapshots.push(value), setGroupLoadError: (value: unknown) => groupErrors.push(value) })
try {
  refreshRegisters(5); await tick(); assert.equal(groupErrors.at(-1), 'timeout'); assert.equal(snapshots.length, 0)
  assert.deepEqual(paths, ['/api/monitor_objects/5/groups', '/api/groups/1/registers'], 'timeout must stop subsequent requests and never publish a partial graph')
  hang = false; refreshRegisters(5); await tick(); assert.equal(snapshots.length, 1); assert.equal(snapshots[0].groups.length, 2); assert.equal(groupErrors.at(-1), null)
  held.resolve([{ id: 99 }]); await tick(0); assert.equal(snapshots.length, 1)
  held = deferred<any>(); hang = true; hangGroup = 2; refreshRegisters(5); await tick()
  assert.equal(groupErrors.at(-1), 'timeout'); assert.equal(snapshots.length, 1, 'a timeout after an earlier group succeeded keeps the complete prior graph')
  held.resolve([{ id: 100 }]); await tick(0); assert.equal(snapshots.length, 1)
  hang = false; refreshRegisters(5); await tick(); assert.equal(groupErrors.at(-1), null); assert.equal(snapshots.length, 2)
  held = deferred<any>(); hang = true; hangGroup = 1; const before = groupErrors.length; refreshRegisters(5); await tick(0); selectedIdRef.current = 6; groupRead.current.cancel(); await tick(); assert.equal(groupErrors.length, before, 'leaving a device cancels without publishing an error to its successor')
} finally { groupRead.current.cancel() }

// A slow but progressing multi-group graph has a fresh budget per GET, not one total deadline.
const controller = new AbortController(), began = Date.now()
const progressing = await reads.readDeviceGroups(5, controller.signal, (url, signal) => (reads as any).readConfigRequest(url, signal, async () => { await tick(5); return url.includes('monitor_objects') ? [...groups, { ...groups[1], id: 3 }] : [] }, 15))
assert.equal(progressing.length, 3); assert(Date.now() - began >= 15)

// Include the real response JSON/text body waits, not merely a mock network-header wait.
const requestNode = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'request')!
const bodyRequest = new Function('fetch', ts.transpileModule('return (' + requestNode.getText(source) + ')', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText)
for (const ok of [true, false]) {
  let aborted = false
  const actualRequest = bodyRequest(async (_url: string, options: RequestInit) => { options.signal!.addEventListener('abort', () => { aborted = true }); return { ok, status: ok ? 200 : 503, json: () => new Promise(() => {}), text: () => new Promise(() => {}) } })
  await assert.rejects((reads as any).readConfigRequest('/api/monitor_objects', controller.signal, (url: string, signal: AbortSignal) => actualRequest(url, { signal }), 5), error => (error as Error).name === 'RequestTimeoutError')
  assert(aborted)
}
const cancelled = new AbortController(); cancelled.abort(); let called = 0
await assert.rejects((reads as any).readConfigRequest('/api/monitor_objects', cancelled.signal, async () => { called++; return [] }, 5)); assert.equal(called, 0)

const { ConfigLoadNotice } = await import('../apps/web/src/ConfigLoadNotice.tsx')
const render = (deviceError: any, groupError: any, english = false) => renderToStaticMarkup(createElement(ConfigLoadNotice, { deviceError, groupError, english, onRetry() {} }))
assert.equal(render(null, null), '')
assert.match(render('timeout', null), /设备清单.*10.*秒.*重试/)
assert.match(render(null, 'failed'), /点表.*失败.*上次/)
assert.match(render('timeout', 'failed', true), /Device list.*10.*Point table.*Retry/)
assert.match(render('failed', null), /role="alert"/)
const appText = source.getFullText(); assert.match(appText, /<ConfigLoadNotice\s+deviceError=\{deviceLoadError\}\s+groupError=\{groupLoadError\}/)
assert.match(appText, /onRetry=\{\(\) => \{ refreshDevices\(\); if \(selectedId != null\) refreshRegisters\(selectedId\) \}\}/)
assert(!nodes.find(node => node.name.getText(source) === 'api')!.getText(source).includes('readConfigRequest'), 'mutation helpers keep their original uncancelled path')
console.log('CONFIG READ TIMEOUT OK: actual App list/group callbacks, timeout→retry/empty/failure, late result isolation, body waits, cancellation, whole-graph/no-follow-up and per-GET budgets; bilingual notice SSR and production wiring; mocks only, no DOM/network/database/hardware')
