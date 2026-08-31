---
name: mendelian-randomization
description: Run EviMed's managed Mendelian-randomization specialist and preserve its GWAS, statistical, sensitivity-analysis, and STROBE-MR boundaries.
metadata:
  evimed-agent: mendelian-randomization
---

# Mendelian randomization

Use this skill to assess a causal exposure-outcome relationship using genetic
instruments. It is not a generic association analysis. Require an explicit
exposure and outcome, and distinguish forward from bidirectional analysis.

## Execute the managed analysis

1. Call `mcp__evimed__mendelian_randomization` with `action=capabilities`. If the R,
   OpenGWAS, model, or Python runtime is unavailable, report that exact blocker.
2. Start the job with the normalized exposure, outcome, language, and direction.
   Record the job id and poll it with `waitSeconds=45` until terminal.
3. Do not invent SNPs, instrument counts, F statistics, effect estimates,
   heterogeneity, pleiotropy, Steiger direction, or sensitivity results. Those
   values must come from the deterministic MR engines and their files.
4. Treat zero instruments, weak instruments, unresolved sample overlap,
   harmonization failure, and missing sensitivity checks as analysis limits or
   blockers. Statistical significance does not by itself establish a valid
   causal interpretation.

## Deliverables

Write `mendelian-randomization-report.md` with the question, instrument sources,
harmonization, primary and sensitivity estimates, diagnostics, interpretation,
limitations, and STROBE-MR-aligned discussion. Write
`mendelian-randomization-run.json` with the terminal job state and exact returned
artifacts. Every number must match the managed analysis output.

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
