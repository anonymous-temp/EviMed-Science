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
