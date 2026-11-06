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
- MBP 只实现当前 XML/INI 子集，无仓库内真实导出样例或原 Python 解析器可进一步核验厂商变体；未验证字段不推断。
- 导入基于 base64 JSON，未用 multipart 文件上传。

## 多窗口归组与原子追加（2026-11-06）

parseMbp/parseMbs 的 registers 新增 groupIndex（从0开始的原始 Data/Window 索引，不是数据库ID）。服务根据该索引映射新建组；即使多个窗口名称、FC、地址相同/重叠也各自保留，不按范围或名称猜归属。INI重复同名段不再覆盖前段，按出现次序保留并返回警告。

写入通过 ConfigStore.appendImportedPoints：先校验目标和全体窗口/点位，再一个事务追加；不更新/删除已有设备、组、点位、告警或历史。组/点位/提交失败时回滚且不发半份配置事件，成功后仅通知一次 scope=import/id=目标设备；同步通知回调失败会返回“已提交、勿重复导入”的警告，不伪装成可重试写失败。空文件/无窗口沿用0计数和警告、无写入事件。

保留旧数量/类型约定：XML每Data逐字建立定义，32位格式提示仍按原始int16；INI每Window保留一条定义，组跨度沿用Quantity，不自动扩成多点；入库点位quantity元数据仍默认1，未按dtype重算。MBS头部明确的从站号现在原样传给createGroup，不再丢回默认1；不修改目标设备自身编号。

预检拒绝不支持的读取FC、广播/非法从站、非整数/非正长度、越界范围、缺失/错误groupIndex、功能码不一致及完整点宽越界。大窗口可以跨多个PDU，不以125/2000为整个组上限。XML使用现有fast-xml-parser的验证器检查完整性，没有新增依赖。

MBP从站号仍沿用已实现的默认1，并返回提示；未猜测未验证的Slave/Unit字段。INI地址换算仍沿用现有0/1/40001/30001规则，其他编号、编码和厂商变体需真实格式资料确认；MBS名称提取仍为启发式。旧已错误归组的现存配置不会自动迁移或重新导入。详情见 [归组修复说明](../../docs/develop/06-MBP多窗口归组修复.md)。

安全回归用 `node node_modules/tsx/dist/cli.mjs scripts/test-importer-groups.ts`；它只用合成Buffer和:memory:配置库。原test-importer.ts会调用完整bootstrap，未加入安全清单，也未在本轮执行。没有启动服务、实机、真实库迁移或部署。
