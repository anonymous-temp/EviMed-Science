# EviMed Science：分级审查与就地修复的通用方案（v1.2，2026-09-24，已实施）

状态：**v1.2，已实施并上线**（`evimed-52b3a10ead0b-1`，2026-09-24）。v1.2 按你 09-24 对第 13 节的决定做完并在生产验证：Jev 上 L1、不换 pro、研究类型在计划阶段声明后挂 CONSORT 2025 / TRIPOD+AI，结果见第 16 节。v1.1 上线于 `evimed-ee8759017e4c-1`（2026-09-23，就绪 26/26，按用户路径验收，见 15.5）。v1.0（2026-09-22 定稿，未改代码）回答的问题是：「平台跑一遍、再由我复核完善，交付质量就不错；平台单跑出来还是大量问题——是不是要 agent 套 agent 才能直接交付？这套东西是所有内容都要过一遍吗？问个"你好"、做个数据分析也这么复查吗？」

v1.1 做了四件事：

1. 把 v1.0 的每条断言对着代码（`main@2babd4816`）、DashScope 的线上线路和生产账本核了一遍，与事实不符的改掉，逐条列在第 15.1 节；
2. 按核对后的方案把 WP1–WP8 做完，实施中的取舍在第 15.2 节，改动清单在第 15.3 节；
3. 用 `evals/tiered-review/` 把审查者放到真实线路上跑，修掉它暴露的三个缺陷（第 15.4 节）；
4. 上线到生产，拿真实交付物和真实回答走用户那条路径验证。线上又暴露十一个缺陷，其中最重的一个是运行时从来没有请求过审查。全部修掉，逐条列在第 15.5 节。

依据：v1.0 的四类——代码、生产实测、七轮联网调研（第 14 节）、Jev 本地实测。v1.1 另加四类：

- 2026-09-23 对 DashScope 的线上探测，以及录下来的线路帧（`packages/contracts/dashscope/fixtures/`）；
- 生产账本 09-17 至 09-22 的门禁通知分布；
- 本地 324 份报告上的回放；
- 评测结果文件（`evals/tiered-review/results/`）。

还需要你拍板的四件事在第 13 节，都不妨碍已经上线的部分。

## 0. 一页结论

**为什么第二遍有效。** 不是因为"多套了一层 agent"。第二遍之所以有效，是因为它带进来四样第一遍没有的东西：

- 换了一个不同家族、不弱于生成者的模型；
- 换了干净的上下文；
- 用确定性工具把每一条引用、引文、数字全量核了一遍；
- 发现的缺陷带位置，然后直接改。

文献把这四样各自单独量化过（第 1 节）。v1.0 写方案时，平台的审查者只有其中一样半：新上下文有了，工具是检索式抽样；模型和生成者是同一个；发现只是建议，冻结后又改不了。它自己的数据：29 次交付 129 条发现，3 条是真的；同一输入 temperature 0 跑五次，得到 6/4/4/3/4 条，每次都不一样。v1.1 之后，四样都有了。

**是不是所有内容都要过一遍。** 不是"都复核"，是"都过同一个分级器"。分级器只看可判定的属性：有没有产物、产物是什么契约、回复里有没有引用标记、有没有命中药物词表；它不看语言。

- **L0**：问候和普通问答，什么都不做，零延迟零成本。这是文献的默认（VeriScore：很多句子根本不含可核验论断；FLARE：对不需要的回复强行核验反而降准确率），也是开发原则 12。
- **L1**：带引用或涉药的回答。回复照常先出，约 15–40 秒后在回复下方异步出一行 ✓/⚠，不拦不改。
- **L2 / L3**：文件交付物。L2 是文本类，L3 是数据与计算类。全量确定性核验、一遍编辑者、一轮就地修。
- **安全叠加**：临床类契约与涉药回复，在所在的级上再加药师安全项。

**审查者。** Qwen3.8-Max（钉快照 `qwen3.8-max-0902`），跨家族审 DeepSeek 的稿，由控制面调用。

- 运行时容器照旧不持任何 key，用量记在账本 purpose `review` 下。
- 它拿到的是"论断 + 它引的证据 + 适用规则"，不是运行的推理过程。
- 它输出的是"位置 + 缺陷类别 + 原文 + 改法"，不写文件。
- 写永远单线程，生成者自己改。Cognition 2026-04 的结论是：多 agent 只在"写单线程、其余 agent 贡献智能而不贡献动作"时有效。

**永不扣发，而且新检查先只做建议。** 2026-09-17 的裁决不变。v1.0 把"引文逐字、引用解析、编号一致、数字溯源、重跑一致"定为必修；v1.1 把本方案新增的每一项检查都改为以建议上线。这是原则 4：一项检查先以通知上线，读到真实分布才可能升为必修。

- 代码里，`reviewSeverity` 只对"已提升"的可判定类别给 `required`，今天的提升名单是空的。
- 这样定的依据是数据：生产上 4 次运行里，`claim-numeric-support` 一项就发了 102 条通知。不读分布就设必修，等于回到 09-17 之前。
- 修不完的按 ✓/⚠ 展示给读者。

**审查补不了的两样。** 漏了地标试验、选错统计方法，是生成侧的问题。BLADE：模型选对概念变量的覆盖率不到 13%；那次综述里平台没写 TIM-HF2，审查者不可能替它补上。这两样靠生成侧解决，不靠再加一层审查：

- 地标追溯已写进证据类 SKILL，并新增 `reference_list` 工具，从 Europe PMC 取一篇文献的参考文献与被引；
- 方法先验已写进四个引擎能力的 SKILL；
- 写作阶段换 pro 需要四处工程改动，留给你决定（第 13 节）。

裁决表：

| 决定 | 结论 |
|---|---|
| agent 套 agent / 审查者再套审查者 | **不做**。等预算下单 agent 打败五种多 agent 拓扑；有验证者的系统照样失败（MAST） |
| 同模型自审（flash 审 flash） | **已停用**。DSH 子代理审查者退役，`evimed_review_run` 改走控制面审查者 |
| 审查者 | **Qwen3.8-Max**（钉 `qwen3.8-max-0902`），控制面调用，DashScope 运营方 key |
| 审查者能不能改文件 | **不能**。只出定位式发现；生成者修，或回"不改 + 理由" |
| 哪些发现是"必修" | **v1.1：暂无**。新检查全部先做建议；可判定类别（引用解析、数字溯源、统计一致）按账本里的真实分布逐类提升 |
| 闲聊和普通问答 | **零处理**（L0） |
| 带引用/涉药的回答 | 异步 ✓/⚠：不延迟回复、不改回复，约 15–40 s 后出现在回复下方 |
| 数据分析类产物 | **v1.1：不重跑引擎**。正文数字对照作业输出逐个溯源，设计清单逐项定位；方法评价只做建议 |
| 覆盖缺口（漏地标试验） | 生成侧：地标追溯写进 SKILL，加 `reference_list` 工具；写作阶段换 pro 待你决定 |
| 上线前实验 | 不设计新对照实验；`evals/tiered-review/` 是回归线，误报率从账本读 |

## 1. 为什么第二遍有效：四要素与证据

| 要素 | 证据（打开过的原文） | v1.0 时的平台 | v1.1 |
|---|---|---|---|
| 审查者 ≠ 生成者，且不弱于生成者 | 同模型自审召回 0.85，但准确率零增益，误驳 35% 的正确答案；跨家族中档审查者 52%→64%、零损伤（arXiv 2609.04270）。方向不对称：Claude 审 Codex +18 个百分点，Codex 审 Claude −8.6（2607.21656）。同模型自检降准确率：GPT-4 GSM8K 95.5→89.0（ICLR 2024） | ✗ 同一内核模型 | ✓ Qwen3.8-Max 审 DeepSeek |
| 新上下文 | 新会话审查 F1 28.6% vs 同会话 24.6%，同会话再审一次 21.7%——重复无效、隔离有效（Cross-Context Review, 2603.12123）。Cognition 2026-04：审查 agent 与编码 agent"事先不共享任何上下文"时最好。错误标成"别人的"能修，标成"自己的"就看不见：盲点 64.5%（Self-Correction Bench） | ✓ 子代理新上下文 | ✓ 控制面单次调用，只见交付包 |
| 确定性、全量的工具 | 裁判与人一致率 65%→90%，只靠"能打开、定位产物"（Agent-as-a-Judge）；工具化核验把不可解析引用 16.0%→0.6%（2604.03173）；显式 Claim Verifier 0/337 引用幻觉、数字溯源 98.1%（ScientistOne）；判断式验证器在同一文本上 3%→18% 摇摆，彼此一致性 0.27–0.30（2607.20527）。statcheck 类确定性检查灵敏度 85–100%、特异度 96–100%，通用 AI 52% | ~ 检索工具、抽 40 条 | ✓ 每条参考文献双源解析、每个结论数字溯源、每处统计量核对 |
| 定位式发现 + 就地修 + 授权打通 | 模型找不到错，但告诉它位置就能修（Tyen, ACL 2024）；修复成功 43%（有力审查者）vs 15%（自审）。审查者精度 0.861，但建议采纳率 33.6%、最终通过率反降——**发现必须耦合进生成者的循环**（2607.15388）。最小编辑保留原文 90–95 分，重写式只剩 6–48（RARR） | ✗ 只是建议；冻结后授权铸不出来（09-20） | ✓ 发现回到同一回合的提交信封，逐条回应入账本 |

同一张表里也看得出"审查补不了的"：那次综述平台交付 57 条参考文献，11 条 must-fix 全是保存台账的簿记；真正的缺陷——缺地标 RCT、缺中国政策文件、一个日期错——审查者一条没抓。最后交的 146 条文献，大半是**用更强的模型拿它的草稿当素材重新写**。那部分等价于换生成者，不是任何审查架构能给的。

## 2. 分级器：什么内容走哪一级

分级由代码在两个时刻决定：回合结束时（对话回复），和 `evimed_submit_deliverable` 时（文件交付物）。判据全部是可判定属性，没有一条看语言。实现是 `@evimed/domain` 的 `replyReviewTier` 与 `deliverableReviewTier`。

| 级 | 触发（可判定） | 确定性核验（代码） | 判断式审查（Qwen3.8-Max） | 修复 | 呈现 | 延迟 |
|---|---|---|---|---|---|---|
| **L0** | 回复无引用标记（`[n]`、DOI、PMID、URL），也没命中 `clinical-safety-rules.json` 的药物词表 | 无 | 无 | 无 | 无 | 0 |
| **L1** | 对话回复含引用标记，或命中药物词表（open-domain-answer、飞书、任何原生回合） | 引用条目解析（PMID→PubMed 摘要；DOI 先换 PMID，拿不到则用 Crossref 摘要；再不行读 URL 页面）；涉药时附安全规则 | 一次调用判完一条回复里所有带引用的句子（≤40 句），关思考；涉药句加答安全项 consistent / contradicted | 不改回复 | 回复下方一行"引用核查"，展开见每句的判断、原文与来源链接；安全项被判 contradicted 且有逐字依据时，站内通知与飞书各发一条更正 | 回复不延迟；标注约 15–40 s 后到 |
| **L2** | 文本类契约：`clinical-evidence-report` `drug-evaluation-report` `off-label-report` `drug-selection-report` `appraisal-table` `manuscript-section` `geo-content-pack` `clinical-decision-brief` `peer-review-report` `research-brief` `grant-proposal-package` | 每条参考文献解析（Crossref→doi.org 句柄→PubMed），PMID 与 DOI 互证、登记题名比对；统计量—p 值—区间一致性；已有的引文逐字（CER）、编号、格式与泄漏检查 | 编辑者一遍：矛盾、支持强度、过度结论、解读、清单逐项在/不在、实例验收项、措辞与结构 | 一轮就地修，再提交 | 提交信封里的发现；运行结束时，审查摘要与未回应的发现排在通知最前 | 小包实测 86 s；64 KB 报告实测 4–8.5 min |
| **L3** | 计算类契约：`dataset-scoping-package` `mendelian-randomization-report` `meta-analysis-report` `bibliometric-analysis-report` `adr-analysis-report` `research-topic-report` | L2 全部 + 正文每个结论性数字对照作业输出（`<工作区>/<引擎>-runs/<作业号>/output/`）溯源：一致 / 相近而不同 / 找不到 | 同 L2，清单换成设计清单（STROBE-MR、PRISMA 2020、SAMPL、不成比例分析、文献计量） | 同 L2 | 同 L2 | 同 L2 |
| **安全叠加** | 临床类契约：上面 L2 的前八个，加 `meta-analysis-report` `adr-analysis-report`；L1 中命中药物词表的回复 | 已有安全规则（数据） | 编辑者多一个 `safety` 类别；L1 多一个安全项 | 同所在级 | 安全类发现排最前 | 叠加 |
| 不审 | `source-understanding` `method-candidate` `method-relations` `episode-plan` `agenda-delta` `analysis-plan` `reproducibility-pack` `surveillance-diff` `hypothesis-set` | 契约校验 | 无 | — | — | — |

三条说明：

- **L0 什么都不做是默认，不是例外。** VeriScore 量过：WritingPrompts 类文本 97% 的句子不含可核验论断，一般问答也有四到六成。FLARE 在 StrategyQA 上无条件检索（68.6）比不检索（72.9）还差。Adaptive-RAG 靠先分类，做到了多步检索的准确率、1.03 步的成本。
- **L1 的 ⚠ 先只进展开层。** HALLMARK（2026-07）测了 12 个模型做医学幻觉验证器，误报率 0.050–0.702，差 14 倍；在 2% 的真实缺陷率下，激进的验证器每 35 个标记里不到 1 个是真的。所以回复下方默认只显示计数，读者展开才见逐句判断。从账本读到误报率低于 15% 后，再考虑把 ⚠ 直接标在句子旁。
- **分级只增不减。** 一次运行可以同时有 L3 的产物和 L1 的对话回复，各走各的。

## 3. 审查者规格：Qwen3.8-Max

### 3.1 模型事实（百炼官方页 2026-09-11 更新；v1.1 线上实测 2026-09-23）

| 项 | 值 |
|---|---|
| 模型 id | `qwen3.8-max`（父）/ `qwen3.8-max-0902`（快照）。**钉快照**，阈值按版本校准。线上实测：`/models` 同时列出两者；别名 `qwen3.8-max-2026-09-02` 应答为 `qwen3.8-max-0902`；不存在的快照返回 404 `model_not_found` |
| 上下文 / 最大输出 | 1,000,000 / 131,072；思考链上限 262,144 |
| 思考 | 混合思考，**默认开**。线上实测：OpenAI 兼容端点直接收请求体顶层的 `enable_thinking`，流式与非流式都生效；`thinking_budget` 生效；推理 token 计在 `completion_tokens` 内（`completion_tokens_details.reasoning_tokens`） |
| 结构化输出 | `response_format` 的 `json_schema` + `strict: true`，开关思考都生效（线上实测） |
| 缓存 | 隐式缓存命中计在 `prompt_tokens_details.cached_tokens`；评测里重复的系统提示与稳定前缀命中 1,024 token |
| 端点 | 旧的 `https://dashscope.aliyuncs.com/compatible-mode/v1` 仍可用；新式是工作空间域名 `{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`。先用旧的，钉在 `deps-version.json`，可用 `OPEN_SCIENCE_REVIEW_API_BASE` 改 |
| 价格（北京） | 输入 ¥12 / 输出 ¥36 每百万 token，不分档；隐式缓存命中 ¥1.5；**无夜间折扣**（DeepSeek 行有）；快照送 100 万 token。价目表 `evimed-reference-2026-09-23` |
| 限流 | 北京按月消费档动态限流，无公开 RPM |
| 吞吐 | 第三方实测约 39 token/s、首字 2.9 s，比 DeepSeek V4 Flash 慢 6 倍。所以编辑者的思考预算要限，L1 关思考 |
| 相对强度 | 第三方 Intelligence Index 45 vs DeepSeek V4 Flash 34。"审查者不弱于生成者"成立，生成者升到 pro 也仍成立 |
| 已知怪癖（线上实测） | ① 关思考时 `evidence` 会被转述而不是照抄——逐字核验放在代码里；② 约束解码下，字符串里一个未转义的英文双引号会提前闭合字符串，后面的内容丢失，严重时连后续发现一起丢——提示与 schema 里规定用「」引用（15.4）；③ 模型会把报告原文与来源原文拼成一条 evidence，加标签与引号——代码逐段核验（15.4） |

### 3.2 部署位置（v1.1 实际）

- **第 2 层 控制面功能模块** `reviewService.mjs`：
  - 开关 `OPEN_SCIENCE_REVIEW_ENABLED`，默认关；
  - PostgreSQL 模式 `evimed_review`，三张表 `reviews` / `findings` / `reply_checks`；
  - L1 走租约 worker `reviewWorker.mjs`；
  - 浏览器路由 `GET /api/review/replies`（一次对话的回复核查）与 `GET /api/review/runs/:id`（一次运行的审查）；
  - 就绪检查 `review`，指标 `open_science_review_*`，告警组 `evimed-review`。
- **第 3 层 网关** `reviewGateway.mjs`，路径前缀 `/internal/review/v1/`：
  - `POST deliverables` 开始一次审查，立即返回 `rv_…`；
  - `GET deliverables/<rv_id>` 轮询；
  - `POST responses` 提交写作者的回应。

  运行时用它已有的工作负载令牌，只报产物 id、契约类型、能力、尝试次数和验收项，不报模型、key 或地址。网关地址由修订网关地址推出（同一个工作负载入口），所以运行时控制器协议不用升版。
- **读产物**：先调 `runtimeManager.workspaceRootForDelivery`，因为 AgentBay 下工作区不在本机，和门禁读矩阵的路径一致。
- **模型调用** `reviewModel.mjs`：流式、严格 json_schema、预扣再结算（purpose `review`）；把失败命名为错误码 `review_model_*`，网络失败附上底层原因（如 `ECONNRESET`）。
- **第 10 层**：`deps-version.json` 的 `dashscope.review` 钉 `apiBase`、`qwen3.8-max-0902`、思考预算 8,000。`packages/contracts/dashscope/` 存从线上录下的四份应答帧（关思考流、开思考流、404、401）和录制脚本，回放测试打的是控制面真实客户端。
- **运行时的 DSH 子代理审查者已退役**。`evimed_review_run` 工具保留给写作中途想听意见的模型，后端换成同一个网关。

### 3.3 输入契约：非对称验证

Apodex 1.1 的做法和 Google 的 check-grounding 一致：验证器不重解任务，拿到的是"一条论断、它引的证据、适用的规则"，然后找反例，查名字、日期、数字、公式。我们照此：

1. **交付包本身**：能力声明的输出文件，报告放在最后（稳定部分在前，方便第二遍命中缓存前缀）。总长上限 160,000 字，非 Markdown 文件每个最多 8,000 字。不给对话记录，不给推理过程，不给运行的工具日志。
2. **确定性结果先喂**：参考文献解析的计数与每条问题、L3 的数字溯源计数、统计一致性问题数。它不必重做这些，只在此之上判断，也被要求不要重复。
3. **论断引用的来源原文**：每个来源只给一次（S1、S2…）：8,000 字以内给全文，更长的给每处引文前后各 1,500 字，全部来源合计 32 万字，超出后退回每处引文前后 300 字。论断里只写来源编号和引文。最初实施的是每条论断 ±300 字的片段，生产上第一次审真实报告就因此误报：细节在摘要里、但离引文 400–550 字，编辑者看不到，建议删掉正确的内容（15.5 第 4 条）。
4. **类清单 + 实例验收项**：
   - 类清单在控制面的 `apps/server/src/reviewChecklists.json`，药师和方法学家可改（原则 7），运行时读不到（原则见 5.6）。七份清单：证据报告要素 10 条、PRISMA 2020 27 条、STROBE-MR 20 条、SAMPL 9 条、不成比例分析 8 条、文献计量 6 条、偏倚风险 4 条。按契约挂载，见第 7 节。
   - 实例验收项是运行在 `evimed_plan` 阶段按 brief 给每个交付物写下的最多 10 条（`PLAN_ACCEPTANCE_LIMIT`），随提交送审。RaR 的消融显示，实例专属清单显著优于通用清单。
5. **角色**：交付包作为"外部提交的材料"给它，提示里明说"你没有看过产出它的过程；不要重建它，也不要替它辩护"。角色重标能使显式纠错率提高 23–93 个百分点。
6. **第二遍**：同一交付物修过之后，第二遍会看到上一轮的发现和作者的回应，被要求只报仍未解决、且作者没给出合理理由的问题，以及改动处新出现的问题。

### 3.4 输出契约

严格 `json_schema`，三个数组。schema 按每个交付包生成（`reviewEditorSchema`）：

- `checklist` 与 `acceptance` 恰好是问到的条目数，条目号只能取问到的编号；
- `findings` 至少 1 条、至多 25 条，没有问题时写一条 kind 为 `none` 的条目。代码把 `none` 条目直接略过，既不算发现也不算丢弃。

这两条是约束解码层面的，不只写在提示里。生产上编辑者有 2/6 的回答把数组空着闭合，也出现过一次写了 119 条、在输出上限处截断的回答（15.5 第 8、9 条）。

`findings[]`，每条：

| 字段 | 约束 |
|---|---|
| `location` | 论断编号（CLM-012）、参考文献编号（[7]）、章节标题或清单条目号 |
| `kind` | 封闭词表：`contradiction` `weak_support` `overclaim` `interpretation` `missing_item` `structure` `wording`，临床类再加 `safety`。代码产生的可判定类别（`reference_unresolvable` `reference_mismatch` `number_untraced` `stat_inconsistent`）模型不能用 |
| `severity` | 模型不填。代码按类别给：判断类永远 `advisory`；可判定类只有被提升后才 `required`，今天没有提升任何一类 |
| `evidence` | 它依据的原文，逐字。代码在交付包或来源片段里找不到就**丢弃这条发现**（原则 5：模型判、代码核、核不上的丢）。v1.1 细化：整段找不到时，按换行与分号切开，去掉「报告原文：」这类短标签和外层引号，逐段核，每段都必须找到（15.4） |
| `fix` | 一句可执行的最小改法；引用词句用「」 |

`checklist[]`：每个给出的条目答 `present` / `absent` / `not_applicable`。`present` 必须附报告原文；代码核不上的，记为"未定位"而不是"在"。缺的条目只在这里答，不再写成发现。

`acceptance[]`：每条验收项答 `met`；`met: true` 必须附原文，核不上的记为未判定。

另有两条硬约束：保留下来的发现每个交付物最多 30 条，丢弃的按原因计数进指标；审查者永远不写文件。

### 3.5 思考与预算（v1.1 实际）

**编辑者**：

- 开思考，`thinking_budget` 16,000，最大输出 32,000（最初是 8,000 / 24,000：生产上两次审 64 KB 报告都把 8,000 用满，15.5 第 5 条）。线上实测，最大输出只管回答、不含思考：一次截断的用量是思考 16,000 + 回答 32,003。超时 900 s；流上静默超过 120 s 算中断；
- 回答在上限处被截断时，错误码是 `review_model_truncated`，与闭合了但不合法的 `review_model_response_invalid` 分开；
- 可重试的失败（断流、5xx、429、连不上）等 5 秒重试一次，超时和拒绝不重试；
- 回答什么都没说（没有发现，清单和验收项一条没答）时再问一次；再空就记为编辑者失败 `review_editor_empty`，不当作"没发现问题"。schema 已经从解码层面排除了这种回答，这一条是防提供方哪天不再遵守 minItems；
- 每个交付物最多两遍（首次 + 修后），第二遍只在交付包变了时跑；
- 运行时每 3 秒轮询一次，最多等 16 分钟。等不到就带着门禁结果继续，审查结果照样入库，出现在运行结束的通知里。

**L1**：

- 关思考，最大输出 4,000，超时 90 s；
- worker 并发 2，每条最多 3 次尝试。

实测成本（`evals/tiered-review/results/`）：

- L1 一条带一句引用的回复 ¥0.006–0.018，缓存命中后约 ¥0.007；
- 编辑者审一个 3 条论断的小包：输入约 1.7k token，输出 3.2–4.9k token（其中思考 1.4–2.7k），每遍 ¥0.12–0.19，耗时 86 s。

- 编辑者审生产上一份真实的 64 KB 报告（57 条参考文献、63 条论断）：
  - 最初的配置：输入约 61k token，思考用满 8,000，输出约 11k，首遍 ¥1.13、240 s；同一前缀再审一遍命中缓存，¥0.47。
    - 给全文来源、思考上限 16,000、按包生成 schema 之后（最终代码 4 次）：输入约 72k token，思考 9.3k–16k，发现 13–25 条，清单 19/19，每遍 ¥0.62–0.91（前缀命中缓存）、6–8.5 min；未命中缓存的首遍约 ¥1.24。
- 真实交付经提交路径（两次，每次两遍编辑者）：每遍 ¥0.49–0.83、153–360 s；一次交付的审查合计 ¥1.15–1.55，运行时长从不审查时的约 11 min 变为 11.7–21 min。

线上的真实分布从账本 `purpose = 'review'` 读。

### 3.6 误报控制

判断式发现只做建议，这不是保守，是数据：Qwen3-Max 做 PRISMA 2020 条目核对，灵敏度 95.1%、特异度 49.3%——它会标出两倍于实际的问题。处理办法：

1. **核得上才保留**：发现必须带 `evidence`，并且代码核得上。评测里，编辑者一遍平均丢掉 1–8 条，全是空 evidence 或描述性 evidence 的缺项。
2. **按类计数**：每类发现的提出数、丢弃数（按原因）、写作者回应（已修 / 不改并说明）都进指标：`open_science_review_findings_total`、`_findings_dropped_total`、`_responses_total`。
3. **按拒绝率调整**：一类发现的"不改并说明"过半，就把它降级或删掉；一类可判定检查的误报率读出来足够低，才进提升名单。

## 4. 确定性核验清单（代码，全量，不抽样）

这是准确率真正所在的层：文献里所有接近零错误的结果都来自查表和比对，没有一个来自判断。v1.1 全部以建议上线（第 0 节）。

| 检查 | 级 | v1.0 时 | v1.1 |
|---|---|---|---|
| 引文逐字在来源里（`claimVerification`） | L2（CER） | 有，只在 `clinical-evidence-report`（唯一有论断矩阵的契约） | 不变 |
| 每条参考文献可解析 | L1–L3 | **没有任何地方逐条解析**（v1.0 写"`citationsResolvable` 抽查"不对） | 新建：`referenceResolution`（域）+ `referenceResolver`（控制面）。DOI 先问 Crossref，404 再问 doi.org 句柄（非 Crossref 注册的 DOI）；PMID 走 PubMed esummary。PMID 登记的 DOI 与条目 DOI 不同 → 不符；登记题名与条目题名的词重合过低 → 不符；两边都查无此条 → 不可解析；登记处无应答 → 不判。缓存 24 h，NCBI 限速，每份报告最多 300 条 |
| 编号一致：台账 ↔ 参考文献表 ↔ 正文 `[n]` | L2 | 已有 `claim-reference-identity`（建议） | 不变 |
| 数字溯源 | L3；CER 与数据范围包另有 | CER 与数据范围包已有 `claim-numeric-support`（建议；生产 4 次运行 102 条通知） | 新建：`numericTraceability`。L3 正文每个带单位或统计标签的数字（与门禁 `claim-numeric-support` 用同一个抽取器；跳过 95% CI 的 95、p<0.05 这类阈值和 GWAS 的 5×10⁻⁸；不看标题、代码块、引用行和参考文献表）对照作业输出里的数字：一致 / 相近而不同 / 找不到，按幅度比较，负号不算差异 |
| 重跑一致 | — | 无 | **取消**（15.2） |
| 统计量—p 值—区间一致性（statcheck 式） | L2–L3 所有报告类 | 无 | 新建：`statConsistency`，门禁检查 `stat-consistency`。t/F/χ²/z/r 与自由度推 p，比对报告的 p；估计值落在自己的区间外；区间与 p 的方向矛盾。有三条防误报：p 只在紧邻（中间只有标点）时归属；区间端点正好等于无效值、或 p 在 [0.04, 0.06] 时不判；log OR 等按差值量度（无效值 0）。本地 324 份报告回放：1 条，是真错 |
| 安全规则（`clinical-safety-rules.json`） | L1–L3 | 有 | 加 19 组药物词表（`medicineVocabularies`），供 L1 分级与"涉药"标记 |
| 格式与运行时泄漏 | L2–L3 | 有 | 不变 |

没有一条是开放词表的散文正则（原则 5），没有一条要求读者看不见的簿记（09-17 裁决）。

## 5. 修复环路

```
evimed_submit_deliverable
  → 门禁（域，毫秒级；stat-consistency 等建议项同时出）
  → L2/L3：POST /internal/review/v1/deliverables → rv_…；运行时每 3 s 轮询，最多 16 min
      控制面：读包 → 参考文献全量解析 → L3 数字溯源 → 统计一致性
             → Qwen 编辑者（思考 8k）→ 逐条核 evidence → 入库
  → 一个信封返回：门禁裁定 + 审查发现（F01…，每条带位置、原文、改法）
生成者（同一回合、同一上下文）
  → 逐条处理：修，或在再提交的 responses 里写 {id, fixed | declined + 理由}
  → 再提交：门禁全跑；编辑者第二遍只在包变了时跑，并看到上一轮的发现与回应
运行结束 → 交付（unverified + 通知；审查摘要与仍欠回应的发现排在通知最前）
```

六条规则：

1. **写单线程。** 编辑者提议，生成者应用；生成者用它掌握的用户指令和范围来过滤建议（Cognition 的"通信桥"）。审查者精度再高，不耦合进生成者的循环，也没人采纳。
2. **一轮。** 每个交付物编辑者最多两遍（首次 + 修后）；确定性检查在提交预算内不限次。不做审查者的审查者。
3. **最小编辑。** 改法是句级的，不重写。RARR 的数据：重写式归因分数更高，但原文保留只剩 6–48。用户对"AI 修订"的所有权 5.57，对"AI 起草"4.28。
4. **死结已解。** 09-20 已经把提交改成"渲染 → 门禁"、运行结束才冻结、同一对话里的后续请求可铸一次授权。v1.1 补齐剩下的五处（15.1 第 1 条）。
5. **永不扣发。** 修不完就 `unverified` 交付，通知附上，安全类先列。判断式发现永远是建议；需要回应的只有 `contradiction` `overclaim` `safety` 与可判定类，`wording` 这类可以不回应。
6. **审查者对运行不可见。** 运行读不到编辑者的提示、清单和阈值：它们在控制面，不在会打进运行时的域包里（runtime-can-read-the-gate 的教训；"自写测试不可靠"：35 个策略里 15 个低于随机，却自报通过率 ≥0.70，密封的外部审计才把它修正）。

## 6. L1：对话回复的异步标注

业界做法一致：Google 的 check-grounding 是一个独立调用，返回每条论断的字节区间和支持分，目标延迟 500 ms 以内；Anthropic Citations 返回 `cited_text` 与字符位置；两者都不拦回复。我们照此：

1. **入队**：运行账本每 15 s 一轮收录结束的回合，`replyReviewTier` 判级。回复有引用标记或命中药物词表时，写入 `evimed_review.reply_checks`，同时存下回复原文和它回答的问题。
2. **取来源**：worker 抽出带引用的句子（≤40 句）和它们引的条目，然后取来源文本：PMID → PubMed 题名与摘要；只有 DOI → 先换 PMID，换不到用 Crossref 摘要；都没有 → 用 `web_read` 同一个读取器读 URL。
3. **判断**：一次 Qwen 调用（关思考）判全部句子。每句给出 `verdict`（supported / partial / unsupported / uncertain）、一句理由、从来源逐字复制的 `evidence`；涉药句另给 `safety`。
4. **代码核验**：
   - `evidence` 核不上 → uncertain；
   - 引的来源全打不开 → unresolvable；
   - `contradicted` 必须有逐字依据才保留，因为它是唯一会发到人收件箱的判断。
5. **呈现**：对话是内核框架渲染的，不是我们的 React，所以不复用 `ClaimCitation`（v1.0 的设想），改走内核插槽。
   - 外壳每 10 秒轮询 `/api/review/replies`，经桥把 `reply-check` 发进框架；
   - 框架里 `reply-checks` 这个 body 接管 `conversation.chat.node` 的 `assistant-step`（优先级 −1），在对应回复下加一行"引用核查"，展开见每句的判断、理由、原文与来源链接；
   - 连接键是（会话 id，回合的最后一条助手消息序号）。
6. **安全更正**：安全项被判 contradicted 时，站内通知（severity `safety`）与飞书（`sendRunCorrection`，带【更正提示】）各发一条；对应指标 `open_science_review_safety_alerts_total`，告警 `ReviewMedicineClaimContradicted`。其余标注只留在应用内。

预算见 3.5。误报率按第 2 节的说明，先量后放到句子旁。

## 7. L3：数据与计算交付物

数据类产物的错不在引文，而在"数字从哪来"和"方法对不对"。文献的两条硬结果：审计者拿到日志和代码，准确率从 55% 升到 82%（2509.08713）；执行式验证 90.6% 对静态 78.1%，但有 8 个仓库执行通过、静态检查却发现硬编码指标和数据泄漏（ReAgent）。

1. **数字溯源代替重跑（v1.1）**。
   - 报告里出现的作业号（`mr-…` `meta-…` `bibliometric-…` `safety-…` `topic-…` `review-…`，最多 4 个）定位到工作区的 `<引擎>-runs/<作业号>/output/`，读其中的 JSON / CSV / TSV（所有作业合计 80 个文件、12 MB 以内），抽出全部数字。
   - 报告里每个结论性数字按显示精度比对：一致 / 相近而不同 / 找不到，"相近而不同"排在前面。
   - 为什么不重跑，见 15.2。
2. **设计清单**（控制面 `reviewChecklists.json`）：

   | 契约 | 清单 |
   |---|---|
   | MR | STROBE-MR（20 条）+ SAMPL |
   | meta | PRISMA 2020（27 条）+ SAMPL |
   | ADR | 不成比例分析（8 条）+ SAMPL |
   | 文献计量 | 文献计量（6 条） |
   | 数据范围包 | SAMPL |
   | 评价表 | 偏倚风险（4 条） |
   | 证据报告四类与 CER | 证据报告要素（10 条），CER 另加 SAMPL |

   | 按研究类型（v1.2） | 计划阶段给交付物声明 `studyType`：`rct` 挂 CONSORT 2025（C1–C30），`prediction-model` 挂 TRIPOD+AI（T1–T27），`systematic-review` 挂 PRISMA 2020，`mendelian-randomization` 挂 STROBE-MR；`observational` / `diagnostic-accuracy` / `other` 暂无清单 |

   v1.1 时 CONSORT 2025 与 TRIPOD+AI 没有挂，因为没有一个契约专门报告 RCT 或预测模型。v1.2 按你的决定改成计划阶段声明研究类型再挂，同时交付物里放一份填好的 `reporting-checklist.md`（第 16 节）。编辑者只答在/不在并给原文，代码核定位，不打分。
3. **解读审查**（建议）：效应方向、CI 与 p 的一致、"显著"过度、检验适用性（StatQA：模型最常犯的是适用性错误，用了数据不满足假设的检验）。统计量本身的一致性由第 4 节的代码先做。
4. **方法选择不指望审查。** BLADE 的数字摆在那里；这部分靠 SKILL 里的方法先验（第 8 节）。

## 8. 生成侧配套（审查补不了的）

1. **地标追溯**（已做）。证据类能力的 SKILL 加了一节：检索完主题后，取本领域最新指南与最新系统评价，用新工具 `reference_list` 拿到它们的参考文献表（Europe PMC；也可反查被引），把其中的 RCT 与 meta 分析并入候选，并在报告里交代"地标研究来自何处"。三类药物评价能力加同一段。那次综述缺的三个试验都在指南参考文献表里。
2. **写作阶段用 pro**（未做，待你决定，第 13 节）。Snell 等的结论：验证加修订在容易和中等题上顶得过 14 倍大的模型，最难的题上没用，得换更大的模型；综述的成稿是最难的那段。但它不是一行配置：
   - 模型网关要把 pro 加进允许名单；
   - 内核配置要有第二个模型行；
   - harness-port 要一个按阶段选模型的新接缝；
   - 回执要认证实际跑的是哪个模型（modelGateway 认证的是实际模型，不是源码里写的）。
3. **方法先验**（已做）。meta、MR、文献计量、ADR 四个引擎能力的 SKILL 各加一节"Method priors"：何时用什么模型或检验、假设怎么查、敏感性分析怎么选、结果怎么写才不过度——写成可编辑的文字，不写成 if（原则 7）。

## 9. 落到分层（v1.1 实际）

| 层 | 改动 |
|---|---|
| 1 浏览器 | `lib/replyChecks.ts`：轮询回复核查并发进内核框架；`RuntimeUiFrame` 接上。运行页的发现列表沿用现有通知展示（审查摘要在前） |
| 2 控制面 | 功能模块 `reviewService` / `reviewRoutes` / `reviewWorker` / `reviewPersistence`（模式 `evimed_review`）+ `reviewModel` + `referenceResolver` + `reviewChecklists.json`；`config.mjs` 的 `reviewSettings()`（12 个 `OPEN_SCIENCE_REVIEW_*`，默认关）；`server.mjs` 一处注册；`agentRuns` 在运行结束时把审查通知排最前；`imService.sendRunCorrection` |
| 3 网关 | `reviewGateway.mjs`：三个路径，一个前缀常量；运行时只报产物 id |
| 4 域 | `statConsistency` `referenceResolution` `numericTraceability` `reviewFindings` `reviewTier` `replyCheck` 六个纯模块；门禁检查 `stat-consistency`；usage purpose `review`；价目表 `evimed-reference-2026-09-23`；计划的验收项；药物词表；`reference_list` 进工具名 |
| 5 反腐层 | 框架 body `reply-checks`（插槽 `conversation.chat.node`）、桥的 `reply-check` 入站消息、工具结果解析（`ok` 后跟问题行）、审查摘要的工具视图 |
| 6 插座 | `run-policy` 的提交改调网关（开始 + 轮询 + 回应）；`review` 插件的工具改走网关；原生回合每回合重置尝试次数；计划工具收验收项 |
| 7 运行时镜像 | MCP 工具 `reference_list`；能力清单重新生成 |
| 8 能力 | 八个能力升版：SKILL 加地标追溯或方法先验，四个证据类能力的清单加 `reference_list` |
| 9 引擎 | 无改动（作业输出已在工作区） |
| 10 外部 | `deps-version.json` 钉 `qwen3.8-max-0902`；`packages/contracts/dashscope` 录线路帧 + 回放测试 |
| 运维 | compose 12 个开关；`.env.example` 审查者一节；告警组 `evimed-review` 三条（编辑者失败过半、回复核查失败多于成功、用药说法被来源否定）；运行手册三行；SaaS 对齐审计加 `review_default_off` |

## 10. 工作包与状态

| # | 工作包 | v1.1 状态 |
|---|---|---|
| WP1 | 死结：提交=渲染→门禁→审查一次返回；运行结束冻结；同对话铸授权；信封加回应 | ✅ 09-20 已做大半；v1.1 补齐五处（15.1 第 1 条） |
| WP2 | 网关与合同：`reviewGateway`、DashScope 合同帧、pin、purpose `review`、价目表 | ✅ |
| WP3 | 确定性全量：参考文献解析、数字溯源、统计一致性（编号一致已有） | ✅ 全部建议级 |
| WP4 | L2 编辑者：输入/输出契约、清单数据、实例验收项、DSH 审查者退役 | ✅ |
| WP5 | L3：数字溯源接入作业输出、设计清单、统计一致性 | ✅（重跑取消） |
| WP6 | L1：异步核查 worker、消息标注、飞书更正 | ✅（不接 Jev） |
| WP7 | 生成侧：地标追溯、方法先验、写作阶段切 pro | ◐ 前两项已做；pro 待决定 |
| WP8 | 观测：按类计数、拒绝率、告警 | ✅ 指标 + 三条告警 + 运行手册 |
| — | 评测：`evals/tiered-review/` | ✅ 19 个用例，离线 16/16，在线 19/19（15.4；新增的 5 个来自 15.5） |

## 11. 成本与延迟

| 级 | 每次量级 | 说明 |
|---|---|---|
| L0 | 0 | 绝大多数对话 |
| L1 | 实测一句 ¥0.006–0.018；五句的回答估 ¥0.02–0.04；约 15–40 s 异步 | 全部走 Qwen（关思考），一次调用判完一条回复 |
| L2 | 小包实测 ¥0.12–0.19/遍；真实交付经提交路径每遍 ¥0.49–0.83、2.5–6 min；生产上 64 KB 报告按最终配置每遍 ¥0.62–0.91（前缀命中缓存），未命中约 ¥1.24 | 一份深度报告约 ¥3.5，加两遍审查后估 ¥5.5 以内；审查同步进行，运行多等 1–10 min |
| L3 | 同 L2 | 不重跑，不占运行时容器 |
| 对照 | Anthropic Code Review 每个 PR $15–25、约 20 分钟，错误发现率 <1% | 我们的编辑者便宜一个量级，精度靠 evidence 强制来追 |

## 12. 不做的事

- 不做第二个审查者、不做审查者循环、不做并行写作 agent。
- 不让 flash 审 flash；不让任何审查者写文件。
- 不新增开放词表的散文正则；不新增读者看不见的簿记检查。
- 不把判断式发现设为 required；不因审查扣发任何交付；新增的可判定检查先做建议。
- 不给编辑者对话记录或推理过程。
- 不重跑引擎作业（15.2）。
- 不设计新的对照实验；编辑者作为回合内建议进入运行，误报率从账本读。

## 13. 需要你决定的

> **v1.2（2026-09-24）：** 第 1 条已定——上生产；第 2 条已定——先不换；第 3 条已定——计划阶段声明研究类型再挂，交付物里也放。余额提醒已由平台告警 `ModelProviderBalanceExhausted` 覆盖，你那边也已充值。**只剩第 4 条待定。** 结果见第 16 节，下面保留 v1.1 的原文。

四件事，都不阻塞已上线的部分；另有一个运维开关在最后：

1. **Jev 要不要上生产。** v1.0 设想 L1 先过 Jev（约 300 ms、上轮实测引文—论断支持 99/101），不确定带再送 Qwen。接它需要两样：
   - 把 typesafe 的 key 放到生产主机（你还没授权过）；
   - 账本只按人民币计价，Jev 按美元计费，得加一行汇率，或者单独记。

   不接也能跑：L1 现在全部由 Qwen 判，一句约 ¥0.007。
2. **报告类能力的写作阶段要不要换 pro。** 工程上要四处改动（第 8 节第 2 条），成本按 DeepSeek pro 价目另算。我的建议是先看 L2 审查上线两周的账本：如果"矛盾 / 过度结论"类发现的已修率高、残留少，就不必换。
3. **CONSORT 2025 / TRIPOD+AI 挂到哪。** 今天没有契约专门报告 RCT 或预测模型；`manuscript-section` 可能是任一种。可以让计划阶段声明研究类型再挂，也可以新增契约类型。
4. **L1 的 ⚠ 什么时候放到句子旁。** 现在默认只在回复下方显示计数、展开才见。我提议的门槛是：账本里 L1 的"unsupported"抽检误报率低于 15%。

另外，**DeepSeek 余额需要一个提醒。** 09-23 11:49 UTC 起余额见底（−¥0.04，HTTP 402），到约 13:5x 你充值为止：

- 这段时间所有 DeepSeek 调用都失败；
- 发布回执铸不出来，就绪检查停在 25/26。

平台看得到 402，但没有针对余额的告警；DeepSeek 控制台可以设余额提醒，这是你那边的一个开关。

## 14. 依据

**自我纠错与审查者选择**：[Large Language Models Cannot Self-Correct Reasoning Yet (ICLR 2024)](https://arxiv.org/abs/2310.01798) · [When Can LLMs Actually Correct Their Own Mistakes? (TACL 2024)](https://arxiv.org/abs/2406.01297) · [Reviewer Capability Governs Rejection Targeting, Not Repair Skill (2026-09)](https://arxiv.org/abs/2609.04270) · [Cross-Model LLM Code Review (2026-07)](https://arxiv.org/abs/2607.21656) · [Self-Correction Bench](https://arxiv.org/abs/2507.02778) · [The Self-Correction Illusion (2026-06)](https://arxiv.org/abs/2606.05976) · [LLM Evaluators Recognize and Favor Their Own Generations](https://arxiv.org/abs/2404.13076) · [Variation in Verification](https://arxiv.org/abs/2509.17995) · [Self-Authored Verification Is Unreliable (2026-07)](https://arxiv.org/html/2607.24300)

**上下文隔离**：[Cross-Context Review (2026-03)](https://arxiv.org/abs/2603.12123) · [Context Rot (Chroma)](https://www.trychroma.com/research/context-rot) · [Cognition: Multi-Agents, What's Actually Working (2026-04)](https://cognition.com/blog/multi-agents-working) · [Cognition: Don't Build Multi-Agents (2025-06)](https://cognition.com/blog/dont-build-multi-agents)

**工具与确定性核验**：[Agent-as-a-Judge (ICML 2025)](https://arxiv.org/abs/2410.10934) · [Detecting and Correcting Reference Hallucinations (2026-04)](https://arxiv.org/abs/2604.03173) · [ScientistOne](https://arxiv.org/html/2605.26340v1) · [VeriGraph (2026-06)](https://arxiv.org/abs/2606.16603) · [Evaluating and Guarding Citation Faithfulness (2026-07)](https://arxiv.org/abs/2607.20527) · [Cited but Not Verified (2026-05)](https://arxiv.org/html/2605.06635v1) · [SourceCheckup](https://arxiv.org/abs/2402.02008) · [HALLMARK (2026-07)](https://arxiv.org/html/2607.18360) · [statcheck vs AI (J Korean Med Sci 2025)](https://www.jkms.org/DOIx.php?id=10.3346%2Fjkms.2025.40.e342) · [OpenScholar](https://arxiv.org/abs/2411.14199) · [PaperQA2](https://arxiv.org/abs/2409.13740)

**逐句核验与何时核验**：[Self-RAG](https://arxiv.org/abs/2310.11511) · [RARR (ACL 2023)](https://aclanthology.org/2023.acl-long.910/) · [FActScore](https://arxiv.org/abs/2305.14251) · [SAFE / LongFact](https://arxiv.org/abs/2403.18802) · [VeriScore](https://arxiv.org/html/2406.19276) · [FacTool](https://ar5iv.labs.arxiv.org/html/2307.13528) · [FLARE](https://arxiv.org/html/2305.06983v2) · [Adaptive-RAG](https://arxiv.org/html/2403.14403v2) · [MedHallu](https://arxiv.org/abs/2502.14302) · [Ownership of AI-drafted vs AI-revised text (2026-06)](https://arxiv.org/html/2604.11009)

**定位、修复与耦合**：[LLMs cannot find reasoning errors, but can correct them given the error location (ACL 2024)](https://arxiv.org/abs/2311.08516) · [Is Self-Repair a Silver Bullet? (ICLR 2024)](https://arxiv.org/abs/2306.09896v5) · [Precise but Uncoupled (2026-07)](https://arxiv.org/html/2607.15388) · [LLM Critics Help Catch LLM Bugs (CriticGPT)](https://arxiv.org/abs/2407.00215) · [Rubrics as Rewards](https://www.alphaxiv.org/overview/2507.17746) · [Steer, Don't Solve (2026-06)](https://arxiv.org/abs/2606.21811) · [Scaling LLM Test-Time Compute Optimally](https://arxiv.org/abs/2408.03314)

**多智能体**：[Why Do Multi-Agent LLM Systems Fail? (MAST, NeurIPS 2025)](https://arxiv.org/abs/2503.13657) · [Single-Agent LLMs Outperform Multi-Agent Systems Under Equal Budgets (2026-04)](https://arxiv.org/html/2604.02460v1) · [Anthropic: multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) · [Anthropic: Building effective agents（evaluator-optimizer）](https://www.anthropic.com/engineering/building-effective-agents) · [Anthropic Code Review](https://claude.com/blog/code-review) · [Apodex 1.1 (2026-08)](https://arxiv.org/html/2608.23283v1) · [Apodex 1.0](https://www.apodex.com/blog/apodex-1.0)

**数据分析与代码**：[CORE-Bench](https://arxiv.org/abs/2409.11363) · [ReplicationBench](https://arxiv.org/abs/2510.24591) · [ReAgent (2026-08)](https://arxiv.org/html/2609.22111) · [Hidden pitfalls of AI Scientist systems](https://arxiv.org/html/2509.08713v2) · [BLADE (EMNLP 2024)](https://aclanthology.org/2024.findings-emnlp.815/) · [StatQA (NeurIPS 2024)](https://arxiv.org/abs/2406.07815) · [DSBench (ICLR 2025)](https://arxiv.org/abs/2409.07703) · [MLReplicate (2026-05)](https://arxiv.org/abs/2605.16616) · [LLM statistical review of categorical data (2026)](https://pmc.ncbi.nlm.nih.gov/articles/PMC13430902/) · [Risk of bias with LLMs (JAMA Netw Open 2024)](https://pmc.ncbi.nlm.nih.gov/articles/PMC11112444/) · [PRISMA 2020 adherence with LLMs (Qwen3-Max 95.1/49.3)](https://arxiv.org/abs/2511.16707) · [Do LLMs scrutinise what they review? (2026-08)](https://arxiv.org/abs/2608.28626) · [Notebook reproducibility baseline](https://arxiv.org/html/2509.23645)

**清单**：[STROBE-MR](https://jamanetwork.com/journals/jama/fullarticle/2785494) · [PRISMA 2020](https://www.bmj.com/content/372/bmj.n71) · [CONSORT 2025](https://www.bmj.com/content/389/bmj-2024-081123) · [TRIPOD+AI](https://www.bmj.com/content/385/bmj-2023-078378) · [SAMPL](https://www.equator-network.org/reporting-guidelines/sampl/)

**Qwen3.8-Max 与业界标注**：[qwen3.8-max 模型页（百炼）](https://help.aliyun.com/zh/model-studio/qwen3-8-max) · [百炼价格](https://help.aliyun.com/zh/model-studio/model-pricing) · [限流](https://help.aliyun.com/zh/model-studio/rate-limit) · [深度思考](https://www.alibabacloud.com/help/en/model-studio/deep-thinking) · [JSON 模式](https://www.alibabacloud.com/help/en/model-studio/json-mode) · [OpenAI 兼容端点](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope) · [Qwen3.8-2.4T-A95B](https://huggingface.co/Qwen/Qwen3.8-2.4T-A95B) · [Artificial Analysis：Qwen3.8-Max vs DeepSeek V4 Flash](https://artificialanalysis.ai/models/comparisons/qwen3-8-max-vs-deepseek-v4-flash) · [Vertex AI check grounding](https://docs.cloud.google.com/generative-ai-app-builder/docs/check-grounding) · [Anthropic Citations](https://platform.claude.com/docs/en/build-with-claude/citations)

**v1.1 自己的记录**：`packages/contracts/dashscope/fixtures/`（线路帧与 `provenance.json`）· `evals/tiered-review/cases.json` 与 `results/` · `.evimed-local/probes/2026-09-23-qwen-review/`（探测脚本与原始输出，本地）

## 15. v1.1：核对与实施记录

### 15.1 v1.0 与事实不符之处

| # | v1.0 说 | 事实（核对依据） | v1.1 |
|---|---|---|---|
| 1 | WP1"死结"是第一个工作包，1–2 天 | 09-20 已做大半：提交走"渲染→门禁"、运行结束冻结、同对话铸授权都在（代码） | 补齐五处：<br>① 原生回合每回合重置提交尝试次数（同一对话的第二个请求不再继承上一回合的计数）；<br>② 提交信封加 `responses` 载体；<br>③ 运行结束时审查通知排最前（通知上限 40 条，排后面会被挤掉）；<br>④ 审查类问题的读者标题；<br>⑤ 工具结果解析：`ok` 后面跟着问题行时整条被当成失败（生产样本 `LIVE_OK_WITH_REVIEW`） |
| 2 | L2 每条引文逐字匹配 | 只有 `clinical-evidence-report` 有论断矩阵和引文，其他 L2 契约没有可比的引文（契约注册表） | 引文逐字仍只在 CER；其他契约靠参考文献解析与编辑者 |
| 3 | 数字溯源"无" | CER 与数据范围包已有 `claim-numeric-support`（建议），生产 4 次运行发了 102 条通知 | 只新增 L3 对作业输出的溯源 |
| 4 | 编号一致"只查有无条目" | `claim-reference-identity` 已有（建议） | 不变 |
| 5 | 参考文献解析"`citationsResolvable` 抽查" | 没有任何地方逐条解析参考文献 | 新建（第 4 节） |
| 6 | 确定性项定为 required | 与原则 4 冲突，而且没有分布；上面第 3 条的 102 条就是例子 | 全部建议，提升名单为空 |
| 7 | 新工具 `evimed_reproduce` 重跑入口脚本 | 引擎不在运行时镜像里（在 specialist-adapter 容器）；引擎含 LLM 步骤，同输入不保证同输出；作业输出本来就落在工作区 | 取消，改为对作业输出做数字溯源 |
| 8 | L3 名单五个契约 | 漏了 `research-topic-report`（有 topic 引擎作业）；`peer-review-report` 是文本评审 | L3 加 research-topic；peer review 留 L2 |
| 9 | L1 标注 5–10 s 后到 | 回合要等运行账本 15 s 一轮收录，worker 3 s 一轮，再加取来源、一次模型调用和外壳 10 s 一次的轮询 | 约 15–40 s |
| 10 | L1 先过 Jev | 要把 key 放上生产主机，你没授权过；账本只按人民币计价 | 暂不接，全部 Qwen 关思考（第 13 节第 1 条） |
| 11 | 清单放在域 `review-checklists.json` | 域会被打进运行时的插座包，放在那里运行时就读得到（runtime-can-read-the-gate） | 放控制面 `apps/server/src/reviewChecklists.json` |
| 12 | L1 呈现复用 `ClaimCitation` 弹层 | 对话在内核框架里渲染，不是外壳的 React | 走内核插槽 `conversation.chat.node`（第 6 节） |
| 13 | Qwen 关思考要放 `extra_body` | `extra_body` 是 OpenAI SDK 的写法；线路上就是请求体顶层的 `enable_thinking`，流式与非流式都生效（线上实测） | 按线路写，录帧为证 |
| 14 | 来源片段取引文前后各 600 字 | 实施先取了 300 字，生产上第一次审真实报告就因窗口太窄误报两条（15.5 第 4 条） | 每个来源给一次全文（8,000 字以内），更长的给引文前后各 1,500 字 |
| 15 | `evimed_review_run` 每个产物限一次 | 与"编辑者每个交付物最多两遍"合并计数更简单 | 同一计数：每个交付物最多两遍编辑者 |

### 15.2 实施中的取舍

- **新检查全是建议。** 见第 0 节与 15.1 第 6 条。代码层面：可判定类别也只在进了提升名单后才是 `required`；名单由账本数据决定，不由代码默认。
- **不重跑。** 见 15.1 第 7 条。v1.0 想从重跑得到的是"正文数字来自真实计算"，这一半由作业输出溯源直接给出；另一半"代码里没有硬编码结果"，由编辑者读交付包里声明的脚本文件给出建议。
- **L1 不接 Jev**，见第 13 节。
- **审查结果怎么回到运行。**
  - 提交时同步：运行时轮询到结果，发现进同一个提交信封；
  - 运行结束时：`agentRuns` 最多等 2 秒取审查通知，排在所有质量通知之前，保证不被 40 条上限挤掉；
  - 读者侧：运行页的通知里就有"n 条审查发现（已修 a，不改并说明 b，未回应 c）"。
- **开关只有一个。** 旧的 `OPEN_SCIENCE_RUNTIME_REVIEW_ENABLED` 删掉，运行时的审查跟随 `OPEN_SCIENCE_REVIEW_ENABLED`。避免出现"控制面关了、运行时还在等审查"的状态。
- **网关地址由修订网关推出。** 不新增控制器协议字段，所以运行时控制器不用升版，也不用重建控制器容器。
- **重试一次，先停 5 秒。** 只对提供方自己标为暂时性的失败。评测时开发机与 DashScope 断过一段（连续五次连不上，随后恢复），立即重试会落在同一段里。
- **evidence 逐段核验、引号规则**：见 15.4。

### 15.3 改动清单

按层见第 9 节。测试：

- **域**：新增 `statConsistency` `referenceResolution` `numericTraceability` `reviewFindings` `reviewTier` 五个测试文件，改 `pricing` `usagePurpose`。
- **控制面**：新增 `reviewModel`（回放 DashScope 帧）、`reviewGateway`、`reviewService.integration`（真 PostgreSQL：整包审查、第二遍、重试一次、回复核查与安全更正），改 `socketToolResult`（生产样本）、`deploymentEnvReachesTheContainer`、`saasAlignment`。
- **合同**：`packages/contracts/dashscope/contract.test.mjs`。
- **插座**：`consistency.test.mjs`，用网关桩替掉原来假设子代理审查者的用例，加同对话追问的尝试次数。
- **反腐层**：`runtimeUiReplyChecks`、工具视图与解析。
- **外壳**：`replyChecks.test.ts`。
- **MCP**：`reference_list` 三个用例。
- **线上修复（15.5）**：
  - 域：`reviewEditorSchema`、`editorSaidNothing`、回复参考文献定位，各有用例；
  - 控制面：再问一次与 `review_editor_empty`、截断码、读者视图（三遍的集成测试）、日期行；
  - 部署：控制器环境的推导测试，改前的 compose 上是红的；
  - 集成测试 330 个。

### 15.4 评测：审查者在真实线路上暴露的三个缺陷

`evals/tiered-review/run_eval.mjs` 用平台自己的模块跑：离线跑确定性部分；`--live` 时，参考文献走真实登记处，回复与编辑者走控制面真实的提示词、schema 和客户端；`--samples n` 每个模型用例采样 n 次（原则 11：一次回答是样本，不是结论）。

用例共 19 个（最初 14 个，线上事故又加了 5 个，见 15.5）：

| 组 | 用例 |
|---|---|
| 统计 4 | log OR 不跨无效线（09-22 综述里内核审查者的误判）、区间与 p 矛盾、估计值在区间外、APA 一致的对照 |
| 参考文献 3 | 带括号的 Lancet DOI、编造的 DOI、PMID 与 DOI 指向两篇 |
| 数字 1 | MR 报告里手打的估计值 |
| 编辑者离线 3 | 转述式 evidence 被丢；什么都没说的回答不算审查（15.5 第 8 条）及其对照：只答了一条"缺"也算回答 |
| 回复 5 | 问候是 L0、涉药无引用是 L1、UKPDS 34 主要比较被说反、同一句照原文说；参考文献列在一行「参考文献：」下的真实回答（15.5 第 7 条） |
| 编辑者在线 3 | 预埋一处数字矛盾、一处相关写成因果，外加一条忠实的对照论断；离引文 400–550 字的细节仍算有支持（15.5 第 4 条）；今年的检索日期不是笔误（15.5 第 11 条，护栏用例：小报告上不给日期也不复现，复现记录在用例里） |

结果：

- 离线 13/13（最终 16/16；按最终代码的在线全量 18/18，`results/2026-09-23T16-09-30-360Z-live.json`；日期用例两臂各 3/3，`…17-10-37…-live.json` 与 `…17-09-46…-live-no-date.json`）。
- 在线参考文献 3/3：括号 DOI 解析到 Crossref；编造的 DOI 两边查无此条；PMID 30153985 登记的 DOI 与条目的 DAPA-HF DOI 不符，判为不符。
- 回复 6/6：说反的三次都是 unsupported，并被判安全项 contradicted，依据是逐字原文"risk reductions of 32% … for any diabetes-related endpoint"；照原文说的三次都是 supported。
- 编辑者：修复前后差别很大，见下面三个缺陷。

1. **英文双引号截断字符串。** 探测里三条发现的 `fix` 分别只剩「改为」「将」「增加」。模型想写 `将"约 1.5 个百分点"改为…`，第一个引号在约束解码下闭合了字符串。第一次采样还因此提前结束了 findings 数组，只剩 1 条发现，漏掉了预埋的过度结论。修复：系统提示与 schema 描述规定 fix / reason 里用「」引用，原文里的英文双引号按 JSON 转义。修复后 fix 都是完整的一句。
2. **拼接的 evidence。** 模型把报告原文与来源原文拼成一条，有时换行，有时加「报告原文：」「来源摘录：」标签、套「」、用"；"连接。每一段都是逐字原文，但整体不是任何文本的子串，于是被规则丢掉：三次采样里有两次，两处预埋缺陷全部丢失。修复：
   - 整段找不到时，按换行与分号切开，去掉短标签与外层引号，逐段核，每段都必须找到（`evidenceLocated`）。截短逐字原文仍是逐字原文，规则没有放松：编造的一段照样让整条发现被丢，描述性的 evidence 照样被丢；
   - 提示里改为"evidence 只放原文本身；报告和来源对照着给就各占一行"。
3. **暂时性网络失败。** 一轮评测里连续五次 `review_model_unreachable`，随后恢复；同时间点的连通性探测 8/8 正常。修复：编辑者对暂时性失败等 5 秒重试一次；连不上的错误信息带底层原因码；评测脚本按同样方式重试。

修复后，编辑者 7 次采样（两轮各 3 次，外加一次计时）全部通过：两处预埋缺陷每次都找到，忠实的对照论断零误报，每遍 ¥0.12–0.17、86 s。对照论断上 2/3 的采样提了一条 weak_support："比值 0.80 的区间上限正好是 1.00（p=0.046），报告没写"。这是合理的编辑意见，用例里明确允许，理由写在 `cases.json`。

仍在的噪声是缺项被写成空 evidence 的 `missing_item`：每遍 1–8 条，全部按规则丢掉，只多花输出 token。提示里已经要求缺项只在 checklist 里答，还会有；这由指标 `open_science_review_findings_dropped_total{reason="evidence"}` 盯着。

### 15.5 上线与线上验证

**发布。** 六次，都走正常发布流程（增量镜像 → 清单 → 切换）：

`a18acdb62152` → `fdd9d7d4085e` → `c3001ea4ebeb` → `ebdcd814967f` → `6770b8559501` → `ee8759017e4c`

每次切换后就绪检查 26/26，其中 `review` 为 `{ok, enabled, model: qwen3.8-max-0902}`；`/api/me` 的 features 为 `{frontier: true, review: true}`；Prometheus 载入告警组 `evimed-review`。

**线上暴露的十一个缺陷。** 离线评测一个都没抓到。

- 第 1–5 条：用探针直接调网关、审生产上那份 64 KB 真实报告时发现；
- 第 6–9 条：09-23 按用户路径真跑一次交付和一次带引用回答时发现，其中第 6、7 条恰好是探针绕过的那段；
- 第 10–11 条：第 6 条修好后，第一次真正经提交路径走完两遍审查时发现。

| # | 现象（生产证据） | 根因 | 修复 | 发布 |
|---|---|---|---|---|
| 1 | 第一次审查交付包摘要为空，编辑者只看到清单，写了 14 条发现，全被证据规则丢掉（`rv_e1f8…`） | 控制面按 `workspaceRootForDelivery` 读文件，docker 运行时下它答的是容器内路径 `/workspace` | 读宿主机副本 `project.workspaceDir`，那个函数只为它的同步副作用调用；读不到任何文件时以 `review_package_unreadable` 失败，不送模型 | fdd9 |
| 2 | 发现里的引文写成 `4&#xb7;88%` | PubMed efetch 的数字字符引用没解码，读者看到的"逐字原文"不是论文印的样子 | `stripMarkup` 解码十进制与十六进制字符引用，`&amp;` 最后解码，防二次解码 | fdd9 |
| 3 | 清单 19 条一条没留（`rv_6ea4…`） | 模型把整个标签「E1（临床证据报告要素）写明…」当条目号抄回来，与 `E1` 对不上 | 条目号取开头的编号（E1 不会被读成 E10）；审查行记下编辑者实际答了多少（`editorAnswer`） | c300 |
| 4 | 4 条发现里 2 条建议删掉正确内容（`rv_fe1a…`） | 编辑者只看到引文前后 ±300 字，被判"无依据"的细节在同一篇摘要里、离引文 400–550 字 | 每个来源给一次全文（8,000 字以内），更长的给 ±1,500 字。评测用例 `detail-far-from-its-quote-is-supported`：宽窗 3/3 通过，`--narrow` 复现旧窗口 1/3，失败的两次都有删除建议 | ebdc |
| 5 | 两次审查都把思考用满 8,000 | 64 KB 报告 + 57 篇来源，8k 不够判完 | 思考上限 16,000，最大输出 32,000 | ebdc |
| 6 | 真实交付跑完、送达，审查表里没有它的行 | 运行时的启动参数由运行时控制器按它自己的环境生成，控制器从未收到 `OPEN_SCIENCE_REVIEW_ENABLED`，所以每个运行时都是 `EVIMED_REVIEW_ENABLED=0`，提交从不请求审查，而就绪检查与 `/api/me` 都说审查开着。同类还漏了运营者名单和两个网页搜索变量；后者只影响内核自己的 web 注册表，MCP 的 `web_search` 由控制面写地址，照常可用 | compose 把这四个变量传给控制器；测试改为从启动计划自身推导：遍历 `buildRuntimeLaunchPlan` 读的每个配置项，问 `loadConfig` 哪些变量能改动它，Web 收到而控制器没收到就失败（签名密钥、状态存储、端口三项按设计豁免，写明理由）。改前的 compose 上这个测试是红的 | 6770 |
| 7 | 一条带引用、列了 PMID 的回答，核查行 `done`，0 条判定，没调模型 | 回复解析沿用报告的参考文献定位，只认 `## 参考文献` 标题；这条回答写的是单独一行「参考文献：」。persona 只要求列在「参考文献 / References 下」，没有规定标题形式 | 回复用自己的定位：Markdown 标题里带这些词，或一行只有这个词（可加粗、可带冒号）。封闭词表的格式判定，原则 5 允许。评测加这条真实回答，要求读出 4 句 | 6770 |
| 8 | 审查通过、0 条发现、清单 0/19（`rv_e127…`，¥1.24） | 编辑者思考了 10,592 token、逐条判过清单、定下了发现，输出时却把数组空着闭合（约束解码下，本该写 `{` 的地方采样出 `]`）。同一请求本地重放 6 次，2 次如此 | 按包生成 schema：清单与验收项恰好 n 条、编号取问到的，findings 至少 1 条（无问题写 `none`）。本地对照：只强制清单，5 次里仍有 2 次跳过发现；连 findings 一起强制，14/14 完整，`none` 一次没用到。另加兜底：什么都没说就再问一次，再空记 `review_editor_empty`，不当作通过 | 6770 |
| 9 | 约 27 次调用里有 2–3 次回答无法解析 | 其中一次写了 119 条发现、每条证据约 900 字，在 32k 输出上限处截断（`finish_reason: length`） | schema 限 findings 至多 25 条，与提示里的数字同一个常量；记录 `finish_reason`，截断单独报 `review_model_truncated` | 6770 |
| 10 | 两遍审查之后，运行的通知说「没有发现需要处理的问题」，而第二遍的 25 条发现里有 11 条的原文还在报告里 | 读者看到的是每个交付物最新的一次审查；第三次提交时编辑者已用满两遍，只剩确定性核验，它自己没有发现 | 读者视图并入最后一遍编辑者的发现：编号带遍次（`2.F07`），各自带上作者的回应，原文已不在交付包里的记为 `resolved`；摘要写"已修 / 不改并说明 / 未回应 / 其余建议未处理" | ee87 |
| 11 | 第二遍把检索日期「2026 年 9 月 23 日」说成"明显为笔误或占位符" | 编辑者不知道今天的日期，用的是训练数据里的"现在"。在那份真实简报上重放：不给日期 3 次里 1 次要求核对是否占位，给了 0/3 | 编辑者消息开头写"今天是 YYYY-MM-DD（UTC）"，日期来自服务的时钟（原则 17）；写在消息里而不是系统提示里，系统提示保持逐字节不变，提供方的缓存照样命中 | ee87 |

**这一轮学到的。** 直接调网关的探针证明的是网关，不是功能：第 6、7 条都在探针绕过的那段里。所以最终验证走用户路径：派发 → 运行 → 提交 → 审查行 → 通知；真实回答 → 核查行 → 判定。

**最终验证（`ee8759017e4c`）。** 走用户路径，账号 cdss-access，项目 review-tiered-0923：

- **运行时**：镜像 `…-ee8759017e4c`，`EVIMED_REVIEW_ENABLED=1`。上线前每个运行时都是 0。
- **L2**：一次 clinical-evidence-synthesis 真实交付（`run_61eaa729…`），11.7 min 送达，提交三次：
  - 第一遍编辑者 260 s、¥0.65，6 条发现里 5 条定位成功；作者回应 3 条已修、2 条不改并说明理由。
  - 第二遍 153 s、¥0.49，3 条全部已修。
  - 第三次只做确定性核验。
  - 运行结束的通知第一条是审查摘要「有 3 条审查发现（已修 3，不改并说明 0，未回应 0）」；账本 purpose `review` 两行，`run_id` 已归属。
- **上一版的那次交付**（`run_59d16d60…`，21 min，两遍 ¥0.83 + ¥0.72）：读者视图改完之后如实显示第二遍的 25 条——已修 2、原文已改掉 13、仍在 10。仍在的 10 条全是建议级，包括那条把 2026 年说成笔误的。
- **L1**：真实的带引用回答（`run_867b7013…`），核查行 1 句 supported。上一版同一路径的回答 3 句：2 句 supported，1 句 partial。partial 判得对：摘要没提回答里说的"开放标签"。耗时 8.5 s，¥0.033。
- 就绪 26/26；每次探测后登出，`/api/me` 均为 401。

### 15.6 核对中顺带发现（不在本方案范围）

- **公共仓库里有一份医院 TDM 数据**：`uploads/20260805-083307-9s4rdm/20260803TDM.xlsx`，在提交 f171bdb5c 里，uploads 下共 1,382 个文件被跟踪。要不要从仓库和历史里移除，是你的决定（和 Java 硬编码 key 那次一样，需要改写历史）。
- **生产上两个高频错误码**，09-20 以来：`public_source_evimed_evidence_credential_missing` 196 次，`model_gateway_unavailable` 121 次。本方案没有处理，单独排查。
- **余额见底时，前沿动态的 402 被记成"结果不明"。** 那段时间 569 条账本行是 `uncertain`，不是 `released`：提供方明确拒绝、没有计费的调用，被当成可能已计费。审查者的客户端用的是同一条规则（发出去了、没有用量，就记 `uncertain`；测试里写明了），模型网关也是。402/401/400/404/429 这类错误响应该不该直接释放，是账本的口径问题，要三处一起改，没有在本方案里动。
- **开发机连 DashScope。** Node 的 happy-eyeballs 给六个地址各 250 ms，连接超时报 `UND_ERR_CONNECT_TIMEOUT`，而 curl 0.2 s 就连上。只影响本机评测，生产不受影响；本机跑评测时加 `NODE_OPTIONS=--network-family-autoselection-attempt-timeout=2500`。

## 16. v1.2：你的决定与线上结果（2026-09-24）

### 16.1 决定

| 第 13 节 | 你的决定 | 做了什么 |
|---|---|---|
| 1. Jev 上生产 | 上 | L1 先过 Jev，只落它有把握且安全的句子，其余照旧送 Qwen（16.2） |
| 2. 写作换 pro | 先不换 | 未改。继续看 L2 账本 |
| 3. CONSORT / TRIPOD+AI | 计划阶段先声明研究类型再挂，交付物里也放 | 16.3 |
| 余额提醒 | 已充值 | 平台加了告警，账本口径一起改（16.4） |
| 15.6 的 TDM 数据 | 不移除，留作测试数据 | 未动仓库与历史 |

### 16.2 Jev 进 L1

- **规则。** 一条带引用的回答，先整批问 Jev「所引来源是否支持这句」。满足三条的句子直接记 `supported`（`by: "jev"`）：
  - Jev 说支持；
  - 置信度 ≥ 0.8，门槛钉在 `deps-version.json` 的 `typesafe.review.supportConfidence`；
  - 句子不含药名。

  其余句子送 Qwen，包括 Jev 不确定的、它认为不支持的（⚠ 要引原文，只有 Qwen 给得出）、含药名的（安全判断要逐字证据）。Jev 关闭、拒答、出错或超单次上限时，全部由 Qwen 判，等于 v1.1 的行为。
- **依据。** 按本模块的问法，在 101 对真实与植入缺陷的句—源上：
  - Jev 答对 100；
  - 0.8 门槛下落定 40 条真支持里的 37 条，没有落错；
  - 唯一一次错判"支持"的置信度是 0.73。

  药名句不交 Jev，因为药师警示它漏了 11/73，词表匹配是 73/73。
- **计价。** Jev 按美元计费，账本是人民币。价目表 `evimed-reference-2026-09-24` 按 CFETS 汇率 6.7489 折算，一行一模型。
- **密钥。** 放在宿主机 `/srv/evimed-science/shared/secrets/typesafe.api-key`（root 0400）；`.env` 只写路径，运行时容器不持有。
- **线上结果**（`run_9ba4b706…`，cdss-access）：
  - 回答结束后 5 s 核查落定；
  - 4 句中 Jev 落定 1 句，3 句送 Qwen；
  - 账本 Jev ¥0.00071（2,511 token），Qwen ¥0.0388；
  - 就绪检查 `review.jev = {enabled: true, model: "jev-1.13.0"}`。

### 16.3 研究类型与报告规范清单

- **计划。** `evimed_plan` 的交付物加可选字段 `studyType`，词表在 `packages/domain/src/study-types.json`（数据，方法学人员可直接改）：

  | 类型 | 规范 |
  |---|---|
  | rct | CONSORT 2025 |
  | prediction-model | TRIPOD+AI |
  | systematic-review | PRISMA 2020 |
  | mendelian-randomization | STROBE-MR |
  | observational / diagnostic-accuracy / other | 暂无，照样声明，委派简报和审查者会写明设计 |

- **交付物。** manuscript-support 与 research-grant-development（1.1.0）多一个可选产出 `reporting-checklist.md`：规范条目原样抄录，逐条写「报告位置」。
- **审查。** 编辑者除契约自己的清单，再加该研究类型的整份清单：CONSORT 2025 C1–C30，TRIPOD+AI T1–T27。
- **线上结果**（`run_cfb13f0e…`，manuscript-support，一项已完成 RCT 的方法与结果两节，32 min 送达）：
  - 计划给两个交付物（`ms-methods-results`、`consort-checklist`）都声明了 `rct`；
  - 两个交付物各带一份 `reporting-checklist.md`，CONSORT 2025 的 30 条目、42 行原样抄录，逐行给出报告位置；
  - 审查每遍问 39 条（契约 9 条 + CONSORT 30 条），两个交付物各两遍，共 ¥3.03，每遍 257–418 s；
  - `consort-checklist` 两遍都是 30/30 在；
  - `ms-methods-results` 第一遍 22 在、6 不适用、2 条原文没定位到，第二遍 24 在、6 不适用。不适用的是标题、摘要、讨论类条目，这两节本来就不写。

### 16.4 账本与余额

- **4xx 直接释放。** 提供方明确拒绝、没有产出的调用（400/401/402/403/404/409/413/422/429）不会计费，账本记 `released`（原因 `provider_refused_<状态码>`），不再记 `uncertain`。规则只写在一处，`usageLedger.closeUnsettledReservation`：模型网关（前沿动态经它）、审查者、Jev 都调它。
- **余额告警。** 余额拒绝单独计数：DeepSeek 为 402，DashScope 的 `400 Arrearage` 也计在 402 下。Prometheus 告警 `ModelProviderBalanceExhausted`（critical）在 10 分钟窗口内出现一次即报，按提供方分开。09-23 那次 569 行 `uncertain` 的情形不再发生。
- 同一版修了两条审查告警的表达式。

### 16.5 发布

- `evimed-c88e49d3d7d6-1`：Jev、研究类型、账本口径，与界面整改同一版；
- `evimed-b70f2f7f33e0-1`：会话列表一行一会话，交付文件卡片修正；
- `evimed-52b3a10ead0b-1`：侧栏的预热只用空位，不再挤掉下一个要打开的项目的运行时。

三次切换后就绪检查都是 26/26，`review.jev = {enabled: true, model: "jev-1.13.0"}`。每次探测后登出，`/api/me` 为 401。
