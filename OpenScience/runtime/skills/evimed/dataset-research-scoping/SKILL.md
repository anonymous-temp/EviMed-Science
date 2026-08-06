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
a letter does not de-identify it: `P11322133` reads like a pseudonym and is a
source `PATIENT_ID`. The same holds for case numbers, medical record numbers,
admission numbers, dates of birth, and names.

A production run wrote five real `PATIENT_ID`s through its deliverables this
way. Nobody reading them could tell, and the people exposed were not the reader.

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

## Phase 3 — Literature landscape

Go to the literature carrying the concrete findings of Phases 1–2, not the
general topic. Answer:

- What have others produced from comparable data, published where, at what n?
- What is the field's **standard criterion** (reference ranges, diagnostic
  criteria, reporting guideline)? Is this institution's data on the same one?
- Which directions are saturated, which are empty?
- Is there a reusable **methodological template**?

The single most valuable finding of the real run was of this kind: a national
TDM registry stratifies by the **25th/75th percentile of population
dose-normalized concentration** — a directly reusable comparator that answers
"how do I avoid treating a published mean as a gold standard".

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

**Decision rule: if any of the seven cannot be implemented from existing fields
and no external resource supplies it, the question is infeasible, and the
missing field must be named.** A verdict of "the data does not support this"
without naming what is missing is not a verdict.

This matrix satisfies TARGET items 6 and 7 directly.

## Phase 6 — Full design for what survives

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

It blocks on the four things a reader cannot check for themselves: an identifier
copied out of the source data, profile numbers that do not match the script that
claims to produce them, an infeasible verdict that does not name its missing
field, and a post-hoc power calculation. It warns on four more that a reader can
see: an unqualified fill rate, an unexplained blank in the seven-element matrix,
an external resource with no join key, and a preprocessing item with no stated
consequence.

It does not check how many questions you produced. The right number depends on
the data.
