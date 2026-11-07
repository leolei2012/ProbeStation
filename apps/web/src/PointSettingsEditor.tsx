import React, { useEffect, useId, useRef, useState } from 'react'
import { isBinType, isHexType, registerWidth } from '../../../packages/core/src/codec'
import { parsePointSettingsUpdate, type PointSettings, type PointSettingsUpdate } from './point-settings'
import { createPointEnumDraft, updatePointEnumDraft } from './point-enum-draft'
import { PointEnumEditor } from './PointEnumEditor'
import { pointDraftFields, pointDraftChanged, PointDraftCloseGuard, type PointCloseAction } from './point-draft-close'
import { PointDraftDiscard } from './PointDraftDiscard'
export type { PointSettings } from './point-settings'

export function PointSettingsEditor({ name, address, settings, available, typeGroups, t, onClose, onSave, guarded = false }: {
  name: string; address: number; settings: PointSettings; available: number; typeGroups: { key: string; types: string[] }[]; t: (key: string) => string
  onClose: () => void; onSave: (value: PointSettingsUpdate) => Promise<void>
  guarded?: boolean
}) {
  const titleId = useId()
  const [opening] = useState(() => pointDraftFields(settings))
  const [dataType, setDataType] = useState(opening.dataType)
  const [unit, setUnit] = useState(opening.unit)
  const [factor, setFactor] = useState(opening.factor)
  const [offset, setOffset] = useState(opening.offset)
  const [decimalPlaces, setDecimalPlaces] = useState(opening.decimalPlaces)
  const [enums, setEnums] = useState(() => createPointEnumDraft(settings.enumJson))
  const [enumIssueIndex, setEnumIssueIndex] = useState<number | null>(null)
  const [enumIssueRevision, setEnumIssueRevision] = useState(0)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const [closeGuard] = useState(() => new PointDraftCloseGuard())
  const [discarding, setDiscarding] = useState(false)
  const resumeButton = useRef<HTMLButtonElement>(null), closeTrigger = useRef<HTMLElement | null>(null)
  const restoreFocus = useRef(false)
  const dirty = pointDraftChanged(opening, { dataType, unit, factor, offset, decimalPlaces }, enums)
  const closeAction = (action: PointCloseAction) => {
    if (action === 'none') return
    setDiscarding(closeGuard.confirming)
    if (action === 'prompt') closeTrigger.current = document.activeElement as HTMLElement | null
    if (action === 'resume') restoreFocus.current = true
    if (action === 'close') onClose()
  }
  useEffect(() => { if (discarding) resumeButton.current?.focus(); else if (restoreFocus.current) { restoreFocus.current = false; if (closeTrigger.current?.isConnected) closeTrigger.current.focus() } }, [discarding])
  const requestClose = () => closeAction(closeGuard.request(dirty, lock.current))
  const save = async () => {
    if (lock.current || !closeGuard.canSave) return
    let next: PointSettingsUpdate
    try { next = parsePointSettingsUpdate({ dataType, unit, factor, offset, decimalPlaces }, enums, settings.dataType, available, t) }
    catch (e) { setError(e instanceof Error ? e.message : t('operationFailed')); setEnumIssueIndex(e instanceof Error && 'enumRowIndex' in e && Number.isInteger(e.enumRowIndex) ? e.enumRowIndex as number : null); setEnumIssueRevision(previous => previous + 1); return }
    lock.current = true; setBusy(true); setError(''); setEnumIssueIndex(null)
    try { await onSave(next); closeAction(closeGuard.saved()) }
    catch (e: any) { setError(e.message || t('operationFailed')) }
    finally { lock.current = false; setBusy(false) }
  }
  return <div className="modal-mask">
    <form className="modal enum-editor point-settings-editor" role="dialog" aria-modal="true" aria-labelledby={titleId} onSubmit={e => { e.preventDefault(); void save() }} onKeyDown={e => { if (e.key === 'Escape' && !e.nativeEvent.isComposing) { e.preventDefault(); e.stopPropagation(); if (closeGuard.confirming) closeAction(closeGuard.resume(lock.current)); else requestClose() } }}>
      <div className="modal-head"><h3 id={titleId}>{t('pointSettings')}</h3><button className="modal-close" type="button" aria-label={t('cancel')} disabled={busy || discarding} onClick={requestClose}>×</button></div>
      <p className="enum-context">{name} · {t('colAddr')} {address}</p>
      {guarded && <p className="enum-hint" role="note">{t('cancel') === 'Cancel' ? 'Saving checks the opening values and source. Conflicts are rejected and drafts kept; record your changes, close and refresh before editing again. There is no automatic overwrite.' : '保存时核对打开时的字段和来源；冲突会拒绝保存并保留草稿。请先记录修改，关闭并刷新配置后重新编辑，不会自动覆盖。'}</p>}
      <fieldset disabled={busy || discarding} className="point-draft-fields" aria-label={t('cancel') === 'Cancel' ? 'Point settings draft' : '点位设置草稿'}>
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
      </fieldset>
      {error && <div className="write-msg error" role="alert">{error}</div>}
      {discarding && <PointDraftDiscard ref={resumeButton} english={t('cancel') === 'Cancel'} busy={busy} onResume={() => closeAction(closeGuard.resume(lock.current))} onDiscard={() => closeAction(closeGuard.discard(lock.current))} />}
      <div className="modal-actions"><button className="btn" type="button" disabled={busy || discarding} onClick={requestClose}>{t('cancel')}</button><button className="btn primary" disabled={busy || discarding} type="submit">{t(busy ? 'working' : 'save')}</button></div>
    </form>
  </div>
}
