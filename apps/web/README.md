# @probebench/web

React 18 + Vite 前端，DSH 风格 app 壳：**左侧栏（设备/工作区选择 + 新建设备 + 设置），右侧工作页**。

## 技术栈

React 18、Vite 6、@vitejs/plugin-react、TypeScript、纯 CSS（`styles.css`）。

## 运行

```bash
npm run dev --workspace @probebench/web    # vite dev（代理 /api + /ws 到 8080）
npm run build --workspace @probebench/web  # 产物 apps/web/dist
```

## 布局

- **左侧栏**：品牌 + 「新建设备」按钮 + 设备列表（状态点/名称/IP、点击选中、悬停删除）+ 底部「设置」。
- **右侧主区**：选中设备的工作页（表头状态徽章 + 工具栏「暂停/导出 CSV/XLSX/删除」+ 寄存器实时值表 + 行内写值），或「设置」页。
- **设置页**：应用信息 + 数据管理（清空日志）。

## 结构

- `src/App.tsx` — 壳 + 子组件（Sidebar/DeviceView/WriteCell/SettingsView/AddDeviceModal/EmptyState）
- `src/styles.css` — 设计令牌（CSS 变量）+ 全部样式
- `src/main.tsx` — 挂载入口

## 当前限制（TODO）

- 无历史曲线图（导出走 CSV/XLSX）。
- 写值未做范围校验/确认。
- 设置页较简单（后续加主题/告警配置）。
