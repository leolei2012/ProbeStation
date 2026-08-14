# @probebench/modbus

Modbus TCP 驱动抽象 + jsmodbus 实现。提供 `ctx.modbus`。

## 配置（schemastery）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `defaultTimeoutMs` | number | 3000 | 客户端超时（毫秒） |
| `defaultUnitId` | number | 1 | 从站 unit id（device id） |

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
