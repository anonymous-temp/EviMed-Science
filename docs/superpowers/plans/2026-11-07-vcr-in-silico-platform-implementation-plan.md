# In Silico Clinical Research Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Resolve these names to the installed equivalents when the namespace differs. Steps use checkbox (`- [ ]`) syntax for tracking. This document is an implementation specification, not an instruction to start training, purchase services, change production data, or deploy.

**Goal:** Deliver five understandable research entrances around reusable populations, batch patient forecasts, intervention experiments and comparison evidence, with patient matching owned by the separate workstream.

**Architecture:** Retain DSH + DeepSeek as the general execution foundation and the existing independently installable professional plugins, authorized object references, durable jobs and scientific engines. Add explicit population readiness, model use contexts and immutable experiment definitions; disease-specific mechanistic and learned transition models supply scientific behavior. Open-domain questions compose only the needed operations, while the interface presents the selected research object and its results.

**Tech Stack:** Existing React/TypeScript frontend, Node control plane, domain contracts, PostgreSQL persistence, DSH plugins and R engine; versioned executable external/open-source model adapters; a separately evaluated Python training package for temporal models when its data and resource prerequisites are met.

**Date:** 2026-11-07 (Asia/Shanghai).
**Source baseline inspected:** `d74ccaaf22294e10e2b08b4f0c667f7b38786086`, branch `codex/vcr-professional-plugins-20261105`.
**Review revision:** Revised against the owner-supplied review and source at `ef87999fd` on 2026-11-07.
**Status:** Executed 2026-11-07/08 on branch `codex/vcr-in-silico-20261107` (not merged to main, not deployed); see section 17 for what each task delivered and what stays open. The checkboxes below are the original specification; section 17 is the record. Earlier source/runtime qualifications remain tied to their recorded revisions. This inspection did not establish the current production revision or the matching branch revision.

---

## Review decisions (2026-11-07)

The four principal changes are adopted: execute technically runnable exploratory models with explicit premises; reuse existing model contracts and numerical reference tests; prioritize an Alzheimer drug-disease-trial implementation over PBPK; and ship bounded trial-design search before disease-model integration. The following corrections keep that adoption evidence-based:

- The existing mechanism contract declares five allowed solver identifiers; it does not install those solvers or prove a model can execute. The inspected runtime lock has 70 packages and none of those five solvers.
- A logit mean curve is not by itself the complete C-Path model or a beta-regression observation model. Rogers 2012/C-Path uses ADAS-cog; Jamalian 2023 uses CDR-SB and has a different model. Parameter tables, covariance/random effects, placebo/treatment effects and dropout must be reproduced separately.
- The October 25–26 owner ruling explicitly superseded the older mandatory seven-step presentation. Preserve `VCR_STEPS` for internal/historical compatibility; do not restore a mandatory seven-step rail beside five entrances.
- The November 4 160-character provenance defect has a subsequent full-original-message reader and regression tests. Keep that regression and the reader's explicit size/page limits; do not report that every current user question is stored only as 160 characters.
- Historical network-meta routing and completion failures remain acceptance cases. Later native/plugin runs show progress; the surviving cold-runtime completion limitation is still open. Neither old small-sample failures nor later execution success establish universal routing reliability.
- OSPSuite requirements are version-dependent. The [inspected upstream development README](https://raw.githubusercontent.com/Open-Systems-Pharmacology/OSPSuite-R/develop/README.md) names R >=4.4, rSharp and .NET 10; the linked Ubuntu wiki describes an older stack. Do not pin the review's .NET 8/Ubuntu 22.04 statement as an immutable current requirement. PBPK remains deferred pending an exact-version/image cost decision.

This review updates the implementation target and owner-rule documents only. It does not implement the target or change production behavior.

## 1. Owner decisions and scope

1. The five public entrances are **Virtual Population**, **Patient Trajectory Prediction**, **Virtual Laboratory**, **Synthetic Control Arm**, and **Patient Matching**. Chinese UI labels are specified in section 3.
2. Research records join the lower research/conversation history. They are not a sixth professional entrance. Keep durable studies, saved objects and result versions underneath that presentation.
3. A batch of 100 patients is an ordinary prediction input. Individual-level prediction describes the output resolution, not a one-patient input restriction.
4. Virtual patients can be generated before recruitment. An intervention experiment needs an executable response function and population binding. Missing validation alone does not prevent an exploratory run; the result states its assumptions and evidence limits.
5. Trial-design simulation is one task within the laboratory. A general-purpose virtual trial also needs modeled intervention, evolving patient states, observation rules and endpoints.
6. DSH + DeepSeek remains the agent foundation. Use the approved Flash provider identity from the existing gateway; do not silently substitute Pro, introduce a second agent kernel, or train DeepSeek as part of this plan.
7. A researcher can ask only for evidence, inspect a model, compare existing results, or run a subset of an experiment. No compulsory sequence, new study form or hidden requirement to install every sibling plugin.
8. **Patient matching implementation, model/prompt tuning, retrieval/ranking, clinical rules, datasets, benchmarks, release and production operations belong to the parallel matching workstream.** This plan owns its entrance and explicit navigation/context handoff only.
9. No recruitment CRM, patient contact, center profiles, recruiting operations, or site staffing workflow is added.
10. No deployment, production deletion or automatic production migration is authorized by this document. The previously skipped formal-B parser evaluation stays skipped; it is not a prerequisite for unrelated work.

11. Execute technically runnable research even when the intended use lacks independent validation. Put the exact limitation in the existing single premises block; never hide a function or withhold a completed result because of an evidence grade. Missing executable behavior, invalid inputs/units, authorization, runtime availability and explicit resource limits remain real execution boundaries.

### Acceptance of the plan versus scientific acceptance

Five entrances are an agreed product direction. Choice of a disease model, whether JEPA improves performance, and whether a proposed hybrid model supports intervention comparisons are hypotheses to evaluate. They must not become marketing claims because a page or adapter exists.

## 2. Research evidence and the design decisions it supports

Sources below were consulted in this conversation and pivotal pages were refreshed on 2026-11-07. Vendor material establishes described product behavior, not independently measured efficacy or blanket regulatory acceptance. Publication statements are limited to their actual evaluation setting.

| Source | Supported observation | Adopted decision | Boundary |
| --- | --- | --- | --- |
| [Jinkō product](https://novainsilico.ai/jinko) and [official skills](https://github.com/novainsilico/jinko-skills) | The product exposes mechanistic twins, virtual populations, trial simulation and agent-operable/versioned resources | Give the agent executable models and structured feedback; use immutable experiment inputs | Its example agent session is explicitly illustrative; no vendor performance number is adopted |
| [Jinkō modeling and validation](https://doc.jinko.ai/docs/platform/concepts/modeling/part-3-novas-modeling-and-simulation-approach/) | Calibration and validation are separated; credibility is tied to a context of use | Freeze validation data and record the exact population/model/use context | Reproducing calibration observations is not independent validation |
| [InSilicoTrials products](https://www.insilicotrials.com/solutions/pharma) and [four use cases](https://pmc.ncbi.nlm.nih.gov/articles/PMC9831955/) | Specific disease/therapy simulators sit inside a common platform; virtual patients can be personalized instances of mechanistic models | General platform, specialized disease capability packs | A catalog of indications does not establish a universal physiology model |
| [Unlearn method explanation, 2026-10-08](https://www.unlearn.ai/blog/built-on-regulatory-rigor-advancing-digital-twins-in-clinical-trials) | Prognostic twins used in randomized adjustment differ from external controls; the former does not determine drug efficacy by itself | Preserve distinct prognostic, experimental and comparative claims | Qualification of a statistical use does not qualify every generated control or new-drug prediction |
| [Simcyp product material](https://www.certara.com/app/uploads/2021/11/Simcyp_PBPK_2021-v21.pdf) | Population-based drug exposure modeling requires physiology, compound and administration information | Represent intervention and compound inputs explicitly | Exposure is not automatically a clinical efficacy endpoint |
| [OSP model library](https://www.open-systems-pharmacology.org/OSP-PBPK-Model-Library/) and [building blocks](https://docs.open-systems-pharmacology.org/v12/open-systems-pharmacology-suite) | Executable model projects and evaluation reports exist; individuals/populations, compounds and protocols are separate building blocks | Evaluate reuse before building an engine; store scientific packages beyond file catalogs | Pin model-specific licenses, dependencies and evaluation scope before redistribution or customer use |
| [Meta V-JEPA 2](https://ai.meta.com/blog/v-jepa-2-world-model-benchmarks/) | Action-conditioned latent prediction supports planning in its video/robotics setting | Investigate state/action transition learning | Video-model weights are not a clinical simulator |
| [Clin-JEPA v5](https://arxiv.org/html/2605.10840v5) | EHR encoder/predictor co-training and factual patient rollout were studied; alternative treatment sequences remain future work | Include JEPA-style co-training as an experimental arm | Do not claim validated patient counterfactuals or calibrated uncertainty from the architecture name |
| [PatientWM v1](https://arxiv.org/html/2610.17059v1) | Unified state and history-conditioned prediction are studied; stated use is retrospective representation and factual forecasting | Evaluate recursive rollout and typed clinical readouts separately | It is not evidence for autonomous treatment selection or a qualified simulator |

These observations motivate the plan. They do not prove that EviMed has already implemented or clinically validated the proposed capabilities.

## 3. Five product entrances and their boundaries

| UI label | User's question | Owned output | Main inputs and prerequisite label |
| --- | --- | --- | --- |
| 虚拟人群 | What population should this research represent, and can we construct it? | Versioned population and its individual members, calibration/coverage/quality report, model bindings | Built-in qualified population or literature constraints can start without an upload. Real-data construction requires **patient dataset**; intervention readiness requires **applicable response model** |
| 患者轨迹预测 | What may happen to these patients over the requested horizon? | Per-patient trajectories/risks, uncertainty where available, aggregate forecast, update comparison | **Patient baseline/history + applicable model** for real-patient forecasting. Synthetic scenarios must be labeled as such |
| 虚拟实验室 | What happens under these interventions or designs, and what should we try next? | Frozen experiment, evaluated arms, comparisons, candidate search and recommended next evidence | **Runnable population + applicable model + intervention/observation definition**. A qualified built-in pack may satisfy these without a patient upload |
| 合成对照臂 | What comparator and assumptions support this treatment comparison? | Comparator, estimand, balance/overlap diagnostics, estimates and sensitivities | **Applicable treatment/outcome/time/covariate data** for effect estimation. Feasibility/evidence work can start without them |
| 患者匹配 | Which patients and trials might fit? | Owned by matching workstream | Entry displays the matching owner's requirement summary; no duplicated matching execution |

### 3.1 Virtual Population

The population workspace builds and inspects reusable research subjects. It does not run a treatment-effect experiment simply because generation completed.

Supported origins: qualified built-in populations; distributions/constraints grounded in literature; authorized observed patient data; authorized real-patient model instances. Preserve origin per field and per object. Multiple virtual realizations of one patient retain their parent identity and are not counted as independent observed people.

Keep the following two distinctions in machine-readable metadata for correct execution and explanation. Present them as plain sentences inside the existing single `这个结论的前提` block, never as a second status panel, five-grade badge ladder or administrator vocabulary:

- **Computational readiness:** descriptive-only; transition model bound; intervention mapping available for the selected experiment.
- **Evidence:** not evaluated; numerically checked; internally evaluated; externally evaluated for a named use; unsupported for the requested use.

Outputs include joint distributions, correlated parameters, missingness assumptions, representation of important subgroups, physical constraints, failed/unsupported members, weights and a reusable immutable reference. A population may be suitable for a dose-exposure question but unsuitable for an efficacy question. Do not call a synthetic baseline CSV a biologically executable patient population.

The individual view shows starting state, parameter uncertainty, provenance, model bindings and linked experiments. It is not a second competing population store or an independent conversation for each generated person.

### 3.2 Patient Trajectory Prediction

Default to batch input with stable subject keys. The first result reports total supplied subjects, eligible subjects, successfully predicted subjects, rejected subjects and unprocessed subjects; every subject has a status and reason.

Keep three prediction modes explicit:

1. Forecast under the stated observed/current-care context.
2. Conditional forecast under an explicitly supplied future treatment schedule.
3. Intervention comparison, when the model can actually consume the specified actions and produce the requested outputs, linked to a laboratory experiment. If that comparison has not been validated, execute it as model-conditional research and state that limitation; do not equate running with establishing causal efficacy.

An action-conditioned prediction alone is not causal validation. In retrospective evaluation, future recorded treatments cannot be presented as information available at the original prediction time. Score logged-action replay separately from deployable forecast; do not provide post-anchor observations to either predictor.

Provide individual timelines and aggregate distributions, subgroup summaries and a comparison between prior predictions and newly observed follow-up. Preserve old predictions. Model uncertainty, patient heterogeneity, observation noise and Monte-Carlo error must not be displayed as interchangeable intervals. A deterministic model without an uncertainty procedure reports uncertainty as unavailable.

### 3.3 Virtual Laboratory

The laboratory is the workspace for hypothesis-driven computational experiments. Trial-design simulation, supported intervention comparison, mechanism sensitivity, subgroup exploration and evidence-directed iteration are operations in it.

Each experiment binds: research question; model and population versions; intervention arms; dosing/action times; observation schedule; endpoint definitions; horizon; analysis and uncertainty method; seeds; budget; source bindings; and the purpose of the comparison.

The agent may run one experiment, compare existing results without rerunning, or explore a bounded candidate space. It cannot edit the evaluation model or success criterion invisibly until a candidate appears successful. A changed model starts a new experiment lineage and requires a new evaluation of its conclusions.

The default result states the contrast, main estimates/uncertainty, supported scope, failure cases and remaining evidence needs. Useful outcomes include futility, uncertainty reduction and a specific next real experiment. Never promise that simulation success establishes clinical success.

### 3.4 Synthetic Control Arm

Retain separate routes for real external controls, literature/aggregate comparisons, model-based predictions, borrowing, and randomized prognostic adjustment. They share references, not interchangeable evidence status.

Every effect-estimation task states target population, time zero, treatment strategies, outcome, follow-up, estimand, confounders and censoring assumptions. Check post-baseline leakage, immortal-time bias, overlap/positivity, source heterogeneity and sensitivity to unmeasured confounding. Report non-estimability alongside other useful results rather than replacing the entire research package.

A simulated control can be used inside a model-based experiment. Exporting it into an external-control comparison must retain its simulated origin and model dependence; it does not become observed clinical evidence.

### 3.5 Matching ownership contract

Our changes are limited to the sidebar entry, route integration, selected-state behavior and an optional explicit context handoff.

- Use the route/capability descriptor actually supplied by the matching owner at integration time. The current local `?area=patient-matching` and study `/matching` addresses are compatibility references, not an instruction to force the online matching module back into VCR.
- If the owner has a dedicated module, the entry opens that module directly. Do not insert a second composer, create a new matching session behind the user's back, or infer a study from the current general project.
- A contextual handoff carries opaque authorized references and a return location; raw patient data, credentials and free-form hidden clinical payloads never enter URLs/history.
- Opening an entry grants no data permission. Destination code reauthorizes references and defines its own supported inputs. Passing a cohort to matching is an explicit user action; automatic discovery is not permission.
- If no current handoff contract is available, preserve the last functioning destination and ship the four owned functions. Record contextual handoff as unavailable instead of guessing an endpoint.
- Test destination, back navigation, modified click, account/project isolation and a failure return using a matching-owner contract stub. Do not rerun TrialGPT, TREC or n2c2, edit matching prompts, or change its release configuration.

## 4. Interaction and navigation specification

Keep the existing global sidebar, nested directory geometry, design tokens and mobile overlay. No new full-screen shell, permanent middle records column, top stack of four/five explanatory cards, model-name marketing, or mandatory calculator forms.

The lower history groups conversations and saved artifacts by research. A research with no surviving conversation remains reachable through a saved-result row. Multiple sessions in one research remain distinct; neither duplicate the research for every result nor invent a conversation for an orphaned artifact. Search matches research names and conversation titles and preserves account/project scope. `?study=`, `?new=`, libraries and existing result URLs remain readable.

Module root opens the laboratory entry; it does not auto-create a study or a run. Legacy `?area=records` opens the retained archive route during migration but is absent from the five-entry navigation. Suggested canonical area identifiers are `virtual-population`, `patient-trajectory`, `virtual-lab`, `synthetic-control`, `patient-matching`. Resolve existing `virtual-cohort`, `virtual-patient`, `virtual-trial` as aliases. Existing package IDs remain stable in the first release.

Each selected entrance shows one current task surface:

- Before work: a short purpose, relevant data/model prerequisite, available authorized assets and a natural-language question. Examples fill a draft without sending. No compulsory disease/model form precedes an ordinary question.
- During work: a concise explanation of the current action, actual progress and cancel/budget controls. No fabricated percentage or private internal chain-of-thought; show inspectable decisions, assumptions, tool receipts and scientific rationale instead.
- After work: the current scientific object, meaningful plots/tables and supported next actions. Model/source details are available in context. Conversation and results preserve their same research and selected version.

Patient batch tables support filtering failures/uncertainty and opening one member. Laboratory results compare named arms with matched endpoint/time/unit definitions. Large data stay in the protected data plane; use bounded server summaries and virtualized/paginated views. A scatter plot of latent embeddings is an optional expert diagnostic, never a claim that clusters are validated biological subtypes.

Data requirement labels describe the operation, not a blanket upload requirement. If a built-in pack or previously authorized data already satisfies it, show that resource as available. If there is no executable adapter or intervention input mapping, explain exactly what cannot be calculated while retaining the entrance, evidence work and other results. If execution is possible but evidence is missing or the request extrapolates beyond validation, run it with an explicit premise. Example: “这个模型尚未验证过这种治疗比较；结果表示在所列模型假设下可能怎样变化。”

Extend `vcrPremises.mjs` and its shared renderer to carry nonnumeric scientific premises explicitly; the existing numeric-only rule must not cause a missing-validation statement to disappear or force a fabricated numeric value. Merge assumptions, data origin, computational limits and validation context into one block with detailed disclosures. Data-upload hints remain task-specific; they are not evidence-grade badges.

The five entrances are user intentions. `VCR_STEPS` remains the compatibility vocabulary for existing plans/jobs/history; requested or actually active work can be shown in research detail. An open-domain query does not activate all seven steps, and neither clinical matching execution nor a seven-step rail becomes a prerequisite. Update root `AGENTS.md` and `CLAUDE.md` together, and `OpenScience/AGENTS.md` through its existing `CLAUDE.md` symlink, to make this later ruling explicit.

## 5. Current code: reuse and measured gaps

Paths below were checked against the stated local baseline. Source presence is not deployment or scientific validation.

| Concern | Existing anchors | Reuse / required change |
| --- | --- | --- |
| Navigation and entry | `OpenScience/apps/web/src/components/vcr/VcrWorkspaceNav.tsx`; `src/lib/vcrWorkspaceNavigation.ts`; `src/app/virtual-research/VcrHomePage.tsx`; `components/vcr/professionalResearchTasks.ts` | Six-directory baseline becomes five; move records into existing history, retain aliases and unsent draft semantics |
| History/context | `OpenScience/apps/web/src/components/sidebar/SidebarConversations.tsx`; `src/lib/vcrEntryDraft.ts`; `components/vcr/StudyFrame.tsx`; `src/app/layout/AppShell.tsx` | Preserve verified ownership, refresh retention, SPA drafts and mobile query-navigation dismissal |
| Independent plugins | `OpenScience/packages/{virtual-cohort,virtual-patient,virtual-trial,synthetic-control,virtual-research-suite}/` | Keep installable contracts; public labels need not equal historical package IDs |
| Invocation/authorization | `OpenScience/packages/research-plugin-runtime/{catalogue.mjs,hostedProtocol.mjs}`; `apps/server/src/{vcrGateway.mjs,vcrExecutionContext.mjs}` | Reuse method/version/reference authorization; extend through versioned contracts, not free-form shell commands |
| Batch trajectory foundation | `OpenScience/apps/server/src/{vcrForecastProvider.mjs,vcrLongitudinal.mjs,vcrLongitudinalStore.mjs,vcrForecastCalculation.mjs}` | Provider batching, checkpoint hooks, scoped inputs and cancellation already exist; complete product exposure and exact subject accounting rather than rebuilding a batch queue |
| Model applicability | `OpenScience/packages/domain/src/vcrModelInterfaces.mjs`; `apps/server/src/vcrModelApplicability.mjs` | Existing baseline-to-outcome and history-to-trajectories shapes; add explicit action-conditioned semantics and evidence-bound use support |
| Mechanistic package format and numerical references | `项目代码/vcr-engine/R/population.R` (`VCR_MECHANISTIC_REQUIRED`, `vcr_mechanistic_spec_issues`); `tests/numeric/C2_08_C2_14_models.R`; `tests/numeric/N99_progression.R`; `OpenScience/packages/domain/src/vcrEngineJob.mjs`; `OpenScience/scripts/vcr/check-method-references.mjs` | Reuse the existing 13-field contract, uncertainty/variability separation, `vcr_case`, method `crossChecks` and reference checker. Solver names are schema support, not installed runtimes |
| Patient/prediction presentation | `OpenScience/apps/web/src/components/vcr/{VcrLongitudinalPanel.tsx,VcrForecastEvaluation.tsx,VcrForecastComparison.tsx}`; `tabs/{PopulationPatientsTab.tsx,PatientsTab.tsx}` | Reuse timeline/evaluation components, separate prediction task from population member inspection |
| Population/comparison/design | `OpenScience/apps/web/src/components/vcr/tabs/{PopulationTab.tsx,ComparatorTab.tsx,TrialTab.tsx}`; `项目代码/vcr-engine/R/` | Existing statistical and scenario tools remain available; design tools alone do not supply a disease/intervention simulator |
| Persistence/execution | `OpenScience/apps/server/src/{vcrStore.mjs,vcrStoreBase.mjs,vcrDataPlane.mjs,vcrJobs.mjs,vcrWorker.mjs,vcrEngineClient.mjs}` | Add records/adapters to existing durable patterns; no second universal scheduler |
| Scientific provenance | `OpenScience/apps/server/src/{vcrScenarioSources.mjs,vcrScenarioKey.mjs,vcrModelDesign.mjs,vcrModelDocuments.mjs,vcrLongitudinalDocuments.mjs}` | Extend frozen source/model bindings into experiments and reports |
| Evaluation | `OpenScience/evals/{vcr-professional-plugins,vcr-hosted-native}/`; `项目代码/vcr-engine/tests/` | Reuse exact scoped results and test infrastructure; add new intervention/world-model evidence separately |

The inspected cohort plugin includes profiling, construction, scenario/literature generation, synthesis and quality checks. The patient plugin exposes scenario/model application/training methods. The trial plugin principally exposes design/operating-characteristic methods. The optional suite discovers installed tools; it is not already an autonomous scientific experiment environment.

Historical acceptance at `63a6a6c5a` included 499 numerical/reference cases and full engineering CI. The navigation revision has its own UI evidence. Neither is proof of a new disease simulator. The [full-data assessment](../../../OpenScience/evals/vcr-professional-plugins/RUN-20261105.md) retains red synthesis-quality bands, unavailable checks, scoped ICU HR forecasts and ACTG175 composite-outcome limitations. Do not relabel these as successful validation of the proposed platform.

## 6. Shared scientific contracts

Extend existing domain/persistence contracts; the names below are proposed additions, not claims of current exports. Preserve current object IDs and data access grants. Freeze all referenced versions at job admission and include them in deduplication/checkpoint keys.

| Object | Required semantics |
| --- | --- |
| Model capability pack | Scientific model/version/weights/code digest, origin/license, intended questions, input/output units, time scale, training/calibration/evaluation lineage, supported actions, validation context, known limits, resource requirements and executable adapter identity |
| Population version | Target population, origin, subject/member keys and parent identities, joint parameter distribution or patient-state references, constraints, calibration evidence, weighting, quality findings and model bindings |
| Forecast batch | Original patient inventory, as-of boundary, information available at that boundary, endpoint/horizon, model version, action-context mode, per-subject status, trajectories and uncertainty provenance |
| Experiment version | Frozen question, population/model references, interventions, observation/endpoint definitions, contrasts, analysis, seeds and resource envelope |
| Experiment result | Producing job/adapter/model identities, subject and replicate counts, results, unsupported/failed components, numerical diagnostics, scientific evidence limits and export references |
| Search campaign | Frozen objective/constraints/model/evaluator, proposal history, budget, candidate evaluations, stopping reason and independent assessment of the final candidates |

Illustrative contract, not executable model registration:

```json
{
  "schemaVersion": 1,
  "modelRef": {"id": "example-ad-scenario", "version": "1.0.0"},
  "populationRef": {"id": "example-population", "version": "3"},
  "predictionMode": "conditional_forecast",
  "useContext": {
    "endpoint": "ADAS-cog-11",
    "unit": "points",
    "horizon": {"value": 52, "unit": "weeks"},
    "population": "explicitly specified mild-to-moderate AD scenario",
    "interventions": ["explicit hypothetical progression-slowing function"]
  },
  "observationPolicy": {"times": [0, 12, 24, 36, 52], "unit": "weeks"},
  "uncertainty": {"parameter": "declared_distribution", "structural": "not_quantified"},
  "claim": "model_conditional_simulation"
}
```

Do not pass `hours` into the current days/weeks/months/years interface without an explicit adapter/unit conversion. Dose amount, amount-per-weight, route, infusion duration, frequency, concentration and exposure units require dimension-aware conversion. Requested times must fit the executable time representation and actual runtime/API limits. Beyond-validation horizons remain runnable when the model can compute them, with the extrapolation stated in premises.

Use the closed mode vocabulary `factual_forecast`, `conditional_forecast`, and `intervention_comparison`. The experiment field `predictionMode` maps explicitly to `request.mode` when calling the applicability check; they are not two independent settings. A conditional forecast is permitted to be model-conditional without a causal claim.

The shared use check should return inspectable reasons, not a single permanent certification flag. A minimum pure contract test is:

```javascript
import assert from 'node:assert/strict';
import { assessModelUse } from '../src/vcrModelUse.mjs';

const pack = {
  executable: true,
  executableModes: ['factual_forecast', 'intervention_comparison'],
  validation: [{mode: 'factual_forecast', population: 'fixture-adults',
    endpoint: 'heart_rate', horizonHours: 24, evidenceRef: 'fixture-evidence'}],
};
const result = assessModelUse(pack, {
  mode: 'intervention_comparison', population: 'fixture-adults',
  endpoint: 'heart_rate', horizonHours: 24,
});
assert.deepEqual(result.executionIssues, []);
assert.equal(result.premises.some(x => x.code === 'use_not_validated'), true);
const cannotRun = assessModelUse({...pack, executableModes: ['factual_forecast']}, {
  mode: 'intervention_comparison', population: 'fixture-adults',
  endpoint: 'heart_rate', horizonHours: 24,
});
assert.equal(cannotRun.executionIssues.some(x => x.code === 'intervention_input_unavailable'), true);
```

`assessModelUse(pack, request)` is to be introduced in task T03; it checks explicit modes, population, endpoint, intervention, horizon and usable evidence references. Missing provenance must never be interpreted as external validation. Evidence findings change the explanation and claim, not execution permission. Only actual execution issues prevent that calculation; other results remain deliverable.

### Result accounting and uncertainty

Use distinct counts for observed people, observed stays, virtual members, treatment arms, stochastic futures and simulated trials. A 100-patient input with 100 futures each remains 100 input patients. Preserve partial batches and reconcile submitted = completed + rejected + failed + unprocessed. Match uncertainty to its source: parameter draws, observation variability, fitted-model uncertainty, structural alternatives and Monte-Carlo error.

### Execution and evidence are different decisions

`assessModelUse` returns `executionIssues` and `premises`. Execution issues cover a missing adapter/function/input, an unrepresentable intervention, invalid mathematical parameters, nonconvertible units, authorization loss or declared resource/runtime limits. Evidence findings, absent independent validation, scientifically plausible extrapolation and a new proposed hypothesis belong in `premises`; they do not veto an otherwise executable run. A provider's actual API maximum remains an execution limit; a validation horizon alone does not.

Keep claims proportional to evidence without withholding results. Missing model code is not cured by a caveat, and a runtime error must not be replaced by invented numbers. Existing usable results remain delivered with their limitations. The model must not quietly invent a drug-response function: if a user explicitly requests a hypothetical effect function, preserve that assumption as the experiment's input.

### Model-to-clinical readout

A latent transition model needs typed readouts for clinical values/events and an explicit initial-state population mechanism. Embeddings alone cannot produce a valid clinical endpoint or sample a realistic patient population. Do not interpolate arbitrary latent coordinates and label the resulting points as physiologically valid patients. Evaluate decoded distributions, consistency, temporal behavior and out-of-support detection.

## 7. Model capability packs and defensibility

A reusable pack combines natural history, supported interventions, population variation, endpoint/observation models, calibration, independent validation and deployment metadata. It may use mechanistic equations, statistical models, learned dynamics or an evaluated hybrid. These are choices per question, not a mandatory hybrid architecture.

The assets to build are:

1. Executable, calibrated packs for recurring customer questions.
2. Longitudinal data with reliable treatment/time/outcome alignment and the rights needed for each use.
3. Reproducible validation, known failure regions and later independent observations.
4. Agent experiment selection that measurably improves decision quality or time/cost at a fixed budget.

Measure these assets by: independently evaluated question/use-context coverage; held-out error/calibration and failure coverage; reuse across authorized studies without repeating manual model preparation; and decision quality/time/cost versus fixed-design and ordinary-search baselines. Record licensing, maintenance and serving cost per pack. A customer-success or trial-success rate needs a declared denominator, attribution method and follow-up; it is not inferred from simulated success.

Public model files are a starting point. A model count, model-family label, latent-space visualization, or generic agent conversation is not a performance moat. Customer-derived parameters/weights stay tenant-scoped unless separately licensed for broader use. The knowledge base and memory system do not grant training rights.

### First disease–drug–trial model: Alzheimer ADAS-cog

Keep the platform generic; the first disease-response demonstration is a scoped statistical drug-disease-trial simulator for mild-to-moderate Alzheimer disease, using ADAS-cog as in the C-Path/Rogers line. It is not a universal biological mechanism model or a predictor of the unknown efficacy of a new compound.

The [C-Path page](https://c-path.org/tools-platforms/alzheimers-disease-clinical-trial-simulation-tool/) describes disease, drug, placebo, dropout and variability components, R expertise requirements, and application access as under construction. [Rogers et al. 2012](https://pubmed.ncbi.nlm.nih.gov/22821139/) describes the beta-regression drug-disease-trial model. The [FDA letter dated June 12, 2013](https://www.fda.gov/media/98856/download) concerns the original tool's context of use; its recognition does not transfer to our reimplementation. EMA's 2013 qualification is likewise historical and scoped, not an EviMed certification. Preserve the original context and document dates rather than treating draft consultation, opinion and later publication as one date.

T05 must acquire and inspect the full model publication/supplements and usable original artifacts, enumerate equations/parameters/distributions, and record what cannot be recovered. The current review verified the sources and scope, not every numerical parameter. T06 extends the existing R method or introduces a narrowly versioned sibling in the same registry. Aim to use the current R lock; verify actual functions and dependencies before promising that no package change is needed.

Implementation must distinguish the latent/logit mean progression from the beta observation distribution. Recover endpoint scaling/bounds, baseline/covariate effects, random-effect distributions and covariance, parameter uncertainty, placebo dynamics, symptomatic versus disease-modifying effect assumptions, dropout/observation mechanisms and analysis estimands. `qlogis`, `plogis` and `rbeta` provide primitives, not a complete published model. Explicitly assumed missing parameters permit labeled exploratory simulation; they do not permit claiming full C-Path numerical reproduction.

[Jamalian et al. 2023](https://pubmed.ncbi.nlm.nih.gov/37101394/) is a separate CDR-SB model (different endpoint/scale and parameterization). Current `N99_progression.R` explicitly lacks its random onset/log-normal rates and checked parameter table. Do not transplant those parameters into ADAS-cog or call adding a logistic curve a reproduction of either paper.

Write numerical fixtures as `vcr_case` cases under `项目代码/vcr-engine/tests/numeric/`; bind the method's external references through `crossChecks` and `check-method-references.mjs`. Prefer source numerical tables and independently coded equations; figure digitization includes declared reading tolerance and cannot establish exact equality. Reuse the existing method-validation evidence store and scientific evaluation ledger, not a separate reproduction document or model registry.

The fallback candidate is a tumor-growth-inhibition/survival model, subject to a separate paper/parameter/covariate/link-model review before selection. It has not been reviewed here. PBPK/midazolam is deferred until a concrete exposure/dose question justifies the runtime cost; it is not a dependency of laboratory launch. The optional analytic one-compartment fixture remains an engineering check only.

The existing 13-field mechanism format remains authoritative for mechanism packages: `modelKind`, `engine`, `engineVersion`, `modelHash`, `parameters`, `parameterUncertainty`, `betweenSubject`, `residual`, `covariatePopulation`, `events`, `outputs`, `vpopSelection`, `validation`. Current allowed engine tokens are `mrgsolve`, `rxode2`, `nlmixr2`, `ospsuite`, `desolve`. Store statistical disease-trial models through existing model records and method contracts. If the shared format needs a base-R engine token, extend its existing vocabulary and parity tests once; never mislabel base R as an installed external solver. Do not add `vcrModelPack.mjs` or `OpenScience/models/vcr/` as another registration system.

## 8. JEPA and temporal world-model research program

Training is a separate, testable R&D lane. It must not block the five-entrance navigation, existing prediction methods or qualified mechanistic experiments.

### Questions and comparison arms

- H1: A learned latent state/transition improves multi-step factual forecasting over persistence and strong task-specific baselines at the same information boundary.
- H2: Action conditioning improves forecasts beyond what can be explained by history, severity and treatment-selection correlations. This remains factual evidence unless a causal evaluation design supports more.
- H3: A mechanism-informed hybrid improves a specified endpoint or robustness metric relative to its components.
- H4: The model remains useful when an optimizer searches its outputs, rather than only on typical held-out cases.

Compare: persistence; current prognostic/trajectory baseline; an appropriate non-JEPA temporal model; JEPA-style latent transition; and a hybrid only when a concrete mechanism mapping exists. Match available inputs, target definitions, tuning resources and test splits. Training from scratch is not a prerequisite; benchmark encoder reuse, limited adaptation and joint training before choosing compute scale.

### Data and labels

Split by recoverable person identity before visits/windows, then reserve later-time or external-site data where available. A stay split is labeled as a stay split when person identity is unavailable. Keep training, calibration, model selection and final test separate. Previously inspected public challenge splits are development evidence, not fresh independent holdouts.

Use actual medication administration/exposure and its timestamps for action modeling. Orders, recommendations and recorded intentions are different events. Preserve availability time as well as occurrence time; do not leak later documentation backward. Model missingness and observation frequency without interpreting absence as a normal result.

The current recruitment partner's pre-enrollment/post-exit data cannot reveal missing in-trial treatments and outcomes. Do not infer those hidden states from trial exit alone. Seek separately authorized treatment/outcome sequences or use qualified mechanisms and existing model datasets. Admission/exit selection and follow-up availability require explicit analysis.

### Evaluation and promotion

Measure multi-horizon MAE/RMSE, relevant event discrimination and Brier/calibration, prediction-interval coverage where supported, rollout drift, subgroup performance, missing-input tolerance, action removal/shuffling controls and out-of-distribution behavior. Record output coverage and failures against the full frozen input denominator. Factual action dependence does not identify causal treatment effects.

Use known-truth simulations for counterfactual engineering tests; use independent randomized or defensibly designed causal evidence for treatment-comparison validation. Keep factual forecasting, model-conditional scenarios and independently evaluated intervention comparisons as distinct claims, while technically runnable research remains accessible. Prospective claims need prospective evidence. A model without measured improvement may remain runnable as an explicitly experimental candidate; default recommendations should not claim an improvement that the comparison did not establish.

Commercial-use and data-use permissions for MIMIC/other sources, paper code and pretrained weights must be checked per artifact. Existing n2c2 permission is not blanket permission for unrelated data or model vendors. No new data transfer or GPU training is performed by writing this plan.

## 9. Autonomous experimentation with bounded objectives

The first campaign searches existing trial-design methods immediately, without waiting for a new disease model or PBPK. The agent can propose interventions or trial designs within the frozen executable search space, execute experiments through admitted tools, inspect structured results and propose another candidate. Reuse native DSH tools and existing LoopX continuation for long goals; no new universal workflow DSL or custom second agent loop.

Every campaign freezes objective, constraints, population sampling policy, evaluation model(s), search space, maximum candidate/compute/model-call budgets and stopping rules. Inferred objectives are stated before costly work; ordinary small requests do not grow into full campaigns.

Stop reasons include budget exhausted, acceptable precision, no useful improvement, unsupported candidate, persistent model failure, user cancellation, and no feasible beneficial candidate. All candidates and changes remain in history, including failed and unfavorable ones.

After search, evaluate shortlisted candidates using held-out draws and, where available, independent data or structurally different models. Common random numbers can reduce variance in supported paired comparisons, but remain a simulation variance technique, not causal evidence. An optimizer may not alter endpoints, drop nonresponders, increase simulated sample size until a tiny effect is significant, or tune the validation set without opening a new explicitly labeled exploratory campaign.

A latent visualization supports inspection; the search acts on admissible, decoded scientific interventions. The default decision report includes plausible adverse/null cases and the next real measurement that would most reduce uncertainty. Model-generated trajectories may train an emulator as synthetic data, but cannot serve as independent clinical confirmation of the generating model.


### 9.1 Design-search first release and compute policy

First search variables are sample size, interim information times, futility/efficacy boundaries and supported dose-escalation rules. Freeze the endpoint, analysis, nominal type-I error and clinical/design constraints before search. Type-I error cannot be relaxed to make a candidate win. Dose-finding uses relevant toxicity/selection constraints; a superiority-test alpha constraint is not blindly applied to every dose rule. Use current `design.*`, `patients.progression`, rpact/gsDesign-related numerical checks and the actual method registry; not every one of its approximately 48 methods is a design-search evaluator.

The inspected engine README deliberately sets global concurrency to 1 for the shared four-core host; the 70-package runtime lock contains none of the five named mechanism solvers. The November 4 acceptance reported 2,375/5,000 win-ratio replicates before a CPU stop and about 16 minutes for the conversation, and about four minutes for 35,000 re-estimation iterations. These are historical measurements, not a current benchmark or a basis to multiply wall time by 30 uncritically. Profile queue time, tool/agent time, CPU, solver time and memory on the exact new revision.

Implement progressive evaluation:

1. Use exact/analytic evaluation or valid existing surrogates to eliminate infeasible candidates when available.
2. Use a predeclared small replicate stage only to rank/screen remaining candidates, with MCSE and visible incomplete precision. Existing methods enforce replicate floors; do not merely send a smaller number or weaken those floors globally. A versioned `screening` purpose may admit a low-precision result that cannot satisfy final validation, with separate cache/receipt identity and tests.
3. Fully reevaluate finalists at the method's normal precision/replicate requirement and independent validation streams. Preserve every candidate's result and rejected reason; freeze stage sizes and stopping/selection rules before the run.
4. Use the same initial synthetic patients and indexed random substreams across compatible candidates. The same integer seed alone does not guarantee paired patients when candidates change RNG consumption or stopping. Compute paired contrast uncertainty from the actual coupling; state when coupling is not meaningful across method families.
5. Require analytic error-control support where available, or a predeclared independent Monte-Carlo assessment with a conservative upper bound satisfying the fixed constraint. Near-boundary uncertainty is inconclusive, not a pass. Repeated adaptive looks use a valid sequential bound or fixed evaluation stages. Do not report a screening power estimate as a confirmed design or assume finite simulation proves error control over every possible null.

**Host decision:** keep concurrency 1 on the shared production host and retain current CPU/memory/cancel limits. Use serial batching, cache keyed by complete frozen inputs, checkpoints and event-driven completion first. For campaigns whose measured estimate exceeds the explicitly selected time budget, propose an asynchronous run or a separately provisioned compute worker; do not increase shared-host concurrency silently. A dedicated-worker rollout is a separate operational action. Its capacity test must measure 1 versus 2 active jobs, core oversubscription, p95 queue/interactive latency, peak memory, throughput and seed reproducibility before selecting a higher setting. CPU budget is allocated across screening, finalist evaluation and reporting; report actual completed replicates on exhaustion.

A campaign benchmark includes 30 predeclared candidate designs, a cheap analytic family and a heavy simulation family. Publish total time/cost and decision quality for fixed/grid search and agent search at matched budgets, including queue time. Freeze an acceptable user wait/budget in the campaign manifest after the baseline probe; no universal latency promise is inferred from lightweight methods.

## 10. Data preparation and evaluation matrix

| Resource | Reuse now | New work and boundary |
| --- | --- | --- |
| Prepared PhysioNet 2012 A/B/C | Existing cohort/synthesis evaluation and limited HR prediction | Reconcile full applicable inventory, preserve missingness and prior test exposure; it does not establish new-drug response modeling |
| Prepared ACTG175, 2,139 participants | Endpoint-aware statistics and comparator regression | Composite event definitions and post-baseline exclusion stay fixed; within-RCT reweighting is not independent external-control validation |
| TrialGPT/TREC/n2c2 | Matching owner only | No downloading, rerunning, retuning or benchmark promises in this plan |
| Public mechanistic model projects and reports | Candidate first pack | Pin artifacts, license, source datasets, intervention coverage and independent tests before use |
| Authorized longitudinal treatment/outcome data | World-model research when available | Separate access/training/serving rights; preserve actions, time, missingness and site/person grouping |
| Literature and client knowledge | Model assumptions, applicability, parameter/source binding | Source retrieval and quoted values are not automatic mathematical or clinical validation |
| Known-truth synthetic fixtures | Reproducibility, null effects, uncertainty, optimizer behavior | Label as engineering validation; never count as real clinical data |

An evaluation freezes source revision, package/model/adapter versions, data hashes, preprocessing, information boundaries, splits, objective, metric definitions, full denominators and budgets. Run the complete applicable set once the route and scoring are frozen; an operational smoke test may check connectivity, not replace the full campaign. Persist resumable failures instead of repeatedly selecting favorable subsets.

For each task report five separate layers: execution success; numerical correctness; data/model quality; scientific usefulness for the declared context; and actual product usability. API execution is not proof of the native conversation route, and a browser screenshot is not a model-quality score.

## 11. File and ownership map for implementation

Existing files may be extended only within their current responsibility. New paths below are proposed and intentionally small.

| Work package | Existing paths to modify/reuse | Proposed new paths |
| --- | --- | --- |
| Entrance/history | `OpenScience/apps/web/src/lib/vcrWorkspaceNavigation.ts`; `components/vcr/VcrWorkspaceNav.tsx`; `app/virtual-research/VcrHomePage.tsx`; `components/sidebar/SidebarConversations.tsx`; `components/sidebar/ProjectBrowser.tsx` | `OpenScience/apps/web/src/components/vcr/VcrResearchHistory.tsx` and its test, if a focused extraction is needed |
| Model/population contracts | `OpenScience/packages/domain/src/vcrModelInterfaces.mjs`; `vcrObjectReference.mjs`; `vcrContracts.mjs`; package exports | `OpenScience/packages/domain/src/{vcrModelUse.mjs,vcrExperiment.mjs}` and matching `test/*.test.mjs` |
| Existing model records and mechanism contract | `OpenScience/apps/server/src/{vcrStore.mjs,vcrModelApplicability.mjs,vcrModelSources.mjs}`; `项目代码/vcr-engine/R/population.R`; domain method metadata | Extend existing records/fields and parity tests; no third registry |
| Population bindings | `OpenScience/apps/server/src/vcrDataPlane.mjs`; `vcrService.mjs`; `OpenScience/apps/web/src/components/vcr/tabs/PopulationTab.tsx`; engine `R/population.R` | `OpenScience/apps/server/src/vcrPopulationBinding.mjs` and integration test |
| Batch predictions | `OpenScience/apps/server/src/vcrForecastProvider.mjs`; `vcrLongitudinal.mjs`; `vcrLongitudinalStore.mjs`; domain `vcrForecastEvaluation.mjs` | `OpenScience/apps/web/src/components/vcr/PatientTrajectoryWorkspace.tsx` and test |
| Model execution adapters | `OpenScience/apps/server/src/vcrJobs.mjs`; `vcrWorker.mjs`; `vcrEngineClient.mjs`; domain `vcrEngineJob.mjs`, `vcrScenarioSchemas.mjs`; engine `R/protocol.R` | `OpenScience/apps/server/src/vcrSimulationAdapter.mjs`; `项目代码/vcr-engine/R/patients_progression.R` and existing numerical/reference tests; new solver runtime files only for a later justified backend |
| Laboratory | Existing trial result components, jobs, source/result bindings and LoopX continuation | `OpenScience/apps/server/src/vcrExperiments.mjs`; `OpenScience/apps/web/src/components/vcr/VirtualLabWorkspace.tsx`; `OpenScience/packages/domain/src/vcrExperimentSearch.mjs` |
| Plugins | Existing four domain packages, suite and `research-plugin-runtime/{catalogue.mjs,hostedProtocol.mjs,report.mjs}` | Add narrow experiment tools/contracts to the existing suite; do not create a second statistical-method registry |
| Scientific research | Existing evaluation harnesses | `OpenScience/evals/vcr-in-silico/`; `项目代码/vcr-world-model/` for isolated training code/checkpoint manifests after T11 |

`项目代码/vcr-world-model/` is a proposed scientific worker/package, not another agent kernel or a service exposed directly to the browser. Trained inference artifacts must enter through vetted, versioned adapters and the existing authorized job boundary.

## 12. Implementation tasks

All boxes start open. The completion of this document checks none of them. Each task produces an independently reviewable commit with its named tests and evidence. Small reversible copy changes need no implementation-mirroring test; substantive behavior changes require the scenario tests below.

### T01 — Freeze integration baseline and compatibility inventory (P0)

**Owner:** platform integration. **Dependencies:** none.
**Files:** this plan; existing acceptance records; private evaluation manifest.

- [ ] Fetch current main, this feature branch and the matching owner's declared integration ref. Record commits and dirty-state ownership; do not overwrite concurrent edits or assume the inspected baseline is deployable.
- [ ] Inventory public routes, object kinds, plugin/tool IDs, method versions, result readers and native context bindings. Map each renamed entrance to a compatibility alias.
- [ ] Record the independently owned matching destination and allowed context contract. If unavailable, apply section 3.5's last-working-destination fallback; no guessed API.
- [ ] Freeze the exact revision for the first implementation increment and its test commands. Keep production serving state separate.

**Done:** one reproducible integration baseline and no ambiguous owner of a shared change. Commit: `docs(vcr): freeze in silico integration baseline`.

### T02 — Five entrances and unified research history (P0)

**Files:** entrance/history paths in section 11, `vcrEntryDraft.ts`, navigation/HomePage/Sidebar/AppShell tests, `OpenScience/DESIGN.md`, `OpenScience/docs/FRONTEND_DESIGN_SYSTEM.md`.

- [ ] Add regression cases: exactly five public directions; old area and study URLs readable; no research-record directory; a saved-result-only research remains discoverable; two sessions in one research remain distinct.
- [ ] Implement canonical/legacy area resolution and lower-history research grouping. Use source-owned model/result references, not the newest study. Preserve native same-study conversation, selected version, pending draft and account boundaries.
- [ ] Direct matching to the owner descriptor with a route-contract stub; verify back navigation and revoked/foreign context without running a matcher.
- [ ] Render one selected task/result surface with operation-specific data labels. Test mobile query navigation closes the overlay, modified clicks retain browser behavior and refresh failure retains only still-authorized history.
- [ ] Inspect the actual built desktop and 390px pages; replace the superseded layout rule in DS/DESIGN rather than preserving contradictory defaults.

**Run:** `pnpm --filter @ai4s/web test -- src/components/sidebar src/components/vcr/VcrWorkspaceNav.test.tsx src/app/virtual-research src/app/layout src/lib/vcrWorkspaceNavigation.test.ts` from `OpenScience/`.
**Expected:** all addressed behaviors pass; no matching execution requests. Commit: `feat(vcr): organize five research entrances and shared history`.

### T03 — Execution issues and nonblocking scientific premises (P0)

**Files:** proposed pure `vcrModelUse.mjs`/experiment contracts, existing `vcrModelInterfaces.mjs`, `vcrObjectReference.mjs`, `vcrContracts.mjs`, `apps/server/src/vcrModelApplicability.mjs`, `vcrPremises.mjs`, shared premise renderer and tests.

- [ ] Add the section 6 paired tests: executable unvalidated comparison runs with `use_not_validated` in premises; absence of intervention-input mapping prevents that calculation. Also test missing independent data, beyond-validation horizon, invalid parameters, incompatible units, missing adapter and revoked authorization separately.
- [ ] Return execution issues independently from evidence/context premises. Preserve old cards/results; no new clinical-evidence grade prevents a completed result from being delivered.
- [ ] Freeze experiment/population/model/action identities using existing canonicalization. Expose an action-conditioned shape only when technically implemented, without labeling it causally validated.
- [ ] Extend the one premises block for nonnumeric scientific limitations; retain task-specific upload hints but add no validation badges or second status panel.

**Run:** `pnpm test:domain` and focused premise/applicability tests from `OpenScience/`.
**Expected:** runnable exploration stays available; impossible calculations give actionable reasons; claims remain accurate. Commit: `feat(vcr): separate execution validity from research premises`.

### T04 — Reuse existing model registration and validation contracts (P0)

**Files:** `apps/server/src/{vcrStore.mjs,vcrModelApplicability.mjs,vcrModelSources.mjs,vcrMethodValidation.mjs}`; `项目代码/vcr-engine/R/population.R`; `tests/numeric/C2_08_C2_14_models.R`; domain `vcrEngineJob.mjs`, existing model/knowledge-pack contracts and integration tests.

- [ ] Map pack metadata to existing model records and the 13-field mechanism schema. Keep parameter uncertainty and between-subject variability distinct. Extend metadata in place for source/weight hashes, callable inputs, license and use evidence; no `vcrModelPack.mjs` or new `OpenScience/models/vcr/` registry.
- [ ] Reuse the mechanism schema authority; if control-plane admission needs its projection, generate/test parity rather than hand-maintaining divergent required-field lists. Solver declarations must match real installed runtime receipts.
- [ ] Route numeric evidence through `vcr_case`, method `crossChecks`, `NUMERIC_REFERENCES` and the existing method-validation pipeline. No extra standalone `model-reproduction.md` becomes a parallel evidence authority.
- [ ] Test tenant/source revocation, model/code hash changes, legacy versions and uninstall/record-deletion distinctions. Absent scientific validation is a premise; absent code or data access is an execution issue.

**Run:** existing domain/model integration tests and `node scripts/vcr/check-method-references.mjs` from `OpenScience/`.
**Expected:** one registration path per existing model kind and one numerical reference inventory. Commit: `feat(vcr): extend existing model contracts for research packs`.

### T05 — Audit the Alzheimer drug-disease-trial source model (P0)

**Files:** existing model records/metadata; `项目代码/vcr-engine/tests/numeric/N99_progression.R`; existing method-reference inventory; the current acceptance/evaluation ledger.

- [ ] Retrieve and inspect the C-Path/Rogers 2012 full text and supplements through permitted sources. Record version, equation/table/figure identifiers, original population, ADAS-cog scale, parameter values/covariance, variability, placebo/drug effects and dropout. Record unavailable components explicitly; the current tool-download page being under construction does not make abstract-based parameters sufficient.
- [ ] Separate the Rogers ADAS-cog model from the Jamalian 2023 CDR-SB model and the existing generic progression families. Decide which complete source version can be reproduced; never mix endpoint scales or claim the original tool's regulatory recognition for our code.
- [ ] Prefer base-R implementation using the existing runtime. Verify dependency and compute requirements before implementation; evaluate TGI–OS only if the AD source cannot support a useful scoped implementation, with a fresh source audit.
- [ ] Define numerical reference cases and reading tolerances in the existing test harness. Incomplete source reproduction still permits an explicitly assumed AD scenario; it does not count as published-model reproduction.

**Expected:** a source-bound implementation specification and numerical fixtures, with recoverable versus assumed components explicit. Commit: `docs(vcr): specify Alzheimer model reproduction references`.

### T06 — Extend progression simulation and numerical references (P0)

**Files:** existing `项目代码/vcr-engine/R/patients_progression.R`, `R/population.R`, `R/protocol.R`; new focused AD numerical cases under `tests/numeric/`; existing domain scenario/method metadata, `crossChecks`, `NUMERIC_REFERENCES` and original reference checker.

- [ ] Implement T05's source-supported progression/observation/effect/dropout components as a versioned extension or sibling method in the existing registry. Keep old generic progression output/version behavior readable. A beta observation distribution, logit mean evolution and random disease-onset model are distinct components.
- [ ] Add reference fixtures for endpoint bounds, baseline/time-zero behavior, published covariate effects, symptom offset versus slowed progression, zero-effect/null case, dropout and the separate parameter/individual uncertainty distributions. Prefer independently coded equations and tables; graph-digitized references carry their extraction uncertainty.
- [ ] Test population moments, model-specific power/type-I error, MCSE, paired contrasts, cancellation, resumed batches and bit-identical seeded results across admitted core counts in the pinned environment. Do not infer individual-patient accuracy from a population progression model.
- [ ] Wire the method through existing authorized jobs, source bindings and result readback; verify the actual feature path and report unsupported source components as assumptions. No independent clinical validation is required merely to run a technically valid hypothetical experiment.
- [ ] Keep PBPK and additional solver images out of the first release. If a later dose/exposure task requires them, pin that solver's OS/R/.NET/native-library stack and measure build size, startup, numerical parity and serving cost before proposing deployment.

**Run:** `bash tests/run_all.sh` from `项目代码/vcr-engine/`, `node scripts/vcr/check-method-references.mjs` from `OpenScience/`, and affected hosted engine tests.
**Expected:** an executable scoped disease-trial simulator with traceable numeric checks. Source reproduction, independent prediction validity and regulatory status remain separate. Commit: `feat(vcr): simulate source-bound Alzheimer trial scenarios`.

### T07 — Virtual population construction and model binding (P1)

**Files:** `vcrPopulationBinding.mjs` (new), `vcrService.mjs`, `vcrDataPlane.mjs`, domain contracts, `tabs/PopulationTab.tsx`, cohort plugin, and focused integration/UI tests.

- [ ] Support literature-constrained, built-in and authorized data-derived populations with explicit origin. Preserve correlated parameter draws and physiological constraints, not independent random values for every field.
- [ ] Bind a population version to a named model/use context; show computational readiness separately from validation evidence. Changing the model or target population invalidates only affected bindings/results.
- [ ] Provide member inspection, subgroup/coverage summaries and visible failed members. A generated record without a response model remains a valid descriptive object.
- [ ] Run the complete applicable existing synthesis/quality evaluation and preserve red/unknown findings. Add independent pack-specific calibration/validation checks for dynamic populations; do not optimize against the held-out evaluation.

**Expected:** a reusable population that can be used by multiple conversations and experiments, with correct person/member/future counts. Commit: `feat(vcr): distinguish descriptive and experiment-ready populations`.

### T08 — Batch patient trajectory workspace (P1)

**Files:** existing forecast/longitudinal paths and `PatientTrajectoryWorkspace.tsx` (new); patient plugin/skills; `apps/server/test/vcrTrajectoryBatch.integration.test.mjs` and component tests (new).

- [ ] Reuse existing provider batching/checkpoint hooks. Submit 100 fixture patients with valid, missing, invalid-unit and unsupported cases; verify every input patient has a terminal or resumable status and maps to the correct output.
- [ ] Define the provider's required input codes and action fields explicitly. The current numerical adapter may filter to endpoint codes by default; do not silently drop medication/dose/time inputs required by an action-conditioned model. Preserve the existing minimized-data and destination-authorization boundary.
- [ ] Separate origin time, observation availability, action-context mode and model horizon. Add tests where a post-anchor lab value or later-recorded medication would otherwise leak into prediction.
- [ ] Present per-person trajectories, cohort summaries and uncertainty provenance; no averaging away unsupported patients. Keep simulation draws distinct from additional people.
- [ ] Add new-observation updates as new prediction versions, with old-versus-new/observed comparisons. Preserve output across partial provider failure and account/source revocation boundaries.
- [ ] Evaluate existing full applicable HR data as a regression baseline, then evaluate the selected model against persistence/task-specific baselines with frozen selection and full-denominator reporting.

**Expected:** batch-first usability and scientifically scoped evaluation, including explicit unknown uncertainty. Commit: `feat(vcr): deliver batch patient trajectory predictions`.

### T09 — Laboratory v1: design experiments, then disease experiments (P0)

**Files:** `vcrExperiments.mjs` and `VirtualLabWorkspace.tsx` (new), domain experiment contract, trial components, source/result/report anchors and existing suite plugin.

- [ ] First create design experiments directly from existing `design.*` methods and stated assumptions; neither a new disease model nor a dynamic population object is mandatory for that task. Later accept owned disease/population/intervention sets, and attach existing saved results without rerunning them. Freeze all scientific inputs and comparison definitions.
- [ ] Compare at least three named arms for the same cohort, with explicit endpoint/time/unit alignment, incomplete-arm status and model-conditional interpretation.
- [ ] Expose trial-design calculations as a lab task; keep numerical design output separate from estimated biological efficacy. Offer evidence-only and result-explanation paths without scheduling computation.
- [ ] Verify edit -> new version -> old result readback, cancellation, resumed experiment, report/export and comparison of more than four candidates. No old result silently adopts a new model.
- [ ] Use existing native conversation and exact object references for revisions; show meaningful scientific decisions and tool results, not internal reasoning transcripts or implementation diaries.

**Expected:** user can conduct design experiments immediately and later add disease-response experiments without changing the workspace or forcing a full workflow. Commit: `feat(vcr): add hypothesis-driven virtual experiments`.

### T10 — Design search, staged precision and compute capacity (P0)

**Files:** `vcrExperimentSearch.mjs` (new), existing suite skill/tools, `vcrExperiments.mjs`, `OpenScience/evals/vcr-in-silico/search-benchmark.md` and evaluator (new).

- [ ] Define a frozen design candidate space, objective, nominal alpha or relevant safety constraints, search budget and stop conditions. Start after T03 and the design slice of T09, independently of T05/T06/T07. Implement section 9.1's analytic screening, low-precision candidate ranking and independent full-precision finalist validation. Reuse native DSH/LoopX for decisions/continuation; use durable scientific results for evaluation.
- [ ] Compare fixed expert/reference design, ordinary grid/random or Bayesian search as appropriate, and agent-directed search at matched computation/model-call budgets.
- [ ] Test null, harmful, no-feasible-solution and deliberately misspecified simulator cases. Reject infeasible proposals and retain negative outcomes; never tune the evaluator while searching.
- [ ] Add regression cases for screening-purpose replicate floors, accidental cache reuse across precision stages, selection bias, same-seed-but-different-draw candidates and a confidence bound that leaves alpha compliance inconclusive. Keep final precision floors and nominal error constraints unchanged.
- [ ] Profile a frozen 30-candidate workload on the actual runtime. Retain global concurrency 1 on the shared host; compare a dedicated-worker 1/2-job capacity configuration only in an isolated environment before recommending an operational change. Include queue/model/CPU/wall time and cancellation.
- [ ] Independently assess shortlisted candidates and report uncertainty, consumed budget, excluded cases and whether a genuinely useful improvement was found. Regret against an oracle is reported only for known-truth fixtures with an actual oracle.

**Expected:** a usable design-search loop with explicit compute/precision accounting, measured benefit or a documented no-gain result, and a documented retain-one-worker/dedicated-capacity decision. Commit: `feat(vcr): run bounded auditable experiment campaigns`.

### T11 — Temporal-model data and training baseline (P2 research)

**Files:** proposed `项目代码/vcr-world-model/{README.md,pyproject.toml,src/,tests/}`; `OpenScience/evals/vcr-in-silico/world-model-protocol.md` (new).

- [ ] Inventory an authorized longitudinal dataset with usable treatment and outcome sequences; record data-use/training/inference rights, source version and person/time/site splitting. Do not recycle the matching datasets as action-response training evidence.
- [ ] Freeze preprocessing, prediction anchors, supported action vocabulary and task-specific evaluation thresholds before model tuning. Measure resource use on a bounded training probe to produce a costed full-run manifest.
- [ ] Implement the comparison arms in section 8 with identical information access. Test preprocessing leak prevention and subject grouping before full training.
- [ ] Run all frozen applicable evaluation subjects; publish coverage, uncertainty, calibration and subgroup results for every arm. Record failed training runs and seed variation.

**Run:** `uv run pytest` from the proposed training package after its environment is pinned; full training/inference commands and resource caps are emitted by its frozen run manifest.
**Expected:** reproducible training/evaluation evidence, including a legitimate result that JEPA does not improve the chosen task. Commit: `research(vcr): evaluate temporal patient-state models`.

### T12 — Qualify learned or hybrid models for product use (P2 research)

**Files:** existing model records and their metadata, vetted inference adapter, proposed training package, independent evaluation manifests.

- [ ] Evaluate learned models for factual forecasting first, with external/time-transfer evidence where available. Compare inference cost and coverage, not just accuracy on successful rows.
- [ ] For a hybrid candidate, specify the mechanism/state interface and compare to each component. Distinguish a surrogate trained on a mechanistic simulator from an independently validated clinical model.
- [ ] Permit technically implemented intervention comparisons as model-conditional exploration; add stronger prediction/causal claims only when suitable evidence supports that exact question. Keep executable unvalidated modes available with explicit model-conditional premises; do not promote their claim to validated treatment comparison.
- [ ] Publish frozen checkpoint/preprocessing/readout identities and limitations through the existing model registry. Customer-specific weights and data remain appropriately scoped.

**Expected:** a runnable experimental model when technically available, with defaults and claims based on measured evidence rather than architecture. Commit: `feat(vcr): register evaluated patient dynamics models`.

### T13 — Integrate external/synthetic controls with shared objects (P1)

**Files:** existing synthetic-control package, `tabs/ComparatorTab.tsx`, domain comparator/scenario contracts, comparator job/result/report code; new `apps/server/test/vcrComparatorOrigins.integration.test.mjs`.

- [ ] Reuse existing estimators and their numerical tests; distinguish observed, reconstructed, model-predicted and fully simulated comparator inputs through analysis and exports.
- [ ] Exercise time-zero, eligibility, treatment, endpoint/time units, baseline-only adjustment, overlap and sensitivity checks. Preserve method-specific non-estimability.
- [ ] Reuse the full applicable ACTG175 reference assessment without upgrading it to real external-control evidence. Add known-truth transport/selection/confounding stress tests and separately identify the independent real external dataset needed for a transportability claim.
- [ ] Confirm a lab-simulated control stays model-conditional when used in a comparison and cannot be counted as new independent observed subjects.

**Expected:** complete comparison tasks with truthful evidence categories and reusable inputs. Commit: `feat(vcr): preserve comparator evidence origins across experiments`.

### T14 — Independent plugin packaging and compatible composition (P1)

**Files:** existing four domain packages, suite, research-plugin runtime, hosted protocol, runtime bundle tests and build inventory.

- [ ] Keep historical package/tool identifiers compatible in the first increment. Update displayed names/descriptions: cohort -> population task, patient -> trajectory task, trial -> design simulation within lab. The suite gains lab composition only as implemented, not as a claimed capability on rename.
- [ ] Each owned professional plugin must independently complete its stated task with common infrastructure and supplied/imported resources. A patient forecast cannot require installing cohort; a lab with an imported runnable population cannot require population UI installation; a comparator can accept authorized observed data directly.
- [ ] Extend exact native invocation admission and frozen method discovery for new experiment tools; do not leave `hostedProtocol.mjs` regexes or native transcript verification unaware of new names.
- [ ] Test each plugin alone, selected combinations and the optional suite; verify missing capabilities, disable/re-enable, compatible upgrades and uninstall preserving research objects.

**Run:** `pnpm test:research-plugins` from `OpenScience/` and actual clean standalone/hosted installation probes.
**Expected:** advertised tasks work independently; no suite imposes a fixed workflow. Commit: `feat(vcr): package compatible scientific research capabilities`.

### T15 — Integrated scientific and product acceptance (P1)

**Files:** `OpenScience/evals/vcr-in-silico/`, existing hosted harness and acceptance documentation, focused UI tests and browser evidence.

- [ ] Freeze source/data/model/prompt versions and scoring before the integrated campaign. Register temporary accounts, mark runs `automated`, disable memory extraction/learning and isolate each patient-containing workspace.
- [ ] Run the complete applicable population, batch forecast, intervention, comparison and agent-search cases through the actual feature path. Match exact result identifiers and numbers across native conversation, backend receipt, main result, historical version and export.
- [ ] Include open questions, evidence-only work, already available models, unsupported disease/drug, missing data, failure/partial results, stop/restart and no-benefit outcomes. No matching benchmarks in this campaign.
- [ ] Check desktop/390px navigation, loading/empty/error states, history without a session, five-area switching, keyboard focus, input preservation, data labels and matching route handoff. Store a few representative screenshots; numerical evaluation stays backend-driven.
- [ ] Obtain code/language, scientific/statistical and targeted access-boundary reviews. Resolve concrete findings, then run final relevant CI and real runtime checks on the integrated revision.
- [ ] Export evidence, delete only owned test accounts/workspaces/containers, reconcile usage and keep private clinical rows out of Git.

**Expected:** evidence distinguishes engineering completion, model quality and scientific scope; all requested cases and failures are accounted for. Commit: `test(vcr): qualify in silico research product paths`.

### T16 — Documentation and source delivery (P1)

**Files:** this plan's checkboxes/evidence, `OpenScience/PROGRESS.md`, `DESIGN.md`, design-system specification, plugin READMEs/SKILLs and release notes.

- [ ] Update the later owner decision in root `AGENTS.md` and `CLAUDE.md` byte-identically, and `OpenScience/AGENTS.md` through its `CLAUDE.md` symlink. State five entrances, lower research history, no mandatory seven-step rail, runnable unvalidated research with one premises block, and matching entrance-only ownership. Preserve old decisions as explicitly superseded history, not simultaneous requirements.
- [ ] Reconcile every public promise against an implemented/evaluated task. A trial-exposure demo is not described as clinical efficacy simulation; a model without counterfactual evidence is not a treatment optimizer.
- [ ] Record scientific scope, input needs, compatibility aliases, package availability, exact tests and unresolved data/model validation work.
- [ ] Commit and push reviewed source changes, verify remote identity and CI, and hand off matching-entry integration separately. Publishing packages, merging main and deploying production are distinct states.
- [ ] Leave production deployment/data migrations for the separately authorized release action. Do not remove the five-entry navigation's useful completed tasks because a research model remains experimental.

**Expected:** a reviewable release candidate and truthful gap list, not an implied deployment.

## 13. Execution order and milestones

Start with T01's short integration/ownership check, then T02 (five entrances). T03 (run and explain) and T08 (batch forecasts using existing models) proceed next, with T04's existing-record/schema alignment. The design slice of T09 plus T10 delivers laboratory v1 and compute improvements **before** the AD reproduction tasks. T05/T06 then add the first disease-response model; T07 binds reusable populations and T09 extends to disease experiments. T13/T14/T15/T16 apply to each increment. T11/T12 start only once useful longitudinal actions/outcomes, training rights and a costed resource plan exist. PBPK is demand-driven later work.

| Milestone | Deliverable | Completion evidence |
| --- | --- | --- |
| M1 | Five entrances and unified lower history | Navigation/draft/context/owner-handoff tests and desktop/mobile inspection |
| M2 | Runnable exploration and batch forecasts | Evidence-only limitations appear in one premises block; 100-patient accounting and no input leakage |
| M3a | Trial-design experiment/search lab with compute policy | Existing engine/reference checks, fixed alpha/safety constraints, screening/final precision distinction and matched-budget search/capacity measurements |
| M3b | First AD disease–drug–trial simulation | Source-bound/explicitly assumed model, numeric reference cases, actual experiment path and clear limitations; independent human validation is a separate evidence achievement |
| M4 | Reusable populations, broader comparisons and disease experiment search | Frozen objects, partial/result history, provenance, reproducibility and independent search assessment |
| M5 | Self-trained temporal-model advantage where demonstrated | Authorized longitudinal data, baseline comparisons, external/time validation and documented no-gain outcomes where appropriate |

Independent clinical validation upgrades the evidence statement; it is not a date-free lock on M3b or on exploratory laboratory access. Plan source audit and implementation effort after the baseline/resource check, without claiming an unknown disease-data acquisition date. The first laboratory milestone is now independent of new solver images and JEPA training.

Required responsibilities: platform/frontend integration; scientific computation/pharmacometrics; longitudinal data/ML; biostatistical/clinical validation; independent QA. One person may cover multiple roles, but the optimizer author cannot alone define and judge final held-out evaluation.

## 14. Acceptance scenarios and decision rules

| ID | Required scenario | Pass condition |
| --- | --- | --- |
| A01 | Open five entrances and legacy links | Correct destination and current context; no automatic job/study creation |
| A02 | Resume research with two conversations and saved artifacts | Correct grouping, exact selected result/version, no duplicated/missing research |
| A03 | Create a literature-based descriptive cohort without uploading patient data | Task completes with declared assumptions and no false intervention-readiness claim |
| A04 | Execute a model beyond its validation context; request an absent output/action | Runnable extrapolation executes with premises; missing mathematical output/action is reported as uncomputable; other results remain |
| A05 | Forecast 100 patients with mixed eligibility and multiple futures each | Complete denominator reconciliation, stable subject identity and uncertainty provenance |
| A06 | Supply future/late-available observations | No leakage before the prediction anchor; logged-action replay labeled separately |
| A07 | Run a three-arm model-based experiment | Same frozen scientific context, meaningful comparisons and immutable outputs |
| A08 | Ask for sample-size/operating-characteristic comparison only | Uses design tools without forcing a disease model or efficacy claim |
| A09 | Agent search finds no feasible beneficial candidate | Stops with a truthful result, evidence and consumed budget |
| A10 | Model exploits, extreme doses, unsupported latent states | Out-of-domain candidates identified; no promotion through proxy-score maximization |
| A11 | Combine simulated control with observed trial data | Origins and estimand remain explicit; simulated draws do not inflate observed sample size |
| A12 | Disconnect/restart/cancel during a batch | Partial results preserved; idempotent continuation and no duplicate charge |
| A13 | Switch account/revoke data/change model version | No foreign/stale input use; correct invalidation and historical readability |
| A14 | Matching entry or contextual return | Matching-owner destination works; no matcher changes or implicit data grant |
| A15 | Isolated plugin installation | Each advertised task works with supplied dependencies and no unnecessary sibling |
| A16 | End-to-end Chinese open-domain query | Appropriate tools selected, skipped stages remain skipped, evidence/result/report agree |
| A17 | First AD disease-response experiment | Actual AD trajectory/endpoint experiment with numerical reference cases; assumptions and incomplete source reproduction explicit; no inherited C-Path/FDA/EMA status and no independent-evidence runtime gate |
| A18 | Design-search screening and finalist validation | Small-replicate screening cannot satisfy final constraints; independent validation and MCSE retain fixed nominal alpha/safety requirements |
| A19 | Shared-host capacity and 30-candidate campaign | Existing concurrency/CPU limits respected; queue, throughput, precision, paired RNG and completion measured; dedicated capacity choice documented |
| A20 | Engine selection, completion timing and long original query | Chinese calculation query uses the applicable engine; completion during/after the turn reconciles exact result once; parameters beyond 160 characters retain verified original provenance |

Numerical tolerances are fixed per source/reference and account for rounding, digitization and Monte-Carlo error. Use existing method reference checks; do not use an arbitrary common tolerance for published figures. Scientific thresholds are endpoint/use-specific and predeclared: required calibration/coverage, clinically meaningful error or effect, failure coverage and comparator baseline. If those cannot yet be specified or independently tested, the release claim remains exploratory. Do not invent a universal 90% accuracy target or tune thresholds after seeing test scores.

## 15. Dependency register and carried-forward gaps

- Matching destination/contract: parallel owner supplies it; lack of a new contract permits preserving the existing entrance and does not block the four owned capabilities.
- AD source/code/parameter availability: T05 audits the actual publications and supplements; missing components may be explicit scenario assumptions, never invented source-derived parameters. No third registry or independent reproduction ledger is introduced.
- Independent disease-response evidence: upgrades an efficacy/prediction claim; it does not prevent running a technically available model-conditional experiment. No validation-grade switch hides a function.
- Longitudinal treatment/outcome data and training resources: prerequisites for T11/T12. Existing recruitment-partner access does not reveal missing trial-period treatment and outcome information.
- Existing synthesis quality: red/unknown bands remain visible until a newly frozen evaluation supports improvement.
- Engine selection: November 4 network-meta queries reached the engine in only 1/2 retests. Later plugin/native checks demonstrate improved execution paths, not universal intent reliability. T15/A20 repeats a frozen Chinese set, records actual tool selection and numerical agreement, and fixes measured routing failures without a mandatory workflow for ordinary questions.
- Completion delivery: November 4 reported jobs finishing during an unread busy turn with only an inbox notice. Later completion handling exists; the November 6 closeout still reports cold-stop/rebase cases returning saved-result notices without a new explanation. T09/T15/A20 cover finish-before-turn-end, finish-after-turn-end, busy root, cancel and cold restart; retain and deliver exact results once without duplicate billing or polling loops.
- Long original questions: `vcrOriginalHumanMessages` and `vcrOriginalHumanMessages.test.mjs` already read authorized original messages instead of the 160-character ledger preview. Keep the long-message regression, authenticated human scope and explicit four-page/one-MiB read bounds; missing/oversized source produces a stated provenance limitation, not a fabricated quotation. Do not describe the old defect as wholly unfixed.
- Compute: current source documents concurrency 1/shared four-core hosting; live serving resources were not inspected in this document review. Historical heavy-job limits motivate T10's measured staged search and capacity decision, not an unapproved production concurrency increase.
- Formal-B parser: explicitly skipped by the user after authentication failure. Continue using preserved structured sources and permitted parsing paths; any renewed real parser benchmark is separately scoped.
- Registry publication, main integration and production rollout: separate release actions. A Git commit or successful mock UI check proves none of them.

## 16. Definition of a successful first delivery

The researcher can enter through any of the five directions, reuse available assets, construct an honestly described virtual population, forecast an authorized patient batch, or execute a technically available pre-recruitment computational experiment and inspect its premises and evidence. Useful statistical/design and comparator work remains independently available. Research history preserves context without another top-level records function. Matching stays with its own owner.

The platform's scientific value is demonstrated by a reproducible, independently checked answer to a bounded research question. A latent model, an attractive interface, a large synthetic cohort or many completed computations cannot substitute for that evidence.


## 17. Execution record (2026-11-07/08)

Branch `codex/vcr-in-silico-20261107`, cut from `2f775ce82` (this plan's revision) and with `github/main` merged in (`9dea2f436`; main moved the kernel to DSH 0.2.2-rc.1). About 106 commits of this round. Nothing deployed; no production data touched. Work was done in streams with a written brief, then three independent reviews (statistics, engineering/access, product) and four rounds of real conversations on a local real-kernel harness (real control plane in kernel mode, real DSH kernel, real deepseek-v4-flash through the model gateway, real R engine, throwaway accounts deleted through the product; CNY 3.23 in total).

| Task | Outcome |
| --- | --- |
| T01 | Baseline `2f775ce82`; the matching workstream published no route/handoff descriptor, so the entrance keeps its last working destination and contextual handoff is recorded as unavailable. |
| T02 | Done: five entrances, aliases, `?area=records` archive, module root = lab entry, lower research history (one row per conversation, a saved-result row for a study without one); DESIGN.md and the design-system spec updated. Desktop 1440 px and 390 px checked in a real browser. |
| T03 | Done: `assessModelUse` (`executionIssues` vs `premises`), sentence premises in the one block, model-validity findings (input range, horizon, population, endpoint) reach the page. |
| T04 | Done: model identity pins source/weights/code/execution-spec hashes on existing records; parity test against the R 13-field mechanism format; an undeclared solver is an execution issue. No new registry. |
| T05 | Done: source audit of the CAMD/C-Path ADAS-cog model. Rogers 2012 is closed access (abstract only); the authors' released R package adsim 3.0 carries the simulation code and a 1,600-draw posterior that reproduces EMA 2013 qualification opinion Tables 7, 9 and 11 (medians within 0.12, 90% bounds within 0.25) and the training manual's printed numbers; Table 10 bounds and Figures 15–16 are not reproduced. |
| T06 | Done: `patients.progression` 1.1.0 family `beta_logit` (base R + jsonlite, no lock change), numeric cases N101a–m; premises say the parameters are the released posterior, the reproduction is partial, the drug effect is the researcher's hypothesis and no FDA/EMA status transfers. |
| T07 | Done: a patient set naming its population and model is the binding; readiness apart from evidence; a new model/population version marks only what read the old one. |
| T08 | Done except the real-data arm: per-person accounting (completed/rejected/failed/unprocessed), action-aware providers, cut at origin, replay apart from forecast, versions on new observations, per-person page behind a patient-level route. The PhysioNet/ACTG175 evaluation was not run here (private inputs are on the owner's machine); `evals/vcr-professional-plugins/RUN-20261107-batch.md` gives the command. |
| T09 | Done: design experiments (named arms, aligned definitions, saved results attached without rerun), disease experiments with Alzheimer arms (no drug / symptomatic / disease-modifying hypothesis), the lab view and its block in the study's report model (the docx/pdf templates do not print it yet). |
| T10 | Done: frozen campaigns over the existing queue (concurrency 1), screening precision only for a campaign's own units, Clopper–Pearson verdicts, finalists on new streams, seven stop reasons plus `inconclusive_at_precision`; the analysis level is a search variable below the frozen bound. Benchmark (`evals/vcr-in-silico/search-benchmark.md`): under the strict rule no log-rank design passes a 2.5% constraint at its nominal level; searching the analysis level passes at 2.2% (every run) and 2.35% (favourable streams only). Not done: the agent-directed benchmark arm and the 1-vs-2-job capacity test (needs an isolated worker). |
| T11 | Not started: no dataset with administered treatments, times and outcomes under training rights; inventory and frozen protocol in `evals/vcr-in-silico/world-model-protocol.md`. |
| T12 | Not started (depends on T11). |
| T13 | Done: observed, aggregate, reconstructed, model-predicted and simulated controls told apart in analysis, page and report; a simulated control adds no observed people; known-truth stress tests N102a–c. |
| T14 | Done: display names follow the entrances, ids unchanged; each plugin alone, in combination and uninstalled is tested. Packed standalone/hosted installation probes not run. |
| T15 | Reviews: engineering P0 4 / P1 4 / P2 5, statistics P1 6 / P2 18, product P0 2 / P1 10 / P2 17 — every P0 and P1 fixed with a regression test. Live: see below. |
| T16 | This record, `OpenScience/docs/TECHNICAL_DESIGN.md`, `OpenScience/docs/PRD.md`, `OpenScience/PROGRESS.md`. |

**Real conversations (A01, A07–A09, A16, A17, A20).** Phase 2 found D1–D10, phase 3 D11, phase 4 D12–D13; fixed in three rounds and re-tested. Holding at the end: the five entrances; a fixed-size run is never filed as a version of a power-solved design, and different grids stay separate; `vcr_simulate compare` runs and its differences come from the platform; a simulated type I error at the bound is said to be undecided in the reply, the page and the inbox; a stated alpha reads `你给的数据`; the Alzheimer three-arm question runs on the engine (12 runs where phase 2 had none) with the plan's premises on its page; a batch forecast with no provider no longer invents per-patient numbers. Still open: the model does not choose the lab's design *search* even when asked (it iterates single designs and grids on the engine instead and answers truthfully); a derived duration shows `假设` where the person gave an accrual rate; a job finishing after its turn (D5) was fixed in code but never occurred live; a new conversation cannot read an earlier conversation's study (D7). The root conversation's first request grew by about 345 characters, all of it `vcr_simulate`'s schema for the lab actions (its description stayed within its 420-character cap).

**Release steps when this ships:** rebuild the VCR engine image (new R sources and parameter file; the runtime lock is unchanged) and the runtime image; re-admit the trial bundle wherever its 5-tool receipt was admitted (a stale row now drops that bundle alone); re-probe `pnpm audit:capabilities` against the deployment (CI does not run it; the probe predates this round's MCP changes); the `evimed_vcr.experiments` table arrives by the ordinary migration.
