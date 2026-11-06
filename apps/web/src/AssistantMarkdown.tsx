import React from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const plugins = [remarkGfm]
export function AssistantMarkdown({ content }: { content: string }) {
  return <div className="ai-markdown"><Markdown remarkPlugins={plugins} skipHtml components={{
    a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
    img: ({ alt }) => <span>[图片：{alt || '未加载'}]</span>,
  }}>{content}</Markdown></div>
}
