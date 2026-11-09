import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { hookDriver } from './fixtures/component-hook-driver.ts'
import { DeferredResource } from '../apps/web/src/deferred-resource.ts'
import { pickerContext } from '../apps/web/src/register-picker.ts'
import * as picker from '../apps/web/src/register-picker.ts'
import { RegisterSelectModal } from '../apps/web/src/RegisterPicker.tsx'
import { DeferredRegisterSelectModal, RegisterPickerLoading, RegisterSelectButton, registerPickerResource } from '../apps/web/src/DeferredRegisterPicker.tsx'

const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }, tick = () => new Promise<void>(done => setImmediate(done))
const groups = [{ id: 1, name: 'Mock source', slaveId: 1, registers: [{ id: 11, alias: 'mock', startAddress: 0, functionCode: 3, dataType: 'uint16' }] }]
const pickerChecks = (node: any): boolean[] => Array.isArray(node) ? node.flatMap(pickerChecks) : React.isValidElement(node) ? [...(node.type === 'input' && (node.props as any).type === 'checkbox' ? [(node.props as any).checked] : []), ...pickerChecks((node.props as any).children)] : []
let cases = 0, actions = 0
const propsFor = (english: boolean) => ({ t: (key: string) => key === 'cancel' ? english ? 'Cancel' : '取消' : key, groups: structuredClone(groups), initial: new Set([11]), max: 2, onClose() { actions++ }, onApply(_ids: Set<number>) { actions++ } })
function wrapper(resource: DeferredResource<typeof RegisterSelectModal>, initial: ReturnType<typeof propsFor>) {
  let props = initial, restores = 0, focus = 0, otherModal = false
  const body: any = {}, trigger: any = { isConnected: true, disabled: false, matches() { return this.disabled }, focus() { restores++; document.activeElement = trigger } }
  const document: any = { body, activeElement: trigger, querySelector: () => otherModal ? {} : null }
  const control = { focus() { focus++; document.activeElement = control } }, surface = { isConnected: true, querySelector: () => control }
  const driver = hookDriver('DeferredRegisterPicker.tsx', 'DeferredRegisterSelectModal', hooks => ({ DeferredResource, pickerContext, RegisterPickerLoading, registerPickerResource, document,
    useSyncExternalStore(subscribe: any, snapshot: any) { (hooks.useEffect as any)(() => subscribe(() => {}), [subscribe]); return snapshot() },
  }), { ...props, resource }, tree => { const ref = tree.ref; if (ref) ref.current = surface })
  return { driver, document, trigger, surface, get restores() { return restores }, get focus() { return focus }, setOtherModal(value: boolean) { otherModal = value }, update(next = props) { props = next; driver.render({ ...props, resource }) }, html: () => renderToStaticMarkup(driver.tree), close() { surface.isConnected = false; document.activeElement = body; driver.dispose() } }
}
async function check(name: string, run: () => void | Promise<void>) { await run(); cases++; console.log('PICKER LOADING OK: ' + name) }
await check('closed buttons and SSR perform no interface import or action', () => {
  assert.equal(registerPickerResource.snapshot().status, 'idle')
  for (const english of [false, true]) { const props = propsFor(english), html = renderToStaticMarkup(React.createElement(RegisterSelectButton, { ...props, selected: props.initial })); assert(html.includes('1/1')); assert(!html.includes('role="dialog"')) }
  assert.equal(registerPickerResource.snapshot().status, 'idle'); assert.equal(actions, 0)
  const source = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8'), watch = readFileSync(new URL('../apps/web/src/LiveWatchList.tsx', import.meta.url), 'utf8')
  assert(source.includes("import { RegisterSelectButton } from './DeferredRegisterPicker'")); assert(watch.includes('DeferredRegisterSelectModal as RegisterSelectModal'))
})
for (const english of [false, true]) {
  await check('shared code loads, frozen opening selection, close and no implicit apply/' + english, async () => {
    const code = deferred<typeof RegisterSelectModal>(); let imports = 0
    const resource = new DeferredResource(() => { imports++; return code.promise }), props = propsFor(english), first = wrapper(resource, props), second = wrapper(resource, props)
    try {
      assert(first.html().includes(english ? 'Loading point picker' : '正在加载选点界面')); await tick(); assert.equal(imports, 1)
      props.initial.add(22); first.update(); code.resolve(RegisterSelectModal); await resource.load(); first.update(); second.update()
      const actual = first.driver.one(RegisterSelectModal).props; assert.deepEqual([...actual.initial], [11]); assert.equal(actual.restoreFocus, false); assert.equal(actual.contextCurrent, true)
      assert.equal(actions, 0); actual.onApply(new Set([11])); assert.equal(actions, 1); assert.equal(first.restores, 0)
    } finally { first.close(); second.close() }
    assert.equal(first.restores, 1); assert.equal(second.restores, 1); assert.equal(first.driver.lateWrites, 0); actions = 0
  })
  await check('failed code retries only code, preserves selection and never auto retries on reopen/' + english, async () => {
    let imports = 0
    const resource = new DeferredResource(async () => { if (++imports === 1) throw Error('synthetic code failure'); return RegisterSelectModal }), props = propsFor(english), first = wrapper(resource, props)
    await resource.load(); first.update(); assert(first.html().includes(english ? 'could not be loaded' : '加载失败')); first.close()
    const second = wrapper(resource, props)
    try { await resource.load(); second.update(); assert.equal(imports, 1); second.driver.one(RegisterPickerLoading).props.retry(); await resource.load(); second.update(); assert.equal(imports, 2); assert.deepEqual([...second.driver.one(RegisterSelectModal).props.initial], [11]); assert.equal(actions, 0) } finally { second.close() }
  })
  await check('close while loading ignores late completion and reopen reuses code/' + english, async () => {
    const code = deferred<typeof RegisterSelectModal>(); let imports = 0
    const resource = new DeferredResource(() => { imports++; return code.promise }), props = propsFor(english), first = wrapper(resource, props)
    await tick(); first.driver.one(RegisterPickerLoading).props.props.onClose(); assert.equal(actions, 1); first.close(); code.resolve(RegisterSelectModal); await resource.load(); assert.equal(first.driver.lateWrites, 0)
    const second = wrapper(resource, props); try { await resource.load(); second.update(); assert.equal(imports, 1); assert(second.driver.one(RegisterSelectModal)); assert.equal(actions, 1) } finally { second.close() }; actions = 0
  })
  await check('A/B/A, maximum and current/retained callbacks cannot revive an invalid loading context/' + english, async () => {
    const code = deferred<typeof RegisterSelectModal>(), resource = new DeferredResource(() => code.promise), props = propsFor(english), model = wrapper(resource, props)
    try {
      const changed = { ...props, groups: [{ ...props.groups[0], slaveId: 2 }] }; model.update(changed); model.update(props)
      code.resolve(RegisterSelectModal); await resource.load(); model.update(); let actual = model.driver.one(RegisterSelectModal).props
      assert.equal(actual.contextCurrent, false); actual.onApply(new Set([11])); assert.equal(actions, 0); assert(model.html().includes(english ? 'Configuration or source changed' : '配置或来源已变化'))
      const retained = actual.onApply; model.update({ ...props, max: 1 }); actual = model.driver.one(RegisterSelectModal).props; retained(new Set([11])); actual.onApply(new Set([11])); assert.equal(actions, 0)
    } finally { model.close() }
  })
  await check('loading keyboard/cancel and focus ownership do not apply a selection/' + english, async () => {
    const code = deferred<typeof RegisterSelectModal>(), resource = new DeferredResource(() => code.promise), props = propsFor(english), model = wrapper(resource, props)
    try {
      const fallback = RegisterPickerLoading(model.driver.one(RegisterPickerLoading).props), section: any = (fallback.props as any).children; let prevented = 0, stopped = 0
      section.props.onKeyDown({ key: 'Escape', nativeEvent: { isComposing: true }, preventDefault() { prevented++ }, stopPropagation() { stopped++ } }); assert.equal(actions, 0)
      section.props.onKeyDown({ key: 'Escape', nativeEvent: {}, preventDefault() { prevented++ }, stopPropagation() { stopped++ } }); assert.equal(actions, 1); assert.equal(prevented, 1); assert.equal(stopped, 1)
      assert(model.focus > 0); model.trigger.disabled = true
    } finally { model.close(); code.resolve(RegisterSelectModal); await resource.load() }
    assert.equal(model.restores, 0, 'disabled/unavailable trigger cannot receive restored focus'); actions = 0
  })
}
for (const english of [false, true]) {
  await check('timeout/source switch/reopen/retry and late obsolete code retain the edited new draft/' + english, async () => {
    const oldCode = deferred<typeof RegisterSelectModal>(), newCode = deferred<typeof RegisterSelectModal>(); let imports = 0, applies = 0
    const resource = new DeferredResource(() => ++imports === 1 ? oldCode.promise : newCode.promise, 5), a = { ...propsFor(english), onClose() {}, onApply() { applies++ } }, first = wrapper(resource, a)
    let second: ReturnType<typeof wrapper> | undefined, draft: ReturnType<typeof hookDriver> | undefined
    try {
      await resource.load(); first.update(); assert(first.html().includes(english ? 'could not be loaded' : '加载失败')); first.close()
      const b = { ...a, groups: [{ ...a.groups[0], slaveId: 2, registers: [{ ...a.groups[0].registers[0], id: 22 }, { ...a.groups[0].registers[0], id: 23, startAddress: 1 }] }], initial: new Set([22]) }
      second = wrapper(resource, b); await resource.load(); second.update(); assert.equal(imports, 1)
      second.driver.one(RegisterPickerLoading).props.retry(); newCode.resolve(RegisterSelectModal); await resource.load(); second.update(); const accepted = resource.snapshot()
      draft = hookDriver('RegisterPicker.tsx', 'RegisterSelectModal', { ...picker, document: { activeElement: { focus() {} } } }, second.driver.one(RegisterSelectModal).props)
      draft.one('input', p => p.type === 'checkbox' && p.checked === false).props.onChange(); draft.render(); draft.one('input', p => p.type === 'checkbox' && p.checked === true).props.onChange(); draft.render()
      const obsolete = (() => React.createElement('div', {}, 'obsolete picker code')) as any
      oldCode.resolve(obsolete); await tick(); second.update(); draft.render(second.driver.one(RegisterSelectModal).props)
      assert.equal(resource.snapshot(), accepted); assert.equal(second.driver.one(RegisterSelectModal).type, RegisterSelectModal); assert.equal(first.driver.lateWrites, 0)
      assert.deepEqual(pickerChecks(draft.tree), [false, true], 'late code cannot reset the new source draft')
      assert.equal(applies, 0); const saved: number[][] = []; const current = second.driver.one(RegisterSelectModal).props
      draft.render({ ...current, onApply: (ids: Set<number>) => { current.onApply(ids); saved.push([...ids]) } }); draft.one('button', p => p.children === 'save').props.onClick()
      assert.deepEqual(saved, [[23]]); assert.equal(applies, 1); assert.deepEqual([...b.initial], [22]); assert.equal(imports, 2)
    } finally { draft?.dispose(); second?.close(); first.close(); oldCode.resolve(RegisterSelectModal); newCode.resolve(RegisterSelectModal); await resource.load() }
  })
  await check('actual button repeated opening retains a draft; source invalidation/cancel/reopen uses new selection/' + english, async () => {
    const resource = new DeferredResource(async () => RegisterSelectModal); await resource.load(); let applies = 0, selected = new Set([11])
    let props = { ...propsFor(english), selected, onApply(ids: Set<number>) { applies++; selected = new Set(ids) } }
    props.groups[0].registers.push({ ...props.groups[0].registers[0], id: 12, startAddress: 1 })
    const button = hookDriver('DeferredRegisterPicker.tsx', 'RegisterSelectButton', { DeferredRegisterSelectModal }, props)
    let outer: ReturnType<typeof wrapper> | undefined, draft: ReturnType<typeof hookDriver> | undefined
    try {
      const open = () => { button.one('button').props.onClick(); button.render({ ...props, selected }); return button.one(DeferredRegisterSelectModal).props }
      outer = wrapper(resource, open()); await resource.load(); outer.update()
      draft = hookDriver('RegisterPicker.tsx', 'RegisterSelectModal', { ...picker, document: { activeElement: { focus() {} } } }, outer.driver.one(RegisterSelectModal).props)
      draft.one('input', p => p.type === 'checkbox' && p.checked === false).props.onChange(); draft.render(); draft.one('input', p => p.type === 'checkbox' && p.checked === true).props.onChange(); draft.render()
      const save = draft.one('button', p => p.children === 'save').props.onClick
      outer.update(open()); draft.render(outer.driver.one(RegisterSelectModal).props); assert.equal(applies, 0); assert.deepEqual(pickerChecks(draft.tree), [false, true], 'repeat open on the mounted button preserves the edited draft')
      const original = props; props = { ...props, groups: [{ ...props.groups[0], slaveId: 2 }] }; button.render({ ...props, selected }); outer.update(button.one(DeferredRegisterSelectModal).props); draft.render(outer.driver.one(RegisterSelectModal).props)
      props = original; button.render({ ...props, selected }); outer.update(button.one(DeferredRegisterSelectModal).props); draft.render(outer.driver.one(RegisterSelectModal).props)
      await resource.load(true); outer.update(); draft.render(outer.driver.one(RegisterSelectModal).props); save(); draft.one('button', p => p.children === 'save').props.onClick(); assert.equal(applies, 0)
      draft.one('button', p => p.children === (english ? 'Cancel' : '取消')).props.onClick(); button.render({ ...props, selected }); assert.throws(() => button.one(DeferredRegisterSelectModal)); assert.deepEqual([...selected], [11]); draft.dispose(); outer.close()
      selected = new Set([22]); props = { ...props, selected, groups: [{ ...props.groups[0], slaveId: 2, registers: [{ ...props.groups[0].registers[0], id: 22 }, { ...props.groups[0].registers[0], id: 23, startAddress: 1 }] }] }
      outer = wrapper(resource, open()); await resource.load(); outer.update(); draft = hookDriver('RegisterPicker.tsx', 'RegisterSelectModal', { ...picker, document: { activeElement: { focus() {} } } }, outer.driver.one(RegisterSelectModal).props)
      assert.deepEqual([...outer.driver.one(RegisterSelectModal).props.initial], [22]); draft.one('input', p => p.type === 'checkbox' && p.checked === false).props.onChange(); draft.render(); draft.one('input', p => p.type === 'checkbox' && p.checked === true).props.onChange(); draft.render(); draft.one('button', p => p.children === 'save').props.onClick(); button.render({ ...props, selected })
      assert.equal(applies, 1); assert.deepEqual([...selected], [23]); assert.throws(() => button.one(DeferredRegisterSelectModal))
    } finally { draft?.dispose(); outer?.close(); button.dispose() }
  })
  await check('failed open invalidated before retry cannot apply; fresh reopening accepts only its own source/' + english, async () => {
    let imports = 0, applies = 0
    const resource = new DeferredResource(async () => { if (++imports === 1) throw Error('synthetic picker chunk failure'); return RegisterSelectModal }), a = { ...propsFor(english), onClose() {}, onApply() { applies++ } }, first = wrapper(resource, a)
    let second: ReturnType<typeof wrapper> | undefined
    try {
      await resource.load(); first.update(); const b = { ...a, groups: [{ ...a.groups[0], slaveId: 2, registers: [{ ...a.groups[0].registers[0], id: 22 }] }], initial: new Set([22]) }; first.update(b)
      first.driver.one(RegisterPickerLoading).props.retry(); await resource.load(); first.update(); const oldApply = first.driver.one(RegisterSelectModal).props.onApply; oldApply(new Set([11])); assert.equal(applies, 0); assert.equal(first.driver.one(RegisterSelectModal).props.contextCurrent, false)
      first.close(); second = wrapper(resource, b); await resource.load(); second.update(); oldApply(new Set([11])); assert.equal(applies, 0); const current = second.driver.one(RegisterSelectModal).props; assert.equal(current.contextCurrent, true); assert.deepEqual([...current.initial], [22]); current.onApply(new Set([22])); assert.equal(applies, 1); assert.equal(imports, 2)
    } finally { second?.close(); first.close() }
  })
}
await check('timeout ignores late code until manual retry and real module maintains compatibility', async () => {
  const late = deferred<typeof RegisterSelectModal>(); let imports = 0
  const resource = new DeferredResource(() => ++imports === 1 ? late.promise : Promise.resolve(RegisterSelectModal), 5)
  await resource.load(); assert.equal(resource.snapshot().status, 'error'); late.resolve(RegisterSelectModal); await tick(); assert.equal(resource.snapshot().status, 'error'); await resource.load(true); assert.equal(resource.snapshot().status, 'ready')
  await registerPickerResource.load(); assert.equal(registerPickerResource.snapshot().value, RegisterSelectModal)
  const legacy = await import('../apps/web/src/RegisterPicker.tsx'); assert.equal(legacy.RegisterSelectButton, RegisterSelectButton); assert.equal(actions, 0)
})
console.log(`REGISTER PICKER LOADING TEST OK: ${cases} actual wrapper/button/fallback cases, no SSR import/action, shared code, failure/manual retry/timeout, close/late result, frozen initial/context and focus ownership; mock hooks/DOM only, no API or device`)
