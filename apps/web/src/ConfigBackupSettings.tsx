import React, { useEffect, useRef, useSyncExternalStore } from 'react'
import { configBackupFlow, type ConfigBackupFlow, type BackupFlowState } from './config-backup-flow'

export function ConfigBackupView({ state, zh, onChoose, onCancel, onRestore, exportHref = '/api/config/backup' }: { state: BackupFlowState; zh: boolean; onChoose: () => void; onCancel: () => void; onRestore: () => void; exportHref?: string | null }) {
  const text = (cn: string, en: string) => zh ? cn : en
  const busy = state.phase === 'previewing' || state.phase === 'restoring', preview = state.preview
  const outcome = state.phase === 'completed' || state.phase === 'rejected' || state.phase === 'uncertain'
  return <div className="config-backup-settings">
    <div className="settings-line"><div><strong>{text('配置备份与恢复', 'Configuration backup')}</strong><p>{text('包含设备、分组、点位、枚举和告警规则。历史数据、固件文件及 API 密钥不包含在内。', 'Includes devices, groups, points, enums and alarm rules. Excludes history, firmware files and API keys.')}</p></div><div className="settings-inline">{exportHref ? <a className="btn" href={exportHref} download>{text('导出备份', 'Export')}</a> : <button type="button" className="btn" disabled>{text('导出备份', 'Export')}</button>}<button type="button" className="btn" disabled={busy} onClick={onChoose}>{text('选择备份并预览', 'Choose backup and preview')}</button></div></div>
    {state.fileName && <p className="backup-file-name">{text('备份文件', 'Backup file')}: {state.fileName}</p>}
    {state.phase === 'previewing' && <div><p role="status">{text('正在读取和校验备份…', 'Reading and validating backup…')}</p><button type="button" className="btn" onClick={onCancel}>{text('取消预览', 'Cancel preview')}</button></div>}
    {state.phase === 'preview-error' && <p className="warn" role="alert">{text(state.error === 'invalid-file' ? '无法读取支持的JSON配置备份。' : state.error === 'invalid-preview' ? '恢复预览格式或数量不一致，不能确认恢复。' : state.error === 'preview-timeout' ? '预览超时，未执行恢复；可重新选择备份。' : '恢复预览失败，未执行恢复；可重新选择备份。', state.error === 'invalid-file' ? 'Cannot read a supported JSON configuration backup.' : state.error === 'invalid-preview' ? 'Invalid or inconsistent preview. Restore is unavailable.' : state.error === 'preview-timeout' ? 'Preview timed out. No restore was sent. Choose the backup again.' : 'Preview failed. No restore was sent. Choose the backup again.')}{state.detail && <small>{state.detail}</small>}</p>}
    {state.phase === 'ready' && preview && <div className="backup-preview" aria-label={text('恢复预览', 'Restore preview')}>
      <strong>{text('恢复预览', 'Restore preview')}</strong>
      <p>{text(`新增 ${preview.counts.devices} 台设备、${preview.counts.groups} 个分组、${preview.counts.registers} 个点位、${preview.counts.rules} 条告警。现有配置保留，新设备保持暂停。`, `Add ${preview.counts.devices} devices, ${preview.counts.groups} groups, ${preview.counts.registers} points and ${preview.counts.rules} alarms. Existing configuration is retained; imported devices start paused.`)}</p>
      <ul>{preview.devices.map((d, i) => <li key={i}><strong>{d.name}</strong> · {d.mode === 'slave' ? text('从站', 'Slave') : text('主站', 'Master')} · {d.transport.toUpperCase()} · {d.endpoint ?? '—'} {d.sameName && <span className="warn">{text('（已有同名设备，将另建；请确认不是重复恢复）', '(name exists; creates another device — check for an earlier restore)')}</span>}</li>)}</ul>
      <div className="settings-inline"><button type="button" className="btn" onClick={onCancel}>{text('取消', 'Cancel')}</button><button type="button" className="btn primary" onClick={onRestore}>{text('确认新增并恢复', 'Confirm restore')}</button></div>
    </div>}
    {state.phase === 'restoring' && <div className="backup-outcome" role="status"><strong>{text('正在等待恢复结果…', 'Waiting for restore result…')}</strong><p>{text('不会自动重试。关闭设置不会撤销已发出的恢复，再打开可查看本次状态。', 'No automatic retry. Closing settings does not undo the request; reopen to see this operation.')}</p>{state.slow && <p className="warn">{text('恢复仍未返回，可能正在执行或已经提交。请勿重复恢复；连接中断不能证明已回滚。', 'Restore is still pending and may be running or committed. Do not repeat it; a lost connection does not prove rollback.')}</p>}</div>}
    {outcome && <section className="backup-outcome" data-backup-outcome={state.phase} aria-label={text('恢复结果', 'Restore result')}>
      <strong role={state.phase === 'completed' ? 'status' : 'alert'}>{text(state.phase === 'completed' ? '配置已恢复' : state.phase === 'rejected' ? '恢复请求已拒绝' : '恢复结果待核实', state.phase === 'completed' ? 'Configuration restored' : state.phase === 'rejected' ? 'Restore request rejected' : 'Restore outcome unconfirmed')}</strong>
      {state.phase === 'completed' && state.result ? <><p>{text(`已新增 ${state.result.devices} 台暂停设备、${state.result.groups} 个分组、${state.result.registers} 个点位、${state.result.rules} 条告警。`, `Added ${state.result.devices} paused devices, ${state.result.groups} groups, ${state.result.registers} points and ${state.result.rules} alarms.`)}</p><p>{text('新增设备ID', 'New device IDs')}: {state.result.deviceIds.map(id => '#' + id).join(', ') || '—'}</p><p>{text('刷新设备列表并核对连接参数后，再手动启用。', 'Refresh the device list and check connections before enabling manually.')}</p>{state.result.warnings.length > 0 && <ul className="warn">{state.result.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul>}</> : <p className="warn">{text(state.phase === 'rejected' ? '服务端未接受本次恢复。修正问题后，请重新选择备份并预览。' : '可能已新增设备。请先刷新设备列表，按文件、设备名称和数量核对，勿直接重复恢复。如仍需恢复，必须重新选择备份并预览。', state.phase === 'rejected' ? 'The server did not accept this restore. Resolve the issue, then choose the backup and preview again.' : 'Devices may already have been added. Refresh the device list and check names and counts before repeating. A new file selection and preview are required for another restore.')}</p>}
      {preview && state.phase !== 'completed' && <p>{text('本次计划新增', 'Planned additions')}: {preview.counts.devices} / {preview.counts.groups} / {preview.counts.registers} / {preview.counts.rules} ({text('设备 / 分组 / 点位 / 告警', 'devices / groups / points / alarms')})</p>}
      {state.detail && <p className="warn">{state.detail}</p>}
    </section>}
  </div>
}

export function ConfigBackupSettings({ lang, flow = configBackupFlow }: { lang: 'zh' | 'en'; flow?: ConfigBackupFlow }) {
  const file = useRef<HTMLInputElement>(null), state = useSyncExternalStore(flow.subscribe, flow.snapshot, flow.snapshot)
  useEffect(() => () => flow.cancelPreview(), [flow])
  return <><ConfigBackupView state={state} zh={lang === 'zh'} onChoose={() => file.current?.click()} onCancel={flow.cancelPreview} onRestore={() => void flow.restore()} />
    <input ref={file} type="file" accept=".json,application/json" hidden disabled={state.phase === 'previewing' || state.phase === 'restoring'} onChange={e => { const selected = e.currentTarget.files?.[0]; e.currentTarget.value = ''; if (selected) void flow.preview(selected.name, () => selected.text()) }} />
  </>
}
