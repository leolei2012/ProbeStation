import React from 'react'

export function HistoryReadNotice({ reason, english = false }: { reason: 'waiting' | 'invalid' | 'changed' | null; english?: boolean }) {
  if (!reason) return null
  const messages = {
    waiting: ['正在等待当前设备点表，不会使用其他配置的历史结果。', 'Waiting for this device’s point definitions; results from another context are hidden.'],
    invalid: ['无法建立当前点表的历史查询上下文。请重新读取配置或检查点表，未发起查询。', 'Cannot establish the point-definition context. Reload configuration or check the point table; no query started.'],
    changed: ['点表定义已变化，之前的结果已隐藏；当前查询状态见下方。会重新读取历史，服务端并发配置变更仍需核对。', 'Point definitions changed; previous results are hidden. See the query status below. History is read again; concurrent server configuration changes still require checking.'],
  }
  return <p className="chart-hint warn history-read-notice" role="status">{messages[reason][english ? 1 : 0]}</p>
}
