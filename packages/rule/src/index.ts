import type { Context } from 'cordis'

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
 * 告警规则引擎：订阅 poller/result，按规则评估每个采样点，
 * 命中则发 `rule/trigger` 事件（含规则、寄存器、值、时间戳）。
 */
export function apply(ctx: Context): void {
  ctx.on('poller/result', ({ objectId, points }: any) => {
    const rules = ctx.config.listRules()
    if (rules.length === 0) return
    for (const p of points) {
      for (const rule of rules) {
        if (rule.registerId !== p.registerId) continue
        const fn = OPS[rule.operator]
        if (!fn) continue
        if (fn(p.rawValue, rule.threshold)) {
          ctx.emit('rule/trigger', {
            ruleId: rule.id, objectId, registerId: p.registerId,
            value: p.rawValue, threshold: rule.threshold, message: rule.message,
            timestamp: p.timestamp,
          })
        }
      }
    }
  })
  ctx.provide('rule', {})
}
