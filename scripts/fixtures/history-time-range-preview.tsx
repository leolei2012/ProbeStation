import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { HistoryTimeRange } from '../../apps/web/src/HistoryTimeRange'
import { historyTimeRange, resolveHistoryTimeRange, editHistoryTime, changeHistoryInputZone, historyPresetRange } from '../../apps/web/src/history-time-range'
import { historyQueryPlan } from '../../apps/web/src/history-query-task'
import '../../apps/web/src/styles.css'

const start = Date.parse('2026-11-06T00:00:00.123Z'), end = Date.parse('2026-11-06T00:00:00.987Z'), fixedNow = Date.parse('2026-11-06T12:34:56.987Z')
function Preview() {
  const [range, setRange] = useState(() => historyTimeRange(start, end)), [english, setEnglish] = useState(false)
  const resolved = resolveHistoryTimeRange(range), plan = resolved.valid ? historyQueryPlan({ objectId: 9999, start: resolved.start, end: resolved.end, mode: 'chart', page: 0, registerIds: [11] }) : null
  return <main style={{ padding: 24 }}><h1>纯 mock 历史时间输入</h1><p>正式时间控件/模型和查询参数构造；所有时间固定合成，只展示参数，不发请求、不读库、不连接设备。输入“本地”采用当前浏览器时区，此页不修改系统时区。</p>
    <div className="toolbar">
      <button type="button" className="btn" onClick={() => setRange(previous => historyTimeRange(start, end, previous.zone))}>载入毫秒引用（864ms区间）</button>
      <button type="button" className="btn" onClick={() => setRange(previous => historyTimeRange(Date.parse('2026-11-01T05:30:00.000Z'), Date.parse('2026-11-01T06:30:00.000Z'), previous.zone))}>载入重复时刻引用（UTC区间1小时）</button>
      <button type="button" className="btn" onClick={() => setRange(previous => historyPresetRange(0, fixedNow, previous.zone))}>模拟“今天”（本地日，固定now）</button>
      <label><input type="checkbox" checked={english} onChange={e => setEnglish(e.target.checked)} />English controls</label>
    </div>
    <HistoryTimeRange range={range} onEdit={(field, text) => setRange(previous => editHistoryTime(previous, field, text))} onZone={zone => setRange(previous => changeHistoryInputZone(previous, zone))} english={english} />
    <p role="status">{resolved.valid ? `模拟区间长度：${resolved.end - resolved.start} ms` : '无效区间，不构造查询。'}</p>
    <p>参数预览（不可点击、从不发送）：</p><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{plan?.url ?? '—'}</pre>
    <p>手测：切换本地/UTC，区间长度和URL应不变；毫秒引用不得变为0ms。修改一端、无效日期、空值后修正、开始晚于结束、英文和360px窄屏。重复时刻只在采用相应DST规则的本地时区表现为相同墙钟时间；本页不会模拟或修改浏览器时区。</p>
  </main>
}
createRoot(document.getElementById('root')!).render(<Preview />)
