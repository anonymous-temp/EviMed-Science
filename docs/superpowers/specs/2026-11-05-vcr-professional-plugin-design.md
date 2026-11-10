# Independently distributable virtual research plugins

Date: 2026-11-05. Status: consolidated product design and implementation proposal; no implementation,
benchmark rerun, merge or deployment is performed by this document.
Inspected source: `codex/vcr-algorithms-20261103`, `da2d191b4`.

The consolidated review, current status corrections, delivery sequence and
acceptance checklist are in [the final plan](../plans/2026-11-05-vcr-plugin-final-plan.md).
That plan supersedes earlier checkpoint task lists where newer matching or
algorithm evidence has already closed or replaced an item.

## 1. Product decision

Provide four independently installable professional plugins on DSH and
DeepSeek, plus an optional composition bundle:

| Proposed package | User-facing product | Primary question |
| --- | --- | --- |
| `@evimed/virtual-cohort` | Virtual cohorts | Which population does this research describe, and how can it be constructed and checked? |
| `@evimed/virtual-patient` | Virtual patients | What is a subject's recorded history or a model-supported trajectory under stated conditions? |
| `@evimed/synthetic-control` | Synthetic and external controls | What comparator is defensible for the stated estimand and available evidence? |
| `@evimed/virtual-trial` | Virtual trial design | How will alternative trial designs operate under explicit assumptions? |
| `@evimed/virtual-research-suite` | Virtual clinical research | Coordinate selected plugins and preserve one connected research project. |

Patient recruitment and matching is a separate product owned by the parallel
workstream. This design defines exchange boundaries with it, not its internal
implementation or workflow. None of the four plugins requires recruitment or
matching to be installed. The suite does not install it implicitly.

The recommended boundary is a coherent scientific domain with enough capability
to complete end-to-end research when requested. It is not a mandatory workflow
or a fixed sequence. Each plugin contributes composable expertise, skills,
input contracts, scientific methods, result models, report interpretation and
validation. Search, knowledge access, exact computation, artifact rendering and
job execution are reusable services. Open-domain queries may use any relevant
subset, combine installed plugins, or need no plugin execution at all.

Alternatives considered:

- A single VCR plugin would be easiest to package first but would preserve
  coupled releases and installation of irrelevant capabilities.
- Separate search, protocol, analysis and report products would duplicate the
  current stage-based division and force users to assemble a scientific task.
- The recommended task-oriented plugins share small contracts and adapters,
  allowing independent installation and optional composition.

## 2. What exists today

Verified in the inspected checkout:

- `OpenScience/capabilities/vcr-{protocol,evidence,analysis,matching,package}`
  are workflow packages. They do not constitute four standalone product plugins.
- `vcrComposition.mjs` constructs VCR stores, access, data intake, candidate
  matching, evidence, engine and other services together. `server.mjs` wires
  the routes and workers. This is a real hosted-product dependency to extract.
- `vcr_platform.py` exposes broad read/write/simulate tools backed by the
  control-plane gateway. A copied skill still needs those services.
- `项目代码/vcr-engine` already separates deterministic methods and their
  runtime from the language model. Its method registry includes cohorts,
  population synthesis, outcome generation, model application/training,
  comparison and design simulation.
- The platform already has extension preparation, immutable runtime
  generations, project selection, isolated operations and rollback. Use
  `extensionHostedIntegration`, not the old citation-specific plugin path,
  as the hosted integration foundation.
- Hosted extension support does not currently prove arbitrary product service,
  database migration or React-route installation from an external bundle.
  Those interfaces need explicit implementation and validation.
- `packages/harness-port` remains the sole importer of upstream DSH APIs.
  Professional packages must depend on its adapter boundary, not kernel internals.

The November 5 consolidation verified GitHub CI on this exact revision:
492/492 numerical cases with none skipped, and a successful confirmatory-design
step in the isolated candidate image. The hosted-production-e2e job was skipped;
this is not production acceptance. These checks were not rerun locally. Existing acceptance notes also
record method-discovery and answer/result consistency defects in real
conversation. Packaging must address the whole request-to-result path as well
as preserve numerical correctness.

## 3. Define independence before naming a release

The same professional implementation supports two explicit hosts:

1. **Standalone DSH:** install the plugin and declared shared runtime, configure
   host-owned model/data/search providers, run a documented task in an isolated
   workspace, and receive inspectable outputs. No EviMed SaaS account, full web
   application or production database is required. A local object/job adapter
   can be provided by the shared runtime. It must have real execution and
   cancellation tests; it is not a mock backend.
2. **EviMed hosted:** reuse existing identity, data grants, model gateway,
   PostgreSQL jobs, source storage, extension lifecycle and scientific viewers.
   Users install/enable deployment-admitted artifacts. Provider keys remain
   outside the agent runtime. Server-side adapters and migrations are delivered
   by the operator's release process, not arbitrary customer code execution.

Support is recorded per mode. An initially hosted-only adapter must say so;
standalone support is only claimed after a clean DSH installation runs the task.
An installation with only local sources can still work without online retrieval;
its limitations are visible. It does not fabricate a successful search.

## 4. Four plugin responsibilities

### 4.1 Virtual cohort

Owns population construction at group scale:

- Define target population, inclusion rules, time zero, source selection,
  variable meanings, units, missingness and dataset versions.
- Build a cohort from authorized observed records; retain included, excluded,
  unknown and unprocessed counts.
- Generate scenario populations from declared distributions or literature
  parameters; preserve correlations as sourced or assumed.
- Fit an empirical synthesis method only when authorized patient-level data is
  supplied; evaluate fidelity, implausible combinations, diversity and leakage
  risk before claiming properties beyond basic scenario generation.
- Compare source, target and generated population distributions and export an
  immutable cohort snapshot, data dictionary and quality report.

Existing method entry points include `profile.snapshot`, `cohort.build`,
`population.scenario`, `population.literature`, `population.synthpop`,
`population.quality` and `population.check`.

Data prerequisites: observed cohorts and empirical synthesis require individual
records; literature/scenario generation can start from sourced summaries and
explicit assumptions. Marginal summaries do not identify all joint relations.
Generated records do not increase the number of independent observed patients.

Output: `CohortSnapshot`, with observed/derived/synthetic provenance, selection
rules, lineage and limitations. Time-varying outcomes belong to the virtual
patient/model service and can be attached by reference.

### 4.2 Virtual patient

Owns subject-scale representation and model-supported outcomes:

- Reconstruct an authorized subject timeline with events, treatments,
  observations, corrections, temporal anchors and missing information.
- Generate clearly synthetic subject records and trajectories for research
  simulations under a specified model.
- Apply an immutable published or fitted prognostic model to compatible inputs;
  keep model version, target population, outcome, horizon and calibration visible.
- Evaluate prediction quality on disjoint patients/sites/time periods, compare
  forecasts and expose uncertainty and out-of-scope inputs.
- Simulate alternative scenarios only to the extent supported by a specified
  model and its assumptions. Predictions cannot fill observed eligibility fields.

Existing anchors include `patients.*`, `model.survival_fit`,
`model.prognostic_apply`, `model.prognostic_train`, `vcrLongitudinal.mjs` and the
forecast provider interfaces. A method named `patients.*` is not automatically
an individual prediction model: current progression and baseline models may
remain population-level scenario models.

Data prerequisites: scenario demonstration can use parameters; individual
prediction requires subject inputs and an applicable model; model development
and external validation require the corresponding observed longitudinal data.

Outputs: `SubjectSnapshot`, `ModelArtifact`, `TrajectorySet` and
`ValidationReport`. Store observed histories separately from simulated or
predicted tracks. Reserve digital-twin claims for specifically validated use
cases; one generated row or risk score is not sufficient.

### 4.3 Synthetic and external controls

Owns comparator design and analysis, with distinct evidence routes:

| Route | Required inputs | Appropriate output |
| --- | --- | --- |
| Observed external control | Treatment and comparable control records, exposure, endpoints, index dates and confounders | Comparative analysis and bias/transportability diagnostics |
| Population-adjusted indirect comparison | Compatible individual and/or aggregate trial information under method-specific assumptions | MAIC/STC-style estimate with anchored/unanchored interpretation |
| Literature benchmark | Sources, population/endpoint definitions and published summaries or curves | Feasibility or indirect benchmark with reconstruction limitations |
| Hybrid borrowing | Concurrent trial data plus external evidence and a specified borrowing rule | Borrowing sensitivity, effective information and error behavior |
| Randomized prognostic adjustment | A frozen externally trained prognostic model and randomized concurrent data | Adjusted estimate/precision analysis; randomization remains present |

Begin with estimand and target-trial specification: population, treatment
strategies, index date, outcome, follow-up, censoring and intercurrent events.
Select adjustment only after checking availability, timing and comparability of
the data. Report overlap, balance, effective sample size, sensitivity and
remaining identification assumptions. Reuse propensity/entropy weighting,
RMST/Cox/AIPW, target-trial, borrowing and bias methods already present.

The plugin may consume a `CohortSnapshot` or `ModelArtifact` from another plugin
or a validated import. It never requires those plugins to be installed merely
to use compatible data. Creating 100 synthetic patients does not create an
observed 100-person control group. A hidden trial treatment or outcome cannot
be reconstructed from recruitment/exit records.

Outputs: `ComparatorPlan`, `ComparatorAnalysis` and `AnalysisReport`, carrying
the route, estimand, source-arm provenance, diagnostics and limitations.

### 4.4 Virtual trial design

Owns simulation of how a study design operates:

- Translate a scientific objective into endpoint, analysis, sample size,
  allocation, visits, stopping rules, follow-up and abstract accrual assumptions.
- Compare fixed, sequential, adaptive, dose-finding, Bayesian, single-arm and
  other supported designs through the existing method registry.
- Calculate operating characteristics under both null and alternative
  scenarios, expected enrollment/events, error rates, power, duration and
  Monte-Carlo precision.
- Analyze parameter uncertainty and scenario sensitivity; preserve interrupted
  simulation results and the exact completed replicate count.

Reuse `design.*` and the explicit abstract accrual method. The design plugin
can generate outcomes internally from distributions for its simulation without
installing the virtual-patient user interface. Those generated outcomes share
the same implementation as the model runtime; do not duplicate generators.

Data prerequisites: published parameters and assumptions are sufficient for
design exploration. Individual data is optional for calibration and empirical
validation. This plugin does not demonstrate the efficacy of an untested drug.

Outputs: `TrialDesign`, `OperatingCharacteristics`, scenario comparisons,
plots and a design report that explicitly distinguishes events from people.

## 5. Shared services and scientific interpretation

Keep one small research contract package and one versioned calculation runtime
family. Initially reuse the existing engine image rather than cloning an R
stack per plugin. Each plugin declares the method IDs and compatible versions
it needs. The shared runtime handshake reports actual method/package versions;
a package update never silently swaps the engine used by an existing job.

Common ports are extracted from existing implementations as needed by the first
plugin, not built as a speculative new platform:

| Shared port | Reuse | Responsibility |
| --- | --- | --- |
| Evidence/search | Web, literature/registry connectors, knowledge resources, evidence preservation | Retrieve, preserve and cite source material under current permissions |
| Research data | Intake, field maps, frozen snapshots, subject pseudonyms and grants | Read authorized inputs and retain origin/type/visibility |
| Model inference | Host model gateway and usage ledger | Bounded DeepSeek calls, accounting and execution attribution |
| Exact methods | Existing R/Python engine and reference cases | Validated numeric computation, seed, precision, cancellation and checkpoint |
| Scientific assessment | Evidence review and domain rules | Structured applicability, bias, transportability and uncertainty findings |
| Results/reporting | Result objects, evidence-linked numbers, file and scientific viewers | Present and export the same persisted result |
| Jobs/provenance | Existing jobs, artifacts and generation records | Durable status, events, restart, dependencies and version binding |

Clinical grading is not one generic confidence score. Evidence certainty,
source relevance, risk of bias, model applicability, prediction calibration and
eligibility are distinct assessments. Use explicit schemas, stated methods
and source-backed rationale. GRADE-style assessments apply only to the evidence
question for which that method is appropriate; a numerically correct analysis
is not thereby high-certainty clinical evidence.

Patient records stay in their controlled data plane rather than the general
knowledge base or shared memory. A synthetic label is not an authorization to
send source-derived data to a provider. Article licensing, model weights and
reference datasets are dependencies to record, not material to silently bundle.

Evidence parameterization and report writing are shared skills callable by each
plugin. An independently useful evidence-synthesis product can be added later;
it is not a mandatory fifth scientific plugin for the first split.

## 6. Open-domain conversation and adaptive execution

Owner clarification, 2026-11-05: complete-task capability is the scope of a
plugin, not the minimum amount of work a query must trigger. A user may request
only two operations, ask a methodological question, reuse existing results,
change one assumption or combine several plugins in one conversation.

The following operations are available on demand, not numbered mandatory stages:

- Read the request and available authorized inputs.
- Retrieve needed literature or knowledge and preserve relevant sources.
- Resolve field meaning, study population and clinical/methodological scope.
- Form a typed computational specification where an operation requires one,
  retaining observed, published, derived and assumed values.
- Dispatch validated computations or prediction jobs using frozen versions.
- Check relevant diagnostics and perform requested or necessary sensitivity work.
- Read persisted results and explain or export the requested part.
- Deliver available work with explicit gaps; resume only unfinished operations.

Choose the smallest sufficient set of operations for the current request. Order
them by actual data and method dependencies; independent operations may run in
parallel. Users do not fill a universal research form, select a prescribed
starting stage, or finish a checklist before receiving a useful answer. Existing
authorized sources and results satisfy prerequisites without being recreated.
Revisit a completed operation only when a changed input, a new request or an
identified defect requires it.

Examples that must be supported:

| User intent | Appropriate execution |
| --- | --- |
| Explain how external and synthetic controls differ | A concise supported answer; no automatic study, cohort, simulation or report |
| Find a control event-rate range and calculate sample size | Retrieve and parameterize evidence, then calculate; no virtual-patient generation |
| Check balance in an uploaded comparison dataset | Read/map the relevant data and run balance diagnostics; no automatic causal-effect analysis |
| Change one assumption in an existing trial design | Reuse valid inputs and recompute affected results as a new version |
| Explain a previously saved result | Read that result and its premises; no new inference or computation unless needed |
| Prepare a complete comparison study and report | Compose the operations and plugins necessary for that explicit deliverable |

Scientific prerequisites belong to the invoked operation, not an obligatory
workflow. For example, an effect estimate needs suitable treatment/outcome data,
while an explanation of that method does not. Ask for genuinely missing inputs
only when they prevent the requested work; otherwise proceed using available
evidence and clearly bounded assumptions where scientifically appropriate.
Permission, source integrity and method-input checks still apply to every call.

Delivery follows requested scope: a short answer, a table, one calculation, an
updated figure or a full report. Plugin installation must not bind every turn
to its professional report contract. Do not require all plugin output files,
a visible study object or a full plan for a small question. Persist the minimum
execution/result state needed for real work without adding user-facing steps.

DSH coordinates dialogue, files, tools and continuation. DeepSeek interprets
requests and evidence, proposes a plan and explains supported results. The
method runtime produces numerical results. A plugin-owned discoverable entry
and a compact capability description allow the ordinary conversation to discover
and load relevant skills/tools on demand. Explicit plugin selection scopes the
available expertise, not the allowed questions or a mandatory execution order.
Avoid exhaustive always-on instructions, keyword-only routing and automatic
rebinding of the general conversation to a specialist. Keep verified task and
data context explicit when operations cross plugin boundaries.

Reuse current completion and job events. Background completion resumes the
owning conversation or updates its result, without another polling loop or
requiring the user to request a completed result again. Pin each task to plugin,
prompt, input, method, runtime and model identities. A useful result is retained
when another part fails. Do not add a whole-report clinical approval gate.

## 7. Exchange contracts and parallel matching boundary

Derive contracts from current domain types and keep aliases during migration.
The proposed names below are conceptual, not a claim that these new schemas
already exist. A contract carries schema version, producer/plugin version,
object/version identity, source references and authorized data handles, units,
time zero, uncertainty meaning and result lineage. It never carries raw
credentials. Data references do not grant access by themselves.

- `CohortSnapshot`: group membership and population facts; provenance distinguishes
  observed, derived, synthetic and reconstructed data.
- `SubjectSnapshot` / `TrajectorySet`: observed time series versus predicted or
  simulated paths, with model identity and intended use.
- `ModelArtifact`: inputs, endpoint, horizon, training/calibration separation,
  coefficients or provider identity, applicability and validation evidence.
- `ComparatorAnalysis`: estimand, design, sources, balance and effect estimates.
- `TrialDesign` / `OperatingCharacteristics`: parameters, design decisions,
  uncertainty and reproducible simulation outcomes.
- `AnalysisReport`: references to those exact versions and their reported numbers.

Matching exchanges `ProtocolCriteria`, authorized subject/cohort references and
`EligibilityAssessment`/selected-candidate references through published contracts.
Its own owners retain trial retrieval/ranking, criterion judgments, evidence
spans and matching status. The cohort plugin owns group construction, not final
recruitment eligibility; criterion syntax/evaluation libraries may be shared
without requiring the whole matching plugin. Prediction cannot populate an
observed matching fact. No plugin reads or mutates another plugin's private
tables. Cross-plugin operations retain user, tenant and project boundaries.

The matching workstream owns its per-criterion interpretation of an unmentioned
condition and the labels shown for that inference. Shared contracts preserve
observed, inferred, missing and unprocessed evidence separately rather than
forcing an older matching interpretation on that plugin.

## 8. Distribution and lifecycle

Each professional release contains:

- A real DSH bundle, with scoped skill/tool registration through the existing
  harness adapter, and a standalone host adapter where supported.
- Versioned scientific contracts and the minimal method/provider dependencies.
- Hosted adapter and approved result-view contributions; hosted migrations are
  operator-managed. These integration surfaces are explicit new work.
- Example data that can legally be redistributed, golden results, independent
  numeric references and an executable acceptance suite.
- Release identity, compatibility matrix, dependency digests, data/license
  notices, change log and upgrade/disable/uninstall behavior.

Reuse DSH's native package format and installer. Any scientific manifest extends
EviMed metadata and compiles to supported native package fields; do not invent
another plugin loader. Reuse the hosted extension-generation lifecycle instead
of loading arbitrary code into the running web process. No runtime HMR for a
serving research installation. Activate a new version after active work, and
retain old versions for pinned jobs/results or explicitly stop and migrate.

Install, enable, scientifically validate and publish are different events.
Disabling prevents new plugin work and removes its task entry while retaining
readable historical results. Uninstall is not data deletion. Missing models,
connectors or algorithms report the affected operation and leave unaffected
capabilities usable. Numerical validation metadata remains separate from
clinical validation and from runtime authorization.

The suite has a tested dependency lock and an orchestrator for selected
installed plugins. It contains no copied algorithms or second copies of data.
It can connect cohort -> subject simulation -> comparator -> trial design when
the request calls for that composition. This is an example, not a prescribed
path. Plugins may be invoked individually, skipped, revisited or combined in
other scientifically supported orders. Each accepts standard imports and can
run on its own; ordinary DSH conversation can also use several installed plugins
without requiring the suite. Scientific results
are frozen; changes invalidate downstream results and create a new version.
The suite never adds patient matching or recruitment permissions implicitly.

## 9. Product surfaces

Keep one conversation and native composer, with the current EviMed typography
and tokens. Installed plugins supply meaningful task entries and result views;
the general home accepts open-domain queries and can dispatch directly. Task
entries are convenient starting points, not a menu limiting what may be asked.
Do not reconstruct the rejected four
large feature rows followed by a disconnected study list.

Each plugin opens a workspace centered on its scientific object and result:

- Cohort: population definition, composition, distribution and quality.
- Patient: observed history, explicitly separate modeled tracks and validation.
- Control: comparison design, source groups, overlap/balance and sensitivity.
- Trial: design alternatives, operating characteristics and assumptions.

Open such a workspace when the requested work produces or inspects that object.
A methodological question can remain a normal conversation. Follow-up turns may
change scope, combine capabilities or ask only about one result; show progress
for work actually running rather than empty or skipped stages of a fixed rail.

Show task-specific data prerequisites at the point of entry: `Individual data
required`, `Can start from literature`, or `Applicable model required`, with
precise follow-up requirements. Keep provenance/versions in inspectable result
details and operator logs, not as backend prose on the product home.

## 10. Verification and release criteria

Validation is measured per plugin and supported execution mode:

| Plugin | Existing starting material | Required evidence |
| --- | --- | --- |
| Cohort | PhysioNet 2012 A/B/C and independently constructed synthetic controls | Selection correctness, missingness, distribution/correlation fidelity, utility and leakage checks; state that this is ICU validation |
| Patient | Observed time series and model-specific external data | Patient/time/site split, horizon-specific accuracy/calibration, interval coverage and failure rate; no universal disease claim |
| Control | ACTG175, simulated known effects and reference methods | Endpoint/field definitions, estimand, no post-baseline leakage, bias, interval coverage, error rate and sensitivity; RCT data alone does not validate real external controls |
| Trial | Existing engine reference cases, including compatible rpact methods | Numeric agreement, type-I error/power within Monte-Carlo error, seed/restart consistency, truthful people/event labels and design limits |
| Matching, separate team | TrialGPT/TREC/n2c2 | Its full platform cohorts and task-specific metrics, not credited to the four plugins |

For each installable plugin, prove install -> discover -> natural-language task
-> persisted artifact -> report -> disable/upgrade/rollback in an ordinary
account, including relevant failure/cancel/resume paths. Test it without sibling
plugins, with the suite and with matching absent. A clean standalone test must
not import `apps/server`, require an EviMed account or use a production database.

That lifecycle is an installation acceptance journey, not a required workflow
for every user query. Add acceptance cases for explanation-only requests,
arbitrary supported subsets, supplied intermediate data, existing-result reuse,
cross-plugin questions, changed assumptions, interrupted work and a general
nonmedical question in the same conversation. Assert that irrelevant tools,
reports, data requests and visible research objects are not forced on the user.

Before/after extraction, replay the same frozen full applicable dataset and
compare scientific outputs and usable-task completion. Freeze data, code,
prompts, model settings and scoring before the comparison; retain every failed
case. Mark automated tests, separate patient workspaces and disable memory
extraction. Reuse valid existing method evidence and rerun affected checks;
do not replace full-data evaluation with a succession of favorable tiny pilots.

## 11. Incremental extraction plan

1. **Agree contracts with the matching workstream.** Confirm ownership of data,
   eligibility grammar, identifiers, source locators, jobs and exported artifacts.
   Keep that branch's work separate; do not pull historical matching prototypes
   into the algorithm branch merely to split packages.
2. **Use virtual trial as the first complete extraction.** Its deterministic
   engine is already separate and literature-only examples permit standalone
   acceptance. Extract only the shared ports it actually needs. Deliver the
   DSH bundle and hosted adapter with identical method implementation.
3. **Extract virtual cohort.** Add data-plane ports, real/derived/synthetic
   provenance and full applicable PhysioNet tests. Reuse the same host adapters.
4. **Extract synthetic controls.** Add estimand and comparator contracts, route
   distinctions, field/timing checks and full applicable ACTG175/reference tests.
   Accept imported cohorts/models without sibling installation.
5. **Extract virtual patient.** Deliver history and declared scenario models
   first, then claim prediction support only for specifically validated models.
   Keep disease/model packs versioned extensions, not universal patient claims.
6. **Publish the optional suite.** Compose released versions and shared results.
   Test partial installations and absent matching. No extra scientific engine.

Stay in the monorepo initially with independent package versions, tags and CI
entry points. Use the repository's existing `packages/*` workspace rather than
creating a new multi-repository platform. Introduce public task packages and
small shared contract/adapter packages incrementally; retain current method IDs,
URLs and readers as compatibility adapters. Preserve old studies and job
versions. No production data migration or deployment is authorized by this plan.

## Sources and code anchors

- [DSH native plugin manager](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/plugin-manager/README.md): bundle lifecycle and profile scope; current upstream master is not the project's compatibility pin.
- [DSH plugin indexes](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/plugin-market.md): distribution discovery; not clinical qualification.
- `OpenScience/AGENTS.md`, architecture, extension preparation and VCR product rules.
- `OpenScience/apps/server/src/vcrComposition.mjs`, `vcrGateway.mjs`, `vcrJobs.mjs` and `vcrWorker.mjs`.
- `OpenScience/apps/server/src/extensionHostedIntegration.mjs`, `extensionDeployment.mjs` and `extensionService.mjs`.
- `OpenScience/packages/domain/src/extensions.mjs` and `OpenScience/packages/harness-port/`.
- `OpenScience/capabilities/vcr-*/capability.yaml` and `OpenScience/runtime/mcp/evimed-research/vcr_platform.py`.
- `项目代码/vcr-engine/R/engine.R`, its method registry and reference tests.
- `docs/superpowers/plans/2026-11-04-vcr-algorithm-acceptance.md`, real-conversation findings and their stated limits.
