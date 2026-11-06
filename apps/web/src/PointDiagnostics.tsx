import React, { useEffect, useRef, useState } from 'react'
import { filterPointDiagnosticIssues, filterRelatedDiagnosticIds, initialPointDiagnosticState, pointDiagnosticDownload, PointDiagnosticsLoader, type DiagnosticGroup, type DiagnosticPoint, type PointDiagnosticState } from './point-diagnostics'
import { PointLabel, type PointLabelData } from './PointLabel'

const PAGE_SIZE = 20
type Filter = { severity: 'all' | 'error' | 'warning'; query: string }

function RelatedPoints({ ids, points, pointLabels, english }: { ids: readonly number[]; points: readonly DiagnosticPoint[]; pointLabels: Map<number, PointLabelData>; english: boolean }) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [page, setPage] = useState(0)
  const text = (zh: string, en: string) => english ? en : zh
  const byId = new Map(points.map(p => [p.id, p]))
  const matched = filterRelatedDiagnosticIds(ids, query, points, pointLabels)
  const currentPage = Math.min(page, Math.max(0, Math.ceil(matched.length / PAGE_SIZE) - 1))
  return <details className="point-diagnostic-related" onToggle={e => setOpen(e.currentTarget.open)}>
    <summary>{text('关联点位', 'Related points')} · {ids.length}</summary>
    {open && <>
      <p className="chart-hint">{text('以下标签来自当前界面配置，可能与报告快照不同；未找到的ID仍保留。', 'Labels use current page definitions and may differ from the report snapshot. Missing IDs remain visible.')}</p>
      <input aria-label={text('筛选关联点位', 'Filter related points')} placeholder={text('名称、来源或精确 #ID', 'Name, source or exact #ID')} value={query} onChange={e => { setQuery(e.target.value); setPage(0) }} />
      <ul>{matched.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map(id => <li key={id}><PointLabel label={{ ...(pointLabels.get(id) ?? { name: '#' + id, detail: text('当前点表未找到', 'Not found in current definitions'), qualified: true }), qualified: true }} />{byId.has(id) && <small>{byId.get(id)!.dataType}</small>}</li>)}</ul>
      {!matched.length && <p role="status">{text('无匹配点位', 'No matching points')}</p>}
      {matched.length > PAGE_SIZE && <div className="pager"><button className="btn" type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>{text('上一页', 'Previous')}</button><span>{currentPage + 1} / {Math.ceil(matched.length / PAGE_SIZE)}</span><button className="btn" type="button" disabled={(currentPage + 1) * PAGE_SIZE >= matched.length} onClick={() => setPage(currentPage + 1)}>{text('下一页', 'Next')}</button></div>}
    </>}
  </details>
}

export function PointDiagnosticsView({ state, points, groups, pointLabels, refresh, download, filter, onFilter, page, onPage, english = false }: {
  state: PointDiagnosticState; points: readonly DiagnosticPoint[]; groups: readonly DiagnosticGroup[]; pointLabels: Map<number, PointLabelData>
  refresh: () => void; download: () => void; filter: Filter; onFilter: (next: Filter) => void; page: number; onPage: (next: number) => void; english?: boolean
}) {
  const text = (zh: string, en: string) => english ? en : zh
  const snapshot = state.status === 'ready' ? state.snapshot : null, report = snapshot?.report
  const issues = report ? filterPointDiagnosticIssues(report, filter.severity, filter.query, points, groups) : []
  const currentPage = Math.min(Math.max(0, page), Math.max(0, Math.ceil(issues.length / PAGE_SIZE) - 1))
  return <section className="point-diagnostics" aria-label={text('点表检查', 'Point table check')}>
    <p className="chart-hint">{text('只检查配置结构：点宽越界、引用、重复定义和可确定的冲突。不会连接设备或自动修改配置；无错误不代表在线、数据可信或测试通过。', 'Read-only structure checks: widths, references, duplicates and known conflicts. No device connection or automatic repair. No errors does not mean online, trustworthy data or a test PASS.')}</p>
    <div className="toolbar"><button className="btn" type="button" onClick={refresh} disabled={state.status === 'loading'}>{text('重新检查', 'Check again')}</button><button className="btn" type="button" disabled={!snapshot} onClick={download}>{text('下载完整诊断 JSON', 'Download full diagnostic JSON')}</button></div>
    {state.status === 'loading' && <p role="status">{text('正在检查点表…', 'Checking point table…')}</p>}
    {state.status === 'error' && <p role="alert" className="warn">{state.error === 'timeout' ? text('检查请求超时，请重新检查。', 'Check request timed out. Try again.') : state.error === 'invalid' ? text('诊断报告格式不完整或不一致，未作为有效结果显示，请重新检查。', 'Incomplete or inconsistent diagnostic report. Try again.') : text('点表检查失败，请重新检查；服务端可能尚未更新。', 'Check failed. Try again; the backend may need updating.')}</p>}
    {snapshot && report && <>
      <div className="point-diagnostic-summary" role="status"><strong>{text('错误', 'Errors')}: {report.summary.errors}</strong><strong>{text('警告', 'Warnings')}: {report.summary.warnings}</strong><span>{text('分组', 'Groups')}: {report.summary.groups} · {text('点位', 'Points')}: {report.summary.registers}</span><span>{text('兼容覆盖占位', 'Covered placeholders')}: {report.summary.coveredPlaceholders}</span></div>
      <p className="chart-hint">{text('设备ID', 'Device ID')} #{snapshot.deviceId} · {text('报告接收时间', 'Received')} <time>{snapshot.receivedAt}</time> · {text('配置快照；修改配置后请重新检查。', 'Configuration snapshot; recheck after configuration changes.')}</p>
      <div className="toolbar"><label>{text('级别', 'Severity')} <select value={filter.severity} onChange={e => onFilter({ ...filter, severity: e.target.value as Filter['severity'] })}><option value="all">{text('全部', 'All')}</option><option value="error">{text('错误', 'Errors')}</option><option value="warning">{text('警告', 'Warnings')}</option></select></label><label className="point-diagnostic-search">{text('筛选问题', 'Filter issues')} <input value={filter.query} placeholder={text('代码、说明、点位/组名或精确 #ID', 'Code, message, point/group name or exact #ID')} onChange={e => onFilter({ ...filter, query: e.target.value })} /></label><button type="button" className="btn" disabled={filter.severity === 'all' && !filter.query} onClick={() => onFilter({ severity: 'all', query: '' })}>{text('清除筛选', 'Clear filters')}</button></div>
      {!report.issues.length ? <p role="status">{text('本次结构检查未发现错误或警告。', 'No structural errors or warnings found.')}</p> : !issues.length ? <p role="status">{text('筛选后无匹配问题，完整报告仍保留。', 'No matching issues. The full report is retained.')}</p> : <>
        <p className="chart-hint">{text('匹配 / 全部问题', 'Matched / total issues')}: {issues.length} / {report.issues.length} · {text('仅分页显示，下载始终包含完整报告。', 'Paged display only; downloads always include the full report.')}</p>
        <ol className="point-diagnostic-issues" start={currentPage * PAGE_SIZE + 1}>{issues.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map((issue, index) => <li key={currentPage * PAGE_SIZE + index}>
          <div><strong className={issue.severity === 'error' ? 'warn' : ''}>{issue.severity === 'error' ? text('错误', 'Error') : text('警告', 'Warning')}</strong> · <code>{issue.code}</code></div><p>{issue.message}</p>
          <small>{[issue.path, issue.entityId === undefined ? '' : 'ID #' + issue.entityId, issue.groupId === undefined ? '' : text('分组', 'Group') + ' #' + issue.groupId + ' ' + (groups.find(g => g.id === issue.groupId)?.name ?? ''), issue.slaveId === undefined ? '' : text('配置从站', 'Configured slave') + ' ' + issue.slaveId, issue.area].filter(Boolean).join(' · ')}</small>
          {!!issue.registerIds?.length && <RelatedPoints key={JSON.stringify(issue.registerIds)} ids={[...new Set(issue.registerIds)]} points={points} pointLabels={pointLabels} english={english} />}
        </li>)}</ol>
        {issues.length > PAGE_SIZE && <div className="pager"><button type="button" className="btn" disabled={currentPage === 0} onClick={() => onPage(currentPage - 1)}>{text('上一页', 'Previous')}</button><span>{currentPage + 1} / {Math.ceil(issues.length / PAGE_SIZE)}</span><button type="button" className="btn" disabled={(currentPage + 1) * PAGE_SIZE >= issues.length} onClick={() => onPage(currentPage + 1)}>{text('下一页', 'Next')}</button></div>}
      </>}
    </>}
  </section>
}

export function PointDiagnosticsPanel({ deviceId, points, groups, pointLabels, fetcher, english }: {
  deviceId: number; points: readonly DiagnosticPoint[]; groups: readonly DiagnosticGroup[]; pointLabels: Map<number, PointLabelData>
  fetcher: (url: string, signal: AbortSignal) => Promise<unknown>; english?: boolean
}) {
  const [state, setState] = useState(initialPointDiagnosticState), [filter, setFilter] = useState<Filter>({ severity: 'all', query: '' }), [page, setPage] = useState(0)
  const loader = useRef<PointDiagnosticsLoader>()
  if (!loader.current) loader.current = new PointDiagnosticsLoader(setState)
  useEffect(() => { void loader.current!.refresh(deviceId, fetcher); return () => loader.current!.cancel() }, [deviceId, fetcher])
  const download = () => {
    if (state.status !== 'ready' || !state.snapshot || state.snapshot.deviceId !== deviceId) return
    const blob = new Blob([pointDiagnosticDownload(state.snapshot)], { type: 'application/json;charset=utf-8' }), url = URL.createObjectURL(blob), link = document.createElement('a')
    try { link.href = url; link.download = 'point-diagnostics-' + deviceId + '-' + state.snapshot.receivedAt.replace(/[:.]/g, '-') + '.json'; link.click() }
    finally { setTimeout(() => URL.revokeObjectURL(url), 1000) }
  }
  return <PointDiagnosticsView state={state.snapshot && state.snapshot.deviceId !== deviceId ? initialPointDiagnosticState() : state} points={points} groups={groups} pointLabels={pointLabels} english={english} filter={filter} onFilter={next => { setFilter(next); setPage(0) }} page={page} onPage={setPage} refresh={() => { setPage(0); void loader.current!.refresh(deviceId, fetcher) }} download={download} />
}
