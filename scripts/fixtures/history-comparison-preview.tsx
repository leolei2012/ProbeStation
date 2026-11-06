import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { HistoryComparison } from '../../apps/web/src/HistoryComparison'
import { captureHistoryAnchor, historyComparisonContext, updateHistoryComparison, type HistoryComparisonState } from '../../apps/web/src/history-comparison'
import { buildPointLabels } from '../../apps/web/src/PointLabel'
import { curveValue } from '../../apps/web/src/physical-value'
import type { HistorySeries } from '../../apps/web/src/history-curve'
import '../../apps/web/src/styles.css'

const words: Record<string, string> = {
  pointSource: '配置从站', pointSourceUnknown: '来源未知', colAddr: '地址', histQualityPoint: '点位', histCompareTitle: 'A/B 两点对比（模拟）', histCompareSetA: '当前时刻设为 A', histCompareSetB: '当前时刻设为 B', histCompareClear: '清空对比', histCompareA: 'A 最近显示采样', histCompareB: 'B 最近显示采样', histCompareDifference: '数值差 B − A', histCompareSampleDelta: '实际采样时间差', histCompareCursorDelta: '游标时间差 B − A', histCompareNoSample: '无可用显示采样', histCompareEmpty: '先设 A/B。',
  histCompareHint: '用下方滑块或模拟图选择时刻，再设 A/B。共两条同名、同地址、不同来源的模拟曲线；中间包含断线与无效读数。', histCompareLimit: '快照只取显示采样，不插值、不作自动结论；检查实际时间和批次状态。刷新无效数据不改写旧锚点，数值模式改变会清空。这里不是完整历史页面。',
}
const base = Date.parse('2026-11-06T00:00:00Z'), range = { start: base, end: base + 4000 }
const points = [1, 2].map(id => ({ id, groupId: id, alias: '温度', dataType: 'uint16', functionCode: 3, startAddress: 0, factor: .1, offset: -5, unit: '℃' }))
const labels = buildPointLabels(points, [{ id: 1, slaveId: 1 }, { id: 2, slaveId: 2 }], key => words[key] ?? key)
function Preview() {
  const [cursor, setCursor] = useState(base + 1000), [mode, setMode] = useState<'raw' | 'physical'>('raw'), [invalid, setInvalid] = useState(false)
  const [open, setOpen] = useState(true), [status, setStatus] = useState('ready')
  const context = historyComparisonContext(points, range, mode, new Set())
  const [state, setState] = useState<HistoryComparisonState>({ context, a: null, b: null })
  useEffect(() => { setState(previous => updateHistoryComparison(previous, { type: 'context', context })) }, [context])
  const active = state.context === context ? state : { context, a: null, b: null }
  const series: HistorySeries[] = points.map(point => ({ id: point.id, gapMs: 3000,
    samples: [10, 20, null, 30, 40].map((value, i) => [base + i * 1000, invalid || value === null ? null : curveValue(value * point.id, point, mode)]),
    segments: [0, 0, 1, 2, 2].map((segment, i) => [base + i * 1000, segment]), verification: [0, 1, 2, 3, 4].map(i => [base + i * 1000, i === 2 ? 'unknown' : point.id === 2 ? 'unverified' : 'verified']),
  }))
  return <main style={{ padding: 24 }}>
    <h1>纯 mock 历史两点对比</h1><p>无API、服务、设备或数据库；所有数据固定合成。正式历史曲线用指针/触摸选择时刻，此页额外用滑块方便手测。</p>
    <label>数值模式 <select value={mode} onChange={e => setMode(e.target.value as 'raw' | 'physical')}><option value="raw">原始值</option><option value="physical">物理值</option></select></label>
    <label>模拟查询状态 <select value={status} onChange={e => setStatus(e.target.value)}><option value="ready">已恢复/正常</option><option value="loading">查询中</option><option value="error">失败</option></select></label>
    <label><input type="checkbox" checked={invalid} onChange={e => setInvalid(e.target.checked)} />模拟刷新为全无效（旧快照仍保留）</label>
    <label>模拟游标 <input type="range" min={0} max={4000} step={100} value={cursor - base} onChange={e => setCursor(base + Number(e.target.value))} /></label>
    <p>{new Date(cursor).toISOString()} · 可选1秒设A、4秒设B；2秒无效，1–3秒之间有断线。</p>
    {status !== 'ready' ? <p role="status">{status === 'loading' ? '模拟查询中，无真实请求；切换恢复后继续对比。' : '模拟失败，无真实请求；切换恢复后继续对比。'}</p> : <><svg viewBox="0 0 600 130" width="100%" height="150" role="img" aria-label="模拟时间轴" style={{ background: 'var(--surface)', touchAction: 'none' }} onPointerDown={e => {
      const rect = e.currentTarget.getBoundingClientRect(); setCursor(base + Math.round(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * 4000))
    }}>
      {!invalid && <><path d="M0 100 L150 80 M450 60 L600 40" fill="none" stroke="#22d3ee" /><path d="M0 90 L150 70 M450 50 L600 20" fill="none" stroke="#a78bfa" /></>}
      <line x1={(cursor - base) / 4000 * 600} x2={(cursor - base) / 4000 * 600} y1="0" y2="130" stroke="var(--text-1)" />
      {([['A', active.a], ['B', active.b]] as const).map(([name, anchor], i) => anchor && <text key={name} x={(anchor.time - base) / 4000 * 600} y={15 + i * 15} fill={i ? '#a78bfa' : '#22d3ee'}>{name}</text>)}
    </svg>
    <HistoryComparison open={open} onOpenChange={setOpen} state={active} canCapture t={key => words[key] ?? key} pointLabels={labels} formatTime={time => new Date(time).toISOString()} formatValue={(_id, value) => String(value) + (mode === 'physical' ? ' ℃' : '')}
      onCapture={slot => setState(previous => updateHistoryComparison(previous, { type: 'capture', context, slot, anchor: captureHistoryAnchor(cursor, series) }))}
      onClear={() => setState(previous => updateHistoryComparison(previous, { type: 'clear', context }))} /></>}
  </main>
}
createRoot(document.getElementById('root')!).render(<Preview />)
