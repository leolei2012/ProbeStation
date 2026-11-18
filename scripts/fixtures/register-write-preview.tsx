import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { RegisterWriteModal } from '../../apps/web/src/RegisterWriteModal'
import { registerWriteSource, type GuardedWriteResult } from '../../packages/core/src/guarded-register-write'
import '../../apps/web/src/styles.css'

const source = registerWriteSource({ id: 1, name: '压缩机测试设备（模拟）', mode: 'master', transport: 'tcp', ip: '192.0.2.10', port: 502, serialPath: null, baudRate: 9600, parity: 'even', stopBits: 1, dataBits: 8, flowControl: 'none' },
  { id: 1, slaveId: 7, functionCode: 3, startAddress: 0x1000, quantity: 1 }, { id: 1, groupId: 1, objectId: 1, alias: '压缩机开关', startAddress: 0x1000, functionCode: 3, dataType: 'uint16', factor: 1, offset: 0 })
let operation: GuardedWriteResult | null = null, writes = 0, lose = false
const publish = () => { const label = document.getElementById('mock-write-count'); if (label) label.textContent = String(writes) }
globalThis.fetch = async (input, init) => {
  const path = String(input), body = JSON.parse(String(init?.body ?? '{}'))
  if (path.endsWith('/prepare')) {
    const id = '12345678-1234-1234-1234-123456789abc'
    operation = { version: 1, id, state: 'prepared', message: '', plan: { version: 1, id, source, scope: 'preview-only', revision: 'preview-only', channel: 'preview-only', value: body.value, words: [Number(body.value)], functionCode: 6, timeoutMs: 100, expiresAt: Date.now() + 120000 } }
  } else if (path.endsWith('/execute')) {
    writes++; publish(); operation!.state = lose ? 'unknown' : 'acknowledged'
    operation!.message = lose ? '模拟：已提交但没有匹配回执；请核实，不自动重发。' : '模拟：设备已返回匹配的 Modbus 写入回执。此回执不等于压缩机已实际运转。'
    if (lose) throw Error('模拟响应丢失，请查询原操作。')
  } else if (path.endsWith('/review-unknown')) { operation!.state = 'reviewed-unknown'; operation!.message = '模拟：已记录现场核实，不重发原计划。' }
  else if (path.endsWith('/cancel') && operation!.state === 'prepared') { operation!.state = 'not-sent'; operation!.message = '模拟：已取消尚未发送的写入。' }
  return new Response(JSON.stringify(operation), { headers: { 'Content-Type': 'application/json' } })
}
function Preview() {
  const [open, setOpen] = useState(false), [english, setEnglish] = useState(false), [changed, setChanged] = useState(false)
  return <main style={{ padding: 20 }}><h2>写入确认 · 纯模拟预览</h2><p>无后端、无串口、无设备通信。模拟发送次数：<strong id="mock-write-count">0</strong></p>
    <div className="toolbar"><button className="btn" onClick={() => { setChanged(false); setOpen(true) }}>打开写入</button><button className="btn" onClick={() => setEnglish(v => !v)}>中文 / English</button><button className="btn" onClick={() => setChanged(v => !v)}>模拟配置变化</button><label><input type="checkbox" onChange={e => { lose = e.target.checked }} />模拟丢回执</label></div>
    {open && <RegisterWriteModal source={changed ? { ...source, group: { ...source.group, slaveId: 9 } } : source} currentValue="0" english={english} onClose={() => setOpen(false)} />}
  </main>
}
createRoot(document.getElementById('root')!).render(<Preview />)
