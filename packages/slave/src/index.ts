import type { Context } from 'cordis'
import z from 'schemastery'
import net from 'node:net'
import { ModbusTCPServer } from 'jsmodbus'

export const name = 'slave'

export interface Config {
  port: number
  holdingSize: number
}

export const Config: z<Config> = z.object({
  port: z.number().default(8502),
  holdingSize: z.number().default(5000),
})

/**
 * Modbus TCP 从站模拟器（jsmodbus）。holding 缓冲区即寄存器内存，
 * 支持 FC03 读 / FC06 单写 / FC16 多写。用于本地测试与设备仿真。
 */
export class ModbusSlave {
  private readonly holding: Buffer
  private readonly netServer: net.Server
  private readonly server: ModbusTCPServer

  constructor(private readonly config: Config) {
    this.holding = Buffer.alloc(config.holdingSize * 2)
    this.netServer = new net.Server()
    this.server = new ModbusTCPServer(this.netServer, {
      holding: this.holding,
      coils: Buffer.alloc(1024),
      discrete: Buffer.alloc(1024),
      input: Buffer.alloc(1024),
    })
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.netServer.listen(this.config.port, '0.0.0.0', resolve))
  }

  stop(): void {
    this.netServer.close()
  }

  /** 写一个 holding 寄存器（uint16）。 */
  setRegister(address: number, value: number): void {
    this.holding.writeUInt16BE(value & 0xffff, address * 2)
  }

  /** 读一个 holding 寄存器（uint16）。 */
  getRegister(address: number): number {
    return this.holding.readUInt16BE(address * 2)
  }
}

export function apply(ctx: Context, config: Config): void {
  const slave = new ModbusSlave(config)
  ctx.provide('slave', slave)
  void slave.start().then(() => {
    ctx.logger('slave').info(`slave listening on 0.0.0.0:${config.port}`)
  })
}
