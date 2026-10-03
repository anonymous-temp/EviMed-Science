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
Preserve study titles, identifiers, and statistical notation.

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

For managed jobs, send `action=start` with only the declared analysis inputs;
omit `waitSeconds` on `start` and `capabilities`. Save the returned `jobId`,
then use `action=status` with that exact id and `waitSeconds=45` for polling.

Record only actual managed worker ids, terminal states and returned artifacts.
If no managed worker ran, distinguish supported in-session interpretation from
managed execution that was not performed. Do not invent a job id, substitute
a platform run/session id, or claim uncomputed managed results. Advisory
bookkeeping notices never justify discarding supported work.


1. Call `mcp__evimed__meta_analysis` with `action=capabilities`. If it is unavailable,
   stop and report the exact deployment precondition.
2. Call it with `action=start`, the complete topic, language, and only the
   applicable optional inputs. Record the returned job id immediately.
   A start with exactly the same request returns the job already running or
   finished for it, and resumes a failed one from its last completed step; if
   you lose the job id, repeat the identical request rather than a reworded one.
   A finished job, whatever its release status, is returned and never run again.
   While a job runs, a different request is refused with the running job's id.
3. Poll with `action=status`, that job id, and `waitSeconds=45`. A queued or
   running response is not a completed review. Do not manufacture interim study counts,
   effects, GRADE ratings, figures, or conclusions.
   The job alone can take most of this capability's 30–180 minutes. Keep polling
   while `updatedAt` advances (every 30 s); treat the job as failed only on a
   terminal failure or when `updatedAt` has not moved for 10 minutes, and record
   the state you observed either way.
4. At the terminal response, record the exact `releaseStatus`, artifact paths,
   warnings, blockers, and next actions in `meta-analysis-run.json`. The
   terminal response is the answer to this request. A job that wrote its
   manuscript (`deliverable` true) is delivered whatever its `releaseStatus`:
   `ready` passed every release check; `ready_with_warnings` carries advisory
   findings (style, completeness, bookkeeping) a reader can see; `blocked` means
   a check that protects the reader failed - a pooled number whose study inputs
   were not verified, a pooled result the manuscript does not state as computed,
   a citation number with no reference - so the manuscript is presented as
   unverified, with those findings. Never start the job again, reworded or not,
   to clear a finding or reach a better status: it repeats the retrieval and
   extraction and reproduces the result. The job no longer stops for a request
   it can plan only approximately or for too few studies to pool: it records
   the deviation, or writes the narrative evidence-gap report, and delivers. A
   job that still stops before writing a manuscript says why; report that as
   the finding and do not restate the request to get past it. A failed job names
   the steps it completed and the files it wrote; report them as partial work,
   resume once as its next action says, and never present them as a review.
   The job decides some things without asking, and its `modules` name each:
   studies excluded at full text (unusable text, unresolved design), results
   left out of pooling with the reason their verification gave (the verifier
   judged the comparison ineligible, the source contradicts itself, a number
   was not found, the verifier gave no usable answer), unregistered trials
   counted by their own publication, a protocol that differs from the question
   (which outcome was analysed as primary, which as secondary, and why), and a
   narrative synthesis written because too few studies could be pooled. Name
   each, with its reason in plain words, in the limitations; a left-out result
   was not pooled.

MetaAgent may legitimately conclude that quantitative synthesis is impossible
or that direct evidence is absent. Report that result as an evidence gap, not as
evidence of no effect. Keep source-acquired facts, extracted values, deterministic
calculations, LLM interpretations, and unresolved review items distinguishable.

## Deliverables

Write `meta-analysis-report.md` as a concise navigation and interpretation layer:
question, protocol scope, search and eligibility summary, synthesis method,
primary results, certainty, limitations, and, in plain words, whether the
engine's own manuscript is ready for release and why not - each finding of
`package/release_decision.json` (its failed and warning gates, with their
details and locations) said as what it means for the reader. Every numerical
claim must match the generated artifacts and every evidence claim must remain
traceable. Every count and total - records, exclusions, studies, participants -
is copied from the engine's records (the project's `prisma_flow.json` and
`package/evidence_accounting.json`, which also states whether the counts add
up), never added up in the report. Release and blocker codes, job ids,
file paths and field names are bookkeeping for `meta-analysis-run.json` and
`revision-notes.md`, not for the reader; nor does the report carry author,
funding or conflict-of-interest declarations - the run is not an author.

Preserve evidence statuses when compressing the accounting into prose: rows
with unconfirmed quotes are not verified results, while a verified row omitted
to avoid duplication is a different case. Raw database retrieval counts and
post-deduplication flow counts use different denominators; state each scope
separately unless a recorded mapping establishes their overlap. Keep usable
analyses while describing these limits, without inventing an adjudication step.

Write `meta-analysis-run.json` with the job id, terminal job status, release
status, project path, returned artifacts, warnings or blockers, and the retrieval
time. Do not claim completion until both files exist and the managed job is
terminal. This is research evidence synthesis, not an individual treatment
recommendation.

## Method priors

The statistics are the engine's; the reading of them is yours, and two shipped
skills carry the method priors for it — load them before you write the results:
`statistical-analysis` (the estimand, assumptions and their diagnostics, effect
sizes with intervals, multiplicity, missing data, sensitivity analyses) and
`stats-integrity` (report the estimate and its uncertainty as the software
produced it; no causal reading the design does not support). The independent
review checks the report against the reporting checklist for this design and
traces every stated result to the job's own output files. Write each result from
the engine's display value; rounding is checked, not forbidden.

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
