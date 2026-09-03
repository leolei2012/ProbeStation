import { boot } from './_bootstrap.ts'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

// 固件删除回归：上传 → 落盘 → 删除 → 记录与文件都清掉
const { ctx, dir } = await boot()
const ota = ctx.get('ota', false)

const r = ota.uploadFirmware('test.bin', '1.0.0', Buffer.from([1, 2, 3, 4]))
if (ota.listFirmwares().length !== 1) throw new Error('upload failed, list=' + JSON.stringify(ota.listFirmwares()))

const rec = ctx.get('config', false).getFirmware(r.firmware_id)
const abs = join(dir, 'firmware', 'firmware_' + rec.id + '.bin')
if (!existsSync(abs)) throw new Error('firmware file not written to disk: ' + abs)

const d = ota.deleteFirmware(r.firmware_id)
if (!d.ok) throw new Error('delete returned not ok')
if (ota.listFirmwares().length !== 0) throw new Error('firmware record not deleted')
if (existsSync(abs)) throw new Error('firmware file not removed from disk: ' + abs)

console.log('FIRMWARE DELETE OK (record + file both removed)')
process.exit(0)
