import crc from 'crc'

/** CRC-32/ISO-HDLC（poly 0xEDB88320，init/xorout 0xFFFFFFFF，反射），返回 uint32。 */
export function crc32(buf: Buffer): number {
  return crc.crc32(buf) >>> 0
}

/** Modbus RTU CRC16（poly 0xA001，init 0xFFFF），帧尾低字节在前。 */
export function crc16(buf: Buffer): number {
  return crc.crc16modbus(buf)
}

export const IAP_FC = 0x41
export const CMD_START = 0x01
export const CMD_DATA = 0x02
export const CMD_END = 0x03
export const CMD_STATUS = 0x04

export const ST_OK = 0x00
export const ST_BAD_BLOCK = 0x01
export const ST_BAD_LEN = 0x02
export const ST_NOT_ACTIVE = 0x03
export const ST_INTERNAL = 0x04

/** START 请求 PDU：0x41,0x01,total_size(4B),fw_crc32(4B)，均大端。 */
export function buildStartPdu(totalSize: number, fwCrc32: number): Buffer {
  const b = Buffer.alloc(10)
  b[0] = IAP_FC
  b[1] = CMD_START
  b.writeUInt32BE(totalSize >>> 0, 2)
  b.writeUInt32BE(fwCrc32 >>> 0, 6)
  return b
}

/** DATA 请求 PDU：0x41,0x02,block_no(2B),data(N)。 */
export function buildDataPdu(blockNo: number, data: Buffer): Buffer {
  const b = Buffer.alloc(4 + data.length)
  b[0] = IAP_FC
  b[1] = CMD_DATA
  b.writeUInt16BE(blockNo, 2)
  data.copy(b, 4)
  return b
}

/** END 请求 PDU：0x41,0x03,total_blocks(2B)。 */
export function buildEndPdu(totalBlocks: number): Buffer {
  const b = Buffer.alloc(4)
  b[0] = IAP_FC
  b[1] = CMD_END
  b.writeUInt16BE(totalBlocks, 2)
  return b
}

/** STATUS 请求 PDU：0x41,0x04。 */
export function buildStatusPdu(): Buffer {
  return Buffer.from([IAP_FC, CMD_STATUS])
}

/** RTU 封装：addr(1B) + PDU + crc16(2B 低字节在前)。 */
export function wrapRtu(pdu: Buffer, slaveId: number): Buffer {
  const frame = Buffer.alloc(1 + pdu.length + 2)
  frame[0] = slaveId
  pdu.copy(frame, 1)
  frame.writeUInt16LE(crc16(frame.subarray(0, 1 + pdu.length)), 1 + pdu.length)
  return frame
}

/** TCP 封装：MBAP(7B: tx(2)+proto(2=0)+len(2)+unit(1)) + PDU。 */
export function wrapTcp(pdu: Buffer, unitId: number, txId: number): Buffer {
  const frame = Buffer.alloc(7 + pdu.length)
  frame.writeUInt16BE(txId, 0)
  frame.writeUInt16BE(0, 2)
  frame.writeUInt16BE(1 + pdu.length, 4)
  frame[6] = unitId
  pdu.copy(frame, 7)
  return frame
}

/** 解析响应 PDU：返回 { cmd, status, nextBlock? }。 */
export function parseResponsePdu(pdu: Buffer): { cmd: number; status: number; nextBlock?: number } {
  if (pdu.length < 3 || pdu[0] !== IAP_FC) throw new Error('bad IAP response PDU: ' + pdu.toString('hex'))
  const cmd = pdu[1]
  const status = pdu[2]
  let nextBlock: number | undefined
  if (cmd === CMD_STATUS && pdu.length >= 5) nextBlock = pdu.readUInt16BE(3)
  return { cmd, status, nextBlock }
}

/** 从 RTU 响应帧解出 PDU（校验 CRC16，去 addr+crc）。 */
export function unwrapRtu(frame: Buffer): Buffer {
  if (frame.length < 5) throw new Error('RTU frame too short')
  const body = frame.subarray(0, frame.length - 2)
  if (crc16(body) !== frame.readUInt16LE(frame.length - 2)) throw new Error('RTU CRC mismatch')
  return frame.subarray(1, frame.length - 2)
}

/** 从 TCP 响应帧解出 PDU（去 MBAP 头）。 */
export function unwrapTcp(frame: Buffer): Buffer {
  if (frame.length < 8) throw new Error('TCP frame too short')
  const len = frame.readUInt16BE(4)
  if (frame.length < 6 + len) throw new Error('TCP frame incomplete')
  return frame.subarray(7, 6 + len)
}

/** 各命令响应帧的完整长度（RTU / TCP），供按长度收帧。 */
export function expectLen(transport: 'tcp' | 'rtu', cmd: number): number {
  const pduLen = cmd === CMD_STATUS ? 5 : 3
  return transport === 'tcp' ? 7 + pduLen : 1 + pduLen + 2
}
