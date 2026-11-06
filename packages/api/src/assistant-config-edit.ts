import type { ConfigStore } from '../../config/src/index.ts'
import { captureDeviceEditBaseline, type DeviceEditBaseline } from '../../core/src/device-settings-edit.ts'
import { capturePointEditBaseline, type PointEditBaseline } from '../../core/src/point-settings-edit.ts'

export type AssistantTarget = 'device' | 'group' | 'register'
export type AssistantEditGuard = { target: 'device'; expected: DeviceEditBaseline } | { target: 'group'; expectedRevision: string; id: number; deviceId: number } | { target: 'register'; expected: PointEditBaseline }
type Store = Pick<ConfigStore, 'getObject' | 'getGroupSettings' | 'getRegisterSettings' | 'updateObjectSettings' | 'updateGroupSettings' | 'updateRegisterSettings'>
const conflict = (): never => { throw Object.assign(new Error('提案保存条件缺失或配置已变化，请重新发起并核对修改。'), { statusCode: 409 }) }
const compactPoint = (expected: PointEditBaseline) => capturePointEditBaseline({ ...expected.point, enumJson: null }, expected.group, expected.device)
/** Capture the reviewed field and its guard together. Never fetch a new guard at confirmation time. */
export function captureAssistantEdit(cfg: Store, target: AssistantTarget, id: number) {
  if (target === 'device') {
    const row = cfg.getObject(id)
    if (!row) return conflict()
    const expected = captureDeviceEditBaseline(row)
    return { row, deviceId: row.id, guard: { target, expected } as AssistantEditGuard }
  }
  if (target === 'group') {
    const snapshot = cfg.getGroupSettings(id)
    return { row: snapshot.group, deviceId: snapshot.group.objectId, guard: { target, expectedRevision: snapshot.revision, id, deviceId: snapshot.group.objectId } as AssistantEditGuard }
  }
  const expected = compactPoint(cfg.getRegisterSettings(id))
  return { row: expected.point, deviceId: expected.device.id, guard: { target, expected } as AssistantEditGuard }
}
/** Limit persisted proposals too: editing a session file must not widen the tool's single-field scope. */
export function applyAssistantEdit(cfg: Store, target: AssistantTarget, id: number, deviceId: number, field: string, value: unknown, guard: AssistantEditGuard | undefined, undo = false) {
  const allowed = { device: ['name', 'pollIntervalMs', 'timeoutMs'], group: ['name', 'isActive'], register: ['alias', 'unit', 'factor', 'offset'] }
  if (!Object.hasOwn(allowed, target) || !allowed[target].includes(field) || !guard || guard.target !== target) return conflict()
  // NULL is legitimate when undoing an originally empty alias/unit.
  if (['name', 'alias', 'unit'].includes(field) ? !(typeof value === 'string' && (undo || !!value.trim() && value.length <= 120) || field !== 'name' && value === null)
    : field === 'factor' || field === 'offset' ? typeof value !== 'number' || !Number.isFinite(value) || !undo && field === 'factor' && value === 0
    : !Number.isSafeInteger(value) || Number(value) < (field === 'isActive' ? 0 : 1) || Number(value) > (field === 'isActive' ? 1 : 2147483647)) return conflict()
  const changes = { [field]: value }
  if (guard.target === 'device') {
    if (guard.expected?.id !== id || deviceId !== id) return conflict()
    const result = cfg.updateObjectSettings(id, { expected: guard.expected, changes })
    return { guard: { target, expected: captureDeviceEditBaseline(result.device) } as AssistantEditGuard, warnings: result.warnings }
  }
  if (guard.target === 'group') {
    if (guard.id !== id || guard.deviceId !== deviceId) return conflict()
    const result = cfg.updateGroupSettings(id, { expectedRevision: guard.expectedRevision, changes })
    return { guard: { target, id, deviceId, expectedRevision: result.snapshot.revision } as AssistantEditGuard, warnings: result.warnings }
  }
  if (guard.expected?.point.id !== id || guard.expected.device.id !== deviceId || guard.expected.point.objectId !== deviceId) return conflict()
  const result = cfg.updateRegisterSettings(id, { expected: guard.expected, changes })
  return { guard: { target, expected: compactPoint(capturePointEditBaseline(result.point, guard.expected.group, guard.expected.device)) } as AssistantEditGuard, warnings: result.warnings }
}
