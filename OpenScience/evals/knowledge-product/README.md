# Product knowledge evaluation

The 90 independent question groups (revision 2, before the first main quality freeze) are 30 general, 30 medical-research and 30 lifecycle/access. The 24 genuine PubMed abstracts remain unchanged. Medical-research questions now include 18 source-grounded questions, nine authored personal working-method questions and three absent-information controls; the separate original knowledge-pages C27 remains unchanged. General documents include DOCX, PDF, CSV, code and original-only ZIP material, alongside authored personal reporting conventions. No model responses are benchmark truth.

Each substrate covers small (24 documents), medium (64) and large (256) projects. Knowledge-only tasks use external source evidence. Memory-only tasks use only genuinely authored standing user facts; their project files are irrelevant distractors, with no relevant document copies or knowledge-source routes. Combined tasks require both external facts and a previously saved personal reporting convention. Only necessary user-authored statements are seeded through native remember; documents, abstracts and warehouse distractors never are. This is project-document-size coverage, not a native-memory-volume scale test.

Native seed completion requires every required personal value represented in actual native-URI-backed memory before learning is paused and recall stays enabled. Frozen inventory/settings hashes are checked before and after questions. Real native tool results or exactly identified OpenViking producer context must expose the required values. Memory-only answers use the existing semantic key-point judge, including multilingual paraphrases; combined answers have separate semantic knowledge and personal-criterion judgements through the same judge and aggregate budget. Their score is the minimum. Original-only and malicious-source controls apply to the knowledge inputs and still require actual byte exposure. Missing exposure or provenance stays inconclusive. No legacy-memory or offline-retriever substitution is admitted.

The fixed primary rule is unchanged: paired bootstrap over question means, 10,000 seeded draws, general and medical independently require the lower 95% bound above minus 0.02. Repetitions are averaged within question. There are 26 general and 27 medical answerable questions; four general and three medical unanswerables have separate abstention denominators. Substrate, size, language and format coverage is reported separately. All lifecycle questions require complete native evidence with zero violations. Missing data stays inconclusive.

Run `node --test evals/knowledge-product/test/*.test.mjs`. `run.mjs` without `--execute` records a zero-spend preflight. Both collectors fail closed before provisioning or dispatch when live aggregate budget wiring cannot be proved.

## Shared budget before any paid work

`shared_budget.mjs` and `budget_proxy.mjs` provide an evaluation-only coordinator, not a public product API. One durable ledger reserves worst-case input/output charges and settles actual usage across baseline, candidate, native OpenViking, C and any judge. The aggregate cap is CNY 50. Model admission uses the product's canonical price table, rejects underpricing/unknown models and missing output bounds, and retains reservations on missing/uncertain usage. An existing ledger cannot silently restart at zero. Text streaming requires the provider's final usage record; the proxy buffers the stream until accounting is complete. Unknown provider endpoints and unpriced rerank/multimodal paths fail before forwarding.

Start one process with `KNOWLEDGE_BUDGET_CONFIG=/private/config.json node evals/knowledge-product/budget_serve.mjs`. The private config has `models` (canonical model IDs with input/output CNY per million and maxOutput), and `providers` (each admitted name maps to a fixed URL, provider keyFile and optional exact responseModel). For the pinned native embedding model use kind=embedding, the canonical embedding price and maxOutput=0. The script prints the private manifest location, never a provider key or token. Keep the same coordinator for the whole benchmark and C; never start a new budget to continue exhausted work.

Start each real-kernel arm through `budgeted_harness.mjs`, which installs the process-wide provider interceptor before importing the existing general-task harness. `KNOWLEDGE_BUDGET_WIRING` is a private JSON with scope=baseline or candidate, coordinatorUrl, tokenFile and providerOrigins mapping actual external provider origins to admitted provider names. The existing harness's OS/TREE_DIR/LIVE_DATABASE_URL/etc. remain its inputs.

The eval-only `rerank_budget.mjs` admits the pinned `qwen3-rerank` compatible API separately from embeddings. Its Beijing reference input rate is CNY 0.5 per million tokens, with no generated output, verified on 2026-10-23 against [the official model price](https://help.aliyun.com/en/model-studio/qwen3-rerank). This reference estimate excludes promotions and is not an invoice. Configure the model as `{kind:"rerank",input:0.5,output:0,maxOutput:0}` and its fixed provider as `{kind:"rerank",url:"https://dashscope.aliyuncs.com/compatible-api/v1/reranks",keyFile:"/private/dashscope-key",responseModel:"qwen3-rerank"}`. The documented Beijing workspace endpoint is also admitted; international endpoints cannot use this regional rate. On an origin shared with embeddings, set the interceptor's exact `providerRoutes` entry `"https://dashscope.aliyuncs.com/compatible-api/v1/reranks":"<rerank-provider-name>"` while retaining the embedding mapping in providerOrigins. Unknown rerank origins and model/provider-kind mismatches fail before forwarding.

The adapter preserves the actual `MemoryRerank` product envelope: query, string documents, top_n and optional instruct. It bounds 100 documents, 32 KiB per query/document, 8 KiB instruction, the coordinator's existing 2 MB request ceiling and a 256 KiB response ceiling; generated text, streaming, multimodal inputs and returned original documents are refused. [Official billing](https://help.aliyun.com/en/model-studio/text-rerank-api) counts query tokens once per document plus document tokens. Reservation therefore repeats query bytes, instruction bytes and conservative overhead for every document. Settlement uses only a positive integer usage.total_tokens. The configured/requested model and exact Beijing endpoint are bound before dispatch; an explicitly returned model must match. The compatible response may omit model, so absence is recorded as a limitation of provider identity evidence and never filled with a fabricated echo. Missing/invalid usage, provider errors, over-bound usage or responses retain the reservation and halt all arms. These are conservative accounting bounds, not assertions that a byte count equals a tokenizer count or that every bounded request satisfies the provider's context window. Tests call a synthetic unit-only provider, including the real product envelope, and never count those replies as answer-quality evidence.

Native OpenViking's dense embedding API base must point to the same coordinator's `/scope/openviking/<provider>/v1` path and use the coordinator token; no real provider key is placed in the native engine. Its VLM and bot model URLs must point at the coordinator or a live instrumented loopback control plane. Both collector configs require the actual nativeConfigFile and nativeProcessId. The verifier checks the running OpenViking command's config path, the actual configuration, live instrumented gateway listener ownership, nonce-bound coordinator identity, durable process-start identity/liveness, provider-boundary proofs and live committed/reserved accounting. Idle workers do not expire after sixty seconds; a dead or reused PID is refused. JSON assertions such as budget.enforced are not accepted as proof.

The coordinator initially refuses all provider calls after recording their dry boundary path, charging nothing. Drive actual dry model-boundary probes through both app processes and the native engine. Only once all required paths are observed may the collectors arm the same coordinator. Missing/unpriced native embedding/reranking paths or an engine/container whose running config cannot be verified keep collection blocked. No live paid requests have been made in this work. Operator compatibility preflight keeps its messages/tools and reasoning effort unchanged, while its private fetch adapter explicitly bounds max_tokens at 4096. The coordinator accepts only the [documented finite reasoning-effort values](https://api-docs.deepseek.com/guides/thinking_mode/) and still refuses missing or excessive output limits.

## Product collection

Set `KNOWLEDGE_EVAL_BINDINGS` to a private JSON with top-level `sharedBudget` and baseline/candidate objects. Each arm needs base, dataDir, runtimeEvidence (revision/dshVersion/openVikingVersion/model) and the same sharedBudgetId. sharedBudget contains coordinatorUrl, tokenFile, sharedBudgetId, nativeConfigFile, nativeProcessId and instrumentedGatewayOrigins. The actual arm base URL must resolve to a loopback listener owned by that exact instrumented arm PID on the same coordinator. C must bind the candidate listener equivalently. This is checked before provisioning and dispatch, not inferred from a separate gateway URL. There are no per-question source IDs or HTTP scenarios to prepare manually.

`run.mjs --execute` registers fresh owned accounts/projects, automatically creates nine material/substrate contexts under separate fresh accounts (knowledge-only recall/learning paused to prevent memory contamination), uploads frozen sources and distractors, seeds native memory, executes the lifecycle adapters and dispatches the unchanged 60 general/medical prompts through the actual DSH route in both arms with three repetitions (360 DSH cells). Private session cookies live only in a temporary mode-0700 directory with mode-0600 files. Cleanup uses exact owned-account receipts through the product deletion API; it never clears a shared database. The live budget gate is checked before source/memory setup and each dispatch.

When both full runtime images do not fit on the evaluation host, use `run.mjs --execute --arm baseline`, then `--arm candidate` with the exact same KNOWLEDGE_EVAL_OUT and private bindings file. Both web listeners and native provider wiring remain mandatory on the same live CNY 50 coordinator throughout; only the selected arm requires full `/api/ready` and its staged real Docker runtime image. The inactive arm is explicitly not executed, with no claimed runtime readiness or substitute answers. Both planned runtimeImageId values must be immutable image IDs in runtimeEvidence before baseline begins; registry image configuration metadata can establish the candidate ID before its layers are pulled. The active image is verified against the actual instrumented listener process's runtime-image configuration and dataDir, then Docker's actual image ID/revision/DSH labels, before collection and each factual dispatch. An installed candidate image cannot certify a listener still configured for the baseline runtime.

Each arm collects 180 factual and 90 lifecycle cells under unchanged questions/repetitions; it freezes native memory before factual repetition. A durable execution manifest binds both planned configurations, frozen benchmark hash and shared budget identity. After collection, arm-specific raw transcripts, lifecycle evidence, failed-cell receipts, automatic observations and the actual runtime identity are sealed with sorted file hashes. Candidate starts only after baseline is sealed; its append cannot change baseline files or baseline rows in the shared review output. Duplicate arms, changed configurations, output tampering, concurrent collectors and an interrupted unsealed arm are refused before fixture provisioning or dispatch. This supports the explicit baseline-to-candidate boundary; it does not silently retry/reprice partially executed cells. Partial and failed cells remain inconclusive, measured lifecycle violations remain violations, and paired confidence intervals remain incomplete until both real arms exist. Resource/image cleanup and production changes remain operator actions outside the harness.

Collected evidence binds case, arm, repetition, logical identities, actual run ID, model, context, project size and full native transcript. `report.mjs` rejects reuse of one run as independent repetitions. A tool name alone is insufficient: knowledge retrieval must complete without error and return useful content, or the product's small-library result must be followed by a successful original-file read. Empty results qualify an unanswerable control only with a separately ready nonempty inventory. Memory contexts require successful useful native OpenViking recall, and combined contexts require both knowledge and memory evidence.

Collection automatically runs the unchanged knowledge-pages key-point judge through the same coordinator, after reference-answer and empty-answer sanity checks. It emits reviewed-observations.jsonl and summary.json without per-case operator configuration. Ordinary cell failures get partial/failure receipts and independent cells continue; budget/auth/identity failures stop collection and preserve the partial results with an explicit execution status. A timed-out run must reach a confirmed terminal state after cancellation before another cell starts; a successful cancel response alone is insufficient. Unconfirmed cancellation stops collection and preserves its response and last observed status. Request deadlines bound collector waiting, while checked account cleanup separately stops its owned runtimes. Judge-only resume uses `node evals/knowledge-product/automatic_judge.mjs <results-directory> <private-collector-config>` under the same budget.

Generated observation rows contain caseId, arm, repetition, exact prompt, actor, project, score, citedSources (frozen original IDs resolved through the saved sourceMap), staleSources, abstained, violations and evidence={runId,transcript,provider}. transcript points to the collected JSON evidence file. Apply covered=1/partial=0.5/absent-or-contradicted=0 per preserved key point, then average. Record review rationale. For an independent report rebuild run `node evals/knowledge-product/report.mjs /private/run/reviewed-observations.jsonl`.

## Execution evidence and limits

`lifecycle_local.mjs` runs the real authenticated product HTTP boundary and real PostgreSQL against an owned local database named evimed_test_knowledge_evaluation_<suffix>. Its mock kernel is used only for source/library/session HTTP checks; it supplies no model answers or fake embeddings. All 30 adapters were exercised: 23 HTTP checks passed and seven remain blocked on native memory/compiled content/capsule/expiry semantics. These receipts carry qualityEligible=false and never satisfy the full native lifecycle acceptance denominator. No DSH answer-quality result exists; no quality gate has passed.

`prepare_c.mjs` creates one fresh topic project for each topic × repetition, uploads genuine abstracts, asks the production KnowledgePageService to run official OpenViking llm-wiki, waits for a newly completed round, and exports actual wiki pages. Only dynamic source IDs are normalized back to frozen original IDs; prose and quotations remain unchanged, and original/export hashes are recorded. It requires the same sharedBudget object and sharedBudgetId as the main collector. Set KNOWLEDGE_C_CONFIG to the private product base/dataDir/runtimeEvidence/sharedBudget config and run with --execute. The current native engine is unavailable, so C remains blocked with zero trees and zero paid calls.

Historical B records, original C thresholds and their limitations are unchanged. This product benchmark never calls the historical lexical stand-in the product retriever.

The PDF and original-only ZIP were uploaded and downloaded through the real local product HTTP routes with byte-for-byte SHA256 identity; the PDF also opens in pypdf and the ZIP contains its genuine policy.txt original. This validates storage/format integrity only. The local HTTP exercise does not run the external parser or a real DSH answer. Rebuild authored office inputs with build_fixtures.mjs, then run build_original_fixtures.py for deterministic PDF/ZIP material; medical source bytes and the 90 question groups are preserved.

Native lifecycle adapters now execute the seven engine-dependent scenarios when their actual APIs and runtime are available: official compiled-page deletion/revocation, native memory isolation/deletion/recall, shared-source recall revocation, signed capsule import without source grants, and expiry of an actual AgentMemory credential. Expiry advances only the owned test-key row in a database whose name starts evimed_test_knowledge_evaluation_; the arm must supply its private databaseBindingsFile. API minimum TTL is one day, so the controlled timestamp fixture is explicit. Exact restore reuploads the downloaded original bytes at the same logical path and requires the same source ID/hash plus a newer generation. A fully completed kernel run can set qualityEligible=true; mock HTTP remains false. Raw native probe transcripts are retained in the result evidence directory, including failures. All probe dispatches are automated:true; no product admission policy is relaxed.

Pinned DSH Messages calls need a separate trusted provider entry with `protocol:"messages"`,
`url:"https://api.deepseek.com/anthropic/v1/messages"`, a private `keyFile`, and the expected
`responseModel`. Keep the Chat entry for compatibility probes. Configure the interceptor's
exact `providerRoutes["https://api.deepseek.com/anthropic/v1/messages"]` as
`{provider:"<messages-provider-name>",protocol:"messages"}`. Messages calls never fall back
to a Chat mapping. The proxy preserves the structured request and uses `x-api-key` plus
`anthropic-version: 2023-06-01`. A streaming receipt requires start input usage, delta
output usage, the expected model identity and `message_stop`; incomplete receipts retain
the full reservation and halt further admission.

Coordinator recovery is explicit: `createBudgetProxy({resumeCheckpoint,
historicalConfigurationSha256, ...})` replays the existing ledger through
`resumeSharedBudget`. The historical hash is the original attested budget configuration,
not a replacement routing hash. The operator must hold the lifetime lock and verify the
old PID/start identity before invoking recovery. The resumed proxy starts unarmed with
no collector wiring; admission requires fresh proofs and arming. Omitting the checkpoint
keeps new-ledger behavior and never resets an existing ledger.

The fetch preload accepts an optional operator-owned `nativeSessionOrigins` list
(default `[]`). Entries must be canonical literal loopback origins (`127.0.0.1`
or `[::1]`, with HTTP or HTTPS). Only `POST
/api/v1/sessions/<bounded-session-id>/messages` without a query or fragment passes
through at those origins with headers, body and signal preserved. Redirects are
forced to `error` so a native endpoint cannot redirect outside accounting. This is OpenViking session ingestion, not a
model request; it neither reserves budget nor grants access to `/v1/messages` or
other model paths. Invalid configuration fails before the boundary probe. Keep
this list in the protected per-process wiring; the coordinator ledger and its
identity do not change.

### Main benchmark preparation revision 2 (before its first quality freeze)

Version 1's unexecuted preparation was invalid: it sent source documents, medical abstracts and
warehouse distractors through native `remember`, although the product's memory templates explicitly
exclude document text and conclusions. It also asked memory-only trial-fact questions and allowed
combined questions to be answered without personal context. Its exact bytes and both file/semantic
benchmark hashes are retained under `superseded/`; it produced no main quality result.

Version 2 retains 90 unique questions, 30 general / 30 medical-research / 30 lifecycle,
three repetitions and the same aggregate CNY50 coordinator. Original knowledge-pages C27 inputs,
prompts, judge and thresholds are unchanged. The 17 memory-only questions now ask authored standing
work/reporting preferences, including medical-research working methods rather than trial outcomes.
The 21 combined questions retain their external source contract and additionally require the saved
heading for a named report series. Their knowledge and memory components use separate calls to the same semantic key-point judge and are reported separately;
the combined score is their minimum, so either missing component prevents a complete answer.

Only the 38 necessary authored user statements per arm are seeded. Documents and distractors are
never native memory seeds. Each of the nine projects still contains 24, 64 or 256 documents;
memory-only projects contain **only irrelevant workspace documents**, with no relevant original or
knowledge source. This is project-document-size coverage, not a claim about 256 native memory records.
Current planned preparation per arm is 1,032 uploads, 687 knowledge sources and 38 native seed commits
(2,064 / 1,374 / 76 across both arms), plus the existing lifecycle work and answer turns. Main factual judgement now requires 243 calls per arm (180 base judgements plus 63 separate combined-memory judgements), 486 across both arms, plus the existing judge sanity checks, all under the same CNY50 coordinator.
The zero-spend preflight records these counts; it does not predict model-call fan-out or certify cost.

Freeze now requires every necessary authored seed's grounded values in actual native-URI-backed
memory, allowing merged files and declared equivalent phrasing. The receipt preserves the original
user statement, matched native URI and required values. An unrelated record cannot qualify a seed.
Collection retains real native search/read output or producer-owned OpenViking profile context;
the required values must be exposed there and linked to the frozen inventory. Assistant text is not
native context. Memory-only scoring requires this native evidence and does not manufacture document
citations. No paid run should start until this revised manifest and all runtime identities are frozen.
