import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import { diagnosePointTable } from '../packages/core/src/point-diagnostics.ts'
import { PointDiagnosticsLoader, initialPointDiagnosticState, pointDiagnosticDownload } from '../apps/web/src/point-diagnostics.ts'
import { captureDeviceEditBaseline } from '../packages/core/src/device-settings-edit.ts'
import { deviceDraftFields, deviceDraftChanged } from '../apps/web/src/device-draft-close.ts'
import { pointDraftFields, pointDraftChanged, PointDraftCloseGuard } from '../apps/web/src/point-draft-close.ts'
import { createPointEnumDraft, updatePointEnumDraft } from '../apps/web/src/point-enum-draft.ts'
import { parsePointSettingsUpdate } from '../apps/web/src/point-settings.ts'
import { isBinType, isHexType, registerWidth } from '../packages/core/src/codec.ts'
import { PointDraftDiscard } from '../apps/web/src/PointDraftDiscard.tsx'
import { PointEnumEditor } from '../apps/web/src/PointEnumEditor.tsx'
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

// Small deterministic hook driver: actual component/effect/event bodies, not React DOM.
// Setters after disposal are counted; all effects are explicitly cleaned up.
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const elements = (node: any): any[] => Array.isArray(node) ? node.flatMap(elements) : React.isValidElement(node) ? [node, ...elements((node.props as any).children)] : []
function hookDriver(file: string, name: string, scope: Record<string, unknown>, initialProps: any) {
  const fileSource = ts.createSourceFile(file, readFileSync(new URL('../apps/web/src/' + file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const declaration = find(fileSource, node => ts.isFunctionDeclaration(node) && node.name?.text === name)!
  const cells: any[] = [], dependencies: any[][] = [], cleanup = new Map<number, () => void>()
  let cursor = 0, effects: Array<() => void> = [], tree: any, currentProps = initialProps, disposed = false, lateWrites = 0
  const useState = (init: any) => { const id = cursor++; if (!(id in cells)) cells[id] = typeof init === 'function' ? init() : init; return [cells[id], (value: any) => { if (disposed) { lateWrites++; return }; cells[id] = typeof value === 'function' ? value(cells[id]) : value }] }
  const useRef = (init: any) => useState(() => ({ current: init }))[0]
  const useEffect = (effect: () => void | (() => void), deps: any[]) => { const id = cursor++; if (!dependencies[id] || deps.some((v, i) => !Object.is(v, dependencies[id][i]))) effects.push(() => { cleanup.get(id)?.(); const next = effect(); if (next) cleanup.set(id, next); else cleanup.delete(id) }); dependencies[id] = deps }
  const env = { React, useState, useRef, useEffect, useId: () => useState('mock-title')[0], ...scope }
  const component = new Function(...Object.keys(env), compile('return (' + declaration.getText(fileSource).replace(/^export /, '') + ')'))(...Object.values(env))
  const render = (next = currentProps) => { assert(!disposed); currentProps = next; cursor = 0; effects = []; tree = component(currentProps); for (const effect of effects) effect(); return tree }
  render()
  return { render, get tree() { return tree }, get lateWrites() { return lateWrites }, dispose() { if (disposed) return; disposed = true; for (const fn of cleanup.values()) fn(); cleanup.clear() }, one(type: any, predicate: (props: any) => boolean = () => true) { const item = elements(tree).find(node => node.type === type && predicate(node.props)); assert(item, 'control missing'); return item } }
}
const fakeDocument = { activeElement: { isConnected: true, focus() {} } }
const settingsScope = { isBinType, isHexType, registerWidth, parsePointSettingsUpdate, createPointEnumDraft, updatePointEnumDraft, pointDraftFields, pointDraftChanged, PointDraftCloseGuard, PointDraftDiscard, PointEnumEditor, document: fakeDocument }
await check('failed interface retry, actual report effect and device A/B/A late-response recovery compose safely', async () => {
  const module = await import('../apps/web/src/PointDiagnostics.tsx')
  let imports = 0
  const resource = new DeferredResource<PointDiagnosticsRenderer>(async () => { if (++imports === 1) throw Error('synthetic chunk failure'); return module.PointDiagnosticsPanel })
  const calls: Array<{ deviceId: number; signal: AbortSignal; reply: ReturnType<typeof deferred<unknown>> }> = []
  const fetcher = async (url: string, signal: AbortSignal) => { const deviceId = Number(/monitor_objects\/(\d+)/.exec(url)?.[1]); assert([1, 2].includes(deviceId)); const reply = deferred<unknown>(); calls.push({ deviceId, signal, reply }); return reply.promise }
  await begin(resource); assert.equal(resource.snapshot().status, 'error'); assert.equal(calls.length, 0)
  await begin(resource); assert.equal(imports, 1); await resource.load(true); assert.equal(imports, 2)
  const rootView = find(source, node => ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'DeviceView') as ts.JsxSelfClosingElement
  const key = rootView.attributes.properties.find(node => ts.isJsxAttribute(node) && node.name.getText(source) === 'key') as ts.JsxAttribute
  assert.deepEqual([1, 2, 1].map(id => evaluate((key.initializer as ts.JsxExpression).expression!, source, { selected: { id } })), [1, 2, 1], 'actual App keys logical device lifetimes separately')
  const scope = { PointDiagnosticsLoader, initialPointDiagnosticState, pointDiagnosticDownload, PointDiagnosticsView: module.PointDiagnosticsView }
  const mount = (deviceId: number, alias: string) => {
    const current = { ...props, deviceId, points: [{ ...props.points[0], alias, slaveId: deviceId }], fetcher }
    const element = DeferredPointDiagnosticsView({ props: current, state: resource.snapshot(), retry() { throw Error('ready UI must not retry code') }, onClose() {} }) as React.ReactElement<any>
    assert.equal(element.type, module.PointDiagnosticsPanel)
    return hookDriver('PointDiagnostics.tsx', 'PointDiagnosticsPanel', scope, element.props)
  }
  const report = (deviceId: number, quantity: number) => diagnosePointTable({ devices: [{ id: deviceId, mode: 'master', slaveId: deviceId }], groups: [{ id: 9, objectId: deviceId, name: 'synthetic', slaveId: deviceId, functionCode: 3, startAddress: 0, quantity }], registers: [{ id: 7, objectId: deviceId, groupId: 9, alias: 'sample', functionCode: 3, startAddress: 0, dataType: 'uint32' }] })
  const first = mount(1, 'old A'); await tick(); assert.equal(calls[0].deviceId, 1)
  first.dispose(); await tick(); assert(calls[0].signal.aborted)
  const second = mount(2, 'B'); await tick(); assert.equal(calls[1].deviceId, 2)
  second.dispose(); await tick(); assert(calls[1].signal.aborted)
  const current = mount(1, 'current A')
  try {
    await tick(); assert.equal(calls[2].deviceId, 1)
    calls[2].reply.resolve({ malformed: true }); await tick(); current.render()
    assert.equal(current.tree.props.state.status, 'error'); assert.equal(current.tree.props.state.error, 'invalid')
    current.tree.props.refresh(); current.render(); await tick(); assert.equal(calls.length, 4)
    calls[0].reply.resolve(report(1, 1)); calls[1].reply.resolve(report(2, 1)); await tick(); current.render()
    assert.equal(current.tree.props.state.status, 'loading'); assert.equal(current.tree.props.state.snapshot, null)
    calls[3].reply.resolve(report(1, 2)); await tick(); current.render()
    const state = current.tree.props.state
    assert.equal(state.status, 'ready'); assert.equal(state.snapshot.deviceId, 1); assert.equal(state.snapshot.report.summary.errors, 0)
    assert.equal(current.tree.props.points[0].alias, 'current A'); assert.equal(current.tree.props.points[0].slaveId, 1)
    assert.equal(first.lateWrites, 0); assert.equal(second.lateWrites, 0); assert.equal(imports, 2)
  } finally { first.dispose(); second.dispose(); current.dispose() }
})
await check('late code success after returning live leaves a dirty point draft and its close guard intact', async () => {
  const content = deferred<PointDiagnosticsRenderer>(), entered = deferred<void>()
  const resource = new DeferredResource<PointDiagnosticsRenderer>(async () => { entered.resolve(); return content.promise })
  let tab = 5, saved = 0, closed = 0
  const pending = begin(resource); await entered.promise
  evaluate(closeExpression, source, { setTab: (next: number) => { tab = next } })(); assert.equal(tab, 0)
  const live = find(deviceView, node => ts.isBinaryExpression(node) && node.left.getText(source) === 'tab === 0')!
  assert(live && live.getText(source).includes('<LiveTable'), 'point draft owner is the live tab, not the diagnostic chunk')
  const modal = hookDriver('PointSettingsEditor.tsx', 'PointSettingsEditor', settingsScope, { name: 'synthetic point', address: 0, settings: { dataType: 'uint16', unit: 'V', factor: 0, offset: 0, enumJson: null, decimalPlaces: null }, available: 1, typeGroups: [{ key: 'types', types: ['uint16'] }], t: (key: string) => key === 'cancel' ? '取消' : key, guarded: true, onClose() { closed++ }, async onSave() { saved++ } })
  try {
    modal.one('input', value => value['aria-label'] === 'pointUnit').props.onChange({ target: { value: 'unsaved point draft' } }); modal.render()
    content.resolve(Fake); await pending
    assert.equal(renderApp(resource, tab), ''); modal.render()
    assert.equal(modal.one('input', value => value['aria-label'] === 'pointUnit').props.value, 'unsaved point draft')
    modal.one('button', value => value.className === 'modal-close').props.onClick(); modal.render()
    const prompt = modal.one(PointDraftDiscard)
    assert.equal(saved, 0); assert.equal(closed, 0)
    modal.one('form').props.onSubmit({ preventDefault() {} }); await tick(); modal.render(); assert.equal(saved, 0, 'confirming a close must not save via Enter')
    prompt.props.onResume(); modal.render()
    assert.equal(modal.one('input', value => value['aria-label'] === 'pointUnit').props.value, 'unsaved point draft')
    assert.equal(saved, 0); assert.equal(closed, 0)
  } finally { modal.dispose() }
})
await check('late code failure and explicit recovery leave a device draft and discard decision independent', async () => {
  const content = deferred<void>(), entered = deferred<void>(); let imports = 0
  const resource = new DeferredResource<PointDiagnosticsRenderer>(async () => { if (++imports === 1) { entered.resolve(); await content.promise; throw Error('synthetic late chunk failure') }; return Fake })
  const pending = begin(resource); await entered.promise
  let saved = 0, closed = 0
  const initial = { id: 1, name: 'synthetic device', mode: 'master', ip: 'mock.invalid', port: 502, transport: 'tcp', serialPath: 'MOCK_PORT', baudRate: 9600, parity: 'even', stopBits: 1, dataBits: 8, flowControl: 'none', slaveId: 1, pollIntervalMs: 1000, timeoutMs: 3000 }
  const edit = find(deviceView, node => ts.isBinaryExpression(node) && node.left.getText(source) === 'showEdit')!
  assert(edit && edit.getText(source).includes('<DeviceModal'), 'device editor is a sibling controlled by showEdit, independent of diagnostics status')
  const modalProps = { initial, t: (key: string) => key === 'cancel' ? '取消' : key, onClose() { closed++ }, async onSave() { saved++ } }
  const modal = hookDriver('DeviceModal.tsx', 'DeviceModal', { captureDeviceEditBaseline, deviceDraftFields, deviceDraftChanged, PointDraftCloseGuard, PointDraftDiscard, SerialPortPicker: () => null, document: fakeDocument }, modalProps)
  try {
    modal.one('input', value => value['aria-label'] === 'name').props.onChange({ target: { value: 'unsaved device draft' } }); modal.render()
    content.resolve(); await pending; assert.equal(resource.snapshot().status, 'error'); modal.render()
    assert.equal(modal.one('input', value => value['aria-label'] === 'name').props.value, 'unsaved device draft')
    modal.render({ ...modalProps, initial: { ...initial, name: 'background config refresh' } })
    assert.equal(modal.one('input', value => value['aria-label'] === 'name').props.value, 'unsaved device draft')
    modal.one('button', value => value.className === 'modal-close').props.onClick(); modal.render(); const prompt = modal.one(PointDraftDiscard)
    assert.equal(saved, 0); assert.equal(closed, 0)
    prompt.props.onDiscard(); modal.render(); assert.equal(closed, 1); assert.equal(saved, 0, 'explicit discard never saves or restores configuration')
    modal.dispose()
    await resource.load(true); assert.equal(resource.snapshot().status, 'ready')
    assert.equal(closed, 1); assert.equal(saved, 0); assert.equal(modal.lateWrites, 0, 'recovery after explicit discard cannot revive the closed editor')
    assert.equal(imports, 2)
  } finally { modal.dispose() }
})
assert.equal(closes, 2)
console.log('DIAGNOSTICS LOADING TEST OK: ' + passed + ' controlled lifecycle/source/SSR groups; no browser, real report request, hardware or model')
