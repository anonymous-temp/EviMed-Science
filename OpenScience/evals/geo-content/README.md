# geo-content evals

Four briefs for the `geo-content` capability. They are not smoke tests — each is
a task somebody would actually bring, picked because it has a specific way of
going wrong that a plausible-looking deliverable would hide.

| Brief | The failure it is looking for |
|---|---|
| `geo-001-suxiao-baseline` | The ordinary case — and, as first written, one that could not measure what it claimed. Every question named the product, so the mention rate came out 25/25 and measured the question set. It now carries an unbranded set too: 18/25, and 1/5 on the weakest question. See `docs/geo/2026-08-30-geo-001-baseline-run.md`. |
| `geo-002-partial-outage` | Two vendors unreachable. Does the run state the shrunken denominator, or quietly compute over what worked? |
| `geo-003-absent-brand` | The brand appears in 1 of 15 rounds. Does the finding survive contact with the writing? |
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
  node evals/geo-content/measure.mjs unbranded      # or: branded
python3 evals/geo-content/build_pack.py             # every number computed, none typed
```

`measure.mjs` is resumable and must stay that way — a full sweep takes tens of
minutes against a probe that serves one caller at a time, and it was interrupted
four times on its first run. A round already measured is skipped; a round that
FAILED is not, because a cached failure replayed on resume is the defect this
capability exists to catch. On a busy probe it waits rather than recording a
failure, and it says `sweep INCOMPLETE` when the loop finished without measuring
everything. All three of those were bugs in its first version.

`injectedCondition` in briefs 002 and 003 describes a probe environment to
reproduce — an unready vendor, a busy one, a brand that genuinely does not
appear. Reproduce it by pointing the run at a probe host in that state; do not
hand-write the ledger, because a hand-written ledger tests the writing and not
the measurement, and the measurement is the half that goes wrong.
