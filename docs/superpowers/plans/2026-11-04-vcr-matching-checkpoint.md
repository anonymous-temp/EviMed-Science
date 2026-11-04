# VCR patient-matching checkpoint — November 4, 2026

This is a checkpoint, not a claim that full-data evaluation or clinical
acceptance is complete. The user requested the current results and remaining
work before further experiments. Nothing here authorizes or records deployment.

## What has actually been run

1. **TrialGPT platform baseline:** At product revision `3eee7f765`, all 53
   public synthetic patient tasks were attempted through DSH and DeepSeek Flash.
   31 completed, five timed out, 12 failed, three were interrupted and two
   ended without a saved feature result. Of 1,015 reference conditions, 603
   could be aligned; the product agreed on 256/603 (42.5%) and the historical
   TrialGPT predictions on 519/603 (86.1%) of those same units. The other 412
   remain unresolved, not wrong or discarded. See the
   [baseline and denominator](2026-11-03-evimed-trialgpt-platform-baseline-results.md)
   and [follow-up audit](2026-11-04-vcr-baseline-audit.md).
2. **Six-patient development panel:** The integrated control and two successive
   repairs each completed all six preselected patients. On the common 93
   aligned units, the integrated control agreed on 39, the first repair on 38,
   and the whole-clause repair on 36; the historical reference agreed on 72.
   The small, previously inspected panel demonstrates no measured improvement
   in label agreement. It is not a new holdout or a clinical accuracy claim.
3. **TREC operational probes:** The first topic of each of 2021, 2022 and 2023
   completed through the real product at `87d077436`; each produced a frozen
   500-ID retrieval receipt and a source-verified saved order of 20 trials.
   nDCG@10 was respectively 0.584, 0.607 and 0.232; eligible Recall@500 was
   34/47, 69/76 and 163/387. These are three individual cases, not full-year
   results. See the [methods, costs and fixed-candidate comparison](2026-11-04-vcr-trec-operational-results.md).
4. **n2c2:** The user confirmed authorization to send these deidentified records
   to DeepSeek for processing. Private preparation checked label-free inputs
   for 202 training and 86 test patients. No n2c2 record has yet been uploaded
   to the product or sent in this platform evaluation. A separate, not-yet-
   integrated evaluation adapter has offline synthetic tests; this is not an
   external-validation result.
5. **Blind diagnostic:** A separate Flash-only review of 310 public synthetic
   packets was started to investigate unknown-versus-reference disagreements.
   It is not the EviMed product path, is not independent clinical adjudication,
   and has not produced a complete sealed result at this checkpoint. Retain
   failed, unattempted and unresolved units rather than treating them as labels.

## Fixes retained in the pushed feature branch

The matching changes preserve complete source clauses, guard ambiguous language
keys and stale candidate versions, separate applicability and its evidence,
correct calendar-month boundaries, retain partial trial outcomes, and improve
gateway and assessment observability. A later repair suppresses language
requests for a condition already shown inapplicable by the current saved
assessment; unknown applicability and other assessments remain distinct.
Targeted tests, independent review and real PostgreSQL integration checks were
run. The last repair has not yet been rerun through the full product: the
attempted isolated recheck did not start its runtime or send a model prompt.

An experimental background language worker exists only on a separate local WIP
branch, `codex/vcr-language-job-20261104` at `1a4350df4`. It is not integrated
or enabled. Authorization/erasure races, mixed-version database fencing,
assessment invalidation, full lock-order review and client-path validation
remain open; one independent review also found a lint failure and an early
transport-response test gap. Its fake-provider and queue tests do not establish
production readiness.

## Remaining execution, in order

1. Review and integrate the n2c2 evaluation adapter, including its authorization
   binding and protected-data preflight. Run the 86 test and 202 training
   patients through the actual platform under the user's DeepSeek authorization,
   with one disposable account/project/conversation per patient, automated
   attribution and memory extraction off. Keep gold outside runtime and report
   unprocessed, pending and unknown separately. The dataset has prior exposure;
   do not call it a fresh unseen holdout.
2. Freeze the current pushed product revision and rerun the full 53-patient,
   1,015-condition TrialGPT platform cohort. Report all first attempts, aligned
   and unresolved denominators, same-unit historical comparisons, failure
   stages and patient-level uncertainty. Do not tune or relabel missing evidence
   to improve agreement.
3. Run the complete 75/50/40 TREC topic sets on one frozen product revision.
   Report Recall@500, fixed-candidate and saved-order nDCG@10/P@10, completion,
   unjudged topics and time/cost. The three earlier single-topic probes used a
   previous revision and remain separate evidence. Preserve the three 2023
   topics without qrels as unjudged rather than scoring them as zero.
4. Use those full-run outputs to prioritize actual cause fixes: source-clause
   inventory and completion, supported clinical inference versus missing data,
   language-judgment throughput and evidence presentation, and relevance-aware
   ranking. Compare any change against the same patient units and candidate
   sets. Complete and independently review the WIP worker's safety and
   mixed-version gates before integrating or enabling it.
5. Publish the full-run reports and exact remaining failures; then separately
   decide any deployment. Virtual cohort, virtual-patient and synthetic-control
   validation still require their own data and method-specific endpoints.

Each full run should be launched once with a frozen manifest and a bounded
resource envelope. Preserve failures and resume interrupted work explicitly;
do not replace the requested full run with another small pilot.
