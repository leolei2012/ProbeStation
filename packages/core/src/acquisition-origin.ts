/** Process-local publication condition, not wire identity, persisted provenance or physical authentication. */
export interface AcquisitionOrigin { readonly deviceId: number }
const conditions = new WeakMap<AcquisitionOrigin, () => boolean>()
export function captureAcquisitionOrigin(deviceId: number, current: () => boolean): AcquisitionOrigin {
  if (!Number.isSafeInteger(deviceId) || deviceId < 1) throw new Error('invalid acquisition device')
  const origin = Object.freeze({ deviceId }); conditions.set(origin, current); return origin
}
export function acquisitionOriginMatches(origin: AcquisitionOrigin, deviceId: number): boolean {
  const current = conditions.get(origin)
  try { return !!current && origin.deviceId === deviceId && current() } catch { return false }
}
