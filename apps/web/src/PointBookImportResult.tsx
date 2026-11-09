import React, { useEffect, useId, useRef, useState } from 'react'
import { pointBookReportKind, type PointBookReport } from './pointbook-result'

export interface PointBookResult { fileName: string; report: PointBookReport | null; error?: string; targetLabel?: string }
export function PointBookImportResult({ result, t, onDismiss }: { result: PointBookResult; t: (key: string) => string; onDismiss: () => void }) {
  const titleId = useId(), kind = pointBookReportKind(result.report)
  const errors = result.report?.errors, errorCount = (errors?.length ?? 0) + (result.error ? 1 : 0)
  const warnings = result.report?.warnings ?? []
  return <section className="pointbook-result" aria-labelledby={titleId} data-import-outcome={kind}>
    <div className="pointbook-result-head"><h4 id={titleId}>{t('pointBookReport')}</h4><button type="button" className="btn" onClick={onDismiss}>{t('dismiss')}</button></div>
    <p className="pointbook-result-file">{t('pointBookFile')}: {result.fileName}</p>
    {result.targetLabel && <p className="pointbook-result-file">{t('pointBookTargetSnapshot')}: {result.targetLabel}</p>}
    <p role={kind === 'completed' ? 'status' : 'alert'} className={warnings.length || kind !== 'completed' ? 'warn' : undefined}>{t(kind === 'completed' ? 'pointBookCompleted' : kind === 'rejected' ? 'pointBookRejected' : 'pointBookUncertain')}{warnings.length > 0 && ` · ${t('pointBookWarnings')} (${warnings.length})`}</p>
    {result.report && <p>{t('pointBookCounts').replace('{g}', String(result.report.groups)).replace('{r}', String(result.report.registers))}</p>}
    <p className={warnings.length || kind !== 'completed' ? 'warn' : undefined}>{t(kind === 'uncertain' ? 'pointBookUncertainHint' : kind === 'rejected' ? 'pointBookRejectedHint' : warnings.length ? 'pointBookWarningsHint' : 'pointBookCompletedHint')}</p>
    {errorCount > 0 && <PointBookMessages title={t('pointBookErrors')} messages={errors} extra={result.error} t={t} />}
    {warnings.length > 0 && <PointBookMessages title={t('pointBookWarnings')} messages={warnings} t={t} />}
  </section>
}

/** Page only the presentation; never truncate, filter or mutate the received messages. */
export function PointBookMessages({ title, messages, extra, t }: { title: string; messages?: readonly string[]; extra?: string; t: (key: string) => string }) {
  const headingId = useId(), listId = useId(), hintId = useId(), rangeId = useId(), inputId = useId()
  const [page, setPage] = useState(0), owner = useRef({ messages, extra })
  const count = messages?.length ?? 0, total = count + (extra ? 1 : 0), pages = Math.max(1, Math.ceil(total / 20))
  const changed = owner.current.messages !== messages || owner.current.extra !== extra, active = changed ? 0 : Math.min(page, pages - 1)
  useEffect(() => { owner.current = { messages, extra }; if (changed) setPage(0); else if (page >= pages) setPage(pages - 1) }, [messages, extra, page, pages])
  const start = active * 20, end = Math.min(start + 20, total), visible = messages?.slice(start, Math.min(end, count)) ?? []
  if (extra && count >= start && count < end) visible.push(extra)
  const jump = (value: string) => { const next = value.trim() ? Number(value) : NaN; if (Number.isSafeInteger(next) && next >= 1 && next <= pages) setPage(next - 1) }
  const range = t('pointBookMessageRange').replace('{start}', String(start + 1)).replace('{end}', String(end)).replace('{total}', String(total)).replace('{page}', String(active + 1)).replace('{pages}', String(pages))
  return <div>
    <h5 id={headingId}>{title} ({total})</h5>
    {pages > 1 && <p id={hintId}>{t('pointBookPagingHint')}</p>}
    <ul id={listId} className="pointbook-result-list" tabIndex={0} aria-labelledby={headingId} aria-describedby={pages > 1 ? hintId : undefined}>{visible.map((text, i) => <li key={start + i}>{text}</li>)}</ul>
    {pages > 1 && <nav className="pointbook-result-pages" aria-label={`${title} · ${t('pointBookPage')}`}>
      <button type="button" className="btn" aria-label={`${title} · ${t('pointBookPrevious')}`} aria-controls={listId} disabled={active === 0} onClick={() => setPage(Math.max(0, active - 1))}>{t('pointBookPrevious')}</button>
      <label htmlFor={inputId}>{title} · {t('pointBookPage')} <input id={inputId} type="number" min={1} max={pages} step={1} value={active + 1} aria-controls={listId} aria-describedby={rangeId} onChange={event => jump(event.currentTarget.value)} /></label>
      <button type="button" className="btn" aria-label={`${title} · ${t('pointBookNext')}`} aria-controls={listId} disabled={active + 1 === pages} onClick={() => setPage(Math.min(pages - 1, active + 1))}>{t('pointBookNext')}</button>
      <span id={rangeId} role="status">{range}</span>
    </nav>}
  </div>
}
