export type DraftKind = 'device' | 'live'
export type DraftRange = 'all' | 'live'
export interface DraftStatus { dirty: boolean; busy: boolean }
export interface DraftSnapshot { readonly context: string; readonly text: string }
export interface RetainedDraft { readonly id: number; readonly ownerId: number; readonly kind: DraftKind; readonly busy: boolean | null; readonly snapshot: DraftSnapshot | null; readonly deletion?: boolean }
/** Capture runs on observed removal or deletion preparation; revoke new saves before returning its snapshot. */
export interface DraftRegistration { register(kind: DraftKind, read: () => DraftStatus, capture?: () => DraftSnapshot): () => void; removalPending?: () => boolean }
interface DraftEntry { ownerId: number; kind: DraftKind; read: () => DraftStatus; capture?: () => DraftSnapshot; retained?: boolean; captureFailed?: boolean }

/** Mounted editor ownership plus detached read-only records. Never restores, saves or persists drafts. */
export class DraftNavigation {
  private entries = new Map<symbol, DraftEntry>()
  private removals = new Set<number>()
  private records = new Map<number, RetainedDraft>()
  private sequence = 0
  scope(ownerId: number): DraftRegistration {
    return { removalPending: () => this.removals.has(ownerId), register: (kind, read, capture) => {
      const token = Symbol()
      const entry = { ownerId, kind, read, capture }
      this.entries.set(token, entry)
      if (this.removals.has(ownerId)) this.retain(entry, true)
      return () => { this.entries.delete(token) }
    } }
  }
  /** Run only for an accepted full device list, before React can unmount missing owners. */
  retainMissing(presentIds: readonly number[]): void {
    const present = new Set(presentIds)
    for (const entry of this.entries.values()) {
      if (present.has(entry.ownerId) || entry.retained) continue
      this.retain(entry)
    }
  }
  /** Before dispatch: reject busy/unknown editors, then seal this owner's existing and future editors. */
  beginRemoval(ownerId: number): boolean {
    if (this.removals.has(ownerId) || [...this.entries.values()].some(entry => entry.ownerId === ownerId && entry.captureFailed) || !this.allow(ownerId, 'all', () => true, () => {})) return false
    this.removals.add(ownerId)
    let prepared = true
    for (const entry of this.entries.values()) if (entry.ownerId === ownerId && !entry.retained) prepared = this.retain(entry, true) && prepared
    if (!prepared) this.removals.delete(ownerId)
    return prepared
  }
  removalPending(ownerId: number): boolean { return this.removals.has(ownerId) }
  endRemoval(ownerId: number): void { this.removals.delete(ownerId) }
  private retain(entry: DraftEntry, deletion = false): boolean {
    let busy: boolean | null = null, snapshot: DraftSnapshot | null = null
    let clean = false
    try {
      const state = entry.read()
      if (typeof state?.dirty !== 'boolean' || typeof state?.busy !== 'boolean') throw Error('Unknown draft state')
      clean = !state.dirty && !state.busy
      if (clean && !deletion) return true
      busy = state.busy
      const value = entry.capture?.()
      if (typeof value?.context !== 'string' || typeof value.text !== 'string') throw Error('Snapshot unavailable')
      // Copy strings only: no live props, save callbacks, mutable fields or replacement-device references.
      snapshot = Object.freeze({ context: value.context, text: value.text })
    } catch { /* Preserve an explicit unavailable record, without exposing thrown details or blocking refresh. */ }
    entry.retained = true; entry.captureFailed = !snapshot
    // Even a clean editor must be sealed during deletion; do not create a spurious unsaved-input record.
    if (clean && snapshot) return true
    const id = ++this.sequence
    this.records.set(id, Object.freeze({ id, ownerId: entry.ownerId, kind: entry.kind, busy, snapshot, ...(deletion ? { deletion: true } : {}) }))
    return snapshot !== null
  }
  retained(): readonly RetainedDraft[] { return [...this.records.values()] }
  discardRetained(id: number): void { this.records.delete(id) }
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
