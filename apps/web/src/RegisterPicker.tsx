import React, { useEffect, useId, useRef, useState } from 'react'
import { addVisiblePickerPoints, filterPickerGroups, pickerContext, pickerSource, pickerSources, type PickerGroup } from './register-picker'
export type { PickerGroup } from './register-picker'

type T = (key: string) => string
export function RegisterSelectModal({ t, groups, initial, onClose, onApply, max, deviceSlaveId }: {
  t: T; groups: PickerGroup[]; initial: Set<number>; onClose: () => void; onApply: (s: Set<number>) => void; max?: number; deviceSlaveId?: number
}) {
  const [draft, setDraft] = useState<Set<number>>(() => new Set(initial))
  const [search, setSearch] = useState('')
  const [source, setSource] = useState('')
  const [selectedOnly, setSelectedOnly] = useState(false)
  const context = pickerContext(groups, deviceSlaveId, max), [openedContext] = useState(context), invalidated = useRef(false)
  if (context !== openedContext) invalidated.current = true
  const blocked = invalidated.current
  const titleId = useId(), countId = titleId + '-count', limitId = titleId + '-limit'
  const description = countId + (max === undefined ? '' : ' ' + limitId), atLimit = max !== undefined && draft.size >= max
  const english = t('cancel') === 'Cancel'
  const toggle = (id: number) => setDraft((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else if (max === undefined || next.size < max) next.add(id); return next })
  const allIds = groups.flatMap(g => g.registers).map(r => r.id)
  const sources = pickerSources(groups, deviceSlaveId), sourceKey = sources.join(',')
  const activeSource = sources.includes(source) ? source : ''
  const filtered = blocked ? [] : filterPickerGroups(groups, search, activeSource, deviceSlaveId, selectedOnly ? draft : undefined)
  const matching = filtered.reduce((count, group) => count + group.registers.length, 0)
  const addVisible = () => setDraft(prev => addVisiblePickerPoints(prev, filtered, max))
  const sourceLabel = (group: PickerGroup) => { const value = pickerSource(group, deviceSlaveId); return value === null ? t('pickerSourceUnknown') : `${t('pickerSource')} ${value}` }
  useEffect(() => { if (source && !sources.includes(source)) setSource('') }, [sourceKey, source])
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    return () => previous?.focus()
  }, [])
  return (
    <div className="modal-mask">
      <div className="modal reg-modal" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={description} onClick={(e) => e.stopPropagation()} onKeyDown={e => {
        if (e.key === 'Escape' && !e.nativeEvent.isComposing) { e.preventDefault(); e.stopPropagation(); onClose() }
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
        {blocked && <p className="chart-hint warn" role="alert">{english ? 'Configuration or source changed. This draft cannot be applied; close and reopen to select again.' : '配置或来源已变化，此草稿不可应用；请关闭后重新打开并选择。'}</p>}
        <input className="reg-picker-search" disabled={blocked} aria-describedby={description} aria-label={t('pickerSearch')} placeholder={t('pickerSearch')} value={search} onChange={e => setSearch(e.target.value)} autoFocus />
        <div className="reg-picker-filters">
          <label>{t('pickerSource')}<select disabled={blocked} aria-label={t('pickerSource')} value={activeSource} onChange={e => setSource(e.target.value)}>
            <option value="">{t('pickerAllSources')}</option>
            {sources.map(value => <option key={value} value={value}>{value === '?' ? t('pickerSourceUnknown') : `${t('pickerSource')} ${value}`}</option>)}
          </select></label>
          <button type="button" className="btn" disabled={blocked} aria-pressed={selectedOnly} aria-describedby={countId} title={english ? 'Show selected points; entering review clears search and source filters.' : '集中查看已选点位；进入时清除搜索和从站筛选。'} onClick={() => { if (!selectedOnly) { setSearch(''); setSource('') }; setSelectedOnly(!selectedOnly) }}>{english ? 'Review selected' : '查看全部已选'}</button>
          {(search || activeSource || selectedOnly) && <button className="btn" disabled={blocked} onClick={() => { setSearch(''); setSource(''); setSelectedOnly(false) }}>{t('pickerClearFilters')}</button>}
        </div>
        <div className="reg-modal-actions">
          <span id={countId} className="reg-picker-count" role="status" aria-live="polite" aria-atomic={true}>{draft.size} / {allIds.length}{english ? ` · ${matching} matching` : ` · ${matching} 匹配`}{atLimit ? english ? ' · Limit reached' : ' · 已达上限' : ''}</span>
          <button className="btn" aria-describedby={description} onClick={addVisible} disabled={!filtered.length || (max !== undefined && draft.size >= max)}>{t('pickerSelectVisible')}</button>
          <button className="btn" disabled={blocked} aria-describedby={countId} onClick={() => setDraft(new Set())}>{t('pickerClearSelection')}</button>
        </div>
        {max !== undefined && <p id={limitId} className="chart-hint">{t('curveSelectLimit').replace('{n}', String(max))}{atLimit ? english ? '; deselect points to choose others.' : '；取消已选点位可继续选择。' : ''}</p>}
        <div className="reg-list">
          {filtered.map(g => (
            <div key={g.id} className="reg-group">
              <div className="reg-group-name"><span>{g.name} · {sourceLabel(g)}</span><span>{g.registers.filter(r => draft.has(r.id)).length} / {g.registers.length}</span></div>
              {g.registers.map(r => (
                <label key={r.id} className={'reg-item' + (draft.has(r.id) ? ' selected' : '') + (!draft.has(r.id) && max !== undefined && draft.size >= max ? ' unavailable' : '')}>
                  <input type="checkbox" aria-describedby={description} checked={draft.has(r.id)} disabled={!draft.has(r.id) && max !== undefined && draft.size >= max} onChange={() => toggle(r.id)} />
                  <span className="reg-item-copy"><span className="reg-item-alias" title={`${r.alias ?? ('reg' + r.id)} · ${sourceLabel(g)} · #${r.id}`}>{r.alias || ('reg' + r.id)}</span><span className="reg-item-meta">{sourceLabel(g)} · {t('colAddr')} {r.startAddress} · FC{r.functionCode} · #{r.id}</span></span>
                  <span className="reg-item-type">{r.dataType}</span>
                </label>
              ))}
            </div>
          ))}
          {!blocked && !filtered.length && <div className="hist-empty">{t('noMatchingPoints')}</div>}
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>{t('cancel')}</button>
          <button className="btn primary" disabled={blocked} aria-describedby={countId} onClick={() => { if (!invalidated.current) onApply(new Set(draft)) }}>{t('save')}</button>
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
