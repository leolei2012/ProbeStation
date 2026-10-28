import React, { useEffect, useRef, useState, useId } from 'react'
import { SerialPortLoader, initialSerialPortState, serialPortChoices, type SerialPortList, type SerialPortState } from './serial-ports'

export function SerialPortPickerView({ value, onChange, state, refresh, english = false }: {
  value: string; onChange: (value: string) => void; state: SerialPortState; refresh: () => void; english?: boolean
}) {
  const inputId = useId(), hintId = useId()
  const text = (zh: string, en: string) => english ? en : zh
  const choices = serialPortChoices(state.ports, value)
  return <div className="serial-port-picker">
    <label className="device-field"><span>{text('系统可发现串口', 'System serial ports')}</span>
      <span className="serial-port-list-row"><select aria-label={text('系统可发现串口', 'System serial ports')} value={value} onChange={e => onChange(e.target.value)} aria-describedby={hintId}>
        <option value="">{text('请选择，或在下方手工输入', 'Select, or type a path below')}</option>
        {choices.map(p => <option key={p.value} value={p.value}>{p.label}{!p.discovered ? text('（当前/手工值，未在清单中）', ' (current/manual path, not listed)') : ''}</option>)}
      </select><button type="button" className="btn" onClick={refresh} disabled={state.status === 'loading'}>{text('刷新', 'Refresh')}</button></span>
    </label>
    <label className="device-field" htmlFor={inputId}><span>{text('串口路径', 'Serial path')}</span><input id={inputId} aria-label={text('串口路径', 'Serial path')} required pattern={'.*\\S.*'} value={value} onChange={e => onChange(e.target.value)} placeholder="COM3 / /dev/ttyUSB0" aria-describedby={hintId} /></label>
    <div id={hintId} className="serial-port-hint">
      <span>{state.source === 'mock' ? text('模拟端口清单，不是实机端口。', 'Mock list, not actual system ports.') : text('清单来自运行后端的电脑；只枚举，不连接。可继续手工输入。', 'Ports on the backend computer; enumeration only. Manual input is supported.')}</span>
      {state.status === 'loading' && <span role="status">{text('正在读取串口清单…', 'Loading serial ports…')}</span>}
      {state.status === 'ready' && state.ports.length === 0 && <span role="status">{text('系统未发现串口，可手工输入路径后保留。', 'No system ports found. You can keep a manually entered path.')}</span>}
      {state.status === 'error' && <span className="warn" role="alert">{text('读取失败，请刷新重试或手工输入。已有清单可能已过时，已填路径保持不变。', 'Could not load ports. Refresh or enter a path. Previous results may be stale; your path is unchanged.')}</span>}
    </div>
  </div>
}

async function fetchPorts(signal: AbortSignal): Promise<SerialPortList> {
  const response = await fetch('/api/serial-ports', { signal, cache: 'no-store' })
  if (!response.ok) throw new Error('Serial enumeration failed')
  return response.json()
}

export function SerialPortPicker({ value, onChange, english = false }: { value: string; onChange: (value: string) => void; english?: boolean }) {
  const [state, setState] = useState(initialSerialPortState)
  const loader = useRef<SerialPortLoader>()
  if (!loader.current) loader.current = new SerialPortLoader(setState)
  useEffect(() => { void loader.current!.refresh(fetchPorts); return () => loader.current!.cancel() }, [])
  return <SerialPortPickerView value={value} onChange={onChange} state={state} refresh={() => { void loader.current!.refresh(fetchPorts) }} english={english} />
}
