# @probebench/web

React 18 + Vite 前端仪表盘（设备管理 + 实时值 + 写寄存器）。

## 技术栈

React 18、Vite 6、@vitejs/plugin-react、TypeScript。

## 运行

```bash
npm run dev --workspace @probebench/web    # vite dev（代理 /api + /ws 到 8080）
npm run build --workspace @probebench/web  # 产物 apps/web/dist
```

## 功能

- **设备管理**：列表、添加、启用/停用（toggle）、删除。
- **寄存器实时值**：选中设备后展示其寄存器（别名/地址/类型/值/质量），WS 实时刷新。
- **写寄存器**：每行「写」按钮，走 `POST /api/registers/:id/write`（FC16）。

## 结构

- `src/main.tsx` — 挂载入口
- `src/App.tsx` — 单文件组件（设备列表 + 寄存器表 + WS 联动 + 增删改写）

## 当前限制（TODO）

- 无图表/历史曲线、无告警面板。
- 写值用 `prompt()`，未做输入校验/确认。
- 无路由、无状态管理库（pinia 时代遗留，当前 useState 够用）。
