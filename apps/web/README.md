# @probebench/web

React 18 + Vite 前端，DSH 风格 app 壳：**左侧栏（设备/工作区选择 + 新建设备 + 设置），右侧工作页**。

## 技术栈

React 18、Vite 6、@vitejs/plugin-react、TypeScript、纯 CSS（`styles.css`）。

## 运行

```bash
npm run dev --workspace @probebench/web    # vite dev（代理 /api + /ws 到 9090）
npm run build --workspace @probebench/web  # 产物 apps/web/dist
```

## 布局

- **左侧栏**：品牌 + 「新建设备」按钮 + 设备列表（状态点/名称/IP、点击选中、悬停删除）+ 底部「设置」。
- **右侧主区**：选中设备的工作页（表头状态徽章 + 工具栏「暂停/导出 CSV/XLSX/删除」+ 寄存器实时值表 + 行内写值），或「设置」页。
- **设置弹窗**：外观、语言、AI 提供商、数据管理及应用信息。数据管理含配置备份/恢复、历史保留和清空日志。主题与语言持久化到 localStorage。

## 结构

- `src/App.tsx` — 壳 + 子组件（Sidebar/DeviceView/WriteCell/SettingsView/AddDeviceModal/EmptyState）
- `src/styles.css` — 设计令牌（CSS 变量）+ 全部样式
- `src/ConfigBackupSettings.tsx` — JSON 备份、恢复预览与确认
- `src/VirtualTableBody.tsx` — 桌面超过 200 行的分组按可见行渲染
- `src/history-curve.ts` / `src/live-curve.ts` — 历史解码与实时采样纯函数
- `src/Assistant*.tsx` — AI 设置、模型选择及聊天
- `src/main.tsx` — 挂载入口

## 曲线与性能

历史曲线使用 `/api/data/object/series` 获取完整视窗的峰谷保留样本，时间轴缩放和平移会重新加载；读数栏在图外，鼠标时间标签显示在底部刻度。实时曲线隐藏或暂停时保留采样缓冲，停止定时绘图更新。后台页面暂停秒级计时刷新。

桌面大分组只渲染可见行，滚动后可读写全部点位；移动端保留正常卡片布局。配置恢复先预览，再事务新增为暂停设备，不覆盖现有配置。

仓库根目录运行 `npm run check` 做类型检查、构建和无硬件测试。详细说明见 `docs/配置备份与性能检查.md`。
