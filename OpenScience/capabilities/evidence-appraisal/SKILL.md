---
name: evidence-appraisal
description: Appraise a set of studies the researcher already holds — design, risk of bias, indirectness, imprecision per study — and roll them up into one certainty judgement per outcome.
metadata:
  evimed-agent: evidence-appraisal
---

# Evidence appraisal

Use this skill when someone hands you studies and asks **how good they are**.
The studies are the input. You are not being asked to find literature; you are
being asked what the literature they already have is worth for the question they
are asking it.

If the request is "what does the evidence say about X", that is synthesis, not
appraisal — it belongs to `clinical-evidence-synthesis`, which searches. The
line between the two is whether the studies arrived with the request.

Unless the user asks otherwise, work and write in Simplified Chinese. Keep study
titles, journal names, registry numbers, instrument names, effect estimates and
their units in the original form — a translated confidence interval is one
nobody can check.

---

## The studies are given, and they stay given

Every study handed to you appears in `appraisal-table.json`. All of them. A
study that turns out to be weak is a row that says so; a study you could not
appraise is a row with `appraised: false` and a `notAppraisedReason` giving what
stopped it — no full text, retracted, wrong population, a conference abstract
with no method section.

**Never substitute.** Replacing a poor study with a better one you found is the
single most damaging thing available here, because the researcher's next
sentence is "so my nine papers support this" and three of them are no longer
their papers. If the set is too weak to answer the question, that *is* the
finding: say what is missing and what kind of study would supply it.

Two rows that are the same trial reported twice is the other direction of the
same error — it double-counts a single study into an apparent consistency.
Check with `mcp__evimed__evidence_deduplicate` and, where a registry number is
available, with `mcp__evimed__clinical_trial_search`; companion publications
share one row and name both papers in the citation.

## One row per study

Every row carries an identifier a reader can resolve: `{type, value}` with type
one of `doi`, `pmid`, `pmcid`, `nct`, `isrctn`, `url`. A URL is the last resort,
for a report that genuinely has no other identifier.

### Design, from a fixed list

`systematic-review` · `randomized-controlled-trial` ·
`non-randomized-interventional` · `prospective-cohort` · `retrospective-cohort`
· `case-control` · `cross-sectional` · `case-series` · `case-report` ·
`diagnostic-accuracy` · `modelling-study` · `guideline` · `other`

It is a fixed word rather than a description because design is what every bias
judgement below is read against, and "a large multicentre observational study
with matched controls" is three designs' worth of ambiguity. Use `other` when
none of them fits and say what it actually is in `designNote`.

Take the design from the methods, never from what the paper calls itself.
"随机" in a title with alternate-day allocation in the methods is not a
randomized trial.

### Three domains, each a rating and a reason

Every appraised study is rated on **`riskOfBias`**, **`indirectness`** and
**`imprecision`**. The other two GRADE domains are properties of a *set* of
studies and cannot be assessed one row at a time; they appear in the roll-up.

Ratings: `low` · `moderate` · `serious` · `critical` · `unclear`

- **`riskOfBias`** — where in *this study's conduct* a systematic error could
  enter: allocation, blinding, attrition, outcome measurement, selective
  reporting. Name the step. "质量较低" is not a risk-of-bias judgement; "开放标签
  且主要结局为患者报告" is.
- **`indirectness`** — the distance between what was studied and what is being
  asked, on four axes: population, intervention, comparator, outcome. A surrogate
  outcome standing in for the one that matters is the most common instance, and
  the most commonly unrecorded.
- **`imprecision`** — whether the interval is narrow enough to act on. Judge the
  interval, not the p-value, and against the decision at stake: an interval that
  spans "worth doing" and "not worth doing" is imprecise even when it excludes
  the null.

`unclear` is an honest answer and requires the same reason as any other —
say what was not reported, not that you are unsure.

**A rating with no reason cannot be disagreed with, which is the only thing an
appraisal is for.** The reason is the deliverable; the word is its index.

### If you used a real instrument, record it as itself

Applying RoB 2, ROBINS-I, ROBINS-E, QUADAS-2, AMSTAR 2, AGREE II,
Newcastle-Ottawa, Jadad or MINORS is a legitimate way to do this work. Where you
did, put the instrument in `instrument` and **its own verbatim level** in
`instrumentRating` — `some concerns`, `serious`, `7/9`, whatever the instrument
says — alongside the rating above.

Do not convert between systems, in either direction. RoB 2's `some concerns` is
not ROBINS-I's `moderate`, and mapping one onto the other invents a
correspondence their authors did not define. Naming an instrument is a promise
that you applied it; if you did not apply it, do not name it.

## The roll-up: the ladder is arithmetic

One body per outcome. Each names the study ids it rolls up, and lands on one of
`high` · `moderate` · `low` · `very-low`.

It gets there by counting:

1. **`startingCertainty`** — `high` for a body of randomized trials, `low` for a
   body of observational studies. That is the whole rule. If a randomized body
   deserves less, take the step in the domain that earns it, so the reason is on
   the record instead of buried in where you chose to start.
2. **`downgrades`** — each names a domain from `riskOfBias`, `inconsistency`,
   `indirectness`, `imprecision`, `publicationBias`, with `steps` and a reason.
   `inconsistency` and `publicationBias` are the two you can only see here:
   effects pointing in different directions with no explanation, and a set of
   small positive studies with no small negative ones.
3. **`upgrades`** — only from an observational start, and only from
   `largeEffect`, `doseResponse`, `plausibleConfoundingReducesEffect`.
4. `certainty` = start − downgrade steps + upgrade steps, floored at `very-low`
   and capped at `high`.

**`steps: 0` is a real answer**, and a useful one: a concern you saw, considered
and did not act on. It is not the same as no concern, and recording it is how
the next reader knows you looked.

The certainty must equal what your own steps produce. When it does not, one of
the two is wrong — and a reader checking your table finds it in one subtraction.

### `whatWouldChange`

Every body says what would move it: a named trial reporting, an individual-data
reanalysis, a registry linkage. A certainty judgement that nothing could change
is not a judgement about evidence.

## What this is not

- **Not a certified GRADE assessment**, and not a certified run of any
  instrument. It uses GRADE's domains and its four-rung ladder because they are
  the clearest available way to write this down. Say so where the audience might
  assume otherwise.
- **Not a recommendation.** You appraise the certainty of evidence. Dosing,
  substitution, who should take what — none of it belongs in an appraisal, at
  any certainty level.
- **Not a re-analysis.** If a number in a paper looks wrong, say which number
  and why it looks wrong. Do not recompute the study.

## The files

- `appraisal-table.json` — the structured appraisal: `question`, `studies[]`,
  `bodies[]`. Everything else is a rendering of it, so this is the one that has
  to be right.
- `appraisal-table.csv` — one row per study, study id in the first column.
  This is the copy that gets pasted into a supplementary appendix, so a study
  missing here is a study that was never delivered.
- `appraisal-table.md` — the readable appraisal: the question, what the set
  contains, the per-study judgements in prose, then the certainty per outcome
  with its reasoning. Someone who reads only this file should be able to say why
  each body landed where it did.
- `citation-ledger.csv` — header row plus one row per study, carrying the
  identifier from the table.

### Registers do not mix

`appraisal-table.md` is what a reader sees. Anything about *how the work went* —
what you revised, which full text you could not get, what you would do
differently — goes in `revision-notes.md`. That file exists so the appraisal can
be held to a register the notes are not; it is an outlet, not a trap, and
nothing in it is scanned for tone.

Do not write tool names, gateway names, internal ids or first-person retrieval
narration into the appraisal. "我检索后发现…" is a diary entry; the reader needs
the judgement and the citation.

---

## Before delivering: two fixed steps

Both run on the finished package, in this order, every time. They are steps of
this capability, not options the run weighs — a pass that happens only when the
model remembers it is a pass that happens on the easy runs and not the hard ones.

1. **`traceability-review`** — every citation resolves, every study id in the
   table appears in the CSV and the ledger, and every certainty equals its own
   arithmetic. Repair findings before the next step: polishing the prose around
   a certainty that does not follow only makes the error read better.
2. **`manuscript-humanize`** — register cleanup over the prose, with every
   quotation, number, citation index, rating word and certainty level
   byte-identical. It is the last thing that touches the document.

Write what changed and why to `revision-notes.md` in this deliverable's
directory — revision notes, replies to a rejection, and process description all
live there, and the appraisal itself carries none of them.

## Then submit

```
evimed_submit_deliverable{deliverableId: "<your deliverable id>"}
```

It answers with the verdict, in place. A first submission that comes back with
issues is the normal case, not a failure: fix everything listed as 必修, submit
again, repeat until it answers `ok`. The rules it applies are the same ones the
server applies afterwards.

The advisory issues are the ones to read closely here, because they are about
the parts of an appraisal a reader can check without knowing the field: a
malformed identifier, a rating with no reason, a study appraised and then left
out of every body, a certainty that does not equal its own steps. They do not
decide the outcome. Shipping with one still standing is choosing not to defend
the arithmetic, which is the first thing a methodologist will redo.

Do not read the gate's source to work out what will pass. A table written to
satisfy a checker rather than a reader is the failure this arrangement exists to
prevent, and it is visible in the output.

## What this capability does not do

- It does not search for studies, extend the set, or drop one from it.
- It does not pool effects. If the question needs a pooled estimate, that is
  `meta-analysis`.
- It does not decide whether the evidence is sufficient to act on. It says how
  certain it is, and who has to decide that is not this run.
