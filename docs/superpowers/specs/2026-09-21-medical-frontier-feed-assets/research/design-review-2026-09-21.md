# Design review: 前沿动态 plan, chapter 10 + `tools/frontier-schema.sql`

Reviewer scope, as narrowed by the coordinator: sections 10.0–10.7 and the DDL, plus chapters 6–7 only where they contradict chapter 10. The DDL was reviewed as it stood at 14:07 UTC (after `identity_key` was added and `egress` switched to `relay`). Issues already known and being fixed are not repeated here: robots.txt applied to APIs, Chinese numerals escaping the number check, the egress vocabulary, Crossref 7-day rescans, the unique `md5(canonical_url)`, WeChat reposts inflating heat, and WeChat `chksm` links.

Claims about platform code were checked by grepping `OpenScience/apps/server/src`. All of the following are accurate: `callModelForControlPlane` (no timeout or retry of its own; it takes a `purpose`), `usagePurpose.mjs` with its auto-replaced CHECK, `PRODUCT_JOB_KINDS` with its constraint blocks, `KbEmbedder.embedDocuments`/`modelKey`, `MemoryRerank.order` (3 s, fail-open), `HostPacer` (refuses waits over 15 s), `RobotsPolicy` (1 h cache, `EviMedBot`), render off by default with a 30 s timeout, pool size 10, and no ETag or conditional-request precedent. Findings are ranked by severity.

---

## F1 · BLOCKER · Excluding table data from the backup breaks the backup's own restore check (10.4.6)

- **Plan:** 10.4.6 says 「备份脚本对 `item_vectors`、`fetches`、`edge_batches` 三张表只导结构不导数据」 and calls it 「一处小改」.
- **Code:** `scripts/ops/postgres-backup.py:31-39` (`COUNTS_SQL`) counts rows in every table of every non-system schema at snapshot time. After restoring into the drill database it counts again, and `if expected != restored: raise BackupError("restore_application_mismatch")` (≈l.947). The restore readiness check in `postgresBackupReadiness.mjs:95` requires `expectedTablesSha256 === restoredTablesSha256`.
- **Impact:** once those three tables have rows, every nightly drill restores them empty and fails. The platform then has no verified backup, backup readiness goes red (`postgres_backup_stale`), and because releases are gated on all-green readiness, releases stop for the whole platform.
- **Fix:** change the dump and the verification together. Pass the excluded tables to both `pg_dump --exclude-table-data` and `COUNTS_SQL` (expect 0 for them), record them in the receipt, and update `postgresBackupReadiness`. Add a test that runs a drill with one excluded table.

## F2 · MAJOR · `sources.json` cannot populate the `sources` table as specified (DDL, 10.2.2, 10.2.5)

- **DDL** requires `source_type NOT NULL`, `poll_interval_s`/`poll_floor_s`/`poll_ceiling_s NOT NULL`, `authority` and `bypass_scoring`. Section 10.2.2 says 「每个信源有下限和上限（登记表给定）」, and 10.2.5 says 「每条链接的主机名必须属于该信源登记过的主机名」.
- **Data:** the registry has none of these fields. It has only `cadence` (the source's publishing rhythm, e.g. `realtime`/`irregular`) and no host list, selectors, authority or safety flag. `lane` includes `news` (74 rows) and `conference` (34 rows), which are outside the 8-lane vocabulary items are validated against. The rows `pubmed-eutils-esummary`, `europepmc-doi-abstract-enrich` and `unpaywall-oa-status` are enrichment calls, not sources, yet they are counted in P0.
- **Endpoints are probe snapshots.** 163 of them (159 in P0) carry absolute dates or sample ids. For example, `openfda-drug-enforcement-api` uses `report_date:[20260801 TO 20260930]&limit=5`, esummary uses fixed PMIDs, and Unpaywall uses `email=unpaywall_01@example.com`. Loaded as they are, the openFDA sources return nothing new from 1 October, and nothing flags it.
- **The dry run inherited the same caps.** `europepmc-medrxiv-preprints` returned 100/100, `medrxiv-api-details` 100/100, `ctgov-phase3`/`ctgov-china` 50/50, and `crossref-retraction-updates` 20 of about 1,176 per week. So 10.1's 「每天 479 条」 is a floor; P0 is roughly 650+ per day.
- **Fix:**
  - Define a runtime registry schema: endpoint templates with `{since}`/`{cursor}`, `source_type`, `authority`, `safety`, `poll_floor`/`ceiling`, `hosts[]`, `allowed_lanes`, selectors and a date field.
  - Add a validator test that loads every row into the DDL.
  - Move enrichment calls out of the source list.
  - Re-run the dry run with uncapped paging.

## F3 · MAJOR · A compromised edge node can publish fake FDA safety alerts straight into 精选 (10.2.5)

- **Plan:** 「「安全通告直进精选」是信源行上的属性…节点无法把一条消息标成安全通告」. It puts the worst case at 「这些条目仍要过初筛、打分和数字复核」.
- **Data:** the edge (`relay`) set includes 「美国FDA 药物安全通讯」 and 「MedWatch 安全警示」, which are exactly the sources the DDL marks `bypass_scoring … official safety-alert feeds only`. A node holding the key only has to submit an entry for a leased source with an fda.gov URL; it then skips scoring and gets the red banner (and, in phase 3, an instant push). The number check compares against text the node itself supplied, so it provides no protection. The node's clock is also trusted: `entries.first_seen_at` is "the collector's clock", so a future-dated item would stay at the top of the timeline.
- **Fix:**
  - Items received from the edge never take the safety bypass. Either corroborate them through a direct channel (openFDA or Federal Register) or score them normally and label them 「经境外节点读取」.
  - Clamp `first_seen_at` to the window between lease time and `received_at`.

## F4 · MAJOR · Shared per-IP upstream quotas are budgeted as if the frontier were the only consumer (10.2.2)

- **Plan:** NCBI at 0.4 s intervals (2.5 req/s) and openFDA capped at 800 of the 1,000 requests per day per IP. The plan says the platform's openFDA users will manage with the remainder, and 10.4.4 claims 「在多实例下同样安全」.
- **Code:**
  - The public-source gateway calls PubMed and openFDA for every research run from the same host IP, unpaced, with the key optional (`publicSourceGateway.mjs:124-141` `optionalRateCredentials`; `config.mjs:406-407` `OPEN_SCIENCE_NCBI_API_KEY`/`OPEN_SCIENCE_OPENFDA_API_KEY`).
  - Co-located specialist engines call E-utilities directly: `科研选题/services/pubmed_service.py:28` (0.4 s with no key) and `meta/new_meta/tools/pubmed.py:226`.
  - NCBI's anonymous limit is 3 req/s per IP in total.
  - The per-host buckets and daily caps would be in-process memory. They reset on restart and double with two instances.
  - Separately from the known robots-on-APIs issue: FDA pages declare `Crawl-Delay: 30`, but `webReadRobots.mjs:61` caps any crawl delay at 10 s and `HostPacer` refuses waits over 15 s. The edge's FDA list-and-body fetches will therefore either break the declared delay or be refused as busy.
- **Impact:** frontier bursts can push research runs and engines into 429s. That contradicts principle 14/15 and 6.7's 「不会影响任何用户的对话和运行额度」.
- **Fix:**
  - Make NCBI and openFDA keys a phase-1 requirement; the config slots already exist.
  - Cap the frontier at a fixed share of each quota.
  - Persist daily host counters in the database.
  - Use a queued host scheduler for sites with long crawl delays.

## F5 · MAJOR · `identity_key` swallows new events for the same trial or product (DDL, 10.3.3)

- **DDL:** `identity_key … (doi:, pmid:, reg:, wx:, url:)` has a UNIQUE index. 10.3.3 says: 「键与已发布条目相同：这条记为该条目的「另一来路」，不再往下走」.
- **Problem:** the P0 streams `ctgov-results-first-posted` and `ctgov-stopped-phase3` report new events about trials the frontier may already hold as items from `ctgov-phase3-new-registrations`. The key `reg:NCT…` merges results or termination into the old registration item, so the news is lost. The same happens to openFDA records whose links are 「由申请号或召回号拼到官方页面」 (10.2.4): a Drugs@FDA supplement (for example a new indication) collides with the application's earlier item.
- **Separate gap:** there is no index on `items.pmid`, so a PMID-only arrival cannot be matched against an item keyed by DOI.
- **Fix:** registry and database sources get event-level identity: registry id plus event type plus date, or the record's own id. Keep `reg:` only as an event-clustering key. Add a key table (or an index on `pmid`) for every key an item has.

## F6 · MAJOR · Journal items held for abstracts become visible already back-dated (DDL, 10.3.4)

- **DDL:** `timeline_at … the 72-hour rule, computed once and never again`, where 「收录」 is `first_seen_at` ("the collector's clock").
- **10.3.4 and 10.1:** 56% of journal items have no Crossref abstract. They are held for up to 5 days, and 77%, 40% and 25% are still missing from PubMed at 0–1, 2–3 and 4–7 days.
- **Impact:** about 130 journal items a day become visible 1–5 days after they were first seen, filed under an earlier date. They miss 今天, the 07:30 daily's 「前 24 小时」 and the 72-hour hot window. For the ~20 top journals that go in title-first, 10.3.4 says 「摘要到了再补导读」 but nothing re-scores or re-selects them, so a NEJM RCT scored on its title alone may never reach 精选.
- **Fix:** set `timeline_at` when the item is published (`visible_at` if that is within 72 h of publication, else the publication date). Key the daily and hot windows on `visible_at`. Re-score when the abstract arrives.

## F7 · MAJOR · Evidence type for fresh journal articles will almost always come out as 「其他」 (10.3.8, 6.3)

- **Plan:** 「证据类型：期刊条目由程序按 PubMed 文献类型映射」 (10.3.8). 6.3 gives code 30 of the 100 points (authority × evidence coefficient).
- **Data (10.1):** 555 of 1,687 journal items were not in PubMed at all. Of the 1,132 that were, 69% carried only `Journal Article`. So only 152 of 1,687 (9%) have a research type. This is expected: NLM assigns publication types at MEDLINE indexing, weeks later.
- **Impact:** the 「证据有多硬」 label, the product's core promise, is empty exactly when an item is new. The code-computed score then pushes fresh RCTs below regulatory items.
- **Fix:** the model classifies evidence type from the abstract (a language judgment, principle 1). Code confirms or overrides it when PubMed types arrive later, and `evidence_basis` records which happened.

## F8 · MAJOR · The latency table cannot be met under the plan's own off-peak and browser-cadence rules (10.3.10 vs 10.3.6, 10.2.6, 6.1)

- **Plan (10.3.10):** 「媒体与 AI 白天 90 分钟内进「全部」」, 「其余期刊 摘要到位后 4 小时内」, 「官方安全通告 45 分钟内（30 分钟轮询…）」.
- **Plan (10.3.6):** 「其余条目白天攒着，18:00 后一起处理」. But items become visible only after scoring (the 10.3.1 state machine is `screened → scored → published`), so this means up to 9 h on weekdays.
- **Plan (10.2.6):** cloud-browser sources are read 「每站每天 4–8 次」. Two of them are safety-lane sources, `nmpa-label-revision-announcements` and `nmpa-other-drug-announcements`, so their latency is 3–6 h. That also contradicts 6.1's 「安全警示和监管公告 30 分钟」.
- **Fix:** either add a title-only publish path before scoring, or rewrite the table per egress and per off-peak state. Treat NMPA safety pages as a 30-minute browser cadence and budget for it (see F10).

## F9 · MAJOR · ETag/304 ignores per-user state and content changes that don't bump a version (10.5.2)

- **Plan:** 「ETag 就是版本号加查询参数的哈希…版本没变，控制面不查库、直接回 304」, with personal state overlaid on the server. Versions bump only on 「条目发布、精选变化、热点重算、日报定稿」.
- **Impact:**
  - After a star, `GET /api/frontier/items?starred=1` (7.3) answers 304 and the browser serves the cached body without the new star. An item hidden with 「不感兴趣」 comes back on reload, and the problem persists across devices.
  - Retraction flags (10.3.9), late summaries (10.3.4) and operator withdrawals change item content without bumping a version, so they are served stale.
- **Fix:** include a per-user state version in the ETag of every user-dependent view (or skip ETags for them). Bump the view version on every item mutation, not only on publication.

## F10 · MAJOR · The cloud-browser egress depends on an AgentBay key and a paid service the plan never lists (10.2.1 B, 10.2.6, 10.7)

- **Code:** `agentbay/browser.mjs`: `enabled = config?.webRenderEnabled === true && Boolean(config?.agentbayApiKeyFile)`. Renders share one warm session and a concurrency gate of 2 (`webRenderConcurrency`, queue of 16) with researchers' own `web_read` renders, and the session idles for 5 minutes after the last render.
- **Plan:** 10.7's owner asks and 9 (「除那台境外主机外没有新的付费服务」) omit the AgentBay key. 10.7 prices the cloud browser as 「可忽略」.
- **Impact:** without the key, the phase-2 flagship sources (NMPA, CDE, CMDE, NHC) get only `web_read_needs_browser`. With the key, unbatched polling of 12–67 sources keeps sessions alive for hours of billable CPU and memory, and competes with researcher renders.
- **Fix:**
  - List the key as an owner ask and add a readiness line for it.
  - Batch browser sources into scheduled bursts using a separate renderer instance or quota.
  - Put AgentBay time into 10.7's cost table.

## F11 · MAJOR · The 「不可登录的系统账户」 does not exist and touches authentication code (10.3.5)

- **Plan:** usage is 「记在一个不可登录的系统账户和它的内部项目名下」, but 7.2 lists no file that would create it.
- **Code:**
  - `controlPlaneDatabase.mjs:19` has `auth_type CHECK (auth_type IN ('local','oidc','development'))`, so there is no non-login type.
  - `store.mjs:859` lists all users.
  - `internalProjects.mjs isInternalProject` knows only `evimed-learning`, `evimed-sources` and eval cells, which live inside real accounts.
  - `callModelForControlPlane` reserves against `config.userDailySpendLimit` for this account. Its estimate falls back to 65,536 output tokens (`modelGateway.mjs:417-423`), about ¥0.52 per flash call against about ¥0.004 actually spent.
- **Impact:** a hand-made account risks being loginable. It shows up in listings and exports. The moment per-user caps are turned on (the to-C plan), they apply to the pipeline as well, before the pipeline's own ¥10 budget is reached.
- **Fix:**
  - Add a `system` auth type that every login path refuses, excluded from lists, exports and counts.
  - Register its project in `isInternalProject`.
  - Exempt it from per-user caps in favour of the module's own budget.
  - Always send `max_tokens`.

## F12 · MAJOR · 「与你相关」 (10.5.3) is unspecified where it matters and mis-costed

- **(a) How the profile is built is never said.** 10.5.3 says only that the server 「提出一组专科标签和至多 10 条兴趣短语」. Memory records are free text: `researchMemory.profile()` returns records grouped by kind, and `MEMORY_ORIGINS` includes `inferred` while statuses include `pending`.
  - Doing this in code means regex over language (principles 1 and 5).
  - Doing it with a model means a per-user call, contradicting 6's 「不为每个人重新调用大模型」.
  - Inferred or pending memories would be shown as 「因为你在做…」 (principle 18).
  - Cached phrases outlive memories the user deletes.
- **(b) The reranker cannot support the per-phrase reasons.** `MemoryRerank.order(query, documents)` returns only a permutation for one query, with no scores. Showing which phrase matched each item takes one call per phrase. The "32 document limit" is only a configurable default (`maxDocuments = 32`, maximum 100).
- **(c) The cost is wrong and grows with users.** 32 docs × ~180 tokens is about 5.8k tokens, about ¥0.003 per call. That is already above 「一天不到一厘钱」 for a single call, and with up to 10 phrases and a 6-hour cache it reaches about ¥0.12 per active user per day. In the plan's own 10k-DAU scenario that is ¥29–1,160 per day, against 10.7's 「嵌入与重排约 3 元/月…与用户数无关」. Rerank spend is also outside the ledger.
- **Fix:**
  - Specify the extraction: a daily model call per active user, on active and user-confirmed records only, re-validating memory ids when reading.
  - Use one rerank call with one query per user, or add a rerank method that returns scores.
  - Re-cost 10.7 as a per-DAU line.

## F13 · MINOR · Platform seams the module would miss (10.4.4, 10.5.4, 10.2.5)

- **Claim (10.4.4):** 「语义和平台的任务账本完全一样」.
- **Gaps:**
  - `ProductJobs.claim` checks `maintenanceAllowsClaims` (`productJobs.mjs:87`); the module's own `SKIP LOCKED` queues don't.
  - The frontier worker is not in the maintenance `inspectActivity` background list (`server.mjs:2449-2459`), so a maintenance window would not wait for its writes.
  - If `frontier_search` should work in AgentBay sessions ("same path as `kb_search`"), `frontier` must be added to `RUNTIME_GATEWAY_NAMES` and `publicRuntimeGatewayUrls` (`runtimeGatewayEntry.mjs:47,61`).
  - The repo's `Caddyfile` answers 404 to `@internal path /internal/*`, so the edge path needs a public prefix handled in-process (the `/runtime-gateway/` precedent) rather than only an nginx allowlist.
  - The edge key needs a compose `secrets:` entry and generation in `configure-production-state`.
- **Fix:** add these to 7.2 and 7.6.

## F14 · MINOR · Push timing reinvents an existing preference (10.5.5 vs 7.5)

- **Plan:** 10.5.5 and the DDL add `user_prefs.push_hour` and `time_zone` (「时区取浏览器上报的」). 7.5 says 「推送时机沿用用户的简报时间」.
- **Code:** the platform already has `digestTime` and quiet hours in notification preferences (`notificationService.mjs:644,702`). Feishu pushes are gated by `pushNotBefore` (`imService.mjs:146`), which works in fixed Shanghai time and gates only `source.type === "digest"`. The result would be two settings, two time zones, and a `frontier` source type that `pushNotBefore` ignores.
- **Privacy:** Feishu bindings can be group chats (`imService.mjs:800`), so the pushed body must never carry the per-user 「与你相关」 reasons.
- **Fix:** reuse `digestTime` and route through the digest branch of `pushNotBefore`.

## F15 · MINOR · Retention deletes the dedupe memory, so old and undated items return as new (10.4.5, 10.3.2)

- **Plan:** backfill and screened-out entries are deleted after 30 days. The only memory of what was seen is the DDL's `UNIQUE (source_id, external_key)`.
- **Data (dry run):** deep feeds still return MMWR 2,325 items (back to 2019), CDC 1,842 (back to 2006) and OpenAI 1,210. Dated items are re-inserted every month as backfill, which is churn. Undated items (1.3%; `chinjmap` and `zgyxzz-pharm` are entirely undated) get a new `first_seen_at` (「用首次见到时间代替」). They re-enter screening as "new", cost model calls again, and can be published a month late.
- **Fix:** keep compact tombstones (source, key, content hash) for longer than any feed's depth. Never assign "today" to undated items after a source's first read.

---

**Checked and sound:**
- the schema applies idempotently (re-ran `check_schema.sh` on local PostgreSQL 16);
- the cost arithmetic in 10.3.11 matches the price list;
- the storage growth estimates in 10.4.6;
- the use of `callModelForControlPlane` (no timeout or retry of its own; purpose `frontier` fits the vocabulary);
- the adapters as pure functions tested against recorded responses;
- external failures never turning readiness red (10.5.8).
