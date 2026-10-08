import { Buffer } from 'node:buffer'
export type SlaveArea = 'holding-register' | 'input-register' | 'coil' | 'discrete-input'
export const SLAVE_AREAS: SlaveArea[] = ['holding-register', 'input-register', 'coil', 'discrete-input']
export function crc16(data: Buffer): number {
  let crc = 0xffff
  for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1 }
  return crc
}
export function rtuFrame(unitId: number, pdu: Buffer): Buffer {
  const frame = Buffer.concat([Buffer.from([unitId]), pdu, Buffer.alloc(2)])
  frame.writeUInt16LE(crc16(frame.subarray(0, -2)), frame.length - 2)
  return frame
}
export class SlaveMemory {
  readonly areas: Record<SlaveArea, Uint16Array>
  constructor(readonly size = 5000) {
    if (!Number.isInteger(size) || size < 1 || size > 65536) throw new Error('寄存器数量必须为 1–65536')
    this.areas = Object.fromEntries(SLAVE_AREAS.map(area => [area, new Uint16Array(size)])) as Record<SlaveArea, Uint16Array>
  }
  range(area: SlaveArea, address: number, count: number) {
    if (!SLAVE_AREAS.includes(area) || !Number.isInteger(address) || !Number.isInteger(count) || address < 0 || count < 1 || address + count > this.size) throw Object.assign(new Error('数据区域或地址范围无效'), { statusCode: 400 })
    return this.areas[area].subarray(address, address + count)
  }
  write(area: SlaveArea, address: number, values: number[]) {
    const target = this.range(area, address, values.length)
    const max = area === 'coil' || area === 'discrete-input' ? 1 : 65535
    if (values.some(v => !Number.isInteger(v) || v < 0 || v > max)) throw Object.assign(new Error('位值必须为 0/1，寄存器值必须为 0–65535 整数'), { statusCode: 400 })
    target.set(values)
  }
  /** Return an exception PDU for malformed requests; never partially apply writes. */
  respond(pdu: Buffer): Buffer {
    const fc = pdu[0] ?? 0, fail = (code: number) => Buffer.from([fc | 0x80, code])
    if (![1, 2, 3, 4, 5, 6, 15, 16].includes(fc)) return fail(1)
    if (pdu.length < 5) return fail(3)
    const address = pdu.readUInt16BE(1), quantity = pdu.readUInt16BE(3)
    const area: SlaveArea = fc === 1 || fc === 5 || fc === 15 ? 'coil' : fc === 2 ? 'discrete-input' : fc === 4 ? 'input-register' : 'holding-register'
    const count = fc === 5 || fc === 6 ? 1 : quantity
    if (fc <= 4 && (pdu.length !== 5 || count < 1 || count > (fc <= 2 ? 2000 : 125))) return fail(3)
    if (fc === 5 || fc === 6) {
      if (pdu.length !== 5 || fc === 5 && quantity !== 0 && quantity !== 0xff00) return fail(3)
    }
    if (fc === 15 || fc === 16) {
      const bytes = fc === 15 ? Math.ceil(count / 8) : count * 2
      if (count < 1 || count > (fc === 15 ? 1968 : 123) || pdu.length !== 6 + bytes || pdu[5] !== bytes) return fail(3)
    }
    if (address + count > this.size) return fail(2)
    const values = this.range(area, address, count)
    if (fc <= 4) {
      const out = Buffer.alloc(2 + (fc <= 2 ? Math.ceil(count / 8) : count * 2))
      out[0] = fc; out[1] = out.length - 2
      values.forEach((v, i) => { if (fc <= 2) out[2 + (i >> 3)] |= (v & 1) << (i % 8); else out.writeUInt16BE(v, 2 + i * 2) })
      return out
    }
    if (fc === 5 || fc === 6) { values[0] = fc === 5 ? Number(quantity === 0xff00) : quantity; return Buffer.from(pdu) }
    const next = Array.from({ length: count }, (_, i) => fc === 15 ? (pdu[6 + (i >> 3)] >> (i % 8)) & 1 : pdu.readUInt16BE(6 + i * 2))
    values.set(next)
    return Buffer.from(pdu.subarray(0, 5))
  }
}
/** Bounded RTU parser supports split/coalesced frames, CRC resync and silent broadcasts. */
export class RtuSlaveSession {
  private pending = Buffer.alloc(0)
  constructor(private memory: SlaveMemory, private unitId: number, private send: (frame: Buffer) => void, private received: () => void = () => {}) {}
  reset() { this.pending = Buffer.alloc(0) }
  feed(data: Buffer) {
    this.pending = Buffer.concat([this.pending, data]).subarray(-512)
    while (this.pending.length >= 8) {
      const fc = this.pending[1], length = fc === 15 || fc === 16 ? 9 + this.pending[6] : 8
      if (length > 256) { this.pending = this.pending.subarray(1); continue }
      if (this.pending.length < length) return
      const frame = this.pending.subarray(0, length)
      if (crc16(frame.subarray(0, -2)) !== frame.readUInt16LE(length - 2)) { this.pending = this.pending.subarray(1); continue }
      this.pending = this.pending.subarray(length)
      if (frame[0] !== this.unitId && frame[0] !== 0) continue
      const broadcast = frame[0] === 0
      if (broadcast && ![5, 6, 15, 16].includes(fc)) continue
      const response = this.memory.respond(frame.subarray(1, -2)); this.received()
      if (!broadcast) this.send(rtuFrame(this.unitId, response))
    }
  }
}
