import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import React from 'react'
import ts from 'typescript'
import { hookDriver } from './fixtures/component-hook-driver.ts'
import { captureDeviceEditBaseline } from '../packages/core/src/device-settings-edit.ts'
import { deviceDraftFields, deviceDraftChanged } from '../apps/web/src/device-draft-close.ts'
import { pointDraftFields, pointDraftChanged, PointDraftCloseGuard } from '../apps/web/src/point-draft-close.ts'
import { createPointEnumDraft, updatePointEnumDraft } from '../apps/web/src/point-enum-draft.ts'
import { parsePointSettingsUpdate } from '../apps/web/src/point-settings.ts'
import { isBinType, isHexType, registerWidth } from '../packages/core/src/codec.ts'
import { PointDraftDiscard } from '../apps/web/src/PointDraftDiscard.tsx'
import { PointEnumEditor } from '../apps/web/src/PointEnumEditor.tsx'

if (process.argv.slice(2).join(' ') !== '--mock') throw Error('Only --mock is supported; no application, configuration store or device is opened.')
// AUDIT, not a protection guarantee: reproduce the current known unmount gap.
const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function find(node: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node | undefined { if (predicate(node)) return node; let result: ts.Node | undefined; ts.forEachChild(node, child => { result ??= find(child, predicate) }); return result }
const compile = (code: string) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React } }).outputText
const evaluate = (node: ts.Node, env: Record<string, unknown>) => new Function(...Object.keys(env), compile('return (' + node.getText(source) + ')'))(...Object.values(env))
const app = find(source, node => ts.isFunctionDeclaration(node) && node.name?.text === 'App')!
const navigate = (find(app, node => ts.isVariableDeclaration(node) && node.name.getText(source) === 'navigateData') as ts.VariableDeclaration).initializer!
const selectedExpression = (find(app, node => ts.isVariableDeclaration(node) && node.name.getText(source) === 'selected') as ts.VariableDeclaration).initializer!
const globalTab = find(app, node => ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'GlobalTabBar') as ts.JsxSelfClosingElement
const globalChange = (globalTab.attributes.properties.find(node => ts.isJsxAttribute(node) && node.name.getText(source) === 'onChange') as ts.JsxAttribute).initializer as ts.JsxExpression
const deviceButton = find(app, node => ts.isJsxOpeningElement(node) && node.tagName.getText(source) === 'button' && node.getText(source).includes('className="device-select"')) as ts.JsxOpeningElement
const selectDevice = (deviceButton.attributes.properties.find(node => ts.isJsxAttribute(node) && node.name.getText(source) === 'onClick') as ts.JsxAttribute).initializer as ts.JsxExpression
const rootBranch = find(app, node => ts.isConditionalExpression(node) && node.condition.getText(source) === "view === 'database'")!
const refreshDevices = find(app, node => ts.isVariableDeclaration(node) && node.name.getText(source) === 'refreshDevices')!
const refreshRead = find(refreshDevices, node => ts.isCallExpression(node) && node.arguments.length === 3 && node.arguments[1].getText(source).includes('setDevices(objs)')) as ts.CallExpression
const acceptDevices = refreshRead.arguments[1]
assert(navigate && selectedExpression && rootBranch && globalChange.expression && selectDevice.expression && acceptDevices)
const device = { id: 1, name: 'synthetic A', mode: 'master', ip: 'mock.invalid', port: 502, transport: 'tcp', serialPath: 'MOCK_PORT', baudRate: 9600, parity: 'even', stopBits: 1, dataBits: 8, flowControl: 'none', slaveId: 1, pollIntervalMs: 1000, timeoutMs: 3000 }
const t = (key: string) => key === 'cancel' ? '取消' : key
const document = { activeElement: { isConnected: true, focus() {} } }
const base = { PointDraftCloseGuard, PointDraftDiscard, document }
const pointScope = { ...base, pointDraftFields, pointDraftChanged, createPointEnumDraft, updatePointEnumDraft, parsePointSettingsUpdate, isBinType, isHexType, registerWidth, PointEnumEditor }
const deviceScope = { ...base, captureDeviceEditBaseline, deviceDraftFields, deviceDraftChanged, SerialPortPicker: () => null }
type Kind = 'point' | 'device'
function editor(kind: Kind) {
  const calls = { close: 0, save: 0 }
  const callbacks = { onClose() { calls.close++ }, async onSave() { calls.save++ } }
  const input = kind === 'point' ? { name: 'synthetic point', address: 0, settings: { dataType: 'uint16', unit: 'V', factor: 1, offset: 0, enumJson: null, decimalPlaces: null }, available: 1, typeGroups: [{ key: 'types', types: ['uint16'] }], t, guarded: true, ...callbacks } : { initial: device, t, ...callbacks }
  const driver = hookDriver(kind === 'point' ? 'PointSettingsEditor.tsx' : 'DeviceModal.tsx', kind === 'point' ? 'PointSettingsEditor' : 'DeviceModal', kind === 'point' ? pointScope : deviceScope, input)
  const label = kind === 'point' ? 'pointUnit' : 'name', original = kind === 'point' ? 'V' : device.name
  const value = () => driver.one('input', props => props['aria-label'] === label).props.value
  const change = () => { driver.one('input', props => props['aria-label'] === label).props.onChange({ target: { value: 'UNSAVED MOCK DRAFT' } }); driver.render() }
  return { driver, calls, value, change, original }
}
function surface() {
  let selectedId = 1, view = 'monitor', target: any = null, devices = [device, { ...device, id: 2, name: 'synthetic B' }], confirms = 0
  const setters = { setSelectedId(id: number) { selectedId = id }, setView(next: string) { view = next }, setDataTarget(next: unknown) { target = next } }
  const browser = { innerWidth: 1200, confirm() { confirms++; return true } }
  const emit = evaluate(navigate, { ...setters, navigationSequence: { current: 0 }, window: browser })
  const render = () => {
    const selected = evaluate(selectedExpression, { devices, selectedId })
    const noAction = () => { throw Error('No write/refresh/operation callback may run in this audit') }
    return evaluate(rootBranch, { ...setters, view, selected, selectedId, dataTarget: target, devices, DeviceView: 'mock-device-view', DatabaseView: 'mock-database-view', EmptyState: 'mock-empty-view', t, navigateData: emit, groupSnapshot: { objectId: selectedId }, realtime: { status: 'connected' }, deviceConnected: {}, groups: [], latest: {}, groupErrors: {}, fallbackStatus: {}, operation: { busy: false }, toggleDevice: noAction, editDevice: noAction, deleteDevice: noAction, refreshRegisters: noAction, setShowAdd: noAction, React }) as React.ReactElement
  }
  return { render, get confirms() { return confirms }, select(id: number) { evaluate(selectDevice.expression!, { ...setters, d: { id }, window: browser, setCollapsed() {} })() }, database() { evaluate(globalChange.expression!, setters)('database') }, reference() { emit({ deviceId: 2, view: 'history', registerId: 7, start: '2026-11-08T00:00:00Z', end: '2026-11-08T01:00:00Z', label: 'mock' }) }, remove() { evaluate(acceptDevices, { setDevices(next: typeof devices) { devices = next }, setDeviceConnected() {}, setDeviceLoadError() {} })({ objs: devices.filter(value => value.id !== selectedId), map: {} }) } }
}
const cases: Array<Record<string, unknown>> = []
for (const kind of ['point', 'device'] as const) for (const path of ['device-button', 'history-reference', 'database-tab', 'background-removal'] as const) {
  const modal = editor(kind), page = surface()
  try {
    const before = page.render(); assert.equal(before.type, 'mock-device-view'); assert.equal(before.key, '1')
    modal.change(); assert.equal(modal.value(), 'UNSAVED MOCK DRAFT')
    // Existing own-close protection does work; return to editing before unmount.
    modal.driver.one('button', props => props.className === 'modal-close').props.onClick(); modal.driver.render()
    const prompt = modal.driver.one(PointDraftDiscard); assert.equal(modal.calls.close, 0); prompt.props.onResume(); modal.driver.render()
    page.select(1); const same = page.render(); assert.equal(same.key, before.key); assert.equal(same.type, before.type); assert.equal(modal.value(), 'UNSAVED MOCK DRAFT', 'same-device navigation does not unload the component')
    if (path === 'device-button') page.select(2)
    else if (path === 'history-reference') page.reference()
    else if (path === 'database-tab') page.database()
    else page.remove()
    const after = page.render(), unmounted = after.type !== before.type || after.key !== before.key
    assert(unmounted, 'actual App branch/key must unload the device view in this baseline')
    modal.driver.dispose() // Simulate the actual branch/key reconciliation cleanup.
    assert.equal(page.confirms, 0); assert.equal(modal.calls.close, 0); assert.equal(modal.calls.save, 0)
    const reopened = editor(kind)
    try { assert.equal(reopened.value(), reopened.original); assert.notEqual(reopened.value(), 'UNSAVED MOCK DRAFT') } finally { reopened.driver.dispose() }
    cases.push({ kind, path, lossReproduced: true, editorCloseConfirmationBypassed: true, nativeConfirmationCount: page.confirms, saveCalls: modal.calls.save })
  } finally { modal.driver.dispose() }
}
assert.equal(cases.length, 8)
console.log(JSON.stringify({ audit: 'draft-unmount', mockOnly: true, productionFixApplied: false, lossReproduced: true, cases, scope: 'source/component/effect simulation; not actual browser accessibility, React DOM scheduling, persistent storage or a protection guarantee' }, null, 2))
