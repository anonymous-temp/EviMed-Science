# Primary Analysis Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking. This task is already authorized; the parent agent owns independent review, commits, fresh managed evaluation and deployment.

**Goal:** Prevent quantitative primary pooling unless a current, source-anchored judgment confirms that each contributing result matches the review outcome, population and intervention/comparator contrast.

**Architecture:** Extend the existing separate Step 3 extraction verification response with three per-row judgments. Deterministic code verifies complete quote anchors, binds accepted assessments to the full PICO plus the checked row and source snapshot, and records runtime provenance separately from model output. The shared selector admits all-match current proofs, excludes explicit mismatches, and returns the existing `PhaseResult.needs_input` for missing, uncertain, malformed, forged or stale proofs before any primary pool or reuse of cached statistics.

**Tech Stack:** Python 3.10, Pydantic v2, existing MetaAgent structured-output call, checkpointed `Project`, pytest. No new model call, semantic regex, permission route, or statistics implementation.

## Observed defects and boundary

The completed 2026-09-11 managed job selected `39216659:0` (MD 4.4 eGFR slope difference) as HR and `39844714:0` (incidence by diuretic intensification) as HR. The separate numeric patch now refuses both. Row `27539604:18` remains a reported 30% eGFR decline in a broader population, whereas the protocol asks for a sustained 50% decline/composite in CKD. `outcome_matches()` token overlap and an empty subgroup are insufficient proof of outcome/population/contrast alignment. A shared source word, `is_primary` within a paper, or generic manual acceptance must not authorize the review's primary analysis.

Preserve all historical workspaces and receipts. New analysis may retain rejected raw rows but must not call their derived pool clinically valid.

## File ownership

- Modify `项目代码/meta/new_meta/schemas/study.py`: typed model-facing dimension assessments and runtime-only proof attachment on `OutcomeData`.
- Create `项目代码/meta/new_meta/core/primary_analysis_alignment.py`: canonical fingerprints, strict full-quote matching, runtime assessment manifest, proof resolution, typed needs-input result, cached selection validation. It contains no clinical inference.
- Modify `项目代码/meta/new_meta/prompts/extraction_prompts.py`: full PICO in outcome extraction and independent checking; explicit dimension criteria and uncertainty instruction.
- Modify `项目代码/meta/new_meta/agents/data_extraction_agent.py`: extend `ExtractionCheckResult`; pass full protocol; discard model-supplied provenance; bind only the final checked row snapshot; expose alignment in extraction review audit.
- Modify `项目代码/meta/new_meta/core/effect_selection.py` and `core/pipeline_runner.py`: source/type checks remain; replace token/subgroup admission with current proof resolution; retain audited exclusions and return needs-input on unresolved candidate rows without marking effect-size completion.
- Modify `项目代码/meta/new_meta/core/extraction_review.py`: optional dimension-specific human adjudication carried through existing revision-checked review decisions; generic accepted/resolved decisions do not count. Runtime validates expected protocol/row/source versions before recording human provenance.
- Modify `项目代码/meta/new_meta/main.py` and `项目代码/meta/start.py`: honor typed selection before reading effects; route Web uncertainty through `method_decision_required`; guard every cached effect/meta/manuscript consumption before reusing a pool.
- Tests: add `项目代码/meta/tests/test_primary_analysis_alignment.py`; extend existing extraction, selector, CLI/Web, review-decision and checkpoint tests at their existing seams. Keep the four already validated numeric-conversion changes intact.

## Task 1: Typed judgments and version-bound proof

- [x] Add failing tests for all-match, mismatch, uncertain, missing, stale and forged proof behavior.
- [x] Run `python -m pytest tests/test_primary_analysis_alignment.py -q` with the original Meta venv; confirm failures reflect missing admission behavior.
- [x] Add the following model-facing shape with `extra="forbid"`; no model-facing field may claim `verified`, `human`, a fingerprint, an assessor or a proof ID:

```python
class AlignmentDimension(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: Literal["match", "mismatch", "uncertain"]
    rationale: str = Field(min_length=1)
    quote: str = ""
    source_location: str = ""

class PrimaryAlignmentAssessment(BaseModel):
    model_config = ConfigDict(extra="forbid")
    outcome_index: int = Field(ge=0)
    outcome: AlignmentDimension
    population: AlignmentDimension
    contrast: AlignmentDimension
```

- [x] Implement canonical SHA-256 functions over sorted JSON. Protocol binding includes complete PICO, question, inclusion/exclusion criteria, requested method/type/measure and protocol version. Row binding includes study identity/population/arms and raw outcome name, type, measure/scale, numeric inputs, source quote/location, timepoint, subgroup and treatment/reference; exclude only the proof itself and generated review metadata.
- [x] Write the checked source text into a content-addressed source snapshot under the project's extraction directory and retain a runtime-created assessment record in an extraction alignment manifest. Resolve an attached proof only when it exactly matches that runtime record and current hashes. The record identifies `extraction-check-v1` or the existing authenticated human review action; model JSON never supplies these fields.
- [x] Require complete normalized quote containment for every match/mismatch dimension. Whitespace and Unicode ligature normalization is allowed; prefix matches, numeric-window matches and counts-only fallback are forbidden. Missing/unverifiable quote or locator converts the dimension to unresolved, never match. Source snapshot paths must be project-contained regular files without symlinks.
- [x] Assert runtime stamping does not modify any raw outcome value or canonical clinical label; altered protocol, source, quote, threshold, timepoint, subgroup, arms or numeric row invalidates the proof.

## Task 2: Independent existing verification call

- [x] Add extraction-agent tests whose first extraction response contains forged alignment metadata, whose check omits rows, whose check contains duplicate/out-of-range indexes, and whose refinement changes a checked row.
- [x] Extend `ExtractionCheckResult` with `primary_analysis_alignment: list[PrimaryAlignmentAssessment]`. Give the checker full PICO and the exact indexed rows plus source content in its existing structured call.
- [x] In the prompt require independent checks of endpoint threshold/component/composite and time horizon, the analyzed population/subgroup, and the actual intervention-versus-comparator contrast. A paper's primary outcome and the review's primary outcome are distinct. Missing source evidence is uncertain; equivalent wording may match based on a supported judgment.
- [x] Clear all model-supplied proof attachments after initial extraction/refinement. Keep the assessment and checked row fingerprint from the last successful check only. Do not stamp an earlier assessment onto a revised final row; exhausted checks, fallback extraction and failed checks leave unresolved proof.
- [x] After quote validation and deterministic extraction finalization, stamp only unchanged checked rows using code-owned fingerprints/assessor. Do not add an extra model call. Preserve source snapshot and explicit review reasons in the audit.
- [x] Run existing extraction tests plus the new checker tests and inspect the actual structured prompt for full PICO and absence of runtime proof fields.

## Task 3: Shared selector and human adjudication

- [x] Add selector tests for 30% versus 50%, component versus composite, broader non-CKD overall population, wrong comparison, and valid paraphrase. Supply explicit typed verified judgments in fixtures; no test may make keyword equality the criterion.
- [x] Evaluate all rows through deterministic metric compatibility and current alignment proof. Explicit dimension mismatch creates an audited exclusion. Missing/uncertain/stale proof creates an audit row with `requires_adjudication=true`; all-match proof is necessary before primary computation/ranking. Do not allow `subgroup=None` or source `is_primary` to override the judgment.
- [x] If any otherwise eligible row is unresolved, produce a `PhaseResult` with `phase=effect_selection`, `status=needs_input`, specific row IDs, diagnostic artifact reference and the existing extraction-review action. Do not write a successful `effect_sizes` checkpoint or let a partial reviewed subset silently define the primary synthesis.
- [x] Extend `ExtractionReviewDecision` only with optional dimension-specific assessments and expected protocol/row/source bindings. Existing revision checking remains. Generic `accepted`, `manual_adjudication=true`, malformed proof or `updated_by=unknown` never produces human alignment authority. A valid explicit dimension decision records current versions through the same runtime helper; stale decisions raise the existing conflict type.
- [x] Verify unchanged raw rows, rejected fake source quotes/assessor fields, and that legitimate model paraphrase judgments and explicit version-bound human decisions are admitted.

## Task 4: CLI/Web and checkpoint consumption

- [x] Add failing CLI/Web tests that return selection `needs_input`; assert no engine, GRADE, manuscript or success checkpoint is reached.
- [x] CLI inspects `selection_result.status` before accessing `data["effects"]`; preserve the typed artifact and use the existing domain-block exit convention. Web receives the same typed result and emits `method_decision_required`, then returns without continuing.
- [x] Guard cached effect/meta/manuscript paths at the common point where old selected results are consumed. A current proof alone cannot legitimize a cached pool built from different selected rows: cached selected row identities and proof fingerprints must match the recomputed current admitted set; otherwise return needs-input/recompute under the existing flow, never relabel old outputs ready.
- [x] Cover `_resume_from_cached_meta_analysis`, `_resume_from_cached_effect_sizes`, `_resume_direct_to_manuscript`, `_write_manuscript_from_artifacts`, Web `_resume_project_payload` and `_rerun_downstream_payload`. Preserve original artifacts as historical diagnostics rather than modifying their recorded evidence. On repeat resume, return the same actionable blocker without an infinite retry loop.

## Task 5: Verification and independent review

- [x] Run focused new/modified tests with `/Users/wangzeyuan/Desktop/EviMedScience/项目代码/meta/.venv/bin/python` from the release checkout's Meta directory.
- [x] Run numeric regression tests, extraction/review tests, phase/CLI/Web tests and checkpoint tests, then `python tests/test_deep.py`.
- [x] Run scoped `git diff --check`. Send the stable diff plus exact test results and remaining limitations to `meta_clinical_review` and the parent. The parent reviews, commits, and starts fresh managed evaluation. Do not edit historical job states or receipts, start another agent job, or deploy from this subtask.

## Required regression matrix

| Case | Expected result |
| --- | --- |
| MD 4.4 slope or incidence 2.5 presented to HR target | Numeric typed refusal remains intact |
| Source 30% threshold versus protocol 50% | Explicit mismatch is excluded |
| Component endpoint versus requested composite | Mismatch excluded; ambiguous aggregation requires input |
| Overall population broader than CKD protocol | Excluded/needs-input per source-backed population verdict |
| Wrong treatment/comparator with matching disease words | Contrast mismatch excluded |
| Valid clinical paraphrase with current verified three-dimension judgment | Admitted despite different label text |
| Missing, unchecked, failed check, duplicate row, malformed or stale assessment | Needs-input before pooling |
| Fabricated/partial quote or forged model assessor | Never admitted |
| Generic human accepted flag | Does not grant alignment |
| Current explicit dimension adjudication | Admitted only when all dimensions match |
| Cached pool with different/stale selected rows | Refused or recomputed through the guarded path |
| Repeated blocked resume | Stable typed needs-input, no success checkpoint and no loop |

## Review checkpoints

The independent clinical reviewer checks this plan before implementation and the resulting diff before parent integration. All release actions are already authorized by the user; there is no additional confirmation gate in this plan. Commit ownership stays with the parent agent.

### Clinical specification review clarification

Approved by the independent reviewer before implementation, with these concrete refinements:

- Run the existing independent checker after batch overrides and RCT reconciliation so the checker sees final clinically meaningful row/protocol fields. Refinement discards previous judgments; deterministic finalization precedes the next existing check. A later clinical mutation invalidates the proof rather than silently rebinding it.
- Size the existing check response budget from the number of rows within the configured extraction budget; require unique in-range row indices. Missing or duplicated rows stay unknown.
- Bind the proof to both the exact checker source snapshot and the actual source file hash when a local PDF/fulltext file supplied the text. Changing bound source bytes invalidates it.
- A verified clinical paraphrase is admitted even when the old lexical matcher disagrees. Explicitly unrelated secondary rows can be excluded by the checker's outcome mismatch; missing judgments cannot be silently treated as irrelevant.


### Direct IPD boundary approved during implementation

The paper-quote alignment mechanism applies to literature-derived results. Direct
participant-data ingestion retains its existing typed dataset contract. This is
recognized only when the selected rows are typed `IPDStudyData`, belong to the
current `ipd_ingestion.json` dataset digest and result set, and their current
hash-chained ledger events came from the existing `ipd_dataset_import` actor and
`ipd-ledger-v1` importer with participant counts and source-digest locators. A
protocol family label alone is insufficient. The returned phase states
`primary_alignment_scope=direct_ipd_dataset_contract`; it never claims a paper
alignment match. Positive imported-IPD and invalid-ingestion-digest tests cover
this boundary.


### Final compiled-cache closure

Compiled literature and direct-IPD methods retain a separate pool binding written
only after a successful guarded engine execution. Complete-Web resume and
review-decision artifact refresh verify the plan, protocol, ledger head, selected
analysis set, method output and synthesis envelope before touching a cached
package. Literature also rechecks current source rows and alignment proofs;
direct IPD rechecks its importer/dataset contract. Missing or stale binding yields
a typed request to use the existing `rerun_after_overrides` flow; it never blesses
an existing pool. Normal completed-Web tests cover valid cache, changed synthesis,
changed protocol, changed source row, changed selected set and missing binding.

### Explicit same-study primary choice

The independent ranking audit found that two current all-match results could tie
and be selected by extraction order. The shared selector now pauses for an
explicit primary include decision whenever their numerical or clinical contexts
differ. Exact duplicates may deduplicate; source timepoint, adjustment, arms,
raw numerical inputs and clinical fields remain part of duplicate identity,
while runtime-generated contrast/estimand IDs are not clinical evidence.

The existing `ExtractionReviewDecision` carries this choice with authenticated
reviewer identity and rationale, protocol/row/source versions and a whole-study
candidate fingerprint. Runtime creates an immutable choice receipt. Generic
acceptance/manual flags cannot choose. Only currently selectable audit candidates
passing numerical, source and RoB gates are advertised or accepted. One active
choice is retained per study; changing candidates, or losing the selected row's
eligibility, requires explicit reselection rather than silently using another row.
Regression cases cover both extraction orders, actual reconciled duplicates,
different timepoint/adjustment/arm with equal numbers, normal source-card choice
roundtrip, switching choices, stale/new candidates and excluded-row refusal.


### Final validation and handoff

Product source frozen after independent clinical review approval. The combined
23-file regression run passed 182 tests (13 existing Pydantic warnings); the
155-check deterministic deep suite passed. Scoped whitespace/diff validation
passed. The parent owns the full Meta suite, integration/code review, commit,
fresh managed Meta evaluation and deployment. No historical job, receipt or
source artifact was rewritten during this implementation.


### Independent Python review corrections

Quote anchors now preserve complete Unicode word and numeric-expression edges,
including signed/qualified decimals, exponents, fractions, ranges and uncertainty
operators; clipped values such as 250 to 50 or 1.25 to 1.2 cannot verify a claim.
Descriptor reads open nonblocking before rejecting FIFOs and other non-regular
files. Active primary choices with missing, malformed or invalid receipts stay
unresolved, including during cache reuse. Generic review acceptance changes
publication diagnostics without changing primary-choice authority; a genuinely
bound pool remains available for diagnostic refresh, while handwritten legacy
pools without current bindings are refused. The five initial full-suite failures
were triaged: analysis-set tests now provide explicit primary/secondary alignment
fixtures, CLI tests assert the guarded selection seam, and legacy unbound-cache
refresh tests assert preserved artifacts and the required rerun. Independent
Python/security review approved the corrected frozen product source.
