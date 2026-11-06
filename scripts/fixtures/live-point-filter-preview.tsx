import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { LivePointFilters } from '../../apps/web/src/LivePointFilters'
import { evaluateLivePoints, livePointFilterResult, type LivePointFilter } from '../../apps/web/src/live-point-filter'
import { pickerSources } from '../../apps/web/src/register-picker'
import { sourceKey } from '../../packages/core/src/sample-source'
import type { Sample } from '../../apps/web/src/observation'
import '../../apps/web/src/styles.css'

const now = Date.parse('2026-11-06T00:00:00Z')
const point = (id: number, startAddress: number, dataType = 'uint16') => ({ id, alias: '模拟温度（同名点）', startAddress, dataType, functionCode: 3 })
const groups = [
  { id: 1, name: '模拟冷机组', functionCode: 3, isActive: 1, slaveId: 1, registers: [point(1, 0), point(2, 1), point(3, 2, 'uint32')] },
  { id: 2, name: '模拟第二来源', functionCode: 3, isActive: 1, slaveId: 2, registers: [point(4, 1)] },
  { id: 3, name: '模拟未知来源', functionCode: 3, isActive: 1, slaveId: undefined, registers: [point(5, 0)] },
]
const rules = [2, 3, 4, 5].map(id => ({ id, registerId: id, operator: '>', threshold: 100, message: null }))
function Preview() {
  const [mode, setMode] = useState<LivePointFilter>('all'), [search, setSearch] = useState(''), [source, setSource] = useState(''), [scenario, setScenario] = useState('normal'), [english, setEnglish] = useState(false)
  const latest: Record<string, Sample> = {}, set = (slave: number, address: number, rawValue: number, batchId = 'batch-' + slave) => { latest[sourceKey(1, 'holding-register', address, slave)] = { slaveId: slave, rawValue, quality: 'good', timestamp: new Date(now).toISOString(), batchId } }
  set(1, 0, 10); set(1, 1, 200); set(1, 2, 1); set(1, 3, 0, scenario === 'recovery' ? 'batch-1' : 'another-batch'); set(2, 1, 10)
  const views = new Map(groups.flatMap(g => g.registers).map(p => [p.id, { covered: false, invalid: p.id === 5 || p.id === 3 && scenario !== 'recovery' }]))
  const device = { id: 1, isActive: scenario === 'paused' ? 0 : 1, mode: 'master' }, errors: Record<number, string> = scenario === 'fault' ? { 1: '模拟通信错误' } : {}
  const states = evaluateLivePoints(groups, views, latest, device, scenario === 'loading' ? [] : rules, errors, now, 5000)
  const filtered = livePointFilterResult(groups, states, search, source, mode)
  return <main style={{ padding: 24 }}><h1>纯 mock 实时问题筛选</h1><p>固定合成点位/缓存，正式筛选组件与判断逻辑；不连接API、设备、数据库或模型。下方只读示例表不是完整App，不含配置或写入动作。</p>
    <div className="toolbar"><label>模拟状态 <select value={scenario} onChange={e => setScenario(e.target.value)}><option value="normal">新鲜告警、混批待定与同址不同源</option><option value="recovery">完整批次恢复</option><option value="paused">采集暂停</option><option value="fault">分组通信错误</option><option value="loading">规则未载入</option><option value="rule-error">规则读取失败（保留缓存）</option></select></label><label><input type="checkbox" checked={english} onChange={e => setEnglish(e.target.checked)} />English controls</label></div>
    <LivePointFilters search={search} source={source} sources={pickerSources(groups)} mode={mode} counts={filtered.counts} rulesReady={scenario !== 'loading'} ruleError={scenario === 'rule-error'} onSearch={setSearch} onSource={setSource} onMode={setMode} onClear={() => { setSearch(''); setSource(''); setMode('all') }} english={english} />
    <div className="history-table-scroll"><table className="reg"><thead><tr><th>分组 / 从站</th><th>点位</th><th>告警触发</th><th>规则待定</th><th>数据异常</th></tr></thead><tbody>{groups.flatMap(g => g.registers.filter(p => filtered.visibleIds.has(p.id)).map(p => <tr key={p.id}><td>{g.name} / {g.slaveId ?? '?'}</td><td>{p.alias} · #{p.id} · 地址{p.startAddress}</td><td>{String(states.get(p.id)!.alarmActive)}</td><td>{String(states.get(p.id)!.alarmUnknown)}</td><td>{String(states.get(p.id)!.dataIssue)}</td></tr>))}</tbody></table></div>
    {!filtered.visibleIds.size && <p role="status">模拟筛选无匹配点位；可清除筛选。</p>}
    <p>手测：默认“已触发告警”只显示#2，“需关注”含#2、#3、#5；从站2仅#4且不触发。试 id:4 / 0x0001，规则加载/失败提示、完整批恢复和360px窄屏。完整App的临时展开及清除恢复折叠仍需验收。</p>
  </main>
}
createRoot(document.getElementById('root')!).render(<Preview />)
