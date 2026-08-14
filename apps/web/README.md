# @probebench/web

React 18 + Vite 前端仪表盘（最小 shell）。

## 技术栈

React 18、Vite 6、@vitejs/plugin-react、TypeScript。

## 运行

```bash
# 开发（vite dev server，代理 /api 和 /ws 到后端 8080）
npm run dev --workspace @probebench/web

# 构建
npm run build --workspace @probebench/web   # 产物在 apps/web/dist
```

## 结构

- `index.html` — 入口 HTML
- `vite.config.ts` — 代理：`/api → http://127.0.0.1:8080`，`/ws → ws://127.0.0.1:8080`
- `src/main.tsx` — React 挂载入口
- `src/App.tsx` — 仪表盘

## 行为

- 挂载时 `fetch('/api/monitor_objects')` 拿设备列表。
- 连接 `/ws`，接收 `latest` 快照 + `poller/result` 广播，实时更新值表。

## 当前限制（TODO）

- 最小 shell：无历史曲线图、无设备/寄存器 CRUD、无告警面板（后续 Phase 补）。
- 未接语义层（决策：不做）。
- 前端需后端运行在 8080（dev 代理 / 生产由后端 serve dist）。
