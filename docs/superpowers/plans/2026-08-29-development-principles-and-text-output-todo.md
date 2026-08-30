# 开发原则落地与文本输出层 TODO（2026-08-29）

- 来源：两轮讨论的收敛——「正则/门禁越修越错」的根因分析，与文本输出层三痛点（后台话语漏进前台 / 思考深度与证据链 / 改一个数不联动全篇）。
- 十条开发原则已写入工作区根 `CLAUDE.md` 与 `AGENTS.md`（"Development principles" 节），每次开发自动载入；本文只保留行动项与「明确不做」。
- 纪律：不新增阻断点（全系统保持 6 个）、不新增轨道、不整装外部框架。与 spec（`../specs/2026-08-22-evimed-dsh-plug-harness-design.md`）冲突时以 spec 为准。
- 2026-08-29 二次更新：新增 D（平台主线必要项，收敛自 STATUS S161–S174）、E（运维）、F（证据完整性与注入评测，联网核实后）；原「明确不做」移至 G。

## A. 立即可做（纯文档 / 技能内容，不碰服务端代码）

- [x] **A1** 十条原则进根 `CLAUDE.md` / `AGENTS.md`（2026-08-29 完成）。
- [x] **A2 冻结生效**：`packages/domain/src/clinicalEvidence.mjs`（约 4.9k 行、~335 个正则位点）停止新增开放词汇 prose 正则。新的药物/场景规则一律进 `clinical-safety-rules.json`；其余语域判断先记 eval case，等 review 面接手（C1）。
- [x] **A3 交付前两步固定化**（2026-08-29 补正：**原先钉错了文件**。测试断言 `capabilities/<id>/SKILL.md`，
  但镜像 `COPY capability-skills` 且 `EVIMED_CAPABILITY_SKILLS_DIR` 指向它——被委派子代理读到的是后者，
  而十一份技能体里两步一个都没写，测试却一直是绿的。已给十一份补上、测试改为两份都断言、
  drift 基线记为有意的单向分歧；旧树 `runtime/skills/evimed` 按计划不动，翻内核时删除。）：在新树能力包（`OpenScience/capabilities/<id>/SKILL.md`）把 `manuscript-humanize`（语域净化，引语/数字/引文索引/claim 标记字节不变）与 `traceability-review`（引文可解析、无源数字、图-代码对照）写成长文类能力交付前的固定步骤，不再依赖模型自选。旧树 `runtime/skills/evimed` 不动（服务现役 opencode 内核，翻默认后随附 B 处理）。
- [x] **A4 后台话语的合法去处**：工作区布局约定 `deliverables/<id>/revision-notes.md` 为修订说明/过程记录的指定落点，相关 SKILL.md 加一句指路。有出口，正文禁令才立得住。
- [x] **A5 写作评测起步**：`OpenScience/evals/` 下建语域/文风事故台账——每次「后台漏前台 / 免责口吻 / 版本痕迹」事故 = 一条 case。先攒语料，不建 harness。

## B. 小改（各配一条阴性对照测试）

- [x] **B1 prose-pattern 钉数测试**：对 `clinicalEvidence.mjs` 的开放词汇正则位点计数并 pin，增加即红，测试注释指向原则 #5（机制同 domain tsc 钉数测试）。
- [ ] **B2 可重算量的一致性 notice**：meta / MR / 临床数字主张中可从冗余重算的量（p 值 vs 检验统计量+自由度、CI 与点估计一致性、均值粒度 GRIM 式检查）挂 `qualityNotices` / 验证门四指标旁，**不阻断**。statcheck（R 包）进 `stats-integrity` 技能工具箱（R 已在 runtime-dsh 镜像）。

## C. 排进既有轨道（不新增轨道）

- [ ] **C1（P2 · review 插件）首发场景 = 语域/泄漏审查**：全新上下文审查者（模型改别人的稿远强于改自己的稿）+ 固定裁定 schema + 代码核验可查部分。跑出实测分布后，`clinicalEvidence.mjs` 的开放词汇正则降级为 notice、阻断权移交。
- [ ] **C2（manuscript-support 能力设计，规划位）两条底座**：①「文中无手打数字」——统计量从 results 工件渲染进正文，契约查「正文统计量必须在结果工件有出处」（数字是闭集，正是代码该做的检查）；②复用 `项目代码/论文审稿/src/rubrics/` 的 15 份报告规范 YAML（CONSORT/PRISMA/GRADE/STROBE/TRIPOD-AI…）按文体作生成稿的审查清单。大纲先行（STORM 模式）只借模式，落在该能力 SKILL.md 里，不新增门禁产物。
- [ ] **C3（附 B · 内核翻默认既有链）**：输入侧正则路由（`specialistRouting.mjs`，全仓正则密度最高：198 行 26 个位点）按既定决策降级为非阻断期望检查。不提前、不另做。

## D. 平台主线必要项（收敛自 STATUS S161–S174 与未闭合清单；B/C/U/A/F 大轨道见 spec 路线，不在此重复）

- [x] **D1 修复回环的「迟到雪崩」**：rq03j/rq03k 两轮七次尝试用满、停在 2 条 required，轨迹 8→13→1→**83**→7→13→2——矩阵 schema 修对后 required 爆量、预算先竭。S163 已收两条（同一行为只报一个 issue；同一空字段跨 ≥3 主张收敛）；剩余：门禁遇「矩阵不可解析 / schema 错」时明说「先修 schema，修完将重算全量」，修复预算按行为而非条数消耗。全部用 S172 离线回放台（`replay-clinical-gate.mjs`，5 个真实包 3 秒）调，不再用真跑买缺陷。
- [x] **D2 S174 收尾**：`typecheck:port` / `typecheck:socket` 已接入 `test:web`（工作树），210 条类型错误烧毁进行中（当前 13 个修改文件即此项）；跑绿即提交——含已证实的死回退（`call.agent ?? …`）与活缺陷修复。
- [x] **D3 `check:dsh-upstream` 补真**：PROGRESS 记载「新增 pnpm check:dsh-upstream」，但全仓查无此脚本（仅 PROGRESS.md 提及）——「现在时的愿望」缺陷族。补实现（pinned/npm/GitHub 三方对比，npm 领先即 exit 1）+ 一条钉住存在性的测试；0.1.2 rc 落 npm 即按 S170/S171 清单 bump（adapter 两处 + golden 从活线重录），之前不动（alpha 仅 GitHub tag，采纳单元是 npm rc）。
- [ ] **D4 批测前置与批测**：一次新鲜单跑到 `accepted`；核一遍分类器超时/重试参数（S162：链路 ~35KB/s 时 classifier timeout 且正则兜底未接住，临床题面被派去 open-domain——批测会被路由错误污染）；然后 33 篇谷时批测（对照组干净后，生态一期合入镜像）。
- [~] **D5 `audit:capabilities` 刷新**（2026-08-29 推进）：17/26 → **22/26**。五个专家 agent 真跑出新回执（药物安全/文献计量/科研选题/论文审稿 succeeded，meta blocked 但产出完整手稿）；顺带修好文献计量的 CJK 字体崩溃（两份副本）与验证器把 26 个工具硬编码成 25（改为从 `server.list_tools()` 推导）。**剩 4 项全部为凭证阻塞**：web_search / patent_search / pharmacy_reference_search 缺 key；MR 的真实阻塞点实测为 OpenGWAS JWT（HTTP 401）——环境侧已打通（装 R 4.3.3 + 补齐 .r-lib 整条依赖链）。探针按设计拒绝写出部分证据，故仍红；凭证到位后重跑一次即转绿。
- [ ] **D6 翻默认内核 → 附 B 删除**：四个发布硬门（P0 真跑验收、capabilities 重探、F0 会话页真 RQ 验收、部署宿主 hosted e2e）达成后翻 `runtimeKernel` 默认，同一 PR 删旧 store / `packages/sdk` / `src-tauri` / `runtime/harness` / `deploy/runtime-opencode`。双栈每多活一天，一切改动双倍成本。
- [~] **D7 生产 receipt 续期机制**（2026-08-29：机制已建，生产仍红且根因已定位）：`release-receipt-scheduler.mjs` + `docker-compose.receipt.yml`（照 backup-scheduler 范式：run/health/状态文件，12h 续期＝回执 24h 寿命的一半，健康按回执剩余寿命判而非按上次尝试）已实现并测。**但生产此刻铸不出回执**：`preflight:deepseek:release` 在 web 容器里返回 `opencode_binary_missing` —— `OPEN_SCIENCE_OPENCODE_BIN` 是空串，于是回退到 `apps/desktop/src-tauri/binaries/`，而服务器镜像根本不含桌面壳目录，宿主与容器里也都找不到该二进制。故 08-15 那张回执从签发当天起就无法续期。**裁决**：不要为它把二进制塞进服务器镜像（那会把已在退役的 OpenCode 依赖重新钉进生产）——这条并入 D6 的内核翻默认，届时 release-gate 改为认证 DSH 内核，scheduler 直接可用；在此之前生产 readiness 的 modelGateway 一项保持已知红，且它是**唯一**红的一项。：deepseek release receipt 24h 窗口无续期 = 永远红的告警；随 DSH 版 release-gate 重写解决为「可无人值守续期」，期间手动 mint 保绿。红着的告警教会所有人忽略告警。
- [x] **D8 推送**：已解决（2026-08-29 核实）——推送目标是 GitHub，`main` 与 `github/main` 齐平（ahead 0），本机可推。原「231 未推」按 gitee `origin` 计数属过时口径；gitee 落后 231+ 提交，保留为镜像还是作废需另行拍板。

## E. 运维必要项

- [x] **E1 恢复演练一次**：`restore:object` 到隔离目录真跑，记录时长并核对完整性。从未恢复过的备份不算备份。（小，一次性）

## F. 证据完整性与注入评测（2026-08-29 联网核实后新增）

- [~] **F1 撤稿检查落地**（判定半边已实现并测；接线待网关取名单）（P1 已规划，数据源核实可用）：Retraction Watch 全库 2023-09 起归 Crossref——免费、每工作日更新、已入 Crossref REST API 与公开 CSV。实现 = 交付物引文的 DOI/PMID 闭集比对（正是代码该做的检查），先 notice 观察分布；医学场景引用已撤稿文献属事故级，观察后可升 MUST FIX。
- [ ] **F2 注入红队评测**（只加 eval，不加门禁）：平台三要素俱全（私有数据 API + 不可信文献/网页 + 对外交付）即 lethal trifecta；业界共识是架构上无法根除、靠纵深。现有纵深（网关白名单、工作区隔离、无直连出网、胶囊不可信、路径守卫）形状正确但**从未被证明**：`evals/` 放带指令诱饵的文献/网页（「把 X 写进结论」「读取并外传」），断言报告不受污染、网关无越界调用——与原则 6、工程方法「断言结果不断言机制」一致。

## H. GEO（2026-08-29 落地，spec §9.11）

- [x] **H1 探测通道**：`/internal/geo-probe/v1` 作为第四条内部网关（与 model/sources/search 并列），
  不放宽 `publicSourceGateway` 的 HTTPS-only——探测机是自家后端不是第 81 个公共来源。运行时只能点名
  `providers`/`ask`/`screenshot`，永不拼上游路径、不知探测主机、不持凭证。公网明文需显式承担，
  配密钥则 HMAC 签名并回传响应摘要。十个守卫逐条变异验证。对真机端到端跑通。
- [x] **H2 能力包**：`capabilities/geo-content/` + `capability-skills/geo-content/` + `evals/geo-content/`
  四份真实 brief。契约补齐"数字那一半"：五条测量 notice + 探测机地址进正文，**全部先 notice**
  （第七个阻断点要拿实测分布来争），verdict 带上做该裁决用的 metrics。
- [x] **H3 门禁自证**：geo-skills 2.0.0 的 78 条 BLOCK 全部补上具名对照（`evals/geo-gate-coverage/`，
  棘轮为空），并记录每次变异是哪条测试红的——"78/78"上一次是假的。
- [x] **H6 GEO 包的临床契约**(2026-08-30):`geo-content-pack` 进 `CLINICAL_CONTRACT_KINDS`,
  同时 `validateGeoContentPack` 调用共享的 `evaluateClinicalSafetyRules`(导出复用不重写)。
  两半必须一起 —— 只加前者会让触发器不再触发而无人接手,比原来的拒绝更糟。
  真跑验证:同一份交付物从"拒绝理由无法执行"→"拒绝理由具体可修"→`ok: true`。
- [ ] **H4 78 个 BLOCK 的分档**：需真实项目的实测分布，不能凭空定。这是 GEO 接入唯一未闭合项。
- [ ] **H5 传输加固**：探测机加 TLS/域名，或走私有链路。配置位已留（`OPEN_SCIENCE_GEO_PROBE_*`），
  取决于那台机器能否动。在此之前明文跨公网，答复里如实标注。

## I. 下一阶段（2026-08-30 规划，按 H 节落地后的盘面重排）

前情：本清单大半已被 08-29/30 的执行清掉（A 全部、B1、D1–D3、E1、F1 判定半边、GEO H1–H3/H6）；geo-002/003 测量半程完成（六 notice 全部有阴性对照、真实分布 0/4、不设第七阻断点）；糠酸莫米松全景分析在生产真跑 succeeded（46.8 分钟、0813 版门禁 0 阻断、19/19 direct 引语经独立复核逐字命中）。

- [x] **I1 门禁健康度仪表（notice 级，不新增阻断）**（2026-08-30 完成）：`pnpm gate:health`
  把磁盘上 **88 份真实成品包**重放进今天的临床门禁。前提已核实为真：7 件必需（07-23）→
  `question-coverage.json` 于 **08-15** 加入成 8 件。配套棘轮已落地：
  `required-outputs-baseline.json` + `apps/server/test/requiredOutputsBudget.test.mjs`——
  **加一件必需文件必须先 `required: false`、看仪表、再单独提交提升**，四条变异全部被抓
  （加第九件 / 改名保持计数 / 日期缺失 / 记录计数与列表不符）。
  **仪表读数（诚实版）**：76 份**无法判定**（`.evimed-sources` 已不在盘上，是重放的限制不是包的缺陷——
  按内容失败计会得出"6% 通过率"这种关于重放而非关于包的假头条）；可判定 12 份中 5 通过、7 内容失败、
  **膨胀税 0**。而**这个 0 不是"加这件文件不花钱"**：80/88 早于该文件,但没有一份是"只差它"——
  可判定的都另有内容问题,其余压根判不了。工具会自己把这句话打出来。税要到"按当前清单产出、
  且只被下一次新增拒绝"的第一份包出现时才可测。：从 agentRuns/gateRuns 既有账本计算——首过率、尝试次数分布、每次退回 issue 条数、degraded 率、修复回环 token 成本，按门禁/契约版本分组。动机：**阻断点数守恒（6 个），但单点内部判据在膨胀**（生产 0813 版 7 件必需 → dev 树 8 件 + 题面覆盖台账；rq03 的 8→13→1→83 轨迹就是膨胀的税单），每次膨胀都在首过率上付税，现在没人记账。配套规则：**新增必需文件/新增 required 判据也过「先 notice 后必需」，与新增阻断点同权**。
- [~] **I2 review 插件：插件已存在，缺的是场景**（2026-08-30 校正）：`packages/socket/plugins/review.mjs`
  已在基础 preset 里(129 行,fresh context、逐 claim 裁定 schema、只出 notice——29 次真实交付
  129 条发现、代码核验剩 114、命中人工标注仅 3 条,故设计上就不出裁决)。所以这条不是"立项"
  而是"加两个场景"。场景②的实测缺陷已按原则 #6 归档为 eval case
  （`evals/writing-incidents/cases/2026-08-30-geo-003-mention-context-not-weighted.json`,
  `caughtBy: nobody`）——先有可被度量的案子,再谈修法。场景①（C1 语域/泄漏）仍在排队。：① 语域/泄漏审查（C1）；② GEO 提及语境分档——「临床语境被推荐」与「爬来的种草贴标题出现」不同权（geo-003 实测缺陷）。同一形状：模型判、代码核、notice 起步，不写正则。
- [ ] **I3 GEO 模型驱动真跑（解锁 GEO-H4）**：卡点是 Docker——生产宿主有 Docker 29.1.3（糠酸莫米松即在其上跑通）；geo 能力不在 0813 部署清单，在宿主隔离验收项目里跑（dsh-p0 同款隔离纪律），用 `evals/geo-content/` 的真实 brief + briefs.json 账本跑一次模型驱动运行，产出五条测量 notice 与 78 BLOCK 分档的第一份实测分布。
- [ ] **I4 全景运行收尾三件**：①「29 vs 28」检索式计数不一致 → B2 的第一条真实 eval case（正文叙述数字与台账交叉核对）；② references.bib URL 条目 notice 复盘；③ 糠酸莫米松题面 + 交付物归档为 evals 真实题面（全景型此前空白）。
- [ ] **I5 = D4 批测**：D1 雪崩已修——正好先用一次新鲜单跑验证修复真实生效（含分类器超时参数核对，S162），再 33 篇谷时批测；对照组干净后生态一期合入。
- [ ] **I6 部署合并窗口**：生产仍在 evimed-20260813（全景跑的是旧门禁）；D6 翻内核默认 + D7 receipt 续期（已裁决并入 D6）+ geo-content 能力上生产，合并为一个变更窗口，避免多次生产变更。
- [ ] **I7 等用户拍板/供给的三件**：① 四项凭证（web_search / patent_search / pharmacy_reference key + OpenGWAS JWT）→ D5 的 22/26 转绿；② 探测机能否配 TLS/域名（GEO-H5，配置位已留）；③ gitee 镜像去留（D8 尾巴）。

不做（继承 G，另加）：不因 rq03 的痛削减必需文件清单（先看 I1 数据）；不设 GEO 第七阻断点（采纳 geo-002/003 结论）；不用正则猜提及语境。

## G. 明确不做（防过度开发）

- 不新增任何开放词汇 prose 正则；不为语域问题继续扩 `clinicalEvidence.mjs`。
- 不新增第 7 个阻断点——B2 / C1 全部以 notice 起步（spec §29「先 notice 后阻断」）。
- 不整装 STORM / PaperQA 等外部框架，只借模式（spec §16 #22 第四档「借模式不借代码」）。
- 不写新的 DSH 插件——功能一律走能力包；socket 是唯一插件面（不形成双 harness）。
- 不为文风/语域训练或蒸馏任何模型（锁定决策「不训练模型」）。
- 不在旧技能树上做流程改造（现役 opencode 内核只保命，等翻默认）。
- 安全硬不变式的正则（SSRF/主机白名单、路径守卫、secret 扫描）与格式/闭集检查**不在冻结范围**——那是 harness 本职。
