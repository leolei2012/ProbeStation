/** Request a browser-controlled warning only. No custom dialog, persistence or write cancellation. */
export function bindBeforeUnload(target: Pick<Window, 'addEventListener' | 'removeEventListener'>, active: boolean, shouldWarn: () => boolean) {
  if (!active) return
  const handler = (event: BeforeUnloadEvent) => {
    let warn = true
    try { warn = shouldWarn() } catch { /* Unknown risk: request a warning without exposing draft data. */ }
    if (warn) { event.preventDefault(); event.returnValue = ' ' }
  }
  target.addEventListener('beforeunload', handler)
  return () => target.removeEventListener('beforeunload', handler)
}
