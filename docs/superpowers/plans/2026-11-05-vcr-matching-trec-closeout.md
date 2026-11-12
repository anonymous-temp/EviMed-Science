# TREC results and owner-requested closeout

The owner stopped remaining TREC work on2026-11-05 and requested completion of the other work, followed by commit/push without deployment. TREC indexing and its success-only continuation were stopped;2023 did not start. No new TREC clinical or official-score run was completed for the native plugin. Historical scored results remain valid historical evidence and are not relabelled as the new plugin's performance.

Machine-readable aggregates: [trec-closeout.json](2026-11-05-vcr-matching-plugin-v3-assets/trec-closeout.json). Original unchanged evidence: [official-score output](2026-11-04-vcr-matching-delivery-assets/scores/board-e-end2end.json), [result diagnosis](2026-11-05-vcr-matching-next-phase.md).

## Historical full-corpus end-to-end results

These runs used source revision `a2d109cf5`, DeepSeek Flash, the frozen full trial collections and official qrels. The incoming-order figures score the same candidates later judged; they isolate the effect of the old judgment/readback ordering. Each topic's final list contains100 candidates.

| Year | Scorable topics | Incoming nDCG@10 | Final nDCG@10 | Change | Incoming eligible P@10 | Final eligible P@10 | Final J@10 |
|---|---:|---:|---:|---:|---:|---:|---:|
|2021|65|0.4640|0.4750|+0.0110|0.3523|0.4338|0.5308|
|2022|40|0.4743|0.5286|+0.0542|0.3900|0.4825|0.6750|
|2023|28|0.4753|0.3663|−0.1090|0.3071|0.3464|0.4036|

Across133 scorable topics, pooled final nDCG@10 is0.4682 and eligible P@10 is0.4301. The mean of the three yearly means is0.4566 and0.4209 respectively; it uses a different denominator/weighting and is not the pooled result.

The original TREC scope contains165 requested topics. Three2023 topics have no official scorable relevance data, leaving162 scorable all-topic inputs. The historical test split has135 requested topics and133 scorable topics:65/40/28. A result averaged over133 is not an all165-topic mean.

### What the poor2023 result demonstrates

The strongest observed failure is a loss of0.1090 nDCG@10 after judgment on exactly the same candidates. The exploratory paired-topic95% bootstrap interval in the existing diagnosis is approximately[−0.2063,−0.0146]. This is a measured stage regression. It supports repairing ownership of ranking and result composition; it does not prove that clinical eligibility itself is technologically unattainable.

Eligible P@10 increased by0.0393 in2023, but its paired interval includes zero. Graded order and eligible count therefore tell different parts of the story. Moving grade1 excluded trials, grade2 eligible trials and unjudged trials has different effects on discounted graded gain.

Only40.36% of the final2023 top ten are judged by qrels;59.64% are unjudged. Condensing to judged trials raises its auxiliary nDCG@10 to0.8548, but changes the evaluation list and cannot replace the official0.3663. The corresponding2021/2022 auxiliary values are0.8192/0.7408. Unjudged trials are zero gain under the official profile; their absence of labels is not proof that they are clinically suitable.

The archived NIST reference on the same28 scorable2023 test topics is median nDCG@10 0.6680 and best0.8070, compared with0.3663 here. For2021/2022, the archived whole-track medians0.3417/0.4045 are lower than our test-subset point estimates, while the best whole-track values0.7150/0.6125 are higher; differing topic sets prevent a paired standing. These are historical track references, not a new2026 leaderboard.

The previous analysis also identifies low candidate recovery relative to the available depth ceiling, the2023 questionnaire/input shift, incomplete knowledge/longitudinal evidence and implementation effects. These remain distinct from arithmetic errors. Rank-level causal attribution and fresh full-corpus effectiveness after the new implementation remain unmeasured because this run was stopped.

## Current native-plugin work before the stop

| Stage | Actual final state |
|---|---|
| Frozen2021/2022 source |375,580 source records; bounded index projection prepared and hash-verified |
| Frozen2023 source |451,538 source records; bounded index projection prepared and hash-verified |
|2021/2022 dense vectors |232,180/375,580 (61.82%); generation still `building` |
|2023 dense vectors |0/451,538; stage not started |
| Ready full index |0 |
| New native TREC clinical topics |0 |
| New official TREC score |Not produced |

The final database row count matches its atomic generation counter. The last CLI progress event showed232,000 because in-flight batches completed before shutdown; the verified post-stop count232,180 is the authority.11,609 settled embedding requests ×20 vectors =232,180 persisted vectors.

Costs use the usage ledger and its frozen reference price list; supplier invoices were not reconciled. Settled index usage was49,669,196 input tokens and CNY24.834598. Seven interrupted/uncertain reservations retain a conservative CNY0.060305 exposure, giving CNY24.894903 committed exposure. Two of those queued calls were never dispatched; they are not presented as actual spend. The one HTTP429 refusal was released. This cost belongs to source/index preparation, not a new TREC score.

SIGINT exited130; the success-only chain did not start2023. PostgreSQL, frozen source files, manifests, vectors, source/profile hashes, usage and resume metadata are preserved. No further TREC action will run automatically.

## Engineering repairs retained for future use

The new implementation separates Qwen relevance ranking from Flash clinical eligibility, preserves incoming/rerank/final orders, uses one saved projection, keeps metric profiles explicit, validates actor/source access on results and reports, and provides independently versioned native/worker artifacts. Full-pool reranking uses a single provider request rather than mixing request-relative scores. Index construction now has sparse source offsets, bounded batches and atomic progress counters.

The actual run also exposed provider throttling and native output-capacity/contract faults. Those were fixed or retained in the non-TREC validation track with source-phase evidence. Their engineering verification does not establish a new TREC quality gain. Future TREC effectiveness remains a separate explicitly authorized campaign; the remaining work is skipped now.
