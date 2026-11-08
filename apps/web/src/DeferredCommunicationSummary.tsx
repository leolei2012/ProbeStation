import React, { useEffect, useSyncExternalStore, type ComponentType } from 'react'
import { DeferredResource, type DeferredState } from './deferred-resource'
import type { CommunicationSummaryViewProps } from './CommunicationSummaryView'

type Renderer = ComponentType<CommunicationSummaryViewProps>
export const communicationSummaryResource = new DeferredResource<Renderer>(async () => {
  const module = await import('./CommunicationSummaryView')
  if (typeof module.CommunicationSummaryView !== 'function') throw new Error('Invalid communication statistics interface')
  return module.CommunicationSummaryView
})
export function DeferredCommunicationSummaryView({ state, props, retry }: { state: DeferredState<Renderer>; props: CommunicationSummaryViewProps; retry: () => void }) {
  if (state.status === 'ready' && state.value) { const View = state.value; return <View {...props} /> }
  const text = (zh: string, en: string) => props.english ? en : zh
  return <section className="communication-summary" aria-label={text('通信统计界面加载', 'Communication statistics interface loading')}>
    <p role={state.status === 'error' ? 'alert' : 'status'}>{state.status === 'error' ? text('通信统计界面加载失败，可重试加载界面；不会重试统计读取。', 'The statistics interface could not be loaded. Retry loading it; this does not retry the statistics read.') : text('正在加载通信统计界面；只读统计请求独立进行。', 'Loading communication statistics interface; the read-only statistics request runs independently.')}</p>
    {state.status === 'error' && <button type="button" className="btn" onClick={retry}>{text('重试加载界面', 'Retry interface loading')}</button>}
  </section>
}
export function DeferredCommunicationSummary({ resource = communicationSummaryResource, ...props }: CommunicationSummaryViewProps & { resource?: DeferredResource<Renderer> }) {
  const state = useSyncExternalStore(resource.subscribe, resource.snapshot, resource.snapshot)
  useEffect(() => { void resource.load() }, [resource])
  return <DeferredCommunicationSummaryView state={state} props={props} retry={() => { void resource.load(true) }} />
}
