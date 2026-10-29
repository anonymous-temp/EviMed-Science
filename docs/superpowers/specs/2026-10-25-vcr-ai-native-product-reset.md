# Virtual Clinical Research: AI-Native Product Reset

2026-10-25 | Product direction and implementation contract

Last updated: 2026-10-26.

Status: approved product direction, incorporating the October 25 reset review and October 26 implementation boundaries. The original document preceded implementation; local code/verification is recorded in the implementation plan and handoffs. This specification is not evidence of live-model, clinical or production acceptance. No deployment or serving-database operation is authorized by this implementation task.

## 1. Decisions that supersede earlier plans

The owner explicitly removed intelligent recruitment as an operational product.
Contact management, assignment, referrals, site CRM, recruitment funnels,
enrollment ledgers and follow-up task management are out of scope.

The retained product is an AI-native research workspace for:

- patient-trial matching;
- cohort construction and virtual patients;
- external/model-based comparator research;
- virtual trial design and simulation.

Users describe their research goal in one conversation. AI selects and invokes
appropriate tools, reads numerical results and explains them. Users are not
expected to browse a statistical-method catalogue and complete method-specific
parameter forms before work can begin.

Data requirements must be visible per task. “Needs patient information”,
“needs a patient-level dataset”, and “can start from public evidence or explicit
assumptions” are different conditions. Existing authorized connected data
satisfies the requirement without another upload.

These decisions supersede the recruitment/OA portions of the September 28
plans and the October 25 audit's recommendations to finish that OA workflow.
They also supersede the VCR portions of the October 10 feature-retention, October 14/19 fixed-step/configuration and October 20 presentation requirements. VCR methods are not ordinary-user calculators in the Research Tools catalogue. GEO keeps its eight-step workflow. The general
platform remains general-purpose; this reset concerns the VCR method surface.

## 2. The concepts, expressed as user decisions

| Concept | Unit of work | Question answered | Typical output |
|---|---|---|---|
| Patient matching | A real patient and a real study's eligibility requirements | Which trials may fit this person, or which real patients may fit this protocol? | Candidate matches, criterion evidence, conflicts and missing information |
| Cohort | A defined collection or population distribution | Who is being studied, and what is the population like? | Definition, members or generated baseline records, composition and selection flow |
| Virtual patient | An explicitly modeled individual | Under a named model and scenario, how might this person's indicators or events evolve? | Baseline, model/scenario, trajectories or outcome distributions and uncertainty |
| Synthetic/external comparator | A role in a specified comparison | What is the appropriate reference or control, and what comparison can the evidence support? | Comparator design, comparability, estimates or model predictions with limitations |
| Virtual trial | A simulated experiment and analysis | How would a proposed study design behave across plausible conditions? | Comparisons of designs, power, false-positive behavior, precision, duration assumptions and sensitivity |

### 2.1 Cohort and virtual patient are related but not identical

A cohort defines membership and population structure. It may be real, derived or synthetic, or a declared distribution before records have been materialized. An empirically derived synthetic dataset retains its ancestry and source permissions; it is not independently generated merely because its rows are synthetic.

A virtual patient is an individual modeled object. A synthetic baseline row
can be one such object's starting point; adding a disease or outcome model
enables trajectory simulation. A model-conditioned representation of a real
person is a further, scoped use, not something established by assigning a name
to a generated row.

The cohort view answers distribution and coverage questions. The individual
view answers within-person trajectory, scenario and uncertainty questions.
Both should use the same saved population/member lineage.

Do not force an individual archetype request to create a large cohort first.
Do not require every baseline cohort to have a longitudinal disease model.

### 2.2 Comparator is a study role

A cohort may become a comparator when its provenance and relationship to a
target study are defined. A model may supply a predicted comparator distribution.
Neither becomes a credible causal control merely because it exists.

Maintain clear routes for observed external control, literature benchmark,
model-based comparator, and supported hybrid borrowing. Prognostic covariate
adjustment within a randomized trial is a distinct analysis route.

### 2.3 Virtual trial is the experiment, not another type of patient

A virtual trial combines study design, population assumptions, outcome
generation or models, observation/censoring, and an analysis. It can internally
use virtual patients, or use an analytical/reference calculation without
materializing individual records.

Its primary outputs describe study-design behavior. An assumed treatment effect used to evaluate power is not an AI-discovered real treatment effect. Here virtual trial means trial-design simulation, not a decentralized trial or evidence of drug approval.

### 2.4 Matching is an independent task

Real patient matching does not require first creating a virtual cohort,
virtual patient, comparator or full trial simulation. Synthetic records can
be used in labeled tests but are not real recruitment candidates.

Matching ends with an evidence-backed research result. It does not create
a referral, contact a person, allocate a site, assign a coordinator, or maintain
an enrollment workflow.

## 3. Recommended product structure

Keep the first-level “虚拟临床研究” entry. Inside it, reuse the existing native conversation/composer and four recognizable task entry points that fill unsent drafts:

1. Patient Matching.
2. Cohorts and Virtual Patients.
3. Comparator Research.
4. Virtual Trial Design.

The second entry merges the collection and individual views without erasing
their different purposes. Comparator research remains independently reachable;
it is not buried under trial simulation.

These are task suggestions and result spaces, not mandatory modes. Free-text
requests can start anywhere and can combine tasks. The system assembles only
the work needed for the current goal.

### 3.1 Home

- The main research input accepts a question, source reference or attachment.
- Four short examples explain the tasks in user language.
- Each example displays its data requirement before the user starts.
- Existing research conversations and outputs can be resumed.
- No method catalogue, long parameter form, definition-versus-seven-step
  selector, recruitment dashboard or site-management view is the default.

Suggested example intents:

- “Find candidate trials for this patient's records.” — patient information needed.
- “Build a synthetic population for this research scenario.” — can start without uploaded patient data.
- “Assess whether my study can use an external control.” — data need depends on whether this is planning or effect estimation.
- “Compare three study designs and show which assumptions change the conclusion.” — can start from evidence and declared assumptions.

### 3.2 One conversation and saved research objects

Reuse the native DSH conversation and composer. Do not add a second chat box
inside each result card or replace the native file/browser pane.

The six result destinations are overview, matching, population/patients, comparator, trial and evidence/data. Group and individual views share the population workspace; old patient URLs remain readable. The main study area presents saved results as relevant objects:

- cohort composition and selection;
- patient records and complete supported trajectories;
- matching evidence;
- comparator diagnostics;
- trial scenario comparisons.

Object actions are limited and contextual: Adjust, Compare Versions, Inspect
Evidence, and Export. Adjust binds the object/version to the existing composer.
The user can say “restrict this cohort to the earlier period” or “compare a
more conservative dropout assumption” without re-entering the whole study.

Tables and charts are legitimate AI outputs. The distinction is that users
work through research intent and adjustments, rather than manually orchestrating
statistical tools.

## 4. How conversational execution should work

User goal → inspect available inputs and saved objects → retrieve and preserve evidence → bind source-supported parameters → ask only for unavailable facts that change the next operation → choose supported methods/models → execute tools in the verified native task context → read saved results and uncertainty → explain/visualize → revise in the same conversation.

Preserve exact source generations, hashes, quotation spans and literal units. Numerical baseline statistics bind to explicitly verified source fields. Derived values verify quoted inputs only, not reported observed baselines. Nearby evidence supports only labeled exploratory assumptions and sensitivity ranges; it does not establish transportability.

AI may:

- retrieve study precedents and source parameters;
- propose variable/criterion mappings with source evidence;
- select an appropriate supported method;
- construct a validated job configuration;
- invoke calculation/generation tools and track completion;
- explain assumptions, results and limitations;
- save a revised object and compare it with earlier versions.

The statistical engine computes numerical results. The assistant never replaces
a failed job with an invented number or an unsupported clinical forecast.

### 4.1 Ask for research facts, not software parameters

Ask only for information that materially determines the current task and is
not already available. A matching task needs patient evidence and eligibility
requirements; it does not need a treatment-effect hypothesis or trial power.
A baseline cohort task does not need a fully specified outcome estimand.

Use justified, labeled assumptions for exploratory design where appropriate.
Present consequential assumptions with the result and allow revision in
conversation. Do not create an approval ceremony for every parameter.

Do not fabricate an endpoint or treatment-effect value merely to satisfy
a legacy full-study schema. Task context and required fields must be scoped
to the operation.

### 4.2 Asynchronous work remains part of the same research

A longer job returns its actual state and continues under existing resource
and cancellation controls. Results attach to the originating research and
remain usable in subsequent conversation.

Do not make the user manually poll a job ID, navigate to a generic method page,
or repeat the original goal after a tool finishes.

### 4.3 Reuse native tools with verified task ownership

The existing VCR read/write/simulate, registry, curve-digitization and evidence-pooling tools remain the mechanism; narrow aggregate calculations also reuse `research_calculate`. The gateway verifies the exact pending native invocation and its actual root run before resolving an owned account/project/root-conversation task scope. A scheduler dispatch resolves only its associated programme study. General projects/sessions are not rebound, and no newest/sole-study fallback is allowed. A patient source is an owned human-message reference or preserved upload, reread server-side; model-authored patient prose is not clinical observation.

Durable terminal-job and new aggregate-replay completion returns to the exact originating conversation, preserving attribution and dispatch identity through retries and restarts. Busy origins wait; unavailable/deleted origins are explicit and never open another chat. Cancellation never restarts work, and historical calculations do not trigger retrospective continuations. Durable finish consumers land saved objects before delivery.

Local matching/evaluation uses a bounded local executor lane independent of the heavy engine queue. This creates no second R worker and makes no claim of parallel R execution. Immutable configurations, result ownership, de-duplication, budgets, permission decisions, honest errors and numerical provenance remain. See [current technical architecture](../../../OpenScience/docs/TECHNICAL_DESIGN.md) §5.6 for the seams.

## 5. Data requirements: visible at the point of intent

“Provide” below means upload, enter an appropriate case description, or use
an already authorized connected source. It does not always mean uploading
a spreadsheet.

| User task | Minimum information | Must the user supply a patient-level dataset? |
|---|---|---|
| Find trials for one patient | Patient case/baseline evidence; current trial requirements | No table required, but patient information is required |
| Find real patients for a trial | A real patient source plus the study criteria | Yes, an uploaded or connected real patient source is required |
| Construct a real cohort from local records | Patient-level source, variable meaning and cohort question | Yes |
| Generate an assumed population | Target characteristics and declared distributions/dependencies | No; public evidence and explicit assumptions can seed it |
| Generate a population resembling a customer's actual patients | Representative authorized customer data | Yes, if the claim is similarity to that customer's data |
| Simulate a hypothetical virtual patient | Defined baseline and an explicit scenario/model | No real dataset required |
| Predict for a real patient's baseline using an existing suitable model | Baseline information and a compatible, available model | No historical training dataset from the user is necessarily required |
| Train/calibrate a new clinical trajectory model | Suitable longitudinal exposure/outcome data and validation plan | Normally yes, or an independently authorized equivalent data source |
| Research a literature comparator or historical benchmark | Traceable published evidence and a research question | No uploaded patient dataset is inherently required |
| Estimate a target study's actual comparative effect | Comparable target/control exposure and outcome IPD, index dates and confounders | Yes for actual external-control analysis; published curves alone are a weaker descriptive benchmark |
| Build a model-based predicted comparator | Target baselines/population plus an appropriate outcome model | Baselines required; historical model data may come from another authorized source |
| Compare hypothetical trial designs | Endpoints, population/design assumptions and a supported generator or analytical method | No uploaded patient dataset is inherently required |
| Calibrate a trial simulation to a customer's actual population/outcomes | Suitable authorized customer records | Yes, for that empirical calibration claim |

### 5.1 User-facing data indicators

Use concise, task-specific indicators:

- Can start directly.
- Patient information needed.
- Patient-level dataset needed.
- Longitudinal outcome data needed.
- Suitable model needed.
- Existing connected data available.

A marker opens a short explanation of the minimum fields and accepted forms.
The assistant should offer to inspect existing connected data before asking for
another upload. Optional materials are labeled optional.

A reference protocol or published trial is not a patient dataset. A reconstructed
survival curve is not complete observed patient-level covariate data. A file
upload succeeding does not prove that exposure, endpoint and time zero are mapped. Pre-enrolment records, exit date/reason and post-trial care cannot reconstruct hidden study treatment, intervening outcomes or causal effects. Missing facts remain unknown, never exclusions, satisfied criteria or zero. Selected-record grants and cloud permission remain separate from aggregate small-cell suppression. Native `generated_records` requires verified independent generation ancestry; empirical/upload-derived records stay on the controlled path. A synthetic label alone grants no cloud permission.

## 6. Expected results for the four task entry points

### 6.1 Patient Matching

Question: does the available evidence support possible eligibility?

Results:

- candidate patients or studies;
- met, not met, unknown and deferred conditions;
- source passages and dates;
- decisive conflicts and missing evidence;
- current trial/site availability as a discovery fact;
- assessment version and as-of time.

The result does not claim actual enrollment or treatment benefit. Public site
locations and trial recruitment status remain useful matching information;
they are not a site CRM.

### 6.2 Cohorts and Virtual Patients

The cohort view shows selection, composition, distributions, coverage,
missingness and comparisons. The individual view shows a representative or
selected virtual member, baseline, scenario, full supported trajectory and
uncertainty.

The user can switch between “the population” and “this member” within the same
research object family. A new scenario preserves explicit member correspondence
where pairing is intended; independent simulation replicates remain distinct.

A reference simulator remains labeled a mathematical scenario. If no suitable
clinical model exists, the assistant can still provide a justified scenario
simulation or a model/data feasibility assessment, without inventing clinical
predictive validity.

### 6.3 Comparator Research

The assistant first determines whether the user wants a benchmark, a predicted
comparator, or an actual effect comparison. It assesses the available data and
uses the appropriate supported route.

Results include comparator provenance, target population, time zero, outcome
definition, comparability, uncertainty and sensitivity. An unsupported actual
effect estimate can coexist with a useful benchmark or design analysis.

### 6.4 Virtual Trial Design

Question: which proposed design behaves better under the assumptions relevant
to this decision?

The assistant assembles the required population/model/parameter inputs and
compares selected designs. Users receive a short recommendation with its
reasons and sensitivity, plus the underlying scenario comparison.

Outcomes include power, false-positive behavior, precision, sample/event
requirements, observation duration assumptions and robustness. Enrollment
rate can remain a scientific time assumption; there is no separate recruitment
operations or enrollment-CRM product.

Not every request must instantiate a virtual patient set. A supported analytical
calculation can directly answer a narrow design question inside the same
conversation.

## 7. Recruitment/OA removal contract

### 7.1 Remove from the active VCR product

- coordinator assignment and work queues;
- patient contact/approval/sending flows;
- referral ledgers and transition workflows;
- center/site CRM, operational capacity and activation management;
- screening/enrollment operational ledgers and funnel dashboards;
- operational recruitment forecasting and deviation alerts;
- follow-up assignments, reminders, completion tracking and case management;
- recruitment campaign, channel and materials-production modules.

Remove their navigation, controls, skill instructions, callable business writers,
side-effect hooks, notifications and routine operational worker actions. Merely
hiding the pages is insufficient.

### 7.2 Preserve scientific data and independent research behavior

- patient evidence, protocol requirements and matching assessments;
- public study/site status used to find relevant trials;
- authorized longitudinal observations and outcomes as analysis inputs;
- protocol visit/measurement schedules used by simulations;
- design assumptions about enrollment timing, observation and dropout;
- scientific computation jobs, completion notices and version invalidation;
- existing historical records and exportability according to their retention
  and access policies.

The user removed operational functionality, not existing scientific study data. Preserve longitudinal observations and read-only historical follow-up. For the three retired OA tables and recruiter/site roles, the owner approved archive-first offline retirement in principle. `OpenScience/scripts/ops/vcr-retire-recruitment.mjs` prepares a private verified v2 archive, preserving PostgreSQL JSON text losslessly and checking typed restoration. An explicit transaction locks approved sources before READ COMMITTED comparison and uses RESTRICT; no startup deletion or CASCADE. Legacy retired grants may be revoked. All old writers must be stopped and prevented from restarting before later explicit offline execution. This no-deployment task does not operate on the serving database.

Scientific reevaluation when new data arrive may be requested as a research
task. Do not preserve automatic recruiter queues under another name.

### 7.3 Known coupling to cut

| Current coupling | Required disposition |
|---|---|
| Matching job completion saves assessments and creates referrals/notifies coordinators | Retain assessment completion; remove referral/operational notification side effects |
| Matching store mixes facts/assessments with sites/referrals/follow-up episodes | Separate responsibilities; do not delete the entire matching store |
| Runtime writers can create sites and follow-up operational episodes | Retire those business writes; preserve research-data import and longitudinal analysis |
| Contact endpoint updates contact/referral states | Retire the active contact workflow |
| Recruitment forecasting reads site CRM and enrollment ledgers | Remove the operational forecast/backtest workflow; preserve design-time enrollment assumptions |
| Withdrawal closes referral cases | Remove obsolete OA coupling while retaining actual data-use withdrawal behavior |
| Matching skill generates recruitment drafts and explains site/follow-up operations | Restrict the skill to evidence-backed matching and assessment outputs |

The coupling table above records the migration obligations. Current owners are `vcrMatchingCandidates.mjs`, `vcrConversationCompletions.mjs`, `vcrGateway.mjs`, `vcrErasureStore.mjs` and the explicit retirement utility; removed contact/OA modules are not future integration points.

## 8. Method UI retirement

Remove VCR method entries as normal-user standalone calculator journeys in
Research Tools, including “select method → fill parameter form → calculate”.
Retain the actual methods as tools callable by AI.

Scientific method names, assumptions, execution code and parameter values remain
inspectable from results. Expert users can ask for a specific method or change
an assumption in conversation. An optional advanced result view is not the
default interaction or a prerequisite to completing the task.

Existing result/configuration deep links should continue to show preserved
outputs with a path back to their research conversation. Do not silently lose
historical work or duplicate the calculation implementation.

The capability catalogue, read-only historical method result view and exact object-to-conversation actions retain compatible addresses. No historical component or method route authorizes a new calculator journey.

## 9. Revised implementation priority

### Priority 1: the AI-native core

- Remove OA from the active product and disconnect its side effects.
- Make patient matching and cohort/virtual-patient requests executable from
  one conversation without a full-study-definition detour.
- Add the task-specific data indicators.
- Reuse existing numerical tools through background context binding.
- Fix complete longitudinal patient inspection and intended cross-scenario
  correspondence.
- Return saved result objects and support natural-language revision.

### Priority 2: comparator research

- Connect real-data and literature comparator workflows to the same conversation.
- Preserve source, estimand and diagnostic context automatically.
- Complete a scoped model-comparator route only with actual executable and
  method support; do not relabel a registered card as a functioning predictor.

### Priority 3: integrated virtual trial design

- Let AI assemble reusable population, patient/comparator and design objects.
- Compare multiple designs with explicit assumptions and uncertainty.
- Support narrow design calculations directly when they answer the question.
- Preserve decisions and revisions without forcing every user through a
  seven-step programme.

This priority does not remove existing trial-simulation methods. It changes
what is exposed and which end-to-end experiences must be completed first.

## 10. Revised acceptance contract

| ID | Acceptance journey | Required outcome |
|---|---|---|
| N1 | Ask for a synthetic scenario population without uploading a dataset | A calculated, saved cohort with declared assumptions; no mandatory dataset form |
| N2 | Ask to filter real local patients without an available source | A precise request for the needed patient data; no invented real cohort |
| N3 | Provide one patient case and ask for trial matches | Evidence-backed candidate assessment without a full trial-design questionnaire |
| N4 | Provide a protocol and an authorized patient table | Real patient matching with unknowns and provenance, no automatic referral/contact |
| N5 | Use an already connected data source | No redundant upload request; correct access scope retained |
| N6 | Open a virtual patient with multiple visits | All supported visits and uncertainty are inspectable |
| N7 | Change a scenario in natural language | A new version, explicit member correspondence where appropriate, and a comparison |
| N8 | Ask for an actual external-control estimate without target outcomes | A scoped limitation plus useful planning/benchmark work, not an invented effect |
| N9 | Compare study designs from public parameters | Tool-computed results with assumptions and sensitivity, without browsing calculators |
| N10 | Start from a general AI conversation | Minimum authorized research context is bound in the background; no fabricated endpoint |
| N11 | Matching finishes | Assessment saved; no referral, coordinator task, contact or recruitment notification side effect |
| N12 | Import authorized longitudinal research data | Research data remain usable despite OA removal; source-specific restrictions remain |
| N13 | Tool/provider fails or is unavailable | Honest partial result or actionable requirement; no substituted invented computation |
| N14 | Open old research results | Historical outputs remain accessible and attributable |
| N15 | Inspect the ordinary-user surface | No recruiter/site/contact/follow-up management and no default VCR calculator catalogue |

Numerical validation remains in force. No UI simplification can turn
assumed, synthetic, predicted or reconstructed values into observations.

## 11. Relationship to the prior audit

The October 25 audit remains a record of what the earlier scope did and did not
implement. Its recommendations to complete recruitment/site/follow-up OA are
superseded by the owner's explicit removal.

The following audit work remains directly relevant:

- complete longitudinal patient reading;
- model/patient/comparator/design linkage;
- honest model execution and validation states;
- task discoverability and study identity;
- source-specific access and data provenance;
- end-to-end acceptance instead of method-count completion.

The recruitment lifecycle is not to be “finished later” under this reset.
Matching remains; operational recruitment does not.

## 12. Handoff status

This document records a concrete product reset and the code boundaries that
implementation must honor. It does not claim OA has already been removed
from production, that method entries have already disappeared, or that
conversation-first execution has passed a live acceptance run.

Implement against the new scope, reuse the current DSH/tool/data infrastructure,
and preserve unrelated work already in progress in this shared checkout.

## 13. Scoped model and design contract (2026-10-26)

The review's model routes are a capability roadmap, not a blanket implementation claim. Current deterministic execution is scoped to `model.survival_fit` and `model.prognostic_apply` alongside the existing engine methods. Survival fits use intercept-only `survival::survreg` for exponential, Weibull, lognormal and loglogistic distributions; observed records and reconstructed pseudo-IPD remain distinct. Source condition and explicit selected arm are required before a fit becomes a control baseline. Curves/diagnostics survive even when no downstream adapter exists: the current reference-patient/design adapter supports exponential/Weibull only and never silently approximates lognormal/loglogistic fits.

Published equations are typed linear/logistic/Cox specifications with exact source numerical/semantic bindings, predictor units/coding, centering/scaling and endpoint/horizon. Source text is never evaluated as code. A Cox equation lacking baseline survival/reference supports relative scores only; a linear expectation without residual SD is not an outcome distribution. Registration, executability, source applicability, calibration and clinical validation remain separate. Fitting a population baseline does not establish an individual causal twin.

A saved prognostic prediction may support a scoped benchmark or compatible control-design input, with immutable model/result/population selection and separately supplied treatment-effect assumptions. It does not identify a treatment effect, create observed controls, add real/effective sample size or replace an RCT. Actual external-control, literature-benchmark, randomized prognostic-adjustment and hybrid-borrowing routes retain their different data/estimand requirements.

Fit p10/p50/p90 variants are median-parameter sensitivity with fixed shape, not joint parameter uncertainty, outcome percentiles or assurance. Mean full-study duration uses simulation `duration_months`; optional abstract Poisson–Gamma accrual reports last-patient-in timing separately, without CRM sites. Clinical generalizability and real-model/user-path acceptance require their own evidence.

### 13.1 Saved-model design recipe

A saved model enters a trial through `trial_scenario.configuration.modelResultId` and `modelResultVersion`; `modelParameterQuantile` selects `p10`, `p50` or `p90` (default `p50`). A design grid places the same immutable references in `dimensions.base` and may use `modelParameterQuantile: "all"` to compare the three parameter scenarios. The server resolves and verifies the saved execution, binds endpoint/horizon/source condition and derives the compatible control input. Model outputs do not supply an assumed treatment effect. Quantiles are parameter sensitivity with fixed shape, not patient percentiles or assurance.

## UI acceptance handoff — 2026-10-26

The product-specific requirements below are transferred from design specification v3.0 to this module authority. They are acceptance requirements, not a claim that pending product implementation has shipped. Shared component, state, ownership and proof rules are maintained in [Frontend Design System v3.1](../../../OpenScience/docs/FRONTEND_DESIGN_SYSTEM.md). Later explicit owner decisions update this plan without creating another design-system copy of the product scope.

Apply the October 25 AI-native reset as the current direction. Native conversation is the operating entry. Numerical tools remain validated infrastructure; ordinary users do not have to navigate a standalone VCR method catalogue/form to begin a task. Compatible historical links and saved objects remain accessible.

Build only the current task's context. Matching/cohort construction does not require invented trial endpoints, treatment effects or a definition-versus-full-program choice. Reuse authorized connected sources. Explain task-specific requirements: patient information, patient-level dataset, longitudinal observations or compatible model.

Preserve cohorts, virtual patients, comparator research, simulation and historical configuration/result versions as distinct scientific objects. Display AI interpretation alongside deterministic results without calling estimates observations. Remove recruitment operations from the target UX: contact, referral/site CRM, enrollment funnels, operational forecasting and follow-up assignments. Evidence-backed bidirectional patient/trial matching remains. Research follow-up observations and protocol measurement schedules remain scientific data. The reset is not a claim that current deployed screens already implement it.
