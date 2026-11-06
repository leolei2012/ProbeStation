import React from 'react'
import { compareHistoryAnchors, type AnchorReading, type HistoryComparisonState } from './history-comparison'
import { historyVerificationLabel } from '../../../packages/core/src/history-integrity'
import { PointLabel, type PointLabelData } from './PointLabel'

export function HistoryComparison({ state, canCapture, t, pointLabels, formatTime, formatValue, onCapture, onClear, open, onOpenChange }: {
  state: HistoryComparisonState; canCapture: boolean; t: (key: string) => string; pointLabels: Map<number, PointLabelData>
  formatTime: (time: number) => string; formatValue: (id: number, value: number) => string; onCapture: (slot: 'a' | 'b') => void; onClear: () => void
  open?: boolean; onOpenChange?: (open: boolean) => void
}) {
  const rows = compareHistoryAnchors(state.a, state.b)
  const duration = (value: number | null) => value === null || !Number.isSafeInteger(value) ? '—' : (value / 1000).toFixed(3) + ' s'
  const endpoint = (reading?: AnchorReading) => <>
    <strong>{reading?.value == null ? '—' : formatValue(reading.id, reading.value)}</strong>
    <small>{reading?.time == null ? t('histCompareNoSample') : formatTime(reading.time)}</small>
    <small>{historyVerificationLabel[reading?.verification ?? 'unknown']}</small>
  </>
  return <details className="history-comparison" open={open} onToggle={event => onOpenChange?.(event.currentTarget.open)}>
    <summary>{t('histCompareTitle')}</summary>
    <p className="chart-hint">{t('histCompareHint')}</p>
    <div className="toolbar">
      <button type="button" className="btn" disabled={!canCapture} onClick={() => onCapture('a')}>{t('histCompareSetA')}</button>
      <button type="button" className="btn" disabled={!canCapture} onClick={() => onCapture('b')}>{t('histCompareSetB')}</button>
      <button type="button" className="btn" disabled={!state.a && !state.b} onClick={onClear}>{t('histCompareClear')}</button>
    </div>
    <div className="history-comparison-times" role="status"><span>A: {state.a ? formatTime(state.a.time) : '—'}</span><span>B: {state.b ? formatTime(state.b.time) : '—'}</span><span>{t('histCompareCursorDelta')}: {duration(state.a && state.b ? state.b.time - state.a.time : null)}</span></div>
    {!rows.length ? <p className="chart-hint">{t('histCompareEmpty')}</p> : <div className="history-table-scroll" tabIndex={0} aria-label={t('histCompareTitle')}><table className="reg hist-table history-comparison-table">
      <thead><tr><th>{t('histQualityPoint')}</th><th>{t('histCompareA')}</th><th>{t('histCompareB')}</th><th>{t('histCompareDifference')}</th><th>{t('histCompareSampleDelta')}</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row.id}>
        <td><PointLabel label={pointLabels.get(row.id) ?? { name: '#' + row.id, detail: '#' + row.id, qualified: false }} /></td>
        <td>{endpoint(row.a)}</td><td>{endpoint(row.b)}</td>
        <td>{row.difference === null ? '—' : formatValue(row.id, row.difference)}</td><td>{duration(row.elapsed)}</td>
      </tr>)}</tbody>
    </table></div>}
    <p className="chart-hint">{t('histCompareLimit')}</p>
  </details>
}
