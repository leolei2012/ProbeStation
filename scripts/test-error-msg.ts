import net from 'node:net'
import { ModbusTCPServer } from 'jsmodbus'
import { Context } from 'cordis'
import * as modbusPlugin from '../packages/modbus/src/index.ts'

const netServer = new net.Server()
const holding = Buffer.alloc(10 * 2) // 10 个保持寄存器
const slave = new ModbusTCPServer(netServer, { holding, coils: Buffer.alloc(0), discrete: Buffer.alloc(0), input: Buffer.alloc(0) })
await new Promise<void>((resolve) => netServer.listen(18503, '127.0.0.1', resolve))

const ctx = new Context()
await ctx.plugin(modbusPlugin, { defaultTimeoutMs: 1500, defaultUnitId: 1 })
const driver = ctx.get('modbus', false).createDriver()
await driver.connect('127.0.0.1', 18503)

// 写越界地址（服务器对写操作做边界检查）→ 期望抛 Illegal Data Address（不是 [object Object]）
try {
  await driver.writeRegister(100, 1, 1)
  console.log('WRITE ILLEGAL: NO ERROR (unexpected)')
} catch (e) {
  console.log('WRITE ILLEGAL message =', (e as any).message)
}

// 正常读取
const vals = await driver.readHoldingRegisters(0, 2, 1)
console.log('NORMAL read =', JSON.stringify(vals))

driver.disconnect()
netServer.close()
process.exit(0)
