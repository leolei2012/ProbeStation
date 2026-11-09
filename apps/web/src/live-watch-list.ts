/** Small, local display selection; never changes sampling, rules or configuration. */
export const LIVE_WATCH_LIMIT = 32
export interface LiveWatchSelection { readonly scope: symbol; readonly ids: readonly number[] }
export function captureLiveWatch(scope: symbol | null, ids: ReadonlySet<number>, groups: readonly { registers: readonly { id: number }[] }[]): LiveWatchSelection | null {
  if (!scope || !ids.size || ids.size > LIVE_WATCH_LIMIT) return null
  const counts = new Map<number, number>()
  for (const group of groups) for (const point of group.registers) counts.set(point.id, (counts.get(point.id) ?? 0) + 1)
  if ([...ids].some(id => !Number.isSafeInteger(id) || id < 1 || counts.get(id) !== 1)) return null
  return Object.freeze({ scope, ids: Object.freeze([...ids]) })
}
export function liveWatchResult(selection: LiveWatchSelection | null, scope: symbol | null, only: boolean, matches: ReadonlySet<number>) {
  const status = !scope ? 'unverified' : !selection ? 'empty' : selection.scope !== scope ? 'changed' : 'ready'
  const ids = new Set(status === 'ready' ? selection!.ids : [])
  // Callers only read this set. Preserve the full scope without copying when off;
  // a watch-only intersection needs at most 32 membership checks, not a table scan.
  const visibleIds = only ? new Set([...ids].filter(id => matches.has(id))) : matches
  return { status, ids, visibleIds, matching: [...ids].filter(id => matches.has(id)).length }
}
