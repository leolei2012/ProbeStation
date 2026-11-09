import React, { useEffect, useSyncExternalStore, type ComponentType } from 'react'
import { DeferredResource } from './deferred-resource'
import type { AlarmPendingContextProps } from './AlarmPendingContext'

export const alarmPendingResource = new DeferredResource<ComponentType<AlarmPendingContextProps>>(async () => (await import('./AlarmPendingContext')).AlarmPendingContext)
export function DeferredAlarmPendingContext({ resource = alarmPendingResource, ...props }: AlarmPendingContextProps & { resource?: typeof alarmPendingResource }) {
  const state = useSyncExternalStore(resource.subscribe, resource.snapshot, resource.snapshot)
  useEffect(() => { void resource.load() }, [resource])
  if (state.status === 'ready' && state.value) { const View = state.value; return <View {...props} /> }
  const failed = state.status === 'error'
  return <div><p role={failed ? 'alert' : 'status'}>{props.english ? failed ? 'Context view could not load. Retry loads only the interface.' : 'Loading context view…' : failed ? '核对界面加载失败，可重试；只加载界面。' : '正在加载核对界面…'}</p>{failed && <button className="btn" type="button" onClick={() => { void resource.load(true) }}>{props.english ? 'Retry interface loading' : '重试加载界面'}</button>}</div>
}
