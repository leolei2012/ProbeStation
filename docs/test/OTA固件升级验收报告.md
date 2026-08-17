# ProbeStation OTA 固件升级验收测试报告

> 测试时间：2026-08-16 13:32:57（+08:00）
> 测试对象：OTA 固件升级功能（对照 `docs/product/07-OTA固件升级PRD.md` §9 验收标准）
> 测试范围：`packages/ota`（0x41 状态机 + 帧编解码 + CRC32 + 断点续传）+ REST 端点 + MCP 5 工具 + 升级期间轮询暂停/恢复
> 测试人：测试工程师（接替原测试会话）
> 本轮性质：**新功能首轮验收**（OTA 为最新提交 `612966e` 引入，此前 5 轮测试未覆盖）

---

## 一、结论

| PRD §9 验收项 | 结果 | 依据 |
|---|---|---|
| RTU 串口完整升级（START→DATA→END，逐块校验） | ✅ 通过 | `test-ota.ts` 场景1 + 本报告 §二 MCP 链路 |
| TCP 完整升级（MBAP 封装正确） | ✅ 通过 | `test-ota.ts` 场景2 |
| 断点续传（BAD_BLOCK → next_block 续传） | ✅ 通过 | `test-ota.ts` 场景3（blockLog=[0,1,2]，block 1 重试成功） |
| CRC32 计算正确（与设备侧比对） | ✅ 通过 | `test-ota-frame.ts` 标准向量 + `0xDE0E57CE` 对拍 |
| MCP `upload_firmware` → `ota_upgrade` → `ota_status` 全链路 | ✅ 通过 | 本报告 §二（新增独立测试 `test/ota-mcp-acceptance.ts`） |
| 升级期间设备轮询暂停，结束恢复 | ✅ 通过 | 本报告 §二（pause=1 / resume=1 / reconnect=1） |

**结论：OTA 固件升级功能 6/6 项验收全部通过，无缺陷。**

---

## 二、独立验证（本轮新增，弥补开发侧测试覆盖空白）

开发侧 `test-ota.ts` 把 `poller.pauseObject/resumeObject` mock 成了空函数，且从未通过真实 MCP 服务器调用过 5 个 OTA 工具。本轮新增 `test/ota-mcp-acceptance.ts`，**装配真实 ota 插件 + 真实 mcp 服务器**，用一个带断言的 fake poller 替换真实 poller（记录 pause/resume/reconnect 调用），通过真实 MCP 客户端走完整链路：

```
MCP tools (19): [... upload_firmware, list_firmwares, ota_upgrade, ota_status, ota_abort]   # 5 个 OTA 工具齐全
upload_firmware: {"firmware_id":1,"size":300,"crc32":3725481934}                            # 0xDE0E57CE，与 iap_demo.c 对拍一致
list_firmwares count: 1
ota_upgrade: {"task_id":"ota_1","device_id":1}                                              # 异步发起，立即返回
ota_status final: {"state":"done","current_block":3,"total_blocks":3,"percent":100}         # 3 块（300B/128）全部完成
OTA MCP ACCEPTANCE TEST OK  (pause=1 resume=1 reconnect=1)                                  # 升级期间轮询暂停/恢复落实
```

**要点**：
- 固件 300B / 块 128B = 3 块，从站逐块接收并校验，最终镜像字节与上传内容一致、CRC32 一致。
- 升级发起时 `pauseObject` 调用 1 次，结束时 `resumeObject` + `reconnectDevice` 各调用 1 次，满足「升级独占连接 / 半双工串口不抢」的要求。

---

## 三、开发侧测试回归（基线）

本轮同时复核开发侧 OTA 自测脚本，全部通过（用 `node --experimental-transform-types` 运行）：

| 脚本 | 结果 |
|---|---|
| `scripts/test-ota-frame.ts`（CRC32 标准向量 + 0x41 PDU/RTU/TCP 封装字节级对拍） | ✅ 通过 |
| `scripts/test-ota.ts`（RTU/TCP 完整升级 + 断点续传，fake socket） | ✅ 通过 |
| `scripts/test-ota-api.ts`（REST 上传/列表/状态） | ✅ 通过 |
| `scripts/test-rtu.ts`（SerialDriver 连接/FC03/FC06/多 slaveId） | ✅ 通过 |
| `scripts/test-mcp-reconnect.ts`（同进程 A/B/C 三次连接，各 19 工具） | ✅ 通过 |

---

## 四、发现（非缺陷，供跟进）

1. 📝 **文档漂移**：`docs/03-开发与接手指南.md` §11「待办/下一步」仍写着「OTA 固件升级（原 Monitor 有，未做）」，而 OTA 实际已实现（§5/§9/§16 均已描述）。建议删除该行。
2. 📝 **文档漂移**：`docs/test/00-测试总报告.md` 与 `docs/develop/01-变更记录.md` 六处仍写「MCP 14 工具」，实际现为 **19 工具**（OTA 新增 5 个）。建议同步为 19。
3. ⚪ **轻微**：`OtaEngine.abort()` 对「无进行中升级」的设备也返回 `{ok:true}`（静默无操作）；且 PRD §6 将 abort 标为「可选」，故不影响验收，仅提示可后续给 abort 返回 `{ok:false, reason:"no-active-upgrade"}`。
4. ⚪ **轻微**：PRD §2.3「块大小存设备配置」，当前引擎 `startUpgrade` 默认 128 字节（`DEFAULT_CHUNK_SIZE`），未从设备配置读取上限字段（设备 schema 暂无该字段）。默认值与设备侧 `MB_IAP_MAX_DATA=128` 对齐，故无实际影响，仅规格实现存在轻微偏差。
5. ⬜ **未覆盖**：Web 端「固件」Tab（上传/列表/一键升级/进度）本轮未做浏览器验证（需构建前端 + 启动 8080 + Playwright，且 PRD §8 将 Web 进度界面标为 P2 可选）。如需，可作下一轮补测。

---

## 五、测试资产

- 新增：`test/ota-mcp-acceptance.ts`（OTA MCP 全链路 + 暂停/恢复独立验收，可 `node --experimental-transform-types test/ota-mcp-acceptance.ts` 复跑）。
- 复用的开发侧脚本：`scripts/test-ota-frame.ts` / `test-ota.ts` / `test-ota-api.ts` / `test-rtu.ts` / `test-mcp-reconnect.ts`。

> 说明：真机验收仍需设备侧具备 0x41 IAP 从站固件（MB-RTU 库提供）+ 真实串口/TCP 环境；本报告为平台发送侧的逻辑/集成验收（与 PRD §10「平台侧只是发送方」一致）。
