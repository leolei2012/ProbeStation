import { ModbusSlave, type SlaveOptions } from './index.ts'
import { areaForFunction, registerWidth } from '../../core/src/index.ts'
import type { SlaveArea } from './protocol.ts'
/** One listener and memory per configured slave device. Reconciliation is serialized. */
export class DeviceSlaves {
  private entries = new Map<number, { server: ModbusSlave; signature: string; transport: 'tcp' | 'rtu'; error: string; retryAt: number; published: number }>()
  private chain: Promise<void> = Promise.resolve()
  private timer?: ReturnType<typeof setTimeout>
  private closed = false
  private groupStates = new Map<number, string>()
  private groupState(objectId: number, groupId: number, error: string) {
    if (this.groupStates.get(groupId) === error) return
    this.groupStates.set(groupId, error)
    this.emit(error ? 'poller/group-error' : 'poller/group-ok', { objectId, groupId, ...(error ? { error } : {}) })
  }
  constructor(private cfg: any, private store: any, private emit: (event: string, payload: any) => void, private portCtor?: any) {}
  start() { const tick = async () => { if (this.closed) return; await this.sync(); if (!this.closed) this.timer = setTimeout(tick, 250) }; void tick() }
  sync() { this.chain = this.chain.catch(() => {}).then(() => this.reconcile()); return this.chain }
  private async reconcile() {
    if (this.closed) return
    const devices = this.cfg.listObjects().filter((d: any) => d.mode === 'slave')
    const ids = new Set(devices.map((d: any) => d.id))
    const groups = new Set(devices.flatMap((d: any) => this.cfg.listGroups(d.id).map((g: any) => g.id)))
    for (const groupId of this.groupStates.keys()) if (!groups.has(groupId)) this.groupStates.delete(groupId)
    for (const [id, entry] of this.entries) if (!ids.has(id)) { await entry.server.stop(entry.transport); this.entries.delete(id); this.emit('device/status', { objectId: id, connected: false }) }
    for (const device of devices) {
      let entry = this.entries.get(device.id)
      if (!entry) { entry = { server: new ModbusSlave({ port: device.port, holdingSize: 65536 }, this.portCtor), signature: '', transport: device.transport, error: '', retryAt: 0, published: 0 }; this.entries.set(device.id, entry) }
      const options: SlaveOptions = { host: device.ip || '0.0.0.0', port: device.port, unitId: device.slaveId, serialPath: device.serialPath || '', baudRate: device.baudRate, parity: device.parity, dataBits: device.dataBits, stopBits: device.stopBits, flowControl: device.flowControl }
      const signature = JSON.stringify([device.transport, options, device.isActive])
      let running = entry.server.status()[entry.transport].running
      if (entry.signature !== signature || device.isActive && !running && Date.now() >= entry.retryAt) {
        await entry.server.stop(entry.transport)
        entry.transport = device.transport; entry.signature = signature; entry.error = ''
        if (device.isActive) {
          try {
            if (device.transport === 'rtu' && this.cfg.listObjects().some((d: any) => d.id !== device.id && d.isActive && d.transport === 'rtu' && (d.serialPath || '').trim().toLowerCase() === options.serialPath.trim().toLowerCase())) throw new Error('串口已被其他启用的设备使用，请停用后再启动从站')
            await entry.server.start(entry.transport, options)
          } catch (e: any) { entry.error = e.message; entry.retryAt = Date.now() + 5000 }
        }
        running = entry.server.status()[entry.transport].running
        this.emit('device/status', { objectId: device.id, connected: running, error: entry.error })
      }
      if (running && Date.now() - entry.published >= Math.max(100, device.pollIntervalMs || 1000)) this.publish(device, entry)
      else if (!running) for (const group of this.cfg.listGroups(device.id).filter((g: any) => g.isActive)) this.groupState(device.id, group.id, entry.error || '从站已停止')
    }
  }
  private publish(device: any, entry: any) {
    const points: any[] = [], seen = new Set<string>(), timestamp = new Date().toISOString()
    for (const group of this.cfg.listGroups(device.id).filter((g: any) => g.isActive)) {
      try {
        const area = areaForFunction(group.functionCode) as SlaveArea
        // Include complete configured multiword values without publishing unconfigured memory.
        const registers = this.cfg.listRegisters(group.id)
        for (const reg of registers) {
          const count = registerWidth(reg.dataType), values = entry.server.read(area, reg.startAddress, count)
          values.forEach((rawValue: number, i: number) => { const address = reg.startAddress + i, key = area + ':' + address; if (!seen.has(key)) { seen.add(key); points.push({ objectId: device.id, area, address, rawValue, quality: 'good', timestamp }) } })
        }
        this.groupState(device.id, group.id, '')
      } catch (e: any) { this.groupState(device.id, group.id, e.message) }
    }
    if (points.length) { this.store.write(points); this.emit('poller/result', { objectId: device.id, points }) }
    entry.published = Date.now()
  }
  status(id: number) {
    const device = this.cfg.getObject(id), entry = this.entries.get(id)
    if (!device || device.mode !== 'slave') throw Object.assign(new Error('设备不是从站'), { statusCode: 400 })
    const state = entry?.server.status()
    return { objectId: id, connected: !!state?.[entry!.transport].running, error: entry?.error || state?.[entry!.transport].error || '', transport: device.transport, ...(state ? state[entry!.transport] : {}), connections: state?.connections ?? 0 }
  }
  listGroupErrors() {
    return [...this.groupStates].filter(([id, error]) => !!error && this.cfg.getGroup(id)?.isActive).map(([groupId, error]) => ({ objectId: this.cfg.getGroup(groupId).objectId, groupId, error }))
  }
  connected(id: number) { const entry = this.entries.get(id); return !!entry?.server.status()[entry.transport].running }
  async write(id: number, area: SlaveArea, address: number, values: number[]) {
    await this.sync()
    const entry = this.entries.get(id), device = this.cfg.getObject(id)
    if (!entry || !device || device.mode !== 'slave') throw new Error('从站设备不存在')
    if (!this.connected(id)) throw new Error(entry.error || '请先启动从站')
    entry.server.write(area, address, values); this.publish(device, entry)
  }
  async stop() { this.closed = true; if (this.timer) clearTimeout(this.timer); await this.chain; for (const entry of this.entries.values()) await entry.server.stop(entry.transport); this.entries.clear() }
}
