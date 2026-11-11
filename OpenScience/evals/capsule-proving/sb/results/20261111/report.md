# SkillsBench / SkillLearnBench pilot — 2026-11-11

**All scored rows are model + skills in the reference harness, not the product.**

| Run | Passed / planned | Wilson 95% | Scored / infrastructure / missing | Tokens per model-invoked task | CNY per model-invoked task | Mount incidences / read events (distinct mounted / opened) |
| --- | --- | --- | --- | --- | --- | --- |
| sb-none-1 | 1/8 (12.5%) | 2.2–47.1% | 6 / 2 / 0 | 354960 | 0.142 | 0 / 0 (0 / 0) |
| sb-flat-1 | 4/8 (50.0%) | 21.5–78.5% | 6 / 2 / 0 | 354464 | 0.071 | 13 / 7 (12 / 7) |
| sb-learned-1 | 2/8 (25.0%) | 7.1–59.1% | 6 / 2 / 0 | 346720 | 0.085 | 30 / 0 (5 / 0) |
| slb-none-1 | 2/6 (33.3%) | 9.7–70.0% | 5 / 1 / 0 | 1007143 | 0.142 | 0 / 0 (0 / 0) |
| slb-flat-1 | 3/6 (50.0%) | 18.8–81.2% | 5 / 1 / 0 | 1646359 | 0.169 | 10 / 5 (9 / 5) |
| slb-learned-1 | 0/6 (0.0%) | 0.0–39.0% | 5 / 1 / 0 | 827099 | 0.142 | 25 / 2 (5 / 2) |

Rates above keep infrastructure failures and missing tasks in the planned denominator. Wilson intervals describe this feasibility-conditioned pilot, not a population estimate of the full benchmark. Scorer-only rates and every task are in the JSON/CSV. A partial run is not a final benchmark score. Tokens include cached prompt tokens and completion/reasoning tokens. Costs are timestamp-adjusted billing estimates; peak equivalents are retained separately.

## Sampling and per-domain results

Before scores: screen Dockerfile for large ML/compiler/download dependencies, specialized base images and task-required credentials; rank eligible names by SHA256(seed + colon + name). SkillsBench: first per domain test, second practice. SkillLearnBench: first family per README category, variant 1 practice, first two remaining variants by the same hash test. This is a feasibility-conditioned pilot, not a representative full-benchmark estimate.

Capacity amendment before any SkillLearnBench scoring: only the first frozen held-out variant per family is primary (six families/categories, one variant each); the other six candidates are unused reserves. No scored result selected or removed a task.

Execution capacity rule: Within each benchmark, native agent timeout ascending, then SHA256(seed + colon + task id); alternate benchmarks. Complete none/learned/flat per task. Sample unchanged; no outcome enters ordering. The exact order is retained in `execution-queue.json`.

Harness qualification amendment (2026-11-11T08:48:11.273198+00:00): BenchFlow 0.6.3 trajectory redaction stalled the control loop; py-spy located the video client in its generic credential-name scan after native Pi completion. Requalify the whole five-task pre-fix phase, including its pass, under the logging-only compatibility fix. Repeat all five, never select retries by reward. Remaining three no-skill tasks and all learned/flat trials start after the fix. Original grades and paid usage are preserved as calibration, not primary comparisons. Original artifacts: `sb-none-precompat-1`; 5 tasks designated for fresh qualification; primary records distinguish actual reruns from unavailable admissions. Calibration usage remains in total lane cost, separate from primary per-task inference cost.

Harness qualification amendment (2026-11-11T10:37:13.558817+00:00): Whole one-task flat adapter phase invalidated before any other SkillsBench flat trial: intake folders/files are 0700/0600, runtime upload preserves them, and non-root Pi cannot traverse the canonical skills tree. Flat first prompt had the same 1693 tokens as none; learned was 2797. Stage byte-identical public skill copies with readable permissions and repeat the whole affected phase. No outcome selected the retry. Original artifacts: `sb-flat-permission-calibration-1`; 1 tasks designated for fresh qualification; primary records distinguish actual reruns from unavailable admissions. Calibration usage remains in total lane cost, separate from primary per-task inference cost.

Scorer-only rates (excluding unavailable verifiers/admission, never replacing the planned-denominator rates above):
- sb-none-1: 1/6, Wilson 95% 3.0–56.4%; 6 tasks invoked the model.
- sb-flat-1: 4/6, Wilson 95% 30.0–90.3%; 6 tasks invoked the model.
- sb-learned-1: 2/6, Wilson 95% 9.7–70.0%; 6 tasks invoked the model.
- slb-none-1: 2/5, Wilson 95% 11.8–76.9%; 5 tasks invoked the model.
- slb-flat-1: 3/5, Wilson 95% 23.1–88.2%; 5 tasks invoked the model.
- slb-learned-1: 0/5, Wilson 95% 0.0–43.4%; 5 tasks invoked the model.

ML-verifier admission uses the minimum of live free space and the frozen scratch cap in `resource-policy.json` (5,911,142,400 bytes). The NLP verifier declares 10 GiB. Later shared-disk recovery does not change this uniform resource profile; earlier raw errors label the effective allowance as shared free space.

Unavailable native cases (these are not solver failures):

| Case | Arms | Admission/setup reason |
| --- | --- | --- |
| sb/azure-bgp-oscillation-route-leak | none, flat, learned | RuntimeError: Whole primary task group unavailable before any arm dispatch: remaining lane allocation 10183s is below three pinned 3600s agent windows plus 240s verification each and 1200s setup/report reserve (12720s). Official verifier is unchanged; no primary model/scorer result is claimed. All three arms retain explicit unavailable records. |
| sb/video-silence-remover | none, flat, learned | RuntimeError: Whole primary task group unavailable before any arm dispatch: remaining lane allocation 10183s is below three pinned 3600s agent windows plus 240s verification each and 1200s setup/report reserve (12720s). Official verifier is unchanged; no primary model/scorer result is claimed. All three arms retain explicit unavailable records. |
| slb/nlp-paper-reproduction-3 | none, flat, learned | RuntimeError: Capacity unavailable before model dispatch: pinned verifier ML bootstrap, declared storage 10737418240 bytes, shared free 5911142400 bytes. Official verifier is unchanged and unrun. |

### SkillsBench

| Domain/category | No skills | Official flat | Product-learned methods |
| --- | --- | --- | --- |
| cybersecurity | 0/1 | 1/1 | 0/1 |
| finance-economics | 0/1 | 0/1 | 0/1 |
| industrial-physical-systems | 0/1 | 0/1 | 0/1 |
| mathematics-or-formal-reasoning | 0/1 | 1/1 | 1/1 |
| media-content-production | 0/1; 1 infrastructure | 0/1; 1 infrastructure | 0/1; 1 infrastructure |
| natural-science | 0/1 | 1/1 | 0/1 |
| office-white-collar | 1/1 | 1/1 | 1/1 |
| software-engineering | 0/1; 1 infrastructure | 0/1; 1 infrastructure | 0/1; 1 infrastructure |

### SkillLearnBench

| Domain/category | No skills | Official flat | Product-learned methods |
| --- | --- | --- | --- |
| Content & Creative | 1/1 | 1/1 | 0/1 |
| Data & Analytics | 0/1 | 1/1 | 0/1 |
| Information Retrieval | 0/1 | 1/1 | 0/1 |
| Productivity Tools | 0/1 | 0/1 | 0/1 |
| Software Engineering | 0/1; 1 infrastructure | 0/1; 1 infrastructure | 0/1; 1 infrastructure |
| Utilities & Other | 1/1 | 0/1 | 0/1 |

Each SkillsBench domain has one primary task per arm. Each SkillLearnBench row is one sampled family in a README category, not coverage of all 15 sub-domains. The manifest and per-task CSV identify the exact tasks.

## Learning and reuse

The real product learned 5 methods; 5 were approved and exported. Statuses: {'approved': 5}. Learning reached a quiet queue: True.

Learning job outcomes: consolidate/succeeded: 10; distill/succeeded: 5; learning-evidence/succeeded: 10.

- sb: 0 distinct learned methods observed opened in 0 held-out tasks; 0 read-tool openings in total.
- slb: 2 distinct learned methods observed opened in 2 held-out tasks; 2 read-tool openings in total.

Practice task records: 13; turn outcomes: {'canceled': 7, 'succeeded': 10, 'failed': 1, 'unknown': 1}. These are simulated attended user requests (`automated` omitted), not real-user approval. Practice paths were relocated into the product workspace, and practice outputs were not graded by official container verifiers. Failed/time-limited practice and failed learning jobs remain visible.

Scored trials use BenchFlow 0.6.3 + Pi ACP for SkillsBench, and the pinned SkillLearnBench runner + Pi CLI for SkillLearnBench. The learned library comes from product practice/distillation across both benchmark practice pools; its mounting and openings here are reference-agent behavior, not product ranking or capsule observer events. Observed openings require a successful read-tool call; shell reads are not counted. Catalog descriptions are visible before a body is opened, so zero observed reads does not prove zero method influence. This is a frozen practice-to-held-out transfer pilot, not the full continual curriculum, online adaptation or forgetting measurement.

## L7 diagnostic layers

Task outcomes above use the unchanged official deterministic verifiers. The following optional diagnostic measurements use pinned upstream prompts/parsers with **DeepSeek Flash, thinking off**, replacing the published GPT-5-mini judge. This is also the solver family, so diagnostic self-judging bias is possible. The transport facade and removal of thinking blocks from Pi traces are disclosed in `judges/config.json`; no judge feedback reaches learning or solving.

| Arm | Skill coverage | Executability (native scale) | Safety (native scale) | Trajectory key-point recall | Order (1–5) | Completion (1–5) | Judge errors |
| --- | --- | --- | --- | --- | --- | --- | --- |
| none | n/a (n=0) | n/a (n=0) | n/a (n=0) | 0.704 (n=5) | 3.800 (n=5) | 4.000 (n=5) | 1 |
| flat | 0.972 (n=6) | 1.500 (n=12) | 4.833 (n=12) | 0.827 (n=5) | 3.600 (n=5) | 4.750 (n=4) | 2 |
| learned | 0.009 (n=6) | 1.167 (n=30) | 4.867 (n=30) | 0.750 (n=5) | 4.000 (n=5) | 4.600 (n=5) | 1 |

Skill quality is evaluated once per sampled family/skill arm; executability/safety n counts method-family assessments, not distinct learned methods. Trajectory diagnostics use the first held-out variant per family, paired across arms. Means with different units are not combined into a new score. Missing/no-skill diagnostics are n/a, not zero quality. Oracle-trajectory alignment can penalize a valid alternative workflow, including success without invoking the oracle human skill; it does not override the task verifier.

## Cost, time and full-run scenario

Lane known-cost estimate: CNY 38.623; conservative peak-equivalent bound plus product reservations: CNY 67.377. This includes paid smokes, inference, product practice/learning and available diagnostics.

Primary task costs in the table are solver inference only. Paid adapter/permission calibration: CNY 2.112; smokes: CNY 0.183; diagnostic judges: CNY 26.214. Product practice/learning: CNY 6.061 (its learning subtotal is included, not added again). Shared engine embedding/reranking charges are not separately allocated; this is known model usage, not an isolated vendor invoice.

Shared provider balance: 1841.78 → 877.03. Other lanes were active; the balance delta is not this lane's spend. Start: 2026-11-11T05:34:08.000Z; report: 2026-11-11T13:48:18.069Z.

- sb: linear scenario for 87 instances × 3 arms: CNY 40.36 model spend at peak-equivalent pilot prices, 39.7 sequential lab hours at observed throughput (including baseline oracle setup where applicable).
- slb: linear scenario for 100 instances × 3 arms: CNY 87.09 model spend at peak-equivalent pilot prices, 34.1 sequential lab hours at observed throughput (including baseline oracle setup where applicable).

These are budget scenarios, not validated full-run quotes or extrapolated success scores. The fixed arm order, warmed build caches, reused oracle controls and shared lab load affect throughput. Unseen heavy/credentialed tasks, fresh full-set oracle builds, host rental, a complete official-judge evaluation and additional independent practice are not priced. A full SkillsBench learned-method submission needs external practice (the pilot practice tasks are part of its 87-task corpus); the SkillLearnBench first variants are learning inputs, so an entirely held-out extension has 80 remaining variants, distinct from a 100-instance published-protocol run.

## Comparability

The [SkillsBench paper](https://arxiv.org/abs/2602.12670) reports +16.6 percentage points averaged across 18 model/harness configurations. It is not an expected gain for this model. [Vals](https://www.vals.ai/benchmarks/skillsbench) reports DeepSeek V4.1 Flash with **OpenHands** at 69.80% (2026-10-29). [DeepSeek documents](https://api-docs.deepseek.com/quick_start/pricing/) `deepseek-flash` as V4.1-Flash-1017; this lane records the requested/returned alias, not an independent weight fingerprint. Pi, the data pin, the feasibility-conditioned sample, resource limits and the skill-generation protocol differ. Absolute leaderboard rank and full-set success cannot be inferred.

The product supplies learned skill bodies here, not the scored execution harness. The official self-generation view is a different generation protocol. SkillLearnBench uses a Sonnet 4.6 reference solver and GPT-5-mini judge; these DeepSeek measurements are not a reproduction of those published absolute scores. The optional official-pyramid arm would require additional paid trials and was omitted.

## Verification and artifacts

Data pins: SkillsBench `f860ecf02ef53412a030f8661c83d644b739ff01`; SkillLearnBench `726e1f79b96b0cb3d729d0e55a1c847e0b5353ae`. Selected files match the intake pin; verifier SHA256 maps are checked before/after every task. Upstream runner receipts, Python dependency freeze, exact prompts/outputs, official results and private account state stay on the lab. No runtime/provider secrets or raw account credentials belong in the committed report.

Runner checks: 11 Node tests and 19 Python tests (30 total), run on the lab; the official task/oracle outcomes are separate evidence. See the final delivery note for the latest check counts. Source, STATUS, run manifests and ledger rows are separately reviewable; no deployment or leaderboard submission occurred.

## Leaderboard submission requirements (five lines)

1. Freeze code/data/agent pins and the learning boundary; a product claim needs the actual control-plane/DSH task-container adapter, or an accepted, explicitly labelled reference-harness entry.
2. Run the complete required sets/repeats with unchanged official verifiers and retain every result, error and trajectory.
3. Disclose model, harness, skill sources, practice/test separation, generated methods, resource limits, tokens and spend.
4. Include all three SkillLearnBench layers with its required solver/judge, or obtain agreement to clearly labelled substitutions.
5. Package reproducible artifacts and confirm the current submission route/acceptance with maintainers; this pilot is not a submission.
