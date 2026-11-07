import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { AlarmRulesReader } from '../../apps/web/src/alarm-rule-read'
import { AlarmRuleReadStatus, alarmRuleSummaryKey } from '../../apps/web/src/AlarmRuleReadStatus'
import { AlarmPanel } from '../../apps/web/src/AlarmPanel'
import { alarmRuleMatches, parseAlarmEdit } from '../../packages/core/src/alarm-settings-edit'
import '../../apps/web/src/styles.css'

const rules = [{ id: 1, registerId: 101, operator: '>', threshold: 100, message: '合成规则' }]
const point = { id: 101, alias: '合成温度', startAddress: 0, dataType: 'uint16', functionCode: 3 }
function EditorPreview() {
  const [open, setOpen] = useState(false), [mode, setMode] = useState('normal'), modeRef = useRef(mode); modeRef.current = mode
  const stored = useRef(rules.map(row => ({ ...row }))), failRead = useRef(false), [version, setVersion] = useState(0)
  const api = useMemo(() => async (url: string, method = 'GET', body?: unknown) => {
    if (method === 'GET') {
      if (failRead.current && modeRef.current === 'read-failure') throw Object.assign(new Error('合成读回失败'), { statusCode: 503 })
      failRead.current = false
      return JSON.parse(JSON.stringify(stored.current))
    }
    const deleting = method === 'DELETE', input = body as any
    let result: any
    if (method === 'POST') { const id = Math.max(0, ...stored.current.map(row => row.id)) + 1; result = { id, ...input }; stored.current.push(result) }
    else {
      const parsed = parseAlarmEdit(body, deleting), row = stored.current.find(row => row.id === parsed.expected.id)
      if (!row) throw Object.assign(new Error('合成规则已删除'), { statusCode: 404 })
      if (!alarmRuleMatches(row, parsed.expected)) throw Object.assign(new Error('合成规则被另一窗口修改，操作被拒绝'), { statusCode: 409 })
      if (!url.endsWith('/' + row.id + '/settings')) throw new Error('unexpected mock route')
      if (deleting) stored.current = stored.current.filter(value => value.id !== row.id)
      else Object.assign(row, parsed.changes)
      result = { rule: deleting ? null : { ...row }, deletedRuleId: deleting ? row.id : null, warnings: modeRef.current === 'warning' ? ['合成：已保存但通知失败，请核对。'] : [] }
    }
    setVersion(value => value + 1)
    failRead.current = true
    if (modeRef.current === 'lost') throw new Error('合成：操作已提交但响应丢失')
    if (modeRef.current === 'hang') return new Promise(() => {})
    return result
  }, [])
  const labels: Record<string, string> = { cancel: '取消', edit: '编辑', save: '保存', working: '处理中…', alarmRules: '告警规则编辑 / 纯模拟', alarmHelp: '阈值仍比较原始解码值；本页不连接任何设备。', alarmNone: '未设置规则', alarmDelete: '删除', alarmConfirmDelete: '删除以下原始规则？', alarmAdd: '新增规则', alarmEdit: '编辑规则', alarmThreshold: '原始阈值', alarmOperator: '比较条件', alarmMessage: '提示', alarmClose: '关闭', alarmCancelEdit: '取消编辑', colAddr: '地址', alarmTriggered: '条件触发', alarmWaiting: '等待数据', alarmNormal: '未触发', alarmRulesUnverified: '待核实', alarmInvalid: '填写有效阈值' }
  return <section style={{ marginTop: 32 }}><h2>正式告警编辑器 · 纯 mock API</h2><p>所有编辑只改变本页合成数组，不发送请求、不读库、不操作设备。{version} 次合成状态变化。</p>
    <div className="toolbar" style={{ position: open ? 'fixed' : 'relative', top: open ? 8 : undefined, right: open ? 8 : undefined, zIndex: 10000, maxWidth: open ? 360 : undefined, padding: 8, background: '#252525', color: '#eee' }}><button className="btn" onClick={() => setOpen(true)}>打开正式编辑器</button><label>下次响应<select value={mode} onChange={e => setMode(e.target.value)}><option value="normal">正常</option><option value="warning">提交成功但通知警告</option><option value="lost">提交后响应丢失</option><option value="hang">提交后挂起（30秒解除等待）</option><option value="read-failure">保存后读回失败</option></select></label>
      <button className="btn" onClick={() => { if (stored.current[0]) stored.current[0].threshold += 10; setVersion(value => value + 1); window.dispatchEvent(new Event('alarm-rules-changed')) }}>模拟另一窗口提高阈值并刷新列表</button><button className="btn" onClick={() => window.dispatchEvent(new Event('alarm-rules-changed'))}>只读重新加载</button></div>
    <pre>{JSON.stringify(stored.current, null, 2)}</pre><p>手测：先打开编辑器点编辑或删除确认，再点“另一窗口提高阈值”。列表可刷新，原草稿/删除条件保持；提交应冲突且不改合成数组。响应丢失/挂起后不能直接重复；切回正常只读刷新，记录草稿后明确放弃，再从当前规则重新编辑。关闭后重新打开会丢弃本页编辑状态，不是服务端幂等保证。窄屏和长提示仍需人工检查。</p>
    {open && <AlarmPanel t={key => labels[key] ?? key} device={{ id: 1, isActive: 1, mode: 'master', slaveId: 1 }} groups={[{ id: 1, name: 'mock', isActive: 1, slaveId: 1, registers: [point] }]} latest={{}} groupErrors={{}} now={Date.now()} threshold={5000} point={point} onClose={() => setOpen(false)} api={api} />}
  </section>
}
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
    <p>手测：成功→请求失败/异常列表，旧规则保留且摘要待核实；重试合法空列表后才显示未设置规则。延迟期间强制新读，旧响应不应覆盖新结果；自动刷新不应取消在途读。挂起超过30秒应解除等待，切换成功场景后用只读重试恢复。长标签、英文和360px窄屏。</p>
    <EditorPreview />
  </main>
}
createRoot(document.getElementById('root')!).render(<Preview />)
