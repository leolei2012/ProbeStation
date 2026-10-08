import { useEffect, useState } from 'react'
export function DeviceSlaveStatus({ deviceId }: { deviceId: number }) {
  const [status, setStatus] = useState<any>(null), [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const load = async () => {
      try { const res = await fetch('/api/monitor_objects/' + deviceId + '/slave', { signal: controller.signal }); const data = await res.json(); if (!res.ok) throw new Error(data.message || data.error); if (!controller.signal.aborted) { setStatus(data); setError('') } }
      catch (e: any) { if (!controller.signal.aborted) setError(e.message) }
      finally { if (!controller.signal.aborted) timer = setTimeout(load, 1000) }
    }
    void load(); return () => { controller.abort(); clearTimeout(timer) }
  }, [deviceId])
  return <div className="slave-device-summary">
    <strong>从站服务</strong><span>{status?.connected ? '正在监听，等待主站读写' : '未监听'}</span><span>请求：{status?.requests ?? 0}</span>{status?.transport === 'tcp' && <span>连接：{status?.connections ?? 0}</span>}
    <small>点位的“写”修改本设备从站内存；输入寄存器、离散输入也可在本机设置。数据内存重启程序后清空。</small>
    {(status?.error || error) && <p className="write-msg error" role="alert">{status?.error || error}</p>}
  </div>
}
