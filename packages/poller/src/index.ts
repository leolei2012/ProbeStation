import type { Context } from 'cordis'
import z from 'schemastery'
import { areaForFunction, type ModbusArea, type ModbusFunctionCode } from '@probebench/core'

export const name = 'poller'
export const inject = ['config', 'modbus', 'store']

export interface RegisterGroup { id: number; functionCode: number; startAddress: number; quantity: number; slaveId?: number }
export interface Device { id: number; host: string; port: number; groups: RegisterGroup[] }

export interface Config { pollIntervalMs: number; connectRetryMs: number; watchdogTimeoutMs: number; autoResetFailThreshold: number; autoResetCooldownMs: number }
export const Config: z<Config> = z.object({
  pollIntervalMs: z.number().default(1000),
  connectRetryMs: z.number().default(5000),
  watchdogTimeoutMs: z.number().default(30000),
  // 连续读失败达阈值即强制重建该通道驱动（重开串口/新建 ModbusRTUClient），
  // 用于设备侧 TX/RX 断线重接后 jsmodbus 失步无法自愈的场景（0 = 关闭自动重建）。
  autoResetFailThreshold: z.number().default(3),
  autoResetCooldownMs: z.number().default(5000),
})

/**
 * 轮询引擎：
 * - 每台设备一个「扫描间隔」，其下分组按 round-robin 依次读（每过一个间隔读一个分组）。
 * - 内存缓存设备/分组配置 + 到期队列调度，避免每 tick 查 SQLite，支持 <10ms 采样。
 * - 写操作走独立通道：写期间暂停该通道（设备/串口）的读取，避免半双工总线冲突。
 */
class PollingEngine {
  private drivers = new Map<string, any>()
  private rtuLocks = new Map<string, Promise<void>>()
  private paused = new Set<number>()
  private timer: NodeJS.Timeout | undefined
  private watchdogTimer: NodeJS.Timeout | undefined
  private running = false
  private groupErrors = new Map<number, string>()
  private connectCooldown = new Map<string, number>() // driverKey -> 最近一次连接失败时间戳（冷却期内不重连）
  private lastOutcomeAt = new Map<number, number>() // objectId -> 最近一次有结果/错误的时间戳（看门狗用）
  private deviceConnected = new Map<number, boolean>() // objectId -> 最近一次连接状态（变更时发 device/status）
  private readFailCount = new Map<string, number>() // driverKey -> 连续读失败次数（累计用于自动重建）
  private lastAutoResetAt = new Map<string, number>() // driverKey -> 最近一次自动重建时间戳（冷却期内不重复重建）

  // 内存缓存 + 到期队列 + round-robin
  private devices: any[] = []
  private groupsByDevice = new Map<number, any[]>()
  private cursor = new Map<number, number>() // deviceId -> 下一个要读的分组下标
  private nextAt = new Map<number, number>() // deviceId -> 下次到期时间（epoch ms）
  private writeLocks = new Set<string>() // driverKey 正在写（写时停读）
  private inflight = new Map<string, number>() // driverKey -> 在途读计数

  constructor(private readonly ctx: any, private readonly config: Config) {
    // 配置变更时刷新内存缓存（避免每 tick 查 SQLite）
    this.ctx.on('config/changed', () => this.refreshSchedule())
  }

  /** 一次性轮询（测试/手动）：忽略扫描间隔，读所有组。 */
  async pollOnce(device: Device): Promise<void> {
    const driver = this.ctx.modbus.createDriver()
    await driver.connect({ ip: device.host, port: device.port })
    try {
      const points: Array<Record<string, unknown>> = []
      const cycleTs = new Date().toISOString()
      for (const g of device.groups) {
        const gapMs = (device as any).pollIntervalMs ?? 0
        const values = await this.readGroup(driver, g, gapMs, (device as any).timeoutMs)
        const area = areaForFunction(g.functionCode as ModbusFunctionCode)
        for (let i = 0; i < values.length; i++) {
          points.push({ objectId: device.id, area, address: g.startAddress + i, timestamp: cycleTs, rawValue: Number(values[i]), quality: 'good' })
        }
      }
      this.ctx.emit('poller/result', { objectId: device.id, points })
      this.ctx.store.write(points)
      await this.ctx.store.flush()
    } finally { await driver.disconnect() }
  }

  startAll(): void {
    if (this.running) return // 幂等
    this.running = true
    this.refreshSchedule()
    // 看门狗独立定时器：即使某设备读卡死（到期队列停摆），也能按固定节奏兜底
    const cadence = Math.max(100, Math.min(1000, this.config.watchdogTimeoutMs / 2))
    this.watchdogTimer = setInterval(() => {
      if (!this.running) return
      this.runWatchdog()
      this.releaseUnusedRtuDrivers()
    }, cadence)
    this.ctx.logger('poller').info('started polling loop (round-robin + deadline queue)')
  }

  async stopAll(): Promise<void> {
    this.running = false
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined }
    if (this.watchdogTimer) { clearInterval(this.watchdogTimer); this.watchdogTimer = undefined }
    const drivers = [...this.drivers.values()]
    this.drivers.clear()
    await Promise.all(drivers.map((d) => Promise.resolve(d.disconnect()).catch(() => {})))
  }

  isRunning(): boolean { return this.running }

  /** 从配置重载设备/分组到内存缓存（配置变更时调用）。 */
  private refreshSchedule(): void {
    const objs = this.ctx.config.listObjects().filter((o: any) => o.mode !== 'slave')
    this.devices = objs
    const next = new Map<number, any[]>()
    for (const o of objs) next.set(o.id, this.ctx.config.listGroups(o.id).filter((g: any) => g.isActive))
    this.groupsByDevice = next
    const now = Date.now()
    for (const id of [...this.nextAt.keys()]) if (!next.has(id)) this.nextAt.delete(id)
    for (const id of [...this.cursor.keys()]) if (!next.has(id)) this.cursor.delete(id)
    for (const o of objs) {
      if (this.nextAt.get(o.id) == null) this.nextAt.set(o.id, now)
      if (this.cursor.get(o.id) == null) this.cursor.set(o.id, 0)
      if (o.isActive !== 1) this.markDisconnected(o.id) // 停用：标记断开 + 释放 TCP 连接
    }
    this.releaseUnusedRtuDrivers() // 停用/删除后立即释放不再使用的串口
    if (this.running) this.schedule()
  }

  /** 到期队列：只在最早到期的设备需要读时唤醒。 */
  private schedule(): void {
    if (!this.running) return
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined }
    const now = Date.now()
    let next = Infinity
    for (const d of this.devices) {
      if (d.isActive !== 1 || this.paused.has(d.id)) continue
      if (this.writeLocks.has(this.driverKey(d))) continue
      const gs = this.groupsByDevice.get(d.id)
      if (!gs || gs.length === 0) continue
      const at = this.nextAt.get(d.id) ?? now
      if (at < next) next = at
    }
    const delay = next === Infinity ? 1000 : Math.max(0, next - now)
    this.timer = setTimeout(() => { this.timer = undefined; this.tick() }, delay)
  }

  /** 到期后：挑最早到期且未在途/未锁/未冷却的设备，读它的下一个分组（round-robin）。 */
  private tick(): void {
    if (!this.running) return
    const now = Date.now()
    let due: any = null
    let dueAt = Infinity
    for (const d of this.devices) {
      if (d.isActive !== 1 || this.paused.has(d.id)) continue
      if (this.writeLocks.has(this.driverKey(d))) continue
      const key = this.driverKey(d)
      const cd = this.connectCooldown.get(key)
      if (cd != null && now - cd < this.config.connectRetryMs) continue
      const gs = this.groupsByDevice.get(d.id)
      if (!gs || gs.length === 0) continue
      const at = this.nextAt.get(d.id) ?? now
      if (at <= now && at < dueAt) { due = d; dueAt = at }
    }
    if (due) void this.pollNextGroup(due).catch((e) => this.logPollError(due, e))
    for (const d of this.devices) this.updateDeviceStatus(d)
    this.schedule()
  }

  /** 读该设备的下一个分组（round-robin），完成后重排到期队列。 */
  private async pollNextGroup(d: any): Promise<void> {
    const gs = this.groupsByDevice.get(d.id)
    if (!gs || gs.length === 0) return
    const idx = this.cursor.get(d.id) ?? 0
    const g = gs[idx % gs.length]
    this.cursor.set(d.id, (idx + 1) % gs.length)
    this.nextAt.set(d.id, Infinity) // 在途标记：Infinity 会被 schedule() 自然跳过
    const key = this.driverKey(d)
    this.inflight.set(key, (this.inflight.get(key) ?? 0) + 1)

    const run = async () => {
      let driver: any
      try {
        driver = await this.getDriver(d)
        this.connectCooldown.delete(key)
      } catch (e) {
        this.connectCooldown.set(key, Date.now())
        this.setGroupError(d.id, g.id, this.errMsg(e))
        return
      }
      try {
        const gapMs = d.pollIntervalMs ?? this.config.pollIntervalMs ?? 0
        const values = await this.readGroup(driver, g, gapMs, d.timeoutMs)
        const area = areaForFunction(g.functionCode as ModbusFunctionCode)
        this.clearGroupError(d.id, g.id)
        this.readFailCount.delete(key) // 一次成功说明串口链路当前可用，清零该串口的连续失败
        const points: Array<Record<string, unknown>> = []
        for (let i = 0; i < values.length; i++) {
          points.push({ objectId: d.id, area, address: g.startAddress + i, timestamp: new Date().toISOString(), rawValue: Number(values[i]), quality: 'good' })
        }
        if (points.length > 0) {
          this.ctx.emit('poller/result', { objectId: d.id, points })
          this.ctx.store.write(points)
          this.lastOutcomeAt.set(d.id, Date.now())
        }
      } catch (e) {
        this.setGroupError(d.id, g.id, this.errMsg(e))
        this.autoResetOnRepeatedFailures(key, d)
      }
    }

    try {
      if (d.transport === 'rtu' && d.serialPath) await this.enqueueRtu(d.serialPath, run)
      else await run()
    } finally {
      this.inflight.set(key, (this.inflight.get(key) ?? 1) - 1)
      if ((this.inflight.get(key) ?? 0) <= 0) this.inflight.delete(key)
      this.nextAt.set(d.id, Date.now() + Math.max(1, d.pollIntervalMs ?? this.config.pollIntervalMs))
      if (this.running) this.schedule()
    }
  }

  /** 某设备当前是否有已建立（未断开）的 Modbus 连接。 */
  isDeviceConnected(objectId: number): boolean {
    const obj = this.ctx.config.getObject(objectId)
    if (!obj) return false
    const d = this.drivers.get(this.driverKey(obj))
    return !!d && d.isConnected()
  }

  listConnectionStates(): Array<{ objectId: number; connected: boolean }> {
    return this.ctx.config.listObjects()
      .filter((o: any) => o.mode !== 'slave')
      .map((o: any) => ({ objectId: o.id, connected: o.isActive === 1 && this.isDeviceConnected(o.id) }))
  }

  listGroupErrors(): Array<{ objectId: number; groupId: number; error: string }> {
    const out: Array<{ objectId: number; groupId: number; error: string }> = []
    for (const [groupId, error] of this.groupErrors) {
      const g = this.ctx.config.getGroup(groupId)
      if (g) out.push({ objectId: g.objectId, groupId, error })
    }
    return out
  }

  /** 连接状态变化时发 device/status（仅在状态翻转时发，避免刷屏）。 */
  private updateDeviceStatus(d: any): void {
    const driver = this.drivers.get(this.driverKey(d))
    const connected = d.isActive === 1 && !!driver && driver.isConnected()
    const prev = this.deviceConnected.get(d.id)
    if (prev === connected) return
    this.deviceConnected.set(d.id, connected)
    this.ctx.emit('device/status', { objectId: d.id, connected })
  }

  getDeviceDiagnostics(objectId: number): Record<string, unknown> {
    const obj = this.ctx.config.getObject(objectId)
    if (!obj) throw new Error('object ' + objectId + ' not found')
    const driver = this.drivers.get(this.driverKey(obj))
    return {
      objectId,
      connected: !!driver && driver.isConnected(),
      scope: obj.transport === 'rtu' ? 'channel' : 'device',
      channelKey: this.driverKey(obj),
      metrics: driver?.getDiagnostics?.() ?? null,
    }
  }

  getDeviceFrames(objectId: number, limit = 200): any[] {
    const obj = this.ctx.config.getObject(objectId)
    if (!obj) throw new Error('object ' + objectId + ' not found')
    const driver = this.drivers.get(this.driverKey(obj))
    if (!driver?.getFrames) return []
    const safeLimit = Math.max(0, Math.min(2000, Math.trunc(limit)))
    const frames = driver.getFrames(obj.transport === 'rtu' ? 2000 : safeLimit)
    if (obj.transport !== 'rtu') return frames
    const slaveIds = new Set(this.ctx.config.listGroups(objectId).map((g: any) => g.slaveId ?? obj.slaveId ?? 1))
    if (slaveIds.size === 0) slaveIds.add(obj.slaveId ?? 1)
    return frames.filter((frame: any) => slaveIds.has(frame.slaveId)).slice(-safeLimit)
  }

  clearDeviceDiagnostics(objectId: number): void {
    const obj = this.ctx.config.getObject(objectId)
    if (!obj) throw new Error('object ' + objectId + ' not found')
    this.drivers.get(this.driverKey(obj))?.clearDiagnostics?.()
  }

  pauseObject(objectId: number): void { this.paused.add(objectId) }
  resumeObject(objectId: number): void {
    this.paused.delete(objectId)
    this.lastOutcomeAt.delete(objectId)
  }
  isPaused(objectId: number): boolean { return this.paused.has(objectId) }

  async getRawSocket(objectId: number): Promise<any> {
    const obj = this.ctx.config.getObject(objectId)
    if (!obj) throw new Error('object ' + objectId + ' not found')
    const driver = await this.getDriver(obj)
    return await driver.getRawSocket(obj.slaveId ?? 1)
  }

  /** 写寄存器（FC06/FC16）。写期间暂停该通道读取，避免半双工总线冲突。 */
  async write(objectId: number, address: number, values: number[], method: 'single' | 'multiple' = 'multiple', slaveId = 1, area: ModbusArea = 'holding-register'): Promise<void> {
    const obj = this.ctx.config.getObject(objectId)
    if (!obj) throw new Error('object ' + objectId + ' not found')
    const key = this.driverKey(obj)
    this.writeLocks.add(key) // 写时停读（该设备/串口）
    try {
      await this.waitInflight(key) // 等当前在途的读完成
      const doWrite = async () => {
        const driver = await this.getDriver(obj)
        const timeoutMs = obj.timeoutMs
        if (area === 'coil') {
          const bits = values.map((v) => v !== 0)
          if (bits.length === 1) await driver.writeCoil(address, bits[0], slaveId, timeoutMs)
          else await driver.writeCoils(address, bits, slaveId, timeoutMs)
        } else if (method === 'single') {
          await driver.writeRegister(address, values[0] ?? 0, slaveId, timeoutMs)
        } else {
          await driver.writeRegisters(address, values, slaveId, timeoutMs)
        }
      }
      if (obj.transport === 'rtu' && obj.serialPath) await this.enqueueRtu(obj.serialPath, doWrite)
      else await doWrite()
    } finally {
      this.writeLocks.delete(key)
    }
  }

  /** 等待某通道的在途读清零（写前调用）。 */
  private async waitInflight(key: string): Promise<void> {
    while ((this.inflight.get(key) ?? 0) > 0) {
      await new Promise((r) => setTimeout(r, 2))
    }
  }

  /**
   * 读一个分组。当 quantity 超过该 FC 的 Modbus 单请求上限时自动分批读再拼接：
   *   FC01/02（位）→ 每批 ≤2000；FC03/04（寄存器）→ 每批 ≤125。
   * 相邻两批之间暂停 gapMs（扫描间隔；A 方案：为了不过度挤压自/串口从站）再发下一批。
   * 返回数组顺序与地址连续一致（各批顺序拼接）。
   */
  private async readGroup(driver: any, group: any, gapMs = 0, timeoutMs?: number): Promise<Array<number | boolean>> {
    const slaveId = group.slaveId ?? 1
    const fc = group.functionCode
    const perChunk = (fc === 1 || fc === 2) ? 2000 : (fc === 3 || fc === 4 ? 125 : 1)
    const single = async (start: number, want: number): Promise<Array<number | boolean>> => {
      switch (fc) {
        case 1: return driver.readCoils(start, want, slaveId, timeoutMs)
        case 2: return driver.readDiscreteInputs(start, want, slaveId, timeoutMs)
        case 4: return driver.readInputRegisters(start, want, slaveId, timeoutMs)
        default: return driver.readHoldingRegisters(start, want, slaveId, timeoutMs)
      }
    }
    if (group.quantity <= perChunk) return single(group.startAddress, group.quantity)
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)))
    const out: Array<number | boolean> = []
    for (let offset = 0; offset < group.quantity; offset += perChunk) {
      // 除第一批外，每批前先停一个扫描间隔（A 方案）
      if (offset > 0 && gapMs > 0) await sleep(gapMs)
      const want = Math.min(perChunk, group.quantity - offset)
      const part = await single(group.startAddress + offset, want)
      out.push(...(part as Array<number | boolean>))
    }
    return out
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

  /** 看门狗兜底：启用且分组存在、但长时间既无结果也无错误上报时，标记故障。 */
  private runWatchdog(): void {
    const now = Date.now()
    for (const obj of this.devices) {
      if (this.paused.has(obj.id) || !obj.isActive) continue
      const groups = this.groupsByDevice.get(obj.id) ?? []
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

  async reconnectDevice(id: number): Promise<void> {
    const obj = this.ctx.config.getObject(id)
    if (!obj) return
    const key = this.driverKey(obj)
    this.connectCooldown.delete(key)
    const d = this.drivers.get(key)
    if (d) { this.drivers.delete(key); await Promise.resolve(d.disconnect()).catch(() => {}) }
  }

  /**
   * 连续读失败达阈值时强制重建该通道驱动（删除 driver → 下轮 getDriver 惰性重建，
   * 对 RTU 会重开串口并新建 ModbusRTUClient，从而解除 jsmodbus 在设备 TX/RX 断线重接后的失步）。
   * TCP 下重建等价于断线重连；这里主要价值在 RTU 的失步复位。
   */
  private autoResetOnRepeatedFailures(key: string, d: any): void {
    const threshold = this.config.autoResetFailThreshold ?? 3
    if (threshold <= 0) { this.readFailCount.delete(key); return }
    const now = Date.now()
    const lastReset = this.lastAutoResetAt.get(key) ?? 0
    const cooldownMs = this.config.autoResetCooldownMs ?? 5000
    // 一次重建后若仍在失败，须等待冷却结束后才可再次自动重建，避免高频重开串口
    if (now - lastReset < cooldownMs) return
    const n = (this.readFailCount.get(key) ?? 0) + 1
    this.readFailCount.set(key, n)
    if (n < threshold) return

    this.readFailCount.delete(key)
    this.lastAutoResetAt.set(key, now)
    const driver = this.drivers.get(key)
    if (driver) {
      this.drivers.delete(key)
      void Promise.resolve(driver.disconnect()).catch(() => {})
      this.ctx.logger('poller').warn(
        'auto-reset driver ' + key + ' after ' + n + ' consecutive read failures (device likely TX/RX flap); re-created next poll',
      )
    }
  }

  /** 设备被断开/停用：给所有启用分组发「断开」故障，并释放连接。 */
  private markDisconnected(objectId: number): void {
    const groups = this.ctx.config.listGroups(objectId).filter((g: any) => g.isActive)
    for (const g of groups) this.setGroupError(objectId, g.id, 'Disconnected')
    const obj = this.ctx.config.getObject(objectId)
    if (obj) this.connectCooldown.delete(this.driverKey(obj))
    if (!obj || obj.transport !== 'rtu') {
      const key = 'tcp:' + objectId
      const d = this.drivers.get(key)
      if (d) { this.drivers.delete(key); void d.disconnect() }
    }
  }

  private isRtuPortInUse(serialPath: string): boolean {
    return this.ctx.config.listObjects().some((o: any) =>
      o.transport === 'rtu' && o.serialPath === serialPath && o.mode !== 'slave' && o.isActive === 1)
  }

  private releaseUnusedRtuDrivers(): void {
    for (const key of [...this.drivers.keys()]) {
      if (!key.startsWith('rtu:')) continue
      const serialPath = key.slice(4)
      if (this.isRtuPortInUse(serialPath)) continue
      const d = this.drivers.get(key)
      if (d) { this.drivers.delete(key); void d.disconnect() }
    }
  }

  private driverKey(obj: any): string {
    return obj.transport === 'rtu' ? 'rtu:' + (obj.serialPath ?? '') : 'tcp:' + obj.id
  }

  private enqueueRtu<T>(serialPath: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.rtuLocks.get(serialPath) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    this.rtuLocks.set(serialPath, run.then(() => undefined, () => undefined))
    return run
  }

  private async getDriver(obj: any): Promise<any> {
    const fresh = this.ctx.config.getObject(obj.id) ?? obj
    const key = this.driverKey(fresh)
    let driver = this.drivers.get(key)
    if (!driver || !driver.isConnected()) {
      const transport = fresh.transport === 'rtu' ? 'rtu' : 'tcp'
      const identity = transport === 'rtu'
        ? { channelKey: key }
        : { deviceId: fresh.id, channelKey: key }
      driver = this.ctx.modbus.createDriver(transport, identity)
      await driver.connect(fresh)
      this.drivers.set(key, driver)
    }
    return driver
  }
}

export function apply(ctx: Context, config: Config): void { ctx.provide('poller', new PollingEngine(ctx, config)) }
