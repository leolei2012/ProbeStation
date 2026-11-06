export interface RecordingIntervalNotice { recordingId: string; deviceId: number; state: 'preserved' | 'uncertain'; originalIntervalMs: number; recordingIntervalMs: number; finishedAt: number; warnings: readonly string[] }
export type RecordingIntervalStatus = { available: false; deviceId: number } | { available: true; deviceId: number; checkedAt: number; current: { name: string | null; mode: string | null; intervalMs: number | null } | null; active: readonly { recordingId: string; intervalMs: number }[]; notices: readonly RecordingIntervalNotice[]; retention: { scope: 'process'; limit: number; dropped: number } }
export function parseRecordingIntervalStatus(value: any, deviceId: number): RecordingIntervalStatus {
  const invalid = (): never => { throw new Error('录制间隔核对响应无效，请重新读取。') }
  const positive = (n: unknown) => Number.isSafeInteger(n) && Number(n) > 0
  const time = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 8640000000000000
  if (!positive(deviceId) || !value || value.deviceId !== deviceId || typeof value.available !== 'boolean') return invalid()
  if (!value.available) return Object.freeze({ available: false, deviceId })
  const { current, retention } = value
  if (!time(value.checkedAt) || !retention || retention.scope !== 'process' || !positive(retention.limit) || !Number.isSafeInteger(retention.dropped) || retention.dropped < 0 || !Array.isArray(value.active) || !Array.isArray(value.notices) || value.notices.length > retention.limit) return invalid()
  if (current !== null && (!current || ![current.name, current.mode].every(v => v === null || typeof v === 'string') || current.intervalMs !== null && (typeof current.intervalMs !== 'number' || !Number.isFinite(current.intervalMs)))) return invalid()
  const active = value.active.map((row: any) => { if (!row || typeof row.recordingId !== 'string' || !row.recordingId || !positive(row.intervalMs)) return invalid(); return Object.freeze({ recordingId: row.recordingId, intervalMs: row.intervalMs }) })
  const notices = value.notices.map((row: any) => {
    if (!row || row.deviceId !== deviceId || typeof row.recordingId !== 'string' || !row.recordingId || !['preserved', 'uncertain'].includes(row.state) || !positive(row.originalIntervalMs) || !positive(row.recordingIntervalMs) || !time(row.finishedAt) || !Array.isArray(row.warnings) || row.warnings.some((message: unknown) => typeof message !== 'string')) return invalid()
    return Object.freeze({ recordingId: row.recordingId, deviceId, state: row.state as RecordingIntervalNotice['state'], originalIntervalMs: row.originalIntervalMs, recordingIntervalMs: row.recordingIntervalMs, finishedAt: row.finishedAt, warnings: Object.freeze([...row.warnings]) })
  })
  return Object.freeze({ available: true, deviceId, checkedAt: value.checkedAt, current: current && Object.freeze({ name: current.name, mode: current.mode, intervalMs: current.intervalMs }), active: Object.freeze(active), notices: Object.freeze(notices), retention: Object.freeze({ scope: 'process', limit: retention.limit, dropped: retention.dropped }) })
}
