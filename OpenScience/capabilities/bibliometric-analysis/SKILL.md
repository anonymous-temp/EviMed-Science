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
   The job alone can take most of this capability's 20–120 minutes. Keep polling
   while `updatedAt` advances (every 30 s); treat the job as failed only on a
   terminal failure or when `updatedAt` has not moved for 10 minutes, and record
   the state you observed either way.
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

## Method priors

The statistics are the engine's; the reading of them is yours, and two shipped
skills carry the method priors for it — load them before you write the results:
`statistical-analysis` (the estimand, assumptions and their diagnostics, effect
sizes with intervals, multiplicity, missing data, sensitivity analyses) and
`stats-integrity` (report the estimate and its uncertainty as the software
produced it; no causal reading the design does not support). The independent
review checks the report against the reporting checklist for this design and
traces every stated result to the job's own output files, so a number typed from
memory, or rounded differently from the output, comes back as a finding.

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
