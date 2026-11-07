import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { LatestConfigRead, readConfigRequest, configReadFailure, type ConfigReadFailure } from '../../apps/web/src/config-read'
import { ConfigLoadNotice } from '../../apps/web/src/ConfigLoadNotice'
import '../../apps/web/src/styles.css'

function Panel({ mode, english }: { mode: string; english: boolean }) {
  const device = useRef(new LatestConfigRead()), group = useRef(new LatestConfigRead()), source = useRef(mode); source.current = mode
  const [deviceError, setDeviceError] = useState<ConfigReadFailure | null>(null), [groupError, setGroupError] = useState<ConfigReadFailure | null>(null)
  const [devices, setDevices] = useState<string[] | null>(null), [groups, setGroups] = useState<string[] | null>(null), [requests, setRequests] = useState(0)
  const refresh = (kind: 'devices' | 'groups') => {
    const setError = kind === 'devices' ? setDeviceError : setGroupError, setRows = kind === 'devices' ? setDevices : setGroups
    void (kind === 'devices' ? device : group).current.run(signal => readConfigRequest('/mock/' + kind, signal, async () => {
      const selected = source.current; setRequests(value => value + 1)
      if (selected === 'timeout') return new Promise<string[]>(() => {})
      // Intentionally ignore abort to show that a 12-second late result cannot replace a retry.
      await new Promise(resolve => setTimeout(resolve, selected === 'late' ? 12000 : 250))
      if (selected === 'failed') throw new Error('mock HTTP 503')
      return selected === 'empty' ? [] : [kind === 'devices' ? '模拟设备 A（只读）' : '模拟分组 · 从站1', '本次模式: ' + selected]
    }), rows => { setRows(rows); setError(null) }, error => setError(configReadFailure(error)))
  }
  const retry = () => { refresh('devices'); refresh('groups') }
  useEffect(() => { retry(); return () => { device.current.cancel(); group.current.cancel() } }, [])
  return <>
    <p>模拟读取次数：{requests}。本页只体验读取状态，不是完整主界面。</p>
    <ConfigLoadNotice deviceError={deviceError} groupError={groupError} english={english} onRetry={retry} />
    <div className="toolbar"><button type="button" className="btn" onClick={retry}>重新读取两项</button><button type="button" className="btn" onClick={() => refresh('devices')}>只读设备清单</button><button type="button" className="btn" onClick={() => refresh('groups')}>只读点表</button></div>
    <section><h2>设备清单（mock）</h2>{devices === null ? <p>尚未读到结果，不代表没有设备。</p> : !devices.length ? <p>本次读取明确返回空列表。</p> : <ul>{devices.map(row => <li key={row}>{row}</li>)}</ul>}</section>
    <section><h2>点表（mock）</h2>{groups === null ? <p>尚未读到结果，不代表没有点位。</p> : !groups.length ? <p>本次读取明确返回空点表。</p> : <ul>{groups.map(row => <li key={row}>{row}</li>)}</ul>}</section>
  </>
}
function Preview() {
  const [mode, setMode] = useState('normal'), [english, setEnglish] = useState(false), [open, setOpen] = useState(true)
  return <main style={{ padding: 20, maxWidth: 1000, margin: 'auto' }}><h1>配置加载恢复 · 纯 mock</h1>
    <p>只使用本页合成数据，不访问服务器、设备、串口、数据库或模型。超时为实际10秒，迟到响应为12秒。</p>
    <div className="toolbar"><label>下一次读取<select value={mode} onChange={event => setMode(event.target.value)}><option value="normal">正常 / 恢复</option><option value="empty">明确空列表</option><option value="failed">读取失败</option><option value="timeout">请求挂起</option><option value="late">迟到结果（忽略取消）</option></select></label><label><input type="checkbox" checked={english} onChange={event => setEnglish(event.target.checked)} />English</label><button type="button" className="btn" onClick={() => setOpen(value => !value)}>{open ? '关闭读取面板' : '重开读取面板'}</button></div>
    {open && <Panel mode={mode} english={english} />}
    <p>手测：正常后切失败，旧内容应保留且标未核实；切恢复并重试后清除错误。挂起10秒后应明确超时；迟到模式启动后改正常并重试，12秒旧结果不得覆盖。关闭重开时旧读取不得回填。另测空列表、仅设备/仅点表失败、中英和窄屏。</p>
  </main>
}
createRoot(document.getElementById('root')!).render(<Preview />)
