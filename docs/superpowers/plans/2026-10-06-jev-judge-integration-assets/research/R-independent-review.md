# Independent review: 「Jev 判定接入方案（定版）」

Plan reviewed: `/workspace/workspace/EviMedScience/docs/superpowers/plans/2026-10-06-jev-judge-integration.md`
Version reviewed: the file as of mtime 2026-10-06 12:17:37Z (39,880 bytes, md5 2487bec4...). The plan was edited while I was reviewing (it was 37,838 bytes when I first read it; J3, J4, J5, J6 text, the "3 个缺陷" line, §6.3 and B9 are new). Everything below is checked against the later version. S2 also grew while I worked (Part C, engines, was added at 12:16); I used the later S2.

Read-only: nothing in the repo was modified. Only this file was written.

Legend: HIGH = changes a decision or states something the evidence contradicts; MED = wrong or incomplete in a way that will cost rework or mislead; LOW = wording, count, or hygiene.

---

## A. Code and number spot-check (item 1)

### A.1 References that checked out (31 rows, about 45 individual file/line/number references, all in the current tree)

| Plan reference | Result |
|---|---|
| `jevModel.mjs` `callJev` has no `limits` arg; reserve uses `userDailySpendLimit`, `runLimit: 0` | OK (jevModel.mjs:163, 210-216) |
| `reviewService.mjs:957` Jev first pass (`judgeCitedSentences`, threshold `reviewJevSupportConfidence`) | OK |
| `deps-version.json` `typesafe.review` = `jev-1.13.0`, `supportConfidence 0.8`, limits 64k/32k; notes carry 100/101 and 37/40 | OK (deps-version.json:96-106) |
| `OPEN_SCIENCE_REVIEW_JEV_ENABLED`, `reviewJevTimeoutMs` 15 s | OK (config.mjs:908-920) |
| alerts `ModelProviderBalanceExhausted`, `ReviewJevFailing` | OK (deploy/web/monitoring/open-science.rules.json:445, 486) |
| price list `evimed-reference-2026-09-24`, rate 6.7489 | OK, but the file is `packages/domain/src/metering.mjs`, not under `apps/server` (the table in §2.1 gives a bare name) |
| `packages/contracts/typesafe/fixtures` | OK |
| `methodConsolidation.mjs:597` `screenPairs`, `:122` `candidatePairs`, `maxScreenPairs 40` | OK; `candidatePairs` splits on `/[^a-z0-9]+/` so Chinese names yield no tokens (confirms B2) |
| `channels/intent.mjs:104` `classify` | OK |
| `specialistClassifier.mjs:138` model call | OK |
| `frontierEditor.mjs:1048` `screen(batch)`; `frontierEvents.mjs:751` `judgeSameEvent` | OK |
| `sourceService.mjs:389` `classify`; 22 `SOURCE_TYPES`, 4 depths, 11 reachable types, PDF/doc -> `published-paper` | OK |
| `memorySubstrate.mjs:398` rerank call | OK |
| `evolutionComposition.mjs:184` `interpretOverride`; `model()` helper sets no `thinking` | OK |
| `clinicalEvidence.mjs:78` `runtimeLeakagePattern` | OK (but see F7: three consumers) |
| `TOOL_RESULT_PRUNER` 8192/4096/1024 (`packages/domain/src/constants.mjs:198`) | OK |
| `RUNTIME_GATEWAY_NAMES` (`runtimeGatewayEntry.mjs:52`), `engineCaller` (`modelGateway.mjs:203`) | OK |
| `packages/socket/plugins/screening.mjs`: default batch 50; `excluded: verdicts.length - included` (line 188) counts `unclear` as excluded | OK, bug confirmed |
| `论文审稿/.../methodology_reviewer.py:426` `_evaluate_item`, `:739` `_build_evaluation_prompt`; serial loop at 396-398 | OK |
| `孟德尔随机化/.../pipeline.py:416` `_step5_select_gwas`; `_validate_selected_ids` checks id format only, not membership | OK |
| `meta/.../screening_agent.py:110`; dual screening when N<200 (`_dual_screen_title_abstract`) | OK |
| greeting regexes: `meta/start.py:927`, `科研选题/app/main.py:70`, `孟德尔随机化/start.py:361` unanchored; anchored version in `科研选题/core/input_processor.py:67` | OK |
| §6.1: `screenedPairs` reads `pairs[]/kept[]`, `a/b`; `buildGroup` filters `relationType` (methodConsolidation.mjs:675); `applyRelations` reads `relations[]` (:549-560); contract is `screened{selected,rejected}` and `assignments[].RELATION_TYPE` (contractRegistry.mjs:1208-1262) | OK |
| §6.1: real artifact `evals/method-quality/results/2026-09-27-method-relations-screen/.../method-relations.json` follows the contract and has `pairs[]` entries `{pair, methods, verdict}` without `a`/`b` | OK, so `screenedPairs` keeps zero pairs |
| §6.1: test fixture `methodConsolidation.test.mjs:143` uses `relationType` | OK |
| `evals/frontier-editing/cases.json`: 5 `lane` incidents, 11 `same_event` incidents | OK |
| `evidenceTarget`: 12,000-char source, `LIMIT 20` cards (`evidenceEditorial.mjs:420,462`) | OK |
| `evals/memory-recall`, `evals/writing-incidents` exist | OK |
| `research-evolution-2.md` §5.2 exists and lists the closed demand-code fields | OK |
| `2026-09-22-tiered-review-and-repair-plan.md` §16 records Jev going live 2026-09-24 | OK |
| HEAD `c1f02c3cc` | OK |

### A.2 Numbers matched against ROUND2-SUMMARY.json / probe files
Routing 0.824/0.835 vs 0.741, 273 vs 712 ms; Feishu 50/50 vs 44/50, wrongSwitch 0 vs 3; method pairs 47/48 vs 47/48 vs lexical 26/48; rubric 0.851/4.2%/293 ms vs 0.840/7.6%/1966 ms; screening forward 14/14, 0.819; MR 12/14 vs 10/14; label check 104/109 vs 107/109; capsule 77/80 vs 80/80; intent 0.873-0.932 vs 0.846-0.955; backstage 12/12 at 0.7, 0/53 clean, regex 1/12. All match.

### A.3 Numbers the notes do not support (cannot be verified from S1-S3)
All of §2.3 (14-day production usage, 620 yuan, 21 Jev calls, 9 autopilot calls, 96%/36.4 yuan frontier split, zero Feishu calls) and "每月约 10 美元" come from production queries that are not in any note. See F13 for the one that matters.

---

## B. Findings, most severe first

### F1 [HIGH] J4 (literature screening) is contradicted by the plan's own evidence, and the "14/14, saves 82%" number is not what the plan implies

Location: §1 row 5 ("真正起作用的是判据怎么写、「拿不准就纳入」这条规则，模型本身影响不大"); §2.2 row 题录/摘要筛选 ("拿不准就纳入：14/14，省下 82% 阅读量 | 生产提示词同样漏掉 2 篇"); §4.1 J4; §6.2; B5.

What is wrong:
1. The Flash column is selective. `screening-deepseek-socket.summary.json` (plugin prompt) lost 2 (12/14, 92.4% saved), but `screening-deepseek-meta.summary.json` (Meta engine's own prompt, which J4 also replaces) got 14/14 and 95/105 excluded = 90.5% saved, better than Jev (`jev-forward`: 14/14, 81.9%; gated at 0.7: 80.0%). §2.2 only reports the arm that lost.
2. Jev's 14/14 is the `jev-forward` arm, whose criteria were written after the first Jev arm had lost the two papers (probe `STATUS` records `jev-forward` after the round-2 summary was first written) and name the drug ("An original study of people receiving emicizumab ... whether or not the abstract itself shows pharmacokinetic data", `.evimed-local/probes/2026-09-21-jev/screening.mjs:33-37`). The memory note jev-wire-facts-2026-09-21 says it directly: "the criteria wording decided it, not the model". In production the plugin's criteria are free text written by the model (S2 A1), so the measured form does not exist in production.
3. Sample: 14 positives. 14/14 gives a one-sided 95% lower bound of 0.05^(1/14) = 0.81 on sensitivity. §3 rule 8 requires exactly that bound; the plan then says "一篇不漏".
4. Packaging: measured 10 records per request; plan says 50 per plugin batch and up to ~1,000 per Meta run, packaging unspecified (rule 7: threshold valid only for the measured form).
5. The Meta contract is not a bare 3-way: `decision` + `priority_tier` + `reason_code` (11) + `publication_role` (6) + `target_outcome_evidence` + identity checks, dual-reviewer "either includes" (S2 C3 M2; pinned by `test_title_abstract_identity.py`, `test_screening_roles.py`). "只为排除的条目套「不符合第 k 条」的理由模板": a 3-way choice has no k. S2 A1 allowed the template only "when Jev answered per-criterion"; the plan dropped that condition.
6. S2 A1: how often `evimed_screen_batch` is called in production is unmeasured and no SKILL.md names it; J4 sits in batch 1 with no volume.
7. Principle 20(b): if wording decides the result, the fix is the prompt, not a new vendor path. The control arm (`deepseek-meta`) already shows the fix.

Fix (text for §4.1 / §2.2):
- §4.1: move J4 out of the first batch. Replace the row with 「**J4 文献题录/摘要筛选：不接 Jev。**实测里起作用的是判据：Meta 引擎自己的提示词（拿不准就纳入）Flash 14/14、省下 90.5%，插件的提示词漏掉 2 篇。做法是把 Meta 的「拿不准就纳入」规则搬进插件提示词（`packages/socket/src/screening.mjs`），并修掉把「不清楚」计成「排除」的计数错误。」
- If the owner wants a Jev pre-filter for the Meta engine anyway, make it batch 2 and say: 「Jev 只对把握很高的「排除」跳过引擎原来的那次调用，其余记录照旧走引擎，所以引擎要求的角色、身份核对字段不变。」
- §2.2 row: Jev column 「判据改写后 14/14，省 82%（判据是看过漏掉的两篇之后写的，只在这一份语料上）」; Flash column 「插件提示词 12/14，省 92%；Meta 提示词 14/14，省 90.5%」.
- Counts then become 接 11 处（第一批 6 处）.

### F2 [HIGH] "已有实测，直接切换" is not true for the shapes that will ship; and the Flash baseline is not the production configuration for three sites

Location: §0 ("第一批 7 处，已有实测，直接切换"), §4.1 heading, §2.2 table, §1 row 2/3, A6.

Evidence (measured shape vs deployed shape):
| Site | Measured | Deployed (per plan) |
|---|---|---|
| J2 Feishu | 3-6 projects per case (`corpora/channel-intent.json`) | one choice over up to 51 projects |
| J3 routing | 11 specialists + none: `routing.mjs` calls `loadAgentRegistry({packageDirs:[runtime/skills/evimed]})` with no `capabilityDirs` | production registry = `packageDirs` + `capabilityDirs` (`server.mjs:963`, `config.mjs:1008-1015`; `capabilities/` has 30 dirs), plan says "约 25 个公开能力" |
| J6 MR | 6-8 candidates per trait (`gwas-select.json`) | up to 50 candidates (plan J6) |
| J5 review | CONSORT-TM: 50 Methods sections x 16 CONSORT items, 32 questions in one call | 15 checklists, 16-42 items each, full manuscripts, ~36-63 items per job (S2 C2 P3); one request with 42 noul questions is a different packaging (rule 7) |
| J4 | see F1 | see F1 |

Baseline: every Flash arm in the probes ran with `thinking: { type: 'disabled' }` (`.evimed-local/probes/2026-09-21-jev/deepseek.mjs`). Production runs J5 (STANDARD tier, thinking on), J6 (`pro` default, thinking on) and Meta screening (thinking on, effort high) with thinking on (S2 C0, C2 P3, C4 M12; the plan's own §4.1 "今天" column says 「开着思考」). So "误判不通过 4.2% 对 7.6%" and "12/14 对 10/14" compare Jev with a weaker configuration than the one in production.

Also: J3's "改写判据后 0.835" is 71/85 vs 70/85 on the same cases the criteria were tuned on; it is noise, not an improvement.

Fix:
- Heading 「### 4.1 第一批：已有实测（题型与线上有差别的，阈值上线前在线上的形态上重定）」 and in §0 「第一批 6 处，已有实测；线上形态和实测不同的点，在 A6 里按线上形态补语料再定阈值。」
- Under the §2.2 table add: 「Flash 一栏用的是生产提示词，但所有对照都关了思考。专项引擎（论文审稿、MR、Meta 筛选）线上开着思考，这三行的对比不是同条件对比，只能读作「Jev 不比关了思考的 Flash 差」。」
- A6: replace 「先补到约 100 条」 by 「按线上形态补：飞书 ≤51 个项目；路由用线上的全部公开能力目录；MR 50 个候选；审稿清单按 CONSORT 之外各自标注」.
- J5: 「第一版只对 CONSORT 清单走 Jev，其余清单仍走 Flash，有了各自的标注再放开。」
- Delete 「（改写判据后 0.835）」 from §1 row 2 and §2.2.

### F3 [HIGH] J5 auto-records "通过", the direction where Jev is worse, and the plan reports only the metric where Jev is better

Location: §0 ("Jev 的结论只做两类事 ... 做错了代价大的方向，要求更高的把握，否则交回原路径"); §4.1 J5 ("把握高的「通过」直接记"); §2.2 rubric row; §9 injection row.

Evidence:
- `rubric-jev.summary.json` / ROUND2-SUMMARY `rubric`: `missingCaught` Jev 0.616 (noul50), 0.608 (choice) vs Flash 0.656. Jev lets through more truly missing items (38.4% vs 34.4%). The plan quotes only `falseFailRate` 4.2% vs 7.6%.
- Overall agreement is equal (0.851 vs 0.840); Jev trades 3.4 points of false FAIL for 4.0 points of missed items.
- S2 C2 (line 160): five layers already run AFTER the item verdict (hard filter, meta LLM triage, quote verification, IssueVerifier, partial issues). As I read S2 they act on issues raised from non-PASS items (P3's extra fields are consumed only for non-PASS items); I did not trace each one, but none is described as looking for a defect the item verdict passed. So the benefit the plan advertises is the error class the pipeline already repairs, and the cost it hides is the one it probably cannot.
- The plan's own §2.2: "把握门槛 ... 在审稿清单和意图分类上只拦得住约 40%", so a confidence gate does not cover this.
- S3 §6.4: manuscripts come from an author with an interest; "if used at all, escalate or flag, never auto-accept, and never let one Jev verdict be the only barrier". Injected text in a manuscript can only push toward "通过". The §9 mitigation (a Flash pre-check per manuscript) is an extra full-manuscript Flash call and Flash is steerable too.
- §0 says Jev "不批准任何事"; auto-recording a PASS is an approval of a checklist item.

Fix:
- §4.1 J5 last cell: 「Jev 只判「通过」。通过需要把握 ≥ 0.9（这个方向做错了，审稿报告会漏掉缺陷，所以要求比「不通过」更高）；其余一律交 Flash，由它写依据。线上上线前报出两个数：该清单上被 Jev 放过、Flash 会判不通过的比例，以及转交 Flash 的比例。」
- §2.2 rubric row: add 「放过缺失项的比例 Jev 38.4%，Flash 34.4%」.
- §9 injection row: keep, and add 「通过只在 ≥0.9 时直接记；抽检 2% 对照 Flash」.
- Alternatively drop J5 from batch 1 and ship it with the thinking-on baseline measured (F2).

### F4 [HIGH] J11 (memory recall cut-off): the evidence is mis-stated, the design contradicts §1, and the plan's own rule for KB rerank applies to it

Location: §1 row 7; §2.2 记忆召回 row ("有绝对分界"); §4.2 J11; C5.

Evidence (computed from `rerank-records.json` and `rerank-capsule.json`):
- Records corpus: gold probabilities sorted 0.16, 0.86, 0.88, ... 0.97; best distractor per query up to 0.73. Capsule corpus: gold 0.14, 0.65, 0.83, 0.91...; best distractor per query 0.92, 0.90, 0.80, 0.78, 0.74. So "相关 ≥0.86，干扰 ≤0.73" holds for the records corpus only, and even there one relevant record sits at 0.16. At a floor of 0.86 the cut would drop 1 of 15 relevant records (records) and 3 of 20 (capsule); in the capsule corpus two distractors (0.92, 0.90) sit above that floor and would be injected; and in 3 of 28 queries a distractor scores at or above the lowest-scoring relevant record (0.17 vs 0.16, 0.17 vs 0.14, 0.66 vs 0.65).
- Neither query set contains a query with no relevant record (`queries.json`: 12 queries, `capsule-queries.json`: 16, `expected` never empty), so the "都不相关" situation this site exists for was never tested.
- §1 row 7 says 「只加一道「都不相关」的截断」 (query-level); J11 says 「对排完序的候选每条问一个「与问题相关吗」，低于下限的不注入」 (per record). These are different designs; the per-record one is what loses the 0.14/0.16 gold records.
- S1 §6 verdict: "not recommended without evidence the rerank order is wrong". §4.3 rejects KB rerank for exactly that reason ("也没有证据说现在的顺序有问题"). The same sentence applies to memory.
- Cost: a serial Jev call after `qwen3-rerank` on every recall (cold connection from Beijing, see F10) plus a second egress of memory text (F8). Principle 20(e): no reproduction, no control, no gate.

Fix: delete J11 from §4.2, add a row to §4.3: 「记忆召回截断 | 9 月的测试里没有「全都不相关」的提问，相关记录的概率最低到 0.14，干扰项最高到 0.92，截不干净；也没有记录说明现在注入了不相关的记忆」. Counts (together with F1): 接 10 处（第一批 6 处，第二批 4 处）. If the owner wants it kept: query-level only (cut when even the top-1 is below the floor), add negative queries to `evals/memory-recall` first, and drop the "≥0.86 / ≤0.73" sentence.

### F5 [MED] J3: unwanted routing and the regex-net interaction are missing from the evidence

Location: §1 row 2, §2.2 routing row, §4.1 J3.

Evidence: ROUND2-SUMMARY `routing`: `unwanted` (a plain question sent to a heavy specialist pipeline) Jev 1 / jev2 4 / jev3 2, Flash 0; `missed` 6/6/5 vs 17; `wrongSpecialist` 8/4/7 vs 5. The rewritten-criteria arm that reaches 0.835 has 4 unwanted routes. Under principle 12 an unwanted specialist run (file-delivery gates, minutes of work) is the costlier error. Flash's 17 "missed" include answers cut by the 0.75 confidence threshold (`routing.mjs:83`), which today's regex net then routes, so the end-to-end comparison (classifier + net) the product actually runs was not measured. The memory note records "Neither matches the regex router on its own regression set", and the real regression that justifies `afterCleanNone` is the title-to-paper corpus (specialistRouting.mjs:228-238: 50 briefs the classifier correctly declined), which was not run on Jev. S1 §3 item 2: the catalog also contains the nine module-only GEO/VCR capabilities (`display.listed:false`), which were not in the measured catalog (F2) and which the owner rules say stay untouched until the owner declares VCR ready.

Fix:
- §2.2 routing row: add 「误送去专项（本来只该普通回答）：Jev 1-4 次，Flash 0 次；漏掉该送专项的：Jev 6，Flash 17」.
- §4.1 J3 last cell, add: 「上线前必须在 `title-to-paper` 的 50 条上检查「干净的普通回答」不被送去专项；GEO 和虚拟临研的模块内能力保持和今天完全一样（在不在选项里，都不改）。」

### F6 [MED] §3 gateway body lets the caller write the questions; this contradicts the registry design and rule 7

Location: §3 判断点登记 ("问题怎么构造 ... 阈值 ... 调用方只调 judge(site, input)") vs 运行时和引擎怎么调用 → 请求体 ("只收三项：site、state、questions").

Problem: if the registry builds the questions and holds the threshold, the gateway must take `site` + `input`, not `questions`. As written the `site` is only a label, the runtime/engine supplies arbitrary question text and arbitrary `state` to a third party, and rule 7 ("阈值只对定下它的那种题型和请求形式有效") is unenforceable because the caller can change the form. It also departs from the gateway pattern the plan cites (S2 B2: "one allowlist of fields", closed vocabularies via `closedField`) and from layer-3 "the runtime names at most the page it wants read".

Fix (replace the 请求体 bullet): 「**请求体。**只收 `site`（只能填登记过的判断点）和 `input`（该判断点登记的几个字段，按字段限长）。问题由控制面里 `judgeSites.mjs` 的那一行按 `input` 构造，答案也在控制面按登记的规则读取；运行时和引擎拿回的只有「已判定 / 转原路径」和判定结果，不能自己写问题。」 And in the same bullet group: 「用途由登记行决定，不由请求体决定。」

### F7 [MED] J7 changes three consumers of the leakage rule, but the plan names one; calibration is clinical-only; packaging unspecified

Location: §4.1 J7 ("交付规则 `clinicalEvidence.mjs:78` 里 `runtime-leakage` 的开放词表那一半 ... 开放词表的正则删掉"); B8; the parenthesis 「光「工件」一个词就在 15 份报告里的 9 份出现过 19 次」.

Evidence:
- `runtimeLeakageLine` (clinicalEvidence.mjs:4092-4093) is used by three places: the clinical rule (`clinicalEvidence.mjs:3727`), the generic prose check for every capability contract (`contractRegistry.mjs:261`, `proseHygieneIssues`), and the GEO notices (`geoContracts.mjs:225`). Tests that assert `runtime_leakage`: `packages/domain/test/vocabulary.test.mjs:296`, `packageVocabulary.test.mjs:71`, `apps/server/test/geoContentPack.test.mjs:156`. A non-clinical contract has already hit it in a real run (`evals/meta-analysis/results/2026-09-28-ma-001-tranexamic-acid-tka/.../revision-notes.md:121`, 「本轮检索」).
- The 53 clean lines come from three clinical chest-pain reports (`backstage.mjs`: `clinical-qa/case-1`, `case-2`, `deepresearch-cdc3d3a4-case1-failed`); the 12 positives are self-written; the 0.7 threshold was picked from 0.5/0.7/0.9 on the same 65 lines (0.5 gives 3 false flags). Non-clinical reports were never sampled.
- Measured form is one line per request (`ask({report_line}, question)`). The plan says 「逐行问」 without saying whether that is one request per line or one batch; §3 rule 7 says a batch of many noul shifts the probabilities.
- The code comment (clinicalEvidence.mjs:64-72) says nine of fifteen production reports carried one of 工件 / 本环境 / 访问层级 (工件 19 times, 本环境 13, 访问层级 12). The plan attributes "9 of 15" to 工件 alone.
- Today the run is told about this finding inside its own turn (advisory, S2 Part D) and can rewrite; after J7 the finding exists only after delivery, so nobody can repair it (principle 3).

Fix:
- J7 last cell, replace the first sentence: 「封闭词表那一半（工具名、`mcp__evimed__*`、`.evimed-sources/` 路径）留在 `runtimeLeakageLine`；开放词表那一半从它的三个使用处一起拿掉：交付规则（`clinicalEvidence.mjs:3727`）、所有能力合约的正文检查（`contractRegistry.mjs:261`）、GEO 合约（`geoContracts.mjs:225`），三处的提示都改由交付后的 Jev 提示承担；三个断言 `runtime_leakage` 的测试同步改。」
- Replace the parenthesis: 「「工件」「本环境」「访问层级」三个词在 15 份生产报告里的 9 份出现过（「工件」一个词 19 次）」.
- Add: 「每行单独一次请求（实测的形式）。阈值 0.7 是在 3 份临床报告加 12 条自编句子上定的；上线前补非临床能力报告的真实句子，确认 0 误报再放开到所有合约。」
- Add one clause: 「运行在交付前不再收到这类提示，只有读者在交付后看到。」 so the owner knows the trade.

### F8 [MED] §9 "数据出境" row misdescribes the precedent and does not say who sends what

Location: §9 row 6 ("现有的回复核查已经在送引文和回答").

Evidence: S1 "Notes on the existing client": the reply check sends the assistant's cited sentences plus public abstracts; "Sites whose state is a researcher's own words (routing and Feishu intent: the raw question or chat message; memory: conversation text; source text) would send content that DeepSeek already receives to a second third party, which the existing reply-check use does not set a precedent for". S3 §6.6: no region choice, hosted in the US; the contract lets TypeSafe keep "Telemetry". The new sites send: J2/J3 the researcher's own message, J5 an unreviewed manuscript, J7 a whole report, J10 the first 6,000 characters of any uploaded file (types include `patient-record`, `medical-case`, `certificate-scan`), J11 memory text.

I am not asking for a compliance workstream (owner ruling: out of scope). The row is simply wrong about precedent, and the owner should be told the payloads once.

Fix (replace the row): 「**数据出境：**J2、J3 送研究者自己写的话，J5 送待审稿件，J7 送整份报告，J10 送上传文件的开头；J1、J8、J9 送方法名称、公开资讯的标题和摘要。这些内容 DeepSeek 已经收到，现在多一个美国托管的接收方。回复核查今天送的是模型的回答和公开来源摘要，不是研究者的话，所以不是先例。| 每个点只送本题需要的字段并限长；J10 只送文字类文件的前约 1,500 字（见 F9）；虚拟临研的患者级数据、密钥、内部地址永不进入。」

### F9 [MED] J10 can start the most expensive operation in the system and can lower how much of a file is read

Location: §4.2 J10 ("解析完成后，对文件名加正文前约 6,000 字问一个 22 选 1，深度另问一个 4 选 1 ... 类型变了就像手动改类型一样升一代，重新理解"); §1 row 9; C4.

Evidence:
- `SourceService.override()` (sourceService.mjs:1084-1100) bumps `generation`, sets `status:"queued"`, calls `enqueue` (re-parse) and `enqueueRunCancellations`. "Like a manual override" therefore means parse again and run `source-understanding` again (an agent run, own budget; S1 §8). `.pdf/.doc/.docx/.odt` all default to `published-paper`, so Jev will disagree with the default often, and each disagreement doubles parse + understanding cost for that file. The plan adds this to save nothing.
- `freezeCapture` (sourceService.mjs:671-672) cuts units using `docType` and `depth` and is immutable per generation, so the right place to decide is before it, inside the same job.
- `SOURCE_DEPTHS` includes `skip` and `index_only` (sourceService.mjs:146); `classify` never returns `skip`. A confident model answer can reduce how much of a researcher's file is read, the non-conservative direction §0 says to avoid.
- Sends up to 6,000 characters of arbitrary uploads (F8); the question needs far less. §3 rule 3 says send only what the question needs.

Fix (replace J10 "接入后" and "校准" cells): 「在解析出文字之后、冻结这一代解析结果之前判，直接写进当前这一代，不升代、不重新解析、不重新理解。只对文字类文件（pdf、doc、docx、odt、md、txt、rtf）判；表格、音视频、图片仍按扩展名。送文件名加正文前约 1,500 字问一个 22 选 1；深度只允许今天 `classify` 能给出的值，并且只许往深处改（不降到 `skip`、`index_only`）。研究者改过的永远优先；没把握时保持今天按扩展名的默认。」

### F10 [MED] Online paths (J2, J3) have no numbers, no breaker, and the cold-connection cost is not acknowledged; background sites share one account-wide rate limit with them

Location: §9 latency row ("每个点都有硬时限（继承现有的 15 秒设置，路由这类在线路径更短）；连续失败就重建连接"); §3 限制; §0 "不以提速为理由".

Evidence:
- J3 sees 49 calls in 14 days (plan §2.3), J2 zero, so every call is a cold connection. S3 §3.7: from the authors' network cold 1.7 s (HTTP/2) to 3.9 s (HTTP/1.1), TLS alone 1.4 s, server idle cut about 90 s, an HTTP/2 connection once silent for 7 and 26 minutes. `callJev` uses the global `fetch` (jevModel.mjs `fetchImpl = fetch`), whose keep-alive window is a few seconds. The only measurement from the production host is an unauthenticated round trip of 0.5-0.6 s (memory jev-wire-facts); the 273 vs 712 ms figures are from the dev box. So on the dispatch path Jev is likely slower than the Flash call it replaces; §0 concedes "不一定比 Flash 快", but J3 sits in front of every unrouted question.
- Memory jev-wire-facts: "it could not serve at all for a stretch of launch week; rate limits are dynamic". S3 §1.5: 80 req/s and 100k tokens/s, account-wide, "adjusting dynamically". Background sites (J1, J7 per-line, J8, J9) and online sites share it.
- Precedent for a breaker already exists: `autopilotNextAction.mjs:92-93` (3 failures, open 5 minutes).
- Principle 15 asks for a config key and a counter for every timeout/concurrency cap; the plan names none per site.

Fix (replace the §9 latency row, and add one bullet to §3 限制): 「**在线路径（J2、J3）：**Jev 硬时限 3 秒，超时按「没结论」处理（J3 交正则网，J2 留在当前项目）；连续 3 次失败后 5 分钟内不调 Jev（照 `autopilotNextAction.mjs` 的断路器），避免每次提问都先等一个超时。判定用长连接。A2 里在生产主机上量一次冷、热延迟（量线上这条路，不是对比试验）。**后台点（J1、J7、J8、J9）：**并发上限 4，不占在线点的名额。每个点的时限、并发上限各有一个 `config.mjs` 键和一个计数。」

### F11 [MED] J1/B1: the benefit is not Jev-specific, "每小时启动" is overstated, and fixing the chain switches on steps that have never run

Location: §0 gain 2 ("省掉一类空跑的后台步骤 ... 今天每小时启动一次研究运行 ... 接入后变成一次约一秒的调用"); §1 row 4; §4.1 J1; §6.1; B1, B2.

Evidence:
- Probe `methodpairs`: Flash, one direct call, 47/48 at 2,012 ms; Jev 47/48 at 957 ms. The saving the plan sells (a 2-minute agent run and a runtime slot to a one-call request) comes from leaving the agent run; a control-plane Flash call (like every other control-plane site) gets it too without a new vendor path.
- "每小时启动一次": `screenPairs` returns without any call when fewer than 2 pairs (methodConsolidation.mjs:598); the dispatch id is a digest of the pair keys and content digests, so an unchanged library adopts the earlier run and pays nothing (S1 §5.2); `candidatePairs` yields no pairs at all for Chinese-only names; the one observed run covered 3 methods.
- Per §6.1 the DECIDE and BUILD steps cannot have produced anything from the live loop. After B1 each pass per researcher can run up to 6 DECIDE and 6 BUILD agent runs (`CONSOLIDATION_LIMITS.maxGroups/maxBuilds`), hourly, and BUILD writes SKILL.md revisions. The learning caps default to zero = no cap (`config.mjs` ~2349-2356: "Zero means no cap, the default"). So §0's 「省掉空跑」 describes the opposite of the net effect: the plan makes the loop start working, and spending.
- "按合约读字段" for relations: the contract has `assignments[]{ASSIGNMENT, SKILLS[], RELATION_TYPE, REASON}` with no source/target; `recordRelations` needs a directed edge (methodConsolidation.mjs:549-560). How a SKILLS set plus one type becomes edges is unspecified (which one is the parent in a `subset`?).
- B2 (Chinese bigrams) will enlarge the shortlist; it is capped at 40 by overlap order.

Fix:
- §0 gain 2 → 「**把一个两分钟的后台研究运行换成一次约一秒的调用，并把学习循环的链路修通。**注意：修通之后，「决定」「构建」两步才第一次在线上真正跑起来，每位研究者每小时最多 6 个决定、6 个构建。」
- B1 add: 「同时给学习循环设日金额上限（`OPEN_SCIENCE_LEARNING_DAILY_LIMIT_CNY`），并在方案里写明「一组方法加一个关系类型」怎样变成有向关系；修通后头三天看 `learning` 用途的花费。」
- J1 row: add 「（这一步换成控制面的一次调用就拿到大部分好处；用 Jev 是因为同一套接口、同一个开关）」.

### F12 [MED] J12 does not need Jev; its calibration set does not exist; "按最高档" is unsupported

Location: §1 row 14; §4.2 J12 ("今天这一步调用 Flash 时没关思考，按最高档在跑"; calibration 「运维人员直接点选的选项就是标注」); C6.

Evidence: S1 §10: the `model()` helper (`evolutionComposition.mjs:118-123`) sets no `thinking`, so the provider default applies; the effort level is not set on this path, so "最高档" is not supported. The call is rare and operator-paced, and the evolution engine is off unless enabled. A direct click on an option stores the option but no text, so it is not a (text, option) pair; the override text is not stored next to the option it mapped to (S1 §10.5). One line fixes the real defect: `thinking: { type: "disabled" }`. Principle 20(b).

Fix: delete J12 and C6 (with F1 and F4 the count becomes 接 9 处，第二批 3 处). §1 row 14 「定版」: 「**不接 Jev**；把那次调用的思考关掉（一行）。」 Put the one-liner in §6 as 「4. 进化决策文字更正的那次 Flash 调用没关思考。」 If J12 is kept, delete the calibration sentence; there is nothing to calibrate against.

### F13 [MED] Cost statement has no derivation, and J8 as designed is ~500 questions per request

Location: §0 「按今天的用量估算每月约 10 美元」 (the earlier version said 「不到」, so the figure moved without a derivation); §4.2 J8 ("每条四个问题 ... 专科用是否题，取概率最高的 3 个").

Evidence: no note contains a per-site token estimate. J8 as written is 4 questions + 21 specialty noul = 25 questions per entry x 20 entries = ~500 questions in one request (S1 §1.3 sized it at ~100-140 under a different shape). Each question carries its own instruction text, so the 64k request cap is close; and §3 rule 7 says many noul in one request shift the probabilities. A choice over 21 specialties + "都不是" returns a probability vector and the top 3 can be taken from it: one question instead of 21. J8 is the dominant cost term because it is per ingested entry.

Fix:
- J8 cell: 「专科：每条一个选项题（21 个专科加「都不是」），取概率最高的 3 个；不是 21 个是否题。」
- §2.3: add columns 「每次约多少 token」「每天次数」「每月美元」 for each Jev site, and compute the §0 figure from them; the one number to look up is entries per day in `evimed_frontier.entries`. If the sum is not about 10 dollars, say what it is.
- The owner ask 「打开自动充值」: the plan's own risk table says exhaustion falls back to the old path and raises the existing 402 alert, so top-up is not a precondition. Say 「可选」.

### F14 [MED] §3 claims the ledger column also satisfies 循证进化 2.0; 2.0 asks for different fields

Location: §3 计量 ("用量账本加一列 `operation` ... 它同时满足「循证进化 2.0」里按任务、按模块记账的需要"); A4.

Evidence: `2026-10-06-research-evolution-2.md:564`: 「所有改进工作都记在 `evolution` 用途下，带任务单号和模块两个字段 ... 用量账本新增这两个可空字段」. That is two other nullable fields, not `operation`.

Fix: 「用量账本加一列 `operation`（可为空，取值是判断点编号）。循证进化 2.0 方案第 7.5 节要加「任务单号」「模块」两个可空字段；三列在同一次迁移里加。」 And A4: 「`operation`、`task_id`、`module` 三列一次迁移」.

### F15 [MED] J6: the new fallback silently picks a dataset for a causal analysis; reachability not stated

Location: §4.1 J6 last cell ("都失败时取检索排序的第一个，不再整个跳过"); B7.

Evidence: S2 C4 M12 records "NO fallback to the already-ranked top candidate" as a gap, not as a recommended fix. Retrieval order is a deterministic ranking by sample size/recency; it does not check that the trait matches (the criteria the Flash prompt applies: "Trait name must closely match the target"). A wrong exposure/outcome GWAS gives a wrong causal estimate with no sign. The owner's 2026-09-29 rule: when an input is not valid, decline that calculation with its reason; never invent. S2 C4 finding 3: in the hosted `evimed_runner` with explicit local/catalog/OpenGWAS sources the step is skipped, so J6 only matters on the OpenGWAS search path.

Fix: last cell → 「Jev 和 Flash 都没给出结论时：只有检索排序第一的性状名和目标性状完全一致（代码核对）才取它；否则跳过这个性状并写明原因，不替研究者猜数据集。代码核对编号必须在候选里。」 Add: 「只在 OpenGWAS 检索路径上起作用；带明确数据源时这一步本来就不调用。」

### F16 [MED] Real-session verification is required for more than J3, and for five scenarios, not three

Location: §4.1 note after the table ("J3 改的是对话行为 ... 覆盖多轮追问、补充数据、换主题这三种情况").

Evidence: CLAUDE.md "Verifying a conversation change": any change to persona, guidance, a socket plugin, a tool description or routing; cover multi-turn follow-up, data supplement, subject switch, boundaries and tool failure. J2 is routing between projects; the J4 plugin is a socket plugin; J7 changes what the reader sees on a delivery; J11 (if kept) changes what a turn is shown.

Fix: 「J2、J3、J4 的插件改动、J7 的交付提示，都要在真实的 DSH + DeepSeek 会话里验证，覆盖多轮追问、补充数据、换主题、边界、工具失败（含 Jev 不可用）五种情况，并留下实际输出。」 (If F1/F4 are accepted, drop J4/J11 from that list.)

### F17 [MED] TODO and release gaps

- B5 (Meta), B7 (MR) and B9 (three engines) change engine code; only B6 says 「改动引擎要跑引擎增量发布那一步」. The J4 plugin and the runtime-side client change the runtime image (memory: engine-changes-need-engine-delta, runtime delta chain layer limit). Add the step to B5, B7, B9, and to B5's plugin part.
- C1 (export the screened-out entries) must come first. The hourly retention pass deletes `screened-out/dropped/backfill/failed` entries older than 30 days (`frontierWorker.mjs:241-248`, `before(30)`); phases A and B are about 7 days, so putting C1 in phase C loses a quarter of the window. Fix: rename it **A0** and run it before anything else.
- E1 is one release of up to 12 behaviour changes across the server, the runtime image, and three engines. Per-site levers exist, but regression attribution is poor. Fix: 「E1 分两次发：B 阶段结束后一次，C 阶段结束后一次；每次发完看一周」. This is staging, not a shadow phase.
- B9 (greeting regexes) triggers an engine release in three engines for no hosted effect: §6.3 itself says the hosted path (`evimed_runner`) does not reach it. Fix: move §6.3 to a one-line note and delete B9, or keep B9 and say it is for the standalone services only and ships with the next engine release anyway.
- Engines also run outside the hosted deployment (CLI/`start.py`) where no judge route exists; the plan states the fall-back-to-subagent only for J4. Add 「J5、J6、Meta：没有判定路由（本地命令行、网关关闭）时走原来的 Flash」.

### F18 [LOW-MED] Corpus facts in A6

Location: A6 ("`title-to-paper` 的 33 例"; "9 月的语料不到 100 条的判断点（飞书 50、方法配对 48、MR 14、路由 85）").

Evidence: `evals/title-to-paper/definition.json` and `corpus-v3/manifest.json`: `caseCount` 50. The "thirty-three" is the incident count quoted in the `specialistRouting.mjs:22-26` comment (six of thirty-three clinical-review briefs routed away), a different corpus not stored as a file; S1 conflated the two. The comment at `:234` says the title-to-paper corpus gave fifty briefs the classifier correctly declined. The under-100 list omits the backstage corpus (65 lines, 12 positives) and memory recall (12 + 16 queries); rule 8 wants about 100 labels and positives matter more than lines.

Fix: 「`title-to-paper` 的 50 例（期望都是普通回答）」; add 「报告后台语气（65 行，只有 12 条阳性）」 to the list.

### F19 [LOW-MED] J9: rule 4 (dates and numbers to code) is not applied, and "同今天拿不准就答否" is not equivalent

Location: §4.2 J9 ("只有把握高的「同一」才合并，其余按不同事件处理，和今天「拿不准就答否」一致").

Evidence: S1 §2: the state per pair includes dates, DOI/PMID/registry ids and the event title; Jev's documented weak spots (dates, numeric closeness, same-format series that differ by a drug name) "are exactly the failure class the prompt's rule 3 guards". Today Flash's `yes` has no threshold; a high bar on Jev's "同一" will merge less than today, which means more duplicate events. The 11 incident cases check false merges; the plan does not say they also check merge recall.

Fix: J9 cell add 「编号相同的直接合并（今天就是这样）；日期窗口、共同实体由代码先筛；同一格式的系列通告（只差药名或数字）由代码判为不同事件，不交给 Jev。11 个事故案例既查误合并，也查该合并的没漏。」

### F20 [LOW] Small factual and wording items

1. §0 and §1 row 1: "在 12 个候选判断点上和 Flash 做过两轮同题对照" holds for 9 rows only. Memory recall (Jev only), pharmacist cautions and backstage (vs the term matcher / regex) had no Flash arm. Fix: 「和原来的做法做过对照」.
2. §2.2 测量方式 "5 次重复运行答案完全相同": `mechanics.json` is one question x5; its `determinism.identical` flag is `false` (key order differs, values equal). S3 §3.7: μ measured 27 of 72 probabilities differing by 0.01-0.04 between identical runs. Fix: 「同一道题重复 5 次，概率一致（μ 的测试里有 27/72 个概率差 0.01-0.04，所以阈值留余量）」.
3. §2.2 "其余六份由本地编写": the count is not supported; the round-2 note says "the other six" for round 2 only, and the plan's table has more locally authored rows. Fix: 「除这两份外都是本地编写，标注经过复核」.
4. §2.1 `metering.mjs`: it is `packages/domain/src/metering.mjs`.
5. §3 "拿回「已判定」或「转原路径」两种结果" vs the metric `outcome=settled|escalated|fallback` (three). Fix: 「已判定 / 转原路径（没把握和失败分别计数）」.
6. §3 rule 1 (conservative option first) was not how the probes were built. The screening arm listed include/exclude/unclear; J4 says 「不清楚、纳入、排除」. §3 rules 1/7/9 say order bias matters, so measured thresholds do not transfer to the new order. Fix: in A6 「按定下来的选项顺序重跑一遍已有语料再定阈值」.
7. §3 A1: renaming `typesafe.review` to `typesafe.judge` touches `config.mjs:897-906`, `config.test.mjs:674-679`, `packages/contracts/typesafe/contract.test.mjs` (a dozen reads), the fixtures' provenance, and the notes in `deps-version.json`, for no behaviour change. Fix: keep `typesafe.review`, add `typesafe.review.sites.<判断点>`. A1 shrinks to one config read.
8. §5 item 2 「干活和汇报分开 ... 不新增任何东西」 is not an adopted item, so the heading 「两件事」 should read 「一件事」, and §0 「2 件事借鉴 μ」 likewise.
9. §5.1 D1: state the scope. S3 §6.12: "applied only to recognised log formats, never to data or analysis output". The plan's count marker keeps it lossless, but say which tools (`bash`, `read` of logs) and exclude the research source tools. Add 「只折连续 ≥3 行相同的块」.
10. §3 抽检: for J7, J10, J11 the "original path" is a regex or nothing, so "一致率" has no comparison. Say 「J7、J10 对照原来的正则；J11 若保留，对照「不截断」时的最终回答是否被引用」 or leave those three out of the 2% rule. Also name it 「常设漂移监测」, so it is not read as a shadow phase.
11. §4.1 J3 timeouts 「更短」 and J2: give the number (F10).
12. (Resolved) The assets directory listed only S1 and S3 when I first looked; S2 was copied in at 12:16 and is there now. No action.

---

## C. Internal consistency (item 2)

Checked OK:
- 接 12 = J1-J7 (7) + J8-J12 (5). 不接 22 = the 22 rows of §4.3 (counted). §6 has 3 defects (matches "顺带查出 3 个缺陷"). §5 has two items (see F20.8).
- J-numbers: §4.1 J1-J7, §4.2 J8-J12, §8 B2-B8 and C2-C6 map one to one, in order. B1, B9, D1, A1-A6, C1, E1, E2 are non-J. Every J site has a TODO.
- Cross-references: §0/§1 → §6, §1 → §5, §2.3 → §4.3, §2.3 → §3 (ledger column), §3 抽检 → §3, B9 → §6.3, E2 → §7, §7 "写法照 J9", `research-evolution-2.md` §5.2: all resolve.
- §4.1 J1 "(最多 40 对)", §4.2 J8 "每批 20 条", J9 "11 个事故案例", J8 "5 个栏目事故案例": match the code and `evals/frontier-editing/cases.json`.

Not consistent:
1. §1 numbers are the old list's rows (1-21) and carry no J labels; the §1 → §4 mapping is implicit (row 3→J2, 2→J3, 4→J1, 5→J4, 6→J8+J9, 7→J11, 9→J10, 14→J12, 20→J5+J6). **J7 has no row in §1 at all**, and §0 never names it. Fix: add 「（J3）」 etc. to each 「定版」 cell, and a line in §1 「新增（清单里没有）：J7 报告里的后台语气」.
2. §0 "第一批 7 处，已有实测，直接切换" vs §3 rules 7-9 (re-set thresholds on the shipped form), A6 (top up corpora), B4 (re-set J3's threshold): see F2.
3. §0 "Jev 的结论只做两类事 ... 做错了代价大的方向，要求更高的把握" is not operationalised: the §3 registry row has 「阈值」 but not 「代价大的方向」. J5 passes at an ordinary threshold (F3); J10 may lower depth (F9); J11 truncates context (F4). Fix: add a field to the registry row and a column to §4 tables: 「做错代价大的方向 / 该方向的阈值」.
4. §1 row 7 (memory: "都不相关" cut-off) vs §4.2 J11 (per-record floor): F4.
5. §3 "两种结果" vs three metric outcomes (F20.5).
6. §3 gateway "请求体 site/state/questions" vs "问题怎么构造" in the registry (F6).
7. §3 "用途都从令牌里取": the runtime's model-gateway token carries no purpose (S2 B2.6); purpose has to come from the site row. Folded into F6's fix.
8. §3 "同时满足 2.0 记账需要" vs 2.0 §7.5 (F14).

## D. Design soundness (item 3)

### D.1 Can a Jev verdict authorize, block, withhold, or touch safety?
- Safety/security: J7 explicitly leaves the SAFETY tier, `clinical-safety-rules.json`, emergency patterns, pharmacist rules, capsule scan, injection defences alone (§4.1 J7, §4.3). Good. No site gates a delivery (principle 13, ruling of 2026-09-17), none adds a blocking point (principle 4).
- Authorize: J5 records "通过" without a second look (F3). J4 high-confidence "排除" removes a record from a systematic review for good (F1). J9 high-confidence "同一" merges events (acceptable; add F19). J2 high-confidence `switch_to` moves a conversation to another project (Jev 0 wrong switches in 50, Flash 3; measured on 3-6 projects, F2).
- Block a user: J3 and J2 sit on a live path; with no breaker and a cold connection each unrouted question may wait for a timeout first (F10). J11 would drop context a live turn sees (F4).
- Withhold: none.

### D.2 Principles and owner rulings
| Rule | Status |
|---|---|
| 1, 5 (regex never does language) | J7, J10 move language judgment from regex to a model: consistent. |
| 2, 12, 13 | Nothing added to the chat path beyond the existing classifier. OK. |
| 14 (engineering boundaries) | F6: the gateway takes caller-written questions and state; make it site + input. |
| 15 (every limit has a key and counter) | F10: per-site timeout/concurrency keys absent. |
| 20 (five questions) | (b) not answered for J1 (a direct Flash call gives the same gain), J4 and J12 (prompt/one-line fixes); (e) not met for J11 (no reproduction, no control). |
| No shadow phase, no bake-off | The plan removes the shadow phase (§1 row 21). The 2% audit is a standing sample; call it 「常设漂移监测」. My F2 request is a wording correction plus an optional one-off regression on the existing corpora, not a trial. |
| Owner's to-do minimal | Two items. The second (自动充值) is not a precondition by the plan's own fallbacks (F13). |
| VCR untouched | J3's catalog contains the module-only GEO/VCR capabilities (S1 §3.2); say the list and behaviour for them stay as today (F5). |
| Compliance out of scope | F8 corrects a wrong sentence only. |
| All Flash, never Pro | No Pro anywhere. OK. |

### D.3 Places where splitting a call adds cost instead of saving it
- J10: "升一代，重新理解" adds a parse + an understanding agent run for every file Jev re-types (F9).
- J5: each manuscript gets an extra full-manuscript Flash call (the §9 injection pre-check), and FAIL/uncertain items still go to Flash; the saving exists only on PASS items.
- J4 "不符合第 k 条" template: needs a per-criterion question, which the plan does not have (F1.5).
- J7 / J10 / J11 add a model call where there was none (a regex, a regex, nothing). That is a capability change, not "替平台省下一次大模型调用"; §0's two-bucket description should have a third bucket 「替掉一段做语言判断的正则」.
- J8 as designed sends 25 questions per entry (F13).

### D.4 Missing fallbacks
- §4.2 has no fallback column for J8-J12 (only §3 generic text). S1 §1.4: the frontier screen has no rule-based fallback; on provider failure an entry waits (provider pause) and after 3 other failures it is `failed` with `frontier_screen_invalid`. With Jev as primary, say 「Jev 失败或没把握 → 原来的 Flash 筛选，不计一次失败」. Add the column.
- Outside the hosted deployment (F17).
- Slow-but-up Jev (F10).

## E. Missed items from the notes (item 4)

1. S2 A1: usage of `evimed_screen_batch` is unmeasured (F1.6).
2. S3 §6.4 / §6.14 (never auto-accept anything from an interested author; random audit of accepted verdicts): the audit is in; the auto-accept rule is not applied to J5 (F3).
3. S3 §1.5 / §6.8 account-wide dynamic rate limits (F10).
4. S1 sweep B lists principle-5 regexes the plan neither takes nor declines: `geoMarket.mjs:172-191` (outlet blacklist from vendor remarks, S1 verdict REPLACE), `evolutionToolRouting.mjs:8`, `evolutionMaintenance.mjs:279` (Jaccard for "same tool"), `evolutionIntegration.mjs:140`. S2 C10 adds: 论文审稿 P7 IssueVerifier (a yes/no per issue already closed, keep-on-failure) and the 科研选题 relevance gate (`task_service.py:380-415`, lexical, a recorded incident kept 3 of 688, fixture `tests/data/missed_dialysis_retrieval_2026_09_27.json`). §0 reason 3 promises that "做语言判断的正则可以由它替掉", then touches two regexes. Fix: either list these in §4.3 with a reason (「暂不接：GEO 市场调研模块未启用 / 没有标注」) or drop the promise from §0.
5. S2 C4 finding 3: MR GWAS selection is skipped when explicit sources are given (F15).
6. S1 §5 ASIDE and the learning-loop caps: F11.
7. S3 §3.7 / memory: vendor availability history (F10).
8. S1 §10: `interpretOverride` caller does not check the option is in the list; the plan adds the check (good) but only inside J12 (F12).

## F. Readability for the owner (item 5)

1. **The conclusion does not name the decisions.** §0 says 「接 12 处」 and never lists them; the owner must read §4. Fix: add after 「裁决」 a seven-line list, e.g. 「接：方法合并初筛、飞书分拣、能力路由、论文审稿逐条判定、MR 选数据集、报告里的后台语气、前沿入口筛选、前沿同事件判断、资料类型……（各一句：今天怎样、以后怎样、没把握时怎样）」.
2. **Unexplained first uses.** 「μ」 (an open-source coding-agent project; "那篇文章" is about it), 「那份清单」, 「状态」 (the text Jev is given to read), 「L1」, 「DSH」, 「接缝」, 「插件行」, 「判定路由」, 「引擎凭证」, 「工作负载令牌」, 「MRR」, 「CFETS」, 「HTTP/2」. And §0's 「能力路由 0.82 对 0.74」 never says it is accuracy. Fix: one-clause glosses at first use; or move the plumbing words to an appendix.
3. **§1 is process.** About 50 lines review an earlier chat list and fact-check an article before the decision tables appear. Fix: keep a three-line 「相对那份清单改了什么」 in §0, move §1 (the 21-row table and the μ article check) to an appendix 「与清单、与文章的对照」.
4. **§3 is a design document** (gateway identities, metric names, config keys). Fix: §3 for the owner = 「一个接口、每点可单独关、失败回原路径、账本按点记账、阈值在中文语料上定」; the rest under 「实现要点（给开发看）」 at the end.
5. **Table cells are paragraphs.** J1, J4, J5, J6, J7 cells carry 60-120 characters with file:line, call counts and fix lists. Fix: three short columns 「今天 / 改成 / 没把握或出错时」 (one sentence each); file:line and counts go in the TODO line or the appendix.
6. **Over-long bullet in §0 gain 2** mixes three claims (the saving, the defect, the pointer). Split into one claim per sentence (see F11 text).
7. **Narration to remove:** 「这些不影响本方案的结论」, 「这是既定裁决」, 「做起来很小」, 「它是回归检查，不是新增实验」 (defends against a ruling nobody raised), and the 「那篇文章的说法」 block.
8. **What reads well:** 状态 and 依据 on top; 「你要做的只有两件」 at the end of §0; §4.3 as a plain table; §9 one-line rows; the J-row structure itself.

## G. Final checks

- Plan file at the end of my review: mtime 2026-10-06 12:17:37Z, md5 2487bec48dbba4bfd283455355d86330, unchanged since I last re-read it in full (so every quote above is from this version).
- Not verifiable by me (no note or file in reach): all production usage numbers in §2.3, "近 14 天 21 次 0.07 元", "autopilot 9 次 0.01 元", the 96% / 36.4 yuan frontier split, "生产近 14 天飞书调用为零", the 36-63 calls per manuscript (plausible from the rubric item counts and the serial loop at `methodology_reviewer.py:396-398`), and the monthly dollar figure.
- Network: none used. Repo: nothing modified.

## H. Top findings, in order

1. F1 J4 contradicts the plan's own evidence (criteria decide, Meta prompt already 14/14 at 90.5%, Jev's 14/14 was tuned on the two lost papers, n=14, Meta contract not a bare 3-way). Fix the prompt, not the vendor path.
2. F2 "已有实测，直接切换" is false for the shipped shapes (3-6 vs 51 projects; 11 vs ~25 capabilities; 6-8 vs 50 candidates; CONSORT Methods vs 15 checklists on full text) and the Flash baseline had thinking off where production has it on.
3. F3 J5 auto-passes in the direction where Jev is worse (missed-defect rate 38.4% vs 34.4%), reports only the metric the pipeline already repairs, and contradicts §0's own "更高把握" rule and S3 §6.4.
4. F4 J11 rests on a "clean cut-off" that exists only in one corpus (gold as low as 0.14; distractors up to 0.92), was never tested on a query with no relevant record, differs from §1's design, and has no evidence of need.
5. F6 Gateway lets the caller write questions and state: breaks rule 7 and the one-allowlist pattern; make it `site` + `input`.
6. F7 J7 changes three consumers (`contractRegistry.mjs:261`, `geoContracts.mjs:225`, three tests), calibrated on three clinical reports only; the run loses in-turn repair.
7. F9 J10's "升一代" re-parses and re-understands every re-typed file; depth can be lowered by a model verdict; sends 6,000 characters of arbitrary uploads.
8. F10 No numbers/breaker for online paths; cold connections on a 3-calls-a-day site; one account-wide rate limit shared with background sites.
9. F8 §9's data-egress row is wrong about precedent (reply check sends model output; the new sites send the researcher's own text, manuscripts, files, reports).
10. F11 J1's gain is not Jev-specific, "每小时启动" is overstated, and B1 switches on DECIDE/BUILD with uncapped learning spend; §0's 「省掉空跑」 describes the opposite net effect.

(Then F5, F12-F20 as above.)

## I. Overall verdict

The plan is careful where it checks code: every file/line reference I sampled (31 rows above) is right, the §6 learning-loop defect is real and well explained, the count/J-number structure is consistent, the TODO covers every J site, nothing gates a delivery, and the safety tier is correctly left alone. Its weakness is that the evidence it leans on is thinner than the labels say. "已有实测，直接切换" does not hold for J2, J3, J4, J5, J6 once the measured shape (3-6 projects, 11 capabilities, 6-8 candidates, Methods-only text, thinking-off baseline, criteria tuned on the test cases) is set against the shipped shape, and for J4 the plan's own sentence 「模型本身影响不大」 argues for a prompt change, not a new path; J11 and J12 have no usable evidence at all; J5 hands Jev the one direction where it is measurably worse. The design also has three real gaps that matter more than any single number: the gateway lets callers write the questions, the online sites have no breaker or timeout numbers on a cold cross-Pacific connection, and the data-egress row is wrong about precedent. I would not publish it as 定版 yet. With F1-F4, F6, F7, F9 and F11 applied (J4, J11, J12 out or reduced, J5 restricted to CONSORT with a higher pass bar, the gateway reshaped, J7 and J10 re-scoped), the plan becomes roughly 9 sites, each with a measured form and a fallback, and the owner's two actions stay at two. Readability needs one pass: name the decisions in §0, gloss μ/状态/L1, and move §1 and most of §3 to appendices.
