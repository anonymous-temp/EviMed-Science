# EVAL2：测量错误类别修复

基线 `github/main = 717308708`；工作分支 `cc/capsule-eval-class-1117`（开始时已存在，HEAD 与指定基线一致）。只改 `OpenScience/evals/capsule-proving/` 和本报告；没有 fetch/push、SSH、部署、安装依赖、模型调用、网络请求或密钥读取。没有改产品代码、产品权限或资源围栏。

## 第一部分：结果、同类扫描和未完成项

### 1. 错题档案绑定和证据保全

以前按 plantId 拼档案会把另一个用户的 gold 接上来；现在新增 `run/dossier.mjs`，直接复用 scorer 的 gold loader、case evidence loader、questionContext、snapshotFor、storeEvidence，不另写 checkpoint 选择规则。每个 pack 的身份是 `(runId, caseId, kind, id, checkpoint)`，另记 scoreDirectory 以区分同一 run 的多个评分变体；gold 只能来自该 case，重复 case、错绑 answer、错 run、含糊 packet 和结果 hash 不符均拒绝。

档案保存整条原 answer（问题、回答、opening、全部工具参数/返回值），以及所有 answer 变体的原记录、该 case 完整 gold、checkpoint 前的完整来源会话、原快照、主体检查快照、证据会话 ingest、case maintenance、可绑定的 root maintenance 和 judge packet/result。没有原答的 store 不被假装成聊天问题；缺失证据逐项列在 missingRecords。每个导出的证据记录也带同一完整身份。默认拒绝名称或 symlink 目标含 sealed 的读取，只有显式 `--allow-sealed` 可放开；不会用该参数调用评分器或更改评分器的开发集限制。

使用：`node run/dossier.mjs --run RUN --data DATA --out NEW_DIR [--scores SCORE_DIR] [--allow-sealed]`。没有重新导出或重评分历史实测数据，因此不声称已经把旧档案的 547 条错绑行逐条迁移。

动手前扫描过的同类连接点，以下是最终状态（行号为本次版本）：

| 位置 | 状态 | 处理/理由 |
|---|---|---|
| `run/score.mjs:99,214,282,319` | 不适用：原来已正确 | gold、答案、plant、schedule 和 snapshot 查找在单 case 内；没有全局 plantId cache |
| `run/score.mjs:635`、`run/judgePackets.mjs:63` | 已修 | score row 与 packet 身份补 checkpoint；唯一性检查同步，老六字段 packet 仍可读取 |
| `run/score.mjs:645`、`run/errata.json:2` | 已修 | errata 加 case/kind/checkpoint，重复 qid 不再误伤同 set/split 的另一个用户 |
| `run/rejudge-stores.mjs:22` | 已修 | 仍用完整 rowKey；重新评审时把有 captured packet 的旧 fail/unknown 显式设为 review，保留原判，排除尚未 ingest/未观察到的记录 |
| `results/paired.py:17`、`em/loo-table.py:19`、`results/score_rows.py:2` | 已修 | 两臂分别索引 set/split/case/kind/id/checkpoint；重复身份报错，unknown 不转成 false，报告 shared/observed/缺臂成员规模 |
| `em/patient-pilot.mjs:13` | 已修 | 原 id-only 重审选择补显式 caseId，并要求唯一结果 |
| `run/forkAnswers.mjs:41,69` | 不适用 | sourceCases 按 case 匹配，续跑 step key 含 caseId |
| `run/corruptions.mjs:279,283`、`synthetic/spec.mjs:136,258,282,308` | 不适用 | 输入是一个用户的 skeleton 或一次 corruption 应用，局部 id 合法；9 条 corruption 回归通过 |
| `run/ledger.mjs:120,326` | 不适用：原合并键正确 | ledgerId 对完整 canonical row（含 run/set/arm/scorer 等）做 hash，不是按 plant/qid 覆盖；本次另保留红线成员 |
| `experiments/pasted-labels.mjs:24`、`pasted-replay.mjs:73`、`pasted-paired-summary.mjs:7,14,25` | 不适用 | label id 是 case+正文+来源的 digest，录制 id 含 run/case/session/rep，不是可跨用户重复的 plantId |
| `offlineJudge.mjs:18,59`、`run/historyRetrievalProbe.mjs:56` | 不适用 | 前者使用其独立 fixture 的全局 id 和整个 source 的 hash；后者在一次 case 的 registry 内连接 engine session |

### 2. Store 不再按聊天答案判分

11-15 已有 store rubric，本次保留并补齐类别：正向 retention、history、forgotten、never-stored、subject/attribution 和 memory 侧 entity red-line 都走 store 规则。旧 store packet 若仍绑定 answer rubric，发请求前就要求升级；不会再发送给聊天 judge。历史结果可以读，显式重审会重新绑定并写新 hash。

`not_ingested_yet` 现在是单独 verdict，store recall 的分子、分母都不包括它，summary 和 ledger 单列数量与成员。已 ingest 但没采到快照是 `unobserved`，仍在原观察范围内。普通文字的字面 miss 只触发语义评审，stored 不先写成 false；语义 judge 确认缺失后才是 false。硬秘密的确切出现仍是有效机械证据，没有为了变好看而削弱。

兄弟已一起检查/修改：`run/scoreChecks.mjs:225` 所有 store 类别、`run/judgePackets.mjs:154,190,283` 主 store 和 store redline、`run/rejudge-stores.mjs:24` 的旧结果、`run/score.mjs:408,757` 的两层 recall 和 `run/ledger.mjs:785` 的 ledger。没有将 QA 和 store 的分母混在一起。

### 3. 公共题目与证据一致性

新增逐题离线检查，覆盖金标准缺乏所给证据的字面支持、记录日期冒充事件日期、多正确答案配单选 rubric、brand/generic 的中英文锚点/回复不一致、以及 abstention 的候选答案已出现在来源会话。输出 `scores*/quarantine.json`；手工 errata 保留且身份范围明确。

这类检查本身不能再制造错误：词语未逐字出现、翻译、出现候选答案、日期可疑都只是 `review`，不自动判产品错，也不缩 valid 分母。只有多答案/单选的明确结构矛盾，或数据本身明确同时标为 answerable 的矛盾，才自动 quarantine。保留 n/accuracy 和 nValid/accuracyValid（含各自 Wilson 区间），不悄悄减少总分母。引用 session id 的 LoCoMo evidence 不当成答案正文；每个问题只检查该 checkpoint 及日期之前的源材料。

兄弟：`inputsLearning.mjs:39,64` 与 `inputs.mjs:76,236` 的原始 gold 保留（不适用：不改 benchmark 原数据）；`run/publicSets.mjs`、`run/publicJudge.mjs` 的官方内容保留（不适用：不替换官方标准）；`run/dataCheck.mjs:22`、`run/score.mjs:684,824` 统一产生审核清单。未跑缺失本地 corpus 的八项 public fixture；不能宣称已经找全真实公开集中的题目错误，也未生成新准确率估计。

### 4. 工具链模拟器

在 11-15 已实现的换算/日期计算、event/message/file readback 基础上，补齐 drug normalise 保留原药物、稳定 today、目录下文件 root、相同对象的读回和跨调用 world。每个回答臂有独立 world，不把上一个臂的写入带给下一个臂。

参数按工具 schema 比较，支持数字格式、单位别名、等值的长度/质量输入、路径 `./` 和已知 bilingual 药名，数字 ID 不再被数值归一吞掉前导零。确定性工具接受并计算新的合法验证参数；对象读取只接受同一 world 中存在的对象，不把随便一个错误 ID 当作正确结果。

分别报告 finalTaskCorrect、prescribedPathFollowed、extraCalls；保留 legacyStrictPass/legacyStrict 专名列。只读工具的额外核验、包括反向换算，不会擦掉已经完成的目标计算；目标 write 后又写错内容仍失败。这里的 finalTask 是最后目标工具操作的正确性，不冒充最终自然语言答案或所有现实服务的完整语义正确性。

兄弟已修：`synthetic/toolverse/env.mjs:58,90,193`、`score.mjs:24`、`l8/answer_l8.mjs:56,115`、`l8/score_l8.mjs:9,38`。`synthetic/toolverse/run.mjs` 是 corpus 构建入口，自动使用同一 env，无另一套 simulator。历史冻结任务、历史分数和 ledger 未重写；现有旧随机 fixture 如需重用，仍应按新 env 重新构建并留 pin，不能把本次离线测试当成对它们的新实测认证。

### 5. C1 文本游戏

ALFWorld 改为请求并展示环境返回的 admissible_commands，删除手写的错误 put 文法；ScienceWorld 从环境的合法 action 接口读取。每步记录当时合法命令、实际 action、是否 admissible，拿不到列表时明确记录缺哪条证据。

保存逐卡的完整原文字、展示/包含状态和文本 hash；read_skill 另记详情文件读取事件。是否真正被模型理解/注意不能观察，textRead 保持 null，不把展示冒充阅读。每局记录 success、step-limit、invalid-action-loop、early-terminal-state 和分数，采集异常是 unobserved。invalid-action-loop 只在原 step cap 到达后作诊断，没有提前停止或改变 agent 的循环预算。

兄弟：`c1/run_c1.py:20,54` 两个 adapter、`c1/loop.py:122` 单一 agent loop（已修）；`c1/build_library.mjs`、`product_provider.py` 是学习/选择已有卡，不应为了测评修改被测知识（不适用）；`learn/gameTranscript.mjs:21` 是动作转 transcript，并不提供游戏命令（不适用）。报告所述“先拿两个再放”的原长卡不在本仓库，未伪造卡修订或宣称其内容已修好，新记录可用于核对这种卡。

### 6. 产品路径生命周期——实现了可用路径，P7/P8 原脚本仍缺失

`git ls-tree` 和文件扫描均没有找到要求中的 P7/P8 或 pp 目录。新增有界 lifecycle helper：删除回执必须显式 settled 才 dispatch；pending 到界限是 timeout；cleanup_busy 最多三次重试；404 先重新检查自己拥有的具名项目，不能“换个最新项目”；资源拒绝、timeout、unobserved 与真实 task-failed 分开。

现有 `lx/conversation.mjs` 已接入具 run id 的项目名、拒绝复用别的评测项目、有界 dispatch/404 复核、缺 transcript/超时分类；恢复同一会话保留原 evalRunId。测试确认不会因 409 误认项目、不会因 404 采用另一个项目。

同类扫描：`p32/product.mjs:60` 委托 scope 外的 general-tasks runner（留待其所属范围，未改）；`l3b/run_l3b.mjs:115` 调用 LX（已由共用路径覆盖）；`c2/run_c2.mjs` 的缺评分/后处理分类在第 9 项修复。**P7/P8 的真实脚本未能修改或验证；waitDeleteSettled 的真实产品回执 adapter 也不能在缺失的脚本中接入。** 当前 LX 没有执行删除，未编造一个产品完成信号或跳过 fence。此项不能报告为全部完成，是整体派工仍有缺口的原因。

### 7. 不可观察不是错误，红线必须有成员

主评分器把缺 answer、错误采集、缺 snapshot、缺成功 secret probe、缺 forget receipt 分开命名为 unobserved；完整记录中真的空白回答仍可以错误，不会全部变未知。缺工具返回值时 trace 的 retrieved 是 null；缺快照 stored 是 null，不再由 `!null` 记成 not_stored。

新红线 summary、按 set/type/place 的计数和 forget reappearance 都带 case/id/checkpoint 或 trialId。G4 缺删除状态的记录单列；G5 没跑到的 probe 不再当成“已拒绝/已隐藏”。新 ledger 红线计数缺成员会拒绝；旧 summary 的非零无成员计数保存为具名 legacy_redline_count / legacy_forgotten_reappeared_count，并标 unobserved，而不把它认证成新的错误数。原历史 ledger 不重写。

兄弟已修：`run/score.mjs:246,408,480,674,743`、`run/judgePackets.mjs:66`、`run/scoreChecks.mjs:235,273`、`redline/classify.mjs:196,314`、`run/ledger.mjs:171,798` 和两个 Python paired 脚本。`redline/common.mjs` 的 cap 计数是调度预算、不是错误计数（不适用）；`sb/report.mjs:18-26,86` 已区别 verifier 错误/缺 reward（不适用）；`c1/summarize.py` 的历史成功率不能补出未采到的原 action，新 trajectory 保存完整诊断（未重写历史分数）。

### 8. 追加：store scope 和全 code-check 通过后被聊天评语推翻

来自协调者追加消息 `msg_17595bf278aa`。追加前的两个失败测试复现：profile.md 中已存的 self 事实因为存在 preferences/self 文件被漏计；全部 code checks 通过却被“The reply is empty”判 fail。

self 现在检查该用户拥有的全部快照文件，包含 profile/preferences/notes/follow_ups/observations/projects。具名人物使用明确人物文件（完整名称/slug，非子串）以及任意其他文件中明确提到该人/已记录别名的行；没有命中时保留空 scope，不默默退回全用户。每行 score 写 scope.files、模式、labels、原行号和 fallback:false。A 的值只存在 B 的文件时不会被借来给 A 算 stored，语义 judge 仍可确认真失败。

store judge 若想推翻全通过的 code checks，必须拿到被存行和原种植语句，并在 storeEvidence 中逐字给出两者、说明 meaning/attribution 的差异；空 reply 或没给差异证据的判错只变成 unobserved/缺 store-judge-mismatch-evidence，不能成为失败。新 prompt/response schema、checkpoint hash 和显式 rejudge 一并更新。

同类扫描：唯一对 store 作 subject-path 子串过滤的是 `scopeMemory`（已修 `run/score.mjs:341`）；memory side entity redline 和 dossier 都调用同一函数（已修）。`redline/scan.mjs` 查路径里的删除标记，测的是隐私可访问性而非事实归属（不适用）；`run/lab.mjs:856` 的 openingListing 只是开场目录读取（不适用）。未改产品存储布局或抽取逻辑，395 条历史错判规模来自协调者，本任务没有对旧 885 行重新测量。

### 9. 追加：DA-Code 绘图后处理故障被记成分析零分

来自协调者追加消息 `msg_3ee88163e3ef`。初始 repo 没有 basch 字面量，也没有 vendored 的 da_agent/configs/post_process.py；自己的 `official()` 导入外部官方 plot_process，其命令经 SandboxContainer 执行。故在我们拥有的 wrapper 修复，未改外部 pin：将官方命令前导 basch 改 bash，将已知的 cd /workspace 适配到该次产品 workspace，支持字符串和 argv 形式，记录 originalCmd、规范化命令和每项 normalization。仍使用原 sandbox/权限参数。

每个后处理 subprocess 的非零、timeout、无法启动及官方 post-process exception 都成为 `post-process failed: <stderr>`，score/pass 为 null，outcome=post-process-failed。官方 evaluator 异常/缺结果是 scorer-failed；这些不再落入 reasoning。完整产物（包括已存在的 result.png）照样保存。后处理成功而确实错误的图仍由官方零分判失败。aggregate 显式保存全部/可评分/排除的 task ids，主汇总总分母保留，valid-only 单列；不把未执行的仪器步骤认证为分析失败。

检查了脚本要求：我们自己的 wrapper 不要求固定文件名；已有 scorer 注释明确它找顶层 .py 内的 plt.savefig，而原 prompt 只有 PNG 交付要求。现在 plot_process 任务明确要求留下可重放的顶层 .py（any filename），避免隐藏格式条件。外部完整源码未在本机，不能声称独立审阅了其所有识别分支或重新跑了那 11 个真实 plot pack。

修改前扫描并一起处理/登记的兄弟：

| 位置 | 状态 | 原因/结果 |
|---|---|---|
| `c2/score_dacode.py:75,140,194,216` | 已修 | 内部子进程失败、hook 失败、evaluator exception 都不是零分 |
| `c2/run_c2.mjs:98,133,272,294` | 已修 | 缺答采集/缺 verdict/子进程非零即使有旧 verdict 也不能拿来当错答；保存 priorVerdict 和 stderr |
| `c2/run_c2.mjs:531,535` | 已修 | aggregate 非零另记 scorer-failed，不只丢一个 exit code |
| `c2/score_dabench.py:67-74` | 不适用：本来已报错退出 | 调用方已修复对退出的解释 |
| `c2/benches.mjs:64` | 已修 | 显式告知可重放 .py/plt.savefig 要求；未强加特定 basename |
| `sb/run.py:151`、`sb/report.mjs:18-26,86` | 不适用：已有分离 | passed:false 仍附 official；汇总用 scored:false 区分 verifier_error/缺 reward，并不记 reasoning |
| `p32/product.mjs:24`、`l3b/run_l3b.mjs:62` | 不适用 | seed 失败停止任务，不产生分析分数 |

### 没有完成或没有认证的工作

- 必做第 6 项的 P7/P8 原脚本缺失，无法修其真实删除/重试编排；已补 helper 和可见的 LX 同类路径，但不把它冒充 P7/P8 完成。
- 没有跑真实产品、游戏、官方外部绘图 hook、公共 corpus 全量重审或任何模型；没有新基准准确率和“真实错误少了多少”的结论。
- 公共题目的语义支持、事件日期和翻译是否正确只能离线列 review，未把字面不符自动当作坏题。原 C1 长卡和历史错误档案不在本次可用输入，未重写。
- 有关规范化、模拟器和仪器异常的改变只影响以后新评分；不篡改历史 raw、冻结 fixture、official benchmark pin 或旧 ledger。

## 第二部分：修改定位和实际验证

路径均相对 `OpenScience/evals/capsule-proving/`。上面每项已给主实现位置，新增/关键变更定位如下：

| 修改 | file:line |
|---|---|
| 档案 CLI、sealed/symlink guard、完整绑定和原始证据 | `run/dossier.mjs:12,30,61,103` |
| 复用 scorer evidence/checkpoint 接口、checkpoint 身份 | `run/score.mjs:214,233,282,319,635`；`run/judgePackets.mjs:63` |
| 逐题数据检查、errata 合并及输出 | `run/dataCheck.mjs:10,22`；`run/errata.json:2`；`run/score.mjs:684,824` |
| Store 字面 miss 未决；not-ingested 分母、主体 scope | `run/scoreChecks.mjs:235,255`；`run/score.mjs:341,408,757` |
| Store-only guard、差异证据、rejudge 和 hash 验证 | `run/judgePackets.mjs:44,190,247,283`；`run/rejudge-stores.mjs:22` |
| 缺记录、红线成员、legacy 无成员标签 | `run/score.mjs:246,408,480,743`；`run/judgePackets.mjs:66`；`run/ledger.mjs:171,785,798`；`redline/classify.mjs:196,314` |
| 跨臂 case 键、重复拒绝和 unknown 配对 | `results/score_rows.py:2,6`；`results/paired.py:13`；`em/loo-table.py:16`；`em/patient-pilot.mjs:13` |
| 工具 world/参数语义、三种测量和旧严格列 | `synthetic/toolverse/env.mjs:58,90,193`；`score.mjs:24`；`l8/answer_l8.mjs:56`；`l8/score_l8.mjs:9,38` |
| 游戏词汇、admissibility、卡证据、终止原因 | `c1/run_c1.py:20,54,155`；`c1/loop.py:122,143,164,204` |
| 产品调用有界生命周期和既有 LX 接入 | `run/productLifecycle.mjs:5,14,24`；`lx/conversation.mjs:19,45,78,99` |
| DA-Code 命令规范化和独立失败状态 | `c2/score_dacode.py:75,140,194,216,236`；`c2/run_c2.mjs:98,133,170,272,531`；`c2/benches.mjs:64` |

失败先行证据保存在未提交的 `.lane/*.before.log`：初始新导出/数据检查/lifecycle 接口缺失；C1 2 条失败；追加 item8 的 2 条失败；redline 3 条失败；反向换算额外核验失败；C2 JavaScript 2 条、Python 2 条失败。其后保留测试断言，修复后全部通过。原 tests/run-score 的断言随明确的新 verdict、带成员指标及 rowKey checkpoint 变更更新；不是删除真错断言，真错误的 dose/entity/citation/patient/store/plot 仍覆盖。

最终验收测试逐文件、顺序执行，临时目录设为工作区 `.lane/tmp`，没有 package test script 新增，因此没有新增绕过 localhostProbeGuard 的脚本。结果日志为 `.lane/<name>.final.log`，没有提交运行日志或临时文件。

| 实际运行的 Node 文件 | pass | fail | skip |
|---|---:|---:|---:|
| `tests/run-score.test.mjs` | 89 | 0 | 0 |
| `tests/run-store-rejudge.test.mjs` | 3 | 0 | 0 |
| `tests/run-corruptions.test.mjs` | 9 | 0 | 0 |
| `tests/run-ledger.test.mjs` | 26 | 0 | 0 |
| `tests/run-official.test.mjs` | 2 | 0 | 0 |
| `tests/run-public-memory.test.mjs` | 6 | 0 | 8 |
| `tests/toolverse.test.mjs` | 12 | 0 | 0 |
| `tests/l8-runner.test.mjs` | 10 | 0 | 0 |
| `tests/redline-classify.test.mjs` | 17 | 0 | 0 |
| `tests/run-measurement.test.mjs`（新增） | 7 | 0 | 0 |
| `tests/run-dossier.test.mjs`（新增） | 3 | 0 | 0 |
| `tests/run-data-check.test.mjs`（新增） | 3 | 0 | 0 |
| `tests/run-product-lifecycle.test.mjs`（新增） | 3 | 0 | 0 |
| `tests/redline-measurement.test.mjs`（新增） | 3 | 0 | 0 |
| `tests/toolverse-consistency.test.mjs`（新增） | 4 | 0 | 0 |
| `tests/c2-measurement.test.mjs`（新增） | 2 | 0 | 0 |
| `l3b/conversation.test.mjs` | 3 | 0 | 0 |
| `c2/run_c2.test.mjs` | 9 | 0 | 1 |
| Node 合计 | 211 | 0 | 9 |

Python 逐文件：`cd c1 && python3 -m unittest test_measurement.py`（新增，2/2）；`test_loop.py`（9/9）；`cd c2 && python3 -m unittest test_postprocess.py`（新增，2/2）；harness 根目录 `python3 -m unittest discover -s tests -p test_paired_measurement.py`（新增，2/2）。Python 共 15/15，无失败。总计 **226 passed、0 failed、9 skipped**；skip 是本机缺失固定 public corpus / 官方 DABench 源码。所有 provider/API/subprocess 路径均为 fake/mock，Python 后处理回归没有执行 shell、容器或官方外部 evaluator。

`git diff --check` 通过。全部代码/注释为英文；本报告按要求用中文。本地提交保留基线可审查差异；没有推送。整体派工回报会明确第 6 项缺原脚本，不能写“全部完成”。
