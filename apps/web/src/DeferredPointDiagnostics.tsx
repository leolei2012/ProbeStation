import React, { useEffect, useSyncExternalStore, type ComponentProps, type ComponentType } from 'react'
import { DeferredResource, type DeferredState } from './deferred-resource'
import type { PointDiagnosticsPanel } from './PointDiagnostics'

export type PointDiagnosticsProps = ComponentProps<typeof PointDiagnosticsPanel>
export type PointDiagnosticsRenderer = ComponentType<PointDiagnosticsProps>
export const pointDiagnosticsResource = new DeferredResource<PointDiagnosticsRenderer>(async () => {
  const module = await import('./PointDiagnostics')
  if (typeof module.PointDiagnosticsPanel !== 'function') throw new Error('Invalid point diagnostics module')
  return module.PointDiagnosticsPanel
})
export function DeferredPointDiagnosticsView({ state, props, retry, onClose }: { state: DeferredState<PointDiagnosticsRenderer>; props: PointDiagnosticsProps; retry: () => void; onClose: () => void }) {
  if (state.status === 'ready' && state.value) { const Panel = state.value; return <Panel {...props} /> }
  const text = (zh: string, en: string) => props.english ? en : zh
  return <section className="point-diagnostics" aria-label={text('点表检查界面加载', 'Point-table interface loading')}>
    <p role={state.status === 'error' ? 'alert' : 'status'}>{state.status === 'error' ? text('点表检查界面加载失败，可重试加载；尚未发送本次检查请求。', 'The point-table interface could not load. Retry loading; no check request has been sent for this opening.') : text('正在加载点表检查界面，不改变采集状态。', 'Loading the point-table interface; acquisition state is unchanged.')}</p>
    <div className="toolbar"><button className="btn" type="button" onClick={onClose}>{text('返回实时数据', 'Back to live data')}</button>{state.status === 'error' && <button className="btn" type="button" onClick={retry}>{text('重试加载界面', 'Retry interface loading')}</button>}</div>
  </section>
}
export function DeferredPointDiagnostics({ resource = pointDiagnosticsResource, onClose, ...props }: PointDiagnosticsProps & { resource?: DeferredResource<PointDiagnosticsRenderer>; onClose: () => void }) {
  const state = useSyncExternalStore(resource.subscribe, resource.snapshot, resource.snapshot)
  useEffect(() => { void resource.load() }, [resource])
  return <DeferredPointDiagnosticsView state={state} props={props} onClose={onClose} retry={() => { void resource.load(true) }} />
}
