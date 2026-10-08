import type { DataTarget } from './DeviceIssues'
import { useEffect, useRef, useState } from 'react'
import { AssistantMessage } from './AssistantMessage'
export type AssistantTurn = { entryIndex: number; startedAt: number; endedAt?: number; state: 'running' | 'completed' | 'stopped' | 'failed' }
const labels = { running: '处理中', completed: '已完成', stopped: '已停止', failed: '执行失败' }
function TurnStatus({ turn }: { turn: AssistantTurn }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => { if (turn.state !== 'running') return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [turn.state])
  const seconds = Math.max(0, Math.floor(((turn.endedAt ?? now) - turn.startedAt) / 1000))
  return <div className={'ai-turn-status ' + turn.state}><span>{labels[turn.state]}</span><span>用时 {seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ` : ''}{seconds % 60} 秒</span></div>
}
export function AssistantConversation({ entries, turns, onNavigate, sources, onSource }: { entries: { role: string; content: string }[]; turns: AssistantTurn[]; onNavigate: () => void; sources: (DataTarget & { entryIndex: number })[]; onSource: (source: DataTarget) => void }) {
  const anchors = useRef<Map<number, HTMLDivElement>>(new Map())
  const nav = useRef<HTMLDetailsElement>(null)
  const starts = entries.flatMap((e, i) => e.role === 'user' ? [i] : [])
  return <>
    {starts.length > 1 && <details className="ai-turn-nav" ref={nav}><summary aria-label="定位对话">☰ <span>对话目录 · {starts.length}</span></summary><div>{starts.map((index, n) => <button type="button" key={index} onClick={() => { onNavigate(); if (nav.current) nav.current.open = false; anchors.current.get(index)?.scrollIntoView({ block: 'start', behavior: 'auto' }) }}><small>{n + 1}</small><span>{entries[index].content.slice(0, 100)}</span></button>)}</div></details>}
    {starts.map((start, n) => {
      const end = starts[n + 1] ?? entries.length
      const batch = entries.slice(start + 1, end)
      const tools = batch.filter(e => e.role === 'tool')
      const turn = turns.find(t => t.entryIndex === start)
      return <div className="ai-turn" key={start} ref={el => { if (el) anchors.current.set(start, el); else anchors.current.delete(start) }}>
        <AssistantMessage {...entries[start]} />
        {turn && <TurnStatus turn={turn} />}
        <>
          {!!tools.length && <details className="ai-turn-process"><summary>{turn?.state === 'running' ? '正在执行' : '执行过程'} · {tools.length} 次工具调用</summary>{tools.map((e, i) => <AssistantMessage key={i} {...e} />)}</details>}
          {!!sources.filter(s => s.entryIndex === start).length && <div className="ai-sources"><small>查询来源（点击查看）</small>{sources.filter(s => s.entryIndex === start).map((source, i) => <button className="btn" key={i} onClick={() => onSource(source)}>{source.label}{source.start && <small>{new Date(source.start).toLocaleString()} — {new Date(source.end!).toLocaleString()}</small>}</button>)}</div>}
          {batch.filter(e => e.role !== 'tool').map((e, i) => <AssistantMessage key={i} {...e} />)}
        </>
      </div>
    })}
  </>
}
