import React, { useId, useRef, useState } from 'react'
import { isBinType, isHexType, registerWidth } from '../../../packages/core/src/codec'
import { parsePointSettingsUpdate, type PointSettings, type PointSettingsUpdate } from './point-settings'
import { createPointEnumDraft, updatePointEnumDraft } from './point-enum-draft'
import { PointEnumEditor } from './PointEnumEditor'
export type { PointSettings } from './point-settings'

export function PointSettingsEditor({ name, address, settings, available, typeGroups, t, onClose, onSave }: {
  name: string; address: number; settings: PointSettings; available: number; typeGroups: { key: string; types: string[] }[]; t: (key: string) => string
  onClose: () => void; onSave: (value: PointSettingsUpdate) => Promise<void>
}) {
  const titleId = useId()
  const [dataType, setDataType] = useState(settings.dataType)
  const [unit, setUnit] = useState(settings.unit ?? '')
  const [factor, setFactor] = useState(String(settings.factor ?? 1))
  const [offset, setOffset] = useState(String(settings.offset ?? 0))
  const [decimalPlaces, setDecimalPlaces] = useState(settings.decimalPlaces == null ? '' : String(settings.decimalPlaces))
  const [enums, setEnums] = useState(() => createPointEnumDraft(settings.enumJson))
  const [enumIssueIndex, setEnumIssueIndex] = useState<number | null>(null)
  const [enumIssueRevision, setEnumIssueRevision] = useState(0)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const save = async () => {
    if (lock.current) return
    let next: PointSettingsUpdate
    try { next = parsePointSettingsUpdate({ dataType, unit, factor, offset, decimalPlaces }, enums, settings.dataType, available, t) }
    catch (e) { setError(e instanceof Error ? e.message : t('operationFailed')); setEnumIssueIndex(e instanceof Error && 'enumRowIndex' in e && Number.isInteger(e.enumRowIndex) ? e.enumRowIndex as number : null); setEnumIssueRevision(previous => previous + 1); return }
    lock.current = true; setBusy(true); setError(''); setEnumIssueIndex(null)
    try { await onSave(next); onClose() }
    catch (e: any) { setError(e.message || t('operationFailed')) }
    finally { lock.current = false; setBusy(false) }
  }
  return <div className="modal-mask">
    <form className="modal enum-editor point-settings-editor" role="dialog" aria-modal="true" aria-labelledby={titleId} onSubmit={e => { e.preventDefault(); void save() }}>
      <div className="modal-head"><h3 id={titleId}>{t('pointSettings')}</h3><button className="modal-close" type="button" aria-label={t('cancel')} disabled={busy} onClick={onClose}>×</button></div>
      <p className="enum-context">{name} · {t('colAddr')} {address}</p>
      <label>{t('colType')}<select autoFocus aria-label={t('colType')} value={dataType} disabled={busy} onChange={e => { setDataType(e.target.value); setError('') }}>
        {typeGroups.map(group => <optgroup key={group.key} label={t(group.key)}>{group.types.map(type => <option key={type} value={type} disabled={type !== settings.dataType && registerWidth(type) > available}>{type}</option>)}</optgroup>)}
      </select></label>
      <div className="point-semantic-fields">
        <label>{t('pointUnit')}<input aria-label={t('pointUnit')} value={unit} maxLength={64} placeholder="℃ / V / rpm" disabled={busy} onChange={e => { setUnit(e.target.value); setError('') }} /></label>
        <label>{t('pointFactor')}<input aria-label={t('pointFactor')} type="number" step="any" value={factor} disabled={busy} onChange={e => { setFactor(e.target.value); setError('') }} /></label>
        <label>{t('pointOffset')}<input aria-label={t('pointOffset')} type="number" step="any" value={offset} disabled={busy} onChange={e => { setOffset(e.target.value); setError('') }} /></label>
      </div>
      <label className="point-decimals-label">{t('pointDecimals')}<select aria-label={t('pointDecimals')} value={decimalPlaces} disabled={busy} onChange={e => setDecimalPlaces(e.target.value)}><option value="">{t('pointDecimalsAuto')}</option>{Array.from({ length: 9 }, (_, i) => <option key={i} value={i}>{i}</option>)}</select></label>
      <p className="enum-hint point-scale-note">{t('pointScaleHint')}</p>
      {factor.trim() && Number(factor) === 0 && !isHexType(dataType) && !isBinType(dataType) && <p className="chart-hint" role="note">{t('pointZeroFactorHint')}</p>}
      <h4 className="point-enum-title">{t('enumConfig')}</h4>
      <p className="enum-hint">{t('enumHint')}</p>
      <PointEnumEditor state={enums} busy={busy} issueIndex={enumIssueIndex} issueRevision={enumIssueRevision} english={t('cancel') === 'Cancel'} onAction={action => { setEnums(prev => updatePointEnumDraft(prev, action)); setError(''); setEnumIssueIndex(null) }} />
      {error && <div className="write-msg error" role="alert">{error}</div>}
      <div className="modal-actions"><button className="btn" type="button" disabled={busy} onClick={onClose}>{t('cancel')}</button><button className="btn primary" disabled={busy} type="submit">{t(busy ? 'working' : 'save')}</button></div>
    </form>
  </div>
}
