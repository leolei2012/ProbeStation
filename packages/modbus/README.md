# @probebench/modbus

Modbus TCP/RTU 驱动抽象 + jsmodbus 实现。提供 `ctx.modbus`。

## 配置（schemastery）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `defaultTimeoutMs` | number | 3000 | 客户端读写超时（毫秒） |
| `defaultUnitId` | number | 1 | 从站 unit id（device id） |
| `connectTimeoutMs` | number | 5000 | RTU 串口 open 超时（毫秒），防止 open 回调不来导致 connect 永久挂起 |
| `frameBufferSize` | number | 2000 | 每条设备/通道在内存中保留的近期 TX/RX 报文上限 |

## 服务 `ctx.modbus`

```ts
interface ModbusService {
  createDriver(transport?: 'tcp' | 'rtu', identity?: { deviceId?: number; channelKey?: string }): ModbusDriver
}
```

## 驱动接口 `ModbusDriver`

```ts
interface ModbusDriver {
  connect(opts: ConnectOptions): Promise<void>               // TCP/RTU 连接参数
  disconnect(): Promise<void>                               // 等待关闭回调或兜底期限
  isConnected(): boolean                                    // 连接是否可用
  readCoils(address: number, count: number): Promise<boolean[]>             // FC01
  readDiscreteInputs(address: number, count: number): Promise<boolean[]>    // FC02
  readHoldingRegisters(address: number, count: number): Promise<number[]>  // FC03
  readInputRegisters(address: number, count: number): Promise<number[]>     // FC04
  writeRegister(address: number, value: number): Promise<void>              // FC06 单写
  writeRegisters(address: number, values: number[]): Promise<void>          // FC16 多写
  getDiagnostics(): ModbusDiagnosticsSnapshot                              // 通信指标快照
  getFrames(limit?: number): ModbusFrameRecord[]                            // 近期 TX/RX
  clearDiagnostics(): void                                                  // 清空当前通道诊断
}
```

- FC03/04 返回 `uint16[]`（从 `body.valuesAsArray` 转换）。
- FC01/02 返回 `boolean[]`，并严格截断到请求数量，不包含最后一个响应字节的填充位。
- Modbus 异常会抛错（`modbus exception code=N`），不静默吞掉。

## 用法

```ts
const driver = ctx.modbus.createDriver()
await driver.connect({ ip: '192.168.90.32', port: 8899 })
const regs = await driver.readHoldingRegisters(0, 47)
await driver.disconnect()
```

## 通信诊断

- 原始报文旁路采集，不消费或修改 jsmodbus 的数据流；记录时间、方向、HEX、长度、Slave ID、功能码及异常码。
- 缓冲固定上限，默认每通道 2000 条；长期运行不会因日志无限增长而持续占用内存。
- 指标包括成功/失败/超时、连续错误、最近 100 次错误率、最后/平均/最大响应耗时和最近成功/错误时间。
- TCP 驱动按设备统计；RTU 驱动按物理串口共享统计，查询设备报文时再按该设备配置的 Slave ID 过滤。

## 设计说明

驱动被包在 `ModbusDriver` 抽象后，未来加协议（RTU、其它库）只需新增 provider，
不碰 `poller` / `api` 等上层。抽象接口对齐原 Python 版 `BaseModbusDriver`。

## 踩坑：RTU 串口 open 静默卡死

历史反馈中的原生binding挂起及USB串口掉线原因仍属推断，未用本轮模拟测试确认实机根因。新常规回归覆盖打开、失败清理、轮询错误与共享端口生命周期，见[历史反馈对照和验证边界](../../docs/develop/212-RTU历史反馈对照与打开失败清理.md)。

- **症状**：CH340/CP2102 等 USB 转串口驱动可能出现「原生已占用串口，但 serialport 的
  `binding.open()` Promise 永不 settle」→ open 回调不来 → `connect()` 永久 pending →
  轮询「无数据、无错误、通信灯不闪」地静默卡死。
- **修复**：`SerialDriver.connect()` 用 `connectTimeoutMs` 兜底——超时即 reject，并尽力
  `close()` 半开句柄；打开阶段的事件错误、构造回调错误也统一尝试close并保留原始错误。
  这只是清理尝试，不保证原生半开句柄确已释放。
- **验证**：`npx tsx scripts/test-rtu-timeout.ts`（超时/失败/成功三条路径）。

## 踩坑：disconnect() 未真正关串口

- serialport 的 `close()` 本身**不返回 Promise**（回调/事件式），直接 `sp.close()` 后置空引用
  并不会等到串口真正关闭，导致 reconnect 后旧句柄仍占用 COM（Access denied）。
- **修复**：`disconnect()` 改为 `async`，用回调把 `close()` 包成 Promise 再 `await`（带 2s 超时兜底）；
  `connect()` 开头也改为 `await this.disconnect()`，避免旧口未关就开新口。
- **验证**：`npx tsx scripts/test-rtu-release.ts`（Part 1：disconnect 真正 await close）。

常规安全清单现包含 `test-rtu-lifecycle.ts` 的7组构造器注入/模拟采集器回归；旧独立脚本使用强制process.exit和较粗定时等待，不能替代新清理与错误事件断言。所有手动运行也应在已准备的隔离checkout使用现有依赖，不运行真实采集入口。
