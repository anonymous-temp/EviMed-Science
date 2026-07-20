# Extraction Source Cards Contract

This contract is the frontend-facing trust layer for extracted outcome data. It is emitted in two places:

- WebSocket `evidence_readiness` / extraction review payload: `extraction_review.source_cards`
- Artifact zip: `review/evidence_readiness_review.json.extraction_source_cards`
- Artifact zip review page: `review/extraction_review.html`

Both use the shared helpers in `new_meta.core.extraction_review` so the live UI and offline audit package stay identical.

## Card Shape

Each source card represents one extracted outcome row.

```json
{
  "row_id": "36027570:0",
  "study_id": "36027570",
  "outcome_index": 0,
  "study": {
    "label": "Solomon 2022",
    "title": "Dapagliflozin in Heart Failure with Mildly Reduced or Preserved Ejection Fraction",
    "pmid": "36027570",
    "doi": "10.xxxx/example",
    "source_type": "user_upload",
    "pdf_path": "/.../user_fulltexts/deliver.pdf"
  },
  "outcome": {
    "name": "primary composite outcome",
    "type": "time_to_event",
    "timepoint": "median 2.3 years",
    "accepted_timepoint": "median 2.3 years"
  },
  "values": [
    {
      "field": "hazard_ratio",
      "label": "hazard ratio",
      "value": 0.82,
      "editable": true,
      "conflicts": [],
      "source_quote_verified": true,
      "extraction_confidence": "high",
      "suggested_override": {
        "study_id": "36027570",
        "outcome_index": 0,
        "outcome_name": "primary composite outcome",
        "field": "hazard_ratio",
        "value": 0.82
      }
    }
  ],
  "source": {
    "location": "Table 2",
    "page": 5,
    "section": "Results",
    "quote": "hazard ratio, 0.82; 95% CI, 0.73 to 0.92",
    "quote_match": "hazard ratio, 0.82; 95% CI, 0.73 to 0.92",
    "quote_verified": true
  },
  "source_context": {
    "available": true,
    "match_strategy": "quote",
    "source_file": "papers/parsed_papers.json",
    "page": 5,
    "prefix": "Primary outcome events were recorded in the results table.",
    "match_text": "hazard ratio, 0.82; 95% CI, 0.73 to 0.92",
    "suffix": "The result favored dapagliflozin over placebo.",
    "start_char": 18420,
    "end_char": 18465
  },
  "confidence": "high",
  "conflicts": [],
  "requires_review": false,
  "review_reasons": [],
  "override": {
    "current_revision": 3,
    "user_override_applied": false,
    "override_revision": null,
    "save_message_type": "extraction_override",
    "rerun_message_type": "rerun_after_overrides"
  },
  "review_decision": null,
  "review_action": {
    "current_revision": 0,
    "save_message_type": "extraction_review_decision",
    "suggested_decision": {
      "row_id": "36027570:0",
      "study_id": "36027570",
      "outcome_index": 0,
      "outcome_name": "primary composite outcome",
      "decision": "accepted",
      "note": "Reviewer confirmed extracted values against the displayed source quote.",
      "resolves_review": true,
      "resolves_conflicts": true
    }
  }
}
```

`source_context.match_strategy` is `"quote"` when the stored quote or quote match was found directly. It is `"numeric_context"` when direct quote matching failed but the backend found a conservative source window containing extracted numeric values plus outcome context. It is `"unavailable"` when the system could not find a safe source window.

The surrounding extraction-review payload also exposes coverage counters:

```json
{
  "summary": {
    "source_context_available_cards": 10,
    "source_context_missing_cards": 6,
    "source_context_coverage": 0.625,
    "source_context_missing_review_cards": 6
  },
  "missing_source_context_cards": [
    {
      "row_id": "34449189:4",
      "study_id": "34449189",
      "study_label": "Empagliflozin in Heart Failure with a Preserved Ejection Fraction",
      "outcome_name": "KCCQ-CSS change",
      "quote_verified": false,
      "requires_review": true,
      "missing_reason": "source_context_unavailable"
    }
  ]
}
```

## UI Behavior

1. Render one card per extracted outcome row.
2. Clicking any `values[]` item opens the source drawer:
   - show `source.location`, `source.page`, `source.section`
   - show `source.quote` with `source.quote_match` highlighted when available
   - show `source_context.prefix + match_text + suffix` when available, highlighting `match_text` so the user can verify the extracted number in its original neighborhood rather than as an isolated quote
   - label whether the context came from direct quote matching or numeric-context recovery
   - show `source.quote_verified`, `confidence`, and `review_reasons`
3. The edit action sends WebSocket message type `extraction_override`.
   - Use `value.suggested_override` as the payload seed.
   - Include `expected_revision: card.override.current_revision`.
   - On stale revision, refresh the review payload and show a conflict message.
4. The confirm action sends WebSocket message type `extraction_review_decision`.
   - Use `card.review_action.suggested_decision` as the payload seed.
   - Include `expected_revision: card.review_action.current_revision`.
   - This resolves source-review/conflict warnings after the user has checked the quote and values, without changing extracted values.
5. The rerun action sends message type `rerun_after_overrides`.
6. Cards with `requires_review=true` or non-empty `review_reasons` should be pinned above verified cards.

The static artifact page follows the same interaction model with native HTML `details` panels. It is intentionally dependency-free so users can open it directly from `metaagent_export.zip` before the production frontend has implemented the richer source drawer.

## WebSocket Messages

The source drawer should not write directly to project files. It should send the same structured messages already accepted by `start.py`.

To confirm a row after checking the source context:

```json
{
  "type": "extraction_review_decision",
  "project_dir": "/path/to/output/project",
  "expected_revision": 0,
  "decision": {
    "row_id": "36027570:0",
    "study_id": "36027570",
    "outcome_index": 0,
    "outcome_name": "primary composite outcome",
    "decision": "accepted",
    "note": "Reviewer confirmed extracted values against the displayed source context.",
    "resolves_review": true,
    "resolves_conflicts": true
  }
}
```

The backend replies with `extraction_review_decision_saved` and then pushes a refreshed `extraction_review` payload. If the reply has `ok=false` and `error="revision_conflict"`, refresh the drawer and ask the user to retry against the new revision.

To edit one value:

```json
{
  "type": "extraction_override",
  "project_dir": "/path/to/output/project",
  "expected_revision": 3,
  "override": {
    "study_id": "36027570",
    "outcome_index": 0,
    "outcome_name": "primary composite outcome",
    "field": "hazard_ratio",
    "value": 0.82,
    "reason": "Corrected after checking source context"
  }
}
```

The backend replies with `extraction_override_saved`, pushes a refreshed `extraction_review`, and marks downstream analysis as requiring rerun. The UI should then offer the `rerun_after_overrides` action.

## Review Reason Meanings

- `source_quote_unverified`: the quote was not found in the parsed source text.
- `missing_source_quote`: no quote was saved for the extracted value.
- `low_confidence`: the extraction agent marked this row as low confidence.
- `conflicts_present`: conflicting source or schema signals exist.
- `count_conflict`: arm-level counts require explicit whole-number confirmation.

## Current Benchmark Snapshot

The latest real-PDF SGLT2 HFpEF benchmark package at `output/benchmark_runs/20260521_112500_sglt2_hfpef_real_pdf_upload_fixed_match/package/metaagent_export.zip` currently exports:

- `16` extraction source cards
- `7` review cards
- `review/extraction_review.html` for offline source-card review
- primary pooled HR `0.807` with 95% CI `0.740` to `0.880`, matching the published anchor HR `0.80` with 95% CI `0.73` to `0.87`
- two user-uploaded NEJM PDFs matched by exact `filename_title`: DELIVER PMID `36027570` and EMPEROR-Preserved PMID `34449189`

Earlier pre-routing runs exported `64` source cards and `31` review cards; the reduction comes from retaining secondary/design/surrogate records as `related_source_only` instead of extracting them as independent studies.
