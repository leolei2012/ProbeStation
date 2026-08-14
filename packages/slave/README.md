# @probebench/slave

Modbus TCP 从站模拟器（jsmodbus）。holding 缓冲区即寄存器内存，支持 FC03 读 / FC06 单写 / FC16 多写。
用于本地测试与设备仿真。提供 `ctx.slave`。

## 配置（schemastery）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `port` | number | 8502 | 监听端口 |
| `holdingSize` | number | 5000 | holding 寄存器数量 |

## 服务 `ctx.slave`

```ts
interface Slave {
  start(): Promise<void>      // 开始监听
  stop(): void                // 停止
  setRegister(address, value) // 写一个 holding 寄存器（uint16）
  getRegister(address): number// 读一个 holding 寄存器
}
```

## 用法

```ts
await ctx.plugin(slavePlugin, { port: 8502 })
const slave = ctx.get('slave', false)
slave.setRegister(0, 1234)   // 主站读地址 0 得到 1234
```

## 与 poller 的关系

slave 插件本身是**从站服务器**；要让它被轮询，需在 config 里建一个 `mode=master` 的设备
指向 `127.0.0.1:8502`（见 `apps/cli` 的「本地模拟器」播种）。config 的 `mode=slave` 是另一种语义
（平台对外模拟设备），poller 会跳过 slave 设备。
