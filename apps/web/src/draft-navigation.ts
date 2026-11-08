export type DraftKind = 'device' | 'live'
export type DraftRange = 'all' | 'live'
export interface DraftStatus { dirty: boolean; busy: boolean }
export interface DraftRegistration { register(kind: DraftKind, read: () => DraftStatus): () => void }

/** Current mounted editors only. No draft values, persistent storage or navigation side effects. */
export class DraftNavigation {
  private entries = new Map<symbol, { ownerId: number; kind: DraftKind; read: () => DraftStatus }>()
  scope(ownerId: number): DraftRegistration {
    return { register: (kind, read) => {
      const token = Symbol()
      this.entries.set(token, { ownerId, kind, read })
      return () => { this.entries.delete(token) }
    } }
  }
  allow(ownerId: number | null, range: DraftRange, confirm: () => boolean, blocked: () => void): boolean {
    if (ownerId === null) return true
    let statuses: DraftStatus[]
    try {
      statuses = [...this.entries.values()].filter(entry => entry.ownerId === ownerId && (range === 'all' || entry.kind === 'live')).map(entry => entry.read())
      if (statuses.some(state => typeof state?.dirty !== 'boolean' || typeof state?.busy !== 'boolean')) throw Error('Draft state unavailable')
    } catch { blocked(); return false }
    if (statuses.some(state => state.busy)) { blocked(); return false }
    if (!statuses.some(state => state.dirty)) return true
    // One confirmation per navigation intent, shared by all affected editors. Never cache consent.
    try { return confirm() === true } catch { blocked(); return false }
  }
}
