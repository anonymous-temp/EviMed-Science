# A — Code claims in the 2026-10-06 drafts, checked against the repository

Scope: `docs/superpowers/plans/2026-10-06-regularized-research-evolution.md` (§3, §5, §8, §9) and `…/2026-10-06-open-ended-research-evolution.md` (§3, §13, §14).

- **R** = `f394c3b33` (head of `codex/release-20261004`, "Release candidate 20 … the evidence flywheel"). Authoritative.
- **E** = `c1f02c3cc` (what the drafts inspected). E is an ancestor of R; 322 commits lie between them, 46 of which touch `apps/server/src/evolution*` / `packages/domain/src/evolution*`.
- Paths are relative to `OpenScience/`. Line numbers are at R unless marked E. Verdicts: **holds**, **partly**, **wrong**, **fixed-at-R** (true at E, not at R).
- Read-only: `git show/grep/diff/log` only. The longer working notes are in `/tmp/rsi-review/A-code-claims.long.md`.

## Claims

### 1. Hidden-case feedback steers repair — **holds** (form changed)
- `apps/server/src/evolutionBuild.mjs:46`: `failedCaseIds:(evaluation.failedCaseIds??[]).map(id=>\`case-${sha(\`${evaluation.evaluatorHash??''}:${String(id)}\`).slice(0,16)}\`)` plus closed `issueCodes`. The comment at `:44` says the token "is stable for one frozen definition, so repeated failures can still be told apart".
- At E (`:43`) the ids went back raw (`.map(String)`), even though the comment said "opaque". Some ids named the paper (`darth-time-dependent`). This was fixed in commit `87dfd4146`.
- The loop: `evolutionComposition.mjs:330` stores `feedback` on the dossier. `:332` enqueues `repair:${dossier.id}:${attempt + 1}`. The next brief carries `previousFeedback: card.feedback ?? null` (`:291`). Up to `evolutionMaxBuildAttempts` = 3 (`config.mjs:2652`) attempts run before a decision card is raised (`:261–263`).
- New at R (`b2178499c`): behavioural checks run on inputs seeded by `[evaluatorHash, candidate.files, purpose]` (`evolutionCandidateEvaluator.mjs:315`), so derived inputs change every round. `reserve: true` cases are skipped by ordinary evaluations (`:255`). The published hidden cases are still re-run every round, and there is no feedback-use ledger or fresh-confirmation split (searched for `feedback.?use|queried|fresh.?confirm`: nothing found).
- Redesign: the gap is real, and query accounting plus a fresh confirmation step are still needed. Opaque tokens and per-round reseeding already exist.

### 2. Sudden-perfect review re-runs the same frozen cases — **fixed-at-R**
- At E, `candidateSuddenPerfectReview.mjs:60` `const replayed = await replay();` re-ran the same cases and called the result `"sudden-perfect-independent-review"`.
- At R, `:35–42` says it "used to replay the evaluation it was reviewing … `replay` now … executes only held-out material", meaning reserved cases plus behavioural checks under the review's own seed. `:84` `const performed = heldOut.reservedCases > 0 || heldOut.freshCases >= BEHAVIOUR_LIMITS.freshPerCase;`. If neither is available the result is `"not-performed"` / `passed:null`, and the candidate is not promoted (`:91`; `evolutionCandidateEvaluator.mjs:218–219`).
- Redesign: this gap row is out of date. What remains is coverage: reserved cases exist only where a definition marks them, and `freshPerCase: 3` (`evals/paper-gold/behavioural.mjs:30`).

### 3. Harm monitoring restarts epochs with a per-test alpha — **fixed-at-R** for the restart; per-revision alpha remains
- At E, `evolutionMaintenance.mjs:81–82` opened a new epoch once `epoch.state !== 'watching' || … >= METHOD_HARM_TEST.maxRuns`, and any `harm` retired the tool (`:91`).
- At R, `:13–15` reads: "every concluded test was followed by a fresh one ("epochs") … retired 33% of the time by 100 runs and 87% by 500". `:23` reads: "one test per revision, at most 40 trials. Once it reads `clear` or `harm` it is over". `:111` admits one trial per account: `!trials.some(trial => trial.accountKey === observation.accountKey)`. `:268` turns `harm` into a `tool-retire` review that carries `falseAlarmAtBackgroundRate` and `association: 'not-cause'` (`:293–295`), not into a retirement.
- The constants are unchanged: `packages/domain/src/constants.mjs:89` `METHOD_HARM_TEST = {baseRate: 0.1, harmRate: 0.4, alpha: 0.05, beta: 0.2, minRuns: 3, maxRuns: 40}` and `:105` `METHOD_SCIENTIFIC_HARM_TEST = {baseRate: 0.25, harmRate: 0.6, …, minRuns: 4, maxRuns: 40}`. Tools now use the latter (`evolution.mjs:13`).
- Still open: "a repaired revision starts its own test" (`:24–25`). There is no bound across revisions or across the library, and the code defers it: "continuous monitoring would need an alpha-spending boundary".

### 4. Exhausting the harm window returns `clear` — **holds**
- `packages/domain/src/methodGraph.mjs:419` (unchanged E→R): `return { state: runs >= maxRuns ? 'clear' : 'watching', runs, bad, llr }`. The tool loop's operating-characteristic helper also folds capped runs into clear: `evolutionMaintenance.mjs:72` `clear: clear + capped`.
- Nothing distinguishes a test that crossed the boundary from one that hit the cap. Redesign: a reason or inconclusive state is still needed, and it would change the return shape shared with the learned-methods loop.

### 5. V4 follows V3 plus delivery-harm clearance — **partly** (axis changed; still "no detected harm")
- At E, `evolution.mjs:31` used `METHOD_HARM_TEST.minRuns` (the delivery axis). At R, `:58` reads `… a.kind === 'research' && Number(a.papers) >= 5)) return usage.harmState === 'clear' && Number(usage.runs) >= EVOLUTION_TOOL_HARM_TEST.minRuns ? 'V4' : 'V3'`, and live promotion happens at `evolutionMaintenance.mjs:270`.
- Trials come from `evolutionFeedback.mjs:13–17`: `deliverable-adopted`→`accepted`, `deliverable-edited`→`repaired`, analytic/evidence `result-corrected`→`rejected`. Each is tagged `causalBenefit: 'unproven'` (`:33`). V3 was tightened: failures now count, and V3 needs "at least five reproduced papers and a reproduction rate whose one-sided 95% lower bound is at least one half" (`evolutionResearchPromotion.mjs:26–27`).
- Redesign: V4 still means no detected correction harm across up to 40 accounts, and running out of trials counts as clear (claim 4). The demand for evidence of genuine use and scientific outcome stands; the "delivery-harm" wording is out of date.

### 6. Private leads lose identity and recurrence; a completed scout is not re-armed — **holds**
- `apps/server/src/evolutionService.mjs:73–79`: private sources `['runtime-failure','autopilot','dataset','handbook']` reduce to `{track, source, gapCode, code}`, unchanged from E. `if (prior) { if (prior.payload.status === 'queued') await this.enqueue('scout', …, id); return prior; }`.
- Nothing ever moves a lead out of `queued` (the only `save('lead'` is `:80`). Re-enqueueing reuses key `evolution:<leadId>`. `productJobs.mjs:31–38` (`ON CONFLICT … status=CASE WHEN $9::boolean AND jobs.status='failed' THEN 'queued' ELSE jobs.status END`) never re-runs a succeeded job, and evolution never passes `rearmFailed`.
- New at R (`evolutionLeadSources.mjs`, F20): module leads carry `{track:"M", source, gapCode, code, entityKeys, endpoint?}` (`:71`), but "the same code and keys, from any number of accounts, is one lead and one run" (`:20–21`). There are at most 5 per day (`:43`). The communication and 虚拟临研 offers are "neither … called by anything today" (`:17–19`).
- Redesign: recurrence counts and wake-on-new-evidence are still missing. Closed entity keys now exist for scoped identity.

### 7. One waiting scout pauses unrelated scouting — **holds** (narrower than stated)
- `apps/server/src/evolutionWorker.mjs:121–122` (E `:94–95`): `const blockedScout = (await this.service.list('failure')).some(row => row.payload.workerStage === 'scout' && row.payload.status === 'waiting'); if (!blockedScout) await this.service.enqueue('scout', { action: 'daily-scan', day }, …)`.
- There is one failure record per stage (`dossierId: \`worker-${stage}\``, `:148`), and any successful job of that stage clears it (`:184–186`). Only the daily scan is suppressed; lead-driven and frontier-paper scouts still run. Redesign: replace the per-stage wait identity with dependency-scoped waits.

### 8. Activation metadata pins bytes but not the qualifying evaluation — **holds**
- `apps/server/src/platformSkillSupply.mjs:144`: `const certificate={reference:result.reference,id,revision:pin.revision,digest,pinDigest:sha(canonicalJson(pin))};`. The pin (`:115`) holds only the label `verificationLevel`. `activate` (`:151–164`) checks hashes only. The certificate is unchanged E→R.
- The receipt exists but is not linked: `evolutionCandidateEvaluator.mjs:210–213` writes `paper-gold/candidate-evaluations/<hash>.json` and returns `evaluationReceiptHash`, and nothing stores it (the only grep hit is `:213`). Tool records keep `{id, sha256: verdict.evaluatorHash}` per case (`evolutionComposition.mjs:312`). Handbook pins (F16) need only `recheckPassed===true` (`:96`).
- Redesign: link `evaluationReceiptHash` and the review receipt into the pin or certificate. No signing service is needed.

### 9. `engine-pr` review input as the terminal path for trusted code — **holds** (already terminal, unevaluated)
- `apps/server/src/evolutionBuild.mjs:21–25` (unchanged): `if(snapshot.publicationKind==='engine-pr'){… return{status:'review',review,digest}; }`, which returns before static verification and the hidden evaluation. `evolutionComposition.mjs:294–295` forces `new-capability` to `engine-pr`.
- `evolutionEngineReview.mjs:8–9`: "Prepare review input only … generated agents never obtain authority to edit platform source". It writes `manifest.json` + `pr-body.txt` and returns `prepareCommand: node OpenScience/scripts/dev/open-evolution-pr.mjs … --dry-run` (`:31`). That script exists.
- Redesign: the terminal outcome already exists. What is missing is any verification or evaluation evidence attached to an engine-pr candidate.

### 10. Conflicting automation/origin classification — **holds**
- `apps/server/src/evolutionScientificUse.mjs:5–6` (unchanged): `const evaluation=isInternalProject(projectId) || run?.automated===true;` vs `packages/domain/src/usagePurpose.mjs:186–188`: `managedResearch = route.startsWith('geo:') || route.startsWith('autopilot:') || route.startsWith('vcr:')`; `return run.automated !== true || managedResearch`.
- GEO and 虚拟临研 step runs are dispatched with `automated: true` (`server.mjs:4610`, `:4693`; reasons `geo:…` `geoOrchestrator.mjs:1091`, `vcr:${step}` `vcrOrchestrator.mjs:2665`). The domain counts them as researcher-owned, but evolution counts them as evaluation, so `evolutionComposition.mjs:425` drops their tool use from use counts and harm trials. Autopilot is `automated` only for acceptance fixtures (`server.mjs:4103`).
- New at R: purposes come from control-plane route reasons (`PLATFORM_ROUTE_PURPOSES`, `autopilot:evidence:`), never from caller dispatch ids (`:127–136`). That is a trusted carrier for the draft's run-origin enum.

### 11. GEO NET has controls, noise and DiD, but no intervention or version identity — **holds**
- `apps/server/src/geoMetricsJob.mjs` is unchanged E→R. `:230–264` compares only rounds with the same question set and `sameEngines` (`:207–212`, engine names). `packages/domain/src/geoMetrics.mjs:1317–1324`: `const net = pilotChange - controlChange` … `verdict: Math.abs(compared) <= threshold ? 'flat' : …`, using a measured noise band or the default `noiseMeasured:false`.
- Searching for `engineVersion|modelVersion|contentRevision|strategyRevision|interventionId` across GEO files finds nothing. Rounds store `set_version, engines, surface` (`geoMeasureStore.mjs:335`). Redesign: intervention and version metadata belong on `evimed_geo.rounds` and in the NET reading.

### 12. Frontier records reader actions without an exposure log — **holds**
- `apps/server/src/frontierRoutes.mjs:37`: `ITEM_ACTIONS = ["star","unstar","hide","unhide","read"]`, stored as last-state timestamps in `evimed_frontier.user_state (user_id, item_id, starred_at, hidden_at, read_at)` (`frontierPersistence.mjs:407–413`). `user_profiles` keeps only the current `for_you` (`:429–436`).
- Searching `frontier*.mjs` for `exposure|impression|propensity|shown_ids|policy_version` finds nothing. The +155-line change to `frontierProfiles.mjs` after E (F11) adds zones and entity keys as signals, not exposure records. Redesign: the exposure record is new work.

### 13. Spend summed by `purpose='evolution'`, with no campaign attribution — **holds**
- `apps/server/src/evolutionComposition.mjs:342`: `dailyCost` sums settled plus open-at-bound costs `FROM evimed_usage.model_requests WHERE purpose='evolution' AND created_at>=$1::timestamptz-interval '24 hours'`. The same purpose filter appears at `evolutionRuns.mjs:87`.
- `usageLedger.mjs:295–311` `reserveModel` takes `id,userId,projectId,runId,sessionId,purpose,model,…,dailyLimit,weeklyLimit,runLimit`, and `usagePersistence.mjs:18–45` has no campaign or experiment column. Note that open and uncertain rows already count at their bound (`OPEN_COST_VALUE`, `usageLedger.mjs:160`).

### 14. Evolved assets stop serving when `OPEN_SCIENCE_EVOLUTION_ENABLED` is off — **holds**
- `platformSkillSupply.mjs:182` `if(config.evolutionEnabled!==true)return{generation:null,degraded:false};`, plus `:200` and `:217` (`executeIsolated`). `evolutionGateway.mjs:17` returns 404. `runtimeGatewayEntry.mjs:80` `evolution: config.evolutionEnabled ? … : ""`. `evolutionComposition.mjs:60` returns null.
- At R this also covers platform handbooks (F16) and recalculation cards (`evidenceRecalculation.mjs:213`). It was made deliberate in `2e5db2add` ("nothing of the module runs when it is off"). Redesign: "pause search, keep serving" needs a second switch.

### 15. Scout priority, literature, coverage and eligibility — **holds** (file unchanged E→R)
- `apps/server/src/evolutionScout.mjs:8–12`:
  ```js
  const count = key => Math.max(0, Math.min(10_000, Number(features[key]) || 0));
  return 3 * Math.log1p(count("literature24Months")) + 4 * Math.log1p(count("runtimeFailures"))
    + 5 * Math.log1p(count("waitingAgendas")) + 2 * Number(features.referenceCode === true)
    + 2 * Number(features.reachableData === true) + Math.min(count("publishedExamples"), 5)
    + 3 * Number(features.coverageGap === true) - 3 * count("unresolvedDependencies");
  ```
  The score only orders the next eligible `planned` dossier (`:134–136`).
- Literature (`:46–47`): `start.setUTCMonth(start.getUTCMonth() - 24)`; `` `(${query}) AND FIRST_PDATE:[…] AND SRC:MED` `` against Europe PMC REST (`:48`), counting `hitCount`. The query text comes from the scout model, or from the Flash normalizer (`:89–100`).
- Coverage (`:113`): `covered = Object.hasOwn(METHOD_RECORDS, methodId) || tools.some(… methodId === methodId && status !== "retired")`. `:118`: `coverageGap: parents.length >= 2 || !covered && card.feasibility?.implementationMissing === true`. The `implementationMissing` flag is stated by the model.
- Eligibility (`:17–26`): a gap with no unresolved dependencies is required. The first tool also needs `!["X","T"].includes(card.track) && published && literature24Months >= 2`, where `published = reachableData && publishedExamples >= 2`. After that the routes are workflow smoke, published inputs or preregistered simulation, and the X track is refused. An ineligible dossier opens a `resource` card (`:129–132`).

### 16. What `evolutionIntegration.mjs` forwards and wakes — **holds**, with additions at R
- Producers:
  - `plannerStopped` → `autopilot-gap`, tool/data needs only (`:59–65`).
  - `datasetChanged` → `dataset-ready`, metadata only (`:68–73`).
  - Composition → `tool-ready` (`evolutionComposition.mjs:322`).
  - `EvolutionFrontierSignals.tick` → `frontier-publication`, built from `item_changes` rows where `op='upsert' AND reason='published'`, 25 per tick, starting at the feed's present with a 3-day look-back (`:340–370`; `cc262464e`).
- `consume` (`:76–133`):
  - feedback → tool harm trials.
  - `evaluation-gap`, `runtime-gap` and `handbook-gap` → leads.
  - `lead-source-scan` (new).
  - `source-facts-scan` → `waiting` meta/prospective candidates with `missingFacts`.
  - `autopilot-gap` → `waitFor` + lead.
  - `dataset-ready` / `tool-ready` → dataset–tool opportunities + `resolveWaiters`.
  - `frontier-publication` → temporal observation, prospective matching, `predictionPublication` (F25, new) and paper scouting capped at `evolutionMaxPaperScoutsPerDay` = 8 per 24 h (new).
- Wakes only autopilot agenda waiters. Tool waits match a visible tool's method, capability or id (`evolutionService.mjs:150`). Data waits enqueue a `self-check` instead (`:151–160`). `wakeForEvolution` failures stay on their wait (`:178–186`). There is no general impact map.

### 17. Budget and limits — **holds**: 50 CNY rolling day / 10 CNY run / concurrency 1
- `config.mjs:2642–2644`:
  - `evolutionDailyBudgetCny` (`OPEN_SCIENCE_EVOLUTION_DAILY_BUDGET_CNY`, default 50)
  - `evolutionRunBudgetCny` (`…_RUN_BUDGET_CNY`, default 10)
  - `evolutionMaxConcurrency` (`…_MAX_CONCURRENCY`, default 1)
  - Bounds are in `evolutionConfiguration.mjs:4–6`.
- Enforcement:
  - Rolling 24-hour window (`evolutionComposition.mjs:342`).
  - Worker admission `count … >= (this.config.evolutionMaxConcurrency ?? 1)` and `cost < (this.config.evolutionDailyBudgetCny ?? 50)` (`evolutionWorker.mjs:32`, `:38–39`).
  - Per-run `runLimit` (`evolutionRuns.mjs:88`). The weekly limit is effectively unset.
- Purpose is `evolution` (label 循证进化, `usagePurpose.mjs:65`), with route reason `platform-evolution` (`:205`).
- Related settings: cards 3/day (max 3), paper scouts 8/day, decision timeout 86 400 000 ms, build attempts 3, job attempts 3. The module is off by default (`config.mjs:2640`).

### 18. Acceptance record `evals/acceptance/2026-10-04-evolution.json` — **holds**; R adds two more unaudited attempts
- Line 41 has `wholePlanAccepted: false` at both E and R. The status block is identical (`implementation: implemented`, `planExitCriteria: partially-measured`, `productionDeployment: false`, `merged: false`; the last is out of date).
- `producer_receipt_hash_unverified` appears at E line 1835 and at R line 1921. At R it is also the cause behind the release-6 finding `scorer-audit-refuses-unpinned-artifacts` (line 2532).
- Every scorer audit so far reviewed 0 of 3 sampled units:
  - the original attempt (lines 1893–1894): "Zero discrepancies with zero reviewed samples is not a passing scorer audit";
  - release 5 (lines 2092–2093);
  - release 6 (lines 2463–2464): "Not passed. The audit audited nothing".
  - A path probe then bought one review (qwen3.8-max, 1.48 CNY), and the evidence-id guard discarded it.
- Accepted on releases 5 and 6 (isolated):
  - compose, handler-level gateway probes and decisions;
  - native egress proof;
  - scout→build→hidden verification→publication, with the note "The scout was handed the method";
  - use by an account the wrapper created;
  - upload of public Pima data into a fixture agenda;
  - wake and release replay;
  - release-6 isolation;
  - a release-6 scoped cycle with 5 of 6 units code-verified, though none was unexposed.
- Not accepted (`remainingAcceptance`, 7 items, up from 4 at E):
  - the same 5–10 papers across all three rulers;
  - full gateway filtering;
  - an interpretable cycle plus an independent audit;
  - V3/V4, temporal/prospective results and a full month;
  - the two release-6 audit blockers;
  - known exposure (`cite_lookup`, PMID lists, query echo);
  - release-5 steps not repeated on release 6.
  - `notEstablished` adds that the reviewer is "of the assessor's family", so the audit needs "a third family or a person".
- Also new at R: `corrections` restates the method-ruler counts (meta 5/5 agree; pharmacovigilance 46 agree / 19 disagree of 65; MR 10/11, 1 could not run).
- Fixes coded after the record but not re-run live: `ef415eda2` (unpinned files no longer block; `passed:outcome==='audited'`, `evolutionScorerAudit.mjs:121–124`, `:167–169`) and `365fdf162`.

### 19. Decision cards (≤3/day, 24 h default, expiry) — **holds**; expiry reworked after E
- The cap is `evolutionMaxDecisionCards` (default 3, schema max 3). Above the cap, B cards execute the recommended option and C cards the conservative one (`evolutionDecisions.mjs:86–91`). Cards reach the owner only through the daily digest (`:208–211`; `deliver` is called only there).
- Each delivery sets `dueAt = deliveredAt + evolutionDecisionTimeoutMs` (86 400 000) and enqueues an `evolution-decision` job (`:103–105`).
- That job runs `expire()` (`evolutionWorker.mjs:162`):
  - D takes the alternative;
  - C takes the conservative option at once;
  - B gets a refresh plus a cross-family review. If no review is available it retries 3 times, 1 h apart, then takes the conservative option (`:9–10`, `:121–145`).
  - At E (`:53–57`) a missing review threw an error, and C also waited for a review.
- `closeNotice` → `notifications.resolveByDefault` (new, `6005b11a8`; `:162–172`, `notificationService.mjs:661–667`) closes the card's inbox item. `applyDueDefaults` exists at E and R (`notificationService.mjs:686–697`, run by `server.mjs:1183`), but it only resolves rows with `default_action`, and evolution cards set none (`:99–101`).
- Late answers supersede earlier ones (`:173–193`). Adaptive class A applies only to cards a person saw: "A decision the engine took by itself … is not agreement" (`:79–83`). The options a card may carry are a closed list (`evolution.mjs:38–41`).

### 20. Learning scope, and what crosses tenants — **partly**: account handbooks are still owner-scoped, but two opt-in cross-account channels are new at R
- Owner scope: `capabilityHandbooks.mjs:1` "Owner-specific lessons are workspace context" and `:15–23` `learning.documents.list(project.userId, "method", …)` (4-line change E→R). `methodFeedback.mjs` gains `fromEvidenceOutcome` (F15): a corrected or withdrawn card becomes an `evidence_corrected` signal for the method test.
- **Platform handbooks** (`learningPlatformHandbooks.mjs`, `bd31ad813`, F16). An applied account lesson must pass four gates:
  1. Code field checks (identifiers, data numbers, project facts).
  2. A Flash "general method knowledge" judgement with a closed class.
  3. An author rule: "three published cards that each carry a ✓" or corroboration by another account.
  4. A re-check by "a model of another family … which must not be DeepSeek".

  Only then does it become a text-only skill in `platformSkillSupply`, which refuses it otherwise (`:96`). Provenance is internal, and retirement uses the tool harm test. Off by default: `OPEN_SCIENCE_LEARNING_PLATFORM_HANDBOOKS_ENABLED` (`config.mjs:558`), 3/day.
- **Account-to-account sharing** (`capsuleSharing.mjs`, `capsuleShareLinks.mjs`, `capsuleMethodPack.mjs`, `capsuleShareTrust.mjs`; `ceaa7d672`, F17):
  - named delivery, share links, take-down that disables copies, and an Agent Skills zip (text only, with `PROVENANCE.md`);
  - shares count for the platform only after `SHARE_CORROBORATION_MIN_ACCOUNTS = 3` accounts keep them for `14` days;
  - guest-influenced runs are excluded from `evolutionLearningCoupling.mjs`, which emits a `handbook-gap` lead after ≥2 non-guest `method-missing` runs (`:17–20`).
- Across tenants, `platformSkillSupply` ships by capability or track (`:199–214`):
  - immutable `skill` packages;
  - `isolated-tool` stubs (only `SKILL.md` plus a platform gateway client; code stays private, `:107–114`);
  - script-free workflows;
  - text-only `handbook` entries (new at R).

  "Researcher data/results never enter this store" (`:38`).
- Redesign: shared procedural candidates with independent re-checks exist at R, though off by default. Extend F16 rather than build a parallel path.

### 21. Autopilot: what feeds back — **holds** (planner gained frontier items at R)
- Planner (`autopilotNextAction.mjs:14–35`): "The model decides" the task type, `focus`, `reason` and `stop`. Code decides eligibility, the closed answer vocabulary, `stopAllowed`, the budget (purpose `autopilot`) and the date-rotation fallback. Failed or canceled episodes are shown as `did_not_run`/`check_unavailable`, never as negative findings (`:38–44`).
- Inputs the planner sees:
  - progress (checked/refuted/weakened claims), the researcher's note, eligible (non-paused) types, `reducedPriority`;
  - `availableTools` when evolution is on;
  - new at R: `frontierItems` (≤8 items matching the agenda's entities, F04, `:239`).
  - A `needs_input` stop may carry a tool or data `resourceNeed`. At R an unusable need is dropped and the stop kept; E rejected the whole answer.
- `autopilotOutcome.mjs` `foldOutcome` (unchanged) tracks per-type failures (→ `pause-type`), `episodesWithoutGatedClaim` from succeeded episodes only (→ `halve`, `park`), unopened digests and rejections. Thresholds (`agenda.mjs:313–320`): halve at 3, park at 6, pause a type after 2 failures, pause the thread after 7 days without the digest being opened.
- Resource waiters follow claim 16. Nothing reports tool quality back beyond `verificationLevel`. Redesign: these are operational stopping signals, not scientific outcomes.

### 22. GEO S0–S4 severity — **holds** (initial and uncalibrated)
- `geoJudge.mjs:74` `GEO_SEVERITIES = ["S0","S1","S2","S3","S4"]`. Flash assigns a severity to each `wrong` statement using the prompt scale (`:119`). Code drops verdicts with an invalid severity (`:354–356`) and re-verifies quotes and numbers (`:17–25`).
- `:26–29`: "Severity is 初判 (`severity_basis: 'initial'`) until a pharmacist calibration set exists … anchored to NCC MERP". The database default is `severity_basis … DEFAULT 'initial'` (`geoPersistence.mjs:313`), and no code ever writes another value. The `confirm` round in `geoErrors.mjs:17–23` measures re-ask stability, not severity.
- New at R (`6ee4049ff`, F21): judging uses verified card claims, and each statement records `cardId`/`cardClaimId`/`cardRevision`, "filled by code". This partly supplies the draft's `claimBaseRevision`.

## Stale or missing in the drafts

**Status.** Both drafts call the Evidence Flywheel "a proposal". At R it is built, released as RC20, and every part is off by default (`config.mjs:415–726`: `OPEN_SCIENCE_EVIDENCE_PROGRAMME_ENABLED`, `…_RECALCULATION_CARDS_ENABLED`, `OPEN_SCIENCE_PREDICTION_REGISTRY_ENABLED`, `OPEN_SCIENCE_GEO_QUESTION_BANK_ENABLED`, `OPEN_SCIENCE_CAPSULE_SHARE_ENABLED`, `OPEN_SCIENCE_LEARNING_PLATFORM_HANDBOOKS_ENABLED`, `OPEN_SCIENCE_EVOLUTION_MODULE_LEADS_ENABLED`, all `false`). The 46 evolution commits after E (`git log --oneline E..R -- …evolution*`) invalidate claims 2 and 3, change claims 1, 5 and 19, and add the machinery below.

**Described as proposals or gaps, but present at R:**
- **Unified source-change record.** `sourceChanges.mjs:2`: "The one durable fact per source identifier that every module reads". These are platform-level `source-change` documents with a positioned feed, written by result impact, the zone editor and frontier, and read by result impact, memory labels and cards. Not flag-gated (`server.mjs:1065–1066`). The regularized draft's §8 "if it lands first" condition is met.
- **Entity keys.** `packages/domain/src/entityKeys.mjs` (`@evimed/domain/entity-keys`) and `entityVocabulary.mjs` ("the join key every module calls"), used by module leads, predictions, frontier profiles and planner items.
- **Evidence-card claims and lineage.** `packages/domain/src/evidenceCard.mjs` ("the platform's single evidence unit"; producer required; ✓/⚠ via `claimVerification`; "Only an index (a card is cited as a pointer to its sources, never as evidence)"; "A simulation is never evidence"). `evidenceCardFromResult.mjs` (`previousCardId`, `originCardId`), tables `evidence_card_revisions/origins/runs` and `evidence_change_log`. Guards against circular support: notice `platform_card_cited` (`errorCodes.mjs:858–861`) and refusal `vcr_evidence_source_is_card`.
- **Question bank.** `geoQuestionBank.mjs` (F22) and `packages/domain/src/geo/question-bank.json`: about 60 class-level questions, asked monthly and judged against published cards.
- **Prediction registry and calibration.** `predictionRegistry.mjs` (F25), built on evolution's `prospective` records. It scores Brier, absolute error and interval coverage, and publishes calibration after `PREDICTION_CALIBRATION_MIN_SCORED = 30` (`:47`). However, "No proposer is composed in the server yet" (`:28`).
- **`evidence` / `evidence-upkeep` usage purposes** (`usagePurpose.mjs:66–67`).
- **Platform-level sharing of methods and handbooks.** F16 and F17 (claim 20).
- **Incident → eval pipeline.** `evidenceIncidents.mjs` (F15) and `scripts/evals/export-evidence-incidents.mjs` → `evals/evidence-incidents/cases/`.
- **Evolution → flywheel.** Recalculation cards publish adjudicated reproductions from `evolution-research-proof` (`evidenceRecalculation.mjs`, F03). Module leads also exist (F20).
- **Measurement hygiene.** `evidenceFlywheelMetrics.mjs:7`: "A figure with no input is `null` with the reason, never 0". Origin is classified by route reason (claim 10), GEO verdicts are pinned to card revisions (claim 22), and the planner reads frontier items (claim 21).
- **P0 repairs already coded.** Unpinned artifacts become `unverified`, and only a pinned file with changed bytes raises `producer_receipt_hash_unverified` (`paperGoldEvaluator.mjs:157–158`). A same-family reread is not a review (`695118693`, `365fdf162`). A live re-run is still needed.

**Machinery at R that the drafts do not mention:**
- `evals/paper-gold/behavioural.mjs` (metamorphic checks plus fresh reference cases, required for V2).
- `simulation.mjs` (Monte-Carlo-interval criteria, at least 200 replicates).
- `tolerance.mjs` (tolerances from printed precision; models no longer supply tolerances, `d645ded2b`).
- The method ruler now reports disagreement (`91432130f`).
- Clopper–Pearson V3.
- Exact operating characteristics of the harm test (`evolutionMaintenance.mjs:55–73`).
- An exposure chain across attempts that keeps the worst tier (`evolutionExposureChain.mjs`), plus a `recalled` tier for references the model remembers (`d72f14a80`).
- A release-replay crash counts as `execution-regression` (`:127–137`).
- Platform-skill fallback and quarantine (`24df827a7`).
- Locked tool-use counting (`3ea4ea0a4`).
- With the module off, pre-feature bytes are written and the tool list is not read (`80df95881`, `3f9caf0fc`).
- Run-cap vs day-cap refusal handling (`evolutionWorker.mjs:58–80`).

**Still open at R (the drafts are right):**
- The paper the frontier sends to evolution has no earliest-public evidence (`evolutionIntegration.mjs:361–363` builds `{id,title,url,publishedAt,identity,excerpt}`), so temporal and prospective matches stay `waiting` / `waiting-provenance`.
- There is one frozen case file per method (`evolutionCandidateEvaluator.mjs:228`), and `reserve` cases are the only held-out subset.
- Activation is serialized only within one process (`platformSkillSupply.mjs:43` `let mutation=Promise.resolve();`).
- There is still no frontier exposure log, campaign attribution, recurrence counting, cross-revision alpha accounting or severity calibration.
