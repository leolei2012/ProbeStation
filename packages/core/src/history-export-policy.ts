import { registerWidth } from './codec.ts'
import { areaForFunction, type ModbusArea, type ModbusFunctionCode } from './protocol.ts'

export const HISTORY_EXPORT_RAW_LIMIT = 200_000

export interface HistoryExportReadRange { area: ModbusArea; startAddress: number; endAddress: number }

/** Include every word required by the existing decoder, merging overlaps without duplicating rows. */
export function historyExportReadRanges(registers: readonly { functionCode: number; startAddress: number; dataType: string }[]): HistoryExportReadRange[] {
  const ranges = registers.map(r => {
    const area = areaForFunction(r.functionCode as ModbusFunctionCode), endAddress = r.startAddress + registerWidth(r.dataType) - 1
    if (!area || !Number.isSafeInteger(r.startAddress) || r.startAddress < 0 || !Number.isSafeInteger(endAddress)) throw new Error('Invalid historical export point range')
    return { area, startAddress: r.startAddress, endAddress }
  }).sort((a, b) => a.area.localeCompare(b.area) || a.startAddress - b.startAddress)
  const merged: HistoryExportReadRange[] = []
  for (const range of ranges) {
    const previous = merged.at(-1)
    if (previous?.area === range.area && range.startAddress <= previous.endAddress + 1) previous.endAddress = Math.max(previous.endAddress, range.endAddress)
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
