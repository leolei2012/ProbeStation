import { useEffect, useRef, useState } from 'react'
import { assistantRequest as request, type AssistantConfig, type ProviderInfo } from './assistant-client'

export function AssistantSettings({ onSaved }: { onSaved: () => void }) {
  const [config, setConfig] = useState<AssistantConfig>({ provider: 'custom', baseUrl: '', model: '', hasKey: false })
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [configured, setConfigured] = useState<AssistantConfig[]>([])
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [deleting, setDeleting] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [models, setModels] = useState<string[]>([])
  const lock = useRef(false)
  const custom = !config.provider || config.provider === 'custom'
  const refresh = async () => { const c = await request('/providers'); setProviders(c.providers); setConfigured(c.configured) }
  useEffect(() => { let alive = true; Promise.all([request('/settings'), request('/providers')]).then(([c, p]) => { if (alive) { setConfig(c); setProviders(p.providers); setConfigured(p.configured) } }).catch(e => { if (alive) setError(e.message) }).finally(() => { if (alive) setBusy(false) }); return () => { alive = false } }, [])
  const edit = async (provider: string) => {
    if (lock.current) return
    lock.current = true; setBusy(true); setError(''); setNotice(''); setApiKey(''); setModels([])
    try { setConfig(await request('/settings?provider=' + encodeURIComponent(provider))) } catch (e: any) { setError(e.message) } finally { lock.current = false; setBusy(false) }
  }
  return <div className="ai-settings">
    {error && <div className="ai-error" role="alert">{error}</div>}
    <p>选择提供商并填写 API 密钥，即可使用其模型。密钥分别保存在服务端。</p>
    <div className="ai-provider-cards">{configured.map(c => <div className="ai-provider-card" key={c.provider}><div><strong>{providers.find(p => p.id === c.provider)?.name ?? '自定义 API'}</strong><small>{c.model} · {c.hasKey ? '已保存密钥' : '未设置密钥'}</small></div><div className="ai-provider-card-actions"><button className="btn" disabled={busy} onClick={() => void edit(c.provider ?? 'custom')}>编辑</button><button className="btn" disabled={busy} onClick={() => { setDeleting(c.provider ?? 'custom'); setError('') }}>删除</button></div>{deleting === c.provider && <div className="ai-provider-delete" role="alert"><p>删除此 API 配置和已保存的密钥？聊天记录不受影响，之后需重新配置才能使用。</p><button className="btn" disabled={busy} onClick={() => setDeleting(null)}>取消</button><button className="btn primary" disabled={busy} onClick={async () => {
      if (lock.current) return
      lock.current = true; setBusy(true); setError('')
      try { await request('/settings/' + encodeURIComponent(c.provider ?? 'custom'), undefined, 'DELETE'); setDeleting(null); if (config.provider === c.provider) { setApiKey(''); setModels([]); setConfig(await request('/settings')) }; await refresh(); onSaved(); setNotice('API 配置及密钥已删除') } catch (e: any) { setError(e.message) } finally { lock.current = false; setBusy(false) }
    }}>{busy ? '删除中…' : '确认删除'}</button></div>}</div>)}</div>
    <form className="ai-provider-editor" onSubmit={async e => {
      e.preventDefault(); if (lock.current) return
      lock.current = true; setBusy(true); setError(''); setNotice('')
      try { await request('/settings', { provider: config.provider ?? 'custom', baseUrl: config.baseUrl.trim(), model: config.model.trim(), reasoningProtocol: config.reasoningProtocol ?? 'default', ...(apiKey ? { apiKey } : {}) }); setApiKey(''); onSaved(); setConfig(await request('/settings')); await refresh(); setNotice('已保存，可在聊天中选择此提供商的模型') } catch (e: any) { setError(e.message) } finally { lock.current = false; setBusy(false) }
    }}>
      <fieldset disabled={busy}>
        <div className="seg"><button type="button" className={!custom ? 'selected' : ''} onClick={() => void edit(providers.find(p => p.id === 'deepseek')?.id ?? providers[0]?.id)}>第三方模型提供商</button><button type="button" className={custom ? 'selected' : ''} onClick={() => void edit('custom')}>自定义模型 API</button></div>
        {!custom && <><label>提供商<select value={config.provider} onChange={e => void edit(e.target.value)}>{providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label>默认模型<select value={config.model} onChange={e => { const m = providers.find(p => p.id === config.provider)?.models.find(m => m.id === e.target.value); setConfig({ ...config, model: e.target.value, baseUrl: m?.baseUrl ?? config.baseUrl }) }}>{providers.find(p => p.id === config.provider)?.models.map(m => <option key={m.id} value={m.id}>{m.name} · {m.id}</option>)}</select></label><p>协议与可选推理等级由模型目录提供，无需手动配置。</p></>}
        <label>API 密钥<input required={!custom && !config.hasKey} type="password" autoComplete="new-password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder={config.hasKey ? '已保存，留空保留' : custom ? '本地免密服务可留空' : '填写此提供商的 API Key'} /></label>
        <details open={custom} key={config.provider}><summary>自定义设置</summary>
          <label>API 基础地址<input type="url" required value={config.baseUrl} placeholder="https://服务地址/v1" onChange={e => setConfig({ ...config, baseUrl: e.target.value })} /></label>
          <p>修改地址会清除旧密钥，需重新填写。自定义接口使用 Chat Completions 协议。</p>
          {custom && <><label>模型 ID<input required list="ai-settings-models" value={config.model} onChange={e => setConfig({ ...config, model: e.target.value })} /></label><datalist id="ai-settings-models">{models.map(m => <option key={m} value={m} />)}</datalist><button type="button" className="btn" onClick={async () => { if (lock.current) return; lock.current = true; setBusy(true); try { const r = await request('/models', { provider: 'custom', baseUrl: config.baseUrl, ...(apiKey ? { apiKey } : {}) }); setModels(r.models); setNotice(r.models.length ? '模型目录已加载，可在模型 ID 输入框选择' : '未返回模型，请手动填写') } catch (e: any) { setError(e.message) } finally { lock.current = false; setBusy(false) } }}>获取模型列表</button><label>推理参数<select value={config.reasoningProtocol ?? 'default'} onChange={e => setConfig({ ...config, reasoningProtocol: e.target.value as AssistantConfig['reasoningProtocol'] })}><option value="default">服务商默认</option><option value="reasoning_effort">reasoning_effort（需服务商支持）</option></select></label></>}
        </details>
        <p>对话及查询到的设备数据会发给所选服务。仅支持 API Key 接入，未接入账号 OAuth 登录。</p>
        <p>连接测试会发送一条简短消息，可能产生少量 API 费用，不包含设备数据。</p>
        <div className="ai-provider-actions"><button className="btn" type="button" onClick={async () => {
          if (lock.current) return
          lock.current = true; setBusy(true); setError(''); setNotice('')
          try { const result = await request('/test', { provider: config.provider ?? 'custom', baseUrl: config.baseUrl.trim(), model: config.model.trim(), ...(apiKey ? { apiKey } : {}) }); setNotice(`${result.message} · ${result.elapsedMs} ms（尚未保存的设置仍需点击保存）`) }
          catch (e: any) { setError(e.message) } finally { lock.current = false; setBusy(false) }
        }}>测试连接</button><button className="btn primary" type="submit">{busy ? '处理中…' : '保存'}</button></div>
      </fieldset>
    </form>
    {notice && <p role="status">{notice}</p>}
  </div>
}
