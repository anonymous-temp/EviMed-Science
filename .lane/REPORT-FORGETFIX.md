# FORGETFIX：忘记内容，不误伤同日记忆

工作分支：`cc/capsule-write-classes-1117`；基线为 WRITE 提交 `d6348f752`。仅本地修改与提交；没有部署、SSH、fetch、reset、push、安装依赖或读取密钥目录。没有新开关，没有修改 `dump-config.baseline.json`。

## 一、人的体验与结论

以前，用户要求“忘掉上个月临时顶夜班，别的都别动”，系统可能把另一条“备用钥匙在蓝色鞋柜第二层”也藏起来。两条话的内容无关，只是都带了“2026-11-17 用户说明”一类出处日期。撤回规则把日期当成了唯一硬标记，读记忆、搜索摘要、开场上下文都会受这个错误决定影响。

现在，撤回原文与待检查文本先去掉明确的出处说明、说话者标签与模板装饰，再比较内容。支持模板中的 `(as of date)`、中英文“说于/说明/陈述/确认”日期、`User believes:`、`用户认为：`、助手建议标签及 source/来源标签；括号样式和位置不决定匹配结果。事件本身的日期、历史值的截至日期、数字与医学指标名仍是内容。尤其不会再把 `**血肌酐:**` 当成可丢弃的出处标签。

无模型的拒绝必须有真实内容依据：内容相等或足够长的完整内容包含；或者全部硬标记相同、至少一个不是日期/年份，且剩下的主题短语也一致。只有日期、年份、小整数或出处的交集不能拒绝另一条事实。更宽的改写交给原来的语义判断；不通过空数组的 `every` 猜测。`血肌酐 132` 的同主题重述仍被屏蔽，`血钠 132` 不会被连带屏蔽。同为 40 分钟的骑车和地铁也不再由数字直接判为同一事实。

已经中招但原文件还在的账号，无需迁移：同一批旧 rejection 行现在重新计算时就会放过邻居。测试直接使用 run A 的一条撤回、七条 history message rejection、原始来源行与空 history fence 记录；备用钥匙原文恢复，夜班原文、改出处日期的副本仍然不显示。旧指纹和已经存在的重新授权回执地址保持不变。

**物理误删风险确实存在，不能把整个问题描述成“只是隐藏”。** run A 的钥匙文件原始 250 字节仍在，因此这个现场证实的是误隐藏，没有证据证明这里发生了误删。但是 `nativeMemoryWorker.mjs:1230` 的提取后清理用的正是错误的 `removalRefusals`，随后会 `replace/remove` 引擎文件；同日期的新提取邻居可能被真正删掉。保留旧行的 guard 也会把错误拒绝当成撤回而不恢复。两者现在共同使用修正后的匹配器，并补了实际 worker 写入后的存留测试。没有检查生产的全部旧 revision，不能断言历史上未发生过物理误删；物理上已经不存在的正文不会靠读时修复自动长回来，应通过已有 revision/undo 另行核对恢复。

`nativeMemoryForgetEverywhere` 原来是完整文本包含加语义判断，没有那个“日期硬标记全中即删”的分支；本次把它的比较也统一为去出处后的内容，并保留较严格的完整包含，**没有扩大为凭一个相同数字就物理删副本**。即时 exact sweep 同样跳过仅有出处或通用数字的撤回内容；延迟 sweep 仍要求语义 verdict 和冻结的文件 hash。

第二个现象不是“忘记文件误触发删除对话”。空文件删除会产生目录摘要失效票据，后台重建摘要时确实持有账号独占写租约；这个租约与真正的对话来源清理共用安全围栏。run A 记录了 notes 与 memories 两张失效票据，`history_fences` 为零。派发在本次修改前就已经按 20 秒总期限轮询等待：+60 秒发起、约 +82 秒拿到 409 与这条路径一致；没有租约现场采样，无法凭现有记录给出引擎重建的确切耗时。

**这里没有虚构一个新的等待修复。** 现有的有界等待符合任务要求，保留不变；短暂清理结束就接受一次提示，超过期限才给可重试 `memory_source_cleanup_busy`。本次修正了“正在清理已删除的对话”的误导文案，改为记忆维护仍在进行，并增加短/长维护两分支测试，包括空文件 forget → 真租约 → admission 的 PostgreSQL 集成用例。真实对话删除的独占围栏没有放宽，摘要重建也没有改为并发无锁；若维护超过 20 秒仍可返回 409，产品路径脚本会按这个可重试码重试并记录次数。

## 二、代码核对与验证

以下路径均相对 `OpenScience/`。状态“修复”包含通过共享函数生效的调用点；“不适用”说明为何没有另写一套规则。

| 同类路径 | 位置 | 结论 |
|---|---|---|
| 出处归一化、内容包含、无模型硬标记判断 | `apps/server/src/nativeMemoryRejections.mjs:67`, `:253`, `:269`, `:363` | 修复：双边去出处；完整内容或值加主题；日期/年份不能单独决定拒绝 |
| 历史授权回执 | `apps/server/src/nativeMemoryRejections.mjs:289` | 保留旧地址算法；新内容比较不使旧回执失效；固定旧 digest 测试 |
| 行枚举与指纹 | `apps/server/src/nativeMemoryRejections.mjs:351`, `nativeMemoryOverlay.mjs:45` | 不适用：是 diff/身份，不是语义拒绝；不能全局重写指纹造成迁移 |
| 硬标记词法与源日期证明 | `apps/server/src/nativeMemoryHardTokens.mjs:27`, `:59` | 不适用：通用证据词法仍需日期；撤回调用点先去出处，历史拒绝不再拿消息时间戳代替正文 |
| 已存在 native 正文 fence | `apps/server/src/memoryHistory.mjs:141` | 共享修复，无迁移；只读，旧行不改写 |
| 历史扫描/出处消息匹配 | `apps/server/src/memoryHistory.mjs:325` | 修复：完整内容判定，余下候选才问 judge，消除日期全中即拒绝 |
| pending scan / 历史摘录与派生文本 fence | `apps/server/src/memoryHistoryPersistence.mjs:212`, `:250` | 修复：同一内容匹配器；未完成扫描也不以日期单独屏蔽 |
| 历史来源整个被撤回、对话删除 | `apps/server/src/memoryHistoryPersistence.mjs:277` | 不适用：完整消息 hash/永久 fence 的证据边界保留，没有删除旧隐私记录或放宽真正删除 |
| read、search abstract、opening | `apps/server/src/memoryGateway.mjs:226`, `:469`, `:907`, `:1332` | 共享修复：均读受 fence 保护的实际正文；不增加读时模型调用 |
| 已写摘要与晚到正文回退 fence | `apps/server/src/nativeMemorySummaries.mjs:107` | 共享修复：完整包含走 `containsRemoved`；不改变已确认正文授权或摘要可见性 |
| 提取/合并/重放后的拒绝与实际删行 | `apps/server/src/nativeMemoryWorker.mjs:1230` | 共享修复；新增真正写入 worker 的集成回归，确保钥匙留在引擎及 overlay |
| 未解释旧行的恢复与撤回优先 | `apps/server/src/nativeMemoryWorker.mjs:971`, `nativeMemoryKeepLines.mjs:77` | 共享修复；保留 guard 不重新学回真的被忘行；其 replacement 的 hardTokens 是保留细节判定，不是撤回匹配 |
| 验证更正/合并后的重写 | `apps/server/src/nativeMemoryVerification.mjs:263`, `nativeMemoryWorker.mjs:1034` | 共享修复；verifyLines 的数字有无来源证明不是撤回规则，保持不变 |
| ROBUST 的恢复前隐私清理 | `apps/server/src/nativeMemoryWorker.mjs:1475` | 共享修复；没有打开 ROBUST，也没有改其准入政策 |
| 文件名规范合并/undo 的检查 | `apps/server/src/nativeMemoryNames.mjs:68`, `nativeMemoryStore.mjs:939` | 共享修复：继续调用相同拒绝规则 |
| 含撤回词的路径改名 | `apps/server/src/nativeMemoryStore.mjs:1443` | 修复：路径决策的原文及新正文先去出处，不能因注记日期而改名 |
| 即时冻结清单/精确副本删除 | `apps/server/src/nativeMemoryStore.mjs:1720`, `:1729` | 修复：去出处的相等比较，排除仅有日期、数字、来源标签的“内容” |
| 其他文件副本删除 | `apps/server/src/nativeMemoryForgetEverywhere.mjs:45` | 修复：共享去出处包含，不截短到 400 字再匹配；仍然只以完整包含确定删除，宽泛改写需 judge |
| 延迟副本删除 | `apps/server/src/nativeMemoryStore.mjs:1772` | 不适用：语义 verdict + 原始 hash，未用日期硬标记作删行证据 |
| 账号导出、被替换的灰色旧行/历史版本 | `apps/server/src/nativeMemoryAccountExport.mjs:28`, `memoryMapSources/replacedStatements.mjs:72` | 共享修复：去出处包含；原来没有日期-only 的 hard-token 分支；来源删除的独立过滤保留 |
| 空文件删除与摘要失效 | `apps/server/src/nativeMemoryStore.mjs:1923`, `nativeMemorySummaries.mjs:52`, `:75`, `nativeMemoryWorker.mjs:295` | 不适用：真实摘要维护，应保留独占租约，不能把它当误入的对话删除状态移除 |
| 派发等待 | `apps/server/src/pluginService.mjs:335`, `:628`, `:639`, `:662` | 保留既有 20 秒有界轮询，只修正文案；短/超时两分支都加验证 |

模板依据：`deploy/web/openviking/memory-templates-src/profile.yaml:72` 的 as-of 格式；`notes.yaml:25` / `people.yaml:39` / `project_context.yaml:88` 的 User believes 标签；`extraction-v2.mjs:7`, `:10`, `:13` 的历史值、观点、助手建议标签；以及 run A 原始两条 notes。此次没有改模板或开关。明确带标识的出处与事件自身的日期分开处理，不擅自把所有括号内日期抹掉。

### 新增或扩展的测试

- `test/nativeMemoryForgetNeighbours.test.mjs:1`：7 个本地回归，覆盖括号/位置矩阵、标签、旧行自愈、原文/换日期/跨文件副本、数字带主题、保留 guard、历史 pending fence、旧回执与导出。
- `test/fixtures/forget-neighbours-run-a.json:1`：从 `.lane/forgetfix/out2-attempt1/pp-recheck-2.json` 精简出的真实合成账号行（1 条撤回、7 条消息拒绝、3 条源行、3 条写消息、0 条 history fence），不是生产个人资料。
- `test/nativeMemoryForgetGateway.integration.test.mjs:766` / `:788`：已有 run A rejection 自愈；p6c 四事实中对两个作 statement forget，read/search abstract/opening 保留另外两条。原 `:675` 附近的真实 p6c 一次 lines + 两次 statement 原始场景继续保留。
- `test/nativeMemoryRejections.integration.test.mjs:137`：提取后真正落盘检查，不只看可见性；钥匙保留，重新提取的夜班副本删掉。
- `test/nativeMemorySummaries.integration.test.mjs:213`：空文件删除后不产生对话 history fence；真实独占租约短暂结束则提示继续、超过期限则 409，释放后下一条正常。
- `test/pluginAdmissionWait.test.mjs:149`：超时必须等到界限，不执行提示、不写 acceptance，代码可重试且文案不虚构删除对话；原短暂维护等待测试继续通过。
- `test/nativeMemoryForgetTool.test.mjs:283` 的故障夹具改为真正的语义改写，避免拿已可精确匹配的原文冒充“必须问模型”；`:438` 增加来源标签/日期/小整数不能作为跨文件删除依据的测试。

### 本机实际结果

逐文件执行，没有全套 suite、安装依赖或完整 tsc。日志在 `.lane/forgetfix-checks/`。

标准命令（工作目录 `OpenScience/apps/server`）：

```sh
node --import ../../../.lane/fixmem-imports.mjs --test test/<file>.test.mjs
```

**16 个文件合计 320 项通过**（不重复累计中途重跑）：

| 文件 | 通过数 |
|---|---:|
| automatedDrivers.test.mjs | 2 |
| memoryForgetPropagation.test.mjs | 8 |
| memoryGateway.test.mjs | 121 |
| memoryHistory.test.mjs | 26 |
| memoryHistoryRetrieval.test.mjs | 6 |
| memoryHistorySecrets.test.mjs | 5 |
| memoryMapReplaced.test.mjs | 22 |
| nativeMemoryForgetEverywhere.test.mjs | 6 |
| nativeMemoryForgetNeighbours.test.mjs | 7 |
| nativeMemoryForgetRequests.test.mjs | 7 |
| nativeMemoryForgetTool.test.mjs | 35 |
| nativeMemoryKeepLines.test.mjs | 19 |
| nativeMemoryRejections.test.mjs | 21 |
| nativeMemorySummaries.test.mjs | 8 |
| nativeMemoryVerification.test.mjs | 17 |
| pluginAdmissionWait.test.mjs | 10 |

测试限制不能算通过：

1. `nativeMemoryForgetTool.test.mjs` 的 ZIP 用例因为给定 `.lane/fixmem-imports.mjs` 用会抛异常的 `fflate.zipSync` 替身而不能执行；确认其他断言后使用 `--test-skip-pattern 'AL8 native ZIP'` 得到上述 35 项通过。实验室必须跑完整文件，不带这个排除。
2. `pluginAdmissionWait.test.mjs` 先因缺少 `pg` 无法加载；追加本地 `.lane/forgetfix-pg-import.mjs` 后 10 项通过。这个导入适配只提供一个构造时就抛错的 Pool，测试仍注入它本来使用的假数据库/假 pool，**没有伪造真数据库结果**。实验室不得使用这个适配。
3. `nativeMemoryRejections.integration.test.mjs`、`nativeMemoryForgetGateway.integration.test.mjs`、`nativeMemorySummaries.integration.test.mjs` 尝试执行后均因缺少 `pg` 在加载阶段失败，未执行集成断言（不是数据库通过，也不是自动 skip）。
4. `accountExportNative.test.mjs` 加载失败：缺少 `@evimed/harness-port`。新增小测试直接验证 native export 内容投影，但不能代替完整账号导出测试。
5. 修改/新增的 13 个 `.mjs` 文件 `node --check` 通过，产品路径脚本 `--help` 通过，`git diff --check` 通过。未运行 ESLint/checkJs，留实验室。

### 实验室必须运行（真实数据库、完整依赖）

工作目录 `OpenScience/apps/server`，使用实验室已有的 `OPEN_SCIENCE_TEST_POSTGRES_URL`（独立 `evimed_test*` 数据库），每次仅一个文件：`node --test test/<下面的文件名>`。不要使用本机的导入替身或 ZIP 排除。下面包含要求的全部邻居及共享包含规则的额外消费者；再运行仓库规定的 lint / server checkJs。

```text
accountExport.test.mjs
accountExportNative.test.mjs
agentRunAdmission.integration.test.mjs
automatedDrivers.test.mjs
conversationSourceDeletion.integration.test.mjs
conversationSourceDeletion.test.mjs
conversationSourceDeletionApp.integration.test.mjs
learningBackgroundWork.test.mjs
memoryDispatch.test.mjs
memoryForgetPropagation.integration.test.mjs
memoryForgetPropagation.test.mjs
memoryGateway.test.mjs
memoryGatewayContext.integration.test.mjs
memoryGatewayNextRound.test.mjs
memoryHistory.integration.test.mjs
memoryHistory.test.mjs
memoryHistoryRetrieval.test.mjs
memoryHistorySecrets.test.mjs
memoryHistorySources.integration.test.mjs
memoryMapReplaced.test.mjs
nativeMemoryApp.integration.test.mjs
nativeMemoryForgetEverywhere.integration.test.mjs
nativeMemoryForgetEverywhere.test.mjs
nativeMemoryForgetGateway.integration.test.mjs
nativeMemoryForgetNeighbours.test.mjs
nativeMemoryForgetRequests.integration.test.mjs
nativeMemoryForgetRequests.test.mjs
nativeMemoryForgetRows.integration.test.mjs
nativeMemoryForgetTool.test.mjs
nativeMemoryForgottenHistory.integration.test.mjs
nativeMemoryKeepLines.integration.test.mjs
nativeMemoryKeepLines.test.mjs
nativeMemoryNames.test.mjs
nativeMemoryRejections.integration.test.mjs
nativeMemoryRejections.test.mjs
nativeMemorySummaries.integration.test.mjs
nativeMemorySummaries.test.mjs
nativeMemoryVerification.test.mjs
nativeMemoryWorkerScopes.integration.test.mjs
nativeMemoryWriteFence.integration.test.mjs
pluginAdmissionWait.test.mjs
pluginService.integration.test.mjs
pluginService.test.mjs
runtimeMemoryDispatch.test.mjs
runtimePromptAdmission.test.mjs
```

### 产品路径脚本用法

新增已跟踪文件：`OpenScience/evals/capsule-proving/pp/forget-neighbours.mjs`。在已启动且具备本地注册、原生记忆及 forget 功能的实验室 control plane 上运行；脚本本身不启服务、不读取 provider key、不调用原始 engine：

```sh
cd OpenScience
node evals/capsule-proving/pp/forget-neighbours.mjs \
  --base http://127.0.0.1:48859 \
  --data-dir /path/to/existing/lab-harness-data \
  --out /path/to/forget-neighbours-results
```

`--data-dir` 必须是已有 harness 的数据目录，包含 `users/<id>/projects/<project>/.openscience/transcripts/`；`--base` 只接受回环地址。脚本新建合成账号、项目，派发标记 `automated: true`，沿产品允许的记忆路径运行。保存账号标识、每次 run 的完整 transcript、工具输入输出、opening block、回答、请求实际偏移、409 重试次数及每项判定于输出目录，账号保留供实验室核查。

流程：一次消息陈述过敏/钥匙/游泳/夜班；等待四条均可读取且夜班确实带日期（否则明确 PRECONDITION FAIL，防止 run B 假阳性）；新对话忘记夜班，要求 tool 确实删除空文件；从 forget 完成时间起 +10/+60/+180 秒发起新对话，要求 search/read 并问三个邻居及夜班次数。若上一轮耗时跨过目标点，记录实际偏移，不伪造准点。各次同时检查回答和工具/opening 内容；输出逐次 PASS/FAIL，整体验证失败 exit 1。明确的 `409 memory_source_cleanup_busy` 在最多 180 秒重试窗口内用同一 dispatchId 重试，不重试不明传输失败，也不重复已接受的提示。

此脚本本机只做了语法与帮助检查，**尚未在实验室或生产跑真实产品复验**。本次提交可供合入/实验室验证；实际上线及全库历史物理误删核对不属于此次本地授权。
