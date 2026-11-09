import React, { useEffect, useRef, useState, useSyncExternalStore, type ComponentProps, type ComponentType } from 'react'
import { DeferredResource, type DeferredState } from './deferred-resource'
import { pickerContext } from './register-picker'
import type { RegisterSelectModal } from './RegisterPicker'

type PickerProps = ComponentProps<typeof RegisterSelectModal>
type Renderer = ComponentType<PickerProps>
export const registerPickerResource = new DeferredResource<Renderer>(async () => {
  const module = await import('./RegisterPicker')
  if (typeof module.RegisterSelectModal !== 'function') throw new Error('Invalid point picker')
  return module.RegisterSelectModal
})
export function RegisterPickerLoading({ state, props, retry }: { state: DeferredState<Renderer>; props: PickerProps; retry: () => void }) {
  const english = props.t('cancel') === 'Cancel'
  return <div className="modal-mask"><section className="modal" role="dialog" aria-modal="true" aria-label={props.t('selectRegisters')} onKeyDown={event => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); props.onClose() }
    if (event.key === 'Tab') { const controls = event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'), first = controls[0], last = controls[controls.length - 1]; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() } }
  }}><h3>{props.t('selectRegisters')}</h3><p role={state.status === 'error' ? 'alert' : 'status'}>{state.status === 'error' ? english ? 'Point picker could not be loaded. Retry loads only the interface; no selection is applied.' : '选点界面加载失败。重试只加载界面，不会应用选择。' : english ? 'Loading point picker…' : '正在加载选点界面…'}</p><div className="modal-actions"><button type="button" className="btn" data-picker-loading-close onClick={props.onClose}>{props.t('cancel')}</button>{state.status === 'error' && <button type="button" className="btn" onClick={retry}>{english ? 'Retry loading picker' : '重试加载选点'}</button>}</div></section></div>
}
export function DeferredRegisterSelectModal({ resource = registerPickerResource, ...props }: PickerProps & { resource?: DeferredResource<Renderer> }) {
  const state = useSyncExternalStore(resource.subscribe, resource.snapshot, resource.snapshot), root = useRef<HTMLDivElement>(null)
  const [openingContext] = useState(() => pickerContext(props.groups, props.deviceSlaveId, props.max)), [initial] = useState(() => new Set(props.initial)), invalidated = useRef(false)
  if (pickerContext(props.groups, props.deviceSlaveId, props.max) !== openingContext) invalidated.current = true
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null, surface = root.current
    void resource.load()
    return () => { if (surface && !surface.isConnected && previous?.isConnected && !previous.matches(':disabled') && document.activeElement === document.body && !document.querySelector('[aria-modal="true"]')) previous.focus() }
  }, [resource])
  useEffect(() => { root.current?.querySelector<HTMLElement>(state.status === 'ready' ? 'input:not(:disabled), button:not(:disabled)' : '[data-picker-loading-close]')?.focus() }, [state.status])
  if (state.status === 'ready' && state.value) {
    const Picker = state.value
    return <div ref={root}><Picker {...props} initial={initial} restoreFocus={false} openingContext={openingContext} contextCurrent={!invalidated.current} onApply={ids => { if (!invalidated.current) props.onApply(ids) }} /></div>
  }
  return <div ref={root}><RegisterPickerLoading state={state} props={props} retry={() => { void resource.load(true) }} /></div>
}
export function RegisterSelectButton({ t, groups, selected, onApply, max, deviceSlaveId }: Omit<PickerProps, 'initial' | 'onClose'> & { selected: Set<number> }) {
  const [show, setShow] = useState(false), total = groups.reduce((n, g) => n + g.registers.length, 0)
  return <><button className="btn reg-picker-trigger" onClick={() => setShow(true)}>{t('selectRegisters')} <span>{selected.size}/{total}</span></button>{show && <DeferredRegisterSelectModal t={t} groups={groups} max={max} deviceSlaveId={deviceSlaveId} initial={selected} onClose={() => setShow(false)} onApply={ids => { onApply(ids); setShow(false) }} />}</>
}
