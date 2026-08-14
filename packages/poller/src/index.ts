import type { Context } from 'cordis'
import z from 'schemastery'

export const name = 'poller'
export const inject = ['config', 'modbus', 'store']

export interface RegisterGroup { id: number; functionCode: number; startAddress: number; quantity: number; slaveId?: number }
export interface Device { id: number; host: string; port: number; groups: RegisterGroup[] }

export interface Config { pollIntervalMs: number }
export const Config: z<Config> = z.object({ pollIntervalMs: z.number().default(1000) })

/** 轮询引擎：按设备循环，按组 scan rate（poll_interval_ms）与 slave id 独立轮询。 */
class PollingEngine {
  private drivers = new Map<number, any>()
  private timers: NodeJS.Timeout[] = []
  private lastPoll = new Map<number, number>()
  private groupErrors = new Map<number, string>()

  constructor(private readonly ctx: any, private readonly config: Config) {}

  /** 一次性轮询（测试/手动）：忽略 scan rate，读所有组。 */
  async pollOnce(device: Device): Promise<void> {
    const driver = this.ctx.modbus.createDriver()
    await driver.connect(device.host, device.port)
    try {
      const points: Array<Record<string, unknown>> = []
      for (const g of device.groups) {
        const values: number[] = g.functionCode === 4
          ? await driver.readInputRegisters(g.startAddress, g.quantity, g.slaveId ?? 1)
          : await driver.readHoldingRegisters(g.startAddress, g.quantity, g.slaveId ?? 1)
        for (let i = 0; i < values.length; i++) {
          points.push({ objectId: device.id, registerId: g.startAddress + i, timestamp: new Date().toISOString(), rawValue: values[i], quality: 'good' })
        }
      }
      this.ctx.emit('poller/result', { objectId: device.id, points })
      this.ctx.store.write(points)
      await this.ctx.store.flush()
    } finally { driver.disconnect() }
  }

  startAll(): void {
    const objects = this.ctx.config.listObjects().filter((o: any) => o.isActive && o.mode !== 'slave')
    for (const obj of objects) {
      const loop = () => { void this.pollObject(obj).catch((e) => this.logPollError(obj, e)) }
      void loop()
      this.timers.push(setInterval(loop, this.config.pollIntervalMs))
    }
    this.ctx.logger('poller').info('started polling ' + objects.length + ' device(s)')
  }

  stopAll(): void {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    for (const d of this.drivers.values()) d.disconnect()
    this.drivers.clear()
  }

  /** 写寄存器（FC06/FC16），复用持久连接，按 slave id 路由。 */
  async write(objectId: number, address: number, value: number, method: 'single' | 'multiple' = 'multiple', slaveId = 1): Promise<void> {
    const obj = this.ctx.config.getObject(objectId)
    if (!obj) throw new Error('object ' + objectId + ' not found')
    const driver = await this.getDriver(obj)
    if (method === 'multiple') await driver.writeRegisters(address, [value], slaveId)
    else await driver.writeRegister(address, value, slaveId)
  }

  private async pollObject(obj: any): Promise<void> {
    const groups = this.ctx.config.listGroups(obj.id).filter((g: any) => g.isActive)
    const registers = this.ctx.config.listRegistersByObject(obj.id)
    const addrToId = new Map<number, number>()
    for (const r of registers) addrToId.set(r.startAddress, r.id)

    const now = Date.now()
    const due = groups.filter((g: any) => now - (this.lastPoll.get(g.id) ?? 0) >= (g.pollIntervalMs ?? this.config.pollIntervalMs))
    if (due.length === 0) return
    for (const g of due) this.lastPoll.set(g.id, now)

    // 连接失败：该设备所有到期分组都标错
    let driver: any
    try {
      driver = await this.getDriver(obj)
    } catch (e) {
      const msg = this.errMsg(e)
      for (const g of due) this.setGroupError(obj.id, g.id, msg)
      return
    }

    const points: Array<Record<string, unknown>> = []
    for (const g of due) {
      try {
        const values: number[] = g.functionCode === 4
          ? await driver.readInputRegisters(g.startAddress, g.quantity, g.slaveId ?? 1)
          : await driver.readHoldingRegisters(g.startAddress, g.quantity, g.slaveId ?? 1)
        this.clearGroupError(g.id)
        for (let i = 0; i < values.length; i++) {
          const addr = g.startAddress + i
          points.push({ objectId: obj.id, registerId: addrToId.get(addr) ?? addr, timestamp: new Date().toISOString(), rawValue: values[i], quality: 'good' })
        }
      } catch (e) {
        this.setGroupError(obj.id, g.id, this.errMsg(e))
      }
    }
    if (points.length > 0) {
      this.ctx.emit('poller/result', { objectId: obj.id, points })
      this.ctx.store.write(points)
    }
  }

  private errMsg(e: any): string {
    return e && e.message ? e.message : String(e)
  }

  private setGroupError(objectId: number, groupId: number, msg: string): void {
    if (this.groupErrors.get(groupId) !== msg) {
      this.groupErrors.set(groupId, msg)
      this.ctx.emit('poller/group-error', { objectId, groupId, error: msg })
    }
  }

  private clearGroupError(groupId: number): void {
    if (this.groupErrors.has(groupId)) {
      this.groupErrors.delete(groupId)
      this.ctx.emit('poller/group-ok', { groupId })
    }
  }

  private logPollError(obj: any, e: any): void {
    const msg = e && e.message ? e.message : String(e)
    this.ctx.logger('poller').warn('poll ' + obj.name + ' failed: ' + msg)
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

export function apply(ctx: Context, config: Config): void { ctx.provide('poller', new PollingEngine(ctx, config)) }
