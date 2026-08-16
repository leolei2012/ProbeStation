import type { Context } from 'cordis'
import { decodeRawByAddr } from '@probebench/core'

export const name = 'rule'
export const inject = ['config']

const OPS: Record<string, (a: number, b: number) => boolean> = {
  '>': (a, b) => a > b,
  '<': (a, b) => a < b,
  '>=': (a, b) => a >= b,
  '<=': (a, b) => a <= b,
  '==': (a, b) => a === b,
  '!=': (a, b) => a !== b,
}

/**
 * 告警规则引擎：订阅 poller/result，把原始字按寄存器解码后评估，
 * 命中则发 `rule/trigger` 事件（含规则、寄存器、值、时间戳）。
 */
export function apply(ctx: Context): void {
  ctx.on('poller/result', ({ objectId, points }: any) => {
    const rules = ctx.config.listRules()
    if (rules.length === 0) return
    const rawByAddr: Record<number, number> = {}
    for (const p of points) rawByAddr[p.address] = p.rawValue
    const decoded = decodeRawByAddr(ctx.config.listRegistersByObject(objectId), rawByAddr)
    for (const rule of rules) {
      const v = decoded.get(rule.registerId)
      if (v == null) continue
      const fn = OPS[rule.operator]
      if (!fn) continue
      const num = typeof v === 'bigint' ? Number(v) : v
      if (fn(num, rule.threshold)) {
        ctx.config.log('WARN', 'rule', `rule ${rule.id}: ${rule.message ?? ''} (value=${num}, threshold=${rule.threshold})`)
        ctx.emit('rule/trigger', {
          ruleId: rule.id, objectId, registerId: rule.registerId,
          value: typeof v === 'bigint' ? String(v) : v, threshold: rule.threshold, message: rule.message,
          timestamp: points[0]?.timestamp,
        })
      }
    }
  })
  ctx.provide('rule', {})
}
