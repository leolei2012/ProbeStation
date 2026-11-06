import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { RegisterSelectButton } from '../../apps/web/src/RegisterPicker'
import { PointLabel, buildPointLabels } from '../../apps/web/src/PointLabel'
import { HistoryQualitySummary } from '../../apps/web/src/HistoryQualitySummary'
import '../../apps/web/src/styles.css'

const words: Record<string, string> = { pointSource: '配置从站', pointSourceUnknown: '配置来源未知', histQualityTitle: '采样质量摘要（模拟）', histQualityHint: '仅检查标签，以下计数为固定模拟数据。', selectRegisters: '选择点位', pickerSource: '从站', pickerAllSources: '全部从站', pickerSourceUnknown: '来源未知', pickerSearch: '搜索名称、地址或点位编号（id:编号）', pickerClearFilters: '清除筛选', pickerSelectVisible: '选择筛选结果', pickerClearSelection: '清空全部选择', noMatchingPoints: '没有匹配的点位', cancel: '取消', save: '保存', curveSelectLimit: '最多选择 {n} 个点位', colAddr: '地址' }
const groups = [
  { id: 1, name: '同名分组：长标签与来源', slaveId: 1, registers: [{ id: 11, alias: '温度：非常长的点位名称用于确认省略与窄屏布局', startAddress: 0, functionCode: 3, dataType: 'uint16' }, { id: 12, alias: '电流', startAddress: 16, functionCode: 3, dataType: 'float32' }, { id: 13, alias: '温度', startAddress: 4, functionCode: 3, dataType: 'uint16' }] },
  { id: 2, name: '同名分组：长标签与来源', slaveId: 2, registers: [{ id: 22, alias: '温度', startAddress: 0, functionCode: 3, dataType: 'uint16' }] },
  { id: 3, name: '缺少来源的模拟配置', registers: [{ id: 33, alias: '状态', startAddress: 4, functionCode: 4, dataType: 'uint16' }] },
]
function Preview() {
  const [ids, setIds] = useState(new Set<number>()), [mode, setMode] = useState('master'), [empty, setEmpty] = useState(false)
  const available = empty ? [] : groups, allowed = new Set(available.flatMap(g => g.registers.map(r => r.id)))
  const selected = new Set([...ids].filter(id => allowed.has(id)))
  const t = (key: string) => words[key] ?? key
  const points = available.flatMap(g => g.registers.map(r => ({ ...r, groupId: g.id })))
  const labels = buildPointLabels(points, available, t, mode === 'slave' ? 7 : undefined)
  const chosen = points.filter(p => selected.has(p.id))
  return <main style={{ padding: 24 }}>
    <h1>纯 mock 选点流程</h1>
    <p>无数据库、无设备、无API请求；选择只保存在此页面内存。</p>
    <p>可搜索 id:22、0x0000；窗口缩至360px可检查长名称与窄屏。预览上限2个，实际实时曲线上限保持8个。</p>
    <label>预览角色 <select aria-label="预览角色" value={mode} onChange={e => setMode(e.target.value)}><option value="master">主站多从站</option><option value="slave">本地从站7</option></select></label>
    <label><input type="checkbox" checked={empty} onChange={e => setEmpty(e.target.checked)} />空点表</label>
    <RegisterSelectButton t={t} groups={available} selected={selected} max={2} deviceSlaveId={mode === 'slave' ? 7 : undefined} onApply={setIds} />
    <p>已应用点位：<output aria-label="已应用点位">{JSON.stringify([...selected])}</output></p>
    <p>选择 #13 和 #22 检查重名来源标签；过滤或仅选一个后标识仍保留。标签是当前配置，不代表样本来源已验证。</p>
    <div className="history-table-scroll"><table className="reg hist-table"><thead><tr>{chosen.map(p => <th key={p.id}><PointLabel label={labels.get(p.id)!} /></th>)}</tr></thead><tbody><tr>{chosen.map(p => <td key={p.id}>— [未知]</td>)}</tr></tbody></table></div>
    <div className="history-legend">{chosen.map(p => <button className="history-series-toggle" key={p.id}><strong><PointLabel label={labels.get(p.id)!} /></strong><span>模拟图例 · 无采样</span></button>)}</div>
    <HistoryQualitySummary t={t} registers={points} pointLabels={labels} series={chosen.map(p => ({ id: p.id, samples: [], gapMs: 1000, summary: { sourceSamples: 1, validSamples: 0, invalidSamples: 1 }, integrity: { verified: 0, unverified: 0, unknown: 1 } }))} />
  </main>
}
createRoot(document.getElementById('root')!).render(<Preview />)
