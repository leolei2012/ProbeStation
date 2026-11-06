import { historyQueryRange } from './history-curve'

export interface HistoryExportRequest {
  readonly objectId: number
  readonly start: string
  readonly end: string
  readonly registerIds: readonly number[]
  readonly timezoneOffsetMin: number
  readonly scope: 'full' | 'viewport'
}

/** Capture the exact range and selection at the moment the export dialog opens. */
export function captureHistoryExport(objectId: number, range: { start: number; end: number }, registerIds: readonly number[], timezoneOffsetMin: number, scope: HistoryExportRequest['scope']): HistoryExportRequest {
  const { start, end } = historyQueryRange(range)
  if (!Number.isSafeInteger(objectId) || objectId < 1 || !Number.isFinite(start) || !Number.isFinite(end) || start >= end || !Number.isInteger(timezoneOffsetMin)) throw new Error('Invalid export range or device')
  if (!registerIds.length || registerIds.some(id => !Number.isSafeInteger(id) || id < 1)) throw new Error('Select points before exporting')
  return Object.freeze({ objectId, start: new Date(start).toISOString(), end: new Date(end).toISOString(), registerIds: Object.freeze([...new Set(registerIds)].sort((a, b) => a - b)), timezoneOffsetMin, scope })
}

export function historyExportUrl(format: 'csv' | 'xlsx', request: HistoryExportRequest): string {
  if (!['csv', 'xlsx'].includes(format)) throw new Error('Invalid export format')
  const params = new URLSearchParams({ object_id: String(request.objectId), start: request.start, end: request.end, register_ids: request.registerIds.join(','), tz: String(request.timezoneOffsetMin) })
  return `/api/export/${format}?${params}`
}

/** Show the same fixed offset used by the existing export endpoint, including milliseconds. */
export function historyExportRangeLabel(request: HistoryExportRequest): string {
  const local = (iso: string) => new Date(Date.parse(iso) + request.timezoneOffsetMin * 60_000).toISOString().replace('T', ' ').replace('Z', '')
  const offset = Math.abs(request.timezoneOffsetMin)
  const zone = `UTC${request.timezoneOffsetMin >= 0 ? '+' : '-'}${String(Math.floor(offset / 60)).padStart(2, '0')}:${String(offset % 60).padStart(2, '0')}`
  return `${local(request.start)} — ${local(request.end)} (${zone})`
}
