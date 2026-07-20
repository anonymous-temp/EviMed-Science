# SGLT2 HFmrEF/HFpEF 2022 Benchmark

## Published Anchor

- Benchmark: Vaduganathan et al., Lancet 2022, comprehensive meta-analysis of five randomized SGLT2 inhibitor heart-failure trials.
- Subset used here: prespecified meta-analysis of the two LVEF >40% trials, DELIVER and EMPEROR-Preserved.
- Topic: SGLT2 inhibitors versus placebo for cardiovascular death or first hospitalization for heart failure in adults with mildly reduced or preserved ejection fraction.
- Anchor result: HR 0.80 (95% CI 0.73 to 0.87), 2 trials, 12,251 participants.

## Machine-Readable Manifest

Manifest: `docs/benchmarks/sglt2_hfpef_2022.manifest.json`

Expected trials:

| Trial | PMID | DOI | Intervention events/total | Control events/total |
| --- | --- | --- | --- | --- |
| DELIVER | 36027570 | 10.1056/NEJMoa2206286 | 512/3131 | 610/3132 |
| EMPEROR-Preserved | 34449189 | 10.1056/NEJMoa2107038 | 415/2997 | 511/2991 |

Aggregate count anchor:

- Intervention: 927/6128
- Control: 1121/6123
- Total participants: 12,251

## Why This Benchmark Matters

- It tests whether MetaAgent can choose HR/time-to-event as the appropriate effect measure instead of defaulting to RR for composite cardiovascular endpoints.
- It tests retrieval precision: DAPA-HF, EMPEROR-Reduced, and SOLOIST-WHF are adjacent records from the same Lancet meta-analysis but should not be included in the HFmrEF/HFpEF subset benchmark.
- It tests primary-outcome harmonization: DELIVER wording includes “worsening heart failure,” while the benchmark subset reports cardiovascular death or first hospitalization for heart failure.

## Current Intended Gates

- Search recall must match both DELIVER and EMPEROR-Preserved.
- Publication-ready recall must exclude adjacent HFrEF/SOLOIST records from the primary HFmrEF/HFpEF subset.
- Primary analysis comparison should match both trial rows, aggregate counts, and the published HR anchor.
- Evidence-readiness should require source-backed event counts and explicit endpoint harmonization when extracted outcome wording differs from the benchmark endpoint.
- Benchmark CLI output includes `anchor_summary`, so a project report can directly show the published HR/CI, participant total, aggregate counts, and expected trial IDs before showing system recall and primary-analysis gaps.
- Benchmark project reports now include a `pooled_effect` gate that reads `analysis/meta_results.json` and compares the observed primary pooled effect, 95% CI, effect measure, and study count against the published HR 0.80 (95% CI 0.73 to 0.87) anchor.
- Benchmark project reports also include `primary_publication_recall`, which requires exact expected PMID/DOI matches for DELIVER and EMPEROR-Preserved primary publications instead of accepting secondary analyses or design papers as publication-ready evidence.
- Benchmark project reports now include `primary_full_text_recall`, which requires those exact primary publications to have a real full-text source (`pdf_path`, `fulltext_path`, Europe PMC full text/HTML, or user upload). Trial-level full-text recall can be 2/2 while this gate still fails if only secondary/design papers have PDFs and the primary NEJM articles are abstract-only.
- Research planning now has a deterministic guard for this class of endpoint: cardiovascular death plus heart-failure hospitalization/worsening-HF composites are forced to `effect_measure="HR"` rather than relying on the LLM's initial choice.
- The 2026-05-21 live run initially failed before full-text screening: `date_range="2015-01-01 to present"` was parsed as `*-2015`, and the capped fallback set contained broad irrelevant RCTs. Follow-up fixes now parse start-to-present correctly, add SGLT2/HFpEF title-shaped fallback queries, rank merged results before `max_results` truncation, prevent prefix/near-title deduplication from dropping primary trial publications, and decouple fallback retrieval depth from the final screening cap.
- The retrieval probe after those fixes reached both trial-level search recall 2/2 and `primary_publication_recall` 2/2 at `max_results=20`. DELIVER NEJM (PMID 36027570) and EMPEROR-Preserved NEJM (PMID 34449189) both enter the top-20 search set.
- The full live benchmark run at `output/benchmark_runs/20260521_073547_In_adults_with_heart_failure_with_mildly_reduced_o` reproduced the published primary-analysis anchor at the structured data/statistics level: selected primary rows matched both expected trials, aggregate counts were exactly 927/6128 vs 1121/6123, and pooled HR was 0.807 (95% CI 0.740 to 0.880), within tolerance of the published HR 0.80 (95% CI 0.73 to 0.87).
- The same full run is still not publication-ready: both primary NEJM publications were retrieved only as abstract text, so `primary_full_text_recall=0/2`. Evidence readiness correctly blocked publication-style writing and emitted an `evidence_gap` report with `abstract_only_primary_effect` blockers.
- Time-to-event benchmark checks now distinguish endpoint definitions from day-window timepoints. DELIVER/EMPEROR-Preserved use `timepoint_kind="time_to_event"` so source-verified primary-outcome HR rows pass, while COVID-style 28-day mortality benchmarks still require strict source-backed timepoint/adjudication checks.
- GRADE indirectness was corrected after this run: missing extracted P/I/C/design fields are now treated as unverified directness, not as confirmed mismatch or non-randomized design. On the SGLT2 artifact, this changes primary-outcome indirectness from erroneous `very serious` to `serious`; the real blocker remains the lack of full-text primary sources.
- Post-run full-text repair is now supported in the backend. `attach_user_fulltexts_to_project()` and the Web `fulltext_upload` message can attach user-supplied PDFs to the existing DELIVER/EMPEROR-Preserved records, update text-source artifacts, and clear downstream checkpoints. Unit coverage verifies that `primary_full_text_recall` moves from failing to 2/2 after the corresponding primary PDFs are attached.
- The evidence-readiness payload now exposes this as two actionable `fulltext_upload_rows` for the current SGLT2 run: PMID 34449189 (EMPEROR-Preserved) and PMID 36027570 (DELIVER). Each row carries PMID/DOI/title hints and a `suggested_upload` message shape, so the UI can render a direct “upload full text for this primary publication” task.
- The Web repair loop now has a resume action after those full texts are attached. `resume_project` / `resume_after_fulltext` delegates to the canonical CLI checkpoint pipeline (`new_meta.main --resume`) and returns updated evidence-readiness plus artifact paths, so the user can continue the same project instead of starting over or relying on a separate Web-only phase2 branch.
- Benchmark project reports now include a compact `summary_card`: it shows the published anchor, observed primary effect, gate status, missing primary full texts, and next actions. For the current SGLT2 run, this card should read as blocked by `primary_full_text_recall`, not as a statistical mismatch, because the pooled HR already matches the published anchor.
- Full-text repair was executed with user-supplied NEJM PDFs for DELIVER and EMPEROR-Preserved. The upload repair path now stages PDFs inside `user_fulltexts/`, prioritizes filename-title matches over loose full-text overlap, and tolerates PDF side-column insertions during source-quote verification. This prevented secondary/design papers from displacing the primary NEJM publications.
- The repaired benchmark project at `output/benchmark_runs/20260521_094700_sglt2_hfpef_fulltext_repair_v3` now passes all structured gates: search recall 2/2, primary publication recall 2/2, primary full-text recall 2/2, selected primary rows 2/2, aggregate counts 927/6128 vs 1121/6123, and pooled HR 0.807 (95% CI 0.740 to 0.880), within tolerance of the published HR 0.80 (95% CI 0.73 to 0.87).
- Manuscript validation also passes after deterministic repairs. The writer now blocks unsafe drafts when hard validation fails, saves them as `manuscript/draft.rejected.md`, and only writes a publication-style `draft.md` when `manuscript_validation.json` has `passed=true`. Repairs used in this benchmark include primary participant-total backfill from `manuscript_facts.json`, undefined Figure/Table reference removal, adjacent secondary-outcome effect-window fixes, and a more precise exclusion/sensitivity context validator.
- Extraction review payloads now expose the remaining trust checklist as source cards. The refreshed SGLT2 artifact package contains 65 `extraction_source_cards` and 28 `extraction_review_cards`; each card includes the extracted values, source quote/page/section, quote verification status, conflicts, and suggested override metadata.
- Real user-PDF upload was re-tested with the two NEJM files provided at `/Users/wangzeyuan/Downloads`. The fixed upload matcher now maps DELIVER to PMID 36027570 and EMPEROR-Preserved to PMID 34449189 via exact `filename_title` matching, parsing 41,021/44,039 text characters and 4/5 tables respectively. This fixed a discovered failure mode where a primary-paper filename could be matched to a secondary “According to Age” DELIVER analysis because the secondary title contained the primary title as a substring.
- The real-PDF project `output/benchmark_runs/20260521_112500_sglt2_hfpef_real_pdf_upload_fixed_match` now passes all benchmark gates after resume: search recall 2/2, primary publication recall 2/2, primary full-text recall 2/2, selected primary rows 2/2, aggregate counts 927/6128 vs 1121/6123, pooled HR 0.807 (95% CI 0.740 to 0.880), and `manuscript_validation.json passed=true`.
- The same real-PDF project was refreshed on 2026-05-23 with the current fact-locked manuscript writer. The regenerated `manuscript/draft.md` is 6,816 words overall (`main_word_count=5751`) and the artifact package contains `draft.md`, `draft.docx`, figures, extraction/source review files, and benchmark review files. The abstract now uses concise clinical labels ("SGLT2 inhibitors compared with placebo") rather than raw protocol text.
- GRADE inconsistency handling was corrected for the 2-study HFpEF/HFmrEF subset. A wide 2-study prediction interval is no longer used by itself to downgrade inconsistency when I²=0% and Q is non-significant; the refreshed GRADE profile rates inconsistency as `no concern` and overall certainty as `High`.
- A second writing failure surfaced during the real-PDF resume: the draft described a non-primary secondary-analysis record (`Gerasimos 2023`) as if it contributed to the primary/meta-analysis. The hard validator correctly blocked that draft. The deterministic repair layer now removes such non-primary contribution sentences and also repairs word-number claims such as “Seven RCTs contributed data to the primary outcome analysis.”
- Full-text screening now emits evidence roles and routes related records out of extraction. In the same real-PDF project, DELIVER and EMPEROR-Preserved are `primary_publication / primary_extraction`; secondary analyses, design/protocol papers, and CAMEO-DAPA-style surrogate-endpoint trials are retained as `related_source_only`. After rerun, only 2 papers entered extraction, while source cards fell from 64 to 16 and review cards from 31 to 7 without changing the published-anchor result.
- The refreshed artifact package now includes `review/extraction_review.html`, a dependency-free offline source-card review page. It renders the same 16 source cards and 7 review cards from `evidence_readiness_review.json`, so users can inspect values, page/section, source quotes, conflicts, and override payload seeds even before the production frontend renders the source drawer.
- The same package now includes persisted benchmark comparison artifacts: `benchmark/benchmark_report.json`, `benchmark/benchmark_summary_card.json`, `review/benchmark_review.json`, and `review/benchmark_review.html`. For the real-PDF project, `package_manifest.json.review` records `benchmark_status="passed"`, `benchmark_failing_gates=0`, and `benchmark_missing_primary_full_texts=0`, giving users an offline published-anchor receipt alongside the extraction source cards.
- Web evidence-readiness now exposes the same benchmark receipt under `benchmark` via the shared `docs/contracts/benchmark_review.md` contract. The real-PDF payload reports `status="passed"`, `passed=true`, 0 failing gates, 0 missing primary full texts, 0 source acquisition tasks, and 0 attached source tasks.
- The 2026-05-23 refresh also adds source-context excerpts to `review/extraction_review.html`: source cards now show the quote's surrounding parsed full-text neighborhood and highlight the matched sentence. The refreshed SGLT2 package has 9 highlighted source-context excerpts; the COVID corticosteroids package has 28. This makes the "check this number against the paper" step visible rather than leaving users with isolated quotes.
- The SGLT2 benchmark gate now treats a DL random-effects result with `tau_squared=0` as model-equivalent to a fixed-effect published anchor when the effect, CI, and study count are within tolerance. This keeps genuine model mismatches as failures while avoiding a false fail when the random-effects estimate mathematically collapses to the fixed-effect estimate.

## Remaining Work

- Extend selected-row primary-analysis comparison beyond arm-level count totals if per-trial log-HR/SE extraction becomes available; for now the project-level `pooled_effect` gate covers the final HR/CI anchor.
- Render the already-exposed `benchmark` payload in the UI alongside evidence-readiness: published anchor vs observed system output, plus failing gates or pass receipts, so users understand why a numerically correct synthesis is or is not ready.
- Close the extraction-review UI loop before calling the output submission-ready: the backend now provides source cards, but the frontend still needs to render “click value -> show quote/page -> edit override -> rerun” as the final trust checklist.
- Further generalize FT screening role classification beyond the current deterministic title patterns. The SGLT2 benchmark now routes obvious secondary/design/surrogate records correctly, but other clinical domains will need broader, test-backed role vocabularies and possibly trial-registration linking to avoid excluding legitimate subgroup-only evidence.
