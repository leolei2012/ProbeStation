import { useEffect, useRef, useState } from 'react'
import type { AssistantConfig, ProviderInfo } from './assistant-client'
export const effortLabels: Record<string, string> = { default: '默认', off: '关闭', none: '关闭', minimal: '最低', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', max: 'Max' }
export function AssistantModelPicker({ provider, model, effort, providers, configured, disabled, onSelect, onEffort }: { provider: string; model: string; effort: string; providers: ProviderInfo[]; configured: AssistantConfig[]; disabled: boolean; onSelect: (provider: string, model: string) => void; onEffort: (effort: string) => void }) {
  const [pane, setPane] = useState<'root' | 'models' | 'efforts' | null>(null)
  const [search, setSearch] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const current = providers.find(p => p.id === provider)?.models.find(m => m.id === model)
  const levels = current?.efforts ?? (configured.find(c => c.provider === provider)?.reasoningProtocol === 'reasoning_effort' ? ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'] : ['default'])
  useEffect(() => { if (disabled) setPane(null) }, [disabled])
  useEffect(() => { const close = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setPane(null) }; document.addEventListener('pointerdown', close); return () => document.removeEventListener('pointerdown', close) }, [])
  const done = () => { setPane(null); trigger.current?.focus() }
  return <div className="ai-picker" ref={root} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); done() } }}>
    <button type="button" ref={trigger} className="ai-picker-trigger" disabled={disabled} aria-expanded={!!pane} aria-label="选择模型和推理等级" onClick={() => { setPane(pane ? null : 'root'); setSearch('') }}><span className="ai-model-caption" title={current?.name ?? model}>{current?.name ?? (model || '选择模型')}</span><span className="ai-effort-caption">{effortLabels[effort] ?? effort}</span><svg className="ai-picker-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m7 10 5 5 5-5" /></svg></button>
    {pane && <div className="ai-picker-menu" role="dialog" aria-label="模型选择">
      {pane === 'root' ? <><button type="button" onClick={() => setPane('models')}><strong>模型</strong><span>{current?.name ?? model} ›</span></button><button type="button" onClick={() => setPane('efforts')}><strong>推理等级</strong><span>{effortLabels[effort]} ›</span></button></> : <>
        <button type="button" onClick={() => setPane('root')}>‹ {pane === 'models' ? '选择模型' : '推理等级'}</button>
        {pane === 'models' ? <><input autoFocus placeholder="搜索模型或提供商" aria-label="搜索模型或提供商" value={search} onChange={e => setSearch(e.target.value)} /><div className="ai-picker-list">{configured.map(c => {
          const p = providers.find(p => p.id === c.provider)
          const options = p?.models ?? [{ id: c.model, name: c.model }]
          const matches = options.filter(m => `${p?.name ?? '自定义'} ${m.name} ${m.id}`.toLowerCase().includes(search.toLowerCase()))
          return matches.length ? <div key={c.provider}><small>{p?.name ?? '自定义 API'}</small>{matches.map(m => <button type="button" key={m.id} aria-pressed={provider === c.provider && model === m.id} onClick={() => { onSelect(c.provider ?? 'custom', m.id); done() }}>{m.name}<span>{provider === c.provider && model === m.id ? '✓' : ''}</span></button>)}</div> : null
        })}{!configured.length && <p>请先添加提供商</p>}</div></> : levels.map(level => <button type="button" key={level} aria-pressed={effort === level} onClick={() => { onEffort(level); done() }}>{effortLabels[level] ?? level}<span>{effort === level ? '✓' : ''}</span></button>)}
      </>}
    </div>}
  </div>
}
