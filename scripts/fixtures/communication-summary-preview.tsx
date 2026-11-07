import React, { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { CommunicationSummary } from '../../apps/web/src/CommunicationSummary'
import '../../apps/web/src/styles.css'

function Preview() {
  const [mode, setMode] = useState('normal'), [transport, setTransport] = useState('tcp'), [english, setEnglish] = useState(false), [reads, setReads] = useState(0)
  const current = useRef({ mode, transport }); current.current = { mode, transport }
  const get = useRef(async () => {
    const chosen = current.current; setReads(value => value + 1)
    if (chosen.mode === 'failure') throw new Error('PRIVATE synthetic backend error, never shown')
    if (chosen.mode === 'hang') return new Promise(() => {})
    const serial = chosen.transport === 'rtu', scope = serial ? 'channel' : 'device', channelKey = serial ? 'rtu:COM_MOCK' : 'tcp:1', zero = chosen.mode === 'zero', instant = chosen.mode === 'instant'
    const value = { objectId: chosen.mode === 'wrong' ? 999 : 1, connected: chosen.mode !== 'unavailable', scope, channelKey, metrics: chosen.mode === 'unavailable' ? null : {
      scope, channelKey, ...(serial ? {} : { deviceId: 1 }), txFrames: zero ? 0 : 8, rxFrames: zero ? 0 : 7, successCount: zero ? 0 : instant ? 1 : 4, errorCount: zero || instant ? 0 : 1, timeoutCount: zero || instant ? 0 : 1, consecutiveErrors: zero || instant ? 0 : 1, bufferedFrames: zero ? 0 : 15, recentErrorRate: zero || instant ? 0 : 0.2,
      ...(zero ? {} : instant ? { lastResponseMs: 0, averageResponseMs: 0, maxResponseMs: 0, lastSuccessTime: '2026-11-07T12:00:00.000Z' } : { lastResponseMs: 500, averageResponseMs: 112, maxResponseMs: 500, lastSuccessTime: '2026-11-07T12:00:00.000Z', lastErrorTime: '2026-11-07T12:00:01.000Z', lastError: { code: 'timeout', message: '<script>合成异常，仅文本</script>\n' + '长说明'.repeat(100), retryable: true } }),
    } }
    if (chosen.mode === 'slow') await new Promise(resolve => setTimeout(resolve, 2000))
    return value
  }).current
  return <main style={{ padding: 24, maxWidth: 1000, margin: 'auto' }}><h1>通信统计 · 纯 mock 手测</h1><p>正式只读模型/组件，全部合成数据。不读取后端、数据库、真实通信或串口；读取次数 {reads}，默认收起不读取，没有自动刷新。</p>
    <div className="toolbar"><label>下次读取<select value={mode} onChange={e => setMode(e.target.value)}>{[['normal', '已有统计'], ['zero', '零请求，不推断正常'], ['instant', '一次请求，耗时0'], ['unavailable', '无诊断计数'], ['wrong', '来源不匹配'], ['failure', '读取失败'], ['hang', '挂起，10秒超时'], ['slow', '延迟2秒，忽略取消']].map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label>模拟通道<select value={transport} onChange={e => setTransport(e.target.value)}><option value="tcp">TCP设备</option><option value="rtu">RTU共享串口（非系统端口）</option></select></label><label><input type="checkbox" checked={english} onChange={e => setEnglish(e.target.checked)} />English</label></div>
    <CommunicationSummary device={{ id: 1, transport, serialPath: 'COM_MOCK' }} get={get} english={english} />
    <p>手测：展开后读取，未主动重读时数字不变化。失败/超时/错来源保留上次并标未核实；恢复正常后显式重读。延迟时收起→改正常/通道→重开，旧结果不能覆盖新读取。核对RTU共享警告、零请求/无计数、耗时0与缺失、中英文、HTML文本及360px长错误换行。页面无连接、清空、探测、写配置或模型入口，CSP禁止联网。</p>
  </main>
}
createRoot(document.getElementById('root')!).render(<Preview />)
