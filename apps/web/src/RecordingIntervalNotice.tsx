import React, { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { RecordingAttentionRead, type RecordingAttentionState } from './recording-attention-read'

export function RecordingIntervalStatusView({ state, refresh }: { state: RecordingAttentionState; refresh: () => void }) {
  const value = state.value?.available ? state.value : undefined
  const rate = (value: number | null) => value === null ? '未核实' : value + ' ms' + (Number.isSafeInteger(value) && value > 0 ? '' : '（配置值异常）')
  return <section className={'recording-interval-notice' + (value?.notices.length ? ' needs-review' : '')} aria-label="录制间隔核对">
    <div className="recording-interval-heading"><strong>录制间隔核对</strong><button className="btn btn-sm" type="button" disabled={state.phase === 'loading'} onClick={refresh}>重新读取</button></div>
    {state.phase === 'loading' && <p role="status">正在读取当前配置…</p>}
    {state.phase === 'error' && <p role="alert">当前录制间隔状态未核实，请重新读取。{value && '下方保留上次读取结果。'}</p>}
    {state.value?.available === false && <p>{state.phase === 'ready' ? '本次' : '上次'}读取的服务未提供录制状态，无法核实；不会自动修改间隔。</p>}
    {value && <><p>{state.phase === 'ready' ? '本次读取：' : '上次读取：'}{new Date(value.checkedAt).toLocaleString()} · {value.current ? `当前配置间隔 ${rate(value.current.intervalMs)}` : '设备已不存在，未操作替代设备'} · 活动录制 {value.active.length} 段</p>
      {!!value.notices.length && <><p role="status">有 {value.notices.length} 条录制结束记录需要人工核对。请确认当前间隔符合预期；如需调整，可在上方的设备编辑入口核对当前配置后保存所需间隔。</p>
        <details><summary>查看原始间隔、录制间隔与警告</summary><ul>{value.notices.map(notice => <li key={notice.recordingId}><strong>{notice.state === 'preserved' ? '已保留当前值，未自动恢复' : '恢复结果待核实'}</strong> · {new Date(notice.finishedAt).toLocaleString()}<br />原间隔 {rate(notice.originalIntervalMs)} · 录制间隔 {rate(notice.recordingIntervalMs)}<br /><span className="kv">录制 {notice.recordingId}</span><p>{notice.warnings.join('；')}</p></li>)}</ul></details>
      </>}
      {!value.notices.length && <p>本次运行暂无保留的待核对记录。</p>}
      {value.active.length > 0 && <p>仍有录制在运行，临时间隔可能继续使用；请结合录制状态核对。</p>}
      {value.current?.mode === 'slave' && <p>从站间隔配置不代表主动轮询频率。</p>}
      <small>仅保留本次运行当前配置的最近 {value.retention.limit} 条核对记录，删除录制样本不会清除它们；重新打开配置或重启后不保留。{value.retention.dropped > 0 && `全局已有 ${value.retention.dropped} 条较早记录移出内存，当前清单不覆盖全部历史。`} 当前配置值不代表硬件实测频率。</small>
    </>}
  </section>
}
const read = async (url: string, signal: AbortSignal) => { const response = await fetch(url, { signal }); if (!response.ok) throw new Error('读取失败'); return response.json() }
export function RecordingIntervalNotice({ deviceId, get = read }: { deviceId: number; get?: (url: string, signal: AbortSignal) => Promise<unknown> }) {
  const reader = useMemo(() => new RecordingAttentionRead(deviceId), [deviceId]), latestGet = useRef(get)
  latestGet.current = get
  const state = useSyncExternalStore(reader.subscribe, reader.getSnapshot, reader.getSnapshot)
  useEffect(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout>
    const poll = async () => { await reader.refresh((url, signal) => latestGet.current(url, signal)); if (!stopped) timer = setTimeout(poll, 15000) }
    void poll()
    return () => { stopped = true; clearTimeout(timer); reader.cancel() }
  }, [reader])
  return <RecordingIntervalStatusView state={state} refresh={() => { void reader.refresh((url, signal) => latestGet.current(url, signal)) }} />
}
