---
name: geo-insight
description: Steps 1–3 of a 「循证 GEO」 project for one medicine — verified identity and label, a claim library with verbatim quotes, patient subtypes, journey and care nodes, and a four-pool question map with control groups, written into the project.
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
the method pack. Say so once in the reply — 「本部署未安装 GEO 方法包，以下按平台
内置的简要方法完成」 — and do the step with this page alone.

## Tools, not clients

The pack's standalone clients map to platform tools; the runtime never knows a
probe host, a social crawler or a marketplace.

- Evidence: `mcp__evimed__drug_label_search` (China label index and FDA; reading a label
  preserves its sections under `.evimed-sources/`), `mcp__evimed__guideline_search`,
  `mcp__evimed__literature_search`, `mcp__evimed__clinical_trial_search`, `mcp__evimed__open_access_full_text`,
  `mcp__evimed__web_search`, `mcp__evimed__web_read` (regulator pages render in the cloud browser),
  `mcp__evimed__locate_quote` to find the exact passage in a preserved source.
- Real phrasings: `mcp__evimed__social_posts_search`, one platform per call (a crawl takes
  30–120 s): ask the platforms that carry the product's patients — usually 知乎、抖音、
  小红书 — one after another. A platform with no posts is 「无信号」,
  never zero; when the channel fails, questions are written as kind `typical`
  and the report says the phrasings were not collected.
- Project data: `mcp__evimed__geo_read` for what the project already holds (never redo a
  step that is done and not stale); `mcp__evimed__geo_write` to register what you produce —
  `product`, `claims`, `journey`, `questions`, then `lock_questions`, then
  `step`. A write answers item by item; fix the refused items and write again.
  `product` carries `competitors` (`brandName`, `genericName`, `aliases`,
  `holder`, `indication`, `reason`): the measurement recognises a rival only by a
  registered name, so without them share of voice is never computed. `aliases`
  are the other names an answer uses for it — the molecule's short name (替尔泊肽),
  the English brand (Mounjaro).
  The project page shows the journey as four columns, so every `journey` stage
  carries all four: `emotion`, `thinking`, `questions` (the questions a patient
  at that stage asks an AI — take them from the question map's typical
  questions and real phrasings) and `infoSources` (where they look: 小红书、
  抖音、百度、公众号、医生、药师 …). An empty list is an empty column. Give each
  claim `sourceRefLabel`, the source as a reader names it (「玛仕度肽注射液说明书
  （国家药监局 2025）」); the page never shows a preserved page's id.
- Measurement is the platform's. Never batch-probe inside a run: once the set
  is locked the platform runs the baseline on its own. `mcp__evimed__geo_visibility_probe`
  is only for a single question the user asks about in the conversation.

## What you decide without asking

Only two things in a whole GEO project wait for a person: the distribution
budget, and an article with an unresolved clinical-safety finding. Neither is
yours. Everything else you decide: a default with its reason, written into the
package's `assumptions[]` (`field`, `value`, `basis: default|upstream|inferred|
client_said`, `reason`, `howToChange`). The one input stop is identity: when you
cannot tell which product (which holder, which form) the user means, ask one
question and nothing else.

Defaults: coverage period and engines from `geo_read project`; prescription
medicines get a patient line and a physician line, OTC a patient line only;
the focus SKU by the variants skill's default rule.

**Single-step, minimal mode.** When the brief asks for one step only, build the
missing upstream as a minimal version and say so: identity and label claims
only, and a minimal question set of **30** measured questions (at least a few
per pool), each marked as `typical` unless it was collected. Set
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
  One claim per statement the brand may make: `claimKey`, `statement` (no
  stronger than the evidence), `quote` (verbatim), `sourceRef` (label version,
  DOI, PMID or guideline), `sourceKind` (`label|guideline|trial|review|
  literature|regulator|other`), `artifactPath` (the `.evimed-sources/` file the
  quote is in), `evidenceLevel`, `population`, `inLabel`, `elements` (the
  T/CAPT 026 evidence elements), `verifiedAt`, `validUntil`. A full library
  usually holds 30–50 claims.
- `question-map.json` — `{ minimal, groups: [...], assumptions }`. Each group:
  `groupKey`, `pool` (`P1`–`P4`), `name`, `typicalQuestion`, `journeyStage`,
  `audience` (`patient|physician`), `bridge`, `weight`, `isControl`, `signal`
  (`collected|partial|no_signal|client`), and `questions` with `text`, `kind`
  (`typical|real|label_safety|client`), `platform`, `sourceUrl`, `collectedAt`,
  `measured`. A full set measures 40–120 questions with 3–5 control groups
  (about 20–30%); a real phrasing always carries its platform and URL.
- `journey.md` — optional: the full 12-stage matrix the page only summarises.

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
