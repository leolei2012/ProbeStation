import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep, basename } from 'node:path'
import Fastify from 'fastify'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { registerAssistant } from '../packages/api/src/assistant.ts'
import { parseDeviceIssues, DeviceIssuesRead } from '../apps/web/src/device-issues-read.ts'
import { DeviceIssues, DeviceIssuesView } from '../apps/web/src/DeviceIssues.tsx'
import ts from 'typescript'

// Only a newly-created empty temporary data directory; no real assistant configuration is read.
const dir = mkdtempSync(join(tmpdir(), 'probestation-issues-')), app = Fastify(); let effects = 0
const devices = [{ id: 1, name: '<script>paused</script>', mode: 'master', isActive: 0 }, { id: 2, name: 'two reasons', mode: 'master', isActive: 1 }, { id: 3, name: 'slave', mode: 'slave', isActive: 1 }, { id: 4, name: 'missing data', mode: 'master', isActive: 1 }]
const groups = (id: number) => id === 2 ? [{ id: 20, objectId: id, isActive: 0 }, { id: 21, objectId: id, isActive: 1, functionCode: 3, startAddress: 0, quantity: 1, slaveId: 1 }] : [{ id: id * 10, objectId: id, isActive: 1, functionCode: 3, startAddress: 0, quantity: 1, slaveId: 1 }]
const cfg: any = { listObjects: () => devices, getObject: (id: number) => devices.find(device => device.id === id), listGroups: groups, listRegistersByObject: (id: number) => [{ id: id * 100, objectId: id, groupId: id * 10, functionCode: 3, startAddress: 0, dataType: 'uint16' }], updateObject() { effects++ }, log() { effects++ } }
const store: any = { getLatestByObjectAll: () => ({}), write() { effects++ } }
const poller: any = { getDeviceDiagnostics: (id: number) => ({ connected: id !== 2 }), isDeviceConnected: () => false, reconnectDevice() { effects++ }, read() { effects++ }, write() { effects++ } }
registerAssistant(app, { cfg, store, poller }, dir, async () => { effects++; throw new Error('model must never be called') })
let actual!: ReturnType<typeof parseDeviceIssues>
try {
  const get = async (url: string, signal: AbortSignal) => { assert.equal(url, '/api/ai/issues'); assert(signal instanceof AbortSignal); const response = await app.inject({ url, headers: { 'X-ProbeStation-AI': '1' } }); assert.equal(response.statusCode, 200); return response.json() }
  const reader = new DeviceIssuesRead(); await reader.refresh(get); assert.equal(reader.snapshot().phase, 'ready'); actual = reader.snapshot().value!
  assert.equal(actual.issues.length, 5); assert.equal(actual.issues.filter(issue => issue.deviceId === 2).length, 2, 'multiple reminders for one device are not deduplicated'); assert.equal(actual.issues.find(issue => issue.deviceId === 3)!.view, 'diagnostics'); assert(actual.issues.find(issue => issue.deviceId === 4)!.reason.includes('不完整')); assert.equal(effects, 0)
  assert.equal((await app.inject('/api/ai/issues')).statusCode, 403, 'existing read header remains required')
} finally {
  await app.close()
  const absolute = resolve(dir), parent = resolve(tmpdir())
  assert(absolute.startsWith(parent + sep) && basename(absolute).startsWith('probestation-issues-'), 'cleanup stays within this explicit temporary parent')
  rmSync(absolute, { recursive: true, force: true })
}
const sample = { issues: [{ deviceId: 1, view: 'history', label: '<script>only text</script>', reason: 'reason', registerId: 9, start: '2026-11-07T00:00:00.123Z', end: '2026-11-07T00:00:01.456Z', valueMode: 'raw', token: 999, private: 'not copied' }], checkedAt: Date.parse('2026-11-07T00:00:00Z') }
const value = parseDeviceIssues(sample); assert(Object.isFrozen(value)); assert(Object.isFrozen(value.issues)); assert(Object.isFrozen(value.issues[0])); assert.equal(value.issues[0].start, sample.issues[0].start); assert(!Object.hasOwn(value.issues[0], 'token')); assert(!Object.hasOwn(value.issues[0], 'private')); sample.issues[0].reason = 'later'; assert.equal(value.issues[0].reason, 'reason')
assert.equal(parseDeviceIssues({ issues: [] }).checkedAt, null, 'legacy absence of backend time is not replaced with receipt time')
for (const invalid of [null, [], {}, { issues: null }, { issues: {} }, { issues: [null] }, { issues: [{}] }, { issues: [], checkedAt: '123' }, { issues: [], checkedAt: NaN }, { issues: [], checkedAt: Number.MAX_SAFE_INTEGER }, { issues: [{ deviceId: 0, view: 'live', label: '', reason: '' }] }, { issues: [{ deviceId: 1, view: 'other', label: '', reason: '' }] }, { issues: [{ ...sample.issues[0], start: 'invalid' }] }, { issues: [{ ...sample.issues[0], registerId: '9' }] }]) assert.throws(() => parseDeviceIssues(invalid))
const deferred = <T,>() => { let resolve!: (value: T) => void, reject!: (value: Error) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail }); return { promise, resolve, reject } }
const reader = new DeviceIssuesRead(), first = deferred<any>(); let calls = 0, notices = 0
const stop = reader.subscribe(() => notices++), pending = reader.refresh(async () => { calls++; return first.promise })
await Promise.resolve(); await reader.refresh(async () => { calls++; return sample }); assert.equal(calls, 1); first.resolve(sample); await pending; assert.equal(reader.snapshot().phase, 'ready')
await reader.refresh(async () => { throw new Error('PRIVATE response detail') }); assert.equal(reader.snapshot().error, 'request'); assert.equal(reader.snapshot().value!.issues.length, 1); assert(!JSON.stringify(reader.snapshot()).includes('PRIVATE'))
await reader.refresh(async () => ({ issues: null })); assert.equal(reader.snapshot().error, 'invalid'); assert.equal(reader.snapshot().value!.issues.length, 1)
const slow = deferred<any>(); let aborted!: AbortSignal
await reader.refresh(async (_url, signal) => { aborted = signal; return slow.promise }, 5); assert.equal(reader.snapshot().error, 'timeout'); assert(aborted.aborted)
await reader.refresh(async () => ({ issues: [], checkedAt: 0 })); slow.resolve(sample); await Promise.resolve(); assert.equal(reader.snapshot().phase, 'ready'); assert.equal(reader.snapshot().value!.issues.length, 0)
const old = deferred<any>(), oldTask = reader.refresh(async () => old.promise); await Promise.resolve(); reader.cancel(); const fresh = deferred<any>(), freshTask = reader.refresh(async () => fresh.promise); await Promise.resolve(); old.reject(new Error('old failure')); await oldTask; assert.equal(reader.snapshot().phase, 'loading')
let duplicate = 0; await reader.refresh(async () => { duplicate++; return sample }); assert.equal(duplicate, 0, 'obsolete finalizer cannot unlock the new request'); fresh.resolve(sample); await freshTask; assert.equal(reader.snapshot().phase, 'ready')
const late = deferred<any>(), task = reader.refresh(async () => late.promise); await Promise.resolve(); reader.cancel(); const canceled = reader.snapshot(); late.resolve({ issues: [] }); await task; assert.equal(reader.snapshot(), canceled)
stop(); const n = notices; await reader.refresh(async () => sample); assert.equal(notices, n)
let callbacks = 0
for (const english of [false, true]) {
  const render = (state: any) => renderToStaticMarkup(createElement(DeviceIssuesView, { state, english, onNavigate() { callbacks++ }, refresh() { callbacks++ } }))
  const initial = render({ phase: 'loading' }); assert(initial.includes('disabled=""')); assert(!initial.includes('<details>')); assert(!initial.includes(' · 0'))
  const full = render({ phase: 'ready', value: actual }); assert(full.includes('&lt;script&gt;paused&lt;/script&gt;')); assert(!full.includes('<script>')); assert(full.includes('two reasons')); assert(full.includes(english ? 'Backend check UTC' : '后端核对UTC')); assert(full.includes('<details>')); assert(!full.includes('<details open'), 'reminders retain the existing collapsed presentation')
  assert(render({ phase: 'error', error: 'timeout', value }).includes(english ? 'previous target' : '上次关联位置'))
  assert(render({ phase: 'error', error: 'invalid', value }).includes(english ? 'unverified' : '未核实'))
  const empty = render({ phase: 'ready', value: parseDeviceIssues({ issues: [] }) }); assert(empty.includes(english ? 'does not establish device health' : '不等于设备健康')); assert(empty.includes(english ? 'Not provided' : '未提供'))
  assert(render({ phase: 'error', error: 'request', value: parseDeviceIssues({ issues: [] }) }).includes(english ? 'previous snapshot had no reminders' : '上次汇总没有提醒'))
}
renderToStaticMarkup(createElement(DeviceIssues, { onNavigate() { callbacks++ }, get: async () => { callbacks++; return sample } })); assert.equal(callbacks, 0)

// Execute the actual small navigation callbacks and tab declaration, not App or its
// mounted components. This covers their contract together without DOM or service I/O.
const navFile = ts.createSourceFile('App.tsx', readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function collect(root: ts.Node, predicate: (node: ts.Node) => boolean) {
  const out: ts.Node[] = []; const walk = (node: ts.Node) => { if (predicate(node)) out.push(node); ts.forEachChild(node, walk) }; walk(root); return out
}
const deviceView = navFile.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'DeviceView')!
assert(deviceView)
const property = (root: ts.Node, object: string, key: string) => collect(root, node => ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === object && node.name.text === key).length > 0
const viewEffects = collect(deviceView, node => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'useEffect') as ts.CallExpression[]
const navEffects = viewEffects.filter(call => property(call.arguments[0], 'target', 'view') || property(call.arguments[0], 'device', 'mode'))
assert.equal(navEffects.length, 2, 'review the navigation harness when callback boundaries change')
const tabs = collect(deviceView, node => ts.isJsxAttribute(node) && node.name.getText(navFile) === 'tabs' && (ts.isJsxSelfClosingElement(node.parent.parent) || ts.isJsxOpeningElement(node.parent.parent)) && node.parent.parent.tagName.getText(navFile) === 'TabBar')[0] as ts.JsxAttribute
assert(tabs && tabs.initializer && ts.isJsxExpression(tabs.initializer) && tabs.initializer.expression)
const evaluate = (expression: ts.Node, names: string[], values: unknown[]) => new Function(...names, ts.transpileModule('const result = ' + expression.getText(navFile) + '; return result', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText)(...values)
const offered = (mode: string) => evaluate((tabs.initializer as ts.JsxExpression).expression!, ['device', 't'], [{ mode }, (key: string) => key]).map((tab: { id: number }) => tab.id) as number[]
function navigation(initial = 0) {
  let tab = initial; const previous = new Map<ts.Node, unknown[]>()
  return { choose(value: number) { tab = value }, render(mode: string, target: unknown) {
    const names = ['device', 'target', 'setTab'], values = [{ mode }, target, (next: number | ((current: number) => number)) => { tab = typeof next === 'function' ? next(tab) : next }]
    for (const effect of navEffects) {
      const deps = evaluate(effect.arguments[1], names, values) as unknown[], old = previous.get(effect)
      if (!old || deps.length !== old.length || deps.some((value, index) => !Object.is(value, old[index]))) { previous.set(effect, deps); evaluate(effect.arguments[0], names, values)() }
    }
    assert(offered(mode).includes(tab), 'navigation must select an offered tab'); return tab
  } }
}
const navigate = collect(navFile, node => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'navigateData')[0] as ts.VariableDeclaration
assert(navigate?.initializer)
let selectedDevice = 0, selectedView = '', target: any
const sequence = { current: 0 }, emitTarget = evaluate(navigate.initializer, ['canNavigate', 'setSelectedId', 'setView', 'setDataTarget', 'navigationSequence'], [() => true, (id: number) => { selectedDevice = id }, (view: string) => { selectedView = view }, (value: unknown) => { target = value }, sequence])
const targetAttribute = collect(navFile, node => ts.isJsxAttribute(node) && node.name.getText(navFile) === 'target' && ts.isJsxSelfClosingElement(node.parent.parent) && node.parent.parent.tagName.getText(navFile) === 'DeviceView')[0] as ts.JsxAttribute
assert(targetAttribute?.initializer && ts.isJsxExpression(targetAttribute.initializer) && targetAttribute.initializer.expression)
for (const issue of actual.issues) {
  const mode = devices.find(device => device.id === issue.deviceId)!.mode, view = navigation(1), before = JSON.stringify(issue)
  view.render(mode, null); emitTarget(issue)
  assert.equal(selectedDevice, issue.deviceId); assert.equal(selectedView, 'monitor'); assert.equal(JSON.stringify(issue), before)
  assert.equal(view.render(mode, target), issue.view === 'diagnostics' && mode !== 'slave' ? 3 : 0)
  emitTarget(issue); assert.equal(view.render(mode, target), issue.view === 'diagnostics' && mode !== 'slave' ? 3 : 0, 'repeat navigation while device mode is unchanged')
  assert.equal(evaluate((targetAttribute.initializer as ts.JsxExpression).expression!, ['dataTarget', 'selected'], [target, { id: issue.deviceId }]), target)
  assert.equal(evaluate((targetAttribute.initializer as ts.JsxExpression).expression!, ['dataTarget', 'selected'], [target, { id: 999 }]), null, 'another device must not receive this target')
}
const history = navigation(1), historyTarget = { ...value.issues[0], token: 999 }
emitTarget(historyTarget); assert.notEqual(target.token, 999); assert.equal(target.registerId, 9); assert.equal(target.start, '2026-11-07T00:00:00.123Z'); assert.equal(target.end, '2026-11-07T00:00:01.456Z'); assert.equal(target.valueMode, 'raw')
assert.equal(history.render('slave', target), 2); history.choose(1); assert.equal(history.render('slave', target), 1, 'ordinary re-render must not replay a consumed navigation'); emitTarget(historyTarget); assert.equal(history.render('slave', target), 2)
const roleChange = navigation(); const diagnosticTarget = { deviceId: 1, view: 'diagnostics', token: 100 }
assert.equal(roleChange.render('master', diagnosticTarget), 3); assert.equal(roleChange.render('slave', diagnosticTarget), 0); roleChange.choose(1); assert.equal(roleChange.render('master', diagnosticTarget), 1, 'role change must not replay the old target'); assert.equal(roleChange.render('master', { ...diagnosticTarget, token: 101 }), 3)
for (const mode of ['master', 'slave']) { const none = navigation(1); assert.equal(none.render(mode, null), 1) }
console.log('DEVICE ISSUES READ OK: actual injected summary route through App navigation callbacks/offered tabs, repeated slave/master targets, one-shot navigation/role changes/device scope/exact history fields, immutable single-flight reads and timeout/late recovery, bilingual SSR; no actual service, model, hardware, real data or DOM automation')
