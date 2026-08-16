import { SerialDriver } from '../packages/modbus/src/index.ts'
import { SerialPortMock } from 'serialport'
import { createRequire } from 'node:module'
import crc from 'crc'

// @serialport/binding-mock 有 CJS/ESM 双入口（exports.require vs default），
// SerialPortMock 内部用 require() 走 CJS 入口；这里也用 createRequire 拿到同一个实例，否则端口状态不互通。
const require2 = createRequire(import.meta.url)
const { MockBinding } = require2('@serialport/binding-mock')

// 用 MockBinding + SerialPortMock 模拟一条串口，验证 RTU 驱动的连接/读/写（无需真机）
MockBinding.reset()
MockBinding.createPort('COM_TEST', { record: true })

const driver = new SerialDriver({ defaultTimeoutMs: 1000, defaultUnitId: 1 }, SerialPortMock)
await driver.connect({ serialPath: 'COM_TEST', baudRate: 9600, parity: 'even', stopBits: 1, dataBits: 8, flowControl: 'none' })
if (!driver.isConnected()) throw new Error('SerialDriver connect failed')
console.log('SerialDriver connected OK')

const mockPort = (driver as any).serialPort.port // MockPortBinding

// 读 2 个保持寄存器（FC03）：主站发请求 → 从站回 [100, 200]
const readPromise = driver.readHoldingRegisters(0, 2, 1)
await new Promise((r) => setTimeout(r, 30))
const reqFrame = mockPort.lastWrite as Buffer
console.log('master request frame:', reqFrame.toString('hex'))
if (reqFrame[0] !== 0x01 || reqFrame[1] !== 0x03) throw new Error('unexpected request frame: ' + reqFrame.toString('hex'))

const respData = Buffer.from([0x01, 0x03, 0x04, 0x00, 0x64, 0x00, 0xc8])
const respCrc = crc.crc16modbus(respData)
mockPort.emitData(Buffer.concat([respData, Buffer.from([respCrc & 0xff, (respCrc >> 8) & 0xff])]))
const values = await readPromise
if (values[0] !== 100 || values[1] !== 200) throw new Error('read mismatch: ' + JSON.stringify(values))
console.log('readHoldingRegisters:', JSON.stringify(values))

// 写单寄存器（FC06）：主站发请求 → 从站回显
const writePromise = driver.writeRegister(5, 0x1234, 1)
await new Promise((r) => setTimeout(r, 30))
const wReq = mockPort.lastWrite as Buffer
console.log('write request frame:', wReq.toString('hex'))
if (wReq[0] !== 0x01 || wReq[1] !== 0x06) throw new Error('unexpected write frame: ' + wReq.toString('hex'))
const wRespData = Buffer.from([0x01, 0x06, 0x00, 0x05, 0x12, 0x34])
const wCrc = crc.crc16modbus(wRespData)
mockPort.emitData(Buffer.concat([wRespData, Buffer.from([wCrc & 0xff, (wCrc >> 8) & 0xff])]))
await writePromise
console.log('writeRegister OK')

// 多从站共享同一 socket：slaveId=2 也能读（客户端按 unitId 路由）
const read2Promise = driver.readHoldingRegisters(0, 1, 2)
await new Promise((r) => setTimeout(r, 30))
const req2 = mockPort.lastWrite as Buffer
if (req2[0] !== 0x02) throw new Error('unexpected slaveId in frame: ' + req2.toString('hex'))
const resp2Data = Buffer.from([0x02, 0x03, 0x02, 0x00, 0x2a])
const resp2Crc = crc.crc16modbus(resp2Data)
mockPort.emitData(Buffer.concat([resp2Data, Buffer.from([resp2Crc & 0xff, (resp2Crc >> 8) & 0xff])]))
const values2 = await read2Promise
if (values2[0] !== 42) throw new Error('slave2 read mismatch: ' + JSON.stringify(values2))
console.log('slaveId=2 read:', JSON.stringify(values2))

driver.disconnect()
if (driver.isConnected()) throw new Error('disconnect failed')
console.log('RTU TEST OK')
process.exit(0)
