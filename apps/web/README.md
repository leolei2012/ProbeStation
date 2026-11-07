# @probebench/web

`RuntimeLogs`接入设置→数据的“查看近期日志”，默认收起，使用原GET /api/logs?limit=200；全服务快照可按原始级别/空格关键词筛选并20条分页。关闭取消只读等待，失败保留上次并标未核实，原清空请求正常返回后对已展开查看器重读。新查看器没有清空/写配置/模型能力，未改旧端点契约，见[说明与手测](../../docs/develop/53-只读近期运行日志查看.md)。

`ui-preferences.ts`仅处理ps-theme/ps-lang/ps-collapsed：受支持枚举、原默认值、存储属性/getItem/setItem异常降级；主题effect不因保存失败而中断系统主题订阅。读取不写、不清空其他key，保存失败时React当前状态仍可用，刷新后能否保留取决于浏览器存储；见[范围与验证](../../docs/develop/52-启动偏好存储容错.md)。

助手本地附件读取由`assistant-attachment-read.ts`管理：全批元数据预检、原子追加、取消/失败中止余下FileReader并释放回调，卸载取消不发布状态。`AssistantAttachmentReadStatus`提供type=button的取消控件，不提交聊天表单；选择文件不等于发送。保留原支持格式、粘贴图片命名和大附件行为，无新数量/大小阈值，见[验证边界](../../docs/develop/51-助手本地附件读取取消.md)。

写值弹窗采用`registerWritePayloadValue`与REST共用的输入边界，提交前拒绝空值/非有限数值和无效64位整数文本；64位值序列化为精确字符串，hex/bin保持原进制payload。页面不新增写权限、自动重试或硬件动作，mock验证及限制见[说明](../../docs/develop/50-寄存器写值输入校验.md)。

实时REST回退生命周期：`src/realtime-fallback.ts`只负责所选设备的只读latest快照，合并有效在途请求，10秒超时；通道恢复、选择变更、卸载后旧响应及错误均失效。保留5秒刷新周期及既有更新中断提示，不改重连/心跳/硬件采样或写入；前端取消不表示后端采集已停止。离线回归及未验收部分见[说明](../../docs/develop/49-实时回退读取生命周期隔离.md)。

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
