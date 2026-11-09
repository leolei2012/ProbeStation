import React, { useState } from 'react'
import { validSlaveId } from '../../../packages/core/src/sample-source'

export interface AlarmPendingContextProps {
  current: boolean; english?: boolean
  device: { isActive: number; mode?: string; slaveId?: number }
  groupErrors: Readonly<Record<number, string>>
  rows: readonly { rule: { id: number; operator: string; threshold: number }; reg: { id: number; alias: string | null; startAddress: number; dataType: string; functionCode: number }; group: { id: number; name: string; isActive: number; slaveId?: number } }[]
}
/** Existing page evaluations only. No sample lookup, rule evaluation, read or write. */
export function AlarmPendingContext({ current, rows, device, groupErrors, english = false }: AlarmPendingContextProps) {
  const [page, setPage] = useState(0), text = (zh: string, en: string) => english ? en : zh
  if (!current) return <p role="status">{text('点表或规则尚未核实，暂不展示待定明细；请先核对现有读取状态。', 'Point definitions or rules are unverified. Check the existing read status before reviewing pending details.')}</p>
  const pages = Math.max(1, Math.ceil(rows.length / 20)), activePage = Math.min(page, pages - 1)
  return <section aria-label={text('本页待定规则上下文', 'Pending rule context on this page')}>
    <p className="alarm-hint">{text('范围是当前设备已加载点表，不随观察清单、搜索、从站或状态筛选缩小；数量为规则条数，同一点可有多条规则。只列未取得判定值的规则，不是故障或事件清单。条件比较类型解码后的原始值，不应用倍率/偏移；页面标记不是根因，也不提供触发时间或持续时长。核对清单外点位时，先关闭“仅看观察清单”并清除其他筛选，再在实时表搜索 id:编号。', 'Scope is the loaded point definitions for the current device, not narrowed by watch list, search, slave or status filters. Counts are rule entries; one point can have multiple rules. Lists rules without usable evaluation values, not faults or recorded events. Conditions compare type-decoded raw values without scale/offset. Page flags are not root causes, trigger times or durations. To inspect a point outside the watch list, turn off watch-only and clear other filters before searching id:number in the live table.')}</p>
    <p role="status">{text('待定规则条数', 'Pending rule entries')}: {rows.length}</p>
    {!rows.length ? <p>{text('本次已载入规则没有待定项；不等同无告警或设备恢复。', 'No pending items among the loaded rules; this does not mean no alarms or device recovery.')}</p> : <ol start={activePage * 20 + 1}>{rows.slice(activePage * 20, (activePage + 1) * 20).map(({ rule, reg, group }) => {
      const source = device.mode === 'slave' ? device.slaveId : group.slaveId
      return <li key={rule.id}><strong>{text('规则', 'Rule')} #{rule.id} · {reg.alias || '#' + reg.id} · id:{reg.id}</strong><p>{group.name} · {text('配置从站', 'Configured slave')} {validSlaveId(source) ? source : '?'} · FC{reg.functionCode} · {text('地址', 'Address')} {reg.startAddress} · {reg.dataType} · {text('原始值条件', 'Raw condition')} {rule.operator} {String(rule.threshold)}</p><small>{text('设备', 'Device')}: {text(device.isActive ? '启用' : '暂停', device.isActive ? 'enabled' : 'paused')} · {text('分组', 'Group')}: {text(group.isActive ? '启用' : '暂停', group.isActive ? 'enabled' : 'paused')} · {text('本页组错误标记', 'Page group-error flag')}: {text(groupErrors[group.id] ? '有' : '无', groupErrors[group.id] ? 'present' : 'absent')}</small></li>
    })}</ol>}
    {pages > 1 && <div className="toolbar"><button className="btn" type="button" disabled={activePage === 0} onClick={() => setPage(activePage - 1)}>{text('上一页', 'Previous')}</button><span>{activePage + 1}/{pages}</span><button className="btn" type="button" disabled={activePage + 1 === pages} onClick={() => setPage(activePage + 1)}>{text('下一页', 'Next')}</button></div>}
  </section>
}
