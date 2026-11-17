# API3 执行记录（逐项本地提交）

## A 开场上下文

已实现 `GET /api/agent-memory/v1/context`，`memory.read`，项目规则沿用 recall。平台部分调用 `forDispatch(..., peek:true)`；默认结果与交付记账不变，peek 不读取或写入会话交付状态。原生部分把 HTTP 身份认证后的处理提为同一个 dispatch，固定读取 profile/preferences/entities，保留撤回、敏感文件、其他项目与来源版本栅栏，agent-api origin 不计 recall/use 或内核来源收据。

返回每层文本／省略原因、平台完整原文、预算省略数；原生文本是内核网关返回的开场输入，listings 为两份结果数组的 JSON，不冒充上游插件的展示标签。profile 被网关预算截断时有 elided 标记。暂停／试用只返回省略层，共享命名空间拒绝，普通只暂停学习不影响回忆。额外 mostUsed 层避免把使用排序内容误称胶囊。

A 已运行：residentProfile 24、memoryGateway 123、agentMemoryContext 3、agentMemoryApi 22、agentMemoryForget 9 全通过，均单文件串行；新 peek、gateway opening、公共 context 测试先失败。agentMemoryContext.integration 1 项因未配置 PostgreSQL 跳过；改动源文件 ESLint 通过。其余项与最终文件行号／实验机清单在后续提交补全。

## B 直接记住

已实现 `/remember`，新增独立 `memory.remember`，不扩张 memory.write。原话和外部 source 调用网页的 NativeMemoryStore.remember；外部请求在现有 native_admissions 增加 external_source JSON 字段，使用既有 lease、phase 和原生 worker 恢复，不新建表或文档种类。owner/client/session/message（无 message 则原话 hash）幂等，冲突返回 409；不确定的消息发送先检查引擎状态，不能证明未发送就不重发。命名项目保持网页同样的项目引言。

原生 page commit 真实记录本人的单条陈述，网页来源显示外部助手和原始日期，账户导出携带来源，既有记录 undo/forget 仍可使用。前置和重试复用 memoryAdmission，拒绝暂停、试用、自动轮、临床上下文、引擎未就绪和 reset 之前的陈述；撤回检查复用 removalRefusals，平台标签和标识符复用 captured-message 规则。worker 仍执行页面原有的 pasted-instruction / forget-request / verification；没有伪造一段外部对话历史。

B 已运行：agentMemoryRemember 3、agentMemoryRememberStore 3、accountExport 17、agentMemoryApi 22、agentMemoryForget 9、nativeMemoryForgetTool 34、agentMemoryMcp 3、DSH plugin 18、Python 19，通过；新增公共／store／导出／客户端契约测试先失败。新增 remember PostgreSQL 集成 2 项跳过（无数据库）。agentMemoryNative.integration 有 7 个非数据库断言通过、6 个跳过，但整个文件因缺少 @evimed/patient-matching-core 的异步导入失败，不能算文件通过。服务端修改 ESLint 通过；前端两文件 lint 缺 @typescript-eslint/eslint-plugin，测试只写好未执行，未安装依赖。

## E 会话导入：保持关闭

能力表现在明确 `conversationIngest.available=false`、`requiredScopes:[memory.ingest]`、`internalOnly:true`、`reason:external_conversation_history_authority_unavailable`。该 scope 尚不可签发，面板不提供空有权限但无功能的选项；OpenAPI 用 x-unavailable-operations 记录保留路由，没有宣称已服务的 path。

确切缺口：`apps/server/src/memoryHistory.mjs:461` 只索引 platformSessionOf 可解析的内核会话，`:467` 再要求原生 session 与权威来源一致；`memoryHistorySources.mjs:30–37` 验证原生命名、项目绑定和真实 conversationRuns。不是“把角色、内容传给引擎”就可以自动得到后续 recall / 源删除可达的历史。需要把外部会话身份、批次幂等/恢复、人为/临床准入和源删除一起接入现有权威，本轮没有完成这一组合；不能把 B 的单条直接陈述当 E 的完整会话。现有历史拒绝外部 engine session 的刻画测试及已绑定内核会话仍可解析的正向断言通过；能力关闭原因测试先失败，修复后共 2 项通过。
