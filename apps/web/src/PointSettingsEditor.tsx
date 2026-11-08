import type { DraftRegistration } from './draft-navigation'
import { DetachedEditorNotice, ConfigurationSaveHint } from './RetainedDraftNotice'
import { bindBeforeUnload } from './before-unload'
import { useDraftDialogFocus, draftDialogKey } from './dialog-focus'
import React, { useEffect, useId, useRef, useState } from 'react'
import { isBinType, isHexType, registerWidth } from '../../../packages/core/src/codec'
import { parsePointSettingsUpdate, type PointSettings, type PointSettingsUpdate } from './point-settings'
import { createPointEnumDraft, updatePointEnumDraft } from './point-enum-draft'
import { PointEnumEditor } from './PointEnumEditor'
import { pointDraftFields, pointDraftChanged, PointDraftCloseGuard, type PointCloseAction } from './point-draft-close'
import { PointDraftDiscard } from './PointDraftDiscard'
export type { PointSettings } from './point-settings'

export function PointSettingsEditor({ name, address, settings, available, typeGroups, t, onClose, onSave, guarded = false, draftScope }: {
  name: string; address: number; settings: PointSettings; available: number; typeGroups: { key: string; types: string[] }[]; t: (key: string) => string
  onClose: () => void; onSave: (value: PointSettingsUpdate) => Promise<void>
  draftScope?: DraftRegistration
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
  const [dialog, resumeButton, closeTrigger] = useDraftDialogFocus(busy, discarding)
  const dirty = pointDraftChanged(opening, { dataType, unit, factor, offset, decimalPlaces }, enums)
  const detached = useRef(draftScope?.removalPending?.() ?? false)
  const [, notifyDetached] = useState(false)
  const navigationState = useRef(() => ({ dirty: false, busy: false }))
  navigationState.current = () => ({ dirty: !detached.current && dirty && (closeGuard.canSave || closeGuard.confirming), busy: lock.current })
  const unloadRisk = navigationState.current().dirty || lock.current
  useEffect(() => bindBeforeUnload(window, unloadRisk, () => { const state = navigationState.current(); return state.dirty || state.busy }), [unloadRisk])
  const [draftContext] = useState(() => ({ name, address }))
  const snapshotState = useRef(() => ({ context: '', text: '' }))
  snapshotState.current = () => { detached.current = true; notifyDetached(true); return { context: draftContext.name + ' · ' + draftContext.address, text: JSON.stringify({ context: draftContext, opening, fields: { dataType, unit, factor, offset, decimalPlaces }, enums: { original: enums.original, intent: enums.intent, rows: enums.rows.map(row => ({ value: row.value, label: row.label })) } }, null, 2) } }
  useEffect(() => draftScope?.register('live', () => navigationState.current(), () => snapshotState.current()), [draftScope])
  const closeAction = (action: PointCloseAction) => {
    if (action === 'none') return
    setDiscarding(closeGuard.confirming)
    if (action === 'prompt') closeTrigger[0] = document.activeElement as HTMLElement | null
    if (action === 'resume') closeTrigger[1] = true
    if (action === 'close') onClose()
  }
  const requestClose = () => closeAction(closeGuard.request(!detached.current && dirty, lock.current))
  const save = async () => {
    if (draftScope?.removalPending?.()) { detached.current = true; notifyDetached(true); return }
    if (detached.current || lock.current || !closeGuard.canSave) return
    let next: PointSettingsUpdate
    try { next = parsePointSettingsUpdate({ dataType, unit, factor, offset, decimalPlaces }, enums, settings.dataType, available, t) }
    catch (e) { setError(e instanceof Error ? e.message : t('operationFailed')); setEnumIssueIndex(e instanceof Error && 'enumRowIndex' in e && Number.isInteger(e.enumRowIndex) ? e.enumRowIndex as number : null); setEnumIssueRevision(previous => previous + 1); return }
    lock.current = true; setBusy(true); setError(''); setEnumIssueIndex(null)
    try { await onSave(next); closeAction(closeGuard.saved()) }
    catch (e: any) { setError(e.message || t('operationFailed')) }
    finally { lock.current = false; setBusy(false) }
  }
  return <div className="modal-mask">
    <form ref={dialog} tabIndex={-1} className="modal enum-editor point-settings-editor" role="dialog" aria-modal="true" aria-labelledby={titleId} onSubmit={e => { e.preventDefault(); void save() }} onKeyDown={e => draftDialogKey(e, closeGuard, lock.current, closeAction, requestClose)}>
      <div className="modal-head"><h3 id={titleId}>{t('pointSettings')}</h3><button className="modal-close" type="button" aria-label={t('cancel')} disabled={busy || discarding} onClick={requestClose}>×</button></div>
      <p className="enum-context">{name} · {t('colAddr')} {address}</p>
      {guarded && <ConfigurationSaveHint english={t('cancel') === 'Cancel'} />}
      {detached.current && <DetachedEditorNotice english={t('cancel') === 'Cancel'} />}
      <fieldset disabled={busy || discarding || detached.current} className="point-draft-fields" aria-label={t('cancel') === 'Cancel' ? 'Point settings draft' : '点位设置草稿'}>
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
      <div className="modal-actions"><button className="btn" type="button" disabled={busy || discarding} onClick={requestClose}>{t('cancel')}</button><button className="btn primary" disabled={busy || discarding || detached.current} type="submit">{t(busy ? 'working' : 'save')}</button></div>
    </form>
  </div>
}
