import React, { useEffect, useId, useRef, useState, useSyncExternalStore, type Ref } from 'react'
import { createPortal } from 'react-dom'
import { LogCleanupFlow, logCleanupFlow, type LogCleanupState } from './log-cleanup-flow'

export function LogCleanupDialogView({ state, preview, confirm, close, english = false, closeRef }: { state: LogCleanupState; preview: () => void; confirm: () => void; close: () => void; english?: boolean; closeRef?: Ref<HTMLButtonElement> }) {
  const title = useId(), text = (zh: string, en: string) => english ? en : zh
  return <div className="modal-mask"><section className="modal" role="dialog" aria-modal="true" aria-labelledby={title} onKeyDown={event => {
    if (event.key === 'Escape') { event.stopPropagation(); close() }
    if (event.key === 'Tab') { const controls = event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'), first = controls[0], last = controls[controls.length - 1]; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() } }
  }}>
    <h3 id={title}>{text('确认清理运行日志', 'Review runtime log cleanup')}</h3>
    <p>{text('只清理下方预览范围，预览后新增日志会保留。包括近期查看器未显示的旧日志，不影响历史采样、设备配置或文件。删除无法撤销。', 'Only the reviewed range is removed; subsequent logs are kept. This includes older logs outside the recent viewer. Sample history, device settings and files are unaffected. Deletion cannot be undone.')}</p>
    {(state.phase === 'idle' || state.phase === 'previewing') && <p role="status">{text('正在预览清理范围…', 'Loading cleanup preview…')}</p>}
    {state.phase === 'preview-error' && <p role="alert">{text(state.error === 'timeout' ? '本次预览超过10秒，未发送清理请求。' : state.error === 'unsupported' ? '后端未提供安全清理接口，已阻止操作；不会回退旧接口。' : '范围读取失败，本次预览未发起清理；请核对后重读。', state.error === 'timeout' ? 'This preview exceeded 10 seconds and sent no cleanup request.' : state.error === 'unsupported' ? 'This backend does not support guarded cleanup; no legacy fallback is used.' : 'Preview failed and sent no cleanup request. Check and read again.')}</p>}
    {state.preview && <p>{text('全服务预览', 'Service-wide preview')}: <strong>{state.preview.count}</strong> {text('条，截止日志ID', 'rows through log ID')} <strong>{state.preview.throughId}</strong><br />{text('读取完成（UTC）', 'Preview received (UTC)')}: {state.previewAt}</p>}
    {state.phase === 'ready' && state.preview?.count === 0 && <p>{text('当前没有可清理日志。', 'No logs are available to clear.')}</p>}
    {state.phase === 'saving' && <p role="status">{text(state.slow ? '仍在等待清理结果，请勿重复提交。关闭窗口不会取消后端请求。' : '正在清理已确认范围，请勿重复提交。', state.slow ? 'Still awaiting the cleanup result. Do not resubmit. Closing does not cancel the backend request.' : 'Clearing the reviewed range; do not resubmit.')}</p>}
    {state.phase === 'completed' && state.result && <p role="status">{text(`已删除${state.result.deleted}条；${state.result.alreadyRemoved}条此前已移除。事务内保留${state.result.remaining}条，之后日志可能继续增加。`, `Deleted ${state.result.deleted}; ${state.result.alreadyRemoved} were already removed. ${state.result.remaining} remained in the transaction; new logs may continue to arrive.`)}</p>}
    {state.phase === 'rejected' && <p role="alert">{text(state.error === 'conflict' ? '来源或条件已变化，本次未清理。请重新预览，再决定是否清理。' : '请求被拒绝，本次未清理。请核对后重新预览。', state.error === 'conflict' ? 'The source or conditions changed; nothing was cleared. Preview again before deciding.' : 'The request was rejected; nothing was cleared. Check and preview again.')}</p>}
    {state.phase === 'uncertain' && <p role="alert">{text('清理结果未确认，可能已经执行；已阻止直接重试。可查看近期日志，或显式开始新的预览并重新确认；不会自动重放旧请求。', 'The result is uncertain and cleanup may have occurred. Direct retry is blocked. Inspect logs or explicitly start a new preview and confirm again. The old request is never replayed automatically.')}</p>}
    <div className="modal-actions"><button type="button" className="btn" ref={closeRef} onClick={close}>{text('关闭', 'Close')}</button><button type="button" className="btn" disabled={state.phase === 'previewing' || state.phase === 'saving'} onClick={preview}>{text('重新预览', 'New preview')}</button><button type="button" className="btn danger" disabled={state.phase !== 'ready' || !state.preview?.count} onClick={confirm}>{text('确认清理预览范围', 'Clear reviewed range')}</button></div>
  </section></div>
}
export function LogCleanupDialog({ onClose, english = false, flow = logCleanupFlow }: { onClose: () => void; english?: boolean; flow?: LogCleanupFlow }) {
  const state = useSyncExternalStore(flow.subscribe, flow.snapshot, flow.snapshot)
  const closeButton = useRef<HTMLButtonElement>(null), [mounted, setMounted] = useState(false)
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; setMounted(true); if (flow.snapshot().phase === 'idle') void flow.preview(); return () => { flow.closeRead(); previous?.focus() } }, [flow])
  useEffect(() => { if (mounted) closeButton.current?.focus() }, [mounted, flow])
  return mounted ? createPortal(<LogCleanupDialogView state={state} english={english} closeRef={closeButton} close={onClose} preview={() => { void flow.preview() }} confirm={() => { void flow.confirm() }} />, document.body) : null
}
