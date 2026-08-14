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
interface RegisterGroup { id; functionCode; startAddress; quantity }
interface Device { id; host; port; groups: RegisterGroup[] }

interface Poller {
  pollOnce(device: Device): Promise<void>  // 一次性轮询（测试/手动）
  startAll(): void                          // 对 config 中所有 active 主站设备循环轮询
  stopAll(): void                           // 停止所有循环 + 断开连接
}
```

## 行为

- `pollOnce`：连一次 → 读所有组 → 写 store → flush → 断开（`registerId` 用 `startAddress` 占位）。
- `startAll`：从 `ctx.config` 读 active 主站设备，每台起一个 `setInterval` 循环轮询；
  连接**持久复用**（`Map<objectId, driver>`），失败时丢弃 driver 下次重连；
  用 config 的 register id（`startAddress → id` 映射，缺失时回退到地址）。
- 每次轮询结果：`ctx.emit('poller/result', { objectId, points })` + `ctx.store.write(points)`。

## 当前限制（TODO）

- 轮询失败被静默吞掉（无日志）；建议加 warn 日志。
- 仅 FC03 读取；写路径、暂停/重连、slave 模式未处理。
- `flush()` 不再每轮调用，依赖 store 的定期 flush（`flushIntervalMs`）。
