import React, { useId, useRef, useState } from 'react'
import { RegisterSelectModal, type PickerGroup } from './RegisterPicker'
import { LIVE_WATCH_LIMIT, liveWatchResult, type LiveWatchSelection } from './live-watch-list'

export function LiveWatchList({ selection, scope, only, matches, groups, deviceSlaveId, t, onSelect, onOnly, onClear, english = false }: {
  selection: LiveWatchSelection | null; scope: symbol | null; only: boolean; matches: ReadonlySet<number>; groups: PickerGroup[]; deviceSlaveId?: number
  t: (key: string) => string; onSelect: (scope: symbol, ids: Set<number>) => void; onOnly: (value: boolean) => void; onClear: () => void; english?: boolean
}) {
  const [editing, setEditing] = useState<symbol | null>(null), currentScope = useRef(scope); currentScope.current = scope
  const description = useId(), hintId = description + '-hint', statusId = description + '-status'
  const result = liveWatchResult(selection, scope, only, matches), text = (zh: string, en: string) => english ? en : zh
  return <section className="live-point-filters" aria-label={text('手动观察清单', 'Manual watch list')}>
    <div className="toolbar"><strong>{text('手动观察清单', 'Manual watch list')}</strong><button type="button" className="btn" aria-describedby={hintId + ' ' + statusId} disabled={!scope || !groups.some(group => group.registers.length)} onClick={() => setEditing(scope)}>{text('选择观察点位', 'Choose watch points')}</button>
      <label><input type="checkbox" aria-describedby={statusId} checked={only} disabled={!only && result.status !== 'ready'} onChange={event => onOnly(event.target.checked)} />{text('仅看观察清单', 'Show watch list only')}</label><button type="button" className="btn" aria-describedby={statusId} disabled={!selection && !only} onClick={onClear}>{text('清空观察清单', 'Clear watch list')}</button></div>
    <p id={hintId} className="chart-hint">{text('最多32点，仅本实时页内存；离开、切设备或刷新会丢失。与现有搜索/从站/状态筛选取交集，筛选数量仍按完整范围统计。仅改变显示，不影响采集、规则或曲线选点。冻结只包含当前实际匹配点位，JSON不保存清单。顶部待定规则清单按当前设备已加载点表统计规则条数，不随本清单或其他实时表筛选缩小。', 'Up to 32 points in this live view only; lost on leaving, device change or refresh. Intersects search/slave/status filters; their counts still use the full scope. Display only; acquisition, rules and curve selection are unchanged. Freeze captures actual matches; JSON does not save the list. The top pending-rule list counts rule entries across loaded device point definitions; watch-only and other live-table filters do not narrow it.')}</p>
    <p id={statusId} role="status" aria-atomic={true}>{result.status === 'unverified' ? text('来源/配置未核实，观察清单不可用。', 'Source/configuration unverified; watch list unavailable.') : result.status === 'changed' ? text('配置或来源已变化，原观察清单已失效；请重新选择，不会按相同编号沿用。', 'Configuration or source changed; the old watch list is invalid. Choose again; matching IDs are not reused.') : result.status === 'empty' ? text('尚未选择观察点位。', 'No watch points selected.') : text(`已选 ${result.ids.size} 点，符合当前筛选 ${result.matching} 点。`, `${result.ids.size} selected; ${result.matching} match current filters.`)}{only && result.visibleIds.size === 0 ? text(' 当前没有可显示的观察点；这不代表设备正常或无告警，可关闭“仅看观察清单”核对完整范围。', ' No watch points to display; this does not prove normal operation or no alarms. Turn off watch-only to review the full scope.') : ''}</p>
    {editing !== null && editing === scope && <RegisterSelectModal t={t} groups={groups} initial={result.ids} max={LIVE_WATCH_LIMIT} deviceSlaveId={deviceSlaveId} onClose={() => setEditing(null)} onApply={ids => { if (currentScope.current !== editing) return; onSelect(editing, ids); setEditing(null) }} />}
  </section>
}
