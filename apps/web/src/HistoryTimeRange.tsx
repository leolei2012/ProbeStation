import React from 'react'
import { historyTimeOffset, historyTimeText, resolveHistoryTimeRange, type HistoryInputZone, type HistoryTimeRange as TimeRange } from './history-time-range'

export function HistoryTimeRange({ range, onEdit, onZone, english = false, children }: { range: TimeRange; onEdit: (field: 'start' | 'end', text: string) => void; onZone: (zone: HistoryInputZone) => void; english?: boolean; children?: React.ReactNode }) {
  const text = (zh: string, en: string) => english ? en : zh, resolved = resolveHistoryTimeRange(range)
  return <div className="history-time-controls">
    <div className="toolbar history-range"><label className="hist-label">{text('时间输入时区', 'Time input zone')}<select value={range.zone} disabled={!resolved.fieldsValid} onChange={e => onZone(e.target.value as HistoryInputZone)}><option value="local">{text('浏览器本地', 'Browser local')}</option><option value="utc">UTC</option></select></label>
      {(['start', 'end'] as const).map(field => <label key={field} className="hist-label">{text(field === 'start' ? '开始时间' : '结束时间', field === 'start' ? 'Start time' : 'End time')}<input className="hist-input" type="datetime-local" step="0.001" value={historyTimeText(range[field], range.zone)} onChange={e => onEdit(field, e.target.value)} /><small>{historyTimeOffset(resolved[field], range.zone)}</small></label>)}
      {children}
    </div>
    <p className="chart-hint">{text('输入支持毫秒。切换时区保留绝对区间；手工本地时刻按浏览器时区解析，夏令时重复时刻请用UTC区分。“今天”按本地自然日。', 'Millisecond input. Switching zones preserves the interval. Manual local times use the browser timezone; use UTC to distinguish repeated DST times. Today uses the local calendar day.')}</p>
    {!resolved.fieldsValid && <p className="chart-hint warn" role="status">{text('请先修正无效或不存在的时间，再切换输入时区。', 'Correct invalid or nonexistent times before switching the input zone.')}</p>}
    {resolved.fieldsValid && <p className="history-utc-range" role="status">{text('完整区间（UTC）', 'Full interval (UTC)')}: <time>{new Date(resolved.start).toISOString()}</time> — <time>{new Date(resolved.end).toISOString()}</time></p>}
  </div>
}
