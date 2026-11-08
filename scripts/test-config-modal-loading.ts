import { groupEditorScope } from './fixtures/group-editor-scope.ts'
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
import { draftEditor, draftSurface, assertDraftWiring, syntheticDevice } from './fixtures/draft-navigation-driver.ts'
import { hookDriver } from './fixtures/component-hook-driver.ts'

const deferred = <T,>() => { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((done, failed) => { resolve = done; reject = failed }); return { promise, resolve, reject } }
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
    const editor = hookDriver('GroupModal.tsx', 'GroupModal', groupEditorScope({ captureDeviceEditBaseline, captureGroupOpening, parseGroupEditChanges, planGroupResize, readGroupSettings, saveGuardedGroupSettings, groupCreateWarnings, configurationWriteBlocked }), forwarded)
    try { assert.equal(writes, 0); editor.one('input').props.onChange({ target: { value: 'NEW GROUP DRAFT' } }); editor.render(); editor.one('form').props.onSubmit({ preventDefault() {} }); editor.one('form').props.onSubmit({ preventDefault() {} }); assert.equal(writes, 1); pending.resolve(Promise.reject(Error('synthetic response lost'))); await tick(); editor.render(); assert.equal(editor.one('input').props.value, 'NEW GROUP DRAFT'); assert.match(editor.one('div', value => value.role === 'alert').props.children, /待核实/); assert.equal(writes, 1) } finally { editor.dispose() }
  } finally { view.driver.dispose() }
})
// Reconcile explicit simulated mounts against the actual App branch key and navigation callbacks.
// This drives the existing component functions, not a React DOM/browser renderer.
function deviceHost(page: ReturnType<typeof draftSurface>, resource: DeferredResource<typeof DeviceModal>, onEdit: (...args: any[]) => Promise<void> = async () => { assert.fail('no automatic configuration write') }) {
  const opening = page.render(), owner = opening.props.device as typeof syntheticDevice, draftScope = page.registration()
  let active = true, editor: ReturnType<typeof draftEditor> | null = null, closes = 0
  const props = { ...deviceProps, initial: owner, draftScope, onClose() { closes++ }, onSave: page.deviceSaveHandler(onEdit, () => { closes++ }) }, view = wrapper(resource, props)
  const dispose = () => { if (!active) return; active = false; editor?.driver.dispose(); view.surface.isConnected = false; view.driver.dispose() }
  const reconcile = () => {
    if (!active) return
    const current = page.render()
    if (current.type !== opening.type || current.key !== opening.key) { dispose(); return }
    view.update()
    if (!editor && resource.snapshot().status === 'ready') { const forwarded = view.driver.one(DeviceModal).props; editor = draftEditor('device', forwarded.draftScope, forwarded.onSave, null, undefined, forwarded.initial) }
  }
  return { view, reconcile, dispose, active: () => active, editor: () => { assert(editor); return editor }, closes: () => closes }
}
await check('cold navigation unloads only the owner identified by the actual App key', async () => {
  for (const route of ['device', 'database', 'reference'] as const) {
    const page = draftSurface(), code = deferred<typeof DeviceModal>(), resource = new DeferredResource<typeof DeviceModal>(() => code.promise), host = deviceHost(page, resource)
    try { assertDraftWiring(page); await tick(); assert.equal(page.drafts.retained().length, 0); if (route === 'device') page.select(2); else if (route === 'database') page.global('database'); else page.reference(2)
      host.reconcile(); assert(!host.active()); assert.equal(page.prompts.length, 0, 'no editor or draft exists while code loads'); const destination = page.state(); code.resolve(DeviceModal); await resource.load(); host.reconcile(); assert.deepEqual(page.state(), destination); assert.equal(host.view.driver.lateWrites, 0); assert.equal(host.closes(), 0)
    } finally { code.resolve(DeviceModal); await resource.load(); host.dispose() }
  }
})
await check('failed load retry cannot bypass another dirty editor or cancelled navigation', async () => {
  const page = draftSurface(), point = draftEditor('point', page.registration()); let imports = 0
  const resource = new DeferredResource<typeof DeviceModal>(async () => { if (++imports === 1) throw Error('synthetic code error'); return DeviceModal }), host = deviceHost(page, resource)
  try {
    point.change('POINT DRAFT BEFORE RETRY'); await resource.load(); host.reconcile(); const before = page.state(); page.select(2); host.reconcile(); assert.deepEqual(page.state(), before); assert(host.active()); assert.equal(page.prompts.length, 1)
    host.view.driver.one(ConfigModalLoading).props.retry(); await resource.load(); host.reconcile(); const editor = host.editor(); editor.change('DEVICE DRAFT AFTER RETRY'); page.global('database'); host.reconcile(); assert.deepEqual(page.state(), before); assert.equal(page.prompts.length, 2, 'one shared confirmation for both dirty editors'); assert.equal(point.value(), 'POINT DRAFT BEFORE RETRY'); assert.equal(editor.value(), 'DEVICE DRAFT AFTER RETRY'); assert.equal(point.calls.save + editor.calls.save, 0); assert.equal(imports, 2)
    page.setAnswer(true); page.select(2); host.reconcile(); assert(!host.active()); assert.equal(page.state().selectedId, 2)
  } finally { point.driver.dispose(); host.dispose() }
})
await check('loaded device preserves navigation ranges and a pending or unknown save', async () => {
  const page = draftSurface(), resource = new DeferredResource<typeof DeviceModal>(async () => DeviceModal), save = deferred<void>(); let writes = 0
  const host = deviceHost(page, resource, async (id: number) => { assert.equal(id, 1); writes++; return save.promise })
  try {
    await resource.load(); host.reconcile(); const editor = host.editor(); editor.change('PENDING OWNER DRAFT'); page.localTab(2); host.reconcile(); assert.equal(page.state().tab, 2, 'device editor is a sibling and remains mounted across local tabs'); assert(host.active()); assert.equal(page.prompts.length, 0)
    editor.submit(); const before = page.state(); page.select(2); host.reconcile(); assert.deepEqual(page.state(), before); assert.equal(page.prompts.length, 0, 'pending save blocks without asking for consent'); assert.equal(writes, 1)
    save.reject(Error('synthetic unverified result')); await tick(); editor.driver.render(); page.global('database'); host.reconcile(); assert.deepEqual(page.state(), before); assert.equal(page.prompts.length, 1); assert.equal(editor.value(), 'PENDING OWNER DRAFT'); assert.equal(writes, 1); assert.equal(host.closes(), 0)
  } finally { host.dispose() }
})
await check('A-to-B-to-A navigation plus timed-out old code cannot replace fresh drafts', async () => {
  const page = draftSurface(), oldCode = deferred<typeof DeviceModal>(); let imports = 0
  const resource = new DeferredResource<typeof DeviceModal>(() => ++imports === 1 ? oldCode.promise : Promise.resolve(DeviceModal), 5), old = deviceHost(page, resource)
  await resource.load(); old.reconcile(); page.select(2); old.reconcile(); assert(!old.active())
  const fresh = deviceHost(page, resource)
  try {
    fresh.view.driver.one(ConfigModalLoading).props.retry(); await resource.load(); fresh.reconcile(); const editor = fresh.editor(); editor.change('FRESH B DRAFT'); const before = page.state(); oldCode.resolve(DeviceModal); await tick(); fresh.reconcile(); old.reconcile(); assert.deepEqual(page.state(), before); assert.equal(editor.value(), 'FRESH B DRAFT'); assert.equal(old.view.driver.lateWrites, 0); assert.equal(imports, 2)
    page.select(1); fresh.reconcile(); assert.equal(page.state().selectedId, 2); assert.equal(page.prompts.length, 1); page.setAnswer(true); page.select(1); fresh.reconcile(); assert(!fresh.active()); const returned = deviceHost(page, resource)
    try { returned.reconcile(); assert.equal(returned.editor().value(), 'synthetic A'); assert.equal(returned.editor().calls.save, 0); assert.equal(page.drafts.retained().length, 0) } finally { returned.dispose() }
  } finally { oldCode.resolve(DeviceModal); old.dispose(); fresh.dispose() }
})
await check('group code retry after owner navigation uses only the new device callbacks', async () => {
  const page = draftSurface(), late = deferred<typeof GroupModal>(); let imports = 0, oldWrites = 0, newWrites = 0
  const resource = new DeferredResource<typeof GroupModal>(() => ++imports === 1 ? late.promise : Promise.resolve(GroupModal), 5)
  const old = wrapper(resource, { ...groupProps, async create() { oldWrites++; assert.fail('closed group callback') } }); await resource.load(); old.update(); page.select(2); assert.equal(page.prompts.length, 0); old.driver.dispose()
  const props = { ...groupProps, draftScope: page.registration(), device: captureDeviceEditBaseline(page.render().props.device), onSaved() {}, async create(url: string) { assert.equal(url, '/api/monitor_objects/2/groups'); newWrites++; return { id: 99 } } }, fresh = wrapper(resource, props)
  try {
    fresh.driver.one(ConfigModalLoading).props.retry(); await resource.load(); fresh.update(); const forwarded = fresh.driver.one(GroupModal).props; assert.equal(forwarded.device.id, 2)
    const editor = hookDriver('GroupModal.tsx', 'GroupModal', groupEditorScope({ captureDeviceEditBaseline, captureGroupOpening, parseGroupEditChanges, planGroupResize, readGroupSettings, saveGuardedGroupSettings, groupCreateWarnings, configurationWriteBlocked }), forwarded)
    try { editor.one('input').props.onChange({ target: { value: 'B GROUP DRAFT' } }); editor.render(); late.resolve(GroupModal); await tick(); fresh.update(); assert.equal(editor.one('input').props.value, 'B GROUP DRAFT'); page.select(1); assert.equal(page.state().selectedId, 2); assert.equal(page.prompts.length, 1); assert.equal(old.driver.lateWrites, 0); assert.equal(oldWrites + newWrites, 0); editor.one('form').props.onSubmit({ preventDefault() {} }); await tick(); assert.equal(oldWrites, 0); assert.equal(newWrites, 1) } finally { editor.dispose() }
  } finally { late.resolve(GroupModal); fresh.driver.dispose() }
})
await check('loaded group draft blocks cancelled owner navigation after code loading', () => {
  const page = draftSurface(), editor = hookDriver('GroupModal.tsx', 'GroupModal', groupEditorScope({ captureDeviceEditBaseline, captureGroupOpening, parseGroupEditChanges, planGroupResize, readGroupSettings, saveGuardedGroupSettings, groupCreateWarnings, configurationWriteBlocked }), { ...groupProps, draftScope: page.registration() })
  try { editor.one('input').props.onChange({ target: { value: 'PROTECTED GROUP DRAFT' } }); editor.render(); page.select(2); assert.equal(page.state().selectedId, 1); assert.equal(page.prompts.length, 1); assert.equal(editor.one('input').props.value, 'PROTECTED GROUP DRAFT'); assert.equal(page.drafts.retained().length, 0) } finally { editor.dispose() }
})
await deviceModalResource.load(); await groupModalResource.load(); assert.equal(deviceModalResource.snapshot().value, DeviceModal); assert.equal(groupModalResource.snapshot().value, GroupModal)
console.log('CONFIG MODAL LOADING TEST OK: ' + passed + ' source/SSR and controlled loader/device/group/keyboard/focus lifecycle groups; no actual browser, network, storage, serial enumeration, model or hardware')
