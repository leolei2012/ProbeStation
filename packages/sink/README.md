# @probebench/sink

数据导出（CSV / XLSX）。注入 `config` + `store`，提供 `ctx.sink`。导出值按寄存器类型**解码**（hex/bin 逐字、数值格式化，多字 32/64 位合成完整值，走 `formatRawByAddr`）。

## 服务 `ctx.sink`

```ts
interface Sink {
  exportCsv(objectId, start, end, registerIds?: number[]): Promise<string>   // CSV 字符串（宽表）
  exportXlsx(objectId, start, end, registerIds?: number[]): Promise<Buffer>  // XLSX 二进制
}
```

`registerIds` 可选：只导出指定寄存器子集（不传 = 导出该设备全部寄存器）。

## 导出格式（宽表）

行 = 时间戳，列 = 每个寄存器（列名用 alias，缺省用 reg{id}），单元格为解码后的显示值：

```
timestamp,温度,转速
2026-08-14 10:00:00,100,800
2026-08-14 10:00:01,101,801
```

## API 端点（由 api 插件暴露）

- `GET /api/export/csv?object_id=&start=&end=[&register_ids=1,2,3]` → 下载 CSV
- `GET /api/export/xlsx?object_id=&start=&end=[&register_ids=1,2,3]` → 下载 XLSX

`register_ids` 可选，逗号分隔的寄存器 id 列表。

## 实现

- 数据来自 `store.queryObject()`（一次查某设备全部寄存器的时序，按地址存原始 16 位字）。
- 用 `formatRawByAddr()` 把原始字解码成显示值（hex/bin 逐字、数值 `formatNumber`、多字合并）。
- CSV 纯字符串拼接（含逗号/引号转义）。
- XLSX 用 exceljs（`writeBuffer()`）。

## 当前限制（TODO）

- 未做大数据分页/流式（一次性读全量）。
