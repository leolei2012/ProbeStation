import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import React from 'react'
import ts from 'typescript'
import { hookDriver } from './component-hook-driver.ts'
import { DraftNavigation, type DraftRegistration } from '../../apps/web/src/draft-navigation.ts'
import { captureDeviceEditBaseline } from '../../packages/core/src/device-settings-edit.ts'
import { deviceDraftFields, deviceDraftChanged } from '../../apps/web/src/device-draft-close.ts'
import { pointDraftFields, pointDraftChanged, PointDraftCloseGuard } from '../../apps/web/src/point-draft-close.ts'
import { createPointEnumDraft, updatePointEnumDraft } from '../../apps/web/src/point-enum-draft.ts'
import { parsePointSettingsUpdate } from '../../apps/web/src/point-settings.ts'
import { isBinType, isHexType, registerWidth } from '../../packages/core/src/codec.ts'
import { PointDraftDiscard } from '../../apps/web/src/PointDraftDiscard.tsx'
import { PointEnumEditor } from '../../apps/web/src/PointEnumEditor.tsx'

// Actual source expressions/effects, controlled state and dialogs. No App mount or I/O.
const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../../apps/web/src/App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function find(node: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node | undefined { if (predicate(node)) return node; let result: ts.Node | undefined; ts.forEachChild(node, child => { result ??= find(child, predicate) }); return result }
const compile = (code: string) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React } }).outputText
const evaluate = (node: ts.Node, env: Record<string, unknown>) => new Function(...Object.keys(env), compile('return (' + node.getText(source) + ')'))(...Object.values(env))
const app = find(source, node => ts.isFunctionDeclaration(node) && node.name?.text === 'App')!
const deviceView = find(source, node => ts.isFunctionDeclaration(node) && node.name?.text === 'DeviceView')!
const variable = (name: string, root = app) => (find(root, node => ts.isVariableDeclaration(node) && node.name.getText(source) === name) as ts.VariableDeclaration).initializer!
const globalTab = find(app, node => ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'GlobalTabBar') as ts.JsxSelfClosingElement
const deviceButton = find(app, node => ts.isJsxOpeningElement(node) && node.tagName.getText(source) === 'button' && node.getText(source).includes('className="device-select"')) as ts.JsxOpeningElement
const tabs = find(deviceView, node => ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'TabBar') as ts.JsxSelfClosingElement
const attribute = (element: ts.JsxOpeningElement | ts.JsxSelfClosingElement, name: string) => ((element.attributes.properties.find(node => ts.isJsxAttribute(node) && node.name.getText(source) === name) as ts.JsxAttribute).initializer as ts.JsxExpression).expression!
const targetEffect = find(deviceView, node => ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect' && node.arguments[0]?.getText(source).includes('target.view')) as ts.CallExpression
const rootBranch = find(app, node => ts.isConditionalExpression(node) && node.condition.getText(source) === "view === 'database'")!
const refreshDevices = find(app, node => ts.isVariableDeclaration(node) && node.name.getText(source) === 'refreshDevices')!
const refreshRead = find(refreshDevices, node => ts.isCallExpression(node) && node.arguments.length === 3 && node.arguments[1].getText(source).includes('setDevices(objs)')) as ts.CallExpression
export const syntheticDevice = { id: 1, name: 'synthetic A', mode: 'master', ip: 'mock.invalid', port: 502, transport: 'tcp', serialPath: 'MOCK_PORT', baudRate: 9600, parity: 'even', stopBits: 1, dataBits: 8, flowControl: 'none', slaveId: 1, pollIntervalMs: 1000, timeoutMs: 3000 }
const t = (key: string) => key === 'cancel' ? '取消' : key
const document = { activeElement: { isConnected: true, focus() {} } }
const base = { PointDraftCloseGuard, PointDraftDiscard, document }
const pointScope = { ...base, pointDraftFields, pointDraftChanged, createPointEnumDraft, updatePointEnumDraft, parsePointSettingsUpdate, isBinType, isHexType, registerWidth, PointEnumEditor }
const deviceScope = { ...base, captureDeviceEditBaseline, deviceDraftFields, deviceDraftChanged, SerialPortPicker: () => null }
export type EditorKind = 'point' | 'device'
export function draftEditor(kind: EditorKind, draftScope?: DraftRegistration, onSave: (...args: any[]) => Promise<void> = async () => {}) {
  const calls = { close: 0, save: 0 }
  const callbacks = { onClose() { calls.close++ }, async onSave(...args: any[]) { calls.save++; await onSave(...args) } }
  const input = kind === 'point' ? { draftScope, name: 'synthetic point', address: 0, settings: { dataType: 'uint16', unit: 'V', factor: 1, offset: 0, enumJson: null, decimalPlaces: null }, available: 1, typeGroups: [{ key: 'types', types: ['uint16'] }], t, guarded: true, ...callbacks } : { draftScope, initial: syntheticDevice, t, ...callbacks }
  const driver = hookDriver(kind === 'point' ? 'PointSettingsEditor.tsx' : 'DeviceModal.tsx', kind === 'point' ? 'PointSettingsEditor' : 'DeviceModal', kind === 'point' ? pointScope : deviceScope, input)
  const label = kind === 'point' ? 'pointUnit' : 'name', original = kind === 'point' ? 'V' : syntheticDevice.name
  return { driver, calls, original, value: () => driver.one('input', props => props['aria-label'] === label).props.value,
    change(value = 'UNSAVED MOCK DRAFT') { driver.one('input', props => props['aria-label'] === label).props.onChange({ target: { value } }); driver.render() },
    close() { driver.one('button', props => props.className === 'modal-close').props.onClick(); driver.render() },
    resume() { driver.one(PointDraftDiscard).props.onResume(); driver.render() },
    discard() { driver.one(PointDraftDiscard).props.onDiscard(); driver.render() },
    submit(render = true) { driver.one('form').props.onSubmit({ preventDefault() {} }); if (render) driver.render() },
  }
}
export function draftSurface(options: { english?: boolean; slave?: boolean; mobile?: boolean } = {}) {
  let selectedId = 1, view = 'monitor', target: any = null, tab = 0, collapsed = 0, cancelledHistory = 0, answer: boolean | Error = false
  let devices = [{ ...syntheticDevice, mode: options.slave ? 'slave' : 'master' }, { ...syntheticDevice, id: 2, name: 'synthetic B' }]
  const prompts: string[] = [], notices: Array<{ error: boolean; text: string }> = [], changes: string[] = [], sequence = { current: 0 }
  const drafts = evaluate(variable('draftNavigation'), { useMemo: (fn: () => unknown) => fn(), DraftNavigation }) as DraftNavigation
  const setters = { setSelectedId(id: number) { changes.push('device'); selectedId = id }, setView(next: string) { changes.push('view'); view = next }, setDataTarget(next: unknown) { changes.push('target'); target = next } }
  const window = { innerWidth: options.mobile ? 640 : 1200, confirm(text: string) { prompts.push(text); if (answer instanceof Error) throw answer; return answer } }
  const confirmDraftLeave = (...args: unknown[]) => evaluate(variable('confirmDraftLeave'), { draftNavigation: drafts, lang: options.english ? 'en' : 'zh', window, operation: { setNotice: (value: { error: boolean; text: string }) => notices.push(value) } })(...args)
  const canNavigate = (...args: unknown[]) => evaluate(variable('canNavigate'), { selectedId, view, devices, confirmDraftLeave })(...args)
  const emit = evaluate(variable('navigateData'), { ...setters, navigationSequence: sequence, canNavigate })
  const render = () => {
    const selected = evaluate(variable('selected'), { devices, selectedId })
    const noAction = () => { throw Error('No write/refresh callback may run') }
    return evaluate(rootBranch, { ...setters, view, selected, selectedId, dataTarget: target, devices, DeviceView: 'mock-device-view', DatabaseView: 'mock-database-view', EmptyState: 'mock-empty-view', t, navigateData: emit, draftNavigation: drafts, confirmDraftLeave, groupSnapshot: { objectId: selectedId }, realtime: { status: 'connected' }, deviceConnected: {}, groups: [], latest: {}, groupErrors: {}, fallbackStatus: {}, operation: { busy: false }, toggleDevice: noAction, editDevice: noAction, deleteDevice: noAction, refreshRegisters: noAction, setShowAdd: noAction, React }) as React.ReactElement<any>
  }
  return { render, drafts, prompts, notices, changes, setAnswer(value: boolean | Error) { answer = value }, state: () => ({ selectedId, view, target, token: sequence.current, tab, collapsed, cancelledHistory }),
    registration() { const frame = render(); assert.equal(frame.type, 'mock-device-view'); assert.equal(frame.props.drafts, drafts); return evaluate(variable('draftScope', deviceView), { useMemo: (fn: () => unknown) => fn(), drafts: frame.props.drafts, device: frame.props.device }) as DraftRegistration },
    select(id: number) { evaluate(attribute(deviceButton, 'onClick'), { ...setters, canNavigate, d: { id }, window, setCollapsed() { collapsed++ } })() },
    global(next: string) { evaluate(attribute(globalTab, 'onChange'), { ...setters, canNavigate })(next) },
    reference(deviceId = 2, view = 'history') { emit({ deviceId, view, registerId: 7, start: '2026-11-08T00:00:00Z', end: '2026-11-08T01:00:00Z', label: 'mock' }) },
    applyTarget() { const frame = render(); evaluate(targetEffect.arguments[0], { target, device: frame.props.device, setTab: (next: number) => { tab = next } })() },
    localTab(next: number) { const frame = render(); evaluate(attribute(tabs, 'onChange'), { tab, onLeaveDrafts: frame.props.onLeaveDrafts, historyNavigation: { current: { cancelPending() { cancelledHistory++ } } }, setTab: (next: number) => { changes.push('tab'); tab = next } })(next) },
    remove() { evaluate(refreshRead.arguments[1], { setDevices(next: typeof devices) { devices = next }, setDeviceConnected() {}, setDeviceLoadError() {} })({ objs: devices.filter(value => value.id !== selectedId), map: {} }) },
    deviceSaveHandler(onEdit: (...args: any[]) => Promise<void>, close: () => void) {
      const modal = find(deviceView, node => ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'DeviceModal') as ts.JsxSelfClosingElement
      return evaluate(attribute(modal, 'onSave'), { device: render().props.device, t, onEdit, setShowEdit: (value: boolean) => { assert.equal(value, false); close() } }) as (...args: any[]) => Promise<void>
    },
  }
}

export function assertDraftWiring(page: ReturnType<typeof draftSurface>) {
  const registration = page.registration()
  for (const tag of ['DeviceModal', 'LiveTable']) {
    const child = find(deviceView, node => ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === tag) as ts.JsxSelfClosingElement
    assert.equal(evaluate(attribute(child, 'draftScope'), { draftScope: registration }), registration)
  }
  const table = find(source, node => ts.isFunctionDeclaration(node) && node.name?.text === 'LiveTable')!
  const editor = find(table, node => ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'PointSettingsEditor') as ts.JsxSelfClosingElement
  assert.equal(evaluate(attribute(editor, 'draftScope'), { draftScope: registration }), registration)
  const rootAdd = find(app, node => ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'DeviceModal') as ts.JsxSelfClosingElement
  assert(!rootAdd.attributes.properties.some(node => ts.isJsxAttribute(node) && node.name.getText(source) === 'draftScope'), 'root add dialog persists across these routes and is not a device-view draft')
}
