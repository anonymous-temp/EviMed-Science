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

For managed jobs, send `action=start` with only the declared analysis inputs;
omit `waitSeconds` on `start` and `capabilities`. Save the returned `jobId`,
then use `action=status` with that exact id and `waitSeconds=45` for polling.

Record only actual managed worker ids, terminal states and returned artifacts.
If no managed worker ran, distinguish supported in-session interpretation from
managed execution that was not performed. Do not invent a job id, substitute
a platform run/session id, or claim uncomputed managed results. Advisory
bookkeeping notices never justify discarding supported work.


1. Confirm the workspace-relative manuscript and its likely article type. Call
   `mcp__evimed__peer_review` with `action=capabilities`, then start without `waitSeconds` and retain the returned `jobId`. Poll with
   `action=status`, that exact `jobId`, and `waitSeconds=45` until terminal. The job alone can take most of this
   capability's 20–120 minutes. Keep polling while `updatedAt` advances (every
   30 s); treat the job as failed only on a terminal failure or when `updatedAt`
   has not moved for 10 minutes, and record the state you observed either way.
2. Preserve the selected reporting rubrics and every evidence location. Separate
   confirmed defects from uncertain findings caused by parsing or retrieval
   limits. Never claim that a missing item is absent when the relevant section,
   table, supplement, or image was not successfully parsed.
   Use maintained spreadsheet readers: `xlrd` (or pandas with `engine="xlrd"`)
   for legacy `.xls`, and `openpyxl` for `.xlsx`. Inventory every sheet's name,
   dimensions, representative populated cells and cell types before judging a
   table's completeness. Zero and False are present values, not missing cells.
   Do not replace a missing reader with an ad hoc binary
   parser: incomplete string or Boolean decoding can look like empty data.
   If extraction cannot be verified, describe that limitation and retain the
   parts of the review supported by readable material.
   Before claiming that a control or comparator is absent, inspect the relevant
   panel and legend; do not infer its absence from a partial text extraction.
   Match cited studies by their actual reference entry and identifiers rather
   than merging distinct papers that use a similar method. Unverified absence
   remains a question, not a confirmed major defect.
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

**What the reader gets.** The deliverable is read by a clinician, pharmacist or
reviewer, not by this platform.

- The package's bookkeeping — which acceptance or checklist item is answered
  where, where a number came from, why an item does not apply — goes to
  `revision-notes.md`, never into a section of the deliverable. A statement
  nobody gave you (conflicts of interest, funding, authorship) is not written.
- Say what a field, status or file means, never its name: 「未排序（未提供评分
  细则）」, not `ranking: withheld`. No JSON keys, enum values, job or run ids,
  file paths, or sentences about this deployment, its tools or its routing.
- A count, sum, share or formula result the run makes itself — sources, rows,
  categories, placeholders — is computed by a script over the file that holds
  the items and copied from its output, with its definition beside it; count
  again after the items change. Where a tool does not state how it computed a
  value, say so; never reconstruct the formula.
- Reference entries — title, authors, journal, year, DOI, PMID — are copied
  from the record the retrieval tool returned, never typed from memory.
- Write in the language of the user's request: a brief written in English gets
  an English deliverable.
