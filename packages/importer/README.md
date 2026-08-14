# @probebench/importer

寄存器文件导入：把 Modbus Poll（.mbp）和 Modbus Slave（.mbs）项目文件解析成设备/寄存器配置。
注入 `config`，提供 `ctx.importer`。

## 支持格式

| 格式 | 说明 |
|---|---|
| `.mbp` XML（Modbus Poll v12+） | `<ModbusPoll>` + `<Data>` 块（Function/Address/Quantity/CellData/Formats） |
| `.mbp` INI（Modbus Poll < v12） | `[Window*]` 段（Function/Address/Quantity/Alias/Data Type） |
| `.mbs` 二进制（Witte Modbus Slave） | 小端头（func_code@12 / quantity@16 / slave_id@20）+ UTF-16LE 寄存器名 |

## 服务 `ctx.importer`

```ts
import(objectId: number, filename: string, content: Buffer):
  { groups: number; registers: number; warnings: string[] }
```

按文件名后缀自动选解析器（`.mbs` → MBS，否则 MBP 自动探测 XML/INI）。

## API 端点（由 api 插件暴露）

````
POST /api/monitor_objects/:id/import
body: { filename: "t.mbp", content: "<base64 文件内容>" }
```

## 导出函数

`parseMbp(content)` / `parseMbs(content)` 直接返回 `{ groups, registers, warnings }`（供测试/复用）。

## 当前限制（TODO）

- MBS 名称提取是启发式（仿原 Python），对复杂字体前缀的清理可能不完美。
- 所有寄存器导入到第一个 group（多 Data/多 Window 的组映射未完全对齐原逻辑）。
- 导入基于 base64 JSON，未用 multipart 文件上传。
