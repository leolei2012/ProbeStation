import { useCallback, useEffect, useRef, useState } from 'react'
import './styles.css'
import { baseType, decodeRawByAddr, formatRawByAddr, formatRegisterValue, isBinType, isHexType, registerWidth } from '../../../packages/core/src/codec.ts'

const TYPE_GROUPS = [
  { key: 'grp16BE', types: ['int16', 'uint16', 'float16', 'hex16', 'bin16'] },
  { key: 'grp16LE', types: ['int16-LE', 'uint16-LE', 'float16-LE', 'hex16-LE', 'bin16-LE'] },
  { key: 'grp32BE', types: ['int32', 'uint32', 'float32', 'hex32', 'bin32'] },
  { key: 'grp32LE', types: ['int32-LE', 'uint32-LE', 'float32-LE', 'hex32-LE', 'bin32-LE'] },
  { key: 'grp64BE', types: ['int64', 'uint64', 'float64', 'hex64', 'bin64'] },
  { key: 'grp64LE', types: ['int64-LE', 'uint64-LE', 'float64-LE', 'hex64-LE', 'bin64-LE'] },
]

interface Device { id: number; name: string; ip: string; port: number; mode: string; isActive: number; transport: string; serialPath: string | null; baudRate: number; parity: string; stopBits: number; dataBits: number; flowControl: string; slaveId: number; pollIntervalMs: number; dataRetainSeconds: number | null }
type DeviceFields = { name: string; ip: string; port: number; transport: string; serialPath: string; baudRate: number; parity: string; stopBits: number; dataBits: number; flowControl: string; slaveId: number; pollIntervalMs: number }
interface Register { id: number; groupId: number; objectId: number; alias: string | null; functionCode: number; startAddress: number; dataType: string }
interface DeviceGroup { id: number; name: string; slaveId: number; functionCode: number; startAddress: number; quantity: number; pollIntervalMs: number; isActive: number; registers: Register[] }
interface LatestValue { rawValue: number; quality: string; timestamp: string }
interface WorkspaceInfo { current: string; currentTitle: string; recent: { path: string; title: string; lastUsedAt: string; createdAt: string }[] }

type Lang = 'zh' | 'en'
type Theme = 'light' | 'dark' | 'system'
type T = (key: string) => string
type RealtimeStatus = 'connecting' | 'connected' | 'stale' | 'reconnecting' | 'disconnected'

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
    realtimeConnected: '实时通道正常', realtimeConnecting: '实时通道连接中', realtimeStale: '实时数据延迟', realtimeReconnecting: '实时通道重连中（第 {n} 次）', realtimeDisconnected: '实时通道已断开',
    groupDisconnected: '已断开',
    connect: '连接',
    disconnect: '断开',
    pause: '暂停',
    resume: '启用', enable: '使能',
    export: '导出', exportTitle: '导出数据', exportCsv: '导出 CSV',
    exportXlsx: '导出 XLSX',
    deleteDevice: '删除设备', deleteGroup: '删除分组', confirmDeleteDevice: '确定删除设备「{name}」？其下所有分组与寄存器将一并删除。', confirmDeleteGroup: '确定删除分组「{name}」？其下所有寄存器将一并删除。',
    regCount: '{n} 个寄存器',
    colAlias: '别名', colAddr: '地址', colType: '类型', colValue: '值', colQuality: '质量', colWrite: '写值', writeReg: '写寄存器', fc16: 'FC16 写多个寄存器', fc06: 'FC06 写单个寄存器', valueHint: '双击值可写入', valueCovered: '被上一个多字寄存器占用', valueShort: '数据不足（分组读取范围不够）', grp16BE: '16位 大端', grp16LE: '16位 小端', grp32BE: '32位 大端', grp32LE: '32位 小端', grp64BE: '64位 大端', grp64LE: '64位 小端',
    write: '写', valuePh: '值', writeErrEmpty: '请输入值', writeErrNaN: '请输入有效数字', writeOk: '已写入',
    noRegisters: '暂无寄存器（可通过 API 导入 MBS/MBP 文件）',
    settingsTitle: '设置', settingsSub: '外观、语言与数据管理',
    tabLive: '实时数据', tabHistory: '历史数据', tabCurve: '曲线', tabFirmware: '固件',
    groupCount: '{n} 组',
    newGroup: '新建分组', editGroup: '编辑分组', groupName: '组名', slaveId: '从站 ID', functionCode: '功能码', startAddress: '起始地址', quantity: '数量', scanRate: '扫描间隔(ms)', edit: '编辑', save: '保存', fcReadCoils: '读线圈', fcReadDiscrete: '读离散输入', fcReadHolding: '读保持寄存器', fcReadInput: '读输入寄存器',
    histHint: '最近 1 小时数据', histStart: '开始时间', histEnd: '结束时间', histQuery: '查询', histLoading: '查询中…', histPrev: '上一页', histNext: '下一页', histTotal: '共 {n} 条', histPage: '第 {x}/{y} 页', noHistory: '暂无历史数据', colTime: '时间', histTruncated: '结果较多，仅显示最近 {n} 条', histIdle: '选择时间范围后点击「查询」', histEmpty: '该时间段暂无历史数据', histError: '查询失败', histRangeInvalid: '开始时间必须早于结束时间', histLast1h: '最近 1 小时', histLast6h: '最近 6 小时', histLast24h: '最近 24 小时', histToday: '今天', histQuick: '快捷', selectRegisters: '选择寄存器', selectAll: '全选', clearAll: '清空', histNoRegs: '未选择任何寄存器', curveHint: '最近 1 小时曲线', curveReset: '重置缩放', curveZoomHint: '框选放大：左上→右下拖拽；恢复：右下→左上拖拽', firmwareHint: '暂无固件，请先上传', fwUpload: '上传固件', fwAbort: '中止升级', fwState: '状态', fwUpgrade: '升级', fwUploaded: '固件已上传', fwUploadErr: '上传失败', fwStarted: '升级已发起', fwUpgradeErr: '升级发起失败', fwDelete: '删除', fwDeleted: '固件已删除', fwDeleteErr: '删除失败', confirmDeleteFirmware: '确定删除固件 {name} 吗？',
    appearance: '外观', themeLabel: '主题', light: '浅色', dark: '深色', system: '跟随系统',
    language: '语言',
    appInfo: '应用信息', version: '版本', arch: '架构', persistence: '持久化',
    dataMgmt: '数据管理', runLogs: '运行日志', clearLogs: '清空日志', logsCleared: '日志已清空', retentionLabel: '历史保留', retentionSaved: '保留时长已保存', retentionForever: '永久',
    newDeviceTitle: '新建设备', editDeviceTitle: '编辑设备', name: '名称', ip: 'IP 地址', port: '端口', transport: '连接方式', transportTcp: 'TCP 网口', transportRtu: 'RTU 串口', serialPath: '串口路径', baudRate: '波特率', parity: '校验位', stopBits: '停止位', dataBits: '数据位', flowControl: '流控', slaveIdLabel: '从站地址', pollIntervalLabel: '采样周期(ms)', cancel: '取消', add: '添加',
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
    realtimeConnected: 'Live channel connected', realtimeConnecting: 'Live channel connecting', realtimeStale: 'Live data delayed', realtimeReconnecting: 'Live channel reconnecting (attempt {n})', realtimeDisconnected: 'Live channel disconnected',
    groupDisconnected: 'Disconnected',
    connect: 'Connect',
    disconnect: 'Disconnect',
    pause: 'Pause',
    resume: 'Resume', enable: 'Enable',
    export: 'Export', exportTitle: 'Export data', exportCsv: 'Export CSV',
    exportXlsx: 'Export XLSX',
    deleteDevice: 'Delete', deleteGroup: 'Delete group', confirmDeleteDevice: 'Delete device "{name}"? All its groups and registers will be removed.', confirmDeleteGroup: 'Delete group "{name}"? All its registers will be removed.',
    regCount: '{n} registers',
    colAlias: 'Alias', colAddr: 'Addr', colType: 'Type', colValue: 'Value', colQuality: 'Quality', colWrite: 'Write', writeReg: 'Write register', fc16: 'FC16 Write multiple', fc06: 'FC06 Write single', valueHint: 'Double-click a value to write', valueCovered: 'Covered by previous register', valueShort: 'Not enough polled data', grp16BE: '16-bit BE', grp16LE: '16-bit LE', grp32BE: '32-bit BE', grp32LE: '32-bit LE', grp64BE: '64-bit BE', grp64LE: '64-bit LE',
    write: 'Write', valuePh: 'value', writeErrEmpty: 'Enter a value', writeErrNaN: 'Enter a valid number', writeOk: 'Written',
    noRegisters: 'No registers (import MBS/MBP via API)',
    settingsTitle: 'Settings', settingsSub: 'Appearance, language & data',
    tabLive: 'Live', tabHistory: 'History', tabCurve: 'Curve', tabFirmware: 'Firmware',
    groupCount: '{n} groups',
    newGroup: 'New Group', editGroup: 'Edit Group', groupName: 'Name', slaveId: 'Slave ID', functionCode: 'Function', startAddress: 'Start addr', quantity: 'Quantity', scanRate: 'Scan rate(ms)', edit: 'Edit', save: 'Save', fcReadCoils: 'Read Coils', fcReadDiscrete: 'Read Discrete Inputs', fcReadHolding: 'Read Holding', fcReadInput: 'Read Input',
    histHint: 'Last 1 hour', histStart: 'Start', histEnd: 'End', histQuery: 'Query', histLoading: 'Loading…', histPrev: 'Prev', histNext: 'Next', histTotal: '{n} rows', histPage: 'Page {x}/{y}', noHistory: 'No history data', colTime: 'Time', histTruncated: 'Too many rows, showing latest {n}', histIdle: 'Select a time range and click Query', histEmpty: 'No history data in this range', histError: 'Query failed', histRangeInvalid: 'Start time must be before end time', histLast1h: 'Last 1h', histLast6h: 'Last 6h', histLast24h: 'Last 24h', histToday: 'Today', histQuick: 'Quick', selectRegisters: 'Select registers', selectAll: 'Select all', clearAll: 'Clear', histNoRegs: 'No registers selected', curveHint: 'Last 1 hour', curveReset: 'Reset zoom', curveZoomHint: 'Drag top-left→bottom-right to zoom in; drag back to reset', firmwareHint: 'No firmware uploaded yet', fwUpload: 'Upload firmware', fwAbort: 'Abort', fwState: 'State', fwUpgrade: 'Upgrade', fwUploaded: 'Firmware uploaded', fwUploadErr: 'Upload failed', fwStarted: 'Upgrade started', fwUpgradeErr: 'Upgrade failed', fwDelete: 'Delete', fwDeleted: 'Firmware deleted', fwDeleteErr: 'Delete failed', confirmDeleteFirmware: 'Delete firmware {name}?',
    appearance: 'Appearance', themeLabel: 'Theme', light: 'Light', dark: 'Dark', system: 'System',
    language: 'Language',
    appInfo: 'App info', version: 'Version', arch: 'Architecture', persistence: 'Persistence',
    dataMgmt: 'Data management', runLogs: 'Runtime logs', clearLogs: 'Clear logs', logsCleared: 'Logs cleared', retentionLabel: 'Data retention', retentionSaved: 'Retention saved', retentionForever: 'Forever',
    newDeviceTitle: 'New device', editDeviceTitle: 'Edit device', name: 'Name', ip: 'IP address', port: 'Port', transport: 'Transport', transportTcp: 'TCP', transportRtu: 'RTU serial', serialPath: 'Serial path', baudRate: 'Baud rate', parity: 'Parity', stopBits: 'Stop bits', dataBits: 'Data bits', flowControl: 'Flow control', slaveIdLabel: 'Slave ID', pollIntervalLabel: 'Poll interval (ms)', cancel: 'Cancel', add: 'Add',
  },
}

async function request(url: string, options?: RequestInit): Promise<any> {
  const r = await fetch(url, options)
  if (!r.ok) {
    let detail = ''
    try { detail = await r.text() } catch { /* ignore */ }
    throw new Error('HTTP ' + r.status + (detail ? ' ' + detail.slice(0, 200) : ''))
  }
  return r.json()
}

const api = {
  get: (url: string) => request(url),
  post: (url: string, body?: unknown) => request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }),
  put: (url: string, body: unknown) => request(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  del: (url: string) => request(url, { method: 'DELETE' }),
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

function WorkspaceRow({ w, isCurrent, isExpanded, deviceCount, onToggle, onSwitch, onAdd, t }: {
  w: { path: string; title: string; createdAt: string }
  isCurrent: boolean
  isExpanded: boolean
  deviceCount: number
  onToggle: () => void
  onSwitch: () => void
  onAdd: () => void
  t: T
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const show = () => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({ x: r.right + 10, y: r.top + r.height / 2 })
  }
  return (
    <>
      <div
        ref={ref}
        className={'ws-row' + (isCurrent ? ' current' : '')}
        onClick={isCurrent ? onToggle : onSwitch}
        onMouseEnter={show}
        onMouseLeave={() => setPos(null)}
      >
        <FolderIcon open={isExpanded} />
        <span className="ws-chevron">{isExpanded ? '▾' : '▸'}</span>
        <span className="ws-title">{w.title}</span>
        {isCurrent && <span className="ws-count">{deviceCount}</span>}
        {isCurrent && <button className="ws-row-add" onClick={(e) => { e.stopPropagation(); onAdd() }} title={t('newDevice')} aria-label={t('newDevice')}>＋</button>}
      </div>
      {pos && (
        <div className="ws-hover-card" style={{ left: pos.x, top: pos.y }}>
          <div className="ws-hover-title">{w.title}</div>
          <div className="ws-hover-path">{w.path}</div>
          {w.createdAt && <div className="ws-hover-time">{t('createdAt')} {formatDateTime(w.createdAt)}</div>}
        </div>
      )}
    </>
  )
}

interface RegView { value: string; covered: boolean; invalid: boolean; writable: boolean }

function areaForFunctionCode(fc: number): string {
  if (fc === 1 || fc === 5 || fc === 15) return 'coil'
  if (fc === 2) return 'discrete-input'
  if (fc === 4) return 'input-register'
  return 'holding-register'
}

/** 按地址顺序合并多字：首字显示合并值、被覆盖字显示 —、数据不足显示 —（不可写）。 */
function buildRegViews(groups: DeviceGroup[], latest: Record<string, LatestValue>, objectId: number): Map<number, RegView> {
  const views = new Map<number, RegView>()
  for (const g of groups) {
    const rawByAddr: Record<number, number> = {}
    const area = areaForFunctionCode(g.functionCode)
    const prefix = `${objectId}:${area}:`
    for (const k of Object.keys(latest)) {
      if (k.startsWith(prefix)) rawByAddr[Number(k.slice(prefix.length))] = latest[k].rawValue
    }
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
      const value = formatRegisterValue(r.dataType, words)
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
  const [latest, setLatest] = useState<Record<string, LatestValue>>({})
  const [groupErrors, setGroupErrors] = useState<Record<number, string>>({})
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null)
  const [showWorkspace, setShowWorkspace] = useState(false)
  const [showAdd, setShowAdd] = useState(false)
  const [wsExpanded, setWsExpanded] = useState(true)
  const [realtime, setRealtime] = useState<{ status: RealtimeStatus; attempt: number }>({ status: 'connecting', attempt: 0 })

  const t: T = useCallback((key: string) => I18N[lang][key] ?? key, [lang])
  const selectedIdRef = useRef<number | null>(selectedId)
  useEffect(() => { selectedIdRef.current = selectedId }, [selectedId])

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

  const refreshDevices = useCallback(() => { api.get('/api/monitor_objects').then(setDevices).catch(() => {}) }, [])
  const refreshWorkspace = useCallback(() => { api.get('/api/workspace').then(setWorkspace).catch(() => {}) }, [])
  const refreshRegisters = useCallback((id: number) => {
    api.get('/api/monitor_objects/' + id + '/groups').then(async (gs: Array<{ id: number; name: string; slaveId: number; functionCode: number; startAddress: number; quantity: number; pollIntervalMs: number; isActive: number }>) => {
      const out: DeviceGroup[] = []
      for (const g of gs) {
        const regs: Register[] = await api.get('/api/groups/' + g.id + '/registers')
        out.push({ id: g.id, name: g.name, slaveId: g.slaveId, functionCode: g.functionCode, startAddress: g.startAddress, quantity: g.quantity, pollIntervalMs: g.pollIntervalMs, isActive: g.isActive, registers: regs })
      }
      setGroups(out)
    }).catch(() => {})
  }, [])

  useEffect(() => { refreshDevices(); refreshWorkspace() }, [refreshDevices, refreshWorkspace])
  useEffect(() => { if (selectedId != null) refreshRegisters(selectedId) }, [selectedId, refreshRegisters])
  useEffect(() => {
    const HEARTBEAT_MS = 10_000
    const STALE_MS = 30_000
    const FORCE_RECONNECT_MS = 45_000
    const FALLBACK_MS = 5_000
    let ws: WebSocket | null = null
    let stopped = false
    let attempt = 0
    let lastMessageAt = Date.now()
    let currentStatus: RealtimeStatus = 'connecting'
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined

    const updateStatus = (status: RealtimeStatus, nextAttempt = attempt) => {
      currentStatus = status
      setRealtime({ status, attempt: nextAttempt })
    }
    const mergeObjectSnapshot = (objectId: number, data: Record<string, LatestValue>) => {
      const prefix = objectId + ':'
      setLatest((prev) => {
        const next = { ...prev }
        for (const key of Object.keys(next)) if (key.startsWith(prefix)) delete next[key]
        for (const [address, value] of Object.entries(data)) next[prefix + address] = value
        return next
      })
    }
    const fetchFallback = async () => {
      if (currentStatus === 'connected') return
      const id = selectedIdRef.current
      if (id == null) return
      try { mergeObjectSnapshot(id, await api.get('/api/monitor_objects/' + id + '/latest')) } catch { /* 下轮继续尝试 */ }
    }
    const scheduleReconnect = () => {
      if (stopped || reconnectTimer) return
      attempt += 1
      updateStatus(attempt >= 10 ? 'disconnected' : 'reconnecting', attempt)
      const base = Math.min(15_000, 1_000 * 2 ** Math.min(attempt - 1, 4))
      const delay = Math.round(base * (0.8 + Math.random() * 0.4))
      reconnectTimer = setTimeout(() => { reconnectTimer = undefined; connect() }, delay)
    }
    const handleMessage = (event: MessageEvent) => {
      lastMessageAt = Date.now()
      if (currentStatus !== 'connected') updateStatus('connected', 0)
      let msg: any
      try { msg = JSON.parse(String(event.data)) } catch { return }
      if (!msg || typeof msg.type !== 'string' || msg.type === 'pong') return
      if (msg.type === 'latest' && msg.data && typeof msg.data === 'object') setLatest(msg.data)
      else if (msg.type === 'poller/result' && Array.isArray(msg.points)) {
        setLatest((prev) => { const next = { ...prev }; for (const p of msg.points) if (p.area) next[p.objectId + ':' + p.area + ':' + p.address] = { rawValue: p.rawValue, quality: p.quality, timestamp: p.timestamp }; return next })
      }
      else if (msg.type === 'group-error') setGroupErrors((prev) => ({ ...prev, [msg.groupId]: msg.error }))
      else if (msg.type === 'group-ok') setGroupErrors((prev) => { const next = { ...prev }; delete next[msg.groupId]; return next })
      else if (msg.type === 'workspace/changed') { setSelectedId(null); setLatest({}); setGroupErrors({}); refreshDevices(); refreshWorkspace() }
      else if (msg.type === 'config/changed') { refreshDevices(); if (selectedIdRef.current != null) refreshRegisters(selectedIdRef.current) }
    }
    const connect = () => {
      if (stopped) return
      const protocol = location.protocol === 'https:' ? 'wss://' : 'ws://'
      updateStatus(attempt === 0 ? 'connecting' : 'reconnecting', attempt)
      const socket = new WebSocket(protocol + location.host + '/ws')
      ws = socket
      socket.onopen = () => {
        if (ws !== socket) return
        attempt = 0
        lastMessageAt = Date.now()
        updateStatus('connected', 0)
      }
      socket.onmessage = (event) => { if (ws === socket) handleMessage(event) }
      socket.onerror = () => { if (ws === socket) socket.close() }
      socket.onclose = () => { if (ws === socket) { ws = null; scheduleReconnect() } }
    }
    const reconnectNow = () => {
      if (stopped) return
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = undefined }
      attempt = 0
      if (ws) { const old = ws; ws = null; old.close() }
      connect()
    }

    const heartbeat = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }))
    }, HEARTBEAT_MS)
    const watchdog = setInterval(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return
      const idle = Date.now() - lastMessageAt
      if (idle >= FORCE_RECONNECT_MS) ws.close()
      else if (idle >= STALE_MS && currentStatus === 'connected') updateStatus('stale', attempt)
    }, 5_000)
    const fallback = setInterval(() => { void fetchFallback() }, FALLBACK_MS)
    const onOnline = () => reconnectNow()
    const onVisible = () => { if (document.visibilityState === 'visible' && currentStatus !== 'connected') reconnectNow() }
    window.addEventListener('online', onOnline)
    document.addEventListener('visibilitychange', onVisible)
    connect()

    return () => {
      stopped = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      clearInterval(heartbeat); clearInterval(watchdog); clearInterval(fallback)
      window.removeEventListener('online', onOnline)
      document.removeEventListener('visibilitychange', onVisible)
      if (ws) { const old = ws; ws = null; old.close() }
    }
  }, [refreshDevices, refreshRegisters, refreshWorkspace])

  const addDevice = useCallback(async (f: DeviceFields) => {
    if (!f.name || (f.transport !== 'rtu' && !f.ip)) return
    await api.post('/api/monitor_objects', f)
    setShowAdd(false); refreshDevices()
  }, [refreshDevices])
  const toggleDevice = useCallback(async (id: number) => { await api.post('/api/monitor_objects/' + id + '/toggle'); refreshDevices() }, [refreshDevices])
  const editDevice = useCallback(async (id: number, f: DeviceFields) => {
    if (!f.name) return
    await api.put('/api/monitor_objects/' + id, f)
    refreshDevices()
  }, [refreshDevices])
  const deleteDevice = useCallback(async (id: number) => {
    const device = devices.find((d) => d.id === id)
    if (!window.confirm(t('confirmDeleteDevice').replace('{name}', device?.name ?? String(id)))) return
    try {
      await api.del('/api/monitor_objects/' + id)
      if (selectedId === id) setSelectedId(null)
      refreshDevices()
    } catch { /* 忽略，避免未处理 rejection */ }
  }, [selectedId, refreshDevices, devices, t])

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
                    <WorkspaceRow
                      w={w}
                      isCurrent={isCurrent}
                      isExpanded={isExpanded}
                      deviceCount={devices.length}
                      onToggle={() => setWsExpanded(!wsExpanded)}
                      onSwitch={() => switchWorkspace(w.path)}
                      onAdd={() => setShowAdd(true)}
                      t={t}
                    />
                    {isExpanded && (
                      <div className="ws-children">
                        <div className="device-list">
                          <button className="btn new-device-btn" onClick={() => setShowAdd(true)}>{t('newDevice')}</button>
                          {devices.map((d) => (
                            <div key={d.id} className={'device-item' + (selectedId === d.id ? ' active' : '')} onClick={() => setSelectedId(d.id)}>
                              <span className={'device-dot' + (d.isActive ? ' on' : '')} />
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div className="device-name">{d.name}</div>
                                <div className="device-sub">{d.transport === 'rtu' ? (d.serialPath || 'RTU') : (d.ip + ':' + d.port)}</div>
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
          ? <DeviceView key={selected.id} t={t} device={selected} groups={groups} latest={latest} groupErrors={groupErrors} realtime={realtime} onToggle={toggleDevice} onEdit={editDevice} onDelete={deleteDevice} onRefresh={refreshRegisters} />
          : <EmptyState t={t} onAdd={() => setShowAdd(true)} />}
      </main>

      {showAdd && <DeviceModal t={t} initial={null} onClose={() => setShowAdd(false)} onSave={addDevice} />}
      {showWorkspace && <WorkspaceModal t={t} workspace={workspace} onClose={() => setShowWorkspace(false)} onSwitch={switchWorkspace} />}
      {showSettings && <SettingsModal t={t} theme={theme} setTheme={setTheme} lang={lang} setLang={setLang} onClose={() => setShowSettings(false)} />}
    </div>
  )
}

function EmptyState({ t, onAdd }: { t: T; onAdd: () => void }) {
  return <div className="empty-state"><div className="big">🛰️</div><div>{t('emptyHint')}</div><button className="btn primary" onClick={onAdd}>{t('newDevice')}</button></div>
}

function DeviceView({ t, device, groups, latest, groupErrors, realtime, onToggle, onEdit, onDelete, onRefresh }: {
  t: T; device: Device; groups: DeviceGroup[]; latest: Record<string, LatestValue>; groupErrors: Record<number, string>
  realtime: { status: RealtimeStatus; attempt: number }
  onToggle: (id: number) => void; onEdit: (id: number, fields: DeviceFields) => void; onDelete: (id: number) => void; onRefresh: (id: number) => void
}) {
  const [tab, setTab] = useState(0)
  const [showEdit, setShowEdit] = useState(false)
  const registers = groups.flatMap((g) => g.registers)
  const realtimeText = realtime.status === 'connected' ? t('realtimeConnected')
    : realtime.status === 'connecting' ? t('realtimeConnecting')
      : realtime.status === 'stale' ? t('realtimeStale')
        : realtime.status === 'reconnecting' ? t('realtimeReconnecting').replace('{n}', String(realtime.attempt))
          : t('realtimeDisconnected')
  return (
    <div>
      <div className="device-head">
        <span className="name">{device.name}</span>
        <span className={'status-badge' + (device.isActive ? ' on' : '')}>{device.isActive ? t('connected') : t('disconnected')}</span>
        <span className={'status-badge realtime ' + realtime.status}>{realtimeText}</span>
        <div style={{ flex: 1 }} />
        <button className="btn" onClick={() => onToggle(device.id)}>{device.isActive ? t('disconnect') : t('connect')}</button>
        <button className="btn" onClick={() => setShowEdit(true)}>{t('edit')}</button>
        <button className="btn danger" onClick={() => onDelete(device.id)}>{t('deleteDevice')}</button>
      </div>
      <div className="main-sub">{device.transport === 'rtu' ? (device.serialPath || 'RTU') : (device.ip + ':' + device.port)} · {t('groupCount').replace('{n}', String(groups.length))} · {t('regCount').replace('{n}', String(registers.length))}</div>
      <TabBar tabs={[t('tabLive'), t('tabHistory'), t('tabCurve'), t('tabFirmware')]} active={tab} onChange={setTab} />
      {tab === 0 && <LiveTable t={t} device={device} groups={groups} latest={latest} groupErrors={groupErrors} onRefresh={() => onRefresh(device.id)} />}
      {tab === 1 && <HistoryTable t={t} device={device} groups={groups} registers={registers} />}
      {tab === 2 && <CurveChart t={t} device={device} groups={groups} registers={registers} />}
      {tab === 3 && <FirmwareView t={t} device={device} />}
      {showEdit && <DeviceModal t={t} initial={device} onClose={() => setShowEdit(false)} onSave={(f) => { onEdit(device.id, f); setShowEdit(false) }} />}
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
  t: T; device: Device; groups: DeviceGroup[]; latest: Record<string, LatestValue>; groupErrors: Record<number, string>; onRefresh: () => void
}) {
  const [modal, setModal] = useState<null | { mode: 'add' } | { mode: 'edit'; group: DeviceGroup }>(null)
  const [writeReg, setWriteReg] = useState<Register | null>(null)
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())
  const toggleCollapse = (id: number) => setCollapsed((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })
  const deleteGroup = async (id: number) => {
    const g = groups.find((gg) => gg.id === id)
    if (!window.confirm(t('confirmDeleteGroup').replace('{name}', g?.name ?? String(id)))) return
    try { await api.del('/api/groups/' + id); onRefresh() } catch { /* 忽略 */ }
  }
  const views = buildRegViews(groups, latest, device.id)
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
            {groupErrors[g.id] && <span className="group-error" title={groupErrors[g.id]}>⚠ {groupErrors[g.id] === 'Disconnected' ? t('groupDisconnected') : groupErrors[g.id]}</span>}
            <div style={{ flex: 1 }} />
            <button className="btn" onClick={() => setModal({ mode: 'edit', group: g })}>{t('edit')}</button>
            <button className="btn danger" onClick={() => deleteGroup(g.id)}>{t('deleteGroup')}</button>
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
                    <td><TypeCell t={t} reg={r} available={g.startAddress + g.quantity - r.startAddress} disabled={rv?.covered} onRefresh={onRefresh} /></td>
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
          <option value="1">FC01 · {t('fcReadCoils')}</option>
          <option value="2">FC02 · {t('fcReadDiscrete')}</option>
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
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState(false)
  const width = registerWidth(reg.dataType)
  const base = baseType(reg.dataType)
  const is64 = base === 'int64' || base === 'uint64'
  const write = async () => {
    if (value.trim() === '') { setErr(t('writeErrEmpty')); return }
    const num = is64 ? value : Number(value)
    if (!is64 && (Number.isNaN(num) || !Number.isFinite(num))) { setErr(t('writeErrNaN')); return }
    setBusy(true); setErr(null)
    try {
      await api.post('/api/registers/' + reg.id + '/write', { value: num, method: width > 1 ? 'multiple' : method })
      setOk(true)
      setTimeout(() => onSaved(), 600)
    } catch (e) {
      setErr((e as any)?.message ?? String(e))
    } finally { setBusy(false) }
  }
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{t('writeReg')}</h3>
        <div className="kv" style={{ marginBottom: 10 }}>{reg.alias ?? reg.id} · {t('colAddr')} {reg.startAddress} · {reg.dataType}{width > 1 ? '（' + width + ' 寄存器）' : ''}</div>
        <label>{t('valuePh')}</label>
        <input value={value} onChange={(e) => { setValue(e.target.value); setErr(null); setOk(false) }} autoFocus placeholder={t('valuePh')} />
        <label>{t('functionCode')}</label>
        <select value={method} onChange={(e) => setMethod(e.target.value as 'single' | 'multiple')} disabled={width > 1}>
          <option value="multiple">{t('fc16')}</option>
          {width === 1 && <option value="single">{t('fc06')}</option>}
        </select>
        {err && <div className="write-msg error">{err}</div>}
        {ok && <div className="write-msg ok">{t('writeOk')}</div>}
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>{t('cancel')}</button>
          <button className="btn primary" onClick={write} disabled={busy || ok}>{ok ? t('writeOk') : t('write')}</button>
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

function TypeCell({ t, reg, available, disabled, onRefresh }: { t: T; reg: Register; available: number; disabled?: boolean; onRefresh: () => void }) {
  const [err, setErr] = useState(false)
  const change = async (v: string) => {
    if (v === reg.dataType) return
    if (registerWidth(v) > available) { setErr(true); setTimeout(() => setErr(false), 1600); return }
    await api.put('/api/registers/' + reg.id, { dataType: v })
    onRefresh()
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <select className="cell-select" value={reg.dataType} onChange={(e) => change(e.target.value)} disabled={disabled}>
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

function useRegisterSelection(deviceId: number, registers: Register[]): [Set<number>, (s: Set<number>) => void] {
  const key = 'ps-regs-' + deviceId
  const [selected, setSelected] = useState<Set<number>>(() => {
    try {
      const raw = localStorage.getItem(key)
      if (raw == null) return new Set(registers.map(r => r.id))
      const ids = JSON.parse(raw) as number[]
      const valid = new Set(registers.map(r => r.id))
      return new Set(ids.filter(id => valid.has(id)))
    } catch { return new Set(registers.map(r => r.id)) }
  })
  const update = useCallback((s: Set<number>) => {
    setSelected(s)
    localStorage.setItem(key, JSON.stringify([...s]))
  }, [key])
  return [selected, update]
}

function RegisterSelectModal({ t, groups, initial, onClose, onApply }: {
  t: T; groups: DeviceGroup[]; initial: Set<number>; onClose: () => void; onApply: (s: Set<number>) => void
}) {
  const [draft, setDraft] = useState<Set<number>>(() => new Set(initial))
  const toggle = (id: number) => setDraft((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })
  const allIds = groups.flatMap(g => g.registers).map(r => r.id)
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal reg-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>{t('selectRegisters')}</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="reg-modal-actions">
          <button className="btn" onClick={() => setDraft(new Set(allIds))}>{t('selectAll')}</button>
          <button className="btn" onClick={() => setDraft(new Set())}>{t('clearAll')}</button>
        </div>
        <div className="reg-list">
          {groups.map(g => (
            <div key={g.id} className="reg-group">
              <div className="reg-group-name">{g.name}</div>
              {g.registers.map(r => (
                <label key={r.id} className="reg-item">
                  <input type="checkbox" checked={draft.has(r.id)} onChange={() => toggle(r.id)} />
                  <span className="reg-item-alias">{r.alias ?? ('reg' + r.id)}</span>
                  <span className="kv">{r.startAddress} · {r.dataType}</span>
                </label>
              ))}
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>{t('cancel')}</button>
          <button className="btn primary" onClick={() => onApply(draft)}>{t('save')}</button>
        </div>
      </div>
    </div>
  )
}

function RegisterSelectButton({ t, groups, selected, onApply }: {
  t: T; groups: DeviceGroup[]; selected: Set<number>; onApply: (s: Set<number>) => void
}) {
  const [show, setShow] = useState(false)
  const total = groups.reduce((n, g) => n + g.registers.length, 0)
  return (
    <>
      <button className="btn" onClick={() => setShow(true)}>{t('selectRegisters')} ({selected.size}/{total})</button>
      {show && <RegisterSelectModal t={t} groups={groups} initial={selected} onClose={() => setShow(false)} onApply={(s) => { onApply(s); setShow(false) }} />}
    </>
  )
}

function HistoryTable({ t, device, groups, registers }: { t: T; device: Device; groups: DeviceGroup[]; registers: Register[] }) {
  const toInput = (d: Date) => {
    const p = (n: number) => String(n).padStart(2, '0')
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes())
  }
  const [start, setStart] = useState(() => toInput(new Date(Date.now() - 3600_000)))
  const [end, setEnd] = useState(() => toInput(new Date()))
  const [rows, setRows] = useState<Array<{ ts: string; values: Record<number, string> }>>([])
  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [showExport, setShowExport] = useState(false)
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useRegisterSelection(device.id, registers)
  const selectedRegisters = registers.filter(r => selected.has(r.id))

  // 设备切换时重置为默认「最近 1 小时」，但不自动查询（用户点「查询」才拉数据）
  useEffect(() => {
    setStart(toInput(new Date(Date.now() - 3600_000)))
    setEnd(toInput(new Date()))
    setRows([])
    setPage(1)
    setStatus('idle')
    setError(null)
  }, [device.id])

  const rangeInvalid = Boolean(start && end) && new Date(start) >= new Date(end)
  const canQuery = Boolean(start && end) && !rangeInvalid

  const applyPreset = (kind: '1h' | '6h' | '24h' | 'today') => {
    const now = new Date()
    let s: Date
    if (kind === 'today') s = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0)
    else { const h = kind === '1h' ? 1 : kind === '6h' ? 6 : 24; s = new Date(now.getTime() - h * 3600_000) }
    setStart(toInput(s))
    setEnd(toInput(now))
  }

  const query = useCallback(async () => {
    if (!canQuery) return
    setStatus('loading')
    try {
      const startIso = new Date(start).toISOString()
      const endIso = new Date(end).toISOString()
      const pts: Array<{ ts: string; area: string; address: number; rawValue: number }> = await api.get('/api/data/object?object_id=' + device.id + '&start=' + startIso + '&end=' + endIso)
      const rawByTs = new Map<string, Map<string, Record<number, number>>>()
      for (const p of pts) {
        if (!rawByTs.has(p.ts)) rawByTs.set(p.ts, new Map())
        const area = p.area
        const byArea = rawByTs.get(p.ts)!
        if (!byArea.has(area)) byArea.set(area, {})
        byArea.get(area)![p.address] = p.rawValue
      }
      const nextRows: Array<{ ts: string; values: Record<number, string> }> = []
      for (const [ts, byArea] of rawByTs) {
        const formatted = new Map<number, string>()
        for (const area of ['coil', 'discrete-input', 'holding-register', 'input-register']) {
          const subset = registers.filter(r => areaForFunctionCode(r.functionCode) === area)
          for (const [id, value] of formatRawByAddr(subset, byArea.get(area) ?? {})) formatted.set(id, value)
        }
        const values: Record<number, string> = {}
        for (const r of selectedRegisters) values[r.id] = formatted.get(r.id) ?? '—'
        nextRows.push({ ts, values })
      }
      setRows(nextRows)
      setPage(1)
      setStatus('done')
    } catch (e) {
      setError((e as any)?.message ?? String(e))
      setStatus('error')
    }
  }, [device.id, start, end, canQuery, selected])

  const doExport = (fmt: 'csv' | 'xlsx') => {
    if (!canQuery) return
    const ids = selectedRegisters.map(r => r.id).join(',')
    window.open('/api/export/' + fmt + '?object_id=' + device.id + '&start=' + new Date(start).toISOString() + '&end=' + new Date(end).toISOString() + (ids ? '&register_ids=' + ids : ''))
  }
  const PAGE_SIZE = 200
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
  const currentPage = Math.min(Math.max(1, page), totalPages)
  const shown = rows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)

  return (
    <div>
      <div className="toolbar">
        <label className="hist-label">{t('histStart')}</label>
        <input className="hist-input" type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
        <label className="hist-label">{t('histEnd')}</label>
        <input className="hist-input" type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
        <button className="btn primary" onClick={() => query()} disabled={status === 'loading' || !canQuery}>{status === 'loading' ? t('histLoading') : t('histQuery')}</button>
        <RegisterSelectButton t={t} groups={groups} selected={selected} onApply={setSelected} />
        <div style={{ flex: 1 }} />
        <button className="btn" onClick={() => setShowExport(true)} disabled={!canQuery}>{t('export')}</button>
      </div>
      <div className="hist-quick">
        <span className="hist-label">{t('histQuick')}</span>
        <div className="seg">
          <button onClick={() => applyPreset('1h')}>{t('histLast1h')}</button>
          <button onClick={() => applyPreset('6h')}>{t('histLast6h')}</button>
          <button onClick={() => applyPreset('24h')}>{t('histLast24h')}</button>
          <button onClick={() => applyPreset('today')}>{t('histToday')}</button>
        </div>
      </div>
      {showExport && <ExportModal t={t} onClose={() => setShowExport(false)} onPick={(fmt) => { doExport(fmt); setShowExport(false) }} />}
      {rangeInvalid && <div className="hist-empty warn">{t('histRangeInvalid')}</div>}
      {!rangeInvalid && status === 'idle' && <div className="hist-empty">{t('histIdle')}</div>}
      {!rangeInvalid && status === 'done' && rows.length === 0 && <div className="hist-empty">{t('histEmpty')}</div>}
      {!rangeInvalid && status === 'error' && <div className="hist-empty warn">{t('histError')} {error}</div>}
      {!rangeInvalid && status === 'done' && rows.length > 0 && (
        <>
          {selectedRegisters.length === 0 ? (
            <div className="hist-empty">{t('histNoRegs')}</div>
          ) : (
            <>
              <table className="reg hist-table">
                <thead><tr><th>{t('colTime')}</th>{selectedRegisters.map(r => <th key={r.id}>{r.alias ?? r.id}</th>)}</tr></thead>
                <tbody>
                  {shown.map((row, i) => (
                    <tr key={i}><td className="kv">{row.ts}</td>{selectedRegisters.map(r => <td key={r.id} className="value">{row.values[r.id] ?? '—'}</td>)}</tr>
                  ))}
                </tbody>
              </table>
              <div className="pager">
                <span className="kv">{t('histTotal').replace('{n}', String(rows.length))}</span>
                <button className="btn" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={currentPage <= 1}>{t('histPrev')}</button>
                <span className="kv">{t('histPage').replace('{x}', String(currentPage)).replace('{y}', String(totalPages))}</span>
                <button className="btn" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={currentPage >= totalPages}>{t('histNext')}</button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}

function ExportModal({ t, onClose, onPick }: { t: T; onClose: () => void; onPick: (fmt: 'csv' | 'xlsx') => void }) {
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{t('exportTitle')}</h3>
        <div className="export-options">
          <button className="btn primary" onClick={() => onPick('csv')}>{t('exportCsv')}</button>
          <button className="btn primary" onClick={() => onPick('xlsx')}>{t('exportXlsx')}</button>
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>{t('cancel')}</button>
        </div>
      </div>
    </div>
  )
}

const CHART_COLORS = ['#4176e6', '#22c55e', '#f59e0b', '#ec1313', '#8b5cf6', '#06b6d4', '#f97316', '#ec4899', '#84cc16', '#14b8a6']
function niceStep(range: number, target: number): number {
  const rough = range / target
  const pow = 10 ** Math.floor(Math.log10(rough))
  const n = rough / pow
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10
  return nice * pow
}
function yTicks(min: number, max: number, count = 5): number[] {
  if (min === max) return [min]
  const step = niceStep(max - min, count)
  const start = Math.ceil(min / step) * step
  const n = Math.floor((max - start) / step) + 1
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push(Number((start + i * step).toFixed(10)))
  return out
}
function tickNum(v: number): string {
  const r = Math.abs(v) < 1e-9 ? 0 : v
  if (Number.isInteger(r)) return String(r)
  const a = Math.abs(r)
  if (a !== 0 && (a >= 100000 || a < 0.001)) return r.toExponential(1)
  return String(Number(r.toFixed(2)))
}
function timeTicks(min: number, max: number, count = 6): number[] {
  if (min === max) return [min]
  const range = max - min
  const steps = [1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 180000, 240000, 300000, 600000, 900000, 1200000, 1800000, 3600000, 7200000, 10800000, 21600000, 43200000, 86400000, 172800000, 604800000]
  const step = steps.find(s => range / s <= count) ?? 86400000
  const start = Math.ceil(min / step) * step
  const n = Math.floor((max - start) / step) + 1
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push(start + i * step)
  return out
}
function tickTime(ts: number, span: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  if (span >= 86400000) return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
}


function CurveChart({ t, device, groups, registers }: { t: T; device: Device; groups: DeviceGroup[]; registers: Register[] }) {
  const [pts, setPts] = useState<Array<{ ts: string; area: string; address: number; rawValue: number }>>([])
  const [selected, setSelected] = useRegisterSelection(device.id, registers)
  const [view, setView] = useState<{ t0: number; t1: number; v0: number; v1: number } | null>(null)
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const [size, setSize] = useState({ w: 900, h: 320 })
  const svgRef = useRef<SVGSVGElement | null>(null)

  const hasData = pts.length > 0
  const showChart = hasData && selected.size > 0

  useEffect(() => {
    setView(null)
    const start = new Date(Date.now() - 3600_000).toISOString()
    const end = new Date().toISOString()
    api.get('/api/data/object?object_id=' + device.id + '&start=' + start + '&end=' + end).then(setPts).catch(() => {})
  }, [device.id])

  // SVG 挂载后测量实际像素尺寸，用它当 viewBox（1:1 → 文字不拉伸）
  useEffect(() => {
    if (!showChart) return
    const el = svgRef.current
    if (!el) return
    const measure = () => {
      const r = el.getBoundingClientRect()
      if (r.width > 10 && r.height > 10) setSize({ w: r.width, h: r.height })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [showChart])

  const W = size.w, H = size.h
  const L = 60, R = 14, T = 12, B = 28 // 四周留白：左=Y 轴标签，下=X 轴标签
  const rawByTs = new Map<number, Map<string, Record<number, number>>>()
  for (const p of pts) {
    const t = new Date(p.ts).getTime()
    if (!rawByTs.has(t)) rawByTs.set(t, new Map())
    const area = p.area
    const byArea = rawByTs.get(t)!
    if (!byArea.has(area)) byArea.set(area, {})
    byArea.get(area)![p.address] = p.rawValue
  }
  const byReg = new Map<number, Array<[number, number]>>()
  for (const [t, byArea] of rawByTs) {
    const decoded = new Map<number, number | bigint>()
    for (const area of ['coil', 'discrete-input', 'holding-register', 'input-register']) {
      const subset = registers.filter(r => areaForFunctionCode(r.functionCode) === area)
      for (const [id, value] of decodeRawByAddr(subset, byArea.get(area) ?? {})) decoded.set(id, value)
    }
    for (const r of registers) {
      if (!selected.has(r.id)) continue
      const v = decoded.get(r.id)
      if (v == null) continue
      const arr = byReg.get(r.id) ?? []
      arr.push([t, typeof v === 'bigint' ? Number(v) : v])
      byReg.set(r.id, arr)
    }
  }
  const series = [...byReg.entries()].map(([id, arr], i) => ({ id, color: CHART_COLORS[i % CHART_COLORS.length], arr: arr.sort((a, b) => a[0] - b[0]) }))
  const allT = series.flatMap(s => s.arr.map(p => p[0]))
  const allV = series.flatMap(s => s.arr.map(p => p[1]))
  const hasSeries = allT.length > 0
  const fullMinT = hasSeries ? Math.min(...allT) : 0, fullMaxT = hasSeries ? Math.max(...allT) : 1
  const fullMinV = hasSeries ? Math.min(...allV) : 0, fullMaxV = hasSeries ? Math.max(...allV) : 1
  const tMin = view?.t0 ?? fullMinT, tMax = view?.t1 ?? fullMaxT, vMin = view?.v0 ?? fullMinV, vMax = view?.v1 ?? fullMaxV
  const plotW = W - L - R, plotH = H - T - B
  const x = (ts: number) => L + (tMax === tMin ? 0 : (ts - tMin) / (tMax - tMin)) * plotW
  const y = (v: number) => H - B - (vMax === vMin ? 0 : (v - vMin) / (vMax - vMin)) * plotH
  const path = (arr: Array<[number, number]>) => arr.map(([ts, v], i) => (i === 0 ? 'M' : 'L') + x(ts).toFixed(1) + ' ' + y(v).toFixed(1)).join(' ')

  // 刻度密度自适应：图越高 Y 刻度越多，越宽 X 刻度越多
  const yTickCount = Math.max(4, Math.min(16, Math.round(plotH / 36)))
  const xTickCount = Math.max(4, Math.min(20, Math.round(plotW / 72)))
  const yTickVals = hasSeries ? yTicks(vMin, vMax, yTickCount) : []
  const xTickVals = hasSeries ? timeTicks(tMin, tMax, xTickCount) : []
  const span = tMax - tMin

  const toSvg = (clientX: number, clientY: number) => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    return { x: clientX - rect.left, y: clientY - rect.top }
  }

  return (
    <div className="chart-wrap">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <RegisterSelectButton t={t} groups={groups} selected={selected} onApply={setSelected} />
        <div style={{ flex: 1 }} />
        {view && <button className="btn" onClick={() => setView(null)}>{t('curveReset')}</button>}
      </div>
      {!hasData && <div className="chart-hint">{t('curveHint')} — 暂无数据</div>}
      {hasData && selected.size === 0 && <div className="chart-hint">{t('histNoRegs')}</div>}
      {hasData && selected.size > 0 && (
        <>
          <div className="chart-hint">{t('curveZoomHint')}</div>
          <svg
            ref={svgRef}
            viewBox={'0 0 ' + W + ' ' + H}
            preserveAspectRatio="none"
            style={{ width: '100%', height: 'max(200px, calc(100vh - 240px))', display: 'block', cursor: 'crosshair', userSelect: 'none', WebkitUserSelect: 'none' }}
            onMouseDown={(e) => { if (!hasSeries) return; const p = toSvg(e.clientX, e.clientY); setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y }) }}
            onMouseMove={(e) => { if (!drag) return; const p = toSvg(e.clientX, e.clientY); setDrag({ ...drag, x1: p.x, y1: p.y }) }}
            onMouseUp={() => {
              if (!drag) return
              const { x0, y0, x1, y1 } = drag
              setDrag(null)
              const left = Math.max(L, Math.min(x0, x1))
              const right = Math.min(W - R, Math.max(x0, x1))
              const top = Math.max(T, Math.min(y0, y1))
              const bottom = Math.min(H - B, Math.max(y0, y1))
              const dx = right - left, dy = bottom - top
              if (x1 < x0 && y1 < y0) { setView(null); return }
              if (x1 > x0 && y1 > y0 && dx > 10 && dy > 10) {
                const nt0 = tMin + (left - L) / plotW * (tMax - tMin)
                const nt1 = tMin + (right - L) / plotW * (tMax - tMin)
                const nv1 = vMin + (H - B - top) / plotH * (vMax - vMin)
                const nv0 = vMin + (H - B - bottom) / plotH * (vMax - vMin)
                setView({ t0: Math.min(nt0, nt1), t1: Math.max(nt0, nt1), v0: Math.min(nv0, nv1), v1: Math.max(nv0, nv1) })
              }
            }}
            onMouseLeave={() => setDrag(null)}
          >
            {/* Y 轴网格线 + 数值标签 */}
            {yTickVals.map((v) => (
              <g key={'y' + v}>
                <line x1={L} y1={y(v)} x2={W - R} y2={y(v)} stroke="var(--border-1)" strokeWidth="1" />
                <text x={L - 6} y={y(v) + 4} textAnchor="end" fontSize="10" fill="var(--text-3)" pointerEvents="none">{tickNum(v)}</text>
              </g>
            ))}
            {/* X 轴网格线 + 时间标签 */}
            {xTickVals.map((tv) => (
              <g key={'x' + tv}>
                <line x1={x(tv)} y1={T} x2={x(tv)} y2={H - B} stroke="var(--border-1)" strokeWidth="1" />
                <text x={x(tv)} y={H - B + 16} textAnchor="middle" fontSize="10" fill="var(--text-3)" pointerEvents="none">{tickTime(tv, span)}</text>
              </g>
            ))}
            {/* 坐标轴 */}
            <line x1={L} y1={T} x2={L} y2={H - B} stroke="var(--border-2)" strokeWidth="1" />
            <line x1={L} y1={H - B} x2={W - R} y2={H - B} stroke="var(--border-2)" strokeWidth="1" />
            {/* 数据线 */}
            {series.map(s => <path key={s.id} d={path(s.arr)} fill="none" stroke={s.color} strokeWidth="1.6" />)}
            {/* 框选 */}
            {drag && (
              <rect x={Math.min(drag.x0, drag.x1)} y={Math.min(drag.y0, drag.y1)} width={Math.abs(drag.x1 - drag.x0)} height={Math.abs(drag.y1 - drag.y0)} className="zoom-box" />
            )}
          </svg>
          <div className="legend">
            {series.map(s => { const r = registers.find(rr => rr.id === s.id); return <span key={s.id} className="legend-item"><span className="legend-swatch" style={{ background: s.color }} />{r?.alias ?? s.id}</span> })}
          </div>
        </>
      )}
    </div>
  )
}

function FirmwareView({ t, device }: { t: T; device: Device }) {
  const [firmwares, setFirmwares] = useState<any[]>([])
  const [status, setStatus] = useState<any>({ state: 'idle' })
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => { try { setFirmwares(await api.get('/api/firmwares')) } catch { /* ignore */ } }, [])
  useEffect(() => { void refresh() }, [refresh])

  useEffect(() => {
    let alive = true
    const poll = async () => { try { const s = await api.get('/api/ota/status?device_id=' + device.id); if (alive) setStatus(s) } catch { /* ignore */ } }
    void poll()
    const timer = setInterval(poll, 1000)
    return () => { alive = false; clearInterval(timer) }
  }, [device.id])

  const onFile = async (e: any) => {
    const file = e.target.files?.[0]
    if (!file) return
    setBusy(true); setMsg('')
    try {
      const buf = await file.arrayBuffer()
      const res = await fetch('/api/firmware/upload?name=' + encodeURIComponent(file.name), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buf })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      await refresh()
      setMsg(t('fwUploaded'))
    } catch (err: any) { setMsg(t('fwUploadErr') + ' ' + (err?.message ?? '')) }
    finally { setBusy(false); e.target.value = '' }
  }

  const upgrade = async (fid: number) => {
    setBusy(true); setMsg('')
    try { await api.post('/api/ota/upgrade', { device_id: device.id, firmware_id: fid }); setMsg(t('fwStarted')) }
    catch (err: any) { setMsg(t('fwUpgradeErr') + ' ' + (err?.message ?? '')) }
    finally { setBusy(false) }
  }

  const remove = async (fid: number, name: string) => {
    if (!window.confirm(t('confirmDeleteFirmware').replace('{name}', name))) return
    setBusy(true); setMsg('')
    try { await api.del('/api/firmwares/' + fid); await refresh(); setMsg(t('fwDeleted')) }
    catch (err: any) { setMsg(t('fwDeleteErr') + ' ' + (err?.message ?? '')) }
    finally { setBusy(false) }
  }

  const pct = status.percent ?? 0
  const state = status.state ?? 'idle'
  return (
    <div className="chart-wrap firmware-card">
      <div className="fw-toolbar">
        <label className="btn">{t('fwUpload')}<input type="file" style={{ display: 'none' }} onChange={onFile} disabled={busy} /></label>
        {(state === 'starting' || state === 'transferring' || state === 'verifying') && <button className="btn danger" onClick={() => { void api.post('/api/ota/abort', { device_id: device.id }) }}>{t('fwAbort')}</button>}
      </div>
      {state !== 'idle' && (
        <div className="fw-progress">
          <div className="fw-state">{t('fwState')}: {state} · {pct}% · {status.currentBlock ?? 0}/{status.totalBlocks ?? 0}</div>
          <div className="fw-bar"><div style={{ width: pct + '%' }} /></div>
          {status.error && <div className="fw-err">{status.error}</div>}
        </div>
      )}
      {msg && <div className="write-msg">{msg}</div>}
      <div className="fw-list">
        {firmwares.length === 0 && <div className="chart-hint">{t('firmwareHint')}</div>}
        {firmwares.map((f) => (
          <div key={f.id} className="fw-item">
            <div className="fw-name">{f.name} <span className="kv">{f.version || '—'}</span></div>
            <div className="kv">{f.size} B · crc32=0x{(f.crc32 >>> 0).toString(16)}</div>
            <button className="btn" disabled={busy} onClick={() => { void upgrade(f.id) }}>{t('fwUpgrade')}</button>
            <button className="btn danger" disabled={busy} onClick={() => { void remove(f.id, f.name) }}>{t('fwDelete')}</button>
          </div>
        ))}
      </div>
    </div>
  )
}

function SettingsModal({ t, theme, setTheme, lang, setLang, onClose }: {
  t: T; theme: Theme; setTheme: (v: Theme) => void; lang: Lang; setLang: (v: Lang) => void; onClose: () => void
}) {
  const [msg, setMsg] = useState('')
  const [retention, setRetention] = useState<number>(2592000)
  const [customRetention, setCustomRetention] = useState('')
  useEffect(() => { api.get('/api/retention').then((r: any) => setRetention(r.retention_seconds)).catch(() => {}) }, [])
  const clearLogs = async () => { await api.post('/api/logs/clear'); setMsg(t('logsCleared')) }
  const retentionPresets: Array<[string, number]> = [
    ['1h', 3600], ['6h', 21600], ['24h', 86400], ['7d', 604800], ['30d', 2592000], ['90d', 7776000], [t('retentionForever'), 0],
  ]
  const applyRetention = async (seconds: number) => {
    setRetention(seconds)
    try { await api.post('/api/retention', { retention_seconds: seconds }); setMsg(t('retentionSaved')) } catch { /* ignore */ }
  }
  const saveCustomRetention = async () => {
    const s = Number(customRetention)
    if (!Number.isInteger(s) || s < 0) return
    await applyRetention(s)
  }
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
          <span>{t('retentionLabel')}</span>
          <select value={retentionPresets.some(([, s]) => s === retention) ? String(retention) : 'custom'} onChange={(e) => {
            if (e.target.value === 'custom') { setCustomRetention(String(retention)); return }
            void applyRetention(Number(e.target.value))
          }}>
            {retentionPresets.map(([label, s]) => <option key={s} value={String(s)}>{label}</option>)}
            <option value="custom">自定义 / Custom</option>
          </select>
        </div>
        {!retentionPresets.some(([, s]) => s === retention) && (
          <div className="setting-row">
            <span>秒</span>
            <input value={customRetention} onChange={(e) => setCustomRetention(e.target.value)} placeholder="秒数" />
            <button className="btn" onClick={saveCustomRetention}>{t('add')}</button>
          </div>
        )}
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

function DeviceModal({ t, initial, onClose, onSave }: { t: T; initial: Device | null; onClose: () => void; onSave: (f: DeviceFields) => void }) {
  const [name, setName] = useState(initial?.name ?? '')
  const [transport, setTransport] = useState(initial?.transport ?? 'tcp')
  const [ip, setIp] = useState(initial?.ip ?? '')
  const [port, setPort] = useState(initial ? String(initial.port) : '8899')
  const [serialPath, setSerialPath] = useState(initial?.serialPath ?? '')
  const [baudRate, setBaudRate] = useState(initial ? String(initial.baudRate ?? 9600) : '9600')
  const [parity, setParity] = useState(initial?.parity ?? 'even')
  const [stopBits, setStopBits] = useState(initial ? String(initial.stopBits ?? 1) : '1')
  const [flowControl, setFlowControl] = useState(initial?.flowControl ?? 'none')
  const [slaveId, setSlaveId] = useState(initial ? String(initial.slaveId ?? 1) : '1')
  const [pollInterval, setPollInterval] = useState(initial ? String(initial.pollIntervalMs ?? 1000) : '1000')
  const save = () => onSave({ name, ip, port: Number(port), transport, serialPath: transport === 'rtu' ? serialPath : '', baudRate: Number(baudRate) || 9600, parity, stopBits: Number(stopBits) || 1, dataBits: 8, flowControl, slaveId: Number(slaveId) || 1, pollIntervalMs: Number(pollInterval) || 1000 })
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{initial ? t('editDeviceTitle') : t('newDeviceTitle')}</h3>
        <label>{t('name')}</label>
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        <label>{t('transport')}</label>
        <select value={transport} onChange={(e) => setTransport(e.target.value)}>
          <option value="tcp">{t('transportTcp')}</option>
          <option value="rtu">{t('transportRtu')}</option>
        </select>
        <label>{t('slaveIdLabel')}</label>
        <input value={slaveId} onChange={(e) => setSlaveId(e.target.value)} placeholder="1" />
        <label>{t('pollIntervalLabel')}</label>
        <input value={pollInterval} onChange={(e) => setPollInterval(e.target.value)} placeholder="1000" />
        {transport === 'tcp' ? (
          <>
            <label>{t('ip')}</label>
            <input value={ip} onChange={(e) => setIp(e.target.value)} placeholder="192.168.90.176" />
            <label>{t('port')}</label>
            <input value={port} onChange={(e) => setPort(e.target.value)} placeholder="8899" />
          </>
        ) : (
          <>
            <label>{t('serialPath')}</label>
            <input value={serialPath} onChange={(e) => setSerialPath(e.target.value)} placeholder="COM3 / /dev/ttyUSB0" />
            <label>{t('baudRate')}</label>
            <select value={baudRate} onChange={(e) => setBaudRate(e.target.value)}>
              {[9600, 19200, 38400, 57600, 115200].map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
            <label>{t('parity')}</label>
            <select value={parity} onChange={(e) => setParity(e.target.value)}>
              <option value="even">Even</option>
              <option value="odd">Odd</option>
              <option value="none">None</option>
            </select>
            <label>{t('stopBits')}</label>
            <select value={stopBits} onChange={(e) => setStopBits(e.target.value)}>
              <option value="1">1</option>
              <option value="2">2</option>
            </select>
            <label>{t('flowControl')}</label>
            <select value={flowControl} onChange={(e) => setFlowControl(e.target.value)}>
              <option value="none">None</option>
              <option value="rtscts">RTS/CTS</option>
              <option value="xonxoff">XON/XOFF</option>
            </select>
          </>
        )}
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>{t('cancel')}</button>
          <button className="btn primary" onClick={save}>{initial ? t('save') : t('add')}</button>
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
