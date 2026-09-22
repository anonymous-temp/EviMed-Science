
---

# 附录 B　AIHOT 实测明细

数据来源：它的公开接口 `/api/v1/items?mode=all&window=7d`（翻完 28 页）、`/api/v1/hot-topics`、`/api/v1/stories/{id}`、`/api/v1/dailies`，以及第三方镜像仓库里的 4,014 条历史精选。

**近 7 天全量池里条目最多的信源（条目数 / 其中精选）**

| 信源 | 条目 | 精选 |
|---|---|---|
| IT 之家（RSS） | 493 | 3 |
| X：Rohan Paul | 163 | 1 |
| Hacker News 热门（中文翻译） | 140 | 3 |
| X：Alexandr Wang | 130 | 1 |
| X：Kim | 87 | 0 |
| TechCrunch：AI（RSS） | 80 | 2 |
| HuggingFace Daily Papers | 76 | 1 |
| Hacker News：AI 热帖 | 60 | 4 |
| The Decoder（RSS） | 49 | 3 |

**历史精选里出得最多的信源**：IT 之家 245、Hacker News 热门 212、HuggingFace Daily Papers 178、Hugging Face 博客 135、OpenAI 官网动态 128、OpenRouter 公告 97、Claude 博客 87、The Decoder 73。历史精选按类别：产品 983、技巧与观点 965、模型 624、行业 569、论文 475。

**它的数据模型（对我们第 6 章的直接参照）**：条目有 `title`、`originalTitle`、`summary`、`reason`、`source.name`、`links.original`、`publishedAt`、`discoveredAt`、`category`、`score`、`selected`；热点只给 `rank`、`sourceCount`、`signalCount`、`sourceNames`，不给热度值；事件有 `digest`（随事件更新的综述）、`latest`、`reports` 时间线、`status`（超过 48 小时无新报道为 settled）、`storyline` 与 `related`；日报有 `lead`、`sections`、`flashes`。

**它公开的管线口径**（来自第三方拆解文章，未经它官方确认）：初筛用小模型、通过率约三成；打分四个维度是信源权威 30%、内容新颖 25%、行业影响 25%、实用价值 20%。

# 附录 C　本次核查怎么做的，怎么复跑

所有材料在 `docs/superpowers/specs/2026-09-21-medical-frontier-feed-assets/`：

| 路径 | 内容 |
|---|---|
| `sources.json` / `sources.csv` | 登记表：每个信源的读法、入口、备用入口、节奏、两地核查结果、出口、梯队、备注 |
| `stats.json` | 正文里引用的全部计数 |
| `research/*.jsonl` | 十个分片的原始调研记录（每行一个信源，含核查工具的原始输出） |
| `research/probe-dev.jsonl`、`probe-prod.jsonl` | 整表从本机、从生产机各读一遍的结果 |
| `research/aihot-measured-7d.json` | AIHOT 7 天实测的分类计数 |
| `tools/verify_feed.py` | 单个地址探测：状态码、类型、条目数、最新日期、近 7 天条数、质询识别（Cloudflare、瑞数、阿里云与火山引擎 WAF、Akamai、Incapsula、DataDome）、空壳页识别 |
| `tools/probe_registry.py` | 整表探测，`local` 或 `ssh:<主机>`，可续跑；对远端只通过标准输入传脚本，不落任何文件；`--egress relay,browser` 只测某个出口的那一批（境外主机验收用） |
| `tools/resolve_journals.py`、`journals.tsv` | 期刊名 → ISSN → Crossref 与 PubMed 近 7、30 天篇数 |
| `tools/merge_registry.py`、`classify_registry.py` | 合并去重；定出口与梯队；生成 CSV、附录与计数 |
| `tools/dryrun_ingest.py`、`research/dryrun-p0-2026-09-21.json`、`research/dryrun-findings.json` | 对首发信源的采集干跑（可续跑，原始响应有缓存）、它的全部统计、以及据此对登记表做的修正（由 `classify_registry.py` 读取） |
| `tools/frontier-schema.sql`、`frontier-schema-smoke.sql`、`check_schema.sh` | `evimed_frontier` 的完整建表语句、样例数据与关键查询、在本机 PostgreSQL 上的校验脚本 |
| `tools/wechat_article.py` | 公众号文章页 → 标准记录的纯函数解析器（11.4） |
| `tools/wechat_trial.py` | 100 个号的试跑：免登录的种子与搜狗测量、Wechat2RSS 的订阅、读取与健康检查、微信读书登录备用；可续跑，原始页面缓存在状态目录 |
| `research/edge-acceptance-2026-09-22.md` 及同日的 `probe-edge*`、`probe-prod-honest-ua`、`edge-browser`、`search-compare`、`push-latency-*`、`wechat-search-engines` | 海外节点验收：两种标识的两地探测、推送延迟、东京无头浏览器、两地搜索对比、搜索引擎找公众号链接（10.2.5） |
| `tools/browser_probe.mjs`、`research/regulator-browser-2026-09-22.md` | 用自有无头浏览器打开监管站列表页的测试脚本与两地实测记录（10.2.6） |
| `tools/evimed_api_freshness.py` | EviMed 资料检索接口的索引新鲜度测量；9 月 22 日在生产机上跑过一次，记录在 `research/evimed-freshness-2026-09-22.jsonl`（12.2） |
| `research/wechat-accounts-100.jsonl`、`wechat-trial-2026-09-21.json`、`wechat-routes-2026-09-21.md` | 100 个号的清单、试跑统计、各条路的实测与出处 |
| `research/design-review-2026-09-21.md`、`design-review-own-findings-2026-09-21.md` | 第 13 章的两路复查原文 |
| `research/upstream-limits-2026-09-21.md`、`upstream-limits-detail-2026-09-21.md` | 上游接口的限速与模型价格核对 |
| `src/` | 十张图的源文件、正文分段、组装与导出脚本 |

复跑：`merge_registry.py` → `probe_registry.py local …` 与 `probe_registry.py ssh:evimed …` → `classify_registry.py` → `src/make-charts.py` → `src/render.mjs` → `src/build-doc.py` → `src/export-pdf.mjs`。

核查中踩到、实现时要记住的几件事：

- **Crossref 匿名池对并发很敏感。** 8 并发探测时 155 个期刊接口有 126 个返回 429，串行后 155 个全部正常。采集器对 Crossref 必须串行、每秒至多 1 次，并带联系邮箱进礼貌池。
- **PubMed 的 `jsubsetaim`（核心临床期刊子集）在 E-utilities 里已经失效**，查询不报错但命中为零；「核心期刊里的 RCT」这条查询流改用显式的 26 种期刊列表。
- **PubMed 的订阅源可以无浏览器创建**（对 `/create-rss-feed-url/` 发 POST，字段名是 `name` 和 `limit`），但不依赖它；主路线是 E-utilities。
- **Crossref 每周能看到约 1,200 条撤稿更新，PubMed 同期只有 23 条**，因为 PubMed 要等 MEDLINE 标注文献类型。撤稿监测订 Crossref。
- **OpenAlex 已改为按额度计费的模型，匿名请求共享按 IP 的每日额度，当天已用尽；Altmetric 在 2025 年 11 月关闭了匿名免费层。**
- **WHO 的新闻订阅源 2026 年 2 月之后没有再更新**，改用它的 OData 接口。
- **若干「返回 200」的假阳性**：药审中心首页 200 但没有任何条目；健康界 200 其实是阿里云 WAF 的质询页；丁香园的 atom 订阅源 200、78 条，但最新一条是 2022 年。核查工具现在要求列表页确有 8 个以上带文字的链接才算读到。
- **国内不少站点对境外 IP 关门，境外不少站点对国内机房 IP 关门。** 信源核查必须在爬虫真正运行的机器上做。
- **本机是一条台湾的家用宽带线路（AS3462），不是云主机。** 「境外读得到」的那一批信源，上线前要从真正的境外云主机再测一遍（10.2.5）。
- **「读得到」不等于「还在更新」。** 探测工具看的是状态码和条目数；《中国全科医学》的订阅源两项都正常，内容却停在 2021–2022 年，是采集干跑才发现的。
