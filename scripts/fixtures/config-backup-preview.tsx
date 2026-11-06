import React, { useMemo, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { ConfigBackupView } from '../../apps/web/src/ConfigBackupSettings'
import { ConfigBackupFlow } from '../../apps/web/src/config-backup-flow'
import '../../apps/web/src/styles.css'

const counts = { devices: 1, groups: 1, registers: 2, rules: 0 }
const sample = JSON.stringify({ format: 'probestation-config', version: 1, devices: [{}], groups: [{}], registers: [{}, {}], rules: [] })
const preview = { counts, devices: [{ name: '模拟设备（不会连接）', mode: 'master', transport: 'rtu', endpoint: 'MOCK-PORT', sameName: true }] }
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })
function Preview() {
  const [scenario, setScenario] = useState('success'), [open, setOpen] = useState(true), [writes, setWrites] = useState(0), [english, setEnglish] = useState(false)
  const operation = useMemo(() => {
    let finishPending: ((value: Response) => void) | undefined
    const completed = () => response({ ...counts, deviceIds: [42], warnings: scenario === 'warning' ? ['模拟：已提交，变更通知失败。请刷新核对，不要重复恢复。'] : [] })
    const flow = new ConfigBackupFlow(async url => {
      if (String(url).endsWith('/preview')) return response(preview)
      setWrites(value => value + 1)
      if (scenario === 'pending') return new Promise<Response>(resolve => { finishPending = resolve })
      if (scenario === 'loss') throw new Error('模拟：服务器提交后响应丢失')
      if (scenario === 'rejected') return response({ error: '模拟：校验拒绝，没有写入' }, 400)
      if (scenario === 'invalid') return response({ devices: 1 })
      return completed()
    })
    return { flow, finish: () => finishPending?.(completed()) }
  }, [scenario])
  const state = useSyncExternalStore(operation.flow.subscribe, operation.flow.snapshot, operation.flow.snapshot)
  return <main style={{ padding: 24 }}><h1>纯 mock 配置恢复流程</h1><p>固定模拟文件和响应，正式视图/状态机；无文件选择器、API、数据库、设备或模型。这里禁用导出备份。下方计数仅代表模拟恢复请求数，不是实际新增数量。</p>
    <div className="toolbar"><label>模拟场景 <select disabled={state.phase === 'restoring'} value={scenario} onChange={e => { operation.flow.cancelPreview(); setScenario(e.target.value); setWrites(0) }}><option value="success">成功</option><option value="warning">提交成功但通知失败</option><option value="loss">提交后响应丢失</option><option value="rejected">请求被拒绝</option><option value="invalid">返回内容不完整</option><option value="pending">持续等待（10秒提示）</option></select></label><label><input type="checkbox" checked={english} onChange={e => setEnglish(e.target.checked)} />English controls</label><button className="btn" onClick={() => { if (open) operation.flow.cancelPreview(); setOpen(!open) }}>{open ? '关闭模拟设置' : '重新打开模拟设置'}</button>{scenario === 'pending' && <button className="btn" disabled={state.phase !== 'restoring'} onClick={operation.finish}>返回模拟成功响应</button>}</div>
    <p>模拟恢复请求次数：{writes}</p>
    {open && <ConfigBackupView state={state} zh={!english} exportHref={null} onChoose={() => void operation.flow.preview('模拟备份.json', async () => sample)} onCancel={operation.flow.cancelPreview} onRestore={() => void operation.flow.restore()} />}
    <p>手测：预览后确认；成功警告/新增ID应保留。响应丢失后不能直接重复确认，必须新预览。等待场景关闭再打开、10秒提示后返回响应，次数应始终为1。检查窄屏和英文控件。</p>
  </main>
}
createRoot(document.getElementById('root')!).render(<Preview />)
