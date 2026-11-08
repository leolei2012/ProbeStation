import { activationMatches, activationTarget, parseActivationRequest, parseActivationSnapshot, type ActivationSnapshot } from '../../../packages/core/src/activation-settings.ts'

export class ActivationUncertainError extends Error {
  constructor() { super('开关结果待核实，可能已生效。请先刷新核对，勿直接重复切换。'); this.name = 'ActivationUncertainError' }
}
/** One explicit, conditional SET. A missing new endpoint never falls back to the old inverse operation. */
export async function saveActivation(expected: ActivationSnapshot, isActive: 0 | 1, put: (url: string, body: unknown) => Promise<unknown>, refresh: () => void): Promise<readonly string[]> {
  const kind = expected.group ? 'group' : 'device', id = expected.group?.id ?? expected.device.id
  const request = parseActivationRequest({ expected, isActive }, kind, id)
  let result: any
  try { result = await put((kind === 'device' ? '/api/monitor_objects/' : '/api/groups/') + id + '/activation', request) }
  catch (error) { if (error instanceof Error && /^HTTP (400|403|404|409|413|415)\b/.test(error.message)) throw error; throw new ActivationUncertainError() }
  let saved
  try { saved = parseActivationSnapshot(result?.snapshot, kind) } catch { throw new ActivationUncertainError() }
  if (!activationMatches(saved, activationTarget(request.expected, isActive)) || !Array.isArray(result.warnings) || result.warnings.some((value: unknown) => typeof value !== 'string')) throw new ActivationUncertainError()
  const warnings: string[] = [...result.warnings]
  try { refresh() } catch { warnings.push('开关配置已保存，但界面刷新未完成；请刷新核对，勿重复切换。') }
  return Object.freeze(warnings)
}
