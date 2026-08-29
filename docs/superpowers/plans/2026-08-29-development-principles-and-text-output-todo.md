# 开发原则落地与文本输出层 TODO（2026-08-29）

- 来源：两轮讨论的收敛——「正则/门禁越修越错」的根因分析，与文本输出层三痛点（后台话语漏进前台 / 思考深度与证据链 / 改一个数不联动全篇）。
- 十条开发原则已写入工作区根 `CLAUDE.md` 与 `AGENTS.md`（"Development principles" 节），每次开发自动载入；本文只保留行动项与「明确不做」。
- 纪律：不新增阻断点（全系统保持 6 个）、不新增轨道、不整装外部框架。与 spec（`../specs/2026-08-22-evimed-dsh-plug-harness-design.md`）冲突时以 spec 为准。
- 2026-08-29 二次更新：新增 D（平台主线必要项，收敛自 STATUS S161–S174）、E（运维）、F（证据完整性与注入评测，联网核实后）；原「明确不做」移至 G。

## A. 立即可做（纯文档 / 技能内容，不碰服务端代码）

- [x] **A1** 十条原则进根 `CLAUDE.md` / `AGENTS.md`（2026-08-29 完成）。
- [x] **A2 冻结生效**：`packages/domain/src/clinicalEvidence.mjs`（约 4.9k 行、~335 个正则位点）停止新增开放词汇 prose 正则。新的药物/场景规则一律进 `clinical-safety-rules.json`；其余语域判断先记 eval case，等 review 面接手（C1）。
- [x] **A3 交付前两步固定化**：在新树能力包（`OpenScience/capabilities/<id>/SKILL.md`）把 `manuscript-humanize`（语域净化，引语/数字/引文索引/claim 标记字节不变）与 `traceability-review`（引文可解析、无源数字、图-代码对照）写成长文类能力交付前的固定步骤，不再依赖模型自选。旧树 `runtime/skills/evimed` 不动（服务现役 opencode 内核，翻默认后随附 B 处理）。
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
- [ ] **D7 生产 receipt 续期机制**：deepseek release receipt 24h 窗口无续期 = 永远红的告警；随 DSH 版 release-gate 重写解决为「可无人值守续期」，期间手动 mint 保绿。红着的告警教会所有人忽略告警。
- [ ] **D8 推送积压**：**231 个未推送提交**（08-24 时为 161），单机磁盘风险；需操作者在持有 gitee 凭证处 push。

## E. 运维必要项

- [x] **E1 恢复演练一次**：`restore:object` 到隔离目录真跑，记录时长并核对完整性。从未恢复过的备份不算备份。（小，一次性）

## F. 证据完整性与注入评测（2026-08-29 联网核实后新增）

- [~] **F1 撤稿检查落地**（判定半边已实现并测；接线待网关取名单）（P1 已规划，数据源核实可用）：Retraction Watch 全库 2023-09 起归 Crossref——免费、每工作日更新、已入 Crossref REST API 与公开 CSV。实现 = 交付物引文的 DOI/PMID 闭集比对（正是代码该做的检查），先 notice 观察分布；医学场景引用已撤稿文献属事故级，观察后可升 MUST FIX。
- [ ] **F2 注入红队评测**（只加 eval，不加门禁）：平台三要素俱全（私有数据 API + 不可信文献/网页 + 对外交付）即 lethal trifecta；业界共识是架构上无法根除、靠纵深。现有纵深（网关白名单、工作区隔离、无直连出网、胶囊不可信、路径守卫）形状正确但**从未被证明**：`evals/` 放带指令诱饵的文献/网页（「把 X 写进结论」「读取并外传」），断言报告不受污染、网关无越界调用——与原则 6、工程方法「断言结果不断言机制」一致。

## G. 明确不做（防过度开发）

- 不新增任何开放词汇 prose 正则；不为语域问题继续扩 `clinicalEvidence.mjs`。
- 不新增第 7 个阻断点——B2 / C1 全部以 notice 起步（spec §29「先 notice 后阻断」）。
- 不整装 STORM / PaperQA 等外部框架，只借模式（spec §16 #22 第四档「借模式不借代码」）。
- 不写新的 DSH 插件——功能一律走能力包；socket 是唯一插件面（不形成双 harness）。
- 不为文风/语域训练或蒸馏任何模型（锁定决策「不训练模型」）。
- 不在旧技能树上做流程改造（现役 opencode 内核只保命，等翻默认）。
- 安全硬不变式的正则（SSRF/主机白名单、路径守卫、secret 扫描）与格式/闭集检查**不在冻结范围**——那是 harness 本职。
