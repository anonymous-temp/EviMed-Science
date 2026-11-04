# VCR TREC operational probes, November 4, 2026

The first preselected topic from each TREC year ran through the local EviMed
patient-matching product at pushed revision `87d0774369c06aa6813c28fca96de6eef39fb3aa`.
Each used a separate automated conversation, throwaway account and project, with
memory extraction off. The product ran DSH 0.2.1-rc.5 and requested and received
the `deepseek-flash` alias through its model gateway. The provider's current
[model documentation](https://api-docs.deepseek.com/quick_start/pricing/)
maps that alias to DeepSeek-V4.1-Flash-1017; the response did not independently
identify the underlying model build. The experiments did not use Pro.

All three conversations finished with 20 source-verified, distinct saved trial
rows and a source-verified 500-ID retrieval receipt. The 2021 and 2022 topics
used the frozen April 2021 collection; the 2023 topic used the frozen May 2023
collection. Gold qrels stayed outside the runtime. The three accounts and their
runtime containers were removed. The control planes exited normally, drained
their model-call receipts and passed the post-shutdown circuit-breaker check.
The blinded diagnostic was running concurrently, so these latencies are not
isolated capacity measurements.

| Year, topic | Eligible Recall@500 | Graded Recall@500 | nDCG@10 | P@10 eligible | Calls | Minutes | Reference-price CNY |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2021, 1 | 34/47 = 0.723 | 139/216 = 0.644 | 0.584 | 0.4 | 52 | 7.82 | 0.9411 |
| 2022, 1 | 69/76 = 0.908 | 175/269 = 0.651 | 0.607 | 0.5 | 51 | 7.27 | 0.8527 |
| 2023, 1 | 163/387 = 0.421 | 356/889 = 0.400 | 0.232 | 0.3 | 40 | 6.00 | 0.5775 |

These are three development probes, not three-year benchmark averages or a
patient-level validation. The scorer uses linear-gain nDCG and treats an
unjudged trial as zero gain for the metric; it does not infer that the patient
is clinically ineligible. TREC's qrel 0 is non-relevant, 1 is relevant but
excluded and 2 is eligible ([NIST 2022 definitions](https://trec.nist.gov/data/trials2022.html)).
Recall is limited to the judgments available for each topic. A comparison with
TrialGPT's reported benchmark aggregate requires matching its corpus, topics,
candidate depth, qrels and metric convention; these individual probes cannot
establish that comparison.

## Ranking on the same selected candidates

An exploratory post-run analysis reorders each of the 20 candidates actually
saved by the product using their positions in its own deepest source-verified
retrieval receipt. Both orders use the same selected set and the same full-topic
ideal DCG; no annotations guide candidate selection. The updated scorer records
its own SHA-256 as well as the product revision, and refuses this comparison
when the saved order is empty, unverified, duplicated or not contained in a
complete retrieval receipt.

| Year, topic | Retrieval order nDCG@10 | Saved product order nDCG@10 |
| --- | ---: | ---: |
| 2021, 1 | 0.663 | 0.584 |
| 2022, 1 | 0.320 | 0.607 |
| 2023, 1 | 0.558 | 0.232 |

This analysis uses observed, repeatedly inspected topics and is not a frozen
independent ranking comparison. It shows that the current criterion-proportion
ordering can help or hurt on particular examples; it does not establish a safe
replacement or justify tuning to these three labels. The product evaluated up
to 20 candidates from a 500-ID retrieval receipt, not all 500.

## Observed issues and remaining gates

- On 2022 topic 1, 162 conditions were saved, while the final narrative said
  approximately 200. Persisted data and generated prose can diverge; results
  need an exact read-back for counts.
- The same case's final view still listed four language requests corresponding
  to criteria already marked not applicable. Those should not be counted as
  four applicable missed decisions, but the stale requests are confusing.
- Two long candidate-tool responses were spilled and recovered from files by
  the agent. The 500-ID receipt remained parseable and the scoring used the
  saved view, but very large tool responses create avoidable orchestration work.
- The initial 2023 no-model isolation probe failed before dispatch because a
  host Mach-O Docker client had been supplied to a Linux container. The probe
  account was removed and no prompt was sent. A new isolated instance using a
  Linux client passed the no-model probe and produced the measured 2023 result.
  The launcher should reject incompatible clients before creating resources.
- The first topics meet the operational retrieval-and-ranking gate. The other
  162 topics have not been run in this recovery batch; the plan also calls for
  the matching completion/coverage gates before scaling. A semantic reranker,
  independent fixed-candidate ranking study, full 53-patient rerun, clinical
  adjudication and authorized external-record platform validation remain open.

Private source-bound receipts, all first attempts, the redacted usage journal
and scoring artifacts are retained under `.evimed-local/acceptance/` and are not
part of Git. This report contains only aggregate public-benchmark results. No
deployment is implied by the local runs or pushed code.
