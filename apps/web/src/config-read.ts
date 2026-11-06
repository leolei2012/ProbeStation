/** Metadata reads only; mutations must never be cancelled through this helper. */
export class LatestConfigRead {
  private sequence = 0
  private controller?: AbortController
  cancel() { this.sequence++; this.controller?.abort(); this.controller = undefined }
  async run<T>(fetcher: (signal: AbortSignal) => Promise<T>, accept: (value: T) => void, failed: (error: unknown) => void, isRelevant: () => boolean = () => true) {
    if (!isRelevant()) return
    this.controller?.abort()
    const sequence = ++this.sequence, controller = this.controller = new AbortController()
    const current = () => sequence === this.sequence && !controller.signal.aborted && isRelevant()
    try { const value = await fetcher(controller.signal); if (current()) accept(value) }
    catch (error) { if (current()) failed(error) }
    finally { if (this.controller === controller) this.controller = undefined }
  }
}

export interface GroupMetadata { id: number; name: string; slaveId: number; functionCode: number; startAddress: number; quantity: number; isActive: number }
/** Publish a complete graph only; stop subsequent group requests after cancellation. */
export async function readDeviceGroups<R>(objectId: number, signal: AbortSignal, fetcher: (url: string, signal: AbortSignal) => Promise<unknown>): Promise<Array<GroupMetadata & { registers: R[] }>> {
  signal.throwIfAborted()
  const groups = await fetcher('/api/monitor_objects/' + objectId + '/groups', signal)
  signal.throwIfAborted()
  if (!Array.isArray(groups) || groups.some(group => !group || !Number.isSafeInteger(group.id) || group.id < 1)) throw new Error('Invalid groups response')
  const out: Array<GroupMetadata & { registers: R[] }> = []
  for (const group of groups as GroupMetadata[]) {
    signal.throwIfAborted()
    const registers = await fetcher('/api/groups/' + group.id + '/registers', signal)
    signal.throwIfAborted()
    if (!Array.isArray(registers)) throw new Error('Invalid registers response')
    out.push({ id: group.id, name: group.name, slaveId: group.slaveId, functionCode: group.functionCode, startAddress: group.startAddress, quantity: group.quantity, isActive: group.isActive, registers })
  }
  return out
}
export function groupsForSelection<T>(snapshot: { objectId: number; groups: T[] } | null, selectedId: number | null): T[] {
  return snapshot?.objectId === selectedId ? snapshot.groups : []
}
