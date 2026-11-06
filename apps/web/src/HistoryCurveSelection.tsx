import React, { useState } from 'react'
import type { HistoryCurveExclusion, HistoryCurveSelectionPlan } from '../../../packages/core/src/history-curve-plan'
import { PointLabel, type PointLabelData } from './PointLabel'

const reasons: readonly HistoryCurveExclusion[] = ['covered', 'past-group-end', 'non-numeric', 'missing-group', 'missing-point']
export function HistoryCurveSelection({ plan, pointLabels, onTable, english = false }: { plan: HistoryCurveSelectionPlan; pointLabels?: ReadonlyMap<number, PointLabelData>; onTable: () => void; english?: boolean }) {
  const [filter, setFilter] = useState<'all' | HistoryCurveExclusion>('all'), [page, setPage] = useState(0)
  const excluded = plan.entries.filter(entry => entry.reason !== 'eligible'), text = (zh: string, en: string) => english ? en : zh
  if (!excluded.length) return null
  const names: Record<HistoryCurveExclusion, string> = { covered: text('被同组较前定义的跨度覆盖', 'Covered by an earlier definition in this group'), 'past-group-end': text('点宽超过分组结束地址', 'Point extends past group end'), 'non-numeric': text('十六进制/二进制显示格式不参与数值曲线', 'Hex/binary display format excluded from numeric curves'), 'missing-group': text('找不到所属分组', 'Group not found'), 'missing-point': text('找不到精确点位ID', 'Exact point ID not found') }
  const shown = excluded.filter(entry => filter === 'all' || entry.reason === filter), pages = Math.max(1, Math.ceil(shown.length / 20)), current = Math.min(page, pages - 1), none = plan.registers.length === 0
  return <details className="history-curve-selection" open={none}>
    <summary>{text('曲线选点说明', 'Curve selection details')} · {text('所选', 'Selected')} {plan.entries.length} · {text('可参与查询', 'Queryable')} {plan.registers.length} · {text('未参与', 'Excluded')} {excluded.length}</summary>
    <p className="chart-hint" role="status">{none ? text('没有可参与当前数值曲线的所选点位，未发起曲线读取。这不等于没有历史数据。', 'No selected points can participate in this numeric curve; no curve read started. This does not prove history is absent.') : text('以下点位未参与数值曲线；选择仍保留，其他点位正常查询。', 'These points are excluded from the numeric curve. Selection is retained; other points are queried.')}</p>
    <div className="toolbar"><button type="button" className="btn" onClick={onTable}>{text('在历史表格查看所选点位', 'View selected points in history table')}</button>
      <label>{text('查看原因', 'Reason')}<select value={filter} onChange={e => { setFilter(e.target.value as typeof filter); setPage(0) }}><option value="all">{text('全部原因', 'All reasons')} ({excluded.length})</option>{reasons.map(reason => <option key={reason} value={reason}>{names[reason]} ({excluded.filter(entry => entry.reason === reason).length})</option>)}</select></label></div>
    <ul>{shown.slice(current * 20, (current + 1) * 20).map(entry => {
      const label = pointLabels?.get(entry.id)
      return <li key={entry.id}>{label ? <PointLabel label={{ ...label, qualified: true }} /> : <strong>#{entry.id}</strong>}<span>{names[entry.reason as HistoryCurveExclusion]}{entry.coveredBy === undefined ? '' : ` · #${entry.coveredBy}`}</span></li>
    })}</ul>
    {!shown.length && <p>{text('这一原因当前没有条目。', 'No entries for this reason.')}</p>}
    {pages > 1 && <div className="toolbar"><span>{current + 1}/{pages} · {text('此类全部', 'Total in filter')} {shown.length}</span><button type="button" className="btn" disabled={current === 0} onClick={() => setPage(current - 1)}>{text('上一页', 'Previous')}</button><button type="button" className="btn" disabled={current + 1 >= pages} onClick={() => setPage(current + 1)}>{text('下一页', 'Next')}</button></div>}
    <p className="chart-hint">{text('这里只说明客户端当前点表的曲线资格，不证明数据存在或质量有效。覆盖优先级沿用现有规则，前项本身也可能未参与曲线；更多结构问题可到“点表检查”核对。未修改配置或取消选择。', 'Client point definitions explain eligibility only, not data existence or quality. Existing coverage priority is retained; a blocking definition may itself be excluded. Check Point diagnostics for structural issues. Configuration and selection are unchanged.')}</p>
  </details>
}
