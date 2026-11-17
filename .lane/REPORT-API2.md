# API2：原生遗忘、恢复与客户端续作（A/B 未完成）

日期：2026-11-17。分支 `cc/capsule-api-full-1117`，继续 API1 的 `192956b8d`，没有 fetch、reset、push、部署或 SSH。

**本轮是部分交付，不能称为完整胶囊 API；总体回报 failed。** 按 A→B→C→D 检查后，A 完整开场和 B 外部直接记住未能完成到可安全开放的程度，依任务要求保留 `available: false` 并继续 C、D，没有在第一个难项停止。C 新增原生陈述/逐行遗忘、原文遗忘列表与网页同一路径的恢复，D 完成相应适配、历史选项、能力检查和文档。两个 PostgreSQL 集成测试只写好并跳过，不声称数据库或生产验证。

## 一、给负责人

| 原任务能力 | 现在可用吗 | 用法及剩余边界 |
|---|---|---|
| 1. 原始对话回忆 | API1 已实现；本轮补 MCP | `/recall` 显式 `include:["history"]`，同时需要 `memory.read`、`memory.history.read`；没有把历史加入开场。 |
| 2. 完整开场上下文 A | **否** | `openingContext.available=false`，原因 `complete_opening_composition_unavailable`；没有发布 `/context`。 |
| 3. 直接记住 B | **否** | `explicitRemember.available=false`，原因 `external_source_admission_unavailable`；没有发布 `/remember`。`memory.write` 原已存在，仍只授权候选，不扩大其语义。 |
| 4. 陈述遗忘与已忘记列表 C | **有条件可用** | `/forget` 复用 `NativeMemoryStore.forget`，需要 `memory.manage`、无项目绑定的 key、原有 targeted-forget 开关；`/forgotten` 用 `memory.read` 读原文和可用的恢复动作。项目绑定 key 只能读其项目列表，不能授权跨副本遗忘或恢复。 |
| 5. 外部完整会话学习 | 否，本轮不在范围内 | `/episodes` 仍待确认。 |
| 6. 通用工作信号 | 否，本轮不在范围内 | 原处方 observations 不冒充通用工作学习。 |
| 7. 胶囊分享与独占选定胶囊 | 否，本轮不在范围内 | 分享仍在网页；capsuleIds 仍是叠加选择，试用仍在网页。 |
| 8. 客户端 D | 部分能力可用，闭合能力明确拒绝 | DSH 有 status/recall/propose/method/context/remember/forget/forgotten；MCP 有 status/recall/note/context/remember/forget/forgotten。新操作先读服务器能力表；A/B 关闭时不探测不存在的接口。context 仅在能力开放后按提示于会话开头调用一次，本轮没有自动注入开场。 |

### 内部账号如何使用

内部受众沿用 API1：保持 `OPEN_SCIENCE_AGENT_MEMORY_API_ENABLED=false`；指定 `OPEN_SCIENCE_AGENT_MEMORY_API_INTERNAL_USERS=<account-id>`，或对已有 `OPEN_SCIENCE_OPERATOR_USERS` 显式启用 `OPEN_SCIENCE_AGENT_MEMORY_API_INTERNAL_ENABLED=true`。生产没有执行这些配置变更。网页仍仅根据 `/api/me.features.agentMemoryApi` 显示密钥面板。

C 另外需要已有 `OPEN_SCIENCE_MEMORY_FORGET_TARGETS_ENABLED=true`、可用原生存储/命名空间/admission；默认仍 false。本轮没有新增环境开关。创建无项目绑定的 key，读列表用 `memory.read`，执行遗忘/恢复用 `memory.manage`；默认勾选范围不变。

以下只是请求形状，`<KEY>` 是占位符，实际客户端把 key 放在本机文件，不放工具参数或日志。

```sh
# A/B 尚不可调用；先查看明确关闭原因，而不是探测 /context 或 /remember。
curl -H 'Authorization: Bearer <KEY>' https://example.invalid/api/agent-memory/v1
# data.capabilities.openingContext.available=false
# data.capabilities.explicitRemember.available=false

# C1：人的原话所指的事实，即使尚无记忆文件也建立历史回忆拒绝。
curl -X POST -H 'Authorization: Bearer <KEY>' -H 'Content-Type: application/json' \
  --data '{"statement":"Use metric units."}' https://example.invalid/api/agent-memory/v1/forget

# C2：已读取的记录，只移除完整指定行；省略 lines 表示该记录，profile 行不会扩大成整个 profile。
curl -X POST -H 'Authorization: Bearer <KEY>' -H 'Content-Type: application/json' \
  --data '{"recordId":"<RECORD_ID>","lines":["Use metric units."]}' https://example.invalid/api/agent-memory/v1/forget

# C3：管理用原文列表，不作为回忆或开场上下文。
curl -H 'Authorization: Bearer <KEY>' https://example.invalid/api/agent-memory/v1/forgotten

# C4：使用上一步 restore.path 与 expectedVersion；此处数字仅为形状示例。
curl -X POST -H 'Authorization: Bearer <KEY>' -H 'Content-Type: application/json' \
  --data '{"expectedVersion":123}' https://example.invalid/api/agent-memory/v1/records/<RECORD_ID>/restore

# D：MCP 已能转发 API1 的历史选项；默认仍不请求历史。
curl -X POST -H 'Authorization: Bearer <KEY>' -H 'Content-Type: application/json' \
  --data '{"query":"units","include":["history"],"methods":"none"}' https://example.invalid/api/agent-memory/v1/recall
```

遗忘响应只报告原生存储确认的 `removed`、`removedLines`、`fileRemoved`、`historyRejected`、`historyScanPending` 等实际字段。`historyRejected:true, removed:false` 不是“删除了文件”；pending 表示仍可能回忆到未检查完的转述或副本。无法解析的记录 ID 返回错误，不虚构 `forgotten:true`。列表最多继承原生的 100 项上限，不是完整导出。

### A/B 为何没有开放

这是**未完成的工程项，不是技术不可行的结论**。

- A：`residentProfile.mjs:286` 的 `forDispatch` 有项目卡、胶囊补充、索引、standing/safety、预算和 delivered/digest 状态；`memoryGateway.mjs:862` 起的 search/read/list 及 `:1313` 起的请求上下文持有敏感 URI、其他项目、祖先 summary 排除、撤回与源版本边界。尚未把两条路径提取为一处完整组合，也没有完成任务要求的“固定夹具重构前后逐字节相同”新刻画测试。因此不以 resident-only 结果冒充完整开场，未动这两个内核模块。
- B：`memoryGateway.mjs:1149` 的 remember 先做 admission/captured-message 过滤，再转发引擎的 one-shot remember，`afterCall` 从引擎返回的 session/task 记录来源；网页 `nativeMemoryStore.mjs:2335` 的 remember、candidate admission 有另一套既有输入权威。尚未完成外部 `(owner,client,session,messageId|hash)` 幂等、最小真实归档来源、外部来源显示、源删除、粘贴指令/forget-request/rejection 栅栏贯通。直接调用网页 remember 或确认 candidate 都不足以证明上述承诺，所以不开放，也不新增一个假 archive 或第二存储。
- A/B 的公共暂停、试用、临床、自动化、敏感 URI、逐字节刻画及来源删除/幂等测试尚未写成；本轮只测试其能力关闭与端点不存在。不能把 C 的删除准入测试当成 B 的学习准入测试。

## 二、改动位置和验证

以下路径默认以 `OpenScience/` 为前缀。

| 文件:行 | 本轮改动 |
|---|---|
| `apps/server/src/agentMemoryForget.mjs:6`、`:56` | 新公共薄适配：验证目标、普通命名空间、原生 admission；携带已验证 context 进入原生 live-context 检查后执行 forget；列表读取 forgotten 修订、过滤私密/共享并返回原文/恢复动作。profile 行不授权邻行，失败提示不泄露整份 profile。 |
| `apps/server/src/agentMemoryRoutes.mjs:70`、`:255`、`:269`、`:477`、`:550` | 注册字段/端点、key scope/项目/内部受众既有边界、账号级恢复限制、明确 A/B 关闭原因及 C 每 key 能力。 |
| `apps/server/src/server.mjs:3599` | 延迟闭包引用同一个生产 `memoryAdmission`，没有第二套 admission 或存储。 |
| `apps/server/src/agentMemoryBoard.mjs:187`、`:269`、`:311` | 看板读原生 forgotten 修订；restore 改调网页相同的 `native.update(status:active, expectedVersion)`，并拒绝私密/共享来源。 |
| `apps/server/src/nativeMemoryStore.mjs:2033` | 文件不在引擎时，undo 也核对保留 before-image 的版本；错误版本 409，未指定版本的内核旧调用不变。 |
| `apps/server/src/agentMemoryOpenApi.mjs:163`、`:362`、`:375`、`:495` | ForgetRequest 的互斥模式、严格字段、确认语义、forgotten 管理读、可用性 reason 和真实 restore 描述。A/B 不列不存在的路径。 |
| `apps/server/test/agentMemoryForget.test.mjs:39` | 九项公共路由测试：原生确认、逐行/profile 选择、scope/项目/共享/敏感/试用/内部受众、暂停允许撤回、无 URI/空行组、原文列表/恢复、关闭能力和邻行防泄露。 |
| `apps/server/test/agentMemoryForget.integration.test.mjs:46`、`:64` | 真实 PostgreSQL key/overlay/history + 引擎 HTTP stub：陈述遗忘→原文回忆拒绝→列表恢复→再次回忆；精确行删除/邻行保留、受限 key 拒绝与恢复。未配置数据库，未实际验收。 |
| `apps/server/test/nativeMemoryForgetTool.test.mjs:436` | 真实 NativeMemoryStore 的 absent-file undo 旧版本失败、正确版本成功。 |
| `apps/server/test/agentMemoryBoard.test.mjs:127`、`:212`；`agentMemoryNative.test.mjs:162` | 更新旧 restore 拒绝断言；新增看板从遗忘修订取数而不是 active 文件的回归。 |
| `apps/server/test/agentMemoryApi.test.mjs:327`；`agentMemoryMcp.test.mjs:37` | OpenAPI 字段和根路径一致性、MCP 操作/能力/历史/凭据文件协议断言。 |
| `packages/dsh-memory-capsule/index.mjs:6`、`:99`、`:147`；`test/plugin.test.mjs:185` | 四个新工具，先查 capability，不探测关闭接口；会话起始 context 指引、原生遗忘结果透传、凭据仍从文件逐请求读取。 |
| `runtime/mcp/evimed-memory/server.py:88`、`:123`、`:152`、`:241`；`test/test_server.py:49`、`:220`、`:232` | 历史/project 参数、GET/status、新操作、服务端 capability 检查。按本轮“key 留在文件”要求取消内联 `EVIMED_MEMORY_API_KEY` 回退，响应和异常不回显 key；十八项协议测试。 |
| `apps/web/src/components/settings/AgentKeysSection.tsx:16`、`AgentKeysSection.test.tsx:41` | manage 权限标签补“恢复”，默认不选；write 标签仍“提出待确认的记忆”，没有声称 B 已开放；未增加 feature 探测。 |
| `docs/AGENT_MEMORY_API.md:146`、`:170`、`:362`；`packages/dsh-memory-capsule/README.md:65`、`README.zh.md:65` | 能力表、新操作/限制/恢复版本、客户端说明、MCP 凭据迁移；中文 README 的过时限制段用英文更新，遵守本轮文件英文约束。 |
| `PROGRESS.md:1` | 一行结果和 A/B、数据库验证边界。 |

### 既有缺陷与本轮修复

1. 基线 `agentMemoryBoard.mjs:268` 的 `/restore` 无条件报 unsupported，尽管 `nativeMemoryStore.update` 已有与网页一致的 forgotten restore。现在启用该路径；使用 `/forgotten` 返回的版本，与 last-change undo 的版本语义分开。旧 `agentMemoryBoard`/`agentMemoryNative` 测试明确要求拒绝，与本次任务冲突，已按新要求改写，并保留 update 参数断言。
2. 基线 `nativeMemoryStore.mjs:2012` 只在 live 文件存在时检查 undo 版本，`:2032` 的已删除分支忽略传入版本。先添加失败测试（旧实现未拒绝），再在该分支核对 before-image hash；正确版本仍可恢复。
3. 基线看板从 `listRecords` 的 active 文件过滤 archived；原生遗忘内容实际在 `forgotten()` 的 overlay 修订里。新回归在旧实现中确实为空，现在读取同一原生遗忘列表。没有修造第二份列表存储。

### 实际运行

均为**单测试文件、串行**；没有全量套件、完整 tsc、Vitest 或安装依赖。

| 文件/命令 | 最终结果 |
|---|---|
| `agentMemoryForget.test.mjs` | 9 通过；最初六项全部失败，后补 profile 邻行泄露用例也先失败。 |
| `agentMemoryApi.test.mjs` | 22 通过；OpenAPI 新路径/字段一致性先失败再修复。 |
| `agentMemoryBoard.test.mjs` | 9 通过；新看板回归先失败。 |
| `agentMemoryNative.test.mjs` | 14 通过；旧 restore 拒绝断言先失败，按任务更新。 |
| `agentMemoryMcp.test.mjs` | 3 通过。 |
| `agentMemoryAvailability.test.mjs` | 8 通过。 |
| `agentMemoryHistory.test.mjs` | 5 通过（含撤回、原始归档审查、共享、暂停、外账号项目和安全记录保留）。 |
| `nativeMemoryForgetTool.test.mjs` | 34 通过；新 undo 版本测试先失败。 |
| `nativeMemoryForgetEverywhere.test.mjs` | 6 通过。 |
| `memoryGateway.test.mjs` | 121 通过，内核路径未改。 |
| `residentProfile.test.mjs` | 23 通过，开场模块未改；不等同 A 所需的新提取刻画测试。 |
| DSH `node --import ../../scripts/test/localhostProbeGuard.mjs --test test/plugin.test.mjs` | 17 通过，新 capability-gated 工具用例先失败。 |
| Python `python3 -m unittest discover -s test -p test_server.py` | 18 通过，新操作和仅文件凭据/脱敏用例先失败。 |
| `agentMemoryForget.integration.test.mjs` | **2 跳过**；无 `OPEN_SCIENCE_TEST_POSTGRES_URL`，不是通过。 |
| `serverComposition.test.mjs` | **未运行到测试逻辑**：缺 `@evimed/patient-matching-core`；未安装/绕过。 |
| 改动服务端源文件和测试 ESLint `--max-warnings 0` | 通过。 |
| 前端两文件 ESLint | **失败**：缺 `@typescript-eslint/eslint-plugin`；未安装，前端断言未执行。 |
| `pnpm -s check:pin-inventory` | 通过，1,041 个出现位置已分类，无新版本字符串。 |
| `git diff --check` | 通过。 |

去重通过数 **289**；2 个数据库跳过不计入。开发过程中少数命令因工作目录与相对路径重复而找不到文件，修正目录后才记入上表；没有将这些启动失败算通过。没有声称真实模型、真实内核挂载、新前端浏览器或线上调用已验收。

### 实验机必须运行的清单

下面每个 `.test.mjs` 在 `OpenScience/apps/server` 以 `node --test test/<文件>` 单文件运行；数据库项需测试 PostgreSQL，不能因 skip 而通过验收。已有未修改邻居也列出，特别是源删除、恢复和 app 接线。测试导入缺包需实验机提供完整既有依赖，本机没有安装。

```text
accountExport.integration.test.mjs
accountExport.test.mjs
accountExportKinds.test.mjs
accountExportNative.test.mjs
accountExportSharers.test.mjs
agentApiKeys.integration.test.mjs
agentMemoryApi.test.mjs
agentMemoryAvailability.test.mjs
agentMemoryBoard.integration.test.mjs
agentMemoryBoard.test.mjs
agentMemoryForget.integration.test.mjs
agentMemoryForget.test.mjs
agentMemoryHistory.test.mjs
agentMemoryMcp.test.mjs
agentMemoryNative.integration.test.mjs
agentMemoryNative.test.mjs
agentMemoryObservations.integration.test.mjs
agentMemoryObservations.test.mjs
agentMemoryRecall.integration.test.mjs
config.test.mjs
memoryGateway.test.mjs
memoryGatewayContext.integration.test.mjs
memoryGatewayNextRound.test.mjs
memoryHistory.integration.test.mjs
nativeMemoryApp.integration.test.mjs
nativeMemoryAttribution.integration.test.mjs
nativeMemoryForgetEverywhere.integration.test.mjs
nativeMemoryForgetEverywhere.test.mjs
nativeMemoryForgetGateway.integration.test.mjs
nativeMemoryForgetRequests.integration.test.mjs
nativeMemoryForgetRequests.test.mjs
nativeMemoryForgetRows.integration.test.mjs
nativeMemoryForgetTool.test.mjs
nativeMemoryReads.test.mjs
nativeMemoryStoreScopes.integration.test.mjs
residentProfile.integration.test.mjs
residentProfile.test.mjs
serverComposition.test.mjs
```

还需运行 `packages/dsh-memory-capsule/test/plugin.test.mjs`（带 localhostProbeGuard）、`runtime/mcp/evimed-memory/test/test_server.py`、`apps/web/src/components/settings/AgentKeysSection.test.tsx`、`AgentKeysSection.integration.test.tsx`，以及服务器 checkJs、前端 lint/类型检查、pin inventory。前端仍由 me feature 决定展示的集成测试不可省略。

### 公共路径刻意比内核窄的地方

- A/B 仍关闭，不接受 native session、URI、namespace、归档审查覆盖或不带来源的直接写入。客户端工具存在不等于服务端能力已提供。
- `/forget` 与新启用的 `/restore` 只接受无项目绑定的账号 key；内核同命名空间副本扫除/恢复可能超出某个项目，不能让项目 key 借这个入口扩大授权。陈述模式只用普通 default；命名项目可用于记录选择但不能缩窄原生跨副本动作。
- 共享命名空间、私密/未分类记录、sensitive 记录不经新增公共路径外流；网页可有更多个人管理内容。原始 URI 不是公共输入，输出列表也不带 URI。privateByDefault 和显式 sensitive 是两个独立检查。
- profile 行 ID 仅对应本行；输入其他行直接拒绝。原生 store 的 availableLines 可能包括整份 profile，公共 profile 行请求故意去掉该提示，而不改写 store 确认的删除结果。
- 空 `lines:[]` 在原生旧工具中等同整文件（原测试明确如此），公共新增入口拒绝空数组，以免外部宿主空选择变成整文件删除；没有改变内核既有语义。
- 暂停不拒绝删除，这是保留内核语义，不能为了“每种 fence 都拒绝”反而阻止人撤回信息。trial、memory_off、internal_project 按原生删除规则拒绝；automated/clinical/engine-ready 的学习限制不冒充删除限制。
- `/forgotten` 是显式管理读：会返回本人已撤回的原话以供恢复，不能拿它当 recall 或开场。read-only key 不返回 restore 动作。列表继承 100 条上限、看板只显示其中 20 条，尚无分页/完整导出承诺。
- C 复用已有原生 statement normalization、拒绝账本、异步扫描及恢复文本语义，没有声称逐字节保留所有 Markdown 装饰或未审查归档全文；源会话仍由历史 reader 保持秘密审查。当前会话的已显示文字不会被改写。
- DSH/MCP 新操作先读取 capability，旧服务器不提供能力时不尝试新端点。MCP 本轮取消旧环境变量内联 key，需要迁移到 `EVIMED_MEMORY_API_KEY_FILE`；DSH 一直只有 `apiKeyFile`。

本轮没有新增数据库表或 document kind，没有需要加入账户导出/擦除的新存储；没有修改 runtime baseline、socket guidance、上游 pin、生产开关。未部署、SSH、push、fetch、读取密钥目录或 `~/.ssh`。按要求独立工作，没有调用其他 agent；本地提交包含本报告，A/B 和实验机验证仍是明确未完成项。
