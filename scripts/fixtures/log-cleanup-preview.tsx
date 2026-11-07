import React, { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { LogCleanupFlow } from '../../apps/web/src/log-cleanup-flow'
import { LogCleanupDialog } from '../../apps/web/src/LogCleanupDialog'
import { parseLogCleanupRequest } from '../../packages/core/src/log-cleanup'
import '../../apps/web/src/styles.css'

function Preview() {
  const [open, setOpen] = useState(false), [mode, setMode] = useState('ok'), [rows, setRows] = useState([1, 2, 3]), [writes, setWrites] = useState(0), [english, setEnglish] = useState(false)
  const data = useRef(rows); data.current = rows
  const selected = useRef(mode); selected.current = mode
  const nextId = useRef(4), flow = useRef<LogCleanupFlow>()
  const revision = (id: number, count: number) => 'v1:' + id.toString(16).padStart(32, '0') + count.toString(16).padStart(32, '0')
  if (!flow.current) flow.current = new LogCleanupFlow((async (url: string, init?: RequestInit) => {
    const scenario = selected.current
    if (url.endsWith('cleanup-preview')) {
      if (scenario === 'preview-hang') return new Promise(() => {})
      const count = data.current.length, throughId = Math.max(0, ...data.current)
      return new Response(JSON.stringify({ version: 1, count, throughId, revision: revision(throughId, count) }))
    }
    setWrites(value => value + 1)
    if (scenario === 'conflict') return new Response('{}', { status: 409 })
    if (scenario === 'slow') await new Promise(resolve => setTimeout(resolve, 3000))
    const expected = parseLogCleanupRequest(JSON.parse(String(init?.body))), deleted = data.current.filter(id => id <= expected.throughId).length
    const retained = data.current.filter(id => id > expected.throughId); data.current = retained; setRows(retained)
    if (scenario === 'lost') throw new Error('synthetic response lost after cleanup')
    return new Response(JSON.stringify(scenario === 'bad-ack' ? { ok: true } : { ok: true, throughId: expected.throughId, revision: expected.revision, deleted, alreadyRemoved: expected.count - deleted, remaining: retained.length }))
  }) as typeof fetch, { slowWriteMs: 1000 })
  return <main style={{ padding: 24, maxWidth: 850, margin: 'auto' }}><h1>日志清理 · 纯 mock 手测</h1><p>正式清理对话框/状态模型，全部为本页合成ID与模拟请求。无数据库、真实日志、HTTP或设备；模拟POST {writes} 次。当前合成ID：{rows.join(', ') || '空'}</p>
    <div className="toolbar"><label>下次场景<select value={mode} onChange={e => setMode(e.target.value)}>{[['ok', '正常'], ['slow', '慢写3秒'], ['lost', '执行后响应丢失'], ['bad-ack', '执行后回执异常'], ['conflict', '条件冲突，不执行'], ['preview-hang', '预览挂起，10秒超时']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label><input type="checkbox" checked={english} onChange={e => setEnglish(e.target.checked)} />English</label><button className="btn" onClick={() => setOpen(true)}>打开清理对话框</button><button className="btn" onClick={() => { const next = [...data.current, nextId.current++]; data.current = next; setRows(next) }}>新增合成日志</button></div>
    <p>预览后关闭，新增合成日志，再打开确认：只清理原范围。慢写时关闭重开应显示同一进行中状态，不重复提交；响应丢失/异常不显示成功且阻止直接重试。新预览必须再确认。重复条件冲突、空状态、预览超时恢复、中英文和360px；Tab只在对话框按钮内循环，Esc关闭后返回原焦点。模拟回执不等于真实后端能力，令牌仅为本页合成格式。</p>
    {open && <LogCleanupDialog flow={flow.current} english={english} onClose={() => setOpen(false)} />}
  </main>
}
createRoot(document.getElementById('root')!).render(<Preview />)
