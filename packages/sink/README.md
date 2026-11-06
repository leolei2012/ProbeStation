# @probebench/sink

数据导出（CSV / XLSX）。注入 `config` + `store`，提供 `ctx.sink`。导出值按寄存器类型**解码**（hex/bin 逐字、数值格式化，多字 32/64 位合成完整值，走 `formatRawByAddr`）。

## 服务 `ctx.sink`

```ts
interface Sink {
  exportCsv(objectId, start, end, registerIds?, tzOffsetMin?): Promise<string>   // CSV 字符串（宽表）
  exportXlsx(objectId, start, end, registerIds?, tzOffsetMin?): Promise<Buffer>  // XLSX 二进制
  exportPointSheet(objectId): Promise<{ buffer: Buffer; filename: string }>      // 点表 xlsx，分组=sheet
  importPointBook(objectId, buffer, replace?): Promise<{ groups; registers; errors; warnings }> // 原子重建或追加点位
}
```

`registerIds` 可选：只导出指定寄存器子集（不传 = 导出该设备全部寄存器）。
`tzOffsetMin` 可选（分钟，东为正，0=UTC）：把时间戳转成目标时区的本地字面时间。不传默认为 `0`（UTC）。

历史导出最多接受 **200000 条已选点位所需原始采样行**（包含多字点位的全部原始字），不是 CSV/XLSX 的宽表行数。在数据库中先按从站/数据区/地址筛选，再多取一条判断是否溢出；未选地址不占用限额。低于/恰好上限正常返回；超过时抛出 `HistoryExportLimitError`（code=`HISTORY_EXPORT_LIMIT`），不生成任何部分文件。CSV/XLSX 数据列和批次状态列不变。

相邻/重叠点位的地址范围按并集读取，不因范围重叠重复返回原始行；原库的真实重复行仍保留并参与解码校验。只输出至少有一个所选点位原始字的时间戳，缺字、混批、坏质量仍显示未知；不再为仅有未选点位数据的时刻生成空行。没有匹配点位时仅输出表头。筛选粒度为设备/从站/数据区/地址，期望从站由点位当前分组决定（本地 slave 模式用设备编号）。旧 NULL 来源行不能排除，保守计入限额；跨从站重叠时未知，不复制为两边可信值。

HTTP 接口将该错误返回为 **413 JSON**，含 `code`、`limit` 和说明，不带附件头。网页在导出弹窗显示超限原因，取消并缩小范围后可重试；直连 API 的调用者必须检查状态码，不能将错误体保存为 CSV/XLSX。未提供自动拆分、流式或显式部分导出。

## 点表 xlsx（分组=sheet）

`exportPointSheet` 把一台设备的**点位定义**（不是历史采样）导成一个 xlsx：
- Sheet「设备信息」记录设备连接参数；
- 其余每个 sheet = 一个寄存器分组（分组名即 sheet 名），每行一个寄存器；
- 每分组 sheet 的布局固定（前两行分组头「分组/从站/功能码/起始地址/数量」，第4行数据列头 `别名|数据类型|单位|系数|偏移|枚举|功能码|起始地址|数量`），可供该文件的 `importPointBook` 对称回导（`importPointBook` replace=true 会全量重建该设备分组/寄存器）。

端到端往返验证：`npx tsx scripts/test-pointsheet.ts` → `POINTSHEET ROUNDTRIP OK`。

现整次替换/追加在一个配置事务内执行，已有校验发现任意行错误则回滚，返回groups/registers=0及errors；写入异常同样回滚，无部分通知。没有分组页不能清空设备。成功后一次point-book-import通知，提交后通知/日志失败只返回warnings，请核对而非自动重试。当前Web检查errors但未新增warnings展示。

pointbook.ts现先校验完整计划，原样保留分组从站/显式范围、点位quantity及零倍率。完整dtype字宽不得越出显式范围；范围两项同时空才推导并提示。缺从站/FC保留旧默认1/FC03并提示，缺quantity默认1。只建文件明确的点，稀疏/有范围空组不补占位。35组安全回归覆盖这些字段往返和错误隔离，v2未定义的mode/启用字段、枚举分隔符、名称碰撞等限制见[字段保真](../../docs/develop/09-XLSX点表字段保真.md)。

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

- 历史导出数据来自 `store.queryObjectForExport(..., ranges)`，按 dtype 宽度合并所需地址区间，在筛选之后最多读取 200001 条用于溢出判断；普通 `queryObject()` 的 200000 条限制不变。
- 用 `formatRawByAddr()` 把原始字解码成显示值（hex/bin 逐字、数值 `formatNumber`、多字合并）。
- CSV 纯字符串拼接（含逗号/引号转义）。
- XLSX 用 exceljs（`writeBuffer()`）。

## 当前限制（TODO）

- 未做大数据分页/流式；超过原始行上限会拒绝导出，请拆分时间范围。浏览器会在内存中接收已允许的文件，等待超过 30 秒时可取消/重试；不保证后台工作立即停止。

CSV/XLSX 保持三列一组的结构：值、`__batch_status`、`__automatic_eligible`。状态文字现为“批次/来源已验证”“批次/来源未验证”“未知”；外部按状态文字解析的脚本需适配。automatic_eligible 必须同时满足目标从站来源明确、完整同批和质量有效，仅表示可供自动消费，不表示 PASS/FAIL。缺来源但无归属歧义时允许人工兼容查看；存在来源歧义、混批或缺字时值为空。已知目标样本完整时只采用该目标，不用 NULL 或另一从站补字。
