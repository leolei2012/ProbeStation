import { useRef, useState } from 'react'

type Preview = { counts: { devices: number; groups: number; registers: number; rules: number }; devices: { name: string; mode: string; transport: string; endpoint: string; sameName: boolean }[] }
export function ConfigBackupSettings({ lang }: { lang: 'zh' | 'en' }) {
  const zh = lang === 'zh', file = useRef<HTMLInputElement>(null)
  const [pending, setPending] = useState<{ backup: unknown; preview: Preview } | null>(null)
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('')
  async function send(action: string, body: unknown) {
    const res = await fetch('/api/config/backup/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-probestation-config': '1' }, body: JSON.stringify(body) })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error ?? data.message ?? `HTTP ${res.status}`)
    return data
  }
  async function preview(selected?: File) {
    if (!selected) return
    setBusy(true); setPending(null); setMessage(''); setError('')
    try { const backup = JSON.parse(await selected.text()); setPending({ backup, preview: await send('preview', backup) }) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  async function restore() {
    if (!pending || busy) return
    setBusy(true); setError('')
    try {
      const result = await send('restore', pending.backup)
      setPending(null); setMessage(zh ? `已恢复 ${result.devices} 台设备，均已暂停。检查连接参数后可手动启用。` : `Restored ${result.devices} paused devices. Check connections before enabling.`)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  return <div className="config-backup-settings">
    <div className="settings-line"><div><strong>{zh ? '配置备份与恢复' : 'Configuration backup'}</strong><p>{zh ? '包含设备、分组、点位、枚举和告警规则。历史数据、固件文件及 API 密钥不包含在内。' : 'Includes devices, groups, points, enums and alarm rules. Excludes history, firmware files and API keys.'}</p></div><div className="settings-inline"><a className="btn" href="/api/config/backup" download>{zh ? '导出备份' : 'Export'}</a><button className="btn" disabled={busy} onClick={() => file.current?.click()}>{busy ? (zh ? '处理中…' : 'Working…') : (zh ? '选择备份' : 'Choose backup')}</button></div></div>
    <input ref={file} type="file" accept=".json,application/json" hidden onChange={e => { const selected = e.currentTarget.files?.[0]; e.currentTarget.value = ''; void preview(selected) }} />
    {pending && <div className="backup-preview" aria-label={zh ? '恢复预览' : 'Restore preview'}>
      <strong>{zh ? '恢复预览' : 'Restore preview'}</strong>
      <p>{zh ? `新增 ${pending.preview.counts.devices} 台设备、${pending.preview.counts.groups} 个分组、${pending.preview.counts.registers} 个点位、${pending.preview.counts.rules} 条告警。现有配置保留，新设备保持暂停。` : `Add ${pending.preview.counts.devices} devices, ${pending.preview.counts.groups} groups, ${pending.preview.counts.registers} points and ${pending.preview.counts.rules} alarms. Existing configuration is retained; imported devices start paused.`}</p>
      <ul>{pending.preview.devices.map((d, i) => <li key={i}><strong>{d.name}</strong> · {d.mode === 'slave' ? (zh ? '从站' : 'Slave') : (zh ? '主站' : 'Master')} · {d.transport.toUpperCase()} · {d.endpoint} {d.sameName && <span className="warn">{zh ? '（已有同名设备，将另建）' : '(name exists; creates a separate device)'}</span>}</li>)}</ul>
      <div className="settings-inline"><button className="btn" disabled={busy} onClick={() => setPending(null)}>{zh ? '取消' : 'Cancel'}</button><button className="btn primary" disabled={busy} onClick={() => void restore()}>{zh ? '确认新增并恢复' : 'Confirm restore'}</button></div>
    </div>}
    {message && <p role="status">{message}</p>}{error && <p className="warn" role="alert">{error}</p>}
  </div>
}
