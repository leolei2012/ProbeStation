import { useEffect, useState } from 'react'
import { assistantRequest } from './assistant-client'

export type DataTarget = { deviceId: number; view: 'live' | 'history' | 'diagnostics'; label: string; registerId?: number; start?: string; end?: string; token?: number }
export function DeviceIssues({ onNavigate }: { onNavigate: (target: DataTarget) => void }) {
  const [issues, setIssues] = useState<(DataTarget & { reason: string })[]>([])
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true, timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      try { const result = await assistantRequest('/issues'); if (alive) { setIssues(result.issues); setError('') } }
      catch { if (alive) setError('状态汇总暂时不可用') }
      finally { if (alive) timer = setTimeout(refresh, 10000) }
    }
    void refresh()
    return () => { alive = false; clearTimeout(timer) }
  }, [])
  if (error) return <div className="device-issues">{error}</div>
  if (!issues.length) return null
  return <details className="device-issues"><summary>设备状态提醒 · {issues.length} 项</summary><div>{issues.map((issue, i) => <button className="btn" key={i} onClick={() => onNavigate(issue)}><strong>{issue.label}</strong><span>{issue.reason}</span><span>查看 →</span></button>)}</div></details>
}
