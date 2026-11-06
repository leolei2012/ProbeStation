import React, { useEffect, useSyncExternalStore, type ComponentType } from 'react'
import { DeferredResource, type DeferredState } from './deferred-resource'

export type MarkdownRenderer = ComponentType<{ content: string }>
export const assistantMarkdownResource = new DeferredResource<MarkdownRenderer>(async () => {
  const module = await import('./AssistantMarkdown')
  if (typeof module.AssistantMarkdown !== 'function') throw new Error('Invalid Markdown renderer module')
  return module.AssistantMarkdown
})

export function AssistantMarkdownView({ content, state, onRetry }: { content: string; state: DeferredState<MarkdownRenderer>; onRetry: () => void }) {
  if (state.status === 'ready' && state.value) { const Renderer = state.value; return <Renderer content={content} /> }
  return <div className="ai-plain-markdown"><div className="ai-plain-content">{content}</div>
    <div className="ai-renderer-status" role="status">{state.status === 'error' ? <>富文本显示暂不可用，正文已保留。<button type="button" className="btn" onClick={onRetry}>重试富文本显示</button></> : '富文本显示加载中，当前为纯文本。'}</div>
  </div>
}

export function DeferredAssistantMarkdown({ content, resource = assistantMarkdownResource }: { content: string; resource?: DeferredResource<MarkdownRenderer> }) {
  const state = useSyncExternalStore(resource.subscribe, resource.snapshot, resource.snapshot)
  useEffect(() => { void resource.load() }, [resource])
  return <AssistantMarkdownView content={content} state={state} onRetry={() => void resource.load(true)} />
}
