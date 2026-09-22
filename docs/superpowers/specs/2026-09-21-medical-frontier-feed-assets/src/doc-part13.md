
---

# 14. 定版修订：信源做成一个插件

业主 2026-09-22 的三条要求：复查方案并再看一遍 AIHOT 的仓库；把所有信源当作一个「数据库插件」——主要指知识库，不含 MIMIC 这类真实世界数据队列库和生信库——由团队维护，把现有的数据访问接口也放进去，让数据的爬取、访问、接入成为一个单独的插件，工作解耦；插件返回什么平台就先用什么，一批一批丰富，不断线上生效。这一章是照这三条做出的定版，覆盖前文与之相抵的段落（改在哪里，见 10.6 与本章各节末的指向）。

## 14.0 先说结论

1. **一个插件、一份契约、一个地址。** 753 个信源的登记表、调度、四个出口、九种读法、归一、去重、补全、健康，整体是一个独立服务「知识信源插件」（`evimed-knowledge-plugin`），团队维护、独立发版、自己的库。平台只认它的 HTTP 契约（`contract/knowledge-plugin-openapi.yaml`，v1.0），按游标拉条目，按需要正文。
2. **分工线画在「补全」和「初筛」之间。** 十五步管线的前五步（解析、归一、去残缺、信源内去重、补全）归插件，后十步（初筛、导读与打分、复核、标签、向量、事件、综述、精选与热度、撤稿传播、日报）归平台。所有花钱的模型调用都在平台，记在平台的用量账本上。
3. **平台照单全收，不等齐。** 契约只规定字段的形状，不规定哪些一定要有：插件返回什么，平台就用什么；没有摘要就走「仅标题」路径，没有文献类型就由模型先判，没有影响因子就不算这一项。插件每加一批信源、每补一个字段，平台不发版就能用上——信源公开页和卡片上的数据范围随插件的 `/v1/manifest` 变化。
4. **现有的数据访问接口迁入插件的查询面，消费者不变。** EviMed 的文献、指南、试验、说明书四个接口第三批起由插件包装成 `/v1/lookups/*`；平台的公开信源网关换供应商，运行时的 MCP 工具一个字不改。PubMed、Crossref、DOI 开放获取查询随后逐个迁入。生信与真实世界数据不迁。
5. **两个库、零耦合。** 插件库 `evimed_knowledge`（5 张表）与平台库 `evimed_frontier`（22 张表）在同一个生产 PostgreSQL 实例里，没有外键、没有共享连接；两份建表语句都已在本机各执行两遍。
6. **AIHOT 第二次复查补进 9 处、更正 5 处**（14.8），其中三处是建表语句的改动：事件并入的别名与重定向、事件之间的边、给下游副本的变更流。
7. **业主要多做一件事**：指定插件团队与仓库（第 9 章第 7 项）；密钥交给插件团队，平台只拿一个插件令牌。

## 14.1 范围：什么进插件、什么不进

| 进插件（知识源） | 不进插件（留在平台现有的公开信源网关与专科引擎） |
|---|---|
| 期刊（Crossref、PubMed、Europe PMC）、13 条 PubMed 查询流、预印本（medRxiv、bioRxiv、arXiv） | 生信库：GEO、GTEx、UCSC、cBioPortal、GDC、OMIM、ClinVar、dbSNP、Ensembl、UniProt、AlphaFold、STRING、Reactome、Human Cell Atlas、OpenGWAS、GWAS Catalog、Open Targets、gnomAD、CIViC、ChEMBL 等 |
| 监管与安全：openFDA（召回、短缺、说明书、Drugs@FDA）、FDA 官网栏目、EMA、MHRA、PMDA、WHO、国家药监局、药审中心、器审中心、卫健委、医保局、不良反应监测中心 | 真实世界数据与队列：MIMIC 等（平台今天也没有接入）；openFDA 不良事件（FAERS）的统计用途归药物安全引擎 |
| 指南与循证机构、学会列表页、HTA 机构、试验注册（ClinicalTrials.gov；ChiCTR 经 EviMed 接口） | 平台自己的知识库检索（`kb_search`）与记忆——那是用户的数据，不是信源 |
| 产业与媒体、公共卫生、科研与基金、AI 与医学、中文媒体、100 个公众号、学术会议页 | 网页读取 `web_read` 与联网搜索 `web_search`：研究运行按需读任意页面的通道，保留在平台（它们不是「信源」，是工具） |
| 业主的资料检索接口：文献、指南、指南段落、临床试验、说明书（`接口文档/EviMed医学证据检索.md`、`指南检索.md`） | 文档解析接口（`evimed-extract`）：它是处理服务不是数据源，保持现状 |
| 补全用的公开接口：PubMed esummary、Europe PMC 按 DOI、Unpaywall | 术语规范化（MeSH、RxNorm、OLS）：工具类，保持现状 |

一句话判据：**「今天有什么新东西」和「查一条已知的知识」归插件；「分析一份数据」「读一个网页」「查用户自己的库」不归。**

## 14.2 边界：插件做什么，平台做什么

| 事 | 插件 | 平台 |
|---|---|---|
| 登记表（753 行）：读法、地址模板、节奏、出口、梯队、权威、运营主体、选择器 | 拥有、修改、发版 | 每小时镜像一份，只读；显示开关 |
| 调度、令牌桶、条件请求、退避、首次接入保护 | 全部 | —— |
| 四个出口：直连、无头浏览器、东京代理、公众号桥 | 全部，含浏览器与 Wechat2RSS 容器、代理凭据 | 平台自己的 `web_read`、搜索和三个库仍用同一条东京代理 |
| 九种读法（适配器） | 全部；纯函数，用录下来的真实响应测试 | —— |
| 解析、归一、去残缺、字段白名单、未来时间夹到首见时间 | 全部 | 收到后再做一次白名单核对（防御性，不信任而验证） |
| 去重 | 信源内：外部键加内容哈希，400 天记忆；算出身份键 | 跨信源：按身份键查 `item_keys`，命中即「另一来路」；标题近似合并 |
| 补全：摘要、文献类型、MeSH、正文片段、开放获取、影响因子与核心期刊标签、试验事实、说明书段落 | 全部，平台按需索取（`/text`），插件自己排重试 | 12 小时挂起周期里再问一次；5 天后「无摘要」放行 |
| 信源健康、漂移、选择器自愈 | 全部；自愈是插件唯一的模型调用，用插件自己的密钥与小预算，次数进 `/health` | 展示；初筛通过率按信源每周导出给插件团队 |
| 初筛、翻译、导读、打分、数字复核、标签、向量、事件、综述、精选、热度、撤稿传播、日报、与你相关、推送、对话工具 | —— | 全部，模型调用全部记平台用量账本 |
| 读者看到的一切、用户状态 | —— | 全部 |
| 存储 | `evimed_knowledge`：sources、fetches、entries、entry_texts、seen_keys | `evimed_frontier`：22 张表（10.4.2） |
| 备份 | 团队自己：sources 与 seen_keys 每天导一份，其余可重爬 | 平台整库备份（item_vectors 只导结构） |
| 密钥 | NCBI、openFDA、EviMed 接口、Wechat2RSS、AgentBay 后备、东京代理凭据（共用文件）、自愈用的模型密钥 | 插件令牌；平台自己的东京代理凭据 |

**五个「永不」**，两边都要守：平台永不直连任何信源（信源公开页也读镜像）；插件永不调用平台（没有平台地址、没有平台凭据）；运行时永不直连插件（只经平台网关）；插件永不做生成内容的模型调用；插件永不保存任何用户数据。

## 14.3 契约 v1

文件：`contract/knowledge-plugin-openapi.yaml`（OpenAPI 3.1，10 个路径、17 个模型，引用已校验）。八条规则写在文件开头，这里复述：

1. **主版本 1 内只增不减。** 字段、枚举值、查询能力、流都可以在任何一次发版里加，不改名、不删除。平台忽略不认识的字段，不认识的枚举值按文档里的兜底处理（栏目 → 待定、来源类型 → 媒体、健康 → 退化）。
2. **`seq` 是游标。** 每条送出的条目带严格递增的 `seq`；`GET /v1/entries?after=<seq>` 按升序返回其后的条目。内容变了，同一个 `entry_id` 以更高的 `revision`、新的 `seq` 再送一次；同一 `(entry_id, revision)` 永不重送。
3. **条目是「一个信源的一次看见」。** 插件在信源内去重，按确定的阶梯算身份键：`doi:` > `pmid:` > `wx:<biz>:<mid>:<idx>` > `reg:<注册号>:<事件>:<日期>` > `fda:<申请号>:<补充号>` > `url:<sha256>`。跨信源合并是消费者的事，身份键让它变成一次查表。
4. **只有白名单里的字段。** 适配器只能产出 `Entry.facts` 与 `EntryText` 里点名的字段；上游带出的联系人邮箱、电话在适配器之后就不存在。
5. **旧东西的首次看见标 `backfill: true`。** 首次接入只把近 7 天当新条目送，更早的带标记送，默认列表不含。
6. **插件永不调用平台。** 一切交互都是平台去拉。
7. **保留是插件自己的**：条目送出后 30 天（平台要过正文的 90 天）、抓取日志 14 天、去重记忆 400 天、登记表与健康永久。平台发布了什么，平台自己留底。
8. **钱与模型。** 插件不做生成内容的模型调用；唯一的模型用途是页面漂移时提出新选择器，次数记在 `/v1/health`。

| 路径 | 用途 | 平台什么时候调 |
|---|---|---|
| `GET /v1/manifest` | 插件版本、契约版本、能力（流、正文、刷新、查询清单）、实际使用的词表值、信源统计、填充了哪些可选字段、限额、最早可用的 seq | 启动时，之后每小时；主版本不符则只拉不用 |
| `GET /v1/health` | 状态、各健康档的信源数、各出口是否通、积压、最近一次抓取与新条目时间、自愈调用数、最新 seq | 每 60 秒随拉取 |
| `GET /v1/sources`、`/v1/sources/{id}` | 登记表加运行健康 | 每小时镜像 |
| `GET /v1/entries?after=&limit=` | 归一化条目流，≤ 500 条一页 | 每 60 秒，`has_more` 则立刻续拉 |
| `GET /v1/entries/{id}`、`/text` | 单条；摘要、正文节选、补全字段（`status: available / pending / unavailable`） | 过了初筛的条目要正文时；12 小时后再问一次 |
| `POST /v1/entries/{id}/refresh` | 让插件重取正文（可选能力） | 只有运营手动用 |
| `GET /v1/lookups`、`POST /v1/lookups/{capability}` | 查询面：每个能力自带参数 JSON Schema、上游名、限额、一句覆盖说明；结果带 provider、fetched_at、coverage、missing | 第三批起，经平台网关供运行时工具调用 |

**`Entry` 的字段**（必填加粗）：**entry_id、seq、revision、source_id、identity_key、url、canonical_url、title、language、first_seen_at、content_sha256、backfill**；external_key、doi、pmid、registry_ids、summary（≤ 20,000 字符）、lane_hint、published_at、date_precision、defects（no-date、future-date、truncated-summary、short-summary、no-summary、encoding、link-derived、oversize-truncated）、text_status、facts（crossref_type、update_to、author_count、journal、issn、trial_phase、trial_status、trial_event、sponsor、recall_class、fda_application、fda_supplement、wx_biz、wx_author、wx_original、is_correction_notice、is_masthead）。**`EntryText`**：abstract、body_excerpt、text_kind、fetched_from、enrichment（publication_types、mesh、journal、authors_short、open_access、oa_pdf_url、impact_factor、core_journal_tags、preprint_of_doi、published_version_doi、trial_facts、drug_label_excerpt）。

**词表归平台，值写进契约。** 栏目（8 个加 `mixed`）、来源类型（6 个）、出口（5 个）、读法（11 个）的取值列在契约的枚举里；`packages/domain/src/frontierVocabulary.mjs` 与契约文件必须一致，一个测试盯着。插件想用新值，先加进契约（小版本），平台随后消费。

**鉴权与网络。** 静态令牌，运营写进主机上一个 0600 文件，只读挂进两个容器；插件只监听 compose 内网，没有公网端口；平台侧 `OPEN_SCIENCE_KNOWLEDGE_PLUGIN_TOKEN_FILE`。没有用户上下文，所以不用专科适配器那套带用户与项目声明的工作负载 JWT。

## 14.4 平台侧怎么接

- **一个客户端模块** `knowledgePluginClient.mjs`：六个方法、读令牌文件、8 秒超时、一次重试、具名错误码（`plugin_unreachable`、`plugin_incompatible`、`invalid_cursor` …）、契约主版本核对。与 `documentParserClient.mjs` 同形。
- **拉取循环在 `frontierWorker`**：每 60 秒 `entries?after=<meta.plugin_cursor>`，一页写一个事务（`entries` 插入、游标推进），`has_more` 就续；每小时刷新 `sources` 镜像与 manifest。游标落在插件的 `oldest_seq_available` 之前时，从那里重来并在指标里记一次「缺口」。
- **正文按需**：条目过初筛后 `held`，向插件要 `/text`；`pending` 则 12 小时后再问；5 天后「无摘要」放行。收到的正文与补全**快照进 `item_texts`**——插件会清，平台要留底。
- **钉版与契约测试**：`deps-version.json` 加一条 `knowledge-plugin`（契约版本、契约目录、备注）；`packages/contracts/knowledge-plugin/contract.test.mjs` 用真 HTTP 回放录自插件真机的样本（manifest、health、一页 entries、一份 text、一次 lookup、四种错误），`fixtures/provenance.json` 记录制时间与状态码。样本必须从真机录，不能手写——平台在这上面出过事（一份手写的线协议样本认证了错的形状，让一次审计失效）。
- **就绪检查** `frontier`：迁移已应用、工人已登记、插件 manifest 可读且主版本相符、词表值全部认识。信源读不到不红；插件不兼容标黄并附代码。
- **部署**：`deploy/web/docker-compose.knowledge.yml` 叠加文件——插件容器按镜像摘要钉住、只在内网、`cap_drop: ALL`、健康检查；它依赖的浏览器与 Wechat2RSS 容器（内存封顶、只准访问登记表里的域名）；给 web 追加五个 `OPEN_SCIENCE_KNOWLEDGE_PLUGIN_*` 键与令牌文件的只读挂载；这些键登记进「环境变量真的到了容器」那个测试。
- **网关换供应商（第三批）**：`publicSourceGateway.mjs` 的 `evimed-evidence` 配置加一个 `provider: plugin` 分支，把五个 EviMed 接口的调用改发 `/v1/lookups/*`，参数校验与返回形状不变；一个开关切回直连。运行时工具、能力包、评测集一个字不改。

## 14.5 插件怎么建（交给团队的建造说明）

- **语言与形态**：Python（团队现有六个引擎、本方案的全部探测与干跑工具都是 Python），一个 FastAPI 服务加一个调度进程，同一个镜像；独立仓库，镜像推到腾讯云容器镜像服务，每次发版记 manifest 里的 `plugin.version` 与 `build`。
- **起点**：`tools/dryrun_ingest.py`（已会读 Crossref、PubMed 补全、订阅源、开放接口，并踩出 10.2.4 的十个坑）、`tools/probe_registry.py`、`verify_feed.py`、`classify_registry.py`、`browser_probe.mjs`，以及 `sources.json` / `sources.csv`（753 行，两地实测结果在内）——随本章一并移交。第一批要做的头一件事是 10.2.9：把探测清单变成运行时登记表。
- **必须照做的规格**：10.2 全节（调度、令牌桶及其依据、条件请求、首次接入保护、适配器与十个坑、四个出口、健康与自愈、登记表），10.3.2 去残缺表（含未来时间一律夹到首见时间），10.3.3 的身份键阶梯，10.3.4 的补全顺序，第 11 章的公众号三层设计与身份键 `wx:biz:mid:idx`，第 12 章的三个 `evimed-api` 扫描。
- **存储**：`tools/knowledge-plugin-schema.sql`，同一实例里的第二个数据库 `evimed_knowledge`、独立角色；`entries.seq` 就是游标，`sources` 的到期索引就是队列。
- **出口依赖**：东京代理凭据文件（与平台共用，root 只读）；自己的 Chromium 容器（固定版本、内存封顶、域名白名单）；Wechat2RSS 容器与两个微信身份。
- **测试**：每种适配器用录下来的真实响应做单元测试；一条「登记表每一行都能装进 `sources` 定义」的装载测试（缺字段、词表外的值、写死的日期都会红）；契约测试用同一份 OpenAPI 校验自己的响应。
- **不做的**：不登录、不付费墙、不抓全文、不绕防护、不隐身、不调用平台、不存用户数据、不做生成内容的模型调用；带出个人信息的字段在适配器就丢掉；日志里不出现任何密钥与检索词。

## 14.6 批次：插件一批一批加，平台照单全收

| 批 | 插件交付（团队） | 平台交付 | 怎么线上生效 | 验收 |
|---|---|---|---|---|
| 0 · 契约（约 2 天，两线） | 契约 v1.0 定稿，开发实例起 manifest / health / sources / entries（空流也行） | 客户端、拉取循环、镜像；从开发实例录样本进契约测试；钉版 | —— | 契约测试两侧都绿 |
| 1 · 能读（第一阶段） | 运行时登记表；六种读法；受保护抓取；267 个直连信源；`/text` 的 PubMed 与 Europe PMC 补全 | 库表、选、页面、登记（第 8 章第一阶段） | 插件发版；平台发版一次 | 第一阶段验收线，加：插件停机 1 小时页面照常、恢复后续拉不漏不重 |
| 2 · 能广（第二阶段） | `browser-list`（四个监管站）、中文媒体与学会列表页、选择器自愈、经东京代理的境外信源、100 个公众号、三个 `evimed-api` 扫描、影响因子与核心期刊标签、说明书段落、试验事实 | 事件、日报、与你相关、推送、往下接、对话工具（第二阶段）；卡片显示 enrichment 里新到的字段 | 插件按周发版；**新信源与新字段平台不发版**（镜像与 manifest 自动带出）；平台只为消费新字段的界面改动发版 | 第二阶段验收线，加：插件清单里新增的信源与字段不改平台代码即出现 |
| 3 · 查询面 | `/v1/lookups`：EviMed 文献、指南、指南段落、试验、说明书五个能力 | 公开信源网关 `evimed-evidence` 换到 `provider: plugin`，一个开关切回 | 平台发版一次，之后网关不再改 | 五个运行时工具对同一批问题的返回与直连逐字段一致；切回开关有效 |
| 4 · 查询面扩展 | `pubmed-search`、`crossref-works`、`doi-open-access`；第三梯队其余信源；会议日历用的会期字段 | 网关按能力逐个切换 | 同上 | 同上 |
| 5+ · 持续 | 每批：新信源、新字段、新能力，manifest 声明 | 只在要消费时改界面 | —— | 每批一份验收记录 |

**验收留痕。** 每次验收写一份 `research/acceptance-runs/<时间戳>.md`：命令、退出码、证据、逐项通过与否，验收人不是构建人（借 infosechot 的做法）。10.5.10 的空跑一周也照此记录。

**「先用什么」的消费规则**，写进平台代码：没有 `summary` → 仅标题路径；没有 `publication_types` → 证据类型由模型先判，类型到了再由程序改正（10.3.8）；没有 `impact_factor` → 来源权威分只用登记表的权威等级；没有 `owner_entity` 的旧条目 → 按信源计独立来源并标记；`lane_hint` 为 `mixed` 或缺失 → 初筛模型定栏目；不认识的枚举值 → 兜底并计数，计数超过阈值告警而不是拒收。

## 14.7 现有数据访问接口迁入插件的顺序

| 接口 | 今天的路径 | 插件里的样子 | 批 | 消费者 |
|---|---|---|---|---|
| EviMed 文献 `v2/literature-guide`、指南 `review/api/guide`、指南段落 `guide-block`、试验 `v2/clinical-trial`、说明书 `v2/instruction` | 运行时工具 → 公开信源网关（`evimed-evidence` 配置注入密钥）→ `www.evimed.com` | `lookups/literature-search`、`guideline-search`、`guideline-blocks`、`clinical-trial-search`、`drug-label`；密钥在插件 | 3 | `literature_search`、`guideline_search`、`clinical_trial_search`、`drug_label_search` 不变 |
| 同上接口作为信源 | 无 | `evimed-api` 读法：ChiCTR 每日、指南每周、补全（第 12 章） | 2 | 前沿动态 |
| PubMed E-utilities、Crossref、Europe PMC、OpenAlex、Semantic Scholar、arXiv、ClinicalTrials.gov、ISRCTN | 网关白名单直连 | `pubmed-search`、`crossref-works`、`europepmc-search` … 逐个加；密钥（NCBI）在插件，与平台共用同一把——限额按密钥计，两侧合计每秒 10 次，插件只用三成 | 4 | `biomedical_source_search` 的文献类来源、`search_papers`、`search_biomedical_records` 不变 |
| Unpaywall 开放获取解析 | 网关 `unpaywall` 配置 | `doi-open-access`；插件补全也用它 | 4 | `open_access_full_text` 不变 |
| DailyMed、RxNorm、PubChem、OLS、PubTator3 | 网关直连 | 术语与说明书查找，视团队进度 | 5+ | 不变 |
| GEO、GTEx、OMIM、cBioPortal、OpenGWAS、Open Targets、gnomAD … 66 个生信源里的非文献部分 | 网关直连（三个经东京） | **不迁** | —— | —— |
| `web_read`、`web_search`、`kb_search`、文档解析 | 平台网关 | **不迁** | —— | —— |

每一步都是「换供应商、消费者不变」：网关配置多一个 `provider` 值，一个开关切回直连，契约测试对同一批问题逐字段比对两条路径的返回。

## 14.8 AIHOT 与 infosechot 的第二次复查

复查了本机的五个参考仓库（拉了上游：只有精选镜像有 4 个新提交、16 条新精选，无设计变化；官方 Skill 仍是 v1.7.1）和线上匿名只读接口（OpenAPI 自报 1.3.0），逐条对照本方案。**补进方案的 9 处**：

| # | AIHOT 的做法（依据） | 方案原来 | 现在 | 改在 |
|---|---|---|---|---|
| 1 | 事件并入后旧编号 308 永久重定向（api.md:107） | `events.public_id` 唯一，无并入记录 | `events.merged_into` 加 `event_aliases`；事件页与工具对旧编号回 308 | 4.4、6.4、7.3、建表语句 |
| 2 | 事件之间有边：storyline / related（StoryNeighbor） | 事件层是平的 | `event_links`：follows、supersedes、preprint-of、retracted-by、corrected-by、related；事件页「相关事件」 | 4.4、6.4、建表语句 |
| 3 | 热点榜按最近活跃排，事件不因年龄出榜（实测榜首事件已 5 天） | 「近 72 小时热度前 10」按事件年龄截断 | 窗口作用于衰减不作用于事件；`events.heat` 是衰减和，不设年龄上限 | 4.4、6.4 |
| 4 | 报道数、信源数、参与者数是三个量（hot-topics：sourceCount 18 / signalCount 11 / participantCount 27） | 只有一个 `source_count` | `source_count_72h`、`report_count`、`entity_count`；独立按运营主体 | 6.4、建表语句 |
| 5 | 综述可空、按需写（实测 27 篇报道的活跃事件 `digest=null`） | 每个事件都写 | 上榜或含一手来源才写；`digest_state`；界面「暂无综述」 | 4.4、6.4、10.3.1 |
| 6 | 日报自带窗口起止，空栏目直接消失，成稿留延迟（windowStart / windowEnd，generatedAt 晚 59 分） | 只有 `day`；八栏「保底 1 条」；07:30 日切即定稿 | `window_start / window_end / generated_at`；07:00 日切、07:30 定稿；只收已有导读的；清淡日不凑数 | 4.5、6.4、建表语句 |
| 7 | 两条时间轴并存（`by=published` / `by=timeline`），切换即游标失效 | 单轴 | `items` 接口加 `by=`，`published_at` 上加索引 | 7.3、建表语句 |
| 8 | 翻页非一致性快照；稳定错误码；`invalid_cursor` 必须显式从第一页重来（errors.md:20–28） | 未写游标失效契约 | 游标编入时间轴、视图、内容版本；`400 invalid_cursor`；界面「有 N 条新的」 | 7.3、10.5.2 |
| 9 | 对下游副本有 `op=upsert / remove` 的变更通道；「时间窗表达不了 remove」（sync.md:53） | 无 | `item_changes`（留 90 天）；知识库副本与飞书据此处理撤稿与撤下 | 6.6、10.4、建表语句 |

**更正第 1.2 节里记在 AIHOT 名下、材料不支持的 5 处**：事件页没有「热度走势」，接口不返回热度值也禁止推算；热点榜不是「近 48 小时」——48 小时是收束条件，不是榜单窗口（因此方案原先「改成 72 小时窗口」的前提不成立，已改为衰减）；周报、月报只有网页没有接口，日报按条目而不是按事件呈现；条目没有标签字段，只有单值 `category`；「38 个主题」「收藏存浏览器本地」「自称 168 个信源」是站点自述，接口与仓库里无法证实——已标注。

**从 infosechot 借的 3 处**：未来时间戳一律夹到现在（它的 ingest 里 `if (when > Date.now()) when = new Date()`，起因是中文订阅源把本地时间标成 GMT）——只挡「超过 24 小时」放得过 +8 小时的误标，已改（10.3.2）；「还有谁在说」不必等事件层，用另一来路的连接表在读时算，第一阶段卡片就有（4.3）；独立验收留痕（`verifier/runs/<时间戳>.md`，验证人不是构建人），已加进第 8 章与 14.6。**不借的 1 处**：它用正则分类、用关键词加热度分——正是平台原则 1 与 5 禁止的「正则做语言」。

## 14.9 其余修订

- **登记表里 `news` 组的栏目值**：原稿写「并入综合资讯」，而八栏词表里没有这个值。改为 `mixed`，由初筛模型逐条定栏目（10.2.9）。
- **登记表加运营主体列**（`owner_entity`），热度按它数独立来源；11.6 早就这样要求，登记表却没有这一列。
- **配额按密钥计，不再按 IP 独占**：NCBI、openFDA 密钥两侧共用一把，限额合计；平台的研究运行与专科引擎照旧用平台那份配置，插件只用三成（10.2.2 的表不变）。
- **名字**：平台里已有 `sourceService`（知识库的「来源」）。插件相关的代码一律用 `knowledgePlugin*` 前缀，前沿动态模块仍是 `frontier*`；文档里「信源」指登记表里的东西，「来源」指知识库的东西。
- **删掉的平台文件**：`frontierFetch.mjs`、`frontierAdapters.mjs`、`packages/domain/src/frontier-sources.json`、`docker-compose.frontier.yml`、`OPEN_SCIENCE_FRONTIER_FETCH_CONCURRENCY`、`_CONTACT`、`_BROWSER_URL`；平台代码量约少三成。
- **主机内存**：多一个常驻容器（约 300–500 MB，渲染时再加约 300 MB）落在一台交换区已满的主机上；插件第一批上线前先量一次空闲内存，不够就先把浏览器容器的内存封顶降到 512 MB、并发降到 1。
- **7.2 节的文件清单**：少了三个、多了三个（客户端、契约目录、compose 叠加）；7.4 的配置键换成五个 `OPEN_SCIENCE_KNOWLEDGE_PLUGIN_*`。

## 14.10 风险与对策

| 风险 | 对策 |
|---|---|
| 插件团队进度落后，平台等米下锅 | 第 0 批只要一个空流就能接通；第一批的雏形是 `dryrun_ingest.py`，已经会读四类信源；平台第一阶段可以先接开发实例 |
| 契约反复改，两边互相等 | 主版本 1 只增不减；新字段先加进契约再实现；平台忽略不认识的字段；每批一次契约测试 |
| 插件停机，页面空白 | 平台只读自己的库，插件停了页面照常，顶部注明最近更新时间；游标续拉不漏不重 |
| 插件送来脏数据（个人信息、超长、错栏目） | 白名单在插件；平台收到再核一次白名单与长度；不认识的枚举兜底并计数；第 03 步的去残缺表在两侧都有 |
| 两侧都调 NCBI、openFDA，把限额吃光 | 同一把密钥，限额按密钥计；插件令牌桶设成三成；429 时插件整主机暂停（10.2.2） |
| 团队在插件里偷偷用模型写摘要，花费不进账本 | 契约第 8 条；`/health` 报模型调用数；平台监控该数超过每天 50 次告警 |
| 主机内存不够 | 先量再上；浏览器容器内存封顶可调；插件的库与平台同实例，不另起引擎 |
| 一次插件发版改了身份键的算法，所有旧条目被当成新的 | 身份键阶梯写在契约里，是主版本内容；契约测试里有一组固定输入到固定键的样本 |

## 14.11 定版一览

| 事项 | 定版 |
|---|---|
| 做什么 | 「前沿动态」一个页面：精选、热点、日报、全部；八个栏目；753 个信源 |
| 信源怎么来 | 全部经团队维护的**知识信源插件**；平台按 `seq` 游标拉、按需要正文；契约 v1.0 |
| 分工线 | 解析、归一、去残缺、信源内去重、补全归插件；初筛及其后归平台；所有花钱的模型调用在平台 |
| 范围 | 知识源进插件；生信库、真实世界数据、网页读取、搜索、知识库检索、文档解析不进 |
| 现有接口 | EviMed 五个接口第三批迁入插件查询面，网关换供应商，工具不变；PubMed、Crossref、Unpaywall 第四批 |
| 出口 | 直连、无头浏览器（自有 Chromium）、东京代理、Wechat2RSS 桥——都在插件里 |
| 期刊 | Crossref 加 PubMed，不爬出版商站 |
| FDA | openFDA 与 Federal Register；官网栏目用如实的爬虫标识从北京直读 |
| 国内监管站 | 插件的无头浏览器；AgentBay 只作后备 |
| 公众号 | Wechat2RSS 出列表、北京读全文；100 个号，第二批 |
| 指南 | 读学会列表页；EviMed 指南索引每周复查（滞后半年） |
| ChiCTR | 经 EviMed 接口（唯一读法） |
| 数据库 | 同一生产 PostgreSQL 实例，插件库 5 张表，平台库 22 张表，零耦合 |
| 事件 | 衰减热度、不按年龄出榜；并入有别名与 308；事件之间有边；综述按需写 |
| 日报 | 07:00 日切、07:30 定稿，窗口存档，只收已有导读的，不凑数 |
| 模型与花费 | 全部 deepseek-flash；不含「与你相关」每月约 240 元，与用户数无关 |
| 搜索 | 百炼加东京 SearXNG（已上线；不是信源的读法） |
| 分期 | 契约 2 天；第一阶段约 1.5 周、第二阶段约 1.5 周，两线并行；之后插件按批发版，平台照单全收 |
| 业主要做的 | 第 9 章 7 项：NCBI 密钥、openFDA 邮件里的密钥、Wechat2RSS 授权、两个微信号、31 个文章链接、飞书扫码、**指定插件团队与仓库**；再加一句「开始」 |
