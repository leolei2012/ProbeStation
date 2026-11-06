import React, { useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { HistoryQueryMemoryPanel } from '../../apps/web/src/HistoryQueryMemory'
import { HistoryQueryMemory, QueryMemoryError, queryMemoryContext } from '../../apps/web/src/history-query-memory'
import { HistoryTimeRange } from '../../apps/web/src/HistoryTimeRange'
import { historyTimeRange, resolveHistoryTimeRange, editHistoryTime, changeHistoryInputZone } from '../../apps/web/src/history-time-range'
import { historyQueryPlan } from '../../apps/web/src/history-query-task'
import '../../apps/web/src/styles.css'

const start = Date.parse('2026-11-06T00:00:00.123Z'), end = Date.parse('2026-11-06T01:00:00.987Z')
const device = { id: 9999, mode: 'master', transport: 'tcp', ip: 'synthetic.invalid', port: 502 }
const points = [1, 2].map(i => ({ id: i * 11, objectId: 9999, groupId: i * 10, slaveId: i, alias: '合成温度' + (i === 1 ? '很长的查询点位描述'.repeat(10) : ''), dataType: 'uint32', functionCode: 3, startAddress: 0, factor: 1 }))
function Preview() {
  const [memory, setMemory] = useState(() => new HistoryQueryMemory(device.id)), [history, setHistory] = useState(true), [english, setEnglish] = useState(false)
  const [state, setState] = useState('ready'), [range, setRange] = useState(() => historyTimeRange(start, end)), [mode, setMode] = useState<'chart' | 'table'>('chart'), [valueMode, setValueMode] = useState<'physical' | 'raw'>('physical'), [selected, setSelected] = useState([11, 22]), [applied, setApplied] = useState('尚未恢复。')
  const context = useMemo(() => queryMemoryContext(state === 'device' ? { ...device, port: 503 } : device, state === 'missing' ? points.slice(1) : state === 'changed' ? points.map(p => ({ ...p, factor: 0 })) : points), [state])
  const ready = state !== 'loading', resolved = resolveHistoryTimeRange(range)
  return <main style={{ padding: 24 }}><h1>纯 mock 本页暂存查询</h1><p>正式面板和校验模型；只保留合成条件，不请求历史、不读库、不连接设备。这里的标签切换演示面板卸载后重新挂载，实际App集成仍需手测。</p>
    <div className="toolbar"><button className="btn" onClick={() => setHistory(v => !v)}>{history ? '模拟离开历史标签' : '回到历史标签'}</button><button className="btn" onClick={() => { setMemory(new HistoryQueryMemory(device.id)); setApplied('设备页生命周期已重建。') }}>模拟离开再进入设备（清空）</button><label><input type="checkbox" checked={english} onChange={e => setEnglish(e.target.checked)} />English</label>
      <label>配置状态<select value={state} onChange={e => setState(e.target.value)}><option value="ready">原配置（可恢复）</option><option value="loading">加载中</option><option value="missing">点位11缺失</option><option value="changed">倍率改为0</option><option value="device">设备连接变化</option></select></label></div>
    {history ? <section><div className="toolbar"><label>模式<select value={mode} onChange={e => setMode(e.target.value as typeof mode)}><option value="chart">曲线</option><option value="table">表格</option></select></label><label>数值<select value={valueMode} onChange={e => setValueMode(e.target.value as typeof valueMode)}><option value="physical">物理量</option><option value="raw">原始值</option></select></label>
      {points.map(p => <label key={p.id}><input type="checkbox" checked={selected.includes(p.id)} onChange={e => setSelected(ids => e.target.checked ? [...ids, p.id] : ids.filter(id => id !== p.id))} />#{p.id} · 配置从站{p.slaveId}</label>)}</div>
      <HistoryTimeRange range={range} onEdit={(field, value) => setRange(r => editHistoryTime(r, field, value))} onZone={zone => setRange(r => changeHistoryInputZone(r, zone))} english={english} />
      <p>合成曲线视窗：完整范围内缩两端各四分之一（表格模式不可选）。</p>
      <HistoryQueryMemoryPanel memory={memory} context={context} ready={ready} canSave={resolved.valid && selected.length > 0} canViewport={mode === 'chart' && resolved.valid} english={english}
        onSave={(name, scope) => {
          if (!resolved.valid) throw new QueryMemoryError('invalid-query')
          const delta = Math.floor((resolved.end - resolved.start) / 4)
          return memory.save(name, { start: resolved.start + (scope === 'viewport' ? delta : 0), end: resolved.end - (scope === 'viewport' ? delta : 0), registerIds: selected, mode, valueMode, inputZone: range.zone, scope }, context, ready)
        }}
        onRestore={id => memory.restore(id, context, ready, saved => {
          setRange(historyTimeRange(saved.start, saved.end, saved.inputZone)); setMode(saved.mode); setValueMode(saved.valueMode); setSelected(saved.points.map(p => p.id))
          setApplied('仅构造新查询参数，从不发送：\n' + (historyQueryPlan({ objectId: saved.deviceId, start: saved.start, end: saved.end, mode: saved.mode, page: 0, registerIds: saved.points.map(p => p.id) })?.url ?? '无有效查询参数'))
        })} />
    </section> : <p>模拟实时标签：没有真实采样或通信；历史面板已卸载。</p>}
    <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }} role="status">{applied}</pre>
    <p>手测：命名保存→切换标签→恢复；保存视窗→成为完整区间；重复保存、7条条件分页、超长名称、移除、加载/缺失/变更后恢复原配置、中英文及360px窄屏。实际App还需验收恢复后的查询取消/重新请求、分页/缩放/A/B重置。</p>
  </main>
}
createRoot(document.getElementById('root')!).render(<Preview />)
