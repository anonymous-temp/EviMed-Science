# Virtual Clinical Research: Product Alignment Review

Review date: 2026-10-25 (Asia/Shanghai)

Status: review complete; remediation proposed, not implemented.
Disposition: 11 actionable findings; one initial hypothesis (F11) withdrawn
after checking the shared editor.

## 1. Verdict

The owner's concern is materially supported, with one important correction:
Virtual Clinical Research still has its own first-level navigation entry above
Evidence GEO. It has not literally been removed into Research Tools.

The deeper problem is that the most developed and easily exposed product
surface is a statistical-method workbench, while several of the original
virtual-patient and recruitment journeys remain incomplete. A shared method
catalogue is a useful implementation choice; it does not by itself deliver
the promised virtual clinical research platform.

There is substantial working infrastructure worth preserving: persistent
studies and versions, cohorts, generated patient batches, observed external
control estimators, trial simulation, source lineage, access controls,
matching assessments, and recruitment records. This is neither an empty
shell nor a reason to rewrite the platform.

The priority is to complete the user-facing object and workflow chain:

research question → population → virtual patients → comparator → trial design
→ actual candidate review/referral → permitted follow-up and learning.

This review does not reinstate superseded presentation rules, require a return
to four homepage cards, remove the Research Tools catalogue, or relax scientific
and data-access boundaries. It identifies what must work regardless of the
chosen navigation layout.

## 2. Review scope and evidence boundaries

The user requested a detailed audit, recovery of the original intent and plan,
current competitor/academic research, and delegated work using GPT-6.1-sol.

Three read-only agents were used:

- frontend/product trace: GPT-6.1-sol, high reasoning;
- backend/statistical implementation trace: GPT-6.1-sol, xhigh reasoning;
- competitor and academic evidence: GPT-6.1-sol, high reasoning.

The lead reviewed the original conversation commitments, recovered plans,
implementation history, current instructions, and the live product's entry
surfaces. Findings below distinguish live observation, source inspection,
synthetic reproduction, automated tests, and product inference.

### 2.1 Repository snapshot

The inspected checkout was branch main at:

    01e965e99
    2026-10-23T05:09:24Z
    fix(frontier-web): no score tier wears a primary action's solid accent,
    and the operations tag card shows eight rows a list

Existing untracked owner files were preserved. No product code, model,
configuration, permissions, or production data was changed.

### 2.2 Live browser scope

Read-only inspection used an already authenticated Chrome profile, in a new
audit tab. The serving application was at:

    https://82.156.128.153

Observed pages:

- /app/virtual-research
- /app/virtual-research?new=1
- /app/capabilities
- /app/capabilities/methods/patient-outcomes

The accessible account had no VCR studies. Therefore study-internal findings
are based on source, fixture interaction tests, and a synthetic pure-function
reproduction, not a claim that every study journey was executed in production.

Opening the method page only fetched catalog/account/study data and maintained
a browser-local draft. No study was created, no configuration was submitted,
no calculation or paid model run was started, and no patient was contacted.

The inspection did not establish the exact production source revision or
whether additional private disease-model providers were configured. The
October 22 deployment note is historical evidence, not a substitute for a
current deployment identity check.

### 2.3 Test scope

Frontend: 5 files, 204 tests passed, approximately 6.33 seconds. React act
warnings were present. Backend/domain: 5 files, 159 tests passed, 0 skipped.
These 363 checks are scoped tests, not complete numerical, production,
clinical, or usability acceptance.

No full R numerical suite, production scientific job, real-patient evaluation,
database migration, or external model execution was performed.

## 3. Original intent recovered

The conversation's durable product decisions were:

1. A complete first-level platform above GEO, rather than a standalone
   calculator or a single specialist report.
2. Virtual cohorts, virtual patients, synthetic/external controls, and virtual
   trials as the research core.
3. Intelligent recruitment and bidirectional patient-trial matching connected
   to that research core.
4. A general platform rather than a lung-cancer-only application.
5. A partner-specific data restriction: pre-enrollment and post-exit routine
   care available, in-trial treatment/outcomes unavailable.
6. That source restriction must not become a universal limit on customers
   with independently authorized, complete data.
7. Observations, assumptions, generated records, and model predictions must
   remain distinct; scientific limitations are explained without replacing
   usable work with a stub.

The owner explicitly corrected an earlier recruitment-heavy proposal because
the virtual-cohort, synthetic-control, and virtual-patient core had become
subordinate. That correction remains relevant to the present audit.

### 3.1 Recovered documents

| Document | Role in the original scope |
|---|---|
| [September 28 v1 product proposal](/Users/wangzeyuan/Desktop/EviMedScience/docs/superpowers/specs/2026-09-28-virtual-clinical-research-platform-product-plan.md:10) | Four core workspaces; generality; source-specific visibility; complete journeys; 24 acceptance scenarios |
| [September 28 v2 product plan](/Users/wangzeyuan/Desktop/EviMedScience/docs/superpowers/specs/2026-09-28-EviMed虚拟临研平台方案.md:14) | Expanded source-backed plan, four core workspaces, seven-step study, literature parameterization and operational integration |
| [Original v2 mockups](/Users/wangzeyuan/Desktop/EviMedScience/docs/superpowers/specs/2026-09-28-virtual-clinical-research-assets/mockups/SPEC.md) | Home, cohort, individual patient, control, trial, matching, recruitment, models, and package views |
| [September 28 build contract](/Users/wangzeyuan/Desktop/EviMedScience/docs/superpowers/specs/2026-09-28-vcr-build-contract.md:143) | Frontend ownership, first-level placement, four creation actions and seven study tabs |
| [September 29 integration contract](/Users/wangzeyuan/Desktop/EviMedScience/docs/superpowers/specs/2026-09-29-vcr-integration-contract.md:1) | Repairs real seams; separates implementation from deployment and partner acceptance |
| [September 30 status and gaps](/Users/wangzeyuan/Desktop/EviMedScience/docs/superpowers/specs/2026-09-30-vcr-status-and-gaps.md) | Explicit original gaps and distinctions between fixtures, repository checks, deployment, and partner evidence |
| [October 19/20 workflow rectification](/Users/wangzeyuan/Desktop/EviMedScience/docs/superpowers/plans/2026-10-19-workflow-rectification.md:149) | Later usability decisions and acceptance backlog |

The v2 plan is approximately 1,199 lines. It still explicitly states that the
four research workspaces are the main product and that matching/recruitment
follow the selected design. The plan was not lost.

Historical document titles use the former short product name. The current
product name remains “虚拟临床研究”; this review does not propose renaming it.

### 3.2 Which later decisions legitimately supersede the original mockups

Current [OpenScience instructions](/Users/wangzeyuan/Desktop/EviMedScience/OpenScience/AGENTS.md:262)
record the October 20 owner decision:

- VCR home lists studies with one New Study action.
- Methods, reference search, and population templates are contextual tools.
- Research Tools is the shared discovery surface for methods.
- Seven VCR steps remain discoverable, with current/waiting/next state.
- Configuration, progress and results belong together in an analysis workbench.
- Existing objects, scientific function, and project context must be preserved.
- No new approval ceremony or clinical delivery gate is introduced.

Accordingly, the absence of four homepage cards is not by itself an actionable
regression. The test is whether users can complete the four research journeys
and recruitment operations from the new structure.

## 4. How the drift developed

| Period | Verified change | Product implication |
|---|---|---|
| September 28 | v1/v2 define a complete platform and research-object chain | Computational methods are supporting mechanisms |
| September 29–30 | Integration contracts and gap reviews concentrate on typed jobs, numerical engines, provenance and deployment | Necessary engineering work, but not equivalent to complete user journeys |
| October 7 | Commit 75fd16cb7 rewrites homepage tests around one-list presentation and absence of four creation cards | A deliberate reduction in visible research affordances |
| October 20 | Commit 93bd53ea0 introduces the shared calculation workbench | Useful reuse, but study-owned work now traverses a global tools route |
| October 20 | Commit b1d21b22b reconnects research workflows and scoped conversation intake | Evidence that study continuity was intended, not deliberately abandoned |
| October 21–22 | Scoped release follow-ups repair input mapping, job admission, method results and templates | Local workflow fixes do not establish the full original product acceptance |
| October 25 audit | Independent entry persists; source and reproduction reveal patient/operational gaps | Priority should shift from catalogue growth to end-to-end journeys |

This is an evidence-backed interpretation, not a claim about any developer's
intent. The history shows legitimate choices whose combined result was not
reconciled against the full product contract.

### 4.1 Root-cause hypotheses supported by the evidence

**The unit of progress became a method or a passing check.** Method IDs,
schemas, estimators and numerical comparisons are concrete and testable.
The harder question—whether a user can inspect a patient, compare scenarios,
advance a referral and learn from follow-up—received weaker closure criteria.

**Reference simulators became the durable representation of virtual patients.**
Reference simulations are legitimate research tools. The missing step is
turning generated batches into inspectable, scenario-linked virtual-patient
assets, and distinguishing them from a separately validated disease model.

**A successful presentation cleanup removed discovery paths before complete
replacement journeys were in place.** A study-list home can work well. Empty
states that also hide matching directions, sites, follow-up, or prediction
setup make the capability disappear to a new user.

**One partner's restrictions were encoded in a general follow-up contract.**
The data plane remains appropriately source-scoped, but the follow-up pathway
does not consistently preserve that distinction.

**Acceptance has several valid technical layers but an incomplete product
layer.** Green fixture tests and numerical validation are necessary. They do
not show that the intended first-time, cross-role and cross-object journeys
can be completed.

## 5. What is actually present

| Capability | Current source evidence | Audit classification |
|---|---|---|
| Independent VCR product | First-level route, sidebar placement, seven-step study | Present; entry also observed live |
| Persistent research objects | Studies, definitions, assumptions, populations, patient sets, comparators, scenarios, jobs/results and dependencies | Substantial implemented foundation |
| Virtual cohort construction | Real filtering, parameter/literature baselines, empirical synthesis, quality checks and version comparison | Implemented; full study UX still has gaps |
| Virtual patient generation | Four seeded mathematical scenario models; generated record browsing/export | Implemented reference simulation; incomplete individual/trajectory lifecycle |
| Disease/event-history forecasting | Provider adapter and imported predictions with evaluation | Deployment-conditional; private provider availability not checked |
| Observed external controls | Weighting, entropy balance, mean/risk/RMST contrasts, AIPW, MAIC and sensitivity | Real statistical capability |
| Model-predicted comparator | Explicit unsupported status in service/orchestrator | Missing route in the intended core chain |
| Hybrid controls | Historical/robust prior, ESS, conflict and design operating characteristics | Design support implemented; not a complete current-data combined-effect analysis |
| Virtual trial design | Supported fixed, single-arm, sequential and other bounded simulations/grid/assurance methods | Implemented statistical design capability; not a universal disease simulator |
| Bidirectional matching | Criterion evidence, unknown/deferred, trial candidates and ranking | Implemented, with first-use and operational handoff gaps |
| Recruitment operations | Referrals, transitions, site records and enrollment history | Backend foundation; structured UI lifecycle incomplete |
| Follow-up | Stored records and restricted-partner behavior | Read-only presentation and generalized source-policy defect |
| Models and methods | Model metadata, source bindings, model/provider interfaces and method validation | Registry and adapter do not prove a callable validated disease model |

The R engine has **32 dispatched methods** and the Node layer adds **4
longitudinal job kinds**. This is an implementation inventory, not a claim about
how many capabilities real users have completed. The live Research Tools page
showed 52 entries including research capabilities and calculation methods.

Key foundation evidence:

- [Persistent objects](/Users/wangzeyuan/Desktop/EviMedScience/OpenScience/apps/server/src/vcrPersistence.mjs:625)
- [Jobs and results](/Users/wangzeyuan/Desktop/EviMedScience/OpenScience/apps/server/src/vcrJobs.mjs:1519)
- [Method vocabulary](/Users/wangzeyuan/Desktop/EviMedScience/OpenScience/packages/domain/src/vcrEngineJob.mjs:90)
- [R dispatch](/Users/wangzeyuan/Desktop/EviMedScience/项目代码/vcr-engine/R/engine.R:64)
- [Scenario model seeds](/Users/wangzeyuan/Desktop/EviMedScience/OpenScience/apps/server/src/vcrService.mjs:225)

## 6. Detailed findings

P1 below means a significant bug or unfulfilled journey that should be resolved
before claiming that capability is complete. It does not mean all existing
statistical results are unusable. P2 denotes a material context or usability
gap. Scientific-model acquisition/validation is separately identified where
it cannot be solved by UI code alone.

### F01 — Single-patient longitudinal inspection returns only the first visit

**Priority/type:** P1, reproduced functional bug.

The longitudinal engine emits multiple rows per patient. The single-patient
reader uses the first matching row, and its trajectory builder recognizes
potential-outcome columns rather than aggregating longitudinal visits.

A synthetic in-memory patient with visits containing outcomes 10, 11 and 12
returned only the first visit and trajectories:null. No private data or
production job was involved.

- [Longitudinal output](/Users/wangzeyuan/Desktop/EviMedScience/项目代码/vcr-engine/R/longitudinal.R:242)
- [First-row selection](/Users/wangzeyuan/Desktop/EviMedScience/OpenScience/apps/server/src/vcrRows.mjs:403)

**Impact:** the original promise “inspect a virtual patient's trajectory” fails
even when longitudinal results have been generated.

**Acceptance:** one patient with multiple visits, missing observations and
exit/censoring information retains all appropriate dated records and renders a
complete trajectory; no first row is presented as the entire patient.

### F02 — Model-predicted controls are explicitly unsupported

**Priority/type:** P1, core capability gap, not evidence that the existing
external-control estimators are fake.

The model_comparator route is labeled unsupported in the service and
orchestrator. Registering a disease-model card cannot complete this route.

- [Service route](/Users/wangzeyuan/Desktop/EviMedScience/OpenScience/apps/server/src/vcrService.mjs:419)
- [Orchestrator refusal](/Users/wangzeyuan/Desktop/EviMedScience/OpenScience/apps/server/src/vcrOrchestrator.mjs:737)

**Impact:** the model → virtual patient → model comparator → trial-design chain
is not a complete supported workflow.

**Acceptance:** an explicit, scoped model prediction can become a versioned
comparator scenario with source/model uncertainty and traceability. An
incompatible or unvalidated use remains clearly limited; simply deleting an
unsupported flag would not be a scientific implementation.

Keep observed external controls, model comparators, hybrid borrowing and
randomized prognostic adjustment separately named.

### F03 — Virtual-patient identity and model outputs do not yet form a unified asset lifecycle

**Priority/type:** P1 for the broken model-to-study chain; P2 for cross-scenario
identity design.

Patient sets are persistent batches with records and downloads; it would be
wrong to say there are no virtual-patient assets. However generated IDs include
the job ID, so a new scenario/run changes identity even with the same seed.
There is no equivalent stable member mapping demonstrated across scenarios.

Event-history forecasts are saved as separate longitudinal artifacts rather
than the patient-set table/result. Design conversion is separate and currently
limited to fixed continuous/binary cases, with parameter uncertainty explicitly
not estimated.

- [Generated identities](/Users/wangzeyuan/Desktop/EviMedScience/项目代码/vcr-engine/R/engine.R:820)
- [Patient-record access](/Users/wangzeyuan/Desktop/EviMedScience/OpenScience/apps/server/src/vcrRecords.mjs:195)
- [Separate prediction result handling](/Users/wangzeyuan/Desktop/EviMedScience/OpenScience/apps/server/src/vcrOrchestrator.mjs:1069)
- [Design conversion limits](/Users/wangzeyuan/Desktop/EviMedScience/OpenScience/apps/server/src/vcrLongitudinal.mjs:335)

**Acceptance:** inspect a saved cohort member, create scenario A/B predictions,
retain explicit member correspondence and provenance, and reuse the selected
prediction in a supported study design. Common random numbers are not an
identity model and do not prove an individual's real counterfactual.

### F04 — The first-use prediction route is hidden, and a read error can look like absence

**Priority/type:** P1, discoverability/error-propagation defect.

The prediction/longitudinal view is shown only when ready data already contains
records. The setup/import controls live inside that view. A longitudinal read
error does not have an equivalent visible error/retry state in the parent.

- [Parent visibility](/Users/wangzeyuan/Desktop/EviMedScience/OpenScience/apps/web/src/components/vcr/tabs/PatientsTab.tsx:76)
- [Panel visibility](/Users/wangzeyuan/Desktop/EviMedScience/OpenScience/apps/web/src/components/vcr/VcrLongitudinalPanel.tsx:34)
- [Setup actions](/Users/wangzeyuan/Desktop/EviMedScience/OpenScience/apps/web/src/components/vcr/VcrLongitudinalPanel.tsx:115)
- [Test asserting hidden state](/Users/wangzeyuan/Desktop/EviMedScience/OpenScience/apps/web/src/components/vcr/tabs/PatientsTab.test.tsx:494)

**Acceptance:** a new study can discover the prediction workflow, understand
which input/model is missing, and reach setup. Uninitialized, unavailable,
unauthorized and failed retrieval states are distinguishable.

### F05 — A new matching view hides directions, referrals, sites and follow-up

**Priority/type:** P1, first-use journey gap.

When the initial matching view has no results, its bare state removes the
toolbar containing these navigation choices. The user must first produce other
data to discover the broader operational product.

- [Visibility condition](/Users/wangzeyuan/Desktop/EviMedScience/OpenScience/apps/web/src/components/vcr/tabs/MatchingTab.tsx:167)
- [Toolbar rendering](/Users/wangzeyuan/Desktop/EviMedScience/OpenScience/apps/web/src/components/vcr/tabs/MatchingTab.tsx:218)
- [Tests fixing that absence as expected](/Users/wangzeyuan/Desktop/EviMedScience/OpenScience/apps/web/src/components/vcr/tabs/RecruitTabs.test.tsx:432)

**Acceptance:** an empty study can discover both matching directions, site
setup, referral tracking and follow-up, with useful prerequisite explanations
and actions. This does not require displaying irrelevant empty tables.

### F06 — Recruitment, site and follow-up views do not complete the operational lifecycle

**Priority/type:** P1, product completion gap.

The recruitment ledger is a table without the full progression actions.
Site and follow-up views are read-only projections. An empty site table refers
to registering a site without giving a registration path in that view.
Follow-up lacks a complete interface for observation windows, exposure/outcome
records, missingness, loss to follow-up and pending tasks.

- [Recruitment ledger](/Users/wangzeyuan/Desktop/EviMedScience/OpenScience/apps/web/src/components/vcr/tabs/MatchingTab.tsx:631)
- [Sites](/Users/wangzeyuan/Desktop/EviMedScience/OpenScience/apps/web/src/components/vcr/tabs/MatchingTab.tsx:748)
- [Follow-up](/Users/wangzeyuan/Desktop/EviMedScience/OpenScience/apps/web/src/components/vcr/tabs/MatchingTab.tsx:818)

Backend transitions exist and should be reused. The finding is not that all
records or APIs are missing.

**Acceptance:** an authorized coordinator can select/record a destination,
assign ownership, resolve evidence requests, record site response, screening,
enrollment or a specific closure reason, and create permitted post-exit
follow-up observations/tasks. Each event has a responsible party and timestamp.

A contactReferral action updates records and audit state; it is not proof of
message delivery. Preserve manual contact confirmation and any actual outbound
delivery receipt as different facts.
[Contact implementation](/Users/wangzeyuan/Desktop/EviMedScience/OpenScience/apps/server/src/vcrContact.mjs:159).

### F07 — Matching does not bridge every supported data source and direction into recruitment

**Priority/type:** P1, cross-object integration gap.

Automatic referrals after matching use current-study protocol document
candidates and explicitly exclude subject_table candidates. Patient-to-external-
trial matching has candidate trials and ranking, but the referral record links
to the study's matching assessments without a corresponding candidate-trial
association.

- [Referral creation condition](/Users/wangzeyuan/Desktop/EviMedScience/OpenScience/apps/server/src/vcrComposition.mjs:828)
- [External trial candidates](/Users/wangzeyuan/Desktop/EviMedScience/OpenScience/apps/server/src/vcrPatientTrials.mjs:304)
- [Referral schema](/Users/wangzeyuan/Desktop/EviMedScience/OpenScience/apps/server/src/vcrPersistence.mjs:1227)

**Acceptance:** test document and table patients separately; test study-to-
patient and patient-to-external-trial routes separately. Appropriate candidates
can become permission-scoped operational cases tied to the correct trial and
site, without treating a match as consent or enrollment.

### F08 — A partner-specific restricted period is generalized in the follow-up contract

**Priority/type:** P1, contract-generalization defect.

The original plan restricted a particular partner's in-trial information.
The general study_specific follow-up path rejects treatment, outcome,
randomization_arm, progression_date and last_dose_date and requires exit date/
reason, without a source/policy argument.

- [Original partner-specific scope](/Users/wangzeyuan/Desktop/EviMedScience/docs/superpowers/specs/2026-09-28-virtual-clinical-research-platform-product-plan.md:579)
- [Gateway field restrictions](/Users/wangzeyuan/Desktop/EviMedScience/OpenScience/apps/server/src/vcrGateway.mjs:1658)
- [Follow-up handling](/Users/wangzeyuan/Desktop/EviMedScience/OpenScience/apps/server/src/vcrRecruit.mjs:701)
- [Source-scoped data access that should remain](/Users/wangzeyuan/Desktop/EviMedScience/OpenScience/apps/server/src/vcrAccess.mjs:244)

**Impact:** a future fully authorized study cannot use the general follow-up
path for data that its source contract permits.

**Acceptance:** the existing restricted partner remains restricted; a distinct
fully authorized source can record its permitted treatment/outcomes with
provenance. No existing grant is expanded. Participant exit is still distinct
from readout.

### F09 — Model registration, callable execution and scientific validation remain easy to conflate

**Priority/type:** P1 for product claims and completion tracking; partly a data/
model programme requirement rather than a local code bug.

There are four seeded scenario simulators, not four validated disease models.
Literature-model intake binds values to reference simulation profiles; it does
not generally fit a published model's equations. Knowledge packages provide
terminology/definitions and are not outcome models. The event-history provider
requires configuration. Mechanistic package validation is not a PBPK/QSP
execution environment.

- [Scenario seeds](/Users/wangzeyuan/Desktop/EviMedScience/OpenScience/apps/server/src/vcrService.mjs:225)
- [Literature model bindings](/Users/wangzeyuan/Desktop/EviMedScience/OpenScience/apps/server/src/vcrModelSources.mjs:8)
- [Knowledge packages](/Users/wangzeyuan/Desktop/EviMedScience/OpenScience/packages/domain/src/vcrKnowledgePackData.mjs:22)
- [Provider dependency](/Users/wangzeyuan/Desktop/EviMedScience/OpenScience/apps/server/src/vcrForecastProvider.mjs:13)
- [Mechanistic package check](/Users/wangzeyuan/Desktop/EviMedScience/项目代码/vcr-engine/R/population.R:701)

**Acceptance:** distinguish registered metadata, evidence-parameterized
simulation, callable predictor, imported predictions, and independently
validated scoped model. Show available inputs and allowed outputs at the
point of use, without presenting an absent provider as a functioning model.

Generic reference simulations remain valuable. Clinical model expansion can
use mature upstream libraries, external services or partner models; do not
assume that a new custom model must be trained for the UI to be useful.

### F10 — A study-owned calculation visually becomes Research Tools

**Priority/type:** P2, context continuity defect.

Study tools navigate to the global method route with study context preserved.
The workbench retains study information, but sidebar active-state logic follows
the path prefix. The user is visually moved from VCR into Research Tools while
working on the study.

- [Study method links](/Users/wangzeyuan/Desktop/EviMedScience/OpenScience/apps/web/src/components/vcr/VcrStudyMethods.tsx:21)
- [Workbench context](/Users/wangzeyuan/Desktop/EviMedScience/OpenScience/apps/web/src/app/routes/VcrMethodWorkbenchPage.tsx:66)
- [Sidebar active state](/Users/wangzeyuan/Desktop/EviMedScience/OpenScience/apps/web/src/components/sidebar/Sidebar.tsx:106)

**Acceptance:** standalone calculations keep their global tools identity;
study-bound calculations keep the study's identity, inputs, current step and
return path. Reuse the same calculation component and service rather than
forking two implementations.

### F11 — Withdrawn: structured cohort editing was initially overlooked

This is **not an actionable finding**. The initial reviewer inspected the
numeric shortcut drawer but not the shared cohort.build editor. The lead
requested a targeted follow-up before finalizing the report.

The shared editor supports rule arrays, adding/removing rules, all/any child
rules, not recursion, columns, comparison operators and typed values,
between/in/not_in, and scenario fields for time zero, exit and a second set
of comparison rules.

- [Method form integration](/Users/wangzeyuan/Desktop/EviMedScience/OpenScience/apps/web/src/components/vcr/VcrMethodRunner.tsx:273)
- [Rule arrays](/Users/wangzeyuan/Desktop/EviMedScience/OpenScience/apps/web/src/components/vcr/VcrScenarioEditor.tsx:52)
- [Structured rule controls](/Users/wangzeyuan/Desktop/EviMedScience/OpenScience/apps/web/src/components/vcr/VcrScenarioEditor.tsx:95)
- [Cohort scenario schema](/Users/wangzeyuan/Desktop/EviMedScience/OpenScience/packages/domain/src/vcrScenarioSchemas.mjs:420)

These are structured controls, not a requirement to type raw JSON. This
does not establish arbitrary clinical temporal-expression support, but it
does disprove the broad claim that a structured cohort editor is absent.
Any contextual entry improvement belongs under F10 and should reuse this
implementation.

### F12 — Technical acceptance is not closing the original product contract

**Priority/type:** P1 release-acceptance gap; not an allegation that tests have
no value.

Existing tests verify many useful behaviors. Some also explicitly assert that
navigation/prediction controls are absent in empty states. Those assertions
make a narrower interface green without proving first-use discoverability.

The historical September 30 gap document already separates repository checks,
fixtures, release-time acceptance and partner-data evidence. Later scoped
release acceptance still documents uncovered cases.

- [Frontend fixture boundary](/Users/wangzeyuan/Desktop/EviMedScience/OpenScience/apps/web/src/components/vcr/__fixtures__/serverFixtures.ts:4)
- [No-results operational navigation test](/Users/wangzeyuan/Desktop/EviMedScience/OpenScience/apps/web/src/components/vcr/tabs/RecruitTabs.test.tsx:463)
- [Historical acceptance limits](/Users/wangzeyuan/Desktop/EviMedScience/docs/superpowers/specs/2026-09-30-vcr-status-and-gaps.md)
- [Latest scoped closure](/Users/wangzeyuan/Desktop/EviMedScience/docs/superpowers/plans/2026-10-19-workflow-rectification.md:349)

**Acceptance:** add connected first-use, multi-visit, multi-scenario, cross-role,
data-source-specific and operational journeys. Keep existing numerical and
security tests. Do not weaken them or count fixture renders as clinical proof.

## 7. Competitor evidence: the missing product unit is the workflow

These are descriptions from official public materials, not access to private
vendor applications or independent confirmation of marketing outcomes.

| Product | Publicly documented unit of work | Consequence for this review |
|---|---|---|
| Unlearn TrialPioneer | Scientific precedent → historical patient data → design scenarios with linked assumptions | A collection of formulas is not equivalent to a saved design decision |
| Unlearn disease models | Patient-conditioned longitudinal forecasts, with distinct randomized adjustment and external-control uses | Virtual patients need identifiable baselines, horizons, trajectories and validation scope |
| Formation Bio Muse | Disease/population research → recruitment strategy → materials/questionnaires → iterative review | Recruitment strategy and materials have value, but are not patient-level matching or enrollment |
| Formation project memory | Decisions, evidence and results captured during work | Store why a scenario was selected and how subsequent evidence changed it |
| Paradigm | Patient evidence → eligibility review → navigation → site screening/enrollment workflow | The ledger must support action, ownership, missing evidence and actual progression |
| Medidata SCA | Historical real patient-level trial data used to construct matched comparators | Synthetic-control branding does not imply all patients were generated |
| TriNetX institutional use | Cohort discovery, eligibility feasibility, site/patient availability and outcomes | Population tools serve a research/recruitment decision, not just descriptive counts |

Sources:

- [Unlearn product explanation, 2026-04-01](https://www.unlearn.ai/blog/we-listened-to-sponsors-heres-what-we-built)
- [Unlearn statistical/regulatory distinction, 2026-10-08](https://www.unlearn.ai/blog/built-on-regulatory-rigor-advancing-digital-twins-in-clinical-trials)
- [Unlearn collaboration model](https://www.unlearn.ai/solutions/clinical-trial-assessment)
- [Formation Muse launch](https://www.formation.bio/press/introducing-muse)
- [Formation workflow and institutional memory](https://www.formation.bio/blog/building-an-ai-native-pharma-company)
- [Paradigm matching and recruitment workflow](https://www.paradigmhealth.ai/solutions/patient-identification-trial-enrollment)
- [Paradigm Matcha technical implementation](https://www.paradigmhealth.ai/resources/matcha-end-to-end-platform-for-enterprise-ai-tech)
- [Medidata synthetic control product](https://www.medidata.com/en/study-experience/real-world-data/synthetic-control-arm/)
- [Penn's TriNetX use description](https://www.cceb.upenn.edu/clinicalresearch/trinetx.html)

The common lesson is not to imitate every vendor's infrastructure. It is to
organize work around a research object and decision, using established methods
inside that workflow. EviMed should keep its existing engine, source pipelines,
run records, domain contracts, and native agent integration where they fit.

## 8. Academic and regulatory evidence

### 8.1 Virtual patients and control construction

[Schuler and colleagues' prognostic-adjustment paper](https://pubmed.ncbi.nlm.nih.gov/34957728/)
supports using an externally trained prognostic score within a real randomized
trial under its stated conditions. This improves precision; it does not turn
a predicted patient's outcome into an observed treatment effect.

The [EMA PROCOVA qualification opinion](https://www.ema.europa.eu/en/documents/regulatory-procedural-guideline/qualification-opinion-prognostic-covariate-adjustment-procovatm_en.pdf)
is scoped to the specified continuous-endpoint randomized-trial setting.
It is not approval of every digital-twin model, disease, or endpoint.

Unlearn's [October 8, 2026 explanation](https://www.unlearn.ai/blog/built-on-regulatory-rigor-advancing-digital-twins-in-clinical-trials)
itself distinguishes randomized prognostic adjustment from single-arm model
controls, notes the absence of a built-in unbiasedness guarantee for the latter,
and describes the broader regulatory pathway as still developing.

The [2026 single-arm digital-twin preprint](https://arxiv.org/html/2605.12832v1)
combines outcome modeling and propensity-based adjustment and reports
retrospective analyses. It does not remove the need for comparability, overlap,
confounding assumptions or external validation.

**Product implication:** preserve model-based research as a named core path,
show its actual scope and maturity, and implement its object chain. Do not
pretend a mathematical scenario is a disease-validated model, or reject the
entire product because universal counterfactual validity is unavailable.

### 8.2 Research design precedes method selection

[Hernan and Robins' target-trial framework](https://pmc.ncbi.nlm.nih.gov/articles/PMC4832051/)
defines eligibility, treatment strategies, assignment, follow-up, outcomes,
causal contrast and analysis. Selecting weights and an effect estimator is
only part of that design.

The [RCT-DUPLICATE study, FDA-hosted JAMA article](https://www.fda.gov/media/170837/download)
evaluated 32 selected trials using protocols registered before analysis.
Agreement depended on how closely the real-world data could emulate the trial.
Its more favorable subgroup analysis was post hoc and cannot be generalized
into a claim that database comparisons universally replace randomized trials.

The [FDA external-control guidance page](https://www.fda.gov/regulatory-information/search-fda-guidance-documents/considerations-design-and-conduct-externally-controlled-trials-drug-and-biological-products)
remained draft at this review. It supports careful design/data assessment,
not a universal calculator-to-regulatory-evidence shortcut.

**Product implication:** a study workspace should carry its estimand, cohort,
time zero, outcome definition and assumptions into each method. A technically
correct calculation with the wrong comparison is not a complete research result.

### 8.3 Matching evidence is not the same as enrollment evidence

[TrialGPT, Nature Communications 2024](https://www.nature.com/articles/s41467-024-53081-z)
evaluated synthetic patient cases and criterion-level judgments, with a
screening-time user study. Its reported accuracy/time savings are not evidence
that a live service increased enrollment by those percentages.

[MatchMiner, npj Precision Oncology 2022](https://www.nature.com/articles/s41698-022-00312-5.pdf)
reported real clinical use and trial-consent events. The time comparison was
observational; consent, screening and formal enrollment remain distinct.

[The 2025 prospective molecular-tumor-board evaluation](https://www.nature.com/articles/s41698-025-00806-y)
assessed 157 sequential patients and found substantial eligibility and
recruitment-status errors in the evaluated tools. This is not an estimate of
all contemporary AI systems, but it supports local prospective workflow testing.

**Product implication:** evaluate criterion evidence, shortlist quality,
human review time, referral acceptance, screening and actual enrollment
separately. A matched patient row is the beginning of an operational journey.

### 8.4 Data restrictions are source-specific

The existing partner's inaccessible trial period must remain inaccessible.
Post-exit routine-care data can support an appropriately defined new
observation episode, not reconstruction of hidden treatment or original
trial outcomes.

This does not prevent other authorized datasets or scoped external models
from supporting other workflows. The
[FDA EHR data guidance](https://www.fda.gov/media/152503/download)
frames fitness around population, exposure, outcomes, covariates, time and
traceability. It does not justify hard-coding one partner's visibility policy
into every follow-up record.

## 9. Evidence-based target product

The target remains the original general VCR product, with later valid
presentation decisions preserved.

### 9.1 One study, connected research objects

The study should make these objects and their relationship visible:

    Study question and protocol version
        -> population version
        -> virtual patient set and trajectories
        -> comparator design
        -> trial scenarios and comparisons
        -> selected operational protocol
        -> patient matching and referral cases
        -> permitted observations and decision history

Supporting evidence and assumptions are attached throughout. The seven-step
study structure can continue to represent this chain.

### 9.2 Methods remain reusable, with two contexts

- A person who only needs a calculation can open Research Tools.
- A person inside a study uses the same method component with the study's
  saved inputs, selected versions, outputs and next action.

The method catalogue need not be deleted or duplicated. Study identity should
remain visible when a contextual method happens to use a shared route.

### 9.3 Core research outcomes

| Workspace | Minimum complete user outcome |
|---|---|
| Cohorts | Define and version a target population; inspect inclusion, exclusion, unknowns and composition; reuse it downstream |
| Virtual patients | Inspect one member's full supported trajectory; compare scenarios with explicit member correspondence; save and reuse predictions |
| Controls | Select an appropriate route and data; inspect comparability; obtain an estimate or an actionable not-estimable result |
| Trials | Compare multiple saved designs using declared assumptions and uncertainty; select with rationale; export a reproducible package |
| Matching/recruitment | Evaluate both directions; resolve evidence; advance an authorized case to the appropriate site and record actual outcome |
| Follow-up | Define an authorized observation episode, collect its permitted data and track missingness/tasks |

These are acceptance outcomes, not a mandate to copy the September mockup
layout or introduce a new global workflow engine.

### 9.4 Model availability must be explicit without creating a new delivery veto

Use factual distinctions:

- mathematical reference scenario;
- literature-parameterized scenario;
- callable external or local predictor;
- imported prediction results;
- independently validated model for a declared context.

Allow research to proceed with supported inputs and appropriately labeled
scope. Preserve usable partial artifacts and explain missing capabilities.
Do not create a new blanket approval process or withhold every output because
one model or dataset is unavailable.

## 10. Recommended correction sequence

### Track A — Repair the concrete research and operational breaks

1. Fix longitudinal patient record aggregation and add multi-visit cases.
2. Make first-use prediction, matching directions, sites and follow-up
   discoverable; preserve explicit unavailable/error states.
3. Reconnect the existing structured cohort editor to the population workflow
   and verify versioned changes; do not rebuild an editor that already exists.
4. Complete the recruitment/site/follow-up UI using existing records and APIs.
5. Bridge table candidates and external-trial matches into the correct
   permission-scoped operational cases.
6. Apply follow-up visibility through source policy rather than one global
   restricted-partner rule.

### Track B — Complete the core model/patient/comparator chain

1. Define stable correspondence for virtual members across saved scenarios.
2. Connect patient sets, longitudinal forecasts, comparator designs and
   supported trial-design conversions with explicit provenance.
3. Implement and validate the supported model-comparator research path;
   preserve scientific limits rather than merely changing a flag.
4. Separate design-phase Bayesian borrowing from actual combined analysis.
5. Complete provider configuration/readiness and model evidence at the point
   of use; do not count a catalogue card as an executable clinical model.

This track may require external data/model cooperation. That dependency should
be recorded per capability, not used to hide the entire research workspace.

### Track C — Restore study ownership in presentation

1. Keep independent VCR navigation and current approved naming.
2. Keep one New Study action if that remains the preferred presentation.
3. Make the study's research objects and next achievable action explicit.
4. Keep study-bound calculations visually inside their study context.
5. Retain standalone Research Tools for independent calculations.

Restoring four homepage cards alone would not close any of the principal
patient/model/operational defects.

### Track D — Replace completion-by-inventory with journey acceptance

Retain numerical, security and contract tests. Add the journeys in section 11
as release evidence. Do not expand the method inventory as the primary next
milestone unless a missing method is required by one of those journeys.

Do not change scientific result states or quality rules merely to produce
green UI demonstrations.

## 11. Acceptance journeys for the correction

| ID | Journey | Required evidence |
|---|---|---|
| J1 | Fresh study -> accessible synthetic demonstration data -> AND/OR/time-window/unknown criteria -> cohort v1 -> change -> v2 -> comparison/export | Persistent versions, truthful counts and reusable cohort |
| J2 | Saved cohort -> generated longitudinal patients -> inspect one person's complete visits -> scenario A/B -> explicit member comparison | All visits, uncertainty and identity/lineage preserved |
| J3 | Study -> choose observed external control -> map treatment/outcome/time zero -> configure method -> diagnostics -> sensitivity -> result | No loss of study context; reproducible comparison or specific limitation |
| J4 | Evidence parameters -> two trial scenarios -> run -> inspect precision/MCSE -> change one assumption -> compare -> record selection -> package | Input/result versions agree and decision is saved |
| J5 | Empty study -> discover both matching directions -> document and table patients -> criterion evidence -> candidate trial | Useful empty states and no unknown-to-negative coercion |
| J6 | Candidate -> authorized contact record -> site referral -> response -> screening -> enrollment/closure | Correct trial/site association and real event semantics |
| J7 | No existing matching results -> register/update site -> assign follow-up task -> post-exit observation | Operations can be initialized rather than only viewed after data exists |
| J8 | Restricted partner plus separate fully authorized source | First remains restricted; second records permitted treatment/outcomes; grants unchanged |
| J9 | Registered metadata, unconfigured provider, callable provider and imported forecasts | Distinct states, actionable failures, no substituted reference result |
| J10 | Completed work -> source/protocol/model change -> affected results stale -> targeted rerun -> recovery/export | Traceable reuse, controlled cache behavior and no lost history |

J1/J2/J4 can begin with explicitly labeled synthetic/reference scenarios.
Real clinical validation remains separate and is required for the corresponding
clinical prediction claims. Recruitment performance requires real partner/site
feedback; it cannot be inferred from fixture-generated enrollment states.

## 12. Preserve, reconnect, and avoid

### Preserve

- Existing persistent studies and typed/versioned research objects.
- Mature numerical methods and their numerical acceptance work.
- Source-aware access, restricted intervals and outcome sealing where applicable.
- Value provenance and separate counts for real, reconstructed and generated data.
- Unknown/deferred matching, source evidence and temporal filtering.
- Partial results, not-estimable findings and advisory review.
- Existing DSH integration, general-purpose platform behavior and shared methods.

### Reconnect

- Virtual member, trajectory, scenario, comparator and design lineage.
- Study identity across shared tool routes.
- Matching evidence and the correct operational case.
- Site/referral/follow-up records and their user actions.
- Model catalogue, execution interface and evidence of applicability.
- Original acceptance commitments and current release evidence.

### Avoid

- Deleting validated methods to make the product appear less computational.
- Calling a collection of methods a complete virtual-patient platform.
- Adding more disease labels without model or data evidence.
- Automatically inferring inaccessible treatments/outcomes.
- Treating generated samples as new independent clinical observations.
- Using the existing partner's limitations as a permanent universal restriction.
- Building another agent kernel, workflow engine, or duplicated calculator UI.
- Adding new approval ceremonies or withholding usable research because of
  unrelated unavailable functionality.

## 13. Live evidence

These captures are from the audit's read-only browser session. They show the
accessible account and should be treated as internal audit artifacts, not
published marketing screenshots.

### 13.1 Independent entry still exists

The VCR entry is visibly above Evidence GEO. The account had no VCR studies.

![Live VCR home](/Users/wangzeyuan/Desktop/EviMedScience/docs/ui-ux-audit/2026-10-25-vcr-product-alignment/live-vcr-home.png)

### 13.2 New study is a question-led entry

The form offers study design, literature planning and existing-data analysis.
It defaults to defining the study, with an option to advance the full workflow.
Nothing was submitted.

![New study form](/Users/wangzeyuan/Desktop/EviMedScience/docs/ui-ux-audit/2026-10-25-vcr-product-alignment/live-new-study.png)

### 13.3 Calculation methods are prominently discoverable in Research Tools

The live catalogue showed seven calculation task groups, alongside other
research capabilities. This supports the user's observation about tool
placement, but not a claim that the VCR module was deleted.

![Research Tools](/Users/wangzeyuan/Desktop/EviMedScience/docs/ui-ux-audit/2026-10-25-vcr-product-alignment/live-research-tools.png)

### 13.4 Patient simulation opens as an explicit numerical workbench

The default binary view asks for group sizes and outcome/effect assumptions.
The selector also supports continuous, longitudinal and event-time variants;
all four options were verified enabled in the DOM. An accessibility snapshot
initially described options as disabled, so that description was not used as
evidence of a product defect.

![Patient-outcome workbench](/Users/wangzeyuan/Desktop/EviMedScience/docs/ui-ux-audit/2026-10-25-vcr-product-alignment/live-patient-outcome-method.png)

The longitudinal variant requests visit times and individual/measurement
assumptions. This is a valid mathematical simulator; it does not prove the
individual-patient inspection or disease-model journeys are complete.

![Longitudinal configuration](/Users/wangzeyuan/Desktop/EviMedScience/docs/ui-ux-audit/2026-10-25-vcr-product-alignment/live-longitudinal-method.png)

## 14. Reproduction and commands

### 14.1 Frontend checks

Working directory: /Users/wangzeyuan/Desktop/EviMedScience/OpenScience

    pnpm --filter @ai4s/web exec vitest run \
      src/app/virtual-research/VcrHomePage.test.tsx \
      src/components/vcr/StudyFrame.test.tsx \
      src/components/vcr/tabs/PatientsTab.test.tsx \
      src/components/vcr/tabs/RecruitTabs.test.tsx \
      src/components/sidebar/Sidebar.test.tsx

Observed result: 5 files passed, 204 tests passed, approximately 6.33 seconds.
React act warnings were retained.

### 14.2 Backend/domain checks

Working directory: /Users/wangzeyuan/Desktop/EviMedScience/OpenScience

    node --test --test-reporter=spec \
      packages/domain/test/vcrEngineJob.test.mjs \
      packages/domain/test/vcrLongitudinal.test.mjs \
      apps/server/test/vcrService.test.mjs \
      apps/server/test/vcrRecruit.test.mjs \
      apps/server/test/vcrMatching.test.mjs

Observed result: 159 tests passed, 0 failed, 0 skipped. These use domain/pure
function and service-mock boundaries, not the complete R or production stack.

### 14.3 Synthetic longitudinal reproduction

The backend reviewer executed the following pure in-memory case. It uses no
patient data and makes no network or persistence calls.

    node --input-type=module <<'NODE'
    import { patientRecord } from '/Users/wangzeyuan/Desktop/EviMedScience/OpenScience/apps/server/src/vcrRows.mjs';

    const headers = ['patientId', 'arm', 'visit', 'time', 'y'];
    const table = {
      columns: headers.map((key, index) => ({
        key,
        index,
        kind: key === 'patientId' ? 'text' : 'number',
        missing: 0,
      })),
      rows: [
        ['vp_fixture', '0', '1', '0', '10'],
        ['vp_fixture', '0', '2', '1', '11'],
        ['vp_fixture', '0', '3', '2', '12'],
      ],
    };
    console.log(JSON.stringify(patientRecord(table, 'vp_fixture'), null, 2));
    NODE

Observed: only visit 1 / time 0 / y 10 is retained as the inspected record;
position and trajectories are null. The intended individual longitudinal
view should retain all three visits.

## 15. Review conclusion and handoff

The product direction should be restored through the original research
objects and clinical-research journeys, using the substantial existing
implementation.

The strongest immediate evidence is a concrete trajectory-reading bug,
an unsupported model-comparator route, hidden first-use paths, incomplete
operational interaction, and a source-policy restriction generalized beyond
its original partner. These are more consequential than whether the home has
one button or four cards.

Before the next implementation iteration, use the 11 actionable findings
F01–F10 and F12, together with journeys J1–J10, as the correction contract.
F11 remains in this record only to explain the withdrawn hypothesis.
The user requested review in this turn;
no product modification or deployment has been performed. This report and
its captures are the review deliverables.

## 16. Subsequent owner scope change

After this audit, the owner explicitly removed recruitment/OA operations and
required conversation-first execution of research tools. See
[the current product reset](/Users/wangzeyuan/Desktop/EviMedScience/docs/superpowers/specs/2026-10-25-vcr-ai-native-product-reset.md).

The findings remain a record of the audited implementation, but recommendations
to finish referral, site CRM and follow-up task workflows are superseded.
Retire those workflows and their side effects instead. Patient matching,
scientific longitudinal data, core research objects and their validation remain.
J6/J7 are no longer future product acceptance requirements; source-specific
access in J8 still applies to retained research data.
