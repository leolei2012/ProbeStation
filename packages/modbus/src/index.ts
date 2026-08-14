import type { Context } from 'cordis'
import z from 'schemastery'
import net from 'node:net'
import { ModbusTCPClient } from 'jsmodbus'

/** Cordis plugin name. */
export const name = 'modbus'

export interface Config {
  defaultTimeoutMs: number
  defaultUnitId: number
}

export const Config: z<Config> = z.object({
  defaultTimeoutMs: z.number().default(3000),
  defaultUnitId: z.number().default(1),
})

/** Transport-agnostic Modbus driver, mirroring the legacy Python abstraction. */
export interface ModbusDriver {
  connect(host: string, port: number): Promise<void>
  disconnect(): void
  isConnected(): boolean
  readHoldingRegisters(address: number, count: number): Promise<number[]>
  readInputRegisters(address: number, count: number): Promise<number[]>
  writeRegister(address: number, value: number): Promise<void>
  writeRegisters(address: number, values: number[]): Promise<void>
}

/** jsmodbus provider of {@link ModbusDriver}. */
class JsmodbusDriver implements ModbusDriver {
  private socket: net.Socket | null = null
  private client: ModbusTCPClient | null = null

  constructor(private readonly config: Config) {}

  async connect(host: string, port: number): Promise<void> {
    this.socket = new net.Socket()
    this.client = new ModbusTCPClient(this.socket, this.config.defaultUnitId, this.config.defaultTimeoutMs)
    await new Promise<void>((resolve, reject) => {
      const s = this.socket!
      s.once('connect', resolve)
      s.once('error', reject)
      s.connect(port, host)
    })
  }

  disconnect(): void {
    this.socket?.destroy()
    this.socket = null
    this.client = null
  }

  isConnected(): boolean {
    return this.socket !== null && !this.socket.destroyed && this.socket.writable
  }

  private requireClient(): ModbusTCPClient {
    if (!this.client) throw new Error('modbus driver is not connected')
    return this.client
  }

  private static toValues(body: any): number[] {
    if (body.isException) throw new Error(`modbus exception code=${body.exceptionCode ?? body.code}`)
    const arr = body.valuesAsArray as number[] | undefined
    return arr ? Array.from(arr) : []
  }

  async readHoldingRegisters(address: number, count: number): Promise<number[]> {
    const res = await this.requireClient().readHoldingRegisters(address, count)
    return JsmodbusDriver.toValues(res.response.body)
  }

  async readInputRegisters(address: number, count: number): Promise<number[]> {
    const res = await this.requireClient().readInputRegisters(address, count)
    return JsmodbusDriver.toValues(res.response.body)
  }

  async writeRegister(address: number, value: number): Promise<void> {
    const res = await this.requireClient().writeSingleRegister(address, value)
    JsmodbusDriver.toValues(res.response.body)
  }

  async writeRegisters(address: number, values: number[]): Promise<void> {
    const res = await this.requireClient().writeMultipleRegisters(address, values)
    JsmodbusDriver.toValues(res.response.body)
  }
}

/** Provide `ctx.modbus` (driver factory) to consumers. */
export function apply(ctx: Context, config: Config): void {
  ctx.provide('modbus', {
    createDriver(): ModbusDriver {
      return new JsmodbusDriver(config)
    },
  })
}
