import React, { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { DeviceIssuesRead, type DataTarget, type DeviceIssuesReadState } from './device-issues-read'
export type { DataTarget } from './device-issues-read'

export function DeviceIssuesView({ state, onNavigate, refresh, english = false }: { state: DeviceIssuesReadState; onNavigate: (target: DataTarget) => void; refresh: () => void; english?: boolean }) {
  const text = (zh: string, en: string) => english ? en : zh, value = state.value, current = state.phase === 'ready'
  return <section className="device-issues" aria-label={text('设备状态提醒快照', 'Device issue snapshot')}>
    <div className="toolbar"><strong>{text('设备状态提醒', 'Device reminders')}{value && ' · ' + value.issues.length}</strong><button type="button" className="btn btn-sm" disabled={state.phase === 'loading'} onClick={refresh}>{text('重新核对', 'Check again')}</button></div>
    <div className="device-issues-read-status">{(state.phase === 'loading' || state.phase === 'idle') && <p role="status">{value ? text('正在核对；显示上次快照，当前状态未核实。', 'Checking; previous snapshot shown, current state unverified.') : text('正在核对现有设备状态…', 'Checking existing device status…')}</p>}
    {state.phase === 'error' && <p role="alert">{text(state.error === 'timeout' ? '汇总读取超过10秒，当前状态未核实；稍后自动重读，也可手动核对。' : state.error === 'invalid' ? '汇总响应异常，当前状态未核实。' : '汇总读取失败，当前状态未核实。', state.error === 'timeout' ? 'Summary read exceeded 10 seconds; current state is unverified. Automatic and manual checks can recover.' : state.error === 'invalid' ? 'Invalid summary response; current state is unverified.' : 'Summary read failed; current state is unverified.')}{value && text(' 上次提醒仍可查看，不代表问题仍在或已恢复。', ' Previous reminders remain available without establishing ongoing issues or recovery.')}</p>}
    {current && <p>{text('状态汇总，可展开查看提醒与核对时间。', 'Status snapshot; expand for reminders and check times.')}</p>}</div>
    {value && <details><summary>{text(current ? '查看本次状态汇总' : '查看上次状态汇总', current ? 'View this status snapshot' : 'View previous status snapshot')} · {value.issues.length}</summary><p>{text('本页接收UTC', 'Received at UTC')}: {value.receivedAt}<br />{text('后端核对UTC', 'Backend check UTC')}: {value.checkedAt === null ? text('未提供', 'Not provided') : new Date(value.checkedAt).toISOString()}</p>
      {!value.issues.length ? <p>{text(current ? '本次规则汇总未产生提醒，不等于设备健康或测试通过。' : '上次汇总没有提醒，不能用于判断当前设备状态。', current ? 'This rule snapshot produced no reminders; it does not establish device health or a test pass.' : 'The previous snapshot had no reminders; current device state remains unverified.')}</p> : <div className="device-issue-list">{value.issues.map((issue, i) => <button type="button" className="btn" key={i} onClick={() => onNavigate(issue)}><strong>{issue.label || '#' + issue.deviceId}</strong><span>{issue.reason || text('未提供说明', 'No reason provided')}</span><span>{text(current ? '查看 →' : '查看上次关联位置 →', current ? 'View →' : 'Inspect previous target →')}</span></button>)}</div>}
      <small>{text('仅汇总暂停、连接和现有数据状态，未覆盖所有故障；关联配置可能已变化。', 'Summarizes paused, connection and existing data states; it does not cover every fault. Referenced configuration may have changed.')}</small>
    </details>}
  </section>
}
const read = async (url: string, signal: AbortSignal) => { const response = await fetch(url, { signal, cache: 'no-store', headers: { 'X-ProbeStation-AI': '1' } }); if (!response.ok) throw new Error('Device summary unavailable'); return response.json() }
export function DeviceIssues({ onNavigate, english = false, get = read }: { onNavigate: (target: DataTarget) => void; english?: boolean; get?: (url: string, signal: AbortSignal) => Promise<unknown> }) {
  const reader = useMemo(() => new DeviceIssuesRead(), []), state = useSyncExternalStore(reader.subscribe, reader.snapshot, reader.snapshot), latest = useRef(get); latest.current = get
  useEffect(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout>
    const poll = async () => { await reader.refresh((url, signal) => latest.current(url, signal)); if (!stopped) timer = setTimeout(poll, 10000) }
    void poll(); return () => { stopped = true; clearTimeout(timer); reader.cancel() }
  }, [reader])
  return <DeviceIssuesView state={state} onNavigate={onNavigate} english={english} refresh={() => { void reader.refresh((url, signal) => latest.current(url, signal)) }} />
}
