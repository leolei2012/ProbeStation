import { registerWidth } from './codec.ts'
import { areaForFunction, type ModbusFunctionCode } from './protocol.ts'

export const validSlaveId = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 255
export function sourceKey(objectId: number | string, area: string, address: number, slaveId: number | null) {
  return `${objectId === '' ? '' : objectId + ':'}slave:${slaveId ?? 'unknown'}:${area}:${address}`
}
export function sourceSample<T extends { slaveId?: number | null }>(latest: Record<string, T>, objectId: number | string, area: string, address: number, slaveId?: number): T | undefined {
  const key = `${objectId === '' ? '' : objectId + ':'}${area}:${address}`
  if (slaveId === undefined) return latest[key]
  const scoped = latest[sourceKey(objectId, area, address, slaveId)]
  return scoped?.slaveId === slaveId ? scoped : latest[key]?.slaveId === slaveId ? latest[key] : undefined
}

/** A configured-source view must not interpret an absent/invalid source as an unscoped legacy lookup. */
export function configuredSourceSample<T extends { slaveId?: number | null }>(latest: Record<string, T>, objectId: number | string, area: string, address: number, slaveId?: number | null): T | undefined {
  return validSlaveId(slaveId) ? sourceSample(latest, objectId, area, address, slaveId) : undefined
}

export function withRegisterSources<T extends { groupId?: number; functionCode: number; startAddress: number; dataType: string; slaveId?: number }>(registers: T[], groups: Array<{ id: number; slaveId?: number; functionCode: number; startAddress: number; quantity: number }>, device?: { mode?: string; slaveId?: number }) {
  return registers.map(r => {
    const group = groups.find(g => g.id === r.groupId)
    const slaveId = device?.mode === 'slave' ? device.slaveId ?? 1 : group ? group.slaveId ?? 1 : r.slaveId
    const area = areaForFunction(r.functionCode as ModbusFunctionCode), end = r.startAddress + registerWidth(r.dataType)
    const sourceAmbiguous = device?.mode !== 'slave' && groups.some(g => (g.slaveId ?? 1) !== slaveId && areaForFunction(g.functionCode as ModbusFunctionCode) === area && g.startAddress < end && g.startAddress + g.quantity > r.startAddress)
    return { ...r, slaveId, sourceAmbiguous }
  })
}
