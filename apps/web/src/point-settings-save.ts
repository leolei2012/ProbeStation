import { capturePointEditBaseline, parsePointEditRequest, type PointEditBaseline, type PointEditChanges } from '../../../packages/core/src/point-settings-edit'

/** One write, no automatic retry or fallback to an older unguarded endpoint. */
export async function saveGuardedPointSettings(expected: PointEditBaseline, changes: PointEditChanges, put: (url: string, body: unknown) => Promise<unknown>): Promise<readonly string[]> {
  // The enum is not a precondition when omitted from changes. Do not resend a potentially huge opaque source.
  const wireExpected = Object.hasOwn(changes, 'enumJson') ? expected : { ...expected, point: { ...expected.point, enumJson: null } }
  const request = parsePointEditRequest({ expected: wireExpected, changes })
  const result = await put('/api/registers/' + expected.point.id + '/settings', request) as any
  const uncertain = () => new Error('保存结果待核实，请核对配置，勿自动重复保存。')
  if (!result || !Array.isArray(result.warnings) || result.warnings.some((value: unknown) => typeof value !== 'string')) throw uncertain()
  let saved
  try { saved = capturePointEditBaseline(result.point, expected.group, expected.device).point } catch { throw uncertain() }
  if (saved.id !== expected.point.id || Object.entries(request.changes).some(([key, value]) => saved[key as keyof typeof saved] !== value)) throw uncertain()
  return Object.freeze([...result.warnings])
}
