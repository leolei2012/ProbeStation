import assert from 'node:assert/strict'
import { bindBeforeUnload } from '../apps/web/src/before-unload.ts'
import { draftDialogKey } from '../apps/web/src/dialog-focus.ts'
import { ConfigurationSaveHint } from '../apps/web/src/RetainedDraftNotice.tsx'
import { unloadTarget } from './fixtures/unload-events.ts'
import { draftDialogFocusHook } from './fixtures/dialog-focus-hook.ts'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DeviceModal } from '../apps/web/src/DeviceModal.tsx'
import { captureDeviceEditBaseline } from '../packages/core/src/device-settings-edit.ts'
import { deviceDraftFields, deviceDraftChanged } from '../apps/web/src/device-draft-close.ts'
import { PointDraftCloseGuard } from '../apps/web/src/point-draft-close.ts'
import { PointDraftDiscard } from '../apps/web/src/PointDraftDiscard.tsx'
import Fastify from 'fastify'
import { ConfigStore } from '../packages/config/src/index.ts'
import { registerDeviceSettings } from '../packages/api/src/device-settings.ts'
import { saveGuardedDeviceSettings } from '../apps/web/src/device-settings-save.ts'

const sample = { id: 1, name: 'synthetic', mode: 'master', ip: 'mock.invalid', port: 502, transport: 'tcp', serialPath: 'MOCK_PORT', baudRate: 9600, parity: 'even', stopBits: 1, dataBits: 8, flowControl: 'none', slaveId: 1, pollIntervalMs: 1000, timeoutMs: 3000 }
const t = (key: string) => ({ cancel: '取消', name: '名称', ip: '地址', port: '端口', baudRate: '波特率', save: '保存', add: '新增', working: '处理中' }[key] ?? key)
const source = ts.createSourceFile('DeviceModal.tsx', readFileSync(new URL('../apps/web/src/DeviceModal.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'DeviceModal')!
const code = ts.transpileModule('return (' + declaration.getText(source).replace(/^export /, '') + ')', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React } }).outputText
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))
const elements = (node: any): any[] => Array.isArray(node) ? node.flatMap(elements) : React.isValidElement(node) ? [node, ...elements((node.props as any).children)] : []

// Actual component/event functions with a small deterministic hook driver. This is not a browser/React DOM renderer.
function driver(initial: any = sample, onSave: (...args: any[]) => Promise<void> = async () => {}) {
  const cells: any[] = [], dependencies: any[] = []; let cursor = 0, effects: Array<() => void> = [], tree: any, closes = 0, saves = 0, focus = 0
  const document = { activeElement: null as any }
  const useState = (init: any) => { const index = cursor++; if (!(index in cells)) cells[index] = typeof init === 'function' ? init() : init; return [cells[index], (value: any) => { cells[index] = typeof value === 'function' ? value(cells[index]) : value }] }
  const useRef = (init: any) => useState(() => ({ current: init }))[0]
  const useEffect = (fn: () => void, deps: any[]) => { const index = cursor++; if (!dependencies[index] || deps.some((value, i) => !Object.is(value, dependencies[index][i]))) effects.push(fn); dependencies[index] = deps }
  const SerialPortPicker = () => null
  const env = { React, useState, useRef, useEffect, useId: () => useState('synthetic-title')[0], captureDeviceEditBaseline, deviceDraftFields, deviceDraftChanged, PointDraftCloseGuard, PointDraftDiscard, SerialPortPicker, ConfigurationSaveHint, bindBeforeUnload, draftDialogKey, useDraftDialogFocus: draftDialogFocusHook({ useState, useEffect, document }), window: unloadTarget(), document }
  const component = new Function(...Object.keys(env), code)(...Object.values(env))
  const props = { initial, t, onClose() { closes++ }, async onSave(...args: any[]) { saves++; await onSave(...args) } }
  const render = () => {
    cursor = 0; effects = []; tree = component(props)
    const prompt = elements(tree).find(node => node.type === PointDraftDiscard)
    if (prompt?.ref) prompt.ref.current = { isConnected: true, focus() { focus++ } }
    for (const effect of effects) effect()
    return tree
  }
  const one = (type: any, predicate: (props: any) => boolean = () => true) => { const node = elements(tree).find(node => node.type === type && predicate(node.props)); assert(node, 'missing control'); return node }
  const prompt = () => elements(tree).find(node => node.type === PointDraftDiscard)
  render()
  return {
    get tree() { return tree }, get closes() { return closes }, get saves() { return saves }, get focus() { return focus }, render, prompt,
    set(label: string, value: string) { const node = elements(tree).find(node => ['input', 'select'].includes(node.type) && node.props['aria-label'] === label); assert(node, label); node.props.onChange({ target: { value } }); render() },
    serial(value: string) { one(SerialPortPicker).props.onChange(value); render() },
    close() { document.activeElement = { isConnected: true, focus() { focus++ } }; one('button', p => p.className === 'modal-close').props.onClick(); render() },
    cancel() { one('button', p => p.children === '取消').props.onClick(); render() },
    resume() { assert(prompt()); prompt().props.onResume(); render() },
    discard() { assert(prompt()); prompt().props.onDiscard(); render() },
    escape(composing = false) { one('form').props.onKeyDown({ key: 'Escape', nativeEvent: { isComposing: composing }, preventDefault() {}, stopPropagation() {} }); render() },
    submit() { one('form').props.onSubmit({ preventDefault() {} }); render() },
    value(label: string) { return elements(tree).find(node => ['input', 'select'].includes(node.type) && node.props['aria-label'] === label)?.props.value },
    refresh(initial: any) { props.initial = initial; render() },
  }
}

const edited = driver(); edited.set('名称', 'changed'); edited.close()
assert.equal(edited.closes, 0, 'closing the actual edited device modal must preserve input pending explicit discard')
assert(edited.prompt()); assert.equal(edited.value('名称'), 'changed'); assert(edited.focus > 0)
assert.equal(edited.prompt().props.label, '确认关闭设备草稿')
edited.submit(); assert.equal(edited.saves, 0, 'Enter while confirming cannot save')
edited.resume(); assert(!edited.prompt()); assert.equal(edited.value('名称'), 'changed')
edited.escape(true); assert(!edited.prompt(), 'IME Escape is ignored')
edited.escape(); assert(edited.prompt()); edited.escape(); assert(!edited.prompt(), 'Escape from confirmation returns to editing')
edited.cancel(); assert(edited.prompt()); edited.discard(); assert.equal(edited.closes, 1); assert.equal(edited.saves, 0)
const clean = driver(); clean.close(); clean.close(); assert.equal(clean.closes, 1)
const reverted = driver(); reverted.set('名称', 'temporary'); reverted.set('名称', sample.name); reverted.cancel(); assert.equal(reverted.closes, 1); assert(!reverted.prompt())
const propsOnly = driver(); propsOnly.refresh({ ...sample, name: 'background update' }); propsOnly.close(); assert.equal(propsOnly.closes, 1, 'props alone do not turn an untouched opening into a dirty draft')
const matchingProps = driver(); matchingProps.set('名称', 'local draft'); matchingProps.refresh({ ...sample, name: 'local draft' }); matchingProps.close(); assert(matchingProps.prompt(), 'later matching props do not silently replace the opening baseline')
const roles = driver(); roles.set('设备角色', 'slave'); roles.set('设备角色', 'master'); roles.cancel(); assert(roles.prompt(), 'automatic role-related address changes are also drafts')
const fresh = driver(null); fresh.close(); assert.equal(fresh.closes, 1)
const invalid = driver(null); invalid.set('端口', ''); invalid.cancel(); assert(invalid.prompt()); assert.equal(invalid.saves, 0)
const serial = driver({ ...sample, transport: 'rtu' }); serial.serial('MOCK_OTHER'); serial.close(); assert(serial.prompt()); serial.resume(); serial.refresh({ ...sample, name: 'background new name', serialPath: 'MOCK_REFRESH' }); serial.close(); assert(serial.prompt(), 'later props do not replace the opening baseline')

const opening = deviceDraftFields(sample); assert(Object.isFrozen(opening)); assert(!deviceDraftChanged(opening, { ...opening }))
for (const key of Object.keys(opening) as Array<keyof typeof opening>) { const changed = { ...opening, [key]: opening[key] + ' ' }; assert(deviceDraftChanged(opening, changed), key); changed[key] = opening[key]; assert(!deviceDraftChanged(opening, changed), 'revert ' + key) }
assert.equal(deviceDraftFields(null).port, '8899'); assert.equal(deviceDraftFields(null).timeout, '3000'); assert.equal(deviceDraftFields(sample).port, '502')

let reject!: (error: Error) => void, sent: any[] = []
const held = new Promise<void>((_resolve, fail) => { reject = fail }), busy = driver(sample, async (...args) => { sent = args; await held })
busy.set('名称', 'draft to keep'); busy.submit(); busy.close(); busy.escape(); assert.equal(busy.closes, 0); assert(!busy.prompt()); assert.equal(busy.saves, 1)
assert(elements(busy.tree).filter(node => node.type === 'fieldset').every(node => node.props.disabled))
assert.equal(sent[0].name, 'draft to keep'); assert.deepEqual(sent[1], captureDeviceEditBaseline(sample))
reject(new Error('synthetic unknown save outcome')); await tick(); busy.render(); assert.equal(busy.value('名称'), 'draft to keep')
busy.cancel(); assert(busy.prompt()); busy.discard(); assert.equal(busy.closes, 1); assert.equal(busy.saves, 1, 'discard after failed save sends no retry or undo')
let parentClosed = 0
const saved = driver(sample, async () => { parentClosed++ }); saved.set('名称', 'save normally'); saved.submit(); await tick(); saved.render(); assert.equal(parentClosed, 1); assert.equal(saved.closes, 0, 'successful onSave retains existing parent-owned close behavior'); assert(!saved.prompt())

// Actual modal -> actual guarded helper -> actual API -> memory SQLite; only the response is lost.
const cfg = new ConfigStore({ dbPath: ':memory:' }), app = Fastify(); let runtimeCalls = 0
registerDeviceSettings(app, cfg, { async reconnect() { runtimeCalls++ }, async syncSlaves() { runtimeCalls++ } })
try {
  const device = cfg.createObject('response-loss form', 'mock.invalid', 502)
  let requests = 0, successfulSaves = 0, settle!: () => void
  let settled = new Promise<void>(resolve => { settle = resolve })
  const lost = driver(cfg.getObject(device.id), async (fields, expected) => {
    try {
      await saveGuardedDeviceSettings(expected, fields, async (url, body) => {
        requests++; const response = await app.inject({ method: 'PUT', url, payload: body as any })
        if (response.statusCode !== 200) throw new Error('HTTP ' + response.statusCode + ': ' + response.body)
        throw new TypeError('Failed to fetch')
      })
      successfulSaves++
    } finally { settle() }
  })
  lost.set('名称', 'form committed response lost'); lost.submit(); lost.submit(); await settled; await tick(); lost.render()
  assert.equal(requests, 1); assert.equal(lost.saves, 1); assert.equal(runtimeCalls, 2)
  assert.equal(cfg.getObject(device.id)!.name, 'form committed response lost')
  assert.equal(lost.value('名称'), 'form committed response lost'); assert.equal(lost.closes, 0); assert.equal(successfulSaves, 0)
  const alert = () => elements(lost.tree).find(node => node.props.role === 'alert')?.props.children
  assert.match(alert(), /保存结果待核实.*核对设备配置.*勿自动重复保存/)
  await tick(); assert.equal(requests, 1, 'rendering and waiting never retry or read back to claim success')
  settled = new Promise<void>(resolve => { settle = resolve }); lost.submit(); await settled; await tick(); lost.render()
  assert.equal(requests, 2); assert.equal(runtimeCalls, 2, 'explicit stale retry is rejected before runtime hooks')
  assert.match(alert(), /HTTP 409/); assert.equal(successfulSaves, 0); assert.equal(lost.closes, 0)
  lost.cancel(); assert(lost.prompt()); lost.discard(); assert.equal(lost.closes, 1); assert.equal(requests, 2, 'discard cannot retry or undo an already-committed save')
} finally { await app.close(); (cfg as any).db.close() }

// Production App creation callback -> actual POST, with the component retaining a new-device draft.
const appSource = ts.createSourceFile('App.tsx', readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const appComponent = appSource.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'App') as ts.FunctionDeclaration
const createDeclaration = appComponent.body!.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations]).find(node => node.name.getText(appSource) === 'addDevice')!
const createCode = ts.transpileModule('return (' + (createDeclaration.initializer as ts.CallExpression).arguments[0].getText(appSource) + ')', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
const apiSource = ts.createSourceFile('api.ts', readFileSync(new URL('../packages/api/src/index.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
let createRoute: ts.CallExpression | undefined
const visit = (node: ts.Node) => { if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'post' && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === '/api/monitor_objects') createRoute = node; ts.forEachChild(node, visit) }; visit(apiSource); assert(createRoute)
let failCreateNotify = false
const createCfg = new ConfigStore({ dbPath: ':memory:' }, () => { if (failCreateNotify) throw new Error('synthetic creation notify failure') }), createApp = Fastify()
let loseResponse = true, failSync = false, createRequests = 0, createRefreshes = 0, createClosed = 0, syncCalls = 0
const createNotices: any[] = []
new Function('fastify', 'cfg', 'ctx', ts.transpileModule(createRoute.getText(apiSource), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText)(createApp, createCfg, { get(name: string) { assert.equal(name, 'deviceSlaves'); return { async sync() { syncCalls++; if (failSync) throw new Error('synthetic sync failure') } } } })
const createEnv = { api: { async post(url: string, body: any) {
  createRequests++; const response = await createApp.inject({ method: 'POST', url, payload: body })
  if (response.statusCode !== 200) throw new Error('HTTP ' + response.statusCode + ' ' + response.body)
  if (loseResponse) throw new TypeError('Failed to fetch')
  return response.json()
} }, setShowAdd(value: boolean) { assert.equal(value, false); createClosed++ }, refreshDevices() { createRefreshes++ }, operation: { setNotice(value: any) { createNotices.push(value) } }, t }
const addDevice = new Function(...Object.keys(createEnv), createCode)(...Object.values(createEnv))
try {
  let finish!: () => void, submitted: any; const complete = new Promise<void>(resolve => { finish = resolve })
  const lost = driver(null, async fields => { submitted = fields; try { await addDevice(fields) } finally { finish() } })
  lost.set('名称', 'new device response lost'); lost.set('地址', 'mock.invalid'); lost.submit(); lost.submit(); await complete; await tick(); lost.render()
  assert.equal(createRequests, 1); assert.equal(createCfg.listObjects().length, 1); assert.equal(syncCalls, 1)
  assert.equal(lost.value('名称'), 'new device response lost'); assert.equal(lost.value('地址'), 'mock.invalid')
  const alert = () => elements(lost.tree).find(node => node.props.role === 'alert')?.props.children
  assert.match(alert(), /新增设备结果待核实.*核对设备列表.*勿重复新增/)
  assert.equal(createClosed, 0); assert.equal(createRefreshes, 0); assert.equal(createNotices.length, 0)
  await tick(); assert.equal(createRequests, 1); lost.cancel(); assert(lost.prompt()); lost.discard(); assert.equal(lost.closes, 1); assert.equal(createRequests, 1); assert.equal(createCfg.listObjects().length, 1)
  // Existing POST can return 500 after its INSERT when notification or slave synchronization throws.
  loseResponse = false; failSync = true
  await assert.rejects(addDevice({ ...submitted, name: 'committed sync failed' }), /新增设备结果待核实.*勿重复新增/)
  assert.equal(createCfg.listObjects().length, 2); assert.equal(syncCalls, 2); failSync = false; failCreateNotify = true
  await assert.rejects(addDevice({ ...submitted, name: 'committed notification failed' }), /新增设备结果待核实.*勿重复新增/)
  assert.equal(createCfg.listObjects().length, 3); assert.equal(syncCalls, 2); failCreateNotify = false
  assert.equal(createClosed, 0); assert.equal(createRefreshes, 0); assert.equal(createNotices.length, 0)
  const beforeRejected = JSON.stringify(createCfg.listObjects())
  await assert.rejects(addDevice({ ...submitted, mode: 'invalid' }), /HTTP 400/)
  assert.equal(JSON.stringify(createCfg.listObjects()), beforeRejected)
  const actualPost = createEnv.api.post
  try {
    for (const status of [400, 403, 404, 409, 413, 415]) {
      const rejected = new Error('HTTP ' + status + ' synthetic rejection'); let calls = 0
      createEnv.api.post = async () => { calls++; throw rejected }
      await assert.rejects(addDevice(submitted), error => error === rejected); assert.equal(calls, 1)
    }
    for (const error of [new SyntaxError('JSON response lost'), new Error('HTTP 502 gateway'), null, 'network failure']) {
      let calls = 0; createEnv.api.post = async () => { calls++; throw error }
      await assert.rejects(addDevice(submitted), /新增设备结果待核实.*勿重复新增/); assert.equal(calls, 1)
    }
  } finally { createEnv.api.post = actualPost }
  assert.equal(JSON.stringify(createCfg.listObjects()), beforeRejected)
  const requestsBeforeLocal = createRequests; await addDevice({ ...submitted, name: '' }); assert.equal(createRequests, requestsBeforeLocal, 'existing local preflight remains before sending')
  await addDevice({ ...submitted, name: 'normal RTU metadata', transport: 'rtu', serialPath: 'MOCK_ENUMERATION_ONLY', ip: '' })
  assert.equal(createClosed, 1); assert.equal(createRefreshes, 1); assert.equal(createNotices.length, 1); assert.equal(createNotices[0].error, false)
  assert.equal(createCfg.listObjects().length, 4); assert.equal(createCfg.listObjects()[3].serialPath, 'MOCK_ENUMERATION_ONLY')
} finally { await createApp.close(); (createCfg as any).db.close() }

let callbacks = 0
for (const initial of [null, sample, { ...sample, transport: 'rtu' }]) {
  const html = renderToStaticMarkup(createElement(DeviceModal, { initial, t, onClose() { callbacks++ }, async onSave() { callbacks++ }, portFetcher: async () => { callbacks++; throw new Error('SSR must not enumerate') } }))
  assert.match(html, /role="dialog"/); assert(!html.includes('point-draft-discard'))
}
assert.equal(callbacks, 0)
for (const english of [false, true]) {
  const label = english ? 'Device draft close confirmation' : '确认关闭设备草稿'
  const html = renderToStaticMarkup(createElement(PointDraftDiscard, { label, english, busy: false, onResume() {}, onDiscard() {} }))
  assert(html.includes(label)); assert(html.includes(english ? 'Continue editing' : '继续编辑')); assert(!html.includes('Point draft close confirmation'))
}
console.log('DEVICE DRAFT CLOSE OK: actual component/event driver, dirty close/cancel/Escape/IME/resume/discard, clean/revert/new/invalid/RTU inputs, stable opening, no-save while confirming/busy, failed save preservation and unchanged parent close/save payload; guarded API response loss/stale retry, actual App create callback/actual POST/memory DB committed response loss and postinsert notification/sync 500 -> uncertain alert/draft/no success/no retry, known rejection and normal RTU metadata creation; pure SSR, no DOM automation, network, enumeration or real runtime/hardware')
