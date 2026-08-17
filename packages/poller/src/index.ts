import type { Context } from 'cordis'
import z from 'schemastery'

export const name = 'poller'
export const inject = ['config', 'modbus', 'store']

export interface RegisterGroup { id: number; functionCode: number; startAddress: number; quantity: number; slaveId?: number }
export interface Device { id: number; host: string; port: number; groups: RegisterGroup[] }

export interface Config { pollIntervalMs: number; connectRetryMs: number; watchdogTimeoutMs: number }
export const Config: z<Config> = z.object({
  pollIntervalMs: z.number().default(1000),
  connectRetryMs: z.number().default(5000),
  watchdogTimeoutMs: z.number().default(30000),
})

/** 轮询引擎：按设备循环，按组 scan rate（poll_interval_ms）与 slave id 独立轮询。 */
class PollingEngine {
  private drivers = new Map<string, any>()
  private rtuLocks = new Map<string, Promise<void>>()
  private paused = new Set<number>()
  private timer: NodeJS.Timeout | undefined
  private running = false
  private lastPoll = new Map<number, number>()
  private groupErrors = new Map<number, string>()
  private connectCooldown = new Map<string, number>() // driverKey -> 最近一次连接失败时间戳（冷却期内不重连）
  private lastOutcomeAt = new Map<number, number>() // objectId -> 最近一次有结果/错误的时间戳（看门狗用）

  constructor(private readonly ctx: any, private readonly config: Config) {}

  /** 一次性轮询（测试/手动）：忽略 scan rate，读所有组。 */
  async pollOnce(device: Device): Promise<void> {
    const driver = this.ctx.modbus.createDriver()
    await driver.connect({ ip: device.host, port: device.port })
    try {
      const points: Array<Record<string, unknown>> = []
      const cycleTs = new Date().toISOString() // 同一轮询周期内所有分组共享时间戳
      for (const g of device.groups) {
        const values: number[] = g.functionCode === 4
          ? await driver.readInputRegisters(g.startAddress, g.quantity, g.slaveId ?? 1)
          : await driver.readHoldingRegisters(g.startAddress, g.quantity, g.slaveId ?? 1)
        for (let i = 0; i < values.length; i++) {
          points.push({ objectId: device.id, address: g.startAddress + i, timestamp: cycleTs, rawValue: values[i], quality: 'good' })
        }
      }
      this.ctx.emit('poller/result', { objectId: device.id, points })
      this.ctx.store.write(points)
      await this.ctx.store.flush()
    } finally { await driver.disconnect() }
  }

  startAll(): void {
    if (this.running) return // 幂等：避免重复建循环
    this.running = true
    // 单一全局循环：每轮动态读所有非 slave 设备，新建/重连的设备自动纳入，断开/删除的自动排除。
    // 下一轮间隔 = 所有启用设备的最小 poll_interval_ms（动态重调度，支持 <1s 采样）。
    const loop = () => {
      if (!this.running) return
      this.timer = undefined
      const objects = this.ctx.config.listObjects().filter((o: any) => o.mode !== 'slave' && !this.paused.has(o.id))
      const tcp: any[] = []
      const rtuByPort = new Map<string, any[]>()
      for (const obj of objects) {
        if (obj.transport === 'rtu' && obj.serialPath) {
          const arr = rtuByPort.get(obj.serialPath) ?? []
          arr.push(obj)
          rtuByPort.set(obj.serialPath, arr)
        } else {
          tcp.push(obj)
        }
      }
      for (const obj of tcp) void this.pollObject(obj).catch((e) => this.logPollError(obj, e))
      for (const [port, objs] of rtuByPort) this.enqueueRtu(port, () => this.pollRtuGroup(objs))
      this.runWatchdog(objects)
      this.releaseUnusedRtuDrivers()
      this.timer = setTimeout(loop, this.nextInterval())
    }
    void loop()
    this.ctx.logger('poller').info('started polling loop')
  }

  async stopAll(): Promise<void> {
    this.running = false
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined }
    const drivers = [...this.drivers.values()]
    this.drivers.clear()
    await Promise.all(drivers.map((d) => Promise.resolve(d.disconnect()).catch(() => {})))
  }

  /** 全局轮询循环是否在跑。 */
  isRunning(): boolean { return this.running }

  /** 下一轮调度间隔 = 所有启用、非 slave、未暂停设备的最小 poll_interval_ms（下限 1ms）。 */
  private nextInterval(): number {
    const objects = this.ctx.config.listObjects().filter((o: any) => o.mode !== 'slave' && !this.paused.has(o.id) && o.isActive === 1)
    let min = this.config.pollIntervalMs
    for (const o of objects) {
      const iv = o.pollIntervalMs ?? this.config.pollIntervalMs
      if (iv < min) min = iv
    }
    return Math.max(1, min)
  }

  /** 某设备当前是否有已建立（未断开）的 Modbus 连接。 */
  isDeviceConnected(objectId: number): boolean {
    const obj = this.ctx.config.getObject(objectId)
    if (!obj) return false
    const d = this.drivers.get(this.driverKey(obj))
    return !!d && d.isConnected()
  }

  /** OTA 升级期间暂停/恢复该设备轮询（避免和升级抢连接，尤其 RTU 半双工）。 */
  pauseObject(objectId: number): void { this.paused.add(objectId) }
  resumeObject(objectId: number): void {
    this.paused.delete(objectId)
    this.lastOutcomeAt.delete(objectId) // 复位看门狗计时，避免恢复后误报
  }
  isPaused(objectId: number): boolean { return this.paused.has(objectId) }

  /** OTA 用：获取某设备的原始连接 socket（复用现有 driver 的 socket，不另开连接）。 */
  async getRawSocket(objectId: number): Promise<any> {
    const obj = this.ctx.config.getObject(objectId)
    if (!obj) throw new Error('object ' + objectId + ' not found')
    const driver = await this.getDriver(obj)
    return await driver.getRawSocket(obj.slaveId ?? 1)
  }

  /** 写寄存器（FC06 单写 / FC16 多写），values 为已按类型编码的 16 位字。 */
  async write(objectId: number, address: number, values: number[], method: 'single' | 'multiple' = 'multiple', slaveId = 1): Promise<void> {
    const obj = this.ctx.config.getObject(objectId)
    if (!obj) throw new Error('object ' + objectId + ' not found')
    const doWrite = async () => {
      const driver = await this.getDriver(obj)
      if (method === 'single') await driver.writeRegister(address, values[0] ?? 0, slaveId)
      else await driver.writeRegisters(address, values, slaveId)
    }
    if (obj.transport === 'rtu' && obj.serialPath) await this.enqueueRtu(obj.serialPath, doWrite)
    else await doWrite()
  }

  private async pollObject(obj: any): Promise<void> {
    if (this.paused.has(obj.id)) return
    // 每轮重新检查设备启停/模式：设备被「断开」后立即停止轮询
    const current = this.ctx.config.getObject(obj.id)
    if (!current || current.mode === 'slave') return
    if (!current.isActive) {
      this.markDisconnected(obj.id)
      return
    }
    const groups = this.ctx.config.listGroups(obj.id).filter((g: any) => g.isActive)

    const now = Date.now()
    const interval = Math.max(1, current.pollIntervalMs ?? this.config.pollIntervalMs)
    const due = groups.filter((g: any) => now - (this.lastPoll.get(g.id) ?? 0) >= interval)
    if (due.length === 0) return
    for (const g of due) this.lastPoll.set(g.id, now)

    // 连接失败冷却：坏串口/坏地址不每轮重建连接（也避免 RTU 串行队列堆积）
    const key = this.driverKey(current)
    const cooldown = this.connectCooldown.get(key)
    if (cooldown != null && now - cooldown < this.config.connectRetryMs) return

    // 连接失败：该设备所有到期分组都标错
    let driver: any
    try {
      driver = await this.getDriver(obj)
      this.connectCooldown.delete(key)
    } catch (e) {
      this.connectCooldown.set(key, Date.now())
      const msg = this.errMsg(e)
      for (const g of due) this.setGroupError(obj.id, g.id, msg)
      return
    }

    const points: Array<Record<string, unknown>> = []
    const cycleTs = new Date().toISOString() // 同一轮询周期内所有分组共享时间戳，避免历史页多分组错位
    for (const g of due) {
      try {
        const values: number[] = g.functionCode === 4
          ? await driver.readInputRegisters(g.startAddress, g.quantity, g.slaveId ?? 1)
          : await driver.readHoldingRegisters(g.startAddress, g.quantity, g.slaveId ?? 1)
        this.clearGroupError(obj.id, g.id)
        for (let i = 0; i < values.length; i++) {
          const addr = g.startAddress + i
          points.push({ objectId: obj.id, address: addr, timestamp: cycleTs, rawValue: values[i], quality: 'good' })
        }
      } catch (e) {
        this.setGroupError(obj.id, g.id, this.errMsg(e))
      }
    }
    if (points.length > 0) {
      this.ctx.emit('poller/result', { objectId: obj.id, points })
      this.ctx.store.write(points)
      this.lastOutcomeAt.set(obj.id, Date.now())
    }
  }

  private errMsg(e: any): string {
    if (!e) return 'Unknown error'
    if (typeof e === 'string') return e
    if (typeof e.message === 'string' && e.message) return e.message
    if (typeof e.err === 'string') return e.err
    try { return JSON.stringify(e) } catch { return String(e) }
  }

  private setGroupError(objectId: number, groupId: number, msg: string): void {
    this.lastOutcomeAt.set(objectId, Date.now())
    if (this.groupErrors.get(groupId) !== msg) {
      this.groupErrors.set(groupId, msg)
      this.ctx.emit('poller/group-error', { objectId, groupId, error: msg })
    }
  }

  private clearGroupError(objectId: number, groupId: number): void {
    if (this.groupErrors.has(groupId)) {
      this.groupErrors.delete(groupId)
      this.ctx.emit('poller/group-ok', { groupId })
      this.lastOutcomeAt.set(objectId, Date.now())
    }
  }

  /**
   * 看门狗兜底：启用且有分组、但长时间既无结果也无错误上报的设备，主动标记故障，
   * 避免像「RTU 串口静默卡死」那样永久无反馈。阈值不低于「最慢分组间隔 × 3 + 5s」，防止长周期分组误报。
   */
  private runWatchdog(objects: any[]): void {
    const now = Date.now()
    for (const obj of objects) {
      if (obj.mode === 'slave' || this.paused.has(obj.id) || !obj.isActive) continue
      const groups = this.ctx.config.listGroups(obj.id).filter((g: any) => g.isActive)
      if (groups.length === 0) continue
      const interval = Math.max(1, obj.pollIntervalMs ?? this.config.pollIntervalMs)
      const threshold = Math.max(this.config.watchdogTimeoutMs, interval * 3 + 1000)
      const last = this.lastOutcomeAt.get(obj.id)
      if (last == null) { this.lastOutcomeAt.set(obj.id, now); continue }
      if (now - last < threshold) continue
      for (const g of groups) this.setGroupError(obj.id, g.id, 'No response (watchdog)')
    }
  }

  private logPollError(obj: any, e: any): void {
    const msg = e && e.message ? e.message : String(e)
    this.ctx.logger('poller').warn('poll ' + obj.name + ' failed: ' + msg)
  }

  /** 编辑设备 ip/port 后调用：断开缓存连接，下次轮询用最新地址重连。 */
  async reconnectDevice(id: number): Promise<void> {
    const obj = this.ctx.config.getObject(id)
    if (!obj) return
    const key = this.driverKey(obj)
    this.connectCooldown.delete(key) // 编辑设备后立即重连，不残留旧冷却
    const d = this.drivers.get(key)
    if (d) { this.drivers.delete(key); await Promise.resolve(d.disconnect()).catch(() => {}) }
  }

  /** 设备被断开/停用：给所有启用分组发「断开」故障（复用 group-error，前端显示 ⚠ 徽标），并释放连接。 */
  private markDisconnected(objectId: number): void {
    const groups = this.ctx.config.listGroups(objectId).filter((g: any) => g.isActive)
    for (const g of groups) this.setGroupError(objectId, g.id, 'Disconnected')
    const obj = this.ctx.config.getObject(objectId)
    // 断开时清掉连接冷却：用户手动「断开→连接」应立即重连，而不是再等冷却期
    if (obj) this.connectCooldown.delete(this.driverKey(obj))
    // TCP 释放该设备自己的连接；RTU 串口由 releaseUnusedRtuDrivers() 按引用计数统一释放
    if (!obj || obj.transport !== 'rtu') {
      const key = 'tcp:' + objectId
      const d = this.drivers.get(key)
      if (d) { this.drivers.delete(key); void d.disconnect() }
    }
  }

  /** 该串口是否仍被至少一台「启用、非 slave」的 RTU 设备使用。 */
  private isRtuPortInUse(serialPath: string): boolean {
    return this.ctx.config.listObjects().some((o: any) =>
      o.transport === 'rtu' && o.serialPath === serialPath && o.mode !== 'slave' && o.isActive === 1)
  }

  /** 引用计数兜底：释放不再被任何启用设备使用的 RTU 串口驱动（覆盖「停用」和「删除」两种场景）。 */
  private releaseUnusedRtuDrivers(): void {
    for (const key of [...this.drivers.keys()]) {
      if (!key.startsWith('rtu:')) continue
      const serialPath = key.slice(4)
      if (this.isRtuPortInUse(serialPath)) continue
      const d = this.drivers.get(key)
      if (d) { this.drivers.delete(key); void d.disconnect() }
    }
  }

  /** 驱动缓存键：TCP 按设备、RTU 按串口（同一条串口共享一个 SerialDriver）。 */
  private driverKey(obj: any): string {
    return obj.transport === 'rtu' ? 'rtu:' + (obj.serialPath ?? '') : 'tcp:' + obj.id
  }

  /** 串口半双工：同一条串口同一时刻只能一个请求在总线上，按 port 串行排队。 */
  private enqueueRtu<T>(serialPath: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.rtuLocks.get(serialPath) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    this.rtuLocks.set(serialPath, run.then(() => undefined, () => undefined))
    return run
  }

  /** 依次轮询同一串口上的多台设备（一个读完再读下一个）。 */
  private async pollRtuGroup(objs: any[]): Promise<void> {
    for (const obj of objs) {
      await this.pollObject(obj).catch((e) => this.logPollError(obj, e))
    }
  }

  private async getDriver(obj: any): Promise<any> {
    // 每轮读最新对象，编辑设备 ip/port 后无需重启即生效
    const fresh = this.ctx.config.getObject(obj.id) ?? obj
    const key = this.driverKey(fresh)
    let driver = this.drivers.get(key)
    if (!driver || !driver.isConnected()) {
      driver = this.ctx.modbus.createDriver(fresh.transport === 'rtu' ? 'rtu' : 'tcp')
      await driver.connect(fresh)
      this.drivers.set(key, driver)
    }
    return driver
  }
}

export function apply(ctx: Context, config: Config): void { ctx.provide('poller', new PollingEngine(ctx, config)) }
