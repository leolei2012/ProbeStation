import React, { useEffect, useId, useRef } from 'react'
import { historyExportRangeLabel, type HistoryExportRequest } from './history-export'

export function HistoryExportModal({ request, t, onClose, onPick }: {
  request: HistoryExportRequest; t: (key: string) => string; onClose: () => void; onPick: (format: 'csv' | 'xlsx') => void
}) {
  const titleId = useId(), hintId = useId(), cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    cancel.current?.focus()
    return () => previous?.focus()
  }, [])
  return <div className="modal-mask">
    <div className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={hintId} onKeyDown={e => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose() }
      if (e.key === 'Tab') {
        const buttons = e.currentTarget.querySelectorAll<HTMLButtonElement>('button')
        const first = buttons[0], last = buttons[buttons.length - 1]
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
      }
    }}>
      <h3 id={titleId}>{t(request.scope === 'viewport' ? 'histExportViewport' : 'histExportFull')}</h3>
      <p className="history-export-range">{historyExportRangeLabel(request)}</p>
      <p>{t('histExportSelected').replace('{n}', String(request.registerIds.length))}</p>
      <p id={hintId} className="chart-hint">{t('histExportHint')}</p>
      <div className="export-options">
        <button type="button" className="btn primary" onClick={() => onPick('csv')}>{t('exportCsv')}</button>
        <button type="button" className="btn primary" onClick={() => onPick('xlsx')}>{t('exportXlsx')}</button>
      </div>
      <div className="modal-actions"><button type="button" ref={cancel} className="btn" onClick={onClose}>{t('cancel')}</button></div>
    </div>
  </div>
}
