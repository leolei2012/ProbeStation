import assert from 'node:assert/strict'
import net from 'node:net'
import { once } from 'node:events'
import Fastify from 'fastify'
import { ModbusTCPClient } from 'jsmodbus'
import { SerialPortMock } from 'serialport'
import { ModbusSlave } from '../packages/slave/src/index.ts'
import { SlaveMemory, RtuSlaveSession, rtuFrame, crc16 } from '../packages/slave/src/protocol.ts'
import { registerSlave } from '../packages/api/src/slave.ts'
const memory = new SlaveMemory(128)
const pdu = (hex: string) => Buffer.from(hex, 'hex')
assert.equal(memory.respond(pdu('0600011234')).toString('hex'), '0600011234')
assert.equal(memory.respond(pdu('0300010001')).toString('hex'), '03021234')
assert.equal(memory.respond(pdu('10000200020400100020')).toString('hex'), '1000020002')
assert.equal(memory.respond(pdu('0300020002')).toString('hex'), '030400100020')
assert.equal(memory.respond(pdu('050001ff00')).toString('hex'), '050001ff00')
assert.equal(memory.respond(pdu('0100010001')).toString('hex'), '010101')
assert.equal(memory.respond(pdu('0f00000009025501')).toString('hex'), '0f00000009')
assert.equal(memory.respond(pdu('0100000009')).toString('hex'), '01025501')
memory.write('input-register', 0, [321]); memory.write('discrete-input', 0, [1])
assert.equal(memory.respond(pdu('0400000001')).toString('hex'), '04020141')
assert.equal(memory.respond(pdu('0200000001')).toString('hex'), '020101')
for (const [request, expected] of [['03007f0002','8302'],['1000010002040001','9003'],['0500010001','8503'],['0300000000','8303'],['030000007e','8303'],['1100000001','9101']]) assert.equal(memory.respond(pdu(request)).toString('hex'), expected)
assert.equal(memory.areas['holding-register'][1], 0x1234, 'malformed writes cannot partially change values')
assert.throws(() => memory.write('coil', 0, [1, 2])); assert.equal(memory.areas.coil[0], 1)
let responses: Buffer[] = []
const rtu = new RtuSlaveSession(memory, 7, frame => responses.push(frame))
const read = rtuFrame(7, pdu('0300010001'))
rtu.feed(read.subarray(0, 3)); rtu.feed(read.subarray(3))
assert.equal(responses[0].toString('hex'), rtuFrame(7, pdu('03021234')).toString('hex'))
assert.equal(crc16(responses[0].subarray(0,-2)), responses[0].readUInt16LE(responses[0].length - 2))
const count = responses.length
rtu.feed(rtuFrame(8, pdu('060001000a'))); assert.equal(responses.length, count); assert.equal(memory.areas['holding-register'][1], 0x1234)
rtu.feed(rtuFrame(0, pdu('060001000a'))); assert.equal(responses.length, count); assert.equal(memory.areas['holding-register'][1], 10)
const corrupt = Buffer.from(read); corrupt[corrupt.length-1] ^= 1
rtu.feed(Buffer.concat([corrupt, read, read])); assert.equal(responses.length, count + 2)
rtu.reset()
SerialPortMock.binding.reset(); SerialPortMock.binding.createPort('SLAVE_TEST', { record: true })
let serial!: SerialPortMock
class TestPort extends SerialPortMock { constructor(options: any) { super(options); serial = this } }
const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe,'listening'); const port = (probe.address() as net.AddressInfo).port; await new Promise<void>(resolve => probe.close(()=>resolve()))
const slave = new ModbusSlave({ port, holdingSize: 128 }, TestPort)
const socket = new net.Socket()
const api = Fastify(); registerSlave(api, slave)
try {
  await slave.start('tcp', { host:'127.0.0.1', unitId:7 }); const client = new ModbusTCPClient(socket, 7, 1000)
  socket.connect(port,'127.0.0.1'); await once(socket,'connect')
  await client.writeSingleRegister(1, 456); assert.equal(slave.getRegister(1),456)
  assert.deepEqual((await client.readHoldingRegisters(1,1)).response.body.valuesAsArray,[456])
  await client.writeMultipleRegisters(2,[10,20]); assert.deepEqual(slave.read('holding-register',2,2),[10,20])
  await client.writeSingleCoil(1,true); assert.equal(slave.read('coil',1,1)[0],1)
  await client.writeMultipleCoils(2,[true,false,true]); assert.deepEqual(slave.read('coil',2,3),[1,0,1])
  assert.equal((await client.readCoils(1,1)).response.body.valuesAsArray[0], 1)
  slave.write('input-register',0,[999]); assert.deepEqual((await client.readInputRegisters(0,1)).response.body.valuesAsArray,[999])
  slave.write('discrete-input',0,[1]); await client.readDiscreteInputs(0,1)
  await slave.start('rtu', { serialPath:'SLAVE_TEST', unitId:7 })
  serial.port!.emitData(rtuFrame(7,pdu('06000100ff')))
  for (let i=0;i<50 && slave.getRegister(1)!==255;i++) await new Promise(resolve=>setTimeout(resolve,5))
  assert.equal(slave.getRegister(1),255, 'serial transport applies RTU request to shared memory')
  assert.equal(serial.port!.recording.toString('hex'),rtuFrame(7,pdu('06000100ff')).toString('hex'))
  assert.deepEqual((await client.readHoldingRegisters(1,1)).response.body.valuesAsArray,[255])
  assert.equal((await api.inject({method:'GET',url:'/api/slave'})).statusCode,200)
  assert.equal((await api.inject({method:'PUT',url:'/api/slave/values',payload:{area:'coil',address:0,values:[2]}})).statusCode,400)
  assert.equal((await api.inject({method:'PUT',url:'/api/slave/values',payload:{area:'holding-register',address:3,values:[65535]}})).statusCode,200)
  assert.equal(slave.getRegister(3),65535)
  assert.equal((await api.inject({method:'POST',url:'/api/slave/start',payload:{transport:'bad'}})).statusCode,400)
  assert.equal((await api.inject({method:'GET',url:'/api/slave/values?area=holding-register&address=127&count=2'})).statusCode,400)
  await slave.stop('rtu'); assert.equal(slave.status().rtu.running,false)
  await slave.stop('tcp'); assert.equal(slave.status().tcp.running,false)
  await slave.start('tcp',{host:'127.0.0.1'}); assert.equal(slave.getRegister(1),255)
  const occupied = new ModbusSlave({port,holdingSize:128})
  await assert.rejects(()=>occupied.start('tcp',{host:'127.0.0.1'}),/占用/)
  assert.equal(occupied.status().tcp.running,false); await occupied.stop()
  console.log('SLAVE OK: all data areas, TCP reads/writes, RTU serial binding, CRC, broadcast, address isolation, invalid requests, API validation, restart and occupied port')
} finally { socket.destroy(); await slave.stop('tcp'); await slave.stop('rtu'); await api.close(); SerialPortMock.binding.reset() }
