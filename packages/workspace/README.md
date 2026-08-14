# @probebench/workspace

工作区管理（对齐 DSH「一个文件夹 = 一个工作区」）。注入 `config` + `store` + `poller`，提供 `ctx.workspace`。

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
}
```

## 行为

- 一个工作区 = 一个文件夹，内含 `config.db`（元数据）+ `poll.duckdb`（时序），自包含。
- `switchTo(dir)`：停轮询 → `store.reopen` → `config.reopen` → 更新 current + 注册表 → 发 `workspace/changed` → 重启轮询。
- `config.reopen` / `store.reopen` 会关闭旧库（node:sqlite `close()` / DuckDB `closeSync()`）再开新库，热层 `latest` 清空。
- 注册表记录形如 `{ path, title, lastUsedAt }`（对齐 DSH workspaceRecord），`title = basename(path)`，最多 20 条、最近优先，按规范化路径去重。
- 注册表**原子写**（先写 `.tmp` 再 `rename`，失败回退直写）；兼容旧版 `string[]` 格式（加载时迁移成记录）。
- 导出的 `resolveInitialWorkspace(default, registryPath?)`：启动时优先返回注册表里最近一次使用的工作区；cli 用它推导 `config.db`/`poll.duckdb` 路径，实现「重启记住上次工作区」。

## 当前限制

- 切换工作区不会自动播种演示设备（只有默认工作区首次启动时由 cli 播种）。
- 不做跨工作区复制/迁移。
