// 规格符合性测试：对运行中的程序（8080 REST + 8081 MCP）逐项验证
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const REST = 'http://127.0.0.1:8080'
const MCP = 'http://127.0.0.1:8081/mcp'
const results: any[] = []
const ok = (spec: string, label: string, detail: string, pass: boolean) => results.push({ spec, label, detail, pass })

async function req(method: string, url: string, body?: unknown): Promise<{ status: number; json: any; text: string; ct: string }> {
  const opts: any = { method }
  if (body != null) { opts.headers = { 'Content-Type': 'application/json' }; opts.body = JSON.stringify(body) }
  const r = await fetch(REST + url, opts)
  const text = await r.text()
  let json: any = null
  try { json = JSON.parse(text) } catch {}
  return { status: r.status, json, text, ct: r.headers.get('content-type') || '' }
}

// ============ REST ============
const h = await req('GET', '/health')
ok('§6.1 REST', '/health', h.json?.status === 'ok' ? 'status=ok v' + h.json?.version : JSON.stringify(h.json), h.json?.status === 'ok')

const ws = await req('GET', '/api/workspace')
ok('§5.13 工作区', '当前工作区', JSON.stringify({ current: ws.json?.current, recent: ws.json?.recent?.length }), ws.status === 200 && !!ws.json?.current)

const devs = await req('GET', '/api/monitor_objects')
ok('§5.1 设备', '设备列表', 'devices=' + (devs.json?.length), Array.isArray(devs.json) && devs.json.length >= 2)

const groups1 = await req('GET', '/api/monitor_objects/1/groups')
ok('§5.2 组', '设备1分组', 'groups=' + groups1.json?.length, Array.isArray(groups1.json) && groups1.json.length === 2)
const gid1 = groups1.json?.[0]?.id

const regs1 = await req('GET', `/api/groups/${gid1}/registers`)
ok('§5.3 寄存器', '组寄存器', 'registers=' + regs1.json?.length, Array.isArray(regs1.json) && regs1.json.length === 10)

const latest = await req('GET', '/api/monitor_objects/1/latest')
const keys = Object.keys(latest.json || {})
const tsSet = new Set(Object.values(latest.json || {}).map((v: any) => v?.timestamp))
ok('§5.5/5.6 快照', '最新快照', `addrs=${keys.length} 时间戳种数=${tsSet.size}`, keys.length === 20 && tsSet.size === 1)

const q1 = await req('GET', '/api/data/query?object_id=1&address=0&start=2000-01-01T00:00:00Z&end=2100-01-01T00:00:00Z')
ok('§5.7 历史', '单地址历史', 'rows=' + (q1.json?.length ?? 'null'), Array.isArray(q1.json) && q1.json.length > 0)

const qo = await req('GET', '/api/data/object?object_id=1&start=2000-01-01T00:00:00Z&end=2100-01-01T00:00:00Z')
const hasAddrField = Array.isArray(qo.json) && qo.json.length > 0 && 'address' in qo.json[0]
ok('§5.7 历史', '全设备历史(含 address 字段)', 'rows=' + qo.json?.length + ' hasAddress=' + hasAddrField, hasAddrField)

const csv = await req('GET', '/api/export/csv?object_id=2&start=2000-01-01T00:00:00Z&end=2100-01-01T00:00:00Z')
ok('§5.8 导出', 'CSV', `status=${csv.status} ct=${csv.ct.slice(0, 30)} len=${csv.text.length}`, csv.status === 200 && csv.text.includes(','))

const xlsx = await req('GET', '/api/export/xlsx?object_id=2&start=2000-01-01T00:00:00Z&end=2100-01-01T00:00:00Z')
ok('§5.8 导出', 'XLSX', `status=${xlsx.status} ct=${xlsx.ct}`, xlsx.status === 200)

const rules0 = await req('GET', '/api/rules')
ok('§5.10 规则', '规则列表', 'rules=' + rules0.json?.length, Array.isArray(rules0.json))

const logs0 = await req('GET', '/api/logs')
ok('§5.14 日志', '日志列表', 'logs=' + logs0.json?.length, Array.isArray(logs0.json) && logs0.json.length > 0)

// 写寄存器（设备2 本地模拟器，安全）
const regs2 = await req('GET', '/api/groups/3/registers')
const targetReg = regs2.json?.[0]
const wr = await req('POST', `/api/registers/${targetReg.id}/write`, { value: 777, method: 'multiple' })
ok('§5.9 写寄存器', 'FC16 写值', `status=${wr.status} resp=${wr.text.slice(0, 80)}`, wr.status === 200)

// 新建组（自动生成寄存器）→ 删除
const ng = await req('POST', '/api/monitor_objects/2/groups', { name: '规格测试组', slaveId: 1, functionCode: 3, startAddress: 100, quantity: 2, pollIntervalMs: 1000, isActive: 0 })
const ngid = ng.json?.id
const ngRegs = ngid ? await req('GET', `/api/groups/${ngid}/registers`) : { json: [] }
ok('§5.2 组', '新建组自动生成寄存器', `group=${ngid} regs=${ngRegs.json?.length}`, !!ngid && ngRegs.json?.length === 2)
if (ngid) { const dr = await req('DELETE', `/api/groups/${ngid}`); ok('§5.2 组', '删除组', 'status=' + dr.status, dr.status === 200) }

// 规则 CRUD
const rc = await req('POST', '/api/rules', { registerId: targetReg.id, operator: '>', threshold: 100, message: '规格测试告警' })
const rid = rc.json?.id
ok('§5.10 规则', '新建规则', 'id=' + rid, !!rid)
if (rid) { const rd = await req('DELETE', '/api/rules/' + rid); ok('§5.10 规则', '删除规则', 'status=' + rd.status, rd.status === 200) }

// 设备启停 toggle（设备2）
const t0 = await req('GET', '/api/monitor_objects')
const dev2 = t0.json?.find((d: any) => d.id === 2)
const tg = await req('POST', '/api/monitor_objects/2/toggle')
const tgBack = await req('POST', '/api/monitor_objects/2/toggle')
ok('§5.1 设备', '启停 toggle', `before=${dev2?.isActive} toggle1=${tg.status} toggle2=${tgBack.status}`, tg.status === 200 && tgBack.status === 200)

// ============ MCP ============
let mcpSection: any[] = []
try {
  const transport = new StreamableHTTPClientTransport(new URL(MCP))
  const client = new Client({ name: 'spec-test', version: '1.0' })
  await client.connect(transport)
  const tools = await client.listTools()
  const toolNames = tools.tools.map((t: any) => t.name)
  ok('§5.15 MCP', '工具清单', toolNames.join(', '), toolNames.length >= 12)
  mcpSection.push({ toolNames, count: toolNames.length })

  const call = async (name: string, args: any) => {
    const r = await client.callTool({ name, arguments: args })
    return JSON.parse((r.content?.[0] as any)?.text ?? 'null')
  }

  const listDev = await call('list_devices', {})
  ok('§5.15 MCP', 'list_devices', 'devices=' + (listDev?.length ?? 'null'), Array.isArray(listDev) && listDev.length >= 2)

  const listReg = await call('list_registers', { device_id: 1 })
  ok('§5.15 MCP', 'list_registers', 'regs=' + (listReg?.length ?? 'null'), Array.isArray(listReg) && listReg.length >= 10)

  const rr = await call('read_register', { device_id: 2, register_id: targetReg.id })
  const rrOk = rr && typeof rr.value !== 'undefined' && 'address' in rr && 'timestamp' in rr && 'quality' in rr
  ok('PRD§6 read_register 带 timestamp/quality', 'read_register', JSON.stringify(rr), !!rrOk)
  mcpSection.push({ read_register: rr })

  const snap = await call('get_device_snapshot', { device_id: 1 })
  const snapOk = Array.isArray(snap) && snap.length >= 10 && snap.every((x: any) => 'alias' in x && 'address' in x && 'timestamp' in x)
  ok('PRD§6 get_device_snapshot', '整机快照', 'items=' + (snap?.length ?? 'null'), !!snapOk)

  const health = await call('get_device_health', { device_id: 1 })
  const healthOk = health && typeof health.connected === 'boolean' && typeof health.polling === 'boolean' && 'last_sample_time' in health
  ok('PRD§6 get_device_health', '健康状态', JSON.stringify(health), !!healthOk)

  const alarms = await call('list_alarm_rules', {})
  ok('PRD§5 list_alarm_rules', '告警规则查看', 'rules=' + (alarms?.length ?? 'null'), Array.isArray(alarms))

  const qh = await call('query_history', { device_id: 1, register_id: 1, start: '2000-01-01T00:00:00Z', end: '2100-01-01T00:00:00Z' })
  ok('§5.15 MCP', 'query_history', 'rows=' + (qh?.length ?? 'null'), Array.isArray(qh) && qh.length > 0)

  const wrm = await call('write_register', { device_id: 2, register_id: targetReg.id, value: 888 })
  ok('PRD§6 write_register 忠实执行', 'write_register', JSON.stringify(wrm), wrm != null)

  await client.close()
  ok('§5.15 MCP', '连接/协议', 'streamable-http OK', true)
} catch (e: any) {
  ok('§5.15 MCP', 'MCP 测试', 'EXCEPTION: ' + e.message, false)
  mcpSection.push({ error: e.message })
}

// ============ 输出 ============
const pass = results.filter((r) => r.pass).length
const fail = results.filter((r) => !r.pass).length
console.log('=== 规格符合性测试 ===')
for (const r of results) console.log(`${r.pass ? '✅' : '❌'} [${r.spec}] ${r.label} | ${r.detail}`)
console.log(`\nTOTAL: ${pass} pass / ${fail} fail / ${results.length} checks`)
console.log('MCP tools=' + JSON.stringify(mcpSection))
