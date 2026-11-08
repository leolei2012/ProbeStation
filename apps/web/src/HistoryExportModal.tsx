import React, { useEffect, useId, useRef, useState } from 'react'
import { HistoryExportContextChangedError, historyExportRangeLabel, type HistoryExportRequest } from './history-export'
import { HISTORY_XLSX_POINT_LIMIT, HistoryExportLimitError } from '../../../packages/core/src/history-export-policy'
import { HistoryQueryTimeoutError, runHistoryQuery } from './history-query'

export function HistoryExportModal({ request, t, onClose, onPick, contextCurrent = true }: {
  request: HistoryExportRequest; t: (key: string) => string; onClose: () => void; onPick: (format: 'csv' | 'xlsx', signal: AbortSignal) => Promise<void>; contextCurrent?: boolean
}) {
  const titleId = useId(), hintId = useId(), cancel = useRef<HTMLButtonElement>(null)
  const controller = useRef<AbortController | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  const [invalidated, setInvalidated] = useState(false), blocked = invalidated || !contextCurrent
  const close = () => { controller.current?.abort(); onClose() }
  const download = async (format: 'csv' | 'xlsx') => {
    if (busy || blocked) return
    const current = controller.current = new AbortController()
    setBusy(true); setError(null)
    try {
      await runHistoryQuery(signal => onPick(format, signal), current.signal)
      if (!current.signal.aborted) onClose()
    } catch (e) {
      if (!current.signal.aborted) {
        if (e instanceof HistoryExportContextChangedError) setInvalidated(true)
        else setError(e instanceof HistoryExportLimitError ? t('histExportTooLarge').replace('{n}', String(e.limit)) : e instanceof HistoryQueryTimeoutError ? t('histExportTimeout') : e instanceof Error ? e.message : String(e))
      }
    } finally { if (!current.signal.aborted) setBusy(false) }
  }
  useEffect(() => { if (!contextCurrent) { setInvalidated(true); controller.current?.abort(); setBusy(false) } }, [contextCurrent])
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    cancel.current?.focus()
    return () => { controller.current?.abort(); previous?.focus() }
  }, [])
  return <div className="modal-mask">
    <div className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={hintId} onKeyDown={e => {
      if (e.key === 'Escape') { e.stopPropagation(); close() }
      if (e.key === 'Tab') {
        const buttons = e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
        const first = buttons[0], last = buttons[buttons.length - 1]
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
      }
    }}>
      <h3 id={titleId}>{t(request.scope === 'viewport' ? 'histExportViewport' : 'histExportFull')}</h3>
      <p className="history-export-range">{historyExportRangeLabel(request)}</p>
      <p>{t('histExportSelected').replace('{n}', String(request.registerIds.length))}</p>
      <div id={hintId}>
        <p className="chart-hint">{t('histExportHint')}</p>
        <p className="chart-hint">{t('histExportCapacityNote').replace('{n}', String(HISTORY_XLSX_POINT_LIMIT))}</p>
        <p className="chart-hint">{t('histExportCancellationNote')}</p>
      </div>
      <p className="chart-hint">{t('histExportDefinitionNote')}</p>
      {blocked && <p role="alert">{t('histExportContextChanged')}</p>}
      {busy && <p role="status">{t('histExportPreparing')}</p>}
      {error && <p className="hist-empty warn" role="alert">{error}</p>}
      <div className="export-options">
        <button type="button" className="btn primary" disabled={busy || blocked} onClick={() => void download('csv')}>{t('exportCsv')}</button>
        <button type="button" className="btn primary" disabled={busy || blocked} onClick={() => void download('xlsx')}>{t('exportXlsx')}</button>
      </div>
      <div className="modal-actions"><button type="button" ref={cancel} className="btn" onClick={close}>{t('cancel')}</button></div>
    </div>
  </div>
}
