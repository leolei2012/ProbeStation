# @probebench/sink

数据导出（CSV / XLSX）。注入 `config` + `store`，提供 `ctx.sink`。导出值按寄存器类型**解码**（hex/bin 逐字、数值格式化，多字 32/64 位合成完整值，走 `formatRawByAddr`）。

## 服务 `ctx.sink`

```ts
interface Sink {
  exportCsv(objectId, start, end, registerIds?, tzOffsetMin?): Promise<string>   // CSV 字符串（宽表）
  exportXlsx(objectId, start, end, registerIds?, tzOffsetMin?): Promise<Buffer>  // XLSX 二进制
  exportPointSheet(objectId): Promise<{ buffer: Buffer; filename: string }>      // 点表 xlsx，分组=sheet
  importPointBook(objectId, buffer, replace?): Promise<{ groups; registers; errors }> // 从该 xlsx 重建点位
}
```

`registerIds` 可选：只导出指定寄存器子集（不传 = 导出该设备全部寄存器）。
`tzOffsetMin` 可选（分钟，东为正，0=UTC）：把时间戳转成目标时区的本地字面时间。不传默认为 `0`（UTC）。

## 点表 xlsx（分组=sheet）

`exportPointSheet` 把一台设备的**点位定义**（不是历史采样）导成一个 xlsx：
- Sheet「设备信息」记录设备连接参数；
- 其余每个 sheet = 一个寄存器分组（分组名即 sheet 名），每行一个寄存器；
- 每分组 sheet 的布局固定（前两行分组头「分组/从站/功能码/起始地址/数量」，第4行数据列头 `别名|数据类型|单位|系数|偏移|枚举|功能码|起始地址|数量`），可供该文件的 `importPointBook` 对称回导（`importPointBook` replace=true 会全量重建该设备分组/寄存器）。

端到端往返验证：`npx tsx scripts/test-pointsheet.ts` → `POINTSHEET ROUNDTRIP OK`。

## 导出格式（宽表）

行 = 时间戳（默认 UTC，带 `tzOffsetMin` 时转成对应本地时区，列名标注时区），列 = 每个寄存器（列名用 alias，缺省用 reg{id}），单元格为解码后的显示值：

```
timestamp (UTC+08:00),温度,转速
2026-08-14 10:00:00,100,800
2026-08-14 10:00:01,101,801
```

数据库存储的时间戳一律为 UTC；`tzOffsetMin` 由浏览器在下载时透传本地时区偏移（经 `tz=` query），使导出时间与本地浏览一致。

## API 端点（由 api 插件暴露）

- `GET /api/export/csv?object_id=&start=&end=[&register_ids=1,2,3][&tz=-480]` → 下载 CSV
- `GET /api/export/xlsx?object_id=&start=&end=[&register_ids=1,2,3][&tz=-480]` → 下载 XLSX

`register_ids` 可选，逗号分隔的寄存器 id 列表；`tz` 可选，本地时区相对 UTC 的偏移分钟数（东为正，缺省 0）。

## 实现

- 数据来自 `store.queryObject()`（一次查某设备全部寄存器的时序，按地址存原始 16 位字）。
- 用 `formatRawByAddr()` 把原始字解码成显示值（hex/bin 逐字、数值 `formatNumber`、多字合并）。
- CSV 纯字符串拼接（含逗号/引号转义）。
- XLSX 用 exceljs（`writeBuffer()`）。

## 当前限制（TODO）

- 未做大数据分页/流式（一次性读全量）。
