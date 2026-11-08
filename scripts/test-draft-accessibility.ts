import assert from 'node:assert/strict'
import { draftEditor, draftSurface } from './fixtures/draft-navigation-driver.ts'
import { draftFocusModel, focusDocument } from './fixtures/draft-focus-model.ts'
import { bindDialogReturnFocus, restoreDialogFocus } from '../apps/web/src/dialog-focus.ts'

let passed = 0
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
function opener(document: ReturnType<typeof focusDocument>) {
  return { ownerDocument: document, isConnected: true, disabled: false, inheritedDisabled: false,
    matches(selector: string) { assert.equal(selector, ':disabled'); return this.disabled || this.inheritedDisabled },
    focus() { if (this.isConnected && !this.matches(':disabled')) document.activeElement = this },
  }
}
async function check(name: string, fn: () => void | Promise<void>) { if (process.argv[2] && !name.startsWith(process.argv[2])) return; await fn(); passed++; console.log('DRAFT ACCESSIBILITY OK: ' + name) }
await check('complete close restores the still-usable opening button after clean Escape, discard and successful save', async () => {
  for (const kind of ['point', 'device'] as const) for (const action of ['clean', 'discard', 'save'] as const) {
    const model = draftFocusModel(), trigger = opener(model.document); trigger.focus()
    let parentClosed = false
    const save = kind === 'device' ? draftSurface().deviceSaveHandler(async () => {}, () => { parentClosed = true }) : undefined
    const editor = draftEditor(kind, undefined, save, null, undefined, undefined, model)
    try {
      model.field(kind === 'point' ? 'pointUnit' : 'name').focus()
      if (action !== 'clean') editor.change()
      if (action === 'save') { editor.submit(); await tick(); editor.driver.render() }
      else { model.key(editor, 'Escape'); if (action === 'discard') editor.discard() }
      assert.equal(editor.calls.close, action === 'save' && kind === 'device' ? 0 : 1, `${kind}/${action}: child close contract`)
      assert.equal(parentClosed, action === 'save' && kind === 'device'); assert.equal(editor.calls.save, action === 'save' ? 1 : 0)
      model.commit(null); editor.driver.dispose()
      assert(model.document.activeElement === trigger, `${kind}/${action}: complete close must restore the opening button`)
    } finally { editor.driver.dispose() }
  }
})
await check('complete close skips removed, own-disabled, inherited-disabled and foreign-document opening buttons', () => {
  for (const kind of ['point', 'device'] as const) for (const state of ['removed', 'disabled', 'fieldset', 'foreign'] as const) {
    const model = draftFocusModel(), trigger = opener(model.document); trigger.focus()
    const editor = draftEditor(kind, undefined, undefined, null, undefined, undefined, model)
    try {
      model.field(kind === 'point' ? 'pointUnit' : 'name').focus(); editor.close()
      if (state === 'removed') trigger.isConnected = false
      if (state === 'disabled') trigger.disabled = true
      if (state === 'fieldset') trigger.inheritedDisabled = true
      if (state === 'foreign') trigger.ownerDocument = focusDocument()
      model.commit(null); editor.driver.dispose()
      assert(model.document.activeElement === model.document.body, 'unusable opener must not receive focus; no substitute is guessed')
    } finally { editor.driver.dispose() }
  }
})
await check('unmount does not steal existing focus or another modal and connected effect cleanup does not act as a close', () => {
  const document = focusDocument(), model = draftFocusModel(document), trigger = opener(document); trigger.focus()
  const editor = draftEditor('point', undefined, undefined, null, undefined, undefined, model)
  const cleanup = bindDialogReturnFocus(model.form, trigger as unknown as HTMLElement)
  model.field('pointUnit').focus(); const inside = document.activeElement
  cleanup(); assert(document.activeElement === inside, 'effect cleanup while still mounted must not restore focus')
  const other = opener(document); other.focus(); model.commit(null); editor.driver.dispose()
  assert(document.activeElement === other, 'user/new view focus wins')
  document.activeElement = document.body
  const nextModel = draftFocusModel(document), next = draftEditor('device', undefined, undefined, null, undefined, undefined, nextModel)
  document.activeElement = document.body // Model a mounted dialog whose focus has not yet been placed.
  cleanup(); assert(document.activeElement === document.body, 'even an unfocused open modal must prevent background return')
  nextModel.commit(null); next.driver.dispose()
  bindDialogReturnFocus(null, trigger as unknown as HTMLElement)(); assert(document.activeElement === document.body, 'missing form is a no-op')
})
await check('new-device save may unmount in its parent before resolving without missing return focus or retrying the write', async () => {
  const model = draftFocusModel(), trigger = opener(model.document); trigger.focus()
  let editor!: ReturnType<typeof draftEditor>
  editor = draftEditor('device', undefined, async () => { model.commit(null); editor.driver.dispose() }, null, undefined, null, model)
  editor.change('SYNTHETIC NEW DEVICE'); editor.submit(false); await tick()
  assert.equal(editor.calls.save, 1); assert.equal(editor.calls.close, 0, 'device save closure remains parent-controlled')
  assert(model.document.activeElement === trigger, 'parent-led unmount during a successful save returns to the same opening button')
})
await check('Tab and Shift-Tab stay inside either actual editor at its boundaries', () => {
  for (const kind of ['point', 'device'] as const) {
    const model = draftFocusModel(), editor = draftEditor(kind, undefined, undefined, null, undefined, undefined, model)
    try {
      const items = model.form.querySelectorAll('button:enabled,input:enabled,select:enabled')
      items.at(-1).focus(); assert(model.key(editor, 'Tab').defaultPrevented, 'last control must wrap inside the modal'); assert(model.document.activeElement === items[0], 'Tab returns to first control')
      assert(model.key(editor, 'Tab', true).defaultPrevented); assert(model.document.activeElement === items.at(-1), 'Shift-Tab returns to last control')
      model.field(kind === 'point' ? 'pointUnit' : 'name').focus(); assert(!model.key(editor, 'Tab').defaultPrevented, 'middle Tab keeps native ordering')
    } finally { editor.driver.dispose() }
  }
})
await check('resume after observed removal cannot restore focus to an inherited-disabled field', async () => {
  for (const kind of ['point', 'device'] as const) {
    const page = draftSurface(), model = draftFocusModel(), editor = draftEditor(kind, page.registration(), undefined, null, undefined, undefined, model)
    try {
      editor.change(); const field = model.field(kind === 'point' ? 'pointUnit' : 'name'); field.focus(); model.key(editor, 'Escape')
      assert(model.document.activeElement === model.button('继续编辑'), 'confirmation focuses continue editing'); page.remove(); editor.driver.render()
      editor.resume(); assert.equal(field.disabled, false, 'disabled state is inherited from fieldset'); assert(field.matches(':disabled'))
      assert(model.document.activeElement === model.close(), 'fallback focus must remain in the modal after prompt removal')
      editor.submit(); assert.equal(editor.calls.save, 0); assert.equal(page.drafts.retained().length, 1)
    } finally { editor.driver.dispose() }
  }
})
await check('pending saves focus the dialog itself and keep Tab/Escape from escaping or cancelling the request', async () => {
  for (const kind of ['point', 'device'] as const) {
    let reject!: (error: Error) => void; const wait = new Promise<void>((_resolve, no) => { reject = no })
    const model = draftFocusModel(), editor = draftEditor(kind, undefined, () => wait, null, undefined, undefined, model)
    try {
      editor.change('PENDING INPUT'); model.form.querySelectorAll('button:enabled').at(-1).focus(); editor.submit()
      assert(model.document.activeElement === model.form, 'busy dialog must have a focusable fallback when all controls disable'); assert.equal(model.form.props.tabIndex, -1)
      assert(model.key(editor, 'Tab').defaultPrevented); assert(model.document.activeElement === model.form)
      const escape = model.key(editor, 'Escape'); assert(escape.defaultPrevented && escape.stopped); assert.equal(editor.calls.close, 0); assert.equal(editor.calls.save, 1)
      reject(Error('synthetic unknown save result')); await tick(); editor.driver.render()
      assert(model.key(editor, 'Tab', true).defaultPrevented); assert(model.document.activeElement === model.form.querySelectorAll('button:enabled').at(-1))
      assert.equal(editor.value(), 'PENDING INPUT'); assert.equal(editor.calls.save, 1)
    } finally { reject(Error('cleanup')); await tick(); editor.driver.dispose() }
  }
})
await check('two confirmations keep independent state, Escape resumes only its owner, and bilingual text preserves uncertain-save meaning', () => {
  for (const english of [false, true]) {
    const page = draftSurface({ english }), document = focusDocument(), pointModel = draftFocusModel(document), deviceModel = draftFocusModel(document)
    const point = draftEditor('point', page.registration(), undefined, null, undefined, undefined, { ...pointModel, english }), device = draftEditor('device', page.registration(), undefined, null, undefined, undefined, { ...deviceModel, english })
    try {
      point.change('POINT INPUT'); device.change('DEVICE INPUT'); pointModel.field('pointUnit').focus()
      assert(!pointModel.key(point, 'Escape', false, true).defaultPrevented); assert(!pointModel.confirmation(), 'IME Escape does not close or prompt')
      pointModel.key(point, 'Escape'); const label = english ? 'Continue editing' : '继续编辑'
      assert(document.activeElement === pointModel.button(label)); assert(pointModel.confirmationText().includes(english ? 'an earlier save may still have taken effect' : '不能据此判断此前保存结果'))
      assert(pointModel.confirmationText().includes(english ? 'Escape continues editing' : 'Esc继续编辑'))
      device.close(); assert(deviceModel.confirmation()); assert(pointModel.confirmation())
      assert(deviceModel.confirmation().props['aria-label'] === (english ? 'Device draft close confirmation' : '确认关闭设备草稿'))
      const before = page.state(); page.global('database'); assert.deepEqual(page.state(), before); assert.equal(page.prompts.length, 1)
      deviceModel.key(device, 'Escape'); assert(!deviceModel.confirmation()); assert(pointModel.confirmation())
      assert(document.activeElement === deviceModel.close(), 'foreign trigger cannot steal restoration to the other confirmation')
      pointModel.button(label).focus(); pointModel.key(point, 'Escape'); assert(!pointModel.confirmation()); assert(document.activeElement === pointModel.field('pointUnit'))
      assert.equal(point.value(), 'POINT INPUT'); assert.equal(device.value(), 'DEVICE INPUT'); assert.equal(point.calls.save + device.calls.save + point.calls.close + device.calls.close, 0)
    } finally { point.driver.dispose(); device.driver.dispose() }
  }
})
await check('handled keys and browser tab shortcuts retain ownership; stale/outside restoration falls back inside', () => {
  for (const kind of ['point', 'device'] as const) {
    const model = draftFocusModel(), editor = draftEditor(kind, undefined, undefined, null, undefined, undefined, model)
    try {
      const last = model.form.querySelectorAll('button:enabled').at(-1); last.focus()
      model.key(editor, 'Tab', false, false, true); assert(model.document.activeElement === last, 'already handled child key is not wrapped again')
      for (const modifiers of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }]) { assert(!model.key(editor, 'Tab', false, false, false, modifiers).defaultPrevented); assert(model.document.activeElement === last) }
      restoreDialogFocus(model.form, model.document.body); assert(model.document.activeElement === model.close(), 'outside element is not a valid restore target')
      last.focus(); restoreDialogFocus(model.form, { isConnected: false } as HTMLElement); assert(model.document.activeElement === model.close())
      restoreDialogFocus(null, model.document.body); assert(model.document.activeElement === model.close())
    } finally { editor.driver.dispose() }
  }
})
assert(passed > 0)
console.log('DRAFT ACCESSIBILITY TEST OK: ' + passed + ' actual callbacks with a limited focus model, not native DOM/keyboard/screen-reader validation')
