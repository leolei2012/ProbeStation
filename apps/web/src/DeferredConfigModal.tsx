import React, { useEffect, useRef, useSyncExternalStore, type ComponentProps, type ComponentType } from 'react'
import { DeferredResource, type DeferredState } from './deferred-resource'
import type { DeviceModal } from './DeviceModal'
import type { GroupModal } from './GroupModal'

type DeviceProps = ComponentProps<typeof DeviceModal>
type GroupProps = ComponentProps<typeof GroupModal>
type Renderer<P> = ComponentType<P>
export const deviceModalResource = new DeferredResource<Renderer<DeviceProps>>(async () => {
  const module = await import('./DeviceModal')
  if (typeof module.DeviceModal !== 'function') throw new Error('Invalid device editor')
  return module.DeviceModal
})
export const groupModalResource = new DeferredResource<Renderer<GroupProps>>(async () => {
  const module = await import('./GroupModal')
  if (typeof module.GroupModal !== 'function') throw new Error('Invalid group editor')
  return module.GroupModal
})

export function ConfigModalLoading({ state, t, title, close, retry }: { state: DeferredState<unknown>; t: (key: string) => string; title: string; close: () => void; retry: () => void }) {
  const english = t('cancel') === 'Cancel'
  return <div className="modal-mask"><section className="modal" role="dialog" aria-modal="true" aria-label={title} onKeyDown={event => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); close() }
    if (event.key === 'Tab') { const controls = event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'), first = controls[0], last = controls[controls.length - 1]; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() } }
  }}><h3>{title}</h3><p role={state.status === 'error' ? 'alert' : 'status'}>{state.status === 'error' ? english ? 'Editor could not be loaded. Retry loads only the interface; no configuration write is retried.' : '编辑界面加载失败。重试仅加载界面，不会重试配置写入。' : english ? 'Loading editor… No configuration write has been requested by this dialog.' : '正在加载编辑界面…此窗口尚未发起配置写入。'}</p><div className="modal-actions"><button type="button" className="btn" data-config-loading-close onClick={close}>{t('cancel')}</button>{state.status === 'error' && <button type="button" className="btn" onClick={retry}>{english ? 'Retry loading editor' : '重试加载界面'}</button>}</div></section></div>
}

export function DeferredConfigModal<P extends { t: (key: string) => string; onClose: () => void }>({ resource, props, title }: { resource: DeferredResource<Renderer<P>>; props: P; title: string }) {
  const state = useSyncExternalStore(resource.subscribe, resource.snapshot, resource.snapshot), root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const surface = root.current
    void resource.load()
    return () => { if (surface && !surface.isConnected && previous?.isConnected && !previous.matches(':disabled') && document.activeElement === document.body && !document.querySelector('[aria-modal="true"]')) previous.focus() }
  }, [resource])
  useEffect(() => { if (state.status !== 'ready') root.current?.querySelector<HTMLButtonElement>('[data-config-loading-close]')?.focus() }, [state.status])
  if (state.status === 'ready' && state.value) { const Modal = state.value; return <div ref={root}><Modal {...props} /></div> }
  return <div ref={root}><ConfigModalLoading state={state} t={props.t} title={title} close={props.onClose} retry={() => { void resource.load(true) }} /></div>
}
export function DeferredDeviceModal({ resource = deviceModalResource, ...props }: DeviceProps & { resource?: DeferredResource<Renderer<DeviceProps>> }) {
  return <DeferredConfigModal resource={resource} props={props} title={props.t(props.initial ? 'editDeviceTitle' : 'newDeviceTitle')} />
}
export function DeferredGroupModal({ resource = groupModalResource, ...props }: GroupProps & { resource?: DeferredResource<Renderer<GroupProps>> }) {
  return <DeferredConfigModal resource={resource} props={props} title={props.t(props.initial ? 'editGroup' : 'newGroup')} />
}
