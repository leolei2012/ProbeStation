import React from 'react'

/** Static rules, not telemetry about the current backend's timer configuration. */
export function RetentionCleanupNotice({ english = false }: { english?: boolean }) {
  const text = (zh: string, en: string) => english ? en : zh
  return <aside className="retention-cleanup-notice" aria-label={text('历史清理触发规则', 'History cleanup trigger rules')}>
    <p>{text('周期清理间隔设为 0 只停定时任务。启动、重开历史库或修改全局保留时长仍可安排清理。', 'Setting the cleanup interval to 0 only stops the timer. Startup, reopening history storage and changing global retention can still schedule cleanup.')}</p>
    <p>{text('全局设为 0 不会覆盖设备的独立正数保留期；设备暂停也不停止历史清理。', 'Setting global retention to 0 does not override a positive device retention; pausing a device does not stop history cleanup.')}</p>
    <small>{text('此处仅说明规则，未读取当前后台清理周期，不触发清理或保存。', 'These are rules, not live timer status. The current backend cleanup interval has not been read. This notice does not clean up or save anything.')}</small>
  </aside>
}
