# VCR baseline diagnostic audit

The frozen November 3 TrialGPT platform baseline reconciles to **1,015 units: 256 label agreements, 347 disagreements and 412 unresolved alignments**. The audit replayed the retained first-attempt case files using the pinned alignment implementation and reproduced the saved geometry and product rows. It did not modify the scorer, substitute later attempts, or make new inference calls.

Of 53 attempts, 31 saved a completed feature result, 12 failed, five timed out, three were interrupted and two ended without a saved feature result. Of 105 requested patient–trial pairs, 72 returned at least one criterion row and 33 returned none. The latter account for all 312 units in the scorer’s `no_overlap` bucket. Some incomplete attempts still returned usable rows.

| Frozen comparison | EviMed agreement | Historical TrialGPT agreement on the same units |
| --- | ---: | ---: |
| All aligned units | 256/603 (42.5%) | 519/603 (86.1%) |
| Aligned units from completed attempts | 227/512 (44.3%) | 436/512 (85.2%) |

## Unresolved units: 412

| Earliest observable stage | Units | What the trace establishes |
| --- | ---: | --- |
| No candidate write or verified exact registry lookup observed | 273 | No criterion rows for the requested pair. The transcript does not show a candidate write or verified lookup. The supplied attachment may still have been available. |
| No candidate write after verified registry lookup | 35 | The exact frozen record was returned; no candidate write appears for the pair. |
| Candidate write rejected | 4 | The exact source clause was present in a rejected candidate item. No criterion rows came back for the pair. |
| Source anchor unresolved | 18 | Eight annotation fragments could not be located verbatim, one was empty, and nine occurred more than once in the eligible source section. |
| Clause geometry unresolved | 82 | 55 partial overlaps, 16 unresolved merges, eight unresolved splits and three further ambiguous overlaps. Their geometry is observable. The trace does not establish a clinical verdict or why those boundaries differ. |

The first three rows cover 33 pairs: 28 without a verified lookup or candidate write, three with a verified lookup followed by no candidate write, and two with rejected writes containing exact clauses. These are observations of retained traces, not a claim that an upstream failure caused every missing pair. One conversation reported as having no matching result read both exact registry records and also attempted broad retrieval; it never wrote candidate criteria.

The original scorer buckets remain unchanged: 312 no overlap, 55 partial overlap, 16 unresolved merge, 12 ambiguous overlap, nine source unlocated and eight unresolved split. Of the 412 unresolved units, 76 came from completed runs, 199 from failed runs, 82 from interrupted runs, 39 from runs without a feature result and 16 from timed-out runs. No scorer issue indicates a rejected or unverified source collection among the rows that were returned.

## Aligned disagreements: 347

| Earliest observable stage or unresolved attribution | Reference not excluded / product unknown | Other disagreement | Total |
| --- | ---: | ---: | ---: |
| Source-to-rule qualifier loss verified in the frozen candidate write | 1 | 1 | 2 |
| Code returned unknown; cause uncertain | 256 | 45 | 301 |
| Model returned unknown; cause uncertain | 21 | 15 | 36 |
| Applicability verdict observed; cause uncertain | 0 | 1 | 1 |
| Decisive label disagreed; cause uncertain | 0 | 7 | 7 |
| Total | 278 | 69 | 347 |

The two confirmed source-to-rule losses involve a missing symptomatic-arrhythmia alternative and a changed relationship among disease, stability and procedures. Neither structural finding proves how the complete condition applies to the note. Two further losses appeared in label agreement controls: a missing threshold or class range in a risk-factor rule and a missing disease subtype. Those agreements do not establish that the executable rule is sound.

A saved unknown shows what the evaluator returned. The optional displayed request comes from the rule’s predefined evidence requirements, and the displayed reason reports the evaluator’s first gap. Neither independently establishes absence from the note. The private table keeps the raw state, decision producer, reason and returned evidence, where available, beside the original labels and trace locators. True missing information, available facts lost during grounding, applicability, semantic interpretation and reference-policy differences remain open where the retained record cannot separate them. The audit assigns no clinical reference error and makes no blanket conversion from unknown to a favorable label.

## Independent evidence review

The private review deck contains **310 rows**: every one of the 278 unknown-versus-not-excluded units and 32 agreement controls. Four agreement controls target independently observed rule or inference questions; the remainder are deterministically selected across criterion and shared-verdict strata. The controls serve as a diagnostic sample. Their results cannot estimate the rate of unsupported agreement across the benchmark without a separate sampling analysis.

The deck mixes targets and controls under opaque IDs. Each packet contains the frozen full note, the anchored original condition, its surrounding protocol text and the frozen trial context. The reviewer sees neither comparator labels nor system decisions, selected evidence, trace diagnostics or queue assignments. The operator’s mapping is stored separately. Independent judgments and any later adjudication should be retained as separate records. **No clinical review or adjudication has been performed.**

Record the evidence and decision axes independently:

- A direct observation carries its source quote, subject, assertion and any source-supported time, value or unit. An explicit denial carries the scope, subject and time it actually covers.
- A supported derivation carries its quoted inputs, rationale and rule or calculation. A diagnosis may support a bounded inference; it does not supply an unobserved measurement or event.
- Absent or conflicting information carries the unresolved proposition and what would resolve it. Unknown applicability stays distinct from explicit non-applicability. Evaluate an exclusion as its original proposition before applying eligibility inversion.
- Unprocessed, interrupted, rejected or otherwise failed work carries a separate execution disposition. A completed clinical unknown requires an evaluation with identified missing evidence. Preserve the legacy scorer’s labels for the paired baseline and version any changed product contract.

The frozen diagnostic inputs and reference mapping are reproducible. The campaign used DSH 0.2.1-rc.5 and a configuration of `deepseek-flash`; the retained receipts do not verify effective thinking or output limits for each inference call. Freeze and verify those settings, the treatment protocol and the independent comparison panel before a paid experiment. This inspected public sample is for development and regression, and the sealed n2c2 partition was untouched. Clinical adjudication, a paired product rerun, clinical holdout validation and deployment remain separate.

Baseline: [November 3 results](2026-11-03-evimed-trialgpt-platform-baseline-results.md). Next gates: [recovery plan](2026-11-03-vcr-next-stage-todo.md).
