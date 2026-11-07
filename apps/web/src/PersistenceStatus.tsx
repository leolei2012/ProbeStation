import React, { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { PersistenceStatusRead, type PersistenceReadState } from './persistence-status-read'
export function PersistenceStatusView({ state, refresh, english = false }: { state: PersistenceReadState; refresh: () => void; english?: boolean }) {
  const text = (zh: string, en: string) => english ? en : zh, value = state.value?.available ? state.value : undefined
  const current = state.phase === 'ready', issue = value?.phase === 'failed' || value?.phase === 'blocked'
  const summary = !value ? '' : value.phase === 'initializing' ? text('历史存储正在初始化，尚不能确认写入就绪。', 'History storage is initializing; writes are not yet verified.') : value.phase === 'switching' ? text('历史存储正在切换，请等待完成后重新核对。', 'History storage is switching; verify again after it completes.') : value.phase === 'blocked' ? text(value.failure === 'initialization-failed' ? '历史存储初始化失败，后续写入已被阻止。' : '批量写入结果不确定，后续写入已被阻止。', value.failure === 'initialization-failed' ? 'History storage initialization failed; further writes are blocked.' : 'The batch write outcome is uncertain; further writes are blocked.') : value.phase === 'failed' ? text('已记录批量写入失败，缓冲尚未确认提交，请核对后端日志和磁盘。', 'A batch write failed; buffered rows are not confirmed committed. Check backend logs and disk.') : value.flushing ? text('正在提交采样缓冲。', 'Submitting buffered samples.') : value.globalPendingRows > 0 ? text('采样缓冲正在等待批量提交。', 'Samples are buffered, awaiting a batch commit.') : text('暂无待写样本，未记录当前批量写入错误。', 'No pending samples or currently recorded batch-write error.')
  return <section className={'persistence-status' + (state.phase === 'error' || current && issue ? ' needs-review' : '')} aria-label={text('采样落盘状态', 'Sample persistence status')}>
    <div className="persistence-heading"><strong>{text('采样落盘状态（全服务）', 'Sample persistence (service-wide)')}</strong><button className="btn btn-sm" type="button" disabled={state.phase === 'loading'} onClick={refresh}>{text('重新读取', 'Read again')}</button></div>
    {state.phase === 'loading' && <p role="status">{text('正在读取服务状态…', 'Reading service status…')}</p>}
    {state.phase === 'error' && <p role="alert">{text(state.error === 'timeout' ? '读取超过10秒，当前状态未核实。' : state.error === 'invalid' ? '状态响应异常，当前状态未核实。' : '当前落盘状态读取失败，尚未核实。', state.error === 'timeout' ? 'Read exceeded 10 seconds; current status is unverified.' : state.error === 'invalid' ? 'Invalid status response; current status is unverified.' : 'Current persistence status could not be verified.')}{value && text(' 下方保留上次读取结果。', ' The previous result is retained below.')}</p>}
    {state.value?.available === false && <p>{text('该后端未提供落盘状态，无法据此判断已保存。', 'This backend does not provide persistence status; saved data cannot be confirmed here.')}</p>}
    {value && <><p role={current && issue ? 'alert' : 'status'}>{!current && text('上次记录：', 'Previously reported: ')}{summary}</p>
      <p>{text(current ? '本次读取' : '上次读取', current ? 'Read at' : 'Previous read')}: <time dateTime={value.checkedAt}>{value.checkedAt}</time> (UTC)</p>
      <p>{value.objectId === null ? text('全服务待写', 'Service pending') : text(`所选设备 #${value.objectId} 待写`, `Selected device #${value.objectId} pending`)}: <strong>{value.pendingRows.toLocaleString()}</strong>{value.objectId !== null && <> · {text('全服务待写', 'Service pending')}: {value.globalPendingRows.toLocaleString()}</>}</p>
      <p>{text('全服务上次批次提交', 'Last service batch commit')}: {value.lastCommitAt ?? text('尚无记录', 'Not recorded')}<br />{text('最近失败记录（可能已恢复）', 'Last recorded failure (may have recovered)')}: {value.lastFailureAt ?? text('尚无记录', 'Not recorded')}</p>
      {issue && <p>{text('请保留现有服务进程并人工排查；不要自动清空缓冲或重开历史库。', 'Keep the service process available for investigation; do not automatically clear the buffer or reopen storage.')}</p>}
    </>}
    <small>{text('写入状态为全服务共享；按设备只筛选原始采样待写行数，不是解码点位数。待写样本仍在内存，退出可能丢失；不包含被拒写的后续样本。本提示不验证历史完整性或保留清理，刷新不会触发提交、清理或重试。', 'Write state is shared by the service; counts are raw pending rows, not decoded points. Pending samples remain in memory and may be lost on exit; subsequently rejected samples are not counted. This does not verify history completeness or retention cleanup. Refresh never flushes, cleans up or retries writes.')}</small>
  </section>
}
const read = async (url: string, signal: AbortSignal) => { const response = await fetch(url, { signal, cache: 'no-store' }); if (!response.ok) throw new Error('Persistence status read failed'); return response.json() }
export function PersistenceStatus({ objectId = null, english = false, get = read }: { objectId?: number | null; english?: boolean; get?: (url: string, signal: AbortSignal) => Promise<unknown> }) {
  const reader = useMemo(() => new PersistenceStatusRead(objectId), [objectId]), latestGet = useRef(get); latestGet.current = get
  const state = useSyncExternalStore(reader.subscribe, reader.snapshot, reader.snapshot)
  useEffect(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout>
    const poll = async () => { await reader.refresh((url, signal) => latestGet.current(url, signal)); if (!stopped) timer = setTimeout(poll, 15000) }
    void poll(); return () => { stopped = true; clearTimeout(timer); reader.cancel() }
  }, [reader])
  return <PersistenceStatusView state={state} english={english} refresh={() => { void reader.refresh((url, signal) => latestGet.current(url, signal), true) }} />
}
