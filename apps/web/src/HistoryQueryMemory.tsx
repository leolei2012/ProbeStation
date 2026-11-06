import React, { useMemo, useState, useSyncExternalStore } from 'react'
import { HistoryQueryMemory, QueryMemoryError, rememberedQueryCompatibility, type QueryMemoryContext, type RememberedQuery } from './history-query-memory'

const PAGE_SIZE = 5
function message(code: string, english: boolean) {
  const messages: Record<string, [string, string]> = {
    waiting: ['配置尚未就绪，请等待或重试加载。', 'Wait for configuration, or retry loading it.'],
    'invalid-name': ['请输入查询名称。', 'Enter a query name.'],
    'invalid-query': ['请选择有效区间；当前视窗仅用于曲线。', 'Choose a valid interval; viewport capture requires a chart.'],
    'invalid-points': ['请选至少一个定义完整、ID唯一的点位。', 'Select at least one point with a complete, unique definition.'],
    'device-changed': ['设备连接配置已变化，无法恢复；请重新选择条件。', 'Device connection changed. Choose conditions again.'],
    'points-changed': ['点位缺失或定义已变化，无法整条恢复；请重新选择条件。', 'Points are missing or changed. Choose conditions again.'],
    missing: ['此暂存条件已移除。', 'This saved condition was removed.'],
    saved: ['已在本页暂存条件。', 'Conditions saved in this device view.'],
    duplicate: ['相同名称和条件已暂存，未重复添加。', 'Identical name and conditions already saved.'],
    restored: ['已应用全部条件并重新查询；不是恢复旧数据快照。', 'All conditions applied; querying current history, not a saved result.'],
    failed: ['操作未完成，请检查条件后重试。', 'Operation incomplete. Check the conditions and retry.'],
  }
  return messages[code]?.[english ? 1 : 0] ?? messages.failed[english ? 1 : 0]
}
function PointList({ query, context, ready, english }: { query: RememberedQuery; context: QueryMemoryContext; ready: boolean; english: boolean }) {
  const [page, setPage] = useState(0), [differences, setDifferences] = useState(false)
  const changed = (p: RememberedQuery['points'][number]) => ready && context.points.get(p.id)?.signature !== p.signature
  const shown = differences ? query.points.filter(changed) : query.points, pages = Math.max(1, Math.ceil(shown.length / 20)), current = Math.min(page, pages - 1)
  return <details><summary>{english ? 'Captured point definitions' : '暂存时的点位定义'} ({query.points.length})</summary>
    <label><input type="checkbox" checked={differences} disabled={!ready} onChange={e => { setDifferences(e.target.checked); setPage(0) }} />{english ? 'Only missing/changed definitions' : '仅缺失或变化定义'} · {shown.length}/{query.points.length}</label>
    <ul>{shown.slice(current * 20, (current + 1) * 20).map(p => <li key={p.id}>{p.name} · #{p.id} · {english ? 'Configured source' : '配置来源'} {p.sourceAmbiguous || p.source === null ? (english ? 'unknown' : '未知') : p.source} · FC{p.functionCode} · {p.address} · {p.dataType}{changed(p) && <strong> · {context.points.has(p.id) ? (english ? 'Definition changed' : '定义变化') : (english ? 'Missing' : '缺失')}</strong>}</li>)}</ul>
    {pages > 1 && <div className="toolbar"><button type="button" className="btn" disabled={current === 0} onClick={() => setPage(current - 1)}>{english ? 'Previous points' : '上一页点位'}</button><span>{current + 1}/{pages}</span><button type="button" className="btn" disabled={current + 1 >= pages} onClick={() => setPage(current + 1)}>{english ? 'Next points' : '下一页点位'}</button></div>}
  </details>
}
export interface QueryMemoryViewProps {
  entries: readonly RememberedQuery[]; context: QueryMemoryContext; ready: boolean; canSave: boolean; canViewport: boolean; english?: boolean
  onSave: (name: string, scope: 'full' | 'viewport') => { added: boolean }; onRestore: (id: number) => void; onRemove: (id: number) => void
}
/** SSR-testable view. Rendering never reads history or invokes the action callbacks. */
export function HistoryQueryMemoryView({ entries, context, ready, canSave, canViewport, english = false, onSave, onRestore, onRemove }: QueryMemoryViewProps) {
  const [name, setName] = useState(''), [scope, setScope] = useState<'full' | 'viewport'>('full'), [page, setPage] = useState(0), [notice, setNotice] = useState<{ code: string; error: boolean } | null>(null)
  const text = (zh: string, en: string) => english ? en : zh
  const checks = useMemo(() => new Map(entries.map(q => [q.id, rememberedQueryCompatibility(q, context, ready)])), [entries, context, ready])
  const pages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE)), current = Math.min(page, pages - 1)
  const act = (action: () => string) => { try { setNotice({ code: action(), error: false }) } catch (e) { setNotice({ code: e instanceof QueryMemoryError ? e.code : 'failed', error: true }) } }
  return <details className="history-query-memory"><summary>{text('本页暂存查询', 'Temporary queries')} · {entries.length}</summary>
    <p className="chart-hint">{text('只保存条件，不保存采样结果。离开历史标签后仍可用；切换设备或刷新页面会清空。恢复会重新查询，并重置分页、缩放和A/B对比。暂存视窗将作为新的完整区间。', 'Conditions only, no samples. Retained across history tabs; cleared on device switch or page reload. Restore queries history again and resets page, zoom and A/B. A captured viewport becomes the new full interval.')}</p>
    <div className="toolbar"><label>{text('查询名称', 'Query name')}<input value={name} onChange={e => setName(e.target.value)} /></label>
      <label>{text('保存范围', 'Capture range')}<select value={scope} onChange={e => setScope(e.target.value as 'full' | 'viewport')}><option value="full">{text('完整区间', 'Full interval')}</option><option value="viewport" disabled={!canViewport}>{text('当前曲线视窗', 'Current chart viewport')}</option></select></label>
      <button type="button" className="btn" disabled={!ready || !canSave || !name.trim() || scope === 'viewport' && !canViewport} onClick={() => act(() => { const result = onSave(name, scope); setPage(0); return result.added ? 'saved' : 'duplicate' })}>{text('暂存条件', 'Save conditions')}</button>
    </div>
    {!ready && <p role="status">{message('waiting', english)}</p>}
    {ready && !canSave && <p role="status">{text('暂存前请确认区间有效，并至少选择一个点位。', 'Choose a valid interval and at least one point before saving.')}</p>}
    {scope === 'viewport' && !canViewport && <p role="status">{text('当前没有可暂存的曲线视窗，请切换到完整区间或调整曲线视窗。', 'No chart viewport available. Choose the full interval or adjust the chart viewport.')}</p>}
    {notice && <p className={notice.error ? 'chart-hint warn' : 'chart-hint'} role={notice.error ? 'alert' : 'status'}>{message(notice.code, english)}</p>}
    {!entries.length && <p>{text('尚无暂存条件。先选择时间和点位，再输入名称。', 'No temporary queries. Choose time and points, then enter a name.')}</p>}
    <div className="query-memory-entries">{entries.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE).map(q => {
      const check = checks.get(q.id)!
      return <article key={q.id} className="query-memory-entry"><strong>{q.name}</strong>
        <p className="history-utc-range"><time>{new Date(q.start).toISOString()}</time> — <time>{new Date(q.end).toISOString()}</time> (UTC)</p>
        <p>{q.mode === 'chart' ? text('曲线', 'Chart') : text('表格', 'Table')} · {q.valueMode === 'physical' ? text('物理量', 'Physical') : text('原始值', 'Raw')} · {text('输入时区', 'Input zone')}: {q.inputZone === 'utc' ? 'UTC' : text('浏览器本地', 'Browser local')} · {q.scope === 'viewport' ? text('视窗→完整区间', 'Viewport → full interval') : text('完整区间', 'Full interval')} · {q.points.length} {text('点位', 'points')}</p>
        <small>{text('暂存于', 'Saved at')} {q.createdAt} (UTC)</small>
        <PointList query={q} context={context} ready={ready} english={english} />
        {check.kind !== 'ready' && <p className="chart-hint warn" role="status">{message(check.kind, english)}{check.kind === 'points-changed' && ` ${text('缺失', 'Missing')}: ${check.missing.length}; ${text('变化', 'Changed')}: ${check.changed.length}`}</p>}
        <div className="toolbar"><button type="button" className="btn" disabled={check.kind !== 'ready'} onClick={() => act(() => { onRestore(q.id); return 'restored' })}>{text('应用并重新查询', 'Apply and query again')}</button><button type="button" className="btn" onClick={() => { onRemove(q.id); setNotice(null) }}>{text('移除条件', 'Remove conditions')}</button></div>
      </article>
    })}</div>
    {pages > 1 && <div className="toolbar"><span>{text('条件页', 'Query page')} {current + 1}/{pages} · {text('全部', 'Total')} {entries.length}</span><button type="button" className="btn" disabled={current === 0} onClick={() => setPage(current - 1)}>{text('上一页', 'Previous')}</button><button type="button" className="btn" disabled={current + 1 >= pages} onClick={() => setPage(current + 1)}>{text('下一页', 'Next')}</button></div>}
  </details>
}
export function HistoryQueryMemoryPanel({ memory, ...props }: Omit<QueryMemoryViewProps, 'entries' | 'onRemove'> & { memory: HistoryQueryMemory }) {
  const entries = useSyncExternalStore(memory.subscribe, memory.snapshot, memory.snapshot)
  return <HistoryQueryMemoryView {...props} entries={entries} onRemove={id => memory.remove(id)} />
}
