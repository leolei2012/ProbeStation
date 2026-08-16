import {
  crc32, crc16, buildStartPdu, buildDataPdu, buildEndPdu, buildStatusPdu,
  wrapRtu, wrapTcp, parseResponsePdu, unwrapRtu, unwrapTcp, expectLen,
  CMD_START, CMD_STATUS, ST_OK,
} from '../packages/ota/src/frame.ts'

// 1) CRC32 对拍标准向量
const hex = (n: number) => '0x' + (n >>> 0).toString(16).toUpperCase().padStart(8, '0')
if (crc32(Buffer.from('123456789')) !== 0xCBF43926) throw new Error('crc32 123456789 mismatch')
if (crc32(Buffer.from('The quick brown fox jumps over the lazy dog')) !== 0x414FA339) throw new Error('crc32 quick brown fox mismatch')
if (crc32(Buffer.alloc(0)) !== 0) throw new Error('crc32 empty mismatch')
console.log('crc32 standard vectors OK')

// 2) 与 iap_demo.c 的 fw[300]（fw[i]=i*7+3）对拍
const fw = Buffer.alloc(300)
for (let i = 0; i < 300; i++) fw[i] = (i * 7 + 3) & 0xff
if (crc32(fw) !== 0xDE0E57CE) throw new Error('crc32 fw[300] mismatch: ' + hex(crc32(fw)))
console.log('crc32(iap_demo fw[300]) =', hex(crc32(fw)), 'OK')

// 3) START PDU 字节布局：0x41,0x01,total_size=300(0x0000012C),crc32=0x12345678
const start = buildStartPdu(300, 0x12345678)
const expectPdu = '41010000012c12345678'
if (start.toString('hex') !== expectPdu) throw new Error('START PDU mismatch: ' + start.toString('hex'))
console.log('START PDU =', start.toString('hex'), 'OK')

// 4) RTU 封装：addr=1 + PDU + CRC16(低字节在前)，且 unwrap 回环
const rtu = wrapRtu(start, 1)
if (rtu[0] !== 1) throw new Error('RTU addr mismatch')
// 帧头应为 01 41 01 00 00 01 2C 12 34 56 78
if (rtu.subarray(0, 11).toString('hex') !== '01' + expectPdu) throw new Error('RTU head mismatch: ' + rtu.subarray(0, 11).toString('hex'))
const back = unwrapRtu(rtu)
if (!back.equals(start)) throw new Error('RTU roundtrip mismatch')
console.log('RTU frame =', rtu.toString('hex'), '(crc16=0x' + crc16(rtu.subarray(0, rtu.length - 2)).toString(16) + ') OK')

// 5) TCP 封装 + 回环
const tcp = wrapTcp(start, 1, 0x0001)
if (tcp.readUInt16BE(0) !== 1 || tcp.readUInt16BE(2) !== 0 || tcp.readUInt16BE(4) !== 11 || tcp[6] !== 1) throw new Error('MBAP header mismatch')
if (!unwrapTcp(tcp).equals(start)) throw new Error('TCP roundtrip mismatch')
console.log('TCP frame =', tcp.toString('hex'), 'OK')

// 6) STATUS 响应解析（status + next_block 大端）
const statusResp = Buffer.from([0x41, CMD_STATUS, ST_OK, 0x00, 0x05]) // next_block=5
const parsed = parseResponsePdu(statusResp)
if (parsed.cmd !== CMD_STATUS || parsed.status !== ST_OK || parsed.nextBlock !== 5) throw new Error('STATUS parse mismatch: ' + JSON.stringify(parsed))
console.log('STATUS response parse =', JSON.stringify(parsed), 'OK')

// 7) expectLen
if (expectLen('rtu', CMD_START) !== 6 || expectLen('rtu', CMD_STATUS) !== 8) throw new Error('rtu expectLen mismatch')
if (expectLen('tcp', CMD_START) !== 10 || expectLen('tcp', CMD_STATUS) !== 12) throw new Error('tcp expectLen mismatch')
console.log('expectLen OK')

// 8) DATA/END PDU 字节布局
const data = buildDataPdu(0, Buffer.from([1, 2, 3]))
if (data.toString('hex') !== '41020000010203') throw new Error('DATA PDU mismatch: ' + data.toString('hex'))
const end = buildEndPdu(3)
if (end.toString('hex') !== '41030003') throw new Error('END PDU mismatch: ' + end.toString('hex'))
if (buildStatusPdu().toString('hex') !== '4104') throw new Error('STATUS PDU mismatch')
console.log('DATA/END/STATUS PDU OK')

console.log('OTA FRAME TEST OK')
process.exit(0)
