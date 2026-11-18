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

/** One click prepares and executes the bound plan. Recovery never creates another operation automatically. */
export function RegisterWriteModal({ source, currentValue, english, onClose }: { source: RegisterWriteSource; currentValue: string; english: boolean; onClose: () => void }) {
  const [opening] = useState(() => JSON.parse(JSON.stringify(source)) as RegisterWriteSource)
  const [value, setValue] = useState(''), [operation, setOperation] = useState<GuardedWriteResult | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [uncertain, setUncertain] = useState(false)
  const [restoring, setRestoring] = useState(true), [reviewed, setReviewed] = useState(false)
  const lock = useRef(false), live = useRef(true), id = useId()
  const dialog = useRef<HTMLDivElement>(null)
  const storageKey = 'ps-register-write:' + JSON.stringify([opening.device.id, opening.device.transport, opening.device.ip, opening.device.port, opening.device.serialPath, opening.group.id, opening.register.id])
  const changed = JSON.stringify(source) !== JSON.stringify(opening)
  const changedRef = useRef(changed)
  changedRef.current = changed
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
  const write = () => act(async () => {
    if (restoring || changedRef.current || uncertain || operation?.state === 'sending' || operation?.state === 'unknown' || !value.trim()) return
    if (operation?.state !== 'prepared') setOperation(null)
    // Retained prepared operations keep their ID; a delayed original request cannot become a second command.
    const prepared = operation?.state === 'prepared' ? operation : await writeRequest('/api/registers/' + opening.register.id + '/write/prepare', { version: 1, source: opening, value })
    if (!live.current) return
    if (prepared.state !== 'prepared' || JSON.stringify(prepared.plan.source) !== JSON.stringify(opening)) throw new Error(text('写入目标不匹配，请重新打开窗口。', 'The write destination does not match. Reopen the dialog.'))
    sessionStorage.setItem(storageKey, prepared.id)
    setOperation(prepared)
    if (changedRef.current) throw new Error(text('配置已变化，本次未发送，请重新打开窗口。', 'Configuration changed. Nothing sent; reopen the dialog.'))
    if (Date.now() > prepared.plan.expiresAt) throw new Error(text('待处理写入已过期，请取消后重新写入。', 'The pending write expired. Cancel it and write again.'))
    setUncertain(true)
    const result = await writeRequest('/api/register-writes/' + prepared.id + '/execute', { version: 1 }, prepared.plan.timeoutMs * 3 + 15000)
    if (live.current) { setOperation(result); setUncertain(false) }
  })
  const query = () => act(async () => {
    if (!operation) return
    const result = await writeRequest('/api/register-writes/' + operation.id)
    if (live.current) { setOperation(result); setUncertain(result.state === 'prepared') }
  })
  const cancel = () => act(async () => {
    if (!operation) return
    const result = await writeRequest('/api/register-writes/' + operation.id + '/cancel', { version: 1 })
    if (live.current) { setOperation(result); setUncertain(result.state === 'sending' || result.state === 'unknown') }
  })
  const plan = operation?.plan, shown = plan?.source ?? opening
  const pending = uncertain || operation?.state === 'sending'
  const unknown = operation?.state === 'unknown'
  const disabled = busy || restoring || changed || !value.trim() || pending || unknown
  const editable = !busy && !restoring && !pending && !unknown && operation?.state !== 'prepared'
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
    <p id={id + '-help'} className="kv">{text('输入原始值，点击写入。', 'Enter a raw value and click Write.')}</p>
    <label htmlFor={id + '-value'}>{text('原始写入值', 'Raw write value')}</label>
    <input id={id + '-value'} value={value} autoFocus disabled={!editable} onChange={e => { setValue(e.target.value); setOperation(null); setError(''); setReviewed(false) }} onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && !disabled) { e.preventDefault(); void write() } }} aria-describedby={id + '-help'} placeholder={shown.register.dataType.startsWith('hex') ? '0x0001' : text('输入数值', 'Enter a value')} />
    {restoring && <p role="status">{text('正在检查上次写入…', 'Checking the previous operation…')}</p>}
    {changed && <p className="write-msg error" role="alert">{text('打开弹窗后配置已变化，请关闭后重新打开并确认来源。', 'Configuration changed. Close and reopen to review the destination.')}</p>}
    {operation?.state === 'acknowledged' && <p className="write-msg ok" role="status">{text('写入成功', 'Write successful')}</p>}
    {operation?.state !== 'acknowledged' && operation?.message && <p className="write-msg error" role="status">{operation.message}</p>}
    {!busy && pending && <p className="write-msg error" role="status">{text('结果尚未确认，请查询本次写入，勿重复发送。', 'Result not confirmed. Check this write before sending again.')}</p>}
    {error && <p className="write-msg error" role="alert">{error}</p>}
    {unknown && <label className="write-review"><input type="checkbox" checked={reviewed} disabled={busy} onChange={e => setReviewed(e.target.checked)} />{text('我已现场核实原操作，不要求重发；允许重新准备新的指令。', 'I checked the device on site. Do not replay this operation; allow a new plan.')}</label>}
    <div className="modal-actions">
      <button className="btn" type="button" disabled={busy} onClick={onClose}>{text('关闭', 'Close')}</button>
      <button className="btn primary" type="button" disabled={disabled} onClick={() => void write()}>{busy ? text('写入中…', 'Writing…') : text('写入', 'Write')}</button>
      {!busy && (pending || unknown) && <button className="btn" type="button" onClick={() => void query()}>{text('查询结果', 'Check result')}</button>}
      {unknown && <button className="btn" type="button" disabled={busy || !reviewed} onClick={() => void act(async () => { const result = await writeRequest('/api/register-writes/' + operation!.id + '/review-unknown', { confirmedOnSite: true }); if (live.current) { setOperation(result); setUncertain(false) } })}>{text('记录现场核实', 'Record review')}</button>}
      {!busy && operation?.state === 'prepared' && <button className="btn" type="button" onClick={() => void cancel()}>{text('取消待处理写入', 'Cancel pending write')}</button>}
    </div>
  </div></div>
}
export default RegisterWriteModal
