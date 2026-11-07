# In Silico Clinical Research Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Resolve these names to the installed equivalents when the namespace differs. Steps use checkbox (`- [ ]`) syntax for tracking. This document is an implementation specification, not an instruction to start training, purchase services, change production data, or deploy.

**Goal:** Deliver five understandable research entrances around reusable populations, batch patient forecasts, intervention experiments and comparison evidence, with patient matching owned by the separate workstream.

**Architecture:** Retain DSH + DeepSeek as the general execution foundation and the existing independently installable professional plugins, authorized object references, durable jobs and scientific engines. Add explicit population readiness, model use contexts and immutable experiment definitions; disease-specific mechanistic and learned transition models supply scientific behavior. Open-domain questions compose only the needed operations, while the interface presents the selected research object and its results.

**Tech Stack:** Existing React/TypeScript frontend, Node control plane, domain contracts, PostgreSQL persistence, DSH plugins and R engine; qualified external/open-source model adapters; a separately evaluated Python training package for temporal models when its data and resource prerequisites are met.

**Date:** 2026-11-07 (Asia/Shanghai).
**Source baseline inspected:** `d74ccaaf22294e10e2b08b4f0c667f7b38786086`, branch `codex/vcr-professional-plugins-20261105`.
**Status:** Plan written; the tasks below are unimplemented. Earlier source/runtime qualifications remain tied to their recorded revisions. This inspection did not establish the current production revision or the matching branch revision.

---

## 1. Owner decisions and scope

1. The five public entrances are **Virtual Population**, **Patient Trajectory Prediction**, **Virtual Laboratory**, **Synthetic Control Arm**, and **Patient Matching**. Chinese UI labels are specified in section 3.
2. Research records join the lower research/conversation history. They are not a sixth professional entrance. Keep durable studies, saved objects and result versions underneath that presentation.
3. A batch of 100 patients is an ordinary prediction input. Individual-level prediction describes the output resolution, not a one-patient input restriction.
4. Virtual patients can be generated before recruitment. A generated record becomes usable for an intervention experiment only with an applicable executable response model and population binding.
5. Trial-design simulation is one task within the laboratory. A general-purpose virtual trial also needs modeled intervention, evolving patient states, observation rules and endpoints.
6. DSH + DeepSeek remains the agent foundation. Use the approved Flash provider identity from the existing gateway; do not silently substitute Pro, introduce a second agent kernel, or train DeepSeek as part of this plan.
7. A researcher can ask only for evidence, inspect a model, compare existing results, or run a subset of an experiment. No compulsory sequence, new study form or hidden requirement to install every sibling plugin.
8. **Patient matching implementation, model/prompt tuning, retrieval/ranking, clinical rules, datasets, benchmarks, release and production operations belong to the parallel matching workstream.** This plan owns its entrance and explicit navigation/context handoff only.
9. No recruitment CRM, patient contact, center profiles, recruiting operations, or site staffing workflow is added.
10. No deployment, production deletion or automatic production migration is authorized by this document. The previously skipped formal-B parser evaluation stays skipped; it is not a prerequisite for unrelated work.

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

Use two separate axes rather than one green status:

- **Computational readiness:** descriptive-only; transition model bound; intervention mapping available for the selected experiment.
- **Evidence:** not evaluated; numerically checked; internally evaluated; externally evaluated for a named use; unsupported for the requested use.

Outputs include joint distributions, correlated parameters, missingness assumptions, representation of important subgroups, physical constraints, failed/unsupported members, weights and a reusable immutable reference. A population may be suitable for a dose-exposure question but unsuitable for an efficacy question. Do not call a synthetic baseline CSV a biologically executable patient population.

The individual view shows starting state, parameter uncertainty, provenance, model bindings and linked experiments. It is not a second competing population store or an independent conversation for each generated person.

### 3.2 Patient Trajectory Prediction

Default to batch input with stable subject keys. The first result reports total supplied subjects, eligible subjects, successfully predicted subjects, rejected subjects and unprocessed subjects; every subject has a status and reason.

Keep three prediction modes explicit:

1. Forecast under the stated observed/current-care context.
2. Conditional forecast under an explicitly supplied future treatment schedule.
3. Intervention comparison, available only through a model/use context evaluated for that purpose and linked to a laboratory experiment.

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

Data requirement labels describe the operation, not a blanket upload requirement. If a built-in pack or previously authorized data already satisfies it, show that resource as available. Model-unavailable and unsupported-intervention states explain the missing capability without disabling evidence review or other completed results.

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
  "modelRef": {"id": "example-pack", "version": "1.0.0"},
  "populationRef": {"id": "example-population", "version": "3"},
  "predictionMode": "conditional_forecast",
  "useContext": {
    "endpoint": "plasma_concentration",
    "unit": "mg/L",
    "horizon": {"value": 24, "unit": "hours"},
    "population": "pack-defined adult population",
    "interventions": ["pack-defined single-dose administration"]
  },
  "observationPolicy": {"times": [0, 1, 2, 4, 8, 24], "unit": "hours"},
  "uncertainty": {"parameter": "declared_distribution", "structural": "not_quantified"},
  "claim": "model_conditional_simulation"
}
```

Do not pass `hours` into the current days/weeks/months/years interface without an explicit adapter/unit conversion. Dose amount, amount-per-weight, route, infusion duration, frequency, concentration and exposure units require dimension-aware conversion. All requested times must be within the model's supported horizon.

Use the closed mode vocabulary `factual_forecast`, `conditional_forecast`, and `intervention_comparison`. The experiment field `predictionMode` maps explicitly to `request.mode` when calling the applicability check; they are not two independent settings. A conditional forecast is permitted to be model-conditional without a causal claim.

The shared use check should return inspectable reasons, not a single permanent certification flag. A minimum pure contract test is:

```javascript
import assert from 'node:assert/strict';
import { assessModelUse } from '../src/vcrModelUse.mjs';

const pack = {
  executable: true,
  supportedModes: ['factual_forecast'],
  validation: [{mode: 'factual_forecast', population: 'fixture-adults',
    endpoint: 'heart_rate', horizonHours: 24, evidenceRef: 'fixture-evidence'}],
};
const findings = assessModelUse(pack, {
  mode: 'intervention_comparison', population: 'fixture-adults',
  endpoint: 'heart_rate', horizonHours: 24,
});
assert.equal(findings.some(x => x.code === 'mode_not_supported'), true);
```

`assessModelUse(pack, request)` is to be introduced in task T03; it checks explicit modes, population, endpoint, intervention, horizon and usable evidence references. Missing provenance must never be interpreted as external validation. A finding restricts the unsupported operation/claim and preserves other results; it does not restore the retired whole-package withholding gate.

### Result accounting and uncertainty

Use distinct counts for observed people, observed stays, virtual members, treatment arms, stochastic futures and simulated trials. A 100-patient input with 100 futures each remains 100 input patients. Preserve partial batches and reconcile submitted = completed + rejected + failed + unprocessed. Match uncertainty to its source: parameter draws, observation variability, fitted-model uncertainty, structural alternatives and Monte-Carlo error.

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

### First pack selection, not a hidden indication commitment

Keep the platform generic. Start with one bounded computational use case and one independently evaluated patient-prediction task.

- Engineering reference: a fully specified one-compartment IV exposure model with an analytic solution. This is a solver/contract fixture, explicitly not a disease efficacy model.
- First reusable upstream candidate: the OSP **midazolam** package, assessed for adult single-dose exposure only. Before adopting it, inspect the model-specific license, executable dependencies, evaluation datasets, route/range scope and whether calibration/evaluation data overlap. This is a candidate, not an already selected/validated EviMed model.
- If that candidate cannot be reproduced or legally used, task T05 records why and evaluates another OSP adult exposure package by the same checklist. An upstream-access failure does not cause invented parameters or a renamed statistical scenario to substitute for it.
- First disease-response pack: a separate selection deliverable comparing available public QSP/disease models on executable availability, intervention coverage, calibration data, independent human outcome evidence and domain-specialist ownership. Only a qualifying pack earns an efficacy/toxicity simulation claim. The exposure milestone stays valuable but does not satisfy this milestone.

Model imports should preserve native artifacts and use the upstream runtime where appropriate. Do not translate a PBPK system into a simplified R equation merely to fit the current executor. Do not install an arbitrary package supplied through a model card at request time. Register vetted adapters with frozen dependencies.

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

Use known-truth simulations for counterfactual engineering tests; use independent randomized or defensibly designed causal evidence for treatment-comparison validation. Keep factual forecasting, model-conditional scenarios and supported intervention comparisons as distinct release claims. Prospective claims need prospective evidence. A model without measured improvement can remain an experimental candidate without being promoted into the default product.

Commercial-use and data-use permissions for MIMIC/other sources, paper code and pretrained weights must be checked per artifact. Existing n2c2 permission is not blanket permission for unrelated data or model vendors. No new data transfer or GPU training is performed by writing this plan.

## 9. Autonomous experimentation with bounded objectives

The agent can propose interventions or trial designs within the frozen supported domain, execute experiments through admitted tools, inspect structured results and propose another candidate. Reuse native DSH tools and existing LoopX continuation for long goals; no new universal workflow DSL or custom second agent loop.

Every campaign freezes objective, constraints, population sampling policy, evaluation model(s), search space, maximum candidate/compute/model-call budgets and stopping rules. Inferred objectives are stated before costly work; ordinary small requests do not grow into full campaigns.

Stop reasons include budget exhausted, acceptable precision, no useful improvement, unsupported candidate, persistent model failure, user cancellation, and no feasible beneficial candidate. All candidates and changes remain in history, including failed and unfavorable ones.

After search, evaluate shortlisted candidates using held-out draws and, where available, independent data or structurally different models. Common random numbers can reduce variance in supported paired comparisons, but remain a simulation variance technique, not causal evidence. An optimizer may not alter endpoints, drop nonresponders, increase simulated sample size until a tiny effect is significant, or tune the validation set without opening a new explicitly labeled exploratory campaign.

A latent visualization supports inspection; the search acts on admissible, decoded scientific interventions. The default decision report includes plausible adverse/null cases and the next real measurement that would most reduce uncertainty. Model-generated trajectories may train an emulator as synthetic data, but cannot serve as independent clinical confirmation of the generating model.

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
| Capability-pack records | `OpenScience/apps/server/src/vcrStore.mjs`; `vcrModelApplicability.mjs`; `vcrModelSources.mjs` | `OpenScience/apps/server/src/vcrModelPack.mjs`; `OpenScience/models/vcr/README.md`; candidate manifests under that directory |
| Population bindings | `OpenScience/apps/server/src/vcrDataPlane.mjs`; `vcrService.mjs`; `OpenScience/apps/web/src/components/vcr/tabs/PopulationTab.tsx`; engine `R/population.R` | `OpenScience/apps/server/src/vcrPopulationBinding.mjs` and integration test |
| Batch predictions | `OpenScience/apps/server/src/vcrForecastProvider.mjs`; `vcrLongitudinal.mjs`; `vcrLongitudinalStore.mjs`; domain `vcrForecastEvaluation.mjs` | `OpenScience/apps/web/src/components/vcr/PatientTrajectoryWorkspace.tsx` and test |
| Model execution adapters | `OpenScience/apps/server/src/vcrJobs.mjs`; `vcrWorker.mjs`; `vcrEngineClient.mjs`; domain `vcrEngineJob.mjs`, `vcrScenarioSchemas.mjs`; engine `R/protocol.R` | `OpenScience/apps/server/src/vcrSimulationAdapter.mjs`; `项目代码/vcr-engine/R/exposure_reference.R`; adapter-specific runtime files only after T05's runtime decision |
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

### T03 — Scientific use and experiment contracts (P0)

**Files:** proposed domain modules in section 11; existing `vcrModelInterfaces.mjs`, `vcrObjectReference.mjs`, `vcrContracts.mjs`, exports and domain tests.

- [ ] Introduce `assessModelUse(pack, request)` with the concrete mode-separation test in section 6. Add mismatched population/endpoint/horizon/action/unit, missing evidence, unconfigured execution and old-card compatibility cases.
- [ ] Define immutable experiment/population binding records and deterministic reference hashing using the existing canonicalization primitives. A seed or action-schedule change produces a distinct execution identity.
- [ ] Add a representation for action-conditioned transitions without relabeling the existing `event_history_to_trajectories` interface as causally qualified. Declare initial-state construction and clinical readouts separately.
- [ ] Keep old result readers and baseline cards readable. Unsupported operations return reasons while unrelated results remain deliverable.

**Run:** `pnpm test:domain` from `OpenScience/`.
**Expected:** new mismatch tests fail before implementation and pass afterward; historical contract tests remain green. Commit: `feat(domain): define model use and immutable experiment contracts`.

### T04 — Capability-pack registry and provenance (P0)

**Files:** `apps/server/src/vcrModelPack.mjs` (new), `vcrModelApplicability.mjs`, `vcrModelSources.mjs`, `vcrStore.mjs`; new `apps/server/test/vcrModelPack.test.mjs` and `vcrModelPack.integration.test.mjs`.

- [ ] Implement pack metadata and reference resolution in the existing durable document/revision store. Validate digest, supported units/horizons/actions, license metadata and executable adapter availability; a card URL alone cannot register executable code.
- [ ] Preserve separate evidence for numerical verification, factual prediction and intervention use. Do not permit the model or a user-edited display label to upgrade that evidence.
- [ ] Test tenant isolation, revoked source access, changed weights, missing adapter, old versions and deletion/uninstall distinctions.
- [ ] Render a concise applicability summary in context; keep raw manifests and runtime details in inspectable technical evidence.

**Run:** `node --import ./scripts/test/localhostProbeGuard.mjs --test apps/server/test/vcrModelPack.test.mjs` from `OpenScience/`; run the integration counterpart with the repository's isolated PostgreSQL runner.
**Expected:** no cross-scope read or runtime installation from a card; historical references survive upgrades. Commit: `feat(vcr): register scoped scientific capability packs`.

### T05 — Select and reproduce the first executable pack (P0)

**Files:** `OpenScience/models/vcr/README.md` (new), selected pack manifest, `OpenScience/evals/vcr-in-silico/model-reproduction.md` (new), adapter source only after selection.

- [ ] Inspect the OSP midazolam candidate and at least one alternative against section 7's license/data/runtime/scope checklist. Record rejected candidates and choose one only on evidence; no paid dependency is silently selected.
- [ ] Reproduce the upstream reference simulation in its supported environment from frozen inputs. Compare parameter units, dosing events, concentration curves and exposure summaries to the published/reference artifacts.
- [ ] Select the smallest integration adapter preserving upstream behavior; record native runtime/dependency versions and measured memory/CPU needs. Existing R stays the statistical engine; native upstream solving is not approximated for convenience.
- [ ] Produce a separate disease-response candidate assessment. Explicitly state whether any candidate supports a human clinical outcome and whether an independent dataset is available. Keep an unqualified disease-response capability unavailable without blocking exposure work.

**Expected:** a reproducible candidate pack, executable command captured in its manifest, license decision and independent-validation inventory; or a concrete unavailable reason. Commit: `feat(vcr): qualify the first scoped simulation pack` only when a pack actually qualifies; otherwise commit the assessment as documentation.

### T06 — Numerical execution adapter and exposure reference (P0)

**Files:** `vcrSimulationAdapter.mjs` (new), jobs/worker/engine/domain anchors in section 11, `项目代码/vcr-engine/R/exposure_reference.R` (new), a registered numerical test and `apps/server/test/vcrSimulationAdapter.integration.test.mjs` (new).

- [ ] Establish an engineering fixture with `C(t) = (dose / V) * exp(-(CL / V) * t)`, all units explicitly normalized. Example fixture: dose 100 mg, V 10 L, CL 1 L/hour gives C(0)=10 mg/L and C(10)=10/e mg/L.
- [ ] Require relative error at most `1e-6` against that analytic fixture under the stated solver tolerance. Test zero/negative volume rejection, route mismatch, unit conversion, repeated event ordering and invalid time grids. This tolerance is a numerical target, not a clinical accuracy claim.
- [ ] Implement vetted adapter dispatch through existing admission/lease/budget/receipt mechanisms; preserve model/data/action hashes and exact producing adapter identity.
- [ ] Test cancellation, partial output, checkpoint restart, duplicate submission, lease loss, provider unavailability, source withdrawal and a model version change during execution. No duplicate paid/model job after retry.
- [ ] Reproduce T05's exposure pack through the same hosted boundary, not just a developer-side command.
- [ ] Once T05 selects a qualifying disease-response pack, integrate it through the same boundary and reproduce an independently reserved clinical endpoint/trajectory comparison under its supported interventions. Retain a separate open scientific dependency if no pack/data qualifies; the exposure demonstration does not close this item.

**Run:** `bash tests/run_all.sh` from `项目代码/vcr-engine/` using the pinned dependency environment; the new server integration test uses the isolated product runner.
**Expected:** fixture correctness and actual adapter execution proven separately. Commit: `feat(vcr): execute versioned intervention simulations`.

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

### T09 — Laboratory experiments and comparisons (P1)

**Files:** `vcrExperiments.mjs` and `VirtualLabWorkspace.tsx` (new), domain experiment contract, trial components, source/result/report anchors and existing suite plugin.

- [ ] Create an experiment from an owned model/population/intervention set, or attach existing saved results without rerunning them. Freeze all scientific inputs and comparison definitions.
- [ ] Compare at least three named arms for the same cohort, with explicit endpoint/time/unit alignment, incomplete-arm status and model-conditional interpretation.
- [ ] Expose trial-design calculations as a lab task; keep numerical design output separate from estimated biological efficacy. Offer evidence-only and result-explanation paths without scheduling computation.
- [ ] Verify edit -> new version -> old result readback, cancellation, resumed experiment, report/export and comparison of more than four candidates. No old result silently adopts a new model.
- [ ] Use existing native conversation and exact object references for revisions; show meaningful scientific decisions and tool results, not internal reasoning transcripts or implementation diaries.

**Expected:** user can conduct and inspect one actual bounded intervention experiment before recruitment. Commit: `feat(vcr): add hypothesis-driven virtual experiments`.

### T10 — Bounded iterative experiment search (P1)

**Files:** `vcrExperimentSearch.mjs` (new), existing suite skill/tools, `vcrExperiments.mjs`, `OpenScience/evals/vcr-in-silico/search-benchmark.md` and evaluator (new).

- [ ] Define a frozen candidate space, objective, constraints, search budget and stop conditions. Reuse native DSH/LoopX for decisions/continuation; use durable scientific results for evaluation.
- [ ] Compare fixed expert/reference design, ordinary grid/random or Bayesian search as appropriate, and agent-directed search at matched computation/model-call budgets.
- [ ] Test null, harmful, no-feasible-solution and deliberately misspecified simulator cases. Reject infeasible proposals and retain negative outcomes; never tune the evaluator while searching.
- [ ] Independently assess shortlisted candidates and report uncertainty, consumed budget, excluded cases and whether a genuinely useful improvement was found. Regret against an oracle is reported only for known-truth fixtures with an actual oracle.

**Expected:** measurable search benefit or a documented no-gain result; no endless success-seeking loop. Commit: `feat(vcr): run bounded auditable experiment campaigns`.

### T11 — Temporal-model data and training baseline (P2 research)

**Files:** proposed `项目代码/vcr-world-model/{README.md,pyproject.toml,src/,tests/}`; `OpenScience/evals/vcr-in-silico/world-model-protocol.md` (new).

- [ ] Inventory an authorized longitudinal dataset with usable treatment and outcome sequences; record data-use/training/inference rights, source version and person/time/site splitting. Do not recycle the matching datasets as action-response training evidence.
- [ ] Freeze preprocessing, prediction anchors, supported action vocabulary and task-specific evaluation thresholds before model tuning. Measure resource use on a bounded training probe to produce a costed full-run manifest.
- [ ] Implement the comparison arms in section 8 with identical information access. Test preprocessing leak prevention and subject grouping before full training.
- [ ] Run all frozen applicable evaluation subjects; publish coverage, uncertainty, calibration and subgroup results for every arm. Record failed training runs and seed variation.

**Run:** `uv run pytest` from the proposed training package after its environment is pinned; full training/inference commands and resource caps are emitted by its frozen run manifest.
**Expected:** reproducible training/evaluation evidence, including a legitimate result that JEPA does not improve the chosen task. Commit: `research(vcr): evaluate temporal patient-state models`.

### T12 — Qualify learned or hybrid models for product use (P2 research)

**Files:** model-pack registry, vetted inference adapter, proposed training package, independent evaluation manifests.

- [ ] Evaluate learned models for factual forecasting first, with external/time-transfer evidence where available. Compare inference cost and coverage, not just accuracy on successful rows.
- [ ] For a hybrid candidate, specify the mechanism/state interface and compare to each component. Distinguish a surrogate trained on a mechanistic simulator from an independently validated clinical model.
- [ ] Qualify intervention comparison only with suitable causal/randomized/mechanistic validation evidence for the exact intended question. Keep unsupported modes disabled while permitted forecasts remain available.
- [ ] Publish frozen checkpoint/preprocessing/readout identities and limitations through the existing model registry. Customer-specific weights and data remain appropriately scoped.

**Expected:** a narrowly qualified model or an experimental-only record, never automatic promotion based on architecture. Commit: `feat(vcr): register evaluated patient dynamics models` only after qualification.

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

- [ ] Reconcile every public promise against an implemented/evaluated task. A trial-exposure demo is not described as clinical efficacy simulation; a model without counterfactual evidence is not a treatment optimizer.
- [ ] Record scientific scope, input needs, compatibility aliases, package availability, exact tests and unresolved data/model validation work.
- [ ] Commit and push reviewed source changes, verify remote identity and CI, and hand off matching-entry integration separately. Publishing packages, merging main and deploying production are distinct states.
- [ ] Leave production deployment/data migrations for the separately authorized release action. Do not remove the five-entry navigation's useful completed tasks because a research model remains experimental.

**Expected:** a reviewable release candidate and truthful gap list, not an implied deployment.

## 13. Execution order and milestones

Engineering sequence: T01 -> T03 -> T04; T02 can proceed once ownership/aliases are frozen. T05 -> T06 -> T07 -> T09 -> T10 provides the intervention vertical slice. T08 starts after T03/T04 using already available forecast models and does not depend on a new exposure-model adapter. T13 reuses the same contracts. T14/T15/T16 qualify each completed increment. T11/T12 are a parallel R&D lane with explicit data/model prerequisites, not a condition for releasing mature capabilities.

| Milestone | Deliverable | Completion evidence |
| --- | --- | --- |
| M1: understandable product | Five entrances, lower unified history, matching handoff boundary, accurate labels | Native entry/navigation tests and actual desktop/mobile review; no new scientific claim |
| M2: executable population/forecast foundation | Qualified pack metadata, population binding and batch forecasting | Exact model/input identity, per-subject accounting, scoped model evaluation |
| M3a: exposure experiment | One qualified exposure use with actual population/arm simulation and comparison | Independent reference reproduction and feature-path results; no efficacy claim |
| M3b: disease-response experiment | A scoped disease/intervention model with clinical trajectory or endpoint readouts | Independent disease-response evidence and actual feature-path experiment; M3a alone does not close M3b |
| M4: useful iterative research | Bounded agent search and independent candidate assessment | Matched-budget comparison including null/adverse/no-gain cases |
| M5: proprietary model advantage | Learned/hybrid model demonstrating repeatable gain in a defined use | Frozen independent evaluation, data rights, applicable scope and resource evidence |

Engineering effort can be estimated after T01/T05 identify the shared-branch conflicts and upstream runtime. Do not publish a clinical-validation deadline or GPU budget before the data inventory and resource probe. Functional releases can proceed incrementally; research uncertainty is not hidden in a nominal feature completion percentage. Completion of the full disease-response vision requires M3b/A17; a useful exposure or forecasting release must retain that gap if it is still open.

Required responsibilities: platform/frontend integration; scientific computation/pharmacometrics; longitudinal data/ML; biostatistical/clinical validation; independent QA. One person may cover multiple roles, but the person optimizing a model cannot alone define and judge its final held-out evaluation.

## 14. Acceptance scenarios and decision rules

| ID | Required scenario | Pass condition |
| --- | --- | --- |
| A01 | Open five entrances and legacy links | Correct destination and current context; no automatic job/study creation |
| A02 | Resume research with two conversations and saved artifacts | Correct grouping, exact selected result/version, no duplicated/missing research |
| A03 | Create a literature-based descriptive cohort without uploading patient data | Task completes with declared assumptions and no false intervention-readiness claim |
| A04 | Bind a population to a compatible model; change endpoint beyond scope | Supported use executes; unsupported use names the gap while preserving results |
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
| A17 | First disease-response virtual experiment | Applicable interventions and clinical readouts reproduced against independent evidence; an exposure-only model cannot satisfy this case |

Numerical thresholds are fixed per reference method before evaluation (T06 gives a concrete analytic tolerance). Scientific thresholds are endpoint/use-specific and predeclared: required calibration/coverage, clinically meaningful error or effect, failure coverage and comparator baseline. If those cannot yet be specified or independently tested, the release claim remains exploratory. Do not invent a universal 90% accuracy target or tune thresholds after seeing test scores.

## 15. Dependency register and carried-forward gaps

- Matching destination/contract: parallel owner supplies it; lack of a new contract permits preserving the existing entrance and does not block the four owned capabilities.
- First model license/runtime/data: resolved by T05's concrete candidate assessment; unavailable components are not silently replaced by fabricated models.
- Independent disease-response evidence: required for that claim, not for all evidence work, descriptive populations or qualified exposure simulation.
- Longitudinal treatment/outcome data and training resources: prerequisites for T11/T12. Existing recruitment-partner access does not reveal missing trial-period treatment and outcome information.
- Existing synthesis quality: red/unknown bands remain visible until a newly frozen evaluation supports improvement.
- Existing continuation after cold runtime rebase: preserve saved results and review completion delivery in T15; do not claim every resume already produces a fresh AI explanation.
- Formal-B parser: explicitly skipped by the user after authentication failure. Continue using preserved structured sources and permitted parsing paths; any renewed real parser benchmark is separately scoped.
- Registry publication, main integration and production rollout: separate release actions. A Git commit or successful mock UI check proves none of them.

## 16. Definition of a successful first delivery

The researcher can enter through any of the five directions, reuse available assets, construct an honestly described virtual population, forecast an authorized patient batch, or execute a qualified pre-recruitment computational experiment and inspect its evidence. Useful statistical/design and comparator work remains independently available. Research history preserves context without another top-level records function. Matching stays with its own owner.

The platform's scientific value is demonstrated by a reproducible, independently checked answer to a bounded research question. A latent model, an attractive interface, a large synthetic cohort or many completed computations cannot substitute for that evidence.
