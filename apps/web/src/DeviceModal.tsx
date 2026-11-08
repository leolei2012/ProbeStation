import type { DraftRegistration } from './draft-navigation'
import React, { useEffect, useId, useRef, useState } from 'react'
import { captureDeviceEditBaseline, type DeviceEditBaseline } from '../../../packages/core/src/device-settings-edit'
import { SerialPortPicker } from './SerialPortPicker'
import type { SerialPortList } from './serial-ports'
import { deviceDraftFields, deviceDraftChanged } from './device-draft-close'
import { PointDraftCloseGuard } from './point-draft-close'
import { PointDraftDiscard } from './PointDraftDiscard'

export type DeviceFields = { mode: string; name: string; ip: string; port: number; transport: string; serialPath: string; baudRate: number; parity: string; stopBits: number; dataBits: number; flowControl: string; slaveId: number; pollIntervalMs: number; timeoutMs: number }

export function DeviceModal({ t, initial, onClose, onSave, portFetcher, draftScope }: { t: (key: string) => string; initial: DeviceEditBaseline | null; onClose: () => void; onSave: (f: DeviceFields, expected: DeviceEditBaseline | null) => Promise<void>; portFetcher?: (signal: AbortSignal) => Promise<SerialPortList>; draftScope?: DraftRegistration }) {
  const [opening] = useState(() => { const fields = deviceDraftFields(initial); try { return { fields, expected: initial ? captureDeviceEditBaseline(initial) : null, error: '' } } catch { return { fields, expected: null, error: '设备配置不完整，请关闭窗口并刷新后重新编辑。' } } })
  const [name, setName] = useState(opening.fields.name)
  const [mode, setMode] = useState(opening.fields.mode)
  const [transport, setTransport] = useState(opening.fields.transport)
  const [ip, setIp] = useState(opening.fields.ip)
  const [port, setPort] = useState(opening.fields.port)
  const [serialPath, setSerialPath] = useState(opening.fields.serialPath)
  const [baudRate, setBaudRate] = useState(opening.fields.baudRate)
  const [parity, setParity] = useState(opening.fields.parity)
  const [stopBits, setStopBits] = useState(opening.fields.stopBits)
  const [flowControl, setFlowControl] = useState(opening.fields.flowControl)
  const [slaveId, setSlaveId] = useState(opening.fields.slaveId)
  const [pollInterval, setPollInterval] = useState(opening.fields.pollInterval)
  const [timeout, setTimeout_] = useState(opening.fields.timeout)
  const [dataBits, setDataBits] = useState(opening.fields.dataBits)
  const titleId = useId()
  const [busy, setBusy] = useState(false), [error, setError] = useState(opening.error)
  const locked = useRef(false)
  const [closeGuard] = useState(() => new PointDraftCloseGuard()), [discarding, setDiscarding] = useState(false)
  const resumeButton = useRef<HTMLButtonElement>(null), closeTrigger = useRef<HTMLElement | null>(null), restoreFocus = useRef(false)
  const dirty = deviceDraftChanged(opening.fields, { name, mode, transport, ip, port, serialPath, baudRate, parity, stopBits, flowControl, slaveId, pollInterval, timeout, dataBits })
  const detached = useRef(false)
  const navigationState = useRef(() => ({ dirty: false, busy: false }))
  navigationState.current = () => ({ dirty: !detached.current && dirty && (closeGuard.canSave || closeGuard.confirming), busy: locked.current })
  const snapshotState = useRef(() => ({ context: '', text: '' }))
  snapshotState.current = () => { detached.current = true; return { context: opening.fields.name, text: JSON.stringify({ opening: opening.fields, fields: { name, mode, transport, ip, port, serialPath, baudRate, parity, stopBits, flowControl, slaveId, pollInterval, timeout, dataBits } }, null, 2) } }
  useEffect(() => draftScope?.register('device', () => navigationState.current(), () => snapshotState.current()), [draftScope])
  const closeAction = (action: 'none' | 'prompt' | 'resume' | 'close') => {
    if (action === 'none') return
    setDiscarding(closeGuard.confirming)
    if (action === 'prompt') closeTrigger.current = document.activeElement as HTMLElement | null
    if (action === 'resume') restoreFocus.current = true
    if (action === 'close') onClose()
  }
  useEffect(() => { if (discarding) resumeButton.current?.focus(); else if (restoreFocus.current) { restoreFocus.current = false; if (closeTrigger.current?.isConnected) closeTrigger.current.focus() } }, [discarding])
  const requestClose = () => closeAction(closeGuard.request(!detached.current && dirty, locked.current))
  const save = async () => {
    if (detached.current || locked.current || !closeGuard.canSave || initial && !opening.expected) return
    locked.current = true; setBusy(true); setError('')
    try { await onSave({ mode, name: name.trim(), ip: ip.trim(), port: transport === 'tcp' ? Number(port) : opening.expected?.port ?? 8899, transport, serialPath: serialPath.trim(), baudRate: Number(baudRate), parity, stopBits: Number(stopBits), dataBits: Number(dataBits), flowControl, slaveId: Number(slaveId), pollIntervalMs: Number(pollInterval), timeoutMs: Number(timeout) }, opening.expected) }
    catch (e) { setError(e instanceof Error ? e.message : t('operationFailed')) }
    finally { locked.current = false; setBusy(false) }
  }
  const textField = (label: string, value: string, change: (value: string) => void, placeholder = '', numeric?: { min: number; max?: number }, unit?: string) => (
    <label className="device-field"><span>{label}</span><span className="device-input-wrap">
      <input aria-label={label} required type={numeric ? 'number' : 'text'} min={numeric?.min} max={numeric?.max} step={numeric ? 1 : undefined} value={value} onChange={e => change(e.target.value)} placeholder={placeholder} pattern={numeric ? undefined : '.*\\S.*'} />
      {unit && <span className="device-input-unit">{unit}</span>}
    </span></label>
  )
  const selectField = (label: string, value: string, change: (value: string) => void, options: string[]) => (
    <label className="device-field"><span>{label}</span><select aria-label={label} value={value} onChange={e => change(e.target.value)}>{options.map(v => <option key={v} value={v}>{v}</option>)}</select></label>
  )
  return (
    <div className="modal-mask">
      <form className="modal device-modal" role="dialog" aria-modal="true" aria-labelledby={titleId} onSubmit={e => { e.preventDefault(); if (!busy) void save() }} onKeyDown={e => {
        if (e.key === 'Escape' && !e.nativeEvent.isComposing) { e.preventDefault(); e.stopPropagation(); if (closeGuard.confirming) closeAction(closeGuard.resume(locked.current)); else requestClose(); return }
        if (e.key !== 'Tab') return
        const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)'))
        const first = items[0], last = items[items.length - 1]
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
      }}>
        <div className="device-modal-header"><h3 id={titleId}>{initial ? t('editDeviceTitle') : t('newDeviceTitle')}</h3><button type="button" className="modal-close" aria-label={t('cancel')} disabled={busy || discarding} onClick={requestClose}>✕</button></div>
        <div className="device-modal-body">
          {initial && <p className="device-field-hint">{t('cancel') === 'Cancel' ? 'Saving checks the opening configuration. Conflicts reject the save and keep drafts; record changes, close and refresh before editing again. Saved configuration may have separate runtime warnings.' : '保存时核对打开时的配置；冲突会拒绝保存并保留草稿。请先记录修改，关闭并刷新后重新编辑。已保存配置的运行状态警告会单独提示。'}</p>}
          {error && <div className="write-msg error" role="alert">{error}</div>}
          {detached.current && <p role="alert">{t('cancel') === 'Cancel' ? 'This editor was detached after the device disappeared. Editing and new saves are disabled. See the read-only page record; close and review the current configuration before opening a new editor.' : '设备曾从清单移除，此旧编辑器已停用编辑与新保存。请查看页面只读记录，关闭并核对当前配置后重新打开编辑器。'}</p>}

          <fieldset disabled={busy || discarding || detached.current}>
            <legend>基本信息 / General</legend>
            <label className="device-field"><span>{t('name')}</span><input aria-label={t('name')} required pattern={'.*\\S.*'} value={name} onChange={e => setName(e.target.value)} autoFocus /></label>
            <label className="device-field"><span>{t('cancel') === 'Cancel' ? 'Device role' : '设备角色'}</span><select aria-label={t('cancel') === 'Cancel' ? 'Device role' : '设备角色'} value={mode} onChange={e => { const next = e.target.value; setMode(next); if (next === 'slave') { setIp('0.0.0.0'); setDataBits('8') } }}><option value="master">{t('cancel') === 'Cancel' ? 'Master · Poll external devices' : '主站 · 主动轮询外部设备'}</option><option value="slave">{t('cancel') === 'Cancel' ? 'Slave · Respond to external masters' : '从站 · 等待外部主站读写'}</option></select></label>
            <div className="device-transport" role="group" aria-label={t('transport')}>
              <button type="button" className={'btn' + (transport === 'tcp' ? ' selected' : '')} aria-pressed={transport === 'tcp'} onClick={() => setTransport('tcp')}>{t('transportTcp')}</button>
              <button type="button" className={'btn' + (transport === 'rtu' ? ' selected' : '')} aria-pressed={transport === 'rtu'} onClick={() => setTransport('rtu')}>{t('transportRtu')}</button>
            </div>
          </fieldset>
          <fieldset disabled={busy || discarding || detached.current}>
            <legend>连接参数 / Connection</legend>
            <div className="device-field-grid">
              {transport === 'tcp' ? <>
                {textField(mode === 'slave' ? '监听地址 / Bind address' : t('ip'), ip, setIp, mode === 'slave' ? '0.0.0.0' : '192.168.1.10')}
                {textField(mode === 'slave' ? '监听端口 / Listen port' : t('port'), port, setPort, '8899', { min: 1, max: 65535 })}
              </> : <>
                <SerialPortPicker fetcher={portFetcher} value={serialPath} onChange={setSerialPath} english={t('cancel') === 'Cancel'} />
                {textField(t('baudRate'), baudRate, setBaudRate, '9600', { min: 1 })}
                {selectField(t('parity'), parity, setParity, ['even', 'odd', 'none'])}
                {selectField('数据位 / Data bits', dataBits, setDataBits, mode === 'slave' ? ['8'] : ['5', '6', '7', '8'])}
                {selectField(t('stopBits'), stopBits, setStopBits, ['1', '2'])}
                {selectField(t('flowControl'), flowControl, setFlowControl, ['none', 'rtscts', 'xonxoff'])}
              </>}
            </div>
          </fieldset>
          <fieldset disabled={busy || discarding || detached.current}>
            <legend>{mode === 'slave' ? '从站设置 / Slave' : '采集设置 / Sampling'}</legend>
            <div className="device-field-grid">
              {textField(t('slaveIdLabel'), slaveId, setSlaveId, '1', { min: mode === 'slave' ? 1 : 0, max: 247 })}
              {mode === 'master' && textField(t('pollIntervalLabel'), pollInterval, setPollInterval, '1000', { min: 1, max: 2147483647 }, 'ms')}
              {mode === 'master' && textField(t('timeoutLabel'), timeout, setTimeout_, '3000', { min: 1, max: 2147483647 }, 'ms')}
            </div>
            {mode === 'slave' ? <p className="device-field-hint">从站等待外部主站读写。TCP 的 0.0.0.0 接受本机所有网卡连接；外部主站使用本机实际 IP。RTU 使用独占串口。</p> : <><p className="device-field-hint">{t('pollIntervalHint')}</p><p className="device-field-hint">{t('timeoutHint')}</p></>}
          </fieldset>
          {discarding && <PointDraftDiscard ref={resumeButton} label={t('cancel') === 'Cancel' ? 'Device draft close confirmation' : '确认关闭设备草稿'} english={t('cancel') === 'Cancel'} busy={busy} onResume={() => closeAction(closeGuard.resume(locked.current))} onDiscard={() => closeAction(closeGuard.discard(locked.current))} />}
        </div>
        <div className="modal-actions device-modal-footer">
          <button type="button" className="btn" disabled={busy || discarding} onClick={requestClose}>{t('cancel')}</button>
          <button type="submit" className="btn primary" disabled={busy || discarding || detached.current || !!initial && !opening.expected}>{busy ? t('working') : initial ? t('save') : t('add')}</button>
        </div>
      </form>
    </div>
  )
}
