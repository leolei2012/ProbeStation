import { registerWidth } from './codec.ts'
import { areaForFunction, type ModbusArea, type ModbusFunctionCode } from './protocol.ts'

export const HISTORY_EXPORT_RAW_LIMIT = 200_000
// Existing wide export: timestamp + value/status/eligibility for each selected point.
export const HISTORY_XLSX_COLUMN_LIMIT = 16_384
export const HISTORY_XLSX_POINT_LIMIT = Math.floor((HISTORY_XLSX_COLUMN_LIMIT - 1) / 3)

export class HistoryExportColumnLimitError extends Error {
  readonly code = 'HISTORY_EXPORT_COLUMN_LIMIT'
  readonly limit = HISTORY_XLSX_COLUMN_LIMIT
  readonly pointLimit = HISTORY_XLSX_POINT_LIMIT
  constructor() {
    super(`XLSX最多支持${HISTORY_XLSX_COLUMN_LIMIT}列（${HISTORY_XLSX_POINT_LIMIT}个点位，每点位3列）。请减少点位后重试，或改用CSV。未生成文件。`)
    this.name = 'HistoryExportColumnLimitError'
  }
}

export interface HistoryExportReadRange { area: ModbusArea; startAddress: number; endAddress: number; slaveId?: number }

/** Include every word required by the existing decoder, merging overlaps without duplicating rows. */
export function historyExportReadRanges(registers: readonly { functionCode: number; startAddress: number; dataType: string; slaveId?: number }[]): HistoryExportReadRange[] {
  const ranges = registers.map(r => {
    const area = areaForFunction(r.functionCode as ModbusFunctionCode), endAddress = r.startAddress + registerWidth(r.dataType) - 1
    if (!area || !Number.isSafeInteger(r.startAddress) || r.startAddress < 0 || !Number.isSafeInteger(endAddress)) throw new Error('Invalid historical export point range')
    return { area, startAddress: r.startAddress, endAddress, ...(r.slaveId !== undefined ? { slaveId: r.slaveId } : {}) }
  }).sort((a, b) => a.area.localeCompare(b.area) || (a.slaveId ?? -1) - (b.slaveId ?? -1) || a.startAddress - b.startAddress)
  const merged: HistoryExportReadRange[] = []
  for (const range of ranges) {
    const previous = merged.at(-1)
    if (previous?.area === range.area && previous.slaveId === range.slaveId && range.startAddress <= previous.endAddress + 1) previous.endAddress = Math.max(previous.endAddress, range.endAddress)
    else merged.push({ ...range })
  }
  return merged
}

export class HistoryExportLimitError extends Error {
  readonly code = 'HISTORY_EXPORT_LIMIT'
  constructor(readonly limit = HISTORY_EXPORT_RAW_LIMIT) {
    super(`History export exceeds ${limit} raw rows. No file was generated; narrow the time range.`)
    this.name = 'HistoryExportLimitError'
  }
}
