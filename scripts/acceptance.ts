const base = 'http://127.0.0.1:8080'
const out: string[] = []
const ok = (label: string, detail: string) => out.push(`✅ ${label}  ${detail}`)
const bad = (label: string, detail: string) => out.push(`❌ ${label}  ${detail}`)

async function get(label: string, url: string) {
  try {
    const res = await fetch(base + url)
    const text = await res.text()
    if (res.ok) ok(label, 'HTTP ' + res.status + ' | ' + text.slice(0, 90))
    else bad(label, 'HTTP ' + res.status)
  } catch (e: any) { bad(label, e.message) }
}
async function post(label: string, url: string, body: unknown) {
  try {
    const res = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const text = await res.text()
    if (res.ok) ok(label, 'HTTP ' + res.status + ' | ' + text.slice(0, 90))
    else bad(label, 'HTTP ' + res.status + ' ' + text)
  } catch (e: any) { bad(label, e.message) }
}

await get('健康检查 /health', '/health')
await get('前端首页 /', '/')
await get('设备列表', '/api/monitor_objects')
await get('模拟器实时值 (latest)', '/api/monitor_objects/2/latest')

// 写寄存器（写模拟器设备 id=2 的寄存器）
const regs = JSON.parse(await (await fetch(base + '/api/groups/2/registers')).text())
const target = regs[0]
await post('写寄存器 (FC16)', '/api/registers/' + target.id + '/write', { value: 123, method: 'multiple' })

// 历史查询
await get('历史查询', '/api/data/query?object_id=2&address=' + target.startAddress + '&start=2000-01-01T00:00:00Z&end=2100-01-01T00:00:00Z')
// 导出
await get('CSV 导出', '/api/export/csv?object_id=2&start=2000-01-01T00:00:00Z&end=2100-01-01T00:00:00Z')
// 规则
await get('规则列表', '/api/rules')
await post('新建规则', '/api/rules', { registerId: target.id, operator: '>', threshold: 100, message: '测试告警' })
// 日志
await get('日志', '/api/logs')

console.log(out.join('\n'))
