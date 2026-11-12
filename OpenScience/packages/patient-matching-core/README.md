# Patient matching core

Independent Node ESM package with no runtime or workspace dependencies. Run `npm test`
or `node --test test/*.test.mjs`; `npm pack` produces a self-contained package.
No provider transport, clinical language rules, model loop or metric scorer lives here.

`index.mjs` exports executable validators for the v1 task, context, trial, evidence,
assessment, computation, decision and result contracts. Validators return the original
value or throw `MatchingContractError` with `code` and `path`. Code verifies types,
identity and literal source addressing; the native clinical model owns semantic judgments.

The host ABI is `patient-matching.host.v1`. `HOST_PORT_METHODS` is its operation map.
`bindHostInvocation(host, invocation)` resolves the scope through `IdentityPort`.
`createHostClient(host, scope)` binds an already verified scope. Every `call(port,
operation, input)` authorizes again and passes `{scope, port, operation, input}`.
Authorization must return `{allowed: true, scope}`. Operations return `{status,
summary, data, artifacts, nextAction?}`. A response may explicitly be pending,
partial, failed or unsupported. Adapters enforce current grants and source revocation;
an opaque source, patient or job ID never grants permission. The optional bounded
cache is an optimization after authorization, not a patient store or an access cache.

The release manifest is closed. It binds exact package SRI, worker image digest,
kernel/seam, host ABI, schemas, model/code profiles and compatible index dimensions.
Only DeepSeek Flash is accepted for reasoning; Qwen3.7 serves embedding/rerank and
Jev 1.14 is optional. Empty verification receipts mean no verification claimed.
`validateReleaseManifest` checks declared structure; it does not fetch or authenticate
artifacts. The host preparation service must verify their actual bytes and admission.

`MatchingTask` supplies `schemaVersion: '1'`, `taskId`, `direction`, `objective`,
`scope`, `pluginGeneration`, `sources`, `selectedPairs` and bounded `budgets`.
Scope has tenant, project, actor and root conversation IDs. Sources have `sourceId`,
`revision`, SHA-256 `digest` and `kind`. Pairs have `subjectKey`, `trialId` and
optional `armId`; `pairIdentity` preserves that exact tuple without name matching.

`PairDecision` supplies schema/revision, pair/scope, `state`, explicit
`clinicalEligibility`, `recommendation: {priority, rationale}`, typed `criteria`,
`sourceRefs`, `profileDigest`, `producer: {kind: 'model', modelProfileDigest,
executionId}`, `evidenceBundleId`, `unresolvedFacts` and `assumptions`.
Clinical eligibility is eligible, ineligible, uncertain or not-assessed. Priority is
null or in [0,1]; no priority threshold implies eligibility. Criterion decisions have
`criterionId`, inclusion/exclusion `kind`, `verdict`, `basis`, `evidenceIds`,
`assumptions` and `reason`. Pass trusted trial/evidence contracts to
`validatePairDecision` to verify criterion/arm and evidence/subject/source mapping.
For a completed decision, a supplied trial profile's exact source and every source
in a supplied evidence bundle must be bound in `sourceRefs`; the bundle denotes
the frozen evidence context consumed by that decision, not an unused search pool.
An eligible label that contradicts the model's own semantic rationale is a clinical
review finding; this package does not reinterpret that rationale.

`projectMatchingResult({task, resultId, revision, decisions, profileDigest,
currentSources?, ranking?, stageOrders?, trialProfiles?, evidenceBundles?, reportRefs?, affectedPairs?})`
accounts for every selected pair. Missing decisions remain pending. Changed source
or interpretation identities retain the historical verdict under a stale state and
do not count as current eligibility. The task must contain the frozen sources for
the selected scope, not a tenant-wide source inventory. Default ranking keeps
current non-excluded decisions first, unfinished work next and explicit ineligible
decisions last, preserving task order within these groups. `ranking: {order:
'priority'}` explicitly selects stable descending priority within each group.
It never changes a clinical label. Host-supplied `affectedPairs` can limit new-source
invalidation by known ownership; otherwise all pairs are conservatively marked stale
and `invalidationPrecision` states that limitation.
`finalOrder` is the exact ordered pair-identity list. `reportInputFromResult` and
`metricInputFromResults` read the saved projection; neither reassesses patients.
Saved rows retain decision/revision, producer, profile and evidence-bundle identities.
The result retains the task's `frozenSources` and host-known `affectedPairs` (null
for unknown ownership). Writer and reader derive refresh reasons from that same
context, so removing a saved new-source warning cannot make a stale result current.
Read validation enforces those bindings, refresh reasons, work states and recomputed
counts before reports or evaluators consume a projection. A pending row without a
decision cannot be promoted by editing its clinical label or aggregate counts.

`planReassessment` walks a scoped dependency DAG and returns invalidated IDs and
affected pairs without deleting historical results. An incomplete ledger falls back
to whole-pair reassessment. Uncovered/new sources require caller-supplied affected
pairs; the function refuses to invent their patient association. Evidence spans use
UTF-16 offsets in the preserved decoded source text. Byte documents need the host's
separately preserved, digest-bound text rendition before passage validation.

`METRIC_PROFILES` records the distinct TrialGPT, TREC, NIH, n2c2 and product routes.
A concrete metric profile must pin its scorer, corpus, input manifest, mapping policy
and aggregation. Official score calculation remains the external adapter's work.
