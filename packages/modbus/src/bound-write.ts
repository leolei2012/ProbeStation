import net from 'node:net'
import { randomInt } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { SerialPort } from 'serialport'
import type { GuardedWritePlan } from '../../core/src/guarded-register-write.ts'

export interface BoundWire {
  events: EventEmitter
  open(): Promise<void>
  ready(): boolean
  write(frame: Buffer): void
  close(): Promise<void>
}
export type BoundWireFactory = (plan: GuardedWritePlan) => BoundWire
export function writeCrc(bytes: Buffer) {
  let crc = 0xffff
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >> 1) ^ 0xa001 : crc >> 1 }
  return crc
}
export function boundWriteFrame(plan: GuardedWritePlan, transaction: number): Buffer {
  const address = plan.source.register.startAddress, unit = plan.source.group.slaveId
  const pdu = Buffer.alloc(plan.functionCode === 6 ? 5 : 6 + plan.words.length * 2)
  pdu[0] = plan.functionCode; pdu.writeUInt16BE(address, 1)
  if (plan.functionCode === 6) pdu.writeUInt16BE(plan.words[0], 3)
  else { pdu.writeUInt16BE(plan.words.length, 3); pdu[5] = plan.words.length * 2; plan.words.forEach((w, i) => pdu.writeUInt16BE(w, 6 + i * 2)) }
  if (plan.source.device.transport === 'tcp') {
    const header = Buffer.alloc(7); header.writeUInt16BE(transaction); header.writeUInt16BE(pdu.length + 1, 4); header[6] = unit
    return Buffer.concat([header, pdu])
  }
  const body = Buffer.concat([Buffer.from([unit]), pdu]), crc = Buffer.alloc(2); crc.writeUInt16LE(writeCrc(body))
  return Buffer.concat([body, crc])
}

/** Fresh per-operation native handle. Never uses SDK queues, cached clients, raw OTA sockets or reconnect. */
export function createNativeBoundWire(plan: GuardedWritePlan, constructors = { tcp: () => new net.Socket(), serial: (options: any) => new SerialPort(options) }): BoundWire {
  const d = plan.source.device, tcp = d.transport === 'tcp'
  const port = tcp ? constructors.tcp() : constructors.serial({ path: d.serialPath!, baudRate: d.baudRate, parity: d.parity as 'none' | 'even' | 'odd',
    stopBits: d.stopBits as 1 | 2, dataBits: 8, rtscts: d.flowControl === 'rtscts', xon: d.flowControl === 'xonxoff', xoff: d.flowControl === 'xonxoff', autoOpen: false, lock: true })
  // Error listener remains through close/late OS callbacks. Operation listener handles the actual result.
  port.on('error', () => {})
  let closed = false
  const close = async () => {
    closed = true
    if (tcp) { (port as net.Socket).destroy(); return }
    const serial = port as SerialPort
    if (serial.isOpen) await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('串口关闭结果未确认。')), 2000)
      serial.close(error => { clearTimeout(timer); if (error) reject(error); else resolve() })
    })
  }
  return {
    events: port,
    ready: () => !closed && !port.destroyed && port.writable && port.writableLength === 0 && (tcp ? !(port as net.Socket).connecting : (port as SerialPort).isOpen),
    open: () => new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: Error | null) => {
        if (settled) { if (closed) void close().catch(() => {}); return }
        settled = true; clearTimeout(timer); port.off('error', fail); port.off('close', onClose)
        if (error) { void close().catch(() => {}); reject(error) } else if (closed) reject(new Error('连接已关闭。')); else resolve()
      }
      const fail = (error: Error) => finish(error), onClose = () => finish(new Error('连接在打开前关闭。'))
      const timer = setTimeout(() => finish(new Error('连接超时，尚未发送。')), plan.timeoutMs)
      port.once('error', fail); port.once('close', onClose)
      if (tcp) (port as net.Socket).connect({ host: d.ip, port: d.port }, () => finish())
      else (port as SerialPort).open(error => { if (error || closed) finish(error ?? new Error('串口已失效。')); else (port as SerialPort).flush(flushError => finish(flushError)) })
    }),
    write: bytes => { if (closed) throw new Error('连接已失效。'); port.write(bytes) },
    close,
  }
}
export const nativeBoundWire: BoundWireFactory = plan => createNativeBoundWire(plan)

export type BoundWriteOutcome = { state: 'acknowledged' | 'not-sent' | 'unknown'; message: string }
export async function executeBoundWrite(plan: GuardedWritePlan, accept: (send: () => void) => void, current: () => boolean,
  factory: BoundWireFactory = nativeBoundWire, capture: (direction: 'tx' | 'rx', bytes: Buffer) => void = () => {}): Promise<BoundWriteOutcome> {
  const wire = factory(plan), transaction = randomInt(1, 65536), frame = boundWriteFrame(plan, transaction), tcp = plan.source.device.transport === 'tcp'
  let submitted = false, timer: ReturnType<typeof setTimeout> | undefined
  let data = Buffer.alloc(0), settle: ((outcome: BoundWriteOutcome) => void) | undefined
  const fail = (error: unknown) => settle?.({ state: submitted ? 'unknown' : 'not-sent', message: (error instanceof Error ? error.message : String(error)) + (submitted ? '；可能已执行，请现场核实，不要自动重发。' : '；未提交写入。') })
  const onData = (bytes: Buffer) => {
    if (!submitted || !settle) return
    try { capture('rx', bytes) } catch { /* diagnostics cannot change command outcome */ }
    data = Buffer.concat([data, bytes])
    if (data.length > 260) { fail(new Error('响应长度异常')); return }
    let pdu: Buffer
    if (tcp) {
      if (data.length < 7) return
      const length = data.readUInt16BE(4)
      if (length < 2 || length > 254 || data.readUInt16BE(0) !== transaction || data.readUInt16BE(2) !== 0 || data[6] !== plan.source.group.slaveId) { fail(new Error('响应事务或从站不匹配')); return }
      if (data.length < length + 6) return
      if (data.length !== length + 6) { fail(new Error('响应帧不唯一')); return }
      pdu = data.subarray(7)
    } else {
      if (data.length < 2) return
      const length = data[1] & 0x80 ? 5 : 8
      if (data.length < length) return
      if (data.length !== length || data[0] !== plan.source.group.slaveId || writeCrc(data.subarray(0, -2)) !== data.readUInt16LE(data.length - 2)) { fail(new Error('RTU 响应地址、长度或 CRC 不匹配')); return }
      pdu = data.subarray(1, -2)
    }
    if (pdu[0] === (plan.functionCode | 0x80) && pdu.length === 2) { fail(new Error('设备返回 Modbus 异常码 ' + pdu[1])); return }
    const expected = tcp ? frame.subarray(7, 12) : frame.subarray(1, 6)
    if (pdu.length !== 5 || !pdu.equals(expected)) { fail(new Error('写入回执的功能码、地址、值或数量不匹配')); return }
    settle({ state: 'acknowledged', message: '设备已返回匹配的 Modbus 写入回执。此回执不等于压缩机已实际运转。' })
  }
  const onError = (error: Error) => fail(error), onClose = () => fail(new Error('连接在确认结果前关闭'))
  try {
    if (!current()) throw new Error('写入来源已失效')
    await wire.open()
    if (!current()) throw new Error('排队或连接期间来源已变化')
    wire.events.on('data', onData); wire.events.on('error', onError); wire.events.on('close', onClose)
    const response = new Promise<BoundWriteOutcome>(resolve => { settle = resolve })
    timer = setTimeout(() => fail(new Error('等待写入回执超时')), plan.timeoutMs)
    try {
      accept(() => {
        if (!current() || !wire.ready()) throw new Error('发送前来源或连接已失效')
        // Mark before calling native write: a synchronous exception can occur after acceptance.
        submitted = true
        wire.write(frame)
      })
      try { capture('tx', frame) } catch { /* preserve outcome */ }
    } catch (error) { fail(error) }
    return await response
  } catch (error) { return { state: submitted ? 'unknown' : 'not-sent', message: (error as Error).message + (submitted ? '；结果未知，不自动重发。' : '；未提交写入。') } }
  finally {
    settle = undefined; if (timer) clearTimeout(timer)
    wire.events.off('data', onData); wire.events.off('error', onError); wire.events.off('close', onClose)
    await wire.close()
  }
}
