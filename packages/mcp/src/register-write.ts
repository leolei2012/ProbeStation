import type { ConfigStore } from '../../config/src/index.ts'
import { registerWriteSource, type GuardedWritePlan, type GuardedWriteResult } from '../../core/src/guarded-register-write.ts'
import { selectSourceRegister } from '../../core/src/register-selection.ts'
import { withRegisterSources } from '../../core/src/sample-source.ts'
import type { BoundWriteOutcome } from '../../modbus/src/bound-write.ts'
import { baseType } from '../../core/src/codec.ts'

export interface McpWriteArgs {
  device_id: number; address: number; value: number | string; area?: 'coil' | 'discrete-input' | 'holding-register' | 'input-register'
  method?: 'single' | 'multiple'; slave_id?: number; register_id?: number; value_mode?: 'physical' | 'raw'; request_id?: string
}
export interface BoundWriteSender { canWriteBoundRegisters?(): boolean; writeBoundRegisters?(plan: GuardedWritePlan, accept: (send: () => void) => void): Promise<BoundWriteOutcome> }
export async function mcpWriteRegister(cfg: ConfigStore, sender: BoundWriteSender, args: McpWriteArgs): Promise<object> {
  args = { ...args, request_id: args.request_id?.toLowerCase() }
  if (!cfg.prepareRegisterWrite || !sender.canWriteBoundRegisters?.() || !sender.writeBoundRegisters) return { code: 'DEVICE_WRITE_BLOCKED', retryable: false, error: '后台尚未提供来源绑定写入，请更新服务。' }
  if (args.request_id && cfg.hasRegisterWrite(args.request_id)) {
    const previous = cfg.getRegisterWrite(args.request_id)
    if (previous.plan.source.device.id !== args.device_id || previous.plan.source.register.startAddress !== args.address || args.area && args.area !== 'holding-register' || args.slave_id !== undefined && previous.plan.source.group.slaveId !== args.slave_id || args.register_id !== undefined && previous.plan.source.register.id !== args.register_id) throw Object.assign(new Error('request_id 已用于其他目标，不会发送新指令。'), { statusCode: 409 })
    return { ...previous, request_reused: true, warning: '返回原操作，不重发。即使 value 或 method 改变也不会重用此 ID 发送新值；新指令请使用新的 request_id。' }
  }
  const device = cfg.getObject(args.device_id)
  if (!device) throw Object.assign(new Error('设备不存在。'), { statusCode: 404 })
  const area = args.area ?? 'holding-register'
  const groups = cfg.listGroups(device.id), registers = withRegisterSources(cfg.listRegistersByObject(device.id), groups, device)
  const selection = selectSourceRegister(registers, { area, address: args.address, slaveId: args.slave_id, registerId: args.register_id })
  if ('error' in selection) return selection
  const register = selection.register, group = cfg.getGroup(register.groupId)!
  let raw: number | string = args.value
  if ((args.value_mode ?? 'physical') === 'physical') {
    if (!Number.isFinite(Number(args.value)) || register.factor === 0) throw Object.assign(new Error('工程值或系数无效；零系数不能反算，请使用 value_mode=raw。'), { statusCode: 400 })
    if (register.factor !== 1 || register.offset !== 0) {
      raw = (Number(args.value) - register.offset) / register.factor
      // Repair only floating point inversion noise, not genuinely fractional integer requests.
      if (/^(u?int)(16|32|64)$/.test(baseType(register.dataType)) && Math.abs(raw - Math.round(raw)) <= Number.EPSILON * Math.max(1, Math.abs(raw)) * 4) raw = Math.round(raw)
    }
  }
  const prepared = cfg.prepareRegisterWrite(register.id, raw, registerWriteSource(device, group, register), args.method ?? 'multiple', args.request_id)
  const { operation, claimed } = cfg.claimRegisterWrite(prepared.id)
  if (!claimed) return operation
  let submitted = false, result: GuardedWriteResult
  try {
    const outcome = await sender.writeBoundRegisters(operation.plan, send => {
      if (submitted) throw Error('操作已提交，不重复发送。')
      cfg.acceptRegisterWrite(operation.plan, () => { submitted = true; send() })
    })
    result = cfg.finishRegisterWrite(operation.id, outcome.state, outcome.message)
  } catch (error) { result = cfg.finishRegisterWrite(operation.id, submitted ? 'unknown' : 'not-sent', String(error)) }
  return { ...result, register_id: register.id, device_id: device.id, slave_id: group.slaveId, address: register.startAddress, area,
    value: args.value, value_mode: args.value_mode ?? 'physical', raw_value: result.plan.value, method: result.plan.functionCode === 6 ? 'single' : 'multiple' }
}
