import assert from 'node:assert/strict'
import fs from 'node:fs'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { captureDeviceEditBaseline } from '../packages/core/src/device-settings-edit.ts'
import { captureGroupOpening, parseGroupEditChanges, planGroupResize } from '../packages/core/src/group-settings-edit.ts'
import { readGroupSettings, saveGuardedGroupSettings, groupCreateWarnings } from '../apps/web/src/group-settings-save.ts'
import { configurationWriteBlocked } from '../apps/web/src/configuration-write-outcome.ts'
import { RetainedDraftNotice } from '../apps/web/src/RetainedDraftNotice.tsx'
import { draftSurface, draftEditor, syntheticDevice } from './fixtures/draft-navigation-driver.ts'
import { hookDriver } from './fixtures/component-hook-driver.ts'
import { groupEditorScope } from './fixtures/group-editor-scope.ts'

const tick = () => new Promise<void>(done => setImmediate(done))
const deferred = <T,>() => { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
let passed = 0
async function check(name: string, action: () => void | Promise<void>) { await action(); passed++; console.log('GROUP DRAFT OK: ' + name) }
function groupEditor(page: ReturnType<typeof draftSurface>, editing = false, options: { english?: boolean; wait?: ReturnType<typeof deferred<unknown>>; read?: ReturnType<typeof deferred<unknown>> } = {}) {
  const device = page.render().props.device as typeof syntheticDevice, point = { id: 21, objectId: device.id, groupId: 7, alias: 'synthetic point', functionCode: 3, startAddress: 0, quantity: 1, dataType: 'uint16', unit: null, factor: 1, offset: 0, enumJson: null, decimalPlaces: null }
  const group = { id: 7, objectId: device.id, name: 'synthetic group', slaveId: 1, functionCode: 3, startAddress: 0, quantity: 1, mode: 'read', isActive: 1, registers: [point] }, opening = captureGroupOpening(group, device)
  const snapshot = { ...opening, rules: [], revision: 'v1:' + '0'.repeat(64) }; let writes = 0, closes = 0, saves = 0, reads = 0
  const props = { t: (key: string) => key === 'cancel' ? options.english ? 'Cancel' : '取消' : key, device: captureDeviceEditBaseline(device), initial: editing ? group : null, draftScope: page.registration(), onClose() { closes++ }, onSaved() { saves++ }, async get(_url: string, signal: AbortSignal) { reads++; assert(!signal.aborted); return options.read ? options.read.promise : snapshot }, async create(url: string) { assert.equal(url, '/api/monitor_objects/' + device.id + '/groups'); writes++; return options.wait ? options.wait.promise : { id: 99 } }, async put(url: string, body: any) { assert.equal(url, '/api/groups/7/settings'); writes++; return options.wait ? options.wait.promise : { warnings: [], addedRegisterIds: [], deletedRegisterIds: [], deletedRuleIds: [], snapshot: { ...snapshot, group: { ...snapshot.group, ...body.changes } } } } }
  const driver = hookDriver('GroupModal.tsx', 'GroupModal', groupEditorScope({ captureDeviceEditBaseline, captureGroupOpening, parseGroupEditChanges, planGroupResize, readGroupSettings, saveGuardedGroupSettings, groupCreateWarnings, configurationWriteBlocked, window: page.window }), props)
  return { driver, props, snapshot, counts: () => ({ writes, closes, saves, reads }), value: () => driver.one('input', p => !p.type).props.value, change(value: string) { driver.one('input', p => !p.type).props.onChange({ target: { value } }); driver.render() }, submit() { driver.one('form').props.onSubmit({ preventDefault() {} }); driver.render() }, close() { driver.one('button', p => p.type === 'button' && p.children === props.t('cancel')).props.onClick(); driver.render() }, async ready() { await tick(); driver.render() } }
}

await check('actual App forwards group ownership and cancelled routes preserve edited inputs', async () => {
  const source = fs.readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8'); assert(source.includes('<GroupModal draftScope={draftScope}'))
  for (const editing of [false, true]) for (const route of ['device', 'database', 'history', 'reference'] as const) {
    const page = draftSurface(), editor = groupEditor(page, editing)
    try { await editor.ready(); assert.equal(page.window.count(), 0); editor.change('GROUP RAW DRAFT'); assert(page.window.fire().prevented); const before = page.state(); if (route === 'device') page.select(2); else if (route === 'database') page.global('database'); else if (route === 'history') page.localTab(2); else page.reference(2)
      assert.deepEqual(page.state(), before); assert.equal(page.prompts.length, 1); assert.equal(editor.value(), 'GROUP RAW DRAFT'); assert.equal(editor.counts().writes, 0)
      page.setAnswer(true); page.select(2); assert.equal(page.state().selectedId, 2)
    } finally { editor.driver.dispose(); assert.equal(page.window.count(), 0) }
  }
})
await check('one confirmation covers group plus point while reverted and clean groups do not interfere', async () => {
  const page = draftSurface(), group = groupEditor(page, true), point = draftEditor('point', page.registration())
  try { await group.ready(); group.change('DIRTY GROUP'); point.change('DIRTY POINT'); page.select(2); assert.equal(page.prompts.length, 1); assert.equal(page.state().selectedId, 1); assert.equal(group.value(), 'DIRTY GROUP'); assert.equal(point.value(), 'DIRTY POINT'); group.change('synthetic group'); point.change(point.original); page.localTab(2); assert.equal(page.state().tab, 2); assert.equal(page.prompts.length, 1); assert.equal(group.counts().writes, 0) } finally { group.driver.dispose(); point.driver.dispose() }
})
await check('close cancellation and Escape preserve memory drafts without save or undo', async () => {
  for (const english of [false, true]) {
    const page = draftSurface(), editor = groupEditor(page, true, { english })
    try { await editor.ready(); editor.change('CLOSE DRAFT'); editor.close(); assert.equal(editor.counts().closes, 0); assert.equal(editor.value(), 'CLOSE DRAFT'); let stopped = 0; const event = (composing: boolean) => ({ key: 'Escape', nativeEvent: { isComposing: composing }, preventDefault() {}, stopPropagation() { stopped++ } }); editor.driver.one('form').props.onKeyDown(event(true)); assert.equal(stopped, 0); editor.driver.one('form').props.onKeyDown(event(false)); assert.equal(stopped, 1); assert.equal(editor.counts().closes, 0); page.setAnswer(true); editor.close(); assert.equal(editor.counts().closes, 1); assert.equal(editor.counts().writes, 0) } finally { editor.driver.dispose() }
  }
})
await check('pending saves block navigation deletion and close; unknown results keep drafts without replay', async () => {
  for (const editing of [false, true]) {
    const page = draftSurface(), wait = deferred<unknown>(), editor = groupEditor(page, editing, { wait })
    try { await editor.ready(); editor.change('PENDING GROUP'); editor.submit(); editor.submit(); assert.equal(editor.counts().writes, 1); const before = page.state(); page.select(2); page.global('database'); page.localTab(2); editor.close(); assert.deepEqual(page.state(), before); assert.equal(page.prompts.length, 0); assert.equal(editor.counts().closes, 0); assert.equal(page.drafts.beginRemoval(1), false); assert(page.window.fire().prevented)
      wait.reject(Error('synthetic result lost')); await editor.ready(); assert.equal(editor.value(), 'PENDING GROUP'); assert.equal(editor.counts().saves, 0); page.select(2); assert.equal(page.state().selectedId, 1); assert.equal(page.prompts.length, 1); assert.equal(editor.counts().writes, 1); assert.match(editor.driver.one('div', p => p.role === 'alert').props.children, /待核实/)
    } finally { editor.driver.dispose() }
  }
})
await check('observed removal seals old editors and retains raw group input through same-ID reappearance', async () => {
  for (const editing of [false, true]) {
    const page = draftSurface(), editor = groupEditor(page, editing)
    try { await editor.ready(); editor.change('RAW GROUP <&>'); editor.driver.one('input', p => p.min === 1).props.onChange({ target: { value: '' } }); editor.driver.render(); page.remove(); editor.driver.render(); const records = page.drafts.retained(); assert.equal(records.length, 1); assert.equal(records[0].kind, 'group'); assert(records[0].snapshot?.text.includes('RAW GROUP <&>')); assert(records[0].snapshot?.text.includes('"quantity": ""')); const frozen = JSON.stringify(records); assert.equal(editor.driver.one('fieldset').props.disabled, true)
      await page.refresh(async () => [{ ...syntheticDevice }, { ...syntheticDevice, id: 2 }]); editor.submit(); assert.equal(editor.counts().writes, 0); assert.equal(JSON.stringify(page.drafts.retained()), frozen)
      const fresh = groupEditor(page, editing); try { await fresh.ready(); fresh.change('FRESH SAME-ID GROUP'); page.setAnswer(true); page.retentionNotice().props.onDiscard(records[0].id); assert.equal(page.drafts.retained().length, 0); page.setAnswer(false); page.select(2); assert.equal(page.state().selectedId, 1); assert.equal(fresh.value(), 'FRESH SAME-ID GROUP'); editor.submit(); assert.equal(editor.counts().writes, 0) } finally { fresh.driver.dispose() }
    } finally { editor.driver.dispose() }
  }
})
await check('late committed or failed saves after removal cannot affect a new owner or retry writes', async () => {
  for (const result of ['success', 'failure'] as const) {
    const page = draftSurface(), wait = deferred<unknown>(), editor = groupEditor(page, false, { wait }); await editor.ready(); editor.change('REMOVED PENDING GROUP'); editor.submit(); page.remove(); const record = JSON.stringify(page.drafts.retained()); assert.equal(page.drafts.retained()[0].busy, true); editor.driver.dispose(); page.select(2); const next = groupEditor(page); next.change('CURRENT B GROUP'); const destination = page.state()
    try { if (result === 'success') wait.resolve({ id: 99 }); else wait.reject(Error('late synthetic failure')); await tick(); assert.deepEqual(page.state(), destination); assert.equal(next.value(), 'CURRENT B GROUP'); assert.equal(editor.counts().writes, 1); assert.equal(editor.counts().saves, 0); assert.equal(editor.driver.lateWrites, 0); assert.equal(JSON.stringify(page.drafts.retained()), record); assert.equal(next.counts().writes, 0) } finally { next.driver.dispose() }
  }
})
await check('late snapshot reads cannot revive removed editors and clean removal invents no draft', async () => {
  const page = draftSurface(), read = deferred<unknown>(), editor = groupEditor(page, true, { read }); editor.change('DRAFT BEFORE READ'); page.remove(); editor.driver.render(); read.resolve(editor.snapshot); await editor.ready(); editor.submit(); assert.equal(editor.counts().writes, 0); assert.equal(editor.driver.one('fieldset').props.disabled, true); editor.driver.dispose()
  const cleanPage = draftSurface(), clean = groupEditor(cleanPage, true)
  try { await clean.ready(); assert.equal(cleanPage.window.count(), 0); cleanPage.remove(); clean.driver.render(); assert.equal(cleanPage.drafts.retained().length, 0); clean.submit(); assert.equal(clean.counts().writes, 0) } finally { clean.driver.dispose() }
})
await check('success callback and bilingual read-only records distinguish page memory from saved configuration', async () => {
  for (const english of [false, true]) {
    const page = draftSurface(), editor = groupEditor(page, true, { english })
    try { await editor.ready(); editor.change('SUCCESS GROUP'); editor.submit(); await editor.ready(); assert.equal(editor.counts().writes, 1); assert.equal(editor.counts().saves, 1); assert.equal(editor.counts().closes, 0); page.remove(); const html = renderToStaticMarkup(React.createElement(RetainedDraftNotice, { records: page.drafts.retained(), english, onDiscard() {} })); assert(html.includes(english ? 'Group editor' : '分组编辑')); assert(html.includes(english ? 'page memory only' : '当前页内存')); assert(html.includes(english ? 'not saved configuration' : '不是已保存配置')) } finally { editor.driver.dispose() }
  }
})
await check('native unload warns only for current raw input risk and cleans up on revert or disposal', async () => {
  for (const editing of [false, true]) {
    const page = draftSurface(), editor = groupEditor(page, editing)
    try {
      await editor.ready(); const original = editor.value(); assert.equal(page.window.count(), 0); assert.equal(page.window.fire().prevented, 0)
      editor.change('UNLOAD GROUP INPUT'); assert.equal(page.window.count(), 1); const event = page.window.fire(); assert.equal(event.prevented, 1); assert.equal(event.returnValue, ' '); page.window.fire(); assert.equal(editor.value(), 'UNLOAD GROUP INPUT'); assert.equal(editor.counts().writes, 0); assert.equal(editor.counts().closes, 0); assert.equal(page.prompts.length, 0, 'native event handler never opens a custom confirmation')
      editor.change(original); assert.equal(page.window.count(), 0); assert.equal(page.window.fire().prevented, 0)
      editor.change('DISPOSE GROUP INPUT'); editor.driver.dispose(); assert.equal(page.window.count(), 0); assert.equal(page.window.fire().prevented, 0); assert.equal(page.drafts.retained().length, 0, 'ordinary disposal does not invent persistence or a removal record')
    } finally { editor.driver.dispose() }
  }
})
await check('clean pending edit save requests a native warning without cancelling or replaying the write', async () => {
  for (const result of ['success', 'unknown'] as const) {
    const page = draftSurface(), wait = deferred<unknown>(), editor = groupEditor(page, true, { wait })
    try {
      await editor.ready(); assert.equal(page.window.count(), 0); const original = editor.value(); editor.submit(); assert.equal(editor.counts().writes, 1); assert.equal(page.window.count(), 1)
      for (let i = 0; i < 2; i++) { const event = page.window.fire(); assert.equal(event.prevented, 1); assert.equal(event.returnValue, ' ') }
      assert.equal(editor.value(), original); assert.equal(editor.counts().writes, 1); assert.equal(editor.counts().closes, 0); assert.equal(editor.counts().saves, 0); assert.equal(page.prompts.length, 0)
      if (result === 'success') wait.resolve({ warnings: [], addedRegisterIds: [], deletedRegisterIds: [], deletedRuleIds: [], snapshot: editor.snapshot }); else wait.reject(Error('synthetic clean save outcome unverified'))
      await editor.ready(); assert.equal(editor.counts().writes, 1); assert.equal(editor.counts().saves, result === 'success' ? 1 : 0); assert.equal(page.window.count(), 0); assert.equal(page.window.fire().prevented, 0, 'settled request without changed input has no pending-write or unsaved-input warning')
    } finally { editor.driver.dispose() }
  }
})
await check('read-only group records take over unload risk after editor disposal and release only on explicit last discard', async () => {
  for (const editing of [false, true]) for (const pending of [false, true]) {
    const page = draftSurface(), wait = deferred<unknown>(), editor = groupEditor(page, editing, pending ? { wait } : {}); let release: undefined | (() => void)
    try {
      await editor.ready(); editor.change('RETAINED GROUP UNLOAD'); if (pending) editor.submit(); page.remove(); const records = page.drafts.retained(), frozen = JSON.stringify(records); assert.equal(records.length, 1); assert.equal(records[0].kind, 'group'); assert.equal(records[0].busy, pending)
      editor.driver.dispose(); assert.equal(page.window.count(), 0, 'unmounted editor releases only its listener'); release = page.mountUnload(); assert.equal(page.window.count(), 1); assert.equal(page.window.fire().prevented, 1)
      page.select(2); page.global('database'); assert.equal(page.window.fire().prevented, 1); assert.equal(JSON.stringify(page.drafts.retained()), frozen)
      if (pending) { wait.reject(Error('late unknown save')); await tick(); assert.equal(editor.driver.lateWrites, 0); assert.equal(editor.counts().saves, 0); assert.equal(page.window.fire().prevented, 1); assert.equal(JSON.stringify(page.drafts.retained()), frozen) }
      page.setAnswer(false); page.retentionNotice().props.onDiscard(records[0].id); assert.equal(page.drafts.retained().length, 1); assert.equal(page.window.fire().prevented, 1)
      page.setAnswer(true); page.retentionNotice().props.onDiscard(records[0].id); assert.equal(page.drafts.retained().length, 0); assert.equal(page.window.fire().prevented, 0, 'root listener reads current records even before effect cleanup'); assert.equal(page.window.count(), 1); assert.equal(editor.counts().writes, pending ? 1 : 0)
      release?.(); release = page.mountUnload(); assert.equal(page.window.count(), 0); assert.equal(page.window.fire().prevented, 0)
    } finally { release?.(); editor.driver.dispose() }
  }
})
console.log('GROUP DRAFT TEST OK: ' + passed + ' actual editor/navigation/mock-event groups for create/edit, close, pending/unknown, removal and late outcomes; page memory only, no real DOM/browser, persistence, database, network, hardware or model')
