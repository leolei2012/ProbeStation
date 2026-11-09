import React, { useId } from 'react'
import { pointBookReportKind, type PointBookReport } from './pointbook-result'

export interface PointBookResult { fileName: string; report: PointBookReport | null; error?: string; targetLabel?: string }
export function PointBookImportResult({ result, t, onDismiss }: { result: PointBookResult; t: (key: string) => string; onDismiss: () => void }) {
  const titleId = useId(), kind = pointBookReportKind(result.report)
  const errors = [...(result.report?.errors ?? []), ...(result.error ? [result.error] : [])]
  const warnings = result.report?.warnings ?? []
  return <section className="pointbook-result" aria-labelledby={titleId} data-import-outcome={kind}>
    <div className="pointbook-result-head"><h4 id={titleId}>{t('pointBookReport')}</h4><button type="button" className="btn" onClick={onDismiss}>{t('dismiss')}</button></div>
    <p className="pointbook-result-file">{t('pointBookFile')}: {result.fileName}</p>
    {result.targetLabel && <p className="pointbook-result-file">{t('pointBookTargetSnapshot')}: {result.targetLabel}</p>}
    <p role={kind === 'completed' ? 'status' : 'alert'} className={warnings.length || kind !== 'completed' ? 'warn' : undefined}>{t(kind === 'completed' ? 'pointBookCompleted' : kind === 'rejected' ? 'pointBookRejected' : 'pointBookUncertain')}{warnings.length > 0 && ` · ${t('pointBookWarnings')} (${warnings.length})`}</p>
    {result.report && <p>{t('pointBookCounts').replace('{g}', String(result.report.groups)).replace('{r}', String(result.report.registers))}</p>}
    <p className={warnings.length || kind !== 'completed' ? 'warn' : undefined}>{t(kind === 'uncertain' ? 'pointBookUncertainHint' : kind === 'rejected' ? 'pointBookRejectedHint' : warnings.length ? 'pointBookWarningsHint' : 'pointBookCompletedHint')}</p>
    {errors.length > 0 && <div><h5>{t('pointBookErrors')} ({errors.length})</h5><ul className="pointbook-result-list" tabIndex={0} aria-label={t('pointBookErrors')}>{errors.map((text, i) => <li key={i}>{text}</li>)}</ul></div>}
    {warnings.length > 0 && <div><h5>{t('pointBookWarnings')} ({warnings.length})</h5><ul className="pointbook-result-list" tabIndex={0} aria-label={t('pointBookWarnings')}>{warnings.map((text, i) => <li key={i}>{text}</li>)}</ul></div>}
  </section>
}
