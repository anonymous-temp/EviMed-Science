# Final review of codex/vcr-match-delivery-20261104

Merge base with `github/main` is 0765c63c1.

**Revision.** Product code was read at 70132684d. Later commits were read as diffs and applied below. Head when I stopped was 6c063b781, whose last commits touch eval harness files, the intake and matching pages, and one web client mapping. After 70132684d the server changed only in a `registryIds` pattern in `vcrRoutes.mjs` and small picture-intake edits in `vcrDataPlane.mjs` and `vcrViewsTabs.mjs`; `vcrMatchJudge`, `vcrMatchResults`, the judgment store and the domain's verdict code did not change. Line numbers are as read and may be a few lines off at head.

**Method.** Nothing in the repository was edited and no paid call was made. Scratch files are in a scratch directory. My own databases were dropped at the end.
- "RAN" means I ran a scenario or test. "READ" means I read the code only.
- a scratch directory to `scen4.test.mjs` use real PostgreSQL and real jobs, with doubles for the model and the registry.
- The evaluation section came from a delegated read of the same revision (notes in a scratch directory). I re-read its two highest-stakes findings myself.

Paths below are under `OpenScience/` unless stated. `S/` means `apps/server/src`, `D/` means `packages/domain/src`, `W/` means `apps/web/src/components/vcr`.

Finding ids P, E, F and E-F are this report's. "Stream S5" and the like mean the handoff logs in this folder.

## Bottom line

**This is not an all-clear.**
- The removal left nothing that throws. I found no way around authentication or tenancy, and no label reaching the feature.
- Three product defects leave plan-blocking gaps G5, G6 and G8 open, each with a small fix.
- Four evaluation problems must be settled before any final number is published. One of them (E2) has to be done before the n2c2 test run is scored.
- The plan's acceptance layers (real kernel, scale, the 12-scene UI walk, `pnpm ci:web`, CI) were not finished at this read. Streams S13 and S14 are on some of them.

## Blocks delivery: product

### P1. A failed re-judgment reads as done (G5, G6, G16)
`S/vcrMatchResults.mjs:335`, `S/vcrMatchJudge.mjs:1265` (`newest`), `S/vcrMatchJudgmentStore.mjs:101-128` (`judgingProgress`). RAN `scen1` A.

**Scenario.** A person holds 符合 on two trials. A follow-up note says 「已怀孕，脑转移」. The re-judgment job starts and every model call fails.

**What each surface says:**

| Surface | What it says |
|---|---|
| Page and conversation read | `state: "done"`, 2 of 2, `failed: 0`, `left: 0`, `clauses.left: 0` |
| Verdict | still 符合, from the old note |
| Job | state `failed`, seen only in the conversation read's `job.state` |
| `JudgedFailures` | empty, so 「继续判定」 answers `vcr_match_judge_nothing_to_resume` |

**Why.** The newest row of a pair is the newest `done` row, so a newer `failed` row on the new reading is invisible to every reader.

**What d589c6269 changed.** The page now has a line and 重新判定 for trials marked with an older note, which makes it recoverable on the page. The heading 「已完成 2 / 2」, `state: done` and an empty failure list are still false. When some calls were paid, the progress line also says 「已全部判完」.

**The conversation is worse.** It gets `basisChanged: "document"` (a raw word), `state: "done"`, `left: 0`, and no instruction to mention any of it (F4 below).

**Smallest fix.** In `#pairs` and `pairsOf`, also read the pair's newest row of any status. If it failed and is newer than the row in use, list it in `failed`/`clausesFailed`, add the pair to `left`, and let `state` follow. One SQL column and one branch in `judgingProgress`.

### P2. A read before the first row says "nothing" while the job runs (G6)
`S/vcrService.mjs:1873`, and the same test at `:1845`. RAN `scen1` C.

**Scenario.** Right after `vcr_simulate start kind=match_judge`, the model reads `candidate_trials` with `filter.subjectKey`. `judged.ranking.length || judged.failedPairs` is false, so the read falls through to the old path.

**What the model gets:** `{ total: 0, ranking: [], requests: [], unjudged: [] }`, with no `state`, `job` or `left`.

**What the person may be told:** nothing found. With clause thinking on, the first row can take a while. This is exactly G6's "reads as never started", for the conversation. The page is right here, because `held` counts the job's plan.

**Smallest fix.** Change the test to `judged.ranking.length || judged.failedPairs || judged.total`, in both places.

### P3. An exported file reads as whole when the work was not (G8)
`S/vcrMatchResults.mjs:664,668-669,673-675,691-692`. RAN `scen1` B; READ for the rest.
- `ordered` holds finished pairs only. Failed and not-yet-judged pairs have no row, and nothing in the file says how far the job got. A stopped job of 100 pairs gives a 3-row CSV.
- The pair file has no column for `recordGap`, `clausesNote` or `eligibilityNote`.
- RAN output, clause stage failed: `P-B4ACCD,登记试验,NCT00000011,Trial NCT00000011,符合,85,高,一般,,,,,,a,判定作业,…,否`. On the page the same row says 「逐条判定没有完成：模型服务暂时没有回答」.
- `DESIGN.md:1124` promises "every row".

**Smallest fix.** Add a 备注 column to pairs (CSV and JSON) carrying those three notes. Append failed and unjudged pairs as rows with verdict 未判定 and their reason. Add `progress` to the JSON header.

## Blocks delivery: the numbers (evaluation)

These block publishing the figures as stated. They do not block the feature.

**E1. Board B cannot be scored as scripted. RAN by the delegate; existence checked by me.**
- `evals/vcr-matching-boards/score.py:555-558,610` reads `<boards>/manifest.json`. `narrow_board.mjs:103-113` writes none.
- the scoring script passes `--boards $D/nih-top100`. That directory exists and has no `manifest.json` (a `test -e` only, nothing else opened).
- The official script runs, then `FileNotFoundError`, and `--out` stays empty. The script has no `set -e`, so board B silently has no result.
- `markdown_b` also never says the board was narrowed, so a fixed run would read like the full-list protocol behind the 70% it is compared to.
- Fix: `narrow_board` writes a manifest with `narrowedFrom` and `top`, and `markdown_b` prints it.

**E2. Board F has no pre-named reading, and the test split is one-shot. Time-critical. READ.**
- `score_f.py:5-12,35,263-264` and `README.md:158-163` report readings (b), (c) and (d) equally.
- On the old pipeline (b) gave 0.6751 and (c) gave 0.8293, with the majority baseline at 0.7608 between them (`evals/vcr-matching/n2c2/README.md:84,130,132`). The reading alone decides whether a score beats the baseline.
- The plan's 0.8293 line is reading (c). Choosing after looking is selection on the test set.
- Fix: write the primary reading into `score_f.py` and the README before `final-score.sh` runs.

**E3. No final number goes through the tool path. READ.**
- the freeze scripts run A, B, C, F and G through `dev_job.mjs`, which calls `storeUpload` (:209,216), `saveProtocolVersion` (:256,272) and `matchJudge.start`/`claim`/`advance` directly (:434-445).
- No conversation, skill, gateway, saved search or worker lane is involved. `run_product` labels itself "a diagnostic, never a benchmark result" (`product_server.mjs:81-82`).
- Plan section 9 says all scores go through the real product path, and the owner rule says "through the product".
- Real in these runs: the prompts, parsers, job code, ledger, model gateway and reader.
- Fix: the report states "job path, no conversation", or the owner accepts that wording.

**E4. Board C is scored on the rows its prompt was tuned on. READ.**
- `D/vcrTrialJudgment.mjs:512-517` says the silence rule was tuned on "the 1,015 annotated clauses". `final-c` scores those same rows, and `prepare.py:149-150` puts all of C in dev.
- Any 超过 or 持平 against GPT-4 would be in-sample, and `score.py:413-420` says nothing about it.
- Fix: label C as the tuning set and drop the comparison claim. Use F test as the clean clause-level figure.

## Should fix: product

**F1. Failure reasons the page cannot word. RAN (first `scen1` attempt).**
- A pair failing with `vcr_cloud_processing_not_authorized` reads 「这一对没有判成」, while the job's own error says 「这份病历没有适用的云端处理授权」.
- `VCR_MATCH_FAILURE_REASONS_ZH` (`D/vcrVocabulary.mjs:1343`) also lacks `vcr_source_withdrawn`, `vcr_match_record_changed` and `vcr_match_judge_failed` (READ).
- The person presses 继续 and it fails the same way, with no way to know why.
- Fix: add the words.

**F2. A withdrawal misses the search receipt on the normal path. READ; not checked against a real model's calls.**
- `#erase` deletes `candidate_searches` by `subject_key` (`S/vcrErasureStore.mjs:261`).
- The receipt only has a key if the model sends `filter.subjectKey` on `what: candidates` (`S/vcrEvidence.mjs:1585`). Neither the skill (`capability-skills/vcr-matching/SKILL.md:16`) nor the tool text (`vcr_platform.py:224-231`) asks for it.
- `vcrMatchSecurity` passes because it seeds the key itself (test line 410).
- After a withdrawal the row keeps condition, terms, age, sex and region, unlinked to anyone.
- Fix: stamp the receipt's `subject_key` when a job starts from `{subjectKey, searchId}`, and name the field in the skill.

**F3. A viewer's list hides small groups, but asking by key does not. RAN `scen2`.**
- Seed: 13 people in four groups. A viewer gets an empty list and hidden tallies.
- `?direction=trial_to_patient&subjectKey=…` (`selected`, `S/vcrMatchResults.mjs:546,568`) and `?direction=patient_to_trial&subjectKey=…` (`:511-527`) return that person's verdict, fit, counts and every clause with its words and label.
- A clause row such as 「活动性乙肝：符合排除条件」 is a fact about one person, even with reasons removed.
- `candidateRoster` hands a viewer the keys of everyone with a document (RAN: the tab answered a viewer with the roster). The rule path has the same per-person states at base (`S/vcrService.mjs:1293-1325`), so the shape is inherited, but the two views now disagree.
- Fix: for `patientLevel: false`, `#open` and `forPatient` return verdict only, under the same small-cell rule, with no clause rows.

**F4. The conversation is not taught what a row says of itself. READ.**
- The skill (`SKILL.md:35`) and `next_actions` (`vcr_platform.py:745`) name verdict, reasons, `failed`, `clausesFailed`, `left`. They do not name `recordGap`, `basisChanged`, `clausesOutdated`, `scoreOutdated` or `eligibilitySource`.
- `basisChanged` reaches the model as a bare `document` while the skill says not to print internal fields.
- `writeConversation` also leaves `gapsOf(note, target)` out of its row (`S/vcrMatchJudge.mjs:1504`), so a conversation's own judgment of a partial record reads as whole.
- Fix: one sentence in the skill, a worded mark in `presentJudgment`, and `gapsOf` in that row.

**F5. A 不符合 can be listed first. RAN `scen1` D, also found by stream S13.**
- Fit 90 with a stated exclusion ranks above fit 70 可能符合, by design (`D/vcrTrialJudgment.mjs:941-961`, SIGIR nDCG .652 against .669).
- `DESIGN.md:1121` still says "the ones a stated condition rules out last". d589c6269 reworded only the component comment; `JudgedMatching.test.tsx:87` still says it too.
- The protocol view sorts by verdict first (`S/vcrMatchResults.mjs:542`), so the two directions order by different rules.
- Fix: fix the doc, or get the owner's call on the page's order.

**F6. What the removal left. READ.** Nothing throws. The tests in the list at the end pass at 70132684d.
- `candidate_trials` for old rows still returns `requests` and the tool text says "the language answers still owed" (`S/vcrPatientTrials.mjs:603-606,640-655`, `vcr_platform.py:219-221`). No write can answer: `language_judgment` no longer takes a candidate trial (`S/vcrGateway.mjs:2034-2042`). A model following it hits a refusal.
- `S/vcrEvidence.mjs:1576` tells the model 「写入候选试验时条件按未知算（缺登记原文）」 about a write that is gone. `vcr_platform.py:766-767` says ChiCTR has no eligibility text, though the job now reads its page. `vcr_platform.py:732` sends every `matching` read to "fact write envelopes".
- The route still calls `trials.evaluate` and `candidateSubjects` (`S/vcrRoutes.mjs:1309,1316`). No new candidate row can exist, and its comment (`:1298`) describes the old path. A person only in a table is 404 here while `subjectKnown` is used next door.
- `S/vcrPatientTrials.mjs:1-29` still describes a run that writes trials.
- `matching_extractions` (pseudonym, document id and counts; no words) was never in erasure, despite stream S12's "erasure unchanged". `parsed_trial_criteria(_versions)` have no reader or writer. Owner rule 「没用的和历史的都不留」 applies: a one-shot drop, or a `DELETE` line in `#erase`.

**F7. Table screening still stops at 50 (G9), with no export (G8). READ.**
- `S/vcrViewsTabs.mjs:1615` (`ordered.slice(0, 50)`), `S/vcrService.mjs:1282` (`LIMIT 200`), top 5 gaps at `S/vcrViewsTabs.mjs:1648`.
- No pager or cut note on this list. `MatchingExport` is on the judged pages only.
- Scenario: a 5,000-row table study screened by rules shows 50 rows and offers no file.
- Fix: use the judged page's pattern on the rule path.

**F8. Search coverage is not on the page (G24). READ.**
- The receipt is saved and the answer carries `coverage` (`S/vcrEvidence.mjs:1597`). No page reads it, though `S/vcrCandidateSearchStore.mjs:15` says "the page shows the latest one's line".
- A person cannot see that a registry failed unless the model relayed it.
- Fix: one line on `PatientTrials` from the latest receipt, or correct the comment.

**F9. A hospital export's notes never arrive (G20). READ.**
- Long tables work (`S/vcrLongTables.mjs:38-47`, test RAN). FHIR `DocumentReference` is not read and OMOP `note` is in `OMOP_OTHER_TABLES` (`runtime/mcp/evimed-research/vcr_import_convert.py:894-897`).
- A hospital's narrative through FHIR or OMOP is dropped, and the judge reads only coded lines.
- Fix: read them as documents, or state it in the import's statement.

**F10. New structured data leaves old verdicts unmarked. READ.**
- `#markSubjectChanged` runs for documents only (`S/vcrDataPlane.mjs:2329`).
- `import_standard` or a new table for a person with verdicts changes the hash at the next job but marks nothing now.
- Records added through `records_import` are marked but not re-judged; since d589c6269 the patient page offers the action.

**F11. "保留为历史" has no reader. READ.**
- The statement (`S/vcrMatchJudge.mjs:1254`), the banners and the owner decision all promise the earlier verdict stays as history.
- Rows stay, but no page, export or read shows an older reading. Only the job's `changes` sentence compares them.

**F12. Spend. READ.**
- The default job ceiling is CNY 500 (`S/config.mjs:1190`), from a tool call that needs no confirmation, on a key the controller's notes put near CNY 450.
- W11 promised a cap per patient; there is only the cap per job. Rerank is booked after spending and not at all with no study (`S/vcrEvidence.mjs:1315`).
- Decide the default.

**Plan items nothing delivers. READ.**
- Plan section 4 「算术复算」 and the owner line "a mismatch code finds is a label": no code rechecks a threshold or a unit anywhere on the judged path. In the job the model does arithmetic with no tool.
- Section 4 "知识插件…模型按需调用": the job's model has no tools. `clinical_score` is not in `capabilities/vcr-matching/capability.yaml:17-27`, so a dispatched capability run cannot call it. Definition cards are off and the schema refuses them.
- W5 report export: none. W10 "只重算受影响的条款": the whole pair set is re-judged. W11: see F12.
- Section 10: no misplacement cap is stated anywhere (`score.py` prints the count). First-run ≥98% cannot be read from the final runs (E-F4). P50 ≤2 minutes for 20 candidates is unmeasured; stream S5's five job runs took 4.6-7.4 minutes at 33-99 pairs. `pnpm ci:web` and CI were not run by me, and the controller's note says the branch had not been pushed.
- Section 8: Chinese trial text is on no finished board. Multi-turn real kernel, failure injection, scale and the UI walk are in progress in other streams, and I did not judge them.

## Should fix: evaluation

Delegated read, READ unless marked.

| # | Problem | File | Fix |
|---|---|---|---|
| E-F1 | Board E's reference table is whole-set NIST means (75, 50, 37 topics), while the run scores test topics (65, 40, 28). CSIRO-UQ on the same 28 topics is about .762, not .7363, so .75 reads as 超过 while below it. | `score_e.py:171-179,262-269` | Compute NIST on the same topics |
| E-F2 | Rerank is 30 s per request and 120 s budget in the harness, 8 s and 15 s shipped. Narrowing also refuses anything but `ranked`, where the product falls open. | `narrow_board.mjs:73,88`, `retrieve_e.mjs:211`, `S/config.mjs:1163-1164` | Report the share of requests over 15 s |
| E-F3 | Board E is no user path: 600 s corpus timeout against 20 s, a harness-only search writer, an English sentence not in the skill. Live registries are on no board. | `retrieve_e.mjs:98,114,211,350` | Say so in the report |
| E-F4 | `dev_job` omits `mayYield`, so the end-of-stage retry and outage waits never run, and `lib.sh` re-runs failures up to 200 times. | `dev_job.mjs:445,451` | Derive first-run completion from the first try's log |
| E-F5 | The scale run is one long `advance`, not the worker's batches. | `scale.mjs:83`, `S/vcrWorker.mjs:305` | Add a claim-and-advance loop with `mayYield` |
| E-F6 | F's trial title names the benchmark and reaches the prompt. | `n2c2_board.mjs:17` | Neutral title, or disclose |
| E-F7 | A re-run after a prompt bump reuses old rows; not triggered so far. | `dev_job.mjs:133,291-302` | Put prompt versions in `armSettings` |
| E-F8 | The verdict a person reads is scored by no board. Board C skips `segmentCriteria`. Final ranking arms are `mode fit`, not the shipped default. | `score.py`, `board_cases.mjs:87-94` | State it in the report |
| E-F9 | Lost E topics drop out of the mean instead of counting zero. | `retrieve_e.mjs:414`, `e2e_e.mjs:134`, `score_e.py:228-231` | Require every topic |
| E-F10 | Judged-only columns are printed above the NIST table, with the warning only in a code comment. | `score_e.py:97-101,309` | Add the caveat to the markdown |

**Label leak: none found (RAN by the delegate).** Labels are read only in scoring. Order is a seeded hash. Prompts carry no ids. Both TrialGPT evaluators and `track1_eval.py` match their pinned digests. Board C reproduces 886.

## Minor (READ unless marked)

- All clauses `not_applicable` gives 符合 (`D/vcrTrialJudgment.mjs:928`).
- A person withdrawing during stage two leaves their pairs in `second`, so the job ends `limited` with "逐条判了 x/y" though nothing is owed (`S/vcrMatchJudge.mjs:1082,1091`).
- A judging job reserves 60 CPU seconds it never uses (`S/vcrMatchJudge.mjs:1205`). With a study near its budget it waits on 「等研究的计算预算」, and the note offers only stop (`S/vcrJobs.mjs:1121`, `W/tabs/JudgedProgress.tsx:52-58`).
- Short names differ across surfaces. The conversation uses `vcrSubjectLabel` and the page uses `vcrSubjectLabels`. Six hex digits collide about 0.75 times at 5,000 people (arithmetic, not run).
- The raw key is shown in `W/ClinicalMatchingDetails.tsx:419` and in the legacy heading.
- The funnel counts a person's older clause row after a newer score replaced it (`S/vcrMatchResults.mjs:577-580`).
- The route labels a record re-judgment `reason: "registry_record"` since d589c6269 (`S/vcrRoutes.mjs:1344`).
- A withdrawn person's pseudonym stays in `results.diagnostics` (`changes.pairs`, a document job's `subjectKey`) and in `jobs.scenario.subjectKey` for a document job. No words.
- A cut-off answer is asked again at the same size, never split (`S/vcrMatchJudge.mjs:457`, part of G19).
- Eval minors from the delegate are in a scratch directory. Most notable: `criteriaTextDiffers` compares a text to itself, the false-favourable count needs one definition on both sides (15, 16 or 13 for GPT-4), and `check_report.py:70` can compare arms on different patients.

## Earlier review fixes at this head

| Review | Item | Status |
|---|---|---|
| Security | B1 symlink, B2 deleted document, B3 withdrawn re-import, B4 bounds, B5 reader access | Hold where tested: `vcrMatchSecurity` 28, `vcrMatchAccess` 7, `vcrRecordsImportBounds` 9, RAN green |
| Security | S2 scan permission, S3 first row in ledger, S5 reasons after revocation | Tested in the same files |
| Security | S4 withdrawal reach | **Partly: see F2** |
| Security | S6 prompt line | Applied (`D/vcrTrialJudgment.mjs:474,544`) |
| Security | S7 search text | Masked by shape only. Names and addresses still rest on the tool text, a stated residual in S9.md |
| Behaviour | B1, B2, B3 | Hold (`scen1` B RAN, `vcrMatchJudgeStages` 12) |
| Behaviour | B4 brief | Fixed; route half still open (F6) |
| Behaviour | S1, S2, S3, S4, S5, S6, S7, S9, S11, S12 | Hold where tested |
| Behaviour | S8 measured-not-shipped | Still true (E3, E-F4, E-F5) |
| Behaviour | S10 structured screening | Fixed except the 50 cut (F7) |

**Residuals S9.md states, still open:** shared table and zip uploads stay in the workspace after a withdrawal; a member's job reads under the owner's identity; rerank books after spending; a project-deletion race on scratch.

## G1 to G29 at this head

| Gap | Status | Where | Note |
|---|---|---|---|
| G1 silent criterion | Closed | `D/vcrTrialJudgment.mjs:519-528,887-897,918-938` | Model judges; labels shown |
| G2 batch language | Closed | `S/vcrMatchJudge.mjs:665-1131` | RAN |
| G3 notes at batch size | Partly | `S/vcrRecordsImport.mjs:315`, `S/vcrDataIntake.mjs:34`; `W/data/SourceCard.tsx:106` | Conversation closed, RAN. Page upload is still one file with a typed subject |
| G4 PDF, Word | Closed | `S/vcrUploadReceipts.mjs:14`, `S/vcrPatientContext.mjs:172-178` | RAN on a parser double; real parser not run by me |
| G5 follow-up | Partly | `S/vcrPatientContext.mjs:202-203` | P1. Whole pair set re-judged, not only what is affected |
| G6 unfinished work | Partly | `W/tabs/JudgedProgress.tsx:66`; `S/vcrService.mjs:1873` | Page closed; P1, P2 |
| G7 table zero | Closed | `S/vcrTableMeaning.mjs`, `S/vcrMatchingTable.mjs` | RAN 13, 11, 1 |
| G8 export | Partly | `S/vcrRoutes.mjs:865-900`, `S/vcrMatchResults.mjs:661-717` | P3, F7; no report format |
| G9 page cap and funnel | Partly | `S/vcrMatchResults.mjs:54,576`; `S/vcrViewsTabs.mjs:1615` | Judged pages closed, RAN at 5,000 (conversation read 0.4 s, page 2.3 s). Rule path open (F7) |
| G10 ChiCTR | Partly | `S/vcrRegistryPages.mjs`, `S/vcrMatchJudge.mjs:402-405` | Needs a browser reader; plain fetch gets 405 (stream S3-g15). Production setup not checked. A conversation's `trial_registry_record` does not read the page (`S/vcrService.mjs:1905-1909`) |
| G11 depth | Closed | `S/config.mjs:1153-1155`, `S/vcrEvidence.mjs:1540-1560` | Not run live |
| G12 ranking | Closed | `D/vcrTrialJudgment.mjs:948-961` | F5 on the doc |
| G13 unlocated clause | Closed | `D/vcrTrialJudgment.mjs:835-876` | Evidence is sentence ids |
| G14 completeness | Closed | `D/vcrTrialJudgment.mjs:285`, `S/vcrMatchJudge.mjs:426` | Model behaviour on alternatives not measured |
| G15 registry change | Closed | `S/vcrRegistryWatch.mjs`, `S/vcrWorker.mjs:72` | RAN 12 |
| G16 failure as success | Partly | `S/vcrMatchBatch.mjs:26-36`, `S/vcrNotify.mjs:129-139` | Job and notice closed; P1, F1 |
| G17 settings | Closed | `S/vcrMatchJudge.mjs:890,1117`, `S/config.mjs:1183-1185` | Recorded per path |
| G18 scale, cost | Partly | `S/vcrMatchJudge.mjs:1063-1069` | Batches RAN at default size; crash resume RAN; E-F5 |
| G19 long notes | Partly | `D/vcrTrialJudgment.mjs:981,1046,1082` | No smaller retry; Chinese long records unmeasured |
| G20 FHIR, OMOP, ADaM | Partly | `S/vcrLongTables.mjs:38-47` | F9 |
| G21 variable mapping | Closed | `S/vcrMatchingTable.mjs:117`, `S/vcrTableMeaning.mjs` | RAN |
| G22 owner counts | Closed | `S/vcrService.mjs:1630`, `S/vcrMatchJudge.mjs:639` | Tested in the access file |
| G23 progress, cost, stop | Closed | `W/ClinicalMatchingDetails.tsx:345-352`, `W/tabs/JudgedProgress.tsx:51-60`, `S/vcrMatchResults.mjs:458-466` | |
| G24 coverage | Partly | `S/vcrEvidence.mjs:1597` | F8: saved, not on the page |
| G25 evidence | Closed | `W/tabs/JudgedPair.tsx:56-74,99` | |
| G26 result link | Partly | `vcr_platform.py:1440-1452` | Still the model's to relay; stream S5 saw 0 disagreements in 5 job runs |
| G27 phone, large roster | Closed | `W/tabs/JudgedPair.tsx:80-88`, `W/ClinicalMatchingDetails.tsx:328-331` | Stream S13 is walking it |
| G28 extraction ledger | Closed by removal | stream S12 | Dead table: F6 |
| G29 stale words | Partly | `S/vcrPatientTrials.mjs:1-29`, `S/vcrEvidence.mjs:1576`, `S/vcrRoutes.mjs:1298` | F6 |

## Ran, and held

- **A real process crash (`scen3`, SIGKILL mid-job, inside the first batch and after several).**
  - On re-claim, every saved pair was found in the ledger: 25 fit calls before the kill, 96 after, 120 rows in all.
  - Only the one in-flight call was paid twice. Clause stage done, state done.
  - The page says running until the lease ends.
- **Reads at 5,000 people (`scen4`, 10,000 rows of 3 KB answers):** conversation read 0.4-0.6 s, page 2.2-2.3 s, resume 1.4-1.7 s. A 5 s poll holds on this box.
- **Verdict agreement across surfaces on a real pair:** list, conversation and export gave the same verdict in `scen1`.
- **Focused tests at 70132684d, all green:**
  - Server, all files named above plus: `vcrMatchJudge`, `vcrMatchJudge.integration`, `vcrMatchResults`, `vcrPatientFollowUp`, `vcrRoutes`, `vcrGateway`, `vcrWorker`, `vcrJobs`, `vcrComposedApp`, `vcrEvidenceMatching`, `vcrPatientTrials` (three files), `vcrCandidateTrials`, `vcrMatching`, `vcrMatchScale`, `vcrAuditNoLeak`, `vcrCriteriaWrite`, `vcrLongTables`, `vcrRecordsImport`, `vcrTableScreening`.
  - Domain 95, Python `test_vcr_platform` 93, web 150 across 4 files.
  - `tsc` on the server: clean.
  - Web tests were run with d589c6269 in the tree; the server files were not re-run after 70132684d.

**Checked, nothing found (READ):** config levers reach `.env.example` and compose (43 keys); no new provider key or path reaches a containerized runtime; a job's model calls and the import's proposals go through the usage ledger; `judgeSelection` and the export are study-scoped; a scan goes out under `#cloudBasis`.

## Not looked at

- Browser rendering and the UI walk (stream S13); any real model or kernel (stream S14).
- `pnpm ci:web`, audits, the full server suite, all of `vcrOrchestrator.integration`.
- Production mounts, uids, AgentBay, whether production has a browser reader.
- Terminology build scripts, `clinical_score` correctness, `vcrClauseDefinitions` beyond its wiring, `vcrCandidateRetrieve` in depth, `vcrRecordsImport` past its table walk (its tests pass).
- Web and harness changes past 70132684d beyond their diffs.
- Anything under the run data directory or the run data directory: no score was read. The one touch was a `test -e` on `frozen/nih-top100`. Board E's prompt variant and the final arms' row versions are therefore unverified.
- Real patient notes: none opened.
- The evaluation slice did not read `selfcheck.py`, `incidents.*`, `run_scenarios.mjs`, `fetch_e.sh`, `budget.py` or `score_d.py` past its header. `trec_eval`, VERDICT's scorer and NIST figures could not be compared here.
