import React, { useEffect, useState } from 'react'
import { openAlarmHistory, type AlarmHistoryState } from './alarm-history'
import type { DataTarget } from './DeviceIssues'

export function AlarmHistoryAction({ state, resolve, onOpen, english = false }: { state: AlarmHistoryState; resolve: () => AlarmHistoryState; onOpen: (target: Readonly<DataTarget>) => void; english?: boolean }) {
  const [failure, setFailure] = useState<AlarmHistoryState | null>(null)
  const key = JSON.stringify(state)
  useEffect(() => { setFailure(null) }, [key])
  const shown = failure ?? state
  const text = (zh: string, en: string) => english ? en : zh
  const reasons = {
    waiting: text('点表配置未就绪。', 'Point configuration is not ready.'), rules: text('规则尚未核实或正在读取。', 'Rules are unverified or being read.'),
    inactive: text('当前没有有效的条件命中采样。', 'No valid matching sample now.'), identity: text('点位身份与采样不匹配。', 'Point and sample identities differ.'),
    batch: text('多字样本批次未验证，暂不能精确定位。', 'Multiword batch unverified; precise navigation unavailable.'), time: text('采样时间不明确、已过期或超前，暂不能精确定位。', 'Sample time is uncertain, stale or ahead; precise navigation unavailable.'),
  }
  return <div className="alarm-history-action">
    {shown.kind === 'ready' ? <small>{text('配置从站', 'Configured slave')} {shown.slaveId} · #{shown.registerId} · {text('采样', 'Sample')} <time>{shown.sampledAt}</time> (UTC) · {text(shown.batchKnown ? '有批次ID' : '单字无批次ID', shown.batchKnown ? 'Batch ID present' : 'Single word, no batch ID')}</small> : <small role="status">{reasons[shown.kind]}</small>}
    <button type="button" className="btn" disabled={shown.kind !== 'ready'} onClick={() => { const next = openAlarmHistory(resolve, onOpen); setFailure(next.kind === 'ready' ? null : next) }}>{text('查看采样前5分钟', 'View 5 minutes before sample')}</button>
  </div>
}
