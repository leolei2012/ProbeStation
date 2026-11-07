export interface DeviceRetentionPolicy { readonly version: 1; readonly objectId: number; readonly source: 'global' | 'device' | 'unverified'; readonly seconds: number | null }
export const validRetentionSeconds = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/** Describe configured retention only; does not run cleanup or predict available history. */
export function deviceRetentionPolicy(globalSeconds: number, objectId: number, devices: ReadonlyArray<{ id: number; dataRetainSeconds?: number | null }>): DeviceRetentionPolicy {
  const override = devices.find(device => device.id === objectId)?.dataRetainSeconds
  const source = override == null ? 'global' : 'device', seconds = override == null ? globalSeconds : override
  return Object.freeze({ version: 1, objectId, source: validRetentionSeconds(seconds) ? source : 'unverified', seconds: validRetentionSeconds(seconds) ? seconds : null })
}

/** Old device responses contain only the global default, never proof of an effective device policy. */
export function retentionDisplay(retention: unknown, objectId: number | null): Readonly<{ globalSeconds: number | null; seconds: number | null; source: 'global' | 'device' | 'unverified' }> {
  const row = retention as any, globalSeconds = validRetentionSeconds(row?.retention_seconds) ? row.retention_seconds : null
  const unknown = Object.freeze({ globalSeconds, seconds: null, source: 'unverified' as const })
  if (objectId === null) return globalSeconds === null ? unknown : Object.freeze({ globalSeconds, seconds: globalSeconds, source: 'global' })
  if (!Number.isSafeInteger(objectId) || objectId < 1 || globalSeconds === null) return unknown
  const policy = row?.policy
  if (!policy || policy.version !== 1 || policy.objectId !== objectId || !validRetentionSeconds(policy.seconds) || !['global', 'device'].includes(policy.source)) return unknown
  if (policy.source === 'global' && policy.seconds !== globalSeconds) return unknown
  return Object.freeze({ globalSeconds, seconds: policy.seconds, source: policy.source })
}

/** Exact second resolution. In particular, a short positive duration must never become 0 days. */
export function formatRetentionSeconds(value: unknown, english = false): string {
  if (!validRetentionSeconds(value)) return '—'
  if (value === 0) return english ? 'Forever' : '永久'
  const units = english ? ['d', 'h', 'min', 's'] : ['天', '小时', '分钟', '秒']
  const divisors = [86400, 3600, 60, 1], parts: string[] = []
  let left = value
  for (let i = 0; i < divisors.length; i++) { const count = Math.floor(left / divisors[i]); left %= divisors[i]; if (count > 0) parts.push(`${count} ${units[i]}`) }
  return parts.join(' ')
}
