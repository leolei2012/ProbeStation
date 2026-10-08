import { useState } from 'react'
import type { ValueMode } from './physical-value'

export function useValueMode(key: string): [ValueMode, (mode: ValueMode) => void] {
  const [mode, setMode] = useState<ValueMode>(() => { try { return localStorage.getItem(key) === 'physical' ? 'physical' : 'raw' } catch { return 'raw' } })
  return [mode, next => { setMode(next); try { localStorage.setItem(key, next) } catch {} }]
}
export function ValueModeControl({ t, value, onChange }: { t: (key: string) => string; value: ValueMode; onChange: (mode: ValueMode) => void }) {
  return <div className="seg value-mode-control" role="group" aria-label={t('displayValueMode')}>{(['raw', 'physical'] as const).map(mode => <button type="button" key={mode} className={value === mode ? 'selected' : ''} aria-pressed={value === mode} onClick={() => onChange(mode)}>{t(mode === 'raw' ? 'colRawValue' : 'colPhysicalValue')}</button>)}</div>
}
export type DisplayColumns = { address: boolean; type: boolean; raw: boolean; physical: boolean; action: boolean }
const defaults: DisplayColumns = { address: true, type: true, raw: true, physical: true, action: true }
export function useDisplayColumns(deviceId: number): [DisplayColumns, (value: DisplayColumns) => void] {
  const key = 'ps-live-columns-' + deviceId
  const [value, setValue] = useState<DisplayColumns>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(key) ?? '{}'), next = { ...defaults }
      for (const key of Object.keys(defaults) as (keyof DisplayColumns)[]) if (typeof saved?.[key] === 'boolean') next[key] = saved[key]
      if (!next.raw && !next.physical) next.physical = true
      return next
    } catch { return { ...defaults } }
  })
  return [value, next => { setValue(next); try { localStorage.setItem(key, JSON.stringify(next)) } catch {} }]
}
export function ColumnControl({ t, columns, configuring, onChange }: { t: (key: string) => string; columns: DisplayColumns; configuring: boolean; onChange: (value: DisplayColumns) => void }) {
  const names = { address: 'colAddr', type: 'colType', raw: 'colRawValue', physical: 'colPhysicalValue', action: 'write' }
  return <details className="column-control"><summary className="btn">{t('displayColumns')}</summary><div className="column-menu">
    {(Object.keys(names) as (keyof DisplayColumns)[]).map(key => <label key={key}><input type="checkbox" checked={columns[key] || configuring && (key === 'type' || key === 'action')} disabled={configuring && (key === 'type' || key === 'action') || key === 'raw' && columns.raw && !columns.physical || key === 'physical' && columns.physical && !columns.raw} onChange={e => onChange({ ...columns, [key]: e.target.checked })} />{t(key === 'action' && configuring ? 'pointSettings' : names[key])}</label>)}
    <small>{t(configuring ? 'displayColumnsConfigHint' : 'displayColumnsHint')}</small>
    <div><button className="btn" type="button" onClick={() => onChange({ address: false, type: false, raw: false, physical: true, action: false })}>{t('displayColumnsCompact')}</button><button className="btn" type="button" onClick={() => onChange({ ...defaults })}>{t('displayColumnsAll')}</button></div>
  </div></details>
}
