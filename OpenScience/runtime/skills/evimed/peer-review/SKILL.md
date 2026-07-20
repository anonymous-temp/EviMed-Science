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
   `evimed_peer_review` with `action=capabilities`, then start and poll the job
   with `waitSeconds=60` until terminal.
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
