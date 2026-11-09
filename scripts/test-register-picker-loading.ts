import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { hookDriver } from './fixtures/component-hook-driver.ts'
import { DeferredResource } from '../apps/web/src/deferred-resource.ts'
import { pickerContext } from '../apps/web/src/register-picker.ts'
import { RegisterSelectModal } from '../apps/web/src/RegisterPicker.tsx'
import { DeferredRegisterSelectModal, RegisterPickerLoading, RegisterSelectButton, registerPickerResource } from '../apps/web/src/DeferredRegisterPicker.tsx'

const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }, tick = () => new Promise<void>(done => setImmediate(done))
const groups = [{ id: 1, name: 'Mock source', slaveId: 1, registers: [{ id: 11, alias: 'mock', startAddress: 0, functionCode: 3, dataType: 'uint16' }] }]
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
await check('timeout ignores late code until manual retry and real module maintains compatibility', async () => {
  const late = deferred<typeof RegisterSelectModal>(); let imports = 0
  const resource = new DeferredResource(() => ++imports === 1 ? late.promise : Promise.resolve(RegisterSelectModal), 5)
  await resource.load(); assert.equal(resource.snapshot().status, 'error'); late.resolve(RegisterSelectModal); await tick(); assert.equal(resource.snapshot().status, 'error'); await resource.load(true); assert.equal(resource.snapshot().status, 'ready')
  await registerPickerResource.load(); assert.equal(registerPickerResource.snapshot().value, RegisterSelectModal)
  const legacy = await import('../apps/web/src/RegisterPicker.tsx'); assert.equal(legacy.RegisterSelectButton, RegisterSelectButton); assert.equal(actions, 0)
})
console.log(`REGISTER PICKER LOADING TEST OK: ${cases} actual wrapper/button/fallback cases, no SSR import/action, shared code, failure/manual retry/timeout, close/late result, frozen initial/context and focus ownership; mock hooks/DOM only, no API or device`)
