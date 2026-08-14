import type { Context } from 'cordis'
import z from 'schemastery'

export const name = 'poller'
export const inject = ['modbus', 'store']

export interface RegisterGroup {
  id: number
  functionCode: number
  startAddress: number
  quantity: number
}

export interface Device {
  id: number
  host: string
  port: number
  groups: RegisterGroup[]
}

export interface Config {
  pollIntervalMs: number
}

export const Config: z<Config> = z.object({
  pollIntervalMs: z.number().default(1000),
})

/** Polling engine: reads every group of a device and writes samples to the store. */
class PollingEngine {
  constructor(private readonly ctx: any, private readonly config: Config) {}

  async pollOnce(device: Device): Promise<void> {
    const driver = this.ctx.modbus.createDriver()
    await driver.connect(device.host, device.port)
    try {
      const points: Array<Record<string, unknown>> = []
      for (const g of device.groups) {
        const values: number[] = await driver.readHoldingRegisters(g.startAddress, g.quantity)
        for (let i = 0; i < values.length; i++) {
          points.push({
            objectId: device.id,
            registerId: g.startAddress + i, // TODO: replace with real register ids from config store
            timestamp: new Date().toISOString(),
            rawValue: values[i],
            quality: 'good',
          })
        }
      }
      this.ctx.emit('poller/result', { objectId: device.id, points })
      this.ctx.store.write(points)
      await this.ctx.store.flush()
    } finally {
      driver.disconnect()
    }
  }
}

export function apply(ctx: Context, config: Config): void {
  ctx.provide('poller', new PollingEngine(ctx, config))
}
