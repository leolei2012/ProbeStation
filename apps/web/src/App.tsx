import { useCallback, useEffect, useState } from 'react'

interface Device { id: number; name: string; ip: string; port: number; mode: string; isActive: number }
interface Group { id: number; objectId: number; name: string; functionCode: number; startAddress: number; quantity: number }
interface Register { id: number; groupId: number; objectId: number; alias: string | null; functionCode: number; startAddress: number; dataType: string }
interface LatestValue { rawValue: number; quality: string; timestamp: string }

const api = {
  get: (url: string) => fetch(url).then((r) => r.json()),
  post: (url: string, body?: unknown) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then((r) => r.json()),
  put: (url: string, body: unknown) => fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json()),
  del: (url: string) => fetch(url, { method: 'DELETE' }).then((r) => r.json()),
}

export default function App() {
  const [devices, setDevices] = useState<Device[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [registers, setRegisters] = useState<Register[]>([])
  const [latest, setLatest] = useState<Record<number, LatestValue>>({})
  const [newDev, setNewDev] = useState({ name: '', ip: '', port: '8899' })

  const refreshDevices = useCallback(() => { api.get('/api/monitor_objects').then(setDevices) }, [])
  const refreshRegisters = useCallback((id: number) => {
    api.get(`/api/monitor_objects/${id}/groups`).then(async (groups: Group[]) => {
      const all: Register[] = []
      for (const g of groups) {
        const regs: Register[] = await api.get(`/api/groups/${g.id}/registers`)
        all.push(...regs)
      }
      setRegisters(all)
    })
  }, [])

  useEffect(() => { refreshDevices() }, [refreshDevices])

  useEffect(() => {
    if (selectedId != null) refreshRegisters(selectedId)
  }, [selectedId, refreshRegisters])

  useEffect(() => {
    const ws = new WebSocket(`ws://${location.host}/ws`)
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

  const addDevice = async () => {
    await api.post('/api/monitor_objects', { name: newDev.name, ip: newDev.ip, port: Number(newDev.port) })
    setNewDev({ name: '', ip: '', port: '8899' })
    refreshDevices()
  }

  const toggleDevice = async (id: number) => { await api.post(`/api/monitor_objects/${id}/toggle`); refreshDevices() }
  const deleteDevice = async (id: number) => { await api.del(`/api/monitor_objects/${id}`); if (selectedId === id) setSelectedId(null); refreshDevices() }

  const writeRegister = async (reg: Register) => {
    const value = prompt(`写 ${reg.alias ?? reg.id} (地址 ${reg.startAddress})：`)
    if (value == null || value === '') return
    await api.post(`/api/registers/${reg.id}/write`, { value: Number(value), method: 'multiple' })
  }

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: 16, display: 'flex', gap: 24, alignItems: 'flex-start' }}>
      <div style={{ minWidth: 260 }}>
        <h1>砺台 ProbeStation</h1>
        <h3>设备</h3>
        <div style={{ marginBottom: 8, display: 'flex', gap: 4 }}>
          <input placeholder="名称" value={newDev.name} onChange={(e) => setNewDev({ ...newDev, name: e.target.value })} style={{ width: 70 }} />
          <input placeholder="IP" value={newDev.ip} onChange={(e) => setNewDev({ ...newDev, ip: e.target.value })} style={{ width: 100 }} />
          <input placeholder="端口" value={newDev.port} onChange={(e) => setNewDev({ ...newDev, port: e.target.value })} style={{ width: 50 }} />
          <button onClick={addDevice}>添加</button>
        </div>
        <ul style={{ paddingLeft: 18 }}>
          {devices.map((d) => (
            <li key={d.id} style={{ marginBottom: 4 }}>
              <span
                onClick={() => setSelectedId(d.id)}
                style={{ cursor: 'pointer', fontWeight: selectedId === d.id ? 'bold' : 'normal', opacity: d.isActive ? 1 : 0.4 }}
              >
                {d.name}
              </span>
              <span style={{ color: '#888', fontSize: 12 }}> {d.ip}:{d.port}</span>
              <button onClick={() => toggleDevice(d.id)} style={{ marginLeft: 6 }}>{d.isActive ? '停' : '启'}</button>
              <button onClick={() => deleteDevice(d.id)} style={{ marginLeft: 2 }}>删</button>
            </li>
          ))}
        </ul>
      </div>

      <div style={{ flex: 1 }}>
        <h3>寄存器实时值{selectedId != null ? `（设备 #${selectedId}）` : ''}</h3>
        <table border={1} cellPadding={5} style={{ borderCollapse: 'collapse' }}>
          <thead><tr><th>别名</th><th>地址</th><th>类型</th><th>值</th><th>质量</th><th>操作</th></tr></thead>
          <tbody>
            {registers.map((r) => {
              const v = latest[r.id]
              return (
                <tr key={r.id}>
                  <td>{r.alias ?? '-'}</td>
                  <td>{r.startAddress}</td>
                  <td>{r.dataType}</td>
                  <td>{v ? v.rawValue : '—'}</td>
                  <td>{v ? v.quality : '—'}</td>
                  <td><button onClick={() => writeRegister(r)}>写</button></td>
                </tr>
              )
            })}
            {registers.length === 0 && <tr><td colSpan={6}>选择设备查看寄存器</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}
