import type { Context } from 'cordis'
import z from 'schemastery'
import net from 'node:net'
import { ModbusTCPClient } from 'jsmodbus'

export const name = 'modbus'

export interface Config {
  defaultTimeoutMs: number
  defaultUnitId: number
}

export const Config: z<Config> = z.object({
  defaultTimeoutMs: z.number().default(3000),
  defaultUnitId: z.number().default(1),
})

const EXC_MSG: Record<number, string> = { 1: 'Illegal Function', 2: 'Illegal Data Address', 3: 'Illegal Data Value', 4: 'Slave Device Failure', 5: 'Acknowledge', 6: 'Slave Device Busy', 8: 'Memory Parity Error', 10: 'Gateway Path Unavailable', 11: 'Gateway Target Failed to Respond' }

/** 传输无关的 Modbus 驱动抽象。每个 slave id（unit id）一个 TCP 连接。 */
export interface ModbusDriver {
  connect(host: string, port: number): Promise<void>
  disconnect(): void
  isConnected(): boolean
  readHoldingRegisters(address: number, count: number, slaveId?: number): Promise<number[]>
  readInputRegisters(address: number, count: number, slaveId?: number): Promise<number[]>
  writeRegister(address: number, value: number, slaveId?: number): Promise<void>
  writeRegisters(address: number, values: number[], slaveId?: number): Promise<void>
}

class JsmodbusDriver implements ModbusDriver {
  private host = ''
  private port = 0
  private ready = false
  private readonly clients = new Map<number, { socket: net.Socket; client: ModbusTCPClient }>()

  constructor(private readonly config: Config) {}

  async connect(host: string, port: number): Promise<void> {
    this.host = host
    this.port = port
    this.ready = true
  }

  disconnect(): void {
    for (const c of this.clients.values()) c.socket.destroy()
    this.clients.clear()
    this.ready = false
  }

  isConnected(): boolean { return this.ready }

  private async getClient(slaveId: number): Promise<ModbusTCPClient> {
    const existing = this.clients.get(slaveId)
    if (existing && !existing.socket.destroyed && existing.socket.writable) return existing.client
    const socket = new net.Socket()
    const client = new ModbusTCPClient(socket, slaveId, this.config.defaultTimeoutMs)
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
      socket.connect(this.port, this.host)
    })
    this.clients.set(slaveId, { socket, client })
    return client
  }

  private static toValues(body: any): number[] {
    if (body.isException) {
      const code = body.code ?? body.exceptionCode
      throw new Error(EXC_MSG[code] ?? body.message ?? ('Modbus exception ' + code))
    }
    const arr = body.valuesAsArray as number[] | undefined
    return arr ? Array.from(arr) : []
  }

  private static normalize(e: any): Error {
    if (e && e.err === 'Timeout') return new Error('Timeout')
    return e instanceof Error ? e : new Error(String(e))
  }

  async readHoldingRegisters(address: number, count: number, slaveId = 1): Promise<number[]> {
    try {
      const res = await (await this.getClient(slaveId)).readHoldingRegisters(address, count)
      return JsmodbusDriver.toValues(res.response.body)
    } catch (e) { throw JsmodbusDriver.normalize(e) }
  }

  async readInputRegisters(address: number, count: number, slaveId = 1): Promise<number[]> {
    try {
      const res = await (await this.getClient(slaveId)).readInputRegisters(address, count)
      return JsmodbusDriver.toValues(res.response.body)
    } catch (e) { throw JsmodbusDriver.normalize(e) }
  }

  async writeRegister(address: number, value: number, slaveId = 1): Promise<void> {
    try {
      const res = await (await this.getClient(slaveId)).writeSingleRegister(address, value)
      JsmodbusDriver.toValues(res.response.body)
    } catch (e) { throw JsmodbusDriver.normalize(e) }
  }

  async writeRegisters(address: number, values: number[], slaveId = 1): Promise<void> {
    try {
      const res = await (await this.getClient(slaveId)).writeMultipleRegisters(address, values)
      JsmodbusDriver.toValues(res.response.body)
    } catch (e) { throw JsmodbusDriver.normalize(e) }
  }
}

export function apply(ctx: Context, config: Config): void {
  ctx.provide('modbus', {
    createDriver(): ModbusDriver { return new JsmodbusDriver(config) },
  })
}
