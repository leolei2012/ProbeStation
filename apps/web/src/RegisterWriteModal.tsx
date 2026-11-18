import { useEffect, useId, useRef, useState } from 'react'
import type { GuardedWriteResult, RegisterWriteSource } from '../../../packages/core/src/guarded-register-write'

async function writeRequest(path: string, body?: unknown, timeout = 15000): Promise<GuardedWriteResult> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'x-probestation-write': '1' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || data.message || `HTTP ${response.status}`)
    if (data.version !== 1 || typeof data.id !== 'string' || data.plan?.version !== 1 || data.plan?.id !== data.id || !Array.isArray(data.plan.words) || data.plan.words.length < 1 || data.plan.words.length > 4 || data.plan.words.some((w: unknown) => !Number.isInteger(w) || Number(w) < 0 || Number(w) > 65535) || !data.plan.source?.device || !data.plan.source?.group || !data.plan.source?.register || !Number.isFinite(data.plan.expiresAt) || !Number.isFinite(data.plan.timeoutMs) || !['prepared', 'sending', 'acknowledged', 'not-sent', 'unknown', 'reviewed-unknown'].includes(data.state)) throw new Error('后台返回了不支持的写入协议，请核对前后端版本。')
    return data
  } finally { clearTimeout(timer) }
}

/** Prepare is read-only. Confirmation executes exactly the frozen server plan, once, without fallback. */
export function RegisterWriteModal({ source, currentValue, english, onClose }: { source: RegisterWriteSource; currentValue: string; english: boolean; onClose: () => void }) {
  const [opening] = useState(() => JSON.parse(JSON.stringify(source)) as RegisterWriteSource)
  const [value, setValue] = useState(''), [operation, setOperation] = useState<GuardedWriteResult | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [uncertain, setUncertain] = useState(false)
  const [restoring, setRestoring] = useState(true), [reviewed, setReviewed] = useState(false)
  const lock = useRef(false), live = useRef(true), id = useId()
  const dialog = useRef<HTMLDivElement>(null)
  const storageKey = 'ps-register-write:' + JSON.stringify([opening.device.id, opening.device.transport, opening.device.ip, opening.device.port, opening.device.serialPath, opening.group.id, opening.register.id])
  const changed = JSON.stringify(source) !== JSON.stringify(opening)
  useEffect(() => {
    if (typeof document === 'undefined') return
    const opener = document.activeElement as HTMLElement | null
    return () => { if (opener?.isConnected) opener.focus() }
  }, [])
  useEffect(() => {
    if (restoring || busy) return
    dialog.current?.querySelector<HTMLElement>('input:not(:disabled), button.btn.primary:not(:disabled), button:not(:disabled)')?.focus()
  }, [restoring, busy, operation?.state])
  useEffect(() => {
    live.current = true
    const restore = async () => {
      try {
        const saved = sessionStorage.getItem(storageKey)
        if (!saved) return
        const result = await writeRequest('/api/register-writes/' + encodeURIComponent(saved))
        if (live.current) { setOperation(result); setValue(result.plan.value) }
      } catch (e) { if (live.current) setError((english ? 'Could not restore the previous write. Do not resend until checked: ' : '无法恢复上次写入，请先核实，勿重复发送：') + String(e)) }
      finally { if (live.current) setRestoring(false) }
    }
    void restore()
    return () => { live.current = false }
  }, [storageKey])
  async function act(task: () => Promise<void>) {
    if (lock.current) return
    lock.current = true; setBusy(true); setError('')
    try { await task() } catch (e) { if (live.current) setError(e instanceof Error ? e.message : String(e)) }
    finally { lock.current = false; if (live.current) setBusy(false) }
  }
  const prepare = () => act(async () => {
    const result = await writeRequest('/api/registers/' + opening.register.id + '/write/prepare', { version: 1, source: opening, value })
    // Publish the operation ID locally before any execute is permitted; a reload must never replay a write.
    sessionStorage.setItem(storageKey, result.id)
    if (live.current) { setOperation(result); setUncertain(false) }
  })
  const execute = () => act(async () => {
    if (!operation || operation.state !== 'prepared' || changed || uncertain) return
    if (Date.now() > operation.plan.expiresAt) throw new Error(text('写入计划已过期，请修改输入后重新准备。', 'The plan expired. Edit the value and prepare again.'))
    const planId = operation.id
    setUncertain(true)
    const result = await writeRequest('/api/register-writes/' + planId + '/execute', { version: 1 }, operation.plan.timeoutMs * 3 + 15000)
    if (live.current) { setOperation(result); setUncertain(false) }
  })
  const query = () => act(async () => {
    if (!operation) return
    const result = await writeRequest('/api/register-writes/' + operation.id)
    if (live.current) { setOperation(result); setUncertain(false) }
  })
  const reset = () => { sessionStorage.removeItem(storageKey); setOperation(null); setUncertain(false); setReviewed(false); setError('') }
  const plan = operation?.plan, shown = plan?.source ?? opening
  const pending = uncertain || operation?.state === 'sending'
  const unknown = operation?.state === 'unknown'
  const disabled = busy || restoring || changed || !value.trim() || !!operation
  const text = (zh: string, en: string) => english ? en : zh
  return <div className="modal-mask"><div ref={dialog} className="modal register-write-modal" role="dialog" aria-modal="true" aria-labelledby={id + '-title'} aria-describedby={id + '-help'} onKeyDown={e => {
    if (e.key === 'Escape' && !busy) { e.stopPropagation(); onClose() }
    if (e.key === 'Tab') {
      const controls = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)'))
      const first = controls[0], last = controls.at(-1)
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
    }
  }}>
    <h3 id={id + '-title'}>{text('写入寄存器', 'Write register')}</h3>
    <div className="write-context"><strong>{shown.device.name}</strong><span>{text('当前显示值', 'Current displayed value')}: {currentValue}</span></div>
    <p className="kv">{shown.device.transport.toUpperCase()} · {shown.device.transport === 'tcp' ? `${shown.device.ip}:${shown.device.port}` : `${shown.device.serialPath} · ${shown.device.baudRate} ${shown.device.parity} ${shown.device.stopBits}`}</p>
    <p className="kv">{text('从站', 'Unit')} {shown.group.slaveId} · {shown.register.alias || '#' + shown.register.id} · 0x{shown.register.startAddress.toString(16).toUpperCase()} ({shown.register.startAddress}) · {shown.register.dataType}</p>
    <p id={id + '-help'} className="kv">{text('输入原始值，不应用系数和偏移。先准备并核对来源，再确认发送；分组无需切换写模式。', 'Enter a raw value without scale or offset. Prepare, verify the destination, then confirm. Group write mode is not required.')}</p>
    <label htmlFor={id + '-value'}>{text('原始写入值', 'Raw write value')}</label>
    <input id={id + '-value'} value={value} autoFocus disabled={busy || !!operation || restoring} onChange={e => setValue(e.target.value)} aria-describedby={id + '-help'} placeholder={shown.register.dataType.startsWith('hex') ? '0x0001' : '0 / 1'} />
    {restoring && <p role="status">{text('正在检查上次写入…', 'Checking the previous operation…')}</p>}
    {changed && <p className="write-msg error" role="alert">{text('打开弹窗后配置已变化，请关闭后重新打开并确认来源。', 'Configuration changed. Close and reopen to review the destination.')}</p>}
    {plan && <div className="write-plan" role="status"><strong>{text('已绑定的写入计划', 'Bound write plan')}</strong><p>FC{plan.functionCode} · {text('原始值', 'Raw value')} {plan.value} · {text('发送字', 'Words')}: {plan.words.map(w => '0x' + w.toString(16).toUpperCase().padStart(4, '0')).join(' ')}</p><small>{text('操作编号', 'Operation ID')}: {plan.id}</small></div>}
    {operation?.message && <p className={'write-msg ' + (operation.state === 'acknowledged' ? 'ok' : 'error')} role="status">{operation.message}</p>}
    {pending && <p className="write-msg error" role="status">{text('请求可能已发送。只查询原操作结果，不重复提交。', 'The command may have been sent. Query this operation; do not resubmit.')}</p>}
    {error && <p className="write-msg error" role="alert">{error}</p>}
    {unknown && <label className="write-review"><input type="checkbox" checked={reviewed} disabled={busy} onChange={e => setReviewed(e.target.checked)} />{text('我已现场核实原操作，不要求重发；允许重新准备新的指令。', 'I checked the device on site. Do not replay this operation; allow a new plan.')}</label>}
    <div className="modal-actions">
      <button className="btn" type="button" disabled={busy} onClick={onClose}>{text('关闭', 'Close')}</button>
      {!operation && <button className="btn primary" type="button" disabled={disabled} onClick={() => void prepare()}>{text('准备写入', 'Prepare write')}</button>}
      {operation?.state === 'prepared' && !uncertain && <><button className="btn" type="button" disabled={busy} onClick={reset}>{text('修改输入', 'Edit value')}</button><button className="btn primary" type="button" disabled={busy || changed || Date.now() > operation.plan.expiresAt} onClick={() => void execute()}>{text('确认写入', 'Confirm write')}</button></>}
      {(pending || unknown) && <button className="btn" type="button" disabled={busy} onClick={() => void query()}>{text('查询结果', 'Check result')}</button>}
      {unknown && <button className="btn" type="button" disabled={busy || !reviewed} onClick={() => void act(async () => { const result = await writeRequest('/api/register-writes/' + operation!.id + '/review-unknown', { confirmedOnSite: true }); if (live.current) { setOperation(result); setUncertain(false) } })}>{text('记录现场核实', 'Record review')}</button>}
      {operation && ['acknowledged', 'not-sent', 'reviewed-unknown'].includes(operation.state) && <button className="btn" type="button" disabled={busy} onClick={reset}>{text('准备新指令', 'New plan')}</button>}
    </div>
  </div></div>
}
export default RegisterWriteModal
