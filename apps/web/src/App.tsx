import { useEffect, useState } from 'react'

interface Device { id: number; name: string; ip: string; port: number; mode: string }
interface LatestValue { rawValue: number; quality: string; timestamp: string }

export default function App() {
  const [devices, setDevices] = useState<Device[]>([])
  const [latest, setLatest] = useState<Record<number, LatestValue>>({})

  useEffect(() => {
    fetch('/api/monitor_objects')
      .then((r) => r.json())
      .then(setDevices)
      .catch(() => setDevices([]))
  }, [])

  useEffect(() => {
    const ws = new WebSocket(`ws://${location.host}/ws`)
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data)
      if (msg.type === 'latest') {
        setLatest(msg.data)
      } else if (msg.type === 'poller/result') {
        setLatest((prev) => {
          const next = { ...prev }
          for (const p of msg.points) next[p.registerId] = { rawValue: p.rawValue, quality: p.quality, timestamp: p.timestamp }
          return next
        })
      }
    }
    return () => ws.close()
  }, [])

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: 16 }}>
      <h1>ProbeStation 砺台</h1>
      <h2>设备</h2>
      <ul>
        {devices.map((d) => (
          <li key={d.id}>{d.name}（{d.ip}:{d.port}）</li>
        ))}
      </ul>
      <h2>实时值</h2>
      <table border={1} cellPadding={4}>
        <thead><tr><th>寄存器 ID</th><th>值</th><th>质量</th><th>时间</th></tr></thead>
        <tbody>
          {Object.entries(latest).map(([rid, v]) => (
            <tr key={rid}><td>{rid}</td><td>{v.rawValue}</td><td>{v.quality}</td><td>{v.timestamp}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
