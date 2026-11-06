import React, { useCallback, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { PointDiagnosticsPanel } from '../../apps/web/src/PointDiagnostics'
import { buildPointLabels } from '../../apps/web/src/PointLabel'
import { diagnosePointTable } from '../../packages/core/src/point-diagnostics'
import '../../apps/web/src/styles.css'

const devices = [{ id: 1, mode: 'master', slaveId: 1 }]
const groups = [1, 2].map(id => ({ id, objectId: 1, name: '模拟分组 ' + id, slaveId: id, functionCode: 3, startAddress: 0, quantity: 2 }))
const points = Array.from({ length: 48 }, (_, index) => ({ id: index + 1, objectId: 1, groupId: index % 2 + 1, slaveId: index % 2 + 1, alias: '模拟温度（同名不同从站及多定义）', functionCode: 3, startAddress: index === 0 ? 65535 : 1, dataType: index % 3 ? 'uint16' : 'uint32' }))
const labels = buildPointLabels(points, groups, key => ({ pointSource: '配置从站', colAddr: '地址' }[key] ?? key))
function Preview() {
  const [scenario, setScenario] = useState('issues'), [failOnce, setFailOnce] = useState(false), [english, setEnglish] = useState(false)
  const recovered = useRef(false)
  const fetcher = useCallback(async (_url: string, _signal: AbortSignal) => {
    if (scenario === 'hang') return new Promise(() => {})
    if (scenario === 'failure' && !recovered.current) throw new Error('模拟失败')
    if (scenario === 'failure') return diagnosePointTable({ devices, groups, registers: points })
    if (scenario === 'invalid') return { scope: 'point-table-structure', complete: false }
    if (scenario === 'empty') return diagnosePointTable({ devices, groups: [], registers: [] })
    if (scenario === 'clean') return diagnosePointTable({ devices, groups, registers: [{ ...points[0], startAddress: 0, dataType: 'uint16' }] })
    return diagnosePointTable({ devices, groups, registers: points })
  }, [scenario])
  return <main style={{ padding: 24 }}>
    <h1>纯 mock 点表检查</h1><p>使用正式检查面板及真实纯函数诊断规则；固定合成配置，不访问API、设备、数据库或模型。报告下载仅包含这些模拟问题。</p>
    <div className="toolbar"><label>模拟场景 <select value={scenario} onChange={e => { setScenario(e.target.value); setFailOnce(false); recovered.current = false }}><option value="issues">结构错误与警告（含多定义）</option><option value="clean">结构无问题</option><option value="empty">空点表</option><option value="failure">请求失败后恢复</option><option value="invalid">无效报告</option><option value="hang">无响应（10秒超时）</option></select></label><label><input type="checkbox" checked={english} onChange={e => setEnglish(e.target.checked)} />English controls</label>{scenario === 'failure' && <button className="btn" disabled={failOnce} onClick={() => { recovered.current = true; setFailOnce(true) }}>{failOnce ? '已恢复，请点击重新检查' : '恢复模拟响应'}</button>}</div>
    <PointDiagnosticsPanel key={scenario} deviceId={1} points={scenario === 'empty' ? [] : points} groups={groups} pointLabels={labels} fetcher={fetcher} english={english} />
    <p>手测：筛错误/警告、搜索 #48、展开关联点位按“配置从站 2”或 #48 筛选、翻页；筛成无结果后下载仍应是完整报告。切换失败并恢复、空表和无响应场景；检查360px窄屏。</p>
  </main>
}
createRoot(document.getElementById('root')!).render(<Preview />)
