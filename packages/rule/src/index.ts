import type { Context } from 'cordis'
import { alarmMatches, decodeRegister, registerWidth, sameResponseBatch } from '@probebench/core'

export const name = 'rule'
export const inject = ['config']

/** pollOnce combines responses. Choose the last complete response in this event;
 * never fill its gaps from another response or a previous event's cache.
 */
function eventWords(points: any[], area: string, address: number, width: number, expectedSlaveId: number | undefined, allowLegacy: boolean): any[] | null {
  let relevant = points.filter(p => (p.area ?? 'holding-register') === area && p.address >= address && p.address < address + width)
  if (relevant.some(p => p.slaveId != null)) {
    if (expectedSlaveId === undefined) return null
    // Do not supplement a known source using legacy words or a different slave.
    relevant = relevant.filter(p => p.slaveId === expectedSlaveId)
  } else if (!allowLegacy) return null
  const collect = (batch: any[]) => Array.from({ length: width }, (_, i) => batch.find(p => p.address === address + i))
  if (relevant.every(p => p.batchId == null)) return collect(relevant)
  const responses = new Map<string, any[]>()
  for (const point of relevant) {
    if (typeof point.batchId !== 'string' || !point.batchId) continue
    const batch = responses.get(point.batchId) ?? []
    batch.push(point); responses.delete(point.batchId); responses.set(point.batchId, batch)
  }
  for (const batch of [...responses.values()].reverse()) {
    const words = collect(batch)
    if (words.some(p => !p)) continue
    // A malformed complete response is unknown, not a reason to replay an older value.
    if (batch.length !== width) return null
    return words
  }
  return null
}

/**
 * 告警规则引擎：订阅 poller/result，把原始字按寄存器解码后评估，
 * 命中则发 `rule/trigger` 事件（含规则、寄存器、值、时间戳）。
 */
export function apply(ctx: Context): void {
  const active = new Map<number, string>()
  ctx.on('poller/result', ({ objectId, points }: any) => {
    const rules = ctx.config.listRules()
    for (const id of active.keys()) if (!rules.some(r => r.id === id)) active.delete(id)
    if (rules.length === 0) return
    const registers = ctx.config.listRegistersByObject(objectId)
    const groups = ctx.config.listGroups?.(objectId) ?? []
    const device = ctx.config.getObject?.(objectId)
    const allowLegacy = device?.mode === 'slave' || new Set(groups.map((g: any) => g.slaveId ?? 1)).size <= 1
    for (const rule of rules) {
      const reg = registers.find(r => r.id === rule.registerId)
      if (!reg) continue
      const group = ctx.config.getGroup?.(reg.groupId) ?? groups.find((g: any) => g.id === reg.groupId)
      if (!group && typeof ctx.config.getGroup === 'function' && device?.mode !== 'slave') continue
      const expectedSlaveId = device?.mode === 'slave' ? device.slaveId ?? 1 : group ? group.slaveId ?? 1 : undefined
      const area = reg.functionCode === 1 ? 'coil' : reg.functionCode === 2 ? 'discrete-input' : reg.functionCode === 4 ? 'input-register' : 'holding-register'
      const words = eventWords(points, area, reg.startAddress, registerWidth(reg.dataType), expectedSlaveId, allowLegacy)
      if (!words || words.some(p => !p || p.quality !== 'good' || !Number.isFinite(p.rawValue)) || !sameResponseBatch(words)) continue
      const v = decodeRegister(reg.dataType, words.map(p => p.rawValue))
      if (typeof v === 'number' && !Number.isFinite(v)) continue
      const signature = JSON.stringify([rule.registerId, rule.operator, rule.threshold, rule.message, reg.dataType, expectedSlaveId])
      if (alarmMatches(v, rule.operator, rule.threshold)) {
        if (active.get(rule.id) === signature) continue
        active.set(rule.id, signature)
        ctx.config.log('WARN', 'rule', `rule ${rule.id}: ${rule.message ?? reg.alias ?? ''} (raw=${v}, ${rule.operator} ${rule.threshold})`)
        ctx.emit('rule/trigger', {
          ruleId: rule.id, objectId, registerId: rule.registerId,
          value: typeof v === 'bigint' ? String(v) : v, operator: rule.operator, threshold: rule.threshold, message: rule.message,
          timestamp: words[0]?.timestamp,
          ...(words[0]?.slaveId != null ? { slaveId: words[0].slaveId } : {}),
        })
      } else active.delete(rule.id)
    }
  })
  ctx.provide('rule', {})
}
