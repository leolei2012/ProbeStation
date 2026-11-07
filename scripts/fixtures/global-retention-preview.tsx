import React, { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { GlobalRetentionSettings } from '../../apps/web/src/GlobalRetentionSettings'
import { GlobalRetentionFlow, type RetentionApi } from '../../apps/web/src/global-retention-state'
import '../../apps/web/src/styles.css'

function Preview() {
  const [flow] = useState(() => new GlobalRetentionFlow({ readTimeoutMs: 2000, slowWriteMs: 500 }))
  const [open, setOpen] = useState(true), [english, setEnglish] = useState(false), [mode, setMode] = useState('normal')
  const [counts, setCounts] = useState({ reads: 0, writes: 0 }), [actual, setActual] = useState(0)
  const source = useRef({ mode, actual }); source.current = { mode, actual }
  const api: RetentionApi = {
    async get() {
      setCounts(old => ({ ...old, reads: old.reads + 1 })); const selected = source.current.mode, value = source.current.actual
      if (selected === 'read-timeout') return new Promise(() => {})
      await new Promise(resolve => setTimeout(resolve, 300))
      if (selected === 'read-failure') throw new Error('synthetic read failure')
      if (selected === 'read-invalid') return { retention_seconds: '0' }
      return { retention_seconds: value }
    },
    async post(_url, body) {
      setCounts(old => ({ ...old, writes: old.writes + 1 })); const selected = source.current.mode, value = (body as { retention_seconds: number }).retention_seconds
      await new Promise(resolve => setTimeout(resolve, 1500))
      if (selected === 'write-failure') throw new Error('synthetic rejected write')
      setActual(value)
      if (selected === 'lost-ack') throw new Error('synthetic lost acknowledgment after mock change')
      return { ok: true, retention_seconds: value }
    },
  }
  return <main style={{ padding: 24, maxWidth: 1000, margin: 'auto' }}><h1>全局保留策略 · 纯 mock</h1><p>所有读取和更新只操作本页内存数字，不清理任何历史，不连接API、设备或数据库。模拟后台值 {actual} 秒，读取 {counts.reads} 次，更新 {counts.writes} 次。</p>
    <div className="toolbar"><label>下一次模拟结果<select value={mode} onChange={e => setMode(e.target.value)}><option value="normal">正常（更新延迟1.5秒）</option><option value="read-failure">读取失败</option><option value="read-invalid">读取格式错误</option><option value="read-timeout">读取超时2秒</option><option value="write-failure">更新失败</option><option value="lost-ack">更新生效但回执丢失</option></select></label><label><input type="checkbox" checked={english} onChange={e => setEnglish(e.target.checked)} />English</label><button type="button" className="btn" onClick={() => setOpen(value => !value)}>{open ? '关闭面板' : '重新打开面板'}</button></div>
    {open && <GlobalRetentionSettings api={api} flow={flow} english={english} />}
    <p>手测：初始为永久且先读取；选择预设或清空自定义输入应不更新。确认后更新中关闭/重开不重复请求。模拟失败或丢回执后，切回正常并重新读取，只读核对可恢复；本页更新仍禁止。刷新此静态页才创建新的模拟会话。另测窄屏、长提示与中英切换。</p>
  </main>
}
createRoot(document.getElementById('root')!).render(<Preview />)
