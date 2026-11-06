export class RequestTimeoutError extends Error {
  constructor() { super('Request timed out'); this.name = 'RequestTimeoutError' }
}

/** Cancel the HTTP request and settle even if a provider ignores its abort signal. */
export function runRequestWithTimeout<T>(fetcher: (signal: AbortSignal) => Promise<T>, signal: AbortSignal, timeoutMs: number, timeoutError: () => Error = () => new RequestTimeoutError()): Promise<T> {
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
      const error = signal.reason ?? new DOMException('Request cancelled', 'AbortError')
      finish({ error }); controller.abort(error)
    }
    if (signal.aborted) { cancel(); return }
    signal.addEventListener('abort', cancel, { once: true })
    timer = setTimeout(() => {
      const error = timeoutError()
      finish({ error }); controller.abort(error)
    }, timeoutMs)
    Promise.resolve().then(() => {
      if (!settled) return fetcher(controller.signal)
    }).then(value => { if (!settled) finish({ value: value as T }) }, error => finish({ error }))
  })
}
