# LEARN：晚到的真人证据与学习漏斗（2026-11-17）

## 第一部分：行为与边界

已实现 B01、D30、D39；开关保持关闭，未部署。分支 `cc/capsule-learn-1117` 的起点是已抓取的 `github/main`（`717308708`）。没有 fetch、push、SSH、安装依赖、全量测试或全量 tsc，没有读取密钥目录或 `~/.ssh`。

### 现在什么能算证据

原来不超过 30 分钟的判断路径、提示词和返回语义保留。开启 `OPEN_SCIENCE_LEARNING_LATE_FOLLOW_UP_ENABLED=true` 后，才新增 **超过 30 分钟、最多 24 小时** 的文字路径：同一对话唯一最近的成功交付，期间没有任何其他 run（失败、取消、自动或仍运行的也不行），当前真人输入有 request identity，交付版本有控制面记录的路径与 SHA-256。

首次晚到消息必须由 judge 判断为明确沿用、转换或引用这份交付，且返回能在本人消息中逐字找到的原句、动作关系和精确路径/摘要；本地再次核对交付版本、事件可见性及准入。它只将这次 run 变成一个 clean trajectory，绝不成为 adopt，也不直接绕过三次同形门槛。已完成的 30 分钟 settle job 不会被重新排队：直接补结算，重复回调还可恢复“事件已写、结算中断”的情况。

开关开启时，成功交付会在现有 `feedback_events` 中先写一条 **unknown** 的版本快照（仍用 `silent` 类型），只保存最多四个交付的路径/摘要及既有 shape，不保存文件正文。每文件最多读取 16 MiB，拒绝越界、链接、不稳定文件及完成之后才改写的文件；没有可信快照的历史 run 不追认。快照、晚到反应、后续纠正都有稳定身份；同一反应重放不多写，普通晚到反应每 run 一个槽位，纠正另有事件身份以覆盖已有 clean。

### 什么绝不由新路径算成认可

- 沉默、单独的“收到／谢谢／👍”、没有原句或交付版本绑定的 accept、晚到 adopt，不增加 clean。
- 重做、纠正、拒绝不能变成 clean；后续有本人原句的纠正优先于之前的 accept。
- 助手读取文件、相似文字、另一对话、没有交付、超过 24 小时、已有中间 run、版本改写／删除都不提供晚到 clean。
- 暂停、reset、临床／来源不可复用、自动任务、内部项目／agent、试用及不完整转录仍走原准入；judge 后再次核对暂停／reset／来源。judge 不可用／超预算／不可读保留 unknown，不把下一条正面消息补当首次认可。
- 既有共享 GEO 的 consumed-input 证据路径继续由它的原协议约束；没有从 `onNewTurn` 绕过该路径。

注意：上述“单独致谢不算”是**新增晚到路径**的规则；不超过 30 分钟仍保留旧 judge 的行为。

### 操作者能读什么

`learningMetrics.mjs` 新增两组指标，沿现有 metrics 接线输出：

- `open_science_learning_funnel_runs{account,scope,period,shape,reason}`：按去重 run 记录决策原因。同一 run 的同一原因只计一次，可以有多个原因，不能把不同 reason 相加当作总 run 数。
- `open_science_learning_group_clean_runs{account,scope,period,shape}`：最近结算读取的同组可用 clean 数，直接复用触发器的 shape 匹配谓词和现有有界 family 查询；不是全账户、全历史总量。

`account` 与 `shape` 是摘要，run 身份也只以摘要留在进程中，指标没有消息、规则、原句、文件名或标题。`period` 是保留的固定 epoch 周期；shape 是当前参照结构的摘要，同形匹配仍用原 Jaccard／format 规则，未改成一个新的聚类算法。读取不到结构或来源不允许读取时明确是 `unknown` 组。

原因包括 `no_deliverable`、`outside_window`、`run_in_between`、`judge_unavailable`、`judge_over_budget`、`judge_failed`、`judge_unreadable`、`busy`、`admission_refused` 及具体准入原因（如 `paused`／`before_reset`／`transcript_incomplete`）、`source_not_reusable`、`binding_unavailable`／`binding_changed`、`fewer_than_three_clean`、`routine_not_due`、`unknown`／`corrected`、排队失败等。预算拒绝在 gateway 的原错误码处单独记，不把它混成无交付。

这两个漏斗指标是**进程内有界观测**（最多 10,000 个观测 run，重启清空；既有 Prometheus 抓取可保留时间序列），不是新增数据库权威。原证据表、job 及其耐久指标仍保留。以前 21 个生产 job 的账户／scope／shape／turn 时间，本工作区没有原对象，且本任务禁止访问生产，因此仍标 **unknown，未补历史归因**。

### 没做什么

没有 B02 导出／分享 producer、认可按钮、跨会话归因、降低门槛、shape 阈值改动或生产开关启用。没有把回放说成真实用户效果，也没有调用真实 judge。

**B03 暂不做。** 当前幂等键是 `distill:<完成run>:routine`，计数是固定周期下每第三次；既有证据没有“哪些 source run 已被哪次 lesson 消费”的水位。仅把 SQL 范围换成滚动窗口，会在旧 run 过期后反复凑第三次或永远漏第三次。安全实现必须把 source-run 消费与 enqueue／失败重试／取消恢复绑定在同一幂等事务里，并定义 reset、来源撤回和已有 lesson 的迁移语义；这不是小的窗口替换，本次保留固定周期和原 key。

## 第二部分：改动位置、验证与实验室交接

以下路径均相对仓库根目录；行号是本次提交前的定位。

| 改动 | 文件:行 |
|---|---|
| 默认关闭的配置 | `OpenScience/apps/server/src/config.mjs:3356` |
| 环境值和 override 测试 | `OpenScience/apps/server/test/config.test.mjs:1262` |
| 环境示例与 compose 透传 | `OpenScience/deploy/web/.env.example:445`；`OpenScience/deploy/web/docker-compose.yml:1166` |
| 仅晚到模式追加 judge 协议；原协议不变 | `OpenScience/apps/server/src/learningEvidence.mjs:124`、`:226`、`:286` |
| 交付版本读取与磁盘边界 | `OpenScience/apps/server/src/learningDeliveryBindings.mjs:1` |
| unknown 版本快照、首条晚到分支、直接结算及重放恢复 | `OpenScience/apps/server/src/learningEvidence.mjs:503`、`:693` |
| 证据／触发链漏斗 | `OpenScience/apps/server/src/learningEvidence.mjs:382`、`:894`；`OpenScience/apps/server/src/learningTriggers.mjs:472`、`:533`、`:555`、`:603` |
| 原匹配谓词提取供诊断复用，按 run 去重 | `OpenScience/apps/server/src/learningTriggers.mjs:296`、`:322` |
| 原因枚举、摘要分组、有界指标 | `OpenScience/apps/server/src/learningFunnel.mjs:1`；`OpenScience/apps/server/src/learningMetrics.mjs:115`、`:137`、`:267` |
| 服务接线及预算拒绝原因 | `OpenScience/apps/server/src/server.mjs:5019`、`:5027`、`:5070` |
| 原事件中新增有界绑定字段、保留 4 KiB 总上限；沉默注释修正 | `OpenScience/packages/domain/src/learningEvidence.mjs:65`、`:124` |
| 自动生效／整理的旧审批注释修正 | `OpenScience/apps/server/src/server.mjs:8916` |
| 新的正反例、重放恢复与磁盘验证 | `OpenScience/apps/server/test/learningEvidenceLate.test.mjs:1`；`OpenScience/apps/server/test/learningDeliveryBindings.test.mjs:1` |
| 漏斗与准入诊断测试 | `OpenScience/apps/server/test/learningMetrics.test.mjs:180`；`OpenScience/apps/server/test/learningTriggers.test.mjs:559` |
| PostgreSQL 真实已完成 job 后补结算／幂等／纠正／撤回 | `OpenScience/apps/server/test/learningEvidence.integration.test.mjs:302` |
| 账户导出保留新字段；账户删除级联覆盖晚到事件 | `OpenScience/apps/server/test/accountExport.test.mjs:358`；`OpenScience/apps/server/test/feedbackEvents.integration.test.mjs:85` |
| 4 KiB 与非法绑定清理测试 | `OpenScience/packages/domain/test/learningEvidence.test.mjs:98` |
| 28 例录制回放、确定性协议元数据、README | `OpenScience/evals/follow-up-judge/replay-late.mjs:1`；`OpenScience/evals/follow-up-judge/late-fixtures.mjs:1`；`OpenScience/evals/follow-up-judge/README.md:125` |
| 进度一行 | `OpenScience/PROGRESS.md:1570` |

### 已运行

先加失败测试：新晚到路径最初 3 个测试失败；漏斗指标最初因 `observeFunnel` 不存在失败，然后实现。配置测试尝试在加载阶段被缺失依赖阻断，未把这个结果算成“测试通过”。

均逐个单文件运行，未并行测试、未运行整套：

| 文件（server 目录下 `node --test test/<file>`） | 最终结果 |
|---|---|
| `learningEvidence.test.mjs` | 32 通过 |
| `learningEvidenceLate.test.mjs` | 13 通过 |
| `learningDeliveryBindings.test.mjs` | 1 通过 |
| `learningTriggers.test.mjs` | 30 通过 |
| `learningMetrics.test.mjs` | 4 通过 |
| `learningWorker.test.mjs` | 25 通过 |
| `feedbackEvents.test.mjs` | 10 通过 |
| `accountExport.test.mjs` | 16 通过 |
| `learningEvidence.integration.test.mjs` | 9 跳过：未设置测试 PostgreSQL URL |
| `feedbackEvents.integration.test.mjs` | 2 跳过：未设置测试 PostgreSQL URL |
| `config.test.mjs`（定向新增用例） | 加载失败：缺少 `@evimed/patient-matching-core` |
| `learningEvidenceWiring.integration.test.mjs` | 同一稀疏依赖缺失，加载失败 |
| `serverComposition.test.mjs` | 同一稀疏依赖缺失，加载失败 |

另在 `OpenScience/packages/domain` 单文件运行 `node --test test/learningEvidence.test.mjs`：6 通过。共 137 个通过的单元测试，11 个 PostgreSQL 跳过，3 个测试文件受稀疏依赖阻断。变更的 server 源码／测试、两个 eval 模块和 domain 源码／测试的定向 ESLint 通过；`git diff --check` 通过。未运行全量 tsc，未安装缺失依赖。没有新增用户界面文案；新 domain 字符串为事件键／动作枚举，实验室仍应复验原退休词守卫。

### 28 例回放

```bash
cd OpenScience
node evals/follow-up-judge/replay-late.mjs
```

已在本机离线运行通过；输出也暂留本地忽略文件 `.lane/replay-late.json`，不纳入产品源码。协调者可用上面的命令重放。脚本使用设计指定的全部 28 个 case，保留原录制的 `modelText`，judge 是可注入函数；覆盖 30 分钟减／加一秒、24 小时及超窗、无交付、多版本、删除、reset、自动任务、中间 run、不同对话、重复回调与晚到纠正。

输出明确分两遍：第一遍原样录制，`fj-062`、`fj-069` 因缺少晚到 quote／relation／artifact 字段，逐例记为 missed positive；第二遍仅给这两例注入**合成的确定性协议字段**，保留原 verdict。第二遍证明唯一交付转换、指定版本引用及代码校验可走通，不证明真实 judge 已会产出新字段。两遍都断言：无无关／纠正／拒绝被算 clean、无撤回来源复活、同一反应不重复写、晚纠正覆盖 clean。真实 judge 的新协议有效性及生产增益仍未验证；如实验室补测，只用这 28 例。

### 实验室必须逐文件复验的清单

在完整依赖且配置隔离测试 PostgreSQL 的实验室，进入 `OpenScience/apps/server`，下列每一项分别运行 `node --test test/<文件>`，不要以本机 skip 或导入失败代替数据库验收：

```text
learningEvidence.test.mjs
learningEvidenceLate.test.mjs
learningDeliveryBindings.test.mjs
learningEvidence.integration.test.mjs
learningEvidenceWiring.integration.test.mjs
learningTriggers.test.mjs
learningWorker.test.mjs
learningMetrics.test.mjs
feedbackEvents.test.mjs
feedbackEvents.integration.test.mjs
config.test.mjs
accountExport.test.mjs
serverComposition.test.mjs
```

另外复验 `OpenScience/packages/domain/test/learningEvidence.test.mjs`，以及实际路径 `OpenScience/apps/web/src/app/retiredWords.test.ts`（任务中 `src/test/` 是旧位置）。再次运行上述 28 例 replay。PostgreSQL 新测试验证已 succeeded 的 settle job 不复活、晚到事件唯一、晚纠正从 family 排除及 withdrawn read 不回填；账户删除测试验证新字段随既有表级联删除，导出测试验证整个 detail 保留。没有新表、新 kind 或额外账户数据存储。

### 开关开启的风险与上界

新增风险是 judge 把无关消息误读成续用，尤其多版本的“这个”。本地不能替代语义判断；只有本人逐字原句、指定关系、精确交付摘要及当前仍可读的版本才能通过，模糊或旧协议一律 unknown，且只增加一个 clean、不直接 adopt、三次门槛不变。最多每个合格晚到真人 turn 一次模型调用，共用原并发上限、超时与 gateway 学习预算；同一输入重放不重复判断，新的纠正仍可读取。关闭开关停止新晚到证据；原事件／方法来源引用及现有撤销路径保留。

上线决策仍应等待完整依赖的接线／配置检查、真实 PostgreSQL 检查和可选的 28 例真实 judge 校验；本次只完成本地代码、测试与提交，不宣称可直接开启生产。

## LEARNFIX

The lab failure in test 9 of `OpenScience/apps/server/test/learningEvidence.integration.test.mjs` was a test setup error: it constructed `new ProductJobs({ database })`, although `ProductJobs` takes the database instance directly. The wrapper has no `transaction` or `query` methods. `afterRun` caught the initial enqueue failure as `settle_failed`, so the first uncaught error appeared later in `queue.claim` during migration. The test now uses `new ProductJobs(database)`, matching this file's passing shared setup.

Production wiring was traced from `store.database` to `new ProductJobs(productDatabase)` in `server.mjs`, then to the same queue passed into `LearningEvidence`, `LearningTriggers` and `LearningWorker`. The new late path calls the existing private `#settleRun` on that evidence instance; it constructs neither a queue nor a database wrapper. No production defect was found, so no production code or additional wiring assertion was needed.

Reviewed every PostgreSQL test addition in LEARN commit `47fd4ffd6` against the passing neighbours, including constructors, migrations, ownership/project setup, queue claim/finish, fixture injection and cleanup. The only other addition is the six-line late-evidence/cascade case in `feedbackEvents.integration.test.mjs`: `FeedbackEvents({ database, jobs })` correctly takes a dependency object, its database is a `ControlPlaneDatabase`, and its `JobsDouble` is intentional existing setup. The remaining changed test files add no PostgreSQL setup. The unchanged passing `learningEvidenceWiring.integration.test.mjs` supplies an isolated database URL to `createWebApiApp`, allowing the production composition above to create the queue.

Local validation: `learningEvidenceLate.test.mjs` passed all 13 tests; targeted ESLint for the changed integration file and `git diff --check` passed. `learningEvidence.integration.test.mjs` loaded but skipped all 9 tests, and `feedbackEvents.integration.test.mjs` loaded but skipped both tests, because `OPEN_SCIENCE_TEST_POSTGRES_URL` is unset. These skips are not database acceptance. The supplied lab batch remains the evidence that the other 12 files passed before this fix.

The commander must re-run the changed file against the lab PostgreSQL, from `OpenScience/apps/server`:

```bash
node --test test/learningEvidence.integration.test.mjs
```

Expected acceptance: all nine tests pass, including the real succeeded-job / late acceptance / duplicate callback / correction / withdrawal case. `feedbackEvents.integration.test.mjs` and `learningEvidenceWiring.integration.test.mjs` are unchanged by LEARNFIX and already passed in the supplied lab batch; they require no repeat for this one-line setup correction. No deployment, SSH, fetch, push, dependency installation or secret-directory access was performed.
