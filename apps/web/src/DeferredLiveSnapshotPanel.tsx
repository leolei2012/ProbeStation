import React, { useEffect, useSyncExternalStore, type ComponentProps, type ComponentType } from 'react'
import { DeferredResource, type DeferredState } from './deferred-resource'
import type { LiveSnapshotPanel } from './LiveSnapshotPanel'

type Props = ComponentProps<typeof LiveSnapshotPanel>
type Renderer = ComponentType<Props>
export const liveSnapshotPanelResource = new DeferredResource<Renderer>(async () => {
  const module = await import('./LiveSnapshotPanel')
  if (typeof module.LiveSnapshotPanel !== 'function') throw new Error('Invalid frozen snapshot interface')
  return module.LiveSnapshotPanel
})

export function DeferredLiveSnapshotPanelView({ state, props, retry }: { state: DeferredState<Renderer>; props: Props; retry: () => void }) {
  if (state.status === 'ready' && state.value) { const Panel = state.value; return <Panel {...props} /> }
  const text = (zh: string, en: string) => props.english ? en : zh
  return <section className="live-snapshot" aria-label={text('冻结快照界面加载', 'Frozen snapshot interface loading')}>
    <div className="toolbar"><strong>{text('已冻结本页观测', 'Page observation frozen')}</strong><button className="btn" type="button" onClick={props.close}>{text('关闭预览', 'Close preview')}</button></div>
    <p>{text('冻结UTC', 'Frozen UTC')}: {props.snapshot.capturedAt}</p>
    <p role={state.status === 'error' ? 'alert' : 'status'}>{state.status === 'error'
      ? text('冻结快照预览界面加载失败；本页仍保留本次快照。重试仅加载界面，不会重新冻结、读取或下载。', 'The frozen snapshot interface could not be loaded; this snapshot remains in page memory. Retry loads only the interface, without freezing again, reading or downloading.')
      : text('正在加载冻结快照预览；显示本次已冻结的数据，不随新读数变化。', 'Loading the frozen snapshot preview; it uses this captured data and does not follow new readings.')}</p>
    {state.status === 'error' && <button className="btn" type="button" onClick={retry}>{text('重试加载预览', 'Retry preview loading')}</button>}
  </section>
}

export function DeferredLiveSnapshotPanel({ resource = liveSnapshotPanelResource, ...props }: Props & { resource?: DeferredResource<Renderer> }) {
  const state = useSyncExternalStore(resource.subscribe, resource.snapshot, resource.snapshot)
  useEffect(() => { void resource.load() }, [resource])
  return <DeferredLiveSnapshotPanelView state={state} props={props} retry={() => { void resource.load(true) }} />
}
