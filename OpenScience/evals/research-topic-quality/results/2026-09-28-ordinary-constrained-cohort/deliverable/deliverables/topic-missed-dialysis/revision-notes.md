# Revision notes

This file is the designated home for revision notes, replies to a rejection, and process description. Nothing here is part of the report's prose, and no check reads it as report content.

## What this package contains

| File | Role |
|---|---|
| `research-topic-report.md` | The narrative: search scope, field map, gaps, six candidate questions with novelty statements, registry overlap check, prioritisation and next step |
| `evidence-map.md` | The table: one row per work, with identifier, openable URL, channel, axis, which sentence depends on it, and whether the full text was read |
| `research-portfolio.json` | The specialist job's candidate portfolio with this run's reconciliation |
| `evidence-records.json` | The specialist job's 87 evidence records, copied verbatim |
| `research-topic-run.json` | The run receipt: terminal job state, returned artefacts, searches run, coverage gaps |
| the six preserved open-access article directories | The six articles retrieved in full, whose Methods and Limitations were read |

## Companion provenance and what was changed in it

`evidence-records.json` was copied verbatim from the specialist job's output directory. Its 87 records use `pubmed_<PMID>` identifiers, and all 87 carry `publicationStatus: "active"` with `statusCheckedAt` and `statusSource` returned by the bibliographic lookup, so no recommended candidate rests on a retracted or unchecked record.

`research-portfolio.json` preserves the specialist job's three candidate objects (R1, R2, R3) verbatim, including their original `candidateId`, `sourceOpportunityId` and `sourceEvidenceIds`. Six candidates (Q1–Q6) were appended in the same field shape, and a top-level `reconciliation` block records every retain, reframe and exclusion with its reason. Nothing was deleted. The reconciliation is summarised in section 9 of the report so the two documents do not silently differ.

## The final pass and its checks

### Pre-edit copies

Pre-edit copies of all five text artefacts were taken into `_freeze-snapshot/` **before** the first edit of the final pass, with the source file recorded for each. Every comparison below therefore ran between two genuinely different artefacts, and the sizes and hashes of both sides are recorded in `_freeze-snapshot/preservation-report.json`.

### Checks that ran

| Check | What it compared | Result |
|---|---|---|
| Preservation — `evidence-map.md` | snapshot (15,878 B, sha `1d0eeb53…`) vs current (15,913 B, sha `5a3a4b55…`) | Passed. Distinct artefacts. 0 identifiers lost, 0 table rows lost, 57 rows before and after. |
| Preservation — `research-topic-report.md` | snapshot (63,308 B, sha `c91a9c1f…`) vs current (63,488 B, sha `508f6dd2…`) | Passed. Distinct artefacts. No protected number lost or reduced. Reported additions are informational: the pointer marks 45, 46, 47, 48 and 51 and the new reference entry 51. |
| Pointer reconciliation — both directions | citation marks used in the report body vs entries defined in its reference list | Passed, residue empty. 51 marks, 51 entries. Before the repair the residue was four entries (45–48) that no mark reached. |
| Declared-table shape — `evidence-map.md` | first bytes vs the contract's declared columns | Passed after repair. Line 1 is the header row, line 2 the separator, 57 data rows. |
| Capability preflight | required files, citation-to-map coverage, channels, preserved full texts, novelty statements | Passed. 63 works cited, 63 mapped, 63 openable, 7 channels, 6 full texts, 6 candidate questions, 6 novelty statements, 0 issues. |
| Non-mutating pre-submit check | the deliverable as a whole | Passed with an empty notice list. |

### Repairs made in this pass, and the defects they fixed

1. **`evidence-map.md` began with a title and prose above its table.** A declared table whose header sits below a preamble is read by a parser as a one-column file. Repaired by moving the header row to line 1 and carrying the preamble's information below the table as notes. The rows themselves were not touched — the preservation check confirms zero rows and zero identifiers lost.
2. **Four reference entries (45–48) were reached by their raw registry identifiers in the overlap table but by no bracketed mark**, and `NCT05003115` appeared in the report with no reference entry at all. Repaired by adding the bracketed marks in the overlap table and adding reference entry 51. Citation marks and reference entries are now mutually complete.
3. **Two works used for the existence of an approach are conference abstracts, not full papers** — the USRDS count-band analysis and the machine-learning fluid-admission report. Both are now labelled as abstracts in the reference list, and the inline sentence that quotes the USRDS cohort says so. Neither is used to assert a study design or effect size beyond what the abstract states.

### The pre-submit check's notice list, and how each notice was closed

The check was read for its notices, not only for its verdict. The first run returned one defect that would have rejected the deliverable and several advisories; the second returned none. Each notice was repaired in the artefact it named, never in a declaration.

| Notice | Repair |
|---|---|
| **Rejecting:** the evidence map named a storage path for the preserved articles | The path was replaced with a description of the articles; the report's references to the retrieval index and to a preprint-restricted route were reworded the same way. No longer present in any deliverable file. |
| `research-topic-run.json` records no terminal status / no artifacts list for the engine run | The receipt now exposes `jobId`, `status`, `terminalStatus`, `artifacts` and an `engineRun` block at top level, in addition to the nested `specialistJob` record it already carried. |
| `candidates[3..8]` share a `sourceOpportunityId` with an existing candidate | The six added candidates now carry distinct derived identifiers naming the parent opportunity plus the question distinguished. The three original candidates keep the job's identifiers unchanged. The convention is recorded in the portfolio's `reconciliation` block. |
| `candidates[3..8].gaps` must exactly expose absent design fields; unresolved: none | Every design field is supplied for all nine candidates, so `gaps` is empty throughout. The data-availability open items were moved into each candidate's `feasibility` text rather than left in `gaps`, which would have asserted an absent design field. The move is recorded in `reconciliation.gapsMovedIntoSelfFeasibility`. |

### The second preservation run

The repairs above touched four artefacts after the snapshot was taken, so the comparisons were re-run rather than assumed still valid. `evidence-records.json` is the only artefact with an identical hash on both sides, and it is recorded as *not compared*. The map comparison now tracks rows by the work they name rather than by their exact text, because one row was deliberately modified in place; it reports zero works lost, zero works added, zero identifiers lost, and exactly one row modified — the intentional path repair. The report comparison reports no protected number lost or reduced and no citation mark lost.

### Checks that did not run, and why

- **No preservation comparison was possible for `research-topic-run.json`, `research-portfolio.json` or `evidence-records.json`.** Their hashes are identical on both sides, which means the final pass did not touch them. A comparison reporting `ok` for an unchanged file would be a comparison of a file with itself, so it is recorded as *not run* rather than as passed. This is the case the method warns about: identical figures on both sides carry no information.
- **No protected-content baseline existed before this run.** The revisions recorded above were made in the same conversation turn that produced the package, so there is no earlier accepted baseline to compare against; the pre-edit snapshot taken at the start of this pass is the only baseline, and it is used throughout.
- **The reviewer's claim-level audit is not run here.** These checks establish that the bytes are intact, the pointers resolve and the table parses. They do not judge whether each statement is carried by the source beside it; that is what the independent scientific review at submission is for.

## Corrections made to the evidence record

- One cohort figure was initially attributed to a guessed PubMed identifier for the USRDS missed-session analysis. The correct record was resolved through Crossref to DOI `10.1053/j.ajkd.2012.02.181`, which is also where the work is labelled a conference abstract. No identifier in this package is inferred from memory.
- Four works retrieved by the specialist job were not in this run's own earlier searches — most importantly a 115,982-patient national cohort on transportation insecurity and a 60,135-patient case-crossover on inclement weather. Both were retrieved independently and their abstracts read before they were allowed to change the agenda. They closed two directions (weather; patient-level transport) that would otherwise have been proposed as open, and each such closure is stated in the report as a finding.

## Plan revision

The plan's original `studyType` declaration was withdrawn. This deliverable is a topic-selection report that proposes six candidate research questions; it does not report or design one specific study, so no single study-reporting item table applies to it. The declaration was removed rather than satisfied by a checklist whose rows would have had to point at questions instead of at a study.

## The review round

The first submission was accepted and returned 27 review findings, nine of them marked as requiring a response. Every one of the nine was repaired in the artefact it named, and the repairs to the advisory findings were made as well. Nothing was declined.

### Findings requiring a response

| Finding | Defect | Repair |
|---|---|---|
| F01–F04 | Four bare figures — the 7- and 30-day outcome windows and the 30-day recurrence window — appeared without stating where they came from | Each is now labelled at the point of use. The 7- and 30-day windows in Q2 are identified as the published precedent's, adopted for comparability; the 30-day recurrence window in Q4 is identified as the proposal's own design choice, with its reasoning and a note that it should be varied in sensitivity analysis. This is the acceptance item on number provenance, and it was genuinely unmet. |
| F05 | Reference [18] carried the identifier of a paper whose title differed from the entry (title-word overlap 43%) | The title and year were corrected to the indexed record, which is the HED-SMART trial as published in 2018. The citation is the one intended; only the entry's wording was wrong. |
| F06 | §3.3 called an odds ratio of 1.09 "the field's strongest hint", an over-generalisation from a very small effect | Reworded to call it an effect small in magnitude but one of the few modifiable-system signals reported to date. |
| F07 | §4 Gap 1 stated the absence of event-level transport linkage as an absolute | Reworded to "within the channels searched here, no study was found that links…", consistent with the report's stated search boundaries. |
| F08 | §4 Gap 2 said the recorded reason is "never validated", an absolute the bounded search cannot support | Reworded to "was not found to have been validated against an independent record", in the heading and the body. |
| F09 | §4 said the weather study's result "generalises to weather-driven transport failure", which the study does not establish | Reworded to say it addresses weather-driven non-attendance directly, which is the mechanism this project would otherwise have to proxy. |

### Advisory findings, also repaired

| Finding | Repair |
|---|---|
| F10 | "reproduced" changed to "reported", with an added sentence stating that the three cohorts differ in population, exposure definition and outcome ascertainment, so the signal is consistent rather than replicated. |
| F11 | The rate table's row for the national transport cohort now says the missed-treatment outcome is the facility-attributed subset of a broader analysis. |
| F12 | The USRDS figure now states inline that it is a conference abstract and not verified against a peer-reviewed full text. |
| F13 | The 25-case/24-control pilot is no longer set against the national cohort as contradicting evidence; the passage now says all three studies point to measurement of transport as the source of the disagreement, and that the pilot is far too small to be compared with the cohort. The subsection heading was corrected too. |
| F14 | The Q2 novelty figures now carry the citation [6] adjacent to the numbers rather than only later in the sentence. |
| F15 | Q6's precedent claim softened from "establishes that prediction modelling is acceptable" to "suggests that prediction modelling has been applied", with the nomogram's 206-patient questionnaire basis and single-city setting stated. |
| F16 | The five-to-six-to-one comparison now shows each cohort's own internal ratio and says explicitly that it is not a cross-cohort comparison. |
| F17 | The NCT05003115 row no longer says "As above"; it states the specific overlap. |
| F18 | Section 2 now says the record counts are this run's own tally and are itemised in the run receipt, and the per-query tally was replaced with verified counts. Counting the preserved abstracts showed the earlier figure of 35 was wrong: it is 44. That correction is declared in the preservation ledger rather than made silently. |
| F19 | The nomogram row in the evidence map now carries its journal name. |
| F20 | The unresolved-overlap section now names which questions the registry gap affects (Q5 and Q4 most, Q1 and Q6 conceivably) and why Q2 and Q3 rest less on it. |
| F05 follow-up | The reference check resolved 44 identifiers with 1 mismatch before this round and 0 after. |

### Preservation after the review repairs

The repairs above changed the report and the evidence map after the earlier snapshot. Both comparisons were re-run. The map comparison now keys rows by their identifier column, so relabelling a row is not mistaken for losing a work: it reports zero identifiers lost, zero rows lost, and two rows edited in place — the internal path removed at the pre-submit check's request, and the journal name added. The report comparison reports two declared number corrections and no undeclared loss; no citation mark was lost and the pointer residue is empty in both directions.

## The second review round

The submission in which the nine responses were filed returned eight findings, three of them requiring a response, and reported eighteen earlier findings as resolved. All eight were repaired.

| Finding | Repair |
|---|---|
| F01, F02 | The 30-day recurrence window in Q4 appeared in the estimand and the falsification criterion. It is now defined once, in full, under the question's Design field as a parameter of this proposal — not a figure from any study — with the reasoning for choosing it and a requirement to report its sensitivity; the other two places refer back to that definition. |
| F03 | The summary still said "Nobody in the retrieved literature links…", an absolute that contradicted the scoping just applied to Gap 1 and Gap 2. It now reads "Within the literature retrieved for this report, no study was found that links… and none was found that reports…". |
| F04 and acceptance item A10 | The provenance of the specialist analysis's figures was not stated. Section 2 now names the run (topic-20260928043524-416fa9e331a9) and states that its terminal state, returned artefacts and own record counts are preserved verbatim and are not re-derived; section 9 names the same run. The acceptance item asks for published figures to carry citations, specialist-job output to be reproduced as returned, and design parameters to be stated as the proposal's own — all three now hold, and the two unsupported numbers the reviewer counted were the two 30-day windows, which is what F01 and F02 fixed. |
| F05 | The prioritisation table put Q5 first while the "what would change this agenda" text said a positive audit moves Q1 to first rank. The passage above the table now states that the ordering is as at the start of the project, before the audit, and that the first two ranks are expected to swap if the audit is positive. |
| F06 | The Canadian cohort's figure is now described as a multinomial-logistic-regression relative risk ratio for the more-than-three-visits category relative to no visits, rather than an unqualified relative risk ratio. |
| F07 | "The strongest argument available" softened to "one of the few arguments available that non-attendance may be partly a systems property rather than solely a fixed patient trait". |
| F08 | "Reading these as a prevalence range" changed to "Reading these cross-sectional surveys as a prevalence range". |

Two identifiers were refused by the response ledger in this round: the previous round's F06–F09 were submitted against finding IDs that had been renumbered, so the ledger could not match them. They had already been repaired and the reviewer's own record lists them as resolved; the responses for the current round's first three findings are the ones that matter. This is recorded here rather than silently dropped.

### Where a reviewer suggestion was not adopted

The second round suggested labelling section 2's record counts as coming from the specialist task's output. They do not: those counts are this run's own tallies of what each retrieval channel returned, which is a different thing from the specialist job's 87 screened records. Adopting the suggestion literally would have mislabelled this run's tallies as the job's output. Both provenances are now stated separately and distinctly — the job's counts as preserved verbatim, this run's own counts as this run's — which is what the acceptance item actually requires.
