import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { LiveSnapshotPanel } from '../../apps/web/src/LiveSnapshotPanel'
import { captureLiveSnapshot, liveSnapshotJson, type LiveSnapshot, type SnapshotView } from '../../apps/web/src/live-snapshot'
import { evaluateLivePoints } from '../../apps/web/src/live-point-filter'
import { sourceKey } from '../../packages/core/src/sample-source'
import type { Sample } from '../../apps/web/src/observation'
import '../../apps/web/src/styles.css'

// Entirely synthetic: no fetch, provider, configuration, store, hardware or file access.
function Preview() {
  const [mode, setMode] = useState('normal'), [source, setSource] = useState(''), [english, setEnglish] = useState(false), [tick, setTick] = useState(0), [blocked, setBlocked] = useState(false)
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null), [downloaded, setDownloaded] = useState('')
  const now = Date.parse('2026-11-07T12:00:00Z') + tick * 1000, device = { id: 99, name: '纯合成设备 · 不连接后端', mode: 'master', isActive: 1 }
  const groups = [1, 2].map(slaveId => ({ id: slaveId, name: `合成组${slaveId} · ` + '长标签'.repeat(12), isActive: 1, slaveId, functionCode: 3, registers: Array.from({ length: 13 }, (_, i) => ({ id: slaveId * 100 + i, alias: `点位${i} · ` + (i === 0 ? '<script>仅文本</script>' : '读数'), startAddress: i * 2, functionCode: 3, dataType: 'uint32', factor: i === 0 ? 0 : 1, offset: 5, unit: 'V' })) }))
  const views = new Map<number, SnapshotView>(), latest: Record<string, Sample> = {}, visibleIds = new Set<number>()
  for (const group of groups) for (const point of group.registers) {
    const value = tick + point.id
    views.set(point.id, { value: String(value), label: null, covered: false, invalid: mode === 'invalid' || mode === 'missing', physical: { value: mode === 'invalid' || mode === 'missing' ? null : String(point.factor === 0 ? 5 : value + 5) } })
    if (mode !== 'missing') for (let index = 0; index < 2; index++) latest[sourceKey(device.id, 'holding-register', point.startAddress + index, group.slaveId!)] = {
      rawValue: mode === 'invalid' ? NaN : index === 0 ? 0 : value, quality: mode === 'invalid' ? 'bad' : 'good', timestamp: new Date(now - (mode === 'stale' ? 10000 : 0)).toISOString(), timestampMs: now - (mode === 'stale' ? 10000 : 0), slaveId: group.slaveId, batchId: mode === 'legacy' ? undefined : `${point.id}-${tick}-${mode === 'mixed' ? index : 'batch'}`,
    }
    if (source !== 'none' && (!source || Number(source) === group.slaveId)) visibleIds.add(point.id)
  }
  const states = evaluateLivePoints(groups, views, latest, device, [], {}, now, 5000)
  return <main style={{ padding: 20, maxWidth: 1100, margin: 'auto' }}><h1>实时观测快照 · 纯 mock 手测</h1>
    <p>正式冻结模型和预览组件，26个合成点位；无网络、后端、数据库、设备或模型。合成读数步进 {tick}，冻结后继续步进不应改变快照。下载为本页模拟，不写实际文件。</p>
    <div className="toolbar"><label>场景<select value={mode} onChange={e => setMode(e.target.value)}>{[['normal', '正常'], ['missing', '全无数据'], ['invalid', '全异常'], ['mixed', '多字混批'], ['legacy', '旧样本无批次'], ['stale', '旧值']].map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
      <label>来源<select value={source} onChange={e => setSource(e.target.value)}><option value="">全部</option><option value="1">从站1</option><option value="2">从站2同地址</option><option value="none">无匹配</option></select></label>
      <label><input type="checkbox" checked={english} onChange={e => setEnglish(e.target.checked)} />English</label><label><input type="checkbox" checked={blocked} onChange={e => setBlocked(e.target.checked)} />模拟下载受阻</label>
      <button className="btn" type="button" onClick={() => setTick(value => value + 1)}>合成读数步进</button>
      <button className="btn" type="button" disabled={!visibleIds.size} onClick={() => { setDownloaded(''); setSnapshot(captureLiveSnapshot({ device, groups, visibleIds, views, states, latest, filters: { search: '', source, mode: 'all' }, rulesReady: false, observedAt: now, capturedAt: now, thresholdMs: 5000 })) }}>冻结当前{visibleIds.size}个匹配点位</button></div>
    {snapshot && <LiveSnapshotPanel key={snapshot.capturedAt + ':' + snapshot.scope.source} snapshot={snapshot} close={() => setSnapshot(null)} english={english} download={value => { if (blocked) throw new Error('synthetic download failure'); setDownloaded(liveSnapshotJson(value)) }} />}
    {downloaded && <p role="status">模拟下载已接收 {JSON.parse(downloaded).points.length} 个冻结点位；预览分页不会截断JSON。文本长度 {downloaded.length}。</p>}
    <p>手测：全部来源冻结后下一页；步进、改场景/筛选，已冻结内容应保持。新冻结后核对两从站同地址、0倍率、空值、异常、混批、旧值和长标签；无匹配禁用冻结。模拟下载受阻后应保留快照，取消受阻后可重试。检查中英文、关闭重开及360px横向滚动。CSP禁止联网，无实际下载、写配置或设备入口。</p>
  </main>
}
createRoot(document.getElementById('root')!).render(<Preview />)
