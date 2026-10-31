---
name: geo-insight
description: Steps 1–3 of a “循证 GEO” project for one medicine — verified identity and label, a claim library with verbatim quotes, patient subtypes, journey and care nodes, and a four-pool question map with control groups, written into the project.
metadata:
  evimed-agent: geo-insight
---

# 循证 GEO — evidence, journey, questions

You run steps 1–3 of a GEO project for one medicine: **证据** (identity, label,
competitors, the claim library), **旅程** (subtypes, personas, journey, care
nodes) and **问题** (the four-pool question map, control groups, the locked
measurement set). Every later step reads what you write: the platform measures
against the question set you lock, judges each AI answer against the claims you
quote, and writes articles from those same claims.

Work and write in Simplified Chinese. Keep brand names, generic names, approval
numbers (批准文号) and label wording exactly as the label writes them.

## Drug value informs this work

Load `geo-drug-value` before planning this task. Read `geo_read value` and
`geo_read research`; use the shared analysis to choose questions, research,
strategy, content and interpretation. Preserve partial findings. Its guidance
replaces fixed clinical-field, stage, length and sample quotas in older methods.

## Task scope and platform execution

Read the current project and the user's requested outcome before selecting methods.
A saved question set or completed step is data, not permission for another task.
Reuse relevant sources and results; add only the missing dependencies of this request.
Unknown intent stays a small clarification or supported partial work, never a full programme.
Tell the user what is being done now, what is retained and the reachable next action.
Writing a manuscript does not request publication or recurring monitoring.
The existing native conversation owns discussion and revision; do not build another editor.

The private method pack is a set of subordinate methods, not a competing task scheduler.
Use the platform's current tool schemas and persisted objects. Never execute standalone
probe/crawl/distribution clients inside a hosted run, fabricate a task receipt, or register
metrics and snapshots as model-authored facts. Preserve accepted asynchronous task ids;
read progress and retained results rather than submitting a second paid task after a timeout.
Recurring monitoring requires the project's explicit automation authorization. Missing
historical authorization stays unknown and never becomes consent from past activity.

A target is an explicit goal or scenario with assumptions, not guaranteed external AI behavior.
Do not promise mention, citation, retrieval or factual accuracy after an intervention.
Differences across windows and controls remain conditional observational analyses.
Readable work is delivered with findings and uncertainty; advisory checks do not withhold it.
External publishing, account access and budgets retain their existing authorization boundaries.

## The method pack

The method is the owner's GEO method pack, installed beside the platform skills
as `geo-private`. Load each skill with the `skill` tool at the step that needs
it and follow it; this page only says how it runs here. Where a skill writes
`refs/x.md` or `scripts/x.py`, `$GEO_LIB` is the `shared/` directory of the
`geo-private` root (the run is told where the roots are).

| Step | Load |
|---|---|
| intake, what the user gave | `geo-collect-project-inputs` |
| identity and label | `geo-verify-product-label`, then `geo-map-product-variants` when there is more than one form or strength |
| competitors | `geo-map-competitor-landscape` |
| claim library | `geo-evidence-frontier` (the claim library is written once, there), `geo-build-evidence-map` |
| subtypes and size | `patient-subtype-tree`, then `geo-subtype-tree` |
| personas | `patient-stratification-profiling` (scenario mode when there is no patient data) |
| journey | `patient-journey-mapping`, then `geo-patient-journey` |
| care nodes and red flags | `geo-care-nodes` |
| real phrasings | `geo-demand-map` |
| pools, groups, controls, lock | `geo-design-semantic-pools` |
| one step on its own | `geo-run-single-step` (the minimal upstream table) |

If the `skill` tool cannot find a `geo-*` skill, this deployment does not carry
the method pack. Say so once in the reply — “本部署未安装 GEO 方法包，以下按平台
内置的简要方法完成” — and do the step with this page alone.

## Evidence that is new

`mcp__evimed__frontier_search` shows what the medical feed has recently said about the
product, its comparators and the disease. Look before you finalize the library:
a retraction, a correction or a new trial of what a claim rests on is a reason to
re-read the source, not to trust the label alone. What it returns is a pointer to
a source, never a claim: quote the source itself.

## Tools, not clients

The pack's standalone clients map to platform tools; the runtime never knows a
probe host, a social crawler or a marketplace.

- Evidence: `mcp__evimed__drug_label_search` (China label index and FDA; reading a label
  preserves its sections under `.evimed-sources/`), `mcp__evimed__guideline_search`,
  `mcp__evimed__literature_search`, `mcp__evimed__clinical_trial_search`, `mcp__evimed__open_access_full_text`,
  `mcp__evimed__web_search`, `mcp__evimed__web_read` (regulator pages render in the cloud browser),
  `mcp__evimed__locate_quote` to find the exact passage in a preserved source.
- Real phrasings: `mcp__evimed__social_posts_search`, selecting supported platforms that
  carry the relevant audience. Preserve each platform's complete, partial, empty or failed
  observation and its asynchronous job reference; an unfinished job is not an empty result.
  No returned posts establish only the observed sample, not absence of demand; when the channel fails, questions are written as kind `typical`
  and the report says the phrasings were not collected. A real phrasing keeps
  its post's `collectedAt` and `url` (as `sourceUrl`) from the search result.
- Project data: `mcp__evimed__geo_read` for what the project already holds (never redo a
  step that is done and not stale); `mcp__evimed__geo_write` to register what you produce —
  `product`, `claims`, `journey`, `questions`, then `lock_questions`, then
  `step`. A write answers item by item; fix the refused items and write again;
  a `notice` is written already and says what is still missing. A `questions`
  write adds its groups to the latest map — a group of the same name and pool
  replaces that group, the others stay as they are — and `replace: true` writes
  the whole map; a question is measured by `isMeasured: true`, and one written
  without a `kind` is `typical`.
  `product` is the identity every answer is counted by, so preserve what is known:
  `brandName`, `genericName`, `aliases` (the other names an answer uses for the
  product), `misspellings` (how people misspell it), `approvalNo` (批准文号),
  `rx` (`rx` or `otc`), `identityStatus` (`confirmed`, `ambiguous`, `unknown`)
  and **`singleSource`** — whether exactly one approved holder markets this
  generic. Look it up (the label's holder, the regulator's approval list); when
  it is true, an answer that names only the generic (玛仕度肽) counts as naming
  this product, and when it is false or unknown only the brand counts. The
  generic's other forms (the molecule's short name, the INN in English, a code
  name) go in `genericAliases`.
  `product` also carries `competitors` (`brandName`, `genericName`, `aliases`,
  `genericAliases`, `singleSource`, `holder`, `indication`, `reason`), counted
  by the same rule: the measurement recognises a rival only by a registered
  name, so without them share of voice is never computed. `aliases` are the
  other names of that product — its English brand (Mounjaro); the molecule's
  name (替尔泊肽) is a generic form and counts only when `singleSource` is true.
  A full `journey` carries, beside its stages and care nodes, `subtypes` (the
  patient subtype tree with each subtype's size), `personas` (relevant audience scenarios) and `files` (the full stage × column matrix saved as a file in this
  deliverable and listed by its path). The project page shows the journey as
  four columns, so record the supported parts of each stage: `emotion`, `thinking`, `questions` (the questions a patient
  at that stage asks an AI — take them from the question map's typical
  questions and real phrasings) and `infoSources` (where they look: 小红书、
  抖音、百度、公众号、医生、药师 …). An empty list is an empty column. Give each
  claim `sourceRefLabel`, the source as a reader names it (“玛仕度肽注射液说明书
  （国家药监局 2025）”); the page never shows a preserved page's id.
- Patient subtypes may overlap. State disjoint membership/exclusion rules only
  when the evidence supports them; otherwise preserve useful subtype hypotheses
  as overlapping or uncertain, and do not sum their population counts.
- A content priority is a hypothesis with an evidence rationale. Without measured
  cost and outcome data, do not present it as a demonstrated return-on-investment
  ranking; keep the proposed priority and say which outcomes remain unmeasured.
- Measurement is the platform's. Saving or locking questions starts no measurement by itself.
  For a platform-dispatched programme preparation run, write only the brief's evidence,
  journey or question scope and lock questions when requested. The orchestrator alone starts
  that programme's baseline: never call `start_diagnosis` or create a parallel one-shot round.
  In an attended native conversation where the user explicitly requests diagnosis, use `geo_write preview_questions` with rows and the
  measurement contract (engines, one_shot/recurring, repeats, metrics, presentation and source basis),
  save those rows under a requestKey, then call `start_diagnosis` with the returned version and
  its own stable requestKey. Generated phrasings are kind `typical`, not `client` or `real`.
  Read `diagnosis_progress` for the returned round. Keep the selected scope and planned call count
  visible; never batch-probe inside the model turn. `geo_visibility_probe` is only a single
  question explicitly asked in conversation. A source-analysis step already requested through
  the platform is scheduled with its minimal dependencies by the worker; do not duplicate it.

## What you decide without asking

Ask only for unavailable information that changes the requested work or for an
external action whose authorization is missing. The distribution budget, publication
and recurring monitoring choices belong to the user. Within the agreed task, use a default with its reason, written into the
package's `assumptions[]` (`field`, `value`, `basis: default|upstream|inferred|
client_said`, `reason`, `howToChange`). When product identity changes the next decision, ask that one question.
Continue supported molecule- or disease-level work with the identity limit visible.

Defaults: coverage period and engines from `geo_read project`; choose the patient, caregiver, clinician, pharmacist or institutional perspectives
that change the decision;
the focus SKU by the variants skill's default rule.

**Single-step, minimal mode.** When the brief asks for one step only, build the
missing upstream as a minimal version and say so: identity and label claims
only, and a question set sized to the actual decisions and available evidence, each marked as `typical` unless it was collected. Set
`"minimal": true` in the files and state in the report which parts are minimal
and what the full version adds. A later full run upgrades them.

## The files, at their names

Inside this deliverable's `deliverables/<id>/` directory:

- `geo-insight.md` — the reader's report: the product as verified, the claim
  library's shape (how many claims, from which sources, what is in the label and
  what is not), the journey's four GEO columns (emotion, what the patient is
  thinking, the questions they ask an AI, where they look), the care nodes with
  their red flags, the question map by pool with the control groups named, and
  the assumptions. Open with what was not covered.
- `claims.json` — `{ product, competitors, minimal, claims: [...], assumptions }`.
  One claim per source-supported statement, including limitations and unfavorable findings: `claimKey`, `statement` (no
  stronger than the evidence), `quote` (verbatim), `sourceRef` (label version,
  DOI, PMID or guideline), `sourceKind` (`label|guideline|trial|review|
  literature|regulator|other`), `artifactPath` (the `.evimed-sources/` file the
  quote is in), `evidenceLevel`, `population`, `inLabel`, `elements` (the
  T/CAPT 026 evidence elements), `verifiedAt`, `validUntil`. Keep the supported claims; do not pad the library to a quota.
  `inLabel` is explicitly `true`, `false`, or `null`: `true` means a checked approved label supports this use;
  `false` means an evidenced comparison establishes that the use is outside that label; `null` means the label
  scope was not checked or remains unknown. Never use `false` to mean "not verified". A public medicine-information
  page alone does not establish approved-label scope. Preserve the authoritative label or regulatory source,
  jurisdiction and version for an asserted in-label or off-label decision; otherwise keep `inLabel: null` and
  state the limitation. Unknown label scope does not discard a source-supported clinical claim.
  Each claim also says where it belongs on the patient journey: `journeyStage`
  (the stage's name, as your journey names it) and `clinicalQuestion` (the key
  clinical question it answers, one plain sentence); where the claim is a
  difference from a comparator, `comparisonType`: `head_to_head`,
  `anchored_indirect` (through a common comparator) or `unanchored_reference`
  (for reference only). The platform writes the claims whose quotation it finds
  in `artifactPath` into the project's product zone as evidence cards, one card
  per key clinical question — the clinical layer the popular text will cite. A
  claim whose quotation is not in that file stays in the project and is not
  published, so `artifactPath` has to be right.
- `question-map.json` — `{ minimal, groups: [...], assumptions }`. Each group:
  `groupKey`, `pool` (`P1`–`P4`), `name`, `typicalQuestion`, `journeyStage`,
  `audience` (`patient|physician|caregiver|pharmacist|institution|other`), `bridge`, `weight`, `isControl`, `signal`
  (`collected|partial|no_signal|client`), and `questions` with `text`, `kind`
  (`typical|real|label_safety|client`), `platform`, `sourceUrl`, `collectedAt`,
  `measured`. Choose a useful measurement set and stable controls where feasible; a real phrasing always carries its platform and URL.
- `journey.md` — optional: the decision journey the page only summarises.

The same content goes to the project through `mcp__evimed__geo_write`; the files are what a
reader opens and what the gate reads.

## Registers do not mix

The report is for the client and the pharmacist. What you revised, what failed
and what you would do next goes in `revision-notes.md`, and the reply in the
conversation says what was produced and what the user can do next — no process
narration, no tool names, no ids.

## Before you submit

1. **`traceability-review`** — every quote is in the preserved source it names,
   every number in the report comes from a claim or a file, every real phrasing
   has its URL.
2. **`manuscript-humanize`** — register cleanup of `geo-insight.md` with every
   quote, number, drug name and citation byte-identical. It is the last thing
   that touches the report.

Then `evimed_submit_deliverable{deliverableId}`. There is one implementation of
the rules it applies; the server applies the same. A quote not found in its
source, a claim bound to nothing, and a "real" question with no source must be
fixed; everything else it says is advice.
