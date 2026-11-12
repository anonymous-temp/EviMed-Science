# Patient Matching V3 implementation and verification

**Superseded in part (2026-11-07):** the ranking policy "Qwen owns relevance order" and the multi-candidate Jev priority fallback were replaced by the measured policy `rrf-qwen-jev-v1` (Qwen3.7 rerank fused with Jev's per-candidate five-level fit), and discovery sends ranked terms again. Results and every leaderboard: [round 2](2026-11-07-vcr-matching-round2-results.md).

Status: engineering closeout. The owner stopped remaining TREC and then SIGIR/all leaderboard work on2026-11-05. No further paid evaluation will run. Owner budget: **CNY500 total across providers**, approved2026-11-05. Clinical reasoning is **DeepSeek V4.1 Flash only**. No Pro escalation, translated SIGIR, PR, main merge, package publication or production deployment is authorized by this execution.

The design authority is [V3](2026-11-05-vcr-matching-plugin-v3.md). Historical diagnosis and score definitions remain in [V1](2026-11-05-vcr-matching-next-phase.md); original score artifacts are unchanged.

## Implemented path

- Independent native DSH bundle, core contracts/projection and contained calculation worker under `OpenScience/packages/patient-matching-*`; host ABI `patient-matching.host.v1`.
- Nine native tools and a loadable professional skill. Managed children have a frozen Flash profile, original conversation identity, bounded evidence/calculation tools and cancellation. A tool result comes from saved source-bound clinical decisions.
- Authenticated production host gateway with pending native-call proof, exact arguments, parent/child binding, actor/source permissions and transactional erasure-aware results. Protocol intake preserves original text, spans and inclusion/exclusion/unclassified source kinds.
- Source-specific registry recall, separate Qwen3.7 1024-dimensional index, rank fusion and a single-request Qwen3.7 full-pool ranker. Every retrieval channel uses the same balanced source view. Jev1.14 is an optional typed priority resource, independent of clinical eligibility.
- Leased same-session continuation, cancellation and explicit resume epochs; cold-runtime admission is distinct from live tool proof. Existing matching pages, download routes and exports read the shared saved projection.
- Protected release catalogue, immutable readonly generations, safe-boundary activation/disable/uninstall/rollback, actual contained-worker inspection and exact artifact identities. Local candidate assembly does not publish or deploy it.
- Saved-native-result adapters to the existing official scorers, with source/profile bindings, original final order, missing-topic accounting and original-English SIGIR enforcement.

## Evidence and boundaries

| Evidence | Observed result | Boundary |
|---|---|---|
| [Native runtime](2026-11-05-vcr-matching-plugin-v3-assets/native-runtime-smoke.json), [native status](2026-11-05-vcr-matching-plugin-v3-assets/native-status-smoke.json) | Exact bundle installs offline on pinned DSH; nine actual tools, loadable skill, managed child, cancellation/disposal; disabled ordinary conversation works | Synthetic runtime compatibility; not a score |
| [Provider contracts](2026-11-05-vcr-matching-plugin-v3-assets/provider-inference-smoke.json) | Actual Qwen3.7 embedding1024/rerank, Jev1.14 typed priority and Flash inference | Public synthetic requests; provider contract qualification |
| [Historical 0.1.0 native clinical fixture](2026-11-05-vcr-matching-plugin-v3-assets/native-clinical-workflow.json) | One actual Flash child, three requests,2,687 output tokens; evidence reads and verified BMI20; PG/reply/page/Markdown/JSON readback agree | One public synthetic case; not clinical validation or customer acceptance |
| [Contained worker](2026-11-05-vcr-matching-plugin-v3-assets/contained-worker-runtime.json) | Actual immutable image, no network, readonly root, dropped capabilities, no new privileges; BMI20 and private Linux socket restart | Separate contained-compute proof; the real clinical reference uses the same canonical calculation library |
| Isolated PostgreSQL tests | Source revocation/withdrawal, actual actor report authorization, partial resume,5,000-pair sharding, old-schema vocabulary upgrade, immutable vector generations and operator budgets | Engineering behavior, not clinical accuracy |
| Official-score export tests | Original order and all requested topics retained; missing scorable TREC topic stays in denominator | Export/scorer wiring; no new benchmark result by itself |

The current unpublished native candidate is **0.1.1**, SHA256 `5dc7fdad212913b026ef31ce22af251681a275b11ad820b54f06da3569e13b96`; its pinned-kernel proofs are synthetic and made zero paid model calls. The historical 0.1.0 candidate, SHA256 `33fa64d754ac018816e80826f786b35def898062f7a16cfcd2486dbb38284d59`, owns the real single-case fixture, provider qualification and stopped campaign observations. Its [runtime](2026-11-05-vcr-matching-plugin-v3-assets/native-runtime-smoke-0.1.0.json), [status](2026-11-05-vcr-matching-plugin-v3-assets/native-status-smoke-0.1.0.json) and [release manifest](2026-11-05-vcr-matching-plugin-v3-assets/release-candidate-0.1.0.json) remain preserved separately. The [candidate manifest](2026-11-05-vcr-matching-plugin-v3-assets/release-candidate.json) binds package integrity, OCI manifest, host ABI, kernel seam and model/resource profiles. The operational build/install instructions are in `OpenScience/deploy/patient-matching/README.md`.

## Corrected failure classes

| Failure class | Implemented correction |
|---|---|
| Independent fit overwrites relevance or becomes eligibility | Qwen owns relevance order; clinical exclusions are an explicit projection group; priority never rewrites eligibility. Incoming/rerank/final orders remain separately inspectable |
| Source kind lost during protocol intake | Preserve raw protocol and section provenance; unsectioned source stays unclassified until semantic interpretation |
| Saved outputs retain now-forbidden clinical words | Recheck original judgment documents, snapshot fields and current actor grants; clear denied clinical contents while retaining permitted accounting |
| Task result uses the owner's authority for another reader | Patient-level authorization plus actual requesting actor; no owner fallback |
| Duplicate continuation, failed explicit resume, cold runtime or page-only origin | Durable idempotent dispatch identity, explicit resume epoch, no-progress stop, original-session routing and cold selected-generation admission |
| Long KB sources or generated pages treated as evidence | Whole-source bounded passage selection and verified cursors; generated wiki pages are indexes and controlled datasets use patient-data tools |
| Mixed embedding generations or repeated whole-index work | Endpoint/model/dimension/source-bound index; immutable ready generation; sparse byte-offset resource loading, batch-local integrity checks and atomic generation counters |
| Incomplete billing or a cancelled task starts new paid work | Kernel-purpose account caps, per-request destination/source reauthorization, query-per-document rerank reservation, cancellation propagation and a shared campaign ceiling |

## Frozen campaign scope and owner-requested stop

The campaign uses one exact native bundle, real managed Flash children, the production matching host/core, source-specific frozen registry adapters, actual ranking providers and persisted output. The reference host controls the benchmark inputs and original sessions; it is not deployed SaaS UI acceptance. No relevance label is available to a clinical child.

- SIGIR:59 upstream queries,58 nonempty scored topics,3,835 judged candidates. The zero-candidate query remains an explicit dataset exclusion. The requested protocol requires every judged candidate to pass through the main ranker and clinical path, without100-item truncation. Execution stopped before all pairs were processed; the actual completed/pending/missing counts are recorded below.
- TREC:75/50/40 original topics for2021/2022/2023,165 requested in total. Three2023 topics are unscorable under official qrels, leaving162 official scorable topics. The historical split has135 requested test topics and133 scorable test topics; both all-topic and historical-comparable results must be presented.
- Full trial snapshots:375,580 records shared by2021/2022 and451,538 records for2023,827,118 snapshot records. The dense index uses a fixed bounded source-literal projection; full original source records and clinical eligibility text remain available. This is recorded representation coverage, not complete embedding of every criterion.
- All costs share the owner-approved CNY500 ceiling. Known saved vectors/decisions are reused. Ambiguous external charges retain a conservative bound. Completion, source failures, pending decisions and cost uncertainty remain visible.

### Actual operational repairs during the campaign

The first index attempt stopped on HTTP429 after780 saved vectors. Its39 measured calls and three interrupted/uncertain siblings were retained. A single fixed request/token pacing policy was reviewed before resuming the same generation; no concurrency/model grid was run.

The first clinical phase exposed actual output-contract and capacity faults before any official score was claimed:64-clause segments exhausted the16k output allowance, and the native schema conversion removed numeric bounds without making the0–1 priority scale visible. Seven validated clinical decisions survived; raw completed/truncated responses,41 calls and CNY2.11213988 clinical usage were archived with the original source bytes.

The targeted repair makes the priority range visible in the native schema description, validates auxiliary priority bounds per decision so a malformed sibling cannot discard valid clinical output, and partitions multi-pair work at24 source clauses. It does not clamp scores, change clinical labels, omit requested pairs or switch models. Resume preserves original sessions, saved main-ranker orders and validated decisions, with explicit source-phase provenance. The owner subsequently stopped the campaign. No official result was produced; later engineering repairs do not relabel these observations.

## Engineering gates

The package suite passed with the host's existing exact Corepack cache and canonical short temporary directory: 2,469 passed and 15 environment-dependent cases skipped, with zero failures. The final focused offline run passed 88 cases and skipped 35 database cases; actual isolated PostgreSQL checks separately qualified host persistence, authorization and failure isolation, including all 11 failure-isolation counterexamples. Canonical server/domain/port lint and typechecking, extended matching package/deploy/evaluation lint, frozen dependency installation and code reviews passed. Exact boundaries are in [engineering-verification.json](2026-11-05-vcr-matching-plugin-v3-assets/engineering-verification.json).

Earlier full local server testing contains macOS/Linux-specific failures and source assertions that were corrected afterward; it is not reported as entirely green. Source-dependent capability/tool metadata and the prior web-CI guidance snapshot were regenerated. The new pushed revision's full Linux CI is a separate gate.

No additional scoring is scheduled. The 20-candidate two-minute P50 target is not established by the one-case fixture. Publication, production deployment, hosted customer journey acceptance and clinical validation retain their own evidence boundaries.


## Latest owner direction: stop leaderboard execution

The owner subsequently stopped all remaining TREC, then SIGIR/other leaderboard execution. TREC closeout is recorded in [its result summary](2026-11-05-vcr-matching-trec-closeout.md). Both native clinical and index processes were stopped, and pending provider bookkeeping is retained as settled or conservatively uncertain; no new official score is produced. SIGIR/incident/C/F preparation and partial work are not converted into zero scores or passed-case claims.

The remaining authorized work is functional code repair, offline/engineering verification, documentation and commit/push. Deployment, main integration, package publication and new paid evaluation remain unperformed. The final SIGIR/global budget closeout is in [the stop receipt](2026-11-05-vcr-matching-validation-user-stop.md); current exact artifact checks are attached to the candidate manifest.


### Final paid-execution stop accounting

The owner then stopped SIGIR as well. The partial clinical execution retained686 current valid decisions of3,835 requested pairs;1,470 prepared/pending and1,679 missing pairs remain separately classified. Three of58 topics completed;32 started and31 produced saved projections. Thirty-two complete main-ranker orders were cached. This is partial engineering evidence, not a new official SIGIR score.

All provider/runtime processes and automatic continuation were stopped. The ledger closed with no reserved rows: CNY53.39247588 settled reference cost plus CNY15.151263 conservatively uncertain exposure, total CNY68.54373888 against the500 ceiling. No uncertain amount was guessed to be free. No additional model calls are part of engineering closeout.


## Final functional closeout: candidate 0.1.1

Malformed output and missing validated child decisions now produce a durable, empty **runtime failure** checkpoint. They are never an eligible/ineligible judgment. Each model row is validated against the canonical execution pair and its evidence bundle inside row isolation; one invalid row cannot discard a valid sibling, including different patients matched to the same protocol. The checkpoint remains subject to the original pending call, actor/source grants, selected generation, frozen profile and continuation epoch. Cancellation and source withdrawal do not create fabricated clinical failures.

Within one epoch, completed and failed attempts let the queue advance to remaining pairs. Explicit continue starts a new epoch: current completed decisions are reused, failed/stale work becomes retryable and historical result IDs retain the earlier failure. Failed rows use the existing erasure-aware store and shared result projection. Schema/projection versions remain 1; the new reader accepts previous model-produced records, but old 0.1.0 readers are not claimed to understand new runtime-produced failures. Neither candidate has been published or installed in production.

The native discovery tool and host now reject blank or over-200-character queries before registry/model work. Patient context remains in the bound task. Native output descriptions make formal criterion identity, actual computation receipts, the 0–1 auxiliary priority scale and bounded output explicit; core validation still treats model rows independently.

The paid-run finalizer now aborts and awaits owned provider processes, pending HTTP handlers and billing settlement before closing PostgreSQL. Owner and HTTP-disconnect cancellation propagate through the actual gateway. Stop-time costs remain conservatively uncertain where completed external responses were unavailable.

The release builder derives each version from the selected source package, verifies the packed package identity, and binds only matching-digest runtime/clinical receipts. The current manifest contains package/runtime proofs for 0.1.1; the old 0.1.0 clinical fixture is not promoted into current clinical qualification. The contained calculator worker remains 0.1.0 with its existing exact image and canonical calculator identity.

## Remaining product evidence and operator actions

| Item | Current boundary |
|---|---|
| TREC / English SIGIR / incident / C / F paid execution | Owner-skipped; no automatic resume, translated SIGIR or new score |
| Full trial index | Partial generation retained and not served as ready; no fresh full-corpus recall/effectiveness claim |
| Current 0.1.1 clinical accuracy, ranking level and latency | Unmeasured; engineering/synthetic qualification does not establish these |
| Hosted UI customer journey and clinical validation | Not performed in this isolated reference host |
| Publication, hosted activation, main integration, deployment | Not performed; commit/push is the authorized delivery boundary |
| Future worker resource replacement | Operator prepares compatible contained image before activating a release that changes it; no model-managed shared worker upgrade |

These are separate evidence or release actions. None requires more experiments during this owner-requested engineering closeout.
