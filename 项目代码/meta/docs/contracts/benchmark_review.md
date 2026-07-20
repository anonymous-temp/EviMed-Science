# Benchmark Review Contract

This contract exposes published-anchor benchmark status through the same user review surfaces as evidence readiness.

## Producers

- CLI: `python -m new_meta.core.benchmark_manifest <manifest> <project_dir> --project --write-report`
- Web payload: `start.py::_load_evidence_readiness_payload()` under `benchmark`
- Artifact package:
  - `benchmark/benchmark_report.json`
  - `benchmark/benchmark_summary_card.json`
  - `benchmark/benchmark_source_manifest.json`
  - `benchmark/benchmark_source_decisions.json`
  - `benchmark/benchmark_source_applications.json`
  - `benchmark/source_parsed/*.json`
  - `review/benchmark_review.json`
  - `review/benchmark_review.html`

## Payload Shape

```json
{
  "benchmark_id": "sglt2_hfpef_2022_vaduganathan_lancet",
  "project_dir": "output/benchmark_runs/...",
  "status": "passed",
  "passed": true,
  "summary": {
    "gates": 7,
    "failing_gates": 0,
    "missing_primary_full_texts": 0,
    "next_actions": 0,
    "source_acquisition_tasks": 0,
    "attached_source_tasks": 0,
    "source_decision_revision": 0,
    "accepted_source_candidates": 0,
    "rejected_source_candidates": 0,
    "benchmark_source_applications": 0
  },
  "summary_card": {},
  "published_anchor": {},
  "observed_primary": {},
  "gates": [],
  "failing_gates": [],
  "missing_primary_full_texts": [],
  "source_acquisition_tasks": [],
  "next_actions": [],
  "primary_analysis": {},
  "pooled_effect": {},
  "manuscript_gate": {}
}
```

## UI Guidance

- Show this next to evidence-readiness rather than in a separate hidden debug panel.
- For `status="passed"`, render it as a published-anchor receipt: expected studies/counts/effect vs observed output.
- For `status="blocked"` or `status="failed"`, render the failing gates first, then missing full texts and next actions.
- `source_acquisition_tasks` is the actionable user checklist. Render it before generic next actions.
- `task_type="full_text_upload"` should connect to the full-text upload flow when PMID/DOI/title hints are present.
- `task_type="primary_source_request"` means no PMID/DOI is available; ask the user for a primary paper, supplement, registry result page, or benchmark appendix source.
- `task_type="primary_count_source"` means the benchmark trial is known but the four arm-level counts still need a source table/appendix row.
- `task_type="primary_count_discrepancy"` means the trial is already matched, but the selected extraction row's arm-level counts disagree with the published benchmark and need source-backed correction.
- `task_type="timepoint_adjudication_source"` should open the extraction override/adjudication flow.
- `primary_analysis` gaps should link to extraction source cards and override review where row IDs are available.
- When a user uploads source material for a task, send `type="benchmark_source_upload"` with `project_dir`, `task_id`, `trial_id`, `trial_name`, `source_kind`, and `fileIds` or project-local `local_paths`.
- Uploaded benchmark sources are staged into `benchmark/sources/<trial_id>/` and recorded in `benchmark/benchmark_source_manifest.json`.
- Each uploaded source is parsed for a lightweight preview when possible. The task's `uploaded_sources[]` entries include `parse_status`, `parse_error`, `parsed_path`, `text_chars`, `page_count`, `table_count`, and `text_preview`.
- Full parsed benchmark source artifacts are stored under `benchmark/source_parsed/*.json` and included in `metaagent_export.zip`. The Web payload should show `parsed_path` as an internal artifact pointer, not inline the full parsed text.
- When a parsed uploaded source contains the task's expected arm-level counts or accepted timepoint text, `uploaded_sources[]` may include `quote_candidates[]`. These candidates contain `candidate_type`, `matched_values`, `quote`, `source_location`, optional `source_page`, and a `suggested_override` seed. Render these as reviewer suggestions only.
- Uploaded benchmark sources do not change extraction, effect selection, or meta-analysis automatically. They mark the task as `source_uploaded_needs_review` until the user or reviewer applies an extraction override or a later source-ingestion step.
- Quote candidates also do not mutate the evidence set. A reviewer must explicitly save an extraction override/adjudication before downstream rerun can use the uploaded source.
- To record a reviewer decision on a quote candidate, send `type="benchmark_source_decision"` with `project_dir`, `expected_revision`, `task_id`, `trial_id`, `source`, `candidate`, `decision="accepted"|"rejected"`, and optional `reason`. The backend writes `benchmark/benchmark_source_decisions.json`, returns `benchmark_source_decision_saved`, and refreshes `benchmark_review`.
- Accepted candidates mark their task as `source_candidate_accepted_needs_override`. This means the source has been reviewer-accepted but has still not changed extraction or pooled effects.
- To apply accepted candidates to extraction data, send `type="benchmark_source_apply"` with `project_dir`, optional `candidate_ids`, `expected_revision`, and optional `force=true`. The backend writes/updates `extraction/all_extractions.json`, records `benchmark/benchmark_source_applications.json`, refreshes extraction audit cards, clears downstream checkpoints, and returns `benchmark_source_apply_done`.
- Applying benchmark source candidates is explicit and audited. It creates manual-adjudication extraction stubs only when no matching study exists; otherwise it updates the exact `row_id` for discrepancy tasks or the best publication-ID match. It never happens merely because a candidate was accepted.

## Current Benchmarks

- SGLT2 HFpEF/HFmrEF real-PDF project: benchmark payload reports `passed`, 0 failing gates.
- COVID corticosteroids persisted project after source adjudication: primary-analysis counts now match the WHO REACT/JAMA Figure 2 anchor and the pooled fixed-effect OR matches the published anchor within tolerance; the overall benchmark remains `blocked` because primary-publication/full-text recall gates still require source-complete local full texts.
