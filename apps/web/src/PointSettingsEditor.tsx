import { useId, useRef, useState } from 'react'
import { registerWidth } from '../../../packages/core/src/codec'

type Row = { id: number; value: string; label: string }
export type PointSettings = { dataType: string; unit: string | null; factor: number; offset: number; enumJson: string | null; decimalPlaces?: number | null }
export function PointSettingsEditor({ name, address, settings, available, typeGroups, t, onClose, onSave }: {
  name: string; address: number; settings: PointSettings; available: number; typeGroups: { key: string; types: string[] }[]; t: (key: string) => string
  onClose: () => void; onSave: (value: PointSettings) => Promise<void>
}) {
  const titleId = useId()
  const [dataType, setDataType] = useState(settings.dataType)
  const [unit, setUnit] = useState(settings.unit ?? '')
  const [factor, setFactor] = useState(String(settings.factor ?? 1))
  const [offset, setOffset] = useState(String(settings.offset ?? 0))
  const [decimalPlaces, setDecimalPlaces] = useState(settings.decimalPlaces == null ? '' : String(settings.decimalPlaces))
  const enumJson = settings.enumJson
  const nextId = useRef(0)
  const [rows, setRows] = useState<Row[]>(() => {
    try {
      const map = enumJson ? JSON.parse(enumJson) : {}
      if (!map || typeof map !== 'object' || Array.isArray(map)) return []
      return Object.entries(map).map(([value, label]) => ({ id: nextId.current++, value, label: String(label) }))
    } catch { return [] }
  })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const update = (id: number, field: 'value' | 'label', value: string) => {
    setRows(prev => prev.map(row => row.id === id ? { ...row, [field]: value } : row)); setError('')
  }
  const save = async () => {
    if (lock.current) return
    if (dataType !== settings.dataType && registerWidth(dataType) > available) { setError(t('valueShort')); return }
    const numericFactor = Number(factor), numericOffset = Number(offset)
    if (!factor.trim() || !offset.trim() || !Number.isFinite(numericFactor) || !Number.isFinite(numericOffset) || numericFactor === 0) { setError(t('pointInvalidScale')); return }
    const map: Record<string, string> = Object.create(null)
    for (const row of rows) {
      if (!/^-?\d+$/.test(row.value.trim())) { setError(t('enumInvalidValue')); return }
      const key = BigInt(row.value.trim()).toString()
      if (Object.hasOwn(map, key)) { setError(t('enumDuplicate').replace('{value}', key)); return }
      if (!row.label.trim()) { setError(t('enumEmptyLabel')); return }
      map[key] = row.label.trim()
    }
    lock.current = true; setBusy(true); setError('')
    try { await onSave({ dataType, unit: unit.trim() || null, factor: numericFactor, offset: numericOffset, enumJson: rows.length ? JSON.stringify(map) : null, decimalPlaces: decimalPlaces === '' ? null : Number(decimalPlaces) }); onClose() }
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
      <h4 className="point-enum-title">{t('enumConfig')}</h4>
      <p className="enum-hint">{t('enumHint')}</p>
      <div className="enum-columns"><span>{t('enumValue')}</span><span>{t('enumLabel')}</span><span /></div>
      <div className="enum-rows">
        {!rows.length && <p className="enum-empty">{t('enumEmpty')}</p>}
        {rows.map((row, index) => <div className="enum-row" key={row.id}>
          <input aria-label={`${t('enumValue')} ${index + 1}`} value={row.value} maxLength={40} placeholder={String(index)} disabled={busy} onChange={e => update(row.id, 'value', e.target.value)} />
          <input aria-label={`${t('enumLabel')} ${index + 1}`} value={row.label} maxLength={120} placeholder={t('enumLabelPlaceholder')} disabled={busy} onChange={e => update(row.id, 'label', e.target.value)} />
          <button className="btn" type="button" aria-label={`${t('enumRemove')} ${index + 1}`} disabled={busy} onClick={() => { setRows(prev => prev.filter(r => r.id !== row.id)); setError('') }}>×</button>
        </div>)}
      </div>
      <div className="enum-tools"><button className="btn" type="button" disabled={busy || rows.length >= 200} onClick={() => setRows(prev => [...prev, { id: nextId.current++, value: '', label: '' }])}>＋ {t('enumAdd')}</button><button className="btn" type="button" disabled={busy || !rows.length} onClick={() => { setRows([]); setError('') }}>{t('enumClear')}</button></div>
      {error && <div className="write-msg error" role="alert">{error}</div>}
      <div className="modal-actions"><button className="btn" type="button" disabled={busy} onClick={onClose}>{t('cancel')}</button><button className="btn primary" disabled={busy} type="submit">{t(busy ? 'working' : 'save')}</button></div>
    </form>
  </div>
}
