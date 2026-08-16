# @probebench/modbus

Modbus TCP 驱动抽象 + jsmodbus 实现。提供 `ctx.modbus`。

## 配置（schemastery）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `defaultTimeoutMs` | number | 3000 | 客户端读写超时（毫秒） |
| `defaultUnitId` | number | 1 | 从站 unit id（device id） |
| `connectTimeoutMs` | number | 3000 | RTU 串口 open 超时（毫秒），防止 open 回调不来导致 connect 永久挂起 |

## 服务 `ctx.modbus`

```ts
interface ModbusService {
  createDriver(): ModbusDriver
}
```

## 驱动接口 `ModbusDriver`

```ts
interface ModbusDriver {
  connect(host: string, port: number): Promise<void>      // 建立 TCP 连接
  disconnect(): void                                       // 关闭连接
  isConnected(): boolean                                    // 连接是否可用
  readHoldingRegisters(address: number, count: number): Promise<number[]>  // FC03
  readInputRegisters(address: number, count: number): Promise<number[]>     // FC04
  writeRegister(address: number, value: number): Promise<void>              // FC06 单写
  writeRegisters(address: number, values: number[]): Promise<void>          // FC16 多写
}
```

- 返回值一律为 `uint16` 数组（从 `body.valuesAsArray` 转换）。
- Modbus 异常会抛错（`modbus exception code=N`），不静默吞掉。

## 用法

```ts
const driver = ctx.modbus.createDriver()
await driver.connect('192.168.90.32', 8899)
const regs = await driver.readHoldingRegisters(0, 47)
driver.disconnect()
```

## 设计说明

驱动被包在 `ModbusDriver` 抽象后，未来加协议（RTU、其它库）只需新增 provider，
不碰 `poller` / `api` 等上层。抽象接口对齐原 Python 版 `BaseModbusDriver`。

## 踩坑：RTU 串口 open 静默卡死

- **症状**：CH340/CP2102 等 USB 转串口驱动可能出现「原生已占用串口，但 serialport 的
  `binding.open()` Promise 永不 settle」→ open 回调不来 → `connect()` 永久 pending →
  轮询「无数据、无错误、通信灯不闪」地静默卡死。
- **修复**：`SerialDriver.connect()` 用 `connectTimeoutMs` 兜底——超时即 reject，并尽力
  `close()` 半开句柄；open 失败不再被 `sp.on('error', () => {})` 吞掉，而是冒出来。
- **验证**：`npx tsx scripts/test-rtu-timeout.ts`（超时/失败/成功三条路径）。

## 踩坑：disconnect() 未真正关串口

- serialport 的 `close()` 本身**不返回 Promise**（回调/事件式），直接 `sp.close()` 后置空引用
  并不会等到串口真正关闭，导致 reconnect 后旧句柄仍占用 COM（Access denied）。
- **修复**：`disconnect()` 改为 `async`，用回调把 `close()` 包成 Promise 再 `await`（带 2s 超时兜底）；
  `connect()` 开头也改为 `await this.disconnect()`，避免旧口未关就开新口。
- **验证**：`npx tsx scripts/test-rtu-release.ts`（Part 1：disconnect 真正 await close）。
