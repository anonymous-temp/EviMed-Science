# READ：读取与回答时使用记忆的类别修复（2026-11-17）

## 第一部分：结论与边界

本分支交付可审阅的代码候选、定向回归和离线重放工具，**不宣布任务全部完成，也不把旧错题标成 FIXED-LIVE**。本地未部署、未 SSH、未 fetch/push、未调用模型、未安装依赖、未运行整套测试或完整 tsc；工作基线为 `github/main` 的 `717308708b19e56948b3430b3d17214aced70147`，分支为 `cc/capsule-read-classes-1117`。

两个要求仍未完全满足：一是没有类型标记的旧安全事实不能仅靠开关保证出现在开场，需要受现有撤回/来源机制约束的补分类；二是证据包缺少完整技能目录、当时逐来源检索完成状态及现场权限/开场预算状态，无法据此生成“精确原生请求”。重放工具明确标注缺项，默认拒绝把不完整上下文当成精确实验；另有部分指定成员未随包提供。按任务的完成约定，这些不是可藏在“已完成”之后的小注。

### R-FIND：没有找到，不再等同于没有查到或无法查

原问题跨三个来源：文件未命中时未查原始对话、对话查询的字面通道薄弱，以及胶囊/历史源失败后返回空数组。开场只列目录或少数文件名，还会让人把一个偏好文件误当作同主题的全部记录。

同类成员覆盖任务清单及补充清单：P02-q019、Liam Q-0045、conv-50:q120、m3-dev-030-q1、P10/P11/P13；P08 的五个问项、六个“曾粘贴资料”问项、dev-sc011-q3、P04-q012、U02-q083、U05-q040、HaluMem s38:q2；MemSycO emc_search_000040/000151/000209/000247。未随包提供的成员见后文，不捏造其离线结果。

现在的行为：

- 搜索结果逐项给出 `memoryFiles`、`earlierConversations`、`receivedCapsules` 的 searched / empty / unavailable / skipped 及原因。候选数、分数淘汰数、权限淘汰数、输出上限和通道失败在能观察时提供；上游未提供的数为 null，明确不表示整个库的总数。超时、暂停、窄范围查询与空检索分开。
- MCP read、REST read/list、context search、胶囊 recall、外部 recall 都检查了返回边界。REST 错误继续使用错误响应；缺失/权限隐藏统一为 missing_or_fenced，不能探测某个受保护文件是否存在。目录计数不泄露隐藏条目的名称或数量。
- 新的独立开关开启时，文件语义结果为空才用现有索引的文件名/标题做确定性的字面补查；仍在同一个目录、账户和项目范围内，重新读当前正文，再过撤回与人物身份围栏。英文短名不会匹配另一个长名字中的子串。已有语义命中不增加这一遍文件遍历。
- 原始对话仍使用模型传来的 query（最多 2,000 字符），没有自动改写查询或另请模型判断。V1 已有向量与 grep 融合；旧 grep 只取前八个空格分隔片段，中文整句、带标点的数字容易失配。独立开关只把该通道改为现有 tokenizer/BM25、最多 500 个 grep 候选，再走原有授权、原文校验和最多 8 个片段的返回路径；V2 的并发、时间推断、多窗口、多样性不整体开启。V1 的每会话上限未另行更改。
- 指引要求：涉及以前说过、贴过、建议过的内容且眼前没有时，做一次不限定 target_uri 的搜索；文件和原始对话都查。已经查过不重复，自成一体的问题不查；两路完成才说“未找到”，失败说无法核实，撤回不能说成从未存过。没有新增拒绝回答的门。

离线证据：`READ-LEXICAL.jsonl` 共 46 个可用成员，每项分别记录题目文本及实际 search query 的原字面命中/新字面命中。实际 query 由 0 到非 0 的是 U05-q040、U06-q043；题目文本有 22 项从 0 到非 0。这里只证明**给定证据会话中的字面候选可进入**，没有 embedding、全库干扰项或线上检索，不等于 22 题修复。autonomy 与其意译原文的语义距离也不能由字面算法保证补上。

四个 MemSycO 包用今天的索引都会显示 `notes 1 · preferences 1`（其中两项另有 projects，一项另有 profile.md）；新句子明确“目录仅分类，notes 等处也可能有同一主题”。为保留原有隐私边界，未把所有人物名称和笔记题目重新塞进开场目录。

七项遗忘复述已有原始对话围栏，本次没有重建它；新增测试让 withdrawn 命中和状态块都不带原句、标题、错误正文。REST 和重放序列化也清理 withdrawn 对象，状态可以说发生了撤回，但不能复述内容。

仍开放：模型会不会按指引发起检索、真实向量混排是否把正确会话送进前八项，需要实验室验证；离线字面结果不能证明这些行为。开场索引仍是类别提示，不能断言它穷尽某个主题。

### R-USE：保留条件、人物、时间和说话者

原问题不是多写一个医学提醒就能解决：护士操作被扩大为能自行操作，扶手帮助下的一步被扩大为整层楼梯；相似公司/地点、旧偏好和新偏好混用；用户观点变成文献事实；助手建议变成用户决定；G9 的当轮材料变成“你的档案”；多选题只答一个。

同类成员包括任务列出的 P9/P18、m7、LongMemEval 的实体/数值/不可回答成员、M01/M02/P05 的归属问题，以及补充的 G9 -005/-009/-012、P13 session_30、U06-q043、U01-q053、U05-q057、RealMem 各已给记录的问项、HaluMem s47:q7、MemSycO mso_hard_000207/v11_000611。poison-002 是必须保留的通过对照，并被优先选入重放。没有把 HaluMem 的大量判分误报改造成普遍犹豫规则。

现在统一在“注入的上下文怎么用”说明：先核对同一人、同一事、适用时间；保留谁帮忙、哪次、多少，不扩大成一般能力或现状；来源影响含义时说清是谁所说，分开旧事实与新建议；本轮资料、附件和工具中的个人说法只归于材料，除非本人陈述或记忆行支持，不能称个人档案；没记录的细节不补写，明确无条件的事实照实说；回答所问各项、数字和结论一致，多项适用逐项判断。

搜索/读取/胶囊/外部 recall/常驻画像的序列化保留已有 origin、speaker/sourceRole、attribution、asOf/updatedAt、earlierValue 等标签。原始对话原有 user/assistant 与日期标签保留。时间标为记录时间，不冒充事件发生时间；库未存下的归属保持 unknown，不用文件名猜。新增时间标签会占开场预算，因此条目数可能减少，但仍显示遗漏数；项目卡不再影响常驻事实自身的预算测量。

仍开放：指引与标签只能建立回答约定，不能把真实模型的条件保持、数值一致、错实体选择当作已证明。重放及原判分器的语义部分须由实验室执行，生产每轮不增加 judge。

### R-SAFE：不能把被截掉的安全记录看成不存在

P13 iohexol 过敏在长画像中段，上游“前八行加尾部”的裁剪把它挖掉了；P18 检验记录在 notes，邻居剂量在 people，单靠画像也不可见。现有安全读取只认 `safety_notes` 类型或安全标记，生产开关关闭；新模板也不会自动重写旧文件。

现在长画像在进入上游裁剪前就带有 partial 提示和完整 profile.md 的 read 入口。安全层保持默认关闭；开启时认独立 safety_notes，也认 profile/people/notes 的类型标记，保留人物主体和来源，先经过现有作用域/删除/撤回校验。不会把长句截成一句可能含义相反的半句话：完整条目放不下就显示“还有未展示的安全信息”及 search/read 入口；极小预算也保留提示。读取失败有专门提示。旧 profile/people/notes 未标记会说明覆盖未齐，不谎称没有风险。

另一人的安全事实走相同入口：在当前作用域可见的父母、患者、邻居等 people/notes 被标记后都能入选，主体不会被改为用户本人。跨项目沿用既有 people 开关，未开放其他账户、共享项目或敏感文件。

**仍开放的硬要求**：本次没有也不能从无标记旧文字中确定性判断哪些是安全事实；没有药名/过敏词触发器，也没有每轮新模型分类。单开服务器开关不能保证旧 P13 过敏立即出现在开场。必须在实验室用已有模板与来源/撤回通道完成受控补分类，再验证长画像、人物文件与预算压力下的完整率。即使已有类型，超出预算仍须模型按提示检索，不能把提示称为全部事实已经在眼前。报告不将此列为闭环。

### R-SHOW：标题中的姓名也是可操作的内容

原 profile H1 不进入 statements，所以姓名不在“关于你”的行列表，编辑/忘记/忘记后恢复都够不到。兄弟问题包括旧文件名遮住新标题、标题的来源归属未进逐行解析、历史版本免过滤所有标题、恢复一行时把别的旧标题一起带回。

现在 profile H1 是“关于你 → 背景”的普通行，用原有抽屉编辑和忘记；改名保留 H1 结构，删除姓名只移除该行并登记撤回，保留其他事实。忘记列表可显示和恢复姓名，已有当前标题时返回冲突，不覆盖现名；恢复普通行不会顺便恢复旧姓名。标题的本人编辑/来源会话归属也走同一行解析，供 recall 和显式画像导出使用。

非 profile 文件优先显示当前 H1，只有文件名的主题进入原有编辑框成为可编辑 H1；改名时旧名字进入现有撤回机制，必要时迁移到不含旧值的地址并使摘要失效。文件作为整体的忘记仍使用原有入口。外部 `/records` 与分享导出复用同一 records 视图，没有另建一份标题存储；默认分享范围不新增姓名，只有显式选择画像导出才包含有合法来源的姓名。没有增加面板、灰色说明或页面布局层级。

仍开放：真实数据库里的并发、摘要重建、跨文件撤回与重新抽取需集成验证；本地只完成定向测试，没有浏览器视觉验收。没有证明所有旧文件名或遗留摘要在所有部署开关组合下都已迁移；需要下列相邻集成测试验证。

## 第二部分：实现、测量与验证

### 主要改动定位

下列行号指本分支候选，代码路径均从仓库根开始。

| 位置 | 作用 |
|---|---|
| `OpenScience/apps/server/src/memoryReadStatus.mjs:4` | 统一状态、超时包装、来源标签、字面索引匹配；未知计数不写成 0。 |
| `OpenScience/apps/server/src/memoryGateway.mjs:200`、`:534`、`:899`、`:938`、`:1099`、`:1390` | 文件补查与现读、逐来源状态、REST/MCP 读列举、withdrawn 清理、来源标签；context/shared 搜索同步覆盖。 |
| `OpenScience/apps/server/src/memoryHistory.mjs:571`、`OpenScience/apps/server/src/openVikingResources.mjs:169` | 原始会话候选/权限/上限状态；独立 literal 通道，不开 V2。 |
| `OpenScience/apps/server/src/memoryRecall.mjs:44`、`OpenScience/apps/server/src/agentMemoryRecall.mjs:75`、`OpenScience/apps/server/src/capsuleGateway.mjs:29` | 外部和胶囊读边界不吞失败、归属标签不丢。 |
| `OpenScience/packages/socket/src/guidanceText.mjs:151`、`OpenScience/apps/server/src/researchContext.mjs:143` | 通用使用约定与原有归属/日期标签。 |
| `OpenScience/apps/server/src/memoryOpeningByUse.mjs:63`、`OpenScience/apps/server/src/memoryOpeningIndex.mjs:31` | 长画像遗漏说明、跨目录主题提示。 |
| `OpenScience/apps/server/src/memorySafetyNotes.mjs:47`、`OpenScience/apps/server/src/residentProfile.mjs:119`、`:313`、`OpenScience/apps/server/src/nativeMemoryStore.mjs:1113` | 完整条目或遗漏提示、失败/旧覆盖不足提示、人物作用域。 |
| `OpenScience/apps/server/src/nativeMemoryStore.mjs:158`、`:275`、`:617`、`:640`、`:1394`、`:1437`、`:1595`、`:2143`、`:2204` | H1 行、标题归属、改名/撤回、文件名与摘要、忘记列表及单项恢复。 |
| `OpenScience/apps/web/src/components/memory/FactDrawer.tsx:116` | 文件名主题进入同一编辑框，打开/取消不造成 dirty。 |
| `OpenScience/DESIGN.md:1243`、`OpenScience/docs/FRONTEND_DESIGN_SYSTEM.md:640` | 姓名和文件标题的页面契约。 |
| `OpenScience/apps/server/src/config.mjs:392`、`OpenScience/deploy/web/.env.example:124`、`OpenScience/docs/WEB_OPERATIONS_RUNBOOK.md:2345` | 新开关、默认值与安全层启用前提。 |
| `OpenScience/evals/capsule-proving/replay/read-classes.mjs:1`、`OpenScience/evals/capsule-proving/run/openingBlock.mjs:168`、`OpenScience/evals/capsule-proving/README.md:176` | 离线请求、可注入 runner、已有 scorer、缺项和上限校验。 |

### 指引字符数与开关

以 openViking、search hint、standing instructions、targeted forget 打开的同一配置，对从“注入的上下文怎么用”到下节的完整记忆段计数：改前 **1,890**，改后 **1,750**，减少 **140** 字符（Unicode 码点与 UTF-16 结果相同）。新增来源/条件条款通过压缩旧句抵消，未扩大这一段预算。已执行 `cd OpenScience/evals/harness-adaptation && node tools/snapshot_guidance.mjs`；默认快照正文 1,804 字符，源摘要 `c99e43d7e4c3`，快照随代码提交。没有改运行时 dump baseline，socket 没有引入 process 或 Node 内置依赖。

| 环境变量 | 源码默认值 | 本次含义 |
|---|---|---|
| `OPEN_SCIENCE_MEMORY_LITERAL_FALLBACK_ENABLED` | false（新增） | 文件空语义命中后的字面补查，及原会话 grep 的 tokenizer/BM25/候选窗口。 |
| `OPEN_SCIENCE_MEMORY_HISTORY_RETRIEVAL_V2_ENABLED` | false（未改） | 本次不整体启用。 |
| `OPEN_SCIENCE_MEMORY_SAFETY_NOTES_ENABLED` | false（未改） | 有标记安全层；关闭不新增安全读取。 |
| `OPEN_SCIENCE_MEMORY_PEOPLE_ACROSS_PROJECTS_ENABLED` | false（未改） | 人物可跨项目的既有规则，不等于跨账户。 |
| `OPEN_SCIENCE_MEMORY_HISTORY_SEARCH_ENABLED` | true（未改） | 原始会话读来源。 |
| `OPEN_SCIENCE_MEMORY_SEARCH_HINT_ENABLED` / `OPEN_SCIENCE_MEMORY_OPENING_INDEX_ENABLED` | false / false（未改） | 指引/索引按现有运行配置启用；报告未远程读取生产值。 |

安全类型启用不是只改一个 env：用 `deploy/web/openviking/memory-templates-src/build.mjs --safety-notes --out <generation>` 生成单独模板；引擎配置的 `expectedOpenVikingConfiguration({safetyNotes:true,...})` 需要允许该类型，并核对既有账户的类型策略；模板/引擎配置变更需要在另行授权发布中重启引擎。当前任务没有做这些发布动作。已有文件没有 marker 时，重启也不会自动给它们补分类。

### 断言与本地运行

正向与不变项都已落到测试：空/失败/超时/暂停不同；字面救回但不越界、不混同相似名字、已有命中不补遍历；真正空查询仍空；withdrawn 不带原话；普通无工具问项不加 search；条件/归属/材料条款与“明确无条件照实说”；安全层默认关闭、长行不截句、预算小仍提示、其他人物可见范围不变；姓名可编辑/忘记/恢复且邻行、默认导出范围不变。

本地 Node 定向测试逐文件运行，全部通过（397 个测试，含 socket 17、重放 2；每个文件的计数以下列日志末尾为准）。命令形态：`cd OpenScience/apps/server && node --test test/<file>.test.mjs`。

| 文件（server/test 下，除特别注明） | 通过数 |
|---|---:|
| memoryGateway.test.mjs | 124 |
| memoryHistory.test.mjs | 27 |
| memoryHistoryRetrieval.test.mjs | 7 |
| memoryReadStatus.test.mjs（新增，含 env 默认/覆盖） | 5 |
| memorySafetyNotes.test.mjs | 13 |
| memoryOpeningByUse.test.mjs | 11 |
| memoryOpeningIndex.test.mjs | 1 |
| residentProfile.test.mjs | 23 |
| nativeMemoryReads.test.mjs | 8 |
| nativeMemoryForgetTool.test.mjs | 34 |
| nativeMemoryPrivacyErrors.test.mjs | 1 |
| nativeMemoryRejections.test.mjs | 21 |
| nativeMemoryCorrectionsPath.test.mjs | 2 |
| nativeMemoryForgottenRead.test.mjs | 2 |
| nativeMemoryForgetEverywhere.test.mjs | 6 |
| researchContext.test.mjs | 22 |
| capsuleGateway.test.mjs | 23 |
| capsuleNativeExport.test.mjs | 10 |
| agentMemoryNative.test.mjs | 14 |
| agentMemoryApi.test.mjs | 22 |
| agentMemoryMcp.test.mjs | 2 |
| packages/socket/test/memoryEntrance.test.mjs | 17 |
| evals/capsule-proving/replay/read-classes.test.mjs（新增） | 2 |

Web 按单文件、单 fork 运行：FactDrawer.native.test.tsx 15、FactDrawer.test.tsx 21、src/app/copyRules.test.ts 8、layoutRules.test.ts 7、retiredWords.test.ts 200，合计 251 通过。没有改页面排列或增加可选面板；impeccable detector 输出为空，不能代替浏览器视觉验收。修改的服务端源文件 ESLint `--max-warnings 0` 通过；新小模块 memoryReadStatus.mjs 的单文件 checkJs 通过。没有跑完整 tsc，没有拿旧工作区日志当作本次验证。进度记录在 `OpenScience/PROGRESS.md:1`；生成快照在 `OpenScience/evals/harness-adaptation/evimed_h2/data/current-guidance.md:1`。

### 实验室必须跑的文件与操作

使用真实测试数据库逐文件运行以下相邻测试，不能把没有数据库导致的 skip 当通过：

```
apps/server/test/memoryGatewayContext.integration.test.mjs
apps/server/test/memoryHistory.integration.test.mjs
apps/server/test/memoryHistorySources.integration.test.mjs
apps/server/test/memorySafetyNotes.integration.test.mjs
apps/server/test/residentProfile.integration.test.mjs
apps/server/test/nativeMemory.integration.test.mjs
apps/server/test/nativeMemoryStoreScopes.integration.test.mjs
apps/server/test/nativeMemoryOrigins.integration.test.mjs
apps/server/test/nativeMemoryResident.integration.test.mjs
apps/server/test/nativeMemoryForgetRows.integration.test.mjs
apps/server/test/nativeMemoryForgetGateway.integration.test.mjs
apps/server/test/nativeMemoryForgetEverywhere.integration.test.mjs
apps/server/test/nativeMemoryForgetRequests.integration.test.mjs
apps/server/test/nativeMemoryForgotten.integration.test.mjs
apps/server/test/nativeMemoryForgottenHistory.integration.test.mjs
apps/server/test/nativeMemoryRejections.integration.test.mjs
apps/server/test/nativeMemoryProvenanceApp.integration.test.mjs
apps/server/test/nativeMemoryAttribution.integration.test.mjs
apps/server/test/nativeMemoryAttributionApp.integration.test.mjs
apps/server/test/nativeMemorySummaries.integration.test.mjs
apps/server/test/nativeMemoryLifecycleScopes.integration.test.mjs
apps/server/test/nativeMemoryRoutes.integration.test.mjs
apps/server/test/agentMemoryRecall.integration.test.mjs
apps/server/test/agentMemoryNative.integration.test.mjs
```

其余相邻回归：`memoryGatewayNextRound.test.mjs`、`memoryHistorySecrets.test.mjs`、`nativeMemoryPeopleStore.test.mjs`、`nativeMemoryKeepLines.test.mjs`、`nativeMemorySummaries.test.mjs`；以及上表所有已跑文件。Web 还需 `MemoryHubPage.test.tsx`、`MemoryHubPage.native.test.tsx`、`MemoryOverviewPage.test.tsx`、`memoryGroups.test.ts`、`memoryNative.test.ts`、`memoryItems.test.ts`，路径分别在 routes、lib 和 components/memory；完整项目 typecheck、lint 与实际抽屉浏览器检查在实验室执行。重点实测姓名改名→旧文件名/摘要不回流→忘记→再次抽取不恢复→只恢复所选行。

### 离线重放与限制

仓库根目录运行（本地已运行 prepare，没有运行模型）：

```sh
node OpenScience/evals/capsule-proving/replay/read-classes.mjs prepare \
  --packs .lane/packs --out .lane/read-replay
node OpenScience/evals/capsule-proving/replay/read-classes.mjs run \
  --dir .lane/read-replay --answer-module /path/to/lab-answer.mjs --allow-incomplete
```

第二条只供实验室，`--allow-incomplete` 明确表示接受标注的近似上下文；不是精确重放的证明。可用 `--catalog <file>` 补目录，只有哈希匹配才注入。适配器导出 `async answer({qid,messages,tools,toolChoice})`，返回字符串或 `{answer}`；只有 messages 交给回答器，不传 gold、源会话、参考答案。用现有 `checkAnswer` 写判分结果，语义项保留 needs-judge，交实验室原有 scorer；生产没有新增 judge。

准备结果：107 个请求，其中指定成员 46、已记录通过对照 61。每个可用成员都写了文件，但全部成员配同数对照会超过 60 次，所以 manifest 只选择 30 成员 + 30 对照；可以在运行前调整选择，runner 检查相等对照与最多 60。没有假装一次 60 答案覆盖所有指定成员。工具记录按新生产序列化器重排，旧日志没有记下的通道状态为 unavailable/completion_not_in_recorded_trace；不从 gold 或源会话造检索命中。开场预算/权限状态缺失也列在 gaps。新的检索选择行为、字面补查和真实围栏仍需实验室用真检索另验，固定旧工具轨迹的回答重放不能证明它们。

未随当前 A/B 包找到的成员：P08-q007、P08-q008、P08-q048、P08-q049、M01-q016、M02-q016、M03-q015、P01-q018、P01-q019、P05-q019、dev-sc011-q3、P04-q012、s38:q2、s47:q7、M10。脚本逐项列在 manifest.missingMembers；没有给这些成员伪造请求或字面结果。M10 的既有 0/15 证据只引用任务说明，未在这里重新验证。

供复查的离线摘要随报告提交：`.lane/READ-LEXICAL.jsonl`（46 行，不含完整原会话）。证据包、生成的 107 个请求、临时日志不加入提交。
