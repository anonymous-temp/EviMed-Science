---
name: geo-content
description: Measure how the consumer answering engines answer a set of real questions, then write evidence-bound content blocks a later measurement can be compared against.
metadata:
  evimed-agent: geo-content
---

# GEO content

Use this skill when someone needs to know **whether their product shows up when a
patient asks an AI, and whether what it says is right** — and then wants content
that stands a chance of being cited correctly next time.

Two halves, in this order, always: **measure, then write.** A pack assembled
before anyone looked is a brochure with citations attached.

Unless the user asks otherwise, work and write in Simplified Chinese. Keep
official product names, approval numbers, label wording, statistical symbols and
source titles in their original form — translating them destroys the reachback
that makes the pack checkable.

---

## Part one: the measurement

### It has a denominator, so it can be wrong

Everything else in this platform retrieves; this measures. A retrieval that fails
leaves a gap somebody notices. **A measurement that fails and gets recorded
produces a number that is simply wrong and looks exactly like a correct one.**

Three things are not the same, and collapsing any two of them is the single most
expensive mistake available here:

| What happened | What it means | What it must never become |
|---|---|---|
| The vendor answered, and did not mention the brand | A finding. Counts. | — |
| The vendor errored, timed out, or was busy | A **measurement failure**. Retry it. | "did not mention the brand" |
| The vendor was not logged in | It was **never asked**. | "did not mention the brand" |

`mcp__evimed__geo_visibility_probe` marks all three for you: `inDenominator` is true only for
the first. Take it at its word. If it returns `measurement: "failed"`, you did not
measure — say so, or retry, but do not compute a rate over it.

**Run `op: "providers"` before any batch.** A batch started against an unready
vendor spends its whole run producing failures, and you find out at the end.

### One question, one platform, one fresh session

`newChat` defaults to 1 and should stay there. A warm session measures the
conversation, not the question. Ask each platform separately — a "multi-platform"
round that shares context is one measurement wearing five labels.

Record the **surface** beside every number: `mode` (default or deep) and
`session` (new_chat or continued). Without it, a client who reproduces your
result on their phone in a different mode sees a contradiction rather than a
different measurement, and the whole report goes with it.

### The probe is one caller at a time

HTTP 429 / `geo_probe_busy` means wait, not "no answer". Retry it. Never cache
it — a cached failure makes a resumed batch replay the failure forever while the
progress bar advances.

### What lands on disk

- `geo-probe-log.jsonl` — one line per probe call: question, platform, surface,
  timestamp, latency, `inDenominator`, `answerDigest`, `screenshotName`. This is
  the raw ledger. Every number in the report must be recomputable from it alone.
- `geo-monitor.csv` — one row per (platform × question × round), with the date.
  This is what the *next* run compares against; industry experience is 60–90 days
  before movement, so the file matters more than this run's number does.
- `geo-measurement.md` — what you measured, what you did not, and what the
  numbers are. **Open it by saying what this round did not cover** — which
  platforms, which modes, which question types. A reader who learns the scope
  after the number has already believed the number.

### Rates, honestly

- Denominator = rounds that actually measured. Not rounds attempted.
- If failures shrank the denominator, **write both numbers**. 1/1 and 1/2 are not
  a rounding difference; one of them is double the other.
- Never write a rate to more precision than the denominator supports. Three
  rounds do not produce 33.3%.
- Measured and estimated never share a cell, a column, or a colour. If you
  project anything, it goes in its own column with its own label, and no
  projection may exceed what the measured evidence supports.

---

## Part two: the content

### The three paragraphs are the unit

Every content block is **conclusion → basis → conditions**. Not a heading and
three bullets; three paragraphs, in that order, each doing its own job:

- **Conclusion** — the answer, first sentence, plainly. An answering engine that
  has to read four paragraphs to find the claim will quote the fourth paragraph.
- **Basis** — what makes it true, with the citations. Two resolvable citations
  minimum; a label clause counts and is often the strongest one.
- **Conditions** — who it does *not* apply to, and when it stops being true.
  This is the paragraph that keeps the block honest and, in practice, the one
  that gets cited when a patient's question has a qualifier in it.

A block missing any of the three is rejected by the contract. That is not style
enforcement — a two-paragraph block is a claim with no stated limits, which in a
medical context is the defect.

### Bound to evidence, not to a marketing brief

- Every claim in a block traces to a citation in `citation-ledger.csv`.
- A claim that goes beyond the label is off-label. It does not go in the pack.
  Not softened, not hedged — out. Check with `mcp__evimed__drug_label_search` when unsure.
- Claims about a competitor need the same evidence as claims about the product.
  "Not mentioned by the engines" is a measurement about the engines, not a fact
  about the competitor.
- Author credential and update date on every block. They are contract fields
  because E-E-A-T is what the engines weigh, but they are also just true: a
  medical claim with no responsible name is not finished.

### The machine-readable side

- `jsonLd` per block: schema.org `MedicalWebPage`, plus `MedicalCondition` or
  `Drug` where the block is about one. This is the part the engines parse.
- `llms.txt` — the site-level fragment pointing at the pack.
- An `faq` block for the pack. Questions in the user's words, taken from the
  question set you actually measured, not invented.

### Registers do not mix

`geo-content-pack.md` is what a reader sees. Anything about *how the work went* —
what you revised, what failed, what you would do next round — goes in
`revision-notes.md`. That file exists so the report can be held to a register the
notes are not; it is an outlet, not a trap, and nothing in it is scanned for
tone.

Do not write tool names, gateway names, platform hostnames, internal ids, or
first-person retrieval narration into pack prose. "查了知网发现…" is a diary
entry; the reader needs the finding and the citation.

---

## Before you submit

### The two fixed steps

Both run on the finished pack, in this order, every time. They are steps of this
capability, not options the run weighs — a pass that happens only when the model
remembers it is a pass that happens on the easy runs and not the hard ones.

1. **`traceability-review`** — every citation resolves, every number in prose has
   a source in the artifacts, and every rate can be recomputed from
   `geo-probe-log.jsonl`. Repair findings before the next step: humanizing the
   prose around a rate whose denominator is wrong only makes the defect read
   better. This step matters more here than anywhere else in the platform,
   because a GEO pack's numbers are the deliverable.
2. **`manuscript-humanize`** — register cleanup over the pack prose, with every
   quotation, number, citation index and claim marker byte-identical. Load the
   language-matched upstream rules it names. It is the last thing that touches
   the document.

Write what changed and why to `revision-notes.md` in this deliverable's
directory — revision notes, replies to a rejection, and process description all
live there, and the pack itself carries none of them.

### Then submit

```
evimed_submit_deliverable{deliverableId: "<your deliverable id>"}
```

It answers with the verdict, in place. A first submission that comes back with
issues is the normal case, not a failure: fix everything it lists as 必修, submit
again, repeat until it answers `ok`. The rules it applies are the same ones the
server applies afterwards — there is one implementation of them, so a package
this accepts is a package the server accepts.

The verdict also carries advisory issues. **For this capability they are the
ones to read most carefully**, because every one of them is about a number:
nothing measured, a failed round counted, a surface not recorded, a denominator
larger than the ledger supports. They do not decide the outcome. A pack that
ships with any of them still standing is a pack whose numbers you have chosen
not to defend.

Do not read the gate's source to work out what will pass. A pack written to
satisfy a checker rather than a reader is the failure this whole arrangement
exists to prevent, and it is visible in the output.

## What this capability does not do

- It does not decide whether content may be published, or who may publish it.
- It does not rank you against competitors on anything but what was measured.
- It does not promise movement. 60–90 days is the industry's own experience, and
  this run produces a baseline plus a comparable file, not an outcome.
