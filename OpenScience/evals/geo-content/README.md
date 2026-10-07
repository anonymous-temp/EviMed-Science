# geo-content evals

Since 2026-09-25 (`geo-content` 2.0.0, the 「循证 GEO」 module) the capability
writes layered articles and correction materials, and the platform measures.
`geo-005`…`007` grade that: a first batch for a prescription medicine, a
correction for a measured 讲错我方, and existing drafts that carry unsafe advice.
The four below are kept as the measurement corpus — the platform's probe queue
is held to the same failure modes, and `measure.mjs` still reads their
question sets.

Four briefs for the measurement half of `geo-content` 1.x. They are not smoke
tests — each is a task somebody would actually bring, picked because it has a
specific way of going wrong that a plausible-looking deliverable would hide.

| Brief | The failure it is looking for |
|---|---|
| `geo-001-suxiao-baseline` | The ordinary case — and, as first written, one that could not measure what it claimed. Every question named the product, so the mention rate came out 25/25 and measured the question set. It now carries an unbranded set too: 18/25, and 1/5 on the weakest question. See `docs/geo/2026-08-30-geo-001-baseline-run.md`. |
| `geo-002-partial-outage` | Vendors drop out mid-batch. Does the run state the shrunken denominator? Run 2026-08-30: 12/15 mentions — and a competitor at 14/15, higher than the brand. Being surrounded is not being absent. |
| `geo-003-absent-brand` | The brand barely appears. Does the finding survive contact with the writing? Run 2026-08-30: 3/15, 0/5 on one question — and that zero turned out to be the engines placing the product correctly, which changed what the brief grades. |
| `geo-004-off-label-question-set` | Patients ask off-label questions. Does the run measure them without endorsing them? |

The common thread is that in every one of them the wrong answer **looks
finished**. A three-platform result presented as five platforms, a 1/15 softened
into "emerging presence", a hedged off-label block — none of these are missing
anything a reader would notice. That is why they are the evals.

## What is checked mechanically, and what is not

The deterministic half runs in `apps/server/test/geoContentPack.test.mjs`: the
contract's blocking rules and its measurement notices, exercised one broken pack
at a time. There is one implementation of those rules and a run reaches it
through `evimed_submit_deliverable`, so there is no second copy to keep in
agreement — the capability deliberately ships no `preflight.py`, and a test
holds that line.

The half these briefs cover is not mechanical. Whether an unflattering number
appears before the framing of it, whether a denominator is stated twice, whether
an off-label question is measured without being answered — none of that is
decidable from the artifacts, and writing a regex for it is the mistake this
codebase already made once (principle #5). These are model-judged, and the
`mustDo` / `mustNotDo` lists are the rubric.

## Running

The briefs are inputs to a capability run, not a script. Give one to the
orchestrator and grade the deliverable against its own lists.

The measurement half can also be run on its own, which is how geo-001 was first
executed (2026-08-30, results under `results/2026-08-30-geo-001/`):

```bash
OPEN_SCIENCE_GEO_PROBE_URL=... OPEN_SCIENCE_GEO_PROBE_ALLOW_PLAINTEXT=1 \
  node evals/geo-content/measure.mjs geo-002 unbranded   # brief id, then set
python3 evals/geo-content/build_pack.py                 # every number computed, none typed
node evals/geo-content/tier_distribution.mjs           # what the notices fire on, across every run
```

`measure.mjs` is resumable and must stay that way — a full sweep takes tens of
minutes against a probe that serves one caller at a time, and it was interrupted
four times on its first run. A round already measured is skipped; a round that
FAILED is not, because a cached failure replayed on resume is the defect this
capability exists to catch. On a busy probe it waits rather than recording a
failure, and it says `sweep INCOMPLETE` when the loop finished without measuring
everything. All three of those were bugs in its first version.

Question sets live in `briefs.json` and nowhere else — `measure.mjs` reads them.
A set that lived in both would drift, and telling the branded set from the
unbranded one is the whole point of geo-001.

Nothing is injected. The failure conditions these briefs are about happen on
their own: geo-001 lost 20 of 70 attempts to a busy probe and vendor timeouts,
and geo-003's brand really is nearly absent from two of its three questions.
Do not hand-write a ledger — a hand-written ledger tests the writing, and the
measurement is the half that goes wrong.

## Independent pharmacist calibration

`calibration/dataset-template.json` is empty on purpose. Copy it with
`rubric.json` into a private annotation directory and fill the schema-defined
units, pseudonymous raters and independent ratings. Freeze each answer, its
Unicode codepoint spans, source files and SHA-256 hashes before labeling.
Use the same `groupId` for an answer/project cluster and keep that cluster in
one data split. Record blinding and the actual qualification basis; a model
rating cannot become a pharmacist reference. Keep initial/repeat rounds and
later supplied consensus references separately, with their originating rating
IDs and a prespecified `analysis.referenceRule`. Never overwrite the labels.

```bash
python3 -m venv /tmp/evimed-geo-calibration
/tmp/evimed-geo-calibration/bin/pip install -r evals/geo-content/calibration/requirements.txt
/tmp/evimed-geo-calibration/bin/python evals/geo-content/calibration/agreement.py \
  /private/calibration/dataset.json --split held_out --output /private/calibration/report.json
```

The loader verifies schema, source/rubric/answer digests, statement offsets,
rating uniqueness, reference provenance and group split separation. Files must
remain inside the annotation directory; symlinks are refused. Outputs use
exclusive creation. The empty template produces `awaiting_independent_labels`
and no agreement results. `severity_basis` stays `initial`; this offline report
never changes live delivery behavior or declares clinical validation.

The report separates nominal verdict agreement from S0–S4 severity agreement
(linear weighted Cohen kappa, with quadratic weighting as a sensitivity), and
uses genuine ordinal Krippendorff alpha for incomplete multi-rater data.
Singleton units supply no alpha coincidences. Correct/unverifiable ratings and
missing severity remain missing, never S0. Disputed/unresolved references stay
out of model comparisons. Serious-error sensitivity requires reference S3/S4
and a model wrong/S3/S4 label; missing model ratings and wrong verdicts with missing severity have separate
counts and are excluded from its assessed denominator. Missed unit IDs remain available
for follow-up. None of these measures makes the supplied reference infallible.

Intervals resample `groupId` clusters (999 seeded draws by default), report
undefined draws, and remain unavailable with fewer than two clusters or more
than 20% undefined resamples. Small samples and nonrandom missingness limit
these descriptive intervals. The default split is `held_out`; explicitly use
`--split codebook_pilot` for calibration rounds, never describe them as untouched
validation. `--split all` is an explicit pooled descriptive analysis.

Algorithm checks use synthetic fixtures and independent pinned implementations
in `calibration/tests/requirements.txt`, including the maintainer's documented
missing-data example. These test labels are not an empirical pharmacist corpus.
Run `python -m unittest discover -s evals/geo-content/calibration/tests` after
installing those test dependencies.

Primary method references: [Cohen kappa API](https://scikit-learn.org/stable/modules/generated/sklearn.metrics.cohen_kappa_score.html),
[Krippendorff's computation note](https://www.asc.upenn.edu/sites/default/files/2021-03/Computing%20Krippendorff%27s%20Alpha-Reliability.pdf),
[ordinal reference implementation](https://github.com/pln-fing-udelar/fast-krippendorff),
and [NCC MERP outcome index](https://www.nccmerp.org/types-medication-errors).
The last classifies actual medication-error outcomes. The platform's prospective
information-harm S0–S4 rubric is a local adaptation, not its official conversion.
