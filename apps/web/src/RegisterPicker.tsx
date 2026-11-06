import React, { useEffect, useId, useState } from 'react'
import { addVisiblePickerPoints, filterPickerGroups, pickerSource, pickerSources, type PickerGroup } from './register-picker'
export type { PickerGroup } from './register-picker'

type T = (key: string) => string
export function RegisterSelectModal({ t, groups, initial, onClose, onApply, max, deviceSlaveId }: {
  t: T; groups: PickerGroup[]; initial: Set<number>; onClose: () => void; onApply: (s: Set<number>) => void; max?: number; deviceSlaveId?: number
}) {
  const [draft, setDraft] = useState<Set<number>>(() => new Set(initial))
  const [search, setSearch] = useState('')
  const [source, setSource] = useState('')
  const titleId = useId()
  const toggle = (id: number) => setDraft((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else if (max === undefined || next.size < max) next.add(id); return next })
  const allIds = groups.flatMap(g => g.registers).map(r => r.id)
  const sources = pickerSources(groups, deviceSlaveId), sourceKey = sources.join(',')
  const activeSource = sources.includes(source) ? source : ''
  const filtered = filterPickerGroups(groups, search, activeSource, deviceSlaveId)
  const addVisible = () => setDraft(prev => addVisiblePickerPoints(prev, filtered, max))
  const sourceLabel = (group: PickerGroup) => { const value = pickerSource(group, deviceSlaveId); return value === null ? t('pickerSourceUnknown') : `${t('pickerSource')} ${value}` }
  useEffect(() => { if (source && !sources.includes(source)) setSource('') }, [sourceKey, source])
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    return () => previous?.focus()
  }, [])
  return (
    <div className="modal-mask">
      <div className="modal reg-modal" role="dialog" aria-modal="true" aria-labelledby={titleId} onClick={(e) => e.stopPropagation()} onKeyDown={e => {
        if (e.key === 'Escape') { e.stopPropagation(); onClose() }
        if (e.key === 'Tab') {
          const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)'))
          const first = items[0], last = items[items.length - 1]
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
        }
      }}>
        <div className="modal-head">
          <span id={titleId}>{t('selectRegisters')}</span>
          <button className="modal-close" aria-label={t('cancel')} onClick={onClose}>✕</button>
        </div>
        <input className="reg-picker-search" aria-label={t('pickerSearch')} placeholder={t('pickerSearch')} value={search} onChange={e => setSearch(e.target.value)} autoFocus />
        <div className="reg-picker-filters">
          <label>{t('pickerSource')}<select aria-label={t('pickerSource')} value={activeSource} onChange={e => setSource(e.target.value)}>
            <option value="">{t('pickerAllSources')}</option>
            {sources.map(value => <option key={value} value={value}>{value === '?' ? t('pickerSourceUnknown') : `${t('pickerSource')} ${value}`}</option>)}
          </select></label>
          {(search || activeSource) && <button className="btn" onClick={() => { setSearch(''); setSource('') }}>{t('pickerClearFilters')}</button>}
        </div>
        <div className="reg-modal-actions">
          <span className="reg-picker-count" aria-live="polite">{draft.size} / {allIds.length}</span>
          <button className="btn" onClick={addVisible} disabled={!filtered.length || (max !== undefined && draft.size >= max)}>{t('pickerSelectVisible')}</button>
          <button className="btn" onClick={() => setDraft(new Set())}>{t('pickerClearSelection')}</button>
        </div>
        {max && <p className="chart-hint">{t('curveSelectLimit').replace('{n}', String(max))}</p>}
        <div className="reg-list">
          {filtered.map(g => (
            <div key={g.id} className="reg-group">
              <div className="reg-group-name"><span>{g.name} · {sourceLabel(g)}</span><span>{g.registers.filter(r => draft.has(r.id)).length} / {g.registers.length}</span></div>
              {g.registers.map(r => (
                <label key={r.id} className={'reg-item' + (draft.has(r.id) ? ' selected' : '') + (!draft.has(r.id) && max !== undefined && draft.size >= max ? ' unavailable' : '')}>
                  <input type="checkbox" checked={draft.has(r.id)} disabled={!draft.has(r.id) && max !== undefined && draft.size >= max} onChange={() => toggle(r.id)} />
                  <span className="reg-item-copy"><span className="reg-item-alias" title={`${r.alias ?? ('reg' + r.id)} · ${sourceLabel(g)} · #${r.id}`}>{r.alias || ('reg' + r.id)}</span><span className="reg-item-meta">{sourceLabel(g)} · {t('colAddr')} {r.startAddress} · FC{r.functionCode} · #{r.id}</span></span>
                  <span className="reg-item-type">{r.dataType}</span>
                </label>
              ))}
            </div>
          ))}
          {!filtered.length && <div className="hist-empty">{t('noMatchingPoints')}</div>}
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>{t('cancel')}</button>
          <button className="btn primary" onClick={() => onApply(new Set(draft))}>{t('save')}</button>
        </div>
      </div>
    </div>
  )
}

export function RegisterSelectButton({ t, groups, selected, onApply, max, deviceSlaveId }: {
  t: T; groups: PickerGroup[]; selected: Set<number>; onApply: (s: Set<number>) => void; max?: number; deviceSlaveId?: number
}) {
  const [show, setShow] = useState(false)
  const total = groups.reduce((n, g) => n + g.registers.length, 0)
  return (
    <>
      <button className="btn reg-picker-trigger" onClick={() => setShow(true)}>{t('selectRegisters')} <span>{selected.size}/{total}</span></button>
      {show && <RegisterSelectModal t={t} groups={groups} max={max} deviceSlaveId={deviceSlaveId} initial={selected} onClose={() => setShow(false)} onApply={(s) => { onApply(s); setShow(false) }} />}
    </>
  )
}
