# Working notes (lead) — evaluation of v1.0 and design decisions

Not part of the published plan; persisted so an interruption does not lose the reasoning.

## Keep from v1.0 (strong)
- Value-level provenance vocabulary; four counts kept apart (observed patients / events / ESS / generated records; prior ESS separate).
- Intended use vs review state separated; no universal "regulatory-grade" badge; context-of-use validity (ICH M15).
- "Not estimable" is a complete, valid result; no LLM numbers; generated trajectories never narrow CIs.
- Prognostic adjustment is not a control arm; digital twin label reserved; exit != readout; three clocks; missingness reasons; unknown treatment != no treatment.
- Knowledge / model / method packages as the source of generality; model card fields.
- Persistent business objects, transcripts only provenance; immutable execution snapshots; stale flags.
- 24 acceptance scenarios.

## Gaps -> improvements
G1 Evidence moat unused -> 证据参数化 pipeline (precedents + literature -> quote-anchored arm-level extraction -> meta engine pooling -> predictive distributions / robust MAP priors -> assumption cards). Differentiator vs Cytel/FACTS/nQuery (user guesses) and Unlearn (needs IPD).
G2 No aggregate-data comparators -> add route 文献对照: benchmark meta-analytic control rate; MAIC/STC once own IPD exists; pseudo-IPD from published KM (Guyot); provenance adds reconstructed / aggregate.
G3 Trials lack decision metrics -> ADEMP-structured spec, MCSE-driven replicate count, assurance/PoS over evidence priors, clinical scenario evaluation (assumptions x options x metrics), analytic quick calc + simulation check; group sequential via rpact in V1.x.
G4 Recruitment method unspecified -> Poisson-gamma + site activation, priors from registry precedents + partner funnel, Bayesian update with actuals, forecast vs actual.
G5 IA conflicts with owner's accepted patterns (GEO: study=project, composer chip, AI runs, <=7 tabs, empty tab 「让 AI 做」, no forms, no approval gates) -> home = four actions + study list + model/method library; study page = progress rail + 7 tabs (总览 人群 虚拟患者 对照 试验 匹配与招募 数据与证据).
G6 Data boundary not enforceable -> dataset vault outside the runtime workspace; engine-only row access; model sees schema, dictionary and aggregates (small cells suppressed) — engineering choice (quality, cost, reliability), not compliance language.
G7 Compute: 4-core shared host cannot run Monte Carlo at scale -> engine on a separate elastic pool, budgets, checkpoints.
G8 Schedule: scope vs 12-16 w with 2+1+1 unrealistic as stated; with AI-assisted build the code is fast, validation + partner data are the long poles -> phases by data condition.
G9 Matching approach -> criteria structured once; code evaluates structured thresholds/time windows, model judges free text with evidence spans; unknown stays unknown; partner's historical referrals + screening outcomes = real Chinese eval set.
G10 V1 models -> literature parametric models (reconstructed control-arm survival, published effect sizes) as a model tier between 情景 and 数据/验证.
G11 Regulatory-facing package -> HARPER / STaRT-RWE / TARGET / ADEMP / FDA CID simulation report; credibility tiers by model risk.
G12 Market -> design-stage chain self-serve for individual researchers (EviMed is to-C); data-connected enterprise tier.
G13 Naming -> keep 合成对照 page; route names 真实外部对照 / 文献对照 / 模型预测对照 / 混合对照 / 预后校正.
G14 TCM syndrome dimension in knowledge packages (differentiator).
G15 Root object: 研究定义 (question, PICO, estimand, intended use) drafted by AI from the first message.
G16 Operational feedback loop = self-iteration (forecast vs actual, matching vs formal screening, reviewer corrections -> eval cases).
G17 v1.0 §15.5 outdated: GEO is live at /app/geo, sidebar row after 科研工具.
G18 Capabilities (GEO-style, display.listed false): study-design-evidence, virtual-population, synthetic-control, virtual-trial, trial-matching.
G19 Engine: new deterministic engine container (R + Python, pinned), invoked by the control-plane worker; runtime tools go through a gateway; rows never in /workspace.
G20 Engine input contract: ADaM-like (subject-level + long BDS + time-to-event) analysis views per snapshot; OMOP/FHIR adapters later.

## Owner constraints to honour
- Decisions not experiments; no competitor bake-offs; owner to-do minimal.
- AI drives the whole flow; human review is a non-blocking sign-off; stops only for real-world actions (contacting patients) and compute budget.
- No consent dialogs / compliance gates / legal citations (memory: compliance out of scope). Keep engineering data-protection defaults framed as product choices.
- UI: consistent with DSH/native and the design spec v2.1 (tabs <= 7, data page template, one brand moment, rivals grey, no subtitles, no system-explaining text).
- Product-reader document: value first, figures, PDF beside Markdown.
