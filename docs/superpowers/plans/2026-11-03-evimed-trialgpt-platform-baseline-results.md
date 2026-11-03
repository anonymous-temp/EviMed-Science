# EviMed VCR platform baseline, November 3, 2026

The local benchmark ran the pushed product at `3eee7f7653462c760db303c0234bbb3f96dd9705` using the real DSH 0.2.1-rc.5 Docker runtime and DeepSeek Flash through the product model gateway. The product integrates the two development lines in `faa8d0f28`, source-bound retrieval and persisted ranking in `3434ff107`, and original text attachment intake in `aa17e0d66`. Deployment was outside the execution scope.

## Known-candidate criterion matching

| Measure | Result |
| --- | ---: |
| Patients with a first attempt | 53 / 53 |
| Completed with saved feature results | 31 / 53 |
| Timed out / failed / interrupted / feature result missing | 5 / 12 / 3 / 2 |
| Criteria with scorable alignment | 603 / 1,015 (59.4%) |
| EviMed agreement with expert labels on aligned criteria | 256 / 603 (42.5%) |
| Historical TrialGPT GPT-4 agreement on the same criteria | 519 / 603 (86.1%) |
| Agreement on the 512 aligned criteria from completed runs | EviMed 227 / 512 (44.3%), historical TrialGPT 436 / 512 (85.2%) |
| Conditions without a resolved alignment | 412 / 1,015 |

The first-attempt analysis preserves the original interrupted batch and includes five incomplete cases with usable, persisted criterion rows. The resumed batch covers only the 20 patients without an earlier attempt. All 53 account deletion receipts succeeded. The analysis checked automation attribution and assembled case records using the same pushed revision, live-instance receipt, full case manifest, collection, reference, targets and alignment code hashes. No later result replaced an earlier attempt.

The 412 unresolved rows comprise 312 with no overlap, 55 partial overlaps, 16 unresolved merges, 12 ambiguous overlaps, nine unlocated source clauses and eight unresolved splits. All 312 no-overlap rows had no returned criterion rows for the corresponding patient and trial. Of the 412, 76 came from completed runs. The others came from failed, interrupted, timed-out or missing-result runs. The frozen scorer retains these rows separately. Every aligned row had a scored prediction.

The largest disagreement was 278 instances of platform “not enough information” against reference “not excluded”, 80.1% of the 347 disagreements. Thirty reference inclusions also remained unknown. Review those cases at the level of evidence and criterion meaning. The historical prompt permits limited inference of absence from a good note and encourages fewer insufficient-information predictions. A mention missing from a short record does not establish a negative finding for clinical use. The historical predictions are paired archived answers and the result measures agreement on the aligned subset. [Pinned TrialGPT matching prompt](https://raw.githubusercontent.com/ncbi-nlp/TrialGPT/1b3242cd50c153a9c324661d4a0bd94fc68a4226/trialgpt_matching/TrialGPT.py)

## Execution and product findings

- The control-plane error audit recorded 82 model Messages gateway failures backed by upstream non-success HTTP responses and nine client-closed stream events. The gateway mapped the upstream failures to 502. The audit did not retain the original upstream HTTP status. In one measured case, a reserved request settled after about ten and a half minutes. Heartbeat-sized network traffic continued while the transcript showed no progress. The case deadline bounded the experiment. Uncertain calls remain conservatively reserved in the budget journal.
- Two known-candidate runs completed their conversation without a saved matching result. In `sigir-201515`, the agent registered the patient and wrote six facts, but called broad retrieval despite supplied trial IDs and wrote no candidate criteria. An empty matching view should visibly report unfinished work, and a task with supplied IDs should start from those exact frozen records. Count completed cases from saved artifacts.
- Isolated review of `sigir-20141` found that an executable obesity rule lost its source BMI threshold. The same case displayed three duplicate negative citations and omitted the positive citation that determined the Boolean result. Preserve material qualifiers in the compiled condition and keep the decisive evidence visible after deduplication. Add tests for incomplete evidence, disjunctive branches, and the displayed result.
- The two saved language judgments in `sigir-20141` treated general consent and compliance in a synthetic note as support for written consent and comprehension of diary cards. The source does not explicitly state those narrower facts. These are inference-policy cases for blinded adjudication. Record the supporting statement and the scope of the inference separately.
- The next paired run should test whole-clause preservation, complete processing of pending language judgments, explicit applicability and correct numeric/temporal boundaries. The existing batch extraction job returns extracted facts and unresolved language requests. The native conversation already has an authorized path to write language judgments and reevaluate the saved match. Review the current 500-character language bound and applicability discovery before widening this path.
- Gateway observability should preserve a sanitized upstream status and request identifier when available. Distinguish time to semantic output from transport activity and record retries and incomplete work. Repeat the affected cases separately under the same inference and scoring contract before making a coverage or reliability claim.

## TREC retrieval and ranking

The frozen index component returned 500 distinct candidates in ten pages and returned the exact record for each of the two corpus snapshots. The 2021 and 2022 topics share the 375,580-record snapshot. The 2023 topics use the 451,538-record snapshot. Index hashes matched. The first Docker launch refused a legacy manifest that omitted the explicit source format. A new local manifest declared `clinicaltrials-xml` and kept the same index bytes and hash.

The first topic of each year was selected by manifest order. The paid instances passed their no-model isolation and cleanup probes before dispatch. Each topic received only its patient note. The end-to-end check produced the following results.

| Frozen topic | Execution | Source-verified retrieval receipt | Saved trial order |
| --- | --- | --- | --- |
| `trec-2021-1` | Runtime session error | None | Empty |
| `trec-2022-1` | Runtime session error | None | Empty |
| `trec-2023-1` | Runtime session error | None | Empty |

All three accounts were deleted and both TREC environments were removed. The audited model gateway recorded upstream failures on the Messages route during these attempts. Recall@500 has no denominator for this probe. The empty-ranking metric is zero for the three attempted topics and describes delivery failure. It supplies no estimate of ranking quality. The remaining 162 topics were not run. Resume the full TREC batch only after the same product path produces a source-verified retrieval receipt and a saved order in a repeated operational check.

## Verification and preserved evidence

The benchmark suite passed 32 Python checks and 14 Node checks at the tested revision. Scoped product tests and review preceded the push. The isolated readiness probes verified the runtime mounts, read-only corpus boundary, blocked direct and mediated public egress, effective memory settings and account/runtime cleanup.

Private evidence includes the first-attempt manifest with parent freeze hashes, criterion-level alignment rows, scorer output, three TREC topic receipts, redacted gateway audit and cleanup records. The shared estimated-price journal retained CNY 27.18 in settled usage and CNY 47.49 in unresolved reservations across the local campaigns and prior probes. These are reference-price ledger figures. The journal was retained outside the removed containers.

The next acceptance decision requires a stable rerun with coverage and saved-output targets, then a paired comparison after the product changes. This local public-data run exercises automated product dispatch. Browser acceptance, independent clinical holdout validation and deployment remain separate.
