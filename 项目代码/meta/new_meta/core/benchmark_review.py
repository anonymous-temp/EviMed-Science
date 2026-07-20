"""Shared benchmark review payload helpers."""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from new_meta.core.benchmark_source_decisions import (
    benchmark_candidate_id,
    load_benchmark_source_decisions,
)
from new_meta.core.project import Project


def build_benchmark_review_payload(project: Project) -> dict[str, Any] | None:
    """Load a UI/package-ready benchmark comparison payload from a project."""
    report = project.load_json("benchmark_report.json", subdir="benchmark")
    if not isinstance(report, dict):
        return None
    summary_card = report.get("summary_card")
    if not isinstance(summary_card, dict):
        summary_card = project.load_json("benchmark_summary_card.json", subdir="benchmark")
    if not isinstance(summary_card, dict):
        summary_card = {}

    failing_gates = summary_card.get("failing_gates") or []
    missing_primary_full_texts = summary_card.get("missing_primary_full_texts") or []
    next_actions = summary_card.get("next_actions") or []
    uploaded_sources = _uploaded_sources_by_task(project)
    source_decision_manifest = load_benchmark_source_decisions(project)
    source_decisions = {
        decision.candidate_id: decision.model_dump()
        for decision in source_decision_manifest.decisions
    }
    source_tasks = build_source_acquisition_tasks(
        summary_card,
        report.get("primary_analysis") or {},
        str(project.base_dir),
        uploaded_sources=uploaded_sources,
        source_decisions=source_decisions,
    )
    protocol_tasks = build_protocol_adjudication_tasks(
        summary_card,
        report.get("pooled_effect") or {},
        str(project.base_dir),
    )
    attached_source_tasks = sum(1 for task in source_tasks if task.get("uploaded_sources"))
    source_candidate_counts = _source_candidate_decision_counts(source_tasks)
    return {
        "benchmark_id": report.get("benchmark_id") or summary_card.get("benchmark_id") or "",
        "project_dir": report.get("project_dir") or summary_card.get("project_dir") or str(project.base_dir),
        "status": summary_card.get("status") or "",
        "passed": summary_card.get("passed"),
        "summary": {
            "gates": len(summary_card.get("gates") or []),
            "failing_gates": len(failing_gates),
            "missing_primary_full_texts": len(missing_primary_full_texts),
            "next_actions": len(next_actions),
            "source_acquisition_tasks": len(source_tasks),
            "protocol_adjudication_tasks": len(protocol_tasks),
            "attached_source_tasks": attached_source_tasks,
            "source_decision_revision": source_decision_manifest.current_revision,
            **source_candidate_counts,
        },
        "summary_card": summary_card,
        "published_anchor": summary_card.get("published_anchor") or {},
        "observed_primary": summary_card.get("observed_primary") or {},
        "gates": summary_card.get("gates") or [],
        "failing_gates": failing_gates,
        "missing_primary_full_texts": missing_primary_full_texts,
        "next_actions": next_actions,
        "source_acquisition_tasks": source_tasks,
        "protocol_adjudication_tasks": protocol_tasks,
        "primary_analysis": report.get("primary_analysis") or {},
        "pooled_effect": report.get("pooled_effect") or {},
        "manuscript_gate": report.get("manuscript_gate") or {},
    }


def build_source_acquisition_tasks(
    summary_card: dict[str, Any],
    primary_analysis: dict[str, Any],
    project_dir: str,
    uploaded_sources: dict[str, list[dict[str, Any]]] | None = None,
    source_decisions: dict[str, dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Convert benchmark gaps into user-facing source acquisition tasks."""
    uploaded_sources = uploaded_sources or {}
    source_decisions = source_decisions or {}
    tasks: list[dict[str, Any]] = []
    covered_trial_ids: set[str] = set()
    primary_missing_by_trial = {
        str(item.get("trial_id") or ""): item
        for item in primary_analysis.get("missing") or []
        if item.get("trial_id")
    }

    for item in summary_card.get("missing_primary_full_texts") or []:
        trial_id = str(item.get("trial_id") or "").strip()
        if not trial_id:
            continue
        expected_counts = _expected_counts(primary_missing_by_trial.get(trial_id, {}))
        has_publication_identifier = bool(item.get("publication_pmids") or item.get("publication_dois"))
        if has_publication_identifier:
            task = _full_text_upload_task(item, project_dir, expected_counts)
        else:
            task = _primary_source_request_task(item, project_dir, expected_counts)
        _apply_uploaded_sources(task, uploaded_sources, source_decisions)
        tasks.append(task)
        covered_trial_ids.add(trial_id)

    for item in primary_analysis.get("missing") or []:
        trial_id = str(item.get("trial_id") or "").strip()
        if not trial_id or trial_id in covered_trial_ids:
            continue
        task = _primary_count_source_task(item, project_dir)
        _apply_uploaded_sources(task, uploaded_sources, source_decisions)
        tasks.append(task)
        covered_trial_ids.add(trial_id)

    matched_items = primary_analysis.get("matched") or {}
    if isinstance(matched_items, dict):
        for trial_id, item in matched_items.items():
            if not isinstance(item, dict):
                continue
            count_mismatches = item.get("count_mismatches") or {}
            if not count_mismatches:
                continue
            task = _primary_count_discrepancy_task(str(trial_id), item, project_dir)
            _apply_uploaded_sources(task, uploaded_sources, source_decisions)
            tasks.append(task)

    for item in primary_analysis.get("timepoint_mismatches") or []:
        row_id = str(item.get("row_id") or "").strip()
        trial_id = str(item.get("trial_id") or "").strip()
        task_id = f"timepoint:{row_id or trial_id}"
        task = {
            "task_id": task_id,
            "task_type": "timepoint_adjudication_source",
            "status": "needs_timepoint_adjudication",
            "priority": "medium",
            "trial_id": trial_id,
            "trial_name": item.get("trial_name") or trial_id,
            "row_id": row_id,
            "registration_id": item.get("registration_id") or "",
            "expected_primary_timepoint": item.get("expected_primary_timepoint") or "",
            "accepted_timepoints": item.get("accepted_timepoints") or [],
            "message": "Find the source section or supplement that justifies the benchmark timepoint, or record a user/protocol adjudication.",
            "accepted_file_hints": _dedupe_hints([
                item.get("registration_id"),
                item.get("trial_name"),
                item.get("expected_primary_timepoint"),
                *(item.get("accepted_timepoints") or []),
            ]),
            "suggested_override": {
                "type": "extraction_override",
                "project_dir": project_dir,
                "row_id": row_id,
                "fields": ["accepted_timepoint", "timepoint_adjudication_note"],
            },
        }
        _apply_uploaded_sources(task, uploaded_sources, source_decisions)
        tasks.append(task)

    return tasks


def build_protocol_adjudication_tasks(
    summary_card: dict[str, Any],
    pooled_effect: dict[str, Any],
    project_dir: str,
) -> list[dict[str, Any]]:
    """Convert pooled-effect benchmark mismatches into protocol decision tasks."""
    failure_reasons = _pooled_effect_failure_reasons(summary_card, pooled_effect)
    if not failure_reasons:
        return []
    decision_reasons = {
        "effect_measure_mismatch",
        "model_preference_mismatch",
        "pooled_effect_mismatch",
        "pooled_ci_mismatch",
    }
    if not any(reason in decision_reasons for reason in failure_reasons):
        return []

    anchor = _pooled_anchor(summary_card, pooled_effect)
    observed = _pooled_observed(summary_card, pooled_effect)
    fields = {}
    expected_measure = str(anchor.get("effect_measure") or "").strip().upper()
    expected_model = str(anchor.get("model_preference") or "").strip().lower()
    if expected_measure:
        fields["effect_measure"] = expected_measure
    if expected_model:
        fields["model_preference"] = expected_model
    if not fields:
        return []

    return [
        {
            "task_id": "protocol_effect_model:pooled_effect",
            "task_type": "protocol_effect_model_adjudication",
            "status": "needs_protocol_decision",
            "priority": "high",
            "failure_reasons": failure_reasons,
            "published_anchor": anchor,
            "observed_primary": observed,
            "message": (
                "The pooled result does not match the published benchmark anchor. "
                "Confirm whether the protocol should use the benchmark effect measure/model, "
                "then rerun downstream analysis."
            ),
            "suggested_protocol_patch": {
                "type": "protocol_override",
                "project_dir": project_dir,
                "fields": fields,
                "reason": (
                    "Align protocol effect measure/model with the published benchmark anchor "
                    "before rerunning downstream analysis."
                ),
            },
        }
    ]


def _pooled_effect_failure_reasons(summary_card: dict[str, Any], pooled_effect: dict[str, Any]) -> list[str]:
    reasons = list(pooled_effect.get("failure_reasons") or [])
    for gate in summary_card.get("failing_gates") or []:
        if not isinstance(gate, dict) or gate.get("gate") != "pooled_effect":
            continue
        reasons.extend(gate.get("failure_reasons") or [])
    return list(dict.fromkeys(str(reason) for reason in reasons if reason))


def _pooled_anchor(summary_card: dict[str, Any], pooled_effect: dict[str, Any]) -> dict[str, Any]:
    gate_expected = _pooled_gate_side(summary_card, "expected")
    published = summary_card.get("published_anchor") if isinstance(summary_card.get("published_anchor"), dict) else {}
    return _compact_empty({
        "effect_measure": (
            pooled_effect.get("expected_effect_measure")
            or gate_expected.get("effect_measure")
            or published.get("effect_measure")
        ),
        "model_preference": (
            pooled_effect.get("expected_model_preference")
            or gate_expected.get("model_preference")
            or published.get("model_preference")
        ),
        "effect": pooled_effect.get("expected_effect") or gate_expected.get("effect") or published.get("effect"),
        "ci_lower": pooled_effect.get("expected_ci_lower") or gate_expected.get("ci_lower") or published.get("ci_lower"),
        "ci_upper": pooled_effect.get("expected_ci_upper") or gate_expected.get("ci_upper") or published.get("ci_upper"),
    })


def _pooled_observed(summary_card: dict[str, Any], pooled_effect: dict[str, Any]) -> dict[str, Any]:
    gate_observed = _pooled_gate_side(summary_card, "observed")
    observed = summary_card.get("observed_primary") if isinstance(summary_card.get("observed_primary"), dict) else {}
    return _compact_empty({
        "effect_measure": (
            pooled_effect.get("observed_effect_measure")
            or gate_observed.get("effect_measure")
            or observed.get("effect_measure")
        ),
        "model_preference": (
            pooled_effect.get("observed_model_preference")
            or gate_observed.get("model_preference")
            or observed.get("model_preference")
        ),
        "effect": pooled_effect.get("observed_effect") or gate_observed.get("effect") or observed.get("effect"),
        "ci_lower": pooled_effect.get("observed_ci_lower") or gate_observed.get("ci_lower") or observed.get("ci_lower"),
        "ci_upper": pooled_effect.get("observed_ci_upper") or gate_observed.get("ci_upper") or observed.get("ci_upper"),
    })


def _pooled_gate_side(summary_card: dict[str, Any], side: str) -> dict[str, Any]:
    for gate in summary_card.get("gates") or []:
        if isinstance(gate, dict) and gate.get("gate") == "pooled_effect":
            value = gate.get(side)
            return value if isinstance(value, dict) else {}
    for gate in summary_card.get("failing_gates") or []:
        if isinstance(gate, dict) and gate.get("gate") == "pooled_effect":
            value = gate.get(side)
            return value if isinstance(value, dict) else {}
    return {}


def _compact_empty(data: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in data.items()
        if value is not None and value != ""
    }


def _uploaded_sources_by_task(project: Project) -> dict[str, list[dict[str, Any]]]:
    manifest = project.load_json("benchmark_source_manifest.json", subdir="benchmark")
    if not isinstance(manifest, dict):
        return {}
    grouped: dict[str, list[dict[str, Any]]] = {}
    for source in manifest.get("sources") or []:
        if not isinstance(source, dict):
            continue
        task_id = str(source.get("task_id") or "").strip()
        trial_id = str(source.get("trial_id") or "").strip()
        keys = [key for key in [task_id, f"trial:{trial_id}" if trial_id else ""] if key]
        public_source = {
            "filename": source.get("filename") or "",
            "local_path": source.get("local_path") or "",
            "source_kind": source.get("source_kind") or "",
            "status": source.get("status") or "",
            "sha256": source.get("sha256") or "",
            "size_bytes": source.get("size_bytes") or 0,
            "parse_status": source.get("parse_status") or "",
            "parse_error": source.get("parse_error") or "",
            "parsed_path": source.get("parsed_path") or "",
            "text_chars": source.get("text_chars") or 0,
            "page_count": source.get("page_count") or 0,
            "table_count": source.get("table_count") or 0,
            "text_preview": source.get("text_preview") or "",
            "uploaded_at": source.get("uploaded_at"),
        }
        parsed = _load_parsed_source(project, public_source.get("parsed_path") or "")
        if parsed:
            public_source["_parsed_text"] = parsed.get("text") or ""
            public_source["_parsed_page_map"] = parsed.get("page_map") or []
        for key in keys:
            grouped.setdefault(key, []).append(dict(public_source))
    return grouped


def _apply_uploaded_sources(
    task: dict[str, Any],
    uploaded_sources: dict[str, list[dict[str, Any]]],
    source_decisions: dict[str, dict[str, Any]],
) -> None:
    task_sources = list(uploaded_sources.get(task.get("task_id") or "", []))
    task_sources.extend(uploaded_sources.get(f"trial:{task.get('trial_id')}", []))
    deduped: list[dict[str, Any]] = []
    seen = set()
    for source in task_sources:
        key = source.get("local_path") or source.get("sha256") or source.get("filename")
        if key in seen:
            continue
        seen.add(key)
        deduped.append(_review_source_for_task(task, source, source_decisions))
    if not deduped:
        return
    task["uploaded_sources"] = deduped
    accepted = _accepted_candidate_count_for_sources(deduped)
    task["accepted_source_candidates"] = accepted
    task["status"] = "source_candidate_accepted_needs_override" if accepted else "source_uploaded_needs_review"


def _load_parsed_source(project: Project, parsed_path: str) -> dict[str, Any]:
    if not parsed_path:
        return {}
    try:
        root = project.base_dir.resolve()
        path = (project.base_dir / parsed_path).resolve()
        if path != root and root not in path.parents:
            return {}
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(parsed, dict):
        return {}
    text = str(parsed.get("full_text") or "")
    tables = parsed.get("tables") or []
    table_text = _tables_to_text(tables)
    if table_text:
        text = f"{text}\n\n{table_text}" if text else table_text
    return {
        "text": text,
        "page_map": parsed.get("page_map") if isinstance(parsed.get("page_map"), list) else [],
    }


def _tables_to_text(tables: Any) -> str:
    if not isinstance(tables, list):
        return ""
    chunks: list[str] = []
    for table in tables:
        if isinstance(table, str):
            text = table.strip()
        else:
            text = json.dumps(table, ensure_ascii=False, default=str)
        if text:
            chunks.append(text)
    return "\n\n".join(chunks)


def _review_source_for_task(
    task: dict[str, Any],
    source: dict[str, Any],
    source_decisions: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    public_source = {key: value for key, value in source.items() if not key.startswith("_")}
    candidates = _quote_candidates_for_task(task, source)
    if candidates:
        for candidate in candidates:
            candidate_id = benchmark_candidate_id(
                task_id=str(task.get("task_id") or ""),
                source=public_source,
                candidate=candidate,
            )
            candidate["candidate_id"] = candidate_id
            decision = source_decisions.get(candidate_id) or _matching_source_decision(
                task,
                public_source,
                candidate,
                source_decisions,
            )
            if decision:
                candidate["review_decision"] = _public_source_decision(decision)
        public_source["quote_candidates"] = candidates
    return public_source


def _matching_source_decision(
    task: dict[str, Any],
    source: dict[str, Any],
    candidate: dict[str, Any],
    source_decisions: dict[str, dict[str, Any]],
) -> dict[str, Any] | None:
    """Find a prior decision when quote context changed but values did not."""
    task_id = str(task.get("task_id") or "")
    source_sha = str(source.get("sha256") or "")
    candidate_type = str(candidate.get("candidate_type") or "")
    matched_values = [str(item) for item in candidate.get("matched_values") or []]
    for decision in source_decisions.values():
        if str(decision.get("task_id") or "") != task_id:
            continue
        if source_sha and str(decision.get("source_sha256") or "") != source_sha:
            continue
        if str(decision.get("candidate_type") or "") != candidate_type:
            continue
        if [str(item) for item in decision.get("matched_values") or []] != matched_values:
            continue
        return decision
    return None


def _public_source_decision(decision: dict[str, Any]) -> dict[str, Any]:
    return {
        "candidate_id": decision.get("candidate_id") or "",
        "decision": decision.get("decision") or "",
        "reason": decision.get("reason") or "",
        "updated_by": decision.get("updated_by") or "",
        "updated_at": decision.get("updated_at") or "",
        "revision": decision.get("revision") or 0,
    }


def _accepted_candidate_count_for_sources(sources: list[dict[str, Any]]) -> int:
    count = 0
    for source in sources:
        for candidate in source.get("quote_candidates") or []:
            decision = candidate.get("review_decision") or {}
            if decision.get("decision") == "accepted":
                count += 1
    return count


def _source_candidate_decision_counts(tasks: list[dict[str, Any]]) -> dict[str, int]:
    accepted = 0
    rejected = 0
    for task in tasks:
        for source in task.get("uploaded_sources") or []:
            for candidate in source.get("quote_candidates") or []:
                decision = (candidate.get("review_decision") or {}).get("decision")
                if decision == "accepted":
                    accepted += 1
                elif decision == "rejected":
                    rejected += 1
    return {
        "accepted_source_candidates": accepted,
        "rejected_source_candidates": rejected,
    }


def _quote_candidates_for_task(task: dict[str, Any], source: dict[str, Any]) -> list[dict[str, Any]]:
    text = str(source.get("_parsed_text") or "")
    if not text:
        return []
    if task.get("expected_counts"):
        candidate = _primary_count_quote_candidate(task, source, text)
        return [candidate] if candidate else []
    if task.get("task_type") == "timepoint_adjudication_source":
        candidate = _timepoint_quote_candidate(task, source, text)
        return [candidate] if candidate else []
    return []


def _primary_count_quote_candidate(
    task: dict[str, Any],
    source: dict[str, Any],
    text: str,
) -> dict[str, Any] | None:
    counts = task.get("expected_counts") or {}
    count_keys = (
        "events_intervention",
        "total_intervention",
        "events_control",
        "total_control",
    )
    values: list[str] = []
    for key in count_keys:
        if counts.get(key) is None:
            return None
        value = str(counts.get(key))
        if value not in values:
            values.append(value)

    snippet = _snippet_containing_values(text, values)
    if not snippet:
        return None
    page = _page_for_first_value(text, values[0], source.get("_parsed_page_map") or [])
    candidate = {
        "candidate_type": "primary_counts",
        "matched_values": values,
        "matched_fields": list(count_keys),
        "quote": snippet,
        "source_location": "uploaded benchmark source",
        "suggested_override": {
            "type": "extraction_override",
            "trial_id": task.get("trial_id") or "",
            "task_id": task.get("task_id") or "",
            "values": {
                "events_intervention": counts.get("events_intervention"),
                "total_intervention": counts.get("total_intervention"),
                "events_control": counts.get("events_control"),
                "total_control": counts.get("total_control"),
                "source_quote": snippet,
                "source_location": "uploaded benchmark source",
            },
        },
    }
    if page is not None:
        candidate["source_page"] = page
    return candidate


def _timepoint_quote_candidate(
    task: dict[str, Any],
    source: dict[str, Any],
    text: str,
) -> dict[str, Any] | None:
    values = _dedupe_hints([
        task.get("expected_primary_timepoint"),
        *(task.get("accepted_timepoints") or []),
    ])
    for value in values:
        snippet = _snippet_containing_phrase(text, value)
        if not snippet:
            continue
        page = _page_for_phrase(text, value, source.get("_parsed_page_map") or [])
        candidate = {
            "candidate_type": "timepoint_adjudication",
            "matched_values": [value],
            "quote": snippet,
            "source_location": "uploaded benchmark source",
            "suggested_override": {
                "type": "extraction_override",
                "trial_id": task.get("trial_id") or "",
                "task_id": task.get("task_id") or "",
                "row_id": task.get("row_id") or "",
                "values": {
                    "accepted_timepoint": value,
                    "timepoint_adjudication_note": "Supported by uploaded benchmark source quote.",
                    "source_quote": snippet,
                    "source_location": "uploaded benchmark source",
                },
            },
        }
        if page is not None:
            candidate["source_page"] = page
        return candidate
    return None


def _snippet_containing_values(
    text: str,
    values: list[str],
    *,
    context: int = 240,
    max_value_span: int = 360,
) -> str:
    if not values:
        return ""
    occurrences: list[tuple[int, int, int]] = []
    for value_index, value in enumerate(values):
        value_matches = list(re.finditer(rf"(?<!\d){re.escape(value)}(?!\d)", text))
        if not value_matches:
            return ""
        for match in value_matches:
            occurrences.append((match.start(), match.end(), value_index))
    occurrences.sort(key=lambda item: item[0])

    best_span: tuple[int, int] | None = None
    covered: dict[int, int] = {}
    left = 0
    for right, occurrence in enumerate(occurrences):
        covered[occurrence[2]] = covered.get(occurrence[2], 0) + 1
        while len(covered) == len(values) and left <= right:
            start = occurrences[left][0]
            end = max(item[1] for item in occurrences[left:right + 1])
            if best_span is None or (end - start) < (best_span[1] - best_span[0]):
                best_span = (start, end)
            left_value_index = occurrences[left][2]
            covered[left_value_index] -= 1
            if covered[left_value_index] <= 0:
                del covered[left_value_index]
            left += 1

    if best_span is None:
        return ""
    if best_span[1] - best_span[0] > max_value_span:
        return ""
    tight = _sentence_quote_around_span(text, best_span[0], best_span[1])
    if tight:
        return tight
    start = max(0, best_span[0] - context)
    end = min(len(text), best_span[1] + context)
    return _compact_quote(text[start:end])


def _sentence_quote_around_span(text: str, span_start: int, span_end: int) -> str:
    """Prefer the sentence/table row containing the matched values when available."""
    left_candidates = [
        text.rfind(delimiter, 0, span_start)
        for delimiter in (".", "\n", "\r")
    ]
    left = max(left_candidates)
    start = left + 1 if left >= 0 else 0

    right_candidates = [
        position
        for delimiter in (".", "\n", "\r")
        for position in [text.find(delimiter, span_end)]
        if position >= 0
    ]
    end = min(right_candidates) + 1 if right_candidates else len(text)
    if end <= start:
        return ""
    quote = _compact_quote(text[start:end])
    # Avoid returning an accidental huge paragraph; the context fallback is more
    # readable for table-heavy sources without sentence boundaries.
    if len(quote) > 520:
        return ""
    return quote


def _snippet_containing_phrase(text: str, phrase: str, *, context: int = 240) -> str:
    phrase = str(phrase or "").strip()
    if not phrase:
        return ""
    match = re.search(re.escape(phrase), text, flags=re.IGNORECASE)
    if not match:
        return ""
    start = max(0, match.start() - context)
    end = min(len(text), match.end() + context)
    return _compact_quote(text[start:end])


def _compact_quote(text: str) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip()


def _page_for_first_value(text: str, value: str, page_map: list[Any]) -> int | None:
    match = re.search(rf"(?<!\d){re.escape(str(value))}(?!\d)", text)
    if not match:
        return None
    return _page_for_char_index(match.start(), page_map)


def _page_for_phrase(text: str, phrase: str, page_map: list[Any]) -> int | None:
    match = re.search(re.escape(str(phrase or "")), text, flags=re.IGNORECASE)
    if not match:
        return None
    return _page_for_char_index(match.start(), page_map)


def _page_for_char_index(index: int, page_map: list[Any]) -> int | None:
    for item in page_map:
        if not isinstance(item, dict):
            continue
        try:
            start = int(item.get("start_char", 0))
            end = int(item.get("end_char", -1))
        except (TypeError, ValueError):
            continue
        if start <= index <= end:
            try:
                return int(item.get("page_number"))
            except (TypeError, ValueError):
                return None
    return None


def _full_text_upload_task(
    item: dict[str, Any],
    project_dir: str,
    expected_counts: dict[str, int] | None,
) -> dict[str, Any]:
    trial_id = str(item.get("trial_id") or "")
    task = {
        "task_id": f"full_text:{trial_id}",
        "task_type": "full_text_upload",
        "status": "missing_primary_full_text",
        "priority": "high",
        "trial_id": trial_id,
        "trial_name": item.get("trial_name") or trial_id,
        "registration_id": item.get("registration_id") or "",
        "publication_pmids": item.get("publication_pmids") or [],
        "publication_dois": item.get("publication_dois") or [],
        "aliases": item.get("aliases") or [],
        "message": "Upload the primary publication PDF/HTML or supplement so extraction can verify the benchmark row from source text.",
        "accepted_file_hints": _trial_hints(item),
        "suggested_upload": {
            "type": "fulltext_upload",
            "project_dir": project_dir,
            "trial_id": trial_id,
            "publication_pmids": item.get("publication_pmids") or [],
            "publication_dois": item.get("publication_dois") or [],
            "title_hints": _dedupe_hints([item.get("trial_name"), *(item.get("aliases") or [])]),
        },
    }
    if expected_counts:
        task["expected_counts"] = expected_counts
    return task


def _primary_source_request_task(
    item: dict[str, Any],
    project_dir: str,
    expected_counts: dict[str, int] | None,
) -> dict[str, Any]:
    trial_id = str(item.get("trial_id") or "")
    task = {
        "task_id": f"primary_source:{trial_id}",
        "task_type": "primary_source_request",
        "status": "missing_primary_publication_or_results",
        "priority": "high",
        "trial_id": trial_id,
        "trial_name": item.get("trial_name") or trial_id,
        "registration_id": item.get("registration_id") or "",
        "aliases": item.get("aliases") or [],
        "message": "Find the primary paper, supplement, trial registry result page, or meta-analysis appendix source for this benchmark trial.",
        "accepted_file_hints": _trial_hints(item),
        "suggested_upload": {
            "type": "benchmark_source_upload",
            "project_dir": project_dir,
            "trial_id": trial_id,
            "source_kinds": ["primary_publication", "supplement", "registry_results", "benchmark_appendix"],
            "title_hints": _dedupe_hints([item.get("trial_name"), *(item.get("aliases") or [])]),
        },
    }
    if expected_counts:
        task["expected_counts"] = expected_counts
    return task


def _primary_count_source_task(item: dict[str, Any], project_dir: str) -> dict[str, Any]:
    trial_id = str(item.get("trial_id") or "")
    return {
        "task_id": f"primary_counts:{trial_id}",
        "task_type": "primary_count_source",
        "status": "missing_primary_counts",
        "priority": "high",
        "trial_id": trial_id,
        "trial_name": item.get("trial_name") or trial_id,
        "registration_id": item.get("registration_id") or "",
        "message": "Find the source table or supplement row containing all four arm-level primary outcome counts.",
        "expected_counts": _expected_counts(item) or {},
        "accepted_file_hints": _trial_hints(item),
        "suggested_upload": {
            "type": "benchmark_source_upload",
            "project_dir": project_dir,
            "trial_id": trial_id,
            "source_kinds": ["results_table", "supplement", "registry_results", "benchmark_appendix"],
        },
    }


def _primary_count_discrepancy_task(trial_id: str, item: dict[str, Any], project_dir: str) -> dict[str, Any]:
    expected_counts = _expected_counts(item) or {}
    observed_counts = {
        "events_intervention": item.get("events_intervention"),
        "total_intervention": item.get("total_intervention"),
        "events_control": item.get("events_control"),
        "total_control": item.get("total_control"),
    }
    task = {
        "task_id": f"primary_count_discrepancy:{trial_id}",
        "task_type": "primary_count_discrepancy",
        "status": "primary_counts_disagree_with_benchmark",
        "priority": "high",
        "trial_id": trial_id,
        "trial_name": item.get("trial_name") or item.get("title") or trial_id,
        "row_id": item.get("row_id") or "",
        "study_id": item.get("study_id") or "",
        "pmid": item.get("pmid") or "",
        "doi": item.get("doi") or "",
        "title": item.get("title") or "",
        "message": "Find the source row that resolves the arm-level count discrepancy for this already matched primary-effect row.",
        "expected_counts": expected_counts,
        "observed_counts": observed_counts,
        "count_mismatches": item.get("count_mismatches") or {},
        "accepted_file_hints": _dedupe_hints([
            item.get("pmid"),
            item.get("doi"),
            item.get("title"),
            item.get("trial_name"),
            trial_id,
        ]),
        "suggested_override": {
            "type": "extraction_override",
            "project_dir": project_dir,
            "row_id": item.get("row_id") or "",
            "fields": [
                "events_intervention",
                "total_intervention",
                "events_control",
                "total_control",
            ],
        },
    }
    return task


def _trial_hints(item: dict[str, Any]) -> list[str]:
    return _dedupe_hints([
        *(item.get("publication_pmids") or []),
        *(item.get("publication_dois") or []),
        item.get("registration_id"),
        item.get("trial_name"),
        *(item.get("aliases") or []),
    ])


def _expected_counts(item: dict[str, Any]) -> dict[str, int] | None:
    if not item:
        return None
    keys = (
        ("expected_events_intervention", "events_intervention"),
        ("expected_total_intervention", "total_intervention"),
        ("expected_events_control", "events_control"),
        ("expected_total_control", "total_control"),
    )
    counts: dict[str, int] = {}
    for source_key, output_key in keys:
        value = item.get(source_key)
        if value is None:
            return None
        try:
            counts[output_key] = int(value)
        except (TypeError, ValueError):
            return None
    return counts


def _dedupe_hints(items: list[Any]) -> list[str]:
    hints: list[str] = []
    seen = set()
    for item in items:
        text = str(item or "").strip()
        if not text or text in seen:
            continue
        hints.append(text)
        seen.add(text)
    return hints
