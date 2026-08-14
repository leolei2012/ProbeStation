# @probebench/sink

数据导出（CSV / XLSX）。注入 `config` + `store`，提供 `ctx.sink`。

## 服务 `ctx.sink`

```ts
interface Sink {
  exportCsv(objectId, start, end): Promise<string>   // CSV 字符串（宽表）
  exportXlsx(objectId, start, end): Promise<Buffer>  // XLSX 二进制
}
```

## 导出格式（宽表）

行 = 时间戳，列 = 每个寄存器（列名用 alias，缺省用 reg{id}）：

```
timestamp,温度,转速
2026-08-14 10:00:00,100,800
2026-08-14 10:00:01,101,801
```

## API 端点（由 api 插件暴露）

- `GET /api/export/csv?object_id=&start=&end=` → 下载 CSV
- `GET /api/export/xlsx?object_id=&start=&end=` → 下载 XLSX

## 实现

- 数据来自 `store.queryObject()`（一次查某设备全部寄存器的时序）。
- CSV 纯字符串拼接（含逗号/引号转义）。
- XLSX 用 exceljs（`writeBuffer()`）。

## 当前限制（TODO）

- 暂不支持按 register_ids 子集导出（导出全设备）。
- 未做大数据分页/流式（一次性读全量）。
