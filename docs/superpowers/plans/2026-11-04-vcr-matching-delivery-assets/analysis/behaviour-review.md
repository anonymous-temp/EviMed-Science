# Behaviour review of codex/vcr-match-delivery-20261104 (diff against 6e1841609, HEAD 19de62d2b)

Reviewer: independent, read-only. 2026-11-04. No repo file edited, no model called, no database used. Throwaway scripts: a scratch directory (`seg.mjs`, `corpus*.mjs`, `job.mjs`, `progress.mjs`, `parse.mjs`, `meaning.mjs`, `proto.mjs`), all on doubles or on trial text. Focused tests run: `vcrMatchingTable.test.mjs` + `vcrMatchJudge.test.mjs`, 59 pass. Paths are under OpenScience/.

## Blocks delivery

### B1. A viewer reads patient-level text and exact small cells on the results page
`apps/server/src/vcrRoutes.mjs:187,814` ask only `read`. `vcrMatchResults.mjs` `#listed` / `#open` return `why`, `groups`, `summary`, clause `reason`.
Scenario: a member with role `viewer` (or `clinical_reviewer`, `statistical_reviewer`: `read` without `read_patient_level`) opens `GET matching/judged?direction=patient_to_trial&subjectKey=…`. The sentence quotes are filtered by `viewEvidence`; the model's reasons are not, and they carry the record: the repo's own fixture has 「确诊 EGFR 19del 的 IV 期肺腺癌」 and 「肌酐 3.1 mg/dL…」. `tallies` and the clause funnel are exact for that member too, with no suppression. AGENTS.md keeps both boundaries for anyone but the owner, and the export route of the same data does ask `read_patient_level`.
Tests miss it: `vcrMatchResults.integration.test.mjs:396` asserts the viewer gets 200 and looks at no field.

### B2. Clause-level failure, or stage two never having run, reads as finished everywhere
`vcrMatchResults.mjs:382-396`, `vcrMatchJudge.mjs:936,1172-1183`, `vcrNotify.mjs:135-140`, `JudgedProgress.tsx:67-70`.
Scenario (run, `job.mjs` J5, `progress.mjs`): 3 trials, top K 2, every clause call fails. Notice: 「患者与试验判定完成：判定了 3/3 对」. Page: `state: done`, 3/3, 「已全部判完」, `failed.count` 0, `left: []` so 继续 answers `vcr_match_judge_nothing_to_resume`. The conversation read: `finished 3, failedPairs 0`, no `failed`, no clause rows, verdict from the score bands. The same happens to a job cancelled between the stages. The result does say `limited` and `criteria_pairs_finished=0/2`, but no reader looks there. The skill's "`failed` holds what did not finish" is false for stage two.
Tests miss it: failures are seeded on fit rows or both.

### B3. After a follow-up note the verdict can rest on the old note, unmarked
`vcrMatchJudge.mjs:1065-1069` (`topK: clauses`), `:1096-1098,1104-1110`, `vcrMatchResults.mjs:303-312`.
Scenario (run, J3): person has clause rows on trial T1 (top K 1). A new note reports brain metastases. Rejudge re-scores all trials, stage two takes the new best (T2). T1 now reads fit 5 from the new note beside clause rows from the old note: verdict `eligible` 「符合」, no `basisChanged`, because follow-ups write no mark. At defaults (K 20 of 100) any trial leaving the top 20 keeps this. `judgmentChanges` (`:1003`) compares clause verdict with fit verdict across readings, so its 「重算后 N 个试验结论变化」 can contradict the page.
Tests miss it: `topK` all, or one trial.

### B4. The page's 寻找试验 sends the run down the removed path
`vcrOrchestrator.mjs:275-276`: 「按 vcr-matching 技能里「给患者找试验」一节做」 (no such section since the rewrite) and 「候选试验由 vcr_write 写入，平台判定并排序…不要自己下判定」. The skill says the opposite. A run that obeys the brief writes `candidate_trial` rows, and `MatchingTab.tsx:234` then draws judged rows only, so those trials never appear for a person who has any judgment. The route also still calls `trials.evaluate` (`vcrRoutes.mjs:1317`).
Not run with a real model. Tests miss it: the brief is only checked for its identity fields.

## Should fix

### S1. 继续判定 runs clauses with thinking off
`vcrMatchResults.mjs:401` picks `fit, topK, thinking, collection, collectionRevision` and not `thinkingCriteria`; `vcrMatchJudge.mjs:531` then falls to `selection.thinking`. Run (J2): first selection off/high, resume selection off/off, so a 6,000-token cap and an unmeasured arm, silently, on exactly the pairs that failed. Also rejudge ignores `entry.thinking` (`:1060`), so a job started with explicit `thinking` is re-judged at defaults.

### S2. Stage-two rows lose their score after the first batch
`vcrMatchJudge.mjs:776`: the fallback builds the fit key from `base`, whose `thinking` is the clause stage's. `fitSeen` is reloaded only when `second` is computed (`:903-906`). Run (J1), off/high, slice 1: `fit: null, verdict: possible`; same job in one batch: `fit: 40, verdict: insufficient`. The page recomputes from the fit row, so the damage is the stored column and `judgmentChanges` (`:1003`), which reports changes that did not happen. Regression from 643e83379. Tests miss it: the batch test has `topK: 0`.

### S3. Partial records are presented as whole
`vcrMatchJudge.mjs:274,285,303` and `:759-760`. A document the cloud may not read, a transient read failure, a table read `.catch(() => [])` or long-table rows left out all still give a `done` row under a different hash. `unreadableDocuments` and `leftOut` are saved and read by nothing (`grep`: not in `presentJudgment`, `vcrMatchResults`, `vcrClient`, any tab); the module note in `vcrLongTables.mjs:16` promises "on the row, so a reader does". The table and long-table failures record nothing at all. Since a pair's newest row wins, one failed read during a later re-judgment replaces the full-record verdict with the partial one.

### S4. segmentCriteria turns real headings into the wrong side
`packages/domain/src/vcrTrialJudgment.mjs:161` cuts `INLINE_HEADER` before `NEUTRAL_HEADER` (`:233`) sees the line; `:144-145` accepts any `Inclusion …:`; `:121` cuts at any later "2.". Run over 26,155 TREC 2021 trials (`seg.mjs`, `corpus*.mjs`):
- `Inclusion and Exclusion Criteria:` gives a clause 「Inclusion and」 and every clause `exclusion`: 「Age >= 18」 met maps to `excluded`, stated, so 不符合 (9 trials).
- `Inclusion of Women and Minorities:` or `Inclusion in another study: …` inside the exclusion section flips what follows to inclusion (17 trials end with inclusion clauses after the real exclusion heading, some legitimate).
- `1. ECOG 0, 1, or 2.` becomes 「ECOG performance status of 0, 1, or」 (11 trials), against "a clause is never truncated".
- Alternatives split into clauses: 611 trials (2.3%) hold a clause ending in `or`, 97 a bare `OR`/`AND`. One stated `not included` on one alternative is `ineligible` (`:703-704`) and sorts last. Model behaviour on these not measured.
Tests miss it, and the boards do too: board C feeds its own clause lists through `protocolOf`, so no clause-level score ever passes through this function.

### S5. Protocol-to-patients in a conversation has no taught way in, and the boards bypass the writer
Skill: "the study's criteria are the eligibility text", nothing on saving them. `vcrGateway.mjs:847` requires a grammar `requirement`; the contract sends the model to the rule grammar the owner decision moved free text away from. `dev_job.mjs:256,272` calls `matchStore.saveProtocolVersion` with `{kind, sourceText}` directly, and `run_product.mjs` runs patient-to-trial only, so this direction has never run through the tool path. Also `sourceText` is optional (`vcrGateway.mjs:845`) and `vcrMatchJudge.mjs:371-372` drops an empty one silently: run (`proto.mjs`), an exclusion with no text disappears and the eligibility text ends at a bare heading, so 「符合」 ignores it.

### S6. The conversation cannot say how far a job is, and a stopped job arrives as finished
`vcrMatchJudge.mjs:1201` returns `finished`, `failedPairs`, `more`: no total and no job state, while the skill asks for "how many of how many" and "what is left". A read mid-run looks final. A budget stop is `status: succeeded`, `limited` (`vcrMatchBatch.mjs:376`), so `vcrJobs.mjs:2008-2009` gives `partial: false` and `vcrConversationCompletions.mjs:218-220` says 「计算已完成」, `partial=false`; the notice title says 完成. `vcr_platform.py:1518,1540` tell the model to read `what: results`, which holds counts and no verdicts.

### S7. An attached PDF or scan hits a 10 s budget inside one transaction
`vcrGateway.mjs:2794,2832-2835` leave `patient_context` on `answerBudgetMs` 10 s; the converter may take 60 s and the parser 300 s, all inside `store.transaction` (`vcrPatientContext.mjs:81`) holding a pooled connection and an advisory lock. Scenario by reading: a scan returns 504 `vcr_gateway_timeout` to the model while the work goes on; a retry blocks on the lock under the 5 s `statement_timeout` and answers 503; only a later retry finds the file. Not timed live. Tests miss it: the parser double answers at once.

### S8. Measured is not shipped
- `dev_job.mjs:445` calls `advance(job)`; production uses `mayYield: true` (`vcrWorker.mjs:303`). Batches, checkpoints, the end-of-stage retry and outage waits are on no board, which is why S2 survives. Only `vcrMatchScale` exercises them, on doubles for the model.
- The final runs under way (`frozen/final-t21`, `-t22`) are `mode fit`. The shipped default is `both` with K 20 (dev default K 10), and stage two reorders (`rankJudgments` puts stated disqualifiers last). A published fit-only figure is not the order a user gets.
- Board C at criteria-3: 811/1015 against GPT-4's 886, interval excludes parity [-11.0, -3.6], false favourable 102 against 15. Three prompt versions were tuned on this same board, the only clause board, and the split keeps it dev, so 79.9% is in-sample.
- Chinese trial text, retrieval and rerank, and ChiCTR page text are on no finished board (G translates notes only; E in progress).

### S9. Step 7 of a study does not know about judging
`vcrOrchestrator.mjs:2669-2670`: `kinds: ["match_criteria"]`, complete only with `matching_assessments`. A `match_judge` job never reads as running and never completes the step; above T0 the step stays `none`, and `#stepRun` (`:3565`) sends the matching run again up to `VCR_RUN_RULES.attempts` (2). The ledger spares the pairs, not the conversation turns.

### S10. Structured screening's results vanish once anything is judged; old verdicts are unmarked
- `ClinicalMatchingDetails.tsx:55`: 开始评估 and 重新开始评估 now always start `match_judge`, so a table study cannot re-run its rules from the page.
- `MatchingTab.tsx:247` returns before the assessment view: judging one person against a protocol hides the rule assessments of 5,000, with no way back. The file's own comment says "nobody's earlier assessment disappears"; DESIGN.md's wording only holds while nothing is judged.
- Bump to vcr-eligibility-3: queued jobs fail clearly with 409 (`vcrComposition.mjs:294`), fine. But saved -2 assessments, which read a filled `0` as affirmed, stay on the page with no mark (`grep`: version read only in provenance and correction cases).
- `vcrTableMeaning.mjs:122`: below 10 filled cells no codes are offered (run: 8 people, 0/1 column, no `values`), so every presence criterion of a small table stays `coding_unmapped`, forever for that snapshot. That conflicts with the owner's small-count ruling. Value mapping itself is right on the tests; a comparison reads the number, a map reads presence.
- `dataset_semantics` reaches it only if the model finds the opaque `vcr-tbl-…` id through a list read; nothing names it, the skill does not mention it, and the files panel `DatasetMeaningPanel` matches by path so never shows it. The promised researcher correction has no taught route.

### S11. Model answers can land on the wrong clause
`vcrTrialJudgment.mjs:600`: `numberIn` on the `criterion` field. Run (`parse.mjs`): `{"results":[{"criterion":"Age >= 18 years","sentence_ids":[0],"label":"included"}]}` becomes clause 18, an exclusion, `excluded`, stated, so 不符合; the only trace is `label_other_side`. `:583`: a reason `"N/A"` before the label takes the label `not_applicable`. Positional arrays follow prompt order, not number order, when exclusion comes first (`en_mixed_order`). All need an off-format answer; frequency not measured.

### S12. "Needs nobody to restart it" holds for pairs, not for the batch
`vcrMatchJudge.mjs:604,624,680,865` run outside `judgeOne`; `vcrJobs.mjs:1840,1903` retry only `retryable`, which a database error is not. A `57014` from `doneFor` or `roster` under the 5 s store timeout at any batch start ends a multi-hour job `failed`. Nothing is lost, but someone must press 继续. `dev_job` wraps this with `--job-retries`; production has none.

## Minor
- `fit: false`: `vcrMatchJudge.mjs:946` adds `failedPairs + stages.criteria.failed`. Run (J4): 3 pairs, 2 done, 「2 对没判定成」.
- `unsectioned` shows as 入选: `vcrMatchResults.mjs:129`, `JudgedPair.tsx:94`; `lead` is never drawn, so 「排除标准如下：」 clauses read 入选 (`zh_ruxia`, 914 of 26,155 trials fully unsectioned).
- `trialVerdict` gives `eligible` at fit 5, or with every clause `not_applicable` (run).
- `MatchingTab.tsx:130-135` ignores `touched`: a `?object=` link to patient B in a study with no protocol is overwritten by the roster's first, with no reload, so the band and the page disagree until the 5 s poll flips the page.
- 重新判定 404s for a table-only person: `vcrRoutes.mjs` uses `candidateSubjects`; `subjectKnown` exists for this.
- CSV 患者 column is the key; the page shows `P-XXXXXX`.
- Above 20,000 pairs the page and export cut silently (`MOST_PAIRS`), and `judgments.list` at 20,000 rows; a job allows 50,000 people.
- `vcr_platform.py:740-748`: a `matching` read of a judged person still says "Start kind=match_criteria".
- `score_f.py:188` drops a patient absent from the file from the denominator (printed as "scored X of Y"); dev_job always writes one.
- Long records: `specificity` lets an old stated value outrank a newer one (`vcrTrialJudgment.mjs:844`).

## Dead code
`enqueueVcrMatching` (`vcrClient.ts:3594`, no caller); `pendingReview` query (`vcrService.mjs:1275,1358`, no reader) and `pendingReviewExclusions`; `priority` still computed in `vcrMatching.mjs`; `entry.thinking` in rejudge; selection `definitions` and `thinkingCriteria` have no production caller (the MCP schema refuses both); skill-less but reachable: `match_extract`, `language_judgment`, `candidate_trial`, `PatientTrialsLegacy`. Config levers: every new key has a reader.

## Checked, no defect
Labels cannot reach a runner or prompt (case keys read; labels only in `score.py`'s process). Candidate order independent of labels (mean normalised position by label 0.50/0.50/0.50). `split.json` equal to the prepared one, dev and test disjoint, case `split` fields agree. `to_official.py` keeps saved order and the official script takes list order; unjudged follow in input order, absent patients are written. Macro prints its cohorts. Ledger key: changed note or trial makes a new row; prompt bumps match prompt edits. Job fencing, cancel, yield, re-claim after lease, attempts reset read correct. Completion outbox survives a restart, with `conversationOrigin` kept across yields. Sentence offsets exact on Chinese and CRLF. Evidence ids resolve; bands, levels and page agree.

## Not checked
Any real model or kernel run; the gateway under real timing; browser rendering; `records_import`, rerank and retrieval, terminology, `clinical_score`, `score_d`, `prepare_zh` output, erasure of judgment rows; a real process crash; uncommitted board-runner edits and board E. S4's alternatives and S11 lack a model-side rate.
