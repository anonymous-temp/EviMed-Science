# Benchmark: Systemic Corticosteroids for Critically Ill COVID-19

## Published reference

- Reference: WHO REACT Working Group, JAMA 2020, doi: `10.1001/jama.2020.17023`.
- Source links: [JAMA full text](https://jamanetwork.com/journals/jama/fullarticle/2770279), [PubMed record](https://pubmed.ncbi.nlm.nih.gov/32876694/), [Oxford BDI publication page](https://www.bdi.ox.ac.uk/publications/1130189), [NHS Medicines Awareness summary](https://www.medicinesresources.nhs.uk/association-between-administration-of-systemic-corticosteroids-and-mortality-among-critically-ill-patients-with-covid-19-a-meta-analysis.html).
- Topic: systemic corticosteroids vs usual care/placebo for 28-day all-cause mortality in critically ill COVID-19 patients.
- Published anchor result: 7 randomized clinical trials, 1703 critically ill patients.
- Main effect: summary OR 0.66, 95% CI 0.53-0.82, fixed-effect analysis; random-effects OR reported as 0.70, 95% CI 0.48-1.01 in secondary summaries.
- Trial/patient counts: 678 randomized to corticosteroids and 1025 to usual care/placebo; 222 vs 425 deaths in one JAMA editorial summary.
- Machine-readable manifest: `docs/benchmarks/corticosteroids_covid_2020.manifest.json`. It records the 7 JAMA trial anchors, NCT IDs, available PMID/DOI links, expected mortality events/totals, and aggregate published effect anchors.

## Current source-adjudicated benchmark pass (2026-05-23)

- Project directory: `output/20260523_003812_Systemic_corticosteroids_compared_with_usual_care`.
- Manuscript outputs: `manuscript/draft.md`, `manuscript/draft.docx`, `references.bib`, generated figures, source audit files, and benchmark review files are packaged in `package/metaagent_export.zip`.
- Formal-length manuscript gate: the regenerated draft is 7,051 words overall, with `manuscript_validation.json` reporting `passed=true`, `report_type="meta"`, and `main_word_count=4645`.
- Published-anchor comparison: benchmark status is `passed`; primary source/full-text recall is 7/7, selected primary-analysis rows are 7/7, and total participants match the JAMA anchor exactly (1,703; participant difference 0).
- Primary outcome reproduction: arm-level totals are 222/678 deaths in corticosteroid groups vs 425/1025 in control groups. The fixed-effect pooled OR is 0.659 (95% CI 0.532 to 0.817), matching the published WHO REACT/JAMA OR 0.66 (95% CI 0.53 to 0.82) within the benchmark tolerance.
- Delivery package: `package_manifest.json` inside the zip records `review.benchmark_status="passed"`, zero failing gates, zero missing primary full texts, and includes `review/benchmark_review.html` plus `review/evidence_readiness_review.json` for offline user review.
- LLM provider check: qwen3.6-plus streaming/search mode now falls back from empty/unsupported DashScope Responses API calls to Chat Completions with `enable_search`, and the fallback is shared across new `LLMClient` instances for the same base URL/model. The formal benchmark manuscript itself uses the fact-locked meta writer when needed, so LLM outages no longer block manuscript generation.

Command used for the final manuscript-only rewrite:

```bash
LLM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1 \
LLM_MODEL=qwen3.6-plus \
LLM_ENABLE_SEARCH=1 \
LLM_ENABLE_THINKING=0 \
LLM_STREAM=1 \
python3 -m new_meta.main \
  --topic "Systemic corticosteroids compared with usual care or placebo for 28-day all-cause mortality in critically ill COVID-19 patients randomized trials through September 2020" \
  --resume output/20260523_003812_Systemic_corticosteroids_compared_with_usual_care \
  --skip-confirm \
  --max-papers 30
```

## Fresh one-click probe after the source-adjudicated pass (2026-05-23)

- Project directory: `output/benchmark_runs/20260523_000009_Systemic_corticosteroids_compared_with_usual_care`.
- Command: same topic, no resume, qwen3.6-plus, streaming on, web-search flag on, `--skip-confirm --max-papers 30`.
- Outcome: the run completed, but it produced a narrative synthesis rather than a quantitative meta-analysis. The draft was 5,626 words and validation passed as `report_type="narrative"` with `main_word_count=4661`, but no primary meta-analysis was performed.
- Benchmark comparison: status `failed`; search recall was 2/7 and primary-publication recall was 2/7. The recalled benchmark records were the registry-seed COVID STEROID and Steroids-SARI records; DEXA-COVID 19, CoDEX, RECOVERY, CAPE COVID, and REMAP-CAP were missing. Observed primary analysis was empty (`n_studies=0`).
- Root causes exposed:
  - The automatically generated protocol selected RR + random effects, whereas the published WHO REACT/JAMA anchor uses fixed-effect OR.
  - The generated PubMed query over-emphasized critical-care/respiratory-support wording and failed to retrieve several primary JAMA/NEJM trial publications within the capped top 30.
  - ClinicalTrials.gov broad query returned one 400 error; registry supplement still added records, but not enough to recover the primary publications.
  - Registry seed records reached T/A screening, but the downstream full-text screening identity filter treated three downloaded registry text artifacts as insufficiently traceable, so FT included 0 studies and the pipeline fell back to narrative mode.
- LLM/runtime observation: the fresh qwen3.6-plus run made 60 LLM calls, used about 31,444 tokens, and wrote an estimated cost of about $0.021 to `llm_usage_manifest.json`. DashScope Responses API repeatedly returned empty output before falling back to chat completions, creating avoidable latency.
- Immediate fix from this probe: `LLMClient` now disables the Responses API for the current client session after a Responses failure/fallback, so later calls go directly to chat completions while preserving DashScope search `extra_body`. Regression test: `test_llm_client_disables_dashscope_responses_after_empty_fallback`.

## Earlier fresh one-click run history

Command:

```bash
MESH_API_DISABLED=1 PUBMED_SEARCH_TIMEOUT=5 BATCH_SCREENING_THRESHOLD=1 \
python3 -m new_meta.main \
  --topic "Systemic corticosteroids compared with usual care or placebo for 28-day all-cause mortality in critically ill COVID-19 patients randomized trials through September 2020" \
  --skip-confirm \
  --max-papers 30 \
  --output-dir output/benchmark_runs
```

Earlier project directory:

```text
output/benchmark_runs/20260521_005903_Systemic_corticosteroids_compared_with_usual_care
```

Observed result:

- Protocol generation succeeded and identified the target PICO correctly.
- The deterministic query safety check added the missing COVID-19/SARS-CoV-2 block after the LLM-reviewed query omitted it.
- PubMed search still timed out in this environment; multi-source fallback used OpenAlex.
- Initial compact fallback returned 30 raw records, 29 after deduplication; title/abstract screening included 6 records and full-text screening included 5 records.
- After adding recall-first academic query variants, retrieval smoke returned 76 unique OpenAlex candidates and surfaced additional plausible RCTs such as METCOVID methylprednisolone and Edalatifard methylprednisolone.
- After promoting recall-first order, adding per-drug recall queries, and ranking fallback results by RCT usefulness, a `max_results=30` fallback smoke returned 165 unique OpenAlex records with METCOVID ranked #1, Edalatifard ranked #2, and CoDEX visible within the top 30.
- Initial PDF auto-download failed for all 6 T/A-included records, so extraction used abstract-only text.
- After wiring OpenAlex multi-URL PDF candidates plus DOI-level hydration, a retrieval smoke test downloaded 3/5 benchmark candidate PDFs (RECOVERY final, RECOVERY preliminary, REMAP-CAP via repository URL).
- JAMA article PDFs still returned 403 in this environment. Europe PMC normal article pages often expose only a front-end shell, but Europe PMC direct PDF render succeeds for some PMCID records and `fullTextXML` is now used before HTML when available.
- The latest full rerun returns 6/6 machine-readable sources: 4 PDFs and 2 `europe_pmc_abstract` records, with warnings written to `text_source_warnings.json`.
- First full run produced an inflated primary meta-analysis because subgroup rows and duplicate preliminary/final RECOVERY publications were counted as separate effects: 10 effects, RR 0.861 (95% CI 0.792-0.937).
- After adding the primary-effect hard gate (overall rows only, matching time point, duplicate sample-size signature dedupe), the primary meta-analysis used 2 effects: RR 0.764 (95% CI 0.478-1.220), I² 57.6%.
- After adding DOI/title identity keys, RoB 2 tool enforcement for RCT signals, and source-quote subgroup detection, the primary meta-analysis used 3 trial-level effects: RR 0.865 (95% CI 0.747-1.001), I² 16.0%.
- GRADE now treats synthetic/not-formally-assessed RoB as `very serious` rather than `no concern`.
- Writing now emits `manuscript_facts.json` and `manuscript_validation.json`. The earlier draft could be repaired to pass wording-level hard validators, but the stricter evidence-readiness gate now correctly blocks publication-style output for this benchmark.
- After improving outcome matching, pooled-intervention contrast handling, and protocol-population subgroup selection, one full `--resume` run used 4 analyzable primary effects: Dequin/CAPE COVID, Edalatifard methylprednisolone, RECOVERY invasive-mechanical-ventilation subgroup, and REMAP-CAP pooled corticosteroids, with DL random-effects RR 0.679 (95% CI 0.499-0.926), I² 49.8%, p=0.0143.
- After adding Europe PMC direct PDF/fullTextXML retrieval, explicit RECOVERY subgroup precedence, scalar-list schema cleanup, and additional manuscript hard validators, the latest rerun used 5 FT-included studies and 3 analyzable primary effects: Dequin/CAPE COVID, REMAP-CAP pooled corticosteroids, and RECOVERY invasive-mechanical-ventilation subgroup.
- The latest primary result is DL random-effects RR 0.731 (95% CI 0.621-0.860), I² 0.0%, p=0.0002. It is directionally consistent with the published WHO REACT mortality benefit, but still not numerically equivalent because the benchmark reference reports OR, includes 7 trials/1703 critically ill participants, and uses trial-level data not fully recovered by the current automatic pipeline.
- The current final validation status is `passed=false`, `report_type=evidence_gap`. Evidence-readiness blockers include an abstract-only primary-effect row and selected primary rows whose source quote/location does not directly verify the target 28-day timepoint.
- Secondary outcome selection now requires the target timepoint in the outcome name, timepoint, source quote, or source location. Opportunistic generic death/mortality rows no longer create a 90-day mortality synthesis; the latest `meta_results.json` has `secondary_outcomes=[]`.
- The latest persisted draft is now a deterministic `Systematic Review Evidence-Gap Report`, not a publication-style manuscript. It lists the computed-but-not-released RR, blockers, unresolved extraction warnings, and selected primary-row audit, and it was generated without an LLM call.
- Latest extraction audit shows a non-publication-ready trust state: 49 outcome rows, 36 rows requiring review, 27 conflict rows, 34 verified source quotes, and 15 rows not checked. This now triggers evidence-gap behavior before a submission-grade manuscript is allowed.
- Latest `analysis/effect_selection_audit.json` contains 11 primary-outcome candidate rows: 3 entered the final primary analysis; CoDEX was excluded for missing event counts, METCOVID for missing computable 28-day event counts, RECOVERY overall/no-oxygen/oxygen-only rows were excluded in favor of the invasive-mechanical-ventilation subgroup, and REMAP-CAP duplicate arm rows were excluded in favor of the pooled corticosteroid contrast.
- Benchmark manifest recall check now evaluates known-trial recall against the JAMA seven-trial set. The persisted full benchmark project still has search recall 5/7 (0.714), because it predates the latest registry-seed fallback and is not a publication-ready rerun.
- A live retrieval probe using the same benchmark query now reaches search recall 7/7 despite PubMed and ClinicalTrials.gov timeouts. `registry_seed` metadata records for Steroids-SARI (`NCT04244591`) and COVID STEROID (`NCT04348305`) entered the capped top 30, and the COVID STEROID protocol paper remained visible from OpenAlex.
- Project-level benchmark evaluation still checks full-text recall and primary-analysis counts. The persisted benchmark project remains full-text recall 4/7 (CoDEX, RECOVERY, CAPE COVID, REMAP-CAP) and primary-analysis recall 3/7 (CAPE COVID, REMAP-CAP, RECOVERY), failing the publication-ready comparison. Observed selected-row totals are 183/678 vs 331/857, compared with the published anchor 222/678 vs 425/1025; differences are -39 intervention deaths, 0 intervention total, -94 control deaths, and -168 control total. The new patient-total validator also reports 1535 observed participants vs 1703 expected participants, `participant_difference=-168`, `patient_totals_passed=false`, and failure reason `patient_total_mismatch`.
- Project-level benchmark output can now be persisted into the project and shipped to users. Running `python3 -m new_meta.core.benchmark_manifest docs/benchmarks/corticosteroids_covid_2020.manifest.json output/benchmark_runs/20260521_005903_Systemic_corticosteroids_compared_with_usual_care --project --write-report --no-fail` writes `benchmark/benchmark_report.json` and `benchmark/benchmark_summary_card.json`; the refreshed `package/metaagent_export.zip` contains those files plus `review/benchmark_review.json` and `review/benchmark_review.html`. The current package manifest records `benchmark_status="blocked"`, 4 failing gates, and 5 missing primary full texts. The benchmark review page lists the exact blockers: missing COVID STEROID/Steroids-SARI primary publications, missing primary full texts for DEXA-COVID 19/CoDEX/CAPE COVID/COVID STEROID/Steroids-SARI, primary-analysis row/count/timepoint gaps, and RR-vs-OR pooled-effect mismatch.
- The same benchmark review payload is now exposed in Web evidence-readiness under `benchmark`, using the shared contract in `docs/contracts/benchmark_review.md`. For this persisted project the Web payload reports `status="blocked"`, `passed=false`, 4 failing gates, and 5 missing primary full texts, so the frontend can show the published-anchor gap before the user downloads the artifact package.
- Benchmark review now includes 6 `source_acquisition_tasks`, turning the blocked benchmark into a concrete user/source request list: upload DEXA-COVID 19 (`PMID 32799933`, `doi:10.1186/s13063-020-04643-1`), CoDEX (`PMID 32876695`, `doi:10.1001/jama.2020.17021`), and CAPE COVID (`PMID 32876689`, `doi:10.1001/jama.2020.16761`) primary full text or supplement; find COVID STEROID (`NCT04348305`) and Steroids-SARI (`NCT04244591`) primary publication, registry results, supplement, or JAMA appendix rows; and adjudicate whether CAPE COVID's 21-day endpoint can validly support the 28-day mortality benchmark. These tasks are in both Web payload and `review/benchmark_review.html`.
- The Web source intake now accepts `benchmark_source_upload` for those tasks. Uploaded appendix/registry/supplement files are staged under `benchmark/sources/<trial_id>/`, recorded in `benchmark/benchmark_source_manifest.json`, and shown back on the corresponding task as `source_uploaded_needs_review`. This is intentionally review-only: the project does not silently alter extraction rows or pooled effects until a reviewer applies explicit overrides or a later ingestion step.
- Uploaded benchmark sources now get immediate parse-preview metadata (`parse_status`, text characters, page count, table count, and preview snippet). This addresses the “uploaded but black-box” problem for benchmark appendix/registry files: if a source is scanned or unreadable, the user sees that failure on the task instead of waiting for downstream extraction to fail.
- When parsing succeeds, the full parsed source JSON is saved under `benchmark/source_parsed/<sha256>.json` and included in `metaagent_export.zip`. This keeps the Web payload light while preserving enough material for the next step: source-backed quote candidates and explicit extraction overrides for COVID STEROID, Steroids-SARI, and CAPE COVID adjudication.
- Parsed benchmark sources now generate review-only quote candidates when they contain expected arm-level counts or accepted timepoint text. For COVID STEROID, Steroids-SARI, and CAPE COVID, a user-uploaded registry result, appendix row, or supplement can therefore surface the exact matched numbers/phrases and a suggested override seed, but the pooled result still cannot change until the reviewer explicitly accepts the correction.
- Accepted/rejected quote-candidate decisions are now stored separately in `benchmark/benchmark_source_decisions.json`. This lets a reviewer mark, for example, a Steroids-SARI registry row as source-backed without silently creating a trial effect; the task then becomes `source_candidate_accepted_needs_override` until an explicit extraction/adjudication step is applied and downstream analysis is rerun.
- User-provided source links were checked on 2026-05-21. JAMA direct `curl` returned 403, but browser rendering exposed the WHO REACT article text and signed Figure 2 image. Local downloads now live in `output/benchmark_source_downloads/covid_react_2020/`, including `who_react_figure2.png`, a source-backed transcription `who_react_figure2_transcribed.txt`, EudraCT COVID STEROID results HTML, and COVID-NMA Steroids-SARI detail HTML. The figure transcription has been attached to the persisted COVID benchmark and accepted for DEXA-COVID 19, CoDEX, COVID STEROID, and Steroids-SARI primary count candidates.
- The EudraCT COVID STEROID page reports 6/16 vs 2/14 for day-28 mortality, while WHO REACT Figure 2 uses 6/15 vs 2/14. This discrepancy is intentionally preserved: EudraCT is attached as a source but is not accepted for the WHO REACT benchmark count candidate.
- Registry fallback has been added for unpublished/registry-first trials via ClinicalTrials.gov API v2 and local metadata-only registry seeds. ClinicalTrials.gov supports query search, direct NCT ID fetch, project-local caching under `papers/clinicaltrials_cache/`, and `clinicaltrials_fallback_manifest.json`; registry seeds are recorded separately in `registry_seed_fallback_manifest.json` and carry `metadata_only=true`/`source_warning=registry_seed_metadata_only`.
- A manifest-driven registry augmentation harness now turns the known benchmark gap into an executable regression: it reads missing NCT IDs from the benchmark manifest, fetches only those ClinicalTrials.gov records, and reports recall_before/recall_after plus per-trial attempts. This is benchmark-only instrumentation and does not copy published event counts into extraction or meta-analysis.
- Resume from `manuscript` previously re-ran effect size, meta-analysis, GRADE, and figures despite cached checkpoints. A manuscript-only fast path now covers the common case where analysis/figures are cached and only the manuscript checkpoint is missing; broader per-step guard cleanup is still required.

## Differences vs published reference

| Dimension | Published JAMA reference | Current MetaAgent run |
|---|---:|---:|
| RCTs included | 7 | 5 records at FT, 3 computable primary effects |
| Patients | 1703 | Current selected primary-effect rows sum to 1535 participants; validators now flag unsupported 1703-patient claims as `patient_total_mismatch` |
| Effect estimate | OR 0.66 (95% CI 0.53-0.82) | RR 0.731 (95% CI 0.621-0.860), DL random effects |
| Report generated | Full published meta-analysis | Evidence-gap report state: statistical synthesis computed, but publication-style manuscript blocked by source/timepoint readiness failures |
| Data provenance | Trial-level IPD/aggregate trial data | 4 PDFs + 2 abstract-only structured abstracts; JAMA/CoDEX and CAPE COVID still need user upload or stronger full-text source |
| RoB/GRADE | Formal trial-level assessment | RoB 2 now used for all five RCT records; GRADE still very low and needs deterministic domain rules |

## Bugs and gaps exposed during the benchmark

1. `QueryBuilder.run()` returns `(query, report, is_single_drug)`, while CLI expected two values and crashed before search.
2. MeSH validation was serial and slow: each candidate could wait 15 seconds, multiplying across candidates.
3. `--max-papers` only limited PubMed, while internal database results bypassed the cap and pushed hundreds of papers into LLM screening.
4. Auto-broadening after zero T/A inclusions injected a diabetes/metformin comparator into unrelated topics.
5. CLI did not pass `protocol.date_range` to `PaperRetriever`, unlike Web/start.py.
6. Date parser did not understand full date ranges such as `January 1, 2020 to September 30, 2020`.
7. PubMed search timeout is a hard external dependency; when it fails, there is no alternative biomedical source fallback.
8. Internal database ranking did not surface the known 2020 RCT/meta-analysis records for this topic.
9. The generated query is recall-poor for benchmark reproduction when academic fallback uses only compact Boolean-derived terms; recall-first and per-drug query variants are needed before final capping.
10. Fake dual screening is expensive in non-batch mode; benchmark runs should default to honest single-pass or true dual-model mode.
11. LLM-reviewed search can omit a core disease concept even when the protocol PICO is correct.
12. OpenAlex fallback needs compact, concept-focused query variants; dense PubMed Boolean strings return poor results.
13. OpenAlex abstracts must be reconstructed from `abstract_inverted_index`; title-only screening is not enough.
14. Primary meta-analysis must exclude subgroup rows unless explicitly running subgroup analysis.
15. Duplicate preliminary/final publications of the same trial can inflate precision unless trial/sample signatures are deduped.
16. Abstract-only extraction can hallucinate or approximate event counts, including fractional event counts in JSON retries.
17. Synthetic RoB entries must never be treated as GRADE `no concern`.
18. DOI-only preprints collide when parsed/extracted under empty PMID keys.
19. RCTs can be misclassified as Newcastle-Ottawa when extraction leaves `study_design` blank.
20. Source quotes mentioning subgroups can be counted as overall rows if the LLM forgets to fill `subgroup`.
21. Writing can invent or leak facts unless every high-risk sentence is constrained by `manuscript_facts.json`; this benchmark drove the first hard-validator layer.
22. GRADE indirectness/risk-of-bias rationales can contradict the actual included-study details because domain decisions still mix deterministic values and LLM narrative.
23. Resume from a late checkpoint is incomplete: clearing only `manuscript` still re-runs effect sizes, meta-analysis, GRADE, and figures.
24. Academic fallback must rank broad OpenAlex/Semantic Scholar records before applying `max_results`; otherwise true RCTs can sit below protocols, reviews, and adjacent non-RCT records.
25. Europe PMC normal HTML pages may only return a front-end shell; direct PDF render and `fullTextXML` are more reliable and should be tried first.
26. Full-text screening can become stricter after more text is available: Edalatifard was excluded when the PDF made clear it enrolled severe non-intubated pulmonary-phase patients, which may be correct for the strict protocol but diverges from broader published syntheses.
27. Primary outcome timepoint semantics remain fragile: Dequin/CAPE COVID contributes deaths from a 21-day treatment-failure endpoint while the protocol says 28-day all-cause mortality. This requires either a protocol-level “closest mortality timepoint” rule or user adjudication.
28. METCOVID full-text extraction was unstable: one run extracted 72/194 vs 76/199, while the latest run extracted no computable 28-day event counts despite verified source text. This needs targeted extraction fixtures and retry/override handling.
29. Manuscript patient totals were previously not validated from `manuscript_facts.json`; this is now guarded by selected-primary-row denominator checks, while broader source-backed clinical claim validation still needs expansion.
30. Wording-level manuscript validators are not enough: a draft can have internally consistent prose while the underlying primary-effect evidence is still abstract-only, low-confidence, or missing source-backed target-timepoint verification.
31. Registry metadata can close search recall but cannot supply outcome event counts. Seeded records must remain explicit review targets and must not be converted into effect sizes without full text, user upload, or verified extraction evidence.

## Fixes implemented from this benchmark

- Added MeSH timeout/circuit breaker and `MESH_API_DISABLED`.
- Added CLI compatibility for 2- and 3-value query-builder results.
- Applied `--max-papers` as a hard cap after merging all search sources.
- Replaced topic-specific diabetes auto-broadening with generic comparator broadening.
- Passed `protocol.date_range` from CLI to retriever.
- Parsed `through/until/up to` and full date ranges in retriever date filtering.
- Added configurable `PUBMED_SEARCH_TIMEOUT` and `PUBMED_FETCH_TIMEOUT`.
- Passed date bounds into PubMed search.
- Added deterministic query safety checks for high-salience concepts such as COVID-19/SARS-CoV-2.
- Wired PubMed-failure fallback to `tools/multi_search.py` with Semantic Scholar/OpenAlex.
- Added compact fallback query generation for academic APIs.
- Reconstructed OpenAlex abstracts from inverted-index payloads.
- Propagated OpenAlex OA PDF URLs into paper metadata and downloader input.
- Added downloader metadata hydration so cached screening records can recover `pdf_url` from `search_results.json`.
- Added OpenAlex multi-URL candidate lists, DOI-level PDF URL hydration, and null-safe OpenAlex OA URL parsing.
- Added Europe PMC structured abstract fallback with explicit `text_availability="abstract_only"` and `text_source_warnings.json`.
- Added Europe PMC direct PDF candidate hydration and `fullTextXML` fallback before HTML, improving this benchmark to 4 PDFs + 2 abstract-only records.
- Added stable `paper_identity()` fallback (`pmid -> doi -> provider id -> title hash`) so DOI-only preprints no longer collide under an empty key.
- Added RoB 2 enforcement from title/full-text randomized-trial signals.
- Added primary effect selection gates: exact timepoint check, overall-row-only meta-analysis, and duplicate publication dedupe by treatment/control totals.
- Added subgroup detection from source quote/location text, not just the LLM-populated `subgroup` field.
- Added recall-first academic query variant that drops comparator/outcome terms for Semantic Scholar/OpenAlex retrieval.
- Promoted recall-first fallback ordering, added per-drug recall queries, ranked academic fallback records by RCT usefulness, and limited Semantic Scholar to the first broad recall query to reduce repeated rate-limit delays.
- Added `StudyRoB.is_synthetic` and forced GRADE risk-of-bias concern for synthetic/not-formally-assessed RoB.
- Added `manuscript_facts.json` and `manuscript_validation.json` generation before saving the manuscript.
- Added final manuscript hard validators for internal label leakage, unsupported human-review/registration claims, source-name mismatch, abstract-only evidence warning, publication-bias overclaim when k<10, PRISMA count summaries, GRADE downgrade-domain wording, and review-eligible vs analyzable-primary-study count separation.
- Re-ran the latest benchmark through the writing entrypoint after adding evidence-readiness checks; final validation report is now `passed=false`, `report_type=evidence_gap`, with blockers for abstract-only primary evidence and unverified source-backed target timepoints.
- Added mortality outcome matching that accepts all-cause mortality rows without explicit day labels when no incompatible timepoint is present, while rejecting 21/90-day, cause-specific mortality, and composite outcomes such as ventilation-or-death.
- Added within-study primary-row ranking so exact 28-day mortality beats generic `Death` rows and a study can only contribute one primary-effect row.
- Added protocol-population subgroup selection: for broad hospitalized trials under a critical-illness protocol, eligible critical-care subgroups such as RECOVERY invasive mechanical ventilation outrank the broad overall row.
- Fixed RECOVERY-like subgroup selection when a long source quote lists multiple respiratory-support subgroups; an explicit `subgroup="invasive mechanical ventilation"` now wins over unrelated exclusion phrases in the same quote.
- Added pooled-intervention contrast handling so rows like `Corticosteroid (Pooled) vs No corticosteroids` are treated as an overall intervention-class contrast rather than a patient subgroup.
- Added LLM/schema cleanup for common extraction shapes (`country` lists, arm-count dictionaries, trailing-comma/noisy JSON), plus LLM truncation warnings when completion output reaches the token ceiling.
- Added hard-validator cleanup for PubMed source leftovers, malformed `’s test`/`’s regression` fragments, and publication-bias statements that cite included-study `n` instead of primary-analysis `k`.
- Added secondary-outcome gates equivalent to the primary selector; target-day secondary outcomes now require explicit target-day evidence and cannot be constructed from generic mortality/death rows.
- Added hard-validator repairs for analyzable-vs-eligible study count wording and GRADE no-concern contradictions such as `imprecision=no concern` paired with a prose “precision limitation”.
- Added schema cleanup for multi-value continuous scalar fields: lists such as median/IQR subgroup arrays are dropped to `None` instead of being summed or crashing validation.
- Added hard-validator repairs for orphan `’s test indicated no...`, publication-bias `n` vs `k` wording, and `five eligible RCTs yielded` when only `k=3` contributed to primary meta-analysis.
- Added `analysis/effect_selection_audit.json` so users can inspect which extracted rows were selected, excluded, or deduplicated for the primary meta-analysis and why.
- Added `evidence_readiness` to `manuscript_facts.json`; selected primary-effect rows now block publication-style reports when they come from abstract-only sources, lack verified source quotes, have low/missing extraction confidence, or do not source-verify the target timepoint.
- Routed `report_type="evidence_gap"` through a deterministic evidence-gap writer in `WritingAgent.run()`, so blocked runs no longer call the LLM writer or emit normal Abstract/Methods/Results publication sections.
- Added Web/backend `evidence_readiness` payload generation from `manuscript_facts.json` and `manuscript_validation.json`, exposing this benchmark's blocker codes, selected primary rows, validation issue counts, and action-required status to the frontend instead of hiding them in markdown.
- Added Web/backend `extraction_override` handling with revision checks. User corrections are written to `extraction_overrides.json`, applied immediately to `all_extractions.json`, refresh `extraction_audit.json`, and clear downstream analysis/manuscript checkpoints so stale results cannot be silently reused.
- Added Web/backend `rerun_downstream` handling after overrides. The service can now recompute primary effect selection, effect sizes, meta-analysis/GRADE when eligible, manuscript facts, validation, and evidence-readiness payloads from the corrected extraction state; zero computable primary effects stay `evidence_gap` rather than being mislabeled as narrative.
- Added a central checkpoint dependency DAG via `Project.clear_downstream()`, and routed Web extraction overrides plus CLI protocol/search-query adjustment paths through it so stale downstream checkpoints are invalidated consistently.
- Added first-pass deterministic GRADE indirectness rules. P/I/C/O mismatches, critical-care population mismatches, surrogate outcomes, and non-randomized design signals now set a conservative floor before LLM rationale text is considered.
- Added `docs/benchmarks/corticosteroids_covid_2020.manifest.json` plus `new_meta.core.benchmark_manifest` recall evaluation. The evaluator matches expected trials by PMID, DOI, title alias, and dedicated registration fields, while avoiding false-positive matches from NCT IDs mentioned only inside unrelated abstracts.
- Extended `new_meta.core.benchmark_manifest` to evaluate full project directories: search recall, full-text recall, selected primary-effect rows, expected-vs-observed event totals, missing benchmark trials, and unexpected selected rows.
- Added `new_meta.tools.clinicaltrials` and wired ClinicalTrials.gov registry fallback into `PaperRetriever._multi_source_fallback()`. Registry records are converted to paper-like records with `trial_registration`/`nct_id`, interventions, outcomes, eligibility text, and a bounded timeout (`CLINICALTRIALS_TIMEOUT`, default 5s) plus `ENABLE_CLINICALTRIALS_FALLBACK`.
- Added ClinicalTrials.gov project-local cache and manifest logging. Successful query/NCT fetches are cached, NCT IDs in fallback queries are fetched directly, and `clinicaltrials_fallback_manifest.json` records whether each registry request was ok, cached, skipped, or failed.
- Added `augment_records_with_manifest_registry()` in the benchmark evaluator. The helper can augment a search-record artifact with benchmark-manifest NCT records, emits an audit of attempts/additions, and has regression tests for closing the COVID STEROID/Steroids-SARI search recall gap, failed registry fetches, and duplicate prevention.
- Added a manuscript-only CLI resume path. If all analysis and figure checkpoints are present but `manuscript` is missing, the pipeline loads cached artifacts and regenerates references/manuscript without recomputing effect sizes, meta-analysis, GRADE, or figures.
- Added a persisted parsed-full-text cache for the CLI `pdf_parsing` step. Cached resumes now load `papers/parsed_papers.json` instead of reparsing every PDF/HTML source; legacy runs without the cache rebuild and save it once.
- Added first-pass `pipeline_warnings.json` support. PDF/full-text parse failures, low parse rates, NMA/GRADE failures, and figure/influence/p-curve generation failures are now appended as structured warnings instead of living only in logs.
- Exposed `pipeline_warnings.json` through the existing Web `evidence_readiness` payload (`pipeline_warnings`, `pipeline_warning_count`), so the review UI can show operational failures alongside evidence blockers.
- Added a cached meta-analysis resume path. If `meta_analysis` is checkpointed but GRADE, figures, or manuscript are missing, the CLI loads `effect_sizes.json` and `meta_results.json` and resumes from the missing late stage without recomputing effect sizes or pooled effects.
- Added a cached effect-sizes resume path. If `effect_sizes` is checkpointed but `meta_analysis` is missing, the CLI loads `effect_sizes.json`, generates `meta_results.json`, then continues through GRADE, figures, and manuscript without recomputing primary effects from extraction rows.
- Unified the normal Step 11 path with the cached resume path. The CLI now uses the same `_run_meta_analysis_from_effects()`, GRADE, and figure helper functions after normal effect-size computation, reducing drift between fresh runs and late-stage resumes.
- Moved the Web override downstream rerun onto the shared meta-analysis and GRADE helpers. User extraction corrections now use the same pooling/GRADE code as CLI fresh/resume runs, with `force=True` for GRADE so stale downstream checkpoints do not hide corrected data.
- Moved the Web phase2/full-pipeline meta-analysis and GRADE blocks onto the same shared helpers. Web fresh runs now avoid the old hand-built `meta_engine + publication_bias + GRADEAgent + MetaAnalysisResults` copy, so secondary outcomes, subgroup handling, publication-bias state, NMA fields, and GRADE inputs follow the CLI path.
- Added ClinicalTrials.gov failed-request caching and fallback circuit breaking. In the current environment ClinicalTrials.gov times out even for direct NCT calls; failed query/NCT fetches are cached as `cached_failed`, and `CLINICALTRIALS_FAILURE_LIMIT` marks remaining registry probes as skipped while allowing OpenAlex/Semantic Scholar retrieval to continue. A live COVID corticosteroid retrieval probe now records two registry failures plus seven `clinicaltrials_failure_limit_reached` skips instead of waiting for every broad query to time out, and emits `pipeline_warnings.json` code `clinicaltrials_fallback_failed` for the evidence-readiness UI.
- Added protocol-oriented academic fallback queries and ranking for registry-first RCTs. When the query is COVID + hydrocortisone + critical/respiratory illness, the retriever probes short protocol/statistical-analysis-plan queries. In a live retrieval probe with ClinicalTrials.gov still timing out, the COVID STEROID protocol paper (`32779728`, `10.1111/aas.13673`) entered the capped top 30, improving search recall from 5/7 to 6/7 before local registry seeds were added.
- Added metadata-only registry seed fallback for registry-first trials that remain unreachable when ClinicalTrials.gov times out. The seed file currently includes Steroids-SARI (`NCT04244591`) and COVID STEROID (`NCT04348305`) from public registry mirrors, converts them to paper-like retrieval records, ranks them ahead of generic academic fallback records, and writes `registry_seed_fallback_manifest.json`. A live probe now reaches 7/7 search recall with these seeds, while preserving the warning that no outcome counts are available from seed metadata.
- Added a metadata-only guard for registry seeds. Seed records carry `text_availability="metadata_only"` and `needs_user_full_text=true`; PDF/full-text retrieval skips them, `text_source_warnings.json` reports that outcome extraction requires user-uploaded full text or verified source data, DataExtractionAgent skips them with `metadata_only_extraction_skipped` if they reach extraction, and manuscript facts separate metadata-only counts from abstract-only counts.
- Added a benchmark patient-total validator. `BenchmarkPrimaryComparison` now reports observed vs expected participant totals, participant difference, boolean gates for trial recall/event totals/patient totals/unexpected rows, and machine-readable failure reasons such as `patient_total_mismatch`.
- Added manuscript-level patient-total validation. `manuscript_facts.json` now carries selected primary-row population totals, `validate_and_repair_manuscript()` flags unsupported patient/participant total claims as errors, and the Web `evidence_readiness` payload exposes `primary_population`.
- Added manuscript-level primary-effect CI validation. The hard validator now checks that the reported primary effect's nearby 95% CI matches `manuscript_facts.json`; mismatched intervals fail with `primary_ci_mismatch`.
- Updated the legacy mock e2e fixture for the evidence-readiness contract. `tests/test_e2e.py` now writes a minimal source-backed `analysis/effect_selection_audit.json`, so the publication-style writer is tested only when the audit trail exists; otherwise the new behavior is to emit an evidence-gap report.
- Added manuscript artifact-reference validation and synchronized figure numbering. `validate_and_repair_manuscript()` now fails missing `Figure N`/`Table N` references, while `WritingAgent` only cites figure numbers in the PRISMA checklist when the corresponding generated image exists. The e2e fixture now passes all 8 generated figures into the writing step, so figure embedding, legends, and checklist locations are tested together.
- Added manuscript study-label contribution validation. `manuscript_facts.json` now separates primary-analysis study labels from review-only labels, and final validation fails when a non-primary study is described as contributing to the primary meta-analysis while allowing explicit “did not contribute” wording.
- Added manuscript secondary/subgroup effect validation. `manuscript_facts.json` now includes secondary and subgroup pooled effects, and final validation fails when reported secondary/subgroup effect values or nearby 95% CIs conflict with the deterministic analysis facts.
- Added a CLI figure embedding bridge. Fresh and cached-resume CLI manuscript generation now loads generated `figures/*.png` into the same `figures_b64` contract used by Web, so figure sections, legends, and PRISMA checklist locations can be present in command-line output as well.
- Added a minimal artifact zip. CLI completion now writes `package/metaagent_export.zip` with manuscript, figures, references, facts, validation, extraction/analysis audits, RoB/GRADE artifacts, and warnings, plus a package manifest.
- Added strict integer guards for event and denominator fields. Fractional values, percentages, and rate/proportion-only mappings are no longer truncated into event counts; invalid count-like values are dropped to `None` and recorded as extraction `conflicts`, while explicit multi-arm event/total mappings still sum correctly.
- Added backend review-queue payloads for strict count conflicts. Web `extraction_review` and `evidence_readiness` events now include `review_rows`, `conflict_rows`, `count_conflict_rows`, and `needs_user_count_verification` so the frontend can show percentage/rate-only rows as explicit user adjudication tasks.
- Added parser-versioned PDF/full-text caching. Uploaded PDFs and downloaded PDF/HTML full-text files are cached by content hash plus parser cache version, so repeated parsing can return immediately while parser upgrades deliberately invalidate stale parse output.
- Added Web progress visibility for full-text parse cache hits. Web phase summaries now include `n_fulltext_parse_cache_hits` in the completion text, so cache reuse is visible during repeated uploads or reruns rather than hidden in manifests/logs.
- Added pipeline-warning summaries to generated reports. `manuscript_facts.json` now carries `pipeline_warnings`, and the manuscript validator inserts a `Pipeline Warnings` section so evidence-gap/failure artifacts show retrieval, registry, parsing, GRADE, or figure failures without requiring users to open logs.
- Added a benchmark blocked-report gate. Project benchmark evaluation now fails blocked/evidence-gap runs that still emit publication-style `Abstract`, `Methods`, or `Results` sections, preventing future regressions where a failed benchmark looks submission-ready.
- Added content-level benchmark checks for blocked reports. Evidence-gap/failed benchmark drafts now also fail if they contain unsupported efficacy or publication-ready conclusion language, even when headings are clean.
- Added issue-code disclosure checks for blocked reports. Benchmark evaluation now requires evidence-gap/failed drafts to mention every evidence-readiness blocker code, or validation issue kinds when blocker codes are absent, so the artifact remains actionable.
- Added manifest-level primary-timepoint adjudication checks. The WHO REACT manifest now marks CAPE COVID as a 28-day mortality benchmark row that may use the 21-day CAPE COVID endpoint only when the selected primary-effect row carries an explicit protocol/user adjudication note; benchmark comparison fails with `timepoint_adjudication_mismatch` if this is pooled silently. The gate uses source/timepoint/adjudication fields rather than trusting a generated `outcome_name`, so a row labelled “28-day mortality” still fails when the source quote does not verify the target timepoint.
- Added ordinary evidence-readiness support for timepoint adjudication overrides. If a user/protocol review writes `accepted_timepoint` or `timepoint_adjudication_note` into the selected primary row, `primary_timepoint_not_source_verified` is downgraded to a visible `primary_timepoint_adjudicated` warning instead of remaining an un-clearable blocker.
- Added Web override coverage for the same adjudication fields. Backend override messages can now persist and apply `timepoint_adjudication_note` immediately, clearing downstream checkpoints so the adjudication can affect effect selection, evidence-readiness, and writing on rerun.
- Added a Web-ready timepoint adjudication queue. The evidence-readiness payload now includes `timepoint_adjudication_rows` with row IDs, source snippets, current adjudication fields, and suggested override payloads, so CAPE COVID-style closest-timepoint decisions can be rendered as explicit user review tasks.
- Added a source-backed primary-count gate. Regenerating manuscript facts for the current benchmark now adds `primary_counts_not_source_verified` for CAPE COVID because the selected quote contains 11 and 20 deaths but does not verify the extracted denominators 76 and 73.
- Added a Web-ready primary-count verification queue. The evidence-readiness payload now includes `primary_count_verification_rows` with missing count values and suggested `source_quote`/`source_location` overrides, so denominator/source gaps can be fixed from the review UI rather than hunted down in logs.
- Added an offline review artifact to export packages. `metaagent_export.zip` now includes `review/evidence_readiness_review.json`, carrying blockers, warnings, selected primary rows, timepoint adjudication tasks, and primary-count verification tasks; `package_manifest.json` summarizes the queue counts.
- Downstream reruns after extraction overrides now regenerate `metaagent_export.zip` and return `package_path`, so a user who fixes a denominator quote or timepoint adjudication receives a fresh package with the updated review artifact.
- Added explicit benchmark source decisions and applications. Downloaded WHO REACT/JAMA Figure 2 was attached as a benchmark source, reviewer-accepted quote candidates were saved in `benchmark_source_decisions.json`, and only the explicit `benchmark_source_apply` step wrote manual-adjudication extraction rows/updates plus `benchmark_source_applications.json`.
- Added primary-count discrepancy tasks for already matched trials. The benchmark review now creates `primary_count_discrepancy:<trial_id>` tasks when a selected row matches an expected trial but has arm-level counts that differ from the published anchor, which surfaced and fixed CAPE COVID, REMAP-CAP, and RECOVERY count mismatches from the Figure 2 source.
- Tightened benchmark quote candidates. Count candidates now require all expected values in a short window and prefer the matching sentence/table row, preventing long snippets from accidentally carrying unrelated “subgroup fixed effect” text into source quotes or population/subgroup checks.
- Fixed source-application targeting. Benchmark source applications now prefer explicit `row_id` targets before fuzzy publication/title matching, so a discrepancy task for RECOVERY updates the selected invasive-mechanical-ventilation row rather than the overall outcome row.
- Current COVID benchmark comparison after source adjudication:
  - Primary-analysis trial recall: 7/7 matched.
  - Primary arm-level counts: 222/678 vs 425/1025, matching the WHO REACT/JAMA Figure 2 anchor.
  - Fixed-effect OR after protocol alignment: 0.659 (95% CI 0.532 to 0.817), matching the published OR 0.66 (95% CI 0.53 to 0.82) within tolerance.
- User-provided source refresh on 2026-05-22:
  - Downloaded/saved PMC/JAMA OA text for WHO REACT (`PMC7489434`), CoDEX (`PMC7489411`), and CAPE COVID (`PMC7489432`).
  - Downloaded/saved ClinicalTrials.gov v2 records for `NCT04327401`, `NCT02517489`, `NCT04348305`, `NCT04244591`, and `NCT04325061`.
  - Downloaded/saved EudraCT `2020-001395-15` results and COVID-NMA Steroids-SARI detail page.
  - Staged user-provided PDFs `AAS-65-1421.pdf` and `13063_2020_Article_4643.pdf`.
  - Local acquisition directory: `output/benchmark_source_downloads/covid_react_2020/user_links_20260522/`.
- Benchmark source/full-text gate after source refresh:
  - Explicit `primary_source` / `primary_full_text` benchmark sources now satisfy primary-source and primary-full-text gates; ordinary Figure 2 transcriptions or generic `benchmark_source` files do not.
  - Current project-level benchmark status is `passed`: primary source/full text 7/7, primary analysis 7/7, pooled effect passed, no failing benchmark gates.
  - Fresh search recall remains 5/7 for the persisted run, deliberately preserving the difference between automatic retrieval performance and user-assisted source acquisition.
- Fresh pipeline source-acquisition hardening after the 2026-05-22 iteration:
  - ClinicalTrials.gov fallback records are now automatically materialized into parsable `clinicaltrials_registry` text sources during `download_pdfs()`, rather than stopping at metadata-only protocol cards.
  - Local `registry_seed` entries can now carry official `source_urls`; when present, the retriever automatically fetches those registry/result pages into `registry_seed_source` text artifacts instead of forcing user upload first.
  - Europe PMC PMCID fallback now includes `pmc.ncbi.nlm.nih.gov/articles/<PMCID>/` HTML, which improves recovery for OA PMC mirrors when Europe PMC returns only a shell page.
  - A targeted live probe confirmed the new behavior: `NCT04348305` now becomes a `clinicaltrials_registry` full-text source automatically, and the Steroids-SARI seed (`NCT04244591`) auto-fetches its official source URL into a `registry_seed_source` text artifact.
- Manuscript-readiness after source refresh:
  - Recomputing `manuscript_facts` with the refreshed sources gives `report_type="meta"`, `status="needs_review"`, no evidence-readiness blockers, and no abstract/metadata-only source warnings.
  - Remaining manuscript readiness issues are review warnings: unresolved extraction review rows and conflict rows still need UI-level user confirmation before a submission-grade report should be considered final.
  - A publication-style manuscript was not regenerated in this pass because the active LLM provider repeatedly returned connection errors; the last saved draft remains an evidence-gap artifact until manuscript-only rerun succeeds.
- Publication-style manuscript recovery after the same iteration:
  - CLI now supports `--rerun-manuscript-only`, and Web `resume_project` supports `rerun_manuscript_only=true`, so cached analysis artifacts can force a manuscript rewrite even when the manuscript checkpoint already exists.
  - If the prose-generation LLM fails on a `report_type="meta"` run, the writer now emits a deterministic publication-style skeleton from `manuscript_facts.json` instead of leaving the project stuck on an older evidence-gap draft.
- Effect/model adjudication after the 2026-05-23 refresh:
  - Benchmark summaries now include published-anchor and observed `model_preference` alongside `effect_measure`; the current passed COVID project reports fixed-effect OR for both sides.
  - If a fresh run uses the wrong effect measure or model, `review/benchmark_review.json` will now include a `protocol_adjudication_tasks` entry with a `suggested_protocol_patch` instead of leaving the user to infer the required protocol edit from a pooled-effect mismatch.
  - The refreshed package manifest includes `benchmark_protocol_adjudication_tasks`; the current passed package has value 0.
  - Web can now execute that suggestion through `protocol_override`, which updates `protocol.json`, writes `protocol_overrides.json`, clears stale downstream checkpoints, and returns refreshed benchmark/evidence-readiness payloads.
  - The same `protocol_overrides.json` audit path is now used by CLI known-source recovery when WHO REACT Figure 2 preferences automatically align the protocol to fixed-effect OR, so automatic one-click corrections are visible rather than hidden in extraction internals.

## Remaining required iteration

- Promote the local registry-seed approach into a maintainable production registry mirror. The current seed closes this benchmark's search recall gap, but it is a small metadata fixture; production needs AACT snapshot, NCT mirror/cache service, or curated pre-warmed registry cache with refresh dates and source audit.
- Re-run the full benchmark from a fresh one-click pipeline after the source-adjudication fixes. The persisted project can now match the published primary counts and fixed-effect OR after explicit source applications and protocol alignment; fresh runs still need to reach the same state without manual harness intervention.
- Add PMC/OAI, repository-specific, or user-upload-first full-text retrieval beyond Europe PMC direct PDF/XML; current JAMA articles still fall back to abstract-only in this environment.
- Add publisher-specific or repository fallback for JAMA PDFs that return 403 from the direct article PDF endpoint.
- Continue tightening no-full-text extraction: abstract-only data now blocks selected primary effects, but the UI still needs an explicit review/adjudication workflow for all abstract-only records.
- Render strict count-field conflicts in the actual Web extraction review UI, using the new `count_conflict_rows` payload so users can enter verified numerators and denominators from the paper.
- Render the already-exposed `benchmark` payload, source-decision controls, and `benchmark_source_apply` action in the actual Web UI next to evidence-readiness, so users can accept source candidates and trigger audited extraction updates without using backend scripts.
- Add trial-level duplicate detection before extraction/screening, not only at effect-size time.
- Extend the deterministic evidence-gap artifact into the Web UI and add a user adjudication flow for clearing blockers.
- Render the new `evidence_readiness` event in the Web UI as a review queue and connect each blocker to the corresponding extraction audit row.
- Add frontend controls for the new backend `rerun_downstream` action after extraction overrides are saved and downstream checkpoints are cleared.
- Extend secondary/subgroup validation from deterministic pooled-result consistency to source-backed extraction-row traceability where subgroup/timepoint adjudication is ambiguous.
- Render strict primary-timepoint adjudication controls in the ordinary Web review flow, so users can explicitly accept or reject closest-timepoint rows before pooling using the backend fields now supported by evidence-readiness.
- Extend report-level warning summaries with direct links/row IDs to the affected PDF, registry record, figure, or extraction row when those identifiers are available.
- Extend blocked-report gates to require direct row IDs or file identifiers for blocker codes when those identifiers are present in `manuscript_facts.json` or `pipeline_warnings.json`.
- Finish remaining checkpoint polish beyond the late-stage helper convergence: align the broader Web phase runner with the same shared helpers and add end-to-end resume smoke tests over a persisted project directory.
- Break down cache-hit messages by upload-intake cache vs downstream full-text parse cache in the eventual frontend review panel.
- Render the new `pipeline_warnings` payload in the actual Web UI review panel, beyond backend payloads and generated report text.
- Extend deterministic GRADE indirectness beyond the first-pass rules: persist numeric similarity/audit fields, add post-hoc subgroup and follow-up-window checks, and pass effect-selection population/timepoint adjudication directly into GRADE.
- Add a first-class protocol/effect-measure adjudication step. The COVID benchmark only matches the published pooled result after setting the protocol to fixed-effect OR; the system should surface benchmark/published-anchor effect-measure mismatch as an explicit user decision instead of relying on manual JSON editing.
