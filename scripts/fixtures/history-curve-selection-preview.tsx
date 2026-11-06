import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { planHistoryCurve } from '../../packages/core/src/history-curve-plan'
import { withRegisterSources } from '../../packages/core/src/sample-source'
import { HistoryCurveSelection } from '../../apps/web/src/HistoryCurveSelection'
import { buildPointLabels } from '../../apps/web/src/PointLabel'
import { historyQueryPlan } from '../../apps/web/src/history-query-task'
import '../../apps/web/src/styles.css'

const p = (id: number, groupId: number, startAddress: number, dataType: string) => ({ id, objectId: 7, groupId, alias: '同名合成点', functionCode: 3, startAddress, dataType })
function Preview() {
  const [selected, setSelected] = useState([2, 3, 5, 8]), [mode, setMode] = useState<'chart' | 'table'>('chart'), [firstNarrow, setFirstNarrow] = useState(false), [largerGroup, setLargerGroup] = useState(false), [english, setEnglish] = useState(false), [longName, setLongName] = useState(false)
  const groups = [{ id: 10, name: 'source1', slaveId: 1, functionCode: 3, startAddress: 0, quantity: largerGroup ? 10 : 6 }, { id: 20, name: 'source2', slaveId: 2, functionCode: 3, startAddress: 0, quantity: 2000 }]
  const base = [p(1, 10, 0, firstNarrow ? 'uint16' : 'uint32'), p(2, 10, 1, 'uint16'), p(3, 10, 2, 'hex16'), p(4, 10, 2, 'uint16'), p(5, 10, 4, 'uint64'), p(6, 10, 5, 'uint16'), p(7, 20, 0, 'bin32'), p(8, 20, 3, 'int16'), p(9, 999, 0, 'uint16')]
  if (longName) base[2] = { ...base[2], alias: '很长的合成点位说明'.repeat(30) }
  const extras = Array.from({ length: 150 }, (_, i) => p(1000 + i, 20, 10 + i, 'hex16')), points = withRegisterSources([...base, ...extras], groups, { mode: 'master', slaveId: 9 })
  const eligibility = planHistoryCurve(groups, points, selected)
  const plan = historyQueryPlan({ objectId: 7, start: Date.parse('2026-11-06T00:00:00.123Z'), end: Date.parse('2026-11-06T01:00:00.987Z'), mode, page: 0, registerIds: mode === 'chart' ? eligibility.registers.map(p => p.id) : selected })
  const labels = buildPointLabels(points, groups, key => ({ pointSource: english ? 'Configured slave' : '配置从站', pointSourceUnknown: english ? 'Unknown source' : '来源未知', colAddr: english ? 'Address' : '地址' }[key] ?? key))
  return <main style={{ padding: 24 }}><h1>纯 mock 为什么所选点没有曲线</h1><p>正式共享规划器、原因面板、来源标签及请求参数构造；所有点表为合成。不调用API、不读库、不连接设备，也不修改真实配置。这里仅展示条件，不模拟历史数据或质量。</p>
    <div className="toolbar"><button className="btn" onClick={() => setMode('chart')}>数值曲线</button><button className="btn" onClick={() => setMode('table')}>历史表格</button><button className="btn" onClick={() => setSelected([2, 3, 4, 5, 6, 7, 9])}>只选不能参与的点</button><button className="btn" onClick={() => setSelected([1, 8])}>只选可查询点</button><button className="btn" onClick={() => setSelected([2, 3, 5, 8])}>混合选择</button><button className="btn" onClick={() => setSelected([2, 3, 5, ...extras.map(p => p.id)])}>分页演示150项</button><button className="btn" onClick={() => setSelected([])}>清空选择</button></div>
    <div className="toolbar"><label><input type="checkbox" checked={firstNarrow} onChange={e => setFirstNarrow(e.target.checked)} />仅合成：前项#1改16位释放#2</label><label><input type="checkbox" checked={largerGroup} onChange={e => setLargerGroup(e.target.checked)} />仅合成：第一组扩大到10字</label><label><input type="checkbox" checked={longName} onChange={e => setLongName(e.target.checked)} />超长名称</label><label><input type="checkbox" checked={english} onChange={e => setEnglish(e.target.checked)} />English</label></div>
    <div className="toolbar">{base.map(point => <label key={point.id}><input type="checkbox" checked={selected.includes(point.id)} onChange={e => setSelected(ids => e.target.checked ? [...ids, point.id] : ids.filter(id => id !== point.id))} />#{point.id} · {point.dataType} · addr{point.startAddress} · G{point.groupId}</label>)}</div>
    <p role="status">模拟模式：{mode}；保留的全部选择：{selected.join(', ') || '无'}。参数仅展示，从不发送。</p>
    {mode === 'chart' ? <HistoryCurveSelection plan={eligibility} pointLabels={labels} onTable={() => setMode('table')} english={english} /> : <p>模拟表格只展示完整选择的请求条件，没有读取或伪造行数据；是否有历史数据仍需实际查询。</p>}
    <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{plan?.url ?? '无查询：未选点位或没有可参与数值曲线的点位。'}</pre>
    <p>手测：混合与全不能参与、各原因筛选/分页、表格入口保留全部选择、合成定义调整后恢复、空选择、相同名称不同来源、长标签、中英文和360px窄屏。#3格式本身不能参与但仍按既有跨度优先级覆盖#4；#5越过组末端时仍会覆盖#6，原因不会暗示前项已绘制。实际App曲线、表格和导出仍需隔离验收。</p>
  </main>
}
createRoot(document.getElementById('root')!).render(<Preview />)
