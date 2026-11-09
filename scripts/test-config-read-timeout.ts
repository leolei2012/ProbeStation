import assert from 'node:assert/strict'
import { CONFIG_WRITE_NOT_STARTED, configurationWriteReceipt } from '../apps/web/src/configuration-write-outcome.ts'
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
let loading = true
let get = (_url: string, options: RequestInit) => { signals.push(options.signal!); return old.promise }
const refreshDevices = compile('refreshDevices', { deviceRead, draftNavigation: new DraftNavigation(), setRetainedDrafts: (records: unknown[]) => { assert.deepEqual(records, []) }, request: (url: string, options: RequestInit) => { assert.equal(url, '/api/monitor_objects'); assert.equal(options.method, undefined); return get(url, options) }, readConfigRequest: timeoutRead, configReadFailure: classify, setDevices: (value: any) => accepted.push(value), setDeviceConnected: (value: any) => connected.push(value), setDeviceLoading: (value: boolean) => { loading = value }, setDeviceLoadError: (value: unknown) => errors.push(value) })
try {
  refreshDevices(); assert.equal(loading, true); await tick(); assert.equal(loading, false)
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
let hang = true, hangGroup = 1, groupUnavailable = false
const refreshRegisters = compile('refreshRegisters', { groupRead, selectedIdRef, readDeviceGroups: reads.readDeviceGroups, readConfigRequest: timeoutRead, configReadFailure: classify, request: async (url: string, options: RequestInit) => { assert.equal(options.method, undefined); paths.push(url); if (groupUnavailable && url.includes('/2/registers')) throw Error('HTTP 503 PRIVATE group'); return url.includes('monitor_objects') ? groups : hang && url.includes('/' + hangGroup + '/') ? held.promise : [] }, setGroupSnapshot: (value: any) => snapshots.push(value), setGroupLoadError: (value: unknown) => groupErrors.push(value) })
try {
  refreshRegisters(5); await tick(); assert.equal(groupErrors.at(-1), 'timeout'); assert.equal(snapshots.length, 0)
  assert.deepEqual(paths, ['/api/monitor_objects/5/groups', '/api/groups/1/registers'], 'timeout must stop subsequent requests and never publish a partial graph')
  hang = false; refreshRegisters(5); await tick(); assert.equal(snapshots.length, 1); assert.equal(snapshots[0].groups.length, 2); assert.equal(groupErrors.at(-1), null)
  held.resolve([{ id: 99 }]); await tick(0); assert.equal(snapshots.length, 1)
  held = deferred<any>(); hang = true; hangGroup = 2; refreshRegisters(5); await tick()
  assert.equal(groupErrors.at(-1), 'timeout'); assert.equal(snapshots.length, 1, 'a timeout after an earlier group succeeded keeps the complete prior graph')
  held.resolve([{ id: 100 }]); await tick(0); assert.equal(snapshots.length, 1)
  hang = false; refreshRegisters(5); await tick(); assert.equal(groupErrors.at(-1), null); assert.equal(snapshots.length, 2)
  groupUnavailable = true; refreshRegisters(5); await tick(); assert.equal(groupErrors.at(-1), 'unavailable'); assert.equal(snapshots.length, 2, '503 after the first group must retain the complete old graph')
  groupUnavailable = false; refreshRegisters(5); await tick(); assert.equal(groupErrors.at(-1), null); assert.equal(snapshots.length, 3)
  held = deferred<any>(); hang = true; hangGroup = 1; const before = groupErrors.length; refreshRegisters(5); await tick(0); selectedIdRef.current = 6; groupRead.current.cancel(); await tick(); assert.equal(groupErrors.length, before, 'leaving a device cancels without publishing an error to its successor')
} finally { groupRead.current.cancel() }

// A slow but progressing multi-group graph has a fresh budget per GET, not one total deadline.
const controller = new AbortController(), began = Date.now()
const progressing = await reads.readDeviceGroups(5, controller.signal, (url, signal) => (reads as any).readConfigRequest(url, signal, async () => { await tick(5); return url.includes('monitor_objects') ? [...groups, { ...groups[1], id: 3 }] : [] }, 15))
assert.equal(progressing.length, 3); assert(Date.now() - began >= 15)

// Include the real response JSON/text body waits, not merely a mock network-header wait.
const requestNode = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'request')!
const bodyRequest = (fetcher: unknown) => new Function('fetch', 'configurationWriteReceipt', 'CONFIG_WRITE_NOT_STARTED', ts.transpileModule('return (' + requestNode.getText(source) + ')', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText)(fetcher, configurationWriteReceipt, CONFIG_WRITE_NOT_STARTED)
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
// The actual App HTTP adapter must retain a 503 distinction through its real refresh callback.
let unavailable = true
const httpCalls: string[] = []
const unavailableRequest = bodyRequest(async (url: string, options?: RequestInit) => {
  assert.equal(options?.method, undefined, 'recovery checks must only read'); httpCalls.push(url)
  return { ok: !unavailable, status: unavailable ? 503 : 200, text: async () => JSON.stringify({ code: 'CONFIG_TRANSACTION_UNCONFIRMED', message: 'PRIVATE database detail' }), json: async () => [{ id: 2, connected: false }] }
})
try {
  get = async () => [{ id: 2, connected: true }]; refreshDevices(); await tick()
  get = (url, options) => unavailableRequest(url, options); const saved = accepted.at(-1), savedCount = accepted.length
  refreshDevices(); await tick(); assert.equal(errors.at(-1), 'unavailable'); assert.equal(accepted.length, savedCount); assert.equal(accepted.at(-1), saved, '503 must retain the previous snapshot rather than publish empty')
  refreshDevices(); await tick(); assert.equal(errors.at(-1), 'unavailable'); assert.equal(httpCalls.length, 2, 'manual read retry neither restores a connection nor sends a write')
  unavailable = false; refreshDevices(); await tick(); assert.equal(errors.at(-1), null); assert.equal(accepted.length, savedCount + 1); assert.deepEqual(accepted.at(-1), [{ id: 2, connected: false }])
} finally { deviceRead.current.cancel() }
for (const message of ['HTTP 500 service', 'HTTP 5030 service', 'HTTP 403 service', 'unrelated 503 text', 'mock HTTP 503']) assert.equal(classify(new Error(message)), 'failed')
for (const message of ['HTTP 503', 'HTTP 503 Service Unavailable', 'HTTP 503 PRIVATE detail']) assert.equal(classify(new Error(message)), 'unavailable')
for (const english of [false, true]) {
  const markup = render('unavailable', 'failed', english)
  assert.match(markup, /503/); assert.match(markup, english ? /administrator/i : /管理员/); assert.match(markup, english ? /read.only/i : /只读/); assert.match(markup, english ? /Do not.*sav.*import/i : /不要.*保存.*导入/)
  assert(!markup.includes('PRIVATE')); assert.match(markup, /role="alert"/)
  assert.match(render(null, 'unavailable', english), english ? /Point table.*503.*administrator/i : /点表.*503.*管理员/)
}
const emptyNode = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'EmptyState')!
const EmptyState = new Function('React', ts.transpileModule('return (' + emptyNode.getText(source) + ')', { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText)({ createElement })
{
  const pending = renderToStaticMarkup(createElement(EmptyState, { t: (key: string) => key, onAdd() {}, loading: true }))
  assert.match(pending, /deviceListLoading/, 'an unresolved first list read must not claim an empty configuration')
  assert.doesNotMatch(pending, /emptyHint|<button/)
}
for (const unverified of [true, false]) {
  const markup = renderToStaticMarkup(createElement(EmptyState, { t: (key: string) => key, onAdd() {}, unverified }))
  if (unverified) { assert(markup.includes('configUnread')); assert(!markup.includes('<button')); assert(!markup.includes('emptyHint')) }
  else { assert(markup.includes('emptyHint')); assert(markup.includes('<button')) }
}
const appText = source.getFullText(); assert.match(appText, /<ConfigLoadNotice\s+deviceError=\{deviceLoadError\}\s+groupError=\{groupLoadError\}/)
let emptyGuard = ''
const findEmptyGuard = (node: ts.Node) => { if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'EmptyState') { const attribute = node.attributes.properties.find(value => ts.isJsxAttribute(value) && value.name.getText(source) === 'unverified'); if (attribute && ts.isJsxAttribute(attribute)) emptyGuard = attribute.initializer?.getText(source) ?? '' }; ts.forEachChild(node, findEmptyGuard) }; findEmptyGuard(source)
assert.equal(emptyGuard, '{deviceLoadError !== null}')
assert.match(appText, /t\(deviceLoading \? 'deviceListLoading' : deviceLoadError \? 'configUnread' : 'noDevices'\)/)
assert.match(appText, /onRetry=\{\(\) => \{ refreshDevices\(\); if \(selectedId != null\) refreshRegisters\(selectedId\) \}\}/)
assert(!nodes.find(node => node.name.getText(source) === 'api')!.getText(source).includes('readConfigRequest'), 'mutation helpers keep their original uncancelled path')
{
  function find(node: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node | undefined { if (predicate(node)) return node; let found: ts.Node | undefined; ts.forEachChild(node, child => { found ??= find(child, predicate) }); return found }
  const evaluate = (node: ts.Node, env: Record<string, unknown>) => new Function(...Object.keys(env), ts.transpileModule('return (' + node.getText(source) + ')', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React } }).outputText)(...Object.values(env))
  const initialLoading = nodes.find(node => ts.isArrayBindingPattern(node.name) && node.name.elements[0]?.getText(source) === 'deviceLoading')!
  assert.equal((initialLoading.initializer as ts.CallExpression).arguments[0].kind, ts.SyntaxKind.TrueKeyword, 'first render must be pending before the mount effect starts the GET')
  const sidebarEmpty = find(source, node => ts.isBinaryExpression(node) && node.left.getText(source) === 'devices.length === 0')!
  const sidebarRefreshing = find(source, node => ts.isBinaryExpression(node) && node.left.getText(source) === 'devices.length > 0 && deviceLoading')!
  const messages = evaluate(nodes.find(node => node.name.getText(source) === 'I18N')!.initializer!, {})
  const deleteButton = find(source, node => ts.isJsxElement(node) && node.openingElement.getText(source).includes('className="device-del"'))!
  for (const english of [false, true]) for (const [busy, failure] of [[true, null], [false, 'failed'], [false, null]] as const) {
    const button = evaluate(deleteButton, { React: { createElement }, operation: { busy: false }, deviceLoading: busy, deviceLoadError: failure, d: { id: 2, name: 'synthetic retained device' }, t: (key: string) => messages[english ? 'en' : 'zh'][key], deleteDevice() { assert.fail('render must not delete') } })
    assert.equal(button.props.disabled, busy || failure !== null)
    if (button.props.disabled) assert.match(button.props.title, english ? /list.*unverified/i : /清单.*未核实/)
    else assert.equal(button.props.title, undefined)
  }
  let snapshot: any[] = [], error: reads.ConfigReadFailure | null = null, pending = true, updates = 0
  const owner = { current: new reads.LatestConfigRead() }, queue: Array<{ resolve(value: unknown): void; reject(error: unknown): void; signal: AbortSignal }> = []
  const refresh = compile('refreshDevices', { deviceRead: owner, draftNavigation: new DraftNavigation(), setRetainedDrafts() {}, readConfigRequest: reads.readConfigRequest, configReadFailure: reads.configReadFailure,
    request: (url: string, options: RequestInit) => { assert.equal(url, '/api/monitor_objects'); assert.equal(options.method, undefined); return new Promise((resolve, reject) => queue.push({ resolve, reject, signal: options.signal! })) },
    setDevices(value: any[]) { snapshot = value; updates++ }, setDeviceConnected() {}, setDeviceLoadError(value: reads.ConfigReadFailure | null) { error = value; updates++ }, setDeviceLoading(value: boolean) { pending = value; updates++ } })
  const sidebar = (english: boolean) => {
    const env = { React: { createElement }, devices: snapshot, deviceLoading: pending, deviceLoadError: error, t: (key: string) => messages[english ? 'en' : 'zh'][key] }
    return renderToStaticMarkup(createElement('div', null, evaluate(sidebarEmpty, env), evaluate(sidebarRefreshing, env)))
  }
  const initialView = () => { for (const english of [false, true]) {
    assert.match(sidebar(english), english ? /Reading device list/ : /正在读取设备清单/); assert.doesNotMatch(sidebar(english), /No devices|暂无设备/)
    const html = renderToStaticMarkup(createElement(EmptyState, { t: (key: string) => messages[english ? 'en' : 'zh'][key], loading: pending, unverified: error !== null, onAdd() { assert.fail('rendering must not create a device') } }))
    assert.match(html, /role="status"/); assert.doesNotMatch(html, /<button/)
  } }
  try {
    initialView(); refresh(); initialView(); await tick(0)
    queue[0].reject(new Error('HTTP 503 PRIVATE service')); await tick(0)
    assert.equal(error, 'unavailable'); assert.equal(pending, false); assert.deepEqual(snapshot, [])
    for (const english of [false, true]) { assert.match(sidebar(english), english ? /unverified/ : /尚未核实/); assert.doesNotMatch(sidebar(english), /No devices|暂无设备/); assert.match(render(error, null, english), /503/) }
    refresh(); await tick(0); refresh(); await tick(0); assert.equal(queue[1].signal.aborted, true)
    queue[1].resolve([]); await tick(0); assert.equal(pending, true, 'obsolete success cannot clear the current loading state'); initialView()
    queue[2].resolve([{ id: 2, connected: false }]); await tick(0); assert.equal(pending, false); assert.equal(error, null); assert.equal(snapshot[0].id, 2)
    const previous = snapshot; refresh(); assert.equal(snapshot, previous)
    for (const english of [false, true]) assert.match(sidebar(english), english ? /Refreshing.*previous snapshot/ : /刷新.*上次/)
    await tick(0); queue[3].resolve({ invalid: true }); await tick(0); assert.equal(pending, false); assert.equal(error, 'failed'); assert.equal(snapshot, previous, 'invalid replies retain the complete prior list, never empty it')
    refresh(); await tick(0); queue[4].resolve([]); await tick(0); assert.equal(pending, false); assert.equal(error, null)
    for (const english of [false, true]) assert.match(sidebar(english), english ? /No devices/ : /暂无设备/)
    refresh(); await tick(0); owner.current.cancel(); const writesAtClose = updates; queue[5].resolve([{ id: 99 }]); await tick(0); assert.equal(updates, writesAtClose, 'unmounted/cancelled read has no late loading or list updates')
    assert.equal(queue.length, 6, 'only explicit reads are issued; no automatic retry or write')
  } finally { owner.current.cancel() }
  console.log('DEVICE LIST STATE OK: actual initial loading/sidebar/main, 503 versus empty, retained refreshing snapshot, invalid response, overlap ownership, recovery and cancelled late reply; bilingual callbacks/SSR only.')
}
console.log('CONFIG READ TIMEOUT OK: actual App list/group callbacks, timeout→retry/empty/failure, late result isolation, body waits, cancellation, whole-graph/no-follow-up and per-GET budgets; actual HTTP 503 adapter, old snapshot retention/read-only recovery, status boundaries and bilingual notice/empty-state SSR; mocks only, no DOM/network/database/hardware')
