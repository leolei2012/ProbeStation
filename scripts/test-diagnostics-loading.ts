import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import { DeferredResource } from '../apps/web/src/deferred-resource.ts'
import { DeferredPointDiagnostics, DeferredPointDiagnosticsView, pointDiagnosticsResource, type PointDiagnosticsProps, type PointDiagnosticsRenderer } from '../apps/web/src/DeferredPointDiagnostics.tsx'

// Code-only module loads and actual App/wrapper expressions; no browser, network,
// mounted report effect, database, driver, model or actual download.
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function find(node: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node | undefined { if (predicate(node)) return node; let result: ts.Node | undefined; ts.forEachChild(node, child => { result ??= find(child, predicate) }); return result }
const compile = (code: string) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React } }).outputText
const evaluate = (node: ts.Node, src: ts.SourceFile, env: Record<string, unknown>) => new Function(...Object.keys(env), compile('return (' + node.getText(src) + ')'))(...Object.values(env))
const deviceView = find(source, node => ts.isFunctionDeclaration(node) && node.name?.text === 'DeviceView')!
const panel = find(deviceView, node => ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'DeferredPointDiagnostics') as ts.JsxSelfClosingElement
assert(panel, 'actual App must use the deferred point diagnostics boundary')
const condition = find(deviceView, node => ts.isBinaryExpression(node) && node.left.getText(source) === 'tab === 5')!
const wrapper = ts.createSourceFile('DeferredPointDiagnostics.tsx', readFileSync(new URL('../apps/web/src/DeferredPointDiagnostics.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const effect = find(wrapper, node => ts.isCallExpression(node) && node.expression.getText(wrapper) === 'useEffect') as ts.CallExpression
const retry = find(wrapper, node => ts.isArrowFunction(node) && node.getText(wrapper).includes('resource.load(true)'))!
const closeAttribute = panel.attributes.properties.find(node => ts.isJsxAttribute(node) && node.name.getText(source) === 'onClose') as ts.JsxAttribute
const closeExpression = (closeAttribute.initializer as ts.JsxExpression).expression!
let requests = 0, closes = 0, mounts = 0, passed = 0
const props: PointDiagnosticsProps = { deviceId: 1, points: [{ id: 7, groupId: 9, alias: 'one', dataType: 'uint16', functionCode: 3, startAddress: 0, slaveId: 1 }], groups: [{ id: 9, name: 'one' }], pointLabels: new Map(), english: false, async fetcher() { requests++; throw Error('No report request is expected during code loading or SSR') } }
const Fake: PointDiagnosticsRenderer = next => React.createElement('p', null, 'device-' + next.deviceId + ':' + next.points[0]?.alias + ':' + next.english)
const app = (resource: DeferredResource<PointDiagnosticsRenderer>, tab = 5, ready = true, currentProps = props, setTab: (next: number) => void = () => { closes++ }) => evaluate(condition, source, { tab, configurationReady: ready, device: { id: currentProps.deviceId }, pointCheckContext: 'context-' + currentProps.deviceId, registers: currentProps.points, groups: currentProps.groups, pointCheckLabels: currentProps.pointLabels, fetchPointDiagnostics: currentProps.fetcher, t: (key: string) => key === 'cancel' ? currentProps.english ? 'Cancel' : '取消' : key, setTab, React, DeferredPointDiagnostics: (value: PointDiagnosticsProps & { onClose: () => void }) => { mounts++; return React.createElement(DeferredPointDiagnostics, { ...value, resource }) } })
const renderApp = (...args: Parameters<typeof app>) => renderToStaticMarkup(app(...args))
const begin = (resource: DeferredResource<PointDiagnosticsRenderer>) => { evaluate(effect.arguments[0], wrapper, { resource })(); return resource.load() }
async function check(name: string, fn: () => void | Promise<void>) { await fn(); passed++; console.log('DIAGNOSTICS LOADING OK: ' + name) }
await check('actual tab/configuration gate and SSR never import code or request a report', () => {
  let imports = 0
  const resource = new DeferredResource<PointDiagnosticsRenderer>(async () => { imports++; return Fake })
  assert.equal(pointDiagnosticsResource.snapshot().status, 'idle')
  assert.equal(renderApp(resource, 0), ''); assert.equal(renderApp(resource, 4), '')
  assert(renderApp(resource, 5, false).includes('pointCheckWaiting')); assert.equal(mounts, 0)
  assert(renderApp(resource).includes('正在加载')); assert.equal(mounts, 1)
  const element = evaluate(panel, source, { device: { id: 1 }, pointCheckContext: 'original-config-key', registers: props.points, groups: props.groups, pointCheckLabels: props.pointLabels, fetchPointDiagnostics: props.fetcher, t: () => '取消', setTab() {}, React, DeferredPointDiagnostics })
  assert.equal(element.key, 'original-config-key', 'existing configuration-key remount protection remains')
  assert.equal(imports, 0); assert.equal(requests, 0)
})
await check('closing via actual App callback before import completes cannot reopen or send a check', async () => {
  const content = deferred<PointDiagnosticsRenderer>(), entered = deferred<void>()
  let imports = 0, tab = 5, notifications = 0
  const resource = new DeferredResource<PointDiagnosticsRenderer>(async () => { imports++; entered.resolve(); return content.promise })
  const unsubscribe = resource.subscribe(() => notifications++)
  const pending = begin(resource); await entered.promise
  evaluate(closeExpression, source, { setTab: (next: number) => { tab = next; closes++ } })()
  assert.equal(tab, 0); unsubscribe(); const previousNotices = notifications
  content.resolve(Fake); await pending
  assert.equal(notifications, previousNotices, 'unsubscribed consumer stays closed on late code')
  assert.equal(renderApp(resource, tab), '')
  const current = { ...props, deviceId: 2, points: [{ ...props.points[0], alias: 'two', slaveId: 2 }], english: true }
  const html = renderApp(resource, 5, true, current)
  assert(html.includes('device-2:two:true')); assert(!html.includes('device-1:one'))
  await begin(resource); assert.equal(imports, 1, 'reopen reuses successful code with current props')
  assert.equal(requests, 0)
})
await check('shared import coalesces consumers and failed code needs explicit retry', async () => {
  const content = deferred<PointDiagnosticsRenderer>(); let imports = 0
  const resource = new DeferredResource<PointDiagnosticsRenderer>(async () => { imports++; return content.promise })
  const first = resource.load(), second = resource.load(true); assert.equal(first, second)
  content.resolve(Fake); await first; assert.equal(imports, 1)
  let attempts = 0
  const failed = new DeferredResource<PointDiagnosticsRenderer>(async () => { if (++attempts === 1) throw Error('PRIVATE module error'); return Fake })
  await begin(failed); assert.equal(failed.snapshot().status, 'error')
  const html = renderApp(failed); assert(html.includes('role="alert"')); assert(!html.includes('PRIVATE')); assert(html.includes('尚未发送本次检查请求'))
  await begin(failed); assert.equal(attempts, 1, 'closing/reopening does not retry an errored import automatically')
  evaluate(retry, wrapper, { resource: failed })(); const pending = failed.load(true); await pending
  assert.equal(attempts, 2); assert.equal(failed.snapshot().status, 'ready'); assert.equal(requests, 0)
})
await check('timeout, retry and obsolete import completion cannot replace recovered code', async () => {
  const late = deferred<PointDiagnosticsRenderer>(); let attempts = 0
  const resource = new DeferredResource<PointDiagnosticsRenderer>(async () => ++attempts === 1 ? late.promise : Fake, 5)
  await begin(resource); assert.equal(resource.snapshot().status, 'error')
  const afterTimeout = renderApp(resource); assert(afterTimeout.includes('重试加载界面'))
  evaluate(retry, wrapper, { resource })(); await resource.load(true)
  const recovered = resource.snapshot(); late.resolve(() => React.createElement('p', null, 'obsolete')); await Promise.resolve()
  assert.equal(resource.snapshot(), recovered); assert(!renderApp(resource).includes('obsolete')); assert.equal(requests, 0)
})
await check('bilingual loading/error controls close or retry code only', () => {
  const viewFunction = find(wrapper, node => ts.isFunctionDeclaration(node) && node.name?.text === 'DeferredPointDiagnosticsView')!
  const button = find(viewFunction, node => ts.isJsxAttribute(node) && node.name.getText(wrapper) === 'onClick' && (node.initializer as ts.JsxExpression)?.expression?.getText(wrapper) === 'onClose') as ts.JsxAttribute
  assert(button)
  let retried = 0
  for (const english of [false, true]) for (const status of ['idle', 'loading', 'error'] as const) {
    const html = renderToStaticMarkup(React.createElement(DeferredPointDiagnosticsView, { props: { ...props, english }, state: { status, value: null }, onClose: () => { closes++ }, retry: () => { retried++ } }))
    assert(html.includes('type="button"')); assert(html.includes(status === 'error' ? 'role="alert"' : 'role="status"'))
    assert(html.includes(english ? 'Back to live data' : '返回实时数据'))
    assert.equal(html.includes(english ? 'Retry interface loading' : '重试加载界面'), status === 'error')
  }
  evaluate((button.initializer as ts.JsxExpression).expression!, wrapper, { onClose: () => { closes++ } })()
  assert.equal(retried, 0, 'rendering never retries imports or report operations')
  assert.equal(requests, 0)
})
await check('actual module exports load without mounting report effects or changing current report UI', async () => {
  assert.equal(pointDiagnosticsResource.snapshot().status, 'idle')
  await pointDiagnosticsResource.load(); assert.equal(pointDiagnosticsResource.snapshot().status, 'ready')
  const module = await import('../apps/web/src/PointDiagnostics.tsx')
  assert.equal(pointDiagnosticsResource.snapshot().value, module.PointDiagnosticsPanel)
  for (const english of [false, true]) {
    const html = renderToStaticMarkup(React.createElement(DeferredPointDiagnosticsView, { props: { ...props, english }, state: pointDiagnosticsResource.snapshot(), onClose() {}, retry() {} }))
    assert(html.includes(english ? 'Read-only structure checks' : '只检查配置结构'))
    assert(html.includes(english ? 'Check again' : '重新检查')); assert(!html.includes(english ? 'Retry interface loading' : '重试加载界面'))
  }
  assert.equal(requests, 0, 'module evaluation/SSR never executes the report read effect')
})
assert.equal(closes, 2)
console.log('DIAGNOSTICS LOADING TEST OK: ' + passed + ' controlled lifecycle/source/SSR groups; no browser, real report request, hardware or model')
