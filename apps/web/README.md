全局保留设置由按需模块`GlobalRetentionSettings`与`global-retention-state`管理：未读成功不猜默认值、预设不立即写、独立草稿与不可撤销清理确认、严格回执、慢写关闭重开不重发。未知结果只允许读取核对，本页不再写；不提供后端跨用户条件保护或清理成功证明。`npm run preview:global-retention`仅构建纯mock静态页，浏览器交互未验收，见[范围与限制](../../docs/develop/62-全局保留策略读写状态回归.md)。

# @probebench/web

`SettingsModal`独立按需模块，由`DeferredSettingsModal`复用DeferredResource，只有showSettings为真才加载；失败/超时提供关闭/显式代码重试，关闭不因代码迟到重新开窗，不重放保存/恢复/清理。API适配器仍由App传入，未建立业务模块到App的静态导入，设置正文/内部隐藏AI表单保持原结构，助手面板仍原样挂载。聚合启动预算、测量和手测边界见[说明](../../docs/develop/61-设置模块按需加载与首屏预算.md)。

原始报文页用`DiagnosticsCleanupButton`和本页单例`DiagnosticsCleanupFlow`管理安全预览/一次确认；只对当前完整targetKey匹配的目标提交一次token，写不设abort或业务超时，不回退frames/clear。结果与来源不符/断线/500标未知，关闭重开保留，显式新预览才能再次确认。成功仅使同目标当前原始记录快照失效、通信统计收起，随后按既有读取策略重读，采集不停止；暂停时仍能查看状态。范围与手测见[说明](../../docs/develop/60-通信诊断清空确认与结果隔离.md)。

`RawDataView`采用独立`RawFramesRead`：原1秒调度继续，但在途请求合并、10秒超时，暂停立即取消等待并保留上次不可变快照。设备连接字段/从站默认值/显示上限变化换reader，旧结果不能跨上下文发布；`RawFramesStatus`区分读取中、失败旧结果、空记录及旧身份不足，不修改采集或旧清空写入契约，见[说明](../../docs/develop/59-原始捕获慢读取与暂停隔离.md)。

`CommunicationSummary`接入原始报文页，默认收起不读取；展开及手动重读仅GET既有diagnostics。`CommunicationSummaryRead`合并在途读取、超时/取消和迟到结果隔离；解析核对设备/共享通道身份，NULL/零与旧结果不冒充正常。无后台轮询、探测、模型或清空能力，RTU共享及累计边界见[说明](../../docs/develop/58-只读通信统计快照.md)。

`PointSettingsEditor`用固定的打开时字段文本与`pointEnumChanged`识别本地草稿，`PointDraftCloseGuard`同步管理主动关闭/确认/继续，`PointDraftDiscard`提供明确放弃入口；保存中不关闭、不取消写，成功直接关闭。只涉及点位窗口的×/取消/内部Escape，不做浏览器刷新、外部导航或其他编辑器的全局草稿保护，见[说明与手测](../../docs/develop/57-点位草稿关闭保护.md)。

`LiveTable`的“冻结当前筛选结果”使用纯`captureLiveSnapshot`复制当前逻辑匹配点位、显示文本与已知来源原始字；`LiveSnapshotPanel`独立分页预览并本地下载JSON。采集/新读数/筛选变化不会改写副本，切换设备或卸载后不保留；无请求、模型或配置写入。精确值/NULL/异常、时间边界及手测限制见[说明](../../docs/develop/56-实时观测快照冻结与下载.md)。

日志清理使用`LogCleanupDialog`/`LogCleanupFlow`，打开仅GET预览，确认后只POST冻结范围；默认本页内存状态保留进行中/已完成/结果不明，关闭不取消写、不自动重试，不调用旧/api/logs/clear。清理结果到达后已展开日志查看器只读重读。独立Portal/焦点/Tab/Escape及状态验收限制见[说明](../../docs/develop/55-预览范围日志清理.md)。

日志level/source/message按已有数据库可空契约保留null；NULL显示“未记录”、空串显示“空…”，级别的未记录选项与真实字符串missing/all/null互不冲突。搜索只匹配原字段，不把NULL自动变为文本null；时间、ID和异常字段校验不变，见[修复说明](../../docs/develop/54-日志NULL字段兼容.md)。

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

顶部设备状态提醒读取限时10秒，在途合并并可手动重新核对；失败保留上次提醒并标未核实，展开可查看后端核对时间与本页接收时间，旧响应缺时间不补造。提醒保留原可收起展示，关联按钮只沿用用户主动导航；空汇总不作为健康判断。纯mock入口 `npm run preview:device-issues`，见 `docs/develop/63-设备状态提醒读取与恢复.md`；真实浏览器交互未验收。

诊断关联导航会核对设备角色：主站进入原始报文，从站回到实时概览，避免选中被隐藏的标签。相关路由、重复导航、历史参数与角色切换的组合回归见 `docs/develop/64-设备提醒与页面导航一致性回归.md`；不是浏览器挂载验收。
