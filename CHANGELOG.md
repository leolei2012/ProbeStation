# Changelog

本文件记录项目的所有变更，按时间倒序排列。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

---

## [Unreleased]

### Fixed

- Web 实时数据通道增加心跳、断线检测、无限自动重连和断线期间 REST 快照兜底，解决长期运行后 UI 静默停止刷新而 MCP 仍正常的问题。
- WebSocket 服务端广播增加连接状态检查、异常隔离与僵尸连接清理。

### Added

- 新增主从站共用的 Modbus 协议模型：四类数据区、FC01/02/03/04/05/06/15/16、协议上限校验、广播规则及结构化错误分类。
- `ModbusDriver.execute()` 统一执行入口以兼容方式接入现有 TCP/RTU 驱动，现阶段覆盖已有 FC03/04/06/16。
- 新增 `scripts/test-protocol.ts`，验证协议映射、边界、错误分类和兼容执行。
- 新增 TCP/RTU 通信诊断：有界 TX/RX 报文缓冲、功能码/异常码解析、成功/超时/连续错误、最近错误率和响应耗时指标，并提供按设备 REST 查询与清理接口。
- 新增 `scripts/test-modbus-diagnostics.ts`，并扩展 RTU 模拟测试验证旁路抓包不影响正常协议收发。
- TCP/RTU 主站新增 FC01 线圈和 FC02 离散输入读取，统一执行入口、轮询器和 Web 分组同步支持。
- 时序热层与 DuckDB 历史层强制使用 Modbus 数据区维度，解决四数据区同地址覆盖；不再提供旧地址键和隐式 holding-register 查询。
- FC01/02 响应按请求 quantity 截断，避免字节填充位被误存为点表数据。

### Documentation

- 同步当前实现状态：13 个插件、29 个 MCP 工具、RTU/OTA/按设备轮询速率/数据保留/录制均已实现。
- 明确数据保留已实现，Phase 5 剩余项为时序降采样与 AI 调试语义层。
- 补充 `192.168.90.176:8899` 两段 Holding Registers 的只读真机联调记录。
