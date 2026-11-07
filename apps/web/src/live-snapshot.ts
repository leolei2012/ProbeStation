import { registerWidth } from '../../../packages/core/src/codec'
import { sourceSample, validSlaveId } from '../../../packages/core/src/sample-source'
import type { Sample } from './observation'
import type { LivePointState } from './live-point-filter'

export interface SnapshotPoint { id: number; alias: string | null; startAddress: number; functionCode: number; dataType: string; factor?: number | null; offset?: number | null; unit?: string | null; decimalPlaces?: number | null }
export interface SnapshotGroup { id: number; name: string; slaveId?: number; isActive: number; functionCode: number; registers: readonly SnapshotPoint[] }
export interface SnapshotView { value: string; label: string | null; covered: boolean; invalid: boolean; physical?: { value: string | null; issue?: string } }
interface CaptureInput {
  device: { id: number; name: string; mode: string; isActive: number; slaveId?: number }
  groups: readonly SnapshotGroup[]; visibleIds: ReadonlySet<number>; views: ReadonlyMap<number, SnapshotView>; states: ReadonlyMap<number, LivePointState>
  latest: Record<string, Sample>; filters: { search: string; source: string; mode: string }; rulesReady: boolean; observedAt: number; capturedAt: number; thresholdMs: number
}
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null
const scalar = (value: unknown): number | string | null => typeof value === 'number' ? Number.isFinite(value) ? value : String(value) : null
const areaOf = (fc: number) => fc === 1 ? 'coil' : fc === 2 ? 'discrete-input' : fc === 4 ? 'input-register' : 'holding-register'
export function captureLiveSnapshot(input: CaptureInput) {
  const { device } = input
  if (!Number.isSafeInteger(device.id) || device.id < 1 || !Number.isFinite(input.thresholdMs) || input.thresholdMs < 0 || !input.visibleIds.size) throw new Error('没有可冻结的实时筛选结果。')
  const capturedAt = new Date(input.capturedAt).toISOString(), observedAt = new Date(input.observedAt).toISOString(), ids = new Set<number>()
  const points = input.groups.flatMap(group => group.registers.filter(point => input.visibleIds.has(point.id)).map(point => {
    if (!Number.isSafeInteger(point.id) || point.id < 1 || ids.has(point.id)) throw new Error('点位身份有歧义，请刷新配置后重试。')
    ids.add(point.id)
    const view = input.views.get(point.id), state = input.states.get(point.id)
    if (!view || !state) throw new Error('点位显示状态尚未完整，请刷新后重试。')
    const source = device.mode === 'slave' ? device.slaveId : group.slaveId, slaveId = validSlaveId(source) ? source : null, area = areaOf(group.functionCode), width = registerWidth(point.dataType)
    const words = Object.freeze(Array.from({ length: width }, (_, index) => {
      const address = point.startAddress + index, sample = slaveId === null ? undefined : sourceSample(input.latest, device.id, area, address, slaveId)
      if (!sample) return Object.freeze({ address, sample: null })
      const rawValue = finite(sample.rawValue), numericIssue = rawValue === null ? typeof sample.rawValue === 'number' ? 'non-finite' : 'not-number' : !Number.isInteger(rawValue) || rawValue < 0 || rawValue > (area === 'coil' || area === 'discrete-input' ? 1 : 65535) ? 'outside-word-domain' : null
      return Object.freeze({ address, sample: Object.freeze({ rawValue, rawValueText: rawValue === null && (typeof sample.rawValue === 'number' || typeof sample.rawValue === 'string') ? String(sample.rawValue) : null, numericIssue,
        quality: typeof sample.quality === 'string' ? sample.quality : null, timestamp: typeof sample.timestamp === 'string' ? sample.timestamp : null, timestampMs: finite(sample.timestampMs), batchId: typeof sample.batchId === 'string' ? sample.batchId : null, slaveId: validSlaveId(sample.slaveId) ? sample.slaveId : null }) })
    }))
    const present = words.every(word => word.sample !== null), batches = words.map(word => word.sample?.batchId)
    const batchRelationship = !present ? 'incomplete' : width === 1 ? 'single-word' : batches.every(id => typeof id === 'string' && id.length > 0 && id === batches[0]) ? 'complete-same-batch-id' : batches.every(id => id == null) ? 'legacy-unverified' : 'mixed-or-missing-batch-id'
    return Object.freeze({ id: point.id, groupId: group.id, groupName: group.name, alias: point.alias, configuredSlaveId: slaveId, groupActive: !!group.isActive,
      definition: Object.freeze({ functionCode: point.functionCode, groupFunctionCode: group.functionCode, area, address: point.startAddress, dataType: point.dataType, width, factor: scalar(point.factor), offset: scalar(point.offset), unit: point.unit ?? null, decimalPlaces: scalar(point.decimalPlaces) }),
      display: Object.freeze({ raw: view.covered || view.invalid ? null : view.value, physical: view.covered || view.invalid ? null : view.physical?.value ?? null, physicalIssue: view.physical?.issue ?? null, label: view.label, covered: view.covered, invalid: view.invalid }),
      health: Object.freeze({ missing: state.health.missing, stale: state.health.stale, timestampMs: finite(state.health.timestamp), ageSeconds: finite(state.health.ageSeconds) }),
      observedAlarm: Object.freeze({ active: state.alarmActive, unknown: state.alarmUnknown, rulesReady: input.rulesReady }), batchRelationship, words })
  }))
  if (points.length !== input.visibleIds.size) throw new Error('筛选或点表已变化，请重新冻结。')
  return Object.freeze({ format: 'probestation-live-snapshot' as const, version: 1 as const, capturedAt, observedAt, automaticEligible: false as const,
    device: Object.freeze({ id: device.id, name: device.name, mode: device.mode, active: !!device.isActive }),
    scope: Object.freeze({ kind: 'current-filter' as const, search: input.filters.search, source: input.filters.source, mode: input.filters.mode, capturedPoints: points.length, availablePoints: input.groups.reduce((sum, group) => sum + group.registers.length, 0), includesCollapsedAndVirtualRows: true }),
    thresholdMs: input.thresholdMs, points: Object.freeze(points) })
}
export type LiveSnapshot = ReturnType<typeof captureLiveSnapshot>
export const liveSnapshotJson = (snapshot: LiveSnapshot) => JSON.stringify(snapshot, null, 2)
export const liveSnapshotFilename = (snapshot: LiveSnapshot) => `live-snapshot-device-${snapshot.device.id}-${snapshot.capturedAt.replace(/[:.]/g, '-')}.json`
/** Local download only; injected adapters allow offline verification without writing a real file. */
export function downloadLiveSnapshot(snapshot: LiveSnapshot, doc: Pick<Document, 'createElement' | 'body'> = document, urls: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'> = URL, later: (fn: () => void) => void = fn => { setTimeout(fn, 60000) }) {
  const blob = new Blob([liveSnapshotJson(snapshot)], { type: 'application/json;charset=utf-8' }), url = urls.createObjectURL(blob)
  let link: HTMLAnchorElement | undefined
  try { link = doc.createElement('a'); link.href = url; link.download = liveSnapshotFilename(snapshot); doc.body.appendChild(link); link.click() }
  finally { try { link?.remove() } finally { later(() => urls.revokeObjectURL(url)) } }
}
