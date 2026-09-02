---
name: dataset-research-scoping
description: Start from a dataset the researcher already holds, profile it mechanically, map it against the published literature, and decide which research questions it can and cannot support — naming the missing field for every question it cannot.
metadata:
  evimed-agent: dataset-research-scoping
---

# Dataset Research Scoping

Use this skill when the researcher **already has data** and needs to know what it
can support. The starting point is the file, not a research direction.

This is the opposite entry point from `research-topic-selection`, which takes a
broad direction and never touches data. Do not use this skill when there is no
dataset: a question about a field with no attached file is a topic-selection
request.

## Required skill stack

Load these before retrieving any literature:

1. `deep-research`
2. `biomedical-database-search`
3. `dataset-research-scoping`

Do not claim completion if any required skill fails to load.

## What this skill is for

The researcher's real process is: get data → understand its fields → read what
others did with comparable data → judge whether their data supports it → start.
Data-profiling tools do not read literature, literature tools do not read data,
and topic tools do not look at either. **The judgment this skill owes is the
join: what this dataset can carry, given what the field has already done.**

The deliverable is a set of **study designs**, each with its estimator, its
variable construction against named fields, and its pipeline proven by running
it on the data you were given. A verdict per candidate question is part of that,
not the point of it. A report that is mostly verdicts is a gatekeeper's report,
and the researcher did not ask for a gatekeeper.

## An extract is a schema sample, not a cohort

**The single most expensive mistake this skill has made.** A five-patient export
was read as a five-patient study population, so every question was judged
against n=5, every inferential design failed that test, and what survived was
two descriptive audits. An audit is not a paper. The researcher's hospital has
the same schema behind it with the whole census in it; what they handed you is a
sample of the *structure*.

Unless the researcher says the extract is the entire population, treat n as a
property of the export and not of the source system. That changes what you owe:

- **Never write "infeasible because n is small."** State the method, run it on
  the sample so the pipeline is proven and the code is real, and give the sample
  size the method needs at scale, derived — events per variable, Riley's
  criteria, the detectable effect at a stated α and power.
- A quantity computed on six observations is an **existence proof for the
  pipeline**, not an estimate. Report it as one, with its interval, and say so.
- The questions that scale is needed for are still the questions worth naming.
  Rank by scientific value first and by how much data they need second.

What n genuinely does bind is the *precision* of an estimate from this extract.
It does not bind whether the design is sound, whether the fields support it, or
whether it is worth doing.

## Never carry an identifier out of the data

Subjects are referred to by pseudonyms **you assign** — P1, P2, P3 in a stable
order — never by a value copied from the file. Prefixing a hospital number with
a letter does not de-identify it: `P90000001` reads like a pseudonym and is a
source `PATIENT_ID`. The same holds for case numbers, medical record numbers,
admission numbers, dates of birth, and names.

A production run wrote five real `PATIENT_ID`s through its deliverables this
way. Nobody reading them could tell, and the people exposed were not the reader.

**The mapping is the identifier.** A run wrote `{"pseudonyms": {"900004": "P1",
...}}` into a working file of its own, which hands back exactly what the
pseudonyms were assigned to hide. Derive the pseudonym in memory and never
write the correspondence to disk — not into a deliverable, not into a scratch
file, not into a script's output. The preflight scans every file left in the
workspace, not only the declared deliverables.

Identifiers of *sources* — PMID, PMC, DOI, NCT — are citations and belong in the
deliverables as they are.

## Phase 0 — Declare prior data contact

Before forming any hypothesis, record in `scoping-run.json`: which files were
received, which parts have been inspected, and whether the outcome variable's
distribution has already been seen.

Open-ended "what can this data do" exploration is precisely Gelman and Loken's
garden of forking paths: researcher degrees of freedom raise the error rate even
when only one analysis is finally run and nothing is intended as p-hacking. The
secondary-data preregistration templates (Weston 2019; Van den Akker 2021)
answer it by requiring a **prior data contact** declaration.

Profiling manufactures that obligation. **Write the declaration before the
profiling, because written afterwards it is worthless** — you would be recording
what you already know as though you had not known it.

## Phase 1 — Mechanical profiling, by script

For every column of every table produce: fill rate, distinct-value count,
inferred type, value vocabulary (complete for low-cardinality columns, most
frequent otherwise), and cross-table join reachability.

**This must be done by a script, and the script must be kept**, because every
number in the report has to be recomputable, and because the same structure can
then be re-profiled without redoing the work. `scripts/profile_dataset.py` in
this package does exactly this. Copy it into the workspace as `data-profile.py`
and run it there, so the deliverable regenerates from a deliverable:

```bash
cp "scripts/profile_dataset.py" data-profile.py
python3 data-profile.py <dataset files...> --json data-profile.json --markdown data-profile.md
```

It masks the values of identifier-shaped columns while still computing joins
from them, so the profile reports that a key has 1,284 distinct values and
reaches its target without ever printing one.

The formal vocabulary is *data profiling* (Abedjan 2015): single-column
profiling, **inclusion dependency discovery** (whether a join key's values are
actually contained in the target), and unique column combinations. "Data
reconnaissance" is not an established term; do not use it.

Report quality findings in `data-quality.md` under Kahn's harmonized
terminology (Kahn 2016), which FDA's 2024 real-world-data guidance adopts:

- **Conformance** — value, relational (**the cross-table constraint checks**), computational
- **Completeness** — how often a field is present, nothing about its values
- **Plausibility** — uniqueness, atemporal, temporal

each as **verification** (against metadata and local knowledge) or
**validation** (against an external benchmark).

**Whenever you report a fill rate, state which completeness you measured.**
Weiskopf 2013 identifies four mutually incompatible definitions —
documentation, breadth, density, predictive — measured differently. An
unqualified "completeness: 87%" does not say what it counted.

### Traps that have actually cost a run

Every row below was hit on real hospital data. Check each one explicitly.

| Trap | Real instance | Consequence if missed |
|---|---|---|
| **Local coding vocabulary** | `FREQUENCY` holds 30 values: `BID4`, `QD11`, `W4D8`, `ALWAYS` | Reading `10mg BID4` literally as 10 mg/day — **daily dose off by a factor of two** |
| **Dispensing mixed with administration** | 410 of 497 drug orders are `FREQUENCY=ONCE`, mostly discharge take-home | Discharge medication counted as the regimen in use on the sampling day |
| **Sentinel values** | `END_DATETIME = 0/0/0 00:00:00` in 11.5% of rows | Date parsing fails outright |
| **Empty join key** | Diagnosis table `PATIENT_ID` has **0% fill** | No patient-level analysis across admissions is possible |
| **Type differs across tables** | `AGE` is text `"56岁"` on the front page, numeric in labs | Joins fail silently |
| **Unsplit composite values** | Blood pressure stored `129/74`; comorbidities pipe-delimited | Not directly computable |
| **Ambiguous date order** | 517 of 915 `START_DATETIME` values have both leading parts ≤ 12 | Guessing wrong silently reorders every timeline the designs rest on |
| **Several coding systems in one column** | `DIAGNOSIS_CODE`: 27 ICD-10 rows beside 16 rows of two Chinese TCM code families | A quarter of the rows map to nothing, and the flag column does not separate them reliably |
| **Timestamp is order entry, not administration** | Bedtime (QN) orders share QD's entry-hour profile; no nightly order is entered at night | Time since dose computed from it is wrong for every row |
| **Physiologically impossible value** | One blood pressure recorded as `126/7` | Passes every type and range check that does not know physiology |

`data-quality.md` must end with two tables, in this order.

**The mandatory preprocessing list**, each item naming the downstream analysis
that breaks if it is skipped.

**The field-usage table**, which is what the researcher actually hands to their
information department: one row per field, giving which design consumes it, the
preprocessing it requires, and — where the trap is subtle — the one sentence that
prevents the misuse. The rows that earn this table are the ones where the obvious
reading is wrong: *use the date part only, the time is when the order was
entered, not when the drug was given*; *the gram unit marks herbal items and the
milligram unit western ones, so the column must be split before any dose is
summed*; *strip the padding before grouping, or one concept counts as several*.

Close it with what to **request at full scale**: the fields the designs need that
this extract does not carry, ordered by how much they unlock. One of them is
usually worth more than all the others together — name it and say why.

## Phase 2 — Domain-derived quantities

Fill rates do not tell you whether there is signal. Compute the quantities that
actually carry information **in this domain** and look at their spread and
distribution.

Which quantities matter is domain-specific and this skill does not ship a
catalogue of them — a therapeutic-drug-monitoring dataset wants dose-normalized
concentration, metabolite-to-parent ratio, steady-state attainment and position
within the reference range; a survival dataset wants follow-up completeness and
censoring pattern; a laboratory dataset wants reference-interval deviation.
Derive them from the domain and from Phase 3, and say why each is the quantity
that carries the signal.

**But three kinds are not optional, because they are what the rest depends on,
and a run that skipped all three produced a report with nothing in it:**

1. **Every identity the schema implies, run and reported with counts.** If a
   table holds a parent, a metabolite and a total, check that the total is the
   sum — on the real TDM extract it held in 6 of 6 sets, which is what licenses
   using any of the three. If a stay has an admission date, a discharge date and
   a length, check they agree. If a value has a reference range in its own row,
   check the value against it. These cost minutes and they decide whether the
   numbers can be used at all.
2. **The mechanism proxy the domain already gives you.** A ratio between two
   measured species is usually a phenotype. On the real extract, the
   dehydro-aripiprazole to aripiprazole ratio ran 0.174 to 0.492 — a 2.8-fold
   spread — and that ratio *is* the CYP2D6 activity phenotype, so the run that
   declared prediction impossible "because there is no genotype" had the
   phenotype in its hands and never computed it. Before writing that a covariate
   is absent, ask what in the data stands in for it.
3. **The exposure quantity, reconstructed rather than assumed missing.** Daily
   dose comes from the order in force on the sampling date, not from a
   dose field on the lab row. On the real extract this gave C/D of 7.99 to 23.60
   ng/mL per mg/day across five subjects, and one subject sampled twice at an
   unchanged 20 mg/day moved 317 to 400 ng/mL — a 26% within-subject shift that
   bounds what any single measurement can mean. Both numbers came from joining
   two tables that a field inventory reports as unrelated.

This phase is what decides whether there is anything here at all. Report every
derived quantity **as a number**, not as an intention.

## Phase 2b — Make the expansion visible

A list of derived quantities is not a research programme, and a report that
presents one reads as a menu. What the researcher wants to see is **how one
measurement opens into a field** — and the honest way to show it is to write the
expansion down as a structure, layer by layer, each layer opened by a named
quantity or a named join.

The real one, from the TDM extract, ran six layers deep from a single number:

| Layer | The move | What it opened |
|---|---|---|
| 0 | one concentration measurement | a scalar, and nothing else |
| 1 | the assay also reports the metabolite | parent–metabolite pair, so a ratio exists |
| 2 | the ratio is the enzyme's activity phenotype | a stratifying variable that no field inventory shows |
| 3 | join to the order in force on the sampling date | dose-normalised exposure; between- separates from within-subject |
| 4 | the same subject sampled twice; the order that follows a result | cross-section becomes an individual time series |
| 5 | vitals as longitudinal outcome; dated diagnosis codes as events | the drug's effect on the person becomes observable |
| 6 | reference ranges, registry percentiles, spontaneous reports | an external coordinate system for every internal number |

Two properties make this worth writing rather than merely doing. **Each layer is
a claim that can be checked** — layer 2 stands or falls on whether that ratio is
an accepted phenotype marker, and that is a citation, not an opinion. And **the
layers are what connect the topics**: the questions in the portfolio are not a
list of unrelated ideas, they are the layers cashed out, which is why they share
variable constructions and why one of them is usually a prerequisite for the
others.

Write it as its own section. If the expansion stops at layer two, the report is
thin and the structure will show that before a reader has to.

## Phase 3 — Evidence expansion

Go to the literature carrying the concrete findings of Phases 1–2, not the
general topic.

**One database is not a landscape.** The run this phase was rewritten for
searched PubMed and nothing else, retrieved twelve works, and produced a
portfolio that was defensible and unremarkable: no argument that any direction
in it was new, and not one citation a reader could open. Breadth is not
decoration. Whether a question is worth asking is a claim about the *field*, and
a claim about the field made from one index is a guess.

### The channels that are actually reachable

There is no open-web search and no browser. Everything outside the workspace
arrives through the MCP tools — and they reach considerably more than PubMed.
Verified against the deployed host:

| Channel | Tool call | What only this one gives you |
|---|---|---|
| PubMed | `literature_search`, or `biomedical_source_search` with `sourceId: pubmed` | MeSH-indexed subject search; publication types (RCT, guideline, review) |
| Europe PMC | `sourceId: europe-pmc` | **Full-text** search — a method buried in a Methods section that no title or abstract mentions |
| OpenAlex | `sourceId: openalex` | Citation counts, concepts, publication year — how large a topic is and how fast it is moving |
| Semantic Scholar | `sourceId: semantic-scholar` | References and citing works: the ancestry and the descendants of a method. Rate-limited without a key — retry with backoff |
| Crossref | `sourceId: crossref` | Very recent DOIs, ahead of MEDLINE indexing |
| Preprints | `biomedical_source_search` with `sourceId: europe-pmc` and `SRC:PPR` in the query | What is being done right now and is not yet published. `sourceId: biorxiv`/`medrxiv` resolves a DOI you already have — it is a lookup, not a search |
| Full text | `open_access_full_text` | The actual Methods paragraph rather than its abstract |
| Guidelines | `guideline_search`, `official_page_fetch` | The standard this institution's data has to be judged against |
| Drug and gene facts | `sourceId: dailymed` / `openfda` / `rxnorm` / `clinpgx-pharmgkb` / `mesh` | Label text, adverse-event counts, ingredient normalization, pharmacogenomic annotation |
| Trend analysis | `bibliometric_analysis` | Publication-volume curve, author and institution clusters, emergent terms |
| Direction analysis | `research_topic_selection` | Contradictions and breakthrough points across a whole direction |
| Open web | `web_search` | Everything the indexes do not carry — funding calls, conference programmes, society pages, registries, a method a group describes only on its own site |

`clinicaltrials.gov` and `arxiv.org` do not resolve from the deployed host. Do
not spend the run retrying them; `isrctn` and Europe PMC carry some of the same
registered work.

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

### Four axes, not one

Search every candidate direction four ways. A missing axis is what makes a
portfolio thin:

1. **Subject** — the clinical question as asked.
2. **Method for the gap** — the missing field itself as the search term.
   Unknown sampling time, coded dose regimen, unwitnessed administration, no
   outcome scale, single-digit n: for each of these someone has published what
   they did. A gap you have only reasoned about is a gap you are guessing at; a
   gap with a published treatment is a design choice with a citation. This is
   the difference between "the field is missing so the study is impossible" and
   "here is how three groups handled the same missing field, and which
   transfers."
3. **Comparator** — the number your result will be placed against: reference
   ranges, population percentiles, registry distributions. Without one a finding
   has nothing to be compared to and cannot be interpreted.
4. **Absence** — what is registered, preprinted, or called for in a review but
   not yet answered. An unoccupied question shows up here and nowhere else.
5. **Another field entirely** — the same *methodological* problem, solved
   somewhere with no clinical overlap at all. This is the axis runs skip, and
   skipping it is what makes a bibliography look narrow even at fifty works: all
   fifty are about the same disease.

### Search the method outside its specialty

A run assembled forty-nine works on psychiatric drug monitoring and the reader's
verdict was still that the literature was thin — correctly, because every one of
them was about psychiatric drug monitoring. Breadth of *works* is not breadth of
*thinking*.

The methodological problems in a dataset are almost never specialty-specific.
Concentration-guided dosing is solved daily in oncology, infectious disease, and
transplantation; unknown sampling times are routine in population
pharmacokinetics; sparse repeated measures are the whole of pharmacometrics;
irregular longitudinal outcomes are core to critical-care informatics; small-n
inference with a phenotype proxy is standard in pharmacogenomics. **For each
method a design depends on, run one search in a field that does not share this
one's disease**, and say in the evidence map which field it came from.

The transfer is what you are looking for, not the paper: the estimator, the
validation scheme, the way that field handles the gap this dataset has. Name
what transfers and name what does not — a method borrowed without its
assumptions is worse than a method not borrowed.

Mark the field of origin on every row of the map. If every row says the same
specialty, axis 5 was not run.

### The novelty ledger

For every candidate question, write down **what already answers it, at what n,
in which population, published where and when — and what precisely is left.**
That is the publishability argument. Without it a direction is only something
that can be computed. Three outcomes are all legitimate and each has to be said
out loud:

- **Unoccupied** — nothing addresses it. Say what makes that credible given the
  searches actually run, and name the closest neighbours you did find.
- **Occupied, but not in this population, setting, or era** — name the closest
  work and the exact axis of difference. This is where most real papers live.
- **Answered** — drop it, and say so. A direction removed because the field has
  already settled it is a finding, not a failure.

### Floors

Floors, not targets. A package under any of them is not a landscape:

- **≥ 30 distinct works** across the deliverables, each with an identifier and a
  URL a reader can open. Bare `PMID 12345678` with no link makes the reader do
  the retrieval you were asked to do.
- **≥ 5 distinct channels** from the table above.
- **≥ 5 full texts** actually retrieved and read, marked as such.
- **≥ 2 methodological citations** for every surviving question — papers about
  how to do it, not about the disease.

Do not pad. A work is cited because a sentence depends on it. A bibliography of
things nobody used is worse than a short one, which is why the map has to say
what each work was used for.

### Mark what you verified

A report mixing citations you opened with citations a tool handed you, without
saying which is which, cannot be acted on: the reader has to re-check everything
or trust everything. **Carry a two-level mark through the whole document** — one
symbol for facts verified against the source during this run, another for facts
carried from a search result and not re-opened — and define the marks where they
first appear. This costs nothing and it is the difference between a report a
researcher can build on and one they have to redo.

Then answer:

- What have others produced from comparable data, published where, at what n?
- What is the field's **standard criterion** (reference ranges, diagnostic
  criteria, reporting guideline)? Is this institution's data on the same one?
- Which directions are saturated, which are empty?
- Is there a reusable **methodological template**?

The single most valuable finding of the real run was of this kind: a national
TDM registry stratifies by the **25th/75th percentile of population
dose-normalized concentration** — a directly reusable comparator that answers
"how do I avoid treating a published mean as a gold standard".

Write the landscape into `evidence-map.md`, one row per work:

```
| Work | Identifier | URL | Channel | Axis | Field | Used for | Full text |
|---|---|---|---|---|---|---|---|
| Jönsson 2019, national TDM registry | PMID 31000417 | https://pubmed.ncbi.nlm.nih.gov/31000417/ | pubmed | comparator | psychiatry | 25th/75th percentile C/D comparator for Q1 | yes |
| Neely 2014, sparse-sampling Bayesian dose control | PMID 24936813 | https://pubmed.ncbi.nlm.nih.gov/24936813/ | pubmed | another field | infectious disease | the estimator Q1 borrows for unknown draw times | yes |
```

`Used for` is the column that keeps this honest: a row that cannot say which
sentence depends on it should not be in the table.

## Phase 4 — External linkage map

For each usable public resource state: **which field joins it, at what
granularity, and what it then answers that this dataset alone cannot.** Name the
resource and the join key. "Search the literature" is not a linkage.

Standard vocabularies are the infrastructure here: ATC/RxNorm for drugs,
ICD-10/SNOMED for diagnoses, LOINC for laboratory tests — **LOINC carries no
units, so pair it with UCUM**; one LOINC code can receive both mg/dL and mmol/L.

State the cost of each mapping. OMOP's own documentation warns that "up-hill"
mapping loses semantic precision; its example is ICD-9 *bitten by goose*
mapping to SNOMED *pecked by bird*.

## Phase 4b — The analysis families, every one of them, on the record

A run that never asks whether prediction is on the table will not produce a
prediction question, and the report will read as though the data could not
support one. That is what happened: a run deleted the metabolic-side-effect
question for want of "代谢实验室参数" while 22 longitudinal weight records sat
in the vitals table, and deleted the herb-drug question for want of "中药暴露
定量" while every herb order carried a dose in grams, a route, and a date.

**Walk this list explicitly and record a line for each**, before the matrix.
Say which fields it would consume, what it would answer, and — only if it truly
is — why it is off the table. "Not considered" is not an allowed state.

| Family | The question it asks | What it consumes |
|---|---|---|
| **Prediction / modelling** | Predict a measured quantity, or the dose that achieves it, or who lands outside a target | measured values as *features*, not only as outcomes; covariates; a validation scheme |
| **Class-level comparison** | Behaviour of a whole drug or disease class rather than one member | each member placed against its own reference or equivalent-dose scale |
| **Association mining** | What co-occurs with what, at what lift | order, diagnosis and procedure sets as baskets |
| **Causal inference** | Effect of an exposure on an outcome, not their correlation | a defensible time zero, measured confounders, an estimator |
| **Pharmacovigilance / ADR** | Which harms show up, at what rate, against which exposure | longitudinal vitals and labs, symptomatic-treatment proxies, external spontaneous-report data |
| **External linkage** | What a public resource adds that this data alone cannot | a join key and a vocabulary |
| **Multi-library synthesis** | Where the published record disagrees with itself, and where this data sits in it | the Phase 3 evidence base as a distribution, not a reading list |
| **Descriptive** | The distribution or the process, estimated and positioned against an external one | anything |

Two rules about that last row. **A purely descriptive design is the last
resort, never the default** — if it is what you propose, say which of the rows
above you ruled out and on what evidence. And a *proxy outcome you construct* is
a real outcome: an anticholinergic prescription standing in for extrapyramidal
symptoms, a weight trajectory standing in for metabolic effect, a repeat
measurement standing in for assay reproducibility. A run that writes "no outcome
field" without having looked for a proxy has not finished this phase.

## Phase 5 — Candidate question × target-trial matrix

**This is the verdict step.**

For every candidate question, fill in all seven target-trial elements (Hernán
2016; TARGET reporting guideline, Cashin 2025) and mark, for each, whether this
dataset can implement it, with which field, and if not, what is missing:

```
Question A: ...
  Eligibility criteria → ✅ MAIN_DIAGNOSIS_CODE + IN_DATE
  Treatment strategies → ⚠️ inferable from orders only; no administration record
  Assignment procedure → ✅ observational, by actual prescription
  Time zero            → ❌ no administration timestamp; cannot align with sampling
  Outcomes             → ❌ no rating-scale field
  Causal contrast      → ——
  Analysis plan        → ——
Verdict: infeasible. Missing fields: administration/sampling timestamps, outcome scale.
```

The requirement that eligibility, treatment assignment and follow-up start all
align at **one time zero** is what makes this mechanical rather than a matter of
opinion. Writing it against real data immediately exposes whether there is a
determinable eligibility date, an actual start-of-therapy date rather than an
"ever exposed" flag, dated outcomes rather than status only, and covariates
measured before time zero. Misalignment is the source of immortal time bias —
**a design defect caused by a missing field, not something a later statistical
adjustment repairs.**

### A missing field is a hypothesis, not a verdict

**Before calling anything infeasible you must show that the missing element
actually binds — quantitatively, on this drug and this design.** A general rule
about what a method "requires" is a starting point, not a finding.

The failure this exists to prevent happened on a real run. It judged
model-informed precision dosing impossible because sampling times were absent,
citing the general requirement. Aripiprazole has a half-life near 75 h and was
dosed once daily, so within a dosing interval the concentration moves by roughly
`exp(-ln2 × 24/75) ≈ 0.80` — about 20% — while the between-subject spread it
had just measured in the same data was 2.7-fold. The unknown it refused over was
an order of magnitude smaller than the signal it was studying. The rule is real;
it simply does not bind here. For a drug with a two-hour half-life it would.

So for each of the seven elements that cannot be read straight from a field:

1. **Quantify what the gap costs.** Compare it against the effect being studied,
   in the same units. Half-life against dosing interval; assay CV against
   between-subject spread; decoding ambiguity against the contrast of interest.
2. **State the assumption that closes it and test it.** An unknown draw time
   becomes an interval; a coded frequency becomes a set of decodings; unwitnessed
   administration becomes an adherence range. Carry each through as a sensitivity
   analysis and report the range of the answer, not a point.
3. **Only if the answer changes materially across that range is the question
   infeasible** — and then name the missing field.

**Every infeasible verdict must also carry the strongest question the data can
still answer**, with its assumption and its cost stated. "Cannot estimate the
exposure-response slope" and "can estimate the exposure distribution and bound
the slope's sign under stated adherence" are different findings, and only the
second is useful to the researcher who owns the data.

A verdict of "the data does not support this" that names no missing field is not
a verdict. One that names a field without showing it binds, and without the
fallback, is a refusal wearing a verdict's clothes.

This matrix satisfies TARGET items 6 and 7 directly.

## Phase 6 — What, why, and how, for what survives

A scoping report that stops at "this is feasible" has done half the job. The
researcher's next question is always the same — *so how do I actually run it* —
and an answer that cannot be handed to someone else to execute has not answered
it. Each surviving question therefore needs all three:

- **What** — the scientific question, stated so it could be pre-registered.
- **Why** — carried over from the Phase 3 novelty ledger and written on its own
  labelled line, `新颖性：` or `Novelty:`, in `research-portfolio.md`: the
  closest published work with its citation, the axis on which this differs, and
  what a reader gets that they could not already get. Every question that
  survives owes one. "Clinically important" is not a novelty statement — the
  field agreeing that a topic matters is the reason the question may already be
  answered.
- **How** — an executable protocol: eligibility, the construction algorithm for
  every variable naming the exact source field and derivation rule, the analysis
  plan with its estimator and its handling of missing and sentinel values, the
  sensitivity analyses that carry the Phase 5 assumptions, the tables and figures
  with what each one answers, and the reporting-guideline mapping.

### One topic, three pieces, in `research-portfolio.md`

The researcher reads this file to decide what to work on, so it is organised by
topic and not by artefact. **Give each surviving topic its own section carrying
all three of these, in this order:**

1. **小综述 / Mini-review** — 400 to 800 words of actual prose, not a table.
   What the field has established, where it disagrees with itself, what the
   closest works found and at what n, and which method from *another field*
   (Phase 3 axis 5) this design borrows. Cite as you go, every citation
   resolvable. This is the section that tells the researcher whether the topic
   is worth their year, and it is the one a reader notices is missing.
2. **思路 / The reasoning** — how the topic was arrived at from this data: which
   derived quantity made it visible, what the alternative framings were, why
   this one, and what would change the answer. Written as reasoning, in
   sentences. A design whose origin cannot be retraced cannot be argued for in
   front of a reviewer.
3. **研究方案 / The design** — the estimator, the variable construction against
   named fields, the validation scheme, the minimum detectable effect and
   expected interval width, the principal biases and their handling, the sample
   size needed at scale, the novelty statement, and the target journal.

### The words are part of the design

A topic titled "TDM 采样实践审计" was rejected by the researcher with "这是学术语言吗"
— and they were right. `审计` / *audit* is a compliance word, not a scientific one, and
this skill had put it there: it named a whole deliverable that way and the runs
learned the register from it. Vocabulary is not decoration. A title in the wrong
register tells a reviewer the work is administrative before they read a line.

Name a topic after **the question it answers or the quantity it estimates**, never
after the activity performed. `采样实践审计` is an activity; `常规 TDM 记录中稳态达标率
的估计及其与群体分布的偏离` is a question. Words to keep out of a topic title
entirely: 审计 / audit, 梳理, 摸底, 盘点, 情况分析, 现状调查 — every one of them
describes what the analyst did rather than what the reader learns.

The same applies inside the text. Write "本院的稳态达标率为 x%（95% CI …），
低于注册库同剂量带的 y%" — not "对采样规范性进行了审计".

**Aim for five or six topics, not nine and not two.** Nine is a list nobody
prioritises; two is a refusal. Merge topics that share an estimator and a data
path — they are one paper with two analyses, not two papers — and drop what the
mini-review shows is answered. Say what you merged and what you dropped.

The full executable protocol still goes into `study-protocol.md`, one section per
feasible question. It must be specific enough that a second analyst could execute
it without asking you anything: field names, thresholds, and decision rules, not
"an appropriate
sensitivity analysis should be performed".

State each protocol's **preconditions and stopping conditions** — what must be
true before it starts, and what would make it right to abandon it midway.

## Phase 6b — Full design for what survives

For each feasible question: the scientific question, how each variable is
constructed (including the exact construction of any proxy), the study design,
the **minimum detectable effect and expected confidence-interval width**, the
principal biases and how they are handled, the external evidence base for
comparison, and the intended publication venue.

**Never compute post-hoc power.** The data exists and n is not a choice.
Observed power is a monotone function of the p-value and carries no additional
information (Hoenig & Heisey 2001); plan by precision instead (Bland 2009). The
correct output is the **minimum detectable effect** at a stated α and target
power given the available n, plus the expected interval width for the target
estimand. Bound model complexity with events per variable.

STROBE item 10 asks how the sample size was arrived at; for a fixed dataset the
honest answer is "determined by the available data", accompanied by the MDE.

Then give the **infeasible list**: what is missing, whether an external resource
could supply it, and if not, why.

Check before promising a study that it is reportable at all. RECORD 6.2 requires
that codes used to select the population cite their validation study; RECORD 7.1
requires the complete code list for exposures, outcomes, confounders and effect
modifiers; RECORD 12.3 requires the linkage method and its quality assessment;
RECORD-PE 7.1.c requires the exposure time window and the extent of left
truncation and censoring; RECORD-PE 19.1.a requires how completely the database
captures the drug exposure of interest. **A study that cannot supply one of
these is unreportable however good its numbers look.**

## Phase 7 — Where each topic gets published

Naming a journal in one line at the end of a design is not placement, and a
journal named without checking its standing is worse than none — the researcher
acts on it. Placement is its own step and it has three parts.

### Ask for the tier, then verify it

The bar is the researcher's, not yours. Ask, or read it from the request. When
Chinese partitions are the currency, the usual forms are 中科院分区小类二区以上
(CAS narrow-category tier 2 or better), sometimes with 大类 allowed to be one
tier lower, and **就高不就低** — where the broad and narrow categories disagree,
the higher one is what is claimed.

**Verify every partition against a source and say so.** They are not derivable
from the impact factor, they differ between the broad and narrow category of the
same journal, and they are re-issued annually with basic and upgraded editions
that disagree. State the edition you used and tell the researcher to confirm
against the one their institution recognises.

Do not aim above the bar either. A tier-1 journal wants a cohort and a question
this data cannot carry, and recommending one wastes a submission cycle.

### The framing decides the tier, not the content

This is the finding that matters most, and it emerged from a real check: the
specialty journals of a methodological field are often ranked *below* the
general journals of the clinical field it serves. Every pharmacokinetics and
therapeutic-drug-monitoring journal checked sat at tier 3 or lower, while the
psychopharmacology journals that would take the same study sat at tier 2.

So the same study lands in different tiers depending on how its question is
stated. Written as "a population pharmacokinetic model of drug X" it is a
pharmacokinetics paper; written as "what the co-prescribed drugs actually
measure at" it is a psychopharmacology paper. The data, the estimator and the
result are identical.

**Say this explicitly for each topic**: which framing was chosen, and what the
alternative framing would cost or gain. A researcher who understands that the
tier is a writing decision can make it themselves next time.

### Every recommendation carries a comparable manuscript

Name **a paper that journal has already published which resembles the proposed
study**, and say what resembles it. This does two things a rationale cannot: it
proves the fit rather than asserting it, and it hands the researcher a template
— that paper's structure, its choice of comparator, and the way its discussion
is organised are what the editor expects.

The ideal case is a comparable that is close on the *data structure* rather than
on the topic. The strongest one found in a real run was a paper fitting a parent
drug and its metabolite simultaneously — a different drug, but exactly the data
shape the new study had, so the whole modelling section transfers.

### A topic that cannot be placed is replaced, not defended

If a topic has no home at the required tier, that is a finding about the topic,
not a problem to argue around. Process-quality and practice-conformance
questions are the usual casualties: they are worth doing and hard to publish in
clinical journals at tier 2.

**Go back to Phase 4b and take another one.** The data almost always supports
more designs than the report has room for, and the replacement is usually
stronger, because a topic that a journal wants is a topic with a readership.
Say what was replaced and why — the researcher may still want the unplaceable
question done for their own institution.

### A novelty pattern worth looking for

When looking for a replacement, the most reliable source of a placeable topic is
this: **find where the published field measures a proxy and this data measures
the thing itself.** Whole literatures are built on counting what could have been
measured — how many drugs were co-prescribed, rather than what each one reached;
whether a patient was exposed, rather than to how much. If the data holds the
measurement behind the field's proxy, the topic writes itself, and its novelty
statement is one sentence long.

## Deliverables

| File | Content |
|---|---|
| `data-profile.md` | Per table, per column: fill rate, cardinality, type, vocabulary, join reachability |
| `data-profile.json` | The same profile, machine-readable — what the preflight recomputes and compares |
| `data-profile.py` | The script that produced both, runnable again |
| `data-quality.md` | Findings classified by Kahn category, the mandatory preprocessing list, and the **field-usage table**: per field, which design consumes it, the preprocessing it needs, and what to request at full scale |
| `evidence-map.md` | One row per work: identifier, URL, channel, axis, **field of origin**, what it was used for, full text read |
| `feasibility-matrix.md` | Candidate question × the seven target-trial elements, with a verdict each |
| `external-linkage.md` | Resource, join key, granularity, and what it adds |
| `research-portfolio.md` | Five or six topics, each with its 小综述, its 思路, its 研究方案 and its **verified journal placement with a comparable manuscript** — plus the infeasible list with named missing fields |
| `scoping-run.json` | Run receipt: data fingerprint, search record, **prior data contact declaration** |

Phases 0–4 feed Phases 5–6. Do not skip ahead to candidate questions.

### The deliverables are sections of one document

The files are how the work is stored; a document is how it is read. A researcher
handed nine markdown files reads none of them. Assemble the portfolio so it can
be printed and circulated, in this order, and say so in its opening lines:

1. **摘要** — the three findings that unlocked everything, with their numbers,
   and the count of directions that follow.
2. **数据与字段** — what the schema is, table by table, and what each carries.
3. **编码规范与治理发现** — the traps, each with its count. This belongs early:
   it tells the reader which of the later numbers they can trust.
4. **派生量与一致性校验** — the identities, the mechanism proxy, the
   reconstructed exposure. Every number recomputable from the shipped script.
5. **展开结构** — Phase 2b, one measurement to a field.
6. **研究方向** — five or six, each with 小综述 / 思路 / 研究方案.
7. **投稿目标** — Phase 7, with partitions verified and comparables named.
8. **跨领域方法借鉴** — what was borrowed, from where, and what does not transfer.
9. **字段使用总表** — the attachment for the information department.
10. **全量数据需求** — what to ask for, ordered by what it unlocks.
11. **局限** — specific, and never used as a reason to refuse a design.
12. **实施次序** — which direction to run first and why, and which is
    prerequisite to which.

The order is not arbitrary: it puts what can be checked before what rests on it,
so a sceptical reader can stop at any point and know exactly how much of the
report they have accepted.

## Before claiming completion

Run the preflight and fix everything it reports, then run it again until it
returns `ok`:

```bash
python3 "scripts/preflight.py" --workspace .
```

It blocks on what a reader cannot check for themselves: an identifier copied out
of the source data, profile numbers that do not match the script that claims to
produce them, an infeasible verdict that does not name its missing field, a
post-hoc power calculation, and the Phase 3 floors — how many works, how many
channels, how many full texts, how many of them a reader can open, and whether
every surviving question carries a novelty statement. Nobody holding the report
can see which searches were never run.

It warns on four a reader can see: an unqualified fill rate, an unexplained
blank in the seven-element matrix, an external resource with no join key, and a
preprocessing item with no stated consequence.

It does not check how many questions you produced. The right number depends on
the data. It does check how much of the field you looked at before deciding,
because that number does not depend on the data at all.
