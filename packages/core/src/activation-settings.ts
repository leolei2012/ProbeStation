import { captureDeviceEditBaseline, type DeviceEditBaseline } from './device-settings-edit.ts'
import { captureGroupEditGraph, type GroupEditGroup } from './group-settings-edit.ts'

export type ActivationKind = 'device' | 'group'
export interface ActivationSnapshot { readonly device: DeviceEditBaseline; readonly group: GroupEditGroup | null; readonly isActive: 0 | 1 }
const invalid = (): never => { throw Object.assign(new Error('开关配置或条件无效，请刷新核对。'), { statusCode: 400 }) }
const object = (value: unknown): Record<string, unknown> => { if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid(); return value as Record<string, unknown> }
function flag(value: unknown): 0 | 1 { if (value !== 0 && value !== 1) return invalid(); return value }

/** Configuration only: connection health and parent activation do not prove a group is running. */
export function captureActivation(device: unknown, group?: unknown): ActivationSnapshot {
  const baseline = captureDeviceEditBaseline(device)
  if (group === undefined) return Object.freeze({ device: baseline, group: null, isActive: flag(object(device).isActive) })
  const graph = captureGroupEditGraph({ device: baseline, group, registers: [], rules: [] })
  return Object.freeze({ device: baseline, group: graph.group, isActive: flag(graph.group.isActive) })
}
export function parseActivationSnapshot(value: unknown, kind: ActivationKind): ActivationSnapshot {
  if (kind !== 'device' && kind !== 'group') return invalid()
  const raw = object(value)
  if (kind === 'group' && raw.group === undefined) return invalid()
  if (Object.keys(raw).some(key => !['device', 'group', 'isActive'].includes(key))) return invalid()
  const snapshot = kind === 'device' ? raw.group === null ? captureActivation({ ...object(raw.device), isActive: raw.isActive }) : invalid() : captureActivation(raw.device, raw.group)
  if (snapshot.isActive !== flag(raw.isActive)) return invalid()
  return snapshot
}
export function parseActivationRequest(value: unknown, kind: ActivationKind, id: number) {
  const raw = object(value), expected = parseActivationSnapshot(raw.expected, kind), isActive = flag(raw.isActive)
  if (!Number.isSafeInteger(id) || id < 1 || (kind === 'device' ? expected.device.id : expected.group!.id) !== id || Object.keys(raw).some(key => !['expected', 'isActive'].includes(key)) || isActive === expected.isActive) return invalid()
  return Object.freeze({ expected, isActive })
}
export function activationTarget(expected: ActivationSnapshot, isActive: 0 | 1): ActivationSnapshot {
  return Object.freeze({ ...expected, group: expected.group ? Object.freeze({ ...expected.group, isActive }) : null, isActive })
}
export function activationMatches(a: ActivationSnapshot, b: ActivationSnapshot): boolean { return JSON.stringify(a) === JSON.stringify(b) }
