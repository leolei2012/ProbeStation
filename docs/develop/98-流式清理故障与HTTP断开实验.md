# 流式清理故障与HTTP断开实验

## 决策与现状

基线`74c851b6515c55ec484860104b0bebea8756c097`，开始时工作区干净。无AGENTS.md或仓库.agents/skills，本会话协作清单仅root，未验证其他独立编辑器。本轮仅修改scripts中的实验、增加模拟断开夹具/故障检查及类型入口和文档，生产Sink/API/存储/前端及依赖清单不变。

结论是继续保留流式候选，不接入生产：未找到WorkbookWriter可公开、稳定地取消全部内部生成并等待清理完成的接口。只销毁自有输出Writable不能替代该能力；Archiver.abort本身也不承诺排空全部输入。改进候选的错误处理有价值，但不能因此声称所有资源已回收。

本机既有ExcelJS 4.4.0的README流式writer章节、index.d.ts的WorkbookWriter声明和lib/stream/xlsx/workbook-writer.js均以commit为完成入口，无公开abort/destroy。可由调用方公开持有的是options.stream；内部Archiver通过writer.zip访问，仍是未公开依赖。archiver 5.3.2的lib/core.js明确abort为best-effort：允许活动worker完成，不排空剩余来源。这是本地已安装代码的审查，未安装或切换依赖。

## 已复现缺陷与最小修复

旧候选stop顺序为zip.abort后stream.destroy，finally随后释放块并通知观察回调。注入abort抛错时，原始行错误被清理错误替换，输出流尚未destroy，观察回调也未执行；原始探测记录primaryPreserved=false、cleanupReplacedPrimary=true、destroyedAtRejection=false、cleanupObserverCalled=false。新增故障回归修复前退出1，未得到包含原始错误和清理错误的AggregateError。

候选现改为：stop只尝试一次，zip.abort和输出destroy分别尽力执行；先保留原始错误，清理步骤和清理观察回调抛错作为独立错误收集，最终AggregateError保留原错及cause。不把清理失败当作成功，不重试库内部操作，也不改变成功文件生成、列/原始行限制或生产接口。

同时让abort和finally共用幂等stop，避免重复执行私有abort。原始错误使用显式failed状态保存，避免把0等假值原因误作没有错误。内部块引用在清理步骤失败后仍释放，观察回调仍可报告状态。若输出destroy本身也被注入失败，状态明确仍未destroy；测试最终只为释放自有夹具而恢复并手动关闭，不能声称该故障情形已自动回收。

## 隔离证据

新增test-streaming-cleanup，固定10个场景，各自独立子进程，不使用主入口、真实HTTP监听、数据库或设备：

| 场景 | 观察/断言 | 能证明及边界 |
|---|---|---|
| 私有清理故障 | abort抛错时仍销毁输出；再注入destroy抛错时AggregateError包含原始行错和两种清理错；无返回文件 | 错误不会被覆盖，后续清理仍尝试。双故障下无法保证已销毁，测试显式恢复自有故障夹具 |
| 重复abort | signal取消及finally合计只调用私有abort一次 | 本候选stop幂等，不证明私有方法内部所有操作成功 |
| 公开destroy，提交前 | 输出已destroy，75ms观察后commit仍pending，archive未destroy | 输出close不能当writer完成/取消确认；pending是有界观察，不宣称永久挂起 |
| 公开destroy，提交中带错误 | 输出destroy，commit拒绝，archive仍未destroy | 某时序可让等待拒绝，但仍不能证明上游资源全部回收 |
| Archiver不排空来源 | 注入不结束的内存Readable，abort返回后20ms来源既未destroy也未end | 符合best-effort契约；观测后审计夹具主动销毁来源/归档/目标，未把私有补清理包装成公开方案 |
| HTTP事件模型 | 完整请求close不取消，正常响应finish后close不取消；不完整请求close、未finish响应close、已断开响应取消；仅移除自己3个监听器 | 5种公开事件/状态组合符合夹具规则；未验证真实Node/Fastify/proxy/TLS事件顺序 |
| HTTP读取等待中断开 | signal已取消，但10ms后调用仍等待；释放模拟读取才拒绝，不返回文件 | 断开绑定不等于数据库查询可取消，现有collect等待仍不能中断 |
| HTTP行生成中断开 | 1000行样本在第128行让出后响应close，候选拒绝、输出destroy、无返回文件且监听器移除 | 仅在候选显式接signal时生效，collect同步部分仍不可抢占 |
| 完整Buffer生成后断开 | 内部已生成完整文件，外层交付前再次检查signal/响应状态，不交付并清理监听器 | 需要独立交付检查；不是任意真实网络竞争的线性化保证，也不保证客户端收盘 |
| 自有进程回收边界 | 仅自建内存worker在commit前通过IPC报ready，父进程使用公开child.kill终止并等待close，未收到文件 | 展示无需访问私有zip的粗粒度隔离边界。没有终止任何在用服务、系统枚举目标或其他进程 |

公开destroy和Archiver来源实验的收尾仍使用仅审计可见的引用，以免测试本身留下自有资源。这不改变其公开方案不足的结论。自有worker场景故意终止，不计为自然退出0；其余场景等待自然close。没有用强制exit伪造候选库清理完成。

## HTTP模型与生产差距

新增history-disconnect-candidate仅以EventEmitter和complete/destroyed/writableFinished模拟公开边界：完整请求的close可能只是请求体读取完成，不应一概取消；响应未finish即close才取消，finish时解绑。已断开状态在订阅后立即检查，dispose幂等且保留已有监听器。它没有安装到真实API或路由钩子。

生成后的完整Buffer与交付是不同阶段。模拟在生成后响应断开，完整文件仍可能已经在内存，但外层检查阻止交付；这不解决检查后真实传输再失败，也不代表HTTP finish证明客户端已保存。现有共享生产路由依然未接该signal，不能把本实验算作生产HTTP取消已支持。

优先考虑公开接口的结果：自有Writable.destroy/finished可确认目标状态，无法覆盖ExcelJS私有生成器；Node自有子进程终止/close可形成更强的工作任务边界，但不是当前接口的直接替换。若后续采用，需要只给工作任务传递明确的只读合成/采样快照，评估复制内存、任务协议、截止期限、结果完整性及父进程生命周期。本轮不实现生产worker管理，不把真实主服务/数据库或设备生命周期放入可终止实验。

## 本次验证与复用

在既有隔离源码副本、已有依赖下运行：

```powershell
node --max-old-space-size=384 --import tsx scripts/test-streaming-cleanup.ts --synthetic
node --max-old-space-size=384 --import tsx scripts/test-history-streaming-candidate.ts --synthetic
npm run typecheck:services
```

最终10场景在UTC 2026-11-08 07:22:47至07:23:17完成，父检查退出0；9个非终止场景自然退出0，自有worker场景kill被接受，close为code=null、signal=SIGTERM，未收到文件。原8组CRC/格式/失败/取消回归在07:20:51至07:20:59自然退出0；npm run typecheck:services在07:22:47至07:23:01退出0。初次类型检查指出IPC子进程stdout/stderr可能为null，现用运行时断言确认请求的管道；没有非空强转掩盖失败。用明确close(code, signal)记录自有worker退出，不把signal终止误记成功自然退出。

最终候选第17版598个源文件。类型检查及回归后的实验源码保持不变，只补录文档；提交前后核对候选完整源文件blob对应提交、原工作区在用dist六文件SHA256不变。只暂存本轮7个明确文件，保留既有全部工作。

证据在`.npm-cache/rv-ready-lLgroB/evidence`：streaming-cleanup-probe-before.log、streaming-cleanup-before.log及.json、streaming-cleanup-check.log及.json、streaming-cleanup-baseline.log及.json、streaming-cleanup-typecheck.log及.json。它们是本机审计记录，不随提交发布。源码仍为旁边src；完整检查/内存矩阵本轮未重跑，常规112组数量不变，上一轮内存表只代表当时提交，不作本轮新测量。

仍未覆盖：真实HTTP/TCP断开、真实应用装配/长运行并发、所有zip/流错误时序、库升级、原生内存释放量和任意外部队列的排空；writer构造还位于候选try之外，构造器部分分配后抛错也没有本轮安全保证。没有真实Excel视觉、数据库迁移或设备验收。未新增依赖、付费服务、权限、外部模型调用、推送、部署或重启采集；在用dist和真实数据不变。建议保持实验边界，下一步先决定采用受支持的可取消生成器，还是独立只读工作任务隔离，再做架构和兼容评估，而非继续给生产增加私有清理调用。
