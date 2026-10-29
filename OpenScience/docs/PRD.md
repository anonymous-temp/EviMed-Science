# AI4S Workbench Desktop — Product Requirements

> **Read this as the v0.1 desktop product definition, not as how the system works
> today.** It was written on 2026-07-02 for the local-first desktop workbench, when the
> runtime was a bundled OpenCode sidecar. Two things have since changed underneath it.
> The release target moved from a desktop app to the hosted multi-tenant SaaS, and the
> agent kernel became **DeepSeek Harness**; OpenCode was deleted on 2026-09-01, with no
> rollback lever. Wherever a section below says "the bundled OpenCode runtime", the
> current system runs a per-project DSH container that only the control plane may reach.
> `AGENTS.md` and `docs/WEB_DEPLOYMENT.md` are authoritative on how it actually works;
> what is still worth reading here is the product intent — who it is for, what an
> artifact owes its reader, and which capabilities were promised.
>
> **Original status (v0.1, 2026-07-02).** Built: the three-column workbench UI, real
> multi-session chat with history, a real Skills/Agents view, BYOK key config, and a
> macOS installer. Literature search, provenance/reviewer, code-execution backends, and
> Science Packs below were the target scope, not all shipped.
>
> **Positioning today (2026-10-12).** EviMed is a general-purpose agent platform first — writing,
> office documents, spreadsheets, slides, code, data, the open web, scheduled work — and a
> professional platform for medicine second; “research workbench” below describes the medical
> layer, which loads when the task or the content is medical and is never a precondition for other
> work. Memory and the knowledge base run on OpenViking's native engine for the accounts and
> projects on it (the engine extracts, merges and recalls memory; documents are pushed to it as
> Resources and compiled into a wiki and a graph by its official skills), and both are shown to the
> user as maps, pages and graphs. The root `AGENTS.md` is authoritative.


## Current UX requirements (2026-10-20; VCR revised 2026-10-25/26)

These presentation decisions supersede conflicting September 23, October 7/8 and October 14/19 rules precisely as described below. Earlier records remain historical; this is an acceptance target, not a claim that the implementation has passed. See `../../docs/superpowers/plans/2026-10-19-workflow-rectification.md`, October 20 owner review.

- Global home, logo and New Conversation open the general AI assistant without inherited GEO/study title, progress or specialist binding. Resume-project links are explicit; preserve history, drafts and native tabs. The VCR home offers four task intents in the existing native composer and resumable research. Results and historical links remain reachable; there is no mandatory New Study form or manual method entry journey (VCR reset, 2026-10-25/26).
- Keep the eight GEO steps reachable with visible current/completed/waiting state and next actions, including during conversation. VCR instead has six result destinations (overview, matching, population/patients, comparator, trial, evidence/data), no mandatory step rail, and an optional full programme only when explicitly requested. The October 19 compact-control ruling removes redundant navigation, but a compact selector alone cannot be the only discoverable workflow. Use one conversation and one native composer; remove the redundant Chat button when it is open. Preserve project identity, results, actual run history and the native DSH right pane.
- Research Tools remains the shared discovery surface for professional workflows and non-VCR task-oriented tools. VCR numerical methods are AI-callable tools, not calculator catalogue entries or manual parameter forms; reference-trial research is available from global AI and the study evidence context. This supersedes the October 14 fixed catalogue inventory as a restriction on those method entries. Small calculations need not traverse a full study. Show a short purpose, required inputs, expected outputs and reachable next action; meaningful examples, missing prerequisites and remedies are explicitly permitted. The older blanket no-hint/no-purpose-text rule applies only to explanations of implementation, not useful task guidance.
- Related inputs, configuration, progress and result tables/plots belong together in one analysis workbench in the main area, with responsive tabs where useful. This is an explicit exception to the older one-object/one-shape rule, not permission to stack unrelated metadata. For VCR, the main area holds results, source-linked assumptions and comparisons; configuration and revisions use the native conversation, with only small structured edits in context. Other workbenches retain their existing configuration and literature-to-parameter mapping; drawers hold short previews or small edits. Do not repurpose the native right pane or add another file/browser system.
- Share reference-trial search across global AI and the study evidence context, with contextual reuse in the current research. Distinguish live results from saved status and source failures. Literature parameters retain values, units, passages, missing fields and destination mapping; registration alone never claims executability. Retain configuration/source versions and immutable historical results.
- The saved population object owns criteria, source data, included/excluded/unknown counts, selected version and cohort results. Select account-level reusable template versions in that context, preserve Save as Template/Use Template and compatible links, and recalculate changed criteria as a new version without overwriting history.
- Keep design tokens, default Chinese UI, keyboard/mobile access, ordinary-account access and user/project/tenant boundaries. Technical implementation, source-proof machinery and operator jargon stay out of UI; scientific sources needed to judge or reuse parameters remain available in context. No added approval ceremony or clinical delivery gate. Preserve existing quality budgets and acceptance checks; do not weaken them merely to pass unusable UI. A measured workbench-specific template change must express this connected workflow, not excuse unrelated stacked content.

## Current VCR product contract (2026-10-25/26)

Last updated: 2026-10-26. This section is the current VCR requirement, superseding the earlier seven-step, method-catalogue and recruitment/OA requirements. It records the approved scope, not deployed or clinically validated behavior. See the [product reset](../../docs/superpowers/specs/2026-10-25-vcr-ai-native-product-reset.md), [review](../../docs/superpowers/specs/2026-10-25-vcr-ai-native-reset-review.md) and [implementation plan](../../docs/superpowers/plans/2026-10-25-vcr-ai-native-implementation.md).

Four task entries prepare a draft in the existing native composer: patient matching, populations and virtual patients, comparator research, and trial-design simulation. The user may also start directly in global conversation. No module switch, manual study/PICO definition or statistical parameter form precedes a narrow task. A complete research programme is optional and starts only on an explicit request. The six result destinations are overview, matching, population/patients, comparator, trial and evidence/data. Group composition and an individual's supported observations/trajectory share one population workspace; old patient links remain readable. Historical calculations preserve configuration and results as read-only history.

The working sequence is goal → inspect available data and saved objects → retrieve/preserve evidence → bind justified parameters → ask only for research facts that change the next operation → choose a supported method and explain the reason → execute deterministic tools → read saved results and uncertainty → revise in the same conversation. Source-supported parameters come before asking the user to supply event rates, effects or dropout. Nearby evidence may support a labeled exploratory assumption and sensitivity range; it never establishes target-population transportability. The model interprets and composes; numerical engines calculate. A failed operation leaves its honest partial result and reason, never an invented number.

| Task | Minimum input | Supported result and boundary |
|---|---|---|
| One patient → trials | Original patient case/record and preserved trial criteria | Candidate assessments with quoted criterion evidence, missing facts and recheck dates; no real-patient table required |
| Trial → real patients; real cohort | Uploaded or connected authorized patient-level records, criteria and field meanings | Selected members, included/excluded/unknown counts and version comparison; no invented patient source |
| Literature/assumed population or hypothetical individual | Published baseline parameters or explicit distributions, dependencies and model assumptions | Engine-generated synthetic records/trajectories, labeled by origin; no mandatory patient dataset |
| Predict for real patients | Baselines, predictor units/coding and an executable model appropriate to the declared question | Scoped prognosis; missing predictors stay unknown, and local validation/calibration is stated separately |
| Actual external control | Comparable target/control exposure and outcomes, index dates and confounder IPD | Applicability, overlap/balance and supported estimates or a precise not-estimable result |
| Literature comparator or prediction benchmark | Preserved published evidence or a scoped executable equation plus target baselines/population | A descriptive benchmark; no identified causal effect or extra real/effective N |
| Trial-design simulation | Endpoint/design question and sourced or explicit control, effect, accrual, observation and dropout assumptions | Engine-computed design comparisons, sample size/power/precision and uncertainty; patient data only for an empirical calibration claim |
| Train/calibrate a model | Appropriate authorized longitudinal exposures/outcomes and a validation design | Only the fitting/calibration operations actually supported; registration does not establish an executable or validated model |

Input requirements and present availability are separate facts, visible at the task entry outside its button and in contextual empty states. Connected data satisfies an input requirement without redundant upload. One operation's dataset need never becomes a gate for all VCR work. A protocol, registry result or reconstructed survival curve is not complete patient-level covariate/exposure/outcome data. Pre-enrolment information, exit date/reason and post-trial care do not reveal hidden study treatment or outcomes during the trial. Unknown criteria are retained as unknown, not counted as exclusions or zero.

A cohort is a collection, whether real, derived or synthetic. A virtual patient is an individual record or a supported modeled trajectory; a synthetic member and baseline-conditioned prognosis for a real person remain different products. Neither earns a digital-twin claim merely by being generated. A virtual trial means trial-design simulation, with treatment effects supplied as hypotheses, not drug-approval proof or a decentralized trial. Comparator results distinguish observed external controls, literature benchmarks, prognostic adjustment within a randomized trial and hybrid borrowing. A model prediction is a scoped benchmark, not an observed control arm, an identified treatment effect or a replacement RCT.

The current model contract covers intercept-only exponential, Weibull, lognormal and loglogistic survival fits, preserving observed versus reconstructed pseudo-IPD, and closed typed linear/logistic/Cox published equations with exact coefficient/source/unit bindings. A Cox equation without baseline survival and its reference supports relative scores only. Predictor centering/scaling is explicit; paper text is never executable code. Registration, executable specification, source-population applicability, calibration and clinical validation are distinct states. Fitted control use requires an explicitly selected source arm and condition. Lognormal/loglogistic curves stay available even though the current reference-patient/design adapter supports exponential/Weibull only. Parameter sensitivity quantiles are not individual outcome percentiles or full assurance; treatment effects need separate evidence or assumptions.

Long jobs remain part of their originating conversation through durable, idempotent completion. The task context belongs to the verified native root session; it neither adopts another study nor rebinds a general project/session. Local matching can run independently of the heavy-engine queue; the engine's physical concurrency limit remains in force. Adjust/compare actions carry exact object and result versions into the same composer, retain old versions and invalidate only actually bound evidence dependencies. Mean full-study duration uses simulation `duration_months`; an optional abstract accrual forecast describes last-patient-in timing separately.

Selected patient evidence follows current record grants, field/time-window restrictions, withdrawal and cloud permission. Aggregate results retain small-cell suppression. Synthetic labeling alone does not authorize cloud access; native generated-record access requires verified independent generation ancestry, and empirical/upload-derived data keeps its controlled path. Source generation/hash, exact quotations, literal units and baseline bindings are verified. Derived evidence verifies quoted inputs only; it is not relabeled as a reported observed baseline.

Recruitment operations are removed: no contact, referrals, coordinator queues, site CRM, enrollment/follow-up task management, recruitment materials or operational forecasting alerts. Matching assessments/rechecks, scientific longitudinal observations and protocol measurement schedules remain. Existing legacy data is not deleted at startup. The explicit archive-first offline retirement utility preserves a private verified archive before any approved table/role mutation; the old writers must be stopped and kept stopped. No serving-database retirement or deployment is part of this implementation task. Registry results disclose actual source/date/status/eligibility coverage; CDE and ICTRP are not restored.

Acceptance must distinguish source/permission correctness, numerical correctness, the model's use of tool results and the final answer to the user's goal. Local synthetic browser walks, actual DSH/model task completion, native-control comparison, clinical validation and production user acceptance are separate records. No method count, fixture render or registered model substitutes for these records.

## 1. Positioning

**AI4S Workbench Desktop** is an open-source AI research workbench with macOS /
Windows installers, positioned as an **open-source alternative to Claude Science
style products**.

It is not an ordinary paper-summarization tool. It is a local-first, model-agnostic,
reproducible, auditable research agent workbench that helps researchers do:

- Literature search
- Paper parsing
- Data analysis
- Code execution
- Figure generation
- Report writing
- Citation checking
- Artifact provenance
- Reusable research workflows

Slogan:

> Open-source AI research workbench for reproducible science.

## 2. Goals

### 2.1 Phase 1 goal

Phase 1 must be a genuinely installable desktop app, not a CLI tool.

Required support:

| Platform | Installer | Priority |
| --- | --- | --- |
| macOS Apple Silicon | `.dmg` / `.app` | P0 |
| macOS Intel | `.dmg` / `.app` | P1 |
| Windows x64 | `.exe` NSIS installer | P0 |
| Windows x64 | `.msi` installer | P1 |

Tauri officially supports macOS and Windows and can package `dmg`, `app`, `nsis`,
and `msi` targets; Windows can ship as `.msi` or an NSIS `setup.exe`.

### 2.2 Differentiation

Versus ordinary AI paper tools, AI4S Workbench is different because it is:

1. A research workbench, not a chat box.
2. A generator of traceable artifacts, not just text.
3. Model-agnostic (BYOK / OpenRouter / OpenAI-compatible / local), not tied to one model.
4. Transparent — it keeps code, data, figures, reports, logs, and provenance — not a black box.
5. Multi-domain — expanding from biology to AI4S, materials, chemistry, biology,
   medicine, engineering, and industry.

## 3. Target users

### 3.1 Core users

1. **Researchers** — fast literature reviews; organizing papers, data, figures,
   reports; reproducibility and citation accuracy.
2. **AI4S / AI-for-Science developers** — integrating scientific skills, MCP, and
   database connectors into one workbench; an open-source Claude Science alternative.
3. **Grad / PhD / postdoc students** — topic surveys, paper reading, experiment data
   analysis, submission material prep.
4. **Open-source AI agent users** — already using OpenCode, Codex, Claude Code, Cursor,
   MCP, Agent Skills; want a research-focused desktop product.

### 3.2 Non-target users (Phase 1)

- Complete beginners who cannot configure an API key.
- Users needing clinical diagnosis or medical decisions.
- Institutions needing multi-user collaborative SaaS.
- Teams needing enterprise permissions, audit, or SSO.

## 4. Core product principles

### 4.1 Local-first

Runs on the user's machine by default. Project files, corpora, figures, reports, and
execution logs are stored in a local workspace.

### 4.2 Model-agnostic

No lock-in to Claude, OpenAI, or any single local model. Users can choose OpenRouter,
OpenAI-compatible APIs, the Anthropic API, or local models; Ollama / vLLM / LM Studio
support follows.

### 4.3 Reproducibility-first

Every important artifact must be traceable:

| Artifact | Must trace to |
| --- | --- |
| Figure | generating code, input data, parameters |
| Report | citation sources, data sources, analysis steps |
| Table | raw data, cleaning script |
| Conclusion | citations, data, model output |
| Agent action | time, tool, input, output, status |

### 4.4 Human-in-the-loop

High-risk actions — file writes, command execution, dependency installs, network
access, file deletion, remote compute — require user approval. The agent runtime provides
dangerous-command approval, container isolation, MCP credential filtering, and
cross-session isolation. In the hosted deployment the approval policy is `never`, and
`never` means auto-refuse rather than auto-approve: inside the sandbox nothing needs
approval, so the only things that ask are attempts to step outside it, and refusing
those is exactly right for an unattended run.

## 5. MVP scope

### 5.1 P0 features

#### 5.1.1 Install & first launch

After downloading and first opening, the user enters onboarding:

1. Choose a model provider.
2. Enter an API key.
3. Choose a workspace directory.
4. Detect the local runtime environment.
5. Use the bundled agent runtime (auto-started; no separate install).
6. Create the first research project.

First launch must clearly tell the user: data is stored locally by default; the agent
requests authorization before running commands; the user must supply their own model
API key; research results need human verification and are not final conclusions.

#### 5.1.2 Home

Shows: recent projects, new project, example workflows, current runtime status, model
connection status, local workspace status.

Recommended default examples: Literature Review, Bibliometric Analysis,
Paper-to-Report, Dataset Analysis, Citation Review, Reproducibility Audit.

#### 5.1.3 Research agent workspace

The main work area, in a three-column layout:

```text
Left:   projects / workflows / files
Middle: agent chat + plan + execution progress
Right:  artifacts / citations / review / run logs
```

Core interaction: user submits a task → agent produces a plan → user confirms →
agent runs tools → each step shows status → artifacts land in the Artifact panel →
reviewer checks automatically → user exports the report.

#### 5.1.4 Plan confirmation

For multi-step tasks the agent must produce a plan before executing.

```text
Goal:
Data sources:
Steps:
Expected artifacts:
Risks & limitations:
Actions requiring authorization:
```

User options: Approve · Edit Plan · Run Step by Step · Cancel.

#### 5.1.5 Literature search

v1 sources: arXiv, PubMed, Crossref, OpenAlex, Semantic Scholar (optional API key),
local PDF import.

Features: keyword search; filter by year and source; dedup; export `corpus.csv`; save
search logs; record data-source limits.

#### 5.1.6 Skills library

The Skills page lists the **real** skills and agents the runtime has loaded — no
hardcoded catalog. Skill sources, layered:

1. **Runtime built-in** skills/agents (shipped with the kernel).
2. **Self-authored AI4S skills** — `deep-research`, `domain-check`,
   `manuscript-humanize`, `publication-figures`, `stats-integrity`,
   `traceability-review`, `humanizer`/`humanizer-zh`, `large-file`, and the
   compute skills `hpc-slurm`, `modal-run`, `remote-compute` (Markdown skills
   under `runtime/skills/core`). In the hosted deployment these are baked into the runtime
   image rather than copied per project.
3. **Third-party scientific skills** — e.g. K-Dense `scientific-agent-skills` (curated
   install, a later feature).

K-Dense `scientific-agent-skills` is a collection for science/research; its README
describes ~148 skills and compatibility with Claude Code, Codex, Cursor, OpenCode, and
other Agent Skills hosts.

#### 5.1.7 Code execution

v1 languages: Python, Shell (R later).

| Mode | Notes |
| --- | --- |
| Local | Run directly in the local workspace |
| Docker | Run in an isolated container |
| SSH | Remote server execution (later) |
| Modal | Cloud execution (later) |
| Jupyter Kernel | Notebook-style persistent kernel (later) |

The desktop shell runs tools locally inside the bundled runtime by default; Docker
sandbox and SSH / Modal remote execution are optional advanced backends, so the desktop
starts local and expands later. The hosted deployment has no local mode: every run is a
Docker sandbox.

#### 5.1.8 Artifact panel

All outputs land here. Types: Markdown reports, CSV tables, PNG / SVG figures, PDFs,
Python scripts, notebooks, JSONL provenance, review reports.

Each artifact shows: filename, type, created time, generating step, input data,
generating code, review status, and export / copy / open actions.

#### 5.1.9 Provenance

Each project auto-generates `provenance.jsonl`, `manifest.json`, and `review.md`.

`provenance.jsonl` records each step, append-only:

```json
{
  "step_id": "step_001",
  "type": "literature_search",
  "tool": "openalex",
  "input": {},
  "output_files": ["data/corpus.csv"],
  "timestamp": "",
  "status": "success"
}
```

#### 5.1.10 Reviewer panel

v1 reviewer does basic checks: citations exist; DOI / PMID / arXiv IDs are
well-formed; figures have generating code; tables have source data; reports include
limitations; no untraced artifacts; no steps the agent claims but never ran.

## 6. UI design requirements

### 6.1 Keywords

Modern, restrained, refined, research feel, tool feel — not flashy, not a traditional
admin panel, not a low-quality AI wrapper. Reference vibes: Linear's simplicity,
Cursor's technical feel, Notion's information structure, Raycast's command palette,
Vercel's cleanliness, Claude's warmth.

### 6.2 Visual style

Light theme (default):

| Use | Suggestion |
| --- | --- |
| Background | warm white / soft gray |
| Primary | deep indigo / blue violet |
| Accent | teal / cyan |
| Success | soft green |
| Warning | amber |
| Error | soft red |
| Text | near black / slate |

Dark theme:

| Use | Suggestion |
| --- | --- |
| Background | near black / deep navy |
| Card | dark slate |
| Primary | blue violet |
| Accent | cyan |
| Text | soft white |

### 6.3 Main layout

```text
┌─────────────────────────────────────────────────────────┐
│ Top Bar: Project / Model / Runtime / Sync / Settings    │
├──────────────┬──────────────────────────┬───────────────┤
│ Sidebar      │ Main Agent Workspace      │ Artifact Dock │
│ Projects     │ Chat / Plan / Execution   │ Files         │
│ Workflows    │ Progress Timeline         │ Figures       │
│ Skills       │ Code Blocks               │ Tables        │
│ Connectors   │ Reports                   │ Citations     │
│ Settings     │                          │ Review        │
└──────────────┴──────────────────────────┴───────────────┘
```

### 6.4 Core pages

- **Home** — welcome card, new project, recent projects, example workflows, runtime status, model status.
- **Project Workspace** — agent chat, execution timeline, plan approval card, tool-call cards, artifact dock, review warnings.
- **Literature** — search, filter, list, abstract preview, PDF status, citation info, add to corpus, export BibTeX / CSV.
- **Data & Code** — file tree, Python scripts, notebook preview, CSV preview, run history, environment dependencies.
- **Artifacts** — figure gallery, report preview, table preview, provenance chain, download / export.
- **Review** — citation check, figure provenance check, data source check, reproducibility check, risk warnings, limitations.
- **Skills** — installed skills, recommended scientific skills, install from GitHub, enable / disable, view `SKILL.md`, check license, check dependencies.
- **Settings** — model provider, API keys, workspace path, runtime backend, security approvals, update settings, appearance theme, data cleanup.

## 7. Key interactions

### 7.1 Plan card

Must be clean and clear. Contains: goal, step list, tools to call, expected artifacts,
risk notes, run buttons. Buttons: Approve & Run · Edit Plan · Run Step-by-step ·
Save as Workflow.

### 7.2 Tool-call card

Shows: tool name, status, input summary, output summary, duration, token / cost
(optional), view details, copy log. Status: Pending · Running · Waiting Approval ·
Success · Warning · Failed.

### 7.3 Approval dialog

For dangerous actions — delete file, overwrite file, install package, run shell,
network access, connect remote server, upload file — a dialog must confirm. Options:
Allow Once · Always Allow for This Project · Deny · View Details.

### 7.4 Command palette

Shortcut: `Cmd + K` (macOS) / `Ctrl + K` (Windows). Quick actions: new project, search
literature, run reviewer, open settings, switch model, install skill, export report.

## 8. MVP example workflow

v1 must ship one complete demo:

```text
2023–2026 brain-computer interface literature trends
```

Outputs: `plan.md`, `data/corpus.csv`, `scripts/analyze.py`, `figures/year_trend.png`,
`figures/topic_clusters.png`, `figures/top_keywords.png`, `report.md`, `review.md`,
`provenance.jsonl`. Used for README, website, screenshots, video, and launch.

## 9. Roadmap

- **v0.1 Desktop MVP** — macOS / Windows installers, local workspace, bundled OpenCode runtime,
  model config, agent chat, plan approval, literature search, Python analysis, artifact
  panel, `provenance.jsonl`, basic reviewer, BCI demo.
- **v0.2 Research Workflows** — K-Dense skills installer, PDF parsing, citation checker,
  Markdown report export, workflow template library, fuller review panel.
- **v0.3 Notebook Runtime** — Jupyter Kernel Gateway, persistent Python kernel, notebook
  preview, R support, Quarto / PDF / DOCX export.
- **v0.4 Advanced Science** — BioMCP; PubMed / GEO / ChEMBL / UniProt connectors;
  RDKit / py3Dmol; single-cell and molecular-screening templates; HPC / SSH / Modal runner.

## 10. Non-functional requirements

### 10.1 Performance

Cold start < 3s (excluding first-time runtime init); no noticeable UI jank; streaming
agent output; live tool-call refresh; paginated large-file preview; lazy-loaded
figures; virtualized log lists.

### 10.2 Security

API keys encrypted locally; workspace sandbox isolation; dangerous-command approval;
no file upload by default; no full-disk access for the agent by default; access limited
to the current project directory; all network access auditable.

### 10.3 Maintainability

Frontend, desktop shell, and agent runtime decoupled; pluggable skills; configurable
MCP servers; extensible model providers; stable artifact schema; versioned workflow
templates.

### 10.4 Open-source friendliness

Clear first-screen README; one-click install; one-click demo; nice screenshots;
complete example results; clear license; separate note for third-party skill licenses.

## 11. One-liner

**AI4S Workbench Desktop is an open-source research agent workbench with macOS and
Windows installers that uses an agent kernel, MCP, scientific skills, and a reproducible
artifact system to weave literature, code, figures, reports, and review into one
local-first scientific workflow.**
