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

### I6/清理裁决（2026-08-30，生产崩溃修复后拍板）

- **热修追认**：`.catch` 外科补丁 + 4 条阴性对照的做法正确；孤儿容器已清（时间线上很可能是当日上午糠酸莫米松真跑的运行时容器触发了潜伏缺陷——任何用户的运行都会触发，修法不变）。manifest 重生成时在 STATUS/release 备注里记录补丁来源 commit 与校验和。
- **全量部署：不开窗口。** I6 窗口前置条件定为四条：① 生产静养 ≥72h（restarts=0，readiness 收敛到唯一已知红 receipt）；② 四道发布硬门补齐——F0 会话页真 RQ 验收、capabilities 转绿（等 I7 凭证）、108 提交 delta 在宿主 acceptance 目录彩排 hosted e2e（不碰生产栈）；③ I5 批测完成（顺带验证 D1 修复）；④ 窗口内容一次做完：翻内核 + `.env` 五值 + receipt 续期 + geo 上生产 + 附 B 删除，保留回滚 release。
- **别人的镜像：不清。** 87%/23G 非紧急；tcm-cdss 21 分钟前还在出新镜像，旧标签是活跃项目的回滚路径。改为策略：磁盘 ≥90% 告警时由各栈 owner 自行收敛，不代删。
- **33 个 release：清到保留 3 个**（current + 2 回滚位），两个前置：先 grep 全部 .env/compose/systemd 无旧 release 路径引用；等在飞修复收尾、readiness 收敛后再动。今日此机不再做非必要状态变更。
- **backup_external_unconfirmed：现在就诊断**，不许成为第三个常红（D7 同一条理由：红着的告警教会所有人忽略告警；E1 刚抓过「恢复了空」）。
- **生产删除三判据（新纪律）**：删除任何镜像/文件前须同时满足——无运行使用 ∧ 无配置引用（grep .env/compose/systemd）∧ 无清单/回执引用。「没有容器在用」单独不构成删除理由（今日实证）。
- **重建容器必须用完整 compose 文件集**：文件列表照抄部署脚本，不手拼（今日丢过两个 secret 挂载）。


## K. 生产纪律（2026-08-30，源自当天两次真实失误）

- **K1 生产删除三判据**：无运行使用 ∧ 无配置引用（grep `.env` / compose / systemd）∧ 无清单/回执引用，
  **三者同时满足才可删**。当天教训：`open-science-opencode:…d0505d25` 没有任何容器在用,
  但 `.env` 的 `OPEN_SCIENCE_RUNTIME_CONTAINER_IMAGE` 和 `release-manifest.json` 的
  `runtime.imageId` 都指着它。删掉之后 readiness 多两条红,且**镜像 ID 不可复原**——
  重建出来的不是同一份字节,manifest 只能改钉,原来的"运行的就是当初认证过的那一份"这条链断了。
  删除的代价不止是"再建一次"。
- **K2 重建容器必须用完整 compose 文件集**：文件列表照抄部署脚本/既有容器的
  `com.docker.compose.project.config_files` 标签,**不手拼**。当天教训：用
  `-f docker-compose.yml -f docker-compose.saas.yml` 重建,丢掉了 local-auth 与 monitoring
  定义的 `bootstrap-password`、`operator_metrics_token` 两个 secret 挂载,readiness 立刻多两条红。
- **K4 放宽任何默认值之前,先证明严格值在真正需要的地方是被显式写出来的**:今天救了两次——
  ① `geo-content-pack` 进 `CLINICAL_CONTRACT_KINDS`,查出 `isClinicalContractKind` 全仓只有一处用途,
  只加那一行会让检查变少而非变多,于是两半同改;② `seam-probe` 默认 `full`→`partial`,查出
  `config.mjs:723` 生产算 `full` 且 `dshProfilePatch.mjs:243` 把它显式写进每份 patch,
  所以插件默认只在无控制面时被读到。**做法固定为三步**:找到该默认值的全部读取点 →
  确认严格路径显式赋值 → 配阴性对照钉住两头(默认是宽的、严格路径仍是严的)。
- **K5 验证步骤不得消耗它所验证的资源**：恢复演练(E1 为证明"备份能恢复"而加)每成功一次泄漏
  404MB 进备份容器的 2GB tmpfs,五次之后备份连续失败七天。形状是「清理只在失败路径上发生」——
  `trap - EXIT` 只有成功路径会执行到,于是**唯一有东西要清理的那条路径把清理关掉了**。
  加一条验证步骤时问一句:它占用什么、什么时候还回去、还不回去时先坏的是谁。
- **K3 备份红不许挂着**：当天诊断 `backup_external_unconfirmed` = 2026-08-29 磁盘满
  (`ENOSPC`) 导致连续 3 次失败、熔断器开启睡 24h。**117 次连续成功(含恢复演练)之后断的,
  而 healthcheck 红了 1276 次没有任何通道告诉任何人**——与 D7 同一条病。磁盘已释放,
  熔断按时自愈即可验证;告警缺口本身待补。

## J. 开源即插即用轨道（2026-08-30 核查；Apodex 对照后立项）

核查结论：**代码是真诚可移植的，被少数发布性障碍挡在门外**——socket 无一处 import 控制面；MCP 27 工具中 16 个 keyless 直连公共源（网关是 opt-in 不是硬耦合）；`@evimed/domain` 零运行时依赖、门禁随 bundle 走。六大功能盘点：综述/ADR/资料查询/申报书可开源首发（降级可用）；meta/选题是引擎背书型——引擎在 `项目代码/` 且 MCP 已有本地子进程模式（`EVIMED_*_AGENT_ROOT` + evimed_runner.py），开源引擎仓库即可点亮。

发布前 P0（按杠杆排序）：
- [x] **J1**（2026-08-30 完成，含阴性对照）`seam-probe` 的 `requiredEnforcement` 默认改 `partial`（托管部署经 patch 显式回 `full`）——一行之差 = 陌生人 mac/普通 Linux 能不能启动。
- [x] **J2**（2026-08-30 完成）三包去 `private:true`、真版本、publishConfig：`@evimed/domain` / `@evimed/harness-port` / `@evimed/dsh-socket`；`workspace:*` 依赖改可解析版本。
- [~] **J3**（2026-08-31 考古完成，实现待做——裁决设想的机制不存在，正确形状已定）bundle 自带 `mcp-evimed` 配置行（现在只有控制面 `dshProfilePatch.mjs` 会生成，没有它整个能力目录是装饰）。

  **考古结论（拉了 `@deepseek-ai/dsh@0.1.1-rc.2` 与 `dsh-app-boot` 读源码）**：
  1. **补丁栈有确定顺序**：`bundlePatches → profile.patches → homePatches → overlays`，
     所以 bundle 插的行**可以**被控制面生成的 profile 补丁改写——这一半成立。
  2. **但改写是浅赋值,不是深合并**：`applyEntryPatches` 里就一句
     `target[key] = value`。控制面一旦覆盖 `config:`，**整个 config 对象被替换**，
     bundle 提供的静态部分全部丢失。所以「静态进 bundle、控制面只补部署专属字段」**做不到**。
  3. **补丁里没有 env 占位符**：全仓所有补丁文件的值都是字面量。
     **但这条结论下得太窄，须更正（2026-08-31 补）**：机制确实存在，只是不在 patch 而在
     **preset** —— `presets/evimed-universal/agent.cordis.yml` 已经用了七处
     `!!js process.env.X`（`capabilitiesDir`、`askUserEnabled`、`maxSteps`…），
     而 preset 就在 socket 包的 `files[]` 里随 bundle 发布。裁决的直觉是对的，是我只看了 patch。
  4. **控制面现在是 `insert` 而不是 override**：bundle 若也 insert 会出现**同 id 两行**，
     两个 MCP 进程。

  **因此正确形状是（已按上述更正改写，比先前设想的干净得多）**：把 `mcp-evimed` 行放进
  **bundle 自己的 preset**，路径与 env 一律 `!!js process.env.X ?? <默认>`，与
  `capabilitiesDir` 现在的写法完全一致；控制面**不再 patch 这一行**，只负责把那些环境变量
  设进容器（它本来就在设 `EVIMED_PRESET_SKILLS_DIR` 等）。这样既没有同 id 两行，
  也不依赖"浅赋值覆盖"，陌生人拿 bundle 直接就有研究工具。
  **风险点必须同时处理**：override 因 name 不匹配等原因被跳过时只 warn，
  运行会带着 bundle 的默认 env（没有网关地址）启动——**行看起来配好了而工具全部失效**，
  正是最坏的那种形状。缓解手段现成：seam-probe 本来就"逐行复查我们覆盖过的行"
  （bundle patch 文件头自己写的），把 mcp 行纳入复查即可把静默降级变成响亮启动失败。
  实现须连带改 `build-smoke-patch.yml` 与 `dshProfilePatch.test.mjs`，并由 build-smoke 真启动验证。
- [x] **J4**（2026-08-31 完成）capability 层去平台假设：**`generate-capability-manifests.mjs` 已进 socket 的 `prepack`** —— 13 份清单原本只生成到
  `deploy/runtime-dsh/capabilities/`（一个**部署**目录），三个可发布包一个都不带它，
  所以从 npm 装 `@evimed/dsh-socket` 的人拿到插件与 preset、**拿到一个空目录当能力目录**，
  每一次委派都被拒，错误信息还是在讲请求而不是讲部署。现在 prepack 生成清单并拷贝
  `capability-skills/`，两者都进 `files[]`；测试**真跑一次 prepack** 再核对
  「每个能力一份清单」「清单点名的每个技能体都在包里」。；**5 份 SKILL.md 的分支——查下来是伪问题，不做**：`evimed_submit_deliverable` 由
  `evimed-run-policy` 提供，而该插件就在 **bundle 自己的 preset** 里，任何拿到 bundle 的人都有它，
  根本不是平台假设；`.evimed-brief` 五份里只有 clinical-evidence-synthesis 引用了一次，
  且**已经写好了降级**（「若该文件不在，说明门禁也在没有题面的情况下检查，并会在交付上说明」）。
  没有需要分支的东西。；**capabilities/ 与 capability-skills/ 两树合一 —— 已完成，但裁决的方向要反过来**：
  「单一作者树 = capabilities/」这个方向若照做会**毁掉真内容**。实测三方对照：
  `runtime/skills/evimed`（那条测试实际校验的副本）与 `capability-skills/`（运行真正读到的）
  都写 **three tools preserve**，而 `capabilities/`（被指定为权威的那棵）还写 **two** ——
  照 capabilities 覆盖过去，等于把「只有两个工具保全产物」这个**错误事实**重新灌进每一次委派运行，
  运行会因为拿不到 artifact 而丢掉本可成立的主张。镜像树同时还多一段「后台话语该去哪」的出口说明。
  所以是**按内容合并**（镜像的三处更正 + 作者树那一句更完整的表述），不是按方向拷贝。
  合并后新增 `skillTreesAreOneTree.test.mjs` 相等测试（变异验证：把镜像改离作者树当场点名到行号），
  DSH↔OpenCode 那条 drift 测试是**另一对**（内核差异，旧树待删），基线相应 +1。
- [x] **J5**（2026-08-31 完成，两条配套齐）去硬编码：**前半已完成**（`EVIMED_EVIDENCE_BASE_URL` 改 env-overridable，且无凭证时
  `_evimed_post` 直接以 `evimed_evidence_unconfigured` 拒绝并指明"keyless 公共源仍可用"——
  陌生人不再每次检索都先对 evimed.com 发一个注定失败的请求；错误码已归类为 recoverable）。
  **后半不是一次 sed,需要一个决定**：48 个引用写的是扁平的 `$XDG_CONFIG_HOME/opencode/skills/<名>/…`,
  而 DSH 镜像把它们放在**三个不同的根**下——`curated-scientific` → `/usr/local/share/evimed/skills/…`、
  `core` → `/opt/evimed/skills/core/…`、preset skills → `/opt/evimed/socket/presets/evimed-universal/skills`。
  单一 sed 必然把其中两组指错。**而且这 48 个里有 45 个(36 curated-scientific + 9 core)是 DSH 镜像真的 COPY 进去的**,
  也就是说这不只是可移植性瑕疵,是现役 DSH 运行里就指着一个不存在的 OpenCode 配置目录。
  **约定已按裁决落地**：技能体只写相对根引用（45 条已改，闭集禁词测试钉住）；绝对根声明在
  `@evimed/domain/skillRoots.mjs` 一处，由 guidance 注入运行读到的一段（"你的 shell 从工作区起步，
  所以把相对引用解析到这些根下的技能目录"）。两条配套齐：① 闭集禁词测试 + 前提钉住（`_runtime`
  必须是真实兄弟目录）；② **build-smoke 真跑**——`cd <skill> && python3 ../_runtime/execute_skill.py`，
  与技能体现在写的引用同一条路径，本地已验证可解析可执行。另加漂移守卫：声明的根必须与
  Dockerfile 的 COPY 目的地一致（三条变异全被抓）。
  **裁决（2026-08-30，两路核验后）**：采用 Agent Skills 开放标准原文——**技能体内一律相对技能根引用**
  （`scripts/x.py`；curated 共享执行器写 `../_runtime/execute_skill.py`，与家族根同拷贝故相对性天然保持）；
  **绝对根是部署真相，只在一处声明**——DSH 面由 guidance/profile patch 注入一行「技能根清单」
  （决定性事实：DSH skill 子系统对模型隐藏技能路径、`resourceBase` 只按需解析，模型必须用声明的根
  拼绝对路径去 bash 执行）；opencode 面由其运行时同理声明。配套两条：
  ① 闭集钉住测试——技能体禁含 `$XDG_CONFIG_HOME/opencode` / `/opt/evimed` / `/usr/local/share`
  （封闭路径词表，正是代码该做的检查）；② build-smoke 从声明根真跑一个 curated 脚本（断言能力不断言机制）。
  **优先级：升级为活缺陷修复，插队先于 J4/J7/J3。**
- [ ] ~~**J5 原文**~~ 去硬编码：`EVIMED_EVIDENCE_BASE_URL`（evimed.com）改 env-overridable 且无凭证时跳过首跳（现在陌生人每次检索都先对 evimed.com 发一个注定失败的请求）；48 个技能文件的 `$XDG_CONFIG_HOME/opencode/...` 路径一次 sed。
- [ ] **J9**（2026-08-31 彩排发现，开源与可复现的硬伤）**仓库自己建不出自己的 web 镜像**：
  `deploy/web/Dockerfile:57` 硬 `COPY runtime/skills/external/ai4s-skills`，而
  `OpenScience/.gitignore:62` 把 `runtime/skills/external/` 整个忽略掉。宿主上的构建之所以一直成功，
  只因为发布目录里恰好有这份未受版本控制的 4.6MB 内容。**陌生人克隆仓库无法构建**，
  而我们自己的镜像也依赖着版本控制之外的东西——这两件是同一个洞。
  修法二选一：vendored 内容入库（体积可接受）、或改为构建期按清单拉取并校验 sha256（与
  runtime-opencode 拉 opencode/uv 的写法一致）。
- [ ] **J6** 补三个 keyless 直连模式（可后置）：web_search（SearXNG/Brave 直连档）、patent_search（Google Patents/EPO OPS 连接器）、open_access PDF 直连 Unpaywall 分支；pharmacy 出「自建 SQLite 的 recipe」而非数据。
- [x] **J7**（2026-08-31 完成）课题申报书从 curated 技能升为正式能力包：新增契约种类 `grant-proposal-package` + 验证器、`capabilities/research-grant-development/`
  （manifest + SKILL）、`capability-skills/` 同名技能体、`evals/research-grant-development/` 三份 brief。
  **阻断只在原技能已声明的东西上**（四件产物 + milestones 表可解析、每条里程碑有日期）；
  两条新判据「要求无原文引用」「要求未进自查」按纪律**先 notice**，五条变异全被抓。
  **必需产物棘轮当场接住了它**——新契约七件必需文件必须先记进 `required-outputs-baseline.json`
  才放行，这是那条棘轮第一次真用上。
- [ ] **J8** 引擎开源包装（点亮 meta/选题/MR/审稿/文献计量/药安 六个管理作业）：六个 Python agent 独立仓库 + evimed_runner CLI 文档 + 本地模式直连 DeepSeek key（现在要求走网关且钉死 deepseek-v4-pro）。

顺序裁决（2026-08-30）：**J5b（活缺陷，插队）→ J7（小、独立）→ J4（单独一轮，赶在 33 篇批测之前落地，让批测覆盖合并后的树；方向=单一作者树 `capabilities/`，镜像树由它生成/拷贝，漂移测试改为相等测试）→ J3（先考古 `dshProfilePatch.mjs:145-176` 那行的生成参数，静态部分进 bundle patch 带 env 占位，控制面只留部署专属覆盖）**。

分界（开源 vs 平台专属）：**开代码、留数据**——socket/domain 门禁/MCP/能力包/技能全开；平台专属 = 私有数据 API 与药学库数据本身、胶囊/记忆服务、计量与额度、服务端独立复核即服务、托管运维。`build-smoke.sh` 已是陌生人 README 的八成。

## L. DSH 决胜线（2026-08-31 用户拍板：不留退路，坚持把 DSH 内核做好）

两个用户决定，立即生效：
- **L0a 备份 = 本机副本即最终形态**：不配对象存储桶。执行方式是**声明不是删除**——离盘状态按 `not_configured`（"是决定，不是故障"）落案，readiness 的 backup 项据此收绿；本地备份 + 恢复演练机制（刚修好并验证的）**保留**，三结局代码保留。单机风险作为已接受项记录在案；若日后翻案，平台侧已就绪，只差桶名与凭证。
- **L0b 不留退路 = 不维持双内核**，不是不要证据、也不是窗口当天没有安全绳：内核平价改用**历史 opencode 交付作基线**（不再双内核并行对照）；变更窗口保留一个 release 回滚位，窗口后 72h 稳定即按既定裁决清至 3 个。

**决胜关键路径（顺序即依赖）**：
- [x] **L1**（2026-08-31 核实为**已于 S216–S220 完成**，不重做）：仓库现存 36 处 `XDG_CONFIG_HOME/opencode` 全在审计账本 `digest-repins.jsonl` 的**理由字段**里；活引用只剩 3 处，都在 `runtime/skills/evimed/` 旧 OpenCode 树（镜像不 COPY，随 L7 附 B 删除）。根声明单点 `packages/domain/src/skillRoots.mjs` 在位，三条配套测试在位，build-smoke 真跑已于 S239 在真镜像上验过。
- [x] **L2**（2026-08-31 核实为**已于 S227–S231 完成**）：`capabilities/` 与 `capability-skills/` **13 对 SKILL.md 逐字节相等**（本轮用 `cmp` 全量复核）。注意合并方向按 S227 反转过：被裁决指定为权威的那棵当时是过期的一棵。
- [x] **L3 F0 完成（2026-08-31）**：`scripts/ops/session-stream-acceptance.mjs` 在 HEAD + 新镜像上跑真问题，**3981 帧 / `succeeded` / 第 40 帧掐断后 `?since=40` 续订零重放零 gap**；实况帧入库为前端测试输入（`runStreamLiveFrames.test.ts`）。
  - **查出三个"声明了没人发"的流类型**：`deliverable/update`（浏览器有监听、有 fold、有数组，**每次运行那块面板都是空的**）、`approval/requested`、`question/requested`（浏览器连监听都没注册；内核确实会问，属 F2）。已由 `streamTypesReachTheBrowser.test.mjs` 钉住三个集合。**`deliverable/update` 是否补发布方，是产品决定，未擅动。**
  - **验收环境的一条隐性依赖**：内网到宿主只有一条**手工装的 ufw 规则**放行 18787，代码里无迹可寻；换端口起控制面就"运行什么都不产出"。已补同形规则。**生产不受影响**（走容器 DNS）。
- [x] **L4 完成（2026-08-31）**：单跑验证 D1 雪崩修复成立（门禁 3 轮而非用满 7 次预算）；**33 篇批测跑完在 DSH 内核上，31/33 成功**。与同 33 篇 opencode 基线对照：成功 33/33 → 31/33；助手正文 33,072 → **79,732 字（241%）**；工具调用 399 → 385；产物 32 → 66。
  - 开跑前修掉四处 OpenCode 时代的批测台缺陷（已退役直通路由 / 30 分钟上限低于运行时长 / 单一项目共用工作区 / 运行时槽位不归还），以及**正则网压过模型干净裁定**的路由错配。
  - **两条失败同一根因，仍是路由不是内核**：`routeNamedSpecialist` 把论文标题里的 "Meta-Analysis" 当成用户点名能力包，且它跑在分类器之前并压过它。未擅动——「点名即指令」的优先级是产品决定。
  **L4 前置裁决（2026-08-31，`specialist_receipt_digest_mismatch` 与批测跑法）**：
  ① **回执保留**——它是 S165（"没有任何门禁看过实际发出去的字节"）的直接解药，等价于工业界
  attestation-绑-digest / test-what-you-ship；拿掉=交付门禁变剧场。
  ② **但失败姿势要改，三层**：防——验收即冻结，receipt 写下后被验收路径进路径守卫保护面，
  运行再写当场收到可行动拒绝（"该文件已验收，要改请重新提交"），错误以返回值形态出现在写的瞬间；
  治——仍出现 mismatch 时**不直接 failed**：服务端用同一份 domain 门禁对实际字节重判（单实现，边际成本≈0），
  过 → 换发新回执、succeeded + `amended` notice；不过 → 才是真事故按既有降级/失败逻辑走。
  mismatch 错误码只在"实际字节没过门禁"时出现；账——notices 记录哪些文件在验收后被谁的哪一步改
  （从转录工具调用归因；首要嫌疑：提交后才跑的 humanize/摘要步——执行侧核一下上一跑的实际改动者，
  若 SKILL 步序含糊则把"humanize 在提交之前"写死一行）。
  这是既有服务端外部门禁（6 之一）内部的策略修正，方向是减少阻断，不是第 7 个阻断点。
  ③ **批测跑法**：修完上面再开跑（单跑到 accepted 即其验证载体）；11 小时不是问题——谷时批测本来就是过夜
  （22:00–09:00 恰好一夜），**并发保持 2–3**（15GB 宿主、生产同机、容器各 4g，并发 4 是在赌 OOM，
  OOM 的账单是整夜作废）；**断点续跑是硬要求**（每完成一条落盘一条、重跑跳过已完成，outputs/audit 的
  RESUME 模式照用）；走真临床线不打折——批测的全部价值是给翻默认供证据，换轻量线=证据作废，40 分钟/条是真实成本，认。
- [x] **L5 完成（2026-09-01）**：在宿主 acceptance 目录搭起 production 形态的栈（独立 postgres ＋ memos ＋ drug-safety 适配器 ＋ release manifest ＋ kernel），hosted e2e **跑出全绿**：`every mechanical assertion passed, with 1 notice`（notice ＝ signals.csv 0 数据行）。
  - 途中修掉四处真缺陷：已退役直通路由（移植）、记忆证据**按字节**越界（跨语言边界，阻断了全部记忆写入）、e2e 等待短于被等待者预算、三处诊断吞噬（`securityAudit` 丢弃调用方上下文 / memos 拒绝不带路径 / e2e 六条件一句话）。
  - 判据按 §16 #24 切分：机械面阻断（含新增的 run_summary 见证），内容面 notice 带观测值。
- [ ] **L6** capabilities 收口（二选一，用户拍板）：①补 4 项凭证（web_search / patent / pharmacy key + OpenGWAS JWT）重探转绿；②明确声明这 4 项为未配置面、门禁按"已配置面全绿 + 未配置面具名申明"收口。
- [ ] **L7 变更窗口（一次做完）**：静养期满（约 09-02）+ L1–L6 绿 → 翻 `runtimeKernel` 默认 dsh + `.env` 五值 + **附 B 删除**（旧 store / packages/sdk / src-tauri / runtime/harness / deploy/runtime-opencode / fetch-opencode）+ OpenCode 版 release-gate 死、DSH 版 release-gate + receipt scheduler 上线（D7 收尾）+ geo-content 上生产 + manifest 重生成。窗口内保留一个回滚 release，72h 后撤。
- [ ] **L8 窗口后主线（把 DSH 内核"做好"的三件深化）**：① review 插件三场景（语域泄漏 / GEO 提及语境 / 跨源冲突裁决——Apodex 差距 #3）；② 模型网关按角色配模型槽位（审查者/检索手可换模型，为 Apodex-mini 类开源权重留门——差距 #1 的不训练解法）；③ Hard Medical Research 确定性内评基准（30–50 道封闭答案中文医学题 + hard negatives——差距 #4）。J 轨其余（J3/J6/J7/J8 + 开源首批发布）随后。

**等用户的清单（已缩短）**：① L6 的二选一；② GEO 探测机 TLS/域名可否（H5）；③ gitee 镜像去留。桶已从清单移除。

## G. 明确不做（防过度开发）

- 不新增任何开放词汇 prose 正则；不为语域问题继续扩 `clinicalEvidence.mjs`。
- 不新增第 7 个阻断点——B2 / C1 全部以 notice 起步（spec §29「先 notice 后阻断」）。
- 不整装 STORM / PaperQA 等外部框架，只借模式（spec §16 #22 第四档「借模式不借代码」）。
- 不写新的 DSH 插件——功能一律走能力包；socket 是唯一插件面（不形成双 harness）。
- 不为文风/语域训练或蒸馏任何模型（锁定决策「不训练模型」）。
- 不在旧技能树上做流程改造（现役 opencode 内核只保命，等翻默认）。
- 安全硬不变式的正则（SSRF/主机白名单、路径守卫、secret 扫描）与格式/闭集检查**不在冻结范围**——那是 harness 本职。
