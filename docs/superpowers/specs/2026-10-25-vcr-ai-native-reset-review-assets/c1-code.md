# C1 — Code review of the 2026-10-25 VCR product reset (虚拟临床研究)

- Repo: /workspace, branch main at beb9ea944.
- This is a read-only review. No repo file was edited and no test suite was run. Commands used: `rg`, `sed -n`, `wc`, and tiny `node -e` / `python3 -I -c` imports.
- Paths are relative to the repo root. `OS/` means `OpenScience/`.

Section order:
- Summary
- Q1: tools and reachability, plus §1.6, the calculator catalogue
- Q2: recruitment / OA inventory
- Q3: engine, and Q6: models
- Q4: data plane, and Q7: verification of the prior review's claims
- Q5: programme, Q8: evidence parameterization, and Q9: registries

## Summary

**Method.** I wrote Q1 and the calculator inventory (§1.6) myself. Four parallel review forks drafted Q2–Q9, and I re-checked each draft against its decisive lines; each section ends with a note of what I re-read. **All seven claims from the prior review are confirmed.**

**Bottom line.** Most of what the reset needs already exists, but only inside a *study's own conversation*:
- That conversation's bound analyst, `vcr-protocol`, already writes objects, queues engine jobs and reads results back.
- The engine already covers phases 2 and 3 statistically.
- Matching needs only a definition and criteria.

What the code makes hard is everything *around* that conversation:
- the engine can be reached only from a study's project;
- a background programme runs steps nobody asked for;
- the platform has a single compute slot, and its results never come back into the conversation;
- recruitment is wired into matching, the trial timeline and the role model, not kept in a module of its own.

Several individual-level views are also wrong in the data layer, not only in the UI.

### Easy: exists already, needs a small change
- **The conversational analyst.** Every study conversation is bound to `vcr-protocol`, whose brief is to do the step asked, write the object, queue the engine and read the result back (`OS/capabilities/vcr-protocol/capability.yaml:3-15,31-38`; bound at `OS/apps/server/src/vcrService.mjs:646-650`). Its tool list lacks `curve_digitize` and `dataset_semantics` (`capability.yaml:43-57`).
- **Study-less aggregate compute.** The root-visible `research_calculate` already runs `design.analytic` and `comparator.evalue` on the VCR R engine under a made-up study id (`OS/runtime/mcp/evimed-research/research_calculate.py:22`; `OS/apps/server/src/resultVcrReplay.mjs:11,143-147`). Widening its method list is the narrowest way to give an ordinary conversation the aggregate design methods.
- **Light matching prerequisites.** The `matching` step needs only `definition` (`OS/packages/domain/src/vcrVocabulary.mjs:445-453`) plus criteria on a protocol version (`OS/apps/server/src/vcrComposition.mjs:729-732`). It needs no endpoint, effect or assumption card. The definition writer accepts any non-empty PICO or estimand (`OS/apps/server/src/vcrGateway.mjs:761`), and the analyst writes a minimal one itself. Virtual patients do need an endpoint type (`OS/apps/server/src/vcrOrchestrator.mjs:1197-1199`).
- **Removing auto-referral is a local edit.** It is the referral and notice half of `onJobFinished` (`vcrComposition.mjs:826-859`). Keep `candidateReferrals()` as the candidate-list filter (`:579`).
- **Fixing scenario comparison is small.** The simulators were built for common random numbers (`项目代码/vcr-engine/R/simulators.R:9-16`). The defaults defeat them: the seed is the scenario hash (`OS/apps/server/src/vcrJobs.mjs:232-240,659`) and virtual-patient ids embed the job id (`项目代码/vcr-engine/R/engine.R:820`).
- **The engine is broad enough for phases 2 and 3.** It has 32 R methods: external, literature and hybrid controls, Guyot reconstruction, MAIC, RMST, AIPW, weighted Cox, MAP, analytic and simulated designs, and assurance. They are hand-written, but each is cross-checked in CI against the reference package (§Q3.1). For registry records the chain is complete: evidence → pooled card with a prediction interval → binding into a design → lineage (§Q8).
- **The frontier "VCR trial events" do not depend on recruitment** (`OS/apps/server/src/vcrFrontierEvents.mjs:94-101,181-185,242-279`).

### Hard: structural
1. **A study is a project.**
   - The gateway finds the study from the token's project; without one it answers `404 vcr_no_study` (`vcrGateway.mjs:2149-2153`).
   - Creating a study always creates a new project (`OS/apps/server/src/vcrRoutes.mjs:668-686`).
   - The VCR tools are not on the root list (`OS/packages/domain/src/toolNames.mjs:250-281`).
   - An entry from an ordinary conversation therefore needs one of: (a) a study attached to the existing project; (b) study-less aggregate methods; (c) an entry that creates the study project and continues the conversation there.
2. **The programme works against goal-first.**
   - A study created with a question requests all seven steps (`vcrService.mjs:365-369`).
   - A defined study with nothing requested gets all seven backfilled (`vcrOrchestrator.mjs:376-385`).
   - A study runs one step at a time (`:3126-3131`), and matching is dispatched last (`:3137-3147`).
3. **Compute does not fit a conversational loop.**
   - One job runs at a time across the whole platform (`OS/apps/server/src/config.mjs:1114`; `vcrJobs.mjs:964-974`). Matching and forecasts share that queue (`vcrComposition.mjs:1132-1135,1184-1188`), and the R service has one worker (`项目代码/vcr-engine/service/app.py:635-645`).
   - `vcr_simulate` waits at most 20 s by default (60 s max), then tells the model to end the turn (`OS/runtime/mcp/evimed-research/vcr_platform.py:131-139,1098-1116`).
   - Completion produces only an inbox notice and a toast that polls every 20 s (`vcrOrchestrator.mjs:2914-2930`; `OS/apps/web/src/components/vcr/useVcrFinishedToasts.ts:10`).
   - A job over the 7,200 CPU-s study budget waits for a person to confirm it (`config.mjs:1117-1119`).
4. **Recruitment is woven through the code.**
   - About 5,300 lines to delete across about 42 files, of which about 1,900 are production source.
   - The files are mixed: `vcrRecruit.mjs`, `vcrMatchStore.mjs`, `presentMatchingTab`, `MatchingTab.tsx`.
   - Three tables must be dropped, and live databases have role CHECK constraints that carry `recruiter`/`site` (`OS/apps/server/src/vcrPersistence.mjs:172,512,1211-1276`).
   - The erasure SQL reads `referrals` (`OS/apps/server/src/vcrErasureStore.mjs:289-299,314`).
   - The release walk and its fixture encode 「匹配与招募」, referrals, sites and the method workbench (`OS/scripts/ops/ui-walk.mjs:194-195,417,1631,1645`; `OS/scripts/ops/walk-fixture/vcr.mjs:7`).
5. **Accrual coupling, which matters in phase 3.**
   - The 虚拟试验 trade-off chart takes its duration only from an accrual forecast (`OS/apps/server/src/vcrViews.mjs:873-874,1052-1058`).
   - The conversation can build that forecast only from the site CRM and the referral ledger (`vcrGateway.mjs:2359-2373`). A study without sites is refused (`vcrComposition.mjs:941-942`).
   - Rewire the forecast to stated assumptions before, or together with, deleting the CRM. The schema already allows this (`OS/packages/domain/src/vcrScenarioSchemas.mjs:805-818`).
6. **Registries for Chinese users.**
   - Only ClinicalTrials.gov v2 and EU CTIS give structured records.
   - ChiCTR is list-only, through the EviMed evidence API, with no eligibility text. CDE is unsupported. ICTRP is excluded (`OS/apps/server/src/trialRegistryClient.mjs:102,788-860,1363-1375`).
   - ChiCTR criteria are stored without a location in the source text, and with no warning (`vcrGateway.mjs:994-999`).
   - The owner has ruled out CDE recovery.

### Wrong today: defects the plan must budget for
- **The single-patient read is broken.**
  - It returns the first row only.
  - For longitudinal sets the patient's position is null, and person-visits are counted as people.
  - Trajectories are always null, because no engine method writes `y0`/`y1` (`OS/apps/server/src/vcrRows.mjs:283-299,406,435,445,457-468`).
- **The model has no read of virtual-patient rows.** `vcr_read patients` returns metadata only (`vcrService.mjs:1579-1588`), so a conversational individual view does not exist.
- **Matching evidence is uneven.**
  - Trial→patient carries quotes only for candidates found in documents (`vcrComposition.mjs:435,639-676`).
  - Candidates from the subject table carry none, and their values are hidden even from study members (`OS/apps/server/src/vcrMatchingTable.mjs:31-34`).
  - Patient→trial has no chart quotes (`OS/apps/server/src/vcrPatientTrials.mjs:487-509`).
  - The empty state hides the direction toggle (`OS/apps/web/src/components/vcr/tabs/MatchingTab.tsx:171-180`).
- **Auto-referral fires on every match job.**
  - The 15-minute recheck fires it again, and nothing switches it off.
  - Every owner is a `lead` holding `contact_patients`, so 「招募待办」 reaches ordinary owners (`vcrComposition.mjs:841-859,1176`; `OS/apps/server/src/vcrWorker.mjs:59`; `vcrVocabulary.mjs:564`; `vcrService.mjs:566-577`).
- **"Follow-up data stays as research input" is not true today.**
  - `followup_episodes` is shown only, under the recruitment tab, and `vcr_read` cannot read it.
  - The `study_specific` kind refuses treatment and outcome fields for every source (`vcrService.mjs:1164`; `vcrGateway.mjs:1658-1677`).
  - The research input that does exist is the longitudinal history pipeline.
- **Models.**
  - There is no individual prediction model.
  - A literature "model" is quoted numbers bound to the four reference simulators (`OS/apps/server/src/vcrModelSources.mjs:1`; `vcrService.mjs:231-311`).
  - `model_comparator` can never succeed (`vcrService.mjs:419-420`; `vcrOrchestrator.mjs:737-741`).
  - Adopted cards with no literature source are labelled 「拟合预测」 (`vcrService.mjs:1306-1307`).
- **Routing.**
  - The five module-only capabilities are classifier candidates from any project (`OS/apps/server/src/agentRegistry.mjs:388-390`; `OS/apps/server/src/server.mjs:6241,7393`).
  - `vcr-protocol` requires only `question`, so a misroute ends at `vcr_no_study`.
  - No routing eval covers this.
- **Evidence.**
  - Journal literature cannot anchor a card (`OS/capabilities/vcr-evidence/SKILL.md:102-103`).
  - `#freeze` attaches every card to every object, so one card edit marks unrelated results stale (`vcrOrchestrator.mjs:2803-2818`).

### Prior-review claims
All seven are confirmed (details in Q7):
1. The single-patient read returns the first visit only, and the trajectory is null.
2. Virtual-patient ids embed the job id, and there are no common random numbers.
3. The matching empty state hides the toolbar.
4. The forecast entry is absent when there are no longitudinal records.
5. The `study_specific` restriction applies to every source.
6. In-study method links open `/app/capabilities/methods` and highlight 科研工具.
7. Auto-referral covers document candidates only.

### Governance
The reset contradicts written rulings that tests and the release walk still enforce:
- root `AGENTS.md:281` (2026-10-10): every VCR feature must take effect, and 给患者找试验 is built;
- `AGENTS.md:315-316` and `OS/AGENTS.md:280-281` (2026-10-20): the seven steps stay reachable, and Research Tools method entries are reused in study steps.

Supersede these rulings in writing in the same change.

---

## Q1 — Tool surface and reachability

### 1.1 The tools that exist

All six VCR tools are published by the runtime's research MCP server (`OS/runtime/mcp/evimed-research/vcr_platform.py`, registered at `OS/runtime/mcp/evimed-research/server.py:992`, dispatched at `server.py:2258-2268`). The domain names them at `OS/packages/domain/src/toolNames.mjs:120-132`. **There is no socket tool for VCR.** `SOCKET_TOOL_NAMES` (`toolNames.mjs:173-200`) has none. The socket only knows `vcr_read`/`vcr_write` as "module tools" (`OS/packages/socket/plugins/guidance.mjs:204`).

| Tool | Actions / key params | Server side | Notes |
|---|---|---|---|
| `vcr_read` | `what` ∈ 25 values (`vcr_platform.py:72-75`): study, definition, criteria, assumptions, evidence, population, patients, comparator, trial, precedents, matching, subject_document, results, report_model, snapshot_profile, models, jobs, trial_registry_record, pack, library, model_assessments, longitudinal, candidate_trials, soa, regulatory_contacts. `filter` {id, parentId, kind, registryId, registry, snapshotId, sourceId, subjectKey, documentId, protocolVersionId, query, limit ≤50, offset} (`vcr_platform.py:196-216`) | `POST /internal/vcr/v1/read` → `vcr.service.runtimeRead` (`OS/apps/server/src/vcrGateway.mjs:2162-2168`) | "Aggregates and structure only", small cells suppressed (`vcr_platform.py:7-12`, `vcrGateway.mjs:17-22`) |
| `vcr_write` | `what` ∈ 30 values (`vcr_platform.py:76-81`). They include OA writes: **`site`, `followup`, `regulatory_contact`, `forecast`, `forecast_design`, `candidate_trial`**. Payload is `items[]` (≤200) or `data` | `POST /write` → `vcrRuntimeWrite` (`vcrGateway.mjs:2169-2193`) | Number-shaped keys are refused at any depth (`VCR_FORBIDDEN_WRITE_KEYS`, `vcrGateway.mjs:105-108`) |
| `vcr_simulate` | `action` ∈ start/status/cancel/shape (`vcr_platform.py:105`). `kind` ∈ 37 job kinds (`vcr_platform.py:85-96`, which include `accrual_forecast` and `match_criteria`). Also scenario, inputs, seed, replicates ≤1e7, cpuSecondsLimit ≤86400, subjectId, selection {protocolVersionId(s), subjectKeys ≤5000, direction trial_to_patient/patient_to_trial, snapshotId, offset} (`vcr_platform.py:284-306`) | `POST /simulate` → `startJob` / jobs.get + `forModel` (`vcrGateway.mjs:2208-2240`) | Waits inside the call: 20 s by default, 60 s max, polling every 4 s (`vcr_platform.py:131-139`, `1043-1066`). Past that, the model is told to **end the turn**; the researcher gets a notice (`vcr_platform.py:1098-1116`) |
| `trial_registry_record` | `registryId`, `registry` (`vcr_platform.py:310-325`) | Goes through **`read`** with what=trial_registry_record (`vcr_platform.py:1142-1150`), so **it needs a study** too | Registry coverage: see Q9 |
| `curve_digitize` | imageArtifactId (a workspace path), imageSha256, calibration, plotArea, arms[≤2] with riskTable (`vcr_platform.py:327-435`) | `POST /digitize` → `vcr.evidence.curves.recordDigitization` (`vcrGateway.mjs:2194-2207`) | Runs in the intake container, not on the engine. It stays offered with no engine (`OS/apps/server/src/runtimeManager.mjs:1876-1879`) |
| `evidence_pool` | start/status; parameter, endpointKey, calibres, method ∈ DL/REML/HKSJ/FE/single (`vcr_platform.py:436-461`) | A thin wrapper over `simulate` start with kind=pool_evidence (`vcr_platform.py:1236-1267`) | Pools only the study's verified extractions |
| `research_calculate` (not VCR-named) | methods `meta.dl`, `faers.signals`, `bibliometric.network`, **`design.analytic`, `comparator.evalue`** (`OS/runtime/mcp/evimed-research/research_calculate.py:22`) | The last two run **on the VCR R engine with no study** (`OS/apps/server/src/resultEngineRouter.mjs:7`, `OS/apps/server/src/resultVcrReplay.mjs:11,143-147`, wired at `OS/apps/server/src/server.mjs:2773-2775`) | **Root-visible today.** See 1.4 |
| `dataset_semantics` | separate gateway (`EVIMED_SEMANTICS_GATEWAY_URL`, `runtimeManager.mjs:1684-1685`) | — | Not VCR-specific. Only `vcr-matching` declares it among the five (`OS/capabilities/vcr-matching/capability.yaml:36`) |

The tool schemas are heavy. Measured from `tool_definitions()`, the six VCR tools take **16,792 characters** of schema plus description: vcr_simulate 4,078, curve_digitize 4,254, vcr_read 3,332, vcr_write 3,030, evidence_pool 1,465, trial_registry_record 633. Making them root-visible is a per-request cost; compare the comment on the root list at `toolNames.mjs:241-244`.

### 1.2 Who can see them: three gates, in order

1. **Deployment and account gate: the runtime environment.** `runtimeManager.mjs:1706-1715` gives `EVIMED_VCR_GATEWAY_URL` to *every* project runtime of an account in the VCR audience. It does this **whatever the project is**. The comment says so: "Whether this project carries a study is the gateway's answer (`vcr_no_study`), not a reason to withhold the address". Without the URL, all six tools go into `EVIMED_DISABLED_TOOLS`. Without a composed engine, only `vcr_simulate` and `evidence_pool` do (`runtimeManager.mjs:1866-1882`; the lists are at `runtimeManager.mjs:2018-2020`). Audience: `vcrAudienceAllows` = `vcrEnabled` and (`vcrAudience==='all'` or the user is an operator or on the preview list) (`OS/apps/server/src/vcrService.mjs:159-164`). The code defaults are `OPEN_SCIENCE_VCR_ENABLED=false` (`OS/apps/server/src/config.mjs:1035`) and `OPEN_SCIENCE_VCR_AUDIENCE=operators` (`config.mjs:999`, `OS/deploy/web/.env.example:1537-1539`).
2. **Model-surface gate: socket root narrowing.** The root session is denied every `mcp__evimed__*` tool whose base name is not in `ROOT_VISIBLE_MCP_BASE_NAMES` (`toolNames.mjs:250-281`; `rootHiddenMcpTools`, `OS/packages/socket/src/runPolicy.mjs:482-491`; applied in `OS/packages/socket/plugins/run-policy.mjs:592-650`). **None of the six VCR tools is in that list. `research_calculate` is** (`toolNames.mjs:262`). A capability's tools are added back only when the session is *bound* to one capability. The order is: the control plane's route or session binding, then a single capability in the model's plan, then a single capability id named in the request (`boundCapability`, `run-policy.mjs:686-700`). Then `grantCapabilityTools` → `delegationToolFilter(manifest)` (`run-policy.mjs:713-725`, `OS/packages/domain/src/capabilityManifest.mjs:496-507`). An internal capability is never granted this way unless routed (`run-policy.mjs:659-664`).
3. **Data gate: the gateway resolves the study from the project.** Every operation, `trial_registry_record` and `digitize` included, runs `vcr.store.studyByControlProject(userId, projectId)`. When that finds nothing the answer is **404 `vcr_no_study`**: "This conversation is not in a 虚拟临床研究 study; open the study's own conversation" (`OS/apps/server/src/vcrGateway.mjs:2149-2153`). `vcr_platform.py` turns this into a soft warning: "There is no 虚拟临床研究 study in this conversation … work in the study's own conversation" (`vcr_platform.py:547-561`). The lookup picks the caller's own study in that project, or the single study there if there is only one (`OS/apps/server/src/vcrStore.mjs:406-417`). So **one project = one study** in practice. Study creation always makes a new control-plane project: "A study is a project plus a row" (`OS/apps/server/src/vcrRoutes.mjs:668-686`, `vcrService.mjs:626-660`). There is one extra gate for patient evidence: reads and writes of `subject_document`, `matching`, `fact` and `language_judgment` need a run the ledger can attribute to a session. Otherwise the answer is 403 `vcr_cloud_run_unattributed`, "Start a study conversation before reading patient evidence" (`vcrGateway.mjs:2155-2161`).

Rate and size limits per study and operation: read 120/min, write 60/min, simulate 60/min, digitize 12/min (`vcrGateway.mjs:79`). The read body is ≤16 KB. Every answer has a 10 s budget, except registry and digitize, which get their own deadline plus a margin (`vcrGateway.mjs:81-95`, `2162-2167`, `2196`). A read returns ≤50 items (`vcr_platform.py:118`).

### 1.3 Visibility by session type

| Session | Bound to | VCR tools the model sees | Gateway answer |
|---|---|---|---|
| Ordinary unrouted conversation, normal project (`open-domain-answer`) | nothing | **none**. `open-domain-answer` declares no VCR tool (`OS/runtime/skills/evimed/open-domain-answer/agent.yaml:20-35`), and the root list hides them. **`research_calculate` is visible.** | `vcr_no_study` even if a tool were granted |
| Ordinary conversation that the **classifier routes** to a `vcr-*` capability | that capability (route) | that capability's tools | still `vcr_no_study`: a dead end (see 1.5) |
| A study's own conversation | `vcr-protocol`, bound at creation (`vcrService.mjs:646-650`; `VCR_STEP_CAPABILITIES.definition`, `OS/packages/domain/src/vcrVocabulary.mjs:868-876`) | vcr_read, vcr_write, vcr_simulate, evidence_pool, trial_registry_record and search tools. **No `curve_digitize`, no `dataset_semantics`** (`OS/capabilities/vcr-protocol/capability.yaml:43-57`) | the study |
| Programme step runs (hidden, role `programme`) | the step's capability (`vcrOrchestrator.mjs:3331-3365` → `dispatchRun({projectId: study.projectId, capabilityId})`) | vcr-evidence and vcr-analysis add curve_digitize. vcr-matching adds dataset_semantics and clinical_trial_search. vcr-package gets only read/write, locate_quote and search (`capability.yaml` `tools:` of each) | the study |
| "Calculation" containers from the 科研工具 workbench | no session (`purpose:"calculation"` → `{sessionId:"", bound:false}`, `vcrService.mjs:646-647`) | n/a: the web drives the engine directly | each container is **a whole new project** (`OS/apps/web/src/components/vcr/VcrMethodRunner.tsx:195` creates 「独立计算」) |

### 1.4 Can an ordinary conversation call the VCR engine today?

**Partly, by a side door.** `research_calculate` is root-visible (`toolNames.mjs:262`). It runs `design.analytic` (two-arm continuous, binary or TTE; group sequential; Simon two-stage; single-arm exact binomial) and `comparator.evalue` (E-value) on the **VCR R engine with no study**. It works like this:
- `ResultVcrReplay` makes up `studyId: replay-<digest(user,project)>` and a placeholder input `asm_replay@1`.
- It validates the job with the domain's `validateEngineJob`.
- It writes `result.json` and `receipt.json` into the project workspace, with code and environment digests (`resultVcrReplay.mjs:109-180` start, `182-233` observe; result and receipt paths at `213-217`).
- It is available wherever `resultProvenance && vcr?.engine` exist (`server.mjs:2773-2775`).
- The only check is project ownership (`resultProvenance.scope`). **There is no audience check**: an account outside the VCR audience can run these two methods whenever the module and engine are composed.

This adapter is the narrowest existing precedent for "the conversation calls the engine". It is already file-based, receipted and study-less.

**Not for anything else.** Patient-level methods (cohort, weighting, matching, virtual patients) read a study's data-plane snapshot (`vcr_simulate` description: "Patient-level kinds name their data as inputs [{kind:'snapshot', id}]", `vcr_platform.py:276-277`). Evidence pooling reads the study's verified extractions. Every other job kind goes through the study-scoped gateway.

**What it would take**, in increasing order of reach:
- **(a) Aggregate-only methods.** Widen `research_calculate` / `ResultVcrReplay`: three closed lists (`research_calculate.py:22,37-100`, `resultVcrReplay.mjs:11`, `resultEngineRouter.mjs:7`) plus the input templates. This covers design_simulation, assurance, accrual, rmst and map_prior from summary data. No study, no gateway grant, no tool row. Cost: a longer `research_calculate` description on every root request.
- **(b) The full module from a conversation.** It needs two things.
  - **A study bound to the conversation's project.** The gateway cannot work otherwise (`vcrGateway.mjs:2149-2153`). Today the only constructor makes a *new* project (`vcrRoutes.mjs:668-686`). Attaching a study to an *existing* ordinary project means a new store and service entry. It also means accepting that a project holds at most one usable study (`vcrStore.mjs:406-417`).
  - **The tools on the root.** Either a session binding/route to a `vcr-*` capability, or adding them to `ROOT_VISIBLE_MCP_BASE_NAMES`. The second is about +16.8 K characters per root request, and `socket.test.mjs:1520-1531` holds the list against agent.yaml and the guidance.
  - **No gateway grant is needed.** The URL is already in every runtime of an audience account (`runtimeManager.mjs:1706-1715`).
- **(c) Alternative.** Keep "a study = a project", and make the AI-first entry *create* the study project from the conversation (draft studies already exist: `vcrDrafts.mjs`, `vcrService.mjs:611-625`). Then continue in that project's conversation, which is already bound to `vcr-protocol`. This is the least code. But the "conversation" then moves to a new project, which is the 2026-10-20 "Global home … without inherited … study" tension.

### 1.5 Routing of the five `vcr-*` capabilities (display.listed:false)

- **The control-plane router does not know `display.listed`.** `AgentRegistry.list()` filters only `visibility === "internal"` (`OS/apps/server/src/agentRegistry.mjs:388-390`). Its manifest fields contain no `display` (`agentRegistry.mjs:19-37`). All three routing call sites pass `registry.list()` minus `open-domain-answer` as candidates (`server.mjs:6241`, `6305`, `7393`).
  - So **the classifier (on by default) can route an ordinary conversation to `vcr-protocol` / `vcr-analysis` / ….**
  - So can a leading `/vcr-protocol` (`OS/apps/server/src/specialistRouting.mjs:103-108`).
- The only guard is the classifier's own instruction, "Refuse any specialist whose requiredInputs the request does not actually supply" (`OS/apps/server/src/specialistClassifier.mjs:68`). `vcr-protocol`'s only required input is `question` (`OS/capabilities/vcr-protocol/capability.yaml:73-75`), which every request supplies. Its catalogue description includes sample size and trial simulation (`capability.yaml:26-31`).
  - The others require `studyId` (vcr-evidence, vcr-matching, vcr-package) or `step` (vcr-analysis).
  - A request like "把这份方案草稿的研究问题和入排条件整理出来" (vcr-protocol's own starter prompt, `capability.yaml:95-96`), sent from a normal project, is therefore a plausible misroute.
  - Its tools would answer `vcr_no_study`.
  - `OS/evals/routing/cases.json` has **no `vcr-*` case**: none of the 5 ids appears in `evals/routing`.
- **The model-side catalogue does hide them.** `buildGuidanceText` keeps only `capabilityListed` manifests (`OS/packages/socket/src/guidanceText.mjs:64-72`). `offeredCapabilities` drops every capability that declares `vcr_read`/`vcr_write` when those are disabled (`guidance.mjs:204`, `246-251`).
- **Net:** the router can choose them, but the model is never told they exist, and outside a study they cannot work. For the reset, either take the five out of `registry.list()` candidates for non-study projects, or make the conversation-first entry real by doing (b) or (c).

### 1.6 The 科研工具 calculator catalogue: what removing it touches

No fork was assigned this, so I list it here. It is the third path to the engine, after the study conversation and `research_calculate`.

- **Web entry.**
  - The 科研工具 page loads `getVcrModels()` → `GET /api/vcr/models` and renders `VcrMethodCatalogue` (`OS/apps/web/src/app/routes/CapabilitiesPage.tsx:89`, `132-142`, `185`).
  - There are two routes: `capabilities/methods/:methodId` → `VcrMethodWorkbenchPage`, and `capabilities/calculations/:studyId/:tab?` → `VcrCalculationWorkbenchPage` (`OS/apps/web/src/app/router.tsx:30-31`, `152-153`).
- **How a calculation runs.** `VcrMethodRunner` needs a study. With none chosen, it **creates a 「独立计算」 study with `purpose:"calculation"`** (`OS/apps/web/src/components/vcr/VcrMethodRunner.tsx:195`). That is a new control-plane project with no conversation (`vcrService.mjs:646-647`). It then posts the generic job route `POST /api/vcr/studies/:id/jobs` (`OS/apps/web/src/lib/vcrClient.ts:2521`) and saves configurations at `.../method-configurations` (`vcrClient.ts:3315`; server `OS/apps/server/src/vcrRoutes.mjs:1236`).
- **Sidebar.** The sidebar lists each calculation project with 「打开计算空间」 (`OS/apps/web/src/components/sidebar/ProjectBrowser.tsx:148`, `456`, `835`; `OS/apps/web/src/components/vcr/useVcrProjectIds.ts:81`).
- **Shared with the study, so not deletable wholesale.**
  - `VcrMethodRunner` is also mounted inside the study's models panel (`OS/apps/web/src/components/vcr/VcrModelsPanel.tsx:12,32`).
  - The panel's 「选择研究并使用参数」 navigates to `/app/capabilities/methods/...?model=` (`VcrModelsPanel.tsx:37`).
  - `VcrStudyMethods` is mounted in the study page (`OS/apps/web/src/app/virtual-research/VcrStudyPage.tsx:36,287`); Q7 claim 6 covers its links.
  - `GET /api/vcr/models` also feeds the study's models panel.
- **Server-side `purpose:"calculation"` concept.** It is threaded through `vcrService.mjs:366,587,622-653,791`, `vcrStore.mjs:134,604-619`, `vcrViews.mjs:478,673-677`, `vcrOrchestrator.mjs:383,2267` and `vcrStudyStart.mjs:19` (409 `vcr_calculation_research_required`). Production data will hold calculation-purpose study projects, one per 「独立计算」. Removing the catalogue needs a decision for them: hide, convert to research studies, or keep reachable by link.
- **Size of the web-only part.** It is small. `VcrMethodWorkbenchPage`, `VcrCalculationWorkbenchPage`, `VcrMethodCatalogue`, `VcrMethodRunner`, `VcrMethodResult(+Charts)`, `VcrUseMethodInStudy`, `VcrStudyMethods`, `vcrMethodDraft/Display/Location` and `vcrMethodFieldText/ChoiceText` come to **≈1.3 K lines of source plus ≈0.9 K lines of tests**, 2,145 lines in total by `wc -l`. The method *machinery* (`vcrJobs`, schemas, the engine) is shared with the study and the conversation and stays.

- **Release-gate coupling: the deletion must edit the walk in the same change.** The release UI walk encodes the current shape:
  - the method workbench and calculation-history pages (`OS/scripts/ops/ui-walk.mjs:194-195`, `701`, `3542`);
  - `METHOD_FAMILIES` including 「招募与匹配」 (`ui-walk.mjs:417`);
  - the seven study tabs ending in 「匹配与招募」 (`ui-walk.mjs:1631`, `1645-1648`);
  - a walk fixture that seeds "a matching list with referrals and sites" (`OS/scripts/ops/walk-fixture/vcr.mjs:7`).

  The 2026-10-14 rule says a probe that cannot run fails the walk, so removing pages without editing the walk turns the release red.



---
## Q2 — Recruitment / OA inventory

Classes: (a) pure OA → delete · (b) design-time accrual modelling (may survive inside 虚拟试验 as a timeline assumption) · (c) follow-up DATA as research input → stays · (d) ambiguous.
Paths are repo-root-relative. `OS/` = `OpenScience/`.

### Q2.0 Shape of the thing (read this first)

- Recruitment is **not behind its own switch**. No `OPEN_SCIENCE_VCR_*RECRUIT*`/`*REFERRAL*` key exists (all 41 `OPEN_SCIENCE_VCR_*` keys in `OS/apps/server/src/config.mjs` were listed; none gates recruitment). It is always on wherever `vcrEnabled` + PostgreSQL compose the module (`OS/apps/server/src/vcrComposition.mjs:1084`). So removal means deleting code and data. Flipping a flag will not do it.
- It lives inside the **matching** package and its tab, not in a module of its own. The tab is labelled 「匹配与招募」 (`OS/packages/domain/src/vcrVocabulary.mjs:459`) and has four views, 匹配 / 转诊 / 中心 / 随访 (`OS/apps/web/src/components/vcr/tabs/MatchingTab.tsx:60-65`; server presenter `OS/apps/server/src/vcrViewsTabs.mjs:1167`). The route hooks carry a naming trap: `hooks.matching` is the **referral** object (`vcr.contact`) and `hooks.assessments` is the matching seam (`OS/apps/server/src/server.mjs:3101-3105`).
- Two **different** things are both called "forecast" or "accrual". They must not be deleted together:
  1. **Recruitment forecast**: `accrual.poisson_gamma` fed from the site CRM and the referral ledger, plus the backtest and the "actual vs forecast" alert. This is OA.
  2. **Trajectory forecasts**: `vcrForecastProvider.mjs`, `vcrForecastEvaluation.mjs`, the PatientsTab 「预测验证」 view, `forecast.trajectories/evaluate/compare/trial_benchmark`. These are longitudinal virtual-patient research and are not recruitment (`OS/apps/web/src/components/vcr/tabs/PatientsTab.tsx:77-96`, `OS/apps/server/src/vcrLongitudinal.mjs:1-15`).
  3. **Design-time accrual inside a simulated trial**: the `accrual: {kind, duration, followup, dropoutAnnual}` block of `design.simulate` / `patients.time_to_event` (`项目代码/vcr-engine/R/design_simulate.R:243-303`; `OS/apps/server/src/vcrService.mjs:190-192`). This already belongs to 虚拟试验 and does not touch recruitment data.

### Q2.1 Inventory table

| # | Item | file:line | What it does | Class | Note |
|---|---|---|---|---|---|
| 1 | Referral state machine | `OS/apps/server/src/vcrRecruit.mjs:59-71`; states `OS/packages/domain/src/vcrVocabulary.mjs:749-756` | 11 states candidate→…→referred→site_responded→screening→enrolled/screen_failed/withdrawn | a | |
| 2 | Contact stop policy | `vcrRecruit.mjs:129-176` (`decideReferralTransition`), `:192-208` (`decideContactApproval`); `VCR_CONTACT_STATES` `vcrVocabulary.mjs:759` | per-person coordinator approval before contacted/interested/referred | a | the first of the three "human stops" `vcrVocabulary.mjs:820-823` (`contact_patient`), which is exported but has no reader outside the vocabulary |
| 3 | Candidate→referral mapper | `vcrRecruit.mjs:219-247` (`candidateReferrals`) | newest assessment per subject → `candidate`/`needs_evidence` referral rows | a | also used to compute `candidates` in the matching tab (`vcrComposition.mjs:579`) |
| 4 | Referral funnel / screen failures by criterion | `vcrRecruit.mjs:257-295`, `:302-327` | contact/screen/enrol rates; screen failures per criterion from the **ledger** | a | not to be confused with the **matching** criterion funnel `OS/apps/server/src/vcrMatchStore.mjs:463` (`criterionFunnelRows`, computed from assessments), which stays |
| 5 | Site profile (CRM card) | `vcrRecruit.mjs:334-368` (`siteProfileStatus`, 90-day staleness) | capacity, competing studies, contacts, verification age | a | |
| 6 | Contact/transition transactions | `OS/apps/server/src/vcrContact.mjs:1-289` (whole file) | locked-row contact approval, transitions, list referrals, audited refusals | a | whole file |
| 7 | Store: sites, referrals, events, approvals, funnel | `vcrMatchStore.mjs:930-1229` (`upsertSite`…`siteFunnel`, incl. `approveContact` :1161, `enrollmentTimeline` :1203) | SQL for the OA tables | a | ~300 lines; follow-up store methods `:1230-1268` are next to them |
| 8 | Tables | `OS/apps/server/src/vcrPersistence.mjs:1211` `CREATE TABLE … sites`, `:1227` `… referrals`, `:1253-1264` constraint `vcr_referrals_contact_needs_approval`, `:1266` `… referral_events` | OA data | a | also listed in `VCR_TABLES` `vcrPersistence.mjs:90` (the list the deletion paths read) |
| 9 | Auto-referral + coordinator notice on match finish | `OS/apps/server/src/vcrComposition.mjs:798-863` (`onJobFinished`), hook registration `:1174-1176` | after every succeeded `match_criteria` job: persist assessments (keep), then `createReferral(actor:"control-plane", note:"由匹配评估生成")` `:841-855` and `notifier.newCandidates` `:856-859` | a (the referral and notice half) | subject-table rows are excluded from the ledger, `:828-831` (`tableOnly`) |
| 10 | Notice kind 4 「有新的匹配候选」 | `OS/apps/server/src/vcrNotify.mjs:247-260`; recipients `:191-196` (`recruiter`/`site`/`lead`, else the owner); kinds `vcrVocabulary.mjs:830-833` | inbox and IM push to coordinators | a | goes through the platform inbox; IM channels pick it up like any inbox item (`vcrNotify.mjs:32-34`) |
| 11 | Notice kind 5 「实际入组偏离预测」 | `vcrNotify.mjs:262-275`; trigger `OS/apps/server/src/vcrOrchestrator.mjs:3682-3693`; tolerance `:127-128` (`VCR_ACCRUAL_TOLERANCE = 0.2`) | alert when ledger enrolments drift >20% from the registered accrual forecast | a | |
| 12 | Forecast-vs-actual comparison | `vcrOrchestrator.mjs:3099-3122` (`#compareForecasts`, counts `referrals.state='enrolled'`) | writes `forecasts.actual` for `kind:"accrual"` | a | |
| 13 | Auto-registration of accrual forecasts | `vcrOrchestrator.mjs:3064-3097` (`#registerForecasts`, accrual half `:3077-3097`) | freezes each accrual result into `forecasts` with per-site rates for comparison | a | the `design_simulation` half `:3069-3075` (kind `trial`, AC-23 pre-registration) is research → keep |
| 14 | `forecasts` table + `vcr_write what:forecast` | DDL `vcrPersistence.mjs:947-960`; writer `OS/apps/server/src/vcrGateway.mjs:1322-1335` (default `kind` = `"accrual"` :1324) | prediction registry, registered before the outcome | d | shared: the `trial` kind is research pre-registration (keep). The `accrual` kind exists only for the OA comparison. The writer's default kind should change. |
| 15 | Accrual scenario assembled from the CRM + ledger | `vcrComposition.mjs:921-958` (`accrualScenario`; refuses with 「还没有中心档案：先写入中心（vcr_write what:site）」 `:942`); gateway forces it `vcrGateway.mjs:267-268, 2361-2372` (run may state only `target/eventTarget/eventHazard/byTimes`; `VCR_RUN_SCENARIO_FIELDS.accrual_forecast` `OS/packages/domain/src/vcrScenarioHelp.mjs:56`) | the only conversation path to `accrual_forecast` | a as wired; b if rewired | **coupling, see Q2.3**: today a design-time accrual cannot be stated in conversation without creating site rows |
| 16 | Poisson–Gamma math in JS | `vcrRecruit.mjs:375-555` (`accrualPosterior`, `accrualForecastScenario`, `requestAccrualForecast`, `readAccrualForecast`, `parseProbabilityByMonth`) | conjugate update and engine contract | b | reusable if fed planned sites and assumed rates (prior α/β per planned site, `startTime` = planned activation) |
| 17 | Accrual backtest | `vcrRecruit.mjs:556-674` (`wilsonInterval`, `backtestAccrualCoverage`, `accrualBacktestSlices`); `vcrComposition.mjs:961-982` | coverage of 80% PIs against **ledger** enrolments (AC-37) | a | needs real enrolment dates. A design-time timeline has nothing to backtest. |
| 18 | Engine method `accrual.poisson_gamma` | `OS/packages/domain/src/vcrEngineJob.mjs:113, 161`; schema `OS/packages/domain/src/vcrScenarioSchemas.mjs:805-818` (sites need only `id, alpha, beta, startTime`; `enrolled/exposureTime` optional); R `项目代码/vcr-engine/R/accrual.R` (295 lines); job kind `vcrVocabulary.mjs:775`, mapped to step `trial` `:801` | deterministic time-to-target forecast | b | the schema takes pure assumptions. The calculator workbench already sends hand-typed `sites[]` (`OS/apps/web/src/components/vcr/vcrMethodFieldText.ts:49-59`; route `OS/apps/server/src/vcrRoutes.mjs:1236-1255` takes a full scenario). |
| 19 | Design-time accrual block | `design_simulate.R:243-303, 588, 670-679`; scenario help `vcrScenarioHelp.mjs:284-324` | uniform/piecewise accrual, follow-up and dropout inside a simulated trial | b (already 虚拟试验) | stays as is |
| 20 | 「招募待办」 on the VCR home | `OS/apps/server/src/vcrViews.mjs:486-524` (`presentTodos`), `OS/apps/server/src/vcrService.mjs:566-577`; web `OS/apps/web/src/app/virtual-research/VcrHomePage.tsx:61-63, 105-106, 238-273`; type `OS/apps/web/src/lib/vcrClient.ts:274-312` | contact / evidence / stale-site to-dos; marks a study as "needs attention" | a | shows for **every lead**, because `lead` holds `contact_patients` (`vcrVocabulary.mjs:564`). Auto-referrals (row 9) therefore surface OA to-dos to ordinary owners. |
| 21 | Roles `recruiter`, `site` and abilities `read_referrals`, `write_referrals`, `contact_patients` | `vcrVocabulary.mjs:557-570`; site membership `detail.siteId` `vcrRoutes.mjs:1588-1591, 1694-1712`; web picker `OS/apps/web/src/components/vcr/VcrMembersDialog.tsx:42-66`; body `OS/apps/web/src/lib/vcrBodies.ts:23, 129` | site-scoped access | a | coupling: `review_clinical`'s override route also accepts `write_referrals` (`vcrRoutes.mjs:221`; web `MatchingTab.tsx:337-338`). `members.role` and `grants.role` CHECKs embed `VCR_MEMBER_ROLES` (`vcrPersistence.mjs:172, 512`). |
| 22 | Referral routes | `vcrRoutes.mjs:218` `GET /studies/:id/referrals`; `:219` `POST /studies/:id/referrals/:referral/transition`; `:220` `POST /studies/:id/referrals/:referral/contact`; handlers `:1652-1689` | browser API | a | |
| 23 | Runtime write `what:"site"` | `vcrGateway.mjs:1631-1656`; whitelists `OS/apps/server/src/vcrService.mjs:125-130`, `OS/runtime/mcp/evimed-research/vcr_platform.py:80-85`; description `vcr_platform.py:229` ("sites and follow-up"); accrual note `:934` | AI writes site CRM rows | a | |
| 24 | Runtime write `what:"followup"` | `vcrGateway.mjs:1658-1709`; episode builders `vcrRecruit.mjs:684-794`; table `vcrPersistence.mjs:1278-1291` (+`:1318`) | trial-period exit (restricted fields), post-exit and routine-care observations | c (data) / d (policy) | **has no analytic consumer**: its only reader outside the store is the matching tab presenter (`vcrService.mjs:1164` → `vcrViewsTabs.mjs:1302-1308`), and `READ_WHATS` has no `followup` (`vcr_platform.py:75-79`). The restricted-field rule is written for "the partner's patient in somebody else's trial" (`vcrRecruit.mjs:678-684`, `vcrGateway.mjs:1670-1674`). |
| 25 | Matching tab OA views (server) | `vcrViewsTabs.mjs:1191-1197` (candidate `referralId`, `site`), `:1213-1244` (`canContact`, `referralState`, `trace`), `:1254-1301` (ledger, forecast, sites), `:1346` (`abilities.contact`) | page data | a | `forecast.xLabels/actual/median/band/markers` are always `[]` (`:1263`), so the forecast chart can never draw (`MatchingTab.tsx:678`): dead UI |
| 26 | Matching tab OA views (web) | `MatchingTab.tsx:312-380` (contact/ledger moves), `:503-580` (referral trail, 「确认后联系」, ConfirmDialog), `:626-817` (`ReferralLedger`, `ReferralView` with accrual chart, `SitesView`); chart `OS/apps/web/src/components/vcr/VcrCharts.tsx:465-565` (`VcrForecastChart`, only caller `MatchingTab.tsx:714`); client `vcrClient.ts:2710-2768`; bodies `vcrBodies.ts:132-150, 289-297`; label `OS/apps/web/src/components/vcr/vcrText.ts:77` | UI | a | 「请求补证」 keeps working without referrals through the decision-record path (`MatchingTab.tsx:380-388`) |
| 27 | Follow-up view (web) | `MatchingTab.tsx:818-845`; copy 「入组的患者有了随访之后…」 `:820` | display of row 24 | c | needs a new home (patients/cohort workspace) once the 匹配与招募 tab is split |
| 28 | Consent withdrawal closes referrals | `OS/apps/server/src/vcrErasureStore.mjs:278-299`, `:314` | moves open referrals to withdrawn | a (that part) | the erasure itself stays; constructor takes `matchStore.transitionReferral` (`:84`) |
| 29 | Re-identification for a coordinator | `OS/apps/server/src/vcrDataPlane.mjs:3511-3527` (`identityOf`, "to find the person a referral is about") | pseudonym → source id, audited | d | no caller in `src/`; test-only (`OS/apps/server/test/vcrIntake.integration.test.mjs:360`). A clinician using 给患者找试验 on their own records could need it. |
| 30 | `separateLedgers` | `OS/apps/server/src/vcrMatching.mjs:1007-1029` | "five ledgers" incl. willingness, site capacity, business progress | a | dead code: no caller in `src/` (test `OS/apps/server/test/vcrMatching.test.mjs:503`) |
| 31 | `recheck` loop | `OS/apps/server/src/vcrWorker.mjs:59, 332` → `vcrComposition.mjs:864-893` (`recheckDue` :871) | re-queues matching when a washout/deferral date passes | d | keeping the candidate list current is matching. Today each finish then fires rows 9 and 10. |
| 32 | Recruitment drafts | `OS/capabilities/vcr-matching/capability.yaml:59-61` (`recruitment-drafts.md`), `:4, 17, 22, 24, 30, 95-97, 112, 116`; `OS/capabilities/vcr-matching/SKILL.md:115`; `OS/packages/domain/src/skill-packages.json:1207` | pre-screening questionnaire, patient explanation, coordinator script | a | `safetyClass: clinical` is justified by these patient-facing drafts (`capability.yaml:9-13`). Removing them removes the stated reason, though the class can stay for other reasons. |
| 33 | SKILL text: sites + accrual | `OS/capabilities/vcr-matching/SKILL.md:122-131` (site JSON), `:143-145` (accrual forecast from ledger), `:148` ("中心产能和商务进度"); `OS/capabilities/vcr-protocol/SKILL.md:36` (「联系患者永远要协调员逐人确认」) | instructions | a | follow-up instructions `vcr-matching/SKILL.md:132-142` are c. **Two tracked byte-identical copies** (`OS/capabilities/…` and `OS/capability-skills/vcr-matching/SKILL.md`; `diff -q` same). The third copy, `OS/packages/socket/capability-skills/`, is gitignored and generated (`OS/.gitignore:76`). |
| 34 | Eval brief 005 | `OS/evals/vcr-matching/briefs.json:110-137` (「九家中心的入组预测…回测」) | AC-37 brief | a (or b if retargeted to planned sites) | brief 004 (`:84-94`) replays **historical referrals** as a matching-accuracy baseline. That is (c)-like use of past outcomes and is not OA. 6 of 7 briefs survive, so principle 9's ≥3 holds. |
| 35 | Error codes | `OS/packages/domain/src/errorCodes.mjs:1404, 1545 (vcr_referral_create_failed, vcr_recheck_failed), 1577-1582, 2169, 2274-2278, 2352`; `vcrRecruit.mjs:74-84`; `vcrContact.mjs:53-64` | registry rows | a | |
| 36 | Copy/labels | tab 「匹配与招募」 `vcrVocabulary.mjs:459`; tier copy `:354` ('T1 基线与招募资料'), `:359` ('…做患者匹配与招募'); capability display `OS/packages/domain/src/capability-display.json:628`; unavailable messages `vcrViewsTabs.mjs:1169`, `vcrService.mjs:1630`, `vcrGateway.mjs:1645, 1684`; people-count keys `'referred','contacted'` `vcrVocabulary.mjs:1006` | wording | a (copy edit) | |
| 37 | 给患者找试验 | `OS/apps/server/src/vcrPatientTrials.mjs:1-30` (own tables `vcrPersistence.mjs:1132-1192`) | patient→trials ranking from registries | keep (matching) | explicitly kept apart from the ledger (`vcrPatientTrials.mjs:19-21`). Registry site lists and 「招募中」 status words (`:136-145`) are trial data, not CRM. Contacts are never copied (`:17-18`). |
| 38 | Longitudinal `site` column | `OS/packages/domain/src/vcrLongitudinal.mjs:85, 270`; `OS/packages/domain/src/vcrForecastEvaluation.mjs:255-271`; `vcrLongitudinal.mjs:29-35` | the site an event was recorded at, used for split/groupBy | c | unrelated to the `sites` CRM table. Do not sweep it with a "site" grep. |
| 39 | Regulatory contact log | `vcrPersistence.mjs:1352-1370`; `vcrGateway.mjs:1289-1300`; `vcrRoutes.mjs:206, 1493-1500` | 监管沟通记录 | d (out of scope) | "contact" with a regulator, not with a patient. Not in the owner's list. |

### Q2.2 Backend side effects (what happens with nobody clicking)

1. **Matching finishes → referrals are created and coordinators notified.** This is automatic, in the control plane, on every succeeded `match_criteria` job:
   - The hook is registered at `OS/apps/server/src/vcrComposition.mjs:1176` (`jobs.addFinishHook((done) => matching.onJobFinished(done))`).
   - `onJobFinished` (`:798-863`) persists the assessments (keep), then for each *document* candidate on the current protocol it calls `matchStore.createReferral({... actor: "control-plane", note: "由匹配评估生成"})` (`:841-855`). Rows that come only from the subject table are excluded (`:828-831`).
   - It then calls `notifier.newCandidates(...)` (`:856-859`) → `vcrNotify.mjs:251-260`. That sends inbox notice `new_candidates` to `recruiter`/`site`/`lead` members, or to the owner if none (`:191-196`).
   - The same chain fires for the background `recheck` loop (`OS/apps/server/src/vcrWorker.mjs:59` every 15 min → `vcrComposition.mjs:871-893`) and for panel runs (`enqueuePanel` `:772-790`).
2. **Accrual forecast auto-registration.** Every finished `accrual_forecast` job is frozen into `evimed_vcr.forecasts` with `kind:"accrual"` (`OS/apps/server/src/vcrOrchestrator.mjs:3077-3097`).
3. **Forecast-vs-actual comparison and alert.** On each orchestrator tick `#notices` → `#compareForecasts` (`vcrOrchestrator.mjs:3682` → `:3105-3122`) counts `referrals.state='enrolled'`. A drift above `VCR_ACCRUAL_TOLERANCE = 0.2` (`:127-128`; per-study override `study.budget.accrualTolerance` `:3683`) sends `accrual_off_forecast` (`:3684-3693` → `vcrNotify.mjs:266-275`).
4. **Home to-dos.** `GET /api/vcr/studies` reads every lead's referrals and sites and emits 「招募待办」 (`OS/apps/server/src/vcrService.mjs:566-577` → `vcrViews.mjs:492-524`). This is presentation. Because of (1), an ordinary owner gets OA to-dos after their first matching run.
5. **Consent withdrawal** moves open referrals to `withdrawn` inside the erasure transaction (`OS/apps/server/src/vcrErasureStore.mjs:289-299`).
6. **Notification kinds** (domain): `new_candidates`, `accrual_off_forecast` in `VCR_NOTIFICATION_KINDS` (`OS/packages/domain/src/vcrVocabulary.mjs:830-833`). The other five (`package_ready`, `not_estimable`, `budget_confirm`, `new_evidence`, `job_finished`) are not OA. IM/Feishu delivery is the platform inbox's job; VCR adds no IM code of its own (`vcrNotify.mjs:32-34`, link builder `vcrNoticeHref` `:53-56`).
7. **Tables** (CREATE lines): `evimed_vcr.sites` `OS/apps/server/src/vcrPersistence.mjs:1211`; `evimed_vcr.referrals` `:1227` (live-row unique index `:1249-1251`; approver CHECK `:1253-1264`); `evimed_vcr.referral_events` `:1266`. Kept/shared: `evimed_vcr.forecasts` `:947`, `evimed_vcr.followup_episodes` `:1278`. The DDL is idempotent `CREATE … IF NOT EXISTS` with no down-migrations. Dropping the three OA tables takes an explicit `DROP TABLE` step. The member-role CHECKs (`:172` members, `:512` grants) were baked into existing databases with `recruiter`/`site` in the list. Existing member rows with those roles need a data step (the vocabulary removal alone leaves them orphaned; cf. the "list CHECKs need widening on existing databases" lesson).
8. **Routes**: `GET /api/vcr/studies/:id/referrals`, `POST …/referrals/:referral/transition`, `POST …/referrals/:referral/contact` (`OS/apps/server/src/vcrRoutes.mjs:218-220`, handlers `:1652-1689`). There is no browser route for sites: sites are written only by the runtime (`vcr_write what:"site"`, `OS/apps/server/src/vcrGateway.mjs:1631-1656`) and read inside the matching page.
9. **Scheduled jobs**: no recruitment-specific worker loop. The OA effects ride on the generic `orchestrator` tick and the `recheck` loop (`vcrWorker.mjs:52-60`).

### Q2.3 Coupling risks: places where deletion has to be surgical

1. **The 虚拟试验 "duration" axis is fed by the recruitment forecast.**
   - The design comparison takes `duration_months` from "the accrual forecast filed for this design, never from the design's own simulation" (`OS/apps/server/src/vcrViews.mjs:1052-1058`).
   - `DESIGN_MEASURES` omits `duration_months` (`vcrViews.mjs:874`), so the trade-off chart 「周期、成本与成功把握的取舍」 (x = 「末例入组中位（月）」, `OS/apps/web/src/components/vcr/tabs/TrialTab.tsx:289-301`) can only get its x value from an `accrual_forecast` result.
   - In conversation that result can only be built from the site CRM. The gateway refuses run-written sites (`OS/apps/server/src/vcrGateway.mjs:2361-2366`, "各中心的入组率来自台账和中心档案"), and `accrualScenario` refuses a study with no `sites` rows (`vcrComposition.mjs:942`).
   - Deleting the CRM without rewiring therefore removes the only conversational way to put a timeline on a design.
   - Fix shape (for phase 3): let `accrual_forecast` take planned `sites[]` with prior α/β and planned `startTime` as **assumptions**, which the schema already allows (`OS/packages/domain/src/vcrScenarioSchemas.mjs:805-818`). Or let `DESIGN_MEASURES` read the design's own simulated `duration_months` (`项目代码/vcr-engine/R/design_simulate.R:588`).
2. **`vcrRecruit.mjs` mixes three classes in one file.** Ledger/site (a) `:47-369`; accrual (b) `:370-555`, with its backtest (a) `:556-674`; follow-up (c) `:675-794`. `vcrGateway.mjs:77` imports the follow-up half (`VCR_TRIAL_RESTRICTED_FIELDS, deriveFromExit, followupFidelityFindings, postExitEpisode, trialPeriodEpisode`). `vcrComposition.mjs:104-107` imports the ledger and accrual halves. `vcrRoutes.mjs:74` imports `isSiteScopedRole`. Split it; do not delete it.
3. **`vcrMatchStore.mjs` holds matching, OA and follow-up in one class.** Assessments, criteria, facts and language judgments (`:200-929`) stay. Sites, referrals and the funnel (`:930-1229`) go. Follow-up (`:1230-1268`) stays. `dueRecheckSubjects` (`:642`) stays.
4. **`onJobFinished` is half matching.** Assessment persistence (`vcrComposition.mjs:810-825`) must survive. Only the referral creation and notice (`:826-859`) go. The `live` set (`:807-808`) reads referrals and goes too.
5. **The matching tab presenter mixes them.** `presentMatchingTab` (`OS/apps/server/src/vcrViewsTabs.mjs:1165-1349`) builds the eligibility funnel (keep, `:1180-1185`), candidates (keep, minus `referralId`/`site`), the selected person's judgments (keep, minus `canContact`/`referralState`/`trace`), and ledger/forecast/sites (go) and follow-up (move) in one return. The bundle comes from `vcrService.mjs:1142-1235`, which runs `listReferrals`, `listSites`, `siteFunnel`, `listFollowupEpisodes` and `listReferralEvents` in one `Promise.all` (`:1156-1205`).
6. **Abilities shared with review.** The judgment-override route admits `write_referrals` (`vcrRoutes.mjs:221`; web `MatchingTab.tsx:337-338`, coordinator 改判 test `OS/apps/web/src/components/vcr/tabs/RecruitTabs.test.tsx:611`). Removing the roles needs a decision on who may 改判: `review_clinical`/`review_any`, and `lead`, which holds `review_any`.
7. **The `forecasts` table is shared** between OA (`kind:"accrual"`) and research pre-registration (`kind:"trial"`, AC-23, `vcrOrchestrator.mjs:3069-3075`, and whatever a run registers through `vcr_write what:forecast`; the flywheel's prediction registry `OS/apps/server/src/vcrPredictions.mjs` is a separate store in the learning package, unaffected). Keep the table; drop the accrual comparison (`#compareForecasts`) and the `accrual_off_forecast` notice. Change the default `kind` of `vcr_write what:forecast` from `"accrual"` (`vcrGateway.mjs:1324`).
8. **Follow-up data is (c) by the owner's rule, but the code only gives it a recruitment meaning and no research consumer.**
   - `followup_episodes` is read only by the matching tab (`vcrService.mjs:1164`). No `vcr_read` returns it (`OS/runtime/mcp/evimed-research/vcr_platform.py:75-79`), and no engine job, cohort or longitudinal history reads it.
   - The follow-up data that does feed research is the longitudinal history pipeline (`vcr_write what:history` → `OS/apps/server/src/vcrLongitudinal.mjs`, data-plane snapshots with `siteColumn`/`occurredColumn` mappings, `OS/packages/domain/src/vcrLongitudinal.mjs:85`), and that pipeline is independent of every OA table.
   - The `study_specific` restricted-field rule (`vcrGateway.mjs:1670-1674`) only makes sense for "a partner's patient in somebody else's trial" (`vcrRecruit.mjs:680-684`). Once the referral-to-partner flow is gone, keeping it as a blanket rule is a policy decision. Claim 5 (owned by another fork) verifies that rule.
9. **Erasure depends on the ledger API** (`vcrErasureStore.mjs:84, 289-299, 314`). Remove those lines together with `transitionReferral`, or erasure breaks at runtime: `this.matchStore?.transitionReferral` is optional-chained, but the SQL `SELECT … FROM referrals` (`:291`, `:314`) fails once the table is dropped.
10. **Runtime vocabulary is held equal in three places.** `VCR_WRITE_WHATS` (`vcrService.mjs:125-130`), `WRITE_WHATS` in `vcr_platform.py:80-85`, and the test that compares them (`OS/runtime/mcp/evimed-research/test/test_vcr_platform.py`; per `vcr_platform.py:72-74`, `OS/apps/server/test/vcrGateway.test.mjs` holds the copies equal). Removing `site` is a three-file change.
11. **The capability SKILL is copied byte-identically** (`OS/capabilities/vcr-matching/SKILL.md` = `OS/capability-skills/vcr-matching/SKILL.md`). The repo already notes that a SKILL/manifest edit ripples into several tests (memory "Capability edits ripple into six tests").

### Q2.4 Deletion-size estimate

**How I counted.** Whole files with `wc -l`. For mixed files I used function or block boundaries read from the code (`rg -n "^export|^  async |^test\("` plus `sed -n` of each range) and summed only the OA ranges. Partial numbers are rounded and good to about ±20%. "(a)" is delete. "(b)" is code to rework or keep for 虚拟试验. "(c)" stays.

**Whole files deletable (a)**

| File | Lines |
|---|---|
| `OS/apps/server/src/vcrContact.mjs` | 289 |
| `OS/apps/server/test/vcrContact.integration.test.mjs` | 262 |
| `OS/apps/server/test/fixtures/vcr-views/ev201/matching-referral.json` | 615 |
| `OS/apps/server/test/fixtures/vcr-views/ev201/matching-sites.json` | 615 |
| **Whole files subtotal** | **1,781** |

(`matching-followup.json`, 615 lines, is the follow-up view snapshot: c, regenerate.)

**Partial edits, server source (a)**

| File | Range | Lines |
|---|---|---|
| `vcrRecruit.mjs` | ledger and site `:47-369` (323) + backtest `:556-674` (119) | ≈442 |
| `vcrMatchStore.mjs` | `:930-1229` | ≈300 |
| `vcrComposition.mjs` | tab bits, `onJobFinished` referral half, backtest/timeline/readAccrual, contact composition and imports | ≈92 |
| `vcrRoutes.mjs` | | ≈70 |
| `vcrViewsTabs.mjs` | | ≈75 |
| `vcrPersistence.mjs` | DDL `:1211-1276` + list | ≈67 |
| `vcrOrchestrator.mjs` | | ≈59 |
| `vcrNotify.mjs` | | ≈42 |
| `vcrViews.mjs` | `presentTodos` | ≈39 |
| `vcrGateway.mjs` | site writer | ≈26 |
| `vcrMatching.mjs` | `separateLedgers` | ≈23 |
| `vcrService.mjs` | | ≈22 |
| `vcrErasureStore.mjs` | | ≈12 |
| `server.mjs` + `vcrStoreBase.mjs` | | ≈4 |
| **Server source (a), partial** | | **≈1,270** |
| **Server source (a), with `vcrContact.mjs`** | | **≈1,560** |

Plus (b), to rework for a design-time timeline, ≈240: `vcrRecruit.mjs:370-555` (186), `vcrComposition.mjs` `accrualScenario` (≈38), gateway accrual path (≈14). Plus (d), ≈17: `vcrDataPlane.identityOf`.

**Domain, MCP, skills, evals (a)**

| Area | What | Lines |
|---|---|---|
| Domain | `vcrVocabulary.mjs` (≈18: referral states and labels, contact states, roles `recruiter`/`site` and three abilities, `contact_patient` stop, two notice kinds, two people-count keys), `errorCodes.mjs` (≈16), `capability-display.json`, `skill-packages.json` | ≈40 |
| MCP | `vcr_platform.py`: `site` whitelist entry, description words | ≈3 |
| Capability text | `vcr-matching` `capability.yaml` (≈12) and `SKILL.md` (≈16) × 2 tracked copies, `vcr-protocol/SKILL.md:36` × 2 copies | ≈60 |
| Evals | brief `vcr-matching-005` | ≈28 |

**Web source (a)**

| File | Lines |
|---|---|
| `MatchingTab.tsx` (of 845) | ≈285 |
| `vcrClient.ts` (referral functions `:2710-2768` + types) | ≈130 |
| `VcrCharts.tsx` (`VcrForecastChart` `:465-565`, which never draws, see row 25) | ≈101 |
| `VcrMembersDialog.tsx` | ≈35 |
| `vcrBodies.ts` | ≈30 |
| `VcrHomePage.tsx` | ≈15 |
| `vcrText.ts` | ≈2 |
| **Web source (a)** | **≈600** |

**Tests, partial (a)**

| File | Lines |
|---|---|
| `vcrRecruit.test.mjs` (of 483; plus ≈87 (b) AC-37 accrual tests `:247-333`, ≈53 (c) AC-22 tests `:431-483`) | ≈320 |
| `RecruitTabs.test.tsx` (of 1,199: contact/ledger/trail/sites/forecast blocks `:121-184` part, `:206-309`, `:838-976`) | ≈280 |
| `vcrRecruit.integration.test.mjs` (of 393) | ≈225 |
| `vcrEvidenceMatching.integration.test.mjs` (`:692-812` part, `:758-779` accrual-from-ledger) | ≈150 |
| `vcrRoutes.test.mjs` (`:723-819`, `:820-852` part) | ≈120 |
| `vcrComposedApp.integration.test.mjs` | ≈100 |
| `vcrOrchestrator.test.mjs` (`:442-496` notices, `:497` tolerance) | ≈60 |
| web `vcrClient.test.ts` | ≈60 |
| `vcrOrchestrator.integration.test.mjs` (`:1335-1384` accrual half) | ≈50 |
| `vcrMembers.test.mjs` + `vcrClientBodiesMembers.test.mjs` | ≈40 |
| `vcrViews.test.mjs` (`:760`) | ≈30 |
| `VcrHomePage.test.tsx` + `serverFixtures.ts` | ≈30 |
| `test_vcr_platform.py` | ≈20 |
| `vcrPersistence.test.mjs` (`:99`) | ≈15 |
| **Tests, partial (a)** | **≈1,500** |

**Totals**

| Bucket | Files | Lines |
|---|---|---|
| Whole files (a) | 4 | ≈1,780 (1,230 of it two JSON view fixtures) |
| Partial edits (a) | ≈38 | ≈3,500 (≈1,270 server source, ≈40 domain, ≈60 skill/eval text, ≈600 web, ≈1,500 tests) |
| **(a) overall** | **≈42** | **≈5,300** (≈1,900 production source, ≈3,400 tests and fixtures) |
| (b) | | ≈240 source + ≈90 tests. Keep only if 虚拟试验 wants a site-level accrual model. The simpler design-time accrual already lives in `design.simulate`. |
| (c) | | follow-up: `vcrRecruit.mjs:675-794`, `vcrMatchStore.mjs:1230-1268`, gateway `followup` writer, `followup_episodes` table, `FollowupView`, ≈80 test lines. Stays, but has to move out of the 匹配与招募 tab and still has no analytic consumer. |

For scale: VCR server source is 46,904 lines (`cat OS/apps/server/src/vcr*.mjs OS/apps/server/src/resultVcrReplay.mjs | wc -l`), so recruitment is about 3–4% of the server code. The work is less about volume than about splitting the mixed files listed in Q2.3.

### Q2.5 The frontier feed's "VCR trial events"

- **What they are.** They are flywheel F24, consumed by VCR and not produced by it.
  - `OS/apps/server/src/vcrFrontierEvents.mjs:1-36`. A worker loop every 10 min (`OS/apps/server/src/vcrWorker.mjs:60`) reads frontier-feed items matching a study's entity keys and the identifiers its assumption cards stand on (`vcrFrontierEvents.mjs:5-6`).
  - Each item is classified by the feed's own fields into `registration` | `results` | `label_change` (`:46`, `trialEventOf` `:94-101`). The fields are registry ids plus the flags `registry-unpublished` / `data-updated`, evidence type `rct`, and lane `regulatory`.
  - The flags are set upstream by the frontier pipeline from the knowledge plugin's registry facts (`OS/apps/server/src/frontierPipeline.mjs:605-612`, `facts.trial_event`).
- **What they do.**
  - Write **precedent candidates** (`INSERT INTO … precedent_candidates`, `vcrFrontierEvents.mjs:181-185`; table `OS/apps/server/src/vcrPersistence.mjs:1489`). A candidate is a pointer only, never a precedent (`:16-19`).
  - Label assumption cards with **evidence signals** when one of their sources has new results, a retraction, a correction or a new version (`:242-256`; table `vcrPersistence.mjs:1509`).
  - Ask the orchestrator for an `evidence` refresh run (`requestEvidenceRefresh` `:267`) and send notice kind 6 `new_evidence` (`:279`).
  - A frozen analysis plan is never touched (`:28-31`).
- **Dependence on recruitment: none.** `vcrFrontierEvents.mjs` reads no referral, site, enrolment or follow-up data. `rg -i "referral|recruit|enrol|\bsites?\b"` over the file returns 0 lines. Its inputs are the entity vocabulary, `sourceChanges` and the study's cards.
- **Switch and gate.** `OPEN_SCIENCE_VCR_FRONTIER_EVENTS_ENABLED`, default **on** (`OS/apps/server/src/config.mjs:1067`). It is composed only when the frontier module is on too (`OS/apps/server/src/vcrComposition.mjs:1217`).
- **Relevance to the reset.** These events are evidence-parameterisation input (precedents and assumption cards). They survive the recruitment removal unchanged. They matter to 合成对照 and 虚拟试验 (phases 2–3), not to OA.

### Q2.6 Six most decision-relevant facts (for the parent's summary)

1. **The matching→referral→notify side effect is automatic and unconditional.** Every succeeded `match_criteria` job creates referral rows (`actor:"control-plane"`) for document candidates and sends `new_candidates` to coordinators or the owner. Code: `OS/apps/server/src/vcrComposition.mjs:841-859`, hook `:1176`. Rows from the subject table are exempt (`:828-831`). The 15-minute `recheck` loop (`OS/apps/server/src/vcrWorker.mjs:59`) re-fires it. There is no switch for it.
2. **Ordinary owners already see OA.** The owner resolves to `lead` (`OS/apps/server/src/vcrService.mjs:602-605`), and `lead` holds `contact_patients` (`OS/packages/domain/src/vcrVocabulary.mjs:564`). So the VCR home shows 「招募待办」 for every owner whose matching produced referrals (`vcrService.mjs:566-577`, `OS/apps/server/src/vcrViews.mjs:492-524`).
3. **Accrual is the one coupling that can break phase 3.** The conversation path to `accrual_forecast` only accepts `target/eventTarget/eventHazard/byTimes` and builds the per-site rates from the site CRM and referral ledger (`OS/apps/server/src/vcrGateway.mjs:2361-2372`, `vcrComposition.mjs:929-958`). It refuses a study without site rows (`:942`). The 虚拟试验 trade-off chart's duration axis reads only that forecast (`OS/apps/server/src/vcrViews.mjs:1052-1058`; `DESIGN_MEASURES` `:874` omits `duration_months`). The engine schema itself accepts pure assumptions (`OS/packages/domain/src/vcrScenarioSchemas.mjs:805-818`). Rewire before or with deleting the CRM.
4. **Follow-up data (c) has no research consumer today.** `followup_episodes` is written by `vcr_write what:followup` (`vcrGateway.mjs:1658-1709`) and read only by the matching tab (`vcrService.mjs:1164`). `READ_WHATS` lacks it (`OS/runtime/mcp/evimed-research/vcr_platform.py:75-79`), and no job reads it. The longitudinal history pipeline (`OS/apps/server/src/vcrLongitudinal.mjs`) is the follow-up input that research actually uses, and it is independent of every OA table.
5. **The deletion is mostly surgery on mixed files.** Only `vcrContact.mjs` (289 lines) and its test are whole-file deletions. `vcrRecruit.mjs` (794 lines) splits into a (≈442), b (≈186) and c (≈120). `vcrMatchStore.mjs`, `onJobFinished`, `presentMatchingTab` and the 「匹配与招募」 tab each mix kept matching code with OA. Estimate: ≈5,300 lines (a) across ≈42 files, ≈1,900 of them production source.
6. **The frontier "VCR trial events" do not depend on recruitment.** They are registry/feed events (registration, results, label_change) turned into precedent candidates and assumption-card evidence signals (`OS/apps/server/src/vcrFrontierEvents.mjs:94-101, 181-185, 242-279`). They read no referral, site or enrolment data, and they survive the reset as evidence input for phases 2–3.


_(Q2 was drafted by a review fork. I re-read the decisive lines:_
- _`vcrViews.mjs:873-874,1052-1058`: the duration axis comes only from the accrual forecast;_
- _`vcrGateway.mjs:2359-2373`: the conversation's path to accrual_forecast builds the rates from the ledger;_
- _`vcrComposition.mjs:941-942`: refused without site rows;_
- _`vcrVocabulary.mjs:557-570`: lead holds contact_patients;_
- _`vcrWorker.mjs:52-60`: the 15-minute recheck;_
- _`vcrService.mjs:597-605`: the owner counts as lead.)_

---

## Q3 — Engine

### Q3.1 The method list (`VCR_ENGINE_METHODS`) and how each is implemented

- Definition: `OpenScience/packages/domain/src/vcrEngineJob.mjs:90-129`. It holds **32 methods** (counted with a pure `node -e` import of `VCR_ENGINE_METHOD_IDS`, `vcrEngineJob.mjs:131`).
- The engine's generated snapshot `项目代码/vcr-engine/R/domain-snapshot.json` (key `methods`) holds the same 32 ids. The engine also refuses to start on a mismatch (`项目代码/vcr-engine/R/engine.R:6-12`; the build-time self-check is in `项目代码/vcr-engine/Dockerfile`, the `vcr_engine_health()` step).
- **Job kinds are 36, not 32.** `VCR_JOB_METHODS` (`vcrEngineJob.mjs:139-176`) adds four `forecast.*` methods (`forecast.trajectories`, `forecast.evaluate`, `forecast.compare`, `forecast.trial_benchmark`), defined in `OpenScience/packages/domain/src/vcrLongitudinal.mjs:5-14`. These four have **no R handler**: the handler table at `R/engine.R:65-98` lacks them. They run in the control plane: `OpenScience/apps/server/src/vcrLongitudinal.mjs:225-322` and `OpenScience/apps/server/src/vcrForecastCalculation.mjs:9-11`. `matching.evaluate` has an R handler (`R/engine.R:1969`), but in production it runs in the control plane as a "local executor" (`OpenScience/apps/server/src/vcrJobs.mjs:110-114`, `vcrJobs.mjs:1154-1155`).

**What R packages the engine actually uses at run time.**
- The runtime lock `R/package-lock.json` has 62 packages. The packages the code loads directly are **jsonlite, digest, mvtnorm and synthpop**; the rest is their dependency closure (party, ranger, randomForest, polspline, …). R's own base/recommended packages also ship: survival, nlme, MASS (`Dockerfile`, the comment block on the two locks).
- `rg -o 'pkg::'` over `R/*.R` gives: `stats::` 309, `survival::` 14, `utils::` 11, `jsonlite::` 9, `parallel::` 4, `digest::` 3, `synthpop::` 2, `mvtnorm::` 1. No call goes to WeightIt, MatchIt, cobalt, RBesT, metafor, EValue, survRM2, flexsurv, IPDfromKM, rpact, gsDesign, simsurv or maicplus.
- Those packages are installed **only** in the CI cross-check image (`--build-arg WITH_CROSSCHECK=1`, from `tests/package-lock.crosscheck.json`, 96 packages). The numeric cases in `tests/numeric/` (42 files, N00–N51, C2_*, E*) compare the engine against them.
- So almost every statistical method is a **careful hand-written re-implementation, checked against the reference package in CI**, not a call into the package. The engine's comments say why: bit-reproducibility by seed and scenario hash, and "a number we cannot derive ourselves is a number we cannot defend" (`R/design_analytic.R:5-12`, `R/map_prior.R:5-12`, `R/evidence_pool.R:24-25`).
- Pins: R 4.3.3 by image digest; CRAN snapshot date 2026-09-28; the build fails on any version drift (`Dockerfile`, `ARG CRAN_SNAPSHOT_DATE` and the verify step).

| Method | R handler | Run-time implementation | Cross-check (CI only) | Note |
|---|---|---|---|---|
| profile.snapshot | `R/engine.R:442` | base R | profile_dataset.py | descriptive profile |
| cohort.build | `R/engine.R:514` (+ `R/rules.R`) | base R; rules are data, not code (`R/engine.R:19-22`) | — | criteria filter on a snapshot |
| population.scenario | `R/engine.R:597` → `R/population.R` | Gaussian copula, `mvtnorm::rmvnorm` (`R/population.R:194`); bounds by quantile inversion | "simstudy semantics" | |
| population.literature | `R/engine.R:627` → `R/population.R` | same copula from a published baseline table; correlations "assumed" unless stated (`R/engine.R:633-634`) | — | |
| population.synthpop | `R/engine.R:666` → `R/population.R:416,450` | **`synthpop::syn` (CART) — the one real CRAN modelling call** | synthpop | |
| population.quality | `R/engine.R:735` → `R/quality.R` | stats::glm/ks.test/chisq.test; S_pMSE re-derived (`R/quality.R:137`) | — | "a report, not a gate" (`R/quality.R:5-8`) |
| patients.continuous / binary / time_to_event | `R/engine.R:772` → `R/simulators.R` | inversion sampling (Bender 2005); one uniform per subject per draw (`R/simulators.R:9-16`) | simsurv | the 3 reference simulators; risk `none`, intended use capped at exploratory (`R/simulators.R:5-8`) |
| patients.longitudinal | `R/longitudinal.R:194` | hand-written linear mixed model generator | nlme::lme on output | person-level CRN by design (`R/longitudinal.R:8-23`) |
| evidence.pool | `R/engine.R:851` → `R/evidence_pool.R` | own DL / REML / HKSJ plus the Higgins–Thompson–Spiegelhalter prediction interval (k−2 df; NA for k=2) | metafor, meta engine | `R/evidence_pool.R:5-25` |
| evidence.reconstruct_km | `R/engine.R:928` → `R/reconstruct.R` | own Guyot iteration with QC; output labelled `reconstructed` | IPDfromKM | coordinates never come from a model (`R/reconstruct.R:29-35`) |
| comparator.entropy_balance / propensity_weight | `R/engine.R:1061` → `R/weighting.R` | own Newton solver on the entropy-balancing dual; propensity via `stats::glm`; whole-pipeline bootstrap (weights re-estimated) | WeightIt, cobalt | `R/weighting.R:7-35` |
| comparator.rmst | `R/engine.R:1228` → `R/rmst.R` | own weighted KM, exact area; bootstrap variance when weighted | survRM2 | refuses tau beyond follow-up (`R/rmst.R:16-26`) |
| comparator.maic | `R/engine.R:1285` → `R/maic.R` | MAIC = the entropy-balance kernel (`R/maic.R:7-12`) | NICE DSU TSD 18 | unanchored capped at `limited` |
| comparator.maic_time_to_event | `R/maic_tte.R:71` | `survival::coxph` via `vcr_cox_primary` (`R/maic_tte.R:156-164`) | maicplus 0.1.2 vignette | |
| comparator.weighted_cox | `R/weighted_cox.R:82` | **`survival::coxph` / `coxph.fit` / `cox.zph`** (`R/weighted_cox.R:47-70`) | coxph on WeightIt weights | |
| comparator.aipw | `R/aipw.R:90` | `stats::glm` nuisance models; influence-function SE plus bootstrap | closed-form AIPW | |
| comparator.covariate_sets | `R/covariate_sets.R:32` | re-calls the weighting/AIPW handlers per set | — | |
| comparator.negative_control | `R/negative_control.R:200` | empirical null by `stats::optim` | EmpiricalCalibration | calibration only at ≥30 controls |
| comparator.tipping_point | `R/tipping_point.R:531` | exact enumeration; own `vcr_cox_binary` Newton Cox (`R/tipping_point.R:257`) | fisher.test, binom.test | |
| comparator.prognostic_adjustment | `R/prognostic_adjustment.R:422` | `survival::coxph` (`R/prognostic_adjustment.R:313`) plus `glm.fit` | FDA 2023 table | carries "not EMA-qualified" on every result |
| comparator.evalue | `R/engine.R:1385` | closed form | EValue | |
| comparator.map_prior | `R/engine.R:1413` → `R/map_prior.R` | quadrature over tau, no MCMC (`R/map_prior.R:5-13`) | RBesT | |
| design.analytic | `R/engine.R:1494` → `R/design_analytic.R` | own group-sequential recursion (Armitage–McPherson–Rowe, B scale) | rpact, gsDesign | `R/design_analytic.R:5-18` |
| design.simulate / design.grid | `R/engine.R:1651,1681` → `R/design_simulate.R`, `R/single_arm.R` | ADEMP runner; own log-rank (`R/simulators.R:343`) | design.analytic | replicates stored by index |
| design.assurance | `R/engine.R:1736` → `R/assurance.R` | Gauss–Hermite over a normal design prior | O'Hagan 2005 | prior meant to come from `evidence_pool` (`R/assurance.R:12-17`) |
| design.procova | `R/engine.R:1827` → `R/procova.R` | closed-form sample size | EMA 2022 | |
| accrual.poisson_gamma | `R/engine.R:1854` → `R/accrual.R` | closed form via `qf`; simulation for staggered sites | Anisimov & Fedorov | **site-based recruitment forecast** (`R/accrual.R:5-37`) |
| matching.evaluate | `R/engine.R:1969` (unused in production) | Kleene three-valued logic over criterion states someone else decided | Kleene truth table | the per-criterion *evidence* is not decided here |

**Verdict on engine quality.** The statistics layer is the strongest asset in the module:
- variance estimators are present (bootstrap with weights re-estimated, robust sandwich, Monte-Carlo standard errors);
- the not-estimable rules are deterministic;
- each method has a CI numeric case against a mature package.

The obvious costs:
- **Nothing is a library call.** Every method is code this team must maintain.
- **The model families are narrow.** There is no parametric survival fitting (no Weibull, log-normal or flexsurv fit of a reconstructed KM). The time-to-event simulators *take* stated hazards, piecewise or Weibull (`R/simulators.R:17-20`). They do not fit them.
- **There is no prediction or risk-equation model of an individual patient** anywhere in R. The only individual-level generators are the three scenario simulators plus the linear mixed model.

### Q3.2 Job model

**Engine service (`项目代码/vcr-engine/service/app.py`)**

- **Queue of one, by design.**
  - One in-memory `Queue` and one worker thread: `app.py:635-645` ("One worker, one queue, results on disk").
  - One uvicorn worker (`Dockerfile`, last `CMD`, `--workers 1`).
  - Rationale: a shared four-core host (`app.py:41-46`).
- **Process isolation.**
  - Each job is its own `Rscript service/run_job.R` child in a new session/process group (`app.py:956-964`; why: `service/run_job.R` header).
  - CPU is bounded by `RLIMIT_CPU` on the child, not by a wall timer (`app.py:47-52`, `494-511`). Optional `RLIMIT_AS` (`VCR_ENGINE_MEMORY_BYTES`, default 0 = off; `app.py:34`).
  - R stops itself at 0.9 of the CPU limit and returns a partial `limited` result (`app.py:49-51`).
- **Limits.**
  - CPU-seconds per job: default 600, cap 3600 (`app.py:32`, `282-283`).
  - Replicates: max 200,000 (`app.py:34`; `OpenScience/packages/domain/src/vcrEngineJob.mjs:219`).
  - Body: 8 MiB. Output tables: 512 MiB (`app.py:35-37`).
- **Cancel.** A cancel file, then SIGTERM, then SIGKILL to the group (`app.py:53-61`, `828-934`). A canceled job keeps its finished batches.
- **Durability and signing.**
  - The queue is lost on restart; results and checkpoints survive on disk (`app.py:62-69`).
  - Receipt: HMAC-SHA256 over `jobId \n scenarioHash \n outputHash` when a receipt key file is mounted (`app.py:443-455`).
  - No network egress and no model client (`app.py:91-93`).

**Control plane (`OpenScience/apps/server/src/vcrJobs.mjs`, `vcrWorker.mjs`, `vcrEngineClient.mjs`)**

- **The global concurrency is also one.**
  - `vcrMaxConcurrentJobs` defaults to 1 (`OPEN_SCIENCE_VCR_MAX_CONCURRENT_JOBS`, `OpenScience/apps/server/src/config.mjs:1113-1114`).
  - `claim()` counts every `running` job of every study and every account (`vcrJobs.mjs:964-967`). It takes them FIFO by `run_after, created_at` (`vcrJobs.mjs:968-974`), behind the host-wide `heavyWorkAdmission` lock it shares with document-export renders and extension preparation (`OpenScience/apps/server/src/heavyWorkAdmission.mjs:9-41`, called at `vcrJobs.mjs:953`).
  - **Matching (`matching.evaluate`) and the four `forecast.*` methods run locally but go through the same queue and the same count** (`vcrJobs.mjs:110-114`, `1154-1155`; registered as local executors at `OpenScience/apps/server/src/vcrComposition.mjs:1134,1186`). So a one-patient eligibility check can wait behind another user's 10-minute design simulation.
  - This is the single most important engine fact for a conversation-first product.
- **Timeouts and retries.**
  - The engine HTTP client times out at 120 s (30 s for submit/status/discard, 15 s for cancel; `vcrEngineClient.mjs:215`, `329-371`).
  - Job lease: 900 s (`vcrJobs.mjs:144-145`).
  - Up to 3 attempts, with backoff `min(600, 15·2^(n-1))` s, only on retryable failures (`vcrJobs.mjs:146-147`, `1412-1427`). Up to 2 resubmits when the engine lost a job (`vcrJobs.mjs:148-149`).
  - Worker tick: 5 s (`vcrWorker.mjs:109`).
- **CPU budgets.**
  - Per job, `OPEN_SCIENCE_VCR_JOB_CPU_SECONDS` = 600 (`config.mjs:1116`, applied at `vcrJobs.mjs:661-662`).
  - Per study, `OPEN_SCIENCE_VCR_STUDY_CPU_BUDGET` = 7,200 CPU-s. Past it a job goes to `awaiting_budget` and waits for **one human confirmation** (`config.mjs:1117-1119`, `vcrJobs.mjs:59-75`, `544`).
  - This is one of the "three human stops", and the conversation is told not to wait for it (`OpenScience/runtime/mcp/evimed-research/vcr_platform.py:1083-1094`).
- **Replicate counts.**
  - Design simulation and grid: floor 20,000 under the null and 5,000 under an alternative, raised to a target Monte-Carlo SE. Grid: the worst cell (`vcrJobs.mjs:257-275`, function at `263`; `OpenScience/packages/domain/src/vcrVocabulary.mjs:925-926`; the rationale, e.g. 24,375 for MCSE 0.001 at α = 0.025, is in `vcrEngineJob.mjs:37-42`).
  - Batches of 500 with a checkpoint each (`R/engine.R:1657,1690`, `R/design_simulate.R:407-464`).
  - Bootstraps for the weighting, Cox, AIPW and MAIC-TTE jobs: floor 2,000 (`R/weighting.R:273-276`; `VCR_BOOTSTRAP_MIN`, `vcrVocabulary.mjs:923`).
  - The longitudinal forecast caps are `samples: 1,000, bootstrap: 500` (`OpenScience/packages/domain/src/vcrLongitudinal.mjs:17`).
- **Seeds and randomness.**
  - The RNG is L'Ecuyer-CMRG, with one substream per replicate, so results are bit-identical across core counts and resumes (`R/rng.R:5-27`).
  - **The default seed is derived from the scenario hash** (`vcrSeedFor`: the first 31 bits of `sha256(canonical scenario)`; `vcrJobs.mjs:53-56`, `231-239`, applied at `vcrJobs.mjs:659`).
  - **Consequence:** two scenarios that differ in one assumption get *different* seeds, so by default they share **no** common random numbers. This is true even though the simulators are built for them: one uniform per subject in a fixed order, "common random numbers across scenarios is a product requirement" (`R/simulators.R:9-16`, `R/simulators.R:27-34`, `R/longitudinal.R:8-23`).
  - CRN therefore holds only when a caller passes the same explicit seed. The calculator UI does (`seed ?? 42`, `OpenScience/apps/web/src/components/vcr/VcrMethodRunner.tsx:224`, sent at `:210`). `vcr_simulate` and the orchestrator do not unless the model or caller names a seed (`vcr_platform.py:1005`, `OpenScience/apps/server/src/vcrGateway.mjs:299`; `vcrOrchestrator.mjs` contains no `seed` token at all).
  - **Virtual-patient ids include the job id:** `vp_` + the first 12 hex of `sha256(seed:jobId:i)` (`R/engine.R:820-821`; same in `R/longitudinal.R:242`). Even with a shared seed, "patient 17 under scenario A" and "patient 17 under scenario B" have different ids. The two runs are coupled by row index, not by identity. A cross-scenario single-patient view must join on the index, or the id formula must drop `jobId`.

### Q3.3 How a conversation learns a job finished, and whether a simulation blocks the turn

- **No DSH job wrapper.** `MCP_MANAGED_JOB_BASE_NAMES` lists only the six specialist engines; `vcr_simulate` is not among them (`OpenScience/packages/domain/src/toolNames.mjs:165-172`).
- **The tool does a bounded poll inside the call.**
  - `vcr_simulate start` (and `status`) re-asks the gateway every 4 s, up to `EVIMED_VCR_STATUS_WAIT_SECONDS`: default 20 s, hard max 60 s, 0 = no wait (`OpenScience/runtime/mcp/evimed-research/vcr_platform.py:131-137`, `1028-1066`).
  - The control-plane key is `OPEN_SCIENCE_VCR_STATUS_WAIT_SECONDS` (`OpenScience/apps/server/src/config.mjs:1159`). It reaches the runtime through `runtimeManager.mjs:1714`.
  - So a computation of seconds (analytic designs, E-values, MAP, small cohorts) comes back finished in one call. Anything longer comes back `queued`/`running`.
- **Past the wait, the model is told to stop.** The tool answer says:
  - "Do not wait for it in this turn — no status loop, no sleep… answer with what you already have, and end the turn" (`vcr_platform.py:1095-1112`, the text at `1108-1110`);
  - "In a later turn, when asked, read the result with vcr_read (what: results)" (`vcr_platform.py:1111`).
  - So a long simulation **does not block** the turn (the wait ≤ 60 s stays under the kernel's 180 s tool limit, `vcr_platform.py:128-134`). The price: **the conversation never receives the result by itself.**
- **When the job ends:**
  - The orchestrator files the result under its study object. It sends one inbox notice of kind `job_finished` (「你要的计算算完了」), only for jobs the conversation queued (`checkpoint.origin === "runtime"`, set at `OpenScience/apps/server/src/vcrGateway.mjs:2344`) or that a person asked for with 「让 AI 做」. Programme recomputations send none, and only some result kinds qualify (`OpenScience/apps/server/src/vcrOrchestrator.mjs:2908-2930`; `OpenScience/apps/server/src/vcrNotify.mjs:293-310`; kind list at `OpenScience/packages/domain/src/vcrVocabulary.mjs:830-835`).
  - The web app turns a *new* notice into a toast with 「查看结果」. It polls the unread count every 20 s, and only while the reader is on that study's page or conversation (`OpenScience/apps/web/src/components/vcr/useVcrFinishedToasts.ts:10`, `26-37`, `99`).
  - Nothing posts into the DSH session. There is no `session/prompt` continuation and no settlement notice like the kernel's own sub-agent results: `rg 'session/prompt|continuation|dispatchTurn'` over `vcrOrchestrator.mjs`, `vcrJobs.mjs`, `vcrComposition.mjs`, `vcrGateway.mjs` and `vcrNotify.mjs` finds nothing.
  - The only path where AI reads results back by itself is the programme's: the orchestrator dispatches its own quiet runs (`#dispatch`, `OpenScience/apps/server/src/vcrOrchestrator.mjs:3331`; programme role, in no conversation list per root `AGENTS.md`). That path is not the user's conversation.
- **Implication for "the AI conversation is how users work".**
  - The user has to come back and ask ("算完了吗？"). The model must then call `vcr_read(results)` and explain.
  - That is workable but not conversational. 虚拟试验 (design simulation) and the bootstrapped comparators are exactly the long jobs: 20k+ replicates, 2,000 bootstraps, 600 CPU-s default ceiling, one global slot.
  - Closing the loop needs one of: a job-completion → conversation continuation (the run ledger already has an `automated`/continuation route for LoopX, root `AGENTS.md`); a longer in-call wait; or the kernel job API (`job_run`/`job_status` are mounted kernel tools, `toolNames.mjs:415`).
  - Also: a job over the study's CPU budget parks in `awaiting_budget` until a human confirms on the study page (`vcr_platform.py:1083-1094`). That is a hard stop the conversation can only report.

## Q6 — Models

### Q6.1 Built-in model catalogue

- **Four rows, all "mathematical reference simulators", tier `scenario`, risk `none`.** `VCR_REFERENCE_MODELS` (`OpenScience/apps/server/src/vcrService.mjs:231-311`) is seeded into the library by `seedVcrCatalogue` (`vcrService.mjs:313-333`) together with the 32 engine methods:

| Name | Engine call | Inputs | Card's stated limits |
|---|---|---|---|
| `reference-continuous` | `patients.continuous` | arm sizes, effect, SD, baseline correlation | 「不可用于个体层面的预测」「不承载疗效或安全性证据」 (`vcrService.mjs:233-247`) |
| `reference-binary` | `patients.binary` | control rate, treatment rate / RD / OR | same (`vcrService.mjs:250-264`) |
| `reference-time-to-event` | `patients.time_to_event` | HR, control median or exponential/Weibull/piecewise, accrual, follow-up, dropout | PH by default; no population covariate structure (`vcrService.mjs:267-283`) |
| `reference-longitudinal` | `patients.longitudinal` | visits, intercept, slope, effect on slope, random-effect SDs/correlation, residual SD, per-visit dropout | linear trajectories, MCAR dropout, 「不可用于个体层面的预测」 (`vcrService.mjs:286-306`) |

- The input labels come from the engine's own scenario schemas (`vcrReferenceModelInputs`, `vcrService.mjs:203-223`). The card text itself says what these models are: scenario generators, "not a prediction for any real population or individual".
- **Two "interface shapes"** exist (`OpenScience/packages/domain/src/vcrModelInterfaces.mjs:49-63`):
  - `baseline_to_outcome`: hosted by the R patient generators.
  - `event_history_to_trajectories`: hosted only by the control plane's cloud forecast adapter or imported predictions, and never falls into an R simulator (`vcrModelInterfaces.mjs:56-63`).
  - Mechanistic (QSP/PBPK) is mentioned as a future model *type* only (`vcrModelInterfaces.mjs:12-14`).

### Q6.2 Literature model intake: what is supported

**There is no fitted-model intake. A "literature model" is the reference simulator with some of its inputs bound to numbers quoted from a preserved source.**

- `OpenScience/apps/server/src/vcrModelSources.mjs:1`: "Source-bound numeric parameters for existing reference simulators, never an inferred fitted model."
- Three profiles only (`vcrModelSources.mjs:8-18`):
  - `patients.continuous`: effect + SD;
  - `patients.binary`: control + treatment rate;
  - `patients.time_to_event`: HR + control median.
- Candidates are **every number literally present in the source text** (first 1,000,000 characters, at most 1,000 numbers), with exact quote offsets. The person picks which number means which field; "Meaning is chosen explicitly, never guessed" (`vcrModelSources.mjs:19-41`).
- `prepare()` re-resolves every binding from trusted bytes and ignores browser-supplied values. It validates against the method's scenario schema with a placeholder 1:1 design that is not persisted, and returns:
  - `registrationState: "parameterized_reference"` when complete, else `"incomplete_specification"` with a `specificationMissing` list;
  - `type: "literature_parameterized_reference"`;
  - the explicit limit 「没有由这些数值推断模型方程、个体预测能力或临床验证」.
  - (`vcrModelSources.mjs:66-112`.) When no profile is chosen it says 「外部模型方程与可调用集成尚未提供」 (`vcrModelSources.mjs:103`).
- **Execution** is allowed only for a model bound to a literature source with a complete `executionSpec`. The job's scenario must carry the same endpoint, time unit and parameter values; otherwise "register a corrected model version first" (`vcrService.mjs:1384-1399`, called from `OpenScience/apps/server/src/vcrRoutes.mjs:1247,1298`).
- **ClinicalTrials.gov intake:** `adoptModel` with `card.sourceRegistryId` (NCT only, `^NCT\d{8}$`). It preserves the registry record and the verified precedent parameters (value, unit, quote, locator) onto the card as `sourceParameters` (`vcrService.mjs:1311-1329`). These are **not** made executable; only a literature-source binding is.
- **Not supported anywhere:**
  - a parametric survival fit (Weibull, log-normal, flexsurv) to a reconstructed KM. `evidence.reconstruct_km` pseudo-IPD feeds only `comparator.rmst` and `comparator.maic_time_to_event` (`OpenScience/packages/domain/src/vcrEngineJob.mjs:198-215`); no R file fits a parametric survival likelihood (`rg -i 'weibull|loglik' R/` hits only stated generator distributions: `R/simulators.R:198-206`, `R/design_analytic.R:518-529`);
  - published Cox coefficients + baseline survival;
  - logistic or risk equations;
  - any covariate-conditional individual prediction.
  - The only covariate-to-outcome mechanism is `truth.covariateEffects`, user-stated log-hazard/logit/mean shifts applied to a stored population (`R/engine.R:787-799`).
- **Label risk:** `adoptModel` stamps every `baseline_to_outcome` card `type: "fitted_prediction_model"` (`vcrService.mjs:1306-1307`). The page shows that as 「拟合预测」 (`OpenScience/apps/server/src/vcrViewsKit.mjs:836-838`, used at `OpenScience/apps/server/src/vcrViews.mjs:1253`). Only the literature-source path overwrites it to 「文献参数参考仿真」. A registry-only or bare adopted card therefore reads as a fitted prediction model although nothing was fitted. That conflicts in spirit with the 10-19/10-20 rule that "registration alone never claims executability" (execution is still refused, so it is a labelling defect, not a computation defect).

### Q6.3 `vcrForecastProvider.mjs` and the forecast methods: what is forecast

- **Disease or endpoint trajectories of individual patients, not recruitment.**
  - `createForecastProviders` (`OpenScience/apps/server/src/vcrForecastProvider.mjs:12-124`) is an adapter to a **deployment-configured external cloud model** speaking `evimed-event-history-v1`.
  - It projects a patient event history (codes, values, units, times; no source text or identifiers, `vcrForecastProvider.mjs:58-64`) and returns marginal endpoint forecasts per subject at stated horizons.
  - Every batch is checked against a per-destination cloud permission (`requireCloudPermission`, `vcrForecastProvider.mjs:55-56`) and a cost budget (`:52-53`). Model and version mismatches are detected (`:102-104`).
- **Off by default, and nothing real is configured.**
  - With `OPEN_SCIENCE_VCR_FORECAST_PROVIDERS_FILE` unset, the provider list is empty (`vcrForecastProvider.mjs:16-17`; `OpenScience/apps/server/src/config.mjs:1124`; compose mounts it only when `OPEN_SCIENCE_VCR_FORECAST_HOST_DIR` is set, `OpenScience/deploy/web/docker-compose.yml:843`).
  - The only provider in the repo is a **disabled example**, "not a real HealthFlux API" (`OpenScience/packages/contracts/healthflux/providers.example.json`, `"enabled": false`, notes[0]).
  - Without a provider, `forecast.trajectories` answers `vcr_forecast_provider_unavailable`; "Imported predictions … remain available" (`vcrForecastProvider.mjs:31-35`).
- **The four `forecast.*` methods are control-plane JavaScript, not R.**
  - `forecast.trajectories` calls the provider (`OpenScience/apps/server/src/vcrLongitudinal.mjs:225-300`).
  - `forecast.evaluate`, `compare` and `trial_benchmark` run in a worker thread (`OpenScience/apps/server/src/vcrForecastCalculation.mjs:1-12`, 512 MB heap, time budget = the job's CPU seconds). The code is `@evimed/domain`'s `vcrForecastEvaluation.mjs` (empirical CRPS, MAE/RMSE, interval coverage, AUROC/AP, Brier, calibration-in-the-large; `OpenScience/packages/domain/src/vcrForecastEvaluation.mjs:1-60`).
  - Limits: `samples ≤ 1,000`, `bootstrap ≤ 500` (`OpenScience/packages/domain/src/vcrLongitudinal.mjs:17`).
  - **Not OA-tied.** This is the "individual view" asset for 队列与虚拟患者: forecast vs observed follow-up data. But it has no forecaster unless one is configured or imported.
- **The recruitment forecast is a different thing and *is* OA-tied.** `accrual.poisson_gamma` (`R/accrual.R`) is fed by `accrualForecastScenario` in `OpenScience/apps/server/src/vcrRecruit.mjs:409-473`: per-site rate posteriors from the site ledger's enrolment and screening history. It is queued by `requestAccrualForecast` (`vcrRecruit.mjs:486-492`) and registered as an `accrual` forecast (`vcrOrchestrator.mjs:3065-3097`). The orchestrator later compares it with actual enrolment and sends notice 5 「实际入组偏离预测」 (`vcrOrchestrator.mjs:3686-3694`; `OpenScience/apps/server/src/vcrNotify.mjs:266-268`).
  - The R model itself is generic (sites × Gamma rates, optional staggered starts and screen failure, `R/accrual.R:5-37`). It could survive inside 虚拟试验 as a *stated* accrual assumption, fed from typed site counts and rates instead of the recruitment ledger.
  - Note: the trial simulator already has its own simpler accrual profile (`scenario.accrual.kind / duration / rates / dropoutAnnual`, `R/engine.R:812-815`; labelled 「入组节奏」 in `vcrService.mjs:189`). 虚拟试验 does not need the Poisson–Gamma model for its timeline.

### Q6.4 `model_comparator` (模型预测比较器): the "unsupported" path

- **Vocabulary.** It is one of five comparator routes (`OpenScience/packages/domain/src/vcrVocabulary.mjs:609-616`), min tier T0.
- **Declared not computable.** `VCR_UNSUPPORTED_COMPARATOR_ROUTES = ["model_comparator"]`: "the engine's simulators give set values, not predictions for a population" (`OpenScience/apps/server/src/vcrService.mjs:419-420`). `vcrRouteOptions` returns `supported: false, available: false` for it (`vcrService.mjs:407-417`).
- **UI.** The comparator tab drops the route from the choices unless an older design already names it, in which case it is shown with what it found (`OpenScience/apps/server/src/vcrViewsTabs.mjs:610-624`).
- **Orchestrator.** A comparator design on that route becomes a *finished* verdict, not a failure: `{ rule: "route_unavailable_in_version", reason: "model_comparator_unavailable" }` with the gap 「适用于该人群的结局模型 … 当前版本的引擎里只有按情景参数生成的参考仿真器，它给出的是设定值，不是对该人群的预测」 (`OpenScience/apps/server/src/vcrOrchestrator.mjs:737-741`, `751-757`). The same gap is the fall-through for any route the planner has no job for (`vcrOrchestrator.mjs:1307`).
- **Can it ever succeed today? No.**
  - The precondition is a validated `baseline_to_outcome` prediction model for the population.
  - The library can only hold reference simulators (stated values) and literature-parameterized versions of them (Q6.2).
  - The one prediction path (`event_history_to_trajectories` via the cloud adapter) is wired to the longitudinal forecast jobs, not to the comparator planner.
- **For phase 2 (合成对照)** this means the synthetic control has to come from routes that already compute:
  - external control (entropy balance / propensity / AIPW / weighted Cox, T2 data);
  - literature control (Guyot + RMST, MAIC);
  - hybrid control (MAP prior).
  - A "model-predicted control arm" (digital-twin / PROCOVA-style prediction) would be new engine work: a fitted outcome model plus validation. `design.procova` today is only a sample-size formula taking an externally stated correlation (`R/procova.R:5-21`).

### Q3/Q6: what this means for the 2026-10-25 plan

1. **Easy:** the engine is complete for phase 2 (合成对照) and phase 3 (虚拟试验). It has external-control weighting, AIPW, weighted Cox, RMST, MAIC (binary/continuous and time-to-event), Guyot reconstruction, MAP priors, E-values, negative controls, tipping points, analytic and group-sequential designs, ADEMP simulation, grids and assurance. All are seeded, with MCSE and deterministic not-estimable rules. No new statistics is needed to start; the work is conversational plumbing.
2. **Hard (latency and capacity):**
   - One global engine slot, shared with matching and forecast jobs and host renders (`config.mjs:1114`, `vcrJobs.mjs:964-967`, `vcrComposition.mjs:1134,1186`).
   - A 20–60 s in-call wait (`vcr_platform.py:131-137`).
   - No completion → conversation continuation (Q3.3).
   - A conversation-first 虚拟试验 needs at least: matching moved off the engine queue (it is local code anyway), more than one slot or a per-user fair share, and a way for the finished job to come back into the conversation.
3. **Wrong for "scenario comparison" today:**
   - The default seed is scenario-derived, so two scenarios share no random numbers (`vcrJobs.mjs:237-239,659`).
   - Virtual-patient ids embed the job id (`R/engine.R:820-821`).
   - The engine was built for CRN (`R/simulators.R:9-16`, `R/longitudinal.R:8-23`), so the fix is small: a study-level seed passed by the conversation/orchestrator, and `vp_` ids from `seed:i` only.
4. **Missing for 队列与虚拟患者 "individual view":**
   - No model predicts *a given real patient's* outcome or trajectory. The reference simulators state values (cards: 「不可用于个体层面的预测」).
   - The longitudinal forecast path depends on an external provider that is not configured (`vcrForecastProvider.mjs:16-17`; example disabled).
   - The individual view can honestly show: (a) a virtual patient's simulated trajectory under both arms (`R/longitudinal.R:8-23`); (b) a real patient's observed follow-up and an imported forecast evaluated against it (`forecast.evaluate`).
   - It cannot show a fitted personalised prediction without new model work.
5. **Literature models are parameter bindings, not models** (`vcrModelSources.mjs:1`). Phase-1/2 copy must not promise "fit a model from the paper". Fix the 「拟合预测」 label on adopted non-literature cards (`vcrService.mjs:1306`).
6. **Recruitment removal touches the engine only at `accrual.poisson_gamma`.** Its only feeder is the site ledger (`vcrRecruit.mjs:409-492`); its consumers are the accrual forecast registry and notice 5 (`vcrOrchestrator.mjs:3065-3097,3686-3694`).
   - The R method can stay as a stated-assumption timeline tool for 虚拟试验 or be dropped. The trial simulator has its own accrual profile (`R/engine.R:812-815`).
   - The disease-trajectory forecast (`forecast.*`) is not recruitment and stays.


_(Q3 and Q6 were drafted by a review fork. I re-read the decisive lines:_
- _`config.mjs:1114`, and `vcrJobs.mjs:945-976` (the running count is global);_
- _`vcrComposition.mjs:1132-1135,1184-1188`: matching and forecast run as local executors on the same queue;_
- _`vcrService.mjs:1306-1307`: the 「拟合预测」 stamp;_
- _the R `library()` and `requireNamespace()` calls (`rng.R:29`, `protocol.R:43-44`, `population.R:49,416`) and the 62-entry `R/package-lock.json`;_
- _`vcrOrchestrator.mjs` contains no `seed` token;_
- _`vcrOrchestrator.mjs:2914-2930`: the job_finished notice;_
- _`useVcrFinishedToasts.ts:10`: the 20 s poll;_
- _`vcrService.mjs:405-421` and `vcrOrchestrator.mjs:735-742`: model_comparator;_
- _`vcrModelSources.mjs:1`.)_

---

## Q4 — Data plane and what the model sees

Paths are repo-root-relative; `OS/` = `OpenScience/`.

### Q4.1 Small-cell suppression: the rule

- **Floor = 10 people**, `VCR_MIN_CELL_SIZE = 10` (`OS/packages/domain/src/vcrVocabulary.mjs:921`). A deployment may only *raise* it: `OPEN_SCIENCE_VCR_MIN_CELL_SIZE` is clamped to `[10, 1000]` (`OS/apps/server/src/config.mjs:1095`) and the service ignores anything not `> 10` (`OS/apps/server/src/vcrService.mjs:1436-1439`).
- **What counts as people is a closed list of key names, not the data's origin**:
  - `VCR_PEOPLE_COUNT_FIELDS`, which includes recruitment words: `n, count, patients, realPatients, subjects, events, kept, excluded, indeterminate, cohortSize, screened, eligible, enrolled, referred, contacted, candidates` (`vcrVocabulary.mjs:1004-1007`).
  - Map keys: `levels` (`:1012`).
  - Scalar keys, e.g. `rows, startingRows, keptRows, trainingObservations, effectiveSampleSize, requestedSubjects, batch*…` (`:1026-1029`).
  - `{name,value}` measures: `cohort_size*, effective_sample_size, rows, training_observations` plus the eligibility summaries `eligible|ineligible|insufficient_evidence|pending` (`:1041-1044`, `:743`).
- **How it is applied** (`OS/packages/domain/src/vcrSuppression.mjs`):
  - **Standalone counts.** A standalone count from 1 to 9 becomes `null`, and the object gets `suppressed:[keys]` (`:132-148`). Zero is not hidden when it stands alone.
  - **Sibling cells.** In an array of cells (or a `levels` map), every cell under 10 is hidden, *zero included*. The hidden set is then topped up with the next-smallest cells until it holds ≥2 cells and ≥10 people. If even that is impossible, the whole table is hidden (`:103-113`, `:208-226`).
  - **Hidden cells keep only their identity.** A hidden cell keeps only its identity keys, such as `key,label,arm,criterion…` (`:57-59`, `:120-130`). Its means, notes and other numbers are dropped.
  - **Smallest count decides.** A cell with several count keys is judged by its smallest one (`:90-94`).
  - **No complements.** `suppressedCount` and `suppressedLevels` are dropped (`:53`, `:230`).
  - **Fails closed.** A cycle, or a payload nested deeper than 200 levels, throws (`:62`, `:203-204`). The service turns that into a whole-payload refusal, `503 vcr_gateway_unavailable` 「无法确认不含小样本格子，已整体拒绝」 (`vcrService.mjs:1456-1465`).

### Q4.2 Where suppression is applied, and where it is not

- **One boundary for model reads.** `VcrService.runtimeRead`, then `forModel`, then `stripPlaneAddresses`, then `suppressForModel`, on every `vcr_read` (`vcrService.mjs:1514-1520`, `:1456-1465`). The `vcr_simulate action:status` answer, which carries the job's result, also goes through `forModel` (`OS/apps/server/src/vcrGateway.mjs:2238-2242`).
  - `stripPlaneAddresses` removes `location, inputHashes, outputHash, signature` and the private matching provenance ids at any depth (`vcrService.mjs:98-106`; `OS/apps/server/src/vcrMatching.mjs:59`).
- **Named exemptions** (published figures of *other* trials): `VCR_PUBLISHED_FIGURE_READS = evidence, precedents, trial_registry_record` (`vcrService.mjs:123`).
  - Longitudinal forecast artifacts (`vlf_*`) whose `summary.dataClass === 'synthetic'` get their summary back unsuppressed (`OS/apps/server/src/vcrLongitudinalPresentation.mjs:6-9`). This is the **only** place where "synthetic" relaxes the rule.
- **Not applied to the browser.** Study members' tab views (`vcrService.mjs:905-919`) and the virtual-patient row and record routes (`OS/apps/server/src/vcrRoutes.mjs:180`, `:794-832`) are role-gated (`read`, and `read_patient_level` for documents/originals). They are not suppressed. Suppression is strictly a *model* boundary.
- **The other wrapper.** `suppressSmallCells` (`OS/apps/server/src/vcrDataPlane.mjs:298-310`) is a legacy wrapper over the same domain rule.
- **De-facto bypass by enumeration (matching).** The study-level `matching` read hides the tallies as cells (`summaryCells`, `criterionFunnel[].cells`, `gaps[].n`; `OS/apps/server/src/vcrComposition.mjs:689-698`). Yet in the same payload it lists every subject's pseudonym with its own `summary` verdict, paged 20 at a time with `more` (`:699-702`; built from `matchStore.subjectSummaries`, `OS/apps/server/src/vcrMatchStore.mjs:433-438`).
  - These rows carry no count key, so they pass the boundary.
  - A run that pages through the roster can count "3 eligible" itself, even when `summaryCells` hid it.
  - The per-subject read (next section) is individual-level by design.
  - **Net:** for matching, the binding control on what the model sees is cloud permission plus study attribution, not small-cell suppression.

### Q4.3 What `vcr_read` returns — every action

The tool schema is `OS/runtime/mcp/evimed-research/vcr_platform.py:175-219`. The closed list `READ_WHATS` is at `:75-79` and equals `VCR_READ_WHATS` (`vcrService.mjs:69-73`). At most 50 items per read (`vcrService.mjs:66`), default 20.

The dispatch is `vcrService.mjs:1523-1680`:

| what | returns (model view) | evidence |
|---|---|---|
| `study` | study header, definition, stale marks, budget, seal state, `intendedUseCeiling` | 1526-1534 |
| `definition` | latest definition plus versions | 1535-1536 |
| `criteria` | protocol plus criteria; exclusions read back as written | 1537-1547 |
| `soa` | schedule of activities of a protocol version | 1548-1555 |
| `regulatory_contacts` | contacts page | 1559-1562 |
| `assumptions` | assumption cards | 1563-1566 |
| `evidence` | evidence pipeline read plus curve receipts (**exempt**) | 1567-1573 |
| `population` | population rows with `counts` reduced to the count band (`vcrCountBand`, `:390-399`) | 1575-1578 |
| `patients` | **patient-set metadata only**: `counts` band plus `twinLabel`; no rows | 1579-1588 |
| `comparator`, `trial` | designs and route options; scenarios, grid and forecasts | 1589-1591 |
| `results` | per result: `conclusion, counts band, measures, diagnostics, tables(meta), intendedUse, reviewState, stale` (`#resultView` `:880-894`) | 1592-1596 |
| `report_model`, `jobs`, `models`, `model_assessments` | report render root; queue; model/method library; M15 records | 1597-1608 |
| `snapshot_profile` | snapshot/source profile: structure, quality, dictionary, "never a row" (`vcrComposition.mjs:165-181`) | 1609-1618 |
| `longitudinal` | longitudinal records via `presentLongitudinal` | 1619-1620 |
| `subject_document` | no filter: subjects with document counts; `subjectKey`: that subject's documents (id, length, time; no text); `subjectKey+documentId`: **a window of up to 20 000 characters of the document's cloud projection text** | `vcrComposition.mjs:407`, `:450-480` |
| `matching` | see below | 1627-1638; `vcrComposition.mjs:605-712` |
| `pack`, `library` | disease knowledge pack; account population library | 1639-1652 |
| `candidate_trials` | registry trials found for patients (patient→trial) | 1653-1658; `vcrPatientTrials.mjs:492-529` |
| `precedents` | reference trials (**exempt**) | 1659-1665 |
| `trial_registry_record` | one registry record, structured (**exempt**) | 1666-1676 |

**Matching candidates (trial→patient) — individual-level evidence IS visible to the model:**
- **Study level** (no `subjectKey`):
  - The criteria, each with `decidedBy: model|code` and `languageKeys`.
  - Suppressed tallies and funnel cells.
  - The paged roster `{subjectKey, summary, facts}` (`vcrComposition.mjs:620-711`).
- **With `filter.subjectKey`**:
  - That subject's `assessment.judgments[]` per criterion: `state` (satisfied / not_satisfied / unknown / pending_recheck / not applicable), `applicable`, `decidedBy`, `recheckAt`, `overrideState`.
  - **`evidence:[{quote, locator}]`**, plus the subject's located `facts` (variable, value, unit, polarity, dates, surface, source) and the language criteria the run still owes (`:639-676`).
  - Never the reviewer's name or note (`:656-659`). Withdrawn subjects return `withdrawn:true` and nothing else (`:637`).
- **Filtering.** Quotes and facts are filtered through `documents.runtimeEvidence`. This keeps only entries whose `documentId` belongs to a document the cloud may read now, and whose quote is still exactly at `text.slice(start,end)` of the cloud projection (`vcrComposition.mjs:429-440`).
- **Consequence 1 — structured (subject-table) candidates arrive with no evidence at all.**
  - A table fact's citation is `quote: "age（数据表列 AGE）"`, `quoteKind:'snapshot_cell'`, `locator:{snapshotId, field}`, with no `documentId` (`OS/apps/server/src/vcrMatching.mjs:381-400`).
  - `runtimeEvidence` skips it (`vcrComposition.mjs:435 if (!id) continue;`).
  - The table evidence also hides the *value* even from members, by design (`hideValue`, `OS/apps/server/src/vcrMatchingTable.mjs:31-34`, `:137`; `vcrMatching.mjs:383-387`).
  - So for a table-sourced cohort, "per-criterion evidence" is "which column decided", not the value.
- **Consequence 2 — patient→trial carries no chart quotes.**
  - `candidate_trials` with `subjectKey` returns the ranked trials, each with `eligibility`, `counts`, `evidenceGaps` and judgments' states, but "never a quotation of the chart" (`OS/apps/server/src/vcrPatientTrials.mjs:487-489`, `:506-509`, `:521-525`).
  - The two directions are asymmetric for the model.

**Virtual patients — no row-level read exists for the model.**
- `patients` returns set metadata (`vcrService.mjs:1579-1588`). `results` returns diagnostics. There is no `vcr_read` action for the rows: neither `vcr_platform.py` nor the gateway has one, and the only row and record readers are browser routes (`OS/apps/server/src/vcrRecords.mjs:176-201`, routes `vcrRoutes.mjs:794-832`).
- **What the model can see of individuals:**
  - For **longitudinal** sets: the engine's three example people (10th, 50th and 90th slope percentile). Each carries its trajectory under the given arm *and* the other arm with the same random numbers, inside `diagnostics.examples`. Plus up to 12 individual lines per arm (`项目代码/vcr-engine/R/longitudinal.R:107-145`, `:160-165`, `:175-190`).
  - For **TTE/continuous/binary** sets: arm summaries and KM series only. There is no example person (`R/summaries.R:98-123`).
- **Suppression applies to virtual patients too.** It is keyed on names, not origin, so `events` and per-visit `{time,n,mean,sd}` cells of a *synthetic* set are suppressed below 10, exactly like real people. The only exception is the `vlf_` synthetic artifact.

### Q4.4 Data plane, seal and access judge

- **What the runtime and model never see:**
  - **No mount.** The data-plane directory is never mounted into a runtime. `assertDataPlaneLocation` refuses any path outside `config.vcrDataPlaneDir`, under a workspace, or with a `knowledge-base` segment (`vcrDataPlane.mjs:10-20`).
  - **No rows.** The model never gets a row. Only the control plane builds engine inputs (`:41-48`).
  - **No real identifiers.** The model never sees a source id. Subjects are `USUBJID = P + HMAC(study secret, source id)`, different per study (`:49-54`).
  - **No direct-identifier fields.** These are refused even under a grant (`OS/apps/server/src/vcrAccess.mjs:28-33`, code `vcr_field_identifying`).
- **The gateway pins the study through the project.**
  - The runtime token names user and project, and the project names the study: `studyByControlProject` (`vcrGateway.mjs:2149`).
  - In a project with no study, the gateway answers **`404 vcr_no_study`** 「open the study's own conversation」 (`:2150-2153`). The MCP side turns that into a soft "no study in this conversation" answer (`vcr_platform.py:547-557`).
- **Patient-evidence reads need a study run.** `subject_document` and `matching` reads, and `fact`/`language_judgment` writes, also need a run attributed to the study's project ledger. Otherwise the gateway answers **`403 vcr_cloud_run_unattributed`** 「Start a study conversation before reading patient evidence」 (`vcrGateway.mjs:2157-2161`; resolver `OS/apps/server/src/server.mjs:5524-5530`).
- **Cloud basis.** Patient text may reach the model providers under the deployment's agreements. This is on by default: `OPEN_SCIENCE_VCR_PROVIDER_AGREEMENTS` defaults to `true` (`config.mjs:1043`; `OS/apps/server/src/vcrCloudProjection.mjs:1-8`, `:52-66`). An operator may revoke a source. A cached conversation that read a since-revoked or deleted source is refused at the next model call (`OS/apps/server/src/vcrCloudEgress.mjs:16-38`).
- **Seal.**
  - Outcome columns are sealed only under the intended uses `specified_analysis` and `submission_preparation` (`OS/apps/server/src/vcrSeal.mjs:69-70`).
  - Under exploratory use nothing is sealed (`:14-18`, `:76`).
  - The seal lifts as of the plan-freeze instant (`:44-49`).
  - "Sealed beats everything": the field is refused to the lead, the engine and the run, with no imputation (`vcrAccess.mjs:23-27`, code `vcr_field_sealed`).
- **Per-operation judge.** Inputs are study × role × source × field × window × purpose. It is default-deny with named codes, and writes one audit row per judgment (`vcrAccess.mjs:1-56`, `:63-77`).
  - Roles and abilities are listed in `OS/packages/domain/src/vcrVocabulary.mjs:557-571`.
  - **Recruitment is baked into roles:** `recruiter` (`write_referrals`, `contact_patients`) and `site` (`read_referrals`, `write_referrals`), plus the `lead` ability `contact_patients`. Deleting recruitment touches this vocabulary and its CHECK constraints.
- **Runtime calls run as the owner.** Every runtime read is judged for `study.userId` (the owner/lead), not for a member, e.g. `principal: study.userId` (`vcrComposition.mjs:176-178`, `:416`, `:422`). A conversation therefore reads with lead rights.

### Q4.5 Implications for the reset plan

1. **One matching candidate can be discussed in an AI conversation today, but only in the study's own project conversation.** The model gets per-criterion states plus verbatim quotes with locators plus the facts, and can open a 20 000-character window of the chart (`vcrComposition.mjs:639-676`, `:450-472`). In an ordinary project it gets `vcr_no_study`, or `vcr_cloud_run_unattributed` for patient evidence (`vcrGateway.mjs:2150-2161`). **The gate is the study↔project binding, not suppression.** An "AI-conversation entry" outside a study needs either an implicit study per conversation or a change of `studyByControlProject`.
2. **"Candidate list with per-criterion evidence" is uneven across sources and directions.**
   - Trial→patient: document candidates have quotes; table candidates have no model-visible evidence and no visible values (`vcrComposition.mjs:435`; `vcrMatching.mjs:383-387`).
   - Patient→trial: states only, with no quotes (`vcrPatientTrials.mjs:487-489`).
   - The plan has to decide whether structured-cell values may be shown. Today they are hidden even from members by design (`vcrMatchingTable.mjs:31-34`).
3. **Suppression does not stand in the way of a candidate *list*.** The roster is already enumerated per subject (`vcrComposition.mjs:699-702`). But it makes the aggregate panels (`summaryCells`, funnel) inconsistent with the list the model can page through. Pick one stance: either document that matching is individual-level by consent and cloud permission, or stop enumerating. Do not leave both.
4. **The individual view of virtual patients is browser-only.**
   - The model cannot read a virtual patient's row or record. It can discuss only the three longitudinal "example" people the engine chose (`R/longitudinal.R:175-190`).
   - A conversational "individual view" needs a new model-facing read of synthetic rows. That is allowed by policy: synthetic rows already leave to the browser (`vcrRecords.mjs:9-14`).
   - It should also exempt `source: synthetic` from the people-count rule the way `vlf_` artifacts already are (`vcrLongitudinalPresentation.mjs:8-9`). Otherwise small synthetic subgroups, such as one person's arm in a filtered view, are nulled for no privacy reason.
5. **Recruitment words live in the suppression vocabulary** (`referred`, `contacted`, `enrolled`, `screened`, `candidates`; `vcrVocabulary.mjs:1004-1007`). They are harmless to keep after deletion, but they are recruitment residue.

## Q7 — Verification of prior-review claims

| # | Claim | Verdict |
|---|---|---|
| 1 | single-patient read = first visit only, trajectory null | **Confirmed** (and worse: the list and arm counts are person-visits) |
| 2 | virtual patient ids include the job id; no cross-scenario identity; CRN? | **Confirmed**; no CRN across scenarios (or across grid cells) |
| 3 | MatchingTab empty state hides the toolbar | **Confirmed** |
| 4 | PatientsTab forecast entry disappears with no records | **Confirmed** (the records are *longitudinal* records) |
| 5 | study_specific follow-up refuses restricted fields for every source | **Confirmed** (keyed on `kind`; the write has no source at all) |
| 6 | in-study method links go to /app/capabilities/methods and highlight 科研工具 | **Confirmed** |
| 7 | auto-referral covers only document candidates | **Confirmed**, with a precise reading below |

### 1. Single-patient read: first visit only, trajectory null — Confirmed

- `patientRecord` looks the patient up with `table.rows.find(candidate => candidate[idColumn.index] === patientId)`. That returns the **first** matching row only (`OS/apps/server/src/vcrRows.mjs:406`).
- A longitudinal set is one row per person per visit, sorted by patient then visit (`项目代码/vcr-engine/R/longitudinal.R:244-251`). So the drawer shows visit 1.
- `position` is computed only when the table has **no** `visit` column (`vcrRows.mjs:435`, `:445`). For a longitudinal set it is `null`.
- `trajectories` is filled only when the table has paired potential-outcome columns `y0/y1`, `time0/time1` or `status0/1` (`:457-468`). **No engine method writes such columns.**
  - The simulators return `arm,x,y` or `arm,time,status,entry` (`R/simulators.R:74`, `:133`, `:286`).
  - The longitudinal table writes only `patientId, arm, [pop cols], visit, time, y`; `y_other` is never written (`R/longitudinal.R:248-251`).
  - So `trajectories` is effectively always `null`, for every patient-set kind.
- The route uses `patientRecord` only for a cached table (`OS/apps/server/src/vcrRecords.mjs:199`). A streamed (large) table returns `vcr_patient_not_found`.
- **Extra:** for a longitudinal set the patient list pages *rows*, and `arms[].n` counts rows (`vcrRows.mjs:283-299`). So 「患者 N」 is person-visits, not persons.
- The only per-person trajectories that exist are the engine's three `diagnostics.examples`, each under both arms with the same random numbers (`R/longitudinal.R:117-145`, `:175-190`). They live in the result diagnostics and are not reachable from the row record.
- **Plan impact:** "fix single-patient trajectory" is real work.
  - Group the rows by `patientId` into a series.
  - Have the engine write the counterfactual arm (`y_other`, or y0/y1) if "the same person under the other arm" is wanted per patient, not just for the three examples.
  - Fix the person count.

### 2. Virtual patient ids include the job id; no cross-scenario identity; CRN? — Confirmed, no CRN across scenarios

- **Ids depend on the job.** `ids <- substr(vcr_sha256(paste(job$seed, job$jobId, i, sep=":")), 1, 12)`, then `patientId = "vp_"+id` (`R/engine.R:820-821`). The same holds for longitudinal (`R/longitudinal.R:242`). A new job is a new id set, even with the same seed and the same population.
- **No common random numbers across scenarios:**
  - **Seed per scenario.** With no seed named, the seed is the first 31 bits of the scenario hash: `vcrSeedFor(scenarioHash)` (`OS/apps/server/src/vcrJobs.mjs:53-56`, `:232-240`, `:659`). Two scenarios that differ in any parameter get different seeds, so they draw different random numbers.
  - **Grid cells too.** Each design-grid cell gets `cell_seed = seed + k*7919`, "so adding a cell never changes another cell's numbers" (`R/design_simulate.R:741-743`). The cells are independent, not CRN.
  - **Search.** Searching for "common random" finds nothing in the R engine or the server.
- **The only CRN that exists is within one job.** The longitudinal generator keeps the person's random effects and draws, and computes `y_other` for the other arm: "同一个人，随机数相同，只有分组不同" (`R/longitudinal.R:73`, `:137`).
- **Plan impact:** "scenario comparison" of the *same* virtual patients needs both of these:
  - (a) a scenario-independent person identity, such as an id derived from population member and seed, not from the jobId;
  - (b) a shared seed / substream per person across scenario jobs. The job API already accepts an explicit `seed`, so (b) is a server-side default plus the R draw order.
  
  Today a cross-scenario per-person comparison is impossible.

### 3. MatchingTab: the empty state hides the toolbar — Confirmed

- `asOpened` is true in the default state: view `matching`, direction `trial_to_patient`, no protocol, no candidate. `bare` adds `emptyPage(data)` (`OS/apps/web/src/components/vcr/tabs/MatchingTab.tsx:171-172`).
- `useVcrToolbar(shown?.available === false || bare ? null : {…filters…})` (`:174-180`). So the band drops:
  - the view chips 匹配/转诊/中心/随访 (`:60-65`);
  - the direction chip 给试验找患者/给患者找试验 (`:67-70`, `:156-158`).
- `emptyPage` requires no candidates, forecast, pending review, ledger, sites, follow-up, timeline or comparison (`:263-268`). On that page the tab shows only `MatchingStart` or `VcrStepPending` (`:219-224`).
- **Plan impact:** on a fresh study, 给患者找试验 cannot be reached from this tab. The patient→trial direction must be an entry of its own, a conversation goal or an always-visible control, not a state the user can reach only after trial→patient produced something.

### 4. PatientsTab: the forecast entry disappears when there are no records — Confirmed

- The 预测验证 switch exists only if `hasLongitudinal(longitudinal.state.data)` (`OS/apps/web/src/components/vcr/tabs/PatientsTab.tsx:78-89`). That is `records.length > 0 || related.length > 0` (`OS/apps/web/src/components/vcr/VcrLongitudinalPanel.tsx:38-40`).
- The import and template actions live inside that panel's own toolbar 「⋯」 (`VcrLongitudinalPanel.tsx:46-49`). With no longitudinal record, the study page offers no browser path to start one. The only paths are the conversation (`vcr_write history`, `vcr_simulate`) or the method workbench (`OS/apps/web/src/components/vcr/VcrMethodRunner.tsx` references longitudinal).
- The "records" in the claim are follow-up history and prediction records, not virtual-patient rows.
- **Plan impact:** follow-up data is meant to stay as research input, but it has no first-run entry in the patients workspace. Deleting the calculator catalogue removes one of its two remaining entries. Give the follow-up/longitudinal import an empty-state entry, or a conversation recipe.

### 5. The study_specific follow-up write refuses restricted fields for every source — Confirmed

- In `vcr_write what:"followup"`:
  - The item takes only `subjectKey, kind, windowStart, windowEnd, observations, exitDate, exitReason`. **There is no source or partner field** (`OS/apps/server/src/vcrGateway.mjs:1658-1659`).
  - The refusal is `kind === "study_specific" && VCR_TRIAL_RESTRICTED_FIELDS.includes(row.variable)`, answered with `vcr_exit_field_not_derivable` (`:1671-1675`).
  - `VCR_TRIAL_RESTRICTED_FIELDS = treatment, outcome, randomization_arm, progression_date, last_dose_date` (`OS/apps/server/src/vcrRecruit.mjs:684`).
- `study_specific` also *requires* `exitDate` and `exitReason` (`vcrGateway.mjs:1677`). `trialPeriodEpisode` marks all five fields `restricted_in_trial` for every such episode (`vcrRecruit.mjs:701-714`).
- So `study_specific` (labelled 「研究专属随访」, `OS/packages/domain/src/vcrVocabulary.mjs:762-763`) is hard-wired to "a partner's patient inside somebody else's trial". A study's own protocol follow-up cannot record treatment or outcome under that kind. Only `routine_care` / `post_exit` can (`vcrGateway.mjs:1688-1690`).
- **Extra:**
  - There is **no browser write route** for follow-up; `vcrRoutes.mjs` has no follow-up route.
  - **Episodes feed nothing.** `listFollowupEpisodes` is read only by the matching tab bundle (`OS/apps/server/src/vcrService.mjs:1164`) and rendered in the matching tab's 随访 view (`OS/apps/server/src/vcrViewsTabs.mjs:1302-1305`). No cohort, longitudinal or engine input reads `followup_episodes`.
- **Plan impact:** "follow-up DATA stays as research input" is not true today: it is display-only, under the recruitment tab. To keep it, the plan has to:
  - move it out of the matching/recruitment surface;
  - give `study_specific` a source attribute (restricted partner vs own study);
  - connect episodes to the longitudinal/cohort inputs.

### 6. In-study method links route to /app/capabilities/methods and highlight 科研工具 — Confirmed

- `VcrStudyMethods` opens `navigate(`${vcrMethodPath(methodEntryId(method), { studyId })}&view=${tab}`)` (`OS/apps/web/src/components/vcr/VcrStudyMethods.tsx:22-30`). `vcrMethodPath` builds `/app/capabilities/methods/<id>?study=…` (`OS/apps/web/src/lib/vcrMethodLocation.ts:3-9`; route `OS/apps/web/src/app/router.tsx:152`).
- In `Sidebar.isCurrent`, the 虚拟临床研究 row is current only for `/app/virtual-research*` or a chat in a VCR project. Every other row is `pathname.startsWith(to)`, so `/app/capabilities` (科研工具, `OS/apps/web/src/components/sidebar/Sidebar.tsx:63`) lights up (`:106-113`).
- The same route is used by `VcrUseMethodInStudy.tsx:43`, `:48`, by the calculation space (`OS/apps/web/src/app/routes/VcrCalculationWorkbenchPage.tsx:34`, `:36`; `OS/apps/web/src/app/router.tsx:153`) and by the 科研工具 catalogue (`OS/apps/web/src/app/routes/CapabilitiesPage.tsx:185`).
- **Plan impact:** removing the calculator catalogue is more than one page. It also covers:
  - the method workbench route and page;
  - the calculation-space container, `study.purpose === "calculation"` (`OS/apps/web/src/app/virtual-research/VcrStudyPage.tsx:137`, `:256`; `VcrHomePage.tsx:248`; `OS/apps/web/src/components/sidebar/ProjectBrowser.tsx:835`);
  - the in-study `VcrStudyMethods` and `VcrUseMethodInStudy` entries;
  - the 科研工具 method list.

### 7. Auto-referral covers only document candidates — Confirmed (precise reading)

- The `match_criteria` finish hook persists every assessment (`OS/apps/server/src/vcrComposition.mjs:800-825`). It then creates referrals only for `ledgerBound`: current protocol version, and **not `tableOnly`** (`:831`, `:840-853`).
- `tableOnly` is the subjects that exist only as rows of the subject table, with no document-located fact and no language judgment (`:293-297`, tagged `source:"subject_table"` at `:338`).
- So a subject with ≥1 document-derived fact or language judgment is referred, whether or not they also have a table row. A table-only subject is assessed and counted but never referred.
- Referrals are made for `eligible` (state `candidate`) and for `pending`/`insufficient_evidence` (state `needs_evidence`) (`OS/apps/server/src/vcrRecruit.mjs:232-242`). Then coordinators are notified: `notifier.newCandidates` (`vcrComposition.mjs:857-859`).
- **Plan impact:** the "matching completes → auto-referral / notify coordinator" side effect is this hook plus the notifier, so removing it is a small, local change.
  - **But** `candidateReferrals()` also *derives the candidate list* the matching tab shows (`vcrComposition.mjs:579`). Keep that eligible/pending/insufficient_evidence filter, renamed out of `vcrRecruit.mjs`, when the ledger goes.
  - The recheck loop (`recheckDue`, `:871-891`) re-evaluates deferred subjects. It is matching, not recruitment, and should stay.


_(Q4 and Q7 were drafted by a review fork. I re-read the decisive lines for claims 1, 2, 5 and 7, and for the Q4 points about the roster, the patients read and the seed:_
- _`vcrRows.mjs:406,435,445,457-468`;_
- _`R/engine.R:820`, plus no `y0/y1/time0` column written by any R file;_
- _`vcrGateway.mjs:1658-1677`;_
- _`vcrComposition.mjs:293-297,699-702,831-859`;_
- _`vcrService.mjs:1579-1588`;_
- _`vcrJobs.mjs:232-240`;_
- _`vcrPatientTrials.mjs:485-490`.)_

---



## Q5 — Programme and required inputs

### 5.1 The seven steps, their order and dependencies

- The list is `VCR_STEPS = ['definition','evidence','population','patients','comparator','trial','matching']` (`OS/packages/domain/src/vcrVocabulary.mjs:435`). Labels 定义/证据/人群/患者/对照/试验/匹配 (`:436-438`). Statuses `none|queued|running|done|minimal|stale|failed` (`:440`).
- Dependencies (`VCR_STEP_NEEDS`, `vcrVocabulary.mjs:445-453`): `definition` needs nothing; `evidence`, `population`, `comparator`, `trial`, `matching` each need only `definition`; `patients` needs `population`. So the DAG is shallow: **matching does not depend on evidence, population, comparator or trial; it depends only on the definition.**
- Step → capability (`VCR_STEP_CAPABILITIES`, `vcrVocabulary.mjs:868-876`): definition → `vcr-protocol`; evidence → `vcr-evidence`; population, patients, comparator, trial → `vcr-analysis` (one run covers all four, `VCR_ANALYSIS_STEPS`, `OS/apps/server/src/vcrOrchestrator.mjs:98`, `#analysisRun` `:3279-3315`); matching → `vcr-matching`. Exports go to `vcr-package` (`vcrOrchestrator.mjs:3196-3207`).
- Which steps are code-only: none of the seven is code-only as a *step* (each has a capability run), but the *numbers* of population/patients/comparator/trial are produced only by engine jobs the platform enqueues from the objects a run wrote (`#enqueueWork` `vcrOrchestrator.mjs:2502-2518`, `vcrBuildStages` `:1088`). Matching's verdicts are code (`match_criteria` job, `vcrComposition.mjs:713-786`). Exports' tables/numbers are platform-written (`VCR_EXPORT_OUTLINES`, `vcrOrchestrator.mjs:232-245`).
- Step completion is read from stored data, never from a run's report (`#observe`, `vcrOrchestrator.mjs:2414-2490`):
  - definition done = a `study_definitions` row exists (`:2472`);
  - evidence done = some card is the evidence step's own product (`vcrEvidenceProduct`, `:444-449`: `sourceKind external_evidence` with evidence ids, or an `expert_set` widened from evidence);
  - the four analysis steps are done when every object has an engine result (`aggregate`, `:2426-2464`);
  - **matching done = criteria exist on the latest protocol version AND (study is T0 OR at least one assessment against that version exists)** (`:2477-2479`). At T0 "matching" means "criteria structured".
- Dispatch order and concurrency: one run per study at a time (`#nextRun` returns if any run mark is claimed/running, `vcrOrchestrator.mjs:3129-3131`). Candidates in order (`:3137-3147`): review repair → export → **trial search (给患者找试验)** → evidence refresh → definition → then, only if a definition exists, evidence → analysis (4 steps) → **matching last**. Under the default full programme, a matching run therefore waits behind the evidence and analysis runs of the same study.
- Default programme size: a study created with a question and no action card requests **all seven** (`vcrRequestedSteps` returns `VCR_STEPS` unless the action is one of definition/cohort/patients/comparator/trial — there is no matching card; `OS/apps/server/src/vcrService.mjs:355-369`, used at `:640-642`). And a study where nobody requested anything but a definition exists gets all seven requested by backfill (`vcrProgramSteps`, `vcrOrchestrator.mjs:376-385`, the line is `:383`). The conversation analyst's own SKILL says so: "这一步做完，平台才会按流程接着做研究者没要的步骤（后台运行）" (`OS/capabilities/vcr-protocol/SKILL.md:8`). The draft path avoids the backfill by holding `definition` (`vcrService.mjs:645`). `purpose: "calculation"` studies (the calculator workbench's) request nothing (`vcrService.mjs:366`, `vcrOrchestrator.mjs:383`).
- Retry rule: two attempts per run key, a stalled claim retried after 10 min (`VCR_RUN_RULES`, `vcrOrchestrator.mjs:125`).

### 5.2 Next-action machinery

- `vcrNext` (`OS/packages/domain/src/vcrNext.mjs:38-57`) is a pure function: the first step in `VCR_STEPS` order whose own status is open (`none|failed|stale`) and whose `VCR_STEP_NEEDS` are all `done|minimal`; returns `{step,label,reason:start|retry|refresh}`; returns null if the study is not "described" (no question and no definition). Read by the study page as `next` (`OS/apps/server/src/vcrViews.mjs:676`), computed only for `purpose !== "calculation"`.
- `stepSummaries` (`OS/apps/server/src/vcrStudyStatus.mjs:240-279`): one short note per step from stored rows ("v2", "N 张假设卡", "N 名", "N 条可估计", a power/assurance range, "N 条入排标准"). `activity` (`buildVcrActivity`, `vcrStudyStatus.mjs:186-207`): the run out, queued steps and what each waits for, open jobs, the last thing that ended.
- What gates a step (hard, in code):
  - `runStep` refuses a draft study and a study with neither a question nor a definition: 409 `vcr_definition_missing` (`vcrOrchestrator.mjs:1972`, `:1978-1980`); a paused study: 409 `vcr_study_paused` (`:1973`).
  - `#nextRun` sends no evidence/analysis/matching run until a definition row exists (`vcrOrchestrator.mjs:3135-3147`); the definition run itself waits for a question (`#stepRun` `:3247-3256`).
  - The definition writer requires only that `pico` or `estimand` state *something* (population/intervention, or one estimand attribute); **endpointType is optional** (`OS/apps/server/src/vcrGateway.mjs:747-770`, check at `:761-763`).
  - Seal: outcome columns are sealed until the analysis plan freezes, but only for intended uses `specified_analysis` and `submission_preparation`; exploratory studies are never sealed and nothing is blocked (`OS/apps/server/src/vcrSeal.mjs:14-18`, `VCR_SEALED_USES` `:69`).
  - Data tier gates routes: real cohort/matching from data need a frozen snapshot ("T1 … 做患者匹配与招募", `vcrVocabulary.mjs:354-360`); a patient-level job with no snapshot grant is `skipped: no_snapshot`, not failed (`vcrOrchestrator.mjs:2683-2690`); comparator routes below their tier answer `data_tier_insufficient` (`routeVerdict` `:751-764`).
- Route reasons: a step run's reason is `vcr:<step>` (`#stepRun` `vcrOrchestrator.mjs:3265`; the analysis run uses `vcr:<first scoped step>` `:3302`); others are `vcr:export-<kind>`, `vcr:review-repair`, `vcr:trial-search`, `vcr:evidence-refresh` (`:3190-3240`). `dispatchVcrRun` (`OS/apps/server/src/server.mjs:5776-5867`) runs it `automated: true` in a bounded runtime with a hidden session bound to the step's capability, or in the open runtime when a person asked (`attended`). With `OPEN_SCIENCE_VCR_STEPS_IN_STUDY_SESSION` (default **false**, `OS/apps/server/src/config.mjs:1077`) and the researcher's runtime open, the step becomes a turn of the study's own conversation with the reason rewritten by `conversationTurnRouteReason(reason)` and `routedOverBinding: true` (`server.mjs:5809-5832`).

### 5.3 The five capabilities

All five are `display.listed: false` (entered only from the module) — `vcr-protocol/capability.yaml:102`, `vcr-evidence:113` (also `visibility: public` at `:17`), `vcr-analysis:119`, `vcr-matching:98`, `vcr-package:90`.

| Capability | Role | Tools declared (all `mcp__evimed__*`) | Contract |
|---|---|---|---|
| `vcr-protocol` 1.3.4, `safetyClass: general` | **The analyst of the study's own conversation** (every study conversation is bound to it, `capability.yaml:3-15`; `vcrService.mjs:647` binds the session to `VCR_STEP_CAPABILITIES.definition`). Does whatever step is asked in the conversation: writes the object, queues the engine job, reads the result back; fills a minimal "AI 设定" definition itself and asks only when it cannot tell who/what is studied (`capability.yaml:31-38`, `SKILL.md:8`, `:16-24`, `:101`). Answer-mode: files optional (`capability.yaml:16-18`, `:58-71`). | vcr_read, vcr_write, vcr_simulate, evidence_pool, trial_registry_record, clinical_trial_search, literature_search, guideline_search, open_access_full_text, locate_quote, term_normalize, kb_search, kb_browse, web_read (`:43-57`). **No `curve_digitize`, no `dataset_semantics`.** | `vcr-study-package`, all outputs optional |
| `vcr-evidence` 1.3.0 | Precedents → quote-checked extraction → engine pooling → assumption cards (6 steps, `SKILL.md:28-188`). Says plainly "只有登记记录里的数能进假设卡 … 论文正文和图表里读到的数核对不了，不进假设卡" (`SKILL.md:102-103`). | vcr_read/write/simulate, evidence_pool, trial_registry_record, curve_digitize, clinical_trial_search, literature_search, open_access_full_text, locate_quote, guideline_search, kb_search, kb_browse, frontier_search, term_normalize, evidence_deduplicate, web_read (`:39-56`) | `vcr-study-package` |
| `vcr-analysis` 1.4.0 | Population, virtual patients, comparator, trial: "我按数据档位选路…交给确定性引擎算"; "我不写研究定义，也不做患者匹配与招募" (`capability.yaml:21`). SKILL: read definition first because "终点类型…决定所有方法分支" (`SKILL.md:16-19`); cards bind into scenarios by key (`:286-288`); a null-effect scenario is mandatory for trial designs (`:251`). | vcr_read/write/simulate, evidence_pool, trial_registry_record, curve_digitize, literature_search, clinical_trial_search, open_access_full_text, locate_quote, kb_search, kb_browse, term_normalize, web_read (`:31-45`) | three products: `vcr-cohort-snapshot`, `vcr-comparator-analysis`, `vcr-simulation-report` (`:57-83`); a run is held only to the products of its steps (`VCR_STEP_PRODUCTS` `vcrVocabulary.mjs:887-893`, `vcrProductsOfSteps` `vcrOrchestrator.mjs:110-113`) |
| `vcr-matching` 1.2.0, `safetyClass: clinical` | Two-way matching: structure criteria (closed grammar), write quote-anchored facts from patient documents, answer language-only criteria, then `match_criteria` computes 4-state verdicts (`SKILL.md:14-25`, `:27-107`). Also "给患者找试验" (`SKILL.md:165-185`). **Also recruitment**: sites, follow-up, `accrual_forecast` (`SKILL.md:122-143`), recruitment drafts (`:115`), "协调员逐人确认" (`:152-155`), and "作业成功后，平台自己完成三件事：保存每位受试者的评估、把「候选」建成转介记录（状态 candidate）、通知协调员" (`SKILL.md:102`). Title "Matching and Recruitment" / 「匹配与招募」 (`capability.yaml:17`, `:95`); outputs include `recruitment-drafts.md` (`:59-61`). | dataset_semantics, vcr_read/write/simulate, locate_quote, clinical_trial_search, trial_registry_record, term_normalize, kb_search, kb_browse, literature_search (`:35-46`). **No `web_read`.** | `vcr-matching-assessment` (`matching-assessment.md`, `matching.json` required; `:47-64`) |
| `vcr-package` 1.1.2 | Writes the study package / CDE communication pack / model analysis plan & report prose; "我不重新计算任何数" (`capability.yaml:24`). | vcr_read, vcr_write, locate_quote, kb_search, kb_browse, literature_search, open_access_full_text (`:35-42`) | `vcr-study-package` |

Byte copies of the SKILL bodies exist under `OS/capability-skills/vcr-*` and `OS/runtime/skills/evimed/vcr-*` (listing). The tab label is 「匹配与招募」 (`VCR_TAB_LABELS_ZH`, `vcrVocabulary.mjs:459`).

### 5.4 Does matching / cohort / virtual patients require a protocol, an endpoint or an effect assumption first?

Hard enforcement in code, by task:

- **Protocol → patients matching** needs (a) a definition row before the *programme* will dispatch the matching run (`vcrOrchestrator.mjs:3135-3147`) and before the page offers the step (`VCR_STEP_NEEDS.matching = ['definition']`, `vcrVocabulary.mjs:452`; web empty state `if (!hasDefinition(study)) return <VcrNoDefinition…>` at `OS/apps/web/src/components/vcr/VcrStates.tsx:187`); and (b) **criteria on a protocol version** for the engine job: `matchScenario` returns "还没有入排条件：先在方案步骤里写入排条件，再评估。" (`OS/apps/server/src/vcrComposition.mjs:729-732`), the gateway turns that into 400 (`vcrGateway.mjs:2356-2357`). It does **not** need an endpoint, an effect, assumption cards, a frozen analysis plan or a population. The "protocol" can be just the criteria list (`what: "criteria"`/`"protocol"` writes one version, `vcrGateway.mjs:617-654`). Subjects come from study documents or a frozen subject table (`vcrComposition.mjs:733-750`). Within the study conversation (vcr-protocol), the gateway call itself only needs the study to exist for the runtime's project — it does not re-check `definition` (`vcrGateway.mjs:2149-2153`).
- **Patient → trials (给患者找试验)** needs an *active* study: `requestTrialSearch` refuses anything but `status === "active"` (`vcrOrchestrator.mjs:2065-2069`) — a draft (undescribed) study is "paused" for it. It does not need a protocol, endpoint or definition row; it does need the patient to exist in the study (`subjectKey` must be held, else warning `vcr_subject_not_found`, `vcrGateway.mjs:1004-1015`) and a registry record (below, Q9). Its run is dispatched ahead of the programme runs (`vcrOrchestrator.mjs:3140`).
- **Cohort (population step)**: no endpoint, no cards (`bindAll: false`, `vcrOrchestrator.mjs:1187-1193`). A *real* cohort needs a frozen snapshot and rules (`vcrGateway.mjs:2386-2388` for the runtime `build_cohort`; `fromProtocol` makes rules from the protocol's criteria, `vcrGateway.mjs:1094-1131`), i.e. data tier ≥ T1. A *scenario* or *literature* population needs only its own `definition` (variables/baseline table).
- **Virtual patients** need an **endpoint type** — from the patient set's scenario or the definition — else the plan is refused with `vcr_scenario_endpoint_missing` (no job is queued) "虚拟患者集要知道终点类型：先写研究定义，或在场景里写 endpoint.type" (`vcrOrchestrator.mjs:1197-1199`). They bind assumption cards by key (effect, control median, SD…) unless the longitudinal generator is used (`:1236-1237`); an effect can also be typed into the scenario's `truth`. A population is optional ("先有人群更好", `OS/capabilities/vcr-protocol/SKILL.md:33`); if named and not yet computed the step waits (`vcrOrchestrator.mjs:1228-1232`).
- **Trial designs** need `endpointType` on the object (required field, `vcrGateway.mjs:1217-1221`); assurance needs an effect card whose distribution is a *prediction* distribution (`vcrDesignPriorFrom` `vcrOrchestrator.mjs:699-714`, refusal of confidence basis at `:703`).
- **Comparators** need an endpoint for weighted-Cox/AIPW/covariate-set/robustness routes (`vcr_scenario_endpoint_missing`, `vcrOrchestrator.mjs:856-881`, `:928-931`) and the data tier per route (`routeVerdict`, `:751-764`).

- **Web gates (matching tab).** 「开始评估」 is drawn only when protocol versions *and* a candidate roster exist (`evaluable = canRun && protocols.length > 0 && candidateRoster.length > 0`, `OS/apps/web/src/components/vcr/tabs/MatchingTab.tsx:219-225`); otherwise the step pane is drawn, which shows the 'no definition' state when there is no definition (`OS/apps/web/src/components/vcr/VcrStates.tsx:187`). The patient→trial page is drawn only when the server sends `patientTrials` (`MatchingTab.tsx:194-216`).

SKILL guidance (soft): the conversation analyst is told to write a minimal definition itself and not to ask for confirmation (`OS/capabilities/vcr-protocol/SKILL.md:16-24`, `:101`); `vcr-analysis` is told to read the definition first because the endpoint type decides every method branch (`OS/capabilities/vcr-analysis/SKILL.md:16-19`). The definition card asks for PICO and **all five ICH E9(R1) estimand attributes, with an intercurrent-event strategy "必须写"** (`vcr-protocol/SKILL.md:96`) — that is SKILL text, not a code check (the writer accepts any non-empty pico or estimand, `vcrGateway.mjs:761`).

Net for the plan: phase-1 matching and cohort do **not** need a protocol-with-endpoint or an effect assumption in code; what they need is (i) a definition row (soft-filled by the AI, but a hard dispatch/UX gate) — which a "goal-first" conversation can satisfy with a 1-line PICO — and (ii) criteria (matching) or a frozen snapshot (real cohort). Virtual patients are the one phase-1 object that hard-needs an endpoint type. The real friction is elsewhere: the default "all seven" programme (5.1) and the matching run being dispatched last behind evidence and analysis runs.

## Q8 — Evidence parameterization

**Verdict: implemented end to end for trial-registry records; not implemented for journal literature.** Every stage of "precedent → quote-anchored extraction → engine pooling → assumption card with a prediction interval → bound into design simulation, with lineage" exists in code. The anchor, however, is only ever a *registry record's preserved text*; a number read from a paper cannot become a card.

### 8.1 The pipeline as built

1. **Precedents.** `findPrecedents` searches ClinicalTrials.gov v2, then ChiCTR (list only) and EU CTIS in parallel; similarity ranks and decides nothing (`OS/apps/server/src/vcrEvidence.mjs:1212-1287`; header `:1-100`). A run adds one with `vcr_write what:"precedent"` (registry ∈ `clinicaltrials.gov|chictr|ctis`, `OS/apps/server/src/vcrGateway.mjs:919-953`).
2. **Extraction with quote anchors.** `extractPrecedent` fetches the record, stores the *reduced* record text and its sha256 (`precedents.record_text/record_hash`, `OS/apps/server/src/vcrPersistence.mjs:276-301`; history in `precedent_versions` `:303-315`), and verifies each platform-extracted value with `verifyExtraction` before storing (`vcrEvidence.mjs:1388-1449`). A run's own extra value (`what:"evidence_item"`) must cite a precedent the study already holds (`vcr_precedent_not_in_study`, `vcrEvidence.mjs:1451-1458`) and its quote must be verbatim in that preserved text **and contain every number** (value, CI bounds, n, events) — `quoteIsPresent` + `numberIsInQuote` (`vcrEvidence.mjs:20-60` header, `:263`, `:317`; gateway `vcrGateway.mjs:1026-1077`). A failing value is stored as unverified and "永远进不了假设卡" (`OS/capabilities/vcr-evidence/SKILL.md:19-21`). An evidence card page as a source is refused (`vcr_evidence_source_is_card`, `vcrGateway.mjs:1059`).
3. **Pooling in the engine.** `poolParameter` (`vcrEvidence.mjs:1527`) queues `evidence.pool` jobs per calibre (closest / overall / next_closest) over the latest verified rows with the same `endpointKey` and arm role (`poolEligibility` `:499`, `poolJob` `:679`); the runtime entry is `evidence_pool` / `vcr_simulate kind pool_evidence` (`vcrGateway.mjs:2303-2337`). The R side is `项目代码/vcr-engine/R/evidence_pool.R` (DL / REML / HKSJ / fixed / single study; Higgins–Thompson–Spiegelhalter PI with k−2 df, NA below three studies; "metafor is the cross-check … not the implementation", `evidence_pool.R:5-26`).
4. **Assumption card.** `assumptionFromPooling` (`vcrEvidence.mjs:895-977`): default calibre by a fixed rule (`chooseCalibre` `:862-885`, I² ≥ 0.5 or closest outside the overall PI), distribution re-parameterised **from the prediction interval** (Beta for proportions, lognormal for times/ratios, normal otherwise — `distributionFromPooled` `:805-855`), other calibres as sensitivity, CI kept separately as `pooling.confidenceInterval`. With no PI (k < 3) no card is made (`:901`); the gateway then writes a widened expert setting (half-width ×2 on the quantity's own scale: log for times and ratios, logit for proportions), labelled 「专家设定·待补证」 (`expertSetCard` `:979-1033`; `EXPERT_WIDEN_FACTOR` `:111`; gateway note at `vcrGateway.mjs:829`). A single verified value may be taken directly (`sourceKind: external_evidence`, one evidence id, arm role checked, range = the CI marked `kind: "confidence"`, "没有预测区间", `vcrGateway.mjs:866-898`, the note at `:894`). A model may still write its own number as `expert_set`/`scenario`, labelled `valueSource: assumed`, citing nothing (`vcrGateway.mjs:900-917`). A person's edit through the page route of an `external_evidence` card must cite verified evidence too (`OS/apps/server/src/vcrRoutes.mjs:1388-1392`).
5. **Use in designs.** Cards bind into a scenario by **key name**, closed table, point value only: `hazard_ratio*`→`truth.hazardRatio`, `control_median*`→`truth.controlMedian` (unit-converted), `dropout_rate*`→`accrual.dropoutAnnual`, control/treatment rates, risk difference, odds ratio, mean difference, SD (`VCR_ASSUMPTION_BINDINGS` `OS/apps/server/src/vcrOrchestrator.mjs:617-627`; `vcrBindAssumptions` `:661-682`). The card overrides what the object typed for the same parameter ("方案里同一参数写了数，也以卡为准", `OS/capabilities/vcr-analysis/SKILL.md:288`). Trial scenarios use the cards they name (`assumptionIds`) or all current cards (`vcrOrchestrator.mjs:1315-1317`). **Only assurance uses the distribution**: `vcrDesignPriorFrom` takes the effect card's lognormal/normal and refuses one whose basis is `confidence` (`:699-714`, check `:703`); the R side integrates power over it (Gauss–Hermite, `项目代码/vcr-engine/R/assurance.R:7-47`). Fixed-sample/sequential simulations draw nothing from the card's distribution — truths are fixed values (`项目代码/vcr-engine/R/design_simulate.R:291`, `:324-333`). Sensitivity calibres on a card are not turned into extra scenarios anywhere in the orchestrator (only `vcrAssumptionConflicts` reads `sensitivity.range`, `vcrOrchestrator.mjs:1467-1500`).
6. **Lineage and staleness.** Each job freezes the cards as inputs `assumption:<key>@<version>` with their values (`#freeze`, `vcrOrchestrator.mjs:2803-2818`), records which card bound which path (`detail.bound`, `:2700-2702`), and adds lineage edges (`:2720-2724`); a new card version marks downstream results stale and requeues them (`recomputeAfterChange` `:3514-3521`, domain `recomputePlan` `OS/packages/domain/src/vcrLineage.mjs:168-190`). Side effect worth knowing: `#freeze` attaches **every** current card to **every** object kind (only trial scenarios with explicit `assumptionIds` are narrowed, `vcrOrchestrator.mjs:2806-2808`), so editing, e.g., a dropout card also stales the population, virtual-patient and comparator results that never read it.
7. **Evidence step completion** reads only evidence-derived cards (`vcrEvidenceProduct`, `vcrOrchestrator.mjs:444-449`), so cards written by the protocol or analysis runs do not count.

### 8.2 Do assumption cards exist as objects with provenance?

Yes. `evimed_vcr.assumptions` is versioned per `(study_id, key, version)` with `point_value`, `distribution`, `sensitivity`, `source_kind` (`expert_set|scenario|external_evidence`), `value_source` (nine labels), `pooling_method`, `pooling` (calibre, k, I², τ², CI, PI, scale, rule reason, or `basedOn` for an expert setting), `evidence_ids text[]`, `applicability`, `review_state`, `after_freeze` (`OS/apps/server/src/vcrPersistence.mjs:408-435`). `evidence_ids` point to `evidence_items` rows that carry `quote`, `locator` (with `recordHash`), `source_ref`, `arm_role`, `endpoint_key`, `enrollment_kind`, `historical_baseline` (`vcrPersistence.mjs:342-386`), which point to the precedent with its preserved text and hash. A current card is the newest non-`after_freeze` version per key (`OS/apps/server/src/vcrStore.mjs:953-957`); a version written after the plan froze is kept beside it and never becomes current (`vcrPersistence.mjs:432-435`). Hybrid-control (MAP) historical counts are flagged `inputsAssumed` unless they match verified control-arm items (`#historicalIsVerified`, `vcrOrchestrator.mjs:2747-2771`).

Prediction vs confidence: pooled cards carry the PI as their `distribution.range` (`kind: "prediction"`) and the CI separately; single-study cards carry a CI and say there is no PI; expert settings carry a widened range labelled prediction-kind but `valueSource: assumed` (`vcrEvidence.mjs:927-956`, `:1010-1031`; `vcrGateway.mjs:886-894`).

### 8.3 What is not there

- **Journal literature is not an anchor.** Evidence items are verified only against a registry record the study holds; the SKILL is explicit: "只有登记记录里的数能进假设卡。平台目前只把值对着登记记录的保全文本核对；论文正文和图表里读到的数核对不了，不进假设卡" (`OS/capabilities/vcr-evidence/SKILL.md:102-103`), even though the capability's `whenToUse` says "从登记记录与文献里逐项抽数" (`OS/capabilities/vcr-evidence/capability.yaml:25`). No `literature`/`pmid`/`doi` path exists in `vcrEvidence.mjs` or `vcrEvidenceStore.mjs` (search returned none). Trials whose results are published but not posted to CT.gov (most Chinese and many EU trials) give no poolable numbers.
- Digitised KM curves (`curve_digitize`) feed only literature-control comparators (`reconstruct_km` → RMST / MAIC), "它不进假设卡" (`vcr-evidence/SKILL.md:104-107`; `vcrOrchestrator.mjs:1248-1275`).
- A literature population's `baselineTable` (means/SDs/proportions) is typed by the run with no quote check (schema `OS/packages/domain/src/vcrScenarioSchemas.mjs:446`; no verification in `vcrGateway.mjs`), labelled `aggregate` on display (`OS/apps/server/src/vcrViewsKit.mjs:275`).
- Accrual parameters: `accrual_to_primary_completion_months` and planned-vs-actual enrolment are extractable from CT.gov (`trialRegistryClient.mjs:16-27`), and "screening failure rate, per-site accrual, site activation" are named unavailable, never zero (`trialRegistryClient.mjs:28-32`; `VCR_NOT_IN_REGISTRY` via `unavailableParameters`, `vcrEvidence.mjs:1035-1038`).

Implication for the plan: phase 3 (虚拟试验) can stand on this pipeline as is — cards with PIs exist, bind by key, assurance integrates over the PI, lineage restales results. Phase 2/3 users whose precedents are Chinese (ChiCTR list-only, CDE absent — Q9) or only published in journals will get expert-set cards, not pooled ones, unless a literature anchor (paper text in the knowledge base, which already has verbatim `kb_search` passages) is added.

## Q9 — Registries

### 9.1 What the control plane's registry client can read

The one client is `createTrialRegistryClient` (`OS/apps/server/src/trialRegistryClient.mjs:1344-1690`), composed once for the module (`OS/apps/server/src/vcrComposition.mjs:1151-1155`). It speaks exactly three registries: `TRIAL_REGISTRIES = ["clinicaltrials.gov", "chictr", "ctis"]` (`trialRegistryClient.mjs:102`). Its coverage table has five rows (`:1363-1374`):

| Registry | Coverage | How | Notes |
|---|---|---|---|
| ClinicalTrials.gov | `structured` | Public API v2: `GET /api/v2/studies?…` search and `GET /api/v2/studies/{nct}?format=json` record (`search` `:1490-1548`, `record` `:1552-1575`); wire facts recorded live (`:81-95`). Reduced record whitelist + sha256 (`:14-20`). No credential. | Results section (arm values, HR analyses), planned vs actual enrolment, dates, sites (contacts never copied). |
| ChiCTR | `list_only` | **No public API** (`source_catalog.json` `blocked_no_api`; `trialRegistryClient.mjs:45-50`; `OS/runtime/mcp/evimed-research/source_catalog.json:6-20`); ChiCTR's site answers direct requests with 405 (`trialRegistryClient.mjs:1697-1698`). Reached only through EviMed's own evidence API `POST …/review/api/clinical-trial` with `registry: 0`, with the deployment's `evimedEvidence` key or the researcher's own connector key (`vcrChictrAdapter`, `vcrComposition.mjs:1242-1296`; `createChictrAdapter` `trialRegistryClient.mjs:1708-1717`). "Record by id" is a search by the id and an exact match on `registrationNo` (`fetchRecord`, `OS/apps/server/src/vcrEvidence.mjs:1180-1196`). | The answer "carries no eligibility text, no arms, no outcome definitions and no results" (`trialRegistryClient.mjs:788-800`); `eligibilityText: ""` (`:852`), named unavailable (`:859`); sample size is not marked planned/actual so it never enters a baseline (`:796-800`). |
| EU CTIS | `structured` | The portal's public JSON API: `POST {base}/search`, `GET {base}/retrieve/{ctNumber}` (`:55-85`, `searchCtis` `:1585-1628`, `recordCtis` `:1630-1660`), endpoints recorded from live answers, not a documented API. | No actual enrolment, no outcome results. |
| CDE (chinadrugtrials.org.cn) | `unsupported` | Not integrated: `reason: "registry_unsupported"` (`:1370`); the source catalogue lists NMPA/CDE as `blocked_no_api` (`source_catalog.json:2031-2044`). Owner ruling: "no CDE or Fierce source recovery" (`CLAUDE.md:274`, same line in `AGENTS.md:274`). | No path in `trial_registry_record`, `candidate_trial`, `precedent`, `evidence_item` (registry is a closed choice of the three, `vcrGateway.mjs:921`, `:958`, `:1030`). |
| WHO ICTRP | `unsupported` | Not integrated: `reason: "registry_terms_forbid_commercial_use"` (`trialRegistryClient.mjs:51-54`, `:1371-1373`); catalogue `blocked_no_api` (`source_catalog.json:60-73`). | — |

### 9.2 The runtime tools

- **`trial_registry_record`** (MCP `OS/runtime/mcp/evimed-research/vcr_platform.py:310-327`, handler `registry_record` `:1142-1190`): `registryId` plus optional free-text `registry`; it only ever asks the VCR gateway (`what: "trial_registry_record"`), which calls `readRegistryRecord` (`vcrEvidence.mjs:1291`) → CT.gov record / CTIS record / ChiCTR search-by-id. Never throws, never writes; `registry_not_found` vs `registry_unavailable` kept apart. Because it goes through the VCR gateway, it answers only in a VCR study's project (`vcr_no_study`, `OS/apps/server/src/vcrGateway.mjs:2149-2153`) — Q1's reachability question applies to it.
- **`clinical_trial_search`** (MCP schema `OS/runtime/mcp/evimed-research/server.py:650-670`; `_trials` `public_sources.py:1699-1712`; `_evimed_trial_records` `:1358-1403`): first EviMed's evidence API with `registry` `0` ChiCTR / `1` ClinicalTrials.gov (default) / `2` Cochrane CENTRAL (`接口文档/EviMed医学证据检索.md:94`); if that source is not configured it falls back to ClinicalTrials.gov API v2 directly and says "ChiCTR and Cochrane CENTRAL are not searched" (`public_sources.py:1711`). It is root-visible (`ROOT_VISIBLE_MCP_BASE_NAMES`, `OS/packages/domain/src/toolNames.mjs:270`), so an ordinary conversation can *list* trials today; it cannot read a record into a VCR study or judge eligibility.
- **`clinical_trial_snapshot`** (`trial_snapshots.py:1-40`) preserves and diffs a CT.gov record (NCT only); it tells the run to "search the other registries (ChiCTR, ISRCTN, EU CTR) with clinical_trial_search" (`trial_snapshots.py:581`).

### 9.3 给患者找试验 (patient → trials)

- The run (vcr-matching) finds trials with `clinical_trial_search`, reads promising ones with `trial_registry_record`, and writes each as `what: "candidate_trial"` with structured criteria whose `sourceText` must be copied from the registry record (`OS/capabilities/vcr-matching/SKILL.md:169-180`). The platform fetches the record itself (`candidateRecord`, `vcrEvidence.mjs:1364-1371`) and reads title/phase/status/conditions/sites from it (`candidateTrialFromRecord`, `OS/apps/server/src/vcrPatientTrials.mjs:69-97`), locates each criterion's sentence in the record's eligibility text, then evaluates the named patients with the same evaluator (`vcrGateway.mjs:955-1024`).
- **For a Chinese trial this degrades silently.** A ChiCTR record has empty eligibility text, `locateSourceText` returns null on an empty record (`vcrPatientTrials.mjs:107`), and the "source_text_not_in_record" warning is pushed only when the record *has* eligibility text (`vcrGateway.mjs:994-999`) — so ChiCTR criteria are stored unlocated with no warning, and their wording came from wherever the run found it. `vcr-matching` does not even have `web_read` (`OS/capabilities/vcr-matching/capability.yaml:35-46`). Sites are empty for ChiCTR (no `contactsLocationsModule`). CDE-registered trials (CTR numbers) cannot be written at all (closed registry choice, `vcrGateway.mjs:958`); a ChiCTR lookup by a CTR number would come back `registry_not_found` (`vcrEvidence.mjs:1191-1194`).
- The study's own protocol versions are ranked beside candidate trials in a patient's list (`vcr-matching/SKILL.md:184`; `vcrPatientTrials.mjs:20-22`).

### 9.4 Coverage reporting

`coverage()` / `coverageFor(userId)` (`trialRegistryClient.mjs:1454`, `:1464-1475`; the per-user view closes the ChiCTR row when the researcher has no key) reaches the evidence tab via `presentPrecedents` (`OS/apps/server/src/vcrService.mjs:1369-1371`, `OS/apps/server/src/vcrViews.mjs:1354-1362`) and the runtime read (`vcrEvidence.mjs:1711`). The page renders it in `OS/apps/web/src/components/vcr/VcrRegistryCoverage.tsx:20-33`: 结构化记录 / 仅登记列表 / 未接入, and 未配置 / 上次读取成功 / 上次读取失败 / 尚未查询, the ICTRP terms reason, and "登记列表中的样本量未区分计划与实际，不能作为历史基线" (`:31`). `lastCheckedAt` is per process, not persisted registry health (`trialRegistryClient.mjs:1447-1453`).

Implication for the plan: patient↔trial matching for Chinese patients — the main market — can only *list* ChiCTR trials (and only with an EviMed evidence key), cannot anchor their eligibility text, and cannot see CDE trials at all; CT.gov and CTIS are the only registries with structured eligibility. That is a data-access constraint the owner has already ruled on (no CDE recovery), so "both directions, ending at a candidate list with per-criterion evidence" is fully supported only for CT.gov/CTIS trials and for the study's own protocol.

### Out-of-scope notes spotted (for the parent / other forks)

- Recruitment surfaces inside the programme machinery: `VCR_ACCRUAL_TOLERANCE` ("How far actual accrual may drift from the registered forecast before a person hears about it", `OS/apps/server/src/vcrOrchestrator.mjs:127-128`); the 「匹配与招募」 tab label (`vcrVocabulary.mjs:459`); T1's label "T1 基线与招募资料" and unlock text "做患者匹配与招募" (`vcrVocabulary.mjs:354`, `:359`); the matching SKILL's sites/follow-up/`accrual_forecast` section and the auto-referral sentence (`OS/capabilities/vcr-matching/SKILL.md:102`, `:122-143`); the match job's finish hook "candidates turned into referrals" (`OS/apps/server/src/vcrComposition.mjs:793-800`).
- `trial_registry_record` and the five capabilities' VCR tools are reachable only through the VCR gateway, which needs the runtime's project to be a study's project (`vcrGateway.mjs:2149-2153`) — relevant to Q1.


_(Q5, Q8 and Q9 were drafted by a review fork. I re-read the decisive lines:_
- _`vcrVocabulary.mjs:445-453`: matching needs only a definition;_
- _`vcrOrchestrator.mjs:3126-3148`: one run per study, with matching dispatched last;_
- _`vcrOrchestrator.mjs:376-385`: the backfill;_
- _`vcrComposition.mjs:727-733`: criteria are required;_
- _`vcrOrchestrator.mjs:1195-1200`: virtual patients need an endpoint type;_
- _`trialRegistryClient.mjs:100-103,786-800,1363-1375`: three registries, the ChiCTR stub, CDE and ICTRP unsupported;_
- _`vcr-evidence/SKILL.md:101-104`: only registry numbers enter cards.)_
