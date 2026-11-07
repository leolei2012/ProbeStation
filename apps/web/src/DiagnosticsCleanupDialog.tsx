import React, { useEffect, useId, useRef, useState, useSyncExternalStore, type Ref } from 'react'
import { createPortal } from 'react-dom'
import { diagnosticsCleanupTarget, type DiagnosticsCleanupTarget, type DiagnosticsCleanupResult } from '../../../packages/core/src/diagnostics-cleanup'
import { DiagnosticsCleanupFlow, diagnosticsCleanupFlow, type DiagnosticsCleanupState } from './diagnostics-cleanup-flow'

export function DiagnosticsCleanupDialogView({ state, wanted, preview, confirm, close, english = false, closeRef, blocked = false }: { state: DiagnosticsCleanupState; wanted: DiagnosticsCleanupTarget | null; preview: () => void; confirm: () => void; close: () => void; english?: boolean; closeRef?: Ref<HTMLButtonElement>; blocked?: boolean }) {
  const title = useId(), text = (zh: string, en: string) => english ? en : zh, same = !!wanted && state.preview?.targetKey === wanted.targetKey
  return <div className="modal-mask"><section className="modal" role="dialog" aria-modal="true" aria-labelledby={title} onKeyDown={event => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); close() }
    if (event.key === 'Tab') { const controls = event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'), first = controls[0], last = controls[controls.length - 1]; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() } }
  }}>
    <h3 id={title}>{text('确认清空通信诊断', 'Review communication diagnostic clearing')}</h3>
    <p>{text('清空确认执行时目标内存中的全部捕获和通信计数，包括预览后新增记录，无法撤销；不是只删当前显示的帧。不删除采样历史、设备配置或文件，不停止采集，新记录可能立即出现。', 'Clears all target memory captures and communication counters at execution, including captures arriving after preview. This cannot be undone and is not limited to visible rows. Sample history, settings and files are unaffected. Acquisition continues and new captures may appear immediately.')}</p>
    <p>{text('预览或重新预览不执行清空，也不判定此前未知请求的结果。', 'Previewing never clears data or establishes the outcome of an earlier uncertain request.')}</p>
    {!wanted && <p role="alert">{text('当前页面的设备来源无法核实，不能确认清空。', 'The current page target cannot be verified; confirmation is disabled.')}</p>}
    {blocked && <p>{text('页面读取已暂停：可查看此前状态，恢复后才能新预览或确认；已发送的清空仍会继续。', 'Page reads are paused: prior status remains visible. Resume before a new preview or confirmation; an already-sent clear continues.')}</p>}
    {state.phase === 'previewing' && <p role="status">{text('正在预览目标，没有发送清空请求…', 'Reading target preview; no clear request has been sent…')}</p>}
    {state.phase === 'preview-error' && <p role="alert">{text(state.error === 'timeout' ? '预览超过10秒，未发起清空。' : '当前后端/目标无法提供安全预览，未发起清空，不回退旧接口。', state.error === 'timeout' ? 'Preview exceeded 10 seconds; no clear was requested.' : 'Guarded preview is unavailable; no clear was requested and no legacy fallback is used.')}</p>}
    {state.preview && <><p><strong>{state.preview.deviceName || '#' + state.preview.objectId}</strong> · #{state.preview.objectId}<br /><code style={{ overflowWrap: 'anywhere' }}>{state.preview.label}</code></p>
      <p role={state.preview.scope === 'channel' ? 'alert' : 'note'}>{state.preview.scope === 'channel' ? text('共享RTU串口：将同时清空此通道其他设备/从站的捕获与统计。', 'Shared RTU serial channel: captures and counters for other devices/slaves on this channel are cleared too.') : text('目标为此设备ID的诊断缓存，可能包含此前连接的累计记录。', 'Targets this device ID’s diagnostic cache, which may include earlier connections.')}</p>
      <p>{text('预览缓冲记录 / 完成成功 / 完成失败', 'Preview captures / successful / failed requests')}: {state.preview.bufferedFrames} / {state.preview.successCount} / {state.preview.errorCount}<br />{text('条件到期UTC', 'Condition expires at UTC')}: {state.preview.expiresAt}</p>
      {!same && <p role="alert">{text('下方对象与当前页面配置不同，不能确认；请核对配置并为当前设备重新预览。', 'This operation target differs from the current page configuration. Verify settings and preview this device again before confirming.')}</p>}</>}
    {state.phase === 'saving' && <p role="status">{text(state.slow ? '仍在等待结果，请勿重复提交；关闭不会取消清空请求。' : '正在清空已确认对象，请勿重复提交；关闭不会取消请求。', state.slow ? 'Still awaiting the result; do not resubmit. Closing does not cancel clearing.' : 'Clearing the confirmed target; do not resubmit. Closing does not cancel it.')}</p>}
    {state.phase === 'completed' && state.result && <p role="status">{text(`后台已确认清空当时${state.result.clearedFrames}条捕获，并重置${state.result.clearedRequests}次请求的统计。新捕获可能已出现。`, `Backend confirmed clearing ${state.result.clearedFrames} captures and resetting counters for ${state.result.clearedRequests} requests at execution. New captures may already exist.`)}<br />{state.result.completedAt} UTC</p>}
    {state.phase === 'rejected' && <p role="alert">{text('本次请求被拒绝，未追加执行清空。请核对目标后重新预览；这不判定更早未知操作是否执行。', 'This request was refused without an additional clear. Verify the target and preview again; this does not resolve any earlier uncertain operation.')}</p>}
    {state.phase === 'uncertain' && <p role="alert">{text('结果未确认，可能已经清空；不能直接重试。关闭/重开仍保留此状态。需要再次清空时，明确重新预览并重新确认；不会重放旧请求。', 'The result is uncertain and clearing may have occurred. Direct retry is blocked and this page retains the state across closing/reopening. Any further clear needs an explicit new preview and confirmation; the old request is never replayed.')}</p>}
    <div className="modal-actions"><button type="button" className="btn" ref={closeRef} onClick={close}>{text('关闭', 'Close')}</button><button type="button" className="btn" disabled={blocked || !wanted || state.phase === 'previewing' || state.phase === 'saving'} onClick={preview}>{text('为当前设备重新预览', 'New preview for this device')}</button><button type="button" className="btn danger" disabled={blocked || state.phase !== 'ready' || !same} onClick={confirm}>{text('确认清空全部目标诊断', 'Clear all target diagnostics')}</button></div>
  </section></div>
}
export function DiagnosticsCleanupButton({ device, disabled = false, english = false, onCleared, flow = diagnosticsCleanupFlow }: { device: Parameters<typeof diagnosticsCleanupTarget>[0]; disabled?: boolean; english?: boolean; onCleared: (result: DiagnosticsCleanupResult) => void; flow?: DiagnosticsCleanupFlow }) {
  const [open, setOpen] = useState(false), [mounted, setMounted] = useState(false), state = useSyncExternalStore(flow.subscribe, flow.snapshot, flow.snapshot), button = useRef<HTMLButtonElement>(null), priorFocus = useRef<HTMLElement | null>(null)
  let wanted: DiagnosticsCleanupTarget | null = null
  try { wanted = diagnosticsCleanupTarget(device) } catch {}
  const latest = useRef(onCleared); latest.current = onCleared
  const seen = useRef(state.result?.token)
  useEffect(() => { if (state.phase === 'completed' && state.result && seen.current !== state.result.token) { seen.current = state.result.token; if (state.result.targetKey === wanted?.targetKey) latest.current(state.result) } }, [state, wanted?.targetKey])
  useEffect(() => { setMounted(true) }, [])
  useEffect(() => { if (!open) return; priorFocus.current = document.activeElement as HTMLElement | null; if (!disabled && flow.snapshot().phase === 'idle' && wanted) void flow.preview(wanted.objectId); return () => { flow.closeRead(); if (priorFocus.current?.isConnected) priorFocus.current.focus() } }, [open, flow])
  useEffect(() => { if (open && mounted) button.current?.focus() }, [open, mounted])
  return <><button type="button" className="btn" onClick={() => setOpen(true)}>{english ? 'Review diagnostic clearing' : '预览清空诊断'}</button>{open && mounted && createPortal(<DiagnosticsCleanupDialogView state={state} wanted={wanted} blocked={disabled} english={english} closeRef={button} close={() => setOpen(false)} preview={() => { if (!disabled && wanted) void flow.preview(wanted.objectId) }} confirm={() => { if (!disabled && wanted) void flow.confirm(wanted.targetKey) }} />, document.body)}</>
}
