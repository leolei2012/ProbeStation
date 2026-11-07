import React from 'react'
import type { ConfigReadFailure } from './config-read'

export function ConfigLoadNotice({ deviceError, groupError, onRetry, english = false }: { deviceError: ConfigReadFailure | null; groupError: ConfigReadFailure | null; onRetry: () => void; english?: boolean }) {
  if (!deviceError && !groupError) return null
  const text = (zh: string, en: string) => english ? en : zh
  const issue = (label: string, error: ConfigReadFailure | null) => error ? label + text(error === 'timeout' ? '读取超时（单次请求超过10秒）' : '读取失败', error === 'timeout' ? ' read timed out (one request exceeded 10 seconds)' : ' read failed') : ''
  return <div className="operation-feedback error" role="alert">
    <span>{[issue(text('设备清单', 'Device list'), deviceError), issue(text('点表', 'Point table'), groupError)].filter(Boolean).join(' · ')}{english ? '. ' : '。'}{text('当前配置未核实；已有内容保留上次快照，未读取的内容不代表为空。重试只会重新读取，不会重复保存。', 'Current configuration is unverified. Existing content is the previous snapshot; unread content does not mean empty. Retry only reads again; it does not repeat saves.')}</span>
    <button className="btn" type="button" onClick={onRetry}>{text('重试加载', 'Retry loading')}</button>
  </div>
}
