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
    <p className="alarm-hint">{text('只列本页未取得判定值的规则，不是故障或事件清单。条件比较类型解码后的原始值，不应用倍率/偏移；页面标记不是根因，也不提供触发时间或持续时长。可在实时表搜索 id:编号进一步核对。', 'Lists rules with no usable evaluation value on this page, not faults or recorded events. Conditions compare type-decoded raw values without scale/offset. Page flags are not root causes, trigger times or durations. Search id:number in the live table to inspect further.')}</p>
    <p role="status">{text('本页待定项', 'Pending on this page')}: {rows.length}</p>
    {!rows.length ? <p>{text('本次已载入规则没有待定项；不等同无告警或设备恢复。', 'No pending items among the loaded rules; this does not mean no alarms or device recovery.')}</p> : <ol start={activePage * 20 + 1}>{rows.slice(activePage * 20, (activePage + 1) * 20).map(({ rule, reg, group }) => {
      const source = device.mode === 'slave' ? device.slaveId : group.slaveId
      return <li key={rule.id}><strong>{text('规则', 'Rule')} #{rule.id} · {reg.alias || '#' + reg.id} · id:{reg.id}</strong><p>{group.name} · {text('配置从站', 'Configured slave')} {validSlaveId(source) ? source : '?'} · FC{reg.functionCode} · {text('地址', 'Address')} {reg.startAddress} · {reg.dataType} · {text('原始值条件', 'Raw condition')} {rule.operator} {String(rule.threshold)}</p><small>{text('设备', 'Device')}: {text(device.isActive ? '启用' : '暂停', device.isActive ? 'enabled' : 'paused')} · {text('分组', 'Group')}: {text(group.isActive ? '启用' : '暂停', group.isActive ? 'enabled' : 'paused')} · {text('本页组错误标记', 'Page group-error flag')}: {text(groupErrors[group.id] ? '有' : '无', groupErrors[group.id] ? 'present' : 'absent')}</small></li>
    })}</ol>}
    {pages > 1 && <div className="toolbar"><button className="btn" type="button" disabled={activePage === 0} onClick={() => setPage(activePage - 1)}>{text('上一页', 'Previous')}</button><span>{activePage + 1}/{pages}</span><button className="btn" type="button" disabled={activePage + 1 === pages} onClick={() => setPage(activePage + 1)}>{text('下一页', 'Next')}</button></div>}
  </section>
}
