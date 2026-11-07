import { pointEnumChanged, type PointEnumDraft } from './point-enum-draft'
import type { PointSettings } from './point-settings'

/** Opening input text is independent of later prop refreshes and validation. */
export function pointDraftFields(settings: PointSettings) {
  return Object.freeze({ dataType: settings.dataType, unit: settings.unit ?? '', factor: String(settings.factor ?? 1), offset: String(settings.offset ?? 0), decimalPlaces: settings.decimalPlaces == null ? '' : String(settings.decimalPlaces) })
}
export type PointDraftFields = ReturnType<typeof pointDraftFields>
export function pointDraftChanged(opening: PointDraftFields, current: PointDraftFields, enums: PointEnumDraft): boolean {
  return (Object.keys(opening) as Array<keyof PointDraftFields>).some(key => opening[key] !== current[key]) || pointEnumChanged(enums)
}
export type PointCloseAction = 'none' | 'prompt' | 'resume' | 'close'
/** Synchronous local intent only: never saves, cancels a write or retries one. */
export class PointDraftCloseGuard {
  private state: 'editing' | 'confirming' | 'closed' = 'editing'
  get confirming() { return this.state === 'confirming' }
  get canSave() { return this.state === 'editing' }
  request(dirty: boolean, busy: boolean): PointCloseAction {
    if (busy || this.state !== 'editing') return 'none'
    if (dirty) { this.state = 'confirming'; return 'prompt' }
    this.state = 'closed'; return 'close'
  }
  resume(busy: boolean): PointCloseAction {
    if (busy || this.state !== 'confirming') return 'none'
    this.state = 'editing'; return 'resume'
  }
  discard(busy: boolean): PointCloseAction {
    if (busy || this.state !== 'confirming') return 'none'
    this.state = 'closed'; return 'close'
  }
  saved(): PointCloseAction {
    if (this.state === 'closed') return 'none'
    this.state = 'closed'; return 'close'
  }
}
