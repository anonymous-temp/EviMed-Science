# Patient-matching feature-gap audit (snapshot 6e1841609, codex/vcr-platform-benchmark-20261103)

Status: complete; raw notes first, structured audit under "FINAL AUDIT". Paths are under OpenScience unless stated.

## Running notes (raw, first read)

- `vcr_write what:patient_context` takes message / upl_ text / owned KB source only. `patientFormats = txt, md` (apps/server/src/vcrUploadReceipts.mjs:10). 400 KB cap (:13).
- Each patient_context is a new pseudonym: subject `conversation-case:${identity}` where identity = digest(provenance incl. messageSeq) (vcrPatientContext.mjs:54,64). To verify: follow-up.
- Candidate cap 60 per study (config.mjs:1131) vs FROZEN_CANDIDATE_LIMIT 500 (vcrCandidateSearch.mjs:50).
- Unlocated sourceText turned into unknown `criterion_source_unavailable` (vcrPatientTrials.mjs:539-562), though header says "nothing is refused for being a paraphrase" (:24-26).
- ChiCTR listing only; every criterion unknown (vcrGateway.mjs:1350-1353; vcrCandidateSearch.mjs:366).
- skill is 253 lines (capability-skills/vcr-matching/SKILL.md) vs "very short skill" direction.

- Whole silent-criterion path absent: no `whenSilent` / 「未见记载」 in product code (grep hits only source_catalog.json, unrelated). Plan todo M1 still `[ ]` "等裁定" at codex/vcr-algorithms-20261103 docs/superpowers/plans/2026-11-02-vcr-algorithm-todo.md:74; owner has now decided (this brief). evaluator: vcrMatching.mjs:979 unknown→not_recorded; summarizeEligibility:1205 any unknown→insufficient_evidence, so "eligible" is nearly unreachable on real trials.
- next-stage-todo.md:17: 278 `not excluded` rows predicted unknown = 80.1% of disagreements. Task 1 acceptance says "No blanket unknown-to-favorable conversion" – compatible with per-criterion model judgment + label, but the plan does not encode the owner decision.
- language job prototype: candidate-only, ≤20 units a job (vcrLanguageExecutor), thinking disabled, requires model-counted UTF-16 start/end spans; `complete` is computed with state==='completed' while the executor writes 'awaiting_reevaluation' (never complete, branch 1a4350df4 vcrLanguageExecutor.mjs). Not registered. Plan: "Protocol direction remains unavailable".

- Batch reading deferred at vcrMatchBatchMaxSubjects default 300 (config.mjs:1146), must be restarted by the model (domain vcrMatchBatch.mjs:206; statement). Concurrency default 3, hard min(8) (server vcrMatchBatch.mjs:381; config.mjs:1147).
- Language criteria not answered by match_extract: planBatch languageNote (server vcrMatchBatch.mjs:280). All-language protocol => variables=[] => no job, state 'language_pending' (:293-297, :568). The whole-clause skill direction therefore moves protocol work out of the only batch path.
- recheckDue uses matchScenario(study) = latest protocol only; candidate trials not visited (vcrComposition.mjs:924-945) (verify dueRecheckSubjects).

- Page caps: `ordered.slice(0, 50)` patient list (apps/server/src/vcrViewsTabs.mjs:1614); `tab()` reads listAssessments limit 200 (vcrComposition.mjs:658); top-5 gaps only (vcrViewsTabs.mjs:1636-ish `.slice(0, 5)`); basisUpdated.subjects `.slice(0,50)`; no per-criterion funnel in presentMatchingTab (to verify), no matching export kind: VCR_EXPORT_KINDS (packages/domain/src/vcrVocabulary.mjs:952-956) has none.
- PatientTrials page: no coverage/registry sentence, no export, no unjudged list, no search parameters (apps/web/src/components/vcr/tabs/PatientTrials.tsx). Page's list only includes judged trials (vcrPatientTrials.mjs:672).

- import_documents: csv/tsv only, one row = one subject, duplicates refused, table.rows>200 refused whole (`vcr_intake_payload_invalid`), 400 KB per note (apps/server/src/vcrDataIntake.mjs:33-34,75,91-97). So 300-patient note batch can't arrive in one file through conversation; multi-note patient refused.
- subjectTableFacts: every non-empty cell → polarity 'affirmed' (vcrMatchingTable.mjs:130-138). `present x` with cell 0/No/否 → SATISFIED (vcrMatching.mjs:694-703, withinWindow no window). exclusion → not_satisfied → ineligible, and prefilter then skips the notes (server vcrMatchBatch.mjs:310-316). FALSE EXCLUSION from table: to be run.
- table variable mapping exact-name only (vcrMatchingTable.mjs:73-81) "Nothing here guesses a mapping".

- patient_context input keys only messageSeq/sourceId/generation/sha256 (vcrPatientContext.mjs:13); no subjectKey param; new message = new identity = new pseudonym (:54,:64). Follow-up fact has no write target: `fact` needs documentId+verbatim quote.
- match_extract result: status 'succeeded', conclusion 'estimable' regardless of failed records (server vcrMatchBatch.mjs:513-535); notice headline null when records_read=0 → title 「病历阅读完成」 with no reason (vcrNotify.mjs:127-131). failures not in notice. match_criteria no headline at all.
- Completion re-enters the conversation as automated turn (vcrConversationCompletions.mjs:219-220) "Nobody is attending this turn".

## Plugin notes (raw)
- Jev pin jev-1.13.0, TypeSafe key OPEN_SCIENCE_TYPESAFE_API_KEY_FILE; master switch OPEN_SCIENCE_JEV_ENABLED default on (config.mjs:1495-1542); sites J1-J23 + reply-check, meta-evidence-role, peer-review-checklist (judgeSites.mjs:9). No matching or trial ranking site exists. Call sites live: J1,J3,J4,J5,J6,J7,J8,J9,J11,J12,J13,J15,J17,J18,J19,J20,J21,J22,J23,reply-check. J8 etc via judgeGateway engine allow list (judgeGateway.mjs:14-23).
- calibrated sites in deps: J2,J3,J4,J23 (+reply-check). Others uncalibrated.
- Reranker: qwen3-rerank (deps-version.json openviking.rerank), DashScope, `MemoryRerank` class (memoryRerank.mjs) instantiated for memory (server.mjs:1526) and KB (server.mjs:2366); fails open to given order. Not called from any vcr*.mjs (grep).
- Measurements: evals/vcr-model-comparison README + results/2026-11-02-summary.json. Flash 57.59 / Jev113 53.88 / Jev114 52.69 on 837 rows; cascades no gain → no Jev criterion judge. nDCG@10 BM25 .4517, DashScope .4740 (.4760 with clinical instruction), Jev1.13 .5058, Jev1.14 .5068 on BM25 top-10 of 165 TREC topics. Flash direct latency p50 1.34s p95 1.91s, ¥0.497 per 251 requests (1,015 annotations). Strict missingness 55.67% vs TrialGPT prompt Flash 73.89% vs GPT-4 cache 87.29% (evals/vcr-trialgpt-reproduction/README.md).

## Evidence from prior runs (raw)
- 53 first attempts: 31 complete, 12 failed, 5 timeout, 3 interrupted, 2 no saved result. 33/105 pairs no criterion row. 256/603 agreement vs TrialGPT 519/603. 278 unknown-vs-not-excluded = 80.1% of disagreements; 256 of these "code returned unknown" (docs/superpowers/plans/2026-11-04-vcr-baseline-audit.md at 6e1841609). 82 upstream gateway 502s. CNY 27.18 settled + 47.49 unresolved reservations.
- TREC probes @87d077436: 20 saved of 500 retrieved; 40-52 model calls, 6-7.8 min, ¥0.58-0.94 per topic; nDCG@10 .584/.607/.232; retrieval order on same 20: .663/.320/.558 (criterion-proportion ranking helps and hurts). 13 of 20 unjudged in 2023. Long tool responses spilled to files. Narrative "about 200" vs 162 saved (2026-11-04-vcr-trec-operational-results.md).

## Verified by running the snapshot's code (scratch dir, no repo edits)
- Table indicator column: criteria {age>=18, exclusion present diabetes}; rows DIABETES=0/No/否/1 all → `ineligible` (c2 not_satisfied); only blank → insufficient_evidence. subjectTableFacts + assessSubject at 6e1841609. Also with declared type integer.
- Plan statement for 8 patients: 「这一批要读的病历（人数不显示）…人数少的类别按小样本规则不显示具体人数」; 300 pts/8k chars/30 vars: 1,500 calls, ceiling ¥55.50; 5,000: reads 300, defers 4,700, needs ≥17 restarts (each a conversation turn). (planMatchExtraction + matchBatchStatement, overhead assumption 2,500 tokens per chunk is mine.)
- Silent exclusions: 3 inclusions met + 12 silent exclusions → insufficient_evidence (assessSubject). 
- Ranking: 2-criterion unrelated trial with both satisfied ranks above 30-criterion relevant trial 15/15 (rankPatientTrials). A trial with 29 satisfied + 1 model-wrong not_satisfied (score .93) ranks last.
- locateSourceText: "Age ≥18 years" vs record "Age >= 18 years" → false; Chinese rendering → false; these become forced `unknown` labelled 缺登记原文 although the record has text (vcrPatientTrials.mjs:539-562).

---

# FINAL AUDIT (structured; the raw notes above stay as the trail)

Legend for how a claim was established: [read] read in the code; [run] executed the snapshot's own functions in a throwaway directory (since deleted); [doc] taken from a plan or results file at 6e1841609; [inferred] my estimate or reasoning. Paths are under `OpenScience/apps/server/src` unless they say otherwise. Nothing was run against a live model or database. Production state was not inspected.

Note on the branch: 6e1841609 is 20 commits ahead of `github/main` and 0 behind; it is unmerged and undeployed. `git log` confirms `github/codex/vcr-language-job-20261104` (1a4350df4) and `github/codex/vcr-n2c2-platform-20261104` (19fd840a0) both fork from 64e415ac3.

## 0. Bottom line

Direction A works end to end for a short typed note and up to 20 English trials, costing about ¥0.6-0.9 and 6-8 minutes per patient, but that figure comes from three TREC probes on frozen collections, so live registries in the same path are unmeasured [doc]. Its verdict is almost always 「证据不足」 [run, doc] and 22/53 first attempts did not finish [doc]. Direction B is not deliverable: 300 notes cannot enter through one file, language criteria have no batch path, a result cannot be exported, the page shows 50 people, and a table with a 0/No indicator column falsely excludes the patient [run].

## 1. Gap register

### Blocks delivery

**G1 Silent criterion has no path (both directions).**
Evidence: no `whenSilent`, 「未见记载」 or similar in product code (grep). `evaluatePresence` returns `not_recorded` without asking anyone (vcrMatching.mjs:674). A `language` answer of `unknown` is `not_recorded` and a definite answer needs a verbatim quote (:979-987). Any applicable unknown forces `insufficient_evidence` (:1205). Stated as a limit in capabilities/vcr-matching/capability.yaml knownLimits and in SKILL.md line 158. [run] 3 inclusions met + 12 silent exclusions → `insufficient_evidence`, 3 satisfied/12 unknown. [doc] 278 of 347 aligned disagreements are unknown vs reference "not excluded", 256 of them "code returned unknown"; strict missingness 55.67% vs TrialGPT prompt 73.89% on the same Flash (evals/vcr-trialgpt-reproduction/README.md).
User sees: nearly every trial or patient 「证据不足」, 符合 essentially unreachable.
Smallest fix: per-criterion model verdict adds `silence: not_excluded | needs_confirmation` with no quote required, carried beside `unknown` (a new field, not a new truth value). Page labels 「未见记载，按未排除」/「未见记载，需确认」. Summary gains one tier (for example `eligible_with_silence`) from arithmetic over the labels. Typed rules with no fact must also reach the model, otherwise 256/278 stay untouched. Update SKILL.md:158, capability.yaml knownLimits and the advisory `vcr_summary_contradicted` (packages/domain/src/vcrContracts.mjs:~485).

**G2 B: language criteria have no batch path.**
Evidence: `match_extract` only proposes facts; `planBatch` says so (vcrMatchBatch.mjs:280). `matchingVariablesOf` skips `language` (vcrMatchingTable.mjs:57), so a protocol that is all whole clauses (the current skill direction, SKILL.md:21-30) gives `variables=[]`, no job, state `language_pending` (vcrMatchBatch.mjs:293-297, :568). The conversation must then read and answer per subject (`requests`, vcrComposition.mjs:756). WIP branch: candidate-only, `freezeVcrLanguageUnit` requires `candidateTrialId`, ≤20 units per job, its own plan says "Protocol direction remains unavailable" [read]. Its `complete` flag compares against `'completed'` while outcomes are `'awaiting_reevaluation'`, so it is never complete (vcrLanguageExecutor.mjs on the branch) [read]. It demands model-counted UTF-16 `start/end` and fails on a mismatch, where the skill itself tells the model not to count (SKILL.md:141) [read].
User sees: 300 patients all stay 证据不足, or a turn that tries roughly 1,500 language writes [inferred].
Smallest fix: one job kind `match_judge` replacing `match_extract`: one call per patient (or chunk) with all clauses and the note, returns per-clause state, silence label and quote; code locates the quote by substring, as `items` in the extractor already does (vcrMatchBatch.mjs:475-482). Reuse `planMatchExtraction`, the ledger, `pool`, cancel and notices. Works for both directions by naming protocol or candidate trial.

**G3 B: notes cannot get in at batch size.**
Evidence: `import_documents` csv/tsv only, `table.rows.length > 200` refuses the whole file, duplicate subject refuses the whole file, ≤400 KB per note (vcrDataIntake.mjs:33-34, 75, 94-97) [read]. Page: `files?.[0]`, one file with a hand-typed subject (apps/web/src/components/vcr/data/SourceCard.tsx ~UploadForm) [read].
User sees: a 300-row CSV is refused with a shape error; a patient with several notes is refused; 300 files means 300 uploads.
Smallest fix: run the import as a job, drop the 200 row bound (keep byte and budget bounds), allow repeated subjects, accept zip/folder, let the model propose the subject and note columns as it does a field map.

**G4 A: PDF or Word attached in the conversation cannot become the patient record.**
Evidence: `patientFormats = txt, md` (vcrUploadReceipts.mjs:10), `record` returns null otherwise (:55); `patient_context` reads only those or an owned KB source whose capture has text (vcrPatientContext.mjs:19-36). Local PDF/Word conversion exists (vcrRecordExtract.mjs) but only behind the study page's document upload with a typed subject [read]. Scanned PDFs refused `vcr_document_needs_text`, no OCR, by design.
User sees: a typical discharge summary attachment is not usable; the model must ask to paste it or take the KB route.
Smallest fix: call the existing `vcrRecordExtract` for PDF/Word in `patient_context`. OCR is an open question.

**G5 A: a follow-up fact has nowhere to go and nothing re-judges.**
Evidence: `patient_context` keys are `messageSeq/sourceId/generation/sha256` only (vcrPatientContext.mjs:13); subject is `conversation-case:<digest of provenance incl. messageSeq>` (:54, :64), so a new message is a new pseudonym [read]. `fact` must quote a document of that subject. Re-evaluation only after `language_judgment` (vcrGateway.mjs:2131, 2343); a fact write re-evaluates nothing, the model must rewrite each trial with `subjectKeys` (SKILL.md:214) [read].
User sees: 「ECOG 是 1」 either creates a second patient or changes nothing, and the list stays stale.
Smallest fix: `patient_context {messageSeq, subjectKey}` appends a document to the existing subject; re-judge only that patient's unknown or silent clauses in the same turn.

**G6 Unfinished work reads as finished or as never started.**
Evidence: 31/53 complete; 33/105 pairs no criterion rows; 2 runs ended with no saved result; 82 upstream gateway errors [doc]. `unjudged` exists (vcrPatientTrials.mjs:725) but `#patientTrials` returns only `ranked, detail` (vcrService.mjs:1369-1378) and the page shows 「还没有为 X 找过试验」 on an empty list (PatientTrials.tsx) [read]. Task 3 of next-stage-todo unchecked.
Smallest fix: record requested patient-trial pairs at search or at the first write; reply and page show "n of m finished, these remain" and a resume that only does the rest. Derive from saved rows, no gate.

**G7 Table indicator columns falsely exclude.** [run]
Evidence: `subjectTableFacts` writes `polarity: "affirmed"` for every non-empty cell (vcrMatchingTable.mjs:130-138). Exclusion `present diabetes` with `DIABETES` = 0, No, 否 or 1 → all `ineligible`; only blank → unknown. Prefilter then leaves their notes unread (vcrMatchBatch.mjs:310-316).
Smallest fix: at intake or job start one model call proposes per-column semantics (which values mean present or absent, variable↔column), saved with `basis: model_inferred` through `dataset_semantics`; an unmapped value reads unknown. No keyword table.

**G8 No matching export.**
Evidence: `VCR_EXPORT_KINDS` has none (packages/domain/src/vcrVocabulary.mjs:952-956); only correction-case export on the tab (MatchingTab.tsx); next-stage Task 7 speaks of "downloaded JSON/CSV" that does not exist. The only files are the model-written `matching.json`/`matching-assessment.md`.
Smallest fix: `GET /studies/:id/matching/export?format=csv|json&protocolVersionId=` streaming saved rows (patient × criterion, state, label, quote, locator), `export` ability; same for a patient's trials.

**G9 B page stops at 50 people, no per-criterion funnel.**
Evidence: `ordered.slice(0, 50)` (vcrViewsTabs.mjs:1614), `LIMIT 200` (vcrService.mjs:1282), top 5 gaps (vcrViewsTabs.mjs:1648), `basisUpdated.subjects` first 50 (:1685), pending-review 20 (:1688). `criterionFunnelRows` feeds only the runtime read (vcrComposition.mjs:762), not `presentMatchingTab`. Tiles are total/insufficient/eligible/ineligible [read].
Smallest fix: paged, filterable table reusing the existing rows; one funnel table with `not_satisfied`, unknown, silent labels and `soleReason`.

**G10 ChiCTR is searched but can never yield a verdict.**
Evidence: `chictrPrecedent` keeps no eligibility (trialRegistryClient.mjs:805-820); all criteria unknown `criterion_source_unavailable` (vcrGateway.mjs:1350-1353; SKILL.md:200, which also forbids borrowing the text elsewhere). CDE out by standing ruling. Direct ChiCTR answers 405 per code comment; API doc lists no eligibility field in what I grepped [read, partial].
User sees: Chinese trials listed with every criterion 未知.
Fix depends on an open question (is there a text source?). Failing that, a screen on title, conditions and interventions, labelled as such. Mark severity as blocks for Chinese-registry coverage only.

### Weakens the result

**G11 Retrieval depth and paging.** Live default 20, config 5-50 (config.mjs:1135); no live cursor (vcrGateway.mjs:255); `more:true` tells the model "call again with filter.offset" (runtime/mcp/evimed-research/vcr_platform.py:748) and the live path ignores offset (vcrEvidence.mjs:1396-1477) [read]. 60 trials per study, refused when full (config.mjs:1131; vcrCandidateTrialStore.mjs:138-140). The 500 limit is only the frozen eval corpus: `vcrTrialCorpusManifest` empty by default (config.mjs:1126) [read]. TREC: 20 evaluated of 500 retrieved, eligible Recall@500 .72/.91/.42 [doc]. Fix: live paging or deeper pull, cap per patient rather than per study, two stages (retrieve, rerank, judge top K).

**G12 Ranking has no relevance.** `rankPatientTrials`/`criterionRanking` (vcrPatientTrials.mjs:279-322). [run] a 2-criterion unrelated study with both met outranks a relevant 30-criterion trial at 15/15; one wrong `not_satisfied` on 29/30 sends it last. [doc] nDCG@10 saved vs retrieval order .584/.663, .607/.320, .232/.558. Fix: tier from verdict then relevance score from a plugin (see section 4), measured first on fixed candidates.

**G13 Unlocated clause forced to unknown and mislabelled.** Header says "nothing is refused for being a paraphrase" (vcrPatientTrials.mjs:22-26), evaluate replaces the requirement with `unavailable-source` (:539-562) with label 缺登记原文. [run] "Age ≥18 years" vs "Age >= 18 years" not located; a Chinese rendering not located. Fix: keep the judgment, label 「原文未定位」, have the platform segment the clause so wording is exact.

**G14 Criteria completeness unknown.** `criterionExtractionCompleteness: "unknown"` is hard-coded (vcrPatientTrials.mjs:372); no clause inventory (Task 3). One malformed criterion refuses the whole trial (vcrGateway.mjs:1245, 1267-1274); on a protocol a refused clause leaves a version missing it (SKILL.md:101). A missed exclusion silently improves the verdict [inferred]. Fix: code computes which spans of eligibility text no saved clause covers; model fills them; never drop a trial for one clause.

**G15 Registry changes.** No watcher of held candidates: `vcrFrontierEvents` only raises precedent candidates [read]. Change is noticed only if the model rewrites the trial, then 409 without criteria (vcrCandidateTrialStore.mjs:133-135), and new criteria delete earlier verdicts (:166). `recheckDue` reads `matching_assessments` only and uses the latest protocol (vcrMatchStore.mjs:625-641; vcrComposition.mjs:932). Status shows `statusAsOf`. Fix: one bounded worker loop refreshes hash and status of trials with a live verdict, labels 「登记有更新」, keeps the old verdict until re-judged.

**G16 Failure looks like success.** `status:'succeeded', conclusion:'estimable'` regardless of failures (vcrMatchBatch.mjs:513-535); title 「病历阅读完成」 with no count when 0 read (vcrNotify.mjs:127-131); notice omits failed. Comment says provider-down stops the batch, code stops only on `usage_budget_exceeded`/`insufficient_quota` (vcrMatchBatch.mjs:499-500), so at 90 s timeouts a dead provider costs a long empty run [inferred]. `match_criteria` with zero subjects also `estimable` (vcrComposition.mjs:379-381). Fix: `limited`/`not_estimable` from counts, failed count in notice, stop after N consecutive provider failures.

**G17 Model settings.** `thinking: disabled`, `temperature: 0`, `max_tokens: 2000` (vcrMatchBatch.mjs:230; domain vcrMatchBatch.mjs:57); same in WIP (`buildVcrLanguageBody`). DSH path uses gateway defaults. Effect never measured; remediation plan says so and warns the budget must move together (2026-11-03-vcr-flash-matching-remediation.md lines 70-73, 100) [doc]. Fix: a recorded per-path setting and a paired arm on the same patients.

**G18 Scale and cost.** [run] with 30 variables (assumed), 8 k chars: 300 → 1,500 calls, ceiling ¥55.50; 5,000 → reads 300, defers 4,700, so ≥17 restarts, each a conversation turn (domain vcrMatchBatch.mjs:206; default `vcrMatchBatchMaxSubjects` 300, config.mjs:1146). Concurrency default 3, hard 8 (vcrMatchBatch.mjs:381; config.mjs:1147); one running job per account on the slow lane (vcrJobs.mjs claim). [inferred] 5 sequential calls per record at a few seconds each: 300 in under an hour, 5,000 in many hours. `maxAttempts: 3` on a multi-hour job (vcrMatchBatch.mjs:578), restart-safe through the ledger only if started again. Fix: judge once per patient, chain batches in the job itself without a conversation turn, measure concurrency.

**G19 Long and multi-record notes.** `recordView` cuts at 60 k with a lexical passage search, or the head (vcrMatchBatch.mjs:185-201); `recordsShortened` reaches diagnostics only. Output `length` fails the record with no split (:239-241). M4 unbuilt, Chinese header dates untested (todo). Chinese not evaluated at all (X6 open; evals/vcr-model-comparison/README "Chinese records … remain separate work"). Fix: split at record headers, read per record, retry a smaller chunk.

**G20 FHIR/OMOP/ADaM barely inform matching.** Page only: conversation formats csv/tsv/json/xlsx (vcrDataIntake.mjs:31; zip and xpt refused). Matching reads only the `subject` shape (vcrDataPlane.mjs:3515-3521), so `fhir_condition`, `fhir_observation`, `omop_measurement`, ADAE are unused; notes are not imported (OMOP_OTHER_TABLES includes `note`, vcr_import_convert.py:~897; FHIR map at :393 has no DocumentReference) [read]. All clinical criteria unknown [inferred]. Five manual steps: import, map, confirm, freeze, derive. Fix: read long tables as facts in the same evaluator with model-proposed concept↔variable mapping; import notes; let the model drive the steps.

**G21 Exact-name variable mapping.** `columnForVariable` (vcrMatchingTable.mjs:73-81): a model-chosen `egfr_mutation` against a column `EGFR_STATUS` answers nothing. Merged with the G7 fix.

**G22 Small-cell suppression reaches the owner's conversation.** `VCR_MIN_CELL_SIZE = 10`; `forModel` passes the start answer and funnel through it (vcrService.mjs:1625-1632; vcrGateway.mjs:2959). [run] an 8-patient batch says 「人数不显示」. SKILL.md:179 tells the model to write 「少于十人」. The same model reads the full notes, and the 2026-10-10 ruling allows it. `forModel` also rejects a whole read on a walker error. Not clinical, but it withholds. Fix: exact counts in the owner's own study conversation, suppression kept for shared and published outputs.

**G23 Progress, cost and stop on the page.** No web code starts `match_extract` (grep); the page's 开始评估 starts only the evaluator, so notes without facts give all unknown (ClinicalMatchingDetails.tsx evaluate action). Cost ceiling only in the start sentence; actual tokens in diagnostics, not priced, not shown. Stop = whole study (`cancelVcrStudy`, VcrStates.tsx:136). Fix: 开始评估 starts judging, ceiling and actual on the strip, stop per job.

**G24 Coverage not kept.** Which registries answered exists only in the tool answer (vcrEvidence.mjs:1458-1476 logs counts). Page shows nothing; depends on the model relaying `coverage`. Fix: save the search receipt on the study, one line on PatientTrials.

### Polish

**G25 Evidence.** No rationale on `language_judgment` (vcrGateway.mjs:2115 allows only span fields); on the protocol page `reason` reads `.label` (vcrViewsTabs.mjs judgementView) but `#match` does not label `missing` (vcrService.mjs:1324-1329), so 补证建议's reason is empty there [read, not run]. `decidedBy` not shown. **G26** result link depends on the model relaying `resultEntry` (vcr_platform.py:1382-1394); narrative said ~200 where 162 were saved [doc]. **G27** CriterionTable `min-w-[44rem]` scrolls on phones; roster is a native select that would hold 5,000 options; no keyboard defect obvious [read]. **G28** `matching_extractions` ignores `documentHash` on read (vcrMatchStore.mjs:778-781; algorithm todo). **G29** stale words: MatchingTab comments about referral and "contact confirmation", ClinicalMatchingDetails comment "main action is the contact confirmation"; project AGENTS.md still names `vcrRecruit.mjs`/`vcrContact.mjs`, which are gone.

## 2. Direction walks in brief

A. Typed text ✓ (`patient_context`). Attachment txt/md ✓, PDF/Word ✗ (G4). KB document ✓ only if the model learns the `sourceId` (the patient_context read lists messages and upl_ uploads, not KB sources) [read]. Chinese and English pass through unchanged, Chinese is unmeasured. Long notes G19. Retrieval: three registries in parallel, one failing costs only its own, per-registry state returned (vcrEvidence.mjs:1435-1454) ✓ but not saved (G24). Depth G11. Criteria reading by the model, grammar plus whole clause, G13/G14. Judgment at write, G1. Ranking G12. Result in conversation free text; on page list plus criterion table (PatientTrials.tsx). Follow-up G5. Registry change G15.

B. Table csv/tsv/json/xlsx via conversation or page ✓, field map then freeze then derive; G7, G21. Many notes G3. FHIR/OMOP/ADaM G20. Protocol enters only through the model (`vcr_write protocol`; no page paste or upload for criteria) [read]; partial version risk G14. Prefilter by table with an explicit sentence ✓ (and inherits G7). Limits G18. Language G2. Funnel and per-patient G9. Export G8. Cancel between records keeps work ✓ (vcrMatchBatch.mjs:447-451), resume by ledger ✓ but needs a new start (restart is the model's). Cost stated as a ceiling ✓ (conversation only, G23). At 300: reading works if notes are in, language does not. At 5,000: 17 turns, a 50-row page, no export.

## 3. Native-first: what can go, and what still needs it

| Remove or reduce | Size | Still needed by | Note |
|---|---|---|---|
| capability-skills/vcr-matching/SKILL.md and capabilities/vcr-matching/SKILL.md | 253 lines each → ≤40 | nothing once tools are three | grammar, `clinical`, medication, date rules, deliverable steps move out |
| capability.yaml `produces` (`matching.json`, `matching-assessment.md`), `traceability-review`, `manuscript-humanize`, `evimed_package_check`, `vcrMatchingFindings` (domain vcrContracts.mjs:~436-500) | | contract registry row | reply plus export replace them; all findings are notices today |
| typed grammar on candidate trials: `checkedCriterion` use in `candidate_trial` (vcrGateway.mjs:1248-1380), `criterion_from_other_trial` (:1305-1334), `warnNegatedExclusion`, vcrCriterionFidelity.mjs | ~170 lines | protocol structured path keeps `validateRequirement` | clause text + judgment replaces rule compilation in A |
| parse cache `saveParsedCriteria`, `parsedCriteria`, `parsedHeld` | vcrPatientTrials.mjs:601-645 + store | | reconsider only if clause segmentation is costly |
| fact-extraction prompt: `INSTRUCTIONS`, `questionLines`, `matchExtractChunks`, `extractionPrompt`, `acceptExtractedFacts` | vcrMatchBatch.mjs:99-176, domain :220-265 | keep job shell, plan, ledger, pool, cancel | swap to judge prompt (G2) |
| `vcr_write fact` for the note path, `clinical` block, vcrFactBasis.mjs, parts of packages/domain clinicalFact.mjs | ~285 lines | **evaluator keeps these for table facts and history**; decide after the arm | do not delete until the paired arm says so |
| WIP branch codex/vcr-language-job-20261104 | +1,222 lines | nothing | do not merge wholesale; its fence design lists every mutator as "release blocker", which is the over-blocking the owner rejects; keep only the idea of a leased job and recheck at commit |
| `criterionRanking`, `rankPatientTrials` tier logic | vcrPatientTrials.mjs:279-322 | list order until relevance exists | replace |
| `labelClinicalPriority`, `priority` (never written: `priority: null`, vcrComposition.mjs:904), `PRIORITY_LABEL`, `CandidateRow` priority | small | nothing | dead [read] |
| 待复核排除: `pendingReviewExclusions`, `reviewRows`, card in MatchingTab.tsx | small | nothing | no caller of the function outside its file; the comment contradicts the count (see 5) |
| `patientMatchingMetrics`, `interRaterAgreement`, `criterionConfusion`, `applicabilityConfusion`, `matchingReportDiff`, `matchingAssessmentDocument`, `dueRechecks` | vcrMatching.mjs:~1375-1760 | `runMatchingEvaluation` (evals), `matchingEvaluationReport` (vcrCorrectionCases.mjs) | move to evals; grep shows no other caller |
| `reviewAssessment` countersign, `记录待补证项`, vcrCorrectionCases.mjs + VcrCorrectionCasesActions.tsx | ~200 lines | correction export | ask owner; `overrideJudgment` stays as a person's correction |
| `frozen` branches in search path | keep | TREC benchmarks only | not removal; note 500 is not a product limit |

**Must keep for table cohort screening:** `evaluateRequirement`, compare, elapsed, Kleene, units and time units, `subjectTableFacts`, `matchScenario`, snapshot freeze, `vcrMatchingExecutor`, `onJobFinished`, `recheckDue`.

**Must survive, as engineering (not gates):**
- Authentication and tenancy: `authorize`/`rolesIn` per route (vcrRoutes.mjs), `origin.userId/projectId` checks (vcrGateway.mjs:2690; vcrPatientContext.mjs:11), `resolveInvocation` native call proof.
- Patient-level isolation: data plane never mounted in a runtime, pseudonyms (`pseudonymOf`), `documents.runtimeRead`, `vcrCloudEgress` revocation, withdrawal and erasure (`withdrawnSubjects`, vcrErasureStore).
- Budgets: usage ledger reserve-then-settle, plan ceiling (vcrMatchBatch.mjs:458-462), gateway windows (vcrGateway.mjs:101), purpose `vcr` remains uncapped per owner (usageLedger.mjs:40).
- No fabricated quotes: `verifySourceSpan`, `verifyFactEvidence`, quote substring check in the job (vcrMatchBatch.mjs:476).
- No fabricated trial facts: identity from the fetched record (`candidateTrialFromRecord`), `recordHash` and criterion hash binding, no site staff copied.
- Verdict arithmetic in code, `VCR_FORBIDDEN_WRITE_KEYS`, frozen inputs and `asOf`.

**Existing behaviour that withholds or blocks (flag for the owner):**
1. Clinical grounds: any applicable unknown blocks 符合 (vcrMatching.mjs:1205) and silence never reaches the model. G1.
2. Clinical grounds: registry text missing or not located forces every such criterion unknown, and the skill forbids another source (vcrPatientTrials.mjs:539-562; SKILL.md:200). G10, G13.
3. Write block: one grammar failure refuses the whole trial (vcrGateway.mjs:1267-1274); a rejected write accounts for 2 pairs and 4 units in the baseline, with the rejection's cause not stated there [doc].
4. Write block: `criterion_from_other_trial` refuses a clause. Reasonable integrity intent but it should be a notice once clauses are platform-segmented.
5. Evidence rule: `vcr_evidence_unverified` refuses a fact without a verbatim quote. Keep (no fabricated quotes), but silent labels must not be routed through it.
6. People-count suppression and `forModel` whole-read refusal. G22.
7. `awaiting_budget` on CPU seconds (vcrJobs.mjs:1121): job waits for a person if the study's compute budget is short; `match_extract` asks 60 s (vcrMatchBatch.mjs:578). Probably fine, not measured.
8. Scanned PDF refused rather than read (vcrRecordExtract.mjs). G4.
Not a block despite wording: `vcrProviderAgreements` defaults true (config.mjs:1069), so cloud reads are open unless revoked; reply check is a notice.

## 4. Plugins

**Jev.** Pin `jev-1.13.0`, TypeSafe `https://api.typesafe.ai/v1`, control plane only (deps-version.json `typesafe`, jevModel.mjs). `OPEN_SCIENCE_JEV_ENABLED` default on but needs the key file; `OPEN_SCIENCE_JEV_DISABLED_SITES` per site (config.mjs:1495-1553). Sites J1-J23, `reply-check`, `meta-evidence-role`, `peer-review-checklist` (judgeSites.mjs:9). Calibrated: J2, J3, J4, J23, reply-check; rest uncalibrated at default thresholds. Fails to caller on anything uncertain, circuit per site (judgeService.mjs). **No matching or ranking site exists, and no vcr*.mjs calls a judge** (grep; `.judge(` in vcr files is `access.judge`, a permission check). Whether production holds the key: not checked.

**Rerankers.** `MemoryRerank`, `qwen3-rerank`, DashScope, 3 s, fails open to given order, custom `instruct` (memoryRerank.mjs; server.mjs:1526 memory, :2366 KB; deps-version.json `openviking.rerank`). Not called from VCR.

**Prior measurements** (evals/vcr-model-comparison, public data, no product integration): criterion judging Flash 57.59%, Jev 1.13 53.88%, Jev 1.14 52.69% on 837 rows, cascades no gain → no Jev judgment site (agrees with algorithm todo X2). Ranking on BM25 top-10 of 165 TREC topics, nDCG@10: BM25 .4517, DashScope .4740 (.4760 with clinical instruction), Jev 1.13 .5058, Jev 1.14 .5068; TrialGPT candidate pools not reproduced; reordering ten cannot change P@10 or recall@10. Flash direct: p50 1.34 s, p95 1.91 s, ¥0.50 for 251 requests. Live registry recall unmeasured.

**How to add a ranking site** [read]: add `J24` to `JUDGE_SITE_IDS` (judgeSites.mjs:9), `fields`, purpose `vcr` (default falls to `engine`), a patient-vs-trial question in the relevance branch (J15's wording is about research topics, so write its own) and decode; widen the two site regexes (config.mjs:1524, 1529); row in deps-version.json `typesafe.review.sites`; caller where the candidate list is cut, before `interleave` (vcrCandidateSearch.mjs) or in a ranking step after judging; fall back to registry order on `fallback`. TypeSafe is already in `vcrCloudDestinations` (vcrCloudProjection.mjs:173), so deployment agreements cover it in code; algorithm todo X5 calls it a new data destination. A DashScope variant is a `new MemoryRerank({instruct})`, cheaper to wire, smaller measured gain.

**Knowledge a judgment can call today.** In a DSH conversation: `kb_search`, `kb_browse`, `web_search`, `web_read`, `literature_search`, `guideline_search`, `biomedical_source_search`, `drug_label_search`, `pharmacy_reference_search`, `drug_term_normalize`, `term_normalize`, `clinical_trial_search`, `vcr_read matching kind=terminology`, `vcr_read pack` (packs: breast_cancer, nsclc, type_2_diabetes). The skill forbids reading patient notes through `kb_search` (SKILL.md:115). In `match_extract` and the WIP job: nothing beyond the prompt and the note. M3 definition cards unbuilt.

## 5. Plans and comments that contradict the code

- next-stage-todo Task 7 "downloaded JSON/CSV": no such download.
- vcrPatientTrials.mjs:22-26 "nothing is refused for being a paraphrase": it is forced to unknown at :539-562.
- MatchingTab.tsx 待复核排除 comment "never counted as 不符合 until one has looked": `assessmentTallies` counts them (vcrMatchStore.mjs:400-410); no person is required. Good behaviour, wrong comment.
- vcrMatchBatch.mjs:499 "a provider down … the batch stops": only budget codes stop it.
- vcr_platform.py:748 instructs offset paging; the live search has none.
- capability.yaml starter prompt "知识库里的 20 份病历跑一遍预筛": KB documents reach a subject only one by one through `patient_context`; no batch from KB [read].
- Algorithm todo M1 "等裁定": decided by this brief. next-stage Task 1 "No blanket unknown-to-favorable conversion" is compatible only if per-criterion and labelled; should be restated.
- Checkpoint says the language worker needs a "full lock-order review"; under the owner's stated direction that scope should be re-decided, not inherited.
- Project AGENTS.md cites vcrRecruit/vcrContact; retired.

## 6. Tests that would need replacing (counts at 6e1841609; the snapshot omits tests, read through git)

vcrMatching.test 71, vcrEvidenceMatching.integration 33, vcrCandidateTrialWrite 30, vcrPatientTrials 22, vcrPatientTrialsEvaluation.integration 19, vcrRecordExtract 17 (extend), vcrMatchBatch 15 + Context 10 + integration 7, domain vcrMatchBatch, vcrCandidateTrials.integration 12, vcrCandidateSearch 11 (mostly stays), vcrMatchingTemporalHistory 11, vcrMatchingEvidence 6, vcrPatientTrials.routes.integration 5, vcrMatchingSnapshot 5, vcrMatchingTable 5 (add 0/No), vcrMatchingIneligible 4; fixtures test/fixtures/vcr-views/ev201/matching*; web PatientTrials.test, MatchingIneligible.test, ClinicalMatchingDetails.test, RecruitTabs.test. Assertions encoding "any unknown exclusion is never 符合" must be rewritten on purpose, not relaxed.

## 7. Open questions

1. Silent-label summary: a fifth summary (`eligible_with_silence`) or 符合 with a visible count? Do lab and measurement clauses get a silent verdict at all (algorithm todo suggests they stay unknown)?
2. ChiCTR eligibility: any licensed source of the text, or accept a title-and-conditions screen?
3. OCR for scanned records: may they go to a cloud reader, given the 10-10 ruling?
4. Should exact people counts reach the model in the owner's own conversation (G22)?
5. Ranking candidate: Jev vs DashScope before a fixed-candidate TREC run, and does TypeSafe count as covered by the agreements?
6. Does the native arm keep typed rules for arithmetic (dates, thresholds) or let the model judge and code recheck numbers? next-stage Task 4 is unfinished.
7. Correction cases and countersign: keep?
