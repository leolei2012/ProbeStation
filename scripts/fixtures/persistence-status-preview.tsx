import React, { useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { PersistenceStatus } from '../../apps/web/src/PersistenceStatus'
import '../../apps/web/src/styles.css'
function Preview() {
  const [objectId, setObjectId] = useState<number | null>(null), [scenario, setScenario] = useState('queued'), [english, setEnglish] = useState(false), [shown, setShown] = useState(true), [reads, setReads] = useState(0)
  const mode = useRef(scenario); mode.current = scenario
  const get = useMemo(() => async (url: string, _signal: AbortSignal) => {
    setReads(value => value + 1)
    const selected = mode.current, rawId = new URLSearchParams(url.split('?')[1]).get('object_id'), id = rawId === null ? null : Number(rawId)
    if (selected === 'request-error') throw new Error('synthetic request failure')
    if (selected === 'hang') return new Promise(() => {})
    if (selected === 'slow') await new Promise(resolve => setTimeout(resolve, 1000))
    if (selected === 'unavailable') return { version: 1, available: false, objectId: id }
    const globalPendingRows = selected === 'empty' ? 0 : 8, pendingRows = id === null ? globalPendingRows : globalPendingRows === 0 ? 0 : id === 1 ? 3 : id === 2 ? 5 : 0
    const phase = selected === 'initializing' || selected === 'switching' ? selected : selected === 'failed' ? 'failed' : selected === 'blocked' || selected === 'init-failed' ? 'blocked' : 'ready'
    return { version: 1, available: true, objectId: id, stateScope: 'service', checkedAt: new Date().toISOString(), phase,
      failure: selected === 'failed' ? 'flush-failed' : selected === 'blocked' ? 'write-uncertain' : selected === 'init-failed' ? 'initialization-failed' : null,
      flushing: selected === 'flushing', pendingRows: selected === 'invalid' ? 999 : pendingRows, globalPendingRows,
      lastCommitAt: ['initializing', 'init-failed'].includes(selected) ? null : '2026-11-07T00:00:01.123Z', lastFailureAt: ['failed', 'blocked', 'init-failed'].includes(selected) ? '2026-11-07T00:00:02.456Z' : null }
  }, [])
  return <main style={{ padding: 24, maxWidth: 1000, margin: 'auto' }}><h1>采样落盘状态 · 纯 mock 手测</h1><p>正式状态组件与读取模型；全部为合成状态，不使用数据库、设备或网络。只读次数 {reads}；没有提交、清空或重试写入能力。时间为示例，不代表真实后端。</p>
    <div className="toolbar"><label>范围<select value={objectId ?? 'all'} onChange={e => setObjectId(e.target.value === 'all' ? null : Number(e.target.value))}><option value="all">全服务</option><option value="1">合成设备1（3条）</option><option value="2">合成设备2（5条）</option><option value="3">合成设备3（0条）</option></select></label>
      <label>下次合成响应<select value={scenario} onChange={e => setScenario(e.target.value)}>{[['queued', '待提交'], ['flushing', '提交中'], ['empty', '无待写'], ['failed', '批量写入失败'], ['blocked', '回滚不确定，写入阻止'], ['init-failed', '初始化失败'], ['initializing', '正在初始化'], ['switching', '正在切换'], ['unavailable', '后端不支持'], ['invalid', '异常计数，整份拒绝'], ['request-error', '请求失败'], ['hang', '挂起，10秒超时'], ['slow', '延迟1秒且忽略取消']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <button className="btn" onClick={() => setShown(value => !value)}>{shown ? '移除组件' : '重新挂载'}</button><label><input type="checkbox" checked={english} onChange={e => setEnglish(e.target.checked)} />English</label></div>
    {shown && <PersistenceStatus objectId={objectId} get={get} english={english} />}
    <p>手测：选择场景后点组件内“重新读取”；失败/超时保留上次值并标未核实，恢复正常后再读。提交失败时选合成设备3，应显示所选待写0、全服务8，并保留共享失败说明。切换范围立即隐藏旧范围结果；延迟读取期间切换/移除组件，旧响应不能写回。检查360px窄屏和英文。自动15秒轮询/10秒超时只作用于本页mock回调；CSP禁止联网。</p>
  </main>
}
createRoot(document.getElementById('root')!).render(<Preview />)
