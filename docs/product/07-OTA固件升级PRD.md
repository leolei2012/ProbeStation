# OTA 固件升级 PRD

> 状态：v1.0 · 日期：2026-08-15
> 读者：开发侧（平台实现）+ 产品侧。
> 协议来源：`https://github.com/leolei2012/MB-RTU`（自定义功能码 `0x41` 的 IAP 升级协议）。
> 定位：给平台加「固件升级」能力，**通过 MCP 暴露给调试 agent**（同时可选 Web 界面查看进度）。

---

## 1. 背景与目标

- 固件开发 agent 产出固件后，需要把新固件刷到设备上（OTA / IAP）。
- 复用现成的 **Modbus 0x41 自定义功能码** 协议（用户已设计好，见 `MB-RTU` 工程）。
- 目标：调试 agent 通过 MCP 发起升级、查进度，全程自动，断点续传。

---

## 2. 协议规格（功能码 0x41）

> 从机（设备）只「接数据」：按块、按序回调给用户；flash 分区/跳转/回滚由设备侧自行处理。平台侧只需「按协议发数据」。

### 2.1 子命令（全部**大端**字节序）

| 子命令 | 值 | 请求 | 响应 |
|---|---|---|---|
| START | `0x01` | `0x41,0x01,total_size(4B),fw_crc32(4B)` | `0x41,0x01,status` |
| DATA | `0x02` | `0x41,0x02,block_no(2B),data(N)` | `0x41,0x02,status` |
| END | `0x03` | `0x41,0x03,total_blocks(2B)` | `0x41,0x03,status` |
| STATUS | `0x04` | `0x41,0x04` | `0x41,0x04,status,next_block(2B)` |

### 2.2 状态码（`status` 在响应数据区首字节）

| 值 | 含义 |
|---|---|
| `0x00` | OK |
| `0x01` | BAD_BLOCK（块号不连续） |
| `0x02` | BAD_LEN（长度错误） |
| `0x03` | NOT_ACTIVE（未 START 就 DATA/END） |
| `0x04` | INTERNAL（设备回调错误） |

### 2.3 关键约束

- **块大小（可配置）**：默认 **128 字节**（对齐设备侧 `MB_IAP_MAX_DATA=128`，2 块攒 1 页 flash 256）。**可设置**，但不能超过设备侧 `MB_IAP_MAX_DATA`（超了设备回 `BAD_LEN`）。块大小存设备配置（config，默认 128），升级时也可临时覆盖。
- **块号**：`block_no` 从 0 严格连续；`STATUS` 返回 `next_block` 支持断点续传。
- **CRC32**：整个固件镜像的标准 CRC-32（多项式 `0xEDB88320`，初值/终值 `0xFFFFFFFF`），大端。START 时下发，**设备侧在 END 时自行比对**（协议栈不自动校验）。

---

## 3. 传输层设计（RTU + TCP 双支持）

> 结论：**方案 B——绕过 jsmodbus，拼原始帧**。jsmodbus 的公开 API 不暴露「发任意功能码」，且响应解析不认 0x41，扩展它反而背上私有 API 包袱。

0x41 的 PDU（`0x41 + cmd + data`）是**传输无关**的，RTU/TCP 只是外层封装不同：

```
RTU 帧：  addr(1B) + [0x41 + cmd + data] + crc16(2B)
TCP 帧：  MBAP头(7B: transaction_id(2) + protocol_id(2=0) + length(2) + unit_id(1))
          + [0x41 + cmd + data]
```

- **逻辑一份**：状态机（START/DATA/END/STATUS）只写一次。
- **帧封装两份**：RTU 加从站地址 + CRC16；TCP 加 MBAP 头。
- **复用现有连接**：RTU 用 `SerialDriver` 持有的 serialport，TCP 用现有 socket。**不经过 jsmodbus 的功能码封装**，直接收发原始帧。

---

## 4. 固件管理（方案 C：先上传，再升级）

### 4.1 上传流程

```
upload_firmware(name, version, content_base64)
  → { firmware_id, size, crc32 }
```

上传时平台做两件计算：

1. **长度计算**：`total_size` = 固件字节数（`Buffer.length`），即 `START` 请求里的 `total_size`。
2. **CRC32 计算**：对整个固件字节流算标准 CRC-32，落库并在 `START` 时下发。

### 4.2 CRC32 参数（必须与设备侧一字不差）

| 项 | 值 |
|---|---|
| 算法 | CRC-32/ISO-HDLC（即 zlib / 以太网 / PNG 同款 CRC-32） |
| 多项式（reflected） | `0xEDB88320` |
| 初始值 | `0xFFFFFFFF` |
| 最终异或（final xor） | `0xFFFFFFFF` |
| 输入 | 整个固件镜像字节流（按序，无补零） |
| 输出字节序 | **大端**（START 请求里 4 字节高字节在前：`req[7]`=MSB … `req[10]`=LSB） |

> 实现建议：Node 可用 `crc-32` / `buffer-crc32` 第三方库，或自实现查表法（几十行）。**注意**：`crc-32` 包返回有符号 int32，需 `>>> 0` 转 uint32。**必须写测试**：平台算的 CRC32 与设备侧 `on_end` 比对算法一致（可先用参考工程 `MB-RTU` 的 `iap_demo.c` 里 `0x12345678` 这类已知值对拍）。

### 4.3 `firmwares` 表（SQLite，config 层新增）

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | INTEGER PK | 固件 id（`firmware_id`） |
| `name` | TEXT | 固件名 |
| `version` | TEXT | 版本号 |
| `size` | INTEGER | 字节数（= `total_size`） |
| `crc32` | INTEGER | 镜像 CRC32（uint32，存 0~4294967295） |
| `file_path` | TEXT | 固件文件相对路径 |
| `created_at` | TEXT | 上传时间 |

### 4.4 固件文件存储

- 固件二进制存**文件系统**（不存 SQLite，文件可能几 MB）。
- 目录：工作区下的 `firmware/` 子目录（跟随工作区「自包含」理念）；文件命名 `firmware_<id>.bin`。
- `firmwares.file_path` 记录相对 `firmware/` 的路径。

### 4.5 为什么先上传

- 固件几十 KB~几 MB，MCP 直接传大 payload 慢且受限。
- 先上传 → 拿 `firmware_id` → 按 id 升级，支持「同一固件升级多台设备」+ 升级可追溯（升了哪个版本）。

---

## 5. 升级状态机

```
ota_upgrade(device_id, firmware_id)
  ① 读固件 + crc32
  ② 暂停该设备轮询（升级独占连接，尤其 RTU 半双工串口）
  ③ START(total_size, crc32) → 等 OK
  ④ 逐块 DATA(block_no, chunk_size) → 等 OK，失败查 STATUS 续传
  ⑤ END(total_blocks) → 等 OK
  ⑥ 恢复轮询；结束
```

- **断点续传**：某块失败（BAD_BLOCK / 超时），调 `STATUS` 拿 `next_block`，从该块续传。
- **单请求串行**：等上一块响应 `OK` 再发下一块（半双工）。
- **升级状态**：`idle / starting / transferring / verifying / done / failed / aborted`。
- **进度**：`current_block / total_blocks / 百分比`。

---

## 6. MCP 工具集（给调试 agent）

| 工具 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `upload_firmware` | `name, version, content(base64)` | `{ firmware_id, size, crc32 }` | 上传固件（方案 C） |
| `list_firmwares` | — | 固件列表 | 查已上传固件 |
| `ota_upgrade` | `device_id, firmware_id, chunk_size?` | `{ task_id }` | 发起升级（异步，立即返回）；`chunk_size` 可选，默认取设备配置（128），不得超过设备上限 |
| `ota_status` | `device_id` | `{ state, current_block, total_blocks, percent, error? }` | 查进度 |
| `ota_abort` | `device_id` | `{ ok }` | 中止升级（可选） |

- 升级是**长过程**，agent 的模式是「发起 + 轮询 `ota_status`」，不是同步等结果。
- `write_register` 等常规工具在升级期间对该设备**应被挂起**（升级独占连接）。

---

## 7. 升级期间的轮询处理

- 升级开始：**暂停该设备的 poller 轮询**（避免和升级抢同一串口/连接，尤其 RTU 半双工）。
- 升级结束（done/failed/aborted）：**恢复轮询**。

---

## 8. 分期实施

| 优先级 | 内容 |
|---|---|
| **P0** | 原始帧收发（RTU + TCP）+ 0x41 状态机 + CRC32 + 固件上传/存储 |
| **P1** | 断点续传（STATUS/next_block）+ MCP 工具集（5 个） |
| **P2** | Web 进度界面（可选）、升级日志/审计 |

---

## 9. 验收标准

- [ ] 通过 RTU 串口完成一次完整固件升级（START→DATA→END，逐块校验）。
- [ ] 通过 TCP 完成一次完整固件升级（MBAP 封装正确）。
- [ ] 断点续传：中途制造 BAD_BLOCK，能从 `next_block` 续传成功。
- [ ] CRC32 计算正确（与设备侧比对一致）。
- [ ] MCP `upload_firmware` → `ota_upgrade` → `ota_status` 全链路可用。
- [ ] 升级期间设备轮询暂停，结束恢复。

---

## 10. 风险与开放问题

1. **设备侧配合**：0x41 协议要求设备固件侧有对应的 IAP 从机逻辑（MB-RTU 库已提供）；平台侧只是「发送方」。
2. **块大小上限**：设备侧 `MB_IAP_MAX_DATA` 决定上限（默认 128）。平台块大小可配置，但超过设备上限会被拒（BAD_LEN）；设备上限由固件决定，若固件改了 `MB_IAP_MAX_DATA`，需在设备配置里同步。
2. **升级是破坏性操作**：写错固件可能变砖。平台忠实执行（不兜底），但需在 MCP 工具描述里明确「升级失败可能导致设备不可用」。
3. **TCP 升级的 MBAP 细节**：transaction_id 递增、length 计算需对齐 jsmodbus 现有 TCP 连接的状态，避免和轮询的 MBAP 序列冲突。
4. ~~固件文件存储位置~~ 已定：工作区下 `firmware/` 子目录，随工作区（见 §4.4）。
