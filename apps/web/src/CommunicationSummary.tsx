import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { communicationScope, CommunicationSummaryRead, type CommunicationReadState } from './communication-summary'

export function CommunicationSummaryView({ state, refresh, english = false }: { state: CommunicationReadState; refresh: () => void; english?: boolean }) {
  const text = (zh: string, en: string) => english ? en : zh, value = state.value, metrics = value?.metrics, current = state.phase === 'ready'
  return <section className="communication-summary" aria-label={text('通信统计只读快照', 'Read-only communication statistics')}>
    <div className="toolbar"><strong>{text('通信统计（只读快照）', 'Communication statistics (read-only snapshot)')}</strong><button type="button" className="btn" disabled={state.phase === 'loading'} onClick={refresh}>{text('重新读取统计', 'Read statistics again')}</button></div>
    {state.phase === 'loading' && <p role="status">{text('正在读取后台已有统计…', 'Reading existing backend statistics…')}</p>}
    {state.phase === 'error' && <p role="alert">{text(state.error === 'timeout' ? '读取超过10秒，当前统计未核实。' : state.error === 'invalid' ? '统计响应或来源不匹配，当前统计未核实。' : '统计读取失败，当前状态未核实。', state.error === 'timeout' ? 'Read exceeded 10 seconds; current statistics are unverified.' : state.error === 'invalid' ? 'Statistics or source mismatch; current statistics are unverified.' : 'Statistics read failed; current state is unverified.')}{value && text(' 下方保留上次结果。', ' The previous result is retained below.')}</p>}
    {value && <><p>{text(current ? '本次读取' : '上次结果，未核实当前状态', current ? 'Read at' : 'Previous result; current state unverified')}: {value.receivedAt} UTC · #{value.objectId}</p>
      <p>{value.scope === 'channel' ? text('共享串口通道统计：包含此通道其他设备/从站，不能归因到当前设备。', 'Shared serial-channel statistics include other devices/slaves on this channel; they cannot be attributed to this device.') : text('当前设备ID的后台统计；可能包含此前连接配置的累积记录。', 'Backend statistics for this device ID may include earlier connection configurations.')}</p>
      <p>{text('读取时后台驱动报告', 'Driver reported at read')}: {value.connected ? text('已连接', 'Connected') : text('未连接', 'Not connected')}</p>
      {!metrics ? <p role="status">{text('后台当前没有提供诊断计数；不将其当作零错误或通信正常。', 'No diagnostic counters are currently available; this does not mean zero errors or healthy communication.')}</p> : <>
        <dl className="communication-stats">{[[text('完成成功请求', 'Successful requests'), metrics.successCount], [text('完成失败请求', 'Failed requests'), metrics.errorCount], [text('其中超时', 'Timeouts included'), metrics.timeoutCount], [text('连续错误', 'Consecutive errors'), metrics.consecutiveErrors], [text('近期错误率（最多100次完成请求）', 'Recent error rate (up to 100 completed requests)'), metrics.successCount + metrics.errorCount ? (metrics.recentErrorRate * 100).toFixed(2) + '%' : text('尚无完成请求', 'No completed requests')], [text('末次 / 平均 / 最大耗时 ms', 'Last / mean / max duration ms'), [metrics.lastResponseMs, metrics.averageResponseMs, metrics.maxResponseMs].map(v => v === null ? '—' : String(v)).join(' / ')], [text('TX / RX 捕获次数', 'TX / RX captures'), metrics.txFrames + ' / ' + metrics.rxFrames], [text('通道/设备缓冲记录数', 'Buffered capture records'), metrics.bufferedFrames]].map(([label, result]) => <div key={label}><dt>{label}</dt><dd>{result}</dd></div>)}</dl>
        <p>{text('末次成功时间', 'Last success time')}: {metrics.lastSuccessTime ?? '—'}<br />{text('最近错误记录时间（可能已恢复）', 'Last error record time (may have recovered)')}: {metrics.lastErrorTime ?? '—'}</p>
        {metrics.lastError && <p className="communication-last-error">{text('最近错误记录（可能已恢复）', 'Last recorded error (may have recovered)')}: <code>{metrics.lastError.code}</code>{metrics.lastError.exceptionCode !== null && ' · exception ' + metrics.lastError.exceptionCode}<br />{metrics.lastError.message}</p>}
      </>}
    </>}
    <small>{text('手动读取的有限时刻快照，不自动更新；计数可跨驱动重建累计，清空诊断或重启可能重置。成功请求不等于业务测试通过；TX/RX捕获可能是字节块，差值不是丢包率。此入口不发送探测指令、不连接或重连、不清空、不调用模型，也不证明物理设备身份或采样历史完整。', 'Manually read point-in-time snapshot; no automatic refresh. Counts can survive driver rebuilds and reset on diagnostic clearing or restart. A successful request is not a business test pass; TX/RX captures may be byte chunks and their difference is not a packet-loss rate. This control never probes, connects, reconnects, clears or calls a model, and does not establish physical identity or history completeness.')}</small>
  </section>
}
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
  return <div><button type="button" className="btn" aria-expanded={open} onClick={() => setOpen(value => !value)}>{english ? open ? 'Hide communication statistics' : 'View communication statistics' : open ? '收起通信统计' : '查看通信统计'}</button>{open && <CommunicationSummaryView state={state} english={english} refresh={() => { void reader.refresh((url, signal) => latestGet.current(url, signal)) }} />}</div>
}
