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

For managed jobs, send `action=start` with only the declared analysis inputs;
omit `waitSeconds` on `start` and `capabilities`. Save the returned `jobId`,
then use `action=status` with that exact id and `waitSeconds=45` for polling.

Record only actual managed worker ids, terminal states and returned artifacts.
If no managed worker ran, distinguish supported in-session interpretation from
managed execution that was not performed. Do not invent a job id, substitute
a platform run/session id, or claim uncomputed managed results. Advisory
bookkeeping notices never justify discarding supported work.


1. Clarify the scientific topic and optional year range. Prefer controlled
   biomedical concepts over a long natural-language conclusion.
2. Call `bibliometric_analysis` with `action=capabilities`, then start the
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
