# 日志NULL字段兼容

2026-11-07，基线`35e27112482bfbef833e9b04d95eea95de2b5a25`，初始工作区干净。根AGENTS.md/.agents仍不存在；本轮复查运行日志工作流时发现上一轮客户端的兼容回归，优先修复，不扩展清理操作。未读取真实日志/配置/历史库、访问运行实例、启动主应用/监听端口、连接设备/串口、调用模型、安装依赖、部署/重启/推送。

## 现有契约与失败复现

ConfigStore.LogRecord原本就声明source/message为string|null；现有logs schema对level/source/message没有NOT NULL，ts为NOT NULL，listLogs直接返回SQL字段而不coalesce。上一轮新parseRuntimeLogs要求四个文本字段全为字符串，一条合法NULL记录就拒绝整个快照。这是新增解析器遗漏，不是用户配置或数据库损坏。

先用真实ConfigStore `:memory:`原schema参数化插入WARN、NULL source、NULL message；listLogs确实返回NULL，随后parseRuntimeLogs抛InvalidRuntimeLogs，新增回归先失败。修复后同一测试通过，未修改schema或替用户清洗数据。

## 最小修复

客户端level/source/message接受string或null并原样复制/冻结，JSON往返保留NULL、空串及字面null。ts仍要求字符串，字段缺失/undefined、数字、布尔、数组、对象继续拒绝，ID倒序/重复和200条边界均保持。

显示NULL为“未记录级别/来源/消息”，空串为“空级别/来源/消息”，正常文字保持原样。未记录级别有独立筛选标识，不能与空级别或字面missing/all/null碰撞；原null表示全部级别的本地过滤调用保持兼容。筛选只在本地，不发给后端；未记录标识是本组件内部Symbol，不作为网络协议或持久值。

关键词组合缺失字段时用空串参与检索，不合成字符串null，避免搜索null时把所有缺失字段当命中；真实字符串null仍匹配。该策略不改变数据，也不按显示占位文字生成原始日志内容。

ConfigStore.LogRecord.level的TS声明同步为string|null，以匹配已有可空DDL；cfg.log入参仍要求字符串，普通日志生成、原始GET/listLogs/清空/保留逻辑均不变。不新增列/迁移或数据回填。

## 验证

新增test-runtime-log-null确认原schema可空标志，真实内存插入54种level/source/message NULL/空串/字面值组合，连同原复现记录完整读取并JSON往返，读取不写/清理。验证未记录/全部/空级别和字面all/missing/null各自匹配，NULL不产生假字符串命中；异常字段仍整份拒绝、保留上次合法快照。

中英文正式查看器SSR核对NULL/空串占位、字面null原文、各option值无碰撞。原test-runtime-logs回归同步把原错误的“NULL来源非法”断言修正为真正非法的数字来源；200条上限、旧时间、转义、超时/恢复等原用例继续执行。所有数据库均`:memory:`，没有真实日志/网络/模型/浏览器/硬件。

本轮完整`npm run check`退出0：web/services类型检查、Vite正式构建、包边界检查及81组安全测试全部通过。启动JS 473603字节（gzip 155753），延迟Markdown 158850字节（gzip 48437）；仅构建大小，不是浏览器延迟实测。扩展后的静态mock构建成功并核对禁止联网标记。提交前核对已知13个文件、原HEAD、无其他暂存、diff/空白及新增内容秘密模式，并核验提交与审查文件内容一致。

原`npm run preview:logs`增加“NULL、空串和字面null”纯合成场景。选择后重新读取，核对未记录/空/字面值显示与筛选，并验证null关键词不命中缺失值。静态页仍CSP禁止联网、无清理动作；未进行浏览器点击或实际后端数据验收，不重试受限入口。

## 剩余范围

仍是最近200条只读快照，无归档/来源身份认证或内容脱敏；原日志查看器的其余限制保持。清理确认、并发保护及结果不明恢复尚未实现，本轮没有更改清空端点或增加删除调用。未执行部署/重启，未确认运行页面是否已使用本地构建产物。
