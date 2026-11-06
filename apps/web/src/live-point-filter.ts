import { alarmMatches, type AlarmRule } from '../../../packages/core/src/alarm'
import { registerWidth } from '../../../packages/core/src/codec'
import { sourceSample, validSlaveId } from '../../../packages/core/src/sample-source'
import { readAlarmValue } from './alarm-value'
import { pointHealth, type Sample } from './observation'
import { filterPickerGroups, type PickerGroup } from './register-picker'

export type LivePointFilter = 'all' | 'attention' | 'alarm' | 'data' | 'unknown'
export const LIVE_POINT_FILTERS: readonly LivePointFilter[] = ['all', 'attention', 'alarm', 'data', 'unknown']
export interface LivePointState { health: ReturnType<typeof pointHealth>; alarmActive: boolean; alarmUnknown: boolean; dataIssue: boolean; attention: boolean }
interface LiveGroup extends PickerGroup { isActive: number; functionCode: number }

/** Same source/word/health and raw-value rule checks as the live row. No rule or sampling mutation. */
export function evaluateLivePoints(groups: readonly LiveGroup[], views: ReadonlyMap<number, { covered: boolean; invalid: boolean }>, latest: Record<string, Sample>, device: { id: number; isActive: number; mode?: string; slaveId?: number }, rules: readonly AlarmRule[], groupErrors: Readonly<Record<number, string>>, now: number, threshold: number): Map<number, LivePointState> {
  const rulesByPoint = new Map<number, AlarmRule[]>()
  for (const rule of rules) { const list = rulesByPoint.get(rule.registerId) ?? []; list.push(rule); rulesByPoint.set(rule.registerId, list) }
  const result = new Map<number, LivePointState>()
  for (const group of groups) {
    const area = group.functionCode === 1 ? 'coil' : group.functionCode === 2 ? 'discrete-input' : group.functionCode === 4 ? 'input-register' : 'holding-register'
    const source = device.mode === 'slave' ? device.slaveId : group.slaveId, paused = !device.isActive || !group.isActive, fault = !!groupErrors[group.id]
    for (const point of group.registers) {
      const words = Array.from({ length: registerWidth(point.dataType) }, (_, i) => validSlaveId(source) ? sourceSample(latest, device.id, area, point.startAddress + i, source) : undefined)
      const health = pointHealth(words, now, threshold, paused, fault), view = views.get(point.id), pointRules = rulesByPoint.get(point.id) ?? []
      const value = !view?.covered && pointRules.length ? readAlarmValue(point.dataType, words, now, threshold, paused, fault) : null
      const alarmActive = value !== null && pointRules.some(rule => alarmMatches(value, rule.operator, rule.threshold))
      const alarmUnknown = !view?.covered && pointRules.length > 0 && value === null
      const dataIssue = !view?.covered && (health.stale || !!view?.invalid)
      result.set(point.id, { health, alarmActive, alarmUnknown, dataIssue, attention: alarmActive || alarmUnknown || dataIssue })
    }
  }
  return result
}

export function matchesLivePointFilter(state: LivePointState | undefined, mode: LivePointFilter): boolean {
  return mode === 'all' || !!state && (mode === 'attention' ? state.attention : mode === 'alarm' ? state.alarmActive : mode === 'data' ? state.dataIssue : state.alarmUnknown)
}

/** Counts use the text/source scope before status filtering. All IDs, including covered rows, remain in All. */
export function livePointFilterResult(groups: readonly PickerGroup[], states: ReadonlyMap<number, LivePointState>, search: string, source: string, mode: LivePointFilter, deviceSlaveId?: number) {
  const counts: Record<LivePointFilter, number> = { all: 0, attention: 0, alarm: 0, data: 0, unknown: 0 }, visibleIds = new Set<number>()
  const candidates = filterPickerGroups(groups, search, source, deviceSlaveId).flatMap(group => group.registers)
  for (const point of candidates) {
    const state = states.get(point.id)
    for (const kind of LIVE_POINT_FILTERS) if (matchesLivePointFilter(state, kind)) counts[kind]++
    if (matchesLivePointFilter(state, mode)) visibleIds.add(point.id)
  }
  return { counts, visibleIds }
}
