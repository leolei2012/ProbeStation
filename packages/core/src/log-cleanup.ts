export interface LogCleanupPreview { readonly version: 1; readonly throughId: number; readonly count: number; readonly revision: string }
export interface LogCleanupResult { readonly ok: true; readonly throughId: number; readonly revision: string; readonly deleted: number; readonly alreadyRemoved: number; readonly remaining: number }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
export const invalidLogCleanup = (): never => { throw Object.assign(new Error('日志清理条件无效，请重新预览。'), { statusCode: 400 }) }
export function parseLogCleanupPreview(input: unknown): LogCleanupPreview {
  if (!object(input) || Object.keys(input).some(key => !['version', 'throughId', 'count', 'revision'].includes(key)) || input.version !== 1 || !count(input.throughId) || !count(input.count) || (input.count === 0) !== (input.throughId === 0) || input.count > input.throughId || typeof input.revision !== 'string' || !/^v1:[a-f0-9]{64}$/.test(input.revision)) return invalidLogCleanup()
  return Object.freeze({ version: 1, throughId: input.throughId, count: input.count, revision: input.revision })
}
export function parseLogCleanupRequest(input: unknown): LogCleanupPreview {
  if (!object(input) || Object.keys(input).some(key => key !== 'expected')) return invalidLogCleanup()
  const expected = parseLogCleanupPreview(input.expected)
  if (!expected.count) return invalidLogCleanup()
  return expected
}
export function parseLogCleanupResult(input: unknown, expected: LogCleanupPreview): LogCleanupResult {
  if (!object(input) || input.ok !== true || input.throughId !== expected.throughId || input.revision !== expected.revision || !count(input.deleted) || !count(input.alreadyRemoved) || !count(input.remaining) || input.deleted > expected.count || input.alreadyRemoved !== expected.count - input.deleted) return invalidLogCleanup()
  return Object.freeze({ ok: true, throughId: expected.throughId, revision: expected.revision, deleted: input.deleted, alreadyRemoved: input.alreadyRemoved, remaining: input.remaining })
}
