import { boot } from './_bootstrap.ts'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { ctx, dir } = await boot({ api: {} })
const app = ctx.get('api', false)

let res = await app.inject({ method: 'GET', url: '/api/workspace' })
console.log('workspace:', res.statusCode, res.body)

// 工作区 A 建设备
res = await app.inject({ method: 'POST', url: '/api/monitor_objects', payload: { name: '设备A', ip: '1.2.3.4', port: 502 } })
console.log('create A:', res.statusCode)

// 切到工作区 B（空）
const wsB = mkdtempSync(join(tmpdir(), 'probestation-b-'))
res = await app.inject({ method: 'POST', url: '/api/workspace/switch', payload: { path: wsB } })
console.log('switch to B:', res.statusCode, res.body)
res = await app.inject({ method: 'GET', url: '/api/monitor_objects' })
console.log('B objects (expect []):', res.body)

// B 里建设备
res = await app.inject({ method: 'POST', url: '/api/monitor_objects', payload: { name: '设备B', ip: '2.3.4.5', port: 502 } })
console.log('create B:', res.statusCode)

// 切回 A，设备A 还在
res = await app.inject({ method: 'POST', url: '/api/workspace/switch', payload: { path: dir } })
console.log('switch back to A:', res.statusCode)
res = await app.inject({ method: 'GET', url: '/api/monitor_objects' })
console.log('A objects (expect 设备A):', res.body)

// browse
res = await app.inject({ method: 'GET', url: '/api/workspace/browse?path=' + encodeURIComponent(dir) })
console.log('browse A:', res.statusCode, res.body)

console.log('WORKSPACE TEST OK')
process.exit(0)
