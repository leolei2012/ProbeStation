import assert from 'node:assert/strict'

/** Simulated event API, never a real browser or a page close. */
export function unloadTarget() {
  const listeners = new Set<(event: any) => void>()
  return {
    addEventListener(type: string, listener: any) { assert.equal(type, 'beforeunload'); listeners.add(listener) },
    removeEventListener(type: string, listener: any) { assert.equal(type, 'beforeunload'); listeners.delete(listener) },
    count: () => listeners.size,
    fire() { const event = { prevented: 0, returnValue: '', preventDefault() { this.prevented++ } }; for (const listener of [...listeners]) listener(event); return event },
  }
}
