import assert from 'node:assert/strict'
import fs from 'node:fs'
import React, { type ComponentProps, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DeferredResource } from '../apps/web/src/deferred-resource.ts'
import { DeferredConfigModal, DeferredDeviceModal, DeferredGroupModal, ConfigModalLoading, deviceModalResource, groupModalResource } from '../apps/web/src/DeferredConfigModal.tsx'
import { DeviceModal } from '../apps/web/src/DeviceModal.tsx'
import { GroupModal } from '../apps/web/src/GroupModal.tsx'
import { captureDeviceEditBaseline } from '../packages/core/src/device-settings-edit.ts'
import { captureGroupOpening, parseGroupEditChanges, planGroupResize } from '../packages/core/src/group-settings-edit.ts'
import { readGroupSettings, saveGuardedGroupSettings, groupCreateWarnings } from '../apps/web/src/group-settings-save.ts'
import { configurationWriteBlocked } from '../apps/web/src/configuration-write-outcome.ts'
import { draftEditor, syntheticDevice } from './fixtures/draft-navigation-driver.ts'
import { hookDriver } from './fixtures/component-hook-driver.ts'

const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const tick = () => new Promise<void>(done => setImmediate(done))
let passed = 0
async function check(name: string, action: () => void | Promise<void>) { await action(); passed++; console.log('CONFIG MODAL LOADING OK: ' + name) }
const t = (key: string) => key === 'cancel' ? '取消' : key
const deviceProps: ComponentProps<typeof DeviceModal> = { t, initial: syntheticDevice, onClose() {}, async onSave() { assert.fail('no automatic device save') } }
const groupProps: ComponentProps<typeof GroupModal> = { t, device: captureDeviceEditBaseline(syntheticDevice), initial: null, onClose() {}, onSaved() { assert.fail('no automatic group save') }, async get() { assert.fail('no automatic group read before the form mounts') }, async put() { assert.fail('no automatic group write') }, async create() { assert.fail('no automatic group creation') } }
function wrapper<P extends { t: (key: string) => string; onClose: () => void }>(resource: DeferredResource<ComponentType<P>>, props: P) {
  let restored = 0, loadingFocus = 0, modalPresent = false
  const opener = { isConnected: true, matches: () => false, focus() { restored++ } }, body = {}, close = { focus() { loadingFocus++ } }
  const document = { activeElement: opener as unknown, body, querySelector() { return modalPresent ? {} : null } }
  const surface = { isConnected: true, querySelector() { return close } }
  const driver = hookDriver('DeferredConfigModal.tsx', 'DeferredConfigModal', hooks => ({ ConfigModalLoading, document, useSyncExternalStore(subscribe: (notify: () => void) => () => void, snapshot: () => unknown) { (hooks.useEffect as Function)(() => subscribe(() => {}), [subscribe]); return snapshot() } }), { resource, props, title: 'synthetic editor' }, tree => { tree.ref.current = surface })
  return { driver, update(next = props) { props = next; driver.render({ resource, props, title: 'synthetic editor' }) }, html: () => renderToStaticMarkup(driver.tree), document, opener, body, surface, focus: () => ({ restored, loadingFocus }), setModal(value: boolean) { modalPresent = value } }
}

await check('source wiring and SSR never load a closed configuration editor', () => {
  const app = fs.readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8')
  assert(app.includes('DeferredDeviceModal as DeviceModal, DeferredGroupModal as GroupModal')); assert(app.includes('{showAdd && <DeviceModal')); assert(app.includes('{showEdit && <DeviceModal')); assert(app.includes('{modal && <GroupModal'))
  assert(!/import \{ DeviceModal/.test(app)); assert(!/import \{ GroupModal/.test(app))
  assert.equal(deviceModalResource.snapshot().status, 'idle'); assert.equal(groupModalResource.snapshot().status, 'idle')
  assert(renderToStaticMarkup(React.createElement(DeferredDeviceModal, deviceProps)).includes('正在加载编辑界面'))
  assert(renderToStaticMarkup(React.createElement(DeferredGroupModal, groupProps)).includes('newGroup'))
  assert.equal(deviceModalResource.snapshot().status, 'idle'); assert.equal(groupModalResource.snapshot().status, 'idle')
})
await check('independent editors coalesce loads and use current visible props', async () => {
  for (const [Modal, props] of [[DeviceModal, deviceProps], [GroupModal, groupProps]] as const) {
    let imports = 0; const code = deferred<ComponentType<any>>(), resource = new DeferredResource<ComponentType<any>>(() => { imports++; return code.promise })
    const view = wrapper(resource, props); const latest = { ...props, t: (key: string) => key === 'cancel' ? 'Cancel' : key }
    try { await tick(); assert.equal(imports, 1); assert.equal(resource.load(), resource.load()); view.update(latest); code.resolve(Modal); await resource.load(); view.update(latest); assert.equal(view.driver.one(Modal).props.t('cancel'), 'Cancel'); assert(!view.html().includes('Loading editor')); await resource.load(); assert.equal(imports, 1) } finally { view.driver.dispose() }
  }
})
await check('failed code needs explicit retry and never replays a business operation', async () => {
  for (const english of [false, true]) {
    let imports = 0, closes = 0; const resource = new DeferredResource<typeof DeviceModal>(async () => { if (++imports === 1) throw Error('PRIVATE asset error'); return DeviceModal })
    const props = { ...deviceProps, t: (key: string) => key === 'cancel' ? english ? 'Cancel' : '取消' : key, onClose() { closes++ } }, view = wrapper(resource, props)
    try { await resource.load(); view.update(); assert(view.html().includes('role="alert"')); assert(view.html().includes(english ? 'no configuration write is retried' : '不会重试配置写入')); assert(!view.html().includes('PRIVATE')); await resource.load(); assert.equal(imports, 1); view.driver.one(ConfigModalLoading).props.retry(); await resource.load(); view.update(); assert.equal(view.driver.one(DeviceModal).type, DeviceModal); assert.equal(imports, 2); assert.equal(closes, 0) } finally { view.driver.dispose() }
  }
})
await check('close and device replacement cannot mount a late old consumer', async () => {
  const code = deferred<typeof DeviceModal>(), resource = new DeferredResource<typeof DeviceModal>(() => code.promise)
  let closed = 0; const first = wrapper(resource, { ...deviceProps, onClose() { closed++ } }); await tick(); first.driver.one(ConfigModalLoading).props.close(); first.driver.dispose(); assert.equal(closed, 1)
  const secondProps = { ...deviceProps, initial: { ...syntheticDevice, id: 2, name: 'synthetic B' } }, second = wrapper(resource, secondProps)
  try { code.resolve(DeviceModal); await resource.load(); second.update(); assert.equal(first.driver.lateWrites, 0); assert.equal(second.driver.one(DeviceModal).props.initial.id, 2); assert(second.html().includes('synthetic B')); assert(!second.html().includes('synthetic A')) } finally { second.driver.dispose() }
})
await check('timeout ignores obsolete code and reopening does not auto retry a failure', async () => {
  let imports = 0; const late = deferred<typeof DeviceModal>(), resource = new DeferredResource<typeof DeviceModal>(() => ++imports === 1 ? late.promise : Promise.resolve(DeviceModal), 5)
  const first = wrapper(resource, deviceProps); await resource.load(); first.update(); assert(first.html().includes('加载失败')); first.driver.dispose()
  const second = wrapper(resource, deviceProps)
  try { await resource.load(); assert.equal(imports, 1); second.driver.one(ConfigModalLoading).props.retry(); await resource.load(); const stable = resource.snapshot(); late.resolve(DeviceModal); await tick(); assert.equal(resource.snapshot(), stable); second.update(); assert.equal(second.driver.one(DeviceModal).type, DeviceModal) } finally { second.driver.dispose() }
})
await check('loading dialog keyboard and focus do not interfere with another modal', async () => {
  let closes = 0, retries = 0
  const tree = ConfigModalLoading({ state: { status: 'error', value: null }, t, title: 'synthetic', close() { closes++ }, retry() { retries++ } }), section = (tree.props as any).children
  let prevented = 0, stopped = 0; section.props.onKeyDown({ key: 'Escape', nativeEvent: { isComposing: true }, preventDefault() { prevented++ }, stopPropagation() { stopped++ } }); assert.equal(closes, 0)
  section.props.onKeyDown({ key: 'Escape', nativeEvent: {}, preventDefault() { prevented++ }, stopPropagation() { stopped++ } }); assert.deepEqual([closes, prevented, stopped, retries], [1, 1, 1, 0])
  for (const obstruction of ['none', 'other-modal', 'disabled', 'disconnected'] as const) {
    const resource = new DeferredResource<typeof DeviceModal>(() => new Promise(() => {}), 5), view = wrapper(resource, deviceProps); assert.equal(view.focus().loadingFocus, 1)
    view.surface.isConnected = false; view.document.activeElement = view.body; if (obstruction === 'other-modal') view.setModal(true); if (obstruction === 'disabled') view.opener.matches = () => true; if (obstruction === 'disconnected') view.opener.isConnected = false
    view.driver.dispose(); assert.equal(view.focus().restored, obstruction === 'none' ? 1 : 0); await resource.load(); assert.equal(view.driver.lateWrites, 0)
  }
})
await check('loaded device keeps its existing dirty draft and pending save guard', async () => {
  const resource = new DeferredResource<typeof DeviceModal>(async () => DeviceModal), save = deferred<void>(); let writes = 0
  const props = { ...deviceProps, async onSave() { writes++; return save.promise } }, view = wrapper(resource, props)
  try {
    await resource.load(); view.update(); const forwarded = view.driver.one(DeviceModal).props
    const editor = draftEditor('device', undefined, forwarded.onSave)
    try { editor.change('UNSAVED DEFERRED DRAFT'); editor.close(); editor.resume(); assert.equal(editor.value(), 'UNSAVED DEFERRED DRAFT'); editor.submit(); editor.submit(); assert.equal(writes, 1); view.update(); assert.equal(view.driver.one(DeviceModal).type, DeviceModal); save.resolve(); await tick(); editor.driver.render(); assert.equal(editor.calls.save, 1) } finally { editor.driver.dispose() }
  } finally { view.driver.dispose() }
})
await check('loaded group creates only on explicit submit and retains an uncertain draft', async () => {
  const resource = new DeferredResource<typeof GroupModal>(async () => GroupModal), pending = deferred<unknown>(); let writes = 0
  const props = { ...groupProps, create: async () => { writes++; return pending.promise } }, view = wrapper(resource, props)
  try {
    await resource.load(); view.update(); const forwarded = view.driver.one(GroupModal).props
    const editor = hookDriver('GroupModal.tsx', 'GroupModal', { captureDeviceEditBaseline, captureGroupOpening, parseGroupEditChanges, planGroupResize, readGroupSettings, saveGuardedGroupSettings, groupCreateWarnings, configurationWriteBlocked }, forwarded)
    try { assert.equal(writes, 0); editor.one('input').props.onChange({ target: { value: 'NEW GROUP DRAFT' } }); editor.render(); editor.one('form').props.onSubmit({ preventDefault() {} }); editor.one('form').props.onSubmit({ preventDefault() {} }); assert.equal(writes, 1); pending.resolve(Promise.reject(Error('synthetic response lost'))); await tick(); editor.render(); assert.equal(editor.one('input').props.value, 'NEW GROUP DRAFT'); assert.match(editor.one('div', value => value.role === 'alert').props.children, /待核实/); assert.equal(writes, 1) } finally { editor.dispose() }
  } finally { view.driver.dispose() }
})
await deviceModalResource.load(); await groupModalResource.load(); assert.equal(deviceModalResource.snapshot().value, DeviceModal); assert.equal(groupModalResource.snapshot().value, GroupModal)
console.log('CONFIG MODAL LOADING TEST OK: ' + passed + ' source/SSR and controlled loader/device/group/keyboard/focus lifecycle groups; no actual browser, network, storage, serial enumeration, model or hardware')
