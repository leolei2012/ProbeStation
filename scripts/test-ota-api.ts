import { boot } from './_bootstrap.ts'

const { ctx } = await boot({ api: { port: 18888 } })
const app = ctx.get('api', false)

// 上传固件（raw 二进制）
const fw = Buffer.from('hello-firmware-bytes')
const res = await app.inject({ method: 'POST', url: '/api/firmware/upload?name=test&version=1.0', headers: { 'content-type': 'application/octet-stream' }, payload: fw })
console.log('upload:', res.statusCode, res.body)
const uploaded = JSON.parse(res.body)
if (res.statusCode !== 200 || uploaded.size !== fw.length) throw new Error('upload failed')

// 列表
const list = await app.inject({ method: 'GET', url: '/api/firmwares' })
console.log('list:', list.statusCode, list.body)
if (!JSON.parse(list.body).some((f: any) => f.id === uploaded.firmware_id)) throw new Error('list missing firmware')

// 状态（未升级，idle）
const st = await app.inject({ method: 'GET', url: '/api/ota/status?device_id=1' })
console.log('status:', st.statusCode, st.body)
if (JSON.parse(st.body).state !== 'idle') throw new Error('status not idle')

console.log('OTA API TEST OK')
process.exit(0)
