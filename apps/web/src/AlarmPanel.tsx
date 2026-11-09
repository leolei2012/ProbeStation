import React, { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { ALARM_OPERATORS, alarmMatches } from '../../../packages/core/src/alarm.ts'
import { type Sample } from './observation'
import { readPointAlarmObservation } from './alarm-value'
import { alarmHistoryState } from './alarm-history'
import { AlarmHistoryAction } from './AlarmHistoryAction'
import type { DataTarget } from './DeviceIssues'
import { AlarmRulesReader } from './alarm-rule-read'
import { AlarmRuleReadStatus, alarmRuleSummaryKey } from './AlarmRuleReadStatus'
import { captureAlarmRule } from '../../../packages/core/src/alarm-settings-edit'
import type { AlarmRule } from '../../../packages/core/src/alarm'
import { AlarmWriteGate, writeGuardedAlarm, createAlarm, completeAlarmWrite, captureAlarmOpening, alarmOpeningState } from './alarm-settings-save'
import { AlarmRuleWriteStatus, AlarmContextNotice } from './AlarmRuleWriteStatus'
import { DeferredAlarmPendingContext } from './DeferredAlarmPendingContext'

type Register = { id: number; alias: string | null; startAddress: number; dataType: string; functionCode: number }
type Group = { id: number; name: string; isActive: number; slaveId?: number; registers: Register[] }
const symbols: Record<string, string> = { '>': '>', '>=': '≥', '==': '=', '<=': '≤', '<': '<', '!=': '≠' }
async function request(path: string, method = 'GET', body?: unknown, signal?: AbortSignal) {
  const res = await fetch(path, { method, signal, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  const value = await res.json()
  if (!res.ok) throw Object.assign(new Error(value.message || value.error || 'HTTP ' + res.status), { statusCode: res.status })
  return value
}

export function useAlarmRules(deviceId: number, requester = request) {
  const reader = useMemo(() => new AlarmRulesReader(signal => requester('/api/rules', 'GET', undefined, signal)), [deviceId, requester])
  const state = useSyncExternalStore(reader.subscribe, reader.snapshot, reader.snapshot)
  const [operationError, setError] = useState('')
  const lock = useRef(false)
  useEffect(() => {
    setError('')
    const refresh = () => { if (!lock.current) void reader.refresh(true) }
    const poll = () => { if (!lock.current) void reader.refresh() }
    window.addEventListener('alarm-rules-changed', refresh)
    poll(); const timer = setInterval(poll, 10000)
    return () => { reader.stop(); clearInterval(timer); window.removeEventListener('alarm-rules-changed', refresh) }
  }, [reader])
  const readError = state.status === 'error' ? (state.error instanceof Error ? state.error.message : 'Rule read failed') : ''
  return { rules: state.rules, setRules: reader.accept, error: operationError || readError, setError, lock, ready: state.status === 'ready', reading: state.reading, state, invalidate: reader.invalidate,
    retry: () => { if (!lock.current) void reader.refresh(true) } }
}

export function AlarmPanel({ t, device, groups, latest, groupErrors, now, threshold, point, onClose, configurationReady = false, onHistory, api = request }: {
  t: (key: string) => string; device: { id: number; isActive: number; mode?: string; slaveId?: number }; groups: Group[]
  latest: Record<string, Sample>; groupErrors: Record<number, string>; now: number; threshold: number; point?: Register; onClose?: () => void
  configurationReady?: boolean; onHistory?: (target: Readonly<DataTarget>) => void
  api?: typeof request
}) {
  const { rules, setRules, error, setError, lock, ready, reading, state: readState, invalidate, retry } = useAlarmRules(device.id, api)
  const [open, setOpen] = useState(!!point)
  const [pendingOpen, setPendingOpen] = useState(false)
  const [activePage, setActivePage] = useState(0)
  const [busy, setBusy] = useState(false)
  const [editId, setEditId] = useState<number | null>(null)
  const [registerId, setRegisterId] = useState(point ? String(point.id) : '')
  const [operator, setOperator] = useState('>')
  const [limit, setLimit] = useState('')
  const [message, setMessage] = useState('')
  const [editExpected, setEditExpected] = useState<Readonly<AlarmRule> | null>(null)
  const [deleting, setDeleting] = useState<Readonly<AlarmRule> | null>(null)
  const gate = useMemo(() => new AlarmWriteGate(), [device.id])
  const writeState = useSyncExternalStore(gate.subscribe, gate.snapshot, gate.snapshot)
  const [writeWarning, setWriteWarning] = useState('')
  const [openingContext] = useState(() => { try { return point ? captureAlarmOpening(point, groups, device) : null } catch { return null } })
  const contextState = alarmOpeningState(openingContext, groups, device), contextReady = contextState === 'ready'
  const titleId = useId()
  const registers = groups.flatMap(g => g.registers)
  // Rebuild from this render's definitions; preserve the old first-definition lookup.
  // Do not cache observations: quality, source, time and batch checks still run below.
  const pointContexts = new Map<number, { group: Group; reg: Register }>()
  for (const group of groups) for (const reg of group.registers) if (!pointContexts.has(reg.id)) pointContexts.set(reg.id, { group, reg })
  const localRules = rules.filter(rule => pointContexts.has(rule.registerId) && (!point || rule.registerId === point.id))
  const evaluated = localRules.map(rule => {
    const { group, reg } = pointContexts.get(rule.registerId)!
    const observation = readPointAlarmObservation(reg, latest, device, group, now, threshold, !!groupErrors[group.id]), value = observation?.value ?? null
    const known = value !== null && (typeof value === 'bigint' || Number.isFinite(value))
    return { rule, reg, group, observation, known, value, active: known && alarmMatches(value, rule.operator, rule.threshold) }
  })
  const active = evaluated.filter(e => e.active), unknown = evaluated.filter(e => !e.known)
  const activePages = Math.max(1, Math.ceil(active.length / 20)), shownActivePage = Math.min(activePage, activePages - 1)
  const reset = () => { gate.reset(); setError(''); setWriteWarning(''); setEditId(null); setEditExpected(null); setRegisterId(point ? String(point.id) : ''); setOperator('>'); setLimit(''); setMessage(''); setDeleting(null) }
  const mutate = async (action: (signal: AbortSignal) => Promise<readonly string[]>) => {
    if (lock.current || !ready || reading || !contextReady || gate.snapshot().phase !== 'idle') return
    lock.current = true; invalidate(); setBusy(true); setError('')
    let next: readonly AlarmRule[] | null = null, warnings: readonly string[] = []
    try {
      const saved = await gate.run(async signal => {
        const completed = await completeAlarmWrite(action, child => api('/api/rules', 'GET', undefined, child), signal)
        warnings = completed.warnings; next = completed.rules
      })
      if (saved && next) { setRules(next); reset(); setWriteWarning(warnings.join(' ')) }
    }
    finally { window.dispatchEvent(new Event('alarm-rules-changed')); lock.current = false; setBusy(false) }
  }
  const save = () => {
    if (!registerId || !registers.some(r => r.id === Number(registerId)) || !limit.trim() || !Number.isFinite(Number(limit))) { setError(t('alarmInvalid')); return }
    if (deleting) return
    void mutate(async signal => {
      const changes = { operator, threshold: Number(limit), message: message.trim() || null }
      if (editId !== null) {
        if (!editExpected || editExpected.id !== editId) throw new Error('missing original rule')
        return writeGuardedAlarm(editExpected, changes, (url, method, body) => api(url, method, body, signal), openingContext!)
      }
      return createAlarm({ registerId: Number(registerId), ...changes }, (url, method, body) => api(url, method, body, signal), openingContext!)
    })
  }
  const close = () => { setOpen(false); onClose?.() }
  return <div className={point ? undefined : "alarm-panel"}>
    {!point && <>
      <div className="alarm-summary"><span className={ready && !reading && active.length ? 'alarm-count active' : 'alarm-count'}>{t('alarmLabel')} · {t(alarmRuleSummaryKey(readState, active.length, localRules.length, unknown.length)).replace('{n}', String(active.length))}</span></div>
      <AlarmRuleReadStatus state={readState} onRetry={retry} disabled={busy} english={t('cancel') === 'Cancel'} />
      {active.length > 0 && <>
      {activePages > 1 && <div className="toolbar" role="group" aria-label={t('cancel') === 'Cancel' ? 'Matching rule pages' : '命中规则分页'}><span role="status">{t('cancel') === 'Cancel' ? `Cached matching rules: ${active.length}; showing ${shownActivePage * 20 + 1}–${Math.min((shownActivePage + 1) * 20, active.length)} · ${shownActivePage + 1}/${activePages}` : `缓存命中规则 ${active.length} 条；显示 ${shownActivePage * 20 + 1}–${Math.min((shownActivePage + 1) * 20, active.length)} · ${shownActivePage + 1}/${activePages}`}</span><input type="number" className="hist-input" aria-label={t('cancel') === 'Cancel' ? 'Matching rule page number' : '命中规则页码'} min={1} max={activePages} step={1} value={shownActivePage + 1} onChange={event => { const page = event.currentTarget.valueAsNumber; if (Number.isSafeInteger(page) && page >= 1 && page <= activePages) setActivePage(page - 1) }} /><button type="button" className="btn" disabled={shownActivePage === 0} onClick={() => setActivePage(shownActivePage - 1)}>{t('cancel') === 'Cancel' ? 'Previous' : '上一页'}</button><button type="button" className="btn" disabled={shownActivePage + 1 === activePages} onClick={() => setActivePage(shownActivePage + 1)}>{t('cancel') === 'Cancel' ? 'Next' : '下一页'}</button></div>}
      <div className="alarm-active-list" role="alert">{(!ready || reading) && <p>{t('alarmRetainedRules')}</p>}{active.slice(shownActivePage * 20, (shownActivePage + 1) * 20).map(({ rule, reg, observation, value }) => <div key={rule.id}><strong>{reg.alias || '#' + reg.startAddress}</strong><span>{rule.message || t('alarmTriggered')}</span><small>{t('colRawValue')}: {String(value)} · {symbols[rule.operator]} {rule.threshold}</small>
        {onHistory && <AlarmHistoryAction state={alarmHistoryState(observation, rule, reg, device.id, configurationReady, ready && !reading, now, threshold)} resolve={() => alarmHistoryState(observation, rule, reg, device.id, configurationReady, ready && !reading, Date.now(), threshold)} onOpen={onHistory} english={t('cancel') === 'Cancel'} />}
      </div>)}{onHistory && <p className="alarm-history-hint">{t('alarmHistoryHint')}</p>}</div>
      {activePages > 1 && <p className="alarm-hint">{t('cancel') === 'Cancel' ? 'Display pagination only; all rules are still evaluated in rule order. Refreshes can change the list and page. Enter a page number to jump; browser Find covers only the displayed page. These are conditions matching cached samples, not recorded events or fault causes.' : '仅分页显示，全部规则仍按原顺序判定；刷新可能改变列表和页码。可输入页码跳转；浏览器查找只覆盖当前卡片页。这里是缓存采样的条件命中，不是事件条数或故障原因。'}</p>}
      </>}
      {ready && !reading && unknown.length > 0 && <p className="alarm-hint">{t('alarmUnknown').replace('{n}', String(unknown.length))}</p>}
      <button className="btn" type="button" aria-expanded={pendingOpen} onClick={() => setPendingOpen(value => !value)}>{t('cancel') === 'Cancel' ? pendingOpen ? 'Hide pending rule context' : 'Review pending rules' : pendingOpen ? '收起待定规则' : '查看待定规则'}</button>
      {pendingOpen && <DeferredAlarmPendingContext rows={unknown} current={configurationReady && ready && !reading} device={{ isActive: device.isActive, mode: device.mode, slaveId: device.slaveId }} groupErrors={groupErrors} english={t('cancel') === 'Cancel'} />}
      {error && <p className="write-msg error" role="alert">{t('alarmLoadError')}: {error}</p>}
    </>}
    {open && <div className="modal-mask"><form className="modal alarm-editor" role="dialog" aria-modal="true" aria-labelledby={titleId} onSubmit={e => { e.preventDefault(); save() }}>
      <div className="modal-head"><h3 id={titleId}>{t('alarmRules')}</h3><button type="button" className="modal-close" aria-label={t('cancel')} disabled={busy} onClick={close}>×</button></div>
      <p className="alarm-hint">{t('alarmHelp')}</p>
      <AlarmContextNotice state={contextState} english={t('cancel') === 'Cancel'} />
      <AlarmRuleReadStatus state={readState} onRetry={retry} disabled={busy} english={t('cancel') === 'Cancel'} />
      <div className="alarm-rule-list">{ready && !reading && localRules.length === 0 && <p className="alarm-hint">{t('alarmNone')}</p>}{localRules.map(rule => { const state = evaluated.find(e => e.rule.id === rule.id)!; return <div className="alarm-rule-item" key={rule.id}>
        <div><strong>{state.reg.alias || '#' + state.reg.startAddress} · {symbols[rule.operator]} {rule.threshold}</strong><small>{rule.message || t('alarmTriggered')} · {t(!ready || reading ? 'alarmRulesUnverified' : state.active ? 'alarmTriggered' : state.known ? 'alarmNormal' : 'alarmWaiting')}</small></div>
        <button type="button" className="btn" disabled={busy || !ready || reading || !contextReady} onClick={() => { gate.reset(); setError(''); setWriteWarning(''); setEditId(rule.id); setEditExpected(captureAlarmRule(rule)); setRegisterId(String(rule.registerId)); setOperator(rule.operator); setLimit(String(rule.threshold)); setMessage(rule.message ?? ''); setDeleting(null) }}>{t('edit')}</button>
        <button type="button" className="btn" disabled={busy || !ready || reading || !contextReady} onClick={() => { gate.reset(); setError(''); setWriteWarning(''); setDeleting(deleting?.id === rule.id ? null : captureAlarmRule(rule)) }}>{t('alarmDelete')}</button>
      </div> })}</div>
      {deleting && <div className="alarm-delete-confirm"><span>{t('alarmConfirmDelete')} #{deleting.id} · #{deleting.registerId} · {symbols[deleting.operator]} {deleting.threshold} · {deleting.message}</span><button type="button" className="btn" disabled={busy} onClick={() => setDeleting(null)}>{t('cancel')}</button><button type="button" className="btn danger" disabled={busy || !ready || reading || !contextReady || writeState.phase === 'blocked'} onClick={() => void mutate(signal => writeGuardedAlarm(deleting, null, (url, method, body) => api(url, method, body, signal), openingContext!))}>{t('alarmDelete')}</button></div>}
      <AlarmRuleWriteStatus state={writeState} onReset={reset} english={t('cancel') === 'Cancel'} />
      {writeWarning && <p className="alarm-hint" role="status">{writeWarning}</p>}
      <h4>{t(editId === null ? 'alarmAdd' : 'alarmEdit')}</h4>
      {point ? <p className="enum-context">{point.alias || '#' + point.id} · {t('colAddr')} {point.startAddress} · {point.dataType}</p> : null}
      <div className="alarm-condition"><label>{t('alarmOperator')}<select aria-label={t('alarmOperator')} value={operator} disabled={busy} onChange={e => setOperator(e.target.value)}>{ALARM_OPERATORS.map(op => <option key={op} value={op}>{symbols[op]}</option>)}</select></label><label>{t('alarmThreshold')}<input aria-label={t('alarmThreshold')} type="number" step="any" value={limit} disabled={busy} onChange={e => setLimit(e.target.value)} placeholder="100" /></label></div>
      <label>{t('alarmMessage')}<input aria-label={t('alarmMessage')} value={message} maxLength={200} disabled={busy} onChange={e => setMessage(e.target.value)} placeholder={t('alarmMessageHint')} /></label>
      {error && <p className="write-msg error" role="alert">{error}</p>}
      <div className="modal-actions">{editId !== null && <button type="button" className="btn" disabled={busy} onClick={reset}>{t('alarmCancelEdit')}</button>}<button type="button" className="btn" disabled={busy} onClick={close}>{t('alarmClose')}</button><button className="btn primary" disabled={busy || !ready || reading || !contextReady || !registers.length || !!deleting || writeState.phase === 'blocked'}>{t(busy ? 'working' : 'save')}</button></div>
    </form></div>}
  </div>
}
