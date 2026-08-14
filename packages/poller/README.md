# @probebench/poller

Modbus 轮询引擎。注入 `modbus` + `store`，提供 `ctx.poller`。

## 依赖

```ts
export const inject = ['modbus', 'store']
```

## 配置（schemastery）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `pollIntervalMs` | number | 1000 | 轮询间隔（预留，当前 pollOnce 手动触发） |

## 服务 `ctx.poller`

```ts
interface RegisterGroup {
  id: number
  functionCode: number
  startAddress: number
  quantity: number
}

interface Device {
  id: number
  host: string
  port: number
  groups: RegisterGroup[]
}

interface Poller {
  pollOnce(device: Device): Promise<void>  // 连一次、读所有组、写 store、断开
}
```

## 行为

`pollOnce(device)`：

1. `ctx.modbus.createDriver()` → `connect(host, port)`；
2. 遍历 `device.groups`，逐个 `readHoldingRegisters(startAddress, quantity)`；
3. 每个寄存器生成一条 `PollPoint`（`registerId` 暂用 `startAddress + i` 占位）；
4. `ctx.store.write(points)` + `ctx.store.flush()`；
5. `finally` 中 `disconnect()`。

## 当前限制（TODO）

- `registerId` 用 `startAddress` 占位，Phase 3-4 接入真实寄存器配置后改为 DB 里的 register id。
- 仅支持 FC03（holding registers）读取；写路径、循环轮询、暂停/重连未实现。
- 无事件发射（`poller/result` 等），Phase 3 加 ws 时补。
