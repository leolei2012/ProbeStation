import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { RegisterSelectButton } from '../../apps/web/src/RegisterPicker'
import '../../apps/web/src/styles.css'

const words: Record<string, string> = { selectRegisters: '选择点位', pickerSource: '从站', pickerAllSources: '全部从站', pickerSourceUnknown: '来源未知', pickerSearch: '搜索名称、地址或点位编号（id:编号）', pickerClearFilters: '清除筛选', pickerSelectVisible: '选择筛选结果', pickerClearSelection: '清空全部选择', noMatchingPoints: '没有匹配的点位', cancel: '取消', save: '保存', curveSelectLimit: '最多选择 {n} 个点位', colAddr: '地址' }
const groups = [
  { id: 1, name: '同名分组：长标签与来源', slaveId: 1, registers: [{ id: 11, alias: '温度：非常长的点位名称用于确认省略与窄屏布局', startAddress: 0, functionCode: 3, dataType: 'uint16' }, { id: 12, alias: '电流', startAddress: 16, functionCode: 3, dataType: 'float32' }] },
  { id: 2, name: '同名分组：长标签与来源', slaveId: 2, registers: [{ id: 22, alias: '温度', startAddress: 0, functionCode: 3, dataType: 'uint16' }] },
  { id: 3, name: '缺少来源的模拟配置', registers: [{ id: 33, alias: '状态', startAddress: 4, functionCode: 4, dataType: 'uint16' }] },
]
function Preview() {
  const [ids, setIds] = useState(new Set<number>()), [mode, setMode] = useState('master'), [empty, setEmpty] = useState(false)
  const available = empty ? [] : groups, allowed = new Set(available.flatMap(g => g.registers.map(r => r.id)))
  const selected = new Set([...ids].filter(id => allowed.has(id)))
  return <main style={{ padding: 24 }}>
    <h1>纯 mock 选点流程</h1>
    <p>无数据库、无设备、无API请求；选择只保存在此页面内存。</p>
    <p>可搜索 id:22、0x0000；窗口缩至360px可检查长名称与窄屏。预览上限2个，实际实时曲线上限保持8个。</p>
    <label>预览角色 <select aria-label="预览角色" value={mode} onChange={e => setMode(e.target.value)}><option value="master">主站多从站</option><option value="slave">本地从站7</option></select></label>
    <label><input type="checkbox" checked={empty} onChange={e => setEmpty(e.target.checked)} />空点表</label>
    <RegisterSelectButton t={key => words[key] ?? key} groups={available} selected={selected} max={2} deviceSlaveId={mode === 'slave' ? 7 : undefined} onApply={setIds} />
    <p>已应用点位：<output aria-label="已应用点位">{JSON.stringify([...selected])}</output></p>
  </main>
}
createRoot(document.getElementById('root')!).render(<Preview />)
