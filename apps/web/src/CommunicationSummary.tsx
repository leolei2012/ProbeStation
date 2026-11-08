import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { communicationScope, CommunicationSummaryRead } from './communication-summary'
import { DeferredCommunicationSummary } from './DeferredCommunicationSummary'

const read = async (url: string, signal: AbortSignal) => { const response = await fetch(url, { signal, cache: 'no-store' }); if (!response.ok) throw new Error('Communication summary unavailable'); return response.json() }
interface CommunicationProps { device: { id: number; transport: string; serialPath?: string | null; ip?: string; port?: number; baudRate?: number | null; parity?: string | null; stopBits?: number | null; dataBits?: number | null; flowControl?: string | null }; english?: boolean; get?: (url: string, signal: AbortSignal) => Promise<unknown> }
export function CommunicationSummary(props: CommunicationProps) {
  try { communicationScope(props.device) } catch { return <p role="alert">{props.english ? 'Cannot establish this device’s communication scope; no statistics requested.' : '当前设备通信来源无法核实，未请求统计。'}</p> }
  return <CommunicationSummaryControl {...props} />
}
function CommunicationSummaryControl({ device, english = false, get = read }: CommunicationProps) {
  const reader = useMemo(() => new CommunicationSummaryRead(communicationScope(device)), [device.id, device.transport, device.serialPath, device.ip, device.port, device.baudRate, device.parity, device.stopBits, device.dataBits, device.flowControl]), latestGet = useRef(get); latestGet.current = get
  const [open, setOpen] = useState(false), state = useSyncExternalStore(reader.subscribe, reader.snapshot, reader.snapshot)
  useEffect(() => { if (open) void reader.refresh((url, signal) => latestGet.current(url, signal)); return () => reader.cancel() }, [open, reader])
  return <div><button type="button" className="btn" aria-expanded={open} onClick={() => setOpen(value => !value)}>{english ? open ? 'Hide communication statistics' : 'View communication statistics' : open ? '收起通信统计' : '查看通信统计'}</button>{open && <DeferredCommunicationSummary state={state} english={english} refresh={() => { void reader.refresh((url, signal) => latestGet.current(url, signal)) }} />}</div>
}
