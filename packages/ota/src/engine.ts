import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  crc32, buildStartPdu, buildDataPdu, buildEndPdu, buildStatusPdu,
  wrapRtu, wrapTcp, unwrapRtu, unwrapTcp, parseResponsePdu, expectLen,
  CMD_START, CMD_DATA, CMD_END, CMD_STATUS, ST_OK, ST_BAD_BLOCK,
} from './frame.ts'

export type UpgradeState = 'idle' | 'starting' | 'transferring' | 'verifying' | 'done' | 'failed' | 'aborted'

export interface UpgradeTask {
  deviceId: number
  state: UpgradeState
  currentBlock: number
  totalBlocks: number
  percent: number
  error?: string
}

/** 默认 IAP 单块数据字节数（对齐设备侧 MB_IAP_MAX_DATA=128）。 */
export const DEFAULT_CHUNK_SIZE = 128

export class OtaEngine {
  private tasks = new Map<number, UpgradeTask>()
  private busy = new Map<number, Promise<void>>()

  constructor(private ctx: any) {}

  /** 工作区 firmware 目录（随工作区自包含）。 */
  private firmwareDir(): string {
    const dir = resolve(this.ctx.workspace.getCurrent(), 'firmware')
    mkdirSync(dir, { recursive: true })
    return dir
  }

  /** 上传固件：落盘 + 记录 + 算 CRC32。返回 { firmware_id, size, crc32 }。 */
  uploadFirmware(name: string, version: string, content: Buffer): { firmware_id: number; size: number; crc32: number } {
    const size = content.length
    const c = crc32(content)
    const rec = this.ctx.config.createFirmware(name, version, size, c, null)
    const rel = 'firmware/firmware_' + rec.id + '.bin'
    writeFileSync(join(this.firmwareDir(), 'firmware_' + rec.id + '.bin'), content)
    this.ctx.config.setFirmwarePath(rec.id, rel)
    return { firmware_id: rec.id, size, crc32: c }
  }

  listFirmwares(): any[] { return this.ctx.config.listFirmwares() }

  /** 读固件内容。 */
  private readFirmware(firmwareId: number): { content: Buffer; rec: any } {
    const rec = this.ctx.config.getFirmware(firmwareId)
    if (!rec) throw new Error('firmware not found')
    const abs = rec.filePath
      ? resolve(this.ctx.workspace.getCurrent(), rec.filePath)
      : join(this.firmwareDir(), 'firmware_' + rec.id + '.bin')
    return { content: readFileSync(abs), rec }
  }

  /** 发起升级（异步，立即返回）。 */
  startUpgrade(deviceId: number, firmwareId: number, chunkSize?: number): { task_id: string; device_id: number } {
    const obj = this.ctx.config.getObject(deviceId)
    if (!obj) throw new Error('device not found')
    if (this.busy.has(deviceId)) throw new Error('device is already upgrading')
    const chunk = chunkSize ?? DEFAULT_CHUNK_SIZE
    const task: UpgradeTask = { deviceId, state: 'starting', currentBlock: 0, totalBlocks: 0, percent: 0 }
    this.tasks.set(deviceId, task)
    const run = this.runUpgrade(obj, firmwareId, chunk, task).finally(() => this.busy.delete(deviceId))
    this.busy.set(deviceId, run)
    return { task_id: 'ota_' + deviceId, device_id: deviceId }
  }

  getStatus(deviceId: number): UpgradeTask | { state: 'idle' } {
    return this.tasks.get(deviceId) ?? { state: 'idle' }
  }

  abort(deviceId: number): { ok: boolean } {
    const task = this.tasks.get(deviceId)
    if (task && (task.state === 'starting' || task.state === 'transferring' || task.state === 'verifying')) task.state = 'aborted'
    return { ok: true }
  }

  /** 实际升级：START → DATA（支持断点续传）→ END。 */
  private async runUpgrade(obj: any, firmwareId: number, chunkSize: number, task: UpgradeTask): Promise<void> {
    const deviceId = obj.id
    this.ctx.poller.pauseObject(deviceId)
    try {
      const { content, rec } = this.readFirmware(firmwareId)
      const transport: 'tcp' | 'rtu' = obj.transport === 'rtu' ? 'rtu' : 'tcp'
      const slaveId: number = obj.slaveId ?? 1
      const socket = await this.ctx.poller.getRawSocket(deviceId)
      const totalBlocks = Math.ceil(content.length / chunkSize)
      task.totalBlocks = totalBlocks
      let txId = 1

      const exchange = async (pdu: Buffer, cmd: number): Promise<{ status: number; nextBlock?: number }> => {
        if (task.state === 'aborted') throw new Error('aborted')
        const frame = transport === 'rtu' ? wrapRtu(pdu, slaveId) : wrapTcp(pdu, slaveId, txId++)
        const respFrame = await rawExchange(socket, frame, expectLen(transport, cmd))
        const respPdu = transport === 'rtu' ? unwrapRtu(respFrame) : unwrapTcp(respFrame)
        return parseResponsePdu(respPdu)
      }

      task.state = 'starting'
      const startR = await exchange(buildStartPdu(content.length, rec.crc32), CMD_START)
      if (startR.status !== ST_OK) throw new Error('START failed status=' + startR.status)

      task.state = 'transferring'
      let block = 0
      while (block < totalBlocks) {
        if (task.state === 'aborted') throw new Error('aborted')
        const off = block * chunkSize
        const data = content.subarray(off, Math.min(off + chunkSize, content.length))
        const r = await exchange(buildDataPdu(block, data), CMD_DATA)
        if (r.status === ST_OK) {
          block++
          task.currentBlock = block
          task.percent = Math.floor((block / totalBlocks) * 100)
        } else if (r.status === ST_BAD_BLOCK) {
          const s = await exchange(buildStatusPdu(), CMD_STATUS)
          block = s.nextBlock ?? block
        } else {
          throw new Error('DATA block ' + block + ' failed status=' + r.status)
        }
      }

      task.state = 'verifying'
      const endR = await exchange(buildEndPdu(totalBlocks), CMD_END)
      if (endR.status !== ST_OK) throw new Error('END failed status=' + endR.status)

      task.state = 'done'
      task.percent = 100
    } catch (e: any) {
      if (task.state === 'aborted') task.state = 'aborted'
      else { task.state = 'failed'; task.error = e?.message ?? String(e) }
    } finally {
      this.ctx.poller.resumeObject(deviceId)
      try { await this.ctx.poller.reconnectDevice(deviceId) } catch { /* ignore */ }
    }
  }
}

/** 原始字节收发：发 frame，读恰好 expectLen 字节（带超时）。 */
function rawExchange(socket: any, frame: Buffer, expectLen: number, timeoutMs = 8000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0)
    let done = false
    const finish = (fn: () => void) => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.off('data', onData)
      fn()
    }
    const timer = setTimeout(() => finish(() => reject(new Error('OTA response timeout'))), timeoutMs)
    const onData = (chunk: Buffer) => {
      if (done) return
      buf = Buffer.concat([buf, chunk])
      if (buf.length >= expectLen) finish(() => resolve(buf.subarray(0, expectLen)))
    }
    socket.on('data', onData)
    try {
      socket.write(frame, (err: any) => { if (err) finish(() => reject(err)) })
    } catch (e) { finish(() => reject(e)) }
  })
}
