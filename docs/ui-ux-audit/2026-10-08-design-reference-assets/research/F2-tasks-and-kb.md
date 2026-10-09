# F2 定时任务与知识库:代码级事实核对

核对对象是线上 R12(commit `adcd02e6b`)的 worktree `/home/coder/evimed-wt/release/OpenScience`,只读,没有改动任何源文件。下文路径均相对该目录:`web` = `apps/web/src`,`srv` = `apps/server/src`。行号是该 worktree 里的真实行号。凡未能在代码里直接看到、或需要线上实机才能确认的,标注「未核实」并写明原因。

内核(DSH `0.1.7-rc.2`)的完整 bundle 不在这份 worktree 的 `node_modules` 里,只有 73 个子包里的一小部分(`dsh-agent`、`dsh-session` 等),没有 `dsh-schedule`。内核侧结论因此依据三类材料:已提交的 0.1.7-rc.2 组合基线 `deploy/runtime-dsh/dump-config.baseline.json`、2026-09-18 的内核 UI 清单 `docs/ui-ux-audit/2026-09-18-review/A-kernel-native-ui-inventory.md`、以及本机另一个项目(`/home/coder/workspace/HECRS/app/harness/node_modules/@deepseek-ai/dsh-schedule`,版本 0.1.2-rc.1)里的 README。凡引用后两者处都已注明版本差异。

---

## A 定时任务

### A1 路由、组件,抽屉能否按 URL 寻址,有没有整页视图

只有一条路由,没有任务详情的整页视图。

- 路由表里只有 `{ path: "autopilot", element: <AutopilotPage /> }`(`web/app/router.tsx:112`)。没有 `autopilot/:id` 之类的子路由。
- 侧栏入口「定时任务」是 `NAV` 里的一行普通链接(`web/components/sidebar/Sidebar.tsx:66`)。
- 整页是 `AutopilotPage`(`web/app/routes/AutopilotPage.tsx:39-304`),用 `PageShell title="定时任务"`(`:259`)。页头有搜索框和「新建任务」按钮(`:260-261`)。
- 列表分三块:「即将执行」「已暂停 / 已完成」,然后是 `EvolutionOpportunities`(循证进化的研究机会,`:267`)和「推荐」(六条模板,`:268`,模板定义在 `web/components/autopilot/taskPresentation.ts:8-15`)。
- 列表行是 `ListRow`,只带 `title`、`meta`、`onOpen`,没有传 `menu`(`AutopilotPage.tsx:254-256`)。所以列表行上没有「⋯」,暂停、立即运行都必须先打开抽屉。对比知识库行有 `menu`(`web/components/sources/SourceRow.tsx:71`)。
- 抽屉用通用 `Drawer`(`web/components/ui/Drawer.tsx:78-80`:`fixed inset-0 z-drawer flex justify-end bg-scrim`,即带遮罩的右侧滑出层),`bare` 模式,宽度 `max-w-2xl`(`AutopilotPage.tsx:270`)。它是模态对话框:焦点陷阱、Esc 关闭(`Drawer.tsx:47-73`)。

抽屉可以按 URL 寻址:选中的任务 id 在查询参数 `?task=<agendaId>`(`AutopilotPage.tsx:51` 读取,`:163` `select()` 写入)。`?task=` 指向不存在的任务时,显示「未找到这个任务」的第二个抽屉(`:298`)。

另有 `?digest=<digestId>`(通知链接用)。它不是视图状态,而是一次性重定向,见 A2 和 A6。

筛选与搜索(`search`)是组件内状态,不在 URL 里(`:60`)。

### A2 数据模型、执行方式、会话归属

**数据模型。** 三种文档存在产品账本 `evimed_product.documents`,种类为 `agenda`、`episode`、`digest`(`srv/autopilotService.mjs` 里 `documents.put(userId, "agenda"|"episode"|"digest", …)`,例如 `:1914-1925`、`:2242-2251`)。前端类型在 `web/lib/autopilotClient.ts`:

- `AgendaPayload`(`:6-22`):`prompt`、`schedule`(`once|daily|weekly` + `time` + `timeZone` + `weekdays/date`)、`nextRunAt`、`scheduleState`、三档预算 `maxEpisodeCny/dailyBudgetCny/weeklyBudgetCny`、`taskTypes`、`materials`、`messages`(最近 20 条追问)、`plannerStop`。
- `EpisodePayload`(`:44-54`):`trigger`(`scheduled|manual|follow-up`)、`status`(`queued|running|merged|failed|canceled`)、`runId`、`sessionId`、`digestId`、`claims`、`artifactRefs`、`resourceDeferrals`、`selection`(规划器选了什么任务类型和关注点)。
- `DigestPayload`(`:38-42`):`headlines`、`leads`、`episodeIds`、`artifactRefs`、`openedAt`。

预算默认值 `maxEpisodeCny: 100`(`packages/domain/src/agenda.mjs:329`),与线上抽屉里的「单次上限 ¥100」一致。

**定时任务属于项目。** 列表只列当前项目的任务(`AutopilotPage.tsx:41` 取 `getWebProjectId()`,`:82` `listAgendas(projectId)`),没有跨项目的总列表。

**一次执行是怎么跑的。**

1. 定时触发或手动触发,最终都进入 `AutopilotService.schedule`(`srv/autopilotService.mjs:1814`)。它在一个事务里:先让 Flash 规划器决定这次做什么或停下(`chooseNextAction`,`:1886`,定义于 `:2026`),然后写入状态为 `queued` 的 `episode` 文档(`:1914-1925`),并入队一条 `episode` 作业(`:1954`)。
2. `AutopilotWorker` 每 1000 ms 轮询认领作业(`srv/autopilotWorker.mjs:36-37`、`:67`,`config.autopilotPollMs` 默认 1000,`srv/config.mjs:2628`),调用 `dispatchEpisode`(`autopilotWorker.mjs:175`,实现在 `srv/server.mjs:4162`)。
3. `dispatchEpisode` 的关键动作:
   - `runtimeManager.reserveBoundedRuntimeSession(project, {runId: episode.episodeId, …})`(`server.mjs:4193`),在这个**项目自己的**工作区里起一个带花费上限令牌的受限运行时(bounded runtime),返回一个全新的 `session_<随机>` id(`srv/runtimeManager.mjs:3921`)。
   - 把该会话登记为 specialist 会话(`server.mjs:4203`),再 `agentRuns.dispatch(...)`,路由原因写成 `autopilot:<taskType>`(`:4214`)。
   - 所以**一次执行 = 一个新会话 = 一次 `agentRuns` 里的运行**,不是一个任务一个会话。执行的内容是一个公开能力包的完整运行:`literature-sentinel` 和 `evidence-update` 跑 `clinical-evidence-synthesis`,其余见 `packages/domain/src/capabilityManifest.mjs:113-120`。提示词里写明两小时墙钟上限(`autopilotService.mjs:1912`)。
4. 运行结束后,`completeOwnedAutopilotRun` 把结果折进 episode 与 digest,并结束受限运行时(`srv/autopilotRunCompletion.mjs:40-50`)。随后每条已采纳的声明还会排一个独立复核运行,同样占用受限运行时(`autopilotService.mjs:1188` 起,`server.mjs:4036` 的 `dispatchVerification`)。

**对话记录存放在哪里。** 运行的会话在内核自己的会话存储里(项目数据卷中的 DSH home)。控制平面另有两处:运行账本 `agentRuns`,以及运行结束时写下的转录文件(`srv/runTranscripts.mjs:1-30`)。前端可通过 `GET /api/runtime/sessions/:id/transcript` 读取(`web/lib/apiClient.ts:2361`,服务端 `srv/server.mjs:6979`)。

**反向链接不存在。** `agentRuns.mjs` 里没有 `agendaId` 或 `episodeId` 的字段(grep 无结果);链接只有一个方向:episode → `runId/sessionId`(`autopilotRunCompletion.mjs:12-22` 靠 `episodeForRun` 反查)。对话页不知道自己属于哪个任务。

**时间线能否打开会话。** 能,而且只有这一个入口:`TaskTimeline` 里每次执行有「打开运行对话」链接(`web/components/autopilot/TaskTimeline.tsx:47`),指向 `chatPath(sessionId)`,即 `/app/chat/<sessionId>`(`web/lib/runLocation.ts:8-12`)。`/app/chat/:sessionId` 会让常驻的内核 iframe 打开该会话:`RuntimeUiFrame` 向 iframe 发 `evimed.runtime-ui.navigate`,意图为 `{kind:"open", sessionId}`(`web/app/routes/RuntimeUiFrame.tsx:406-416`、`:904-914`;帧内接收见 `packages/harness-port/src/runtimeUiBridge.mjs:440-466`)。

**`?digest=` 具体打开什么。** `AutopilotPage` 的一个 effect(`AutopilotPage.tsx:144-161`):读取 digest(`getDigest`),列出该任务的 episode,找到 `digestId` 与之相同(或在 `digest.payload.episodeIds` 里)且有 `sessionId` 的那一个(`:152`),把它标记为已读,然后 `navigate(chatPath(sessionId), {replace:true})`(`:155`)。找不到则去掉参数,留在任务页。若 digest 属于另一个项目,则走 `/app/runs?run=…`(`:155`,由 `RunRedirect` 解析,`web/app/router.tsx:189`)。也就是说,通知点进去落在**那次执行的对话**,而不是抽屉。

### A3 「立即运行」

- 点击先弹确认框「立即运行?本次最多花费 ¥X,不改变原定计划。」(`AutopilotPage.tsx:278`、`:302`)。
- 确认后调用 `POST /api/autopilot/agendas/:id/run-now`,body 只有 `requestId`(`web/lib/autopilotClient.ts:64`;路由 `srv/autopilotRoutes.mjs:71`;服务 `autopilotService.mjs:726`,即 `schedule(..., trigger:"manual")`)。
- 这一个 POST 在返回前要做完:额度检查、读取进展、一次 Flash 规划器模型调用、写 episode、入队作业(`autopilotService.mjs:1833-1960`)。响应是 `{episode, job}`,此时 episode 状态是 `queued`。
- 前端收到后把 episode 插进时间线并重置轮询(`AutopilotPage.tsx:184-188`)。所以最早可见的东西是时间线里一条「排队中」(`web/components/autopilot/taskPresentation.ts:61` 的 `RUN_STATES`)。

**抽屉没有实时进度。** 只有状态词:排队中 → 研究进行中 → 结果核验中 → 研究结果(`taskPresentation.ts:61-77`)。没有流式输出,没有工具调用数,没有步骤。`ResearchProgress` 卡(「研究进展」)显示的是任务的累积发现、未解决项、补充材料,不是这次运行的进度(`web/components/autopilot/ResearchProgress.tsx:32-48`)。抽屉也没有读运行账本里的进度。

**轮询。** 有执行在途时每 5 秒刷新一次,否则每 30 秒(`AutopilotPage.tsx:138`、`:140`);最多 60 次后停止并显示「自动刷新已暂停 / 刷新结果」(`:137`、`:296`)。60 次 × 5 秒 = 5 分钟。而执行本身允许跑到两小时(`autopilotService.mjs:1912`),所以长执行在 5 分钟后抽屉不再自动更新。

**从点击到有东西在跑的延迟。**
- 规划器调用:一次 Flash 模型调用,在 POST 内同步完成(`autopilotService.mjs:1886`)。实测时长未核实(未测)。
- 作业被认领:最多 1 秒(`pollMs`)。
- 受限运行时冷启动:基线约 5 秒(记忆项 `runtime-cold-start-is-five-seconds`;本次未实测,未核实)。
- 之后才有 `markEpisodeDispatched`,episode 才变成 `running` 并出现 `sessionId`(`server.mjs:4222`、`:4281`)。

**一个会让「立即运行」长时间不动的条件(代码与单测证实,线上是否常见未核实)。** `reserveBoundedRuntimeSession` 在任何一个「浏览器连着」的情况下拒绝:`this.activeProxyCountForProject(project) > 0` 时抛 `runtime_busy`(`srv/runtimeManager.mjs:3899`)。`runtimeManager.mjs:6974-6979` 的注释说明:会话界面「只要标签页开着就一直占着一条多路复用 WebSocket」,`activeProxies` 因此不会归零。而外壳把对话 iframe 常驻挂载,离开对话页只是 `display:none`,不卸载(`web/app/layout/SessionFrameHost.tsx:52-66`、`:229-245`)。单测直接覆盖了这个状态:`apps/server/test/runtimeBoundedIdleHandoff.test.mjs:41-57`(`browser-connected` 用例断言 `runtime_busy`)。

工作者对 `runtime_busy` 的处理是延后重试,延迟为 `busyDelayMs` = `min(24h, max(5 min, runtimeIdleYieldAfterMs + 1 min))`,默认 31 分钟(`server.mjs:3985-3988`、`config.mjs:1914-1915`、`autopilotWorker.mjs:187-203`)。时间线会显示「等待运行资源 / 预计重试 hh:mm」(`TaskTimeline.tsx:42`、`taskPresentation.ts:72-76`)。生产环境是否覆盖了 `OPEN_SCIENCE_RUNTIME_IDLE_YIELD_AFTER_MS`,未核实。

**执行期间项目的对话页被锁。** 受限运行时占着项目运行时。执行未结束前,打开该项目的对话会得到 423 `runtime_reserved_for_autopilot`(`runtimeManager.mjs:3877-3883`;iframe 里显示的提示是「项目正忙,请稍后再试」,`srv/runtimeUiServer.mjs:777-779`;发送提示词时也同样被拒,`runtimeUiServer.mjs:64-65`)。错误字典的原文是「这个项目的运行时正在执行你自己设定的主动研究任务,暂时不接受交互提问。等这一轮结束后即可继续,或在『主动研究』里先暂停它。」(`packages/domain/src/errorCodes.mjs:2363-2365`)。这是「无法实时驱动」最直接的结构原因:任务执行与用户在同一项目里的对话互斥。

同时,「打开运行对话」链接在 `sessionId` 一写入就出现(`TaskTimeline.tsx:47`),即执行进行中就能点;此时点开会撞上上面的 423。执行结束后该会话是否能在内核里正常打开并继续对话:代码路径存在(见上),线上实机未核实(本次没有实机操作)。

**对比:虚拟临床研究与循证 GEO 已经有「在用户正开着的对话里跑」的做法。** `dispatchVcrRun` 和 `dispatchGeoRun` 里有 `interactive` 分支:项目运行时已经是热的且没有被占用时,不预留受限运行时,而是在那个运行时里直接起一个普通会话,用户能在正看着的对话里看到它跑(`server.mjs:4769-4770`,GEO 版在 `:4852-4853`,其注释在 `:4819-4821`:「A project whose runtime is already open for the researcher takes the run in that runtime instead — the conversation they are looking at」)。此时 `allowBounded: !interactive`(`:4799`),预算标记 `marker` 为空(`:4791`)。`dispatchEpisode` 没有这个分支,总是预留受限运行时(`:4193`)。

### A4 抽屉底部输入框

- 发送调用 `POST /api/autopilot/agendas/:id/follow-ups`,body `{requestId, note, episodeId?}`(`web/lib/autopilotClient.ts:66`;路由 `srv/autopilotRoutes.mjs:72`;服务 `autopilotService.mjs:730-739`)。
- 若任务被规划器暂停过(`resumableByReply`),发送前先 `startAgenda`(`AutopilotPage.tsx:175`,判定在 `taskPresentation.ts:126-128`)。
- 服务端走同一个 `schedule(trigger:"follow-up", note)`,**每条追问都是一次新的 episode,新会话,新一轮完整预算**(`autopilotService.mjs:1817`、`:1907` 把追问拼进提示词「Researcher's follow-up for this episode」)。不是在上一次的会话里续写。
- 规划器会读这条追问,有一种特殊权限:如果消息是在要求暂停,规划器可以决定停止(`pauseAllowed`,`autopilotService.mjs:2039`;停止落地在 `stopOnDecision`,`:2096`),此时不产生 episode,响应里 `episode: null`,前端重新读取(`AutopilotPage.tsx:180-183`)。这是用语言暂停任务的唯一路径。
- **不能**用语言修改计划、时间、预算:规划器的动作集合只有「运行某类任务」和「停止」(`autopilotService.mjs:2052-2056` 的 `decision.action`);改计划只能走「编辑任务」表单(`TaskForm.tsx`,PATCH `/api/autopilot/agendas/:id`,`autopilotRoutes.mjs:40-50`)。
- 回复**不会出现在抽屉里的某个对话框中**。追问的文字以右侧气泡出现在时间线对应的执行条目上(`TaskTimeline.tsx:38`),结果以「研究线索 / 已复现」的声明语句和文件链接出现(`:44-46`),没有助手的自由文本回答。执行完成前这个条目只有状态词。
- 回复何时可见:要等整个 episode 跑完并折叠出 claims,加上 A3 所述的排队与冷启动;抽屉靠 5 秒轮询发现。

### A5 能否从对话里创建任务;对话里能否显示任务卡;有没有打开任务或会话的桥

**今天不能从对话创建。**
- MCP 工具表里没有任何与定时、任务、agenda 相关的工具:`MCP_TOOL_BASE_NAMES` 全文(`packages/domain/src/toolNames.mjs:45-137`)与对话根可见的 `ROOT_VISIBLE_MCP_BASE_NAMES`(`:229-251`)里都没有。socket 自己的工具(`SOCKET_TOOL_NAMES`,`:166-182`)同样没有。
- `runtime/mcp`、`packages/socket/plugins`、`packages/socket/src`、`packages/harness-port/src` 里 grep `autopilot|agenda`:只有 `capabilities/*/capability.yaml` 的 `autopilot:` 字段、`capability-skills/autopilot-episode/SKILL.md`,以及 `guidanceText.mjs:142/153` 与 `run-policy.mjs:2928` 里的 `<evimed-agenda>`。后者读的是工作区里的 `agendaFile`(研究记忆的议程文件),与本任务系统无关。
- 创建任务的唯一入口是 `TaskForm`(`web/components/autopilot/TaskForm.tsx`)→ `createAgenda` + `startAgenda`,或「推荐」模板预填(`AutopilotPage.tsx:268`)。

**内核自带的调度能力,不能替代。**
- 0.1.7-rc.2 的组合基线里有 `@deepseek-ai/dsh-schedule` 与 `@deepseek-ai/dsh-client-ui-schedule` 两行,都是 `disabled: true`(`deploy/runtime-dsh/dump-config.baseline.json:481-483`、`:618-620`)。
- 在线路径上还被我们主动拒绝:RPC 命名空间 `schedule` 在拒绝名单里,理由写的是「cron-like prompts the control plane does not know about」(`packages/domain/src/runtimeUiSurface.mjs:119-120`、`:132`)。
- 这个包是什么(依据 HECRS 里 0.1.2-rc.1 的 README,**与 0.1.7-rc.2 的差异未核实**):会话内的提醒,提供 `schedule_create / schedule_list / schedule_delete` 三个工具;支持延迟后、绝对时间、固定间隔(至少 5 分钟);到点以普通后续消息回到同一会话;会话关闭时到期的提醒要等到下一个活的根 agent 恢复会话才投递;不支持「每个工作日 9 点」这类日历规则;不发邮件或推送。2026-09-18 的内核清单也记录了同一结论并建议保持关闭(`A-kernel-native-ui-inventory.md:646-657`)。
- 结论:它是「对话内提醒」,不是「无人在线时按日历跑一次完整研究」。要做对话建任务,必须是我们自己的工具,把任务落到现有的 agenda。

**对话回答里显示任务卡:缺零件,但座位有。**
- 帧里工具调用的渲染是 `tool.call.toolview` 键控槽,键空间是开放的,按工具名占位即可(`packages/harness-port/src/runtimeUiToolviews.mjs:36-45`,占位代码 `:535`、`:546`)。工具的中文动词短语表由域包生成(`packages/domain/src/toolViewPhrases.mjs:134` 是 `kb_search` 的例子),新工具要在表里有一行,否则域包的完整性测试失败(`runtimeUiToolviews.mjs:28-32`)。
- 卡片上的「打开」需要外壳导航。帧到外壳的导航词汇是封闭集合 `SHELL_DESTINATIONS = ['new-task','runs','knowledge','memory','capabilities','account','geo','virtual-research']`(`runtimeUiBridge.mjs:470`)。外壳侧映射表是 `new-task, knowledge, memory, capabilities, account, geo, virtual-research`(`web/app/routes/RuntimeUiFrame.tsx:741-745`),**没有 `autopilot`**,也没有 `frontier`、`inbox`。顺带一个小不一致:帧侧列了 `runs`,外壳映射里没有,收到会被忽略(`RuntimeUiFrame.tsx:746`)。
- 帧到外壳的全部消息类型:`booted ready connecting error ack session shell-navigate shell-shortcut open-artifact save-to-knowledge-base kb-query bind-capability geo-options vcr-options search-result`(`runtimeUiBridge.mjs:23-27`)。没有「打开某个任务」的消息。外壳到帧:`navigate resume theme run-state evidence kb-result reply-check capability geo vcr search`。

**外壳打开一个会话:有。向会话里发一条消息:帧桥没有,但有 REST。**
- 打开:`navigate('/app/chat/<sessionId>')` 即可(见 A2)。意图类型 `RuntimeUiIntent = {kind:"create"|"open", projectId, requestId, sessionId, draft?, resultRevision?}`(`web/lib/runtimeUiNavigation.ts:4-11`)。
- `draft` 只是填进输入框,从不自动发送(`runtimeUiNavigation.ts:3` 注释「a draft never submits」)。所以外壳无法通过帧桥「替用户发一条消息」。
- 外壳能发消息的方式是 REST:`POST /api/agent-runs/dispatch`,body `{sessionId, text, dispatchId?, line?}`(`srv/server.mjs:6144-6150`;前端 `dispatchWebAgentRun`,`web/lib/apiClient.ts:1750`,`ConnectorNeedNotice.tsx:79` 在用),走的是已绑定会话的 `assertPublicSessionPrompt`(`server.mjs:6175`)。这是一条已存在的服务端发送路径,不经过帧。
- 服务端向既有会话发提示词的能力也存在:`runtimeManager.dispatchPrompt(project, sessionId, …)`,自动研究的修复回合就是对同一会话再次调用(`server.mjs:4216-4232` 的 `repairText` 分支)。

### A6 通知

- 一次执行成功折叠后创建 digest(`autopilotService.mjs:1082`、`:2236`),**仅当有重点发现或线索时**才发一条收件箱通知「主动科研简报:<标题>」,正文「N 条重点发现,M 条待验证线索」,带「查看简报」按钮(`:2261-2267`)。没有发现的日子不通知(注释写明,`:2257-2260`)。
- 其他会写通知的地方只有三处:已采纳结论复核未通过(`:1425-1434`)、规划器停止(`:2119-2122`)、单次上限低于下限(`:2153-2156`)。
- **执行失败、被取消、因资源等待,都没有通知。** 只有时间线上的「未完成 / 等待余额 / 等待运行资源」(`taskPresentation.ts:70-77`)。
- 自动研究自己的运行不走「运行完成」通知:`runFinishedReachesInbox` 对 `autopilotOwned` 返回 false(`srv/notificationService.mjs:320-321`)。
- 通知落点:`source: {type:"digest", id}`。收件箱页(`web/app/routes/InboxPage.tsx:286`)与飞书卡片(`srv/imService.mjs:126`)都指向 `/app/autopilot?digest=<id>`,再由 A2 所述的 effect 重定向到那次执行的对话 `/app/chat/<sessionId>`。

### A7 侧栏

- 「定时任务」只是一个导航目的地(`Sidebar.tsx:61-68`),侧栏不列任务。侧栏下半是 `ProjectBrowser`(项目与其对话,`:213`),对话列表由运行账本分组而来(`web/lib/conversations.ts:34-54`,数据来自 `listWebAgentRuns`,`web/lib/apiClient.ts:1650`)。
- 自动研究的运行是否出现在该对话列表里:`GET /api/agent-runs` 只过滤 `visibility:"internal"` 的能力和已删除/归档项(`server.mjs:6026-6040`),自动研究映射到的是公开能力(`capabilityManifest.mjs:113-120`),所以按代码看**不会被过滤**,应当出现在对应项目的对话树里。线上是否确实出现,未核实(没有实机)。
- AppShell 现在只有「侧栏 + 主区」两列:`<Sidebar />`(`web/app/layout/AppShell.tsx:187`)和 `<main>`(`:190`),主区里是常驻的 `SessionFrameHost`(`:214`)与路由出口(`:226`)。没有第二栏的槽位。
- 要做「次级面板」有两种方式:(a) 在 `AppShell` 里在 `<Sidebar />` 与 `<main>` 之间加一个 flex 兄弟列(仅在 `/app/autopilot*` 时渲染);(b) 页面自己布局:`PageShell width="full"` 就是为「自己排版的拆分视图」准备的(`web/components/layout/PageShell.tsx:15-19`、`:68`)。后者不动外壳。窄屏(< `lg`)侧栏本身已经是覆盖式抽屉(`Sidebar.tsx:179`、`AppShell.tsx:18-30`),次级面板需要自己处理窄屏。

### A8 R12 的变化

`git log 3e52ca1f2..adcd02e6b` 共 16 个提交。与定时任务相关的:

- `131cbb191` 自动研究:折叠完成时若任务已停止,关闭它排下的复核(只改 `srv/autopilotService.mjs`)。
- `86839fc64` 内核拒绝带上调用名(`srv/dshRuntimeAdapter.mjs`、`srv/runtimeManager.mjs`)。
- `3190de7bb` 后台工作(含自动研究、虚拟临床研究、循证 GEO 步骤)最多占账户运行位上限减一(`runtimeManager.mjs:5532` 的 `assertBackgroundShare`),超额按 `runtime_capacity_full` 排队。
- `apps/web/src` 在 R11→R12 之间**没有任何改动**(`git diff --stat` 对 `OpenScience/apps/web/src` 为空)。所以线上的抽屉形态就是 R11 的。

### A 可行的改法与所需改动

1. **任务页改成「左列表 + 右主区」的整页视图,任务有自己的地址。**
   改 `web/app/router.tsx`(加 `autopilot/:taskId?`,并让旧的 `?task=` 重定向过去,保住书签与通知链接)、拆 `web/app/routes/AutopilotPage.tsx`(列表与详情分开),用 `PageShell width="full"` 或在 `AppShell` 加次级栏。列表行补 `menu`(暂停 / 立即运行 / 编辑 / 删除:服务端端点都已存在,`autopilotRoutes.mjs:40-72`)。**不需要新的数据契约,不需要内核能力。** 「分享」没有对应端点,若要必须新增。
2. **「打开任务 = 看到它的对话」。**
   最小做法:详情页主区放最近一次执行的会话入口,直接复用 `chatPath(sessionId)`(今天就有)。若要「每次运行追加到同一个对话」,需要**新的数据契约**:`agenda.payload.sessionId`,并让 `dispatchEpisode` 向该会话再次 `dispatchPrompt`(服务端能力已有,见 A5 末尾),同时要处理上下文增长、每次运行的预算作用域、独立复核运行(`-v<n>`)与它的关系。**不需要新的内核能力**(多轮对话本来就是内核的常态),需要认真评估压缩与成本。
3. **让任务能在用户开着的对话里跑,消除互斥。**
   把 `dispatchVcrRun/dispatchGeoRun` 的 `interactive` 分支搬进 `srv/server.mjs:4162` 的 `dispatchEpisode`:项目运行时已热且不是受限状态时,直接在其中起会话,`allowBounded:false`,不发预算标记。需要评估的一点:受限运行时的预算上限是通过令牌作用域强制的,`interactive` 时没有这层强制(`server.mjs:4791`),单次上限怎么落地要定。**不需要内核能力。**
4. **运行中的可见进度。**
   两条路:(a) 做了第 3 点之后,「打开」直接进入正在跑的会话,由内核自己画实时轨迹;(b) 抽屉读运行账本里已有的进度(`/api/agent-runs` 已带 `withPlanProgress`,`server.mjs:6028`),按 `episode.payload.runId` 取对应运行显示步骤数与阶段。(b) 只改前端与一个按 runId 取单条运行的读取,**不需要新契约**。同时把轮询上限(`AutopilotPage.tsx:137`)改为与执行时长相称,或在有在途执行时不设上限。
5. **从对话创建任务,并在回答里出现任务卡。**
   - 新增一个 MCP 工具(例如 `schedule_task`,先「提议」后「启用」),模式照 `kb_search`:`runtime/mcp/evimed-research` 里一个新模块;`packages/domain/src/toolNames.mjs` 的 `MCP_TOOL_BASE_NAMES` 与 `ROOT_VISIBLE_MCP_BASE_NAMES` 各加一行;`toolViewPhrases.mjs` 加一行动词短语;控制平面加一条内部网关(参照 `srv/kbSearchGateway.mjs`),令牌决定账户与项目,网关调用 `AutopilotService.create`,不接受运行时自报项目。
   - 卡片:在 `packages/harness-port/src/runtimeUiToolviews.mjs` 为该工具名占一个 `tool.call.toolview`,显示「标题 · 星期五 9:00 · 打开」。
   - 打开:在 `runtimeUiBridge.mjs:470` 的 `SHELL_DESTINATIONS` 与 `RuntimeUiFrame.tsx:741` 的映射表里各加一个 `autopilot`,并允许带任务 id(参照 `geo` 带 `tab` 的做法,`runtimeUiBridge.mjs:493-497`、`RuntimeUiFrame.tsx:747-756`)。
   - 涉及花费的动作建议「提议 → 卡片上确认启用」,启用由外壳调用已有的 `startAgenda`;这与「工程边界留在代码里」一致(原则 14)。
   - 这些改动都在 harness-port、socket 与运行时镜像里,**需要重建运行时镜像并走引擎 delta 步骤**(帧 bundle 来自运行它的镜像)。**不需要新的内核能力,不需要启用 `dsh-schedule`。**
6. **用语言修改任务。**
   规划器今天只会「运行 / 停止」(A4)。要让追问能改时间或预算,需要扩展规划器的决策模式(`srv/autopilotNextAction.mjs`)与服务端 PATCH 校验,属于**新的数据契约**。更省的做法是做了第 5 点之后,在任务对话里让模型调用一个 `update_task` 工具,仍落到现有的 PATCH。
7. **通知补洞(可选)。** 失败、等待资源与「无新发现」目前都不通知,只在时间线上。如果任务要成为「会话线程」,每次运行结束可以往该线程追加一条状态,而不是依赖有发现才发的简报。

---

## B 知识库

### B1 页面、列表、抽屉的组件;内容与原文显示什么;「⋯」菜单

- 路由 `files` → `KnowledgePage` → `SourcesPage`(`web/app/router.tsx:111`、`web/app/routes/KnowledgePage.tsx:12-14`)。旧地址 `/app/sources` 重定向到 `/app/files?tab=sources`(`router.tsx:137`),`tab` 参数现在没有人读。
- `SourcesPage.tsx:90-396` 是整页:`PageShell title="知识库" width="wide"`(`:340-342`),`meta` 位置是范围菜单 `KnowledgeScopeMenu`(`:343`),页头 `actions` 是搜索框和「添加」菜单(`:344-347`,菜单项见 `:319-328`)。再下面是类型筛选条 `FilterChips`(至少两种类型时才出现,`:349-351`)和列表 `List`(`:358-369`)。整个页面是拖拽上传的落点(`:279`、`:331-339`)。
- 列表行 `SourceRow`(`web/components/sources/SourceRow.tsx:41-74`):图标(按类型)、标题、第二行是一句「讲了什么」(理解完成后取摘要首句,≤90 字,`srv/sourceDisplay.mjs:16-23`)或状态词、第三行是「类型 · 站点 · 页数/大小 · 来源 · 所有项目可用」(`web/components/sources/sourceView.ts:57-67`)、右侧日期、行尾「⋯」。
- 点行打开右侧抽屉 `SourceDrawer`(`web/components/sources/SourceDrawer.tsx:36-97`),还是通用 `Drawer`,`bare` 模式:页头是元信息 + 标题 + 「⋯」+ 关闭(`:64-72`),页签 `内容 / 原文`(`:73-74`),页脚主按钮「在对话中使用」+ 次按钮「下载」(`:88-93`)。宽度:内容页签 `max-w-xl`,原文页签 `max-w-4xl`(`:62`)。笔记型资料默认落在「原文」页签,原文就是编辑器(`:48-49`、`:80`)。

**「内容」页签显示什么**(`web/components/sources/SourceContent.tsx`,文件内行号):

- 「讲了什么」:理解的 `summary` 全文(第 89 行);文献类再列至多 3 位作者(第 90-92 行)。
- 「研究信息」:仅文献,且只列已知的槽位:研究设计、研究人群、干预或暴露、研究终点、效应估计、DOI(`PAPER_SLOTS`,第 19 行;渲染第 96-106 行)。
- 「要点」:至多 8 条声明,每条带「第 N 页」(PDF 点击切到原文页签并翻到该页,第 111-130 行;`KEY_POINTS = 8`,第 12 行)。
- 数据表改显示「数据含义」面板 `DatasetMeaningPanel`(列与含义、依据),且该面板只在有分析记录过数据含义时才渲染(`web/components/sources/DatasetMeaningPanel.tsx:12-19` 注释与实现)。
- 读取中显示「正在读取」;失败显示失败原因句子 + 「重新读取」按钮(第 62-69 行)。
- **不显示**覆盖率(已读/仅索引/无内容/失败)、解析遗漏率、版本、分块、表格与图注。

**「原文」页签显示什么**:`FilePreviewInspector embedded`,传 `page`(`SourceDrawer.tsx:82-85`)。PDF 是浏览器**原生** `<iframe>`,地址带 `#page=N&view=FitH&navpanes=0`(`web/components/inspector/FilePreviewInspector.tsx:306-309`、`:488-493`),没有 PDF.js,没有高亮,没有文内检索。云盘来源的文档没有本地原件,改显示解析出的文本(`SourceDrawer.tsx:26-29`)。

**「⋯」菜单**(行与抽屉共用一份,`SourceRow.tsx:17-33`):「重新读取」(链接型、或状态为失败/需处理/完成/已取消时)、「改为仅本项目」或「设为所有项目可用」、「处理疑似重复」(仅有重复候选时)、分隔线、「删除」。没有重命名、移动、打标签、导出。

### B2 「在对话中使用」到底做了什么

`openInConversation`(`SourcesPage.tsx:284-295`):

1. 拼一段草稿:「请阅读知识库里的这份资料,并据此回答我的问题,引用时标出处。\n\n资料:<标题>(<文件名>)\n\n我的问题:」(`:289-290`)。
2. 目标项目:共享范围里的文档用当前项目,否则用文档所在项目(`:291`)。
3. `select(target, …)` 先切换当前项目,然后 `navigate("/app/chat", {flushSync:true, state:{runtimeUiIntent: newRuntimeUiIntent(draft)}})`(`:292-294`)。

后果:**总是开一个新对话**(`kind:"create"`,`web/lib/runtimeUiNavigation.ts:21-27`),草稿填在输入框里不发送;**不附加文件,不设置范围,不生成引用 chip**。模型要靠标题自己去找资料(读 `.evimed-knowledge/` 或调 `kb_search`,见 B4)。离开了知识库页面,不会回到原页面。没有在当前对话里「附加到这条对话」的路径。

桥与意图:经由外壳到帧的 `evimed.runtime-ui.navigate`,`intent.draft` 上限 10 万字符(`runtimeUiBridge.mjs:440-466`)。

### B3 每份资料有而界面没显示的数据

服务端和前端类型里已有、界面没用的:

- **分块**:`SourceUnderstanding.units[]`(分块 id、起止偏移、文本、状态,`web/lib/sourceClient.ts:57`)。`getSourceUnderstanding` 已返回,抽屉不用。
- **页码映射**:`pageMap`(`:66`)只用来给「要点」标页码,不用来浏览。
- **结构化材料账本**:`coverage.materials`(表格数、值的定位/歧义/未定位、图注、脚注、补充材料、页面文本层状态等,`web/lib/sourceMaterials.ts:8-26`)。服务端有读取路由:`GET /api/sources/:id/materials` 与 `/materials/:tableId`(带单元格地址和页码,`srv/sourceRoutes.mjs:170-172`)。前端**没有任何调用**(grep `web/src` 无 `/materials` 的资料调用)。
- **覆盖率与遗漏**:`coverage.{total,accounted,extracted,indexedOnly,noContent,failed,percent,omissionRate}` 与 `omissionNotice`(`sourceClient.ts:76-85`、`:154-159`)。界面只把 `needs_attention` 翻译成行上的「部分无法读取」(`sourceView.ts:24`),不说是哪部分。
- **方法条目**:`methods[]`(`sourceClient.ts:40-50`)界面不显示。
- **元数据**:`metadata.keywords`、`doiCheck`(Crossref 核对结果)(`:90-105`)只用了作者、期刊/年份、DOI 的一小部分;没有标签/关键词展示。
- **版本**:`familyId`、`version`、`GET /api/sources/:id/family`、`GET /api/sources/:id/understanding/history`(`sourceClient.ts:203`、`:365`)。前端函数存在但没有调用方(grep 确认)。笔记保存会生成「下一版本、新的文档 id」(`sourceClient.ts:273` 注释),界面只展示当前版本。
- **覆盖手段**:`PATCH /api/sources/:id` 可改 `docType`、`depth`(`sourceRoutes.mjs:187-190`),界面没有入口。
- **反向引用(哪些对话/报告用过这份资料)**:**没有这份数据**。在 `srv/source*.mjs`、`srv/kb*.mjs` 里 grep `citedBy|usedBy|referencedBy|backlink` 无结果;`kb_search` 的调用没有按资料记账。相邻的是结果侧:`ResultImpactPanel`/`sourceChanges.mjs` 记录「一个结果依赖哪些来源」(`inputs.kind==="source"`,`srv/resultSourceUpdatesRoutes.mjs:35-37`),这是结果到来源的方向,界面也没有反过来给资料用。
- **标签、集合、文件夹**:没有这些概念(见 B5)。

### B4 对话运行时如何读知识库

- 每次派发前,控制平面把项目知识库同步到工作区只读目录 `.evimed-knowledge/`,解析后的正文在 `knowledge-base/.evimed-derived/<sourceId>/`(`srv/researchContext.mjs:96`、`:243-253`;`packages/domain/src/workspaceLayout.mjs:26`)。提示里只放指针,不预先检索(原则 12):「个人知识库已同步到工作区的……需要时用 mcp__evimed__kb_search 检索,或直接读取文件」(`researchContext.mjs:251-253`)。
- 工具名是 `kb_search`(MCP 名 `mcp__evimed__kb_search`),在对话根可见的工具列表里(`toolNames.mjs:112`、`:248`)。参数:`query`(必填,≤512)、`limit`(1-20)、`sourceIds`(至多 50 个 `src_…`,用来限定范围,`runtime/mcp/evimed-research/kb_search.py:43-66`)。检索范围是**当前项目的资料 + 账户的个人资料库(「所有项目共享」)**(`kb_search.py:2-12` 的文件说明与 `:47-51` 的工具描述)。
- 后端是混合检索:CJK 词对/词项 tsvector、三元组相似度、向量余弦,倒数排名融合后再用 `qwen3-rerank` 重排;资料库小于阈值时不检索而是返回「请直接读这些文件」的清单(`srv/kbIndex.mjs:14-31`、`:417-423`)。每个命中带 UTF-16 偏移,片段正是该偏移的切片(`kbIndex.mjs:30-31`),并带页码(`pages` 在小库清单里,命中里的页码由 `pageMap` 推出,命中结构细节未逐字段核对,未核实)。
- **用户能不能指定本次对话用哪些资料**:
  - 逐条消息可以:输入框里的 `@` 菜单列出本项目已解析的资料(`kb-query` → `kb-result`,外壳实现 `web/lib/runtimeUiBridge.ts:355-371`,至多 20 条,按名称/摘要匹配;帧侧 `runtimeUiCommands.mjs:146-190`),选中后插入引用 chip,发送时序列化成「【知识库文献 src_… 「标题」,解析后的正文在工作区 …/.evimed-derived/src_…/ 下】」(`runtimeUiCommands.mjs:189-192`)。
  - 对话级的持久范围没有。「在对话中使用」不走 `@` chip(B2)。模型可以自己给 `kb_search` 传 `sourceIds`,但用户无法为一个对话固定一组资料。
- **回答是否引用知识库段落,引用能不能在外壳里打开那一段**:
  - 外壳里没有任何「资料 id + 偏移/页码」的深链:`SourcesPage` 完全不读 URL 参数(grep `useSearchParams` 无结果),抽屉状态 `opened`、范围、筛选、搜索都只在组件状态里,没有 `?source=`(`SourcesPage.tsx:90-109`)。全站没有指向 `/app/files` 的带参链接(只有侧栏与帧的 `knowledge` 目的地,`RuntimeUiFrame.tsx:742`)。
  - 外壳里已有的「打开并标出引文」机制是针对运行产出文件的:`/app/runs/:runId/files/*?quote=…`(`web/app/routes/RunFilePage.tsx:28-51`、`:165`)和报告里的「依据」气泡。帧的 `open-artifact` 消息只接受 `runId + path (+anchor)`(`RuntimeUiFrame.tsx:776-785`,`runtimeUiBridge.mjs:507-515`),`anchor` 只允许字母数字短串。
  - 一次 `kb_search` 命中能否沿这条路径在外壳里显示出被引段落:没有找到连接代码。是否有回答真的这样链接过,未核实(需要读真实对话产物)。

### B5 组织方式

- **范围**:项目即范围。页头的范围菜单把项目按「我的项目 / 虚拟临床研究 / 循证 GEO」分组,最后是「所有项目共享」(`web/components/sources/KnowledgeScopeMenu.tsx:25-49`,`SHARED_SCOPE_NAME` 在 `:14`)。选范围只改本页列表,不切换当前项目(`:19-23` 注释)。页上显示的「我的研究」就是当前项目的名字。
- **共享**:「设为所有项目可用 / 改为仅本项目」进出账户资料库(`/api/library`,`sourceClient.ts:406-411`)。共享范围的列表按内容哈希去重(`srv/sourceService.mjs:1316-1321`)。
- **没有**文件夹、集合、标签。唯一的「夹」是 OpenList 的云盘文件夹同步(`registerSourceFolder` 等,`sourceClient.ts:368-380`,只在「从网盘导入」抽屉里)。来源分类 `SOURCE_ORIGINS`(上传 / 网盘 / 链接 / 笔记 / 前沿动态 / 对话产出)是平台写入位置推出来的(`packages/domain/src/sourceVocabulary.mjs:160-167`),用户不能自定。
- **类型筛选**:6 类(文献与指南 / 数据表 / 文档 / 网页 / 笔记 / 图片),计数由服务端对整个范围和搜索算出(`sourceVocabulary.mjs:40-47`,`sourceService.mjs:1294-1330`),界面显示至少有两类时才出现(`SourcesPage.tsx:349`)。
- **搜索**:服务端 `strpos` 子串匹配,只匹配文件名、标题、元数据标题、作者、摘要、链接地址(`sourceService.mjs:93-98`)。**不搜正文**。正文检索只存在于运行时的 `kb_search`,页面没有用到。
- **排序**:固定按 `created_at DESC, id DESC`(`sourceService.mjs:1340`),没有排序选项;每页 50 条,滚动加载(`SourcesPage.tsx:40`、`:185-191`)。
- **批量操作**:没有多选,没有批量删除或批量共享(`SourceRow` 只有单条菜单)。
- **每份资料或整库问答**:没有页面内的问答入口。唯一的是「在对话中使用」(B2)。整库问答靠对话里的 `kb_search`(B4)。
- **疑似重复**:`version-family / shared-content / similar-name` 三类分组,行上打「疑似重复」标签,在单独抽屉里选「合并/忽略」(`SourcesPage.tsx:207-223`、`:386-390`,类型 `sourceClient.ts:343-363`)。

### B6 摄入

- **入口**:页头「添加」菜单:上传文件、添加网页链接、新建笔记、从网盘导入(仅 `features.openList` 为真时)(`SourcesPage.tsx:319-328`、`:112-120`)。此外有两个不在本页的入口:对话里文件卡的「存入知识库」(`RuntimeUiFrame.tsx:786-797`,服务端命令 `save_to_knowledge_base`,`sourceClient.ts:285`),以及前沿动态保存(来源标为「前沿动态」)。
- **上传**:选择器与整页拖拽都走 `uploadFilesToWorkspace(files, "knowledge-base", "base", projectId)`(`SourcesPage.tsx:259-278`)。支持的格式族:PDF、Word、PPT、Excel 与表格、图片、电子书、网页、纯文本与代码;音视频不支持,并在发送前就拒绝、逐个文件说明原因(`web/lib/knowledgeBaseFiles.ts:10-19`、`:24-25`、`:35-47`)。
- **网页链接**:`POST /api/sources/links`,服务端读页面并保存快照(`sourceClient.ts:262-264`);「重新读取」对链接型是按地址重新抓取,并告知「页面有更新」或「页面没有变化」(`SourcesPage.tsx:236-243`)。
- **笔记**:标题 + Markdown 正文(`AddEntryDialogs.tsx:46-79`),保存产生新版本(新文档 id)(`sourceClient.ts:273-276`)。
- **网盘**:OpenList 浏览、导入、登记文件夹同步(`web/components/sources/DriveImport.tsx`、`sourceClient.ts:368-400`)。
- **状态词**(`sourceView.ts:22-31`):正在读取(排队或解析中)/ 没能读取 / 部分无法读取(`needs_attention`)/ 原件已移除(`missing`)/ 已取消。可用的资料行不写状态。读取中的行每 5 秒后台刷新一次(`SourcesPage.tsx:193-205`)。
- **解析失败**:行上红字「没能读取 · 重试」;悬停提示是错误代码对应的中文句子,管理员账户再附代码(`SourceRow.tsx:85-97`,句子来自 `sourceFailureMessage`,`sourceClient.ts:194-198`)。对 `source_understanding_*` 与 `source_ingestion_failed` 等代码,字典里还没有句子,会落到「把这个代号交给管理员」的兜底(`sourceClient.ts:188-193` 注释)。
- **重新读取**:`retrySource(id, revision)`(`SourcesPage.tsx:242`),允许的状态是失败 / 需处理 / 完成 / 已取消(`sourceView.ts:34`)。文档解析走自研解析 API,纯文本类走服务器本地字节读取(`packages/domain/src/sourceDocuments.mjs:62` 的 `sourceFormatRoute`:`local | api | media`)。

### B7 R12 的变化

R12 没有改动知识库:对 `srv/source*`、`srv/kb*`、`srv/library*`、`srv/knowledge*`、`web/components/sources`、`web/app/routes/SourcesPage.tsx`、`kb_search.py`、`sourceVocabulary.mjs` 的 `git log 3e52ca1f2..adcd02e6b` 为空,`apps/web/src` 整体也无改动。线上的知识库就是 R11 的形态。

### B 可行的改法与所需改动

1. **资料有自己的地址和可恢复的视图。**
   在 `router.tsx` 加 `files/:sourceId?`,把范围、类型、搜索词、当前资料、页签、页码放进 URL(`SourcesPage.tsx` 现在零 URL 状态)。这是通知、前沿卡片、对话引用以后能「链到某份资料某一页」的前提。**不需要新数据契约,不需要内核能力。** 设计参考文档(`docs/ui-ux-audit/2026-10-08-evimed-design-reference.md:172`)已把它列为目标。
2. **抽屉改成阅读视图,把已有数据摆出来。**
   「内容」页签增加:分块/段落列表(`units`,已随 `/understanding` 返回)、覆盖说明(`coverage`)、表格与图注(`/materials`,服务端已有)、版本(`/family`)。全是**已存在的接口**,只缺前端。PDF 若要做到「点要点跳到页并高亮原句」,原生 iframe 做不到,需要引入 PDF.js 之类的前端依赖,这是一个新的前端依赖决定。
3. **「在对话中使用」变成真正的范围/引用,而不是一段草稿。**
   `RuntimeUiIntent` 现在只有 `draft` 字符串(`runtimeUiNavigation.ts:4-11`)。要让「使用」落成 `@` 引用 chip,需要给意图加 `references: [{id,title}]`,并在帧侧 `runtimeUiBridge.mjs:440-466` 的 `navigate` 处理里调用内核的输入触发器插入 chip(`ctx.inputTriggers` 的编程式插入是否可用,未核实,需要在 0.1.7-rc.2 的客户端上探测)。这需要改 harness-port 与重建运行时镜像。若不愿碰帧:退一步在草稿里写明 `src_` id 与路径(`knowledgeSerialization` 的格式,`runtimeUiCommands.mjs:189-192`),模型就不必再检索;不需要内核能力。
4. **对话级的资料范围。**
   参照 `bind-capability`(帧到外壳绑定能力,`RuntimeUiFrame.tsx:824` 起)新增会话级「资料范围」绑定:新数据契约 `session.sourceScope`,服务端 `researchContext.mjs:243-253` 的知识库指令据此只列这些 id,`kb_search` 已支持 `sourceIds`(`kb_search.py:43-66`、`kbSearchGateway.mjs:56-77`)。不需要内核能力。
5. **反向引用(资料 → 用过它的对话与报告)。**
   需要**新的数据契约**:记录每次 `kb_search` 命中和 `.evimed-derived/<id>/` 读取对应的 sourceId 与运行。两个来源:运行转录里的工具调用(`runTranscripts.mjs` 已落盘)或网关侧在 `kbSearchGateway.mjs:127-135` 记一笔 `(sourceId, runId, sessionId)`。读取侧再加一个 `GET /api/sources/:id/uses`。
6. **引用 → 段落的打开。**
   `kb_search` 命中已有 UTF-16 偏移和页码,缺的是目的地:`/app/files/:sourceId?page=N&at=start-end`,以及资料阅读视图里对偏移的高亮(`RunFilePage` 的 `?quote=` 与 `ReportReader highlight` 是现成的参照,`RunFilePage.tsx:28-51`)。帧一侧要让回答里的资料引用成为可点的东西,需要给 `open-artifact` 之外加一种消息(例如 `open-source`,带 `sourceId/page/start/end`),在 `SHELL_DESTINATIONS`/消息表里各加一行并重建镜像;这是**帧桥扩充**,不是内核新能力。
7. **组织能力(标签、集合、批量、排序)。**
   这是产品决定而非技术阻碍:`documents` 账本是通用文档表,可以加 `tags` 字段与对应过滤(`searchSql` 与 `KIND_SQL` 旁);排序和多选是纯前端加一个服务端 `order` 参数。需要**新的数据契约**(标签字段、`PATCH` 允许字段,`sourceRoutes.mjs:187-190` 目前只允许 `docType/depth/reason`)。

<!-- F2 DONE -->
