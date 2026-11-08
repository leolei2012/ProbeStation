import { z as zz } from 'zod'
import type { ConfigStore } from '../../config/src/index.ts'
import type { ConfigEditRegistrar } from './config-edit.ts'
import { CommittedConfigurationNotificationError } from '../../config/src/notification-error.ts'

/** Keep legacy tool names/results; explicit conditions never fall back to an unguarded call. */
export function registerAlarmTools(server: ConfigEditRegistrar, cfg: Pick<ConfigStore, 'createRule' | 'updateRule' | 'deleteRule' | 'listRules' | 'getAlarmEditContext' | 'createRuleSettings' | 'updateRuleSettings' | 'deleteRuleSettings'>) {
  const alarmReply = (value: unknown, warnings: readonly string[] = []) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }, ...warnings.map(text => ({ type: 'text' as const, text }))] })
  const legacyAlarmWarning = '兼容调用未携带原点位/来源条件，未验证先前看到的快照。新调用请先get_alarm_edit_context并原样传回条件；勿为覆盖旧草稿临时刷新条件。'
  const alarmError = (error: any, read = false) => ({ content: [{ type: 'text' as const, text: !read && error instanceof CommittedConfigurationNotificationError ? error.message : [400, 404, 409].includes(error?.statusCode) ? error.message : read ? '告警条件读取失败，请重读；本次未修改配置。' : '告警操作结果待核实，请读取核对，勿重复操作。' }], isError: true })
  server.registerTool('get_alarm_edit_context', {
    title: 'Read alarm edit context', description: '只读一致快照：rule_id读取原规则及点位/来源条件，register_id读取新增用条件，二选一。修改/删除传expected_rule和expected_context，新增传expected_context；保留原条件，不用重读条件替换旧草稿。',
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: { rule_id: zz.number().int().positive().optional(), register_id: zz.number().int().positive().optional() },
  }, async args => { try { return alarmReply(cfg.getAlarmEditContext({ ruleId: args.rule_id, registerId: args.register_id })) } catch (error) { return alarmError(error, true) } })
  server.registerTool('create_alarm_rule', {
    title: 'Create alarm rule', annotations: { destructiveHint: true }, description: '为具体点位新增告警，阈值比较类型解码后的原始值，不应用 factor/offset。推荐先get_alarm_edit_context传原expected_context核对点位/来源；省略条件的旧调用无此保护并返回警告。一个点可设置多个规则。',
    inputSchema: { register_id: zz.number().int().positive(), operator: zz.enum(['>', '>=', '==', '<=', '<', '!=']), threshold: zz.number().finite(), message: zz.string().max(200).nullable().optional(), expected_context: zz.unknown().optional() },
  }, async args => {
    const fields = { registerId: args.register_id, operator: args.operator, threshold: args.threshold, message: args.message ?? null }
    try {
      if (args.expected_context === undefined) return alarmReply(cfg.createRule(fields.registerId, fields.operator, fields.threshold, fields.message), [legacyAlarmWarning])
      const result = cfg.createRuleSettings({ fields, expectedContext: args.expected_context })
      return alarmReply({ ...result.rule, protection: result.protection }, result.warnings)
    } catch (error) { return alarmError(error) }
  })
  server.registerTool('update_alarm_rule', {
    title: 'Update alarm rule', annotations: { destructiveHint: true }, description: '修改告警条件、原始值阈值或提示；省略字段保留，message=null清除。推荐传原expected_rule和expected_context，两者必须同时提供；无条件旧调用保持兼容并返回警告，不代表跨轮次冲突保护。',
    inputSchema: { rule_id: zz.number().int().positive(), operator: zz.enum(['>', '>=', '==', '<=', '<', '!=']).optional(), threshold: zz.number().finite().optional(), message: zz.string().max(200).nullable().optional(), expected_rule: zz.unknown().optional(), expected_context: zz.unknown().optional() },
  }, async args => {
    try {
      if (args.expected_rule !== undefined || args.expected_context !== undefined) {
        if (args.expected_rule === undefined || args.expected_context === undefined) throw Object.assign(new Error('必须同时提供原规则和点位/来源条件；未执行修改。'), { statusCode: 400 })
        const changes = Object.fromEntries([['operator', args.operator], ['threshold', args.threshold], ['message', args.message]].filter(([, value]) => value !== undefined))
        const result = cfg.updateRuleSettings(args.rule_id, { expected: args.expected_rule, expectedContext: args.expected_context, changes })
        return alarmReply({ ...result.rule, protection: result.protection }, result.warnings)
      }
      const before = cfg.listRules().find((r: any) => r.id === args.rule_id)
      if (!before) throw Object.assign(new Error('告警规则不存在'), { statusCode: 404 })
      return alarmReply(cfg.updateRule(args.rule_id, { registerId: before.registerId, operator: args.operator ?? before.operator, threshold: args.threshold ?? before.threshold, message: args.message === undefined ? before.message : args.message }), [legacyAlarmWarning])
    } catch (error) { return alarmError(error) }
  })
  server.registerTool('delete_alarm_rule', {
    title: 'Delete alarm rule', description: '删除单条告警规则，保留点位及其他规则。推荐传原expected_rule及expected_context；只传ID的旧调用保持无条件兼容并返回警告。', annotations: { destructiveHint: true }, inputSchema: { rule_id: zz.number().int().positive(), expected_rule: zz.unknown().optional(), expected_context: zz.unknown().optional() },
  }, async args => {
    try {
      if (args.expected_rule !== undefined || args.expected_context !== undefined) {
        if (args.expected_rule === undefined || args.expected_context === undefined) throw Object.assign(new Error('必须同时提供原规则和点位/来源条件；未执行删除。'), { statusCode: 400 })
        const result = cfg.deleteRuleSettings(args.rule_id, { expected: args.expected_rule, expectedContext: args.expected_context })
        return alarmReply({ ok: true, rule_id: result.deletedRuleId, protection: result.protection }, result.warnings)
      }
      if (!cfg.listRules().some((r: any) => r.id === args.rule_id)) throw Object.assign(new Error('告警规则不存在'), { statusCode: 404 })
      cfg.deleteRule(args.rule_id); return alarmReply({ ok: true, rule_id: args.rule_id }, [legacyAlarmWarning])
    } catch (error) { return alarmError(error) }
  })
}
