import React from 'react'
import type { AlarmWriteState } from './alarm-settings-save'
export function AlarmRuleWriteStatus({ state, onReset, english = false }: { state: AlarmWriteState; onReset: () => void; english?: boolean }) {
  if (state.phase !== 'blocked') return null
  const conflict = state.reason === 'conflict', rejected = state.reason === 'rejected'
  return <div className="alarm-rule-read-status" role="alert"><p>{english ? conflict ? 'The rule changed; this edit/delete was rejected.' : rejected ? 'The operation was rejected.' : 'The write outcome is unconfirmed. Read the rules and verify before another operation.' : conflict ? '规则已变化，本次保存/删除被拒绝。' : rejected ? '本次操作未执行。' : '操作结果待核实。请重新读取规则并核对，勿直接重复操作。'}</p>
    {state.detail && <p>{state.detail}</p>}<p>{english ? 'Your draft is retained. Copy it if needed, reread the rules, then discard the draft and edit again. Refreshing does not repeat or unblock the write.' : '草稿已保留。请先记录所需修改，重新读取核对，再放弃草稿并重新编辑；刷新不会重写或解除待核实状态。'}</p>
    <button className="btn" type="button" onClick={onReset}>{english ? 'Discard draft' : '放弃草稿'}</button></div>
}
