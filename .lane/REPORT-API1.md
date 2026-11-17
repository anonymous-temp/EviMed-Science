# API1：内部账号开放与原始对话回忆（部分交付，整体未完成）

日期：2026-11-17。分支：`cc/capsule-api-full-1117`，基线：`717308708`（已取回的 `github/main`）；该分支已存在且正位于此基线，直接使用，未重置或 fetch。

**结果为 failed / 部分交付，不能把本轮标成“完整胶囊 API 已完成”。** 已完成第一部分的内部账号边界，以及第二部分第 1 项原始对话回忆；第 2 项完整开场上下文尚未完成，按顺序停止后续能力建设。本轮没有完成把内核开场读取拆成可共用服务入口及其边界测试；这是明确的未完成工程项，不是已经证明技术上无法实现。

## 一、给负责人

| 能力 | 现在能通过 API 使用吗？ | 怎么使用／还缺什么 |
|---|---|---|
| 1. 原始对话回忆 | 是，显式选择 | `POST /api/agent-memory/v1/recall` 增加 `include: ["history"]`；密钥同时需要 `memory.read` 与 `memory.history.read`。保留原对话、说话人、时间等标注，默认调用不增加历史。 |
| 2. 完整开场上下文 | 否 | 没有新增 `/context`；`ResidentProfiles` 只提供开场的一部分，不能冒充原生 profile、偏好列表与网关 context 的完整组合。 |
| 3. 直接记住 | 否 | `/note` 仍是待确认候选，未新增直接写入或外部来源归属。 |
| 4. 按陈述遗忘与已忘记列表 | 部分是既有能力 | 已有 `/dashboard` 的 forgotten 和按记录 ID 操作保持原样；未新增裸陈述遗忘，也未修补既有 restore/undo 语义。 |
| 5. 外部完整会话学习 | 否 | `/episodes` 保持待确认，不会自动进入抽取；没有可信宿主 ingest 接口。 |
| 6. 通用工作信号与方法学习 | 否 | 未新增；既有处方 observations 不等同通用工作信号。 |
| 7. 分享与独占选定胶囊 | 否 | 导出、分享链接、接收和启停仍走现有网页服务；`capsuleIds` 继续叠加自己的记忆，不能叫“只用这个胶囊”。试用仍为网页专用，未建立外部会话的隔离权威。 |
| 8. 客户端 | 部分 | DSH 的 `capsule_status` 现在透传服务器能力表，`capsule_recall` 支持 history 选项；MCP 和其余新操作未完成。 |

`GET /api/agent-memory/v1` 按当前密钥返回 `capabilities`：原始历史是否提供、所需 scope，以及其他未实现能力的 `available: false`。已忘记列表单独标出既有 `/dashboard`。这是部署与密钥所提供的能力，不代表暂停账号或被撤回的来源也能读出内容。DSH 不靠试错调用来猜能力。

### 内部账号怎么开启

保持：

```dotenv
OPEN_SCIENCE_AGENT_MEMORY_API_ENABLED=false
```

可选两种授权，可同时使用：

1. 复用设置页已有的运营者名单 `OPEN_SCIENCE_OPERATOR_USERS`，另设 `OPEN_SCIENCE_AGENT_MEMORY_API_INTERNAL_ENABLED=true`。这个新开关默认 **false**，不会让生产现有运营者在没有操作时自动获得 API 权限。
2. 额外账号用 `OPEN_SCIENCE_AGENT_MEMORY_API_INTERNAL_USERS=account-id-1,account-id-2`。按精确账号 ID、逗号分隔；默认空。这个名单独立生效，不授予运营者身份，不要求开启前一个运营者开关。

由操作人员按正常发布流程将环境传入服务并重新创建 web 服务后，允许的账号登录即可在账户页看到密钥面板；`/api/me.features.agentMemoryApi` 是唯一的面板展示依据。创建原始历史密钥时勾选“读取记忆与做法”和“读取原始对话”；保存到本机文件，DSH 配置 `apiKeyFile`。先读根 status，再调用可用操作。没有进行上述发布，本报告不代表生产已开启。

移出名单、且不再有运营者授权的账号，其旧密钥下次请求即关闭。内部模式下不存在、已撤销、找不到拥有者、不在名单的密钥统一为 `503 agent_memory_disabled`；OpenAPI 也要求该内部账号的有效密钥。名单外不能创建、列出或撤销密钥，也看不到面板。公开开关没有被打开；原有 public=true 模式仍支持匿名 OpenAPI。

**默认兼容性的一处必要例外：** `/api/agent-memory/v1` 默认关闭的状态码、错误码和正文以及前端隐藏行为不变；但旧 `agentKeyRoutes` 根本没有特性门禁，即使 public=false 也能用 cookie 管理密钥。任务同时要求所有密钥路由受统一决策保护，因此补上该门禁，会把这条旧路径改为 503。不能诚实声称整个旧系统的所有默认响应逐字节不变。本轮优先遵循明确的密钥路由门禁要求，文档同步记录。

## 二、改动与证据

以下路径省略 `OpenScience/` 前缀；行号是本轮交付文件中的位置。

| 文件位置 | 改动 |
|---|---|
| `apps/server/src/agentMemoryAvailability.mjs:9`、`:17` | 唯一的账号可用性决策与统一关闭错误；无账号调用只判断是否存在可认证的受众。 |
| `apps/server/src/config.mjs:3538` | 运营者显式开关、额外账号名单配置，默认 false/空。 |
| `apps/server/src/agentKeyRoutes.mjs:1`、`:32`、`:35` | cookie 密钥创建、列表、撤销均在读取密钥前应用决策。 |
| `apps/server/src/agentMemoryRoutes.mjs:126`、`:133`、`:140`、`:147` | bearer 所有操作逐次校验当前拥有者；内部 OpenAPI 需要凭据；未知与被撤销/排除的密钥同样关闭。 |
| `apps/server/src/server.mjs:2`、`:7320` | `/api/me` 使用同一个账号决策；前端不新增探测请求。 |
| `apps/server/src/agentApiKeys.mjs:58` | 加入显式的 `memory.history.read` scope，不改变默认 read-only scope。 |
| `apps/server/src/agentMemoryRoutes.mjs:80`、`:108`、`:116`、`:255`、`:292`、`:304` | history include 验证、scope 检查、项目验证、数量和超时边界；不改变未选择 history 的响应。 |
| `apps/server/src/agentMemoryRecall.mjs:305` | `recallHistoryForAgent` 复用 admission、MemoryHistory、秘密过滤及来源删除版本检查；不提供原始 URI 或绕过审查的参数。 |
| `apps/server/src/memoryHistory.mjs:570`、`:584` | 现有 reader 新增仅内部调用参数 accountScope；默认 true 保持内核行为；公共项目绑定（包括 default）可要求精确项目，不扩成整个账号。 |
| `apps/server/src/server.mjs:1`、`:3600` | 接到运行时正在使用的 history/admission/sourceDeletion 实例，无第二套历史存储。 |
| `apps/server/src/agentMemoryRoutes.mjs:513` | 按密钥 scope/部署开关提供能力表，未实现的项明确 false。 |
| `apps/server/src/agentMemoryOpenApi.mjs:98`、`:141`、`:326` | include、原始历史及身份时间标注、根能力响应的机器文档。 |
| `apps/web/src/components/settings/AgentKeysSection.tsx:14` | 新 scope 的中文标签；仍只展示服务器提供的 scope，默认不选历史。 |
| `apps/web/src/lib/apiClient.ts:2742` | 新 scope 的类型；无新增网络探测。 |
| `packages/dsh-memory-capsule/index.mjs:79`、`:96`、`:102`、`:127`、`:130` | 兼容服务器嵌套错误体的 disabled 状态；status 显示 capabilities；recall 透传 include；工具说明保持通用工作措辞。 |
| `deploy/web/.env.example:135`、`deploy/web/docker-compose.yml:443` | 默认关闭/空名单示例与容器环境透传；没有执行 compose。 |
| `docs/AGENT_MEMORY_API.md:16`、`:22`、`:71`、`:110`、`:117`、`:146` | 内部启用步骤、scope、历史的准确范围、逐项未完成声明和兼容性例外。 |
| `PROGRESS.md:1` | 新增一行部分交付与测试边界，不声称完整完成。 |

### 测试与实际执行

先写了内部受众测试并观察到 3 项失败，随后实现转绿；先写原始历史测试并观察到 include 不支持的失败，随后实现转绿；能力声明和 DSH 客户端扩展也先观察到新增测试失败。来源删除竞态测试先因缺少共用适配函数而失败，补齐适配后通过。前端断言先改，依约没有运行 Vitest，因此没有声称观察过其红绿过程。

测试均单文件、串行运行，未运行 `pnpm test`、完整 tsc、Vitest 或 install。

| 命令／文件（服务器命令在 apps/server） | 本机结果 |
|---|---|
| `node --test test/agentMemoryAvailability.test.mjs` | 8 通过：默认关闭、运营者显式开启、额外名单、撤回授权、OpenAPI、同形关闭、cookie 各操作、me 使用同一决策。me 的检查为源码接线加决策测试，不是浏览器/HTTP 端到端验收。 |
| `node --test test/agentMemoryHistory.test.mjs` | 5 通过：默认不查历史、scope、角色时间标注、暂停/试用、撤回/删除/秘密审查/共享拒绝、外账号项目、default 项目绑定不扩域、来源删除竞态、正反断言。使用真实 MemoryHistory 与 admission，存储/引擎为测试替身。 |
| `node --test test/agentMemoryApi.test.mjs` | 22 通过：既有 API、schema 字段/路径一致性、权限和候选语义回归。 |
| `node --test test/memoryHistory.test.mjs` | 26 通过：既有历史边界回归。 |
| `node --test test/memoryHistoryRetrieval.test.mjs` | 6 通过：原 reader 数量、排序、并发与超时回归。 |
| 在 `packages/dsh-memory-capsule` 运行 `node --import ../../scripts/test/localhostProbeGuard.mjs --test test/plugin.test.mjs` | 16 通过：包括新增 status 能力透传与 include；凭据文件、禁重定向和脱敏既有测试仍通过。 |
| `node --test test/agentApiKeys.integration.test.mjs` | 5 跳过，未配置测试 PostgreSQL；新用例在 `:99`，验证真实持久密钥的名单移除和撤销。 |
| `node --test test/memoryHistory.integration.test.mjs` | 92 跳过，未配置测试 PostgreSQL；新 3 用例在 `:1025`，公共路由使用真实 history ledger，验证撤回、源删除和未审查归档，同时保留安全记录。 |
| 服务器改动文件 ESLint `--max-warnings 0` | 通过，包含修改的服务文件与新增/修改的服务器测试。 |
| 前端 3 个改动文件 ESLint `--max-warnings 0` | 失败：本 worktree 缺少 `@typescript-eslint/eslint-plugin`；未安装依赖，也未绕过规则。 |
| `pnpm -s check:pin-inventory`（OpenScience） | 通过，1,041 个版本出现位置均已分类；没有新增 DSH 版本字符串。 |
| `git diff --check` | 通过。 |

去重后的实际通过数 **83**；PostgreSQL **97 跳过，不算通过**。前端 `AgentKeysSection.test.tsx:14`、`:37`、`:39` 的新 scope/默认不选断言未运行；既有 `AgentKeysSection.integration.test.tsx` 的“仅由 me 决定、不得探测 OpenAPI”测试也未在此机运行。CI/实验环境需运行这两个前端文件、上述两个 PostgreSQL 文件，以及 checkJs；本轮不声称完整编译或线上验证。

### 刻意比内核更窄的地方

- 需要个人 key，且同时满足当前账号受众和两个 read scopes；没有让个人 key 访问 `/internal/memory/v1` 或借用 workload token。
- 必须显式 include 原始历史；默认回忆不增加内容。无外部 session_id、源 URI、namespace、forRemoval、秘密审查覆盖等输入。
- key 绑定项目或显式指定项目时只查精确项目，包括 default；内核普通 default 对话默认可扩到拥有者的普通账号命名空间。未绑定且未指定项目的公共回忆才允许同样扩展。
- 共享 GEO 历史继续拒绝，原始对话仍为历史上下文，不进入开场 profile，不作为已确认事实；不从收到的胶囊取得对方原始历史。
- 原始历史复用既有 reader 的 8/20 条上限和网关超时；`since`、`factKinds`、`scope` 仍只作用于既有记忆/胶囊选择，不承诺过滤 history。超时可能给空历史，并非“查遍了没有”。
- 原来的 privateByDefault/sensitive 记忆过滤、候选确认、按 ID 操作均未改；新增更强 scope 只打开原始历史，不改这些旧权限。
- 不接受外部显式写入、会话自动学习、可信工作信号、分享操作或独占试用。没有为了填满 capability 表把本不存在的操作列为可用。

### 停止点与后续工作

第 2 项尚未完成。证据：`apps/server/src/residentProfile.mjs:286` 起的 `forDispatch` 是项目卡、胶囊补充、索引和可选 standing/safety 层；原生 profile/list 和 context 在 `memoryGateway.mjs:453`、`:862`、`:1313` 至 `:1450` 的上下文、敏感 URI/其他项目排除、祖先 summary 排除、撤回读取和源版本检查中。只调用 `residentProfiles.forDispatch` 不能提供完整开场，直接调用 engine search 则缺少这些网关边界。本轮没有完成共享入口的拆分与必要测试，没有上线一个“看起来成功但缺一半”的端点。

第 3–7 项没有进入实现；第 8 项仅完成第一部分强制要求的 DSH status 和新增回忆选项，MCP 原文件未改。对这些未实现写接口，也没有虚称已有 trial/automated/clinical、粘贴指令、忘记请求及拒绝列表的公共端点覆盖测试。后续必须按任务顺序继续，共享现有 admission/write/learning/share 服务，并补上真正的外部来源与幂等权威。

没有新增表或存储 document kind，因此没有新增迁移/导出/擦除枚举；没有修改 `dump-config.baseline.json`、socket guidance 或 socket 插件；没有部署、SSH、git push、fetch、读取密钥目录或 `~/.ssh`。报告和代码本地提交；生产环境没有变化。
