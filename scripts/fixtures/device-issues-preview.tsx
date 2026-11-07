import React, { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { DeviceIssues, type DataTarget } from '../../apps/web/src/DeviceIssues'
import '../../apps/web/src/styles.css'
import '../../apps/web/src/assistant.css'

function Preview() {
  const [mode, setMode] = useState('normal'), [english, setEnglish] = useState(false), [open, setOpen] = useState(true)
  const [reads, setReads] = useState(0), [target, setTarget] = useState<DataTarget | null>(null)
  const source = useRef(mode); source.current = mode
  const get = async (_url: string, _signal: AbortSignal) => {
    const selected = source.current; setReads(count => count + 1)
    if (selected === 'timeout') return new Promise(() => {})
    // Deliberately ignore abort, to exercise isolation after closing the component.
    await new Promise(resolve => setTimeout(resolve, selected === 'slow' ? 2000 : 250))
    if (selected === 'failure') throw new Error('mock request failure')
    if (selected === 'invalid') return { issues: null, checkedAt: Date.now() }
    const issues = selected === 'empty' ? [] : [
      { deviceId: 1, view: 'live', label: '模拟设备A', reason: '设备已暂停' },
      { deviceId: 2, view: 'diagnostics', label: '模拟设备B', reason: 'TCP 通道未连接' },
      { deviceId: 2, view: 'live', label: '模拟设备B', reason: '包含暂停分组（同设备第二条提醒应保留）' },
      { deviceId: 3, view: 'history', label: '模拟长标签-'.repeat(18), reason: '<script>仅显示文字</script>；' + '长说明/不可当成当前状态结论。'.repeat(10), registerId: 9, start: '2026-11-07T00:00:00.123Z', end: '2026-11-07T00:05:00.456Z', valueMode: 'raw' },
    ]
    return { issues, ...(selected === 'legacy' ? {} : { checkedAt: Date.now() }) }
  }
  return <main style={{ padding: 24, maxWidth: 1050, margin: 'auto' }}><h1>设备状态提醒 · 纯 mock</h1>
    <p>所有结果为本页合成数据。读取 {reads} 次；不访问后端、数据库、设备或模型。关闭面板停止下一次轮询；重开创建新读取器。</p>
    <div className="toolbar"><label>下一次读取<select value={mode} onChange={event => setMode(event.target.value)}><option value="normal">正常及同设备多条提醒</option><option value="empty">无提醒</option><option value="legacy">旧响应缺后端核对时间</option><option value="failure">读取失败</option><option value="invalid">异常数组响应</option><option value="timeout">挂起（10秒超时）</option><option value="slow">2秒迟到响应（忽略取消）</option></select></label><label><input type="checkbox" checked={english} onChange={event => setEnglish(event.target.checked)} />English</label><button type="button" className="btn" onClick={() => setOpen(value => !value)}>{open ? '关闭面板' : '重开面板'}</button></div>
    {open && <DeviceIssues get={get} english={english} onNavigate={setTarget} />}
    <p>点击提醒仅在下面显示关联目标，不跳转或操作设备：</p><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{target ? JSON.stringify(target, null, 2) : '尚未选择'}</pre>
    <p>手测：正常后切到失败/异常/超时并点重新核对，旧提醒应保留并标未核实；切回正常可手动恢复，也可等待自动轮询。读取中按钮禁用，计数不重复；选择2秒迟到后立即关闭、改空结果再重开，旧结果不应回填。缺时间只显示未提供；无提醒不报健康。另测窄屏、长标签、中英和展开时间说明。</p>
  </main>
}
createRoot(document.getElementById('root')!).render(<Preview />)
