# 2026-09-07 · 上一阶段复核、交付体验的一类问题、下一阶段 TODO

复核对象：`main` 上 `deb30513b..36138f712`（11 个提交，声称关闭 2026-09-07 缺口清单的 P0–P2）。方法：三路独立代码审计（缺口逐项核对、阻断点普查、用户可见面审计）+ 生产主机只读探测（运行账本、错误账本、磁盘、证书、镜像）+ 联网核查依赖与文献。结论都附文件位置；没确认的写"未确认"。

## 0. 一句话结论

**代码阶段基本完成，交付阶段没有开始。** 13 项里 8 项完成、4 项部分、2 项未做；另有 7 处"造好了但没人喂"。更重要的是：生产跑的仍是合并前的 `evimed-20260907-fd5657b`，这 11 个提交一个都没上线；临床证据深度分析在生产 7 次尝试、0 次验收；而**产品里能让研究者看到门禁结果的那一整面界面根本不在路由上**。用户"突然就出不来了、出来的又消失了"的感受，在生产账本里是可以量出来的（§2）。

## 1. 上一阶段完成度核对

| 项 | 判定 | 残余 |
|---|---|---|
| P0-4 用量对账 | 完成 | 无 |
| P0-6 验收台账 | 完成 | 台账如实记录 16 个能力里 14 个从未有过真实交付验收 |
| P0-8 / P2-19 文档纠偏与归档 | 完成 | 无 |
| P1-9 插件生态 | 部分 | `APPLY_PATH_PLUGIN_IDS` 仍只有 `dsh-cite`，第二个插件被标为已安装时 `pluginRegistryFrom` 直接抛错（`pluginService.mjs:85,107`）；插件级矩阵在 CI 里 `not-probed`（`upstream-matrix.yml` 未设 `EVIMED_PLUGIN_PROBE`） |
| P1-10 资料接入 | 部分 | (e) 语料级覆盖台账无任何生产者/消费者；(d) 遗漏审计的 `omissionNotice` 写进了库、API 也返回，**前端 0 处读取** |
| P1-12 胶囊方法挂载 | 完成 | 挂载路径是 `/runtime/capsule-methods`，计划文案写的 `/opt/evimed/...` 已过时 |
| P1-13 个性化学习 | 部分 | `distill` 的唯一触发器 `reportWebDeliverableFeedback` **没有任何 UI 组件调用**（`apiClient.ts:1138`），所以运行中的产品永远产生不了一个 distill 任务；蒸馏出的 `method` 文档没有读者；`consolidate` 仍无生产者；(d) 可测量指标未做 |
| P1-14 主动科研独立验证 | 完成 | 验证者仍与回合共享 `/runtime`（DSH home），代码里写明需要控制器协议升版 |
| P1-15 简报/收件箱 | 部分 | `question` 只有一个生产者（复核驳回已采纳结论）；回合中途模型需要裁决时仍没有；收件箱里 `仍然沿用` 是记录了点击、没有任何行为（`notificationService.mjs:199-205`） |
| P1-16 计量 | 部分 | `price-list` 文档种类仍无读写者；`priceListAt` / `PRICE_LIST_VERSIONS` 是只有测试调用的死导出 |
| P2-17 组合任务测试 | 完成 | 留下一个如实标注的 KNOWN DEFECT：组合交付丢了一件时 run 行不说 |
| P2-18 7 个能力 ×4 brief | 完成 | 一份都没跑过 |
| F `OPEN_SCIENCE_AUTOPILOT_ENABLED` 进基础栈 | 未做 | 仍只在 ingestion overlay；`config.mjs:1098` 在 production 默认开——所以生产其实开着，但清单要求的两条路一条都没走 |

**"造好了但没人喂"（7 处）**：`reportWebDeliverableFeedback`（无 UI 调用）、蒸馏出的 `method` 文档（无读者）、`omissionNotice`（无 UI）、`priceListAt`/`PRICE_LIST_VERSIONS`（无生产调用）、`VERIFICATION_ROUTE_REASON`（只写不读）、`consolidate` 任务种类（无生产者）、收件箱 action id（无消费者）。上一轮修掉的 3 处暗线（capsuleService 赋值、验证回折键、notifications 注入）已由 `serverComposition.test.mjs` 断言，不会再暗回去。

## 2. 生产实测（2026-09-07 UTC 22:55，只读）

**运行账本**（41 个项目的 `runs.jsonl`，全部历史，179 次结束的运行）：

| 结局 | 次数 | 占比 | 时长中位 / p90 / 最大（分钟） |
|---|---|---|---|
| 交付成功 | 131 | 73% | 39.6 / 60.6 / 87.7 |
| **门禁拒绝**（`specialist_*`） | 28 | **15.6%** | 16.2 / **57.8** / **107.7** |
| 运行时失败（`runtime_*`） | 16 | 9% | 11.4 / 38.6 / 43.6 |
| 取消 | 4 | 2% | — |

28 次门禁拒绝的 `artifacts` **全部为空**——最长 108 分钟的工作，用户一个文件都拿不到。拒绝原因：traceability 12、integrity 5、provenance 4、citation 3、required_output_missing 2、receipt_digest_mismatch 1、delegated_read 1。

**9 月的 16 次**：14 次开放问答（11 次带 `The open-domain-answer skill was not loaded…` 通知 → `verification: "unverified"`，**发生率 100%**）；1 次 `runtime_stopped` 时长记为 **20.7 天**（陈旧运行被清扫时用了墙钟差）；1 次临床证据运行——见下。

**那一次临床证据运行**（`eval-rtpapers-0907-fd-review-aripiprazole`，57.8 分钟）：工作区里 `deliverables/arp-tdm-review/` 下 9 个文件齐全（报告、证据矩阵、引用台账、bib、审计、修订说明…）。门禁找到 10+ 条**可修复**问题（"数值 X 不在其直接支持里，请引出原句或在不确定性里说明"），准备走修复回路，先给已接受的包做快照——快照抛错（运行在提交后还在改文件，`accepted repair source changed during snapshot`），于是 `specialist_evidence_repair_snapshot_failed` → `specialist_receipt_digest_mismatch`，`artifacts: []`。研究者看到的是「未完成 · 运行未通过核验。」和「暂无交付物」。**报告就在盘上，1.7 MB，任何 API 都拿不到。**

**错误账本**（9/1 起）：`unauthorized` 44、`public_source_pdf_not_open_access` 40、`public_source_gateway_token_invalid` 18、`model_gateway_unavailable` 12、`project_limit_reached` 6、`runtime_limit_exceeded` 3。后三个没人看过。

**主机**：`/` 178 GB，已用 167 GB，**剩 3.4 GB（99%）**；`docker system df` 可回收镜像 39 GB——仅 9/7 一天就留下 9 个 4.12 GB 的运行时镜像。没有磁盘告警规则（现有 10 条规则全是探针/HTTP/队列）。这正是上次 502 的成因，而且会再来一次。

**证书**：Let's Encrypt `shortlived` profile（6.67 天），`evimed-certbot-renew.timer` 每天两次，上次续期 9/5 00:05 CST，日志"no renewal failures"，下次预计 9/9。**P0-3 是误报**——它是一张会自动换的短期证书，不是"9/11 之前压倒一切"的事故。缺的是证书到期告警，不是人工续期。

**部署**：`/srv/evimed-science/releases/evimed-20260907-fd5657b`（合并前 review 分支尖）。上一阶段 11 个提交无一上线。

## 3. 一类问题，不是一堆问题

用户的判断是对的：这些不是十几个独立 bug，是同一套设计假设在真实运行里反复失效。把它们按"设计时假设了什么"归类，每类给一条通用规则，一条规则关掉一批分支。

### A. 「回执即真理」——把交付当成密码学身份，而不是盘上的文件

**假设**：运行提交后就不再碰文件；每件交付物恰好经过一次 `evimed_submit_deliverable`；控制面总能拿到与回执逐字节相同的内容。
**现实**：运行提交后继续改（aripiprazole）；子代理替父提交、父再修（9/7 五次运行各自死在不同的守卫状态：提交上限、一次性授权、父子归属、`唯一…` 正则误报、通过却无回执）；8/31 一次 38 分钟门禁全绿的包因摘要不符被整包丢弃（`agentRuns.mjs:3252-3262` 的注释自己记着）。
**后果**：七条拒绝分支里五条写 `artifacts: []`（`agentRuns.mjs:2851,2902,2928,3419,3761,3785`）；修复快照存进 `.openscience/repair-revisions/`，**没有任何路由能读它**。
**通用规则**：**交付是标签，不是开关。** 只要工作区里有交付文件，就发布它们，并附一个裁决 `{verified | unverified(issues) | gate_failed(issues) | killed(reason)}`；`artifacts: []` 只允许在工作区确实没有交付文件时出现。回执不符 → 用同一套门禁对盘上现字节重判（live 路径 `:3427` 已经这么做了），重判不过就按 `unverified` 交付，永远不丢。这一条规则替换掉 5 个分支，也让"修复快照失败"变成通知。

### B. 「门禁结果是给运行看的」——裁决是返回值，但从不给研究者渲染

**假设**：研究者会在运行流页面看到每件交付物的退回理由、修复轮次、审批/追问卡片。
**现实**：`RunStreamSessionPage`/`RunStreamThread`/`RunTree`/`DeliverableCard`/`RunInteractionPrompt`/`Composer` **全部不在路由上**（`router.tsx:34-35` 把 `chat` 指向内核 iframe 的 `SessionRoute`；`RunStreamSessionPage` 被 0 个文件引用）。于是：`/api/runs/:id/events` 没有浏览器消费者；`phase: "repairing"` 永远产生不了（`awaitingRepairDispatch` 服务端从未设置）；「复查与复现」写的草稿没人读（S498 已记过一半）；`ERROR_CODE_MESSAGES` 的 47 句中文一个像素都没渲染——运行页用一张 20 键的小表、**未知码统一显示「运行未通过核验。」**（对超时、取消、基础设施故障都是假话），侧栏直接显示英文码（`RunSidePanel.tsx:141`，还有测试钉着它）；产品 API 一律「操作未完成，请重试。」；收件箱「研究运行已结束，请查看运行记录了解状态。」不带原因不带链接；资料卡的 `payload.error` 存了、类型有了、0 处渲染。
**通用规则**：**每次运行只有一个 Outcome 对象** `{state, reason(中文), produced[], issues[], nextAction}` 由服务端生成，运行页、侧栏、收件箱、iframe 旁栏都只渲染它，不各自翻译。错误码字典只有 domain 一份，前端三张表删掉。

### C. 「一直响的警报不是警报」——检查没有观测分布就上线

**实例**：答案线 `skill not loaded` 通知触发率高到已经不携带信息 —— **2026-09-08 用 `gate:health --ledger` 在生产账本上实测更正**：不是当初写的「100%」，而是 `open-domain-answer` 的 17 次成功运行里 11 次（**65%**），该线 71% 被标 unverified；而 `clinical-evidence-synthesis` 的 93 次里这条通知 **0** 次（它 67% 的 unverified 来自门禁的内容发现，不是这个）。成因也更正了一半：不是「runtime-ui 路径没有预注入」，而是**根本没有预注入这回事** —— `researchContext.mjs:372` 在简报里用一句话**要求模型自己去加载**（"作答前必须先成功加载 open-domain-answer skill"），而 `injectedSkills` 只读 `projection.subagents`，答案线从不委派、因此结构上永远没有那条记录，唯一可能的证据就是模型自己调 `skill` 工具 —— 它 17 次里只做到 6 次。所以这条检查**测到的是真实的不遵从**，错的是应对方式：把 65% 的回答标成 unverified 既帮不到研究者，又让 unverified 这个标签在别处也贬值。按原则 #1 与 #7，正确方向是让 persona **由构造保证在场**（挂载而非叮嘱），而不是继续叮嘱后再罚。（这条 65% 也正好越过新工具自己的 `always-fires` 复审线，闭环成立。）；`runtime_monitor_stalled`（15 分钟无进展即杀）是一个**不在六个之内、没有任何观测记录**的阻断点；前端给一个**服务端从不发出**的 `agent_timeout` 写了中文，却没给 15 个真会发出的码写；上一份清单把自动续期的证书列为 P0。
**通用规则**：**每个检查都要有自己的生产分布，每周看一次。** `scripts/ops/gate-health.mjs` 已经存在，把它接到生产账本上定期跑：触发率 > 50% 或 30 天内 0 次的检查自动进复审；新检查先通知、后阻断（原则 #4）对通知也适用。

### D. 「修复回路只护一个能力、两轮就放弃」

**实例**：`canRepair` 要求 `effectiveAgentId === "clinical-evidence-synthesis"`——其余 15 个能力门禁不过就直接失败；`maxClinicalRepairAttempts` 2 + 结构轮 2 + 运行侧 `deliveryAttemptLimit` 3，三套上限互相不认识，才有 9/7 那些"能改不能交"的死锁；不可退化的码用尽后是 `failed` 而不是"带问题交付"。
**文献**：结构化反馈（位置 + 观测值 + **可接受的替代写法**）把修复成功率提高 42–44 个百分点，增益主要来自"替代写法"一项，散文和 JSON 效果相同（arXiv 2607.14167）；前 3–4 轮修复拿走绝大部分收益，此后边际递减，且"流程与反馈的设计比模型更重要"（arXiv 2607.05197）。我们的数值事实问题文案已经是这个形状（"引出原句，或在不确定性里说明"），把它做成所有 issue 的模板。
**通用规则**：修复回路对 16 个能力通用，以契约 issue 为输入；**一个回合预算 3–4 轮**，全系统只数一次；用尽后**带问题交付**（A 类规则）。

### E. 「幂等和续跑是事后补的」——静默跳过、无人消费的队列、错的时长

**实例**：暂停再恢复的资料夹去重到自己的旧作业上（上一轮修了）；没有配置验证器时 `verify` 任务永远排队、无任何提示；`{skipped:true}` 的作业不写任何用户可见记录；被新派发顶替的运行标「已取消」无原因；收件箱 `仍然沿用` 空操作；20.7 天的时长。
**通用规则**：**每个生产者都要有一个被断言的消费者**——把 `serverComposition.test.mjs` 的"wired is not fed"扩成生产者/消费者登记表（任务种类、通知类型、action id、notice 字段），没有消费者的要么接上要么删除；每个终局跳过都把原因写到所属记录。

### F. 「运维只看得见自己写的探针」

**实例**：磁盘 99% 无告警；镜像无保留策略；证书无到期告警；错误账本里 18 次网关 token 失效、12 次模型网关不可用没人看。
**通用规则**：告警对准真正坏过的东西：磁盘、证书、门禁拒绝率、网关错误率；发布镜像 keep-2；每周一份账本摘要进收件箱（给运营者）。

### G. 「多个真理来源」

**实例**：错误文案 4 份（domain 注册表 + `WEB_RUN_ERROR_LABEL` + `RunSidePanel` 裸码 + `productErrorMessage`），两种回退行为；花费上限两条路（有账本 `usage_budget_exceeded` 带 details，无账本 `credits_*` 只有 `Retry-After`，前端从不读 `Retry-After`，iframe 建帧失败一律「研究会话暂时无法连接」）。
**通用规则**：一个注册表，一个回退，一个 details 形状；`credits_*` 也声明 details；前端解析 `Retry-After`。

## 4. 联网核查（2026-09-07）

- **DSH**：npm `latest` 仍是 `0.1.2-rc.1`；`0.1.3-alpha.2` 于 **2026-09-07 13:11Z** 发到 `alpha` 标签（依赖清单多了 `@deepseek-ai/dsh-http-proxy`，其余同名升版）。按"活线探测后才采纳"，等 0.1.3 到 rc 再跑我们的电池；现在不动。
- **MemOS**：最新 2.0.33（9/3，偏好记忆修复）；2.0.32（8/28）加了官方 DSH 记忆适配器；Local Plugin 2.0.18（9/1）。我们钉 2.0.30。P1-11 的决策未变：生态优先，评估采用上游适配器，而不是继续自建召回插件。
- **MinerU** 3.4.5（6/18）仍是最新稳定版；**OpenList** 4.2.6 仍是最新，CVE-2026-75602 在 4.2.3 修复且在我们未启用的离线下载功能里。均无动作。
- **门禁与 UX 的业界证据**：(1) 分阶段执行——先监控、再软执行、最后全阻断（2026 guardrails 实践）——与原则 #4 一致，我们缺的是"监控"那一段的数据；(2) Google PAIR《Errors + Graceful Failure》：失败时把控制权和**全部信息**交还用户、解释为什么给不出结果、让失败"安全、无聊、是产品的自然一部分"——我们现在是把文件藏起来；(3) Anthropic 2026 harness 设计指南：脚手架的每个组件都编码了一个"模型做不到"的假设，能力提升就该拆掉，"我能停止做什么"——对照 D 类：受契约保护的修复回路是护城河，但三套互不相认的上限是脚手架；(4) 过度拒绝文献：安全性与有用性存在权衡，无解释的拒绝显著提高逆反、降低信任；(5) AI 科学家综述（2608.05179）的结论不变：瓶颈是可核验性，独立验证方向正确。

## 5. 下一阶段 TODO

### P0 · 开放给用户之前

> 进度（2026-09-08 19:00，见下方 19:00 一条覆盖）：

> **进度（2026-09-08 19:00 更新）：** #1 #3 #6 #7 完成；**#5 完成**（persona 由控制面挂载 + `gate:health --ledger` 已装成每周定时并跑通）；#2 大半完成，剩余部分是一次产品决定而非缺陷（见下方注记）；**#4 已在 `evimed-20260908-5898a48` 上重跑**（第一次跑暴露出门禁的一个假阳性，已修并随本版部署）。P1：#8 复核为已完成、#9 完成、#10 的 `compareExpectation` 已删、**#12 完成**（autopilot 三个开关移入基础栈，并把 `deploy.test.mjs` 里那条「每个开关都必须被 compose 转发」的扫描扩到这一族）、#13 的时长封顶完成。P2：**#19 完成**、**#22 的查因完成**。生产磁盘 94% → 81%，两个每周运维定时已装并各跑通一次。

> 旧进度（2026-09-08 18:40）：#1 #3 #6 #7 已完成；#5 的修法已落地（persona 由控制面挂载），周跑定时待随下一版部署；#2 大半完成（侧栏已渲染裁决、原因与未核验文件，收件箱已带原因与深链），剩余的逐件交付物树见下方注记；#4 已在生产上派发并等待结果。P1 中 #8 经复核已由合并完成，#9 已完成，#10 的 `compareExpectation` 已按「要么接线要么删」删除。

1. **交付是标签不是开关（A 类）。** `agentRuns.mjs` 的所有终局分支统一走一个 `publishOutcome`：工作区有交付文件就发布 + 裁决；回执不符先重判现字节，重判不过按 `unverified` 交付；`repair-revisions` 快照增加只读路由。验收：变异测试——任一拒绝分支在盘上有文件时 `artifacts.length > 0`；用 aripiprazole 的工作区回放，得到一份"已交付，待人工复核"的包而不是「暂无交付物」。
2. **把门禁结果给研究者看（B 类）。** 服务端生成 Outcome 对象；`SessionRoute` 的侧栏渲染每件交付物的状态与退回理由（用现成的 `DeliverableCard`，把它挂到路由上）；「复查与复现」真的重新派发；Files 页能进运行工作区（挂上 `SessionFilesPane`）；收件箱条目带原因与深链；被杀的运行显示「已停止：15 分钟无进展」而不是「未通过核验」。验收：一条遍历 `ALL_ERROR_CODES` 的测试断言每个码有中文句子且渲染出来（现在 253 个码 46 个有）。
3. **生产磁盘（F 类）。** 立即：保留当前 + 上一版，清掉其余运行时/Web 镜像（约 39 GB）；然后 `release:prune` 运维脚本 keep-2、node-exporter + 磁盘告警（< 20 GB）。验收：剩余 ≥ 30 GB；告警演练触发。
4. **部署合并后的 main，并在其上重跑临床证据验收。** 前提是 #1 落地，否则再跑一次仍会被丢。验收台账 `clinical-evidence-synthesis` 至少一次 `accepted`。
5. **答案线的 skill 检查（C 类）。** runtime-ui 路径要么预注入 persona，要么不做该检查；`gate-health.mjs` 接生产账本每周跑，触发率 > 50% / 30 天 0 次自动进复审。验收：答案线 unverified 率一周内 < 5%。
6. **修复回路通用化（D 类）。** 对 16 个能力生效；一个回合 3–4 轮、全系统只数一次；issue 文案模板 = 位置 + 观测值 + 可接受写法，中文；用尽后带问题交付。验收：9/7 那五种死锁各写一个回放测试，全部以"交付 + issues"结束。
7. **证书降级为监控项。** blackbox `probe_ssl_earliest_cert_expiry` 告警（< 3 天）；确认 9/9 的自动续期发生。

> **#2 的剩余部分需要一次产品决定，不是修缺陷。** 逐件交付物的状态与退回理由由 `DeliverableCard`/`RunTree` 渲染，而它们只能从 `RunStreamSessionPage` 到达——那是一个**从未挂到路由上**的第二会话面（连同 `RunStreamThread`、`runStream.ts`、`useRunStream`，合计约 1,550 行，配 5 个测试文件全绿）。它自己的文档注释说明了原因：它是「DSH 页 vs 退役的 OpenCode 页」两页并存方案里的新页，由 `/api/me` 决定部署拿到哪一页。但 OpenCode 已于 2026-09-01 整体删除、无回滚闸，而 `SessionRoute` 现在**无条件**渲染 DSH 原生 UI 的 iframe 加我们的 `RunSidePanel`。所以：要么把这 1,550 行按原则 #8 删掉，要么决定我们自己的会话面重新上场——两者都不是「把一个组件挂上路由」。运行级的裁决、原因、未核验文件已经在 `RunSidePanel` 上如实渲染（通知按 must-fix 分组且有显式的 hidden 计数，不静默截断），所以本项的用户可见目标已达成，缺的是逐件粒度。与 P1 #14（iframe 内的门禁可见性，需要一次真浏览器会话）是同一个决定，建议合并处理。

### P1 · 产品完整性

8. **错误码单一真理源（G 类）。** 删除前端三张表，全部走 domain 注册表 + 家族回退；`credits_*` 声明 details；前端读 `Retry-After`；`productErrorMessage`/`inboxClient` 用注册表；资料卡渲染 `payload.error`（并把 `"Source analysis failed."` 换成真实原因）；资料夹增加 `lastError`。
9. **停滞检测改为通知（C/A 类）。** 15 分钟无进展 → 通知 + 继续；只有 4 小时时钟才终止；终止时按 A 类规则交付盘上内容。规格 §29.3 的六点清单补记停滞检测与 `gate_source_denied` 的归属。
10. **生产者/消费者登记表测试（E 类）。** 接上 `reportWebDeliverableFeedback`（交付物"采纳/已编辑"按钮）、收件箱 action、`omissionNotice` 渲染、`phaseNotices` 进类型、`compareExpectation` 要么接线要么删；删 `price-list` 种类、`priceListAt`、`PRICE_LIST_VERSIONS`、`consolidate`（或给它生产者）。
11. **收件箱的 `question` 可以在原地作答**（自由文本），并加回合中途的 `question` 生产者。
12. **`OPEN_SCIENCE_AUTOPILOT_ENABLED` 进基础栈**（或文档写明 overlay 依赖）；控制器协议 6→7 让验证隔离在托管路径上成为真围栏。
13. **静默跳过写原因**；~~时长封顶~~ **时长封顶已完成 2026-09-08**：被顶替的运行原本记 `now - startedAt`，而会被顶替的恰是「浏览器应用开了一个无人认领的会话」时建的占位运行——最容易被丢在那里好几天的那一种。现在取两个诚实上界里更紧的一个：最后一次观测到活动的时刻，以及监控自己的四小时上限（超过它平台早就终止了，所以不可能工作更久）。变异检查过。剩「静默跳过写原因」未做。
14. **iframe 内的门禁可见性**：用真浏览器确认 DSH 原生界面如何渲染 `deliverable_rejected` 工具结果，以及能力模板预填（S498）的去向。
15. **依赖**：DSH 0.1.3 到 rc 时活线探测；MemOS 2.0.32+ 适配器评估（P1-11 原样）；MinerU/OpenList 无动作。
16. **插件生态收尾**：第二个插件的 apply 路径；CI 设 `EVIMED_PLUGIN_PROBE`。
17. **语料级覆盖台账**（P1-10e，原样未做）。

### P2 · 质量与整洁

18. 学习效果指标 eval（P1-13d）。
19. ~~组合交付丢件通知~~ **已完成 2026-09-08**：成功分支的通知原本只由 `receipt.entries` 生成，而回执只能为它持有条目的东西说话，天然无法报告一个缺席——于是「计划两件、交付一件」的运行落在 succeeded、一个产物、无错误码、无通知。单能力运行到不了这个状态（唯一一项被退回就没有回执），所以这恰是读者最不设防的形状。现在同时读投影里的计划：计划里非 accepted 且回执无条目的项各出一条中文通知，是通知不是拒绝。原 `test.todo` 已转为正式测试并做了变异检查。
20. 首批断言中文文案的前端测试（现在为零）。
21. ~~`runtime idle timeout waits for a call still in flight` 放宽期限~~ **已完成 2026-09-08**：真因是 `start_runtime` 返回到 `beginProxy` 之间那段**没有任何东西撑住运行时**的窗口，40ms 的 idle 期限短于满负载跑全套时的调度抖动，于是运行时在代理槽被占用之前就自己空转停掉了——而失败信息写的是「在飞的调用没能让运行时活着」，恰好与实际发生的相反。期限 40ms→200ms、持槽 90ms→400ms：被测性质与形状都不变（持槽时间仍然长于 idle 期限，断言仍然证明持槽能阻止停止），只是把余量拉开。
22. ~~`errors.jsonl` 每周摘要~~ **已完成 2026-09-08**（并入 `gate:health --ledger` 的同一次遍历：`errors.jsonl` 就在 `runs.jsonl` 旁边，问的是同一个问题、早一层；现在每周定时一次同时给出两份分布。注意根目录要给到数据卷根而不是 `users/`——错误账本是全局的，指到 `users/` 会安静地少一半）；~~`public_source_gateway_token_invalid` ×18 查因~~ **查因已完成 2026-09-08**。生产 41 个账本共 2,076 条 HTTP 拒绝，前几名：`unauthorized` 1231、`internal_error` 315、`runtime_bootstrap_failed` 136、`not_found` 70、`auth_rate_limited` 68。那 18 条**全部集中在 2026-09-03 一次事件**（当天 22 条网关错误，其中六条落在同一秒内），09-04 之后为零；今天出现的 3 条是 `rate_limited`（429）而不是它。
    **原因**：`publicSourceGateway` 收到 token 后调 `runtimeManager.assertActiveModelGatewayToken`，而它除了验签还要求 `jti` 命中 `activeModelGatewayTokens` —— 一个**纯内存 Map**，只在 `start()` 里 `waitUntilReady` 之后写入，`runtimeManager.mjs` 里没有任何容器接管（adopt/reattach）路径。控制面一重启（部署即是），这张表就空了，而 docker 容器活得比控制面进程久：孤儿容器带着一个**签名仍然有效**的 token 继续取源，于是并发的几次抓取在同一秒内全部 401。分类本身是对的（`token_invalid` 属终止类、`rate_limited` 属可恢复类），问题在于**一次部署会让在飞的运行以「认证失败」告终**，而现场没有任何东西配错。
    **未做**：真正的修法是重启后接管既有容器并重新登记其 token，那是 runtimeManager 的实质改动，不该在有部署待发、且有一次验收在飞时顺手做。建议与 P1-12 的控制器协议 6→7 一起排。

### 仍需外部输入（不是代码）

- P0-1：MR 通道 Ed25519 回执 + 新 OpenGWAS token（账号主）；
- P0-7：S3 兼容桶、密钥、端点；
- #14：一次真浏览器会话。

## 6. 上线复核与上线前 TODO（2026-09-09）

**一句话结论：发布链路与运维底座已到可上线级，产品面与验收面还没有。** 今天核实的现状：`evimed-20260909-c7434fb`（合并了并行分支的 main）在线，`/api/ready` 24/24、deployment-smoke 13/13、备份加密且恢复演练通过、证书自动续期、两个周运维定时在位、来源清单三处一致；并行分支已合入且远端所有分支都是 main 的祖先；验收账号的 27 个脏项目已清、验收电池在干净项目上开跑。**但**：主交互面仍是 DSH 原生预览 UI（英文、DeepSeek 品牌），15 个公开能力里只有 2 个在线上验收通过，告警没有接收人，备份只在本机，花费没有上限而自注册开着，并发上限是 2。这些不是修缺陷，是上线前必须做的决定与配置。

### A. 硬阻断（代码与产品，我这边能推进的）

> **2026-09-09 更新：A1 已决定并落地** ——保留内核自带的应用作为会话面，通过它的插槽系统换上 EviMed 品牌、以私有语言包强制中文、撤掉工作区选择器，托管权限表收成一行；我们自己那套 1,550 行的会话面已删除（建而可删）。**B5 部分闭合**：研究者现在可以在「账户与额度 → 数据源凭据」填入自己的 OpenGWAS 等凭据，登录后有一次提示；部署级密钥仍优先。**B8 已执行**：三个死实验账号与孤儿目录已删，两个账号各剩 default。

- **A1 · 主会话面（P0-2 / P1-14 的那个产品决定）。** 真浏览器登录后 `/app/chat` 的中央区域是 DSH 内核自带的预览界面：鲸鱼 logo、「Into the Unknown · Preview」、英文占位「Describe what you want to build… / commands, @ files or sessions」、agent 下拉「Evimed Hosted」。研究者看到的第一屏是第三方开发者预览。两条路：把从未上路由的 `RunStreamSessionPage`（约 1,550 行、5 个测试文件全绿）接回来替代 iframe；或对 iframe 做语言与品牌覆盖（受 DSH 版本变化牵制）。**建议前者**——它同时把逐件交付物的裁决树（`DeliverableCard`/`RunTree`）带回给研究者。
> **2026-09-09 13:10 更新（A2）**：两轮电池后台账为 **accepted 7**（adr、dataset-scoping、off-label、manuscript-support、evidence-appraisal、research-grant-development、bibliometric-analysis）/ failed 3（clinical、meta、geo 首次）/ never-run 5（peer-review 需稿件、MR 需 OpenGWAS token——现在研究者可自配、research-topic-selection 简报形状、两个 internal）。geo-content 第二次正在跑。**新发现的引擎缺陷**：bibliometric 适配器镜像装了 openai 3.8.0（无上界 pin），不再带 httpx，检索式生成/中译英/MeSH 映射全部失败，语料退化为裸 `GLP-1` 检索——报告自己如实写了；pin 已修，适配器镜像待重建。meta 引擎超出 4 小时监控上限且作业重启两次，待查。

- **A2 · 能力验收覆盖。** `evals/acceptance-ledger.json`：accepted 2（adr-analysis、dataset-research-scoping）、failed 2（clinical-evidence-synthesis、meta-analysis）、never-run 11。今天电池跑 7 个（off-label、geo-content、evidence-appraisal、meta-analysis、bibliometric、manuscript-support、research-grant）；剩 peer-review（简报要稿件 PDF）、mendelian-randomization（OpenGWAS token）、research-topic-selection（harness 简报无 `capability` 字段）、clinical（等结构修法）。上线规则：**对外展示的每个能力至少一次 accepted，否则在 UI 标「测试中」或把 `visibility` 收起来**——检查表里「按钮存在、后台没有执行能力」的假上线就是这个。
- **A3 · 部署即事故（P2-22 的未做部分 + P1-12）。** 控制面重启后不接管既有容器，在飞运行的网关 token 从内存表消失，以「认证失败」告终。今天无人使用所以无感；有真实用户后每次部署都会打断他们的运行。修法是 runtimeManager 的容器接管 + 控制器协议 6→7。
- **A4 · 花费上限。** `OPEN_SCIENCE_USER_DAILY_SPEND_LIMIT` / `WEEKLY` 都是 0（不设限），而 `OPEN_SCIENCE_SELF_REGISTRATION_ENABLED=1`。开放注册前必须设上限（一个月真实用量后再调），否则一个账号可以无限花。
- **A5 · 临床证据能力的结构修法（本轮第二问题的决策，见下）。**

> **2026-09-10 更新（合并、门禁缺陷、一次由我造成的事故、`evimed-20260910-*` 上线）**
>
> **合并。** `feat/memory-substrate` 四个提交并入 main（`a8f9c0f9d`）：`STATUS` 与 `PROGRESS.md` 两处追加型冲突按时间戳交错；`server.mjs`、`docker-compose.yml`、`.env.example` 三个自动合并文件逐段人读，两侧都在；合并树上跑了全量 `test:web`（server 2183 通过、vitest 549 通过）与 `ci:web` 的全部八项静态审计，全绿。生产用 `builtin` 召回，`memoryRecall` 成了第 25 个就绪检查（report-only）。
>
> **第二轮电池的最后两项，读记录而不是信判决。** geo-content 第二次运行 63 分钟、289 条消息、150 次工具调用、十个文件全写、提交时通过合约，最后被 `specialist_required_skill_missing` 判失败。记录显示的原因是控制面自己的：路由指令要模型「逐个用 skill 工具加载」六个方法并「自行执行 SKILL.md」，而其中两个（`geo-content`、`autopilot-episode`）是能力正文，故意不在内核的技能根目录里，只能经 `evimed_delegate` 注入；模型加载了能加载的四个、在根会话里自己干完，门禁再按它拿不到的方法判它失败。更糟的是 evidence-appraisal 昨天的「accepted」是假阳性：它对自己能力的那一次 `skill` 调用返回的是 `skill "evidence-appraisal" is unknown or no longer available`，门禁把「已完成的调用」一律计为加载。三处修法（`15df67354`）：门禁只认内核为该名字渲染的 `<skill_content>` 块；路由指令改为「先 evimed_plan，再 evimed_delegate 委派给该能力，方法由委派注入」；判决带上缺的方法名和补救路线。台账：evidence-appraisal 回退为 failed，两个包保留为证据，bibliometric 的第三次运行（审稿人推翻一个手打百分比）作为原则 10c 的评测案例记入。
>
> **事故（我造成的）。** 2026-09-09 23:17 CST，为追查一次负载尖峰我在生产主机上跑了只读的 `docker buildx history ls`，dockerd 29.1.3 在 BuildKit 的 `filterHistoryEvents` 空指针崩溃（几乎肯定是十六分钟前一次被 OOM 杀掉的构建留下的坏记录——那次构建不是我发起的），systemd 重启了守护进程，但**共享主机上 38 个容器（含 tcm-cdss 之外的其他四个产品）全部停在 exited**，`unless-stopped` 对守护进程崩溃时标记为已停止的容器不生效。直到今早 01:50 UTC 我查 `/api/health` 得到 nginx 502 才发现，停机约 10.5 小时；按依赖顺序 `docker start` 逐个拉起，数据无损，PostgreSQL 备份定时器在停机中失败的一次已补跑、回执 healthy。已写入记忆：那台主机上永远不要再查询 build history；任何守护进程重启后要按 `FinishedAt` 找出被停的容器手工拉起。顺带修了控制面自己的一处崩溃：autopilot 与 consolidation 两个定时器的 catch 会把非维护错误重新抛出，Postgres 连接超时因此成为未处理的 Promise 拒绝、Node 直接退出（15:01 UTC 发生过一次，容器重启拉回）；两处改为报告后下一轮重试，入口加了兜底处理器，测试钉住「五个定时任务的 catch 都不再抛」。
>
> **上线。** `evimed-20260910-a8f9c0f`：主机上以 `sudo cp -a` 从 7f88cf2 播种、按 `git ls-files` 同步跟踪树（1805 文件、零残差）、五处锚点改写、一个 `BUILD_CREATED` 传给两个镜像并写入 `.env`、三个镜像共 7 分钟（web 1.5 分钟、runtime 51 秒缓存命中、bibliometric 适配器 4 分钟）、标签核对、清单生成与 `--verify-images`、`preflight:host` 只红回执、切换、receipt 容器 20 秒后重签、`/api/ready` **25/25**、`smoke:deployment` **13/13**、英文浏览器实测会话面全中文。bibliometric 适配器镜像已重建上线：旧镜像 openai 3.8.0 且无 httpx，新镜像 openai 1.109.1 + httpx 0.28.1。随后发现内核在插槽之外直接渲染的「workspace」芯片（撤掉的只是它打开的弹窗）成了首屏一个无效按钮，已隐藏（`bd7d2dd03`），随下一版上线。
>
> **第三轮电池（修复后的复验）：** evidence-appraisal 在 dae363e 上 **accepted**（15 分钟；根会话一次委派、四方法注入、交付物第二次提交零问题、九项研究评级全在 `domains` 下、无重做；审稿人 14 条通知，2 条 contradicted，均随包交付）。geo-content 在 dae363e 上运行中：已确认根会话委派、子代理注入全部六个方法（`geo-content, autopilot-episode, citation-integrity, manuscript-humanize, deep-research, biomedical-database-search`），结果见台账。台账现为 accepted 7 / failed 3 / not-run 8。
>
> **上线前仍需你决定/提供的（不变，加两条）：** B1 域名、B2 强口令（现为 6 位且在公网 IP 上）、B3 告警接收人（今天的 10.5 小时停机没有任何告警能到人，就是这一条的代价）、B4 异地备份、B5 OpenGWAS token、B6 法律三页、B7 容量——**今天的事故正是共享主机的代价：别的产品在生产主机上跑构建被 OOM 杀掉，坏记录再让守护进程崩溃，五个产品一起停**；建议专用主机或至少禁止在生产主机上构建。新增：**B9 · GEO 探测主机未配置**——geo-content 两次运行的全部探测轮都在 183 秒通道级超时，该能力在这个部署上测不到任何东西，需要一个可达的探测主机（或明确先不发布 GEO）；**A4 · 花费上限**仍是 0，开放注册前要一个数字。

### B. 需要用户输入的外部项（不是代码）

- **B1 · 域名与证书。** 现在 `OPEN_SCIENCE_PUBLIC_URL=https://82.156.128.153`，Let's Encrypt 6 天短证书对 IP 签发、自动续。正式域名是 Cookie/CSP/OIDC/对外发布的前提。
- **B2 · bootstrap 账号口令。** `sxjxw-research` 是操作者本人的登录账号，口令按 2026-09-04 的指示设为 6 位且在公网 IP 上；上线前改强口令（我不能替你选）。
- **B3 · 告警接收人。** Alertmanager 唯一接收器是示例占位 `http://127.0.0.1:5001/`——13 条规则（含证书 < 3 天、磁盘 < 20 GB、就绪探针失败）一条都到不了人。给我一个企业微信/飞书/钉钉 webhook 或 SMTP。
- **B4 · 异地备份。** `OPEN_SCIENCE_BACKUP_EXTERNAL_ACK=false`、对象存储 URI 为空，备份只在本机盘上；给一个 S3 兼容桶 + 密钥 + 端点（检查表 P0-7）。
- **B5 · OpenGWAS token + MR 通道回执。** `audit:capabilities` 自 8 月中起红（探针证据 07-31、14 天窗口），`ci:web` 因此不能全绿；只有账号主能续 token。
- **B6 · 法律最小交付。** 产品内没有隐私政策、服务条款、科研辅助免责声明页（0 处）。此前裁定不做合规闸，但发布这三页是运营事项。
- **B7 · 容量。** 全局并发任务 2、每用户运行时 2、第 3 个派发直接 429；主机 4 核 15 GB 与另外四个产品共用，可用内存 5 GB。要么专用主机，要么邀请制 ≤ N 人试点。
- **B8 · 删号点名。** 死实验账号 `rq01-pipeline`（43 项目/361 MB）、`scoping-v12`（6/74 MB）、`qa-native-cbc94a7a3f`（1/2.6 MB）与两个孤儿目录；你自己账号下 8 月的 sxjxw v1–fin 迭代（1.2 GB）。没有管理员删号路由，删是 DB + 卷两步。

### C. 上线后第一周（不阻断）

- C1 · 第二问题的结构修法与 A/B（下面）；C2 · DSH 0.1.3 到 rc 时的活线探测（上游 0.1.3-alpha 起 session 格式 v3、`agentLoop.create()` 异步、插件 API 去 `ctx.agent`，是一次真适配）；C3 · `Runtime stream capacity` 一次性观测（DSH UI 打开 58 s 内打满 128 条流，第二次未复现）→ 服务端计数与日志；C4 · P1 #11/#16/#17、P2 #18/#20；C5 · retention 定时加 `--images`（同日多版的排序已修，`current` 永远保留）。

### 第二问题的决策（临床证据能力：2/8 产出、19 条引用完整性、数值自相矛盾）

联网核查（2026-09-09）：生产跑 `deepseek-v4-flash`（= V4-Flash-0731，官方 7/31 正式版，九项 agent 基准超过 V4-Pro-Preview，官方明言「不要仅因价格改用 V4-Pro 做 agent 工作」）；`deepseek-v4-pro` = V4-Pro-0813，约三倍价格，Artificial Analysis 智能指数只高 1 分；**8/13 起两者都支持 low/high/max 三档 thinking effort**，我们的网关此前写死 `high`。文献侧：JBI 2026-09 系统综述（27 项研究）——LLM 数据提取里数值类准确率 47–88%、分类类 74–96%，主要错误是遗漏（60–74%）而非编造（0.08–6%），推荐「双提取 + 人工核验」与结构化提示。这与我们两次运行的失败形状一致：错在数字与缺项，不在虚构文献。

**决定：不盲切模型。**（1）结构先行——矩阵先于报告：先把每条效应量连同逐字 `supportQuote` 写进 `clinical-evidence-matrix.json`，报告再从矩阵渲染，报告中的每个数字由代码对照矩阵核验（原则 10c「数字是渲染产物」，原则 1「数值判断归代码」）；8 个必需产出分阶段提交，缺项在计划层可见而不是终局才发现。（2）杠杆已备——`OPEN_SCIENCE_DEEPSEEK_REASONING_EFFORT` 已做成部署开关（`cc1b5c30a`，下版生效）。（3）用自己的 eval 裁定模型——同一简报、干净项目、三组：Flash@high（已有两次）、Flash@max、Pro@high，按门禁计数（必需产出数、引用完整性条数、自相矛盾数）比较；Pro 只有在计数上胜出才切，且只对文件交付类能力切。
