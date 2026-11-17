# WRITE 写侧类问题修复报告（2026-11-17）

工作分支：`cc/capsule-write-classes-1117`，基线：`github/main` / `717308708`。仅在指定 worktree 修改、测试和本地提交；未部署、未 SSH、未 fetch/push、未读密钥目录。ROBUST 以及 basic 粘贴检查的开关默认值和判断实现均未改。

本次有可审查实现、默认模板产物、单测、待实验室执行的数据库集成用例和离线回放，但**不宣称任务全部关闭**：W-DUP 做到引擎写完后的确定性归并，未做到引擎创建前重定向；真实提取模型的新增行数和来源误改率未测。以下逐项说明边界。

## 第一部分：问题、同类路径、现在的行为和剩余项

### W-DUP：同一个名字因空格、下划线或标点变成两个文件

先扫了模板文件名字段（project/person/topic/category/name）、提取结果的 adds/updates、project tag、people 的确认别名与 redirect、consolidation、页面 memoryGroups/memoryNative 分组。名字实际由 OpenViking 模板和其提取器选择，服务端收到的是已经写入的 diff；project tag 是作用域信息，不是重命名机制；页面只分组展示，不能阻止第二份写入；people 的同人判断有独立的显式确认流程，不能用模糊相似度替代。

新增格式归并只认 NFKC、大小写、空白、下划线/连字符和 Unicode 标点折叠后的相等，保留路径层级、类型、人物区分后缀及 projectId。个人命名空间内不同类型不合并；项目命名空间也不跨边界。归并保留稳定旧路径，最近日期的正文先放，旧正文每条不同陈述原样保留；日期相同时用更新时间。先复制来源链、留撤销版本并刷新摘要，再移除冗余路径；没有语义去重。源删除处理中、敏感文件、撤回命中、正文并发变化、超过既有正文大小上限均跳过。每轮最多 32 对。

已加测试证明正文和来源都留下、重复执行幂等、不同项目/类型/人物后缀/敏感/撤回不混并。`恩布格列净/恩格列净`、`诊断/鉴别`等不是格式相等，仍留给有来源依据的整理。本次没有把这些拼写不同项自动并成一人或一物。

**剩余**：不是“创建前写入现有文件”。上游引擎自己异步创建，当前服务端没有提取写入前的目标路径钩子。实现接在提取 ingest 尾部和 worker account pass；窗口内两个路径仍可能同时被读到。合并异常留下可读原文并可在后续 pass 重试，不隐藏任何一行。要彻底关闭创建前窗口，需上游提供目标路径解析接口或在上游实现相同规则，不能用控制面事后整理冒充已完成。日期排序是字面日期顺序，不是对“截止日期/状态日期”的语义判断。

### W-HIST：当前值更新、缩写或整理让旧细节消失

扫过所有默认模板：profile、preferences、project_context、people、notes、entities、decisions、follow_ups、project_facts 都承载可能变化的状态；九类加入共享历史规则：当前值在前，同一属性至多两条最近旧值，标注变更日期或明确为“说出时日期”，未知就写未知，忘记内容绝不形成旧值。recent_work 是近期事件，corrections 是更正记录，observations 是观察记录，没有另加“当前属性”槽。已取消默认 profile/preferences 的简单覆盖许可、项目完成项直接消失和 follow_up 完成项直接删除的提示。默认及可选 extraction-v2 都由仓库 build 生成。

worker 删除入口有 extraction 更新/整文件删除、consolidation 更新/删除、明确忘记/源删除、basic/robust 既有拒收、手工编辑/undo/restore、确认人物 redirect。普通提取已有 guard；consolidation 现在也把 overlay 前文与引擎后文交给同一 guard。明确撤回、拒收、源删除及确实移动到其他文件的旧行优先，手工编辑和明确恢复继续走原来的用户操作边界，不用自动恢复覆盖人的选择。

guard 不再跳过 200 行以上文件，也不再因为同一个 hunk 有任何新句或当前消息提到同一主题，就放行所有旧句删除。每个旧句需要在对应新句中保住全部具体 token（数字、单位、日期、标识符及保守的中英文内容词）；相同主题词不是替代证据。线性空间找 hunk/插入位置，保留原始旧句，不把旧值改成新事实。数字/单位前缀、英文名字前缀也有反例测试。

实际前后快照核对：协调者补齐 `.lane/packs/snapshots/r2-P08/{20,30}.json`；88→67、丢 45 条的是 **r2**，不是 addendum 原先指向的 r3。回放动态加载基线 `717308708` 的原 guard，45 条全部被其 `kept_deleted_replaced` 放行，原样恢复 **0** 条。新 guard 原样保住 **44** 条，另 1 条“正在起草方案摘要（背景、目的、方法、预期意义）。”已完整包含在新句中，不重复插入；Embase、双变量、盲态核查、补充材料、4000词、成年女性等具体信息保住。r3 8/12→30 也单独回放，未用它冒充 r2。完整 r2 前后正文已作 synthetic fixture 入测试。

**剩余/风险**：有意保守，会留下实质相同但改写不同的句子。模板的两条历史上限不是确定性属性解析器；当提取器不遵守格式时，guard 宁留旧句也不会为实现两条上限而盲删，历史可能超过两条。共享内容词并非语义等价证明，否定/关系颠倒仍需来源核对；本次重点封住“短摘要丢具体信息”这类已证实漏洞。已知撤回指纹、源删除和拒收先行，501 行长文件的撤回 fence 用例不会复活旧内容。

### W-SRC：未说过的话变成自己的事实或长期偏好

按追加裁决修正归类：G9 poison-005/-009/-012 是空 store 上的读侧归属错误，不作为写侧方案依据。main synthetic 112 行没有已确认写侧归属错；实现保持小范围，针对 F03/F06 与 XV P01-x07/P03-x10 类。

开新开关时，普通 commit ingest 后对仍等于本次 after-image 的 profile/preferences/project_context/people/notes 新行，读该 commit 自己的 messages.jsonl，保留 role 和 created_at，复用 `NativeMemoryVerification.assess`。每 commit 最多一次 judge 调用，至多 32 行、序列化总计 48k 字符、单条 16k；超出的原句原样留着并计 omitted。claim 在调用前持久化，跨重启不重复花费；既有 purpose `memory-extraction` 记账。

只执行本地严格校验通过的 corrected/attribution_wrong 单行替换；硬 token 都必须来自这行自己的来源。unsupported 只记 finding，不撤回、不删除、不等待确认；下一次既有 verify 整理仍可看到该文件。无来源、来源过大/隐私不可读、judge 失败、预算不足、缺行或畸形 verdict、校验失败都不改变原字节。写前再比对当前正文，复用撤回保护和版本/来源记录，明确不调用 robust hold 路径。用户自己的陈述、更正、明确采用建议、把文档事实确认为自己的情况都有“不改变”断言；F03 多出的例外和 F06 假阶段有“必须改”断言（synthetic reproduction，不冒充现场原文）。

默认 project_context 的“阶段”明确可省略，意见不是阶段；preferences 不得扩写例外、先询问条款或范围。未采用建议和未确认文档事实不能变成第一人称事实。

写入路径清单（“比较”指本次新增来源比较，不是把用户编辑重新交给模型批准）：

| 路径 | 谁说的/来源 | 是否比较及不一致时行为 |
| --- | --- | --- |
| 普通会话提取 commit | messages.jsonl 的 user/assistant 及日期 | 开关打开时比较本 commit 新行；仅通过校验的纠正，其他原样留 |
| runtime 显式 remember / 新 remember journal | 经边界绑定的真实会话；最终 commit | 同上；缺来源仍留。没有新增另一条绕过 commit 的 remember 路由 |
| 页面“记住” | `remember` → `#submitWords`：人的输入，加明确标为平台的项目提示 | 本 commit 比较；平台提示不当成人说的话 |
| 页面直接编辑 | 已认证的人亲自写出的新正文、user revision | 用户就是作者，继续直接保存，不让 judge 否决 |
| 其他助手导入 | 人选中确认的 statement、import 来源 | 走 commit；只能比较本次确认文本，不能凭空重建外部助手原会话角色 |
| 外部 API note / confirm | note 是候选；confirm 后 `processAdmission` 的用户确认和外部 user messages | commit 同上；未确认 note 不入第一人称文件，不能把外部 assistant 消息伪装成 user |
| received capsule enable | 独立引用/方法/标准，不写用户 profile 等本地第一人称文件 | 不做本次来源重写，仍走原分享权限 |
| consolidation / verify | 文件已有原始来源链 | 旧 verify 比较仍在；新 guard 也保护其删除，未改变旧 unsupported 策略 |
| undo / restore | 人的显式操作及已有版本/撤回恢复授权 | 继续原边界，不新增提取 judge；不会自动恢复用户撤回行 |
| observed choice promotion | 平台汇总而非新的用户原话，已有原始来源链 | 明确跳过新 commit judge，避免把合成 user envelope 当成用户本人 |
| confirmed people redirect、格式归并 | 已确认身份或同型格式路径，保留来源链 | 不编造新 user 来源；归并只复制原句并留版本 |

**剩余**：提取写入与 worker 检查之间仍有时间窗；不是重新审查所有历史行。崩溃在 claim 后会保留 started，不自动重试本次 judge，保证一次上限和 fail-open。完整会话大于输入界限会遗漏检查，必须看 omitted 指标；没有对整批误改率作真实模型声明。导入仅有确认文本时，外部最初说话者仍不能恢复。

### W-MISS：说过但未进任何文件

按种类而非“漏了就全存”改默认规则：自己项目的旁句状态变化照样更新；自己工作或生活的具体数字、型号、费用、家庭细节即使夹在长句中也用一条带来源日期的句子保存；人的更正、明确使用助手建议、明确确认文档事实保留并在措辞标来源。随口意见进 NOTES 并标 User believes，不升级成项目阶段或规则。未认可文档里的主张、只让改写/提取且“不代表我认同”的内容不进第一人称文件；未采用的建议同样不进第一人称，可通过原会话查到，已有 NOTES 如保留也只能明确归属助手/材料。没有为了提高召回而把 17 条材料主张、14 条未采用建议变成用户事实。

忘记指令自身不是新事实或事件，九类状态模板均禁止增加重述被撤回内容的“删除记录”，包括以标签指代的“别记了”。模板测试断言此 fence；真正执行撤回仍依赖已上线机制，本次不改它的生产结论。

**剩余**：模板 renderer 已跑；真实提取器对记录会话的新增行数、误收多少行尚未跑。回放的 extract 注入接口输出 extractedStatements/extraStatements/extractedFiles，可以在实验室量化，默认没有 extract 时明确输出 not-measured，绝不把字符串测试当作提取效果证明。

### W-OBS：一次观察只能被写入，不能被读到

新开关让个人命名空间中的 observations 可以通过现有有界搜索/正文路径读到，标为 `[seen once — observed choice, not a standing preference]`。沿用现有条数/字数上限、权限/项目/withdrawal 和源删除过滤；共享命名空间仍不开放。自动 induction 的条件未改，recall=true、induction=false 不会创建提取会话或自动升级偏好。两个新的读/搜用例也覆盖撤回内容和不触发写入。

**剩余**：读到的是检索命中的一次观察，不承诺每次回答主动检索它；真实 U04 问答收益属实验室回放。新开关默认关，因此生产现状不变。

## 第二部分：代码、开关、验证和交接

以下路径均相对 `OpenScience/`，行号为本次完成前检查位置。

| 修改 | 位置 |
| --- | --- |
| 格式键、保留全文归并、权限/撤回/来源链 | `apps/server/src/nativeMemoryNames.mjs:11`, `:27`, `:43` |
| worker account pass 与 commit 归并、新来源检查 | `apps/server/src/nativeMemoryWorker.mjs:271`, `:891`, `:904` |
| 长文件逐 hunk 保护/具体 token 完整性/插回旧句 | `apps/server/src/nativeMemoryKeepLines.mjs:18`, `:44`, `:71` |
| consolidation 接入已有 guard | `apps/server/src/nativeMemoryWorker.mjs:1026` |
| judge 单次上限、严格批次、assessCommit、禁止 hold | `apps/server/src/nativeMemoryVerification.mjs:72`, `:194`, `:228`, `:260` |
| 一次 claim/结果与 completeCommit 保留结果 | `apps/server/src/nativeMemoryOverlay.mjs:566`, `:575`, `:586` |
| 账户导出复用既有 native_commits，仅导出统计不泄漏 uri/quote | `apps/server/src/accountExport.mjs:81`, `apps/server/src/nativeMemoryAccountExport.mjs:78` |
| observations 独立只读开关 | `apps/server/src/memoryGateway.mjs:1077`, `:1357`, `:1409` |
| 三个开关与部署邻接示例 | `apps/server/src/config.mjs:397`, `deploy/web/.env.example`, `deploy/web/docker-compose.yml` |
| 默认历史片段与 renderer | `deploy/web/openviking/memory-templates-src/extraction-v2.mjs:7`, `build.mjs:89` |
| 九类默认模板源 | `deploy/web/openviking/memory-templates-src/{profile,preferences,project_context,people,notes,entities,decisions,follow_ups,project_facts}.yaml` |
| project 阶段、旁句状态、禁止忘记记录 | `deploy/web/openviking/memory-templates-src/project_context.yaml:45`, `:80`, `:85` |
| 默认/可选产物 | `deploy/web/openviking/memory-templates/`, `memory-templates-extraction-v2/` 同名九文件，由 build 生成 |
| 精确 P08 前后 fixture | `apps/server/test/fixtures/memory-write-p08.json:1` |
| 回放及注入契约 | `evals/capsule-proving/replay/write-classes.mjs:1`, `write-verdicts.example.json`, `evals/capsule-proving/README.md:174` |

没有新表或新 document kind。新摘要放在已有 `native_commits.extraction.sourceVerification`，该表已在迁移/账户导出扫描范围；补了导出统计投影，隐藏 URI、指纹、原文与操作授权。本次未碰 domain、socket guidance、runtime baseline。

三个新开关都 `false`：

- `OPEN_SCIENCE_MEMORY_NORMALIZE_NAMES_ENABLED`：格式路径事后归并。
- `OPEN_SCIENCE_MEMORY_COMMIT_VERIFICATION_ENABLED`：本 commit 新行来源审查。
- `OPEN_SCIENCE_MEMORY_OBSERVATION_RECALL_ENABLED`：一次观察只读召回。

`OPEN_SCIENCE_MEMORY_KEEP_UNEXPLAINED_LINES_ENABLED` 是已有开关，本次修正其打开时的行为；默认模板修改直接进入默认模板集合，不以新 switch 隐藏。ROBUST 没有打开；basic 没有改判断，也没有改变其开关。

### 已实际运行

单文件逐个执行，没有全套、没有 full tsc、没有安装依赖。轻量 worktree 缺 `node_modules` 工作区解析，本地使用已存在 `.lane/fixmem-imports.mjs` / `.lane/workspace-imports.mjs` 把 `@evimed/domain` 指向源码；其中 fflate 只有不被这些测试调用的 throwing stub，**不代表验证过压缩包导出**。

| server 测试文件 | 通过数 |
| --- | ---: |
| `nativeMemoryKeepLines.test.mjs` | 19 |
| `nativeMemoryVerification.test.mjs` | 17 |
| `nativeMemoryNames.test.mjs`（新） | 6 |
| `memoryWriteClassesTemplates.test.mjs`（新） | 3 |
| `memoryGatewayNextRound.test.mjs` | 11 |
| `memoryPastedInstructionTemplates.test.mjs` | 2 |
| `nativeMemoryInstructionOrigin.test.mjs` | 9 |
| `memoryGateway.test.mjs` | 121 |
| `nativeMemoryPastedInstructions.test.mjs` | 3 |
| 合计 | **191** |

命令形如 `cd OpenScience/apps/server && node --import ../../../.lane/fixmem-imports.mjs --test test/nativeMemoryKeepLines.test.mjs`。模板测试需要临时目录时使用 worktree 内 `.lane/tmp`。

此外：默认与 extraction-v2 的仓库 build 及两个 `--check` 通过；三个配置开关的默认/环境 true/显式 false smoke 通过；sourceVerification 账户投影不含敏感 URI/指纹的直接 smoke 通过；21 个修改/新增 mjs 的 `node --check` 通过，`git diff --check` 通过；离线回放 20 例，tokens 0。

尝试但未能执行：`nativeMemoryWriteClasses.integration.test.mjs` 在导入阶段缺 `pg`，未到数据库 skip；`accountExportNative.test.mjs` 缺 `@evimed/harness-port`。不记作通过/skip。完整 `config.test.mjs` 未执行，仅 smoke。没有真实数据库、模型调用和线上验证。新增 promotion 集成用例只做语法检查，等待下列实验室执行。

### 实验室必须逐文件运行（包括所触模块邻居）

工作目录 `OpenScience/apps/server`，有依赖和真实本地测试 PostgreSQL 后，逐条 `node --test test/<文件>`。以下每一个都要跑，不能只跑新增文件：

```text
nativeMemoryWriteClasses.integration.test.mjs
nativeMemoryNames.test.mjs
nativeMemoryKeepLines.test.mjs
nativeMemoryKeepLines.integration.test.mjs
nativeMemoryVerification.test.mjs
nativeMemoryWorkerScopes.integration.test.mjs
nativeMemoryOverlayScopes.integration.test.mjs
nativeMemoryWriteFence.integration.test.mjs
nativeMemoryConsolidation.integration.test.mjs
nativeMemoryConsolidationDirectories.test.mjs
nativeMemoryInstructionOrigin.test.mjs
nativeMemoryInstructionOrigin.integration.test.mjs
nativeMemoryPastedInstructions.test.mjs
nativeMemoryPastedInstructions.integration.test.mjs
nativeMemoryRejections.test.mjs
nativeMemoryRejections.integration.test.mjs
nativeMemorySourcePrivacy.integration.test.mjs
nativeMemoryForgetEverywhere.test.mjs
nativeMemoryForgetEverywhere.integration.test.mjs
nativeMemoryForgetRequests.test.mjs
nativeMemoryForgetRequests.integration.test.mjs
nativeMemoryForgetTool.test.mjs
nativeMemoryForgetGateway.integration.test.mjs
nativeMemoryForgetRows.integration.test.mjs
nativeMemoryPeople.test.mjs
nativeMemoryPeopleStore.test.mjs
nativeMemoryPeople.integration.test.mjs
memoryGateway.test.mjs
memoryGatewayNextRound.test.mjs
memoryGatewayContext.integration.test.mjs
nativeMemoryApp.integration.test.mjs
accountExport.test.mjs
accountExportNative.test.mjs
accountExport.integration.test.mjs
accountExportKinds.test.mjs
accountExportSharers.test.mjs
config.test.mjs
openVikingDeploy.test.mjs
memoryPastedInstructionTemplates.test.mjs
memoryWriteClassesTemplates.test.mjs
```

另外两条模板构建检查（在 `OpenScience/`）：

```sh
node deploy/web/openviking/memory-templates-src/build.mjs --check
node deploy/web/openviking/memory-templates-src/build.mjs --variant extraction-v2 --out deploy/web/openviking/memory-templates-extraction-v2 --check
```

### 回放命令与结果解释

本机从 worktree 根执行：

```sh
node --import ./.lane/fixmem-imports.mjs OpenScience/evals/capsule-proving/replay/write-classes.mjs --packs .lane/packs --verdicts OpenScience/evals/capsule-proving/replay/write-verdicts.example.json --out .lane/write-replay.json
```

实验室有依赖时去掉本机 loader，传入 `--adapter <实验室适配模块>`，其中 `judge` 提供真实批量判定（Map/index/verdict/corrected/calls/usage），`extract` 使用回放提供的已渲染默认 templates 和 sources 返回 files/usage，`basicCall` 使用现有 basic request 返回模型响应。接口和 token 统计规则在 README，最多 40 例，每个 commit 最多一 judge 次；执行一次并保存输出，不读取操作员配置或在仓库中写密钥。

本机 `.lane/write-replay.json` / `.lane/write-replay.log` 是未入库的完整结果。7 个精确历史/重名比较、10 个 source/template case、3 个 basic fixture，共 20 例。F03/F06 是明确标注的 synthetic reproduction；其余 source/template 输入是 pack 的 checkpoint 重建，并非逐次 commit before/after，所以不能从它推断生产误改率。没注入 extract，`extractionMeasured=false`，不报告“新增零行”。回放会保留原行数、最终行数、omitted 和模型 usage；注入 extract 后才报告新增行数及文件供人工审查。

store-triage-2 的 132/158/194：未改的 basic 检查在带原引文的 recorded-verdict fake 下均返回候选 0，ROBUST=false。这证明现有 parser/引用校验路径可拒收这三个形状，不证明真实模型必然做出该判定；有些 evidence 引文缩略，真实评估仍须看完整源会话。G9 不在写侧成功率分母。

### 打开后的风险与 fail-open

- 来源 judge 可能错误改写软语义；局部硬 token 校验不是语义证明。新开关默认关，仅受限纠正，留版本，当前正文变化则放弃，无来源/异常/畸形一律不改、不 hold、不删。生产开启前需真实 judge 控制组。
- 格式归并可能把用户有意用标点区分的同型名字归到一起；内容/来源全部保留、scope 不跨，开关默认关。没有同步给上游改名后的永久 redirect，因此上游可再次生成旧 sibling，worker 再归并；创建前去重仍未完工。
- guard 变保守会增长文件并增加重复；保护具体陈述优先于压缩。已撤回项在 guard 和归并前有同一既有 fence；不靠词相似度恢复它。
- 默认模板增加旁句细节会增加行数；真实 extraStatements 必须在实验室量化，不能把用户材料当本人事实来提高召回。
- observations 只增只读可见范围，仍标一次观察且过滤撤回；不改变 induction，也不赋予跨账户/项目权限。
- 数据库/引擎中途失败可能留下归并的一份冗余副本或来源审查 started；原句仍可读，不用清空文件来回滚。新增审查统计导出不带正文/URI，隐私删除沿用已有 commit 清理边界。

未完成项交接：引擎创建前确定性目标复用、真实 judge/extractor 一次实验室回放、全部列出的 PostgreSQL/配置/导出邻接验证。代码可审查和本地提交不等同于这些项已完成。
