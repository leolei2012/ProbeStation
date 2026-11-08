import type { Context } from 'cordis'

const dependents = new WeakMap<object, Set<() => Promise<void>>>()
/** Preserve the original error identity; report all failures when several cleanup stages fail. */
export function throwCleanupErrors(errors: unknown[], message: string): void {
  const unique = [...new Set(errors)]
  if (unique.length === 1) throw unique[0]
  if (unique.length > 1) throw new AggregateError(unique, message)
}
export async function closeResourceDependents(owner: object): Promise<unknown[]> {
  const tasks = [...(dependents.get(owner) ?? [])]
  const results = await Promise.allSettled(tasks.map(stop => stop()))
  return results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
}
/** Explicit resource identities, independent of Cordis's concurrent root disposal. No I/O or timers. */
export function registerResourceCleanup(ctx: Context, owners: unknown[], cleanup: () => void | Promise<void>): () => Promise<void> {
  let task: Promise<void> | undefined
  const stop = () => task ??= Promise.resolve().then(cleanup)
  const sets = [...new Set(owners.filter((owner): owner is object => owner !== null && (typeof owner === 'object' || typeof owner === 'function')))].map(owner => {
    let set = dependents.get(owner)
    if (!set) dependents.set(owner, set = new Set())
    set.add(stop); return set
  })
  ctx.effect?.(() => async () => {
    await stop()
    for (const set of sets) set.delete(stop)
  })
  return stop
}
