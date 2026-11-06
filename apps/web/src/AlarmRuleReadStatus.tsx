import React from 'react'
import { alarmRuleReadError, type AlarmRuleReadState } from './alarm-rule-read'

export function alarmRuleSummaryKey(state: AlarmRuleReadState, active: number, localRules: number, unknown: number) {
  return state.reading ? 'alarmRulesReading' : state.status !== 'ready' ? 'alarmRulesUnverified' : active ? 'alarmActive' : localRules ? unknown ? 'alarmWaiting' : 'alarmNormal' : 'alarmNone'
}

export function AlarmRuleReadStatus({ state, onRetry, disabled = false, english = false }: { state: AlarmRuleReadState; onRetry: () => void; disabled?: boolean; english?: boolean }) {
  const text = (zh: string, en: string) => english ? en : zh
  // Reserve one short line during routine polling, avoiding an expanding warning panel every 10s.
  if (state.status === 'ready') return <p className="alarm-rule-refresh" role="status">{state.reading ? text('正在刷新规则…', 'Refreshing rules…') : null}</p>
  const updating = state.reading, failed = state.status === 'error', pending = state.status === 'loading'
  if (!updating && !failed && !pending) return null
  const reason = failed ? alarmRuleReadError(state.error) : null
  return <div className="alarm-rule-read-status" role={failed ? 'alert' : 'status'}>
    <p>{failed ? text('规则读取未完成，告警状态待核实。', 'Rule read incomplete. Alarm status is unverified.') : text(updating ? '正在读取规则。' : '规则状态待核实。', updating ? 'Reading rules.' : 'Rule status is unverified.')}
      {reason === 'timeout' ? text('等待超过30秒，可重新读取。', 'Read exceeded 30 seconds. You can retry.') : reason === 'invalid' ? text('响应格式异常，未接受部分规则。', 'Invalid response; no partial rule list accepted.') : failed ? text('请检查服务连接后重试。', 'Check the service connection and retry.') : ''}</p>
    {state.updatedAt !== null && <p>{text('上次完整读取', 'Last complete read')}: <time>{new Date(state.updatedAt).toISOString()}</time> (UTC) · {state.rules.length} {text('条规则（全设备）', 'rules (all devices)')}。{text('保留供核对，不代表当前规则完整；数量为0不证明无告警。', 'Retained for review, not proof of current completeness. Zero does not prove no alarms.')}</p>}
    {state.updatedAt === null && <p>{text('尚未取得完整规则，不能判断“未设置规则”或“未触发”。', 'No complete rule list yet; cannot conclude no rules or no triggered conditions.')}</p>}
    <button type="button" className="btn" disabled={disabled || updating} onClick={onRetry}>{text(updating ? '读取中…' : '重新读取规则', updating ? 'Reading…' : 'Read rules again')}</button>
    <small>{text('此按钮只读规则，不重复保存或删除。', 'Reads rules only; never repeats save or delete.')}</small>
  </div>
}
