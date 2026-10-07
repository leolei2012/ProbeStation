import { useEffect, useRef, useState } from 'react'
import './assistant.css'
import { assistantRequest as request, type AssistantConfig, type ProviderInfo } from './assistant-client'
import { AssistantModelPicker } from './AssistantModelPicker'
import { AssistantConversation, type AssistantTurn } from './AssistantConversation'

type Proposal = { id: string; label: string; field: string; before: unknown; after: unknown; state: string }
type Session = { turns?: AssistantTurn[]; id: string; entries: { role: string; content: string }[]; proposals: Proposal[]; running: boolean; error?: string }
const stateLabels: Record<string, string> = { pending: '等待确认', applied: '已执行', rejected: '已拒绝', expired: '已过期', conflict: '配置已变化', failed: '执行失败', cancelled: '已取消', applying: '执行中' }
const fieldLabels: Record<string, string> = { name: '名称', alias: '点位名称', unit: '单位', factor: '比例系数', offset: '偏移', pollIntervalMs: '采样间隔（ms）', timeoutMs: '超时（ms）', isActive: '分组启用（1=启用，0=暂停）' }

export function AssistantPanel({ device, onChanged, onOpenSettings, configRevision }: { device: { id: number; name: string } | null; onChanged: () => void; onOpenSettings: () => void; configRevision: number }) {
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [following, setFollowing] = useState(true)
  const [config, setConfig] = useState<AssistantConfig>({ baseUrl: '', model: '', hasKey: false })
  const [session, setSession] = useState<Session | null>(null)
  const [model, setModel] = useState('')
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [configured, setConfigured] = useState<AssistantConfig[]>([])
  const [provider, setProvider] = useState('custom')
  const [attachments, setAttachments] = useState<{ name: string; data: string; size: number }[]>([])
  const [readingFiles, setReadingFiles] = useState(false)
  const attachmentLock = useRef(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const [effort, setEffort] = useState('default')
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const configIdentity = useRef('')
  const sessionRef = useRef<string | null>(null)
  const requestLock = useRef(false)
  const disposed = useRef(false)
  const transcript = useRef<HTMLDivElement>(null)
  useEffect(() => {
    disposed.current = false
    return () => { disposed.current = true; if (sessionRef.current) void request('/sessions/' + sessionRef.current, undefined, 'DELETE').catch(() => {}) }
  }, [])
  useEffect(() => {
    if (!open) return
    let alive = true
    Promise.all([request('/settings'), request('/providers')]).then(([c, catalog]) => { if (alive) { setConfig(c); setProviders(catalog.providers); setConfigured(catalog.configured); const identity = JSON.stringify([c.provider, c.baseUrl, c.model, c.reasoningProtocol]); if (identity !== configIdentity.current) { configIdentity.current = identity; setModel(c.model); setProvider(c.provider ?? 'custom'); setEffort('default') } } }).catch(e => { if (alive) setError(e.message) })
    return () => { alive = false }
  }, [open, configRevision])
  useEffect(() => {
    if (!session?.running) return
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try { const next = await request('/sessions/' + session.id); if (alive) { setSession(next); if (next.running) timer = setTimeout(poll, 700) } }
      catch (e: any) { if (alive) { setError(e.message); timer = setTimeout(poll, 2000) } }
    }
    timer = setTimeout(poll, 350)
    return () => { alive = false; clearTimeout(timer) }
  }, [session?.id, session?.running])
  useEffect(() => { if (following) transcript.current?.scrollTo({ top: transcript.current.scrollHeight }) }, [session?.entries.length, session?.running, open, expanded, following])
  const act = async (fn: () => Promise<void>) => {
    if (requestLock.current) return
    requestLock.current = true; setBusy(true); setError(''); setNotice('')
    try { await fn() } catch (e: any) { if (!disposed.current) setError(e.message) }
    finally { requestLock.current = false; if (!disposed.current) setBusy(false) }
  }
  const createSession = async () => {
    const s: Session = await request('/sessions', { deviceId: device?.id ?? null })
    if (disposed.current) { void request('/sessions/' + s.id, undefined, 'DELETE').catch(() => {}); throw new Error('会话已关闭') }
    sessionRef.current = s.id; setSession(s); return s
  }
  const send = () => act(async () => {
    const message = input.trim()
    if ((!message && !attachments.length) || readingFiles || busy || session?.running || session?.proposals.some(p => p.state === 'pending')) return
    setFollowing(true)
    const s = session ?? await createSession()
    const next = await request('/sessions/' + s.id + '/messages', { message, provider, model: model || config.model, effort, attachments: attachments.map(({ name, data }) => ({ name, data })) })
    if (!disposed.current) { setSession(next); setInput(''); setAttachments([]) }
  })
  const decide = (proposal: string, accept: boolean) => act(async () => {
    if (!session) return
    try { setSession(await request(`/sessions/${session.id}/proposals/${proposal}`, { accept })); if (accept) onChanged() }
    finally { setSession(await request('/sessions/' + session.id)) }
  })
  const pending = session?.proposals.some(p => p.state === 'pending')
  const active = busy || readingFiles || session?.running
  const addAttachments = async (files: File[]) => {
          if (!files.length || active || pending || attachmentLock.current) return
          attachmentLock.current = true
          setError(''); setReadingFiles(true)
          try {
            if (attachments.length + files.length > 4) throw new Error('每条消息最多添加 4 个附件')
            if (attachments.reduce((n, f) => n + f.size, 0) + files.reduce((n, f) => n + f.size, 0) > 6 * 1024 * 1024) throw new Error('附件总大小不能超过 6 MB')
            const next = await Promise.all(files.map(async file => {
              const imageExt = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as Record<string, string>)[file.type]
              const name = imageExt && !/\.(png|jpe?g|webp)$/i.test(file.name) ? `${file.name || '粘贴图片'}.${imageExt}` : file.name
              if (!/\.(png|jpe?g|webp|txt|md|csv|json|log|yaml|yml|xml|ini|c|h|cpp|py|js|ts)$/i.test(name)) throw new Error(`${name}：暂不支持此附件格式`)
              const isImage = /\.(png|jpe?g|webp)$/i.test(name)
              if (!file.size || file.size > (isImage ? 2 * 1024 * 1024 : 20000)) throw new Error(`${file.name}：图片限 2 MB，文本限 20 KB，不能上传空文件`)
              const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('读取附件失败')); reader.readAsDataURL(file) })
              return { name, size: file.size, data }
            }))
            if (!disposed.current) setAttachments(prev => [...prev, ...next])
          } catch (e: any) { if (!disposed.current) setError(e.message) } finally { attachmentLock.current = false; if (!disposed.current) setReadingFiles(false) }
  }
  return <>
    <button className="btn ai-launch" aria-expanded={open} onClick={() => setOpen(!open)}>✦ AI 助手{session?.running ? ' · 处理中' : ''}</button>
    {open && <aside className={'ai-panel' + (expanded ? ' expanded' : '')} aria-label="AI 助手">
      <header className="ai-header"><div><strong>✦ AI 助手</strong><small>{device?.name ?? '全部设备'} · {model || config.model || '尚未配置模型'}</small></div><button className="btn" disabled={!!active || pending} onClick={() => void act(async () => { if (session) await request('/sessions/' + session.id, undefined, 'DELETE'); setSession(null); sessionRef.current = null; setInput(''); setAttachments([]) })}>新对话</button><button className="btn" onClick={onOpenSettings}>模型设置</button><button className="btn" aria-label={expanded ? '还原聊天窗口' : '展开聊天窗口'} onClick={() => setExpanded(!expanded)}>{expanded ? '还原' : '展开'}</button><button className="btn" aria-label="收起 AI 助手" onClick={() => setOpen(false)}>×</button></header>
      {(!config.baseUrl || !config.model) && <div className="ai-config-hint">请在左下角设置中配置模型服务。<button className="btn" onClick={onOpenSettings}>前往设置</button></div>}
      <div className="ai-scope-note">发送后，对话及按需查询的数据会传给配置的模型服务。切换设备会新建会话；配置修改需在下方确认。</div>
      <div className="ai-transcript" ref={transcript} onScroll={e => { const el = e.currentTarget; setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 64) }}><div className="ai-transcript-content">
        {!session?.entries.length && <div className="ai-welcome"><h3>想了解设备的什么情况？</h3><p>可以查询当前值、历史变化、通信异常，或提出配置修改。</p>{['查看当前设备的数据和采样时间', '检查设备通信有没有异常', '把当前设备采样间隔改成 500ms'].map(q => <button className="btn" key={q} onClick={() => setInput(q)}>{q}</button>)}</div>}
        {session && <AssistantConversation entries={session.entries} turns={session.turns ?? []} onNavigate={() => setFollowing(false)} />}
        {session?.proposals.map(p => <div className="ai-proposal" key={p.id}><strong>{p.label}</strong><small>{fieldLabels[p.field] ?? p.field}</small><div className="ai-change"><span>{String(p.before ?? '未设置')}</span><span>→</span><b>{String(p.after)}</b></div><small>{stateLabels[p.state] ?? p.state}</small>{p.state === 'pending' && <div><button className="btn primary" disabled={!!active} onClick={() => void decide(p.id, true)}>确认修改</button> <button className="btn" disabled={!!active} onClick={() => void decide(p.id, false)}>拒绝</button></div>}</div>)}
        {session?.running && <div className="ai-working" role="status">正在分析或调用工具…</div>}
        {(error || session?.error) && <div className="ai-error" role="alert">{error || session?.error}</div>}
        {notice && <div role="status">{notice}</div>}
      </div></div>
      {!following && <button className="btn ai-jump" onClick={() => setFollowing(true)}>↓ 回到最新消息</button>}
      <form className="ai-composer" onSubmit={e => { e.preventDefault(); void send() }}>
        <input ref={fileInput} type="file" multiple hidden aria-label="选择附件" accept=".png,.jpg,.jpeg,.webp,.txt,.md,.csv,.json,.log,.yaml,.yml,.xml,.ini,.c,.h,.cpp,.py,.js,.ts" onChange={e => {
          const files = Array.from(e.target.files ?? []); e.target.value = ''
          void addAttachments(files)
        }} />
        {!!attachments.length && <div className="ai-attachments">{attachments.map((file, i) => <div className="ai-attachment" key={i}><span title={file.name}>📎 {file.name}</span><small>{Math.ceil(file.size / 1024)} KB</small><button type="button" disabled={!!active} aria-label={'移除附件 ' + file.name} onClick={() => setAttachments(prev => prev.filter((_, n) => n !== i))}>×</button></div>)}</div>}
        {readingFiles && <small role="status">正在读取附件…</small>}
        <textarea onPaste={e => {
          const items = Array.from(e.clipboardData.items).filter(item => item.kind === 'file').map(item => item.getAsFile()).filter((file): file is File => file !== null)
          const files = items.length ? items : Array.from(e.clipboardData.files)
          if (!files.length) return
          // Preserve normal text insertion for mixed text/file clipboard content.
          if (!e.clipboardData.getData('text/plain')) e.preventDefault()
          void addAttachments(files)
        }} aria-label="给 AI 助手的消息" placeholder={pending ? '请先确认或拒绝上方修改' : '询问数据或描述配置修改；可直接粘贴图片、文件…'} value={input} maxLength={8000} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (!active && !pending && config.baseUrl && config.model) void send() } }} onChange={e => setInput(e.target.value)} disabled={!!active || pending} />
        <div className="ai-composer-toolbar">
          <button type="button" className="ai-new-chat" aria-label="添加附件" title="添加图片、文本、CSV 或日志（最多 4 个）" disabled={!!active || pending} onClick={() => fileInput.current?.click()}>＋</button>
          <span className="ai-toolbar-spacer" />
          <AssistantModelPicker provider={provider} model={model} effort={effort} providers={providers} configured={configured} disabled={!!active} onSelect={(p, m) => { setProvider(p); setModel(m); setEffort('default') }} onEffort={setEffort} onSettings={onOpenSettings} />
          {session?.running ? <button type="button" className="ai-send" aria-label="停止生成" disabled={busy} onClick={() => void act(async () => { await request('/sessions/' + session.id + '/stop', {}) })}>■</button> : <button className="ai-send" aria-label="发送消息" disabled={!!active || (!input.trim() && !attachments.length) || pending || !config.baseUrl || !model}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6" /></svg></button>}
        </div>
      </form>
    </aside>}
  </>
}
