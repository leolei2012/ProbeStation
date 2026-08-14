import { Context } from 'cordis'
import * as slavePlugin from '../packages/slave/src/index.ts'
import * as modbusPlugin from '../packages/modbus/src/index.ts'

const ctx = new Context()
await ctx.plugin(slavePlugin, { port: 18502, holdingSize: 1000 })
await ctx.plugin(modbusPlugin, { defaultTimeoutMs: 2000, defaultUnitId: 1 })

// wait for slave to listen
await new Promise((r) => setTimeout(r, 300))

const slave = ctx.get('slave', false)
slave.setRegister(0, 1234)
slave.setRegister(1, 5678)
console.log('slave set: addr0=1234 addr1=5678')

const driver = ctx.get('modbus', false).createDriver()
await driver.connect('127.0.0.1', 18502)
const values = await driver.readHoldingRegisters(0, 2)
console.log('client read:', values)

// write via FC16
await driver.writeRegisters(5, [42, 43])
const written = await driver.readHoldingRegisters(5, 2)
console.log('after write addr5..6:', written, '| slave getRegister(5)=', slave.getRegister(5))
driver.disconnect()

console.log('SLAVE TEST OK')
slave.stop()
