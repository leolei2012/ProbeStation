# @probebench/poller

Modbus 轮询引擎。注入 `config` + `modbus` + `store`，提供 `ctx.poller`。

## 依赖

```ts
export const inject = ['config', 'modbus', 'store']
```

## 配置（schemastery）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `pollIntervalMs` | number | 1000 | 循环轮询间隔（毫秒） |

## 服务 `ctx.poller`

```ts
interface RegisterGroup { id; functionCode; startAddress; quantity; slaveId?; pollIntervalMs? }
interface Device { id; host; port; groups: RegisterGroup[] }

interface Poller {
  pollOnce(device: Device): Promise<void>  // 一次性轮询（测试/手动）
  startAll(): void                          // 对 config 中所有 active 主站设备循环轮询
  stopAll(): void                           // 停止所有循环 + 断开连接
  write(objectId, address, values: number[], method?, slaveId?): Promise<void>  // FC06 单写 / FC16 多写（values 为已按类型编码的 16 位字数组，32/64 位多个字）
}
```

## 行为

- `pollOnce`：连一次 → 读所有组 → 写 store → flush → 断开（`registerId` 用 `startAddress` 占位）。
- `startAll`：从 `ctx.config` 读 active 主站设备，每台起一个 `setInterval` 循环轮询；
  连接**持久复用**（`Map<objectId, driver>`），失败时丢弃 driver 下次重连；
  用 config 的 register id（`startAddress → id` 映射，缺失时回退到地址）。
- 每次轮询结果：`ctx.emit('poller/result', { objectId, points })` + `ctx.store.write(points)`。
- **按组捕获故障**：连接失败对该设备所有到期组标错，单组读取异常只标该组；错误消息已归一化
  （`Timeout` / `Illegal Data Address` / `connect ECONNREFUSED ...`）。
- 故障/恢复事件：`poller/group-error`（`{ objectId, groupId, error }`，值变化才发）与
  `poller/group-ok`（`{ groupId }`，读成功且之前有错才发）——供 api 转发 WS、前端显示红色徽标。

## 当前限制（TODO）

- 读取支持 FC03（保持寄存器）+ FC04（输入寄存器，`g.functionCode === 4` 时走 `readInputRegisters`）；FC01/FC02（位读取）未实现。
- `flush()` 不再每轮调用，依赖 store 的定期 flush（`flushIntervalMs`）。
