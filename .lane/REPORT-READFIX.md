# READFIX：PostgreSQL 六个失败文件复核与修复

工作树：`/home/coder/evimed-wt/cap-p8`；分支：`cc/capsule-read-classes-1117`；起点：`eaa1b6075`。
未部署、未 SSH、未 fetch/push、未读取密钥目录或 `~/.ssh`。只提交本地修复。**本机没有配置测试 PostgreSQL；下面的数据库结论是代码与实验室失败日志的诊断，不是数据库复跑通过声明。**

## 六个失败文件逐项结论

所有测试路径均相对于 `OpenScience/apps/server/test/`。

| 文件 | 产品或测试 | 依据、修复与保留的断言 |
| --- | --- | --- |
| `memoryGatewayContext.integration.test.mjs` | **测试观测点过期**，不改产品路由 | 第 1 项把任何 `overlay.files()` 都记作 `ranked`。实际 `memoryGateway.mjs:1000` 已将 shared list 分流；READ 在 `:1389` 的 `recallText` 为显式读取添加来源标签，要读取一次 metadata，才是 `[1,1]` 的原因。测试 `:31` 分开验证 list 后 `[metadataReads,used]=[0,0]`，read 后 `[1,1]`，并给个人与共享命名空间放入同相对路径、不同来源，验证只返回共享来源、只增加该共享 URI 的 use。没有移除来源标签，也没有把 shared listing 改成个人排序。 |
| `memorySafetyNotes.integration.test.mjs` | **产品缺陷** | 第 1、2 项实际是 `[]` 多了可枚举 `legacyUnclassified:0`，不是被删正文复活；第 3、4 项是无可见安全事实也输出未分类警告。`nativeMemoryStore.mjs:1111` 先经过正常文件/来源删除读器，才计算 coverage；空结果仍为真正的 `[]`，只有可见安全事实旁边才携带非零 legacy coverage。`memorySafetyNotes.mjs:55` 不再为无安全行的数组输出警告。原四项断言保留；`:104` 补真实健康内容存在但开关关闭时仍为原空字符串，且 provider 调用次数为 0。注意旧日志第 4 项比较的是 **enabled 的非健康账户** 与 disabled，不是 disabled 分支自己读取了安全层。 |
| `nativeMemoryApp.integration.test.mjs` | **测试占位标题不符合模板，同时补产品 neutral 修复的 HTTP 断言** | 原 fixture 为 `# Profile`，既不是模板的 neutral 标题，也没有真实姓名证据，不能把 `Profile` 加进黑名单。`:85` 改为真正英文默认 `# User`，原 map `2` 保留。`:88–103` 对齐 active rows、overview activeCount、关于你行数与 map summary/nodes；再用真实姓名 `Mara Santos` 验证总行数为 `3`、关于你为 `2`。姓名的额外行是预期行为。 |
| `nativeMemoryForgotten.integration.test.mjs` | **测试占位标题校正 + 产品 neutral 修复** | 同为手写 `# Profile` 占位，`:58` 改为模板默认 `# User`；忘记一条后 `activeCount=1`、恢复后 `2` 的原期望均不变。自定义标题仍能忘记/恢复，不将所有 H1 隐藏。 |
| `nativeMemory.integration.test.mjs` | **测试占位标题校正 + 产品 neutral 修复** | `:72` 的泛化占位改为真实模板默认；原 `activeCount=4`、profile 两行均保留，并在 `:79` 增加 list、group、map 与 count 相等断言。同文件另外两个画像编辑 fixture 也统一为实际 neutral 默认。没有通过把 `4` 改 `5` 掩盖空标题。 |
| `nativeMemoryOrigins.integration.test.mjs` | **产品缺陷** | 原增长 fixture 就是 `# 用户`，明确是模板默认。原 `36` 个事实、`36` 个 origins 断言不改。`nativeMemoryStore.mjs:158` 排除 neutral；`nativeMemoryOverlay.mjs:1023` 的 worker `syncOrigins` 复用同一解析器，避免姓名在列表里却没有持久行来源；旧版 title-only 形成的 neutral origin 在读出/继承时也被过滤，下一次正常 sync 会清掉持久行。`:215` 增加中文/英文默认、真实姓名、用户自定 `Profile` 四组：worker → records → count → map → recall → origins 一致，neutral 不可作为单条忘记目标；改成姓名后新增一行，历史星图不产生 neutral 灰点；姓名可忘记及恢复。 |

这三个原 `# Profile` fixture **不是**被认定为产品的 neutral。它们原本想表达“没有姓名的画像”，但写的不是引擎模板格式，所以纠正 fixture；另有明确 `Call me Profile` 的新用例，保证用户自己的相同文字仍是 designation，不能被模板过滤器吞掉。

## 一处定义与各读取面

- `OpenScience/packages/domain/src/memoryProfile.mjs:1` 定义模板默认标题与唯一 `profileMemoryStatements`。默认来自现有 template 中中文“用户”/英文“user”的无姓名规则；模板生成器现在直接消费这份规则，明确中文 `# 用户`、其他语言 `# User`，其余正文仍用用户语言。这样默认标题不再是由模型随意翻译、读侧无法识别的开放集合；不是在几个消费者里抄一份禁用词表。
- `OpenScience/deploy/web/openviking/memory-templates-src/profile.yaml:59` 与 `build.mjs:16,92` 将共享规则写入提取模板；普通版与 extraction-v2 的生成文件已同时重建。worker 不自行发明 profile H1：它接收引擎的提取 diff，再经 `syncOrigins` 建索引；新的索引读取与模板使用同一 domain 定义。
- `OpenScience/apps/server/src/nativeMemoryStore.mjs:158,615,858,1223,2144,2155` 分别覆盖事实行、列表、写操作目标、历史星图、整份空画像的忘记项及逐行忘记项。`profile`、外部 records/recall、显式 profile 分享均从此 records 视图派生，不另造标题事实。
- `nativeMemoryStore.mjs:2647` 不把只有 neutral 标题的空画像作为记忆文件导出；有事实的原始 Markdown 文档保留结构标题用于完整往返，标题本身不会作为导出事实。`capsuleNativeExport.test.mjs:198` 实际调用 exportPreview，验证中英文 neutral、neutral-only 均不产生导出条目；已有姓名导出用例仍通过。
- `nativeMemoryReads.test.mjs:166` 验证只有 neutral 的文件不产生 records、search hit、账户 pack 文件或旧忘记行。`memoryReadStatus.test.mjs:53` 验证两种渲染模板与解析器使用同一规则，并明确 `Profile`、`Dr User` 等其他自定义标题仍保留。
- `OpenScience/DESIGN.md:1245` 与 `OpenScience/docs/FRONTEND_DESIGN_SYSTEM.md:642` 同步说明姓名行与 neutral 结构的区别、行数一致要求；没有新增 UI 或前端布局。

## 其他数据库测试复核

沿指定七个模块和新增受影响的 `nativeMemoryOverlay`，复核了数据库测试的 fixture、读取结果形状、标题/行数/来源断言与空数组断言，完整复跑清单在下一节。

重点结果：

- `memoryExtractionV2.integration.test.mjs:61` 的历史画像 fixture 为 `# User`，三条 current/earlier facts 的旧期望应保留；neutral 修复也覆盖它。`nativeMemoryImport.integration.test.mjs:158` 的 `# 用户` 导入同样应只显示导入事实，不改变其精确 values/evidence 断言。
- `nativeMemoryProvenance`、`nativeMemoryAttribution`、`nativeMemorySourcePrivacy` 按具体正文找行，`nativeMemoryRoutes` 断言文档 URI，未发现要把数量机械加一的理由。它们的自定义 `# Profile` 不加入 neutral 集合，来源与隐私规则保留。
- `nativeMemoryForgetEverywhere`、`nativeMemoryForgetGateway`、`nativeMemoryKeepLines`、`nativeMemoryRemovalRule` 的中文/英文默认标题仅为原始文档结构；读取/撤回断言仍针对正文。旧忘记行和历史星图的标题解析分叉已一起修正。
- `nativeMemoryResident` 与 `residentProfile` 的最常用/常驻偏好测试验证 selection/digest/use；共享启动 listing 本来独立，不应取消 READ 的来源 metadata read。`nativeMemoryResident` 的安全文件跨项目用例继续保留源作用域与隐私检查。
- `memoryHistory`、`memoryHistorySources`、`agentMemoryRecall`、capsule/session gateway 的空数组调用者仍兼容：READ 的 `withReadStatus` 用非枚举属性；这与本次 safety 的 `Object.assign([], {legacyUnclassified:0})` 问题不同。没有把失效/超时退回“成功但为空”，没有放宽来源删除或 tenant/project 边界。

没有据此宣称其他数据库文件已通过；本机 skip 的那些断言仍需要真实 PostgreSQL 执行。

## 本机验证

- 92 个相关 server 测试文件：**590 pass / 0 fail / 540 skip**，日志 `.lane/readfix-regressions.out`。skip 原因均为未配置 PostgreSQL；这不是实验室六文件已经变绿。
- 最终六个任务文件加四个本地回归文件合跑：**39 pass / 0 fail / 81 skip**，`.lane/readfix-final.out`；其中六个任务文件的 81 个 PG cases 在本机仍 skip。
- 最后补充的 reader/标题/safety 回归：**28 pass / 0 skip**，`.lane/readfix-unit.out`；显式 export 回归：**11 pass / 0 skip**，`.lane/readfix-export.out`。这两批与前面的 590 存在重叠，不相加报总数。
- 最后补旧 origins 读出/继承过滤后，再跑 readers/export 与两个相关 PG 文件：**20 pass / 0 fail / 42 skip**，`.lane/readfix-last.out`；server typecheck 和改动文件 ESLint 再次通过。
- `pnpm typecheck:server`、`pnpm typecheck:domain` 通过；按 server/domain 自己目录运行的改动文件 ESLint 通过。最初从 monorepo 根直接 `pnpm exec eslint` 命中系统 ESLint 8、找不到配置；随后按 package 工具链重跑成功，不把第一次命令算通过。
- 模板两种变体重建后，`openVikingDeploy` / `memoryExtractionV2` / safety template 单测通过；`git diff --check` 通过。

## 指挥官需要在实验室复跑的文件

先跑任务点名的六个文件，再跑下面完整受影响集合（69 个文件，含部分混合 unit/PG 用例及 server 装配消费者）。在 `OpenScience/` 下沿用原实验室逐文件 runner 和已配置的 disposable PostgreSQL；保留每文件完整输出，不能用本机 skipped 数替代。单文件入口可用 `node --import ./scripts/test/localhostProbeGuard.mjs --test --test-concurrency=1 apps/server/test/<文件名>`。

```text
accountExport.integration.test.mjs
agentMemoryNative.integration.test.mjs
agentMemoryObservations.integration.test.mjs
agentMemoryRecall.integration.test.mjs
capsuleTransferService.integration.test.mjs
capsuleTwoAccounts.integration.test.mjs
conversationSourceDeletion.integration.test.mjs
conversationSourceDeletionApp.integration.test.mjs
frontierProfileMark.integration.test.mjs
frontierProfiles.integration.test.mjs
geoNativeChildSourceScope.integration.test.mjs
geoNativeComposition.integration.test.mjs
geoNativeCompositionRepair.integration.test.mjs
geoNativeHistoryBudget.integration.test.mjs
geoNativeMemoryPolicy.integration.test.mjs
geoProgrammeRuns.integration.test.mjs
learningEvidenceWiring.integration.test.mjs
legacySchemaMigration.integration.test.mjs
lineageCapsulePack.integration.test.mjs
memoryExtractionV2.integration.test.mjs
memoryForgetPropagation.integration.test.mjs
memoryGatewayContext.integration.test.mjs
memoryHistory.integration.test.mjs
memoryHistorySources.integration.test.mjs
memorySafetyNotes.integration.test.mjs
nativeCommitExtraction.integration.test.mjs
nativeMemory.integration.test.mjs
nativeMemoryApp.integration.test.mjs
nativeMemoryAttribution.integration.test.mjs
nativeMemoryAttributionApp.integration.test.mjs
nativeMemoryComposerSource.integration.test.mjs
nativeMemoryConsolidation.integration.test.mjs
nativeMemoryForgetEverywhere.integration.test.mjs
nativeMemoryForgetGateway.integration.test.mjs
nativeMemoryForgetRequests.integration.test.mjs
nativeMemoryForgetRows.integration.test.mjs
nativeMemoryForgotten.integration.test.mjs
nativeMemoryForgottenHistory.integration.test.mjs
nativeMemoryImport.integration.test.mjs
nativeMemoryInduction.integration.test.mjs
nativeMemoryInstructionOrigin.integration.test.mjs
nativeMemoryKeepLines.integration.test.mjs
nativeMemoryLifecycleScopes.integration.test.mjs
nativeMemoryObservations.integration.test.mjs
nativeMemoryOrigins.integration.test.mjs
nativeMemoryOverlayScopes.integration.test.mjs
nativeMemoryPastedInstructions.integration.test.mjs
nativeMemoryPeople.integration.test.mjs
nativeMemoryProvenance.integration.test.mjs
nativeMemoryProvenanceApp.integration.test.mjs
nativeMemoryRejections.integration.test.mjs
nativeMemoryRemovalRule.integration.test.mjs
nativeMemoryReset.integration.test.mjs
nativeMemoryResetSweep.integration.test.mjs
nativeMemoryResident.integration.test.mjs
nativeMemoryRoutes.integration.test.mjs
nativeMemorySourcePrivacy.integration.test.mjs
nativeMemoryStampBackfill.integration.test.mjs
nativeMemoryStoreScopes.integration.test.mjs
nativeMemorySummaries.integration.test.mjs
nativeMemoryWorkerScopes.integration.test.mjs
nativeMemoryWriteFence.integration.test.mjs
nativeTurnCommit.integration.test.mjs
relationalIntegrityProven.integration.test.mjs
residentProfile.integration.test.mjs
usageLedger.integration.test.mjs
vcrStartsWork.integration.test.mjs
vcrStepsInStudySession.integration.test.mjs
vcrStudyStart.integration.test.mjs
```

另外复跑非 PG 的 `memoryReadStatus.test.mjs`、`memorySafetyNotes.test.mjs`、`nativeMemoryReads.test.mjs`、`capsuleNativeExport.test.mjs`、`memoryMapReplaced.test.mjs`、`memoryOpeningByUse.test.mjs`、`memoryOpeningIndex.test.mjs`、`memoryGateway.test.mjs`、`capsuleGateway.test.mjs`、`residentProfile.test.mjs`、`openVikingDeploy.test.mjs`、`memoryExtractionV2.test.mjs`。
