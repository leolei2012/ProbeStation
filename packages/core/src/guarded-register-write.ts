/** Shared wire contract. Configuration IDs alone are not a write destination. */
export function registerWriteSource(device: any, group: any, register: any) {
  return {
    device: { id: device.id, name: device.name, mode: device.mode, transport: device.transport, ip: device.ip, port: device.port,
      serialPath: device.serialPath ?? null, baudRate: device.baudRate, parity: device.parity, stopBits: device.stopBits,
      dataBits: device.dataBits, flowControl: device.flowControl },
    group: { id: group.id, objectId: register.objectId, slaveId: group.slaveId, functionCode: group.functionCode, startAddress: group.startAddress, quantity: group.quantity },
    register: { id: register.id, groupId: register.groupId, objectId: register.objectId, startAddress: register.startAddress, dataType: register.dataType,
      alias: register.alias ?? null, factor: register.factor ?? 1, offset: register.offset ?? 0 },
  }
}
export type RegisterWriteSource = ReturnType<typeof registerWriteSource>
export type GuardedWriteState = 'prepared' | 'sending' | 'acknowledged' | 'not-sent' | 'unknown' | 'reviewed-unknown'
export interface GuardedWritePlan {
  version: 1; id: string; scope: string; revision: string; channel: string; source: RegisterWriteSource
  value: string; words: number[]; functionCode: 6 | 16; timeoutMs: number; expiresAt: number
}
export interface GuardedWriteResult { version: 1; id: string; state: GuardedWriteState; plan: GuardedWritePlan; message: string }
export function writeConflict(message = '设备、从站或点位配置已变化，请重新准备并确认。') {
  return Object.assign(new Error(message), { statusCode: 409, code: 'WRITE_SOURCE_CHANGED' })
}
