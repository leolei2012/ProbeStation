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
- 每个协议响应内的字共享时间戳与独立 UUID `batchId`。FC03/FC04 超过 125 字时，拆读边界避开已配置的有效多字点位，避免把不同响应的字拼成一个数值。batchId 已保留到事件、热缓存和冷库，但本身不能证明从站来源。
- `pollOnce` 和轮询事件中的每个字新增 `slaveId`，记录传给该次 read 方法的目标从站号（沿用原有 group.slaveId ?? 1），不增加读请求、不改通讯参数。它不是对物理设备身份的额外认证。本阶段仅事件携带此字段；store 的热缓存和冷库尚不保存 slaveId，前端/历史/助手来源隔离待后续改造，不能因新增事件字段声称全链路已修复。
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

## 旧采集结果隔离

采集前用ConfigStore的进程内来源条件绑定设备快照；RTU排队后、连接返回、每批读取前后及发布前复核。来源变化、配置重开/删除、停止或驱动被替换后，旧结果不再发布/写入存储，旧错误不改变新通道的故障与冷却状态。停止清空到期队列，旧生命周期的finalizer不能写回新到期时间。不是取消已发出的Modbus请求，底层挂起仍依赖原有超时/断开逻辑。

驱动缓存按实际TCP IP/端口或RTU路径与串口参数绑定，不只按设备ID/串口键复用。连接完成需仍拥有本次槽位，失效的待连接驱动断开后丢弃。pollOnce仍可使用没有配置记录的临时ID，但全过程须保持当前配置scope且该ID仍未被创建；已配置ID仅接受匹配其主站TCP目标的参数，变化明确拒绝，不改读新目标。

poller/result新增仅进程内的readOrigin发布条件；录制会核对，复制/JSON往返不能重建。WS仍只发原objectId/points，历史字段不变；batchId仍是协议响应批次，不是此句柄。未部署/实机验证，跨进程绕过ConfigStore的ABA、相同参数下物理换机和无句柄的旧自定义事件不在保证内，见[设计与离线回归](../../docs/develop/44-旧采集器迟到结果隔离.md)。

## 当前限制（TODO）

- 读取支持 FC03（保持寄存器）+ FC04（输入寄存器，`g.functionCode === 4` 时走 `readInputRegisters`）；FC01/FC02（位读取）未实现。
- `flush()` 不再每轮调用，依赖 store 的定期 flush（`flushIntervalMs`）。
