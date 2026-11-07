import React, { useEffect, useRef, useSyncExternalStore, type ComponentType } from 'react'
import { DeferredResource, type DeferredState } from './deferred-resource'
import type { SettingsModalProps } from './SettingsModal'

export type SettingsRenderer = ComponentType<SettingsModalProps>
export const settingsResource = new DeferredResource<SettingsRenderer>(async () => {
  const module = await import('./SettingsModal')
  if (typeof module.SettingsModal !== 'function') throw new Error('Invalid settings module')
  return module.SettingsModal
})
export function DeferredSettingsView({ state, props, retry }: { state: DeferredState<SettingsRenderer>; props: SettingsModalProps; retry: () => void }) {
  if (state.status === 'ready' && state.value) { const Settings = state.value; return <Settings {...props} /> }
  const english = props.lang === 'en'
  return <div className="modal-mask"><section className="modal" role="dialog" aria-modal="true" aria-label={props.t('settingsTitle')} onKeyDown={event => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); props.onClose() }
    if (event.key === 'Tab') { const controls = event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'), first = controls[0], last = controls[controls.length - 1]; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() } }
  }}><h3>{props.t('settingsTitle')}</h3><p role={state.status === 'error' ? 'alert' : 'status'}>{state.status === 'error' ? english ? 'Settings could not be loaded. Close or retry loading the interface; no settings action is retried.' : '设置界面加载失败，可以关闭或重试加载界面，不会重放任何设置操作。' : english ? 'Loading the settings interface… Acquisition continues.' : '正在加载设置界面…设备采集继续。'}</p><div className="modal-actions"><button type="button" className="btn" data-settings-close onClick={props.onClose}>{props.t('cancel')}</button>{state.status === 'error' && <button type="button" className="btn" onClick={retry}>{english ? 'Retry loading settings' : '重试加载设置'}</button>}</div></section></div>
}
export function DeferredSettingsModal({ resource = settingsResource, ...props }: SettingsModalProps & { resource?: DeferredResource<SettingsRenderer> }) {
  const state = useSyncExternalStore(resource.subscribe, resource.snapshot, resource.snapshot), root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    void resource.load()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [resource])
  useEffect(() => { root.current?.querySelector<HTMLButtonElement>('[data-settings-close]')?.focus() }, [state.status])
  return <div ref={root}><DeferredSettingsView state={state} props={props} retry={() => { void resource.load(true) }} /></div>
}
