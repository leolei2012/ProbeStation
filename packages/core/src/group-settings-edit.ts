import { captureDeviceEditBaseline, type DeviceEditBaseline } from './device-settings-edit.ts'

export interface GroupEditGroup { readonly id: number; readonly objectId: number; readonly name: string; readonly slaveId: number; readonly functionCode: number; readonly startAddress: number; readonly quantity: number; readonly mode: string; readonly isActive: number }
export interface GroupEditPoint { readonly id: number; readonly objectId: number; readonly groupId: number; readonly alias: string | null; readonly functionCode: number; readonly startAddress: number; readonly quantity: number; readonly dataType: string; readonly unit: string | null; readonly factor: number; readonly offset: number; readonly enumJson: string | null; readonly decimalPlaces: number | null }
export interface GroupEditRule { readonly id: number; readonly registerId: number; readonly operator: string; readonly threshold: number; readonly message: string | null }
export interface GroupEditGraph { readonly group: GroupEditGroup; readonly device: DeviceEditBaseline; readonly registers: readonly GroupEditPoint[]; readonly rules: readonly GroupEditRule[] }
export interface GroupEditSnapshot extends GroupEditGraph { readonly revision: string }
export type GroupEditChanges = Partial<Pick<GroupEditGroup, 'name' | 'slaveId' | 'functionCode' | 'startAddress' | 'quantity' | 'isActive'>>
const editable = ['name', 'slaveId', 'functionCode', 'startAddress', 'quantity', 'isActive'] as const
const groupKeys = ['id', 'objectId', 'name', 'slaveId', 'functionCode', 'startAddress', 'quantity', 'mode', 'isActive'] as const
const pointKeys = ['id', 'objectId', 'groupId', 'alias', 'functionCode', 'startAddress', 'quantity', 'dataType', 'unit', 'factor', 'offset', 'enumJson', 'decimalPlaces'] as const
const ruleKeys = ['id', 'registerId', 'operator', 'threshold', 'message'] as const
export const groupEditInvalid = (): never => { throw Object.assign(new Error('分组编辑参数或快照无效，请核对配置。'), { statusCode: 400 }) }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) return groupEditInvalid(); return value as Record<string, unknown> }
function pick(value: unknown, keys: readonly string[], text: readonly string[], nullable: readonly string[]) {
  const source = object(value), result: Record<string, unknown> = {}
  for (const key of keys) {
    const item = key === 'decimalPlaces' && source[key] === undefined ? null : source[key]
    if (!(nullable.includes(key) && item === null || (text.includes(key) ? typeof item === 'string' : typeof item === 'number' && Number.isFinite(item)))) return groupEditInvalid()
    if (['id', 'objectId', 'groupId', 'registerId'].includes(key) && (!Number.isSafeInteger(item) || Number(item) < 1)) return groupEditInvalid()
    result[key] = item
  }
  return Object.freeze(result)
}
export function captureGroupEditGraph(value: unknown): GroupEditGraph {
  const raw = object(value), group = pick(raw.group, groupKeys, ['name', 'mode'], []) as unknown as GroupEditGroup, device = captureDeviceEditBaseline(raw.device)
  if (!Array.isArray(raw.registers) || !Array.isArray(raw.rules) || group.objectId !== device.id) return groupEditInvalid()
  const registers = raw.registers.map(row => pick(row, pointKeys, ['alias', 'dataType', 'unit', 'enumJson'], ['alias', 'unit', 'enumJson', 'decimalPlaces']) as unknown as GroupEditPoint)
  const rules = raw.rules.map(row => pick(row, ruleKeys, ['operator', 'message'], ['message']) as unknown as GroupEditRule).sort((a, b) => a.id - b.id)
  const ids = new Set(registers.map(row => row.id))
  if (ids.size !== registers.length || new Set(rules.map(row => row.id)).size !== rules.length || registers.some(row => row.groupId !== group.id || row.objectId !== device.id) || rules.some(rule => !ids.has(rule.registerId))) return groupEditInvalid()
  return Object.freeze({ group, device, registers: Object.freeze(registers), rules: Object.freeze(rules) })
}
export function parseGroupEditSnapshot(value: unknown): GroupEditSnapshot {
  const raw = object(value), graph = captureGroupEditGraph(raw)
  if (typeof raw.revision !== 'string' || !/^v1:[a-f0-9]{64}$/.test(raw.revision)) return groupEditInvalid()
  return Object.freeze({ ...graph, revision: raw.revision })
}
/** No rule snapshot exists in the table: the opening GET must present rules before deletion can be acknowledged. */
export function captureGroupOpening(initial: unknown, device: unknown) {
  const group = object(initial), graph = captureGroupEditGraph({ group: { ...group, objectId: object(device).id }, device, registers: group.registers, rules: [] })
  return Object.freeze({ group: graph.group, device: graph.device, registers: graph.registers })
}
export function acceptGroupEditSnapshot(value: unknown, opening: ReturnType<typeof captureGroupOpening>): GroupEditSnapshot {
  const snapshot = parseGroupEditSnapshot(value)
  if (JSON.stringify({ group: snapshot.group, device: snapshot.device, registers: snapshot.registers }) !== JSON.stringify(opening)) throw Object.assign(new Error('打开时的分组或点位已变化，未加载新的保存条件。请关闭并刷新配置后重新编辑。'), { statusCode: 409 })
  return snapshot
}
export function parseGroupEditChanges(value: unknown, group: GroupEditGroup): GroupEditChanges {
  const raw = object(value), entries = Object.entries(raw)
  if (!entries.length || entries.some(([key]) => !(editable as readonly string[]).includes(key))) return groupEditInvalid()
  const next = { ...group, ...raw }, integer = (n: unknown, min: number, max: number) => typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= max
  if (typeof next.name !== 'string' || !next.name.trim() || !integer(next.slaveId, 0, 247) || ![1, 2, 3, 4].includes(next.functionCode) || !integer(next.startAddress, 0, 65535) || !integer(next.quantity, 1, 65536 - next.startAddress) || ![0, 1].includes(next.isActive)) return groupEditInvalid()
  return Object.freeze(Object.fromEntries(entries)) as GroupEditChanges
}
/** Mirror the existing definition-count policy, including duplicate-address expansion behavior. */
export function planGroupResize(graph: GroupEditGraph, changes: GroupEditChanges) {
  const next = { ...graph.group, ...changes }, removeRegisterIds: number[] = [], addAddresses: number[] = []
  if (!Number.isSafeInteger(next.startAddress) || next.startAddress < 0 || !Number.isSafeInteger(next.quantity) || next.quantity < 1 || next.startAddress + next.quantity > 65536) return groupEditInvalid()
  if (changes.quantity !== undefined && next.quantity !== graph.group.quantity) {
    if (graph.registers.length > next.quantity) removeRegisterIds.push(...graph.registers.slice(next.quantity).map(row => row.id))
    else if (graph.registers.length < next.quantity) {
      const existing = new Set(graph.registers.map(row => row.startAddress))
      let address = next.startAddress
      while (existing.size < next.quantity) { if (!existing.has(address)) { existing.add(address); addAddresses.push(address) }; address++ }
    }
  }
  const deleted = new Set(removeRegisterIds), removeRuleIds = graph.rules.filter(rule => deleted.has(rule.registerId)).map(rule => rule.id)
  return Object.freeze({ removeRegisterIds: Object.freeze(removeRegisterIds), removeRuleIds: Object.freeze(removeRuleIds), addAddresses: Object.freeze(addAddresses) })
}
export function groupDeletionAcknowledged(value: unknown, plan: ReturnType<typeof planGroupResize>) {
  if (!plan.removeRegisterIds.length && !plan.removeRuleIds.length) return value === undefined || JSON.stringify(value) === JSON.stringify({ registerIds: [], ruleIds: [] })
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  return Object.keys(raw).length === 2 && JSON.stringify(raw.registerIds) === JSON.stringify(plan.removeRegisterIds) && JSON.stringify(raw.ruleIds) === JSON.stringify(plan.removeRuleIds)
}
