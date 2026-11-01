# VCR matching on real clinical notes: n2c2 2018 Track 1

One patient-grouped evaluation of the matching core on real, English clinical notes (plan 5.5, V2). It was run once on the
86 held-out test patients, after the harness was frozen. It is a measurement of what the shipping matching skill and
evaluator do on this data set, with the model that ships. It is not a release condition and it is not a clinical validation.

Two measurements are reported. The first, on the official test split, came before the product fixes that its findings led to; the second,
after them, ran on training patients that were held out from tuning and is **not** the official split (see "Second measurement"). The first
measurement's numbers below are unchanged.

The notes are not in this repository, are never printed, and nothing here quotes them: the files in this directory hold code,
a unit test on made-up notes, and aggregate numbers. The data sit under the maintainer's `.evimed-local/acceptance/n2c2-2018-t1/`
(gitignored); `SHA256SUMS` beside them lists the digests of the files used, and `FROZEN.json` repeats those digests.

## The result, in one paragraph

On the 86 test patients (1,118 patient-criterion pairs) the pipeline gave a verdict, satisfied or not satisfied, for
35% of the pairs and said `unknown` for 65%. Counting `unknown` as wrong (reading a, what the product shows),
accuracy is **0.30 (0.27-0.33)**. When it did commit, it agreed with the gold 0.87 of the time. Reading `unknown` as
"not met", the convention the annotators used for an absent criterion (reading b), accuracy is **0.72 (0.70-0.74)** and the
official scorer's micro F1 is **0.6751**, against **0.76** and **0.7608** for a baseline that ignores the note and answers
the training majority for every criterion. Reading b is therefore worse than that baseline, on accuracy and on F1, and the intervals do not overlap. Reading c, which adds the
guide's own rule that an unmentioned ENGLISH or MAKES-DECISIONS is met, gives accuracy 0.84 (0.82-0.86) and micro F1
0.8293; two criteria with about 95% "met" carry much of that. When the pipeline says "not satisfied" for a pair the
gold calls met it is rare (1.7% of the gold-met pairs); most of its misses are `unknown`, and that is where the contract, not the
model, decides (see "What the evidence says").

## Test results (86 patients, 95% intervals from a patient-level cluster bootstrap, 2,000 resamples)

Readings of the three-state output against the two-label gold: **(a)** `unknown` is wrong and stays in the denominator; **(b)**
`unknown` is read as not met; **(c)** as (b) except that `unknown` is read as met for ENGLISH and MAKES-DECISIONS, where
the annotation guide (section 4) says an unmentioned criterion is probably met. The three readings were fixed in `FROZEN.json`
before the test was predicted. "Right when decided" is derived (accuracy a divided by one minus the unknown share; the number of pairs it rests on is in brackets, and for HBA1C it is a handful) and was not
in the frozen scoring code. The baseline column gives every patient the class most of the 202 training patients have for the criterion.

| Criterion | Gold met (of 86) | Decided by | Accuracy (a) | Unknown share | Right when decided | Accuracy (b) | Accuracy (c) |
|---|---|---|---|---|---|---|---|
| ABDOMINAL | 30 | code | 0.23 (0.15-0.33) | 0.63 (0.53-0.72) | 0.63 (32) | 0.74 (0.65-0.83) | 0.74 (0.65-0.83) |
| ADVANCED-CAD | 45 | model | 0.45 (0.35-0.56) | 0.45 (0.35-0.56) | 0.83 (47) | 0.78 (0.69-0.86) | 0.78 (0.69-0.86) |
| ALCOHOL-ABUSE | 3 | code | 0.53 (0.43-0.64) | 0.42 (0.31-0.52) | 0.92 (50) | 0.94 (0.88-0.99) | 0.94 (0.88-0.99) |
| ASP-FOR-MI | 68 | code | 0.76 (0.66-0.84) | 0.13 (0.06-0.20) | 0.87 (75) | 0.85 (0.77-0.92) | 0.85 (0.77-0.92) |
| CREATININE | 24 | model | 0.47 (0.36-0.58) | 0.52 (0.42-0.63) | 0.98 (41) | 0.90 (0.83-0.95) | 0.90 (0.83-0.95) |
| DIETSUPP-2MOS | 44 | code | 0.00 (0.00-0.00) | 1.00 (1.00-1.00) | n/a | 0.49 (0.38-0.59) | 0.49 (0.38-0.59) |
| DRUG-ABUSE | 3 | code | 0.49 (0.38-0.59) | 0.49 (0.38-0.59) | 0.95 (44) | 0.98 (0.94-1.00) | 0.98 (0.94-1.00) |
| ENGLISH | 73 | model | 0.16 (0.09-0.24) | 0.81 (0.72-0.90) | 0.88 (16) | 0.16 (0.09-0.24) | 0.98 (0.94-1.00) |
| HBA1C | 35 | code | 0.05 (0.01-0.09) | 0.95 (0.91-0.99) | 1.00 (4) | 0.63 (0.52-0.73) | 0.63 (0.52-0.73) |
| KETO-1YR | 0 | code | 0.00 (0.00-0.00) | 1.00 (1.00-1.00) | n/a | 1.00 (1.00-1.00) | 1.00 (1.00-1.00) |
| MAJOR-DIABETES | 43 | code | 0.38 (0.28-0.49) | 0.56 (0.45-0.66) | 0.87 (38) | 0.83 (0.74-0.91) | 0.83 (0.74-0.91) |
| MAKES-DECISIONS | 83 | model | 0.16 (0.09-0.24) | 0.79 (0.71-0.87) | 0.78 (18) | 0.20 (0.12-0.28) | 0.92 (0.86-0.97) |
| MI-6MOS | 8 | code | 0.26 (0.16-0.36) | 0.73 (0.63-0.83) | 0.96 (23) | 0.91 (0.85-0.97) | 0.91 (0.85-0.97) |
| **All 13 (pooled)** | 459 of 1118 | | 0.30 (0.27-0.33) | 0.65 (0.62-0.68) | 0.87 (388) | 0.72 (0.70-0.74) | 0.84 (0.82-0.86) |
| Majority-class baseline | | | | 0 | | 0.76 (0.75-0.78) | 0.76 (0.75-0.78) |

| Criterion | Met read as not met, explicit | Met missed incl. unknown (b) | Not met read as met | F1 (b) | F1 (c) |
|---|---|---|---|---|---|
| ABDOMINAL | 0.00 (0.00-0.00) | 0.33 (0.17-0.52) | 0.21 (0.12-0.33) | 0.72 (0.62-0.81) | 0.72 (0.62-0.81) |
| ADVANCED-CAD | 0.02 (0.00-0.08) | 0.27 (0.15-0.40) | 0.17 (0.06-0.30) | 0.78 (0.69-0.86) | 0.78 (0.69-0.86) |
| ALCOHOL-ABUSE | 0.00 (0.00-0.00) | 0.33 (0.00-1.00) | 0.05 (0.01-0.10) | 0.71 (0.48-0.89) | 0.71 (0.48-0.89) |
| ASP-FOR-MI | 0.00 (0.00-0.00) | 0.04 (0.00-0.10) | 0.56 (0.31-0.79) | 0.73 (0.59-0.85) | 0.73 (0.59-0.85) |
| CREATININE | 0.04 (0.00-0.13) | 0.38 (0.18-0.58) | 0.00 (0.00-0.00) | 0.85 (0.75-0.93) | 0.85 (0.75-0.93) |
| DIETSUPP-2MOS | 0.00 (0.00-0.00) | 1.00 (1.00-1.00) | 0.00 (0.00-0.00) | 0.33 (0.28-0.37) | 0.33 (0.28-0.37) |
| DRUG-ABUSE | 0.00 (0.00-0.00) | 0.00 (0.00-0.00) | 0.02 (0.00-0.06) | 0.87 (0.49-1.00) | 0.87 (0.49-1.00) |
| ENGLISH | 0.01 (0.00-0.04) | 0.97 (0.93-1.00) | 0.08 (0.00-0.25) | 0.15 (0.09-0.22) | 0.95 (0.88-1.00) |
| HBA1C | 0.00 (0.00-0.00) | 0.91 (0.81-1.00) | 0.00 (0.00-0.00) | 0.46 (0.37-0.56) | 0.46 (0.37-0.56) |
| KETO-1YR | n/a | n/a | 0.00 (0.00-0.00) | 0.50 (0.50-0.50) | 0.50 (0.50-0.50) |
| MAJOR-DIABETES | 0.00 (0.00-0.00) | 0.23 (0.12-0.36) | 0.12 (0.02-0.22) | 0.82 (0.74-0.90) | 0.82 (0.74-0.90) |
| MAKES-DECISIONS | 0.05 (0.01-0.10) | 0.83 (0.75-0.90) | 0.00 | 0.18 (0.11-0.26) | 0.48 (0.46-0.49) |
| MI-6MOS | 0.12 (0.00-0.40) | 1.00 (1.00-1.00) | 0.00 (0.00-0.00) | 0.48 (0.46-0.49) | 0.48 (0.46-0.49) |
| **All 13 (pooled)** | 0.02 (0.01-0.03) | 0.59 (0.55-0.62) | 0.06 (0.05-0.08) | 0.68 (0.65-0.70) | 0.83 (0.81-0.85) |
| Majority-class baseline | 0.22 (0.20-0.25) | 0.22 (0.20-0.25) | 0.24 (0.22-0.26) | 0.76 (0.74-0.78) | 0.76 (0.74-0.78) |

"Met read as not met, explicit" is the share of gold-met pairs where the pipeline itself said not satisfied. "Met missed incl.
unknown" adds the gold-met pairs that were `unknown`. "Not met read as met" is the share of gold-not-met pairs where it said satisfied
(for reading c the pooled figure is 0.07 (0.05-0.08)). Per-criterion F1 is the official scorer's definition: the mean of the F1 of "met" and
of "not met". The pooled F1 rows are micro-averaged; macro F1 is 0.58 (0.54-0.61) (b) and 0.67 (0.62-0.70) (c). KETO-1YR has too few
gold-met patients for any rate over them. Intervals reflect which patients were drawn, nothing else.

Official scorer (the n2c2 `track1_eval.py`, unchanged, run on the gold and on the pipeline's labels under each reading):

| Reading | Micro overall F1 | Macro overall F1 | My own computation |
|---|---|---|---|
| (b) unknown = not met | 0.6751 | 0.5833 | 0.6751 / 0.5833 |
| (c) unknown = not met, except ENGLISH, MAKES-DECISIONS = met | 0.8293 | 0.6677 | 0.8293 / 0.6677 |

For comparison with the literature: Stubbs et al. (J Am Med Inform Assoc 2019, PMC6798568, Table 2 and text) report a best
micro F1 of 0.91 (Medical University of Graz, rule based) on these 86 patients, a mean of 0.799 over all 109 submitted systems and 0.9075 for the second-best
team. This is not a like-for-like comparison. Those systems answered met or not met for every criterion, most were built on the 202 annotated training
patients and the annotators' conventions, and ours abstains with `unknown` and was tuned for the form of its prompt only. The number to read is the
unknown share and what the unknowns are, not the distance to 0.91.

## Second measurement: after the fixes, on training patients that were never used to tune

**This is not the official test split.** The first measurement above was run on the 86 test patients before any of the fixes below, and it
stands: it is not run again. This one ran on the **162 training patients outside the 40 development ones**, which nothing was tuned on, after
the fixes. They are other patients with other labels, so the two tables are not paired; the paired comparison is the control arm further down.

What was fixed in the product after the first measurement (the causes its findings named, items 1 to 4 under "What the evidence says" below):

1. **A date from the record's own date line.** A fact carries an optional second verbatim quotation of the same document that prints a date whole, with
   its year (`dateQuote`); it is checked in the document's own bytes like the first quotation. Upload times, dataset years, file metadata, short forms
   such as `3/14` and anything outside the document still supply nothing. The fact writer, the batch reading (prompt `match-extract-2`) and the
   evaluator's re-read agree on it, and the skill teaches it in a bullet and an example.
2. **A unit the quotation does not print drops the unit, not the fact.** For a variable the domain's closed table gives exactly one conventional unit
   (HbA1c, in percent, for a printed number between 3 and 18; a variable with a conversion row, such as creatinine, has two and is never listed) a
   bare number reads in that unit, recorded as `unitBasis: conventional` and said beside the quotation on the page, never as if printed.
   HbA1c is also reported in mmol/mol (values above 18), so the table carries a printed range and a bare number outside it stays without a unit.
3. **`clinicalUnitInQuote`** judged the word after a unit on a quote with its spaces removed, so `7.2 % this week` failed; it looks at the quote as printed.

How it was measured: `FROZEN-2.json` (digests of the harness, the fixed product and skill, the model and settings, the readings, the 162 patients, and
the first manifest and result it follows) was committed before any held-out patient was predicted. The product's prompt was developed on the forty
development patients only, in three more rounds (`results/dev-r4.json` to `dev-r6.json`; six rounds on those forty in all, so they are not unseen for
either measurement). The same readings (a), (b), (c), the same bootstrap over patients, the same official scorer. The majority baseline is learnt from
the forty development patients only. The 162 were predicted once and scored once (`score-heldout`); nothing was changed afterwards.

**A control arm.** Because the two measurements are on different patients, the first measurement's own pipeline (its harness, prompt and product,
unchanged, from a copy of its tree: the prompt digest is the frozen one and its predictions carry the first manifest's file digests) was also run on the
same 162 patients, and the change between the two is resampled together over patients. It uses a separate model sample for each arm, so the change
includes the model's run-to-run variation as well as the fixes and the skill's new wording; the frame of the prompt also lost the unit and date sentences
the skill now carries.

### Before and after

| | Before: first measurement, 86 official test patients | After: second measurement, 162 held-out training patients |
|---|---|---|
| Accuracy (a) | 0.30 (0.27 to 0.33) | 0.33 (0.31 to 0.36) |
| Unknown share | 0.65 (0.62 to 0.68) | 0.63 (0.60 to 0.66) |
| Accuracy (b) | 0.72 (0.70 to 0.74) | 0.73 (0.72 to 0.74) |
| Accuracy (c) | 0.84 (0.82 to 0.86) | 0.86 (0.84 to 0.87) |
| Micro F1 (b) / (c), official scorer | 0.6751 / 0.8293 | 0.6997 / 0.8511 |
| Macro F1 (b) / (c), official scorer | 0.5833 / 0.6677 | 0.6073 / 0.7200 |
| Majority baseline: accuracy / micro F1 | 0.76 / 0.7608 | 0.77 / 0.7595 |

### On the same 162 patients: the first pipeline and the fixed one

95% intervals are from the patient-level cluster bootstrap (2,000 resamples); the change is resampled on both arms together.

| | First pipeline (control) | Fixed pipeline | Change | Majority baseline |
|---|---|---|---|---|
| Accuracy (a), `unknown` is wrong | 0.32 (0.30 to 0.34) | 0.33 (0.31 to 0.36) | +0.014 (-0.004 to +0.031) | 0.77 (0.75 to 0.78) |
| Unknown share | 0.65 (0.62 to 0.67) | 0.63 (0.60 to 0.66) | -0.016 (-0.033 to +0.003) | 0.00 (0.00 to 0.00) |
| Accuracy (b), `unknown` is not met | 0.72 (0.71 to 0.73) | 0.73 (0.72 to 0.74) | +0.011 (-0.001 to +0.023) | 0.77 (0.75 to 0.78) |
| Accuracy (c) | 0.85 (0.83 to 0.86) | 0.86 (0.84 to 0.87) | +0.008 (-0.003 to +0.019) | 0.77 (0.75 to 0.78) |
| Micro F1 (b), official scorer | 0.69 (0.67 to 0.70) | 0.70 (0.68 to 0.72) | +0.013 (-0.002 to +0.028) | 0.76 (0.74 to 0.78) |
| Micro F1 (c), official scorer | 0.84 (0.83 to 0.86) | 0.85 (0.84 to 0.87) | +0.008 (-0.004 to +0.020) | 0.76 (0.74 to 0.78) |
| Macro F1 (b) | 0.59 (0.57 to 0.61) | 0.61 (0.58 to 0.63) | +0.014 (-0.007 to +0.033) | 0.43 (0.42 to 0.43) |
| Met read as not met, explicit | 0.01 (0.00 to 0.01) | 0.02 (0.01 to 0.02) |  | 0.33 (0.31 to 0.35) |
| Not met read as met | 0.05 (0.04 to 0.07) | 0.05 (0.04 to 0.06) |  | 0.16 (0.14 to 0.17) |
| Right when decided | 0.91 | 0.91 | | |

Official scorer on the 162 (unchanged `track1_eval.py`): the fixed pipeline has micro F1 0.6997 (b) and 0.8511 (c), macro 0.6073 (b) and 0.7200 (c);
the control 0.6864 (b) and 0.8428 (c), macro 0.5932 (b) and 0.6967 (c). My own computation agrees with the scorer to four decimals.

| Criterion | Gold met (of 162) | Accuracy (a), control | fixed | change | Unknown, control | fixed | Accuracy (b), control | fixed |
|---|---|---|---|---|---|---|---|---|
| ABDOMINAL | 64 | 0.30 | 0.27 | -0.037 (-0.086 to +0.012) | 0.56 | 0.59 | 0.77 | 0.72 |
| ADVANCED-CAD | 101 | 0.52 | 0.45 | -0.074 (-0.130 to -0.018) | 0.44 | 0.52 | 0.83 | 0.78 |
| ALCOHOL-ABUSE | 4 | 0.62 | 0.54 | -0.080 (-0.142 to -0.018) | 0.34 | 0.42 | 0.96 | 0.95 |
| ASP-FOR-MI | 135 | 0.77 | 0.72 | -0.049 (-0.099 to +0.000) | 0.15 | 0.21 | 0.86 | 0.82 |
| CREATININE | 70 | 0.52 | 0.56 | +0.037 (-0.012 to +0.086) | 0.43 | 0.39 | 0.81 | 0.83 |
| DIETSUPP-2MOS | 84 | 0.00 | 0.02 | +0.018 (+0.000 to +0.043) | 1.00 | 0.96 | 0.48 | 0.49 |
| DRUG-ABUSE | 8 | 0.49 | 0.47 | -0.025 (-0.074 to +0.019) | 0.49 | 0.52 | 0.99 | 0.99 |
| ENGLISH | 153 | 0.06 | 0.07 | +0.018 (+0.000 to +0.043) | 0.94 | 0.93 | 0.07 | 0.08 |
| HBA1C | 56 | 0.06 | 0.38 | +0.327 (+0.253 to +0.395) | 0.94 | 0.59 | 0.70 | 0.92 |
| KETO-1YR | 1 | 0.01 | 0.02 | +0.012 (-0.012 to +0.037) | 0.99 | 0.98 | 0.99 | 0.99 |
| MAJOR-DIABETES | 95 | 0.41 | 0.41 | +0.000 (-0.037 to +0.037) | 0.51 | 0.54 | 0.75 | 0.77 |
| MAKES-DECISIONS | 156 | 0.18 | 0.23 | +0.056 (+0.012 to +0.099) | 0.81 | 0.75 | 0.20 | 0.25 |
| MI-6MOS | 13 | 0.22 | 0.20 | -0.025 (-0.074 to +0.018) | 0.78 | 0.80 | 0.92 | 0.92 |

### What the fixes did and did not do

- **Units worked.** HBA1C went from strict accuracy 0.06 to 0.38 (+0.327 (+0.253 to +0.395)) and from 0.70 to 0.92 under reading (b).
  Facts dropped for a unit the note does not print fell from 67 to 0, 83 facts were read in percent by convention and 6 had a claimed unit dropped with the fact kept;
  HbA1c verdicts with no value fell from 127 to 90 and with no printed unit from 25 to 5.
- **The date quotation barely moved the windows.** 37 facts were dated through a `dateQuote`, but `undated` unknowns went from 124 to 123 and DIETSUPP-2MOS from 0.00 to 0.02 (+0.018 (+0.000 to +0.043)); MI-6MOS did not improve.
- **It also cost facts.** The model now writes dates much more often, and a date that is not printed whole in the quotation or in the second quotation still refuses the **whole fact**
  (the rule that holds the 10-29 invented-date cases): 104 facts were refused for a date against 14 for the control. Of the 157 facts for which the model wrote a date, only 38 were kept;
  36 of the 157 were myocardial infarction facts (2 of them kept), an event the model dated from partial dates such as `2/2087`. (These counts are a read of the model's answers made after the scoring; no gold is involved and they are not in the frozen code.) A lost fact leaves its criterion `unknown`. This is consistent with the lower strict accuracy of
  ADVANCED-CAD (-0.074 (-0.130 to -0.018)), ASP-FOR-MI (-0.049 (-0.099 to +0.000)), ALCOHOL-ABUSE and ABDOMINAL; I did not test that cause (no arm drops only the date).
  The step that follows from it is the one the unit already has: an unsupported date drops the date and keeps the fact. That is a product ruling (it changes what the 10-29 rule refuses) and a third measurement, and neither was done here.
- **Overall the change is small and not distinguishable from zero**: +0.014 (-0.004 to +0.031) strict, +0.011 (-0.001 to +0.023) under (b), +0.013 (-0.002 to +0.028) micro F1 (b). A gain on HBA1C is offset by losses elsewhere, and some criteria moved by about what one model sample moves them (MAKES-DECISIONS +0.056 (+0.012 to +0.099) has no fix aimed at it).
- **The standing comparison with the majority baseline is unchanged.** Under (b) the fixed pipeline is 0.73 accuracy and 0.6997 micro F1 against 0.77 and 0.7595 for the baseline learnt from the forty development patients: still below it. Under (c) it is above (0.86, 0.8511), with the same caveat as before that two criteria which are about 95% met carry much of it.

Limits of this measurement, besides those below: the 162 are training patients of the same corpus, annotated by the same people, and nothing was tuned on them, but they are not the official split and their score
is not comparable with the published one; the control arm is a second model sample, not a replay; one sample per patient per arm; the criteria structure is the same translation as before; 3 of 162 answers were unreadable JSON for the fixed pipeline
(the control: 2). Total spend for everything, both measurements, the development rounds and the control: CNY 11.70 of the hard budget of 200 (2.96 for the fixed pipeline on the 162, 2.87 for the control).

## What was measured

For each patient, one DeepSeek call (`deepseek-v4-flash`, temperature 0, JSON output, thinking off; the API served it as `deepseek-flash`) reads the whole
file (2-5 dated records, "now" is the latest record's date as the guide says) and returns, for the 13 criteria, located facts
with verbatim quotations and answers for the four criteria only language can decide. The instructions are the shipping skill: three
stretches of `capabilities/vcr-matching/SKILL.md` are cut out of the file when the run starts and placed in the prompt unchanged; the
prompt, the skill file and the excerpts are digested in `FROZEN.json`. Code then does what a study does:

1. `acceptExtractedFacts` (the domain's closed vocabulary for a batch reading) drops what no criterion asked for.
2. Every quotation must be in the file word for word; its position is the first place it occurs, as in the batch reading. One that is not is dropped.
3. `verifyFactEvidence` re-reads each fact against the file (surface, number, unit beside the number, a printed full date), at write time and again inside the evaluator.
4. The verdicts are `assessSubject`'s: Kleene's three-valued logic, windows counted back from "now", a value against its range with its unit.

The thirteen criteria are the guide's wording translated once into the requirement grammar (`criteria.mjs`), before any model call. A
condition the grammar can say is written that way and decided by code: presence (DRUG-ABUSE, ALCOHOL-ABUSE, ABDOMINAL as any of three, MAJOR-DIABETES as any of
six, ASP-FOR-MI), a window (MI-6MOS six months, KETO-1YR one year, DIETSUPP-2MOS two months), a range with a unit (HBA1C 6.5-9.5 %, any value), two of four
(ADVANCED-CAD, as any pair of its four parts). A condition it cannot say is a `language` node the model answers with a quotation (ENGLISH, MAKES-DECISIONS,
CREATININE above the upper limit of normal, and the "two or more medications" part of ADVANCED-CAD). The structure is part of what is measured: another
translation would give other numbers. No keyword, synonym or threshold was added.

Not in the loop: the conversation, the tools, retrieval of notes, the batch reading's own Chinese prompt (`vcrMatchBatch.mjs`, a second prompt production uses for
rosters; this measures the skill's rules, as asked), the batch reading's cap on a record's length (no test file reaches it), and any second step in which the model repairs a refused write. One call
per patient writes facts and language answers together, where a study does them in two steps.

## Protocol and the development log

The 202 training patients were not touched except forty, chosen by a fixed hash (`data.mjs`, `developmentIds`), on which the prompt's form was tuned in three
rounds, and the training labels used for the baseline and for the check of my F1 against the official scorer. Only the form of the prompt was changed: no per-criterion
rule, keyword or threshold. Round 2 was chosen because it had the fewest format losses (facts dropped for form, unreadable answers, refused language answers), a rule
written down before the choice; accuracy differed by less than the noise of forty patients. Then `FROZEN.json` was committed, the test patients were predicted with the sealed gold unopened, and
the gold was opened once, by `score-test`, which refuses without a manifest that matches, predictions made under it, and a test not scored before.

| Round | Change to the prompt's form | Accuracy (a) | (b) | (c) | Unknown | Unreadable | Facts dropped + language dropped + polarity | Cost, CNY |
|---|---|---|---|---|---|---|---|---|
| 1 | Plain: the skill stretches, the criteria, the guide's rules about "now"; quotations from the file. | 0.304 | 0.729 | 0.854 | 0.656 | 3 | 51 + 6 + 0 | 0.72 |
| 2 | Says how a fact is written so it can be re-read: one-line quotation, `\n` for a break in JSON, surface inside the quotation, unit only if printed, `occurredAt` only if the whole date with year is printed. | 0.288 | 0.714 | 0.837 | 0.665 | 2 | 36 + 2 + 2 | 0.70 |
| 3 | As round 2, but a quotation may run across the line break (written `\n`). | 0.277 | 0.710 | 0.839 | 0.675 | 1 | 45 + 20 + 2 | 0.68 |

Round 2 (frozen) on the forty development patients: micro F1 (b) 0.6666, baseline 0.7636. The test figures are of the same size as the development
ones, which is some evidence that nothing was fitted to the forty. Total spend for everything, including a one-call connection check and the smoke runs: CNY
3.65 of a hard budget of 200 (1.51 for the test). Raw model answers are cached outside the repository so that a re-run costs nothing.

## What the evidence says about the shipping contract

These are readings of the first measurement, not patches. Nothing in the skill or the evaluator was changed, and the harness was not changed after the test. (Items 1 to 4 were afterwards fixed in code, see "Second measurement"; the text below describes the product as it was when the test was scored.)

1. **Where the unknowns come from.** Of 730 unknown pairs on the test, 581 had no fact for the variable (the note does not say, or the model wrote none that survived the re-read), 68
   were HbA1c with no usable value, 67 had a fact that a time window could not place, and 14 had a value without a printed unit. On the forty development patients (a breakdown made after the freeze, from the development predictions, and not part of the frozen scoring code), of 215 gold-met pairs the pipeline
   committed to "satisfied" for 88, said "not satisfied" for 2 and `unknown` for 125; of those 125, 64 are ENGLISH and MAKES-DECISIONS, which the guide says are met when not mentioned, and
   15 were windowed facts it found but could not place in time.
2. **A record's own date cannot reach a fact about it.** A window needs `occurredAt`, and `occurredAt` must be a date printed whole, with its year, inside the quotation. In these notes the date is usually in the
   record's header and the current medication list or the problem list carries none, and the dates the model tried to write from inside the text (the facts dropped in the development rounds) were short forms such as `3/14`, `3/14/65` or `10/2074`, which the check does not take for a whole date. So MI-6MOS, KETO-1YR and DIETSUPP-2MOS are almost always `unknown` (DIETSUPP-2MOS: none decided on the test). The header is a clinical encounter date in the
   source, which the skill accepts as an anchor, but the contract has no way to bind a fact to the encounter it was written in. Whether to let a fact take its record's header date is a product ruling; this run only shows what the present rule costs.
3. **A unit the model supplies from knowledge loses the whole fact.** For HbA1c the model writes `%` although the note prints a bare number; the writer's check then drops the fact, not just the unit, and the batch reading has no second step to repair it
   (`unit_not_in_span` dropped 41 of 819 proposed facts on the test). Writing no unit gives `unit_missing`, also unknown. HBA1C is `unknown` for 95% of the patients. The skill's rule (value and unit both, else unknown) is followed as written.
4. **A small defect in the unit check.** `clinicalUnitInQuote` removes whitespace before it asks whether a letter follows the unit, so `7.2 % this week` fails (`%this`) while `7.2 %.` passes. It affected one fact in the development data, so it is a footnote here; it is in `packages/domain/src/clinicalUnits.mjs`, `besideValue`.
5. **Form losses are real but not the main story.** 48 proposed facts had a quotation that is not in the file (typically a line break or trailing spaces changed), 30 had a surface that is not inside its quotation, 41 had a claimed unit; together about
   16% of the 819 facts proposed. 2 of 86 answers could not be read as JSON (a typed line break inside a string); those patients are all `unknown`, as a record the batch reading could not read would be.
6. **Silence is `unknown`, by design.** The skill never reads absence as "not met" or "met", and the pipeline does not. The gold does, in both directions (the guide, section 4). That is why reading a is low and why (b) and (c) differ: it is a difference of convention, not an error of the pipeline, and
   it is the main thing to keep in mind when the numbers are quoted.
7. **Where it is wrong when it commits.** The largest rates of "not met" read as met are ASP-FOR-MI (0.56 (0.31-0.79)), ABDOMINAL (0.21 (0.12-0.33)), ADVANCED-CAD (0.17 (0.06-0.30)) and MAJOR-DIABETES (0.12 (0.02-0.22)): in the few development cases read, any aspirin on a medication list was taken
   for "aspirin to prevent myocardial infarction", where the gold does not always mark it. Those are disagreements about what counts, in criteria where the annotators agreed with each other only to kappa 0.37-0.73.

## Limits

- English notes, 13 fixed criteria, no registry retrieval: it does not show how trials are found, nor that a protocol's own eligibility text is structured well.
- Annotator agreement is low: the paper reports an average Cohen's kappa of 0.54 over the 13 criteria (ENGLISH 0.46, MAKES-DECISIONS 0.31, ADVANCED-CAD 0.37, KETO-1YR -0.1 because 275 of 288 patients are "not met", the others 0.59-0.73), computed over all 288 patients (the paper does not say whether on the three-way labels before adjudication). Most disagreements are one annotator finding evidence the other missed. Our reading is that figures above about 0.9 cannot be told from label noise; that is an inference, not a published bound.
- It does not prove anything for Chinese records, for retrieval recall, for oncology (these are cardiology and diabetes records), for a patient-to-trial direction, or for clinical usefulness. The conversation, the tools and the platform's own routes were not in the loop.
- 86 patients is small. The intervals above are for the patient sample only; they do not include the model's run-to-run variation (one sample per patient at temperature 0, not repeated), the choice of the criteria's structure, or the gold's noise. Per-criterion intervals for rare classes are wide or undefined.
- Reading (b) and (c) are conventions for comparison, not accuracy of the product, which shows `unknown`. The majority baseline shows how much of an accuracy figure on this data set is the class balance.
- One model, one prompt, one run. A different model or a later skill would need its own measurement.

## Running it

Everything runs from `OpenScience/` with the data unpacked under the data root (`EVIMED_N2C2_ROOT`, default `.evimed-local/acceptance/n2c2-2018-t1` in the workspace root) and the DeepSeek key in a file
named by `--key-file`, `OPEN_SCIENCE_DEEPSEEK_API_KEY_FILE`, or `<data root>/../../secrets/deepseek.api-key`.

```
node evals/vcr-matching/n2c2/run_n2c2.mjs predict --split dev --run <name> [--max-seconds N]   # resumes from the cache
node evals/vcr-matching/n2c2/run_n2c2.mjs report-dev --run <name>                              # aggregates + official scorer cross-check
node evals/vcr-matching/n2c2/run_n2c2.mjs freeze --dev-run <name> --rounds <n>                 # writes FROZEN.json, once
node evals/vcr-matching/n2c2/run_n2c2.mjs predict --split test --run <name>                    # refuses without a matching FROZEN.json
node evals/vcr-matching/n2c2/run_n2c2.mjs score-test --run <name>                              # opens the sealed gold, once
node --test evals/vcr-matching/n2c2/n2c2.test.mjs                                              # fabricated notes only; data tests skip without the data
# the second measurement: the 162 training patients outside the development split
node evals/vcr-matching/n2c2/run_n2c2.mjs freeze --manifest 2 --dev-run <name> --rounds <n>    # writes FROZEN-2.json, once
node evals/vcr-matching/n2c2/run_n2c2.mjs predict --split heldout --run <name>                 # refuses without a matching FROZEN-2.json
node evals/vcr-matching/n2c2/run_n2c2.mjs score-heldout --run <name> [--control-run <name>]    # scores once; the control run holds the first pipeline's predictions
```

The tests also run with the server's (`apps/server/test/vcrN2c2Eval.test.mjs`); the data-dependent ones skip when the data is absent.
