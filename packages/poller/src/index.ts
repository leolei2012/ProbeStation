import type { Context } from 'cordis'
import z from 'schemastery'

export const name = 'poller'
export const inject = ['config', 'modbus', 'store']

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

/** Polling engine: reads every active master device's groups and writes samples to the store. */
class PollingEngine {
  private drivers = new Map<number, any>()
  private timers: NodeJS.Timeout[] = []

  constructor(private readonly ctx: any, private readonly config: Config) {}

  /** One-shot poll (tests / manual). registerId falls back to startAddress. */
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
            registerId: g.startAddress + i,
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

  /** Start continuous polling for all active master devices (from config). */
  startAll(): void {
    const objects = this.ctx.config.listObjects().filter((o: any) => o.isActive && o.mode !== 'slave')
    for (const obj of objects) {
      const loop = () => { void this.pollObject(obj).catch((e) => this.ctx.logger('poller').warn(`poll ${obj.name} failed: ${e?.message ?? e}`)) }
      void loop()
      this.timers.push(setInterval(loop, this.config.pollIntervalMs))
    }
    this.ctx.logger('poller').info(`started polling ${objects.length} device(s)`)
  }

  /** Stop all loops and close connections. */
  stopAll(): void {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    for (const d of this.drivers.values()) d.disconnect()
    this.drivers.clear()
  }

  private async pollObject(obj: any): Promise<void> {
    const driver = await this.getDriver(obj)
    try {
      const groups = this.ctx.config.listGroups(obj.id).filter((g: any) => g.isActive)
      const registers = this.ctx.config.listRegistersByObject(obj.id)
      const addrToId = new Map<number, number>()
      for (const r of registers) addrToId.set(r.startAddress, r.id)

      const points: Array<Record<string, unknown>> = []
      for (const g of groups) {
        const values: number[] = await driver.readHoldingRegisters(g.startAddress, g.quantity)
        for (let i = 0; i < values.length; i++) {
          const addr = g.startAddress + i
          points.push({
            objectId: obj.id,
            registerId: addrToId.get(addr) ?? addr,
            timestamp: new Date().toISOString(),
            rawValue: values[i],
            quality: 'good',
          })
        }
      }
      this.ctx.emit('poller/result', { objectId: obj.id, points })
      this.ctx.store.write(points)
    } catch (e) {
      // drop the driver so the next poll reconnects
      const d = this.drivers.get(obj.id)
      if (d) { d.disconnect(); this.drivers.delete(obj.id) }
      throw e
    }
  }

  /** 写一个寄存器（FC06 单写 / FC16 多写），复用持久连接。 */
  async write(objectId: number, address: number, value: number, method: 'single' | 'multiple' = 'multiple'): Promise<void> {
    const obj = this.ctx.config.getObject(objectId)
    if (!obj) throw new Error(`object ${objectId} not found`)
    const driver = await this.getDriver(obj)
    if (method === 'multiple') await driver.writeRegisters(address, [value])
    else await driver.writeRegister(address, value)
  }

  private async getDriver(obj: any): Promise<any> {
    let driver = this.drivers.get(obj.id)
    if (!driver || !driver.isConnected()) {
      driver = this.ctx.modbus.createDriver()
      await driver.connect(obj.ip, obj.port)
      this.drivers.set(obj.id, driver)
    }
    return driver
  }
}

export function apply(ctx: Context, config: Config): void {
  ctx.provide('poller', new PollingEngine(ctx, config))
}
