# @probebench/poller

Modbus 轮询引擎。注入 `config` + `modbus` + `store`，提供 `ctx.poller`。

## 依赖

```ts
export const inject = ['config', 'modbus', 'store']
```

## 配置（schemastery）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `pollIntervalMs` | number | 1000 | 全局回退轮询间隔（无设备或设备未设 `poll_interval_ms` 时用） |
| `connectRetryMs` | number | 5000 | 连接失败后的冷却期（毫秒），期内不重建连接 |
| `watchdogTimeoutMs` | number | 30000 | 看门狗：启用且有分组但长时间无结果无错误时主动标故障（阈值按设备周期放大） |

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
- **连接失败冷却**：坏串口/坏地址在 `connectRetryMs` 内不每轮重建连接，避免对坏端口反复 open
  （也会造成 RTU 串行队列堆积）。
- **看门狗兜底**：启用且有分组、但长时间既无结果也无错误上报的设备，主动发
  `poller/group-error`（`No response (watchdog)`），避免像「RTU open 静默卡死」那样永久无反馈。
- **RTU 串口引用计数释放**：`releaseUnusedRtuDrivers()` 每轮检查，当「最后一台启用、非 slave 的
  RTU 设备」被停用或删除时，`disconnect()` 释放共享串口（不再只能重启进程释放 COM）。
- **按设备采样速率**：调度读设备级 `monitor_objects.poll_interval_ms`（该设备所有组统一周期），
  下一轮 tick 间隔 = 所有启用设备的最小周期（动态 `setTimeout` 重调度，下限 1ms）。组级 `poll_interval_ms`
  字段保留但不再参与调度（PRD 08 §3.2）。

## 当前限制（TODO）

- 读取支持 FC03（保持寄存器）+ FC04（输入寄存器，`g.functionCode === 4` 时走 `readInputRegisters`）；FC01/FC02（位读取）未实现。
- `flush()` 不再每轮调用，依赖 store 的定期 flush（`flushIntervalMs`）。
