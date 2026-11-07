export type PersistencePhase = 'initializing' | 'switching' | 'ready' | 'failed' | 'blocked'
export type PersistenceFailure = 'initialization-failed' | 'flush-failed' | 'write-uncertain' | null
export type SamplePersistenceStatus = Readonly<{ version: 1; available: false; objectId: number | null }> | Readonly<{
  version: 1; available: true; objectId: number | null; stateScope: 'service'; checkedAt: string
  phase: PersistencePhase; failure: PersistenceFailure; flushing: boolean
  pendingRows: number; globalPendingRows: number; lastCommitAt: string | null; lastFailureAt: string | null
}>
export class InvalidPersistenceStatusError extends Error { constructor() { super('Invalid sample persistence status'); this.name = 'InvalidPersistenceStatusError' } }
const invalid = (): never => { throw new InvalidPersistenceStatusError() }
const time = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d\d-\d\dT.*Z$/.test(value) && Number.isFinite(Date.parse(value))
export function parseSamplePersistence(value: unknown, objectId: number | null): SamplePersistenceStatus {
  if (objectId !== null && (!Number.isSafeInteger(objectId) || objectId < 1)) return invalid()
  const row = value as any
  if (!row || typeof row !== 'object' || Array.isArray(row) || row.version !== 1 || row.objectId !== objectId) return invalid()
  if (row.available === false) return Object.freeze({ version: 1, available: false, objectId })
  if (row.available !== true || row.stateScope !== 'service' || !time(row.checkedAt) || !['initializing', 'switching', 'ready', 'failed', 'blocked'].includes(row.phase) || ![null, 'initialization-failed', 'flush-failed', 'write-uncertain'].includes(row.failure) || typeof row.flushing !== 'boolean') return invalid()
  if (![row.pendingRows, row.globalPendingRows].every(v => Number.isSafeInteger(v) && v >= 0) || row.pendingRows > row.globalPendingRows || objectId === null && row.pendingRows !== row.globalPendingRows) return invalid()
  if (![row.lastCommitAt, row.lastFailureAt].every(v => v === null || time(v))) return invalid()
  if (row.phase === 'ready' && row.failure !== null || row.phase === 'initializing' && row.failure !== null || row.phase === 'failed' && row.failure !== 'flush-failed' || row.phase === 'blocked' && !['initialization-failed', 'write-uncertain'].includes(row.failure)) return invalid()
  return Object.freeze({ version: 1, available: true, objectId, stateScope: 'service', checkedAt: row.checkedAt, phase: row.phase, failure: row.failure, flushing: row.flushing, pendingRows: row.pendingRows, globalPendingRows: row.globalPendingRows, lastCommitAt: row.lastCommitAt, lastFailureAt: row.lastFailureAt })
}
