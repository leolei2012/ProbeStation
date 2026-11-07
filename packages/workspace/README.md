# @probebench/workspace

工作区管理（对齐 DSH「一个文件夹 = 一个工作区」）。注入 `config` + `store` + `poller`，提供 `ctx.workspace`。

**当前主启动程序未注册此插件，固定使用单一数据目录；本包保留不代表在用实例开放工作区切换。** 本轮未恢复工作区UI、REST或启动接入。

## 依赖

```ts
export const inject = ['config', 'store', 'poller']
```

## 配置（schemastery）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `defaultWorkspace` | string | `'data'` | 默认工作区目录（相对 cwd 或绝对路径） |
| `registryPath` | string | `~/.probestation/workspaces.json` | 最近工作区注册表 JSON |

## 服务 `ctx.workspace`

```ts
interface Workspace {
  getCurrent(): string                                // 当前工作区绝对路径
  list(): { current; currentTitle; recent: WorkspaceRecord[] }  // 当前 + 最近使用（记录含 path/title/lastUsedAt）
  browse(path: string): { path; parent; dirs }        // 列子目录（文件夹浏览）
  switchTo(path: string): Promise<void>               // 切换工作区
  captureHistoryExportPair(objectId: number): HistoryExportPair // 可选内部能力，返回配置副本和store句柄
  validateHistoryExportPair(pair: unknown): void      // 异步读取/文件生成后再次核对，失效抛固定机器码
}
```

## 行为

- 一个工作区 = 一个文件夹，内含 `config.db`（元数据）+ `poll.duckdb`（时序），自包含。
- `switchTo(dir)`：停轮询 → `store.reopen` → `config.reopen` → 更新 current + 注册表 → 发 `workspace/changed` → 重启轮询。
- 切换开始立即撤销可选导出配对，并拒绝重叠切换（在目录/轮询副作用之前）。只有本次实际重开的两个实例在完整流程结束后仍匹配，才开放新配对；原阶段错误原样抛出，失败不自动恢复旧配对，也不尝试回滚或恢复采集。缺少新能力的旧自定义provider仍可按旧流程切换，但配对不可用。
- `config.reopen` / `store.reopen` 会关闭旧库（node:sqlite `close()` / DuckDB `closeSync()`）再开新库，热层 `latest` 清空。
- 注册表记录形如 `{ path, title, lastUsedAt }`（对齐 DSH workspaceRecord），`title = basename(path)`，最多 20 条、最近优先，按规范化路径去重。
- 注册表**原子写**（先写 `.tmp` 再 `rename`，失败回退直写）；兼容旧版 `string[]` 格式（加载时迁移成记录）。
- 导出的 `resolveInitialWorkspace(default, registryPath?)`：启动时优先返回注册表里最近一次使用的工作区；cli 用它推导 `config.db`/`poll.duckdb` 路径，实现「重启记住上次工作区」。

## 当前限制

- `captureHistoryExportPair`启动时拒绝，不从两个独立打开的库猜测配对；需要成功受管理切换。返回冻结的配置事务快照、store句柄和不含路径的workspaceScope，必须保持原对象，复制/JSON/跨实例无效。直接重开任一库、替换provider或切换失败后，旧配对无效；成功切换才能重新开放。固定错误code为`WORKSPACE_EXPORT_PAIR_INVALID`，不暴露底层错误原文。
- 这只绑定打开周期，不是配置内容revision、历史数据事务或连接保活租约。普通配置编辑/flush不使其失效；调用方必须在异步读取和附件生成后再次`validateHistoryExportPair`，不能用单次预检代替。新能力尚未接入Sink、HTTP、MCP或前端，现有导出风险仍在，详见[配对门禁验证](../../docs/develop/71-工作区导出配对生命周期保护.md)。
- 切换工作区不会自动播种演示设备（只有默认工作区首次启动时由 cli 播种）。
- 不做跨工作区复制/迁移。
