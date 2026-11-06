import { runHistoryQuery, HISTORY_QUERY_TIMEOUT_MS } from './history-query'

export interface HistoryQueryPlan { url: string; key: string; contextKey: string; revision: number; objectId: number; start: string; end: string; mode: 'table' | 'chart'; page: number; selectionKey: string }
export function historyQueryPlan(input: { objectId: number; start: number; end: number; mode: 'table' | 'chart'; page: number; registerIds: readonly number[]; contextKey?: string; revision?: number }): HistoryQueryPlan | null {
  const start = new Date(input.start).getTime(), end = new Date(input.end).getTime()
  if (!Number.isSafeInteger(input.objectId) || input.objectId < 1 || !Number.isFinite(start) || !Number.isFinite(end) || start >= end || !Number.isSafeInteger(input.page) || input.page < 0 || !['table', 'chart'].includes(input.mode) || !input.registerIds.length || input.registerIds.some(id => !Number.isSafeInteger(id) || id < 1) || input.contextKey !== undefined && typeof input.contextKey !== 'string' || input.revision !== undefined && (!Number.isSafeInteger(input.revision) || input.revision < 0)) return null
  const selectionKey = [...new Set(input.registerIds)].sort((a, b) => a - b).join(',')
  const plan = { objectId: input.objectId, start: new Date(start).toISOString(), end: new Date(end).toISOString(), mode: input.mode, page: input.page, selectionKey }
  const params = new URLSearchParams({ object_id: String(plan.objectId), start: plan.start, end: plan.end, page: String(plan.page), page_size: '200', max_points: '1200', register_ids: selectionKey })
  const url = `/api/data/object/${plan.mode === 'chart' ? 'series' : 'page'}?${params}`, contextKey = input.contextKey ?? '', revision = input.revision ?? 0
  return Object.freeze({ ...plan, url, contextKey, revision, key: JSON.stringify([url, contextKey, revision]) })
}

export type HistoryQueryEvent<T> = { status: 'loading' | 'idle' } | { status: 'done'; data: T; plan: HistoryQueryPlan } | { status: 'error'; error: unknown }
export interface HistoryQueryTask { cancel(): void; dispose(): void }
/** Own the debounce and request together, so cancellation also prevents a queued fetch. */
export function startHistoryQuery<T>(plan: HistoryQueryPlan | null, fetcher: (url: string, signal: AbortSignal) => Promise<T>, changed: (event: HistoryQueryEvent<T>) => void, options: { delayMs?: number; timeoutMs?: number } = {}): HistoryQueryTask {
  const controller = new AbortController()
  let active = true, timer: ReturnType<typeof setTimeout> | undefined
  const stop = (notify: boolean) => {
    if (!active) return
    active = false; clearTimeout(timer); controller.abort()
    if (notify) changed({ status: 'idle' })
  }
  const task = { cancel: () => stop(true), dispose: () => stop(false) }
  if (!plan) { active = false; changed({ status: 'idle' }); return task }
  changed({ status: 'loading' })
  timer = setTimeout(() => {
    if (!active) return
    void runHistoryQuery(signal => fetcher(plan.url, signal), controller.signal, options.timeoutMs ?? HISTORY_QUERY_TIMEOUT_MS).then(data => {
      if (!active) return
      active = false; changed({ status: 'done', data, plan })
    }, error => {
      if (!active) return
      active = false; changed({ status: 'error', error })
    })
  }, options.delayMs ?? 250)
  return task
}
