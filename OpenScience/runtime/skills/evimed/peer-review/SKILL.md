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
   `peer_review` with `action=capabilities`, then start and poll the job
   with `waitSeconds=45` until terminal.
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
