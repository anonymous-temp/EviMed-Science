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

`research_topic_selection` runs the topic agent, and that agent searches
**PubMed and nothing else**. Transcribing its output is how this skill produced
directions that were plausible, unranked against the field, and unpublishable:
nothing in them said what was already known, so nothing in them could say what
was new.

The job gives you a first map. The evidence expansion below is what turns it
into a judgment, and where the two disagree, say so — a candidate the job ranked
highly that the wider search shows was answered in 2024 is a finding.

## Execute

1. Preserve the user's disease, population, intervention or exposure, outcomes,
   available data, methods, and feasibility constraints. State only assumptions
   that do not materially change the direction.
2. Call `research_topic_selection` with `action=capabilities`, start the
   job, record the job id, and poll with `waitSeconds=45` until terminal.
3. Run the evidence expansion below **while the job runs** — it is long, and the
   two do not depend on each other.
4. Keep the evidence landscape, contradictions, candidate gaps, proposed study
   designs, feasibility, risks, and prioritization rationale distinct. A topic
   is not high priority merely because it sounds novel.
5. Do not fabricate search counts, citations, data availability, sample sizes,
   effect assumptions, or publication probability.
6. Use `pharmacy_reference_search` only when configured private
   terminology or rule coverage materially informs feasibility, phenotype or
   exposure definition, or data-readiness questions. Private rows are
   institution-specific discovery context, not proof of novelty, prevalence,
   clinical validity, or current guidance; verify material assumptions against
   current authoritative sources.

## Evidence expansion

There is no open-web search and no browser. Everything outside the workspace
arrives through the MCP tools — and they reach considerably more than PubMed.
Verified against the deployed host:

| Channel | Tool call | What only this one gives you |
|---|---|---|
| PubMed | `literature_search`, or `biomedical_source_search` with `sourceId: pubmed` | MeSH-indexed subject search; publication types |
| Europe PMC | `sourceId: europe-pmc` | **Full-text** search — a method or a limitation stated only in a Discussion section |
| OpenAlex | `sourceId: openalex` | Citation counts, concepts, publication year: how large a topic is and how fast it is moving |
| Semantic Scholar | `sourceId: semantic-scholar` | References and citing works — who built on a paper, and who did not. Rate-limited without a key; retry with backoff |
| Crossref | `sourceId: crossref` | Very recent DOIs, ahead of MEDLINE indexing |
| Preprints | `biomedical_source_search` with `sourceId: europe-pmc` and `SRC:PPR` in the query | What is being done right now and is not yet published. `sourceId: biorxiv`/`medrxiv` resolves a DOI you already have — it is a lookup, not a search |
| Full text | `open_access_full_text` | The actual Methods and Limitations paragraphs |
| Guidelines | `guideline_search`, `official_page_fetch` | What practice already recommends, and on what evidence grade |
| Drug and gene facts | `sourceId: dailymed` / `openfda` / `rxnorm` / `clinpgx-pharmgkb` | Label text, adverse-event counts, pharmacogenomic annotation |
| Trend analysis | `bibliometric_analysis` | Publication-volume curve, author and institution clusters, emergent terms |
| Open web | `web_search` | Everything the indexes do not carry — funding calls, conference programmes, society pages, registries, a method a group describes only on its own site |

`clinicaltrials.gov` and `arxiv.org` do not resolve from the deployed host. Do
not spend the run retrying them.

**`literature_search` returns titles and nothing else.** Its own warning
says a title does not establish study design, evidence level, outcome, or effect
size — so any statement about what a paper *found*, built on that call alone, is
invented. Use it to find candidates; use `biomedical_source_search`,
which returns abstracts, to read them; use `open_access_full_text` for
the ones a design actually depends on. This is the mechanism behind a report
that cites papers and says nothing about any of them.

Ask for more than the default ten per call. The limit goes to 50 on most
sources and 123 on the biomedical source search.

**Open-web results are unreviewed pages.** They widen a direction; they do not
support a claim. Anything you take from one has to be followed to its primary
record — and if it is published literature, re-found through
`biomedical_source_search` so it carries an identifier. A page cited as
though it were evidence is worse than no page.

Two categories behave differently and both are worth a call:

- `categories: ["science"]` reaches **arXiv** and PubMed reliably, and OpenAIRE
  publications and datasets intermittently — it answered 15 records on one probe
  and timed out on the next, so treat a miss as a miss and retry rather than as
  an absence. arXiv is the reason to bother: `export.arxiv.org` does not resolve
  through the source gateway at all, so this is the **only** channel here that
  reaches it. OpenAIRE, when it answers, carries EU project, funding and dataset
  records nothing else here does — which is where "who is already working on
  this, and on whose grant" shows up. PubMed through this route duplicates
  `biomedical_source_search`; prefer that one, which returns abstracts.
- `categories: ["general"]` reaches 360search and Baidu, and nothing else:
  Google, DuckDuckGo, Brave and Wikipedia do not resolve from this host, and
  Bing answers it but serves markup the aggregator cannot parse. **The general
  channel is Chinese-language-skewed**, so run the Chinese phrasing too — an
  English-only query under-samples what these two indexes hold.

The tool reports which engines answered. **A thin result set means few engines
answered, not that little exists** — never write "nothing found on the open web"
as a novelty argument. If the tool reports that open-web search is not configured, say so
and carry on with the bibliographic channels; an unavailable search is not an
empty field.

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

- **Unoccupied** — nothing addresses it. Say what makes that credible given the
  searches actually run, and name the closest neighbours you did find.
- **Occupied, but not in this population, setting, or era** — name the closest
  work and the exact axis of difference. Most real papers live here.
- **Answered** — drop it and say so. A direction removed because the field has
  settled it is a finding, not a failure.

"Clinically important" is not a novelty statement. The field agreeing that a
topic matters is the reason it may already be answered.

## Floors

Floors, not targets:

- **≥ 30 distinct works** across the deliverables, each with an identifier and a
  URL a reader can open.
- **≥ 5 distinct channels** from the table above.
- **≥ 5 full texts** actually retrieved and read.
- **≥ 2 methodological citations** for every question that reaches the agenda.

Do not pad. A work is cited because a sentence depends on it.

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
artifacts.

## Before claiming completion

Run the preflight and fix what it reports, then run it again until it returns
`ok`:

```bash
python3 "$XDG_CONFIG_HOME/opencode/skills/research-topic-selection/scripts/preflight.py" --workspace .
```

It checks the one thing a reader cannot: how much of the field was read before
the agenda was written.
