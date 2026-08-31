---
name: meta-analysis
description: Run EviMed's automated systematic-review and meta-analysis pipeline and preserve its evidence, calculation, and release-gate contracts.
metadata:
  evimed-agent: meta-analysis
---

# Automated meta-analysis

Use this skill for a systematic review, quantitative evidence synthesis, pairwise
or network meta-analysis, diagnostic-accuracy synthesis, prevalence or incidence
synthesis, dose-response analysis, prognosis, prediction-model performance, or
IPD meta-analysis. The managed MetaAgent combines LLM-assisted evidence work with
deterministic statistical engines. Do not replace its calculated values with a
language-model estimate.

Unless the user requests another language, pass Simplified Chinese as the job
language and write the EviMed navigation deliverables in Simplified Chinese.
Preserve study titles, identifiers, statistical notation, and generated package
field names where translation would reduce traceability.

## Scope the question

Make the research question concrete enough to identify population, intervention
or exposure, comparator, outcomes, and eligible study designs. State reasonable
assumptions when they do not materially alter eligibility. If the requested
method is unsupported, preserve MetaAgent's fail-closed result instead of
silently switching to an easier analysis.

Uploaded full texts may be supplied through a workspace-relative PDF directory.
IPD input must be a workspace-relative JSON file. Never use a path outside the
current workspace and never describe an abstract or bibliographic record as
full text.

## Execute

1. Call `mcp__evimed__meta_analysis` with `action=capabilities`. If it is unavailable,
   stop and report the exact deployment precondition.
2. Call it with `action=start`, the complete topic, language, and only the
   applicable optional inputs. Record the returned job id immediately.
3. Poll with `action=status`, that job id, and `waitSeconds=45`. A queued or
   running response is not a completed review. Do not manufacture interim study counts,
   effects, GRADE ratings, figures, or conclusions.
4. At the terminal response, preserve the exact `releaseStatus`, artifact paths,
   warnings, blockers, and next actions. `blocked` means the package is not
   submission-ready. `ready_with_warnings` means the warnings still require
   review; it is not equivalent to an unconditional pass.

MetaAgent may legitimately conclude that quantitative synthesis is impossible
or that direct evidence is absent. Report that result as an evidence gap, not as
evidence of no effect. Keep source-acquired facts, extracted values, deterministic
calculations, LLM interpretations, and unresolved review items distinguishable.

## Deliverables

Write `meta-analysis-report.md` as a concise navigation and interpretation layer:
question, protocol scope, search and eligibility summary, synthesis method,
primary results, certainty, limitations, release status, and links to the
generated manuscript, figures, evidence ledger, and package. Every numerical
claim must match the generated artifacts and every evidence claim must remain
traceable.

Write `meta-analysis-run.json` with the job id, terminal job status, release
status, project path, returned artifacts, warnings or blockers, and the retrieval
time. Do not claim completion until both files exist and the managed job is
terminal. This is research evidence synthesis, not an individual treatment
recommendation.

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
