# 2026-09-07 · 缺口盘点与上线前 TODO

对照 2026-09-07 合并后的 `main`（`ff52fe9c` 之后）逐项核实产品能力表的 12 行。核实方法：读代码与测试，不看文档自述；每一条结论都附文件位置。本文件是行动清单，不是设计文档；设计仍以 `docs/superpowers/specs/2026-08-22-evimed-dsh-plug-harness-design.md` 为准。

## 0. 本次已完成（2026-09-07）

- `main` 合并 `codex/full-saas-delivery-20260905`（快进 286）与 `codex/review-topic-release-20260906`（合并 10），两处冲突按"两边都保留"解决，已推送 `github/main`。
- 修复 4 个在两条分支上都红的 `runtimeManager.test.mjs` 用例：`dshDispatchFixture` 从未创建 `workspaceDir`，而 `34d9265f` 去掉了写入路径里的 `fs.mkdir`。真实项目一定有 workspace 目录，所以补在 fixture。
- 能力目录：`researchAgentUi.ts` 只有 10 条中文翻译，15 个公开能力里 5 个（临床证据深度分析、证据质量评价、答案引擎内容优化、论文章节写作、基金申报书开发）以英文渲染——这就是"目录只像 11 项"的来源。已补齐 15 条，并加了一个扫描 `capabilities/*/capability.yaml` 的测试，新能力不翻译就红。
- 主动科研的用户决定回路：此前 `directionVerdict` 的 `userRejected` 恒为 `false`，`digest.payload.decisions` 写了没人读。现在 `decide()` 把净信号（`userSignalScore`，按规格 §24.4.2 的权重）记到议程上；净驳回在下一回合前把方向置底（`park`），重新开始即视为用户覆盖；`question` 必须带文字，并作为下一个**新建**回合简报的第一项任务，只搭一次。
- MinerU 契约测试从"服务尚未部署"的占位改为断言五处派生副本都等于 `deps-version.json`。
- 文档：根 `CLAUDE.md`/`AGENTS.md`（DSH 钉 `0.1.2-rc.1`、15 公开能力、记忆底座真实状态、摄取栈与各持久子系统）、`OpenScience/AGENTS.md`、`deps-version.json` 的 memos 注记（"usememos 已退役"是错的，它仍在生产请求路径上）。

## 1. 12 行盘点：还是不是缺口

| 产品能力 | 表中"仍缺" | 2026-09-07 实况 | 真实缺口 |
|---|---|---|---|
| 统一科研执行 | 所有能力经原生 UI 真实交付验收 | 托管 e2e 只走 HTTP、只跑 `adr-analysis`（`scripts/ops/hosted-production-e2e.mjs:266-390`）；无按能力的验收台账；7 个能力 0 份 brief；组合任务无任何测试（规格 V41 未关） | **仍是缺口**，且是最大的一条 |
| 能力目录 | 只展示 11 项 | API 返回 15（`server.test.mjs:309-325` 钉死），前端全渲染；5 项无中文 → 看起来"不可用" | **已补**（本次） |
| 插件生态 | 发现/配置/启停/升级/卸载/回滚/兼容矩阵 | 配置、启停、回滚（配置回滚 + 应用失败自动回滚）已做（`pluginService.mjs`、`pluginApplyWorker.mjs`）；但 `pluginRoutes.mjs:14` 只认 `dsh-cite`，`availableUpdate` 硬编码 `null`，无卸载路由；兼容矩阵只有上游依赖矩阵（`scripts/ops/upstream-compat-matrix.mjs`），插件级是手写 `plugin-support.json` | 发现、升级、卸载、插件级矩阵 **仍缺** |
| 知识库与资料接入 | OpenList/本地文件夹/增量同步/指纹去重/来源版本 | OpenList 接入、部署、UI 已做；指纹去重已做（`sourceService.mjs:179`，`src_<sha256>`）；版本族已写（`familyId`/`version`）且卡片显示"文件版本 N" | 本地文件夹（`local-agent` 只是常量，worker 拒绝 `server.mjs:534`，UI 却在宣传）、增量同步、版本族列表 **仍缺** |
| 统一资料分析 | MinerU/解析任务/覆盖台账/遗漏检查/归并整理台 | MinerU 3.4.5 已部署并被调用（`deploy/document-parser/`）；解析任务队列已做（`sourceWorker.mjs`）；单资料覆盖台账已做；整理台页面已有 | 遗漏检查（`distillationCompleteness` 零调用，契约强制 `not_run`）、语料级覆盖台账、归并/去重审阅 **仍缺** |
| 记忆底座 | MemOS 未成为实际底座 | 用户可见记忆全部走 usememos 派生服务（`memosClient.mjs` → `evimed-memos:5230`）；MemOS 2.0.30 只在胶囊召回排序，默认关（`config.mjs:1049`），不在已签发布清单里 | **仍是缺口**（表述准确） |
| 记忆胶囊 | 服务地址为空；账本/召回/管理/激活未完成 | 网关地址已推导（`runtimeManager.mjs:1638`）；账本、召回 API、管理 UI、激活流程全部已做 | 只剩 `capsuleMethodsDir` 硬编码 `""`（`runtimeManager.mjs:1689,2052`）→ 方法技能从不挂载 |
| 胶囊分享 | 创建/导入导出/版本快照/工作方式包/客体激活 | 创建、导出、导入、版本快照、客体激活（导入即待确认、不自动启用）全部有路由和 UI | 工作方式包"打包了但运行时不挂载"——同上一条一个根因 |
| 个性化学习 | 编辑/决策反馈、偏好冲突、方法沉淀、可测量提升 | 抽取已做；用户确认 pending 记忆会写 origin/confidence，但无反馈事件流；`memory_conflict` 是并发冲突不是语义冲突；`distill`/`consolidate` 任务种类存在但从不入队；无任何理解提升指标 | **四项都仍缺**；本次把"决策反馈"里议程这一半接上了 |
| 主动科研 | 调度器/持久队列/预算/回合/独立验证 | 持久队列（`SKIP LOCKED` + 租约）、调度器（60 s）、回合预算（签名 marker → 网关）、停止规则全部已做并默认开启 | 独立验证 **仍缺**：`verify` 任务从不入队，`gated` 用的是同一次运行的门禁，`reproduced` 无生产者 |
| 今晨简报与收件箱 | 尚未形成服务 | 简报、发现分层、审阅通知、收件箱服务与 UI 全部已做 | `question` 通知无生产者；用户决定反馈 **本次已接到议程**，到胶囊/记忆的那一半仍缺 |
| 计量与额度 | 持久账本/并发预占结算/价格版本/对账 | Postgres 账本、预占→结算、并发预算、日周上限、价格版本号全部已做 | 对账 **仍缺**：过期 `reserved` 永远停在 reserved；`uncertain` 无限期占预算；`price-list` 文档种类无读写者 |

## 2. TODO（按上线优先级）

### P0 · 上线阻塞

1. **`audit:capabilities` 转绿，`ci:web` 才能整条通过。** 工具探针证据停在 2026-07-31；MR 通道要适配器发出 Ed25519 签名回执 + 新 OpenGWAS token（14 天过期，只有账号主能签）。见 `PROGRESS.md` 2026-09-07 05:09/06:34 两条。
2. **生产磁盘与候选切换。** 候选构建曾撑满生产文件系统导致公网 502；切换仍压在 5 GiB 底线下。隔离构建机（已标定）跑一次真实全量 Web 构建，再做镜像传输与切换。
3. **IP 证书 2026-09-11T07:07:14Z 过期（OPS04）。** 先于其他一切。
4. **用量账本对账（本地无 Postgres，未盲改，需在有库的环境做）。** 设计：(a) `reserveModel`/`assertWithinLimits` 三处 SQL 把 `uncertain` 按 `created_at` 纳入与 settled 相同的 24 h/7 d 窗口，而不是永久计入；(b) 新增 `UsageLedger.reconcileExpiredReservations({now})`：`reserved` 且 `reservation_expires_at <= now` → `uncertain`，`error_code='reservation_expired'`（不是 `released`：供应商可能已扣费）；(c) `server.mjs` 按现有 `maintenanceMutation` 模式加 60 s 定时器；(d) `health()` 报 `expiredReservations`；(e) `usageLedger.integration.test.mjs` 加失败先行用例。
5. **临床证据深度分析的真实交付验收。** 9/7 五次生产运行失败（41/47/52/55/61 分钟）；2.11 修复在 review 分支已合并，但还没有一次在新发布上通过的同题重跑。
6. **按能力的验收台账。** 16 行 × {真实交付通过？记录在哪？eval 存在？brief 数}，落到一个 JSON（建议 `OpenScience/evals/acceptance-ledger.json`），由 `audit:capabilities` 读。目前只有 `adr-analysis` 被 e2e 覆盖，`dataset-research-scoping` 有一次干净记录，其余 14 个没有。
7. **外部备份。** T3.4 因缺 S3 桶/密钥而停在"declared unconfigured"；PG 恢复演练已做，卷级恢复未做。
8. **发布文档纠偏。** 上线计划 §1 仍写 `evimed-20260904-bf10ff35` / `0.1.2-alpha.5`；实际 `evimed-20260907-287cd59` / `0.1.2-rc.1`。

### P1 · 产品完整性（表里真正还缺的）

9. **插件生态。** 发现：把 `pluginRoutes.mjs:14` 的单插件白名单换成从 `plugin-support.json` + 已安装 profile 读出的注册表；升级：`availableUpdate` 从 npm dist-tag 对比而不是常量；卸载：`DELETE /api/plugins/:id`（禁用 + 回滚到无配置修订）；插件级矩阵：`upstream-compat-matrix.mjs` 增加对每个 `nativePlugins`/`communityToolBundles` 在钉住 DSH 上的加载探针。
10. **资料接入。** (a) `local-agent`：要么做（本地代理 CLI，上传 sha256 + 分片），要么先把 `SourcesPage.tsx:147` 的宣传文案撤掉；(b) OpenList 增量同步：按目录记 `{path → providerHash, mtime}` 游标，定时列举比对，只导入变化项，写 `familyId` 新版本；(c) 版本族列表：`GET /api/sources?familyId=` + 卡片里"共 N 版"展开；(d) 遗漏审计：给 `source-understanding` 增加抽样单元 → 判断是否被任何 claim/slot 覆盖 → `omissionRate`，先作为 notice 观察分布，再改契约允许 `status: audited`（开发原则 #4：先通知后阻塞）；(e) 语料级覆盖台账：某次交付读过哪些资料、到哪一层，写进交付摘要；(f) 归并审阅：同 `familyId` 或近重复（同 sha256 不同路径已合并；近重复靠理解输出的 summary 相似度）列出候选，人工合并/拆分。
11. **记忆底座迁移到 MemOS——先决策再动手。** 事实：MemOS 上游 2.0.32（2026-08-28）加了**官方 DeepSeek Harness 记忆适配器**（自动召回 + 六个记忆工具），最新 2.0.33；我们钉的是 2.0.30，且自建了 `memOsEngineClient.mjs` + `capsule.mjs` 召回插件。按"生态优先：用 > 改 > 只造护城河"，应评估直接采用 `@memtensor/memos-cloud-dsh-plugin` / local plugin 作为运行时召回，把自建召回工具降为薄适配；再把 `memoryIntelligence.mjs` 的抽取/画像从 usememos REST 迁到 MemOS；`requireMemoryIndex` 转 true；发布清单纳入 `memos-engine`；最后才退役 `记忆模块/`。风险是长期双写两套记忆存储——这条不做完，"记忆底座"这行永远是缺口。
12. **胶囊方法挂载。** 运行时启动时把当前项目激活胶囊的 `method_preference` 条目渲染成 `SKILL.md`，写到 `plan.runtimeDirs` 下的 `capsule-methods/`，以只读 bind mount 进容器 `/opt/evimed/capsule-methods`，把这条路径同时写进 `dshProfileInput` 与 docker `--env`（`runtimeManager.mjs:1689,2052` 两处，`scripts/ops/native-ui-local/server.mjs:78` 一处）。做完这一条，"工作方式包"才真的会被执行。
13. **个性化学习。** (a) 反馈事件：`evimed_product` 加 `feedback_events`（editDiff / decision / correction / interjection），`PATCH /api/memory/records` 与议程 `decide()` 都写；(b) 偏好冲突：同 canonical key 出现相互矛盾的值 → 新值置 `pending` + 收件箱 `question` 通知让用户裁决；(c) 方法沉淀：`distill` 任务从"被采纳的交付物 + 用户编辑 diff"入队，产出 `method` 文档（现在只有从论文抽的 `source-method`）；(d) 可测量：每用户的"首稿采纳率 / 每交付物编辑次数 / 驳回理由为『错误』的比例（规格 ≤10%）"，写成 eval 而不是 UI 数字。
14. **主动科研的独立验证。** `verify` 任务种类已在枚举里但从不入队。做法：回合完成后，对每个 `gated` 候选 claim 入队一个 `verify` 任务，用**新会话、只给来源不给原报告**重跑该主张；`tierRaiseAllowed(gated → reproduced)` 只接受来自 `verify` 运行的 `reproductionMatched`。这正对上 2026 年"AI 科学家验证鸿沟"综述的核心结论（见 §3）。另外 `OPEN_SCIENCE_AUTOPILOT_ENABLED` 只在 `docker-compose.ingestion.yml` 里为 true，基础栈要么显式带上，要么文档写明依赖 overlay。
15. **简报与收件箱闭环的另一半。** (a) `question` 通知生产者：回合里模型需要用户裁决时（现在只有 `notify`/`review` 两处调用）；(b) 决定 → 胶囊：采纳的 claim 晋升知识层，驳回理由成为 `lesson`（规格 §27），现在 `decisions` 只到议程；(c) 渠道：只有 in-app，邮件/微信按需。
16. **计量。** `price-list` 文档种类落地（有效期 + 版本号，`REFERENCE_PRICE_LIST` 作为种子），`accountExport.mjs:10` 补上导出；用量 UI（上线计划 B1，用户已推迟）。

### P2 · 质量与整洁

17. **组合任务验收测试**（一个计划里 ≥2 个能力的交付物），规格 V41。
18. **7 个 0 brief 的能力各补 ≥3 份真实 brief**（开发原则 #9）：adr-analysis、bibliometric-analysis、dataset-research-scoping、mendelian-randomization、meta-analysis、off-label-analysis、peer-review。
19. **陈旧文档**：`WEB_DEPLOYMENT_READINESS_REPORT.md`（2026-07-13，OpenCode 时代）、`EVIMED_RELEASE_AND_DELIVERY_CHECKLIST.md`（2026-07-19，Java 专项服务时代）——要么重写要么标注归档。
20. **依赖观察**（本次联网核实）：DSH `0.1.2-rc.1` = npm `latest`（9/3），无更新；MemOS 最新 2.0.33（9/3），钉 2.0.30，2.0.32 起有 DSH 适配器；OpenList 4.2.6 不受 CVE-2026-75602 影响（4.2.3 修复；漏洞在离线下载工具，我们只用 list/get/link 且 bootstrap `network_mode: none`）；MinerU 3.4.5 仍是最新稳定版（4.0 只有 alpha）。

## 3. 方向与技术点判断（联网核实，2026-09-07）

- **内核选型与钉版纪律是对的。** DeepSeek Harness 官方定位是"developer preview，一定会有破坏性变更"，微内核 + 全插件（Cordis）。我们"一处钉版 + 派生副本断言 + 活线探测后才采纳"的做法正是对这种上游的正确姿势；`harness-port` 作为唯一可 import `@deepseek-ai/*` 的防腐层要继续守住。
- **记忆方向对，但没走到。** MemOS 是这个生态里事实上的"记忆 OS"，而且 2.0.32 起自带 DSH 适配器——这意味着我们自建的召回插件正在和上游第一方能力重叠。建议按生态优先原则改为采用上游适配器，把精力放在护城河（Postgres 权威账本、胶囊签名/加密、能力契约）上。
- **计量模型与业界一致。** 预占 → 结算 → 释放/不确定的四态账本与 LiteLLM 等网关的做法相同；行业调查显示"对账"正是普遍最痛的一环（约三成团队仍手工对账），所以 P0-4 不是锦上添花。
- **主动科研缺的正是行业公认的那块。** 2026 年 AI 科学家综述（arXiv 2608.05179）的结论：瓶颈已从"能不能完成研究任务"转为"审稿人能不能核验主张"；被调查系统里只有 38% 发布可复现所需的种子/轨迹，没有一个闭环系统有外部验证的 in-loop oracle。我们已经有运行回执与来源台账，缺的是把"验证"做成独立于"研究"的第二个过程（P1-14），而不是同一次运行给自己打分。
- **资料栈选型稳。** MinerU 3.4.x（pipeline 后端 + PP-OCR）与 OpenList 4.2.x 都是当前稳定线；OpenList 的安全事件集中在我们未启用的功能上。

