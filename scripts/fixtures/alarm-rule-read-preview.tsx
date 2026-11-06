import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { AlarmRulesReader } from '../../apps/web/src/alarm-rule-read'
import { AlarmRuleReadStatus, alarmRuleSummaryKey } from '../../apps/web/src/AlarmRuleReadStatus'
import '../../apps/web/src/styles.css'

const rules = [{ id: 1, registerId: 101, operator: '>', threshold: 100, message: '合成规则' }]
function Preview() {
  const [scenario, setScenario] = useState('success'), scenarioRef = useRef(scenario); scenarioRef.current = scenario
  const [revision, setRevision] = useState(0), [english, setEnglish] = useState(false), [triggered, setTriggered] = useState(false)
  const reader = useMemo(() => new AlarmRulesReader(async () => {
    const mode = scenarioRef.current
    if (mode === 'hang') return new Promise(() => {}) // Deliberately ignores abort; reader still settles at 30s.
    if (mode === 'slow') await new Promise(resolve => setTimeout(resolve, 1000))
    if (mode === 'failure') throw new Error('synthetic failure')
    if (mode === 'invalid') return [...rules, { ...rules[0], id: 2, operator: 'unsupported' }]
    return mode === 'empty' ? [] : rules
  }, 30000, () => Date.parse('2026-11-06T00:00:00.123Z')), [revision])
  useEffect(() => () => reader.stop(), [reader])
  const state = useSyncExternalStore(reader.subscribe, reader.snapshot, reader.snapshot)
  const summaries: Record<string, [string, string]> = { alarmRulesReading: ['正在读取规则', 'Reading rules'], alarmRulesUnverified: ['规则待核实', 'Rules unverified'], alarmNormal: ['未触发（合成值）', 'Not triggered (synthetic)'], alarmActive: ['1项触发（合成值）', '1 triggered (synthetic)'], alarmNone: ['未设置规则', 'No rules configured'], alarmWaiting: ['等待有效数据', 'Waiting for valid data'] }
  const summary = alarmRuleSummaryKey(state, state.rules.length && triggered ? 1 : 0, state.rules.length, 0)
  return <main style={{ padding: 24 }}><h1>纯 mock 告警规则读取</h1><p>正式读取模型/状态控件和摘要逻辑，全部为合成元数据与合成判定；不使用AlarmPanel的真实请求钩子，不发送任何请求、写规则或连接设备。初始状态不应显示“未设置规则”或“未触发”。</p>
    <div className="toolbar"><label>下次模拟响应<select value={scenario} onChange={e => setScenario(e.target.value)}><option value="success">完整规则</option><option value="empty">合法空规则</option><option value="failure">请求失败</option><option value="invalid">部分异常规则（整份拒绝）</option><option value="hang">请求不结束（真实等待30秒超时）</option><option value="slow">延迟1秒且忽略取消</option></select></label>
      <button className="btn" onClick={() => void reader.refresh(true)}>模拟显式读取</button><button className="btn" onClick={() => void reader.refresh()}>模拟自动刷新（合并在途请求）</button><button className="btn" onClick={() => reader.invalidate()}>模拟写后待核实（不写任何数据）</button><button className="btn" onClick={() => setRevision(v => v + 1)}>模拟切换设备（新查看器）</button>
      <label><input type="checkbox" checked={triggered} onChange={e => setTriggered(e.target.checked)} />合成值触发</label><label><input type="checkbox" checked={english} onChange={e => setEnglish(e.target.checked)} />English</label></div>
    <div className="alarm-summary"><span className="alarm-count">{summaries[summary][english ? 1 : 0]}</span></div>
    <AlarmRuleReadStatus state={state} onRetry={() => void reader.refresh(true)} english={english} />
    {state.updatedAt !== null && <section><p>上次完整规则（只是定义，不是采样或告警日志）：{state.rules.length}</p><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(state.rules, null, 2)}</pre></section>}
    <p>手测：成功→请求失败/异常列表，旧规则保留且摘要待核实；重试合法空列表后才显示未设置规则。延迟期间强制新读，旧响应不应覆盖新结果；自动刷新不应取消在途读。挂起超过30秒应解除等待，切换成功场景后用只读重试恢复。长标签、英文和360px窄屏。实际App编辑器的禁用/草稿保留及保存后读回另需授权隔离验收。</p>
  </main>
}
createRoot(document.getElementById('root')!).render(<Preview />)
