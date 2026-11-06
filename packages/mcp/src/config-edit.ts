import { z } from 'zod'
import type { ConfigStore } from '../../config/src/index.ts'
import { captureDeviceEditBaseline } from '../../core/src/device-settings-edit.ts'
import { parseGroupEditChanges, planGroupResize } from '../../core/src/group-settings-edit.ts'

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const groupFields = { name: z.string().optional(), slave_id: z.number().optional(), function_code: z.number().optional(), start_address: z.number().optional(), quantity: z.number().optional(), is_active: z.number().optional() }
const groupMap: Record<string, string> = { name: 'name', slave_id: 'slaveId', function_code: 'functionCode', start_address: 'startAddress', quantity: 'quantity', is_active: 'isActive' }
const deviceFields = { name: z.string().optional(), mode: z.enum(['master', 'slave']).optional(), transport: z.enum(['tcp', 'rtu']).optional(), ip: z.string().optional(), port: z.number().optional(), serial_path: z.string().optional(), baud_rate: z.number().optional(), parity: z.string().optional(), stop_bits: z.number().optional(), data_bits: z.number().optional(), flow_control: z.string().optional(), slave_id: z.number().optional(), poll_interval_ms: z.number().optional(), timeout_ms: z.number().optional() }
const deviceMap: Record<string, string> = { name: 'name', mode: 'mode', transport: 'transport', ip: 'ip', port: 'port', serial_path: 'serialPath', baud_rate: 'baudRate', parity: 'parity', stop_bits: 'stopBits', data_bits: 'dataBits', flow_control: 'flowControl', slave_id: 'slaveId', poll_interval_ms: 'pollIntervalMs', timeout_ms: 'timeoutMs' }
const fields = (args: Record<string, unknown>, mapping: Record<string, string>) => Object.fromEntries(Object.entries(args).filter(([key, value]) => Object.hasOwn(mapping, key) && value !== undefined).map(([key, value]) => [mapping[key], value]))
const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] })
// A bounded registrar contract keeps SDK v3/v4 schema inference out of service typechecking.
// Production still supplies McpServer; its real in-memory protocol is exercised by the regression suite.
export interface ConfigEditRegistrar {
  registerTool(name: string, options: { title: string; description: string; annotations: { readOnlyHint?: boolean; destructiveHint?: boolean }; inputSchema: Record<string, z.ZodTypeAny> }, callback: (args: any) => Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }>): unknown
}
function required(tool: string): never { throw Object.assign(new Error('缺少已核对的保存条件。请先调用 ' + tool + '，核对后携带原快照提交。'), { statusCode: 428, code: 'CONFIG_PRECONDITION_REQUIRED', nextTool: tool }) }
const guarded = (write: boolean, run: (args: any) => Promise<ReturnType<typeof text>>) => async (args: any) => {
  try { return await run(args) }
  catch (error: any) {
    const known = [400, 404, 409, 428].includes(error?.statusCode), status = known ? error.statusCode : 500
    return { ...text({ code: error?.code === 'CONFIG_PRECONDITION_REQUIRED' ? error.code : status === 409 ? 'CONFIG_CONFLICT' : status === 404 ? 'CONFIG_NOT_FOUND' : status === 400 ? 'CONFIG_INPUT_INVALID' : write ? 'CONFIG_SAVE_UNCERTAIN' : 'CONFIG_READ_FAILED', status, error: known ? error.message : write ? '保存结果待核实，请核对配置，勿自动重复保存。' : '配置快照读取失败，请核对后重读。', ...(error?.nextTool ? { next_tool: error.nextTool } : {}) }), isError: true }
  }
}

/** Production MCP metadata editors, independently testable without listeners or real runtime services. */
export function registerConfigEditTools(server: ConfigEditRegistrar, cfg: Pick<ConfigStore, 'getObject' | 'updateObjectSettings' | 'getGroupSettings' | 'updateGroupSettings' | 'getRegisterSettings' | 'updateRegisterSettings' | 'log'>, runtime: { reconnect: (id: number) => Promise<unknown>; syncSlaves: () => Promise<unknown> }) {
  const log = (message: string, warnings: string[]) => { try { cfg.log('INFO', 'mcp', message) } catch { warnings.push('配置已保存，但操作日志写入失败；勿重复保存。') } }
  server.registerTool('get_register_edit_snapshot', { title: 'Read register edit snapshot', description: '只读一致的点位及分组/设备来源快照，不访问硬件。update_register须携带核对过的原expected；不得给旧草稿自动换新条件。', annotations: { readOnlyHint: true, destructiveHint: false }, inputSchema: { register_id: id } }, guarded(false, async args => text({ register_id: args.register_id, expected: cfg.getRegisterSettings(args.register_id) })))
  server.registerTool('update_register', {
    title: 'Update register', description: '有条件更改别名/类型/单位/缩放/枚举。先get_register_edit_snapshot并核对，提交原expected；缺条件或来源/同字段冲突拒绝。保留原字段返回并附configuration_saved/warnings，不写硬件。', annotations: { destructiveHint: true },
    inputSchema: { register_id: id, alias: z.string().optional(), data_type: z.string().optional(), unit: z.string().optional(), factor: z.number().optional(), offset: z.number().optional(), enum: z.record(z.string()).optional(), expected: z.record(z.unknown()).optional().describe('执行更新时必需的原expected；缺失仅返回迁移错误。') },
  }, guarded(true, async args => {
    if (args.expected === undefined) required('get_register_edit_snapshot')
    const changes = fields(args, { alias: 'alias', data_type: 'dataType', unit: 'unit', factor: 'factor', offset: 'offset' })
    if (args.enum !== undefined) changes.enumJson = JSON.stringify(args.enum)
    const result = cfg.updateRegisterSettings(args.register_id, { expected: args.expected, changes }), warnings = [...result.warnings]
    log('guarded update register ' + args.register_id, warnings)
    return text({ ...result.point, configuration_saved: true, warnings })
  }))
  server.registerTool('get_device_edit_snapshot', { title: 'Read device edit snapshot', description: '只读设备编辑快照，不连接设备。返回expected；update_device须原样携带，不能在过期草稿上临时替换成新快照。', annotations: { readOnlyHint: true, destructiveHint: false }, inputSchema: { device_id: id } }, guarded(false, async args => {
    const device = cfg.getObject(args.device_id)
    if (!device) throw Object.assign(new Error('设备不存在'), { statusCode: 404 })
    return text({ device_id: args.device_id, expected: captureDeviceEditBaseline(device) })
  }))
  server.registerTool('update_device', {
    title: 'Update device', description: '有条件修改设备角色/连接参数/名称/采样周期。先get_device_edit_snapshot并核对，提交原expected；缺条件或冲突拒绝，无自动降级。返回原设备字段及configuration_saved/warnings；运行状态警告不等于配置未保存。', annotations: { destructiveHint: true },
    inputSchema: { device_id: id, ...deviceFields, expected: z.record(z.unknown()).optional().describe('get_device_edit_snapshot返回的原expected；执行更新时必需，缺失仅返回迁移错误。') },
  }, guarded(true, async args => {
    if (args.expected === undefined) required('get_device_edit_snapshot')
    const result = cfg.updateObjectSettings(args.device_id, { expected: args.expected, changes: fields(args, deviceMap) }), warnings = [...result.warnings]
    // Preserve this MCP caller's existing runtime sequence; tests inject metadata-only mocks.
    if (result.device.mode !== 'slave') { try { await runtime.reconnect(args.device_id) } catch { warnings.push('配置已保存，但连接重建未完成；请核对运行状态，勿重复保存。') } }
    try { await runtime.syncSlaves() } catch { warnings.push('配置已保存，但从站同步未完成；请核对运行状态，勿重复保存。') }
    log('guarded update device ' + args.device_id, warnings)
    return text({ ...result.device, configuration_saved: true, warnings })
  }))
  server.registerTool('get_group_edit_snapshot', { title: 'Read group edit snapshot', description: '只读一致的组、全部点位、关联告警和设备来源快照及revision，不访问硬件。先读取并核对，再preview_group_update；后续提交原revision，不能自动替过期草稿换新版本。', annotations: { readOnlyHint: true, destructiveHint: false }, inputSchema: { group_id: id } }, guarded(false, async args => text(cfg.getGroupSettings(args.group_id))))
  server.registerTool('preview_group_update', {
    title: 'Preview group update', description: '只读核对原expected_revision并预览原改动：新增地址、将删除点位/告警的完整编号和标签。变化返回冲突，不给旧草稿换新条件。核对具体删除后，update_group须显式传confirmed_delete_register_ids及confirmed_delete_rule_ids。', annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: { group_id: id, ...groupFields, expected_revision: z.string().optional().describe('已核对的get_group_edit_snapshot原revision；过期时应重新审阅改动，不能自动换新。') },
  }, guarded(false, async args => {
    if (args.expected_revision === undefined) required('get_group_edit_snapshot')
    if (!/^v1:[a-f0-9]{64}$/.test(args.expected_revision)) throw Object.assign(new Error('分组保存条件格式无效'), { statusCode: 400 })
    const snapshot = cfg.getGroupSettings(args.group_id)
    if (snapshot.revision !== args.expected_revision) throw Object.assign(new Error('分组图已变化，请重新读取并重新核对修改，勿自动替换原条件。'), { statusCode: 409 })
    const changes = parseGroupEditChanges(fields(args, groupMap), snapshot.group), plan = planGroupResize(snapshot, changes), removed = new Set(plan.removeRegisterIds), rules = new Set(plan.removeRuleIds)
    return text({ group_id: args.group_id, expected_revision: args.expected_revision, changes, plan: { add_addresses: plan.addAddresses, delete_register_ids: plan.removeRegisterIds, delete_rule_ids: plan.removeRuleIds }, deleted_points: snapshot.registers.filter(row => removed.has(row.id)).map(row => ({ id: row.id, alias: row.alias, function_code: row.functionCode, address: row.startAddress, data_type: row.dataType })), deleted_rules: snapshot.rules.filter(rule => rules.has(rule.id)) })
  }))
  server.registerTool('update_group', {
    title: 'Update group', description: '有条件更改名称/从站/FC/地址/数量/启停；先get_group_edit_snapshot及preview_group_update核对原版本和具体删除。必须带expected_revision，删除须带完整确认编号；缺条件/冲突拒绝。返回原组字段、结果revision、实际增删编号及warnings。', annotations: { destructiveHint: true },
    inputSchema: { group_id: id, ...groupFields, expected_revision: z.string().optional().describe('执行更新时必需的原revision；缺失仅返回迁移错误。'), confirmed_delete_register_ids: z.array(id).optional().describe('核对本次删除对象后，显式传入preview的plan.delete_register_ids。'), confirmed_delete_rule_ids: z.array(id).optional().describe('核对本次删除对象后，显式传入preview的plan.delete_rule_ids。') },
  }, guarded(true, async args => {
    if (args.expected_revision === undefined) required('get_group_edit_snapshot')
    const confirmation = args.confirmed_delete_register_ids !== undefined || args.confirmed_delete_rule_ids !== undefined ? { registerIds: args.confirmed_delete_register_ids ?? [], ruleIds: args.confirmed_delete_rule_ids ?? [] } : undefined
    const result = cfg.updateGroupSettings(args.group_id, { expectedRevision: args.expected_revision, changes: fields(args, groupMap), ...(confirmation ? { confirmedDeletion: confirmation } : {}) }), warnings = [...result.warnings]
    log('guarded update group ' + args.group_id, warnings)
    return text({ ...result.snapshot.group, configuration_saved: true, revision: result.snapshot.revision, added_register_ids: result.addedRegisterIds, deleted_register_ids: result.deletedRegisterIds, deleted_rule_ids: result.deletedRuleIds, warnings })
  }))
}
