import { boot } from './_bootstrap.ts'

// ============================================================
// 配置变更 → config/changed 事件 → WS 广播（前端同步）回归
// 覆盖：MCP/任意调用方改动元数据（连接/断开设备 = 打开/关闭串口）时，web 能收到同步事件。
// ============================================================

const { ctx } = await boot({ api: { port: 18080 } })
const cfg = ctx.get('config', false)
const obj = cfg.createObject('RTU-COM3', '127.0.0.1', 502, 'master', {
  transport: 'rtu', serialPath: 'COM3', baudRate: 9600, parity: 'none', stopBits: 1, dataBits: 8, flowControl: 'none',
})
const gid = cfg.createGroup(obj.id, 'g', 3, 0, 3).id

const app = ctx.get('api', false)
await app.listen({ host: '127.0.0.1', port: 18080 })

const ws = new WebSocket('ws://127.0.0.1:18080/ws')
await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('ws connect failed')) })
const received: string[] = []
ws.onmessage = (e) => received.push(String(e.data))
await new Promise((r) => setTimeout(r, 200)) // 等 initial latest

// 1) 断开设备（isActive=0，对应「关闭串口」）→ 应收到 config/changed
cfg.updateObject(obj.id, { isActive: 0 })
await new Promise((r) => setTimeout(r, 300))
if (cfg.getObject(obj.id)!.isActive !== 0) throw new Error('isActive not deactivated')
const syncs1 = received.filter((s) => s.includes('config/changed') && s.includes('"scope":"object"'))
if (syncs1.length === 0) throw new Error('no config/changed(object) after disconnect; received=' + JSON.stringify(received))

// 2) 重新连接（isActive=1，对应「打开串口」）→ 再收到一次
cfg.updateObject(obj.id, { isActive: 1 })
await new Promise((r) => setTimeout(r, 300))
const syncs2 = received.filter((s) => s.includes('config/changed') && s.includes('"scope":"object"'))
if (syncs2.length < 2) throw new Error('expected 2 config/changed(object), got ' + syncs2.length)

// 3) 分组变更也应广播（scope=group）
cfg.updateGroup(gid, { pollIntervalMs: 500 })
await new Promise((r) => setTimeout(r, 300))
const syncs3 = received.filter((s) => s.includes('config/changed') && s.includes('"scope":"group"'))
if (syncs3.length === 0) throw new Error('no config/changed(group) after group update')

console.log('object config/changed:', JSON.stringify(syncs2))
console.log('group config/changed:', JSON.stringify(syncs3))
console.log('CONFIG SYNC TEST OK')

ws.close()
await app.close()
process.exit(0)
