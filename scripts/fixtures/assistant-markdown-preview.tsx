import React, { useMemo, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { AssistantMarkdown } from '../../apps/web/src/AssistantMarkdown'
import { DeferredAssistantMarkdown, type MarkdownRenderer } from '../../apps/web/src/DeferredAssistantMarkdown'
import { DeferredResource } from '../../apps/web/src/deferred-resource'
import '../../apps/web/src/styles.css'
import '../../apps/web/src/assistant.css'

const sample = '## 模拟助手回答\n\n**正文始终保留**，这里只切换显示资源。\n\n| 点位 | 值 |\n| - | - |\n| 温度 | 200 |\n\n- [x] GFM 示例\n\n```c\n// mock only\nint value = 200;\n```\n\n<script>这里只应当是文字或被忽略</script>'
function Preview() {
  const [scenario, setScenario] = useState('normal'), [open, setOpen] = useState(true), [content, setContent] = useState(sample), [attempts, setAttempts] = useState(0)
  const operation = useMemo(() => {
    let count = 0, finish!: (renderer: MarkdownRenderer) => void
    const pending = new Promise<MarkdownRenderer>(resolve => { finish = resolve })
    const resource = new DeferredResource<MarkdownRenderer>(async () => {
      setAttempts(++count)
      if (scenario === 'pending') return pending
      if (scenario === 'failure' || scenario === 'retry' && count === 1) throw new Error('模拟资源加载失败')
      return AssistantMarkdown
    })
    return { resource, finish: () => finish(AssistantMarkdown) }
  }, [scenario])
  const state = useSyncExternalStore(operation.resource.subscribe, operation.resource.snapshot, operation.resource.snapshot)
  return <main style={{ padding: 24 }}><h1>纯 mock 助手富文本加载</h1><p>正式显示组件和加载状态机，真实解析器在本文件内联，加载过程完全模拟。无API、会话、模型、设备或数据库，也不是实际网络加载测速。</p>
    <div className="toolbar"><label>模拟场景 <select value={scenario} onChange={e => { setScenario(e.target.value); setAttempts(0) }}><option value="normal">正常加载</option><option value="retry">首次失败，手动重试成功</option><option value="failure">持续失败</option><option value="pending">挂起（10秒超时）</option></select></label><button type="button" className="btn" onClick={() => setOpen(!open)}>{open ? '隐藏内容' : '重新显示内容'}</button>{scenario === 'pending' && <button type="button" className="btn" onClick={operation.finish}>完成模拟资源加载</button>}</div>
    <p>模拟导入次数：{attempts} · 状态：{state.status}</p>
    <label>模拟流式正文（可在等待时修改）<textarea rows={8} style={{ width: '100%', boxSizing: 'border-box' }} value={content} onChange={e => setContent(e.target.value)} /></label>
    {open && <><article className="ai-message assistant"><small>模拟回答</small><DeferredAssistantMarkdown content={content} resource={operation.resource} /></article><article className="ai-message assistant"><small>第二条消息，共用一次资源加载</small><DeferredAssistantMarkdown content="**第二条模拟消息**" resource={operation.resource} /></article></>}
    <p>手测：挂起时正文应完整保留；修改正文后完成加载，应显示最新内容。首次失败场景点任一“重试富文本显示”，两条一起恢复且只新增一次导入。隐藏/重显不重复载入已成功资源。超时后完成旧加载不应自动恢复，手动重试可用缓存恢复。检查窄屏、长行和代码/表格。</p>
  </main>
}
createRoot(document.getElementById('root')!).render(<Preview />)
