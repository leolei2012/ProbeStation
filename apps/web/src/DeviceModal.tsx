import React, { useId, useRef, useState } from 'react'
import { captureDeviceEditBaseline, type DeviceEditBaseline } from '../../../packages/core/src/device-settings-edit'
import { SerialPortPicker } from './SerialPortPicker'
import type { SerialPortList } from './serial-ports'

export type DeviceFields = { mode: string; name: string; ip: string; port: number; transport: string; serialPath: string; baudRate: number; parity: string; stopBits: number; dataBits: number; flowControl: string; slaveId: number; pollIntervalMs: number; timeoutMs: number }

export function DeviceModal({ t, initial, onClose, onSave, portFetcher }: { t: (key: string) => string; initial: DeviceEditBaseline | null; onClose: () => void; onSave: (f: DeviceFields, expected: DeviceEditBaseline | null) => Promise<void>; portFetcher?: (signal: AbortSignal) => Promise<SerialPortList> }) {
  const [opening] = useState(() => { try { return { expected: initial ? captureDeviceEditBaseline(initial) : null, error: '' } } catch { return { expected: null, error: '设备配置不完整，请关闭窗口并刷新后重新编辑。' } } })
  const [name, setName] = useState(initial?.name ?? '')
  const [mode, setMode] = useState(initial?.mode ?? 'master')
  const [transport, setTransport] = useState(initial?.transport ?? 'tcp')
  const [ip, setIp] = useState(initial?.ip ?? '')
  const [port, setPort] = useState(initial ? String(initial.port) : '8899')
  const [serialPath, setSerialPath] = useState(initial?.serialPath ?? '')
  const [baudRate, setBaudRate] = useState(initial ? String(initial.baudRate ?? 9600) : '9600')
  const [parity, setParity] = useState(initial?.parity ?? 'even')
  const [stopBits, setStopBits] = useState(initial ? String(initial.stopBits ?? 1) : '1')
  const [flowControl, setFlowControl] = useState(initial?.flowControl ?? 'none')
  const [slaveId, setSlaveId] = useState(initial ? String(initial.slaveId ?? 1) : '1')
  const [pollInterval, setPollInterval] = useState(initial ? String(initial.pollIntervalMs ?? 1000) : '1000')
  const [timeout, setTimeout_] = useState(initial ? String(initial.timeoutMs ?? 3000) : '3000')
  const [dataBits, setDataBits] = useState(String(initial?.dataBits ?? 8))
  const titleId = useId()
  const [busy, setBusy] = useState(false), [error, setError] = useState(opening.error)
  const locked = useRef(false)
  const save = async () => {
    if (locked.current || initial && !opening.expected) return
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
        if (e.key !== 'Tab') return
        const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)'))
        const first = items[0], last = items[items.length - 1]
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
      }}>
        <div className="device-modal-header"><h3 id={titleId}>{initial ? t('editDeviceTitle') : t('newDeviceTitle')}</h3><button type="button" className="modal-close" aria-label={t('cancel')} disabled={busy} onClick={onClose}>✕</button></div>
        <div className="device-modal-body">
          {initial && <p className="device-field-hint">{t('cancel') === 'Cancel' ? 'Saving checks the opening configuration. Conflicts reject the save and keep drafts; record changes, close and refresh before editing again. Saved configuration may have separate runtime warnings.' : '保存时核对打开时的配置；冲突会拒绝保存并保留草稿。请先记录修改，关闭并刷新后重新编辑。已保存配置的运行状态警告会单独提示。'}</p>}
          {error && <div className="write-msg error" role="alert">{error}</div>}

          <fieldset disabled={busy}>
            <legend>基本信息 / General</legend>
            <label className="device-field"><span>{t('name')}</span><input aria-label={t('name')} required pattern={'.*\\S.*'} value={name} onChange={e => setName(e.target.value)} autoFocus /></label>
            <label className="device-field"><span>{t('cancel') === 'Cancel' ? 'Device role' : '设备角色'}</span><select aria-label={t('cancel') === 'Cancel' ? 'Device role' : '设备角色'} value={mode} onChange={e => { const next = e.target.value; setMode(next); if (next === 'slave') { setIp('0.0.0.0'); setDataBits('8') } }}><option value="master">{t('cancel') === 'Cancel' ? 'Master · Poll external devices' : '主站 · 主动轮询外部设备'}</option><option value="slave">{t('cancel') === 'Cancel' ? 'Slave · Respond to external masters' : '从站 · 等待外部主站读写'}</option></select></label>
            <div className="device-transport" role="group" aria-label={t('transport')}>
              <button type="button" className={'btn' + (transport === 'tcp' ? ' selected' : '')} aria-pressed={transport === 'tcp'} onClick={() => setTransport('tcp')}>{t('transportTcp')}</button>
              <button type="button" className={'btn' + (transport === 'rtu' ? ' selected' : '')} aria-pressed={transport === 'rtu'} onClick={() => setTransport('rtu')}>{t('transportRtu')}</button>
            </div>
          </fieldset>
          <fieldset disabled={busy}>
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
          <fieldset disabled={busy}>
            <legend>{mode === 'slave' ? '从站设置 / Slave' : '采集设置 / Sampling'}</legend>
            <div className="device-field-grid">
              {textField(t('slaveIdLabel'), slaveId, setSlaveId, '1', { min: mode === 'slave' ? 1 : 0, max: 247 })}
              {mode === 'master' && textField(t('pollIntervalLabel'), pollInterval, setPollInterval, '1000', { min: 1, max: 2147483647 }, 'ms')}
              {mode === 'master' && textField(t('timeoutLabel'), timeout, setTimeout_, '3000', { min: 1, max: 2147483647 }, 'ms')}
            </div>
            {mode === 'slave' ? <p className="device-field-hint">从站等待外部主站读写。TCP 的 0.0.0.0 接受本机所有网卡连接；外部主站使用本机实际 IP。RTU 使用独占串口。</p> : <><p className="device-field-hint">{t('pollIntervalHint')}</p><p className="device-field-hint">{t('timeoutHint')}</p></>}
          </fieldset>
        </div>
        <div className="modal-actions device-modal-footer">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>{t('cancel')}</button>
          <button type="submit" className="btn primary" disabled={busy || !!initial && !opening.expected}>{busy ? t('working') : initial ? t('save') : t('add')}</button>
        </div>
      </form>
    </div>
  )
}
