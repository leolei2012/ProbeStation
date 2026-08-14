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
const body = res.response.body
console.log('read 10 registers (FC03):', Array.from(body.valuesAsArray))
socket.destroy()
console.log('DEVICE TEST OK')
