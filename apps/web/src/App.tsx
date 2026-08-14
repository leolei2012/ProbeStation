import { useCallback, useEffect, useState } from 'react'
import './styles.css'

interface Device { id: number; name: string; ip: string; port: number; mode: string; isActive: number }
interface Register { id: number; groupId: number; objectId: number; alias: string | null; functionCode: number; startAddress: number; dataType: string }
interface LatestValue { rawValue: number; quality: string; timestamp: string }

const api = {
  get: (url: string) => fetch(url).then((r) => r.json()),
  post: (url: string, body?: unknown) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then((r) => r.json()),
  del: (url: string) => fetch(url, { method: 'DELETE' }).then((r) => r.json()),
}

export default function App() {
  const [devices, setDevices] = useState<Device[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [view, setView] = useState<'device' | 'settings'>('device')
  const [registers, setRegisters] = useState<Register[]>([])
  const [latest, setLatest] = useState<Record<number, LatestValue>>({})
  const [showAdd, setShowAdd] = useState(false)

  const refreshDevices = useCallback(() => { api.get('/api/monitor_objects').then(setDevices) }, [])

  const refreshRegisters = useCallback((id: number) => {
    api.get('/api/monitor_objects/' + id + '/groups').then(async (groups: Array<{ id: number }>) => {
      const all: Register[] = []
      for (const g of groups) {
        const regs: Register[] = await api.get('/api/groups/' + g.id + '/registers')
        all.push(...regs)
      }
      setRegisters(all)
    })
  }, [])

  useEffect(() => { refreshDevices() }, [refreshDevices])
  useEffect(() => {
    if (selectedId != null) { setView('device'); refreshRegisters(selectedId) }
  }, [selectedId, refreshRegisters])
  useEffect(() => {
    const ws = new WebSocket('ws://' + location.host + '/ws')
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data)
      if (msg.type === 'latest') setLatest(msg.data)
      else if (msg.type === 'poller/result') {
        setLatest((prev) => {
          const next = { ...prev }
          for (const p of msg.points) next[p.registerId] = { rawValue: p.rawValue, quality: p.quality, timestamp: p.timestamp }
          return next
        })
      }
    }
    return () => ws.close()
  }, [])

  const addDevice = useCallback(async (name: string, ip: string, port: number) => {
    if (!name || !ip) return
    await api.post('/api/monitor_objects', { name, ip, port })
    setShowAdd(false)
    refreshDevices()
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
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="brand">砺台</div>
          <div className="brand-sub">ProbeStation · 设备观测与测试</div>
          <button className="new-btn" onClick={() => setShowAdd(true)}>＋ 新建设备</button>
        </div>
        <div className="sidebar-section">设备</div>
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
          {devices.length === 0 && <div className="device-sub" style={{ padding: 8 }}>暂无设备，点上方新建</div>}
        </div>
        <div className="sidebar-footer">
          <button className={'settings-btn' + (view === 'settings' ? ' active' : '')} onClick={() => setView('settings')}>⚙ 设置</button>
        </div>
      </aside>

      <main className="main">
        {view === 'settings'
          ? <SettingsView />
          : selected
            ? <DeviceView device={selected} registers={registers} latest={latest} onToggle={toggleDevice} onDelete={deleteDevice} />
            : <EmptyState />}
      </main>

      {showAdd && <AddDeviceModal onClose={() => setShowAdd(false)} onAdd={addDevice} />}
    </div>
  )
}

function EmptyState() {
  return (
    <div className="empty-state">
      <div className="big">🛰️</div>
      <div>选择左侧设备，或新建设备开始观测</div>
    </div>
  )
}

function DeviceView({ device, registers, latest, onToggle, onDelete }: {
  device: Device; registers: Register[]; latest: Record<number, LatestValue>
  onToggle: (id: number) => void; onDelete: (id: number) => void
}) {
  const exportCsv = () => { const now = new Date().toISOString(); window.open('/api/export/csv?object_id=' + device.id + '&start=2000-01-01T00:00:00Z&end=' + now) }
  const exportXlsx = () => { const now = new Date().toISOString(); window.open('/api/export/xlsx?object_id=' + device.id + '&start=2000-01-01T00:00:00Z&end=' + now) }

  return (
    <div>
      <div className="device-head">
        <span className="name">{device.name}</span>
        <span className={'status-badge' + (device.isActive ? ' on' : '')}>{device.isActive ? '轮询中' : '已停用'}</span>
      </div>
      <div className="main-sub">{device.ip}:{device.port} · {registers.length} 个寄存器</div>

      <div className="toolbar">
        <button className="btn" onClick={() => onToggle(device.id)}>{device.isActive ? '暂停' : '启用'}</button>
        <button className="btn" onClick={exportCsv}>导出 CSV</button>
        <button className="btn" onClick={exportXlsx}>导出 XLSX</button>
        <button className="btn danger" onClick={() => onDelete(device.id)}>删除设备</button>
      </div>

      <table className="reg">
        <thead>
          <tr><th>别名</th><th>地址</th><th>类型</th><th>实时值</th><th>质量</th><th>写值</th></tr>
        </thead>
        <tbody>
          {registers.map((r) => {
            const v = latest[r.id]
            return (
              <tr key={r.id}>
                <td>{r.alias ?? '—'}</td>
                <td className="kv">{r.startAddress}</td>
                <td className="kv">{r.dataType}</td>
                <td className="value">{v ? v.rawValue : '—'}</td>
                <td className="kv">{v ? v.quality : '—'}</td>
                <td><WriteCell reg={r} /></td>
              </tr>
            )
          })}
          {registers.length === 0 && <tr><td colSpan={6} className="kv">暂无寄存器（可通过 API 导入 MBS/MBP 文件）</td></tr>}
        </tbody>
      </table>
    </div>
  )
}

function WriteCell({ reg }: { reg: Register }) {
  const [val, setVal] = useState('')
  const write = async () => {
    if (val === '') return
    await api.post('/api/registers/' + reg.id + '/write', { value: Number(val), method: 'multiple' })
    setVal('')
  }
  return (
    <div style={{ display: 'flex', gap: 4 }}>
      <input className="write-input" value={val} onChange={(e) => setVal(e.target.value)} placeholder="值" />
      <button className="btn" onClick={write}>写</button>
    </div>
  )
}

function SettingsView() {
  const [msg, setMsg] = useState('')
  const clearLogs = async () => { await api.post('/api/logs/clear'); setMsg('日志已清空') }
  return (
    <div>
      <div className="main-title">设置</div>
      <div className="main-sub">应用与数据管理</div>
      <div className="settings-card">
        <h4>应用信息</h4>
        <div className="setting-row"><span>版本</span><span className="kv">0.1.0</span></div>
        <div className="setting-row"><span>架构</span><span className="kv">Cordis 插件化 · TypeScript</span></div>
        <div className="setting-row"><span>持久化</span><span className="kv">SQLite 元数据 + DuckDB 时序</span></div>
      </div>
      <div className="settings-card">
        <h4>数据管理</h4>
        <div className="setting-row">
          <span>运行日志</span>
          <button className="btn" onClick={clearLogs}>清空日志</button>
        </div>
        {msg && <div className="kv" style={{ marginTop: 8 }}>{msg}</div>}
      </div>
    </div>
  )
}

function AddDeviceModal({ onClose, onAdd }: { onClose: () => void; onAdd: (name: string, ip: string, port: number) => void }) {
  const [name, setName] = useState('')
  const [ip, setIp] = useState('')
  const [port, setPort] = useState('8899')
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>新建设备</h3>
        <label>名称</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="设备名称" autoFocus />
        <label>IP 地址</label>
        <input value={ip} onChange={(e) => setIp(e.target.value)} placeholder="192.168.90.32" />
        <label>端口</label>
        <input value={port} onChange={(e) => setPort(e.target.value)} placeholder="8899" />
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" onClick={() => onAdd(name, ip, Number(port))}>添加</button>
        </div>
      </div>
    </div>
  )
}
