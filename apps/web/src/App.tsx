import { useCallback, useEffect, useState } from 'react'
import './styles.css'

interface Device { id: number; name: string; ip: string; port: number; mode: string; isActive: number }
interface Register { id: number; groupId: number; objectId: number; alias: string | null; functionCode: number; startAddress: number; dataType: string }
interface DeviceGroup { id: number; name: string; functionCode: number; startAddress: number; quantity: number; registers: Register[] }
interface LatestValue { rawValue: number; quality: string; timestamp: string }

type Lang = 'zh' | 'en'
type Theme = 'light' | 'dark' | 'system'
type T = (key: string) => string

const I18N: Record<Lang, Record<string, string>> = {
  zh: {
    brand: 'ProbeStation',
    brandSub: '设备观测与测试',
    newDevice: '＋ 新建设备',
    devices: '设备',
    noDevices: '暂无设备，点上方新建',
    settings: '设置',
    emptyHint: '选择左侧设备，或新建设备开始观测',
    polling: '轮询中',
    stopped: '已停用',
    pause: '暂停',
    resume: '启用',
    exportCsv: '导出 CSV',
    exportXlsx: '导出 XLSX',
    deleteDevice: '删除设备',
    regCount: '{n} 个寄存器',
    colAlias: '别名', colAddr: '地址', colType: '类型', colValue: '实时值', colQuality: '质量', colWrite: '写值',
    write: '写', valuePh: '值',
    noRegisters: '暂无寄存器（可通过 API 导入 MBS/MBP 文件）',
    settingsTitle: '设置', settingsSub: '外观、语言与数据管理',
    tabLive: '实时数据', tabHistory: '历史数据', tabCurve: '曲线', tabFirmware: '固件',
    groupCount: '{n} 组',
    histHint: '最近 1 小时数据', curveHint: '最近 1 小时曲线', firmwareHint: '固件升级功能规划中（OTA）',
    appearance: '外观', themeLabel: '主题', light: '浅色', dark: '深色', system: '跟随系统',
    language: '语言',
    appInfo: '应用信息', version: '版本', arch: '架构', persistence: '持久化',
    dataMgmt: '数据管理', runLogs: '运行日志', clearLogs: '清空日志', logsCleared: '日志已清空',
    newDeviceTitle: '新建设备', name: '名称', ip: 'IP 地址', port: '端口', cancel: '取消', add: '添加',
  },
  en: {
    brand: 'ProbeStation',
    brandSub: 'Device observation & testing',
    newDevice: '＋ New Device',
    devices: 'Devices',
    noDevices: 'No devices, create one above',
    settings: 'Settings',
    emptyHint: 'Select a device or create one to start',
    polling: 'Polling',
    stopped: 'Stopped',
    pause: 'Pause',
    resume: 'Resume',
    exportCsv: 'Export CSV',
    exportXlsx: 'Export XLSX',
    deleteDevice: 'Delete',
    regCount: '{n} registers',
    colAlias: 'Alias', colAddr: 'Addr', colType: 'Type', colValue: 'Value', colQuality: 'Quality', colWrite: 'Write',
    write: 'Write', valuePh: 'value',
    noRegisters: 'No registers (import MBS/MBP via API)',
    settingsTitle: 'Settings', settingsSub: 'Appearance, language & data',
    tabLive: 'Live', tabHistory: 'History', tabCurve: 'Curve', tabFirmware: 'Firmware',
    groupCount: '{n} groups',
    histHint: 'Last 1 hour', curveHint: 'Last 1 hour', firmwareHint: 'Firmware upgrade (OTA) is planned',
    appearance: 'Appearance', themeLabel: 'Theme', light: 'Light', dark: 'Dark', system: 'System',
    language: 'Language',
    appInfo: 'App info', version: 'Version', arch: 'Architecture', persistence: 'Persistence',
    dataMgmt: 'Data management', runLogs: 'Runtime logs', clearLogs: 'Clear logs', logsCleared: 'Logs cleared',
    newDeviceTitle: 'New device', name: 'Name', ip: 'IP address', port: 'Port', cancel: 'Cancel', add: 'Add',
  },
}

const api = {
  get: (url: string) => fetch(url).then((r) => r.json()),
  post: (url: string, body?: unknown) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then((r) => r.json()),
  del: (url: string) => fetch(url, { method: 'DELETE' }).then((r) => r.json()),
}

export default function App() {
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('ps-theme') as Theme) ?? 'system')
  const [lang, setLang] = useState<Lang>(() => (localStorage.getItem('ps-lang') as Lang) ?? 'zh')
  const [devices, setDevices] = useState<Device[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('ps-collapsed') === '1')
  const [groups, setGroups] = useState<DeviceGroup[]>([])
  const [latest, setLatest] = useState<Record<number, LatestValue>>({})
  const [showAdd, setShowAdd] = useState(false)

  const t: T = useCallback((key: string) => I18N[lang][key] ?? key, [lang])

  useEffect(() => {
    const apply = () => {
      const r = theme === 'system' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme
      document.documentElement.setAttribute('data-theme', r)
    }
    apply()
    localStorage.setItem('ps-theme', theme)
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [theme])
  useEffect(() => { localStorage.setItem('ps-lang', lang) }, [lang])
  useEffect(() => { localStorage.setItem('ps-collapsed', collapsed ? '1' : '0') }, [collapsed])

  const refreshDevices = useCallback(() => { api.get('/api/monitor_objects').then(setDevices) }, [])
  const refreshRegisters = useCallback((id: number) => {
    api.get('/api/monitor_objects/' + id + '/groups').then(async (gs: Array<{ id: number; name: string; functionCode: number; startAddress: number; quantity: number }>) => {
      const out: DeviceGroup[] = []
      for (const g of gs) {
        const regs: Register[] = await api.get('/api/groups/' + g.id + '/registers')
        out.push({ id: g.id, name: g.name, functionCode: g.functionCode, startAddress: g.startAddress, quantity: g.quantity, registers: regs })
      }
      setGroups(out)
    })
  }, [])

  useEffect(() => { refreshDevices() }, [refreshDevices])
  useEffect(() => { if (selectedId != null) refreshRegisters(selectedId) }, [selectedId, refreshRegisters])
  useEffect(() => {
    const ws = new WebSocket('ws://' + location.host + '/ws')
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data)
      if (msg.type === 'latest') setLatest(msg.data)
      else if (msg.type === 'poller/result') {
        setLatest((prev) => { const next = { ...prev }; for (const p of msg.points) next[p.registerId] = { rawValue: p.rawValue, quality: p.quality, timestamp: p.timestamp }; return next })
      }
    }
    return () => ws.close()
  }, [])

  const addDevice = useCallback(async (name: string, ip: string, port: number) => {
    if (!name || !ip) return
    await api.post('/api/monitor_objects', { name, ip, port })
    setShowAdd(false); refreshDevices()
  }, [refreshDevices])
  const toggleDevice = useCallback(async (id: number) => { await api.post('/api/monitor_objects/' + id + '/toggle'); refreshDevices() }, [refreshDevices])
  const deleteDevice = useCallback(async (id: number) => {
    await api.del('/api/monitor_objects/' + id)
    if (selectedId === id) setSelectedId(null)
    refreshDevices()
  }, [selectedId, refreshDevices])

  const selected = devices.find((d) => d.id === selectedId) ?? null

  return (
    <div className="shell">
      <aside className={'sidebar' + (collapsed ? ' collapsed' : '')}>
        <div className="sidebar-header">
          <div className="sidebar-head-row">
            {!collapsed && (
              <div>
                <div className="brand">{t('brand')}</div>
                <div className="brand-sub">{t('brandSub')}</div>
              </div>
            )}
            <button className="collapse-btn" onClick={() => setCollapsed(!collapsed)}>{collapsed ? '»' : '«'}</button>
          </div>
          {!collapsed && <button className="new-btn" onClick={() => setShowAdd(true)}>{t('newDevice')}</button>}
        </div>
        {!collapsed && <div className="sidebar-section">{t('devices')}</div>}
        {!collapsed && <div className="device-list">
          {devices.map((d) => (
            <div key={d.id} className={'device-item' + (selectedId === d.id ? ' active' : '')} onClick={() => setSelectedId(d.id)}>
              <span className={'device-dot' + (d.isActive ? ' on' : '')} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="device-name">{d.name}</div>
                <div className="device-sub">{d.ip}:{d.port}</div>
              </div>
              <button className="device-del" onClick={(e) => { e.stopPropagation(); deleteDevice(d.id) }}>×</button>
            </div>
          ))}
          {devices.length === 0 && <div className="device-sub" style={{ padding: 8 }}>{t('noDevices')}</div>}
        </div>}
        <div className="sidebar-footer">
          <button className="settings-btn" onClick={() => setShowSettings(true)}>
            <span className="ico">⚙</span>
            {!collapsed && <span>{t('settings')}</span>}
          </button>
        </div>
      </aside>

      <main className="main">
        {selected
          ? <DeviceView key={selected.id} t={t} device={selected} groups={groups} latest={latest} onToggle={toggleDevice} onDelete={deleteDevice} />
          : <EmptyState t={t} />}
      </main>

      {showAdd && <AddDeviceModal t={t} onClose={() => setShowAdd(false)} onAdd={addDevice} />}
      {showSettings && <SettingsModal t={t} theme={theme} setTheme={setTheme} lang={lang} setLang={setLang} onClose={() => setShowSettings(false)} />}
    </div>
  )
}

function EmptyState({ t }: { t: T }) {
  return <div className="empty-state"><div className="big">🛰️</div><div>{t('emptyHint')}</div></div>
}

function DeviceView({ t, device, groups, latest, onToggle, onDelete }: {
  t: T; device: Device; groups: DeviceGroup[]; latest: Record<number, LatestValue>
  onToggle: (id: number) => void; onDelete: (id: number) => void
}) {
  const [tab, setTab] = useState(0)
  const registers = groups.flatMap((g) => g.registers)
  return (
    <div>
      <div className="device-head">
        <span className="name">{device.name}</span>
        <span className={'status-badge' + (device.isActive ? ' on' : '')}>{device.isActive ? t('polling') : t('stopped')}</span>
        <div style={{ flex: 1 }} />
        <button className="btn" onClick={() => onToggle(device.id)}>{device.isActive ? t('pause') : t('resume')}</button>
        <button className="btn danger" onClick={() => onDelete(device.id)}>{t('deleteDevice')}</button>
      </div>
      <div className="main-sub">{device.ip}:{device.port} · {t('groupCount').replace('{n}', String(groups.length))} · {t('regCount').replace('{n}', String(registers.length))}</div>
      <TabBar tabs={[t('tabLive'), t('tabHistory'), t('tabCurve'), t('tabFirmware')]} active={tab} onChange={setTab} />
      {tab === 0 && <LiveTable t={t} groups={groups} latest={latest} />}
      {tab === 1 && <HistoryTable t={t} device={device} registers={registers} />}
      {tab === 2 && <CurveChart t={t} device={device} registers={registers} />}
      {tab === 3 && <FirmwareView t={t} />}
    </div>
  )
}

function TabBar({ tabs, active, onChange }: { tabs: string[]; active: number; onChange: (i: number) => void }) {
  return (
    <div className="tab-bar">
      {tabs.map((name, i) => (
        <button key={i} className={'tab' + (active === i ? ' active' : '')} onClick={() => onChange(i)}>{name}</button>
      ))}
    </div>
  )
}

function LiveTable({ t, groups, latest }: { t: T; groups: DeviceGroup[]; latest: Record<number, LatestValue> }) {
  return (
    <div>
      {groups.map((g) => (
        <div key={g.id} className="group-block">
          <div className="group-head">
            <span className="group-name">{g.name}</span>
            <span className="kv">FC{g.functionCode} · 起始 {g.startAddress} · {g.quantity} 个</span>
          </div>
          <table className="reg">
            <thead><tr><th>{t('colAlias')}</th><th>{t('colAddr')}</th><th>{t('colType')}</th><th>{t('colValue')}</th><th>{t('colQuality')}</th><th>{t('colWrite')}</th></tr></thead>
            <tbody>
              {g.registers.map((r) => {
                const v = latest[r.id]
                return (
                  <tr key={r.id}>
                    <td>{r.alias ?? '—'}</td>
                    <td className="kv">{r.startAddress}</td>
                    <td className="kv">{r.dataType}</td>
                    <td className="value">{v ? v.rawValue : '—'}</td>
                    <td className="kv">{v ? v.quality : '—'}</td>
                    <td><WriteCell t={t} reg={r} /></td>
                  </tr>
                )
              })}
              {g.registers.length === 0 && <tr><td colSpan={6} className="kv">{t('noRegisters')}</td></tr>}
            </tbody>
          </table>
        </div>
      ))}
      {groups.length === 0 && <div className="kv">{t('noRegisters')}</div>}
    </div>
  )
}

function WriteCell({ t, reg }: { t: T; reg: Register }) {
  const [val, setVal] = useState('')
  const write = async () => {
    if (val === '') return
    await api.post('/api/registers/' + reg.id + '/write', { value: Number(val), method: 'multiple' })
    setVal('')
  }
  return (
    <div style={{ display: 'flex', gap: 4 }}>
      <input className="write-input" value={val} onChange={(e) => setVal(e.target.value)} placeholder={t('valuePh')} />
      <button className="btn" onClick={write}>{t('write')}</button>
    </div>
  )
}

function HistoryTable({ t, device, registers }: { t: T; device: Device; registers: Register[] }) {
  const [rows, setRows] = useState<Array<{ ts: string; values: Record<number, number> }>>([])
  useEffect(() => {
    const start = new Date(Date.now() - 3600_000).toISOString()
    const end = new Date().toISOString()
    api.get('/api/data/object?object_id=' + device.id + '&start=' + start + '&end=' + end).then((pts: Array<{ ts: string; registerId: number; rawValue: number }>) => {
      const map = new Map<string, Record<number, number>>()
      for (const p of pts) { if (!map.has(p.ts)) map.set(p.ts, {}); map.get(p.ts)![p.registerId] = p.rawValue }
      setRows([...map.entries()].map(([ts, values]) => ({ ts, values })))
    })
  }, [device.id])
  const exportCsv = () => { const now = new Date().toISOString(); window.open('/api/export/csv?object_id=' + device.id + '&start=2000-01-01T00:00:00Z&end=' + now) }
  const exportXlsx = () => { const now = new Date().toISOString(); window.open('/api/export/xlsx?object_id=' + device.id + '&start=2000-01-01T00:00:00Z&end=' + now) }
  return (
    <div>
      <div className="chart-hint">{t('histHint')} · <button className="btn" onClick={exportCsv}>{t('exportCsv')}</button> <button className="btn" onClick={exportXlsx}>{t('exportXlsx')}</button></div>
      <table className="reg">
        <thead><tr><th>时间</th>{registers.map(r => <th key={r.id}>{r.alias ?? r.id}</th>)}</tr></thead>
        <tbody>
          {rows.slice(-60).map((row, i) => (
            <tr key={i}><td className="kv">{row.ts}</td>{registers.map(r => <td key={r.id} className="value">{row.values[r.id] ?? '—'}</td>)}</tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={registers.length + 1} className="kv">暂无历史数据</td></tr>}
        </tbody>
      </table>
    </div>
  )
}

const CHART_COLORS = ['#4176e6', '#22c55e', '#f59e0b', '#ec1313', '#8b5cf6', '#06b6d4', '#f97316', '#ec4899', '#84cc16', '#14b8a6']

function CurveChart({ t, device, registers }: { t: T; device: Device; registers: Register[] }) {
  const [pts, setPts] = useState<Array<{ ts: string; registerId: number; rawValue: number }>>([])
  useEffect(() => {
    const start = new Date(Date.now() - 3600_000).toISOString()
    const end = new Date().toISOString()
    api.get('/api/data/object?object_id=' + device.id + '&start=' + start + '&end=' + end).then(setPts)
  }, [device.id])

  const W = 900, H = 320, P = 36
  const byReg = new Map<number, Array<[number, number]>>()
  for (const p of pts) {
    const arr = byReg.get(p.registerId) ?? []
    arr.push([new Date(p.ts).getTime(), p.rawValue])
    byReg.set(p.registerId, arr)
  }
  const series = [...byReg.entries()].map(([id, arr], i) => ({ id, color: CHART_COLORS[i % CHART_COLORS.length], arr: arr.sort((a, b) => a[0] - b[0]) }))
  const allT = pts.map(p => new Date(p.ts).getTime())
  const allV = pts.map(p => p.rawValue)
  if (pts.length === 0) return <div className="chart-wrap"><div className="chart-hint">{t('curveHint')} — 暂无数据</div></div>
  const minT = Math.min(...allT), maxT = Math.max(...allT), minV = Math.min(...allV), maxV = Math.max(...allV)
  const x = (ts: number) => P + (maxT === minT ? 0 : (ts - minT) / (maxT - minT)) * (W - 2 * P)
  const y = (v: number) => H - P - (maxV === minV ? 0 : (v - minV) / (maxV - minV)) * (H - 2 * P)
  const path = (arr: Array<[number, number]>) => arr.map(([ts, v], i) => (i === 0 ? 'M' : 'L') + x(ts).toFixed(1) + ' ' + y(v).toFixed(1)).join(' ')
  return (
    <div className="chart-wrap">
      <div className="chart-hint">{t('curveHint')}</div>
      <svg viewBox={'0 0 ' + W + ' ' + H} preserveAspectRatio="none" style={{ width: '100%', height: 320 }}>
        <line x1={P} y1={H - P} x2={W - P} y2={H - P} stroke="var(--border-2)" strokeWidth="1" />
        <line x1={P} y1={P} x2={P} y2={H - P} stroke="var(--border-2)" strokeWidth="1" />
        {series.map(s => <path key={s.id} d={path(s.arr)} fill="none" stroke={s.color} strokeWidth="1.6" />)}
      </svg>
      <div className="legend">
        {series.map(s => { const r = registers.find(rr => rr.id === s.id); return <span key={s.id} className="legend-item"><span className="legend-swatch" style={{ background: s.color }} />{r?.alias ?? s.id}</span> })}
      </div>
    </div>
  )
}

function FirmwareView({ t }: { t: T }) {
  return <div className="chart-wrap firmware-card"><div className="chart-hint">{t('firmwareHint')}</div></div>
}

function SettingsModal({ t, theme, setTheme, lang, setLang, onClose }: {
  t: T; theme: Theme; setTheme: (v: Theme) => void; lang: Lang; setLang: (v: Lang) => void; onClose: () => void
}) {
  const [msg, setMsg] = useState('')
  const clearLogs = async () => { await api.post('/api/logs/clear'); setMsg(t('logsCleared')) }
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>{t('settingsTitle')}</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
      <div className="settings-card">
        <h4>{t('appearance')}</h4>
        <div className="setting-row">
          <span>{t('themeLabel')}</span>
          <div className="seg">
            <button className={theme === 'light' ? 'selected' : ''} onClick={() => setTheme('light')}>{t('light')}</button>
            <button className={theme === 'dark' ? 'selected' : ''} onClick={() => setTheme('dark')}>{t('dark')}</button>
            <button className={theme === 'system' ? 'selected' : ''} onClick={() => setTheme('system')}>{t('system')}</button>
          </div>
        </div>
      </div>
      <div className="settings-card">
        <h4>{t('language')}</h4>
        <div className="setting-row">
          <span>{t('language')}</span>
          <div className="seg">
            <button className={lang === 'zh' ? 'selected' : ''} onClick={() => setLang('zh')}>中文</button>
            <button className={lang === 'en' ? 'selected' : ''} onClick={() => setLang('en')}>English</button>
          </div>
        </div>
      </div>
      <div className="settings-card">
        <h4>{t('appInfo')}</h4>
        <div className="setting-row"><span>{t('version')}</span><span className="kv">0.1.0</span></div>
        <div className="setting-row"><span>{t('arch')}</span><span className="kv">Cordis · TypeScript</span></div>
        <div className="setting-row"><span>{t('persistence')}</span><span className="kv">SQLite + DuckDB</span></div>
      </div>
      <div className="settings-card">
        <h4>{t('dataMgmt')}</h4>
        <div className="setting-row">
          <span>{t('runLogs')}</span>
          <button className="btn" onClick={clearLogs}>{t('clearLogs')}</button>
        </div>
        {msg && <div className="kv" style={{ marginTop: 8 }}>{msg}</div>}
      </div>
      </div>
    </div>
  )
}

function AddDeviceModal({ t, onClose, onAdd }: { t: T; onClose: () => void; onAdd: (name: string, ip: string, port: number) => void }) {
  const [name, setName] = useState('')
  const [ip, setIp] = useState('')
  const [port, setPort] = useState('8899')
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{t('newDeviceTitle')}</h3>
        <label>{t('name')}</label>
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        <label>{t('ip')}</label>
        <input value={ip} onChange={(e) => setIp(e.target.value)} placeholder="192.168.90.176" />
        <label>{t('port')}</label>
        <input value={port} onChange={(e) => setPort(e.target.value)} placeholder="8899" />
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>{t('cancel')}</button>
          <button className="btn primary" onClick={() => onAdd(name, ip, Number(port))}>{t('add')}</button>
        </div>
      </div>
    </div>
  )
}
