---
name: bibliometric-analysis
description: Run EviMed's managed bibliometric specialist for traceable publication trends, networks, topic evolution, and research-frontier analysis.
metadata:
  evimed-agent: bibliometric-analysis
---

# Bibliometric analysis

Use this skill for research-landscape questions based on publication metadata.
It does not estimate clinical efficacy, treatment effects, or evidence certainty.

## Execute

1. Clarify the scientific topic and optional year range. Prefer controlled
   biomedical concepts over a long natural-language conclusion.
2. Call `mcp__evimed__bibliometric_analysis` with `action=capabilities`, then start the
   managed job and poll its job id with `waitSeconds=45` until terminal.
3. Preserve the exact query, retrieval date, database, record count, cleaning
   rules, and network construction settings. Report failed optional modules as
   failed; do not silently describe missing charts or networks as completed.
4. Interpret citation, co-authorship, keyword co-occurrence, burst, and frontier
   measures as bibliometric signals. Do not convert them into study quality or
   clinical importance.

## Deliverables

Write `bibliometric-analysis-report.md` with scope, search strategy, corpus,
methods, trends, networks, topic evolution, frontiers, limits, and links to the
managed figures and tables. Write `bibliometric-analysis-run.json` with the
terminal job state, corpus count, query, and exact returned artifacts.

## Before delivering: two fixed steps

Both run on the finished deliverable, in this order, every time. They are steps
of this capability, not options the run weighs — a pass that happens only when
the model remembers it is a pass that happens on the easy runs and not the hard
ones.

1. **`traceability-review`** — every citation resolves, no number appears in
   prose without a source in the artifacts, and every figure or table matches
   the code that produced it. Findings are repaired before the next step, not
   after: humanizing prose around a citation that does not resolve only makes
   the defect read better.
2. **`manuscript-humanize`** — register cleanup over the prose, with every
   quotation, number, citation index and claim marker byte-identical. Load the
   language-matched upstream rules it names. It is the last thing that touches
   the document.

Write what changed and why to `revision-notes.md` in this deliverable's
directory. That file is the designated home for revision notes, replies to a
rejection, and process description; the report itself carries none of them, and
no check reads the notes as report prose.
