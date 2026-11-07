import React, { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { DeferredSettingsModal, type SettingsRenderer } from '../../apps/web/src/DeferredSettingsModal'
import { DeferredResource } from '../../apps/web/src/deferred-resource'
import type { SettingsModalProps } from '../../apps/web/src/SettingsModal'
import '../../apps/web/src/styles.css'

const MockSettings: SettingsRenderer = props => {
  const [draft, setDraft] = useState('仅此模拟窗口的草稿')
  return <div className="modal-mask"><section className="modal" role="dialog" aria-modal="true" aria-label="合成设置内容"><h3>纯mock设置替身 · {props.lang}/{props.theme}</h3><p>仅用于加载外壳验收，不加载真实设置业务；这不是完整设置布局。</p><label>模拟草稿<input value={draft} onChange={e => setDraft(e.target.value)} /></label><div className="toolbar"><button type="button" className="btn" data-settings-close onClick={props.onClose}>关闭</button><button type="button" className="btn" onClick={() => props.setLang(props.lang === 'zh' ? 'en' : 'zh')}>切换模拟语言（不应重载模块）</button><button type="button" className="btn" onClick={() => { void props.api.post('/mock-only', { draft }) }}>模拟本页保存计数</button></div></section></div>
}
function Preview() {
  const [mode, setMode] = useState('slow'), [open, setOpen] = useState(false), [lang, setLang] = useState<'zh' | 'en'>('zh'), [theme, setTheme] = useState<'light' | 'dark' | 'system'>('light'), [imports, setImports] = useState(0), [saves, setSaves] = useState(0), [revision, setRevision] = useState(0)
  const current = useRef(mode); current.current = mode
  const create = () => new DeferredResource<SettingsRenderer>(async () => { const chosen = current.current; setImports(value => value + 1); if (chosen === 'failure') throw new Error('synthetic chunk failure'); if (chosen === 'timeout') return new Promise(() => {}); if (chosen === 'slow') await new Promise(resolve => setTimeout(resolve, 2000)); return MockSettings })
  const [resource, setResource] = useState(create)
  const props: SettingsModalProps = { initialSection: 'general', t: key => key === 'cancel' ? lang === 'zh' ? '关闭' : 'Close' : lang === 'zh' ? '设置' : 'Settings', theme, setTheme, lang, setLang, onClose: () => setOpen(false), onAISaved() {}, api: { async get() { throw new Error('mock content must not GET') }, async post() { setSaves(value => value + 1); return {} } } }
  return <main style={{ padding: 24, maxWidth: 1000, margin: 'auto' }}><h1>设置延迟加载 · 纯 mock 手测</h1><p>正式加载资源和加载/失败外壳，业务内容为纯mock替身；无API、设备、数据库、模型、文件或真实保存。模块加载尝试 {imports}，本页模拟保存 {saves}，模拟缓存修订 {revision}。</p>
    <div className="toolbar"><label>下次模拟代码加载<select value={mode} onChange={e => setMode(e.target.value)}><option value="slow">延迟2秒，关闭后继续完成</option><option value="normal">立即成功</option><option value="failure">加载失败</option><option value="timeout">挂起10秒超时</option></select></label><label><input type="checkbox" checked={lang === 'en'} onChange={e => setLang(e.target.checked ? 'en' : 'zh')} />English</label><button className="btn" type="button" onClick={() => setOpen(true)}>打开设置替身</button><button className="btn" type="button" disabled={open} onClick={() => { setResource(create()); setRevision(value => value + 1) }}>重置模拟加载缓存（仅此预览）</button></div>
    {open && <DeferredSettingsModal {...props} resource={resource} />}
    <p>手测：页面初始不加载，首次打开等待2秒；等待中关闭，代码晚到不重新打开。再开直接复用已加载代码。失败后关闭→改成功→再开仍需显式重试；重试不增加保存次数。挂起超时可关闭/重试；准备好后改语言仍保留模拟草稿，不重新导入。核对Close/Escape/Tab、焦点交接、英文、360px。CSP禁止网络；真实设置表单/请求策略需另行验收。</p>
  </main>
}
createRoot(document.getElementById('root')!).render(<Preview />)
