import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { filterRuntimeLogs, RUNTIME_LOG_LIMIT, RUNTIME_LOG_PAGE_SIZE, RuntimeLogsRead, type RuntimeLogState } from './runtime-logs'

export function RuntimeLogsView({ state, refresh, english = false }: { state: RuntimeLogState; refresh: () => void; english?: boolean }) {
  const [query, setQuery] = useState(''), [level, setLevel] = useState<string | null>(null), [page, setPage] = useState(0)
  const text = (zh: string, en: string) => english ? en : zh, rows = state.rows ?? [], filtered = filterRuntimeLogs(rows, level, query), fresh = state.phase === 'ready'
  const levels = [...new Set([...rows.map(row => row.level), ...(level === null ? [] : [level])])].sort(), pages = Math.max(1, Math.ceil(filtered.length / RUNTIME_LOG_PAGE_SIZE)), current = Math.min(page, pages - 1)
  return <section className="runtime-logs" aria-label={text('近期运行日志（全服务）', 'Recent runtime logs (service-wide)')}>
    <div className="runtime-logs-heading"><strong>{text('近期运行日志（全服务）', 'Recent runtime logs (service-wide)')}</strong><button type="button" className="btn" disabled={state.phase === 'reading'} onClick={refresh}>{text('重新读取', 'Read again')}</button></div>
    {(state.phase === 'idle' || state.phase === 'reading') && <p role="status">{text(state.phase === 'idle' ? '尚未读取日志。' : '正在读取日志…', state.phase === 'idle' ? 'Logs have not been read.' : 'Reading logs…')}</p>}
    {state.phase === 'error' && <p className="chart-hint warn" role="alert">{text(state.error === 'timeout' ? '读取超过10秒，当前日志未核实。' : state.error === 'invalid' ? '日志响应异常，当前结果未核实。' : '日志读取失败，当前结果未核实。', state.error === 'timeout' ? 'Read exceeded 10 seconds; current logs are unverified.' : state.error === 'invalid' ? 'Invalid log response; current results are unverified.' : 'Log read failed; current results are unverified.')}</p>}
    {state.rows && <>
      <p>{text(state.phase === 'ready' ? '读取完成（UTC）' : '下方为上次读取快照（UTC）', state.phase === 'ready' ? 'Read completed (UTC)' : 'Previous read snapshot below (UTC)')}: {state.receivedAt}</p>
      <p>{text(fresh ? '本次快照' : '上次快照', fresh ? 'Snapshot' : 'Previous snapshot')}: {rows.length} · {text('筛选匹配', 'Matches')}: {filtered.length}{rows.length === RUNTIME_LOG_LIMIT && <> · {text(`已达${RUNTIME_LOG_LIMIT}条读取上限，可能还有更早日志。`, `Reached the ${RUNTIME_LOG_LIMIT}-row read limit; earlier logs may exist.`)}</>}</p>
      <div className="toolbar"><label>{text('级别', 'Level')}<select aria-label={text('日志级别', 'Log level')} value={level === null ? 'all' : 'level:' + level} onChange={e => { setLevel(e.target.value === 'all' ? null : e.target.value.slice(6)); setPage(0) }}><option value="all">{text('全部级别', 'All levels')}</option>{levels.map(value => <option key={value} value={'level:' + value}>{value || text('（空级别）', '(empty level)')}</option>)}</select></label>
        <label>{text('关键词', 'Keywords')}<input aria-label={text('搜索日志', 'Search logs')} value={query} placeholder={text('来源、消息、时间或ID；空格分词', 'Source, message, time or ID; space-separated terms')} onChange={e => { setQuery(e.target.value); setPage(0) }} /></label></div>
      {!rows.length ? <p>{text(`${fresh ? '本次' : '上次'}快照没有日志；不能据此判断设备或历史数据正常。`, `No logs in ${fresh ? 'this' : 'the previous'} snapshot; this does not establish device or history health.`)}</p> : !filtered.length ? <p>{text(`${fresh ? '本次' : '上次'}快照内无匹配日志，请调整筛选；未搜索更早记录。`, `No matches in ${fresh ? 'this' : 'the previous'} snapshot. Adjust filters; earlier records were not searched.`)}</p> : <>
        <div className="runtime-logs-scroll" tabIndex={0} role="region" aria-label={text('日志表格，可横向滚动', 'Log table, horizontally scrollable')}><table className="runtime-logs-table"><thead><tr>{['ID', text('后端记录时间', 'Backend timestamp'), text('级别', 'Level'), text('来源', 'Source'), text('消息', 'Message')].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead><tbody>{filtered.slice(current * RUNTIME_LOG_PAGE_SIZE, (current + 1) * RUNTIME_LOG_PAGE_SIZE).map(row => <tr key={row.id}><td>{row.id}</td><td>{row.ts || '—'}</td><td>{row.level || '—'}</td><td>{row.source || '—'}</td><td className="runtime-log-message">{row.message || text('（空消息）', '(empty message)')}</td></tr>)}</tbody></table></div>
        <div className="toolbar"><span>{text('页', 'Page')} {current + 1}/{pages}</span><button type="button" className="btn" disabled={current === 0} onClick={() => setPage(current - 1)}>{text('上一页', 'Previous')}</button><button type="button" className="btn" disabled={current + 1 === pages} onClick={() => setPage(current + 1)}>{text('下一页', 'Next')}</button></div>
      </>}
    </>}
    <small>{text(`仅手动读取最近${RUNTIME_LOG_LIMIT}条全服务日志，筛选仅作用于这份快照，不代表完整历史或某台设备。记录时间按后端原文显示，不转换时区；旧日志可能已被清理。本区不清理、写配置或调用模型。`, `Manually reads the latest ${RUNTIME_LOG_LIMIT} service-wide logs; filters apply only to this snapshot, not full history or a specific device. Backend timestamps are shown verbatim without zone conversion. Older logs may have been removed. This viewer never clears logs, writes settings or calls a model.`)}</small>
  </section>
}
const fetchLogs = async (url: string, signal: AbortSignal) => { const response = await fetch(url, { signal, cache: 'no-store' }); if (!response.ok) throw new Error('Runtime log read failed'); return response.json() }
export function RuntimeLogs({ english = false, reloadToken = 0, get = fetchLogs }: { english?: boolean; reloadToken?: number; get?: (url: string, signal: AbortSignal) => Promise<unknown> }) {
  const reader = useMemo(() => new RuntimeLogsRead(), []), latestGet = useRef(get); latestGet.current = get
  const state = useSyncExternalStore(reader.subscribe, reader.snapshot, reader.snapshot)
  const refresh = () => { void reader.refresh((url, signal) => latestGet.current(url, signal)) }
  useEffect(() => { refresh(); return () => reader.cancel() }, [reader, reloadToken])
  return <RuntimeLogsView state={state} refresh={refresh} english={english} />
}
