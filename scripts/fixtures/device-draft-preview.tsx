import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { DeviceModal, type DeviceFields } from '../../apps/web/src/DeviceModal'
import '../../apps/web/src/styles.css'

const sample = { id: 1, name: '模拟设备 · 本地草稿', mode: 'master', ip: 'mock.invalid', port: 502, transport: 'tcp', serialPath: 'MOCK_UI_A', baudRate: 9600, parity: 'even', stopBits: 1, dataBits: 8, flowControl: 'none', slaveId: 1, pollIntervalMs: 1000, timeoutMs: 3000 }
const labels: Record<string, [string, string]> = {
  cancel: ['取消', 'Cancel'], save: ['保存', 'Save'], add: ['新增', 'Add'], working: ['处理中…', 'Working…'], name: ['名称', 'Name'], ip: ['目标地址', 'Host'], port: ['端口', 'Port'], transport: ['传输方式', 'Transport'], transportTcp: ['TCP', 'TCP'], transportRtu: ['串口 RTU', 'Serial RTU'], baudRate: ['波特率', 'Baud rate'], parity: ['校验位', 'Parity'], stopBits: ['停止位', 'Stop bits'], flowControl: ['流控', 'Flow control'], slaveIdLabel: ['从站编号', 'Slave ID'], pollIntervalLabel: ['采集间隔', 'Poll interval'], timeoutLabel: ['通信超时', 'Timeout'], pollIntervalHint: ['此页不会实际采集。', 'No real polling on this page.'], timeoutHint: ['此页不会实际连接设备。', 'No real device connection on this page.'], editDeviceTitle: ['编辑模拟设备', 'Edit mock device'], newDeviceTitle: ['新增模拟设备', 'Add mock device'], operationFailed: ['操作失败', 'Operation failed'],
}
function Preview() {
  const [open, setOpen] = useState(true), [isNew, setNew] = useState(false), [english, setEnglish] = useState(false), [outcome, setOutcome] = useState('success')
  const [saves, setSaves] = useState(0), [closed, setClosed] = useState(0), [value, setValue] = useState<DeviceFields | null>(null)
  const t = (key: string) => labels[key]?.[english ? 1 : 0] ?? key
  return <main style={{ padding: 20, maxWidth: 1000, margin: 'auto' }}><h1>设备草稿关闭保护 · 纯 mock</h1>
    <p>仅本页输入和计数，不读写配置或设备；串口选择只显示模拟端口，绝不枚举系统端口。模拟保存 {saves} 次，主动关闭 {closed} 次。</p>
    <div className="toolbar"><label><input type="checkbox" checked={isNew} onChange={e => setNew(e.target.checked)} />新增设备</label><label><input type="checkbox" checked={english} onChange={e => setEnglish(e.target.checked)} />English</label><label>模拟保存<select value={outcome} onChange={e => setOutcome(e.target.value)}><option value="success">成功</option><option value="failure">失败 / 结果未知</option><option value="slow">等待4秒后成功</option></select></label><button className="btn" type="button" onClick={() => setOpen(true)}>打开窗口</button></div>
    <p>先关闭窗口再切换预览选项。手测：无改动直接关闭；修改名称/地址/串口后用×、取消或Escape，应先确认；继续编辑保留输入，确认中Escape恢复编辑，放弃只关闭不保存。改回原值应直接关闭。保存等待中关闭无效；模拟失败后仍保留草稿且可明确放弃。另测RTU隐藏字段、Tab焦点、中英、窄屏和长输入。</p>
    <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{value ? JSON.stringify(value, null, 2) : '尚未模拟保存'}</pre>
    {open && <DeviceModal t={t} initial={isNew ? null : sample} onClose={() => { setClosed(count => count + 1); setOpen(false) }} onSave={async fields => {
      setSaves(count => count + 1)
      if (outcome === 'slow') await new Promise(resolve => setTimeout(resolve, 4000))
      if (outcome === 'failure') throw new Error(english ? 'Synthetic unknown outcome; no real request was sent.' : '模拟结果未知；没有发送真实请求，草稿仍保留。')
      setValue(fields); setOpen(false)
    }} portFetcher={async signal => { await new Promise(resolve => setTimeout(resolve, 100)); signal.throwIfAborted(); return { ports: [{ path: 'MOCK_UI_A', description: '模拟端口 A' }, { path: 'MOCK_UI_B', description: '模拟端口 B' }], source: 'mock', location: 'backend', enumerationOnly: true } }} />}
  </main>
}
createRoot(document.getElementById('root')!).render(<Preview />)
