import { acceptGroupEditSnapshot, groupDeletionAcknowledged, parseGroupEditChanges, parseGroupEditSnapshot, planGroupResize, type GroupEditSnapshot, type captureGroupOpening } from '../../../packages/core/src/group-settings-edit'
import { runRequestWithTimeout } from './request-timeout'

/** Valid legacy records have no warnings; malformed success must not encourage a duplicate create. */
export function groupCreateWarnings(value: unknown): readonly string[] {
  const uncertain = () => new Error('创建结果待核实，请核对分组及点位，勿重复创建。')
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw uncertain()
  const result = value as Record<string, unknown>
  if (!Number.isSafeInteger(result.id) || Number(result.id) < 1) throw uncertain()
  if (result.warnings === undefined) return Object.freeze([])
  if (!Array.isArray(result.warnings) || result.warnings.some(item => typeof item !== 'string')) throw uncertain()
  return Object.freeze([...result.warnings] as string[])
}

/** Display filters contain only visible rows; editing must capture the complete configured group. */
export function fullGroupForEditing<T extends { id: number }>(groups: readonly T[], id: number): T {
  const group = groups.find(value => value.id === id)
  if (!group) throw new Error('当前完整点表中未找到分组，请刷新后重新编辑。')
  return group
}

export function readGroupSettings(opening: ReturnType<typeof captureGroupOpening>, get: (url: string, signal: AbortSignal) => Promise<unknown>, signal: AbortSignal, timeoutMs = 30_000) {
  return runRequestWithTimeout(s => get('/api/groups/' + opening.group.id + '/settings', s), signal, timeoutMs, () => new Error('分组快照读取超时，请重试或核对配置。')).then(value => acceptGroupEditSnapshot(value, opening))
}
/** The compact revision binds the complete graph; no raw enum maps are repeated in the write body. */
export async function saveGuardedGroupSettings(snapshot: GroupEditSnapshot, draft: unknown, confirmed: boolean, put: (url: string, body: unknown) => Promise<unknown>) {
  const changes = parseGroupEditChanges(draft, snapshot.group), plan = planGroupResize(snapshot, changes)
  const confirmedDeletion = confirmed ? { registerIds: plan.removeRegisterIds, ruleIds: plan.removeRuleIds } : undefined
  if (!groupDeletionAcknowledged(confirmedDeletion, plan)) throw new Error('请先核对并确认本次将删除的点位和告警。')
  const uncertain = () => new Error('保存结果待核实，请核对分组及点位/告警，勿自动重复保存。')
  let result: any
  try { result = await put('/api/groups/' + snapshot.group.id + '/settings', { expectedRevision: snapshot.revision, changes, ...(confirmedDeletion ? { confirmedDeletion } : {}) }) }
  catch (error) { if (error instanceof Error && /^HTTP (400|403|404|409|413|415)\b/.test(error.message)) throw error; throw uncertain() }
  if (!result || !Array.isArray(result.warnings) || result.warnings.some((v: unknown) => typeof v !== 'string') || !Array.isArray(result.addedRegisterIds)) throw uncertain()
  let saved
  try { saved = parseGroupEditSnapshot(result.snapshot) } catch { throw uncertain() }
  const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  if (!equal(saved.group, { ...snapshot.group, ...changes }) || !equal(saved.device, snapshot.device) || !equal(result.deletedRegisterIds, plan.removeRegisterIds) || !equal(result.deletedRuleIds, plan.removeRuleIds)) throw uncertain()
  const old = new Set(snapshot.registers.map(row => row.id)), removed = new Set(plan.removeRegisterIds), rules = new Set(plan.removeRuleIds)
  const added = saved.registers.filter(row => !old.has(row.id))
  if (!equal(added.map(row => row.id), result.addedRegisterIds) || !equal(added.map(row => row.startAddress), plan.addAddresses) || !equal(saved.registers.filter(row => old.has(row.id)), snapshot.registers.filter(row => !removed.has(row.id))) || !equal(saved.rules, snapshot.rules.filter(rule => !rules.has(rule.id)))) throw uncertain()
  return Object.freeze({ warnings: Object.freeze([...result.warnings] as string[]), added: added.length, deleted: plan.removeRegisterIds.length, deletedRules: plan.removeRuleIds.length })
}
