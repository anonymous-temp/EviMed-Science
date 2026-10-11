# N3 - Jev sweep of areas not covered by the two earlier sweeps

Read-only. Paths relative to /workspace/workspace/EviMedScience unless absolute. The release worktree (/workspace/evimed-wt/release) differs from the main tree only in unrelated files (frontier_search.py, gene_expression*, geo_platform.py); runtime/mcp dedup/normalize code was read from the main tree.

Cross-cutting constraint (applies to every Python engine and to the runtime MCP): Jev is a provider call. The runtime container holds no provider key (CLAUDE.md, safety defaults), so sites in runtime/mcp/evimed-research cannot call Jev directly. They need either a control-plane gateway (like frontier_search / geo_read), or the judge has to run on the control plane over data the tool returns. The Python engines already hold their own DeepSeek key (llm_service / LLMGateway), so a Jev client there is a local change.

## 1. 项目代码/knowledge-plugin

Finding: the plugin contains NO LLM calls at all (grep for llm/openai/deepseek in knowledge_plugin/ hits only the words "enrollment" and a doc string). Every language decision is a regex, a closed list or a script share. Source relevance, item type and cross-source semantic dedupe are deliberately left to the platform (frontier screen, same-event, both already covered).

### 1.1 Correction / retraction notice flag
- knowledge_plugin/normalize.py:219-233 (`_CORRECTION_NOTICE`, `is_correction_title`), structured twin at adapters/eutils.py:52 (`NOTICE_PUBLICATION_TYPES`) and :248.
- Today: anchored title-prefix regex (phrase + end / colon / to|in|on / "for ... et al"). Misses: "Erratum regarding ...", "Statement of Retraction", "Retraction and replacement", "Notice of Duplicate Publication", "Editorial note", "Addendum", "Corrected and republished article", "Removal of ...", CN "关于...的更正/撤稿". Flag is advisory; platform decides the drop.
- Closed question: choice {notice-of-correction, retraction, expression-of-concern, other-notice, research item}. One title (plus source name) is the state.
- Volume: every journal/feed item, order of thousands per day; only titles that the regex did not match and that come from journal-like sources need a call.
- Fallback: keep the regex flag; Jev can only add a flag, never remove one.
- Labelled data: strong and free. PubMed PublicationType (Published Erratum, Retraction of Publication, Expression of Concern) labels every PubMed/Crossref-with-PMID item; tests/adapters fixtures hold titles. Missing: non-PubMed (Crossref-only, CN journals) labels.
- Verdict: possible. Quality gain is real but the frontier screen model already sees the title, so the marginal value is the plugin's own `facts` flag and the update_to linkage, not the drop decision.

### 1.2 Masthead / non-article page flag
- normalize.py:204-229 (`MASTHEAD_TITLES`, ~50 exact whole-title strings).
- Today: exact match after _norm_title. "Volume 12, Issue 3: Cover", "Cover Image: Figure 2", "Issue Information - Obstetrics" slip through.
- Closed question: choice {masthead/front-matter, correction notice, article, other}. Same state and fallback as 1.1; can share one call (a four-way choice on the title).
- Verdict: possible (merge with 1.1; one choice call).

### 1.3 Language tag
- adapters/common.py:176-188 `guess_language`: CJK share >= 0.3 -> zh else source default / `und`. Comment says the platform screening model is the language judge.
- Closed question: choice among ~15 BCP-47 tags on a short title. Failure mode: mixed Chinese-English titles, Japanese kana-only (share counts CJK ideographs only, not clear), `und` for English from `multi` sources.
- Volume high (every html-list item); cost trivial. Labelled: PubMed language field (adapters/eutils.py:55) gives labels for PubMed rows.
- Verdict: no. Script share is a decidable property, errors are cosmetic, a deterministic detector (fastText/lingua) is the right tool, not Jev.

### 1.4 Item type / lane_hint
- lane_hint comes from registry config (model.py LANES; normalize.py:419) and kind from adapter, not from content. No content-based "news vs article vs press release vs conference item" decision exists in the plugin. Missing decision, not a regex.
- Verdict: no for the plugin (platform lane assignment on deepseek-flash is already covered by frontier screen).

### 1.5 WeChat classification
- 28 sources with `wechat_name` + 8 with `wechat_account` in registry/sources.json; adapter `wechat-bridge` is declared but not built (adapters/__init__.py:8, model.py:48, fetch.py:8). Identity rung `wx:<biz>:<mid>:<idx>` exists.
- When built: official-account posts mix clinical news, course/recruitment ads, conference promotion, reposts. A choice {clinical-news, guideline/policy, trial/paper interpretation, advertisement/course, recruitment, other} on title + first 300 chars is a textbook Jev site.
- Volume: tens of accounts x a few posts/day. Fallback: platform screen.
- Labelled data: none yet (bridge not built); registry/research/ may hold dry-run findings (not opened).
- Verdict: possible, prospective. Decide at bridge-build time; overlaps frontier screen.

### 1.6 Cross-source duplicate
- Identity ladder doi > pmid > wx > reg > fda > url-sha (normalize.py header, :122-129); store.py:92-122 dedupes by content_sha256 per key. Same news item from two outlets with different URLs and no DOI is not merged in the plugin.
- Decision handed to platform same-event (covered). Verdict: no (already decided).

### 1.7 Not language decisions (confirmed no)
fetch.py:132-141 WAF/challenge-page signatures (byte patterns), adapters/common.py:139 TRUNCATION_MARKS (closed list, format), enrich/page.py body-container CSS selectors, urltemplate date regexes. All decidable; leave.

## 2. Six engines, secondary closed sites

### 2.1 论文审稿 IssueVerifier
- src/agents/narrative_generator.py:194-279 `_verify_issues_with_llm`. One STANDARD-tier JSON call per batch of 30 issues; context = title + abstract[:1200] + methods[:800] + results[:600]; rules: wrong study type -> absent, already covered -> absent, unknown -> present (conservative). Failure keeps everything.
- Closed question: noul per issue "does the excerpt already contain what this issue says is missing / is this issue applicable to this study type". State per issue = excerpt (~2.6k chars) + one issue (title + 200 chars). That is longer than ideal and includes distractors (issue list in one prompt today; per-issue calls remove that).
- Volume: a few dozen issues per review. Fallback exists (keep all). Labels: none specific; evals/peer-review/briefs.json only holds briefs.
- Verdict: possible. The "wrong study type" half is clean Jev (study type + issue title: short); the "already covered" half needs the excerpt and is the weak half. Split it: Jev for applicability, keep the LLM for coverage. Never use it to drop an issue on the severe tier without a keep-on-doubt threshold.

### 2.2 论文审稿 study-type canonicalisation + checklist selection
- src/agents/review_planner.py:215-250 `_normalize_study_type` (substring map, 20 entries; unmatched types pass through); src/orchestrators/multi_rubric_orchestrator.py:87-130 `_select_top_4_rubrics`: exact dict hit, then substring on `key.split()` words in either direction (so any type containing "review" or "study" can hit an arbitrary key), plus a keyword-pair "ambiguity" rule that downgrades confidence and appends "Ambiguous Review".
- Detection itself is already LLM: document_analyzer.py:495-552 picks study_types from RECOGNIZED_STUDY_TYPES over a long document context (that long-state call should stay with the LLM; Jev is weak there).
- Closed question: choice of one canonical RUBRIC_PRIORITY key (~40 options, <=255) from a free-text study-type string plus title. Short state. Also replaces the ambiguous-keyword heuristic with a score on "is this a systematic review that follows PRISMA".
- Volume: 1-5 strings per review (tiny), but a wrong checklist poisons the whole review. Fallback: universal_rubric (already the default).
- Labels: 15 YAML rubrics + tests/test_rubric_provenance.py; no labelled free-text -> key table. Cheap to build from past runs' study_types vs chosen rubric.
- Verdict: strong for the canonicalisation (closed, short, current code is accidental substring matching).

### 2.3 科研选题 relevance gate
- services/task_service.py:380-425 `_filter_relevant_records`, :331 `_required_concept_groups`, :302-327 `_is_pediatric_dominant` (CJK + English phrase lists for "pediatric-dominant").
- Today: record kept iff every concept group has one form as a whole-word substring of title+abstract+keywords+MeSH. The 2026-09-27 incident (tests/test_retrieval_recall.py): 688 retrieved, legacy gate kept 3, grouped gate keeps 138. Fix moved the "which phrases are one concept" reading into the query model (concept_groups). Still lexical per record.
- Closed question: score/noul "does this record address the research direction (population + intervention/exposure)", state = direction sentence + title + abstract (<=2k chars). A second small choice {adult, pediatric, mixed, unspecified} replaces `_is_pediatric_dominant`.
- Volume: ~700 records per job, 5+ jobs/day -> thousands of calls; trivially cheap.
- Fallback: current lexical gate (keep as the OR-branch: lexical pass OR Jev yes, so Jev can only widen; this is the failure the incident showed). Thin-evidence path already exists.
- Labelled data: tests/data/missed_dialysis_retrieval_2026_09_27.json has 48 verbatim records plus pre-fix structure, but NO per-record relevance labels (keys: id, pmid, title, abstract, keywords, mesh_terms, publication_year). It records outcomes only (legacy kept 3, grouped kept 138 of 688; the 48 are a subset). Needs ~100 hand labels; a one-hour job. This is the best-grounded incident fixture in the tree.
- Verdict: strong.

### 2.4 科研选题 study-design tagging
- services/pubmed_service.py:607-692 `_identify_study_design`; duplicate logic in services/internal_db_service.py:75-125 `_normalize_study_design` (comment says kept "consistent" by hand). Step 1 is PublicationType (decidable, keep). Steps 2-4 are substring cues on title+abstract: `'cohort'|'registry'|'retrospective'|'prospective' in combined -> Cohort` (a prospective RCT described as "randomized, double-blind" without the phrase "randomized controlled" becomes Cohort; a meta-analysis of cohort studies that lacks the pubtype becomes Meta-analysis only because that cue runs first), 'survey' in title -> Cross-sectional, default `Clinical Study`/`Other`. Downstream: `is_clinical` set, evidence stats (pubmed_service.py:576, :745).
- Closed question: choice among ~14 designs on title + abstract (+ the pubtype list as text). State ~1.5-2k chars.
- Volume: every record, hundreds per job. Fallback: current cascade. Labels: silver labels free; records resolved by step 1 carry PubMed PublicationType, so accuracy of cascade steps 3-4 and of Jev can be measured on the records that have a pubtype by hiding it.
- Verdict: strong (and collapses the two duplicated implementations into one call).

### 2.5 meta: duplicate publication / same-trial detection
- tools/multi_search.py:302-322 `_deduplicate_by_doi_pmid_title`: DOI/PMID or EXACT lowercase title. A preprint and its journal version (different titles), "Trial X: primary results" vs "Trial X: 2-year follow-up" and the same trial reported in two journals are all kept; they then reach screening as separate records. tools/utils.py:69-85 `paper_identity` is pmid > doi > ids > title-hash. main.py:446-790 handles duplicate publications of the SAME effect totals by exact arm totals (numeric, decidable, keep). core/primary_analysis_alignment.py:917-960 + extraction_verification.py:669 `trial_unit_issues` joins trial aliases only when a source states both ID and name (explicit design, no scan).
- Closed question: same/related/different of two titles + first 300 chars of abstract (+ years, authors' first author as text). Candidates must be generated by cheap blocking (shared first author, year within 3, token overlap) because pairwise is quadratic.
- Volume: after blocking, tens to low hundreds of pairs per review. Fallback: keep both (today's behaviour).
- Labelled data: the meta eval cases (evals/meta-analysis, capability-audit meta runs under evals/capability-audit/tool-probe-workspace/meta-analysis-runs, `parsed_papers.json`, extraction JSONs) and the 2026-09-28 ma-001 incident (eight trials none provable independent); PubMed "CommentIn/UpdateIn/Retraction" links are free positives for related. Same-trial labels still need hand work.
- Verdict: possible. Related != same: Jev can propose "same trial, different report" for a human-free review only as a flag attached to the pair (consistent with the 2026-09-29 owner rule: no mandatory adjudication, carry as limitation). Do not let it merge rows silently.

### 2.6 meta: full-text publication role (fallback regex)
- agents/screening_agent.py:865-922 `_classify_full_text_evidence_role` (called at :840 only when the model did not return `publication_role`). Title regex lists: design_patterns, secondary_patterns ("by age", "according to", "with and without", "by glycaemic"), surrogate_title_patterns ("quality of life", "kccq", "pcwp", "gut microbiota", "6-minute walk", gated on the protocol outcome containing death/mortality/hospitalisation/cardiovascular). Result decides route primary_extraction vs related_source_only (:845).
- This is open-vocabulary prose regex with incident-specific terms baked in (principles 5, 7).
- Closed question: choice among {primary_publication, secondary_analysis, design_or_protocol, adjacent_outcome_trial, other, uncertain} from title + abstract (+ protocol primary outcome as one line). The main call already returns the same enumeration (prompts/screening_prompts.py:29, :124), so the labels' definitions exist.
- Volume: only when the LLM omitted the field (rare); but Jev would also be a cheap second opinion on every included paper.
- Fallback: `uncertain` routes to primary_extraction (:844), already conservative.
- Labelled data: screening outputs with publication_role in capability-audit and meta eval runs.
- Verdict: strong (replaces a regex that the principles say should not exist; low risk since route default is conservative).

### 2.7 meta: full-text upload to record matching
- core/fulltext_uploads.py:255-300 difflib SequenceMatcher + title-token overlap between an uploaded PDF (filename + first text) and candidate records; thresholds hand-set; priorities table :286.
- Closed question: same/related/different between "title of record" and "head of uploaded PDF" (short). Candidate list is the project's record list.
- Volume: a handful of uploads per project. Fallback: current score + `uncertain` ask.
- Verdict: possible (low volume, current method is decent because DOI/PMID/title-in-text hits are decidable and run first; use Jev only below the title_similarity rungs 0.40 / 0.20 priority).

### 2.8 meta: outcome matching
- No lexical outcome-name matcher found (extraction_review.py `_override_matches` is index/ID based; ipd_ingestion.py:290 `_normalize_outcome_type` and :306 `_outcome_direction` are small closed maps). Outcome alignment is done by the LLM with quote anchoring (primary_analysis_alignment.py), and the quote check is decidable. Verdict: no (not found / already model + code).

### 2.9 药物安全分析agent term-to-vocabulary matching
- safety_agent/normalize/adr.py:34-88 (`normalize_adr`), vocabulary.py:184-220 (`resolve`, `candidates`), adr_map.py:21 (ZH_TO_PT, 165 entries; EN_ALIAS_TO_PT 69), data/faers_reaction_terms.json (11,703 PTs). Order: zh map, en alias, vocabulary exact/punct/spelling/inflection, then `unresolved` with difflib candidates (confidence 0.0) or `ambiguous` (<=5 terms). normalize_adr_async (adr.py:117-165) already asks the model for a free-text PT, accepted only if the deterministic steps or an openFDA count confirm it. Unresolved terms end the request: pipeline.py:181-223 -> "ADR 词无法归一化" with reason `unresolved_reaction_terms`.
- Closed question: choice among the lexical top-N (difflib + substring + inflection, N<=255; for Chinese, all 165 ZH_TO_PT targets or a pool built from the ZH map values) for "which FAERS PT does this user term name, or none". A short term against short PT strings: Jev's sweet spot, and it replaces the free-text generation (which can hallucinate a non-PT) with a constrained pick.
- Volume: only for terms that miss the deterministic steps; low per request, but every miss is a hard failure today.
- Fallback: keep openFDA count confirmation as the verifier (a PT with zero reports is dropped), keep `unresolved`. Constraint: this feeds a pharmacovigilance signal. Jev only picks the PT label; it must not touch signal values or the safety verdict, and the openFDA confirmation stays mandatory.
- Labelled data: tests/test_reaction_vocabulary.py (ZH map members are vocabulary terms) gives ~165 + 69 positives; no unresolved-term log in the tree (production incident list not available here).
- Verdict: strong, with the openFDA confirmation retained. Also covers drug names? normalize/drugs.py:153-275 is a rule + LLM generic-name suggestion validated against openFDA; leave.

### 2.10 文献剂量分析 keyword/term merging
- src/bibliometric/cleaning/normalizer.py:262-308 `_build_keyword_mapping` merges only case variants; `_merge_keywords` dedups lowercase and drops MESH_STOPWORDS. No synonym/variant merge ("COVID-19" / "SARS-CoV-2" / "coronavirus disease 2019", "type 2 diabetes" / "T2DM", plural/hyphen) before co-occurrence networks (analysis/matrix_builder.py:22 builds from `keywords_merged`), so clusters, burst detection and the frontier output are split by spelling.
- Closed question: same/related/different for two keyword strings (<=60 chars each). Needs candidate pairs (token Jaccard, abbreviation initials, edit distance) over the top ~500 keywords by frequency -> a few thousand pairs.
- Fallback: today's exact casefold merge. Labels: none in tree; MeSH entry terms (available from MeSH) are free positives for synonyms; mesh_terms are already in the records.
- Verdict: possible. Value is real (the whole network analysis is spelling-sensitive) but must be offline-cached per term pair; abbreviations without context are exactly where cheap models are weakest, so keep the "related" band out of merges.

### 2.11 孟德尔随机化 exposure/outcome entity matching
- tools/gwas.py:282-316 `_normalize_trait`, `_filter_and_parse`: substring and >=5-char word match of the user phrase on the OpenGWAS `trait`. Candidate GWAS choice itself is the already-covered "MR GWAS pick". The lexical pre-filter that feeds the pick is the remaining gap: a keyword like "heart attack" never reaches the pick list because the filter requires a substring of "Myocardial infarction". Jev can be used as a candidate generator over the local GWAS database (_get_gwas_db, thousands of traits; needs blocking to <=255 first) or, better, as the choice in the already-covered pick with a larger list.
- Verdict: no new site (belongs to the covered pick; flag the pre-filter recall gap to that owner).

## 3. runtime/mcp/evimed-research

### 3.1 evidence_deduplicate
- server.py:1230-1262 `_deduplicate`: keys doi, pmid, url, exact `_normalize_title` (casefold, word tokens). A preprint/journal pair, "(Review)" vs "Review of X" titles, and translated-title variants are kept as unique; the tool summary says "Deduplicated N into M" and the model treats that as authoritative. Same decision as 2.5, at run time.
- Closed question: same/related/different on title (+ first author + year if given). Items come from the model's own list so the state per pair is short.
- Constraint: no provider key in the runtime, so it needs a gateway round trip or a control-plane job. Today tool is pure and offline on purpose (principle 15, "deterministic and offline"). Alternative with no key: return `possibleDuplicates` pairs via cheap blocking (first-author + year + token Jaccard) in the result so the model sees them: no Jev needed.
- Fallback: current exact dedupe. Labels: PMIDs from literature_search + PubMed "UpdateIn/CommentIn" links.
- Verdict: possible, only through a gateway; the lexical `possibleDuplicates` hint is the cheap first step.

### 3.2 term_normalize misses
- server.py:1015 `TERM_VOCABULARY` (curated, exact casefold key) and :2272-2370. A miss returns the input unchanged with a warning ("No curated normalization exists ... not an authoritative normalization"). Online helpers exist but are off by default (`annotate`, `mesh`); RxNorm for drugs.
- Closed question: choice among the curated keys (size: a few hundred; <=255 per shard) for "does this term name one of these concepts". Model-called tool already has an LLM (the run itself), so a Jev choice here adds little: the caller can match the term itself and the tool tells it so.
- Verdict: no (the calling model is the better judge; the tool correctly refuses to guess).

### 3.3 Tools whose result could carry a judge label
- literature_search (relevance), frontier_search (frontier_search.py:60 already renders feed flags; labels come from the platform's own editor), kb_search.py, web_search.py. Tool descriptions say explicitly "never infer study design, evidence level ... from a title" (server.py:502). Adding a Jev relevance label to a literature_search result would (a) require a key in the runtime, (b) contradict the Principle-12/13 rule that tools return facts, not judgments, and (c) overlap the run's own reading.
- Verdict: no for run-time labels. If wanted, attach labels on the control-plane side of gateways (frontier_search/kb) only.

## 4. OpenScience/evals harnesses with an LLM judge

| Harness | Judge | Closed + cheap enough? | Verdict |
|---|---|---|---|
| open-domain-answer-quality/judge.py | deepseek-v4-pro, 5 dimensions 0-5 over answers up to 60k chars | directness ("conclusion in first paragraph") is a short-state score; readability token leaks are deterministic; correctness / calibration need the whole answer | possible for `directness` only (first paragraph + question); rest no |
| title-to-paper/grade_results.py:213-272 | v4-pro thinking high; reference JSON up to ~130k chars | long, number-heavy, distractor-heavy | no |
| method-quality/run_paired.py, paper-gold/score_existing_methods.py | LLM calls, offline | method-pair judge already in the covered set | covered |
| frontier-editing/run_eval.mjs, run_policy_control.mjs | call the production FrontierEditor (same-event judge) | already the covered frontier site | covered |
| capability-audit/run_tool_audit.py, hosted_receipts.py, run_platform_skill_execution_audit.py | model calls to drive runs, not judges | n/a | no |
| context-fidelity/report.py, geo-content/build_pack.py | report builders; judge calls minor | not inspected in depth | no new site |
| drug-evidence-quality/run_benchmark.py | deterministic (hash ids, substring flags like "missing evidence is never zero" at :198) | one substring check over a skill text; a closed-list sanity check | no |

Gaps without a judge today (candidates if one is wanted): evals for the incident fixtures in 2.3 and 2.4 would be Jev-native (closed, labelled). The eval harness could also use Jev as the cheap pre-judge for "is this reply's first paragraph an answer" across the 25 capability evals.

## 5. apps/web client-side language judgment

Confirmed none. Regex use found: frontierText.ts:232, geoText.ts:77/147 (Han/Latin spacing and "has Han" tests for display typography), growthModel.ts (CJK width), ClaimCitation.tsx:48 (URL scheme), MemoryHubPage.tsx:52, SkillsPage.tsx:86, PluginsPage.tsx:42 (client list filters: `toLowerCase().includes(query)`, substring search, not judgment). No intent, language, relevance or classification logic client-side. Verdict: no.

## 6. Ops/scripts

- deploy/web/monitoring/open-science.rules.json: Prometheus alert annotations are static strings over metrics; no free text enters.
- scripts/ops/gate-health.mjs, replay-clinical-gate.mjs: deterministic replays of the domain gate; classify packages by rule outcome and file-age ("wrong" vs "old"), no language.
- No incident-triage, log-classification or alert-summarisation script exists under scripts/ or deploy/ (the only "triage"/"incident" matches are comments or the eval case names). Verdict: no. If a triage job is ever built over production run failures, "failure message -> existing error-code registry" (closed, packages/domain error codes) is the Jev-shaped task, but nothing to attach to today.

## Ranked table

| # | Site | file:line | Closed question | Volume | Fallback | Labels | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | 科研选题 relevance gate | 科研选题/services/task_service.py:380-425 (+302 pediatric) | does record address direction (score/noul) + adult/peds/mixed | ~700 per job | lexical gate as OR branch | fixture of 48 recs but unlabelled; ~100 hand labels needed | strong |
| 2 | 科研选题 study-design tagging | 科研选题/services/pubmed_service.py:607-692; internal_db_service.py:75-125 | choice of ~14 designs | per record, hundreds/job | current cascade | silver from PubMed PublicationType | strong |
| 3 | meta full-text publication role fallback regex | meta/new_meta/agents/screening_agent.py:865-922 | choice of 6 roles | rare to every included paper | uncertain -> primary_extraction | screening outputs in evals | strong |
| 4 | 论文审稿 study-type to checklist canonicalisation | 论文审稿/src/orchestrators/multi_rubric_orchestrator.py:87-130; review_planner.py:215 | choice of ~40 canonical keys | 1-5 per review | universal_rubric | rubric YAMLs, build table from past runs | strong |
| 5 | 药物安全 unresolved ADR term to PT | 药物安全分析agent/safety_agent/normalize/adr.py:34-165; vocabulary.py:209 | choice among <=255 lexical candidates | only misses | openFDA count confirmation + unresolved | ZH/EN maps (~230 positives) | strong (openFDA check kept; label only, never signal) |
| 6 | meta duplicate-publication / same-trial | meta/new_meta/tools/multi_search.py:302; utils.py:69 | same/related/different on blocked pairs | tens-hundreds of pairs | keep both | meta eval runs, PubMed UpdateIn links | possible (flag, never silent merge) |
| 7 | evidence_deduplicate (runtime) | OpenScience/runtime/mcp/evimed-research/server.py:1230 | same/related/different | per call | exact dedupe | PMIDs | possible, needs gateway; start with lexical possibleDuplicates |
| 8 | knowledge-plugin notice/masthead flag | knowledge-plugin/knowledge_plugin/normalize.py:204-233 | choice {notice kind, masthead, article} on title | thousands/day | regex flag | PubMed PublicationType free labels | possible (overlaps platform screen) |
| 9 | knowledge-plugin WeChat post classification | adapters/__init__.py:8 (bridge unbuilt); registry/sources.json 36 wechat sources | choice of post type | tens/day | platform screen | none yet | possible, prospective |
| 10 | 论文审稿 IssueVerifier applicability half | 论文审稿/src/agents/narrative_generator.py:194-279 | does issue fit study type (noul) | dozens per review | keep all (existing) | none | possible (split; coverage half stays LLM) |
| 11 | 文献剂量分析 keyword synonym merge | 文献剂量分析/src/bibliometric/cleaning/normalizer.py:262-308 | same/related/different on blocked keyword pairs | thousands cached | casefold merge | MeSH entry terms | possible |
| 12 | meta full-text upload to record match | meta/new_meta/core/fulltext_uploads.py:255-300 | same/related/different, short | few per project | score + ask | none | possible (low volume) |
| 13 | open-domain judge `directness` | OpenScience/evals/open-domain-answer-quality/judge.py | first paragraph answers question (score) | per eval run | v4-pro judge | existing reports | possible (rest of judge: no) |
| 14 | knowledge-plugin language tag | adapters/common.py:176 | choice of tag | per item | script share | PubMed language | no (deterministic detector) |
| 15 | term_normalize miss | runtime/mcp/evimed-research/server.py:1015, 2272 | choice among curated keys | per call | warn + input | none | no (caller model is the judge) |
| 16 | MCP tool relevance labels | server.py:502 | n/a | n/a | n/a | n/a | no |
| 17 | MR exposure/outcome pre-filter | 孟德尔随机化/mr_agent/tools/gwas.py:293-313 | belongs to the covered GWAS pick | n/a | n/a | n/a | no new site (flag recall gap) |
| 18 | meta outcome matching | not found as lexical code | n/a | n/a | n/a | n/a | no |
| 19 | other evals (title-to-paper, tool audit) | evals/title-to-paper/grade_results.py:213 | long reference grading | n/a | n/a | n/a | no |
| 20 | apps/web | see section 5 | none | n/a | n/a | n/a | no |
| 21 | ops alerts / triage | deploy/web/monitoring, scripts/ops | none exist | n/a | n/a | n/a | no |

Top picks for a first batch: 1, 2, 3, 4, 5 (all engine-local, closed, short state, existing deterministic fallback, and #1/#2 have incident fixtures). Sites 1 and 2 need ~100 hand labels on the 48-record dialysis fixture plus a PubMed-pubtype-hidden silver set before any switch.
