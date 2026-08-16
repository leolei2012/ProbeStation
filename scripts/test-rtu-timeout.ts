import { SerialDriver } from '../packages/modbus/src/index.ts'

// ============================================================
// RTU 串口「open 回调永不触发」回归测试
// 背景：CH340/CP2102 等 USB 转串口驱动可能出现「原生已占用串口，但 binding.open
// 的 Promise 永不 settle」→ open 回调不来 → connect() 永久 pending → 轮询静默卡死。
// 这里验证：1) connect 超时能 reject；2) 半开句柄被 close；3) open 失败不吞 error；
//           4) 正常打开仍可用（超时逻辑不破坏快乐路径）。
// ============================================================

// 模拟「open 回调永不触发」的假串口
let hangPort: HangPort | null = null
class HangPort {
  public closed = false
  constructor(_opts: any, _cb: any) {
    hangPort = this
    // 故意不调用 _cb —— 模拟 open 回调不来
  }
  close() { this.closed = true }
  on() {}
}

// 模拟「open 立即失败」的假串口（如端口不存在）
class FailPort {
  public closed = false
  constructor(_opts: any, cb: any) {
    process.nextTick(() => cb(new Error('COM3 not found')))
  }
  close() { this.closed = true }
  on() {}
}

// 模拟「open 立即成功」的假串口
class OkPort {
  public closed = false
  constructor(_opts: any, cb: any) {
    process.nextTick(() => cb(null))
  }
  close() { this.closed = true }
  on() {}
}

const baseConfig = { defaultTimeoutMs: 150, defaultUnitId: 1, connectTimeoutMs: 150 }
const connOpts = { serialPath: 'COM_TEST', baudRate: 9600, parity: 'none', stopBits: 1, dataBits: 8, flowControl: 'none' }

// 1) 超时：connect() 必须在 ~150ms 内 reject，不能永久挂起
{
  const driver = new SerialDriver(baseConfig, HangPort)
  const t0 = Date.now()
  let err: any = null
  try {
    await driver.connect(connOpts)
  } catch (e) { err = e }
  const elapsed = Date.now() - t0
  if (driver.isConnected()) throw new Error('after timeout driver should NOT be connected')
  if (!err) throw new Error('expected timeout error, got none')
  if (!String(err.message).includes('timed out')) throw new Error('expected "timed out" error, got: ' + err.message)
  if (elapsed < 100 || elapsed > 2000) throw new Error('timeout fired at unexpected ms: ' + elapsed)
  if (!hangPort || !hangPort.closed) throw new Error('half-open port was NOT closed on timeout')
  console.log('1) connect timeout OK: rejected after ~' + elapsed + 'ms, port closed=' + hangPort!.closed + ' — ' + err.message)
}

// 2) open 失败：错误要冒出来（不能被 sp.on("error") 吞掉）
{
  const driver = new SerialDriver(baseConfig, FailPort)
  let err: any = null
  try {
    await driver.connect(connOpts)
  } catch (e) { err = e }
  if (driver.isConnected()) throw new Error('driver should NOT be connected after open failure')
  if (!err || err.message !== 'COM3 not found') throw new Error('expected "COM3 not found", got: ' + (err && err.message))
  console.log('2) open failure surfaced: ' + err.message)
}

// 3) 正常打开：超时逻辑不破坏快乐路径
{
  const driver = new SerialDriver(baseConfig, OkPort)
  await driver.connect(connOpts)
  if (!driver.isConnected()) throw new Error('driver should be connected after successful open')
  driver.disconnect()
  if (driver.isConnected()) throw new Error('driver should be disconnected after disconnect()')
  console.log('3) normal open + disconnect OK')
}

console.log('RTU TIMEOUT TEST OK')
process.exit(0)
