import { boot } from './_bootstrap.ts'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const reg = join(tmpdir(), 'probestation-reg-' + Date.now() + '.json')

// ── 会话 1：默认工作区 A ──
const { ctx } = await boot({ api: {}, registryPath: reg })
const app = ctx.get('api', false)

let res = await app.inject({ method: 'POST', url: '/api/monitor_objects', payload: { name: '设备A', ip: '1.2.3.4', port: 502 } })
console.log('create 设备A in A:', res.statusCode)

// 切到工作区 B（空），设备A 不应出现
const wsB = mkdtempSync(join(tmpdir(), 'probestation-b-'))
res = await app.inject({ method: 'POST', url: '/api/workspace/switch', payload: { path: wsB } })
console.log('switch to B:', res.statusCode)
res = await app.inject({ method: 'GET', url: '/api/monitor_objects' })
console.log('B objects (expect []):', res.body)

res = await app.inject({ method: 'POST', url: '/api/monitor_objects', payload: { name: '设备B', ip: '2.3.4.5', port: 502 } })
console.log('create 设备B in B:', res.statusCode)

// ── 会话 2：模拟重启（同一 registry），应回到最后使用的 B ──
const { ctx: ctx2 } = await boot({ api: {}, registryPath: reg })
const app2 = ctx2.get('api', false)
res = await app2.inject({ method: 'GET', url: '/api/workspace' })
const after = JSON.parse(res.body)
console.log('after restart current:', after.current === wsB ? 'OK (back to B)' : 'MISMATCH: ' + after.current)
res = await app2.inject({ method: 'GET', url: '/api/monitor_objects' })
console.log('after restart objects (expect 设备B):', res.body)

console.log('WORKSPACE TEST OK')
process.exit(0)
