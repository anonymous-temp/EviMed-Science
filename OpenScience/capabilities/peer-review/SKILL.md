---
name: peer-review
description: Run EviMed's managed multi-rubric peer-review specialist for methodology, statistics, reporting, integrity, and actionable revision findings.
metadata:
  evimed-agent: peer-review
---

# Peer review

Use this skill only for a manuscript file available in the current workspace.
The review is decision support for authors and editors, not a journal decision.

## Execute

1. Confirm the workspace-relative manuscript and its likely article type. Call
   `mcp__evimed__peer_review` with `action=capabilities`, then start and poll the job
   with `waitSeconds=45` until terminal.
2. Preserve the selected reporting rubrics and every evidence location. Separate
   confirmed defects from uncertain findings caused by parsing or retrieval
   limits. Never claim that a missing item is absent when the relevant section,
   table, supplement, or image was not successfully parsed.
3. Keep methodological, statistical, reporting, integrity, and narrative issues
   distinct. Consolidate duplicates and calibrate severity to the effect on
   validity, reproducibility, or interpretation.
4. If the pipeline fails, report a failed job. Do not turn an exception into a
   synthetic completed review or a default recommendation.

## Deliverables

Write `peer-review-report.md` with scope, parsing coverage, rubrics, strengths,
fatal and major issues, minor issues, statistical findings, evidence locations,
and actionable revisions. Write `peer-review-run.json` with terminal status,
rubrics, recommendation, confidence, and exact returned artifacts.

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
