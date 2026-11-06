export const HISTORY_QUERY_TIMEOUT_MS = 30_000

export class HistoryQueryTimeoutError extends Error {
  constructor() { super('History query timed out'); this.name = 'HistoryQueryTimeoutError' }
}

/** Cancel the HTTP request and settle even if a provider ignores its abort signal. */
export function runHistoryQuery<T>(fetcher: (signal: AbortSignal) => Promise<T>, signal: AbortSignal, timeoutMs = HISTORY_QUERY_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController()
    let settled = false, timer: ReturnType<typeof setTimeout> | undefined
    const finish = (result: { value: T } | { error: unknown }) => {
      if (settled) return
      settled = true
      clearTimeout(timer); signal.removeEventListener('abort', cancel)
      if ('error' in result) reject(result.error)
      else resolve(result.value)
    }
    const cancel = () => {
      const error = signal.reason ?? new DOMException('Query cancelled', 'AbortError')
      finish({ error }); controller.abort(error)
    }
    if (signal.aborted) { cancel(); return }
    signal.addEventListener('abort', cancel, { once: true })
    timer = setTimeout(() => {
      const error = new HistoryQueryTimeoutError()
      finish({ error }); controller.abort(error)
    }, timeoutMs)
    Promise.resolve().then(() => {
      if (!settled) return fetcher(controller.signal)
    }).then(value => { if (!settled) finish({ value: value as T }) }, error => finish({ error }))
  })
}
