import {
  areaForFunction,
  assertModbusRequest,
  classifyModbusError,
  quantityForRequest,
  validateModbusRequest,
  type ModbusRequest,
} from '../packages/core/src/protocol.ts'
import { executeModbusRequest, type ModbusDriver } from '../packages/modbus/src/index.ts'

let failures = 0
const check = (condition: unknown, label: string): void => {
  if (condition) console.log('OK  ' + label)
  else { failures++; console.error('FAIL ' + label) }
}

check(areaForFunction(1) === 'coil' && areaForFunction(15) === 'coil', 'FC01/15 map to coil')
check(areaForFunction(2) === 'discrete-input', 'FC02 maps to discrete input')
check(areaForFunction(3) === 'holding-register' && areaForFunction(16) === 'holding-register', 'FC03/16 map to holding register')
check(areaForFunction(4) === 'input-register', 'FC04 maps to input register')

const valid: ModbusRequest[] = [
  { slaveId: 1, functionCode: 1, startAddress: 0, quantity: 2000 },
  { slaveId: 1, functionCode: 3, startAddress: 0, quantity: 125 },
  { slaveId: 0, functionCode: 5, startAddress: 1, values: [true] },
  { slaveId: 1, functionCode: 6, startAddress: 1, values: [65535] },
  { slaveId: 1, functionCode: 15, startAddress: 1, values: [true, false] },
  { slaveId: 1, functionCode: 16, startAddress: 1, values: [1, 2, 3] },
]
for (const request of valid) check(validateModbusRequest(request).length === 0, `valid FC${request.functionCode}`)

const invalid: Array<[ModbusRequest, string]> = [
  [{ slaveId: 0, functionCode: 3, startAddress: 0, quantity: 1 }, 'broadcast read'],
  [{ slaveId: 248, functionCode: 3, startAddress: 0, quantity: 1 }, 'slave range'],
  [{ slaveId: 1, functionCode: 3, startAddress: 0, quantity: 126 }, 'FC03 max quantity'],
  [{ slaveId: 1, functionCode: 1, startAddress: 65535, quantity: 2 }, 'address overflow'],
  [{ slaveId: 1, functionCode: 5, startAddress: 0, values: [1] }, 'coil boolean type'],
  [{ slaveId: 1, functionCode: 16, startAddress: 0, values: [65536] }, 'register uint16 range'],
]
for (const [request, label] of invalid) check(validateModbusRequest(request).length > 0, 'reject ' + label)

check(quantityForRequest({ slaveId: 1, functionCode: 16, startAddress: 0, values: [1, 2] }) === 2, 'derive write quantity')
try { assertModbusRequest(invalid[0][0]); check(false, 'assert invalid request') } catch { check(true, 'assert invalid request') }

check(classifyModbusError(new Error('Timeout')).code === 'timeout', 'classify timeout')
check(classifyModbusError(new Error('RTU CRC mismatch')).code === 'crc_mismatch', 'classify CRC')
check(classifyModbusError(new Error('Serial port COM3 open failed: SetCommState')).code === 'serial_open_error', 'classify serial open')
check(classifyModbusError({ err: 'ModbusException', response: { body: { code: 2 } } }).exceptionCode === 2, 'classify exception code')

const calls: string[] = []
const fake: ModbusDriver = {
  async connect() {}, async disconnect() {}, isConnected: () => true,
  async readCoils(address, count, slaveId) { calls.push(`r1:${slaveId}:${address}:${count}`); return [true, false] },
  async readDiscreteInputs(address, count, slaveId) { calls.push(`r2:${slaveId}:${address}:${count}`); return [false, true] },
  async readHoldingRegisters(address, count, slaveId) { calls.push(`r3:${slaveId}:${address}:${count}`); return [10, 20] },
  async readInputRegisters(address, count, slaveId) { calls.push(`r4:${slaveId}:${address}:${count}`); return [30] },
  async writeRegister(address, value, slaveId) { calls.push(`w6:${slaveId}:${address}:${value}`) },
  async writeRegisters(address, values, slaveId) { calls.push(`w16:${slaveId}:${address}:${values.join(',')}`) },
  execute(request) { return executeModbusRequest(this, request) },
  async getRawSocket() { return null },
  getDiagnostics() { return { scope: 'device', txFrames: 0, rxFrames: 0, successCount: 0, errorCount: 0, timeoutCount: 0, consecutiveErrors: 0, recentErrorRate: 0, bufferedFrames: 0 } },
  getFrames() { return [] }, clearDiagnostics() {},
}

const r3 = await fake.execute({ slaveId: 2, functionCode: 3, startAddress: 100, quantity: 2 })
check(r3.ok && r3.values?.join(',') === '10,20' && calls[0] === 'r3:2:100:2', 'execute FC03 through compatibility layer')
const w16 = await fake.execute({ slaveId: 3, functionCode: 16, startAddress: 200, values: [7, 8] })
check(w16.ok && calls[1] === 'w16:3:200:7,8', 'execute FC16 through compatibility layer')
const r1 = await fake.execute({ slaveId: 1, functionCode: 1, startAddress: 0, quantity: 2 })
check(r1.ok && r1.values?.join(',') === 'true,false' && calls[2] === 'r1:1:0:2', 'execute FC01 through compatibility layer')
const r2 = await fake.execute({ slaveId: 4, functionCode: 2, startAddress: 8, quantity: 2 })
check(r2.ok && r2.values?.join(',') === 'false,true' && calls[3] === 'r2:4:8:2', 'execute FC02 through compatibility layer')

console.log(failures === 0 ? 'PROTOCOL TEST OK' : `PROTOCOL TEST FAILED: ${failures}`)
process.exit(failures === 0 ? 0 : 1)
