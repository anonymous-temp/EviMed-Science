# API3 交付报告

本轮完成 A（开场上下文）和 B（本人明确记忆），沿用现有服务、权限和 worker；E（会话导入）与 F（工作信号）未完成，按任务允许保留 `available:false` 及明确原因。没有部署、SSH、fetch/reset/push、读取密钥目录或安装依赖。分支仍为 `cc/capsule-api-full-1117`，每项均已本地提交，数据库和前端验证不冒充已通过。

## 八项能力总表

| 原始项 | API 当前可用？ | 调用方式与边界 |
|---|---|---|
| 1 原始对话召回 | 是，沿用 API1 | `/recall` + `include:["history"]`，同时持有 `memory.read` 和 `memory.history.read`；来源审查、撤回、删除和项目栅栏不变。 |
| 2 开场上下文 A | 是，本轮新增 | `GET /context`，`memory.read`，会话开始时调用一次；同一个 resident producer 和网关处理器。 |
| 3 本人明确记忆 B | 是，本轮新增 | `POST /remember`，独立 `memory.remember`；原话与外部来源，`storage:directly_stated`，不是 `/note` 的待确认候选。 |
| 4 语句遗忘／遗忘列表 | 是，沿用 API2 | `/forget`、`/forgotten`、原有 record restore/undo；语句遗忘需 account-scoped manage，受功能开关控制。 |
| 5 外部会话导入 E | 否 | `external_conversation_history_authority_unavailable`；`memory.ingest` 仅为保留能力声明，不可签发，无路由。`/episodes` 不变。 |
| 6 工作信号 F | 否 | `external_run_evidence_unproven`；`learning.signal` 仅为保留能力声明，不可签发，无路由；不接受模型自报成果被使用。 |
| 7 分享／仅选定胶囊召回 | 否，既有边界 | 分享和 trial 仍在网页；现有 `capsuleIds` 是叠加语义，不能宣称只读取收到的胶囊。本轮未扩张。 |
| 8 客户端 | 是，已扩展 | DSH 与 MCP 先读状态；提供 context（开场一次）与 remember。没有可伪报人为动作的 ingest/work-events 工具，也没有缺少宿主事件来源的 hook。 |

能力受账户资格、key scope、功能开关与服务配置共同约束；“可用”不表示绕过暂停／试用／撤回等逐请求检查。对外默认仍关闭：`OPEN_SCIENCE_AGENT_MEMORY_API_ENABLED=false`。内部账号可通过 `OPEN_SCIENCE_AGENT_MEMORY_API_INTERNAL_USERS=<account-id>` 明确列入，或 `OPEN_SCIENCE_AGENT_MEMORY_API_INTERNAL_ENABLED=true` 允许现有 `OPEN_SCIENCE_OPERATOR_USERS`；本轮没有修改任何运行环境。后续按发布流程应用配置后，账号 `/api/me.features.agentMemoryApi` 打开面板，创建最小 scope 的 key，再读 `GET /api/agent-memory/v1` 能力表。B 的新权限默认不勾选，旧 `memory.write` 不获直接记忆权限。

## 新操作示例（占位 key，不执行）

开场读取（`memory.read`）：

```sh
curl -H 'Authorization: Bearer <KEY>' \
  'https://example.invalid/api/agent-memory/v1/context?projectId=default'
```

明确记忆（`memory.remember`）：

```sh
curl -X POST -H 'Authorization: Bearer <KEY>' -H 'Content-Type: application/json' \
  -d '{"statement":"Use metric units.","source":{"client":"Editor","sessionId":"external-1","messageId":"message-1","saidAt":"2026-11-17T07:00:00Z"},"projectId":"default"}' \
  'https://example.invalid/api/agent-memory/v1/remember'
```

同一 owner/client/sessionId/messageId 重试复用同一提交；无 messageId 时以原话 hash 代替。相同 key 对应的来源内容或项目改变返回冲突。响应含真实 pending/uncertain/completed 等状态；不确定时不能声称已保存，不自动重发不能证明未发送的消息。后续通过既有 `/records/{id}/undo`、`forget` 操作管理已形成的记录。E/F 没有新可调用操作，OpenAPI 的 `x-unavailable-operations` 仅记载保留路径，不给出伪装成已服务的 curl。

## A 开场上下文

已实现 `GET /api/agent-memory/v1/context`，`memory.read`，项目规则沿用 recall。平台部分调用 `forDispatch(..., peek:true)`；默认结果与交付记账不变，peek 不读取或写入会话交付状态。原生部分把 HTTP 身份认证后的处理提为同一个 dispatch，固定读取 profile/preferences/entities，保留撤回、敏感文件、其他项目与来源版本栅栏，agent-api origin 不计 recall/use 或内核来源收据。

返回每层文本／省略原因、平台完整原文、预算省略数；原生文本是内核网关返回的开场输入，listings 为两份结果数组的 JSON，不冒充上游插件的展示标签。profile 被网关预算截断时有 elided 标记。暂停／试用只返回省略层，共享命名空间拒绝，普通只暂停学习不影响回忆。额外 mostUsed 层避免把使用排序内容误称胶囊。

A 已运行：residentProfile 24、memoryGateway 123、agentMemoryContext 3、agentMemoryApi 22、agentMemoryForget 9 全通过，均单文件串行；新 peek、gateway opening、公共 context 测试先失败。agentMemoryContext.integration 1 项因未配置 PostgreSQL 跳过；改动源文件 ESLint 通过。最终文件行号／实验机清单见下文。

## B 直接记住

已实现 `/remember`，新增独立 `memory.remember`，不扩张 memory.write。原话和外部 source 调用网页的 NativeMemoryStore.remember；外部请求在现有 native_admissions 增加 external_source JSON 字段，使用既有 lease、phase 和原生 worker 恢复，不新建表或文档种类。owner/client/session/message（无 message 则原话 hash）幂等，冲突返回 409；不确定的消息发送先检查引擎状态，不能证明未发送就不重发。命名项目保持网页同样的项目引言。

原生 page commit 真实记录本人的单条陈述，网页来源显示外部助手和原始日期，账户导出携带来源，既有记录 undo/forget 仍可使用。前置和重试复用 memoryAdmission，拒绝暂停、试用、自动轮、临床上下文、引擎未就绪和 reset 之前的陈述；撤回检查复用 removalRefusals，平台标签和标识符复用 captured-message 规则。worker 仍执行页面原有的 pasted-instruction / forget-request / verification；没有伪造一段外部对话历史。

B 已运行：agentMemoryRemember 3、agentMemoryRememberStore 4、accountExport 17、agentMemoryApi 22、agentMemoryForget 9、nativeMemoryForgetTool 34、agentMemoryMcp 3、DSH plugin 18、Python 19，通过；新增公共／store／导出／客户端契约测试先失败。新增 remember PostgreSQL 集成 2 项跳过（无数据库）。agentMemoryNative.integration 有 7 个非数据库断言通过、6 个跳过，但整个文件因缺少 @evimed/patient-matching-core 的异步导入失败，不能算文件通过。服务端修改 ESLint 通过；前端两文件 lint 缺 @typescript-eslint/eslint-plugin，测试只写好未执行，未安装依赖。

## E 会话导入：保持关闭

能力表现在明确 `conversationIngest.available=false`、`requiredScopes:[memory.ingest]`、`internalOnly:true`、`reason:external_conversation_history_authority_unavailable`。该 scope 尚不可签发，面板不提供空有权限但无功能的选项；OpenAPI 用 x-unavailable-operations 记录保留路由，没有宣称已服务的 path。

确切缺口：`apps/server/src/memoryHistory.mjs:461` 只索引 platformSessionOf 可解析的内核会话，`:467` 再要求原生 session 与权威来源一致；`memoryHistorySources.mjs:30–37` 验证原生命名、项目绑定和真实 conversationRuns。不是“把角色、内容传给引擎”就可以自动得到后续 recall / 源删除可达的历史。需要把外部会话身份、批次幂等/恢复、人为/临床准入和源删除一起接入现有权威，本轮没有完成这一组合；不能把 B 的单条直接陈述当 E 的完整会话。现有历史拒绝外部 engine session 的刻画测试及已绑定内核会话仍可解析的正向断言通过；能力关闭原因测试先失败，修复后共 2 项通过。

## F 工作信号：保持关闭

能力表 `workSignals.available=false`、`requiredScopes:[learning.signal]`、`internalOnly:true`、`reason:external_run_evidence_unproven`；OpenAPI 同样记录关闭原因，不发布不存在的 /work-events。保留 scope 不可签发，也没有给模型一个可自报“成果被使用”的工具。

确切障碍：`learningEvidence.mjs:642–655` 的 noteFileUse 从本人的 canonical run ledger 找已完成且确实交付该路径的 run；`:574–586` 的后续消息寻找同一真实会话的前一运行；`learningTriggers.mjs:251–253` 读 run 的完整 transcript 收据。`AgentRunStore.createRun`（agentRuns.mjs:5434）创建的是内核运行，不是外部成果证明。即使写一个 external=true 的最小 run（finishedAt、文件 digest、method 名称齐全），仍被 transcript_incomplete 拒绝；本轮新增刻画测试证明这一点，并证明有真实完整收据的既有路径不被新限制。任务的 F 请求体没有完整工作轨迹，不能伪填 completeness=complete。完整接入需要真实宿主事件与可验证 transcript / 文件清单，不能并列存储另一套学习状态或降低门槛。新增能力原因测试先失败，修复后 host boundaries 共 4 项通过。

## 复核补丁与测试结论

复核补丁保留准入时的 projectCreatedAt 到正常提交及超时恢复发现的 commit，后者也保留 pendingText；先出现断言失败，再修复通过。开场服务装配对后定义的 sourceDeletion 改为延后读取；从真实源表达式构造的离线 VM 诊断先复现 TDZ、再通过，但这不替代完整 serverComposition。追加 before_reset、learning-only pause 和缺少 messageId 的 hash 幂等正反断言通过。

本机遵守单文件串行检查。新增功能先写失败测试；后续边界补充用例不需要引入新生产行为。

| 本轮实际执行 | 结果 |
|---|---|
| `residentProfile.test.mjs` | 24 通过 |
| `memoryGateway.test.mjs` | 123 通过；既有 HTTP 处理器与 opening 的同源输出、隐私／项目／撤回过滤与无使用记账 |
| `agentMemoryContext.test.mjs` | 3 通过；固定 resident 文本、原生层、scope/项目/shared/audience/pause/trial |
| `agentMemoryRemember.test.mjs` | 3 通过；包含多个拒绝／安全恢复子情形与 before_reset |
| `agentMemoryRememberStore.test.mjs` | 最终 4 通过；幂等、冲突、撤回、注入、暂停恢复、不确定 append、项目版本 |
| `agentMemoryHostBoundaries.test.mjs` | 4 通过；E/F 关闭原因和既有权威拒绝／允许对照 |
| `agentMemoryApi.test.mjs`、`agentMemoryForget.test.mjs` | 22、9 通过 |
| `nativeMemoryForgetTool.test.mjs`、`accountExport.test.mjs` | 34、17 通过 |
| `agentMemoryMcp.test.mjs`、`agentMemoryAvailability.test.mjs`、`agentMemoryHistory.test.mjs`、`agentApiKeys.test.mjs` | 3、8、5、3 通过 |
| `packages/dsh-memory-capsule/test/plugin.test.mjs` | 单文件，localhostProbeGuard 下 18 通过 |
| `runtime/mcp/evimed-memory/test/test_server.py` | unittest 单文件，19 通过 |
| 新 `agentMemoryContext.integration.test.mjs`、新 `agentMemoryRemember.integration.test.mjs` | 1、2 项全部跳过，未配置 `OPEN_SCIENCE_TEST_POSTGRES_URL` |
| `agentApiKeys.integration.test.mjs` | 5 项全部跳过，无 PostgreSQL |
| `agentMemoryNative.integration.test.mjs` | **整文件失败**：7 断言通过、6 跳过后异步导入缺 `@evimed/patient-matching-core`，不得算通过 |
| `config.test.mjs`、`serverComposition.test.mjs` | **加载失败**：缺 `@evimed/patient-matching-core`，没有伪造 stub 或安装依赖 |
| 修改服务端源／测试 ESLint | 通过；最后两个生产复核补丁单独 lint 通过 |
| 前端两文件 ESLint | 无法加载 `@typescript-eslint/eslint-plugin`；不算通过 |
| 前端 FactDrawer / AgentKeysSection 新用例 | 已写，按本机限制未执行 vitest；见实验机清单 |
| `pnpm -s check:pin-inventory` | 通过，所有出现的版本均已分类 |

不运行完整 tsc、pnpm test、vitest 套件或安装；未执行真实 PostgreSQL、真实引擎／宿主会话的端到端验证。上线前必须补齐这些检查，尤其 native_admissions 迁移、外部来源 lineage 和 native worker instruction/forget/verification 链。

## 变更位置

以下路径均相对 `OpenScience/`，行号为本轮最终树；测试文件首行代表整份新增测试。

| 文件:行 | 变更 |
|---|---|
| `apps/server/src/agentMemoryContext.mjs:6` | 两个现有 producer 的只读组合、层标识／省略原因、末端准入与 source version 检查 |
| `apps/server/src/residentProfile.mjs:287` | peek 默认关闭；`:340` 返回已渲染层，`:347` 禁止交付记账 |
| `apps/server/src/memoryGateway.mjs:426` | agent-api 不计 recall/use；`:938` 仅内部 elision 元数据；`:1278` 同一 dispatch；`:1432` 固定 startup reads |
| `apps/server/src/agentMemoryRemember.mjs:4` | 来源校验与复用准入（`:17`）；原话保留、来源字段有界 |
| `apps/server/src/agentApiKeys.mjs:58` | 独立 memory.remember scope，默认集合不扩张 |
| `apps/server/src/agentMemoryRoutes.mjs:257` | remember 路由，`:274` context，`:581` 逐 key 能力表及 E/F 关闭原因；scope / rate limit 沿用同一入口 |
| `apps/server/src/agentMemoryOpenApi.mjs:76` | 未服务 host operations 显式元数据；`:101` remember schema；`:350` 新真实路径 |
| `apps/server/src/nativeMemoryPersistence.mjs:101` | 既有 native_admissions 添加 external_source JSON 字段；没有新表／document kind |
| `apps/server/src/nativeMemoryOverlay.mjs:230` | 幂等 admission 持久化／冲突；`:286` authority；`:325` 原始 external 来源和 replay lineage |
| `apps/server/src/nativeMemoryStore.mjs:245` | external source 类型；`:628` 外部来源标注；`:2256` 既有 admission worker 支持 external；`:2381` 网页同一 remember 入口；`:2459` submit 的来源分支 |
| `apps/server/src/server.mjs:3600` | context producer 装配（删除栅栏延后解析）；`:5241` durable retry 准入回调及项目版本核对 |
| `apps/server/src/accountExport.mjs:90` | 已导出 admission 同时导出来源；沿用 account cascade 删除，不新增孤立表 |
| `packages/domain/src/errorCodes.mjs:3771` | 对现有 memory_scope_denied 放行有限枚举 reason，不暴露任意 error details |
| `apps/web/src/components/settings/AgentKeysSection.tsx:16` | 新 scope 标签，面板仍只由 features 绘制 |
| `apps/web/src/components/memory/FactDrawer.tsx:330` | 外部助手、原始时间；不虚构 conversation 链接 |
| `apps/web/src/lib/apiClient.ts:632` | externalSource 类型；`:2743` key scope 类型 |
| `packages/dsh-memory-capsule/index.mjs:100` | context 只发 projectId；`:147` 新真实权限和 statement schema 描述 |
| `packages/dsh-memory-capsule/README.md:72` | 状态优先的 context / remember 操作与边界 |
| `runtime/mcp/evimed-memory/server.py:127` | context、remember 工具契约；`:256` 只转发允许字段 |
| `docs/AGENT_MEMORY_API.md:153` | 八项能力、`:164` context、`:222` remember、`:460` E、`:479` F，示例与内部访问保持清楚 |
| `PROGRESS.md:1` | 本轮一行记录 |
| `apps/server/test/agentMemoryContext.test.mjs:1`、`agentMemoryContext.integration.test.mjs:1` | 新开场单元／数据库回归 |
| `apps/server/test/agentMemoryRemember.test.mjs:1`、`agentMemoryRememberStore.test.mjs:1`、`agentMemoryRemember.integration.test.mjs:1` | 新路由／真实 store／数据库 worker 回归 |
| `apps/server/test/agentMemoryHostBoundaries.test.mjs:1` | E/F 现有权威契约刻画 |
| `apps/server/test/residentProfile.test.mjs:450`、`memoryGateway.test.mjs:1683`、`:1704` | peek 不改变默认行为；网关同源文本和公共隐私边界 |
| `apps/server/test/accountExport.test.mjs:710`、`agentMemoryApi.test.mjs:327`、`agentMemoryForget.test.mjs:100` | 来源导出与新增路径／权限契约；旧“永久关闭 A/B”的断言按任务调整，未放宽其他拒绝 |
| `apps/web/src/components/memory/FactDrawer.native.test.tsx:42`、`apps/web/src/components/settings/AgentKeysSection.test.tsx:14` | 来源标签、scope 提供与默认不勾选 |
| `packages/dsh-memory-capsule/test/plugin.test.mjs:199`、`runtime/mcp/evimed-memory/test/test_server.py:232` | 已提供能力才调用；保留原话／来源，丢弃 attended/used 等非契约字段 |

## 实验机补跑

新增 PostgreSQL 测试要求本地独立 `evimed_test` 数据库；并发相同 remember 只产生一项 admission/commit，worker 完成、来源标签、遗忘后拒绝重入、安全邻项保留、页面 configured instruction check 都在该测试中。迁移必须由既有 `migrateNativeMemory` 路径运行，不手工改生产库。

下面列出本工作树实际存在的相邻文件（`apps/server/test/`）。实验机依赖完整后按单文件执行 `node --test test/<filename>`；本机只执行了上表列明的文件，不把这份待跑清单算入通过数：

```text
accountExport.integration.test.mjs
accountExport.test.mjs
accountExportKinds.test.mjs
accountExportNative.test.mjs
accountExportSharers.test.mjs
agentApiKeys.integration.test.mjs
agentApiKeys.test.mjs
agentMemoryApi.test.mjs
agentMemoryAvailability.test.mjs
agentMemoryBoard.integration.test.mjs
agentMemoryBoard.test.mjs
agentMemoryContext.integration.test.mjs
agentMemoryContext.test.mjs
agentMemoryForget.integration.test.mjs
agentMemoryForget.test.mjs
agentMemoryHistory.test.mjs
agentMemoryHostBoundaries.test.mjs
agentMemoryMcp.test.mjs
agentMemoryNative.integration.test.mjs
agentMemoryNative.test.mjs
agentMemoryObservations.integration.test.mjs
agentMemoryObservations.test.mjs
agentMemoryRecall.integration.test.mjs
agentMemoryRemember.integration.test.mjs
agentMemoryRemember.test.mjs
agentMemoryRememberStore.test.mjs
config.test.mjs
learningEvidence.integration.test.mjs
learningEvidence.test.mjs
learningEvidenceWiring.integration.test.mjs
learningTriggers.test.mjs
memoryGateway.test.mjs
memoryGatewayContext.integration.test.mjs
memoryGatewayNextRound.test.mjs
memoryHistory.integration.test.mjs
memoryHistory.test.mjs
memoryHistoryRetrieval.test.mjs
memoryHistorySecrets.test.mjs
memoryHistorySources.integration.test.mjs
nativeMemoryStoreScopes.integration.test.mjs
nativeMemoryWorkerScopes.integration.test.mjs
nativeTurnCommit.integration.test.mjs
nativeTurnCommit.test.mjs
nativeTurnCommitWiring.test.mjs
residentProfile.integration.test.mjs
residentProfile.test.mjs
serverComposition.test.mjs
```

另跑 `nativeMemoryForgetTool.test.mjs` 与原生记忆其余恢复／撤回邻居；web 定向 `FactDrawer.native.test.tsx`、`AgentKeysSection.test.tsx` 及 retiredWords/copyRules/layoutRules，完整 web/server typecheck 与 lint 在实验机进行。DSH 包保持 localhostProbeGuard，Python 保持单文件 unittest。E/F 将来接入需要真实外部 source authority / transcript + delivered inventory，不能仅让本轮“关闭”刻画测试变绿而宣称已完成。

## 本地提交

- `de4cdfeb4`：A 开场上下文。
- `449aaaaba`：B 本人原话与来源、独立权限、客户端和页面。
- `358c11950`：E 未完成边界与契约。
- `804d464d3`：F 未完成边界与契约。
- `79bce05e4`：B 准入项目版本持久化补丁。
- `1b19b1060`：A 服务初始化读取顺序补丁。
- `f92944486`：reset／仅学习暂停／statement hash 幂等补充回归。
- 本报告与 PROGRESS 由最后一个文档提交保存；不 push。
