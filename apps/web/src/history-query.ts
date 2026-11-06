import { runRequestWithTimeout } from './request-timeout'

export const HISTORY_QUERY_TIMEOUT_MS = 30_000

export class HistoryQueryTimeoutError extends Error {
  constructor() { super('History query timed out'); this.name = 'HistoryQueryTimeoutError' }
}

/** History keeps its existing deadline and error type on the shared request lifecycle. */
export function runHistoryQuery<T>(fetcher: (signal: AbortSignal) => Promise<T>, signal: AbortSignal, timeoutMs = HISTORY_QUERY_TIMEOUT_MS): Promise<T> {
  return runRequestWithTimeout(fetcher, signal, timeoutMs, () => new HistoryQueryTimeoutError())
}
