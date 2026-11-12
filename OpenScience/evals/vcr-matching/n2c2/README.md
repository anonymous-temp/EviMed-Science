# VCR matching on real clinical notes: n2c2 2018 Track 1

One patient-grouped evaluation of the matching core on real, English clinical notes (plan 5.5, V2). It was run once on the
86 held-out test patients, after the harness was frozen. It is a measurement of what the shipping matching skill and
evaluator do on this data set, with the model that ships. It is not a release condition and it is not a clinical validation.

Two measurements are reported. The first, on the official test split, came before the product fixes that its findings led to; the second,
after them, ran on training patients that were held out from tuning and is **not** the official split (see "Second measurement"). The first
measurement's numbers below are unchanged. Two further runs on the same held-out patients (the "Third run" and the "Fourth run") are regression
checks on patients already seen, not estimates.

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
  The step that follows from it is the one the unit already has: an unsupported date drops the date and keeps the fact. That is a product ruling (it changes what the 10-29 rule refuses) and a third measurement, and neither was done here. (The ruling was made and the step taken afterwards; see "Third run".)
- **Overall the change is small and not distinguishable from zero**: +0.014 (-0.004 to +0.031) strict, +0.011 (-0.001 to +0.023) under (b), +0.013 (-0.002 to +0.028) micro F1 (b). A gain on HBA1C is offset by losses elsewhere, and some criteria moved by about what one model sample moves them (MAKES-DECISIONS +0.056 (+0.012 to +0.099) has no fix aimed at it).
- **The standing comparison with the majority baseline is unchanged.** Under (b) the fixed pipeline is 0.73 accuracy and 0.6997 micro F1 against 0.77 and 0.7595 for the baseline learnt from the forty development patients: still below it. Under (c) it is above (0.86, 0.8511), with the same caveat as before that two criteria which are about 95% met carry much of it.

Limits of this measurement, besides those below: the 162 are training patients of the same corpus, annotated by the same people, and nothing was tuned on them, but they are not the official split and their score
is not comparable with the published one; the control arm is a second model sample, not a replay; one sample per patient per arm; the criteria structure is the same translation as before; 3 of 162 answers were unreadable JSON for the fixed pipeline
(the control: 2). Total spend for everything, both measurements, the development rounds and the control: CNY 11.70 of the hard budget of 200 (2.96 for the fixed pipeline on the 162, 2.87 for the control).

## Third run: after dropping the unsupported date (a regression check, not a clean estimate)

**This is a third run on the same 162 training patients that the second measurement had already scored.** It checks that one further fix does what it
should. It is not a clean estimate: those patients are no longer unseen, because the second measurement's results were read before the fix was chosen.
It is not the official test split either. The first and second results above are untouched, and nothing was tuned after this run, whatever it showed.

The fix: a date that no quotation prints (not the fact's own, not its `dateQuote`) no longer refuses the whole fact. The date is dropped and the fact is
kept undated, with a non-blocking notice in the tool answer (`date_not_shown`); `occurredAt` and `recordedAt` stand or fall each on its own, and a second
quotation no remaining date rests on is not stored. The batch reading uses the same writer, so it does the same. No invented date is stored: a dataset year,
an upload time, an age with no date, a short form such as `3/14` and file metadata still supply nothing; they now pass by the date being absent, and the
evaluator's own check (`verifyFactEvidence`, with its 10-29 tests) is unchanged. A window criterion over an undated fact stays unknown (reason `undated`);
a presence criterion counts the fact. An interval the quotation does not bound is still refused. The skill's wording already said "otherwise omit that
timestamp", so it was not changed and the prompt digest is the second manifest's.

How it was run: `FROZEN-3.json` was committed before any prediction. It pins the control (the first pipeline) and the second run by the digest of their
predictions, and it carries the same prompt, model and settings as the second manifest. Two sets of predictions were made under it: a **fresh model sample**
(the third run proper, CNY 1.28) and **the second run's cached answers read again through the fixed writer**, with no model call, which shows what the fix did to
identical model answers. A development check on the forty development patients came first (`results/dev-r7.json`: the dev-r6 answers through the fixed
writer; facts kept 373 to 392). One scoring (`score-heldout --manifest 3`); the baseline is still learnt from the forty development patients only.

### The numbers

95% intervals from the patient-level cluster bootstrap (2,000 resamples); changes are resampled on both sides together.

| | First pipeline (control) | Second run | Third run (fresh sample) | Second run's answers, fixed writer | Majority baseline |
|---|---|---|---|---|---|
| Accuracy (a), `unknown` is wrong | 0.321 (0.298 to 0.342) | 0.334 (0.310 to 0.360) | 0.355 (0.331 to 0.379) | 0.347 (0.323 to 0.372) | 0.766 (0.750 to 0.782) |
| Unknown share | 0.647 (0.625 to 0.670) | 0.631 (0.605 to 0.656) | 0.615 (0.591 to 0.639) | 0.618 (0.593 to 0.643) | 0.000 (0.000 to 0.000) |
| Accuracy (b), `unknown` is not met | 0.720 (0.706 to 0.734) | 0.731 (0.717 to 0.744) | 0.749 (0.735 to 0.762) | 0.740 (0.727 to 0.753) | 0.766 (0.750 to 0.782) |
| Accuracy (c) | 0.849 (0.834 to 0.862) | 0.857 (0.843 to 0.870) | 0.873 (0.860 to 0.886) | 0.866 (0.853 to 0.878) | 0.766 (0.750 to 0.782) |
| Micro F1 (b), official scorer | 0.686 (0.669 to 0.703) | 0.700 (0.682 to 0.717) | 0.723 (0.706 to 0.738) | 0.712 (0.695 to 0.727) | 0.759 (0.743 to 0.776) |
| Micro F1 (c), official scorer | 0.843 (0.828 to 0.857) | 0.851 (0.837 to 0.865) | 0.869 (0.855 to 0.882) | 0.861 (0.847 to 0.874) | 0.759 (0.743 to 0.776) |
| Macro F1 (b) | 0.593 (0.570 to 0.612) | 0.607 (0.584 to 0.626) | 0.630 (0.610 to 0.647) | 0.617 (0.595 to 0.636) | 0.426 (0.420 to 0.432) |

Official scorer, third run: micro F1 0.7226 (b) and 0.8690 (c), macro 0.6298 (b) and 0.7413 (c).
My computation agrees with the scorer to four decimals.

| Change | Third run minus control | Third run minus second run | Fixed writer minus second run, same answers |
|---|---|---|---|
| Strict accuracy (a) | +0.034 (+0.022 to +0.046) | +0.020 (+0.005 to +0.037) | +0.013 (+0.008 to +0.019) |
| Accuracy (b) | +0.029 (+0.018 to +0.039) | +0.018 (+0.008 to +0.029) | +0.009 (+0.005 to +0.014) |
| Accuracy (c) | +0.025 (+0.015 to +0.034) | +0.017 (+0.008 to +0.026) | +0.009 (+0.005 to +0.014) |
| Unknown share | -0.032 (-0.045 to -0.018) | -0.016 (-0.034 to +0.001) | -0.013 (-0.018 to -0.008) |
| Micro F1 (b) | +0.036 (+0.023 to +0.049) | +0.023 (+0.009 to +0.037) | +0.012 (+0.006 to +0.019) |
| Micro F1 (c) | +0.026 (+0.015 to +0.036) | +0.018 (+0.008 to +0.028) | +0.010 (+0.005 to +0.015) |

| Criterion | Gold met (of 162) | Strict accuracy, control | second run | third run | Third minus control | Fixed writer minus second run |
|---|---|---|---|---|---|---|
| ABDOMINAL | 64 | 0.302 | 0.265 | 0.284 | -0.018 (-0.056 to +0.018) | +0.018 (+0.000 to +0.043) |
| ADVANCED-CAD | 101 | 0.525 | 0.451 | 0.518 | -0.006 (-0.062 to +0.049) | +0.049 (+0.018 to +0.086) |
| ALCOHOL-ABUSE | 4 | 0.624 | 0.543 | 0.568 | -0.056 (-0.117 to +0.006) | +0.012 (+0.000 to +0.031) |
| ASP-FOR-MI | 135 | 0.765 | 0.716 | 0.765 | +0.000 (-0.037 to +0.037) | +0.031 (+0.006 to +0.062) |
| CREATININE | 70 | 0.525 | 0.562 | 0.580 | +0.056 (+0.018 to +0.099) | +0.000 (+0.000 to +0.000) |
| DIETSUPP-2MOS | 84 | 0.000 | 0.018 | 0.012 | +0.012 (+0.000 to +0.031) | +0.000 (+0.000 to +0.000) |
| DRUG-ABUSE | 8 | 0.494 | 0.469 | 0.494 | +0.000 (-0.049 to +0.043) | +0.006 (+0.000 to +0.018) |
| ENGLISH | 153 | 0.056 | 0.074 | 0.080 | +0.025 (+0.006 to +0.049) | +0.000 (+0.000 to +0.000) |
| HBA1C | 56 | 0.056 | 0.383 | 0.432 | +0.377 (+0.302 to +0.451) | +0.043 (+0.012 to +0.074) |
| KETO-1YR | 1 | 0.006 | 0.018 | 0.012 | +0.006 (+0.000 to +0.018) | +0.000 (+0.000 to +0.000) |
| MAJOR-DIABETES | 95 | 0.414 | 0.414 | 0.420 | +0.006 (-0.012 to +0.031) | +0.006 (+0.000 to +0.018) |
| MAKES-DECISIONS | 156 | 0.179 | 0.235 | 0.247 | +0.068 (+0.018 to +0.117) | +0.000 (+0.000 to +0.000) |
| MI-6MOS | 13 | 0.222 | 0.198 | 0.198 | -0.025 (-0.068 to +0.019) | +0.000 (+0.000 to +0.000) |

### What it shows

- **It does what it should.** On the second run's own answers the writer now keeps 104 more facts (1485 to 1589): none is refused for a date any more (it was 104) and 104 were kept undated.
  That alone is +0.013 (+0.008 to +0.019) strict accuracy, and it is where the loss the second measurement found was recovered: ADVANCED-CAD +0.049 (+0.018 to +0.086), ASP-FOR-MI +0.031 (+0.006 to +0.062).
  Against the control, ADVANCED-CAD (-0.006 (-0.062 to +0.049)) and ASP-FOR-MI (+0.000 (-0.037 to +0.037)) are no longer lower, as they were in the second run.
- **Net against the first pipeline, on these patients:** +0.034 (+0.022 to +0.046) strict, +0.029 (+0.018 to +0.039) under (b), +0.036 (+0.023 to +0.049) micro F1 (b), and the interval now excludes zero.
  Most of it is the unit fix: HBA1C alone is +0.377 of strict accuracy, which is about 0.029 of the pooled change (each criterion has the same 162 patients).
- **The windows are not solved.** The date quotation dated 43 facts; `undated` unknowns went from 124 (control) and 123 (second run) to 146 in the third run because more facts are kept and many of them have no date.
  DIETSUPP-2MOS is 0.012 and MI-6MOS 0.198 on strict accuracy, as before. What the date path does now is cost nothing; it does not yet date the facts the windows need.
- **Still below the majority baseline under (b)**: accuracy 0.749 against 0.766, micro F1 0.7226 against 0.7595. Under (c) it is above (0.873, 0.8690), with the caveat that two criteria which are about 95% met carry much of it.
- **Sampling noise is about a percentage point.** The fresh sample (0.355 strict) and the same answers re-read by the same writer (0.347) differ by +0.008; a difference of that size between two runs is not a finding.

Limits of this run, besides those below: the same 162 patients as the second measurement; one fresh sample; the control and the second run are the earlier predictions, pinned by digest, not re-run; the replay
is a re-reading, not an independent sample. Spend: CNY 1.28 for the fresh sample, none for the replay, CNY 12.98 for everything so far of the hard budget of 200.

## Fourth run: after the record header dates a fact (a regression check, not a clean estimate)

**This is a fourth run on the same 162 training patients, which the second and third runs had already scored.** The patients are not unseen: their
results were read before the rule below was chosen, and the third run's weak window criteria are what chose it. It checks that the rule does what it
should, and what it costs. It is not a clean estimate and it is not the official test split, which is not run again. The earlier results are untouched,
and nothing was changed after this run whatever it showed.

The rule (the owner's ruling of 2026-11-02, with the risk of dating a fact to the wrong record accepted): a patient fact with no date of its own takes the
date of the record header above it. A header is a matter of format: the nearest preceding line that prints exactly one complete date with its year and
little else (a label of at most 24 characters, a line of at most 80; of the 1,197 lines of the 202 training files that print exactly one date, 1,125 have
24 characters or fewer besides it, and the lines with more are, all but one, five words or longer). The header line is the fact's second quotation, so the
evaluator's literal check is unchanged and passes; `source.dateBasis` says `record_header`. The model no longer writes the record's date; it writes a date
only where the note prints one for that fact, and marks a past event (`temporality: historical`, the domain's own word). For a past event the header date is
only an upper bound (`source.dateBound: no_later_than`): a bound before the window's start is decisively outside, a bound inside it stays `undated`. The
skill (1.6.1), the batch reading's prompt and the answer shape of this harness say so in a few lines; the stretches the prompt cuts out of the skill are cut
by the same opening and closing words.

How it was run: development first, on the forty development patients only (`dev-r8`: `dev-r6`'s answers through the new writer, no model call; `dev-r9`: a
fresh sample with the new skill text, CNY 0.79); the prompt's form was not changed after `dev-r9`. `FROZEN-4.json` was committed before any held-out
patient was predicted. It pins the control (the first pipeline), the second run, the third run and the third run's replay by the digest of their
predictions. Three sets of predictions were made under it: **the second run's cached answers read again through the new writer** (no model call: what the code
alone does to identical model answers), **one fresh model sample** with the new skill text (CNY 3.07), and **the same fresh answers scored with the
past-event guard off** (no model call: the ruling taken literally, every fact at its header's date whatever the model said of it). One scoring
(`score-heldout --manifest 4`); the baseline is still learnt from the forty development patients only.

### The numbers

95% intervals from the patient-level cluster bootstrap (2,000 resamples); changes are resampled on both sides together. "Right when decided" is derived.

| | Third run | Second run's answers, new writer (code alone) | **Fourth run (fresh sample, guard on)** | Fourth run, literal ruling (guard off) | Majority baseline |
|---|---|---|---|---|---|
| Accuracy (a), `unknown` is wrong | 0.355 (0.331 to 0.379) | 0.398 (0.373 to 0.425) | **0.403 (0.377 to 0.430)** | 0.407 (0.381 to 0.434) | 0.766 (0.750 to 0.782) |
| Unknown share | 0.615 (0.591 to 0.639) | 0.547 (0.520 to 0.575) | **0.538 (0.510 to 0.566)** | 0.526 (0.498 to 0.553) | 0.000 |
| `undated` unknowns (pairs) | 146 | 0 | **26** | 0 | |
| Right when decided | 0.921 | 0.880 | **0.873** | 0.859 | |
| Accuracy (b), `unknown` is not met | 0.749 (0.735 to 0.762) | 0.757 (0.743 to 0.771) | **0.756 (0.741 to 0.772)** | 0.752 (0.737 to 0.768) | 0.766 (0.750 to 0.782) |
| Accuracy (c) | 0.873 (0.860 to 0.886) | 0.883 (0.869 to 0.896) | **0.883 (0.869 to 0.897)** | 0.879 (0.865 to 0.894) | 0.766 |
| Micro F1 (b), official scorer | 0.723 (0.706 to 0.738) | 0.737 (0.720 to 0.754) | **0.739 (0.721 to 0.756)** | 0.737 (0.719 to 0.755) | 0.759 (0.743 to 0.776) |
| Micro F1 (c), official scorer | 0.869 (0.855 to 0.882) | 0.880 (0.866 to 0.895) | **0.881 (0.867 to 0.896)** | 0.877 (0.864 to 0.892) | 0.759 |
| Macro F1 (b) | 0.630 (0.610 to 0.647) | 0.667 (0.642 to 0.689) | **0.653 (0.628 to 0.673)** | 0.661 (0.638 to 0.680) | 0.426 |
| Not met read as met | 0.046 (0.035 to 0.059) | 0.070 (0.057 to 0.083) | **0.087 (0.072 to 0.103)** | 0.102 (0.087 to 0.118) | 0.155 (0.138 to 0.173) |
| Met read as not met, explicit | 0.011 (0.004 to 0.018) | 0.034 (0.023 to 0.047) | **0.023 (0.015 to 0.033)** | 0.023 (0.015 to 0.033) | |
| Facts kept / dated from a header / of those, an upper bound only | 1,539 / 0 / 0 | 1,589 / 1,551 / 0 | **1,762 / 1,762 / 343** | 1,762 / 1,762 / 0 | |

Official scorer, fourth run: micro F1 0.7390 (b) and 0.8809 (c), macro 0.6532 (b); the literal ruling 0.7367 and 0.8774, macro 0.6606; the replay 0.7374 and 0.8802,
macro 0.6671. My computation agrees with the scorer to four decimals.

| Change | Fourth run minus third run | Code alone: new writer minus third run's writer, same answers | Guard on minus guard off, same answers |
|---|---|---|---|
| Strict accuracy (a) | +0.048 (+0.028 to +0.068) | +0.051 (+0.044 to +0.059) | -0.004 (-0.007 to -0.002) |
| Accuracy (b) | +0.007 (-0.009 to +0.022) | +0.017 (+0.009 to +0.025) | +0.004 (-0.001 to +0.009) |
| Accuracy (c) | +0.009 (-0.005 to +0.023) | +0.017 (+0.009 to +0.025) | +0.004 (-0.001 to +0.009) |
| Unknown share | -0.077 (-0.099 to -0.054) | -0.071 (-0.080 to -0.063) | +0.012 (+0.008 to +0.017) |
| Micro F1 (b) | +0.016 (-0.002 to +0.035) | +0.025 (+0.017 to +0.034) | +0.002 (-0.002 to +0.007) |
| Micro F1 (c) | +0.012 (-0.003 to +0.026) | +0.019 (+0.011 to +0.027) | +0.004 (-0.001 to +0.008) |
| Macro F1 (b) | +0.023 (-0.002 to +0.047) | +0.050 (+0.040 to +0.060) | -0.007 (-0.020 to +0.005) |
| Not met read as met | +0.041 (+0.028 to +0.054) | +0.019 (+0.012 to +0.026) | -0.015 (-0.021 to -0.008) |

The four criteria the ruling is about, with the pairs behind the error it can cause (gold-not-met pairs the pipeline called met; gold-met pairs it called not met). The columns are the third run, the second run's answers through the new writer (code alone), the fourth run, and the fourth run's answers under the literal ruling:

| Criterion | Strict accuracy | Fourth minus third | Not met read as met (pairs) | Met read as not met (pairs) |
|---|---|---|---|---|
| MI-6MOS (13 met, 149 not) | 0.198 / 0.457 / **0.401** / 0.457 | +0.204 (+0.123 to +0.284) | 0 / 18 / **2** / 18 of 149 | 0 / 1 / **0** / 0 of 13 |
| KETO-1YR (1 met, 161 not) | 0.012 / 0.025 / **0.025** / 0.025 | +0.012 (-0.012 to +0.037) | 0 / 2 / **1** / 2 of 161 | 0 / 0 / **0** / 0 of 1 |
| DIETSUPP-2MOS (84 met, 78 not) | 0.012 / 0.420 / **0.432** / 0.432 | +0.420 (+0.346 to +0.494) | 0 / 2 / **1** / 1 of 78 | 1 / 19 / **16** / 16 of 84 |
| HBA1C (56 met, 106 not; no window) | 0.432 / 0.426 / **0.451** / 0.451 | +0.018 (-0.018 to +0.056) | 0 / 1 / **2** / 2 of 106 | 3 / 4 / **2** / 2 of 56 |

### What it shows

- **The windows are decided now.** On the second run's own answers the writer leaves no `undated` unknown (it was 149 with the third run's writer); strict accuracy
  moves +0.051 (+0.044 to +0.059), DIETSUPP-2MOS from 0.018 to 0.420 and MI-6MOS from 0.198 to 0.457. In the fresh sample DIETSUPP-2MOS is 0.432 against 0.012 and
  MI-6MOS 0.401 against 0.198; the 146 pairs the third run left `undated` for lack of a date became verdicts (26 stay `undated`: a past event whose header date is inside the window).
- **The error the ruling can cause is real, and the guard takes most of it back.** With the second run's answers (the model said nothing of past events) the header
  puts an old myocardial infarction, mentioned in a note inside the six months, inside the window: 18 of 149 gold-not-met MI-6MOS patients read as met (0.121 (0.069 to
  0.174), against 0 before). The same happens under the literal ruling on the fresh answers: 18 of 149. With the model marking past events (343 of the 1,762 facts) and
  the guard, it is 2 of 149 (0.013 (0.000 to 0.034)). Pooled over the three window criteria the false "met" pairs are 22 (code alone), 21 (literal) and 4 (guard).
- **What the guard costs and buys, on the same answers.** It turns 9 of the 12 correct MI-6MOS "met" decisions into unknowns (12 to 3), and so costs 9 of 2,106 pairs
  of strict accuracy (-0.004 (-0.007 to -0.002), the only measure on which it is lower; MI-6MOS alone -0.056 (-0.093 to -0.025)); it removes 16 of the 18 false "met"
  (not met read as met -0.015 (-0.021 to -0.008), MI-6MOS -0.107 (-0.158 to -0.060)); and under reading (b) and the micro F1 it is level or slightly ahead (+0.004 and
  +0.002, intervals that include zero). It is not worse overall, so the guard stays and the literal ruling is not adopted. The strict score credits any decision whether or not
  it is right, which is why it prefers the literal ruling by a hair.
- **Not all of the rise in "not met read as met" is the ruling's.** Pooled it went from 0.046 to 0.087 (+0.041 (+0.028 to +0.054)), which is 54 pairs in the third run and 102 here. Of
  those, the three window criteria hold 0 in the third run and 4 here; the other 98 (54 before) are in criteria with no window, identical with the guard on and off: ABDOMINAL 21 to 49 of
  98, ADVANCED-CAD 4 to 9, ALCOHOL-ABUSE 5 to 9, MAJOR-DIABETES 9 to 11. No date can reach those criteria. The fresh sample wrote more facts under the new skill text (1,762 kept against
  1,539). I did not test the cause (one sample per arm; the second run's answers give the same 60 for those criteria through either writer), but it is a change in what the model wrote under the
  new text and the sample, not in the dates, and it deserves its own look.
- **A fact in an older record is dated by that record.** DIETSUPP-2MOS reads 16 of 84 gold-met patients as not met (against 1 before): a supplement listed in a note older than two months before "now" is
  dated by that note and read as outside the window, though the harness prompt tells the model to assume status carries forward until a later record changes it, and the date logic does not carry it forward.
  Under reading (b) these pairs were wrong already (unknown read as not met), so (b) did not move; but `not_satisfied` is now a stated verdict where `unknown` was.
- **Wrong-record risk, measured in the dataset's own terms** (a read of the fresh answers made after the scoring, `header_risk.mjs`; no gold, not in the frozen code). Every note opens each record with a
  `Record date:` line, so the record a fact sits in is known. Of 1,762 facts dated by a header, 1,511 took that line; 251 took another short dated line, and for 202 of those it printed the same date. 49 facts (2.8%)
  took a date other than their record's: 46 earlier, 3 later; the median distance is 24 days, but the tail is decades (the 90th percentile is 22,347 days): a short line that prints a date of birth is
  indistinguishable by format from a record header. This is the risk the owner accepted; it is small here because every record has a header of its own. After this run a birth-date line stopped counting as a header (`BIRTH_LABEL`); `header_risk.mjs` over the same answers then gives 42 facts (2.4%), median one day apart, at most 726 days. The scores above were not re-taken.
- **HBA1C, which has no window, did not move** beyond what one sample moves it (+0.018 (-0.018 to +0.056)); the standing comparison with the majority baseline is unchanged under (b)
  (0.756 accuracy and 0.7390 micro F1 against 0.766 and 0.7595: still below it) and above it under (c), with the same caveat as before.

Limits of this run, besides those below: the same 162 patients as the second and third runs; one fresh sample, with a changed skill text, so its difference from the third run mixes the text, the writer and the
model's run-to-run variation (the replay isolates the writer and the literal run isolates the guard, each on identical answers, and neither includes the model); the control, second and third runs and the
third run's replay are the earlier predictions, pinned by digest, not re-run; 5 of 162 answers were unreadable JSON (the third run: 2). Spend: CNY 0.79 for the development sample, CNY 3.07 for the fresh sample,
none for the replays: CNY 3.86 of this stream's budget of 30; CNY 16.83 of the hard budget of 200 so far.

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

The runner, the prompt, the assessor and the scorer glue that produced these runs were deleted with the retired fact-extraction path (2026-11-05); the frozen manifests and `results/` stay as the record of what was measured, and the sources they name are in the repository's history at the commits they were written at. `criteria.mjs`, `data.mjs`, `gold.mjs` and `run_official_scorer.py` are read by `evals/vcr-matching-boards/`.

The tests also run with the server's (`apps/server/test/vcrN2c2Eval.test.mjs`); the data-dependent ones skip when the data is absent.
