import net from 'node:net'
import { ModbusTCPClient } from 'jsmodbus'

const socket = new net.Socket()
const client = new ModbusTCPClient(socket, 1, 3000)
await new Promise<void>((resolve, reject) => {
  socket.once('connect', resolve)
  socket.once('error', reject)
  socket.connect(8899, '192.168.90.176')
})
console.log('connected to 192.168.90.176:8899')

const res = await client.readHoldingRegisters(0, 10)
console.log('read 0x0000 x10 (FC03):', Array.from(res.response.body.valuesAsArray))
const res2 = await client.readHoldingRegisters(0x1000, 10)
console.log('read 0x1000 x10 (FC03):', Array.from(res2.response.body.valuesAsArray))
socket.destroy()
console.log('DEVICE TEST OK')
