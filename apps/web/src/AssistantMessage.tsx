import { memo } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const plugins = [remarkGfm]
const toolLabels: Record<string, string> = { list_devices: '查看设备', list_points: '查看点位', get_snapshot: '读取当前数据', query_history: '查询历史数据', get_diagnostics: '检查通信', get_history_stats: '统计历史数据', propose_config_change: '提出配置修改' }

export const AssistantMessage = memo(function AssistantMessage({ role, content }: { role: string; content: string }) {
  if (role === 'tool') {
    const title = content.split('\n')[0]
    const label = Object.entries(toolLabels).find(([name]) => title.includes(name))?.[1] ?? title
    return <details className="ai-tool"><summary>工具 · {label}</summary><pre>{content}</pre></details>
  }
  return <article className={'ai-message ' + role}>
    <small>{role === 'user' ? '你' : role === 'result' ? '执行结果' : 'AI 助手'}</small>
    {role === 'assistant' ? <div className="ai-markdown"><Markdown remarkPlugins={plugins} skipHtml components={{
      a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
      img: ({ alt }) => <span>[图片：{alt || '未加载'}]</span>,
    }}>{content}</Markdown></div> : <div>{content}</div>}
  </article>
})
