import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { RawFramesRead, clampFrameLimit } from '../../apps/web/src/raw-frames-read'
import { RawFramesStatus } from '../../apps/web/src/RawFramesStatus'
import '../../apps/web/src/styles.css'

function Preview() {
  const [mode, setMode] = useState('slow'), [transport, setTransport] = useState('tcp'), [paused, setPaused] = useState(false), [limit, setLimit] = useState(200), [english, setEnglish] = useState(false), [calls, setCalls] = useState(0)
  const reader = useMemo(() => new RawFramesRead({ id: 1, transport, serialPath: 'COM_MOCK' }, limit), [transport, limit]), state = useSyncExternalStore(reader.subscribe, reader.snapshot, reader.snapshot)
  const sequence = useRef(0), current = useRef({ mode, transport, limit }); current.current = { mode, transport, limit }
  const get = useRef(async () => {
    const chosen = current.current, id = ++sequence.current; setCalls(id)
    if (chosen.mode === 'failure') throw new Error('PRIVATE synthetic error')
    if (chosen.mode === 'hang') return new Promise(() => {})
    const serial = chosen.transport === 'rtu', channelKey = serial ? 'rtu:COM_MOCK' : 'tcp:1', identity = chosen.mode === 'legacy' ? {} : { channelKey: chosen.mode === 'wrong' ? 'wrong-source' : channelKey, ...(serial ? {} : { deviceId: 1 }) }
    const rows = chosen.mode === 'empty' ? [] : [
      { id: id * 2, timestamp: new Date().toISOString(), transport: chosen.transport, direction: 'tx', hex: serial ? '01030000' : '000100000006010300000001', byteLength: serial ? 4 : 12, slaveId: 1, functionCode: 3, isException: false, ...identity },
      { id: id * 2 + 1, timestamp: new Date().toISOString(), transport: chosen.transport, direction: 'rx', hex: serial ? '018302' : '000100000003018302', byteLength: serial ? 3 : 9, slaveId: 1, functionCode: 3, isException: true, exceptionCode: 2, ...identity },
    ].slice(-chosen.limit)
    if (chosen.mode === 'slow') await new Promise(resolve => setTimeout(resolve, 1500))
    return chosen.mode === 'invalid' ? {} : rows
  }).current
  useEffect(() => { if (paused) return; void reader.refresh(get); const timer = setInterval(() => { void reader.refresh(get) }, 1000); return () => { clearInterval(timer); reader.cancel() } }, [reader, paused])
  return <main style={{ padding: 24, maxWidth: 1000, margin: 'auto' }}><h1>原始捕获慢读取 · 纯 mock 手测</h1><p>正式读取模型和状态提示，1秒调度/默认1.5秒返回，模拟读取次数 {calls}。无服务、真实端口、设备、数据库、网络或模型；没有清空按钮。</p>
    <div className="toolbar"><label>下一次合成响应<select value={mode} onChange={e => setMode(e.target.value)}>{[['slow', '1.5秒，忽略取消'], ['normal', '立即成功'], ['empty', '空'], ['failure', '失败'], ['invalid', '坏格式'], ['wrong', '错来源'], ['legacy', '旧记录缺来源'], ['hang', '挂起，10秒超时']].map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label>模拟通道<select value={transport} onChange={e => setTransport(e.target.value)}><option value="tcp">TCP</option><option value="rtu">RTU，非系统串口</option></select></label><label>上限<input type="number" min={1} max={2000} value={limit} onChange={e => setLimit(clampFrameLimit(Number(e.target.value)))} style={{ width: 80 }} /></label><label><input type="checkbox" checked={english} onChange={e => setEnglish(e.target.checked)} />English</label><button className="btn" type="button" onClick={() => { reader.cancel(); setPaused(value => !value) }}>{paused ? '继续页面读取' : '暂停页面读取'}</button><button className="btn" type="button" disabled={paused || state.phase === 'loading'} onClick={() => { void reader.refresh(get) }}>手动刷新</button></div>
    <RawFramesStatus state={state} paused={paused} english={english} />
    <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{state.value?.frames.map(frame => `${frame.id} ${frame.timestamp} ${frame.direction.toUpperCase()} slave ${frame.slaveId} FC${frame.functionCode} ${frame.hex}`).join('\n') ?? ''}</pre>
    <p>手测：持续1.5秒响应仍能更新行，不应永远只显示读取中；在途按钮禁用且自动调用不叠加。暂停时旧响应不能改行，继续恢复；改通道/上限隐藏旧来源。失败/超时/错来源保留旧结果并标未核实，切回成功后下一轮恢复。检查空、旧来源、达到上限、英语和360px长HEX。这里暂停的是页面读取，正式应用设备采集继续；CSP禁止联网。</p>
  </main>
}
createRoot(document.getElementById('root')!).render(<Preview />)
