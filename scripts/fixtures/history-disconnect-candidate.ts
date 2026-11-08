import type { EventEmitter } from 'node:events'

// Experiment only: public event/state surfaces, not installed into the API or an HTTP server.
export function candidateDisconnectSignal(request: EventEmitter & { complete: boolean; destroyed?: boolean }, response: EventEmitter & { writableFinished: boolean; destroyed?: boolean }) {
  const controller = new AbortController()
  let disposed = false
  const dispose = () => { if (disposed) return; disposed = true; request.removeListener('close', requestClose); response.removeListener('close', responseClose); response.removeListener('finish', dispose) }
  const abort = () => { if (!controller.signal.aborted) controller.abort(new DOMException('Candidate HTTP connection closed before response finish', 'AbortError')); dispose() }
  const requestClose = () => { if (!request.complete) abort() }
  const responseClose = () => { if (!response.writableFinished) abort(); else dispose() }
  request.on('close', requestClose); response.on('close', responseClose); response.on('finish', dispose)
  if (request.destroyed && !request.complete || response.destroyed && !response.writableFinished) abort()
  return { signal: controller.signal, dispose }
}
