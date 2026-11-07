import React from 'react'
import { retentionDisplay, formatRetentionSeconds } from '../../../packages/core/src/retention-policy'

export function RetentionSummary({ retention, objectId, english = false }: { retention: unknown; objectId: number | null; english?: boolean }) {
  const view = retentionDisplay(retention, objectId), text = (zh: string, en: string) => english ? en : zh
  return <div className="retention-summary" aria-label={text('保留策略说明', 'Retention policy details')}>
    <p>{text('全局默认', 'Global default')}: <strong>{formatRetentionSeconds(view.globalSeconds, english)}</strong></p>
    {objectId !== null && <p>{text(`所选设备 #${objectId}`, `Selected device #${objectId}`)}: <strong>{formatRetentionSeconds(view.seconds, english)}</strong> · {view.source === 'device' ? text('设备独立设置', 'Device override') : view.source === 'global' ? text('跟随全局', 'Inherits global default') : text('实际策略未核实', 'Effective policy unverified')}</p>}
    {objectId !== null && view.source === 'unverified' && <p role="status">{text('后端未提供有效的所选设备策略，不能将全局默认当作该设备实际保留时长。请刷新或核对设备设置。', 'No valid policy was returned for this device. The global default does not establish its effective retention; refresh or check device settings.')}</p>}
    <small>{text(objectId === null ? '设备可独立覆盖全局默认。' : '', objectId === null ? 'Devices can override the global default. ' : '')}{text('这里显示配置时长，不保证该时段历史完整。策略变更不会恢复已清理的数据；本区只读，不触发清理或保存。', 'This is the configured duration, not a guarantee of complete history. Changing a policy cannot restore deleted data. This section is read-only and never cleans up or saves settings.')}</small>
  </div>
}
