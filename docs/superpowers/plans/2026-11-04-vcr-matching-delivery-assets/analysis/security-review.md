# Security review of codex/vcr-match-delivery-20261104 (base 6e1841609)

Scope: authentication, tenancy and data boundaries of what the branch adds. Nothing in the branch was edited and no paid call was made.
Throwaway tests are in a scratch directory (`sec1`-`sec4`, `cell.mjs`, `seg.mjs`, `zipmany.mjs`, `mask.mjs`, `plan.mjs`), not committed. Database: own `evimed_test_secreview` and its `_sec*` children on 127.0.0.1:55433, all dropped at the end. Real plane, queue, receipts and tables; the model, parser and registry were doubles. "Ran" below means a test showed it. "Read" means the code path was read end to end and not run. Paths are under `OpenScience/apps/server/src/` unless they say otherwise.

## Blocks delivery

### B1. A run with a shell reads any file the control plane can read, and writes through a planted link
`vcrRecordsImport.mjs:304,323,331,335,341,441` open an upload original with `createReadStream`, `unzipper.Open.file` and `convertWorkbook` on the path `vcrUploadReceipts.mjs:128` (`locate`) returns. There is no no-follow open and no digest check. The `locate` comment says the bytes are "checked by whoever reads them"; nobody does. `.evimed-upload-originals/` is in `baseDir`, which is the runtime's writable `/workspace` unless a named workspace is active (`store.mjs:923`, `dockerMounts.mjs:60`, `runtimeManager.mjs:2829`).
- Ran (a), `sec4`: upload `p1_note.txt`, replace the original with a symlink to a file outside the project, `import_documents`. Job `succeeded`, and `documents.runtimeRead` returned the outside file's bytes as a patient document. Reachable targets are whatever is plain text to the control plane: mounted key files, another account's project and data plane. A file holding NUL bytes is refused (`decodeUploadText`), so `/proc/self/environ` is not one.
- Ran (b), `sec4`: plant `<original>.xlsx.converted.csv` as a symlink beside a workbook. `convertWorkbook` (`vcrDataPlane.mjs:1751`) wrote the attacker's CSV through it, and the victim file outside the project was overwritten.
- The caller only needs an account and a conversation. Assumed, not run: the runtime uid can replace files in that directory (`deploy/web/.env.example:1754` says the two must be one uid).
- Tests miss it: every import test writes real files and none plants a link. The older path (`readOriginal`, `openScopedFileNoFollow`) defends this; the job path does not use it.

### B2. A job in flight writes a deleted document back, and the export prints it
`judgments.save` (`vcrMatchJudgmentStore.mjs:70`) guards only withdrawal, and non-locking. `noteOf` (`vcrMatchJudge.mjs:639`) keeps up to 32 people's text for the batch (400 pairs or 5 minutes).
- Ran, `sec2`, real executor: delete the document during the first model call. 6 more model calls carried the deleted text, and 7 rows stayed, 2 quoting it verbatim.
- Ran, `sec1 F5`: a row saved after `removeUpload` makes `GET matching/export` print the deleted sentence, an ID number in the test. The page hides the quote and still shows the reason. The same applies to `retireProjection`, the path for a projection that leaked an identifier (read).
- Ran, `sec1 F4`, withdrawal race: a `save` between `#erase`'s DELETE (`vcrErasureStore.mjs:250`) and its commit survives the withdrawal. The row is hidden from reads and kept, until a second withdrawal removes it.
- Ran, `sec2`: a person withdrawn mid-job had 4 more model calls carrying their text. No row was kept, but the text kept leaving, because `withdrawn` is read once per batch (`vcrMatchJudge.mjs:620,748`).
- Tests miss it: `vcrMatchJudge.integration` only saves after the withdrawal has committed, and nothing deletes a document while a job holds it.

### B3. A withdrawn person is written back by an import and read by the cloud again
`#storeChecked` (`vcrDataPlane.mjs:2243`) has no withdrawal check, and the pseudonym is deterministic per study. `#cloudDocument` (`:3445`), `documentText` and `listDocuments` do not check it either.
- Ran, `sec3`: withdraw a person while an import walks a table. Of 3 documents, 2 were live after the withdrawal, and `documents.runtimeRead` returned their text.
- Ran, `sec1 F3`: a later import with the same ID stores a new document under the same key, and `roster` lists the person again. `patient_context` candidates would list them too (read). The judging job's own filter holds; the document read does not.
- This hole exists at base, but the branch removes the 200-row limit and makes import an unattended job, so it is now the normal path. Tests miss it: they cover the judgment's guard, not intake.

### B4. One upload can kill the shared control plane
`delimitedRows` (`vcrRecordsImport.mjs:84`) builds a cell one character at a time with no bound, and the sampling at `:358` runs first, in the server's own process.
- Ran, `cell.mjs`: an unterminated quote costs about 37 bytes of heap per character. 5 MB used 191 MB. 20 MB under `--max-old-space-size=512` aborted the process. The upload ceiling is 50 MB, and inside a zip the entry is unbounded. The crash takes every account down; a reclaimed job repeats it, up to `maxAttempts: 5` (read).
- Also unbounded, same module (read unless marked): rows and entries per import, with one plane file and one row each and no quota (a zip-bomb CSV fills the disk); documents per person in `readSubjectNote`; `people` in the checkpoint; `listSourceFilesForStudy` every batch; `convertWorkbook` reads the whole converted CSV into a string, contrary to the module note; a zip's central directory (ran, `zipmany`: 60,000 entries took 135 MB heap and about 1 s, again every batch; a 50 MB zip holds about 500,000).
- Tests miss it: the 5,000-person proof uses well-formed small rows.

### B5. The matching page and export bypass the plane's access judgment
`GET matching/judged` asks `read` (`vcrRoutes.mjs:187`). `#viewed` (`vcrMatchResults.mjs:551`) filters quotes under the viewer, and nothing else.
- Ran, `sec1 F1`: a `viewer` (no `read_patient_level`) reads `why`, `groups` and every clause `reason`, such as 「确诊 EGFR 19del 阳性的肺腺癌，ECOG 1 分」 and 「62 岁男性」, plus each person's verdict. The table's own comment says reasons "may repeat what a record says", and `vcrViewsTabs.mjs:1665` gates the timeline for this same role.
- Ran, same test: the funnel and tallies show `against: 1`, `silent: 1` and more to a member, against the owner ruling that only the owner reads exact small counts. `vcrRoutes.mjs:777` applies that rule on the longitudinal route; this reader has none.
- Ran, `sec1 F2`: a member `lead` with no source grant gets 403 `vcr_no_grant` on the document, and 200 with the verbatim sentence on `matching/export` (`vcrMatchResults.mjs:605-615`). The export is neither judged nor recorded by the plane.
- Read: a `data_manager` without a grant starts a job that reads under the owner's identity (`vcrMatchJudge.mjs:1038`) and then reads the reasons.
- Tests miss it: the authorization test asserts status 200 for the viewer, not the body.

## Should fix

**S1. Nothing bounds a selection's spend, and the "ceiling" is not one.** `vcr` is in `UNCAPPED_USAGE_PURPOSES` (`usageLedger.mjs:40,364`), so a job's spend never counts against any cap and `usage_budget_exceeded` cannot fire from it. No run limit is passed. Ran, `plan.mjs`, off-peak: 60k-character note × 500 trials with `topK: all` estimates CNY 149.5; a 1 MB note estimates CNY 3,405, above the whole CNY 3,000 eval cap on the key production shares, from one tool call that says 「不用确认」. The owner has ruled out account caps, so this needs a decision on a per-job ceiling, not a re-ask of caps. Read: `最多约` (`vcrMatchJudge.mjs:567`) and `cost.ceiling` (`vcrMatchResults.mjs:398`) omit the re-ask (`askOnceMore`), the end-of-stage retry and the long-table calls. `spent` loses a failed row's cost when the done row replaces it, and omits definition and long-table calls. `.env.example` says output default 16000 and thinking high; `config.mjs:1191-1193` says 32000 and off. A rerank (read) books after spending, and books nothing with no study (`vcrEvidence.mjs:1315`), not even `unmetered`.

**S2. A scan goes to the external parser from a source whose cloud permission is revoked.** `vcrDataPlane.mjs:2221` has no `#cloudBasis`. Ran, `sec3`: parser called once while a cloud read of that source is refused, against "a restriction nothing overrides" (`vcrCloudProjection.mjs:81`). Read: a text PDF also goes to the parser when the converter is down, while the comment promises only scans. The permission page's destinations do not name the parser.

**S3. A table with no header row puts the first patient's row in the job ledger.** `plan.headers` is uncut (`vcrRecordsImport.mjs:360,376`) and goes into the failure message at `:383`. Ran, `sec3`: `jobs.error` held the ID number and note text. Read: `GET jobs/:job` returns `error` and `checkpoint` to a `viewer` (`vcrRoutes.mjs:1443`, `vcrStore.mjs:337`), and no erasure touches them. The whole first row also reaches the model uncut (ran).

**S4. What a withdrawal leaves.** Ran, `sec1 F3`: `candidate_searches` keeps `subject_key`, age, sex, terms and condition; `#erase` has no line for it. Ran, `sec3`: the upload original and its receipt stay readable, and the file name is often the patient's. Read: the job report's names stay, because `skip` always passes `subjectKey: null` (`vcrRecordsImport.mjs:504`) and the filter at `vcrDataPlane.mjs:3729` never matches. `jobs.scenario.subjects` keeps the key, and `latest()` can return it (`vcrMatchResults.mjs:432`). The long-table sample sent to the model is not filtered by withdrawal (`vcrLongTables.mjs:202`).

**S5. Reasons keep going to the cloud after a revocation.** `projected` (`vcrMatchJudge.mjs:1149`) filters evidence only. Ran, `sec2b`: with the permission revoked, a later read returns 「患者李四的肌酐 3.1」 with `evidenceWithheld: 1`. Same root cause as B5.

**S6. The judge prompts have no data fence.** `FIT_SYSTEM` and `criteriaSystem` (`packages/domain/src/vcrTrialJudgment.mjs:311,405`) and the definition prompt lack the "data, never instructions" line that `proposalMessages`, `longShapeMessages` and the rerank carry. Anyone may register a trial, so a trial's text can set `fit` and `reasons` for every patient, and `vcr_platform.py` tells the conversation to copy `reasons`. Definition cards would also cache such text across accounts (off by default). Read, not run; there is no injection test.

**S7. Search text leaves unchecked.** `rankForSummary` (`vcrEvidence.mjs:1328`) consults no cloud decision. Ran, `mask.mjs`: `maskIdentifiers` leaves names, 住院号, MRN, address and date of birth. `terms` and `condition` are not masked at all before public registries and the receipt (read). The summary being "not the note" rests on the tool description alone.

## Minor
- `judgeStatement` (`vcrMatchJudge.mjs:564`) prints small withdrawn and no-record counts to non-owner readers. Ran: `forModel` passes the sentence unchanged, while `matchBatchStatement` honours `exact`.
- `#storeChecked` scratch: an import lane racing project deletion can recreate the study directory and leave one document on disk (read, narrow).

## Checked, nothing found
- Cross-account reach: `requireStudy`, `searchId`, `protocolVersionId`, `documentId` and `subjectKey` are all study-scoped (read). `POST rejudge` and `POST judge` ask `run` plus `read_patient_level`. The `match_judge` and `records_import` kinds are refused from the generic job route (`vcrJobs.mjs:948`).
- Model answers never choose ids, targets, hashes or subject keys: clause numbers, sentence ids and columns are checked in code.
- Zip-slip and symlink entries: entry names never become paths (read).
- CSV formula cells: `csvCell` handles `= + - @ \t \r` (ran). Project and account deletion: FK cascade plus study directory; a job stops on a missing row (read).
- ChiCTR page reader: host allowlist and https only. `registry_pages` and registry definition cards hold no patient text.
- Owner-view `ownerView`/`exact` is set only from identity, and publications, review input and exports do not read judgments (read).
- Logs, metrics and audit carry codes and pseudonyms only (read). Committed files: no key, local path, private repository of ours or customer name in the diff (a test's anti-leak regex aside). `svpo-rl` named in the eval README is a third party's.
- `clinical_score` and `terminology.py`: no eval, parameterized SQL, read-only file. `segmentSentences` on 16 MB took 203 ms, no stall worth reporting.

## Not checked
Production mounts and uids, AgentBay, `/proc` or real secrets as link targets, the web client, `vcrMatching.mjs` and `vcrPatientTrials.mjs` beyond the matching seams, clinical score correctness, terminology build scripts in depth, memory reset (it does not touch `evimed_vcr` by a name search only), an end-to-end prompt injection, the full test suite.
