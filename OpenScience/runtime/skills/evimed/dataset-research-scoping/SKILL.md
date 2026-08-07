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

The deliverable is not a list of ideas. It is a verdict per candidate question,
and for every question judged infeasible, **the specific field that is missing**.

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
cp "$XDG_CONFIG_HOME/opencode/skills/dataset-research-scoping/scripts/profile_dataset.py" data-profile.py
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

`data-quality.md` must end with a **mandatory preprocessing list**, each item
naming the downstream analysis that breaks if it is skipped.

## Phase 2 — Domain-derived quantities

Fill rates do not tell you whether there is signal. Compute the quantities that
actually carry information **in this domain** and look at their spread and
distribution.

This skill deliberately ships **no catalogue of per-domain quantities**. What
matters is domain-specific — a therapeutic-drug-monitoring dataset wants
dose-normalized concentration, metabolite-to-parent ratio, steady-state
attainment and position within the reference range; a survival dataset wants
follow-up completeness and censoring pattern; a laboratory dataset wants
reference-interval deviation. Derive them from the domain and the literature of
Phase 3, and state why each one is the quantity that carries the signal.

This phase is what decides whether there is anything here at all. On the real
TDM data it was this step — not the field inventory — that found a 2.7-fold
spread in dose-normalized concentration, and that only 1 of 6 samples could be
confidently called steady-state.

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
| PubMed | `evimed_literature_search`, or `evimed_biomedical_source_search` with `sourceId: pubmed` | MeSH-indexed subject search; publication types (RCT, guideline, review) |
| Europe PMC | `sourceId: europe-pmc` | **Full-text** search — a method buried in a Methods section that no title or abstract mentions |
| OpenAlex | `sourceId: openalex` | Citation counts, concepts, publication year — how large a topic is and how fast it is moving |
| Semantic Scholar | `sourceId: semantic-scholar` | References and citing works: the ancestry and the descendants of a method. Rate-limited without a key — retry with backoff |
| Crossref | `sourceId: crossref` | Very recent DOIs, ahead of MEDLINE indexing |
| Preprints | `sourceId: biorxiv` / `medrxiv` | Work the peer-reviewed record does not carry yet |
| Full text | `evimed_open_access_full_text` | The actual Methods paragraph rather than its abstract |
| Guidelines | `evimed_guideline_search`, `evimed_official_page_fetch` | The standard this institution's data has to be judged against |
| Drug and gene facts | `sourceId: dailymed` / `openfda` / `rxnorm` / `clinpgx-pharmgkb` / `mesh` | Label text, adverse-event counts, ingredient normalization, pharmacogenomic annotation |
| Trend analysis | `evimed_bibliometric_analysis` | Publication-volume curve, author and institution clusters, emergent terms |
| Direction analysis | `evimed_research_topic_selection` | Contradictions and breakthrough points across a whole direction |

`clinicaltrials.gov` and `arxiv.org` do not resolve from the deployed host. Do
not spend the run retrying them; `isrctn` and Europe PMC carry some of the same
registered work.

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
| Work | Identifier | URL | Channel | Axis | Used for | Full text |
|---|---|---|---|---|---|---|
| Jönsson 2019, national TDM registry | PMID 31000417 | https://pubmed.ncbi.nlm.nih.gov/31000417/ | pubmed | comparator | 25th/75th percentile C/D comparator for Q1 | yes |
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

Write the protocol into `study-protocol.md`, one section per feasible question.
It must be specific enough that a second analyst could execute it without asking
you anything: field names, thresholds, and decision rules, not "an appropriate
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

## Deliverables

| File | Content |
|---|---|
| `data-profile.md` | Per table, per column: fill rate, cardinality, type, vocabulary, join reachability |
| `data-profile.json` | The same profile, machine-readable — what the preflight recomputes and compares |
| `data-profile.py` | The script that produced both, runnable again |
| `data-quality.md` | Findings classified by Kahn category, ending in the mandatory preprocessing list |
| `evidence-map.md` | One row per work: identifier, URL, channel, axis, what it was used for, full text read |
| `feasibility-matrix.md` | Candidate question × the seven target-trial elements, with a verdict each |
| `external-linkage.md` | Resource, join key, granularity, and what it adds |
| `research-portfolio.md` | Full design per feasible question + the infeasible list with named missing fields |
| `scoping-run.json` | Run receipt: data fingerprint, search record, **prior data contact declaration** |

Phases 0–4 feed Phases 5–6. Do not skip ahead to candidate questions.

## Before claiming completion

Run the preflight and fix everything it reports, then run it again until it
returns `ok`:

```bash
python3 "$XDG_CONFIG_HOME/opencode/skills/dataset-research-scoping/scripts/preflight.py" --workspace .
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
