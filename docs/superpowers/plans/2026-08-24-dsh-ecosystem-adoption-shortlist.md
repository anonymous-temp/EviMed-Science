# DSH 生态采用清单(2026-08-24 扫描)

配套决策:插排-插头方案 §16 #22(生态优先)与 §21.8(接入三档与动作)。本文是**工作清单**,不是设计——生态每周在变,过期就重扫,不必维护。

扫描面:GitHub `topic:dsh-plugin` 11,302 仓库;`awesome-dsh-plugin/awesome-dsh-plugin`(12.2k★)人工核验收录 2,112 项(21 个分类全量拉取,按科研关键词两轮筛);dsh-plugin.org 市场自报收录 4,805 / 人工精选 4,401;`topic:dsh-preset` 12 仓库 + `hackerFish/awesome-dsh-presets`。头部候选逐一取了 stars / 最近推送。

**成熟度基线**:整个生态约两周大(DSH 0.1.1-rc.2,08-21),头部条目也只有 0–104★。质量信号是 awesome 列表的收录门槛(「装得上、说什么做什么、有人维护」逐条对源码核过),不是星数。所以三档里的「直接用」意思是**试装成本低到随手试**(pin + 冒烟 + 夜间矩阵兜底),不是「久经考验」。

三档:**直接用**(技能进 `skills/community/`、bundle/MCP 加 patch 行)/ **映射成 capability**(别人的"整只 agent"写成 capability.yaml 委派)/ **吸收实质**(拆出底层库/方法进镜像或我们的技能,不接插件壳)。另有第四类:**借模式**(只学设计,不装)。

**进厂检验(全部机械,一次过;2026-08-24 对 rc.2 源码 + 社区实践核实)**:①技能目录摊平到一层(`<name>/SKILL.md` 或平铺 `<name>.md`,嵌套树不被发现),frontmatter 必填 kebab-case `name` + `description`,与现有四根不重名(两个调用控制键拼错会整技能被静默丢弃);②bundle 看 `package.json` 有无 `dsh.bundle`——只有 `dsh.client` 是装不上的;`dsh.plugin.json` 是市场元数据、非官方,忽略;③pin 精确版本/commit 进镜像,`--dump-config` 快照 + 启动冒烟;④描述对代码抽查一条(借 awesome 列表"描述必须属实"的收录标准)。rc 期已知安装缺陷(peerDeps 挂起 #4236、`plugin remove` 残留、dsh-tools 重复副本)只咬活装——托管面镜像烘焙免疫,本地面备 `dsh-fix-duplicate-loader-id`。更新策略:按需重钉,不自动跟新;community 根是精选不是镜像,目录规模用 §9.7 的 tokenMeter 观测。

## 一、排版与文档(manuscript-support P2 的主要红利池)

| 项目 | 一句话 | 档位 |
|---|---|---|
| `dream-num/dsh-univer-office`(104★,Apache-2.0,官方出品) | Univer 全家:表格/文档/演示 创建·编辑·预览·worktree review | 直接用(dev profile 先试;托管进镜像) |
| `Jesse-njx/dsh-cowork` | 有界、按单元格寻址的 `doc_read/doc_write`(xlsx/pdf/docx/pptx/ipynb),自带 MCP server | 直接用(MCP 形态与我们最合) |
| `didclawapp-ai/DSH-Office` / `kw78/dsh-office-tools` | Office 四件套工具(前者经 zagens-office CLI) | 直接用;CLI 依赖进镜像 |
| `maple-pwn/paperlab` | Overleaf 式 LaTeX 工作台:PDF 上圈注 → agent 改源码 + 编译检查 | 吸收实质(LaTeX 工具链进镜像 + 圈注→修订交互进 F 轨);本地面可整装 |
| `fly233338/dsh-overleaf` | OverleafMCP 连接用户的 Overleaf 项目 | 直接用(本地面/分析层连接器) |
| `STARDUSTLC666/dsh-cite` | DOI/Crossref 查证 + **GB/T 7714**/APA/MLA/Chicago + BibTeX | 直接用(技能/工具双形态,manuscript-support 核心件) |
| `863683348/dsh-plugin-academic-writing` | 论文大纲/标题摘要骨架/引文格式/语句 QA/投稿前检查 | 直接用(技能) |
| `863683348/dsh-plugin-translation` | 论文翻译 QA:分句、术语表、数字/单位/括号一致性 | 直接用(技能) |
| `xmutfyh/dsh-plugin-writing-guard` | 学术写作守卫(中英):去 AI 味、保护证据强度/引文/无效结果 | 直接用;与我们的泄漏禁词互补 |
| `Yu-tao-Li/dsh-reference-checker` | 参考文献真实性检查(.pdf/.bib/.tex) | 借模式(我们的 citationIntegrity 是门禁;它可做 §8.3 复查视角) |
| `HuanLinOTO/dsh-plugin-mineru`(41★) | 把 MinerU 解析暴露给模型 | 直接用/对照(§26 我们本来就选 MinerU,先看它的接法) |
| `zhtx2024/dsh-pdf` | pdf_info/extract/render,双引擎,**中文非嵌入字体**渲染 | 直接用 |
| `STARDUSTLC666/dsh-ppt` | 一句话/一份文档 → HTML 幻灯 + 可编辑 PPTX | 直接用(技能) |

## 二、作图(图表/示意图/流程图)

| 项目 | 一句话 | 档位 |
|---|---|---|
| `Fantasality/dsh-origin-plugin` | MCP 驱动 **OriginLab**:写数据、画线/散点/柱状、导 PNG/SVG | 直接用(**仅本地面**——用用户自己的 Origin;医学科研用户刚需) |
| `jean3690/dsh-drawio` | AI 驱动 drawio:校验/渲染 SVG·PNG/编辑/模板 + 侧栏画板 | 直接用(PRISMA 流程图等结构图) |
| `hanzhangzzz/dsh-diagram` | 会话内可编辑 Excalidraw | 直接用(轻量替代) |
| `tt-a1i/archify`(15.3k★) | 自校验的架构/流程/时序/生命周期交互图技能 | 试用评估(偏软件向,流程图可能可借) |
| `Harvey-Will/dsh-vision-analysis` 的 chart-data 模式 | **从已发表图表反提数据**(meta 分析提数刚需) | 借模式→P1 视觉通了再装 |
| `omdsh-dev/dsh-genui` / mermaid 渲染三家 | 回复内联图表/交互组件;Mermaid 卡片渲染 | 借模式(F 轨前端呈现) |
| 统计图本体 | 森林图等仍走我们的确定性引擎;通用作图走沙箱内 matplotlib(镜像已有) | 现状即可 |

## 三、审稿与评审

| 项目 | 一句话 | 档位 |
|---|---|---|
| `LeslieWylie/review-workflow` | N 评审员隔离子代理**盲评** + 主席合议的结构化评审流 | 映射成 capability / 借模式(P2 `evimed-review` 语义审查的现成结构;我们的 rubric 是护城河,它出「额外视角」) |
| `tetckx/deep-structural-analysis-skill` | 16 视角对抗式结构分析 + 置信度校准 | 直接用(技能,评审视角库) |
| `songoao25/dsh-contract-drafting-agent` | 11 阶段律师工作流:5 路并行评审 + 决策关卡 | 借模式(多路并行评审的编排样例) |

## 四、检索・文献・分析层

| 项目 | 一句话 | 档位 |
|---|---|---|
| `literaf/dsh-ai4scholar` | 38 个学术工具(S2/PubMed/Scholar/arXiv/bioRxiv/medRxiv、引文图谱) | 吸收实质(托管面出网必须走 publicSourceGateway;对照补我们 26 工具没有的引文图谱端点);本地面可整装 |
| `wade20250715/dsh-pubmed` | 作者调查/同名消歧/机构统计/师承匹配 | 吸收实质(文献计量能力的补充方法) |
| `Hongcheng-LI/dsh-zotero` · `Vncntvx/dsh-zotero` | Zotero 本地 API:检索库、读附件全文、证据段落、引文生成 | 直接用(本地面)+ 分析层连接器(§26 contract 的现成一员) |
| `PensiveFei/deep-read-summarize` / `xiehuan123/dsh-deepread` | 深读流水线(MapReduce 子代理、claim-evidence-data 报告、思维导图) | 借模式(§26 深读蒸馏的对照实现) |
| `JimchengChina/dsh-frontier-repro` | 多源信号聚类成版本化证据包 + claim 分级门 | 借模式(§24 验证分层的同类) |

## 五、数据分析・统计・生信

| 项目 | 一句话 | 档位 |
|---|---|---|
| `ZihaoVistonWang/Stata-AI-Skill` | 原生服务驱动 **Stata**(回归、do 文件) | 直接用(仅本地面,用用户自己的 Stata) |
| `omicverse/dsh-omicos` | OmicVerse 生信分析于持久 Python 内核 + 能力目录检索 | 试用评估(生信线;独立包形态装于运行时) |
| `poplarity/dsh-science-workbench` / `biociao/dsh-science`(26★) | 可复现科研工作台:agent 驱动单元、图表反馈重跑、产物溯源 | 借模式(与我们 notebook 内核 + 回执同题,对照吸收) |
| `hccccc01333/dsh-excel-chat` / `duyanta123/dsh-data-insight` | 对话式 Excel(公式体检)/ CSV→结论化报告 | 直接用(技能/工具) |
| `Chaos-Hyper/dsh-econ-tools` | 计量经济方法选择/数据准备/模型设定六工具 | 借模式(「方法选择器」形态参考) |

## 六、视觉・语音(对应 G1 图像缺口与 ASR 轨)

- `xiaoyuink/dsh-image-vision`:视觉/OCR/grounding/裁剪,**组织病理·细胞·解剖·临床域预设**——P1 视觉打通后的首装;本地面先行。
- `good-boy4069/dsh-vision-guard`、`liustack/modlens`(3.6k★)、auto-vision 系:纯文本模型的透明视觉桥——**借模式**,正是我们 G1 适配器要做的事。
- ASR:`haoku123/dsh-voice`(宿主侧 sherpa-onnx + SenseVoice,离线)、`tangzheng202202/dsh-voice-live`(火山流式)、`STARDUSTLC666/dsh-voice`(OpenAI 兼容 ASR)——`/internal/asr/v1` 的供应商与本地退路参考;浏览器 Web Speech 系可直接给本地面。

## 七、记忆・自演化・画像(验证我们 §19/§27 的同类实现,以借为主)

- `WODE25500/dsh-skillopt`(Microsoft SkillOpt-Sleep):夜间睡眠周期收割会话→挖重复任务→held-out 门后固化技能——与 §19.22 睡眠巩固/§ACE 回路同构,**对照实现**。
- `zhangyoufu-123/stylotrace`:从编辑对学习用户文风——§27.2 PRELUDE/CIPHER 路线的在野实现。
- `qkycir-123/dsh-run2skill`、`kouyichi/dsh-learn`:会话经验→技能草稿(用户批准制)——胶囊方法蒸馏同款。
- `Shiye-10Pages/dsh-memory-porter`:一键导入 Claude/ChatGPT 记忆——**胶囊冷启动导入**值得做成产品功能(§19 补一项)。

## 八、专科与产品线

- `dhicoc/dsh-wuyun-liuqi`:五运六气完整技能包(年运/客气推算)——tcm-cdss 线直接评估。
- `Mr-Neutr0n/dsh-medseek`:SOAP/H&P/SBAR 临床文书——美式文书,借结构参考。
- `Kenerlee/dsh-moments-aieo`:AIEO/GEO 交付方法技能(0-9 可见度诊断)——P3 `geo-content` 前先读其方法。
- `THU-MAIC/dsh-openmaic`:课堂/幻灯/苏格拉底教学——患教/培训线备查。

## 九、平台工程自用(让「随手装」更随手)

- 进厂检验自动化:`iiiweiii/dsh-guardwall`(装前源码审查+运行期高危拦截)、`taxueseek/dsh-plugin-guard`(静态审计+哈希锁)、`zoahdev/dsh-dep-audit`(peer 范围可解析性,#2763 类)、`ayahunter/dsh-plugin-clinic`(装后体检)——**用工具代替流程**,与「不设审批流」互补。
- `zhao1012/dsh-fix-duplicate-loader-id`(装机故障自修)、`Pasumao/dsh-plugin-dev-kb` + `PerryLink/dsh-plugin-guide`(离线官方文档技能,给我们写插座用)。
- 本地面(evimed-web)体验件:`dsh-market` / `dsh-find-plugin` / `Dariandai/dsh-starter-pack`(一键装我们钦定的社区包)。
- 技能搬运机制:`mjylfz/dsh-skill-mover`、`wmengxiang/dsh-any-skills`——印证 Claude/Codex 技能生态可整体搬入(Agent Skills 标准);我们 curated 管线同理。

## 十、preset 融合素材(§16 #22 四路径的对象)

- `hackerFish/awesome-dsh-presets`:实测可用 preset 合集(入口)。
- 整只映射成 capability 的样例:`sailoumili/novel-writer`(指挥家+5 专职子代理)、`Andiii208/dsh-ultramath` 与 `Crayonnan/dsh-math-modeling-skills`(五阶段带关卡)、`linxichen/dsh-rigorquant`(无人值守围栏式多代理研究)、`songoao25/dsh-virtual-product-team`。
- 抄行/抄 persona:`kaijia323/dsh-preset-router-*`(任务感知行为带)、`duyanta123/dsh-preset-scaffold`(五阶段 init runbook)、`hatsuyuki0103/oh-my-deepseek-harness` 的 **deep-interview**(§27 冷启动访谈的现成问法)。

## 十一、复审另一份「插件接入方案」后的可借项(2026-08-26)

那份方案答对了三件事(能并行、能共存、能协同),但把整个产品设计成跑在一个 DSH 进程里;它的三种协同模式与五个社区插件用法有六处撞上核实事实或已锁定决策(裁决见 spec §21.8 末段补充)。核实过的事实:并行工具调用真(`isConcurrencySafe` 是工具定义的宿主侧调度元数据);Cordis 五种分发真;`dsh-agent-teams`(1026★)/`dsh-at-file`(475★)/`dsh-memory-evolve`(249★)存在;`dsh-record-replay` 真身是 macOS 桌面操作演示录制;`dsh-sandbox` 作为隔离环境插件不存在;ModLens 以技能+工具形态存在、未核到服务键。**可借的只有下面这些**,其余我们已有或已裁定不用。

| # | 借什么 | 来源 | 落点 | 阶段 |
|---|---|---|---|---|
| 1 | 空闲成员自动认领就绪任务;**重派前先撤销陈旧尝试**;冷恢复重试悬空尝试 | dsh-agent-teams | `evimed_screen_batch` 的认领/撤销语义(防双写);§9.5 第 4 步自动重派前加撤销;冷恢复对应 `state.json` 续跑 | P1(screen_batch 上线时) |
| 2 | 持久成员 = continuable 子代理被唤醒做后续回合 | dsh-agent-teams | 已推迟的「delegate 异步 / continuable」设计的参考实现;preset 已 `backgroundMode: continuable` | P1 设计输入 |
| 3 | 成员间持久邮箱(不经队长) | dsh-agent-teams | 委派子代理之间的有界消息(如 research-brief 向其依赖的报告子代理追问);形态为工作区 `.evimed-run/mail/` 文件 + 一个 run-policy 工具,不加缝 | P2,与 #2 一起设计 |
| 4 | 活动面板:交互式任务 DAG,归档保留成员与任务全史 | dsh-agent-teams | §18/§23 运行树加 `task-plan.json` 的 DAG 视图 | F 轨 |
| 5 | 「粘贴即视觉」两条语义:图像落为工作区私有文件、路径进上下文、视觉工具**按需**解析(不贴图即转写);医学域预设(组织病理/临床) | ModLens;xiaoyuink/dsh-image-vision | G1 图像适配器;视觉工具经网关出网 | P1 视觉打通 |
| 6 | 记忆按上下文作用域标记生效范围(它按 git 分支;我们按项目阶段 / 数据集版本) | dsh-memory-evolve | 胶囊事实的 scope 标签(§19.4)。**不借**它的写前确认——v3.5 已删事前确认,UX 优先 | P2 |
| 7 | 跨线业务事件词汇表(patient/enrolled、recruitment/match-completed…) | 方案本身 | 落在**控制面**:`@evimed/domain` 的 `eventType` 枚举(命名规则 21,`kind` 保留),供 §25 通知与 §24 队列使用;患者管理 / 招募线立项时定 | 立项时 |
| 8 | 「接口-实现-消费者」分离 = 我们「小改」档的定义:换 provider 不换 consumer | 方案本身 + DSH 自身分层(skills、web 缝);社区已有 Metaso 作为 web 缝 provider 的先例 | spec §21.8 补充②;适配社区包时先看它是否是某个 DSH 服务的 provider | 即刻生效 |

**明确不借(已裁)**:Cordis 事件总线当中台消息队列(进程内、单容器、随容器消失;平台总线是控制面);dsh-agent-teams 当编排器(与 evimed_plan/delegate 双编排,绕开契约);第三方服务 `inject`(硬依赖、缺失静默不 apply、宿主作用域跨会话共享——#27 同类);dsh-routing-suite(§16 #7 已取消输入路由);dsh-memory-evolve 当记忆底座(单机本地文件,§19 定案 MemOS);dsh-record-replay(名实不符,审计链在控制面账本)。dsh-agent-teams / at-file / memory-evolve 三者**本地面**个人使用不受影响。

## 首批动作建议(一个下午的量)

1. 建 `skills/community/` 根(customSkillDirs 追加一行,§9.2 已改),首批放技能形态五件:`dsh-cite`、`academic-writing`、`translation`、`writing-guard`、`dsh-ppt`;各记来源 URL + commit。
2. dev profile 试装工具形态四件:`univer-office`、`cowork`、`mineru` 插件、`drawio`;跑各自冒烟,能用的进镜像 pin。
3. 本地面(evimed-web)组一个「科研者桌面」推荐组:Origin + Stata + Zotero + Overleaf + dsh-market + UI 组(执行细则与候选表:`2026-09-01-frontend-ecosystem-adoption-plan.md`)——**连接用户自己已有的桌面工具,是托管 SaaS 给不了、我们本地 profile 白捡的差异化**。
4. 借模式四件落到对应章节的待办:review-workflow → §8.3;vision-guard → G1 适配器;memory-porter → §19 胶囊导入;SkillOpt-Sleep/stylotrace → §19.22/§27.2 对照。

## 十二、2026-09-15 复扫裁决（对着 0.1.5-rc.2 与今天的代码核实）

生态规模已到 GitHub `dsh-plugin` topic 14,897 仓库。下面每条都对着实物核过：`deploy/runtime-dsh/dump-config.baseline.json`、`seam-manifest.json`、`publicSourceGateway.mjs`、`runtimeManager.mjs`、`try-install.json`，以及从 npm 拉下来的 rc.2 包（`@deepseek-ai/dsh-web`、`dsh-client-ui-sidebar-right`）。

**先纠正扫描稿里五个前提**：

1. **`ctx.web` 缝在我们跑的内核里已经挂着**：baseline 有 `web`（`@deepseek-ai/dsh-web`，`searchProvider: deepseek-official` / `fetchProvider: http`）、`web-search-deepseek`（要容器里的 `DEEPSEEK_API_KEY`，我们不给）、`web-fetch-http`（已禁）、`tool-web`（已禁）。rc.2 的 `WebRuntime` 暴露 `registerSearchProvider` / `registerFetchProvider`，provider 形状是 `{ id, available(), search|fetch(request, signal) }`。缺的只是我们没注册 provider、`seam-manifest.json` 没列 `web`。
2. **但它解锁不了"整个第二节"**：核过的候选里 `dsh-plugin-mineru`、`dsh-pubmed`、`dsh-free-search` 都是自己 `fetch`，不是 `ctx.web` 的消费者；没有一个我们想要的插件被证实走 `ctx.web`。这条缝的现实价值是「让 `tool-web` 可以按我们的网关挂载」与「未来出现 `ctx.web` 消费者时零成本」，不是今天的杠杆。
3. **`dsh-plugin-mineru` 不是"连自家服务不需要出网"**：生产运行时走 unix socket 桥，容器没有到 `evimed-document-parser` 的网络路径；插件的 `baseURL` 必须指向控制面新开的网关，且它要容器里有 `apiKeyEnv`，而运行时不持任何密钥。成本与 `dsh-cite` 同级（换传输），还要多一个网关。而且它 0.3.1 peer 上 `react` 与 `dsh-client-ui-*`，带客户端半边。
4. **`dataset-research-scoping` 已有确定性画像步骤**：`scripts/profile_dataset.py` → `data-profile.json/.md`，支持 xlsx（openpyxl）。`dsh-data-quality` 只读 csv/tsv/json/jsonl，画像一半与我们重叠，独有的是 `verifyCitations`（正文数字 ↔ 数据快照，带容差，四值裁定）。
5. **内核 UI 插件对我们的用户是可见的**：2026-09-15 起会话页就是内核 iframe（`SessionRoute` 只渲染 `RuntimeUiFrame`），插座已通过 `dsh.client` 注入客户端模块。所以"UI 插件 ≠ 我们的前端"不再成立；成立的约束换成：任何加 `webServer` 路由的插件要过运行时 UI 代理与方法拒绝名单。`APPLY_PATH_PLUGIN_IDS` 只约束**按项目可配置**的插件；固定配置烘进镜像的 bundle 不经过它。

**核实为真的两条**：`plugin-support.json` 的 `kernel` 仍是 `0.1.2-rc.1`，两条 `incompatible` 是对着它判的，该重测；`ctx.sidebarRight` / `ctx.sidebarRightTabs` / `openResource` / `sidebar.right.pane.tab` 在 rc.2 的 `dsh-client-ui-sidebar-right` 里都在（31 / 3 / 13 / 24 处）。

### 裁决表

| 项目 | 核实 | 档位 | 理由 |
|---|---|---|---|
| **`@changfenhuang/dsh-annotation` 1.4.10** | bundle + client；批注以文本前置进用户消息；Node 半边为空 | **试装**（已进 `try-install.json`） | 稿件评审的现成交互，零出网、零门禁；风险是 peer 写的是裸 `cordis` 而非 `@deepseek-ai/cordis`，试装即知 |
| **`dsh-mermaid` 0.4.0** | 纯客户端渲染，无 peer，无出网 | **试装**（已进 `try-install.json`） | PRISMA 流程图等在回复里直接成图；数字仍须来自筛选台账 |
| **`dsh-data-quality` 0.3.10** | 零网络、进程内 TS、peer 明确覆盖 rc.2、Apache-2.0；发布 `ctx.dataQuality` 服务 + 4 工具 | **试装**（已进 `try-install.json`）+ **借契约** | 装的目的是量 `data_verify` 在真实数据集画像上的表现；`verifyCitations` 的四值契约不论装不装都写进 `dataset-scoping-package` 的 notice（原则 10c 的一个可执行形状）。我们**不** `inject` 它的服务 |
| `@alger-ai/dsh-image-preview` | npm 404，未发布 | 不装 | 不能 pin 的东西不进镜像 |
| `dsh-plugin-mineru` 0.3.1 | 自 fetch；要 baseURL + 容器内 key；带客户端半边 | 不装 → **改自家 MCP** | 运行中拉到的 PDF 今天走 `pypdf`（`open_access_fulltext.py`）；正确形状是给 `/internal/sources/v1` 加一个「经 MinerU 解析」模式、`open_access_full_text` 多一个参数，不新增 5 个工具 |
| `dsh-pubmed`（aiyacharley） | 自 fetch；25 工具；写 `~/.dsh/dsh-pubmed-graph.json` 与 `~/.dsh/skills/`（我们的 profile 只读） | 不装 → **吸收实质** | PubTator3 实体归一 + 关系证据链是真缺口：网关白名单加 `www.ncbi.nlm.nih.gov`，`term_normalize` / `literature_search` 加 PubTator3 标注，一两个工具而不是 25 个 |
| `dsh-free-search` | 自 fetch DuckDuckGo；实现官方 `WebSearchProvider` 接口 | 不装 → **抄形状** | 我们有 SearXNG 网关；它的 provider 对象是写 `evimed-gateway` provider 的样板 |
| `dsh-genui` | host + client；`dsh-ui` fence；30+ 组件；表达式不 eval；host 有 HTTP 路由 | **暂缓** | 与原则 10c 冲突：fence 里的数据是模型手打的数字；等「正文无手打数字」落地后再考虑，且只接受绑定到产物文件的渲染 |
| `DSH-better-sidebar` | host 带 node-pty 真终端 + git 操作 | 不装 → **借 API 用法** | 托管多租户里给用户一个进容器的终端绕开运行账本；原生右栏 API 的用法（`sidebarRightTabs` 注册 tab、`openResource` 开文件）直接用于我们的外壳 |
| `dsh-context` | 读 `contextBreakdown`，展示系统提示与工具 schema 构成 | 不装（本地 profile 可用） | 对租户暴露组合本身；运维诊断放控制面运维台 |
| `dsh-permission-rules` / `dsh-auto-review` | `tools/pre-execute` 上的 YAML 规则引擎 / 第二模型审批 | 不装 | 原则 4、13、20：工具面由组合决定，approval=never；第二模型审批是明确不做的 |
| `dsh-research-report` · `citeguard` · `dsh-deepread` · `zotero-harvest` · `papermachine` | — | **只读** | 证据账本的篡改可见性；SSRF 的 DNS 应答校验（我们 `redirect: "error"` 已比逐跳校验严，缺的是解析后地址核验，只影响 open-access-pdf 出版商主机那条路）；claim 四分法；充分性审计循环（写进 `clinical-evidence-synthesis` SKILL.md，不加门禁）；产物溯源 |
| `dsh-reference-checker` | 单工具，产出按样式更正的引用 | 不装 | `dsh-cite` 已装且有 `cite_check` / `cite_format`；先用一条 eval 看它是否已覆盖「整份 .bib 批量更正」 |
| 记忆类 · 编排类 · 成本面板 · 视觉类 · 市场类 | — | 不装 | 记忆一个端口（§19）；编排已裁（十一）；计量在控制面；视觉是 G1 轨道；市场只属本地 profile |
| `dsh-routing-suite` | — | 不装 | 根 `CLAUDE.md` 2026-09-15 裁决 |

### 待办（按杠杆排序）

1. **重测 peer dep 墙**：在 rc.2 镜像上跑 `pnpm try:community-bundles`（要 Docker，本机没有，在生产宿主的隔离目录或 CI 跑），候选 = 原四条 + 上表三条试装；把 `plugin-support.json` / `try-install.json` 的 `kernel` 与 `lastCompatibilityTest` 换成 rc.2 的结果。
2. **PubTator3 进网关与 MCP**（吸收 `dsh-pubmed` 实质）：白名单一行 + `term_normalize` 的 PubTator3 标注 + `literature_search` 的关系式检索；配三条真实题面 eval。
3. **运行中 PDF 走 MinerU**：先量——统计近 30 天运行里 `open_access_full_text` 拉回的 PDF 有多少是 CJK / 表格密集（`pypdf` 的失败面）；有分布再给 sources 网关加解析模式。
4. **`verifyCitations` 契约进 `dataset-scoping-package`**：notice 级，正文数字必须在 `data-profile.json` 有出处（原则 10c）。不等试装结果，这条与装不装无关。
5. **`ctx.web` 缝**：`seam-manifest.json` 加 `web`（optional），port 导出 `registerWebSearchProvider` / `registerWebFetchProvider`，插座新加 `evimed-web` 行注册 `evimed-gateway` provider（search → `/internal/search/v1`，fetch → `/internal/sources/v1`，非白名单主机返回 `WebError`），patch 把 `web.config` 两个 provider 指向它。**不挂 `tool-web`**（MCP 已有 `web_search` / `official_page_fetch`，挂了是同一活两个工具）。排在 1–4 之后，因为今天没有它的消费者。
6. **外壳右栏改用原生 API**：`runtimeUiShell.mjs` 里凡是要往右栏放的内容，走 `ctx.sidebarRightTabs` 注册 tab、`ctx.sidebarRight.openResource` 开文件，不占 `rightbar` slot 整列。
7. **open-access-pdf 路径加 DNS 应答核验**（借 `citeguard`）：`assertPublicHostname` 只看主机名字符串，解析结果落在私网时仍会发请求；解析后再核一次地址，配阴性对照。
8. **充分性审计写进 SKILL.md**（借 `zotero-harvest`）：子主题覆盖 → 缺口 → 下一轮检索式，作为 `clinical-evidence-synthesis` 检索阶段的指导文字；不加 notice、不加门禁。
9. **社区插件静态扫描进 `try:community-bundles` 报告**：装前跑一遍源码扫描（`dshscan` 类）并把结果写进 `try-install.json` 的 results；是工具不是流程，不设审批。
10. **试装通过后的三件真会话验证**（原则 11）：annotation 在一次稿件评审里批注 5 处；mermaid 渲染一次 PRISMA；data-quality 对一份真实院内表跑 `data_verify`；各对照关掉插件的同一会话。

### 执行结果（2026-09-15，同日）

十条待办的执行记录。每条都注明是**做了**、**做了但结论是不做**，还是**没做以及卡在哪**。

**1. 重测 peer dep 墙 — 做了。** 在生产宿主的隔离目录（`/tmp/try-bundles`，不碰任何 release 目录）用 rc.2 镜像 `open-science-runtime:dsh-0.1.5-rc.2-uv-0.11.26-39111b6b4821` 跑了七条候选，结果与源码扫描一起回写 `try-install.json`：

| 候选 | 结果 | 扫描 |
|---|---|---|
| `dsh-cite@0.3.2` | **BOOTED** | 10 文件、零 fetch、MIT、无 deps 无 peer |
| `@changfenhuang/dsh-annotation@1.4.10` | **BOOTED** | 4 文件、零出网、MIT、`peers=cordis` |
| `dsh-mermaid@0.4.0` | **BOOTED** | 4 文件、`net=1 proc=1 fsWrite=1 httpRoute=2`、`installScripts=prepare` |
| `dsh-data-quality@0.3.10` | **BOOTED** | 67 文件、零网络、Apache-2.0、peer 明确列 `@deepseek-ai/*` |
| `dsh-plugin-academic-writing@0.2.0` | 装不上 | — |
| `dsh-plugin-translation@0.2.0` | 装不上 | — |
| `dsh-plugin-writing-guard@2.0.1` | 装不上 | — |

**4/7 启动。** 两条值得单独说：

- **annotation 的预判风险没有兑现。** 裁决表写它「peer 是裸 `cordis` 而非 `@deepseek-ai/cordis`，与 2026-09-06 两次拒绝同型」。在 rc.2 上它装上了也启动了。预判是对的形状、错的结论——这正是「试装即知」的意思。
- **原四条里那三条仍然装不上，但原因换了。** academic-writing 与 translation 这次报的是 `@deepseek-ai/dsh-fs` 的版本不在其 peer 范围内（此前记的是笼统的「peer 不接受当前 DSH 包」）；writing-guard 仍卡在 `pnpm approve-builds`，即它的依赖要跑构建脚本，与 rc.2 无关。

**9. 静态扫描 — 做了，并且当场证明了它的用处。** 扫描是装前读 pnpm 真正落盘的那棵树：多少文件出网、起进程、写文件、eval 字符串、读环境、挂 HTTP 路由，加上 `package.json` 声明的安装脚本、`dsh.bundle`/`dsh.client`、license、deps 与 peers。结果进 `try-install.json` 的 `lastCompatibilityTest.scan`。

它对 `dsh-mermaid` 报出的四项与裁决表的「纯客户端渲染、无出网」表面矛盾，所以逐条核了：

- `net=1`、`fsWrite=1`、`httpRoute=2` 全部落在同一个文件 `lib/mermaid-runtime.js`——Mermaid + KaTeX 的压缩产物。命中的是压缩代码里的巧合子串（`.listen(`、`writeFile`），唯一像真的那一处是 Mermaid 自己格式化「请求失败」错误信息的模板。这个文件跑在**浏览器**里。
- `proc=1` 是 `bin/dsh-mermaid.mjs` 里的 `import { spawnSync } from 'node:child_process'`——包自带的**命令行工具**，不是插件。插件的宿主半边是 `lib/index.js`，它的 `dsh.bundle.patch` 只插入一行 `ui-mermaid`。
- `installScripts=prepare` 是 `prepare: npm run build`，而 `files` 只发布 `bin`、`lib`、`cordis.patch.yml` 与文档，`scripts/` 和 `src/` 根本不在包里——所以从 npm tarball 装时 `prepare` 无从运行。实测也确实没有触发 approve-builds（writing-guard 触发了）。

**结论：裁决表对 mermaid 的描述成立**，扫描提了正确的问题，答案记在这里。这就是「是工具不是审批」的样子。

**2. PubTator3 进网关与 MCP — 做了。** 网关白名单加 `www.ncbi.nlm.nih.gov`，并新增一层 `apiPathPrefixes`：这台主机只放行 `/research/pubtator3-api/`、只放行 GET。（`officialDocumentPaths` 表达不了这件事，它还强制 `text/html`，而 PubTator3 返回 JSON。）MCP 侧只动两个已有工具、不新增工具：`term_normalize` 加 `annotate`（**默认关**——这个工具本来确定性且离线，默认开等于给每次调用挂一次 NCBI 往返），`literature_search` 加 `relation`，走 PubTator3 自己的 `relations:<type>|<e1>|<e2>` 查询语言。

实测到一件必须说明的事：`relations:...|A|B AND <words>` 返回 0 而不是收窄，所以自由文本**不能**随行。结果里明写「检索只按关系寻址，你的问题文本没有被发送」，否则一次关系检索会被当成被自己的措辞筛过的结果读。

三条题面进新 pack `evals/relation-retrieval/`，概念 id 与计数都是 2026-09-15 实测：metformin–treat–Neoplasms 2277 篇、pembrolizumab–cause–Myocarditis 95 篇、Clopidogrel–drug_interact–ANY **4 篇**。第三条是阴性对照：氯吡格雷与质子泵抑制剂的相互作用是心内科文献最充分的药动学相互作用之一，PubTator3 只记了 4 条，所以那是**索引稀疏**，不是证据不存在，也不是工具故障。

**3. 运行中 PDF 走 MinerU — 量了，结论是不做。** 生产数据卷里 170 份 transcript，`open_access_full_text` 出现 **0 次**；保全下来的原文是 38 个 `.md`、9 个 `.txt`、8 个 `.xml`、6 个 `.json`，**0 个 `.pdf`**（唯一的 PDF 全是我们自己生成的交付物）。全文是按 PMC 的 XML/Markdown 取回来的，`pypdf` 那条路不在热路径上。按第 3 条自己的写法——有分布再加——**不给 sources 网关加解析模式**。

一个过程纠正：run ledger **不记录工具名**，只记运行级状态。所以「ledger 里零命中」不能当证据，上面的数来自 transcript。

**4. `verifyCitations` 契约进 `dataset-scoping-package` — 做了。** 新模块 `packages/domain/src/datasetScopingContract.mjs`，四值裁定 `verified` / `mismatched` / `unsupported` / `unverifiable`，全部 advisory。四值里最要紧的是 `mismatched` 与 `unsupported` 不合并：前者要改数，后者要补出处，只说「没找到」会让运行自己去重推是哪一种。容差按正文写的小数位取整匹配，百分数与比例互认（18.3% ↔ 0.1834）。不读围栏代码块、ISO 日期、裸年份、有序列表序号，以及嵌在词里的数字——`HbA1c` 的那个 `1` 是第一版实测踩到的误报。

**5. `ctx.web` 缝 — 做了，并在真机上验过。** `seam-manifest.json` 的 `services.optional` 加 `web`；port 导出 `registerWebSearchProvider` / `registerWebFetchProvider`（注册前校验 provider 形状，因为注册时抛异常会在启动阶段带垮整个组合）；新插件 `packages/socket/plugins/web.mjs` 注册 `evimed-gateway`，search 走 `/internal/search/v1`、fetch 走 `/internal/sources/v1`，白名单仍留在网关不复制一份；`cordis.patch.yml` 插入该行并把 `web.config` 两个 provider 指向它。**不挂 `tool-web`**，`web-fetch-http` 仍 disabled。

价值说清楚：今天没有 `ctx.web` 的消费者，所以这条缝换来的是两件事——`web` 行从「靠缺席保护」变成「靠配置保护」（缺席离回来只有一次编辑），以及将来出现消费者时零成本。

真机验证：在生产宿主用 `Dockerfile.delta` 构建，build-smoke 通过（profile 启动、每一行 applied、挂起一个 `evimed-universal` 会话）；再用真实网关地址跑一次，`inject:['web']` 解析成功、无 degrade、无错误。dump-config 的实际 diff 只有预期两处，把镜像里的 dump 取回来与提交的副本逐字节比对后更新 `BASELINE_PROVENANCE` 的 sha256。

顺带修了 delta 的一个真缺口：它拿**基础镜像里冻结的**基线做 diff，而不是正在构建的源码里的那份——任何有意改动组合的 delta 都会被它报成漂移。

**6. 外壳右栏改原生 API — 做了。** port 导出 `registerRightSidebarTab` / `openRightSidebarResource`，`seam-manifest.json` 的 `browser` 块记下右栏的服务名、tab slot 与方法；外壳测试断言 `rightbar` **不被占用**——占它等于换掉整列，正是左列要花三条 CSS 才撤回来的那件事。

顺带修掉 2026-09-15 上线时留下的实际损伤：两个拖拽手柄同类名，一条按类名隐藏把右栏的 resize 一起关了。真机量出它们按位置可分（frame 的子元素是三列 + overlayLayer + 手柄，侧栏手柄紧跟 overlayLayer），改成 `[class$="_overlayLayer"] + [class$="_handle"]`。右栏开时第二个手柄回到 8px `col-resize`，右栏关时 DOM 里只有一个手柄且仍隐藏——两种状态都在生产页面上注入 CSS 实测过。也顺便纠正当时的判断：「两个手柄无法区分」是错的，右栏关着时 DOM 里根本只有一个。

**7. open-access-pdf 加 DNS 应答核验 — 做了。** `assertPublicHostname` 只读名字；新增 `assertPublicAddresses` 读解析结果，IPv4 与 IPv6 都核（含 `::ffff:` 映射、`fc00::/7`、`fe80::/10`、`ff00::/8`），要求**每一个**返回地址都是公网——一个名字回一个公网地址加一个私网地址是这类攻击的常见形状，而连哪个不由我们决定。解析失败按上游不可达处理，不按拒绝。阴性对照四例（回环、一公一私、映射到 169.254.169.254、ULA）全部不建连，第五个公网主机取回 PDF。

剩下的重绑定窗口写在注释里没有关：关它要把 socket 钉到已核地址，需要一个本部署的 fetch 不暴露的 agent。说出来比暗示已经关上好。

**8. 充分性审计进 SKILL.md — 做了。** `clinical-evidence-synthesis` 的检索阶段加一节：覆盖 / 缺口（「搜了没有」「还没搜」「该答的源不可用」三分）/ 下一轮检索式，每轮一次而不是最后一次。它的价值是把「可以停了」变成别人能核的陈述。顺带一句把关系式检索指给「缺口是两个具名事物之间的关系」的情形。不加 notice、不加门禁。

**10. 三件真会话验证 — 没做，卡在一次完整镜像重建。** 三条候选试装都过了，但真会话验证要先把它们按精确版本写进 `deploy/runtime-dsh/Dockerfile`。那是新增 npm 依赖，**不符合 delta 的准入条件**（delta 明写：改了 lockfile、加了依赖、动了 kernel pin 的都要走完整 Dockerfile），而完整构建在生产宿主上是小时级，之后还要部署再跑 6 次会话（三件各一次开、一次关）。这一步是往生产镜像里装三个社区 bundle，值得单独一次有人看着的发布，不适合夹在这一轮里。

前置条件已经清完：试装结果在、扫描结果在、mermaid 的四项疑问已逐条核过。下一步就是一次 Dockerfile 编辑加一次完整构建。
