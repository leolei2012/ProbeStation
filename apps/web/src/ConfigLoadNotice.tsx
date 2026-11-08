import React from 'react'
import type { ConfigReadFailure } from './config-read'

export function ConfigLoadNotice({ deviceError, groupError, onRetry, english = false }: { deviceError: ConfigReadFailure | null; groupError: ConfigReadFailure | null; onRetry: () => void; english?: boolean }) {
  if (!deviceError && !groupError) return null
  const text = (zh: string, en: string) => english ? en : zh
  const unavailable = deviceError === 'unavailable' || groupError === 'unavailable'
  const issue = (label: string, error: ConfigReadFailure | null) => error ? label + text(error === 'timeout' ? '读取超时（单次请求超过10秒）' : error === 'unavailable' ? '服务暂不可用（HTTP 503）' : '读取失败', error === 'timeout' ? ' read timed out (one request exceeded 10 seconds)' : error === 'unavailable' ? ' service unavailable (HTTP 503)' : ' read failed') : ''
  return <div className="operation-feedback error" role="alert">
    <span>{[issue(text('设备清单', 'Device list'), deviceError), issue(text('点表', 'Point table'), groupError)].filter(Boolean).join(' · ')}{english ? '. ' : '。'}{text('当前配置未核实；已有内容保留上次快照，未读取的内容不代表为空。重试只会重新读取，不会重复保存。', 'Current configuration is unverified. Existing content is the previous snapshot; unread content does not mean empty. Retry only reads again; it does not repeat saves.')}{unavailable && text(' 请管理员核查配置服务，确认恢复后再只读刷新。连接隔离或关闭都可能导致不可用，503本身不能确定原因；刷新不会解除隔离。不要重复保存或导入来恢复连接，之前写入的结果仍须单独核实。', ' Ask an administrator to inspect the configuration service and confirm recovery before refreshing read-only. Quarantine or shutdown can cause unavailability; 503 alone does not identify the cause. Refresh does not remove quarantine. Do not repeat saves or imports to restore the connection; earlier write outcomes still require separate verification.')}</span>
    <button className="btn" type="button" onClick={onRetry}>{unavailable ? text('重新读取（只读）', 'Read again (read-only)') : text('重试加载', 'Retry loading')}</button>
  </div>
}
