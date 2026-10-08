import { useEffect, useId, useRef, useState } from 'react'
import { ALARM_OPERATORS, alarmMatches, type AlarmRule } from '../../../packages/core/src/alarm.ts'
import { registerWidth } from '../../../packages/core/src/codec.ts'
import { type Sample } from './observation'
import { readAlarmValue } from './alarm-value'

type Register = { id: number; alias: string | null; startAddress: number; dataType: string; functionCode: number }
type Group = { id: number; name: string; isActive: number; registers: Register[] }
const symbols: Record<string, string> = { '>': '>', '>=': '≥', '==': '=', '<=': '≤', '<': '<', '!=': '≠' }
async function request(path: string, method = 'GET', body?: unknown, signal?: AbortSignal) {
  const res = await fetch(path, { method, signal, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const value = await res.json()
  if (!res.ok) throw new Error(value.message || value.error || 'HTTP ' + res.status)
  return value
}

export function useAlarmRules(deviceId: number) {
  const [rules, setRules] = useState<AlarmRule[]>([])
  const [error, setError] = useState('')
  const lock = useRef(false), sequence = useRef(0)
  useEffect(() => {
    const controller = new AbortController()
    setRules([])
    const load = async () => {
      if (lock.current) return
      const seq = ++sequence.current
      try { const next = await request('/api/rules', 'GET', undefined, controller.signal); if (!controller.signal.aborted && seq === sequence.current) { setRules(next); setError('') } }
      catch (e: any) { if (!controller.signal.aborted && seq === sequence.current) setError(e.message) }
    }
    const refresh = () => void load()
    window.addEventListener('alarm-rules-changed', refresh)
    void load(); const timer = setInterval(refresh, 10000)
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener('alarm-rules-changed', refresh) }
  }, [deviceId])
  return { rules, setRules, error, setError, lock, sequence }
}

export function AlarmPanel({ t, device, groups, latest, groupErrors, now, threshold, point, onClose }: {
  t: (key: string) => string; device: { id: number; isActive: number }; groups: Group[]
  latest: Record<string, Sample>; groupErrors: Record<number, string>; now: number; threshold: number; point?: Register; onClose?: () => void
}) {
  const { rules, setRules, error, setError, lock, sequence } = useAlarmRules(device.id)
  const [open, setOpen] = useState(!!point)
  const [busy, setBusy] = useState(false)
  const [editId, setEditId] = useState<number | null>(null)
  const [registerId, setRegisterId] = useState(point ? String(point.id) : '')
  const [operator, setOperator] = useState('>')
  const [limit, setLimit] = useState('')
  const [message, setMessage] = useState('')
  const [deleting, setDeleting] = useState<number | null>(null)
  const titleId = useId()
  const registers = groups.flatMap(g => g.registers)
  const localRules = rules.filter(rule => registers.some(r => r.id === rule.registerId) && (!point || rule.registerId === point.id))
  const evaluated = localRules.map(rule => {
    const group = groups.find(g => g.registers.some(r => r.id === rule.registerId))!
    const reg = group.registers.find(r => r.id === rule.registerId)!
    const area = reg.functionCode === 1 ? 'coil' : reg.functionCode === 2 ? 'discrete-input' : reg.functionCode === 4 ? 'input-register' : 'holding-register'
    const words = Array.from({ length: registerWidth(reg.dataType) }, (_, i) => latest[device.id + ':' + area + ':' + (reg.startAddress + i)])
    const value = readAlarmValue(reg.dataType, words, now, threshold, !device.isActive || !group.isActive, !!groupErrors[group.id])
    const known = value !== null && (typeof value === 'bigint' || Number.isFinite(value))
    return { rule, reg, known, value, active: known && alarmMatches(value, rule.operator, rule.threshold) }
  })
  const active = evaluated.filter(e => e.active), unknown = evaluated.filter(e => !e.known)
  const reset = () => { setEditId(null); setRegisterId(point ? String(point.id) : ''); setOperator('>'); setLimit(''); setMessage(''); setDeleting(null) }
  const mutate = async (action: () => Promise<void>) => {
    if (lock.current) return
    lock.current = true; ++sequence.current; setBusy(true); setError('')
    try { await action(); const next = await request('/api/rules'); setRules(next); reset(); window.dispatchEvent(new Event('alarm-rules-changed')) }
    catch (e: any) { setError(e.message) }
    finally { lock.current = false; setBusy(false) }
  }
  const save = () => {
    if (!registerId || !registers.some(r => r.id === Number(registerId)) || !limit.trim() || !Number.isFinite(Number(limit))) { setError(t('alarmInvalid')); return }
    void mutate(async () => { await request('/api/rules' + (editId === null ? '' : '/' + editId), editId === null ? 'POST' : 'PUT', { registerId: Number(registerId), operator, threshold: Number(limit), message: message.trim() || null }) })
  }
  const close = () => { setOpen(false); onClose?.() }
  return <div className={point ? undefined : "alarm-panel"}>
    {!point && <>
      <div className="alarm-summary"><span className={active.length ? 'alarm-count active' : 'alarm-count'}>{t('alarmLabel')} · {active.length ? t('alarmActive').replace('{n}', String(active.length)) : localRules.length ? unknown.length ? t('alarmWaiting') : t('alarmNormal') : t('alarmNone')}</span></div>
      {active.length > 0 && <div className="alarm-active-list" role="alert">{active.map(({ rule, reg, value }) => <div key={rule.id}><strong>{reg.alias || '#' + reg.startAddress}</strong><span>{rule.message || t('alarmTriggered')}</span><small>{t('colRawValue')}: {String(value)} · {symbols[rule.operator]} {rule.threshold}</small></div>)}</div>}
      {unknown.length > 0 && <p className="alarm-hint">{t('alarmUnknown').replace('{n}', String(unknown.length))}</p>}
      {error && <p className="write-msg error" role="alert">{t('alarmLoadError')}: {error}</p>}
    </>}
    {open && <div className="modal-mask"><form className="modal alarm-editor" role="dialog" aria-modal="true" aria-labelledby={titleId} onSubmit={e => { e.preventDefault(); save() }}>
      <div className="modal-head"><h3 id={titleId}>{t('alarmRules')}</h3><button type="button" className="modal-close" aria-label={t('cancel')} disabled={busy} onClick={close}>×</button></div>
      <p className="alarm-hint">{t('alarmHelp')}</p>
      <div className="alarm-rule-list">{localRules.length === 0 && <p className="alarm-hint">{t('alarmNone')}</p>}{localRules.map(rule => { const state = evaluated.find(e => e.rule.id === rule.id)!; return <div className="alarm-rule-item" key={rule.id}>
        <div><strong>{state.reg.alias || '#' + state.reg.startAddress} · {symbols[rule.operator]} {rule.threshold}</strong><small>{rule.message || t('alarmTriggered')} · {t(state.active ? 'alarmTriggered' : state.known ? 'alarmNormal' : 'alarmWaiting')}</small></div>
        <button type="button" className="btn" disabled={busy} onClick={() => { setEditId(rule.id); setRegisterId(String(rule.registerId)); setOperator(rule.operator); setLimit(String(rule.threshold)); setMessage(rule.message ?? ''); setDeleting(null) }}>{t('edit')}</button>
        <button type="button" className="btn" disabled={busy} onClick={() => setDeleting(deleting === rule.id ? null : rule.id)}>{t('alarmDelete')}</button>
        {deleting === rule.id && <div className="alarm-delete-confirm"><span>{t('alarmConfirmDelete')}</span><button type="button" className="btn" disabled={busy} onClick={() => setDeleting(null)}>{t('cancel')}</button><button type="button" className="btn danger" disabled={busy} onClick={() => void mutate(async () => { await request('/api/rules/' + rule.id, 'DELETE') })}>{t('alarmDelete')}</button></div>}
      </div> })}</div>
      <h4>{t(editId === null ? 'alarmAdd' : 'alarmEdit')}</h4>
      {point ? <p className="enum-context">{point.alias || '#' + point.id} · {t('colAddr')} {point.startAddress} · {point.dataType}</p> : null}
      <div className="alarm-condition"><label>{t('alarmOperator')}<select aria-label={t('alarmOperator')} value={operator} disabled={busy} onChange={e => setOperator(e.target.value)}>{ALARM_OPERATORS.map(op => <option key={op} value={op}>{symbols[op]}</option>)}</select></label><label>{t('alarmThreshold')}<input aria-label={t('alarmThreshold')} type="number" step="any" value={limit} disabled={busy} onChange={e => setLimit(e.target.value)} placeholder="100" /></label></div>
      <label>{t('alarmMessage')}<input aria-label={t('alarmMessage')} value={message} maxLength={200} disabled={busy} onChange={e => setMessage(e.target.value)} placeholder={t('alarmMessageHint')} /></label>
      {error && <p className="write-msg error" role="alert">{error}</p>}
      <div className="modal-actions">{editId !== null && <button type="button" className="btn" disabled={busy} onClick={reset}>{t('alarmCancelEdit')}</button>}<button type="button" className="btn" disabled={busy} onClick={close}>{t('alarmClose')}</button><button className="btn primary" disabled={busy || !registers.length}>{t(busy ? 'working' : 'save')}</button></div>
    </form></div>}
  </div>
}
