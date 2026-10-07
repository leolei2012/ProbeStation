# 内置 AI 助手

## 设置和聊天

接口配置统一放在左下角「设置 → AI 助手」。聊天标题栏「模型设置」打开同一页面。保存后刷新聊天的模型信息；正在运行的请求继续使用启动时的配置，新消息使用新配置。

- `apps/web/src/assistant-client.ts`：统一 API 请求和配置类型。
- `apps/web/src/AssistantSettings.tsx`：配置加载、保存、错误状态；密钥不回显、不进入浏览器存储。
- `apps/web/src/AssistantPanel.tsx`：会话生命周期、轮询、发送/停止、提案确认、窗口展开和滚动跟随。
- `apps/web/src/AssistantMessage.tsx`：消息展示和工具记录。回答使用 react-markdown + remark-gfm；不执行 HTML，不自动加载模型输出中的远程图片。
- `packages/api/src/assistant.ts`：服务端会话、模型调用、白名单工具与提案执行。模型不能自行确认修改。

聊天支持展开/还原、Enter 发送、Shift+Enter 换行、中文输入法组合输入保护。向上阅读时不强制滚到末尾，可点「回到最新消息」。工具原始结果默认折叠。

## DSH 参考边界

本次查阅 [DeepSeek Harness 官方仓库](https://github.com/deepseek-ai/deepseek-harness)，参考版本 `5badb15009ae1756c3afe0ae0cef1faafc290ccc`，重点是 `packages/client/ui-chat` 中的 ChatView、AssistantMarkdown、use-chat-scroll 和 ui-chat/package.json。

DSH 的聊天视图通过会话控制器、conversation 节点、renderer、settings、workspace 等插件协作，并非一个可独立复制的 React 组件。本项目参照其设置/会话/消息展示分层、Markdown 展示、工具折叠和阅读位置保护思路，使用现有 API 实现适配；没有复制 DSH 源码，也没有引入完整 DSH 运行时。下载到 reference/ 的源码仅供本地参考，不参与构建。

当前模型回答仍为非流式返回，会话保存在服务端内存中，不具备 DSH 完整的会话持久化、多会话导航、agent 插件系统。后续如迁移完整 DSH，需另做会话协议及设备工具审批的适配，不能直接开放其通用执行工具来替代当前白名单。

## 验证

- `npm run build:web`
- `node node_modules/tsx/dist/cli.mjs scripts/test-assistant.ts`
- 界面验证使用隔离的模拟 API，检查统一设置保存/回填、聊天模型刷新、展开、键盘发送、Markdown 表格与代码块；不调用真实模型或设备。

本次增加前端 Markdown 依赖，更新部署时先运行 `npm install` 再启动。

## 多提供商与模型选择

`assistant-providers.ts` 直接复用 DSH llm-pi-ai 同一底层依赖 `@earendil-works/pi-ai` 0.87.x 的 builtinModels、completeSimple 和 getSupportedThinkingLevels。未复制其 Cordis 适配器或 UI 源码，仍保留 ProbeStation 白名单工具、只读执行保护和人工确认。

已接入 17 个 API Key 提供商，包括 DeepSeek、MiniMax/中国区、Anthropic、Google、OpenAI、Moonshot/中国区等。未接入 OAuth、Bedrock、Azure、Vertex 等特殊认证流程。没有读取宿主机环境中的模型密钥。内置目录可能落后于服务商实时发布；目录外可暂用自定义 Chat Completions。

配置文件兼容旧单提供商格式，新增 provider 与 profiles 字典，各提供商密钥分开保存。模型请求捕获配置快照，运行中修改设置不会改变该轮请求。修改端点不会沿用该提供商旧端点密钥。模型接口的原生 assistant 元数据保存在服务端会话中，用于工具关联、推理签名等回放；不返回浏览器。跨提供商适配由 pi-ai 处理，切换模型重置推理等级。

设置采用已配置提供商卡片与第三方/自定义分区；聊天输入框左侧添加附件、右侧模型与推理选择浮层，目录支持搜索。只读问答在工具定义与执行层都禁止创建修改提案。推理等级由内置目录过滤；自定义接口仅在手工启用 reasoning_effort 时显示协议候选值，不保证每种模型都支持。

模型调用目前将 SDK 流收集为完整回复后显示，尚未向浏览器逐字流式推送。

验证：`scripts/test-assistant-providers.ts` 使用模拟 SSE 验证 DeepSeek、Anthropic、MiniMax 中国区原生协议的工具调用和回放；`scripts/test-assistant.ts` 验证提供商配置隔离及原有工具权限。测试不使用真实密钥、不接触硬件。

运行环境现要求 Node.js >= 22.19.0，部署前运行 npm install。

## 附件和统一助手

界面不再区分只读问答与配置助手，统一查询/分析和提出修改；修改仍须人工确认。后端保留 read 参数供已有客户端兼容。加号用于添加附件，新对话移到标题栏。

每条消息最多 4 个附件，总计 6 MB；PNG/JPEG/WebP 图片每个 2 MB，UTF-8 文本/CSV/JSON/日志/代码每个 20 KB。暂不支持 PDF、Office、压缩包。服务端校验编码、类型与大小，图片检查内置模型视觉能力；自定义接口需要所选模型支持图像。文本作为带文件名的数据上下文传入，图片使用原生图像内容块。附件不写磁盘，不作为指令执行，随内存会话结束释放；历史界面只回传文件名和大小。整个会话对图像编码累计设 8 MB 上限，对文本继续执行上下文限制。

附件只在发送时随消息上传到本地后端并交给所选模型服务；选择文件本身不发送。发送请求被拒绝时保留待发附件；后端接收消息后清除待发列表，后续模型执行失败仍可在同一会话继续询问。

## /compact 命令

移除新对话入口，输入框输入 `/` 显示命令菜单，选择 `/compact` 后发送。参考 DSH command-compact 与 compaction-basic 的按需摘要语义，适配当前会话 API；并非直接加载 DSH 插件。使用当前提供商与模型，无工具调用，最多等待 120 秒；停止/失败不改上下文。保留系统约束和最近完整用户轮次，较早消息变成摘要，界面记录保留。摘要作为用户级参考数据，不能提高指令权限。较早图片不发给摘要器，只保留历史文字结论，菜单说明额外模型请求费用；减少比例基于请求数据字符数，不是假称精确 token 数。没有足够历史、正在生成或有待确认提案时拒绝压缩。暂不做自动压缩。
