---
name: research-topic-selection
description: Run EviMed's evidence-grounded research-topic specialist to identify gaps, contradictions, feasible questions, and a prioritized research agenda.
metadata:
  evimed-agent: research-topic-selection
---

# Research topic selection

Use this skill when a user has a broad biomedical direction and needs concrete,
testable research questions. Topic novelty must be supported by the retrieved
evidence set; absence from a small search is not proof of novelty.

Use `dataset-research-scoping` instead when the user already has a file. That
entry point starts from the data and decides what it can carry; this one starts
from a direction and never touches data.

## The specialist job is an input, not the report

`mcp__evimed__research_topic_selection` runs the topic agent. Its retrieval starts
with the internal evidence service and also queries PubMed for public identifiers
and metadata. Inspect the returned source records and diagnostics: availability,
coverage and failures are response-dependent. The specialist result is a first
map for the wider novelty and feasibility assessment below.

The job gives you a first map. The evidence expansion below is what turns it
into a judgment, and where the two disagree, say so — a candidate the job ranked
highly that the wider search shows was answered in 2024 is a finding.

## Execute

1. Preserve the user's disease, population, intervention or exposure, outcomes,
   available data, methods, and feasibility constraints. State only assumptions
   that do not materially change the direction.
2. Call `mcp__evimed__research_topic_selection` with `action=capabilities`, start the
   job, record the job id, and poll with `waitSeconds=45` until terminal.
   Keep `researchDirection` as the original retrieval direction. Pass supplied
   context separately as `availableData` (string, at most 4000 characters),
   `population` and `studySetting` (strings, at most 1000 characters each), and
   `resourceConstraints` (at most 20 nonempty strings, at most 200 characters
   each). Omit unspecified fields; do not stringify arrays/objects, silently
   shorten a brief, or place infrastructure settings into these fields. A data
   description is not permission or confirmation of data access.
3. Run the evidence expansion below **while the job runs** — it is long, and the
   two do not depend on each other.
4. Keep the evidence landscape, contradictions, candidate gaps, proposed study
   designs, feasibility, risks, and prioritization rationale distinct. A topic
   is not high priority merely because it sounds novel.
5. Do not fabricate search counts, citations, data availability, sample sizes,
   effect assumptions, or publication probability.
6. Use `mcp__evimed__pharmacy_reference_search` only when configured private
   terminology or rule coverage materially informs feasibility, phenotype or
   exposure definition, or data-readiness questions. Private rows are
   institution-specific discovery context, not proof of novelty, prevalence,
   clinical validity, or current guidance; verify material assumptions against
   current authoritative sources.

## Evidence expansion

Use the configured MCP tools for evidence expansion. Consult
`mcp__evimed__data_source_catalog` and each response for supported operations,
limits, source provenance and availability. The channels below serve different
questions; use those relevant to the candidate rather than a fixed channel quota.

| Channel | Tool call | What only this one gives you |
|---|---|---|
| PubMed | `mcp__evimed__literature_search`, or `mcp__evimed__biomedical_source_search` with `sourceId: pubmed` | MeSH-indexed subject search; publication types |
| Europe PMC | `sourceId: europe-pmc` | **Full-text** search — a method or a limitation stated only in a Discussion section |
| OpenAlex | `sourceId: openalex` | Citation counts, concepts, publication year: how large a topic is and how fast it is moving |
| Semantic Scholar | `sourceId: semantic-scholar` | References and citing works — who built on a paper, and who did not. Rate-limited without a key; retry with backoff |
| Crossref | `sourceId: crossref` | Very recent DOIs, ahead of MEDLINE indexing |
| Preprints | `mcp__evimed__biomedical_source_search` with `sourceId: europe-pmc` and `SRC:PPR` in the query | What is being done right now and is not yet published. `sourceId: biorxiv`/`medrxiv` resolves a DOI you already have — it is a lookup, not a search |
| Full text | `mcp__evimed__open_access_full_text` | The actual Methods and Limitations paragraphs |
| Ongoing studies | `mcp__evimed__clinical_trial_search` | Registered questions, recruitment state and planned outcomes; a registration is not a completed finding |
| Guidelines | `mcp__evimed__guideline_search`, `mcp__evimed__official_page_fetch` | What practice already recommends, and on what evidence grade |
| Drug and gene facts | `sourceId: dailymed` / `openfda` / `rxnorm` / `clinpgx-pharmgkb` | Label text, adverse-event counts, pharmacogenomic annotation |
| Trend analysis | `mcp__evimed__bibliometric_analysis` | Publication-volume curve, author and institution clusters, emergent terms |
| Open web | `mcp__evimed__web_search` | Everything the indexes do not carry — funding calls, conference programmes, society pages, registries, a method a group describes only on its own site |

Do not infer a permanent outage from an old host probe. Inspect current tool
responses; use bounded retries for transient errors and record unavailable
channels as limitations. An unavailable source is not an empty literature.

Check the material actually returned. A title alone cannot support study design,
evidence level, outcomes or effect size. Abstracts support only what they state;
retrieve full text for Methods or Limitations on which the proposed design rests.
Respect limits advertised by the current tool schema rather than assuming a
universal maximum.

Open-web results are discovery leads. Follow material claims to the primary
record and preserve its identifier and URL when available. Official registry,
funder or society pages can document their own records; an unreviewed summary
cannot substitute for the underlying study. Engine coverage varies by response
and language. Record which searches answered and which failed, including both
Chinese and English queries when relevant to the user's population or setting.

Search every candidate direction four ways. A missing axis is what makes an
agenda thin:

1. **Subject** — the direction as the user framed it.
2. **Method** — how a question of this shape is answered: the design, the
   estimator, the reporting guideline. A design without a precedent is a risk
   the user has to be told about.
3. **Comparator** — the published numbers a result would be placed against.
4. **Absence** — what a recent review or a preprint says is still open. This is
   where an unoccupied question actually shows up; nothing else finds it.

## The novelty ledger

Every candidate question gets: **what already answers it, at what n, in which
population, published where and when — and what precisely is left.** Three
outcomes, all legitimate, each stated out loud:

- **No direct answer identified in this search** — state the bounded search
  scope, unresolved coverage gaps and closest neighbours. Do not assert that the
  question is unoccupied across the whole field.
- **Occupied, but not in this population, setting, or era** — name the closest
  work and the exact axis of difference. Most real papers live here.
- **Answered** — drop it and say so. A direction removed because the field has
  settled it is a finding, not a failure.

"Clinically important" is not a novelty statement. The field agreeing that a
topic matters is the reason it may already be answered.

Check the closest completed work and relevant ongoing or registered studies.
State which endpoints and settings they already cover before proposing a new
question. Separate a proposed hypothesis or method from an established finding;
a registry entry or protocol establishes a planned study, not an observed effect.
If the relevant registry is unavailable, record the unresolved overlap check.

## Proportional evidence coverage

Evidence count is a coverage diagnostic, not proof of novelty or a universal
completion threshold. Match search breadth and full-text depth to the claim and
candidate. A rare topic may have few records; a mature topic may require broader
comparison to show that its proposed question has not already been answered.
Record source availability, search scope, closest prior work and unresolved
gaps. Retrieve methods evidence for designs you recommend. Do not pad citations
to meet a count, invent scores or sample sizes, or promote sparse retrieval into
a claim of novelty. Explain feasibility against the supplied resources; mark
missing information and incompatible conditions explicitly.

## Deliverables

Write `research-topic-report.md` with search scope, field map, evidence gaps,
candidate questions, design and data needs, feasibility, risks, prioritization,
and a recommended next step. Each candidate question carries a labelled
`新颖性：` / `Novelty:` line.

Write `evidence-map.md`, one row per work:

```
| Work | Identifier | URL | Channel | Axis | Used for | Full text |
|---|---|---|---|---|---|---|
| Tveit 2020, national TDM audit | PMID 31000417 | https://pubmed.ncbi.nlm.nih.gov/31000417/ | pubmed | comparator | population C/D percentiles for Q1 | yes |
```

`Used for` is the column that keeps this honest: a row that cannot say which
sentence depends on it should not be in the table.

Write `research-topic-run.json` with the terminal job state and exact returned
artifacts. When the job returns `research-portfolio.json`, preserve it as an
optional structured companion and copy the actual returned `evidence-records.json`
beside it in the final deliverable. Do not recreate its IDs from report prose.
Keep each candidate linked to its source
opportunity and evidence IDs, with the supplied researcher context, hypothesis,
study design/estimand, data requirements, falsification, feasibility and novelty
basis. Null fields and `gaps` mean information was not supplied; they are not
permission to invent it. Reconcile the companion with any candidate removed or
reframed after evidence expansion, keeping the original lineage and documenting
the reason. This optional companion adds no new required output or blocker.

## Before claiming completion

Run this capability's preflight to verify required paths and mapped citations,
and inspect proportional coverage diagnostics. Review novelty and feasibility
as evidence-based judgments; numeric counts cannot establish them.

```bash
python3 "scripts/preflight.py" --workspace .
```

It is this capability's tooling, not a second delivery gate: fix what it reports
as an issue, assess its advisory warnings,
then submit the package.

```
evimed_submit_deliverable{deliverableId: "<your deliverable id>"}
```

The submission answers with the delivery verdict in place. A first submission
that comes back with issues is the normal case, not a failure: fix everything it
lists as 必修 and submit again until it answers `ok`.

## Before delivering: two fixed steps

Both run on the finished deliverable, in this order, every time. They are steps
of this capability, not options the run weighs — a pass that happens only when
the model remembers it is a pass that happens on the easy runs and not the hard
ones.

1. **`traceability-review`** — every citation resolves, no number appears in
   prose without a source in the artifacts, and every figure or table matches
   the code that produced it. Findings are repaired before the next step, not
   after: humanizing prose around a citation that does not resolve only makes
   the defect read better.
2. **`manuscript-humanize`** — register cleanup over the prose, with every
   quotation, number, citation index and claim marker byte-identical. Load the
   language-matched upstream rules it names. It is the last thing that touches
   the document.

Write what changed and why to `revision-notes.md` in this deliverable's
directory. That file is the designated home for revision notes, replies to a
rejection, and process description; the report itself carries none of them, and
no check reads the notes as report prose.
