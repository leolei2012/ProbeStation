import { validSlaveId } from '../../../packages/core/src/sample-source'

export interface PickerPoint { id: number; alias: string | null; startAddress: number; functionCode: number; dataType: string }
export interface PickerGroup { id: number; name: string; slaveId?: number; registers: PickerPoint[] }
export function pickerSource(group: PickerGroup, deviceSlaveId?: number): number | null {
  const value = deviceSlaveId === undefined ? group.slaveId : deviceSlaveId
  return validSlaveId(value) ? value : null
}
export const pickerSourceKey = (group: PickerGroup, deviceSlaveId?: number) => String(pickerSource(group, deviceSlaveId) ?? '?')
export function pickerSources(groups: readonly PickerGroup[], deviceSlaveId?: number): string[] {
  return [...new Set(groups.filter(g => g.registers.length).map(g => pickerSourceKey(g, deviceSlaveId)))].sort((a, b) => a === '?' ? 1 : b === '?' ? -1 : Number(a) - Number(b))
}
/** Snapshot only the options this picker can display; equivalent refetch/reordering is harmless. */
export function pickerContext(groups: readonly PickerGroup[], deviceSlaveId?: number, max?: number): string {
  return JSON.stringify([max ?? null, groups.map(g => [g.id, g.name, pickerSourceKey(g, deviceSlaveId), g.registers.map(r => [r.id, r.alias, r.startAddress, r.functionCode, r.dataType]).sort((a, b) => Number(a[0]) - Number(b[0]))]).sort((a, b) => Number(a[0]) - Number(b[0]))])
}
export function filterPickerGroups(groups: readonly PickerGroup[], search: string, source = '', deviceSlaveId?: number, selected?: ReadonlySet<number>): PickerGroup[] {
  const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return groups.filter(g => !source || pickerSourceKey(g, deviceSlaveId) === source).map(g => ({ ...g, registers: g.registers.filter(r => {
    if (selected && !selected.has(r.id)) return false
    const text = `${g.name} ${r.alias ?? ''} ${r.startAddress} 0x${r.startAddress.toString(16)} ${r.dataType} #${r.id} slave:${pickerSourceKey(g, deviceSlaveId)}`.toLowerCase()
    return terms.every(term => {
      const id = term.match(/^(?:id:|#)(\d+)$/), source = term.match(/^slave:(\d+|\?)$/)
      if (id) return Number.isSafeInteger(Number(id[1])) && Number(id[1]) === r.id
      if (source) return source[1] === '?' ? pickerSource(g, deviceSlaveId) === null : Number(source[1]) === pickerSource(g, deviceSlaveId)
      if (/^0x[0-9a-f]+$/.test(term)) return Number(term) === r.startAddress
      return text.includes(term)
    })
  }) })).filter(g => g.registers.length)
}
export function addVisiblePickerPoints(selected: ReadonlySet<number>, visible: readonly PickerGroup[], max?: number): Set<number> {
  const next = new Set(selected)
  for (const group of visible) for (const point of group.registers) if (max === undefined || next.size < max) next.add(point.id)
  return next
}
