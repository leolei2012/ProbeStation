import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { HistoryReadNotice } from '../../apps/web/src/HistoryReadNotice'
import { historyReadContextKey, reduceHistoryRead, historyReadView, type HistoryReadState } from '../../apps/web/src/history-read-context'
import { historyQueryPlan, startHistoryQuery, type HistoryQueryTask } from '../../apps/web/src/history-query-task'
import { withRegisterSources } from '../../packages/core/src/sample-source'
import { decodeRegister } from '../../packages/core/src/codec'
import '../../apps/web/src/styles.css'

interface Payload { rows: Array<{ id: number; source: number; dataType: string; rawValue: number | bigint }> }
const device = { id: 7, mode: 'master', slaveId: 9 }, start = Date.parse('2026-11-06T00:00:00.123Z'), end = Date.parse('2026-11-06T01:00:00.987Z')
function Preview() {
  const [source, setSource] = useState(1), [type, setType] = useState('uint16'), [covered, setCovered] = useState(false), [ready, setReady] = useState(true), [invalid, setInvalid] = useState(false), [scenario, setScenario] = useState('success'), [refresh, setRefresh] = useState(0), [english, setEnglish] = useState(false)
  const [state, setState] = useState<HistoryReadState<Payload> | null>(null), task = useRef<HistoryQueryTask | null>(null)
  const groups = [{ id: 10, name: '合成组', slaveId: source, functionCode: 3, startAddress: 0, quantity: 2 }]
  const selected = { id: 101, objectId: 7, groupId: 10, alias: '合成所选点位', functionCode: 3, startAddress: 1, dataType: type }
  const points = withRegisterSources([selected, invalid ? selected : { ...selected, id: 102, startAddress: 0, dataType: covered ? 'uint32' : 'uint16' }], groups, device)
  const contextKey = historyReadContextKey(device, groups, points)
  const plan = useMemo(() => ready && contextKey !== null ? historyQueryPlan({ objectId: 7, start, end, mode: 'chart', page: 0, registerIds: [101], contextKey, revision: refresh }) : null, [ready, contextKey, refresh])
  useEffect(() => {
    // Capture this request's synthetic definition, deliberately ignore abort on the provider.
    const capturedSource = source, capturedType = type, capturedCovered = covered, capturedScenario = scenario
    const next = startHistoryQuery<Payload>(plan, async () => {
      if (capturedScenario === 'hang') return new Promise(() => {})
      return new Promise((resolve, reject) => setTimeout(() => {
        if (capturedScenario === 'failure') reject(new Error('synthetic request failure'))
        else resolve({ rows: capturedCovered || capturedScenario === 'empty' ? [] : [{ id: 101, source: capturedSource, dataType: capturedType, rawValue: decodeRegister(capturedType, [capturedSource === 1 ? 10 : 200]) }] })
      }, 1000))
    }, event => setState(previous => reduceHistoryRead(previous, plan, event)))
    task.current = next
    return () => { next.dispose(); if (task.current === next) task.current = null }
  }, [plan])
  const view = historyReadView(plan, state)
  return <main style={{ padding: 24 }}><h1>纯 mock 历史定义上下文</h1><p>正式上下文投影、查询计划、读取生命周期、结果归属及提示；全部合成元数据/响应，不请求API、不读库或连接设备。只展示已归属结果，不模拟真实曲线或表格。</p>
    <div className="toolbar"><label>配置来源<select value={source} onChange={e => setSource(Number(e.target.value))}><option value="1">从站1（原始字10）</option><option value="2">从站2（原始字200）</option></select></label><label>所选点类型<select value={type} onChange={e => setType(e.target.value)}><option value="uint16">uint16</option><option value="uint16-LE">uint16-LE</option></select></label>
      <label><input type="checkbox" checked={covered} onChange={e => setCovered(e.target.checked)} />未选点改为32位，覆盖所选点</label><label><input type="checkbox" checked={ready} onChange={e => setReady(e.target.checked)} />点表就绪</label><label><input type="checkbox" checked={invalid} onChange={e => setInvalid(e.target.checked)} />重复ID（格式异常）</label><label><input type="checkbox" checked={english} onChange={e => setEnglish(e.target.checked)} />English</label>
      <label>下次响应（选好后重查）<select value={scenario} onChange={e => setScenario(e.target.value)}><option value="success">成功</option><option value="empty">空结果</option><option value="failure">失败</option><option value="hang">不结束，30秒超时</option></select></label>
      <button className="btn" disabled={!plan} onClick={() => setRefresh(v => v + 1)}>同URL重新查询</button><button className="btn" disabled={view.status !== 'loading' || !plan} onClick={() => task.current?.cancel()}>取消本次读取</button></div>
    <p>当前客户端定义：同一点位 #101 / 配置从站 {source} / {type}。普通响应延迟1秒，故意忽略取消，以验晚到结果隔离。</p>
    <HistoryReadNotice reason={!ready ? 'waiting' : contextKey === null ? 'invalid' : view.contextChanged ? 'changed' : null} english={english} />
    <p role="status">状态：{!ready ? '等待点表' : contextKey === null ? '上下文无效' : view.status}；重查序号 {refresh}；上下文长度 {contextKey?.length ?? 0}（不进入URL）</p>
    <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(view.data, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2)}</pre>
    {view.error != null && <p role="alert">{String(view.error)}</p>}
    <p>参数仅展示，从不发送：</p><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{plan?.url ?? '无查询'}</pre>
    <p>手测：成功后改从站或类型，立即隐藏旧结果；延迟中连续变更，只有最后上下文完成。改未选点类型后接受空结果；重复ID/未就绪挂起，恢复后可重查。成功后同URL重查、取消、失败/超时后恢复，不得显示旧值或旧错误。英文与360px窄屏。实际App还需检查曲线/质量摘要/表格一致、保留X窗口和重置Y/A/B/分页。</p>
  </main>
}
createRoot(document.getElementById('root')!).render(<Preview />)
