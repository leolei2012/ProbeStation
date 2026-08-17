import { SerialDriver } from '../packages/modbus/src/index.ts'

// ============================================================
// 回归：串口被拔出/关闭（runtime close）后，驱动应标记为未连接，下次 getDriver 重建。
// 症状：串口 timeout/断开后物理恢复了，但 web 数据不更新——因为 ready 一直是 true，
//       poller 一直复用旧驱动（旧串口句柄），读不进来。
// ============================================================

let lastPort: UnpluggablePort | null = null
class UnpluggablePort {
  public listeners: Record<string, Array<(...a: any[]) => void>> = {}
  constructor(_opts: any, cb: any) { lastPort = this; process.nextTick(() => cb(null)) }
  on(event: string, fn: any) { (this.listeners[event] ??= []).push(fn) }
  emit(event: string, ...args: any[]) { for (const fn of this.listeners[event] ?? []) fn(...args) }
  close(cb?: () => void) { cb?.() }
}

const cfg = { defaultTimeoutMs: 1000, defaultUnitId: 1, connectTimeoutMs: 150 }
const opts = { serialPath: 'COM_TEST', baudRate: 9600, parity: 'none', stopBits: 1, dataBits: 8, flowControl: 'none' }

const driver = new SerialDriver(cfg, UnpluggablePort)
await driver.connect(opts)
if (!driver.isConnected()) throw new Error('should be connected after open')

// 模拟拔出：串口发 close 事件 → 驱动应标记未连接
lastPort!.emit('close')
if (driver.isConnected()) throw new Error('driver should be disconnected after close event')

// 重连：应恢复（poll 引擎会因 isConnected=false 重建驱动并重开串口）
await driver.connect(opts)
if (!driver.isConnected()) throw new Error('should reconnect after close')

console.log('RTU UNPLUG DETECTION OK: close -> disconnected -> reconnect')
process.exit(0)
