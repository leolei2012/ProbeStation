import React, { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AlarmHistoryAction } from '../../apps/web/src/AlarmHistoryAction'
import { alarmHistoryState } from '../../apps/web/src/alarm-history'
import { readPointAlarmObservation } from '../../apps/web/src/alarm-value'
import { sourceKey } from '../../packages/core/src/sample-source'
import { encodeRegister } from '../../packages/core/src/codec'
import type { Sample } from '../../apps/web/src/observation'
import { HistoryNavigation } from '../../apps/web/src/history-navigation'
import { historyTimeRange, resolveHistoryTimeRange } from '../../apps/web/src/history-time-range'
import { historyQueryPlan } from '../../apps/web/src/history-query-task'
import '../../apps/web/src/styles.css'

const device = { id: 7, mode: 'master', isActive: 1, slaveId: 9 }, baseTime = Date.parse('2026-11-06T00:00:00.987Z')
function Preview() {
  const [scenario, setScenario] = useState('good'), [source, setSource] = useState(2), [revision, setRevision] = useState(0), [english, setEnglish] = useState(false), [expireOnClick, setExpireOnClick] = useState(false), [missingAtHistory, setMissingAtHistory] = useState(false), [longName, setLongName] = useState(false), [result, setResult] = useState('尚未定位。')
  const navigation = useRef(new HistoryNavigation()), token = useRef(0), now = baseTime + revision * 1000
  const single = scenario === 'single', point = { id: source === 1 ? 101 : 202, alias: '合成温度' + (longName ? '很长的同名点位说明'.repeat(15) : ''), dataType: single ? 'uint16' : 'uint32', functionCode: 3, startAddress: 124 }
  const rule = { id: source, registerId: point.id, operator: '>', threshold: single ? 100 : 65535, message: null }
  const cache: Record<string, Sample> = {}
  for (const slaveId of [1, 2]) for (const [i, rawValue] of encodeRegister(point.dataType, single ? 200 : 65536).entries()) cache[sourceKey(7, 'holding-register', 124 + i, slaveId)] = { rawValue, slaveId, timestamp: new Date(now).toISOString(), timestampMs: now, quality: 'good', batchId: 'mock-' + slaveId }
  const own = Object.values(cache).filter(sample => sample.slaveId === source)
  if (scenario === 'legacy' || scenario === 'single') own.forEach(sample => { sample.batchId = null })
  if (scenario === 'time') own[own.length - 1].timestampMs = now - 500
  if (scenario === 'mixed') own[own.length - 1].batchId = 'other'
  if (scenario === 'stale') own.forEach(sample => { sample.timestampMs = now - 6000 })
  if (scenario === 'future') own.forEach(sample => { sample.timestampMs = now + 500 })
  if (scenario === 'missing') delete cache[sourceKey(7, 'holding-register', 125, source)]
  const observation = readPointAlarmObservation(point, cache, device, { isActive: 1, slaveId: source }, now, 5000, false)
  const resolve = (time: number) => alarmHistoryState(observation, rule, point, 7, scenario !== 'loading', scenario !== 'rules', time, 5000)
  const state = resolve(now)
  return <main style={{ padding: 24 }}><h1>纯 mock 告警采样定位历史</h1><p>正式采样投影、导航校验、操作控件、历史意图/时间/参数构造；全为合成数据，不装配真实请求钩子、不发送URL、不读库、不连接设备。异常场景展示禁用原因；实际App无有效条件命中的行通常不会显示。</p>
    <div className="toolbar"><label>配置来源<select value={source} onChange={e => setSource(Number(e.target.value))}><option value="1">从站1 · #101</option><option value="2">从站2 · #202（同地址同别名）</option></select></label>
      <label>合成场景<select value={scenario} onChange={e => setScenario(e.target.value)}><option value="good">完整同批多字</option><option value="legacy">多字无批次</option><option value="single">单字无批次</option><option value="time">同批但各字相差500ms</option><option value="mixed">混批</option><option value="stale">过期</option><option value="future">时间超前500ms</option><option value="missing">缺字</option><option value="loading">点表加载中</option><option value="rules">规则未核实/读取中</option></select></label>
      <label><input type="checkbox" checked={expireOnClick} onChange={e => setExpireOnClick(e.target.checked)} />模拟点击时已过10秒</label><label><input type="checkbox" checked={missingAtHistory} onChange={e => setMissingAtHistory(e.target.checked)} />模拟历史页缺失点位ID</label><label><input type="checkbox" checked={longName} onChange={e => setLongName(e.target.checked)} />超长别名</label><label><input type="checkbox" checked={english} onChange={e => setEnglish(e.target.checked)} />English</label>
      <button className="btn" onClick={() => { setRevision(v => v + 1); setExpireOnClick(false) }}>新的合成采样（恢复）</button></div>
    <div className="alarm-active-list"><div><strong>{point.alias}</strong><small>合成原始值：{String(observation?.value ?? '未知')} · &gt; {rule.threshold}</small>
      <AlarmHistoryAction state={state} resolve={() => resolve(now + (expireOnClick ? 10000 : 0))} english={english} onOpen={target => {
        const action = navigation.current.consume({ ...target, token: ++token.current }, 7, missingAtHistory ? [] : [101, 202], true)
        const range = action?.range ? resolveHistoryTimeRange(historyTimeRange(action.range.start, action.range.end, 'local')) : null
        const plan = range?.valid && action?.focus?.state === 'found' ? historyQueryPlan({ objectId: 7, ...range, mode: 'chart', page: 0, registerIds: [action.focus.id] }) : null
        setResult(JSON.stringify({ target, action, queryPreviewOnly: plan?.url ?? '无查询：精确点位缺失或区间无效' }, null, 2))
      }} />
    </div><p className="alarm-history-hint">定位当前命中条件的采样，不是首次告警时间。实际查询按当前点表解释原始值；不保证采样已落库或仍被保留，也不把当前批次状态套给历史数据。</p></div>
    <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }} role="status">{result}</pre>
    <p>手测：切换两来源，ID正确且结束时间为显示的UTC毫秒、区间恰好5分钟、valueMode为raw；多字无批次/错时/混批/缺字/过期/未来/未就绪禁用，单字无批次可定位但明确标注。模拟点击过期不导航，新采样恢复；缺失历史ID不选别的点。中英文、长标签和360px窄屏。实际历史曲线/请求、空数据与恢复未在本页模拟。</p>
  </main>
}
createRoot(document.getElementById('root')!).render(<Preview />)
