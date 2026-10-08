import type { Context } from 'cordis'
import { alarmMatches, decodeRegister, registerWidth } from '@probebench/core'

export const name = 'rule'
export const inject = ['config']

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
    for (const rule of rules) {
      const reg = registers.find(r => r.id === rule.registerId)
      if (!reg) continue
      const area = reg.functionCode === 1 ? 'coil' : reg.functionCode === 2 ? 'discrete-input' : reg.functionCode === 4 ? 'input-register' : 'holding-register'
      const words = Array.from({ length: registerWidth(reg.dataType) }, (_, i) => points.find((p: any) => (p.area ?? 'holding-register') === area && p.address === reg.startAddress + i))
      if (words.some(p => !p || p.quality !== 'good' || !Number.isFinite(p.rawValue))) continue
      const v = decodeRegister(reg.dataType, words.map(p => p.rawValue))
      if (typeof v === 'number' && !Number.isFinite(v)) continue
      const signature = JSON.stringify([rule.registerId, rule.operator, rule.threshold, rule.message, reg.dataType])
      if (alarmMatches(v, rule.operator, rule.threshold)) {
        if (active.get(rule.id) === signature) continue
        active.set(rule.id, signature)
        ctx.config.log('WARN', 'rule', `rule ${rule.id}: ${rule.message ?? reg.alias ?? ''} (raw=${v}, ${rule.operator} ${rule.threshold})`)
        ctx.emit('rule/trigger', {
          ruleId: rule.id, objectId, registerId: rule.registerId,
          value: typeof v === 'bigint' ? String(v) : v, operator: rule.operator, threshold: rule.threshold, message: rule.message,
          timestamp: words[0]?.timestamp,
        })
      } else active.delete(rule.id)
    }
  })
  ctx.provide('rule', {})
}
