import React, { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { DiagnosticsCleanupButton } from '../../apps/web/src/DiagnosticsCleanupDialog'
import { DiagnosticsCleanupFlow } from '../../apps/web/src/diagnostics-cleanup-flow'
import { diagnosticsCleanupTarget, type DiagnosticsCleanupPreview } from '../../packages/core/src/diagnostics-cleanup'
import '../../apps/web/src/styles.css'

function Preview() {
  const [mode, setMode] = useState('normal'), [transport, setTransport] = useState('rtu'), [english, setEnglish] = useState(false), [paused, setPaused] = useState(false), [revision, setRevision] = useState(0), [display, setDisplay] = useState('尚无已确认结果')
  const device = { id: 1, name: '合成诊断对象 · <script>仅文本</script>', transport, mode: 'master', ip: 'mock.invalid', port: 502, serialPath: 'COM_MOCK', baudRate: 9600, parity: 'even', stopBits: 1, dataBits: 8, flowControl: 'none' }
  const current = useRef({ mode, device }); current.current = { mode, device }
  const memory = useRef({ frames: 4, success: 3, errors: 1, previews: 0, posts: 0, clears: 0, proposals: new Map<string, { preview: DiagnosticsCleanupPreview; result?: unknown; used?: boolean }>() })
  const [flow] = useState(() => new DiagnosticsCleanupFlow(async (_url, init) => {
    const chosen = current.current.mode, mem = memory.current
    if (init?.method !== 'POST') {
      mem.previews++; setRevision(value => value + 1)
      if (chosen === 'preview-fail') return new Response('{}', { status: 503 })
      if (chosen === 'preview-hang') return new Promise(() => {})
      const target = diagnosticsCleanupTarget(current.current.device), token = '00000000-0000-4000-8000-' + mem.previews.toString().padStart(12, '0')
      const preview = { ...target, version: 1 as const, token, expiresAt: new Date(Date.now() + 600000).toISOString(), bufferedFrames: mem.frames, successCount: mem.success, errorCount: mem.errors }
      mem.proposals.set(token, { preview }); return Response.json(preview)
    }
    mem.posts++; setRevision(value => value + 1)
    const token = JSON.parse(String(init.body)).token, entry = mem.proposals.get(token)
    if (chosen === 'slow') await new Promise(resolve => setTimeout(resolve, 2000))
    if (!entry || entry.preview.targetKey !== diagnosticsCleanupTarget(current.current.device).targetKey || chosen === 'conflict') return new Response('{}', { status: 409 })
    if (entry.result) return Response.json(entry.result)
    if (entry.used) return new Response('{}', { status: 500 })
    entry.used = true
    const result = { ...entry.preview, ok: true, completedAt: new Date().toISOString(), clearedFrames: mem.frames, clearedRequests: mem.success + mem.errors }
    mem.frames = mem.success = mem.errors = 0; mem.clears++; setRevision(value => value + 1)
    if (chosen === 'lost') throw new Error('synthetic response loss after clearing')
    if (chosen === 'bad-ack') return Response.json({ ok: true })
    entry.result = result; return Response.json(result)
  }))
  const mem = memory.current
  return <main style={{ padding: 24, maxWidth: 1050, margin: 'auto' }}><h1>诊断清空 · 纯 mock 手测</h1><p>正式客户端/对话框，服务端为简化内存模拟，不是实际条件引擎。所有端口、对象、记录及凭据均为合成值；无网络、真实清空、设备或数据库。修订 {revision}。</p>
    <div className="toolbar"><label>下次响应<select value={mode} onChange={e => setMode(e.target.value)}>{[['normal', '成功'], ['slow', '清空延迟2秒'], ['lost', '已清空但丢响应'], ['bad-ack', '已清空但坏回执'], ['conflict', '来源条件冲突，不执行'], ['preview-fail', '预览不可用'], ['preview-hang', '预览挂起10秒超时']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>合成目标<select value={transport} onChange={e => setTransport(e.target.value)}><option value="rtu">共享RTU（非系统端口）</option><option value="tcp">TCP</option></select></label><label><input type="checkbox" checked={english} onChange={e => setEnglish(e.target.checked)} />English</label><label><input type="checkbox" checked={paused} onChange={e => setPaused(e.target.checked)} />模拟页面暂停</label><button type="button" className="btn" onClick={() => { mem.frames++; mem.success++; setRevision(value => value + 1) }}>增加合成新捕获</button></div>
    <p>模拟缓冲 {mem.frames}，成功 {mem.success}，失败 {mem.errors}；GET {mem.previews} / POST {mem.posts} / 实际模拟清空 {mem.clears}。</p>
    <DiagnosticsCleanupButton device={device} flow={flow} disabled={paused} english={english} onCleared={result => setDisplay(`本页收到已核对回执：${result.clearedFrames}条。正式应用会使旧显示快照失效；新捕获仍可继续到达。`)} />
    <p role="status">{display}</p><p>手测：打开仅预览；关闭→增加记录→重开确认，连新增也清空且POST只一次。慢写关闭/重开不重复POST，暂停仍可查看状态但不可新确认；已清空丢响应/坏回执显示未知，不能直接重试。关闭→换TCP/RTU后旧条件不能确认，显式新预览才可。检查超时恢复、冲突、零计数确认、英文、焦点、长标签和360px布局。这里模拟令牌不是安全凭据，CSP禁止联网，不保存文件。</p>
  </main>
}
createRoot(document.getElementById('root')!).render(<Preview />)
