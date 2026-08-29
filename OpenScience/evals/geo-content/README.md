# geo-content evals

Four briefs for the `geo-content` capability. They are not smoke tests — each is
a task somebody would actually bring, picked because it has a specific way of
going wrong that a plausible-looking deliverable would hide.

| Brief | The failure it is looking for |
|---|---|
| `geo-001-suxiao-baseline` | The ordinary case. Run end to end against the live probe, so the expected shape is observed rather than imagined. |
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

`injectedCondition` in briefs 002 and 003 describes a probe environment to
reproduce — an unready vendor, a busy one, a brand that genuinely does not
appear. Reproduce it by pointing the run at a probe host in that state; do not
hand-write the ledger, because a hand-written ledger tests the writing and not
the measurement, and the measurement is the half that goes wrong.
