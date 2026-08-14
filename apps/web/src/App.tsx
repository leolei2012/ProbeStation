import { useCallback, useEffect, useState } from 'react'
import './styles.css'
import { applyEndianness, baseType, decodeRegister, isBinType, isHexType, registerWidth, toBin, toHex } from '../../../packages/core/src/codec.ts'

const TYPE_GROUPS = [
  { key: 'grp16BE', types: ['int16', 'uint16', 'float16', 'hex16', 'bin16'] },
  { key: 'grp16LE', types: ['int16-LE', 'uint16-LE', 'float16-LE', 'hex16-LE', 'bin16-LE'] },
  { key: 'grp32BE', types: ['int32', 'uint32', 'float32', 'hex32', 'bin32'] },
  { key: 'grp32LE', types: ['int32-LE', 'uint32-LE', 'float32-LE', 'hex32-LE', 'bin32-LE'] },
  { key: 'grp64BE', types: ['int64', 'uint64', 'float64', 'hex64', 'bin64'] },
  { key: 'grp64LE', types: ['int64-LE', 'uint64-LE', 'float64-LE', 'hex64-LE', 'bin64-LE'] },
]

interface Device { id: number; name: string; ip: string; port: number; mode: string; isActive: number }
interface Register { id: number; groupId: number; objectId: number; alias: string | null; functionCode: number; startAddress: number; dataType: string }
interface DeviceGroup { id: number; name: string; slaveId: number; functionCode: number; startAddress: number; quantity: number; pollIntervalMs: number; isActive: number; registers: Register[] }
interface LatestValue { rawValue: number; quality: string; timestamp: string }
interface WorkspaceInfo { current: string; currentTitle: string; recent: { path: string; title: string; lastUsedAt: string; createdAt: string }[] }

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
    workspace: '工作区',
    switchWorkspace: '切换工作区', addWorkspace: '添加工作区', newWorkspace: '新工作区', createdAt: '创建于',
    wsPath: '工作区路径',
    selectFolder: '选择此文件夹',
    upFolder: '上一级',
    recentWs: '最近使用',
    settings: '设置',
    emptyHint: '选择左侧设备，或新建设备开始观测',
    polling: '轮询中',
    stopped: '已停用',
    connected: '已连接',
    disconnected: '未连接',
    connect: '连接',
    disconnect: '断开',
    pause: '暂停',
    resume: '启用', enable: '使能',
    exportCsv: '导出 CSV',
    exportXlsx: '导出 XLSX',
    deleteDevice: '删除设备',
    regCount: '{n} 个寄存器',
    colAlias: '别名', colAddr: '地址', colType: '类型', colValue: '值', colQuality: '质量', colWrite: '写值', writeReg: '写寄存器', fc16: 'FC16 写多个寄存器', fc06: 'FC06 写单个寄存器', valueHint: '双击值可写入', valueCovered: '被上一个多字寄存器占用', valueShort: '数据不足（分组读取范围不够）', grp16BE: '16位 大端', grp16LE: '16位 小端', grp32BE: '32位 大端', grp32LE: '32位 小端', grp64BE: '64位 大端', grp64LE: '64位 小端',
    write: '写', valuePh: '值',
    noRegisters: '暂无寄存器（可通过 API 导入 MBS/MBP 文件）',
    settingsTitle: '设置', settingsSub: '外观、语言与数据管理',
    tabLive: '实时数据', tabHistory: '历史数据', tabCurve: '曲线', tabFirmware: '固件',
    groupCount: '{n} 组',
    newGroup: '新建分组', editGroup: '编辑分组', groupName: '组名', slaveId: '从站 ID', functionCode: '功能码', startAddress: '起始地址', quantity: '数量', scanRate: '扫描间隔(ms)', edit: '编辑', save: '保存', fcReadHolding: '读保持寄存器', fcReadInput: '读输入寄存器',
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
    workspace: 'Workspace',
    switchWorkspace: 'Switch workspace', addWorkspace: 'Add workspace', newWorkspace: 'New workspace', createdAt: 'Created',
    wsPath: 'Workspace path',
    selectFolder: 'Select this folder',
    upFolder: 'Parent',
    recentWs: 'Recent',
    settings: 'Settings',
    emptyHint: 'Select a device or create one to start',
    polling: 'Polling',
    stopped: 'Stopped',
    connected: 'Connected',
    disconnected: 'Disconnected',
    connect: 'Connect',
    disconnect: 'Disconnect',
    pause: 'Pause',
    resume: 'Resume', enable: 'Enable',
    exportCsv: 'Export CSV',
    exportXlsx: 'Export XLSX',
    deleteDevice: 'Delete',
    regCount: '{n} registers',
    colAlias: 'Alias', colAddr: 'Addr', colType: 'Type', colValue: 'Value', colQuality: 'Quality', colWrite: 'Write', writeReg: 'Write register', fc16: 'FC16 Write multiple', fc06: 'FC06 Write single', valueHint: 'Double-click a value to write', valueCovered: 'Covered by previous register', valueShort: 'Not enough polled data', grp16BE: '16-bit BE', grp16LE: '16-bit LE', grp32BE: '32-bit BE', grp32LE: '32-bit LE', grp64BE: '64-bit BE', grp64LE: '64-bit LE',
    write: 'Write', valuePh: 'value',
    noRegisters: 'No registers (import MBS/MBP via API)',
    settingsTitle: 'Settings', settingsSub: 'Appearance, language & data',
    tabLive: 'Live', tabHistory: 'History', tabCurve: 'Curve', tabFirmware: 'Firmware',
    groupCount: '{n} groups',
    newGroup: 'New Group', editGroup: 'Edit Group', groupName: 'Name', slaveId: 'Slave ID', functionCode: 'Function', startAddress: 'Start addr', quantity: 'Quantity', scanRate: 'Scan rate(ms)', edit: 'Edit', save: 'Save', fcReadHolding: 'Read Holding', fcReadInput: 'Read Input',
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
  put: (url: string, body: unknown) => fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json()),
  del: (url: string) => fetch(url, { method: 'DELETE' }).then((r) => r.json()),
}

function formatNumber(d: number | bigint): string {
  if (typeof d === 'bigint') return d.toString()
  if (Number.isNaN(d)) return 'NaN'
  if (!Number.isFinite(d)) return d > 0 ? 'Inf' : '-Inf'
  return Number.isInteger(d) ? String(d) : String(Number(d.toPrecision(7)))
}

function FolderIcon({ open }: { open: boolean }) {
  return (
    <svg className="ws-folder-ico" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {open
        ? <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
        : <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />}
    </svg>
  )
}

function formatDateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

interface RegView { value: string; covered: boolean; invalid: boolean; writable: boolean }

/** 按地址顺序合并多字：首字显示合并值、被覆盖字显示 —、数据不足显示 —（不可写）。 */
function buildRegViews(groups: DeviceGroup[], latest: Record<number, LatestValue>): Map<number, RegView> {
  const rawByAddr: Record<number, number> = {}
  const regIds = new Set<number>()
  for (const g of groups) for (const r of g.registers) {
    regIds.add(r.id)
    const v = latest[r.id]
    if (v) rawByAddr[r.startAddress] = v.rawValue
  }
  for (const k of Object.keys(latest)) {
    const n = Number(k)
    if (regIds.has(n)) continue
    const v = latest[n]
    if (v && rawByAddr[n] === undefined) rawByAddr[n] = v.rawValue
  }
  const views = new Map<number, RegView>()
  for (const g of groups) {
    const regs = [...g.registers].sort((a, b) => a.startAddress - b.startAddress)
    const groupEnd = g.startAddress + g.quantity
    let consumedUpTo = -Infinity
    for (const r of regs) {
      const w = registerWidth(r.dataType)
      const start = r.startAddress
      const end = start + w
      if (start < consumedUpTo) {
        views.set(r.id, { value: '—', covered: true, invalid: false, writable: false })
        continue
      }
      const words: number[] = []
      for (let a = start; a < end; a++) {
        const wv = rawByAddr[a]
        if (wv === undefined) break
        words.push(wv)
      }
      const enough = words.length === w && end <= groupEnd
      if (!enough) {
        views.set(r.id, { value: '—', covered: false, invalid: true, writable: false })
        continue
      }
      const raw = isHexType(r.dataType) || isBinType(r.dataType)
      const dispWords = applyEndianness(r.dataType, words)
      const value = isHexType(r.dataType) ? dispWords.map(toHex).join(' ') : isBinType(r.dataType) ? dispWords.map(toBin).join(' ') : formatNumber(decodeRegister(r.dataType, words))
      views.set(r.id, { value, covered: false, invalid: false, writable: !raw })
      consumedUpTo = end
    }
  }
  return views
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
  const [groupErrors, setGroupErrors] = useState<Record<number, string>>({})
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null)
  const [showWorkspace, setShowWorkspace] = useState(false)
  const [showAdd, setShowAdd] = useState(false)
  const [wsExpanded, setWsExpanded] = useState(true)

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
  const refreshWorkspace = useCallback(() => { api.get('/api/workspace').then(setWorkspace) }, [])
  const refreshRegisters = useCallback((id: number) => {
    api.get('/api/monitor_objects/' + id + '/groups').then(async (gs: Array<{ id: number; name: string; slaveId: number; functionCode: number; startAddress: number; quantity: number; pollIntervalMs: number; isActive: number }>) => {
      const out: DeviceGroup[] = []
      for (const g of gs) {
        const regs: Register[] = await api.get('/api/groups/' + g.id + '/registers')
        out.push({ id: g.id, name: g.name, slaveId: g.slaveId, functionCode: g.functionCode, startAddress: g.startAddress, quantity: g.quantity, pollIntervalMs: g.pollIntervalMs, isActive: g.isActive, registers: regs })
      }
      setGroups(out)
    })
  }, [])

  useEffect(() => { refreshDevices(); refreshWorkspace() }, [refreshDevices, refreshWorkspace])
  useEffect(() => { if (selectedId != null) refreshRegisters(selectedId) }, [selectedId, refreshRegisters])
  useEffect(() => {
    const ws = new WebSocket('ws://' + location.host + '/ws')
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data)
      if (msg.type === 'latest') setLatest(msg.data)
      else if (msg.type === 'poller/result') {
        setLatest((prev) => { const next = { ...prev }; for (const p of msg.points) next[p.registerId] = { rawValue: p.rawValue, quality: p.quality, timestamp: p.timestamp }; return next })
      }
      else if (msg.type === 'group-error') setGroupErrors((prev) => ({ ...prev, [msg.groupId]: msg.error }))
      else if (msg.type === 'group-ok') setGroupErrors((prev) => { const next = { ...prev }; delete next[msg.groupId]; return next })
      else if (msg.type === 'workspace/changed') { setSelectedId(null); setLatest({}); setGroupErrors({}); refreshDevices(); refreshWorkspace() }
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

  const switchWorkspace = useCallback(async (path: string) => {
    await api.post('/api/workspace/switch', { path })
    setShowWorkspace(false)
    setWsExpanded(true)
    setSelectedId(null)
    setLatest({})
    setGroupErrors({})
    refreshDevices()
    refreshWorkspace()
  }, [refreshDevices, refreshWorkspace])

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
        </div>
        {!collapsed && (
          <>
            <button className="new-workspace-btn" onClick={() => setShowWorkspace(true)}>
              <span className="ico">＋</span>
              <span>{t('newWorkspace')}</span>
            </button>
            <div className="sidebar-section">{t('workspace')}</div>
            <div className="ws-list">
              {(workspace?.recent ?? []).map((w) => {
                const isCurrent = w.path === workspace?.current
                const isExpanded = isCurrent && wsExpanded
                return (
                  <div key={w.path} className="ws-group">
                    <div className="ws-row-wrap">
                      <div className={'ws-row' + (isCurrent ? ' current' : '')} onClick={() => { if (isCurrent) setWsExpanded(!wsExpanded); else switchWorkspace(w.path) }}>
                        <FolderIcon open={isExpanded} />
                        <span className="ws-chevron">{isExpanded ? '▾' : '▸'}</span>
                        <span className="ws-title">{w.title}</span>
                        {isCurrent && <span className="ws-count">{devices.length}</span>}
                        {isCurrent && <button className="ws-row-add" onClick={(e) => { e.stopPropagation(); setShowAdd(true) }} title={t('newDevice')} aria-label={t('newDevice')}>＋</button>}
                      </div>
                      <div className="ws-hover-card">
                        <div className="ws-hover-title">{w.title}</div>
                        <div className="ws-hover-path">{w.path}</div>
                        {w.createdAt && <div className="ws-hover-time">{t('createdAt')} {formatDateTime(w.createdAt)}</div>}
                      </div>
                    </div>
                    {isExpanded && (
                      <div className="ws-children">
                        <div className="device-list">
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
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </>
        )}
        <div className="sidebar-footer">
          <button className="settings-btn" onClick={() => setShowSettings(true)}>
            <span className="ico">⚙</span>
            {!collapsed && <span>{t('settings')}</span>}
          </button>
        </div>
      </aside>

      <main className="main">
        {selected
          ? <DeviceView key={selected.id} t={t} device={selected} groups={groups} latest={latest} groupErrors={groupErrors} onToggle={toggleDevice} onDelete={deleteDevice} onRefresh={refreshRegisters} />
          : <EmptyState t={t} />}
      </main>

      {showAdd && <AddDeviceModal t={t} onClose={() => setShowAdd(false)} onAdd={addDevice} />}
      {showWorkspace && <WorkspaceModal t={t} workspace={workspace} onClose={() => setShowWorkspace(false)} onSwitch={switchWorkspace} />}
      {showSettings && <SettingsModal t={t} theme={theme} setTheme={setTheme} lang={lang} setLang={setLang} onClose={() => setShowSettings(false)} />}
    </div>
  )
}

function EmptyState({ t }: { t: T }) {
  return <div className="empty-state"><div className="big">🛰️</div><div>{t('emptyHint')}</div></div>
}

function DeviceView({ t, device, groups, latest, groupErrors, onToggle, onDelete, onRefresh }: {
  t: T; device: Device; groups: DeviceGroup[]; latest: Record<number, LatestValue>; groupErrors: Record<number, string>
  onToggle: (id: number) => void; onDelete: (id: number) => void; onRefresh: (id: number) => void
}) {
  const [tab, setTab] = useState(0)
  const registers = groups.flatMap((g) => g.registers)
  return (
    <div>
      <div className="device-head">
        <span className="name">{device.name}</span>
        <span className={'status-badge' + (device.isActive ? ' on' : '')}>{device.isActive ? t('connected') : t('disconnected')}</span>
        <div style={{ flex: 1 }} />
        <button className="btn" onClick={() => onToggle(device.id)}>{device.isActive ? t('disconnect') : t('connect')}</button>
        <button className="btn danger" onClick={() => onDelete(device.id)}>{t('deleteDevice')}</button>
      </div>
      <div className="main-sub">{device.ip}:{device.port} · {t('groupCount').replace('{n}', String(groups.length))} · {t('regCount').replace('{n}', String(registers.length))}</div>
      <TabBar tabs={[t('tabLive'), t('tabHistory'), t('tabCurve'), t('tabFirmware')]} active={tab} onChange={setTab} />
      {tab === 0 && <LiveTable t={t} device={device} groups={groups} latest={latest} groupErrors={groupErrors} onRefresh={() => onRefresh(device.id)} />}
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

function LiveTable({ t, device, groups, latest, groupErrors, onRefresh }: {
  t: T; device: Device; groups: DeviceGroup[]; latest: Record<number, LatestValue>; groupErrors: Record<number, string>; onRefresh: () => void
}) {
  const [modal, setModal] = useState<null | { mode: 'add' } | { mode: 'edit'; group: DeviceGroup }>(null)
  const [writeReg, setWriteReg] = useState<Register | null>(null)
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())
  const toggleCollapse = (id: number) => setCollapsed((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })
  const deleteGroup = async (id: number) => { await api.del('/api/groups/' + id); onRefresh() }
  const views = buildRegViews(groups, latest)
  return (
    <div>
      <div className="toolbar">
        <button className="btn primary" onClick={() => setModal({ mode: 'add' })}>＋ {t('newGroup')}</button>
      </div>
      {groups.map((g) => (
        <div key={g.id} className="group-block">
          <div className="group-head">
            <button className="group-collapse" onClick={() => toggleCollapse(g.id)}>{collapsed.has(g.id) ? '▸' : '▾'}</button>
            <span className="group-name" style={{ cursor: 'pointer' }} onClick={() => toggleCollapse(g.id)}>{g.name}</span>
            <span className="kv">FC{g.functionCode} · 从站 {g.slaveId} · 起始 {g.startAddress} · {g.quantity} 个 · {g.pollIntervalMs}ms</span>
            {groupErrors[g.id] && <span className="group-error" title={groupErrors[g.id]}>⚠ {groupErrors[g.id]}</span>}
            <div style={{ flex: 1 }} />
            <button className="btn" onClick={() => setModal({ mode: 'edit', group: g })}>{t('edit')}</button>
            <button className="btn danger" onClick={() => deleteGroup(g.id)}>{t('deleteDevice')}</button>
          </div>
          {!collapsed.has(g.id) && (<table className="reg">
            <thead><tr><th>{t('colAddr')}</th><th>{t('colAlias')}</th><th>{t('colType')}</th><th>{t('colValue')}</th></tr></thead>
            <tbody>
              {g.registers.map((r) => {
                const rv = views.get(r.id)
                return (
                  <tr key={r.id}>
                    <td className="kv">{r.startAddress}</td>
                    <td><AliasCell t={t} reg={r} onRefresh={onRefresh} /></td>
                    <td><TypeCell t={t} reg={r} available={g.startAddress + g.quantity - r.startAddress} onRefresh={onRefresh} /></td>
                    <td className="value" title={rv?.covered ? t('valueCovered') : rv?.invalid ? t('valueShort') : t('valueHint')} onDoubleClick={rv?.writable ? () => setWriteReg(r) : undefined}>{rv?.value ?? '—'}</td>
                  </tr>
                )
              })}
              {g.registers.length === 0 && <tr><td colSpan={4} className="kv">{t('noRegisters')}</td></tr>}
            </tbody>
          </table>)}
        </div>
      ))}
      {groups.length === 0 && <div className="kv">{t('noRegisters')}</div>}
      {modal && <GroupModal t={t} device={device} initial={modal.mode === 'edit' ? modal.group : null} onClose={() => setModal(null)} onSaved={() => { setModal(null); onRefresh() }} />}
      {writeReg && <WriteModal t={t} reg={writeReg} onClose={() => setWriteReg(null)} onSaved={() => setWriteReg(null)} />}
    </div>
  )
}

function GroupModal({ t, device, initial, onClose, onSaved }: {
  t: T; device: Device; initial: DeviceGroup | null; onClose: () => void; onSaved: () => void
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [slaveId, setSlaveId] = useState(String(initial?.slaveId ?? 1))
  const [functionCode, setFunctionCode] = useState(String(initial?.functionCode ?? 3))
  const [startAddress, setStartAddress] = useState(String(initial?.startAddress ?? 0))
  const [quantity, setQuantity] = useState(String(initial?.quantity ?? 1))
  const [pollIntervalMs, setPollIntervalMs] = useState(String(initial?.pollIntervalMs ?? 1000))
  const [isActive, setIsActive] = useState(initial ? initial.isActive === 1 : true)
  const save = async () => {
    const body = { name, slaveId: Number(slaveId), functionCode: Number(functionCode), startAddress: Number(startAddress), quantity: Number(quantity), pollIntervalMs: Number(pollIntervalMs), isActive: isActive ? 1 : 0 }
    if (initial) await api.put('/api/groups/' + initial.id, body)
    else await api.post('/api/monitor_objects/' + device.id + '/groups', body)
    onSaved()
  }
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{initial ? t('editGroup') : t('newGroup')}</h3>
        <label>{t('groupName')}</label>
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        <label>{t('slaveId')}</label>
        <input value={slaveId} onChange={(e) => setSlaveId(e.target.value)} />
        <label>{t('functionCode')}</label>
        <select value={functionCode} onChange={(e) => setFunctionCode(e.target.value)}>
          <option value="3">FC03 · {t('fcReadHolding')}</option>
          <option value="4">FC04 · {t('fcReadInput')}</option>
        </select>
        <label>{t('startAddress')}</label>
        <input value={startAddress} onChange={(e) => setStartAddress(e.target.value)} />
        <label>{t('quantity')}</label>
        <input value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        <label>{t('scanRate')}</label>
        <input value={pollIntervalMs} onChange={(e) => setPollIntervalMs(e.target.value)} />
        <label className="checkbox-row">
          <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
          <span>{t('enable')}</span>
        </label>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>{t('cancel')}</button>
          <button className="btn primary" onClick={save}>{t('save')}</button>
        </div>
      </div>
    </div>
  )
}

function WriteModal({ t, reg, onClose, onSaved }: { t: T; reg: Register; onClose: () => void; onSaved: () => void }) {
  const [value, setValue] = useState('')
  const [method, setMethod] = useState<'single' | 'multiple'>('multiple')
  const [busy, setBusy] = useState(false)
  const width = registerWidth(reg.dataType)
  const base = baseType(reg.dataType)
  const is64 = base === 'int64' || base === 'uint64'
  const write = async () => {
    if (value === '') return
    setBusy(true)
    try {
      await api.post('/api/registers/' + reg.id + '/write', { value: is64 ? value : Number(value), method: width > 1 ? 'multiple' : method })
      onSaved()
    } finally { setBusy(false) }
  }
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{t('writeReg')}</h3>
        <div className="kv" style={{ marginBottom: 10 }}>{reg.alias ?? reg.id} · {t('colAddr')} {reg.startAddress} · {reg.dataType}{width > 1 ? '（' + width + ' 寄存器）' : ''}</div>
        <label>{t('valuePh')}</label>
        <input value={value} onChange={(e) => setValue(e.target.value)} autoFocus placeholder={t('valuePh')} />
        <label>{t('functionCode')}</label>
        <select value={method} onChange={(e) => setMethod(e.target.value as 'single' | 'multiple')} disabled={width > 1}>
          <option value="multiple">{t('fc16')}</option>
          {width === 1 && <option value="single">{t('fc06')}</option>}
        </select>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>{t('cancel')}</button>
          <button className="btn primary" onClick={write} disabled={busy}>{t('write')}</button>
        </div>
      </div>
    </div>
  )
}

function AliasCell({ t, reg, onRefresh }: { t: T; reg: Register; onRefresh: () => void }) {
  const [val, setVal] = useState(reg.alias ?? '')
  const commit = async () => {
    if (val === (reg.alias ?? '')) return
    await api.put('/api/registers/' + reg.id, { alias: val || null })
    onRefresh()
  }
  return (
    <input className="cell-input" value={val} placeholder={t('colAlias')}
      onChange={(e) => setVal(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
  )
}

function TypeCell({ t, reg, available, onRefresh }: { t: T; reg: Register; available: number; onRefresh: () => void }) {
  const [err, setErr] = useState(false)
  const change = async (v: string) => {
    if (v === reg.dataType) return
    if (registerWidth(v) > available) { setErr(true); setTimeout(() => setErr(false), 1600); return }
    await api.put('/api/registers/' + reg.id, { dataType: v })
    onRefresh()
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <select className="cell-select" value={reg.dataType} onChange={(e) => change(e.target.value)}>
        {TYPE_GROUPS.map((grp) => (
          <optgroup key={grp.key} label={t(grp.key)}>
            {grp.types.map((d) => <option key={d} value={d}>{d}</option>)}
          </optgroup>
        ))}
      </select>
      {err && <span className="cell-err" title={t('valueShort')}>⚠</span>}
    </span>
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

function WorkspaceModal({ t, workspace, onClose, onSwitch }: {
  t: T; workspace: WorkspaceInfo | null; onClose: () => void; onSwitch: (path: string) => void
}) {
  const [path, setPath] = useState(workspace?.current ?? '')
  const [browse, setBrowse] = useState<{ path: string; parent: string | null; dirs: string[] } | null>(null)
  const browseTo = async (p: string) => {
    const b = await api.get('/api/workspace/browse?path=' + encodeURIComponent(p))
    setBrowse(b)
    setPath(b.path)
  }
  useEffect(() => { if (workspace?.current) void browseTo(workspace.current) }, [])
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal ws-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>{t('switchWorkspace')}</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <label>{t('wsPath')}</label>
        <input value={path} onChange={(e) => setPath(e.target.value)} />
        <div className="ws-browse">
          {browse?.parent != null && <button className="btn ws-dir" onClick={() => void browseTo(browse.parent!)}>↑ {t('upFolder')}</button>}
          {browse?.dirs.map((d) => (
            <button key={d} className="btn ws-dir" onClick={() => void browseTo(browse.path + '/' + d)}>📁 {d}</button>
          ))}
        </div>
        {workspace && workspace.recent.length > 0 && (
          <>
            <div className="sidebar-section">{t('recentWs')}</div>
            {workspace.recent.map((r) => (
              <div key={r.path} className="ws-recent" onClick={() => { setPath(r.path); void browseTo(r.path) }}>
                <span className="ws-recent-title">{r.title}</span>
                <span className="ws-recent-path">{r.path}</span>
              </div>
            ))}
          </>
        )}
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>{t('cancel')}</button>
          <button className="btn primary" onClick={() => onSwitch(path)}>{t('selectFolder')}</button>
        </div>
      </div>
    </div>
  )
}
