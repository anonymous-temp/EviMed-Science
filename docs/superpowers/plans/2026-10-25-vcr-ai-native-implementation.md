# AI-Native Virtual Clinical Research Implementation Plan

> For agentic workers: use subagent-driven-development for bounded implementation
> tasks, followed by specification and independent code review. The owner has
> authorized implementation, local verification, commits and GitHub push.
> Do not deploy or operate on the serving production database in this change.

**Goal:** Execute the approved AI-native reset and its review: four conversation-led
research tasks, evidence-first parameters, useful research objects, no recruitment
OA, and truthful per-task data/model requirements.

**Architecture:** Reuse the existing DSH kernel, authenticated execution-context
guard, VCR data plane, persisted object/job/result contracts and R engine.
General conversation entry is attributed to its verified native session, never
to a model-supplied project/session or the newest study. Aggregate calculations
reuse research_calculate. Model text interprets; numerical engines calculate.

**Tech stack:** React/TypeScript, Node checkJs, Python MCP/FastAPI, R survival,
PostgreSQL, existing DSH and design tokens. No new agent kernel.

## Sources and authoritative choices

- Base: origin/main at 1aa0f7c3f; isolated branch codex/vcr-ai-native-reset-20261025.
- Read: the reset review and c1-code, r1-international, r2-china, r3-academic
  notes; the original v2 plan and current integration contracts.
- All three owner decisions are accepted: remove CRM-fed accrual and use
  simulated duration; archive before retiring the three OA tables/roles;
  allow patient-to-trial matching directly from global conversation.
- Production retirement is approved in principle, but must execute only after
  the old serving code/workers no longer depend on those tables. This code-only,
  no-deployment task prepares/tests inventory, archive, verification and retirement.
- Keep historical calculation projects readable; stop new calculator UI creation.
- Do not reconnect CDE/ICTRP sources against prior owner decisions. Report actual
  registry coverage and missing eligibility text.
- Nearest literature is an explicit exploratory assumption, not automatic
  transportability. Digital-twin terminology is not certification. Simulation
  precision and budget are explicit; research examples are not universal gates.
- The review's Delphi AUC comparison is corrected by its academic note:
  comparable longitudinal results are 0.69 to 0.67, not the mixed 0.76 to 0.67.

## Implementation contract

### A. Retire recruitment operations without losing scientific matching

Ownership: server VCR recruitment/contact/store/composition/routes/views/notify/
erasure code and corresponding domain vocabularies; retirement ops utility/tests.

- [x] Retain candidate filtering as a matching function independent of referrals.
- [x] Remove automatic referrals, coordinator notifications, site/follow-up
  operational writers/routes, recruiter/site permissions and operational forecast
  feedback. Keep matching rechecks with no OA side effects.
- [x] Stop creating OA tables in new installations; existing tables are retired
  only by the explicit archive-verified utility. Preserve historical scientific
  forecasts and research observations.
- [x] Prepare archive-before-retirement with source identity, counts, file digest,
  restore/readback verification, advisory locking and transaction-safe deletion.
  An archive mismatch or data change prevents retirement; do not print records.
- [x] Rewire trial duration to design simulation duration_months; preserve
  optional mathematical accrual and protocol follow-up/dropout parameters.
- [x] Update focused regressions and actual PostgreSQL integration tests.

Representative assertions:

    assert.equal(completedMatch.assessments.length > 0, true)
    assert.equal(referralWriter.calls.length, 0)
    assert.equal(coordinatorNotifier.calls.length, 0)
    assert.equal(trial.duration.source, "design_simulation")

### B. Conversation entry, execution attribution and completion

Ownership: VCR gateway/context/service/store/persistence/job/worker seams,
result replay, root tool exposure, MCP dispatch/context, related server wiring.

- [x] Exclude module-only VCR workflows from ordinary classifier candidates,
  without keyword overriding an LLM none result.
- [x] Reuse/extend the verified native execution-context guard. Propagate the
  context through vcr_platform and resolve child calls to their actual root run.
- [x] Bind a task-scoped VCR context to the authenticated originating conversation,
  preserving normal global conversation behavior and independent sessions in
  the same project. Do not adopt a newest/sole/default-project study.
- [x] Admit a patient case from an owned user message/attachment through existing
  source projection; preserve quotes and minted pseudonyms. Model-authored text
  is not silently upgraded to observed patient evidence.
- [x] Make narrow global calculations use expanded, allowed research_calculate
  recipes; expose compact tools and load workflow detail through skills.
- [x] Add a durable, idempotent same-conversation completion path. It waits for
  the correct session, never changes it to a specialist, and reports failures/
  cancellations honestly; retry uses existing dispatch identity.
- [x] Separate local matching/evaluation from engine-heavy work with bounded
  per-account scheduling. Preserve maintenance/leases and physical engine limits.
- [x] Test concurrent sessions, duplicate calls, source ownership, busy/deleted
  conversations, retries and no recruitment side effects.

Representative assertions:

    assert.notEqual(contextFor(sessionA).studyId, contextFor(sessionB).studyId)
    assert.equal(globalSession.boundAgent, originalAgent)
    assert.equal(continuationsFor(jobId).length, 1)
    assert.equal(localMatchStartedWhileEngineBusy, true)

### C. Native research UI and contextual data requirements

Ownership: apps/web VCR pages/components/client types, capabilities catalogue,
native frame options and UI walk/fixture updates.

- [x] Replace mandatory definition/full-programme startup with four task intents.
  Use the existing native composer; retain full-package execution only when asked.
- [x] Remove VCR method catalogue entry journeys and OA UI. Historical links
  show preserved results; numerical methods remain available to AI.
- [x] Present six study views: overview, matching, population/patients, comparator,
  trial, evidence/data. No compulsory seven-step rail.
- [x] Show task input requirements separately from current data availability.
  Include longitudinal data intake without reopening the calculator UI.
- [x] Adjust/compare actions target the existing conversation and exact object
  version, not another text input or empty generic prompt.
- [x] Keep empty, unavailable and error states visible and actionable.
- [x] Update browser walk and fixtures to the new contract rather than retaining
  known-gap exemptions for retired pages.

### D. Scientific object and evidence integrity

Ownership: rows/records, relevant gateway evidence/model APIs, R patient/
longitudinal/simulation outputs, assumptions/lineage and their tests.

- [x] Count unique people rather than visits; aggregate complete individual
  longitudinal records and expose authorized synthetic members to conversation.
- [x] Preserve stable cohort-member correspondence across paired scenarios;
  make pairing/random-stream policy explicit and keep independent replicates.
- [x] Extend evidence anchors to preserved literature text/tables using existing
  quote/source mechanisms; verify literature baseline numbers through that path.
- [x] Track only actually bound assumption cards for invalidation.
- [x] Preserve criterion evidence for both matching directions and authorized
  individually selected table records; missing source criteria remain unknown.
- [x] Preserve registry source/date/coverage failures without inventing eligibility.
- [x] Treat longitudinal follow-up as research data input, not an OA episode.

### E. Scoped model routes and design results

- [x] Add literature survival fitting using the already available
  survival::survreg; distinguish reconstructed pseudo-IPD from observed people.
  Cover exponential, Weibull, lognormal and loglogistic with correct AFT
  parameter transformations and degenerate-input handling.
- [x] Execute bounded, explicitly sourced published risk equations using typed
  coefficient/transform specifications, never eval of paper text. Missing
  baseline risk yields only supported relative quantities.
- [x] Correct model labels: catalogue adoption is not fitting/validation.
- [x] Connect supported predicted-comparator and trial-parameter use with
  scope/uncertainty labels; do not claim universal clinical validity.
- [x] Build evidence-uncertainty scenario variants with explicit quantile
  provenance and distinguish power from assurance.
- [x] Cross-check numerical changes; preserve supported partial/not-estimable
  outputs and existing reference methods.

### F. Skills, instructions and documentation

- [x] Update root AGENTS/CLAUDE identically and subtree AGENTS (CLAUDE symlink).
  Supersede conflicting seven-step/calculator/OA directives.
- [x] Update PRD, DESIGN and TECHNICAL_DESIGN with four tasks, evidence-first
  parameters, input requirements, scoped model types and no OA.
- [x] Synchronize vcr skill copies/manifests. Matching ends at evidence-backed
  assessment; complete study programme remains optional.
- [x] Add routing, conversational and scientific fixtures for four task families.
  Record real vs synthetic and local vs live-model evidence separately.

### G. Verification, review, commit and push

- [x] Focused unit/integration and numerical tests pass after each task.
- [x] Specification review then code review; TypeScript/JavaScript, Python and
  sensitive-data/security reviews cover the corresponding changed paths.
- [x] Run type/lint/domain/MCP/capability/secret checks and appropriate broader
  suites. Report host-specific or unrun checks without treating them as passed.
- [x] Use local owned PostgreSQL/engine/app fixtures and the in-app browser.
  Verify task entry, data badges, result actions, missing-input behavior,
  historical results and absence of OA/calculator entries.
- [x] Run local real DSH/model conversation probes; retain failures and distinguish
  mocked fixtures from authenticated execution. A native-control ablation was not
  performed, and no performance or superiority claim is made.
- [x] Commit only intended changes, push the non-release branch and create a
  reviewable GitHub PR (unless later instruction explicitly requires direct main).
  No full-release marker, deployment script, production migration, or live
  customer-data operation is performed.

## Evidence log

- Remote review commit fetched and verified. Original maintainer checkout and
  unrelated untracked material preserved.
- Managed worktree created from origin/main; offline frozen pnpm install passed.
- Research notes confirmed survival is a production recommended R package,
  while many reference packages are test-only. No unnecessary dependency added.
- Native session attribution must reuse the existing result-gateway transcript
  proof; a skill alone does not grant hidden MCP tools.

## Completion rule

Do not report completion based on method count, fixture renders or a plan alone.
Track each requirement to a code change and a specific verification result.
Clinical validation, production user acceptance and separate-node performance
remain separate from this explicitly local, no-deployment delivery.


## Final local verification record (2026-10-26)

Implementation A–F is complete. Independent reviews closed the archive, source,
scientific model, native attribution, UI and late live-execution findings. The
[acceptance record](2026-10-26-vcr-ai-native-acceptance.md) maps the delivered
behavior, scientific scope, exact local checks and remaining environment limits.
It supersedes the initial partial test counts recorded during implementation.

The main local gates passed: 5,211 web checks; 1,060 VCR unit checks; 432 isolated
VCR PostgreSQL checks with one explicitly unavailable Docker-context probe;
required-mode model-science and actual R replay checks; domain, port, socket,
MCP, types/lint/build and generated-source/secret audits. Later analytic 1.2
changes additionally passed the affected 846 web checks, 29 PostgreSQL checks
and 18 numerical cases. The original broad macOS server run was not all green
and is retained in the acceptance record.

Actual native matching succeeded on a synthetic diabetes case in ordinary
conversation, with the missing myocardial-infarction history left unknown. The
Linux calculation probe drove the real signed HTTP service; subsequent fixes
make integer arm totals consistent and preserve normal-versus-t methodology.
Complete production-image qualification, native-control benchmarking, clinical
validation and deployed acceptance remain separate from this code-only handoff.

No production recruitment tables were deleted. The owner-approved archive-first
retirement utility is prepared and tested for a later offline operation after
old writers are stopped and fenced. No deployment has been performed.
