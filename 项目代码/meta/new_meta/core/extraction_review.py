"""Extraction review helpers: audit payloads and user overrides."""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import json
from pathlib import Path
import re
from typing import Any

from pydantic import BaseModel, Field

from new_meta.core.known_source_recovery import DEFAULT_KNOWN_SOURCE_PATH
from new_meta.core.project import Project
from new_meta.schemas.study import ExtractedStudy, OutcomeData


class OverrideConflictError(RuntimeError):
    """Raised when an override write is based on a stale revision."""


class ExtractionOverride(BaseModel):
    """A single user correction to an extracted outcome field."""
    study_id: str
    outcome_index: int | None = None
    outcome_name: str = ""
    field: str
    value: Any = None
    reason: str = ""
    updated_by: str = "unknown"
    updated_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    revision: int = 0


class ExtractionOverridesFile(BaseModel):
    schema_version: int = 1
    current_revision: int = 0
    overrides: list[ExtractionOverride] = []


class ExtractionReviewDecision(BaseModel):
    """A user decision that resolves one extraction review row without changing values."""
    row_id: str = ""
    study_id: str = ""
    outcome_index: int | None = None
    outcome_name: str = ""
    decision: str = "accepted"
    note: str = ""
    resolves_review: bool = True
    resolves_conflicts: bool = True
    updated_by: str = "unknown"
    updated_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    revision: int = 0


class ExtractionReviewDecisionsFile(BaseModel):
    schema_version: int = 1
    current_revision: int = 0
    decisions: list[ExtractionReviewDecision] = []


def _study_id(study: ExtractedStudy) -> str:
    c = study.characteristics
    return c.pmid or c.study_id


def _norm(text: str) -> str:
    return " ".join((text or "").strip().lower().split())


def load_extraction_overrides(project: Project) -> ExtractionOverridesFile:
    data = project.load_json("extraction_overrides.json", subdir="extraction")
    if not data:
        return ExtractionOverridesFile()
    return ExtractionOverridesFile.model_validate(data)


def load_extraction_review_decisions(project: Project) -> ExtractionReviewDecisionsFile:
    data = project.load_json("extraction_review_decisions.json", subdir="extraction")
    if not data:
        return ExtractionReviewDecisionsFile()
    return ExtractionReviewDecisionsFile.model_validate(data)


def save_extraction_override(
    project: Project,
    override: ExtractionOverride,
    expected_revision: int | None = None,
) -> ExtractionOverridesFile:
    """Append or replace an override using ETag/If-Match style revision checks."""
    manifest = load_extraction_overrides(project)
    if expected_revision is not None and expected_revision != manifest.current_revision:
        raise OverrideConflictError(
            f"stale override revision: expected {expected_revision}, current {manifest.current_revision}"
        )

    next_revision = manifest.current_revision + 1
    override.revision = next_revision
    override.updated_at = datetime.now(timezone.utc).isoformat()

    replaced = False
    for idx, existing in enumerate(manifest.overrides):
        same_target = (
            existing.study_id == override.study_id
            and existing.outcome_index == override.outcome_index
            and _norm(existing.outcome_name) == _norm(override.outcome_name)
            and existing.field == override.field
        )
        if same_target:
            manifest.overrides[idx] = override
            replaced = True
            break
    if not replaced:
        manifest.overrides.append(override)

    manifest.current_revision = next_revision
    project.save_json("extraction_overrides.json", manifest, subdir="extraction")
    return manifest


def _decision_key(decision: ExtractionReviewDecision) -> str:
    if decision.row_id:
        return decision.row_id
    if decision.study_id and decision.outcome_index is not None:
        return f"{decision.study_id}:{decision.outcome_index}"
    return ""


def save_extraction_review_decision(
    project: Project,
    decision: ExtractionReviewDecision,
    expected_revision: int | None = None,
) -> ExtractionReviewDecisionsFile:
    """Append or replace a user review decision using revision checks."""
    manifest = load_extraction_review_decisions(project)
    if expected_revision is not None and expected_revision != manifest.current_revision:
        raise OverrideConflictError(
            f"stale extraction-review revision: expected {expected_revision}, current {manifest.current_revision}"
        )

    key = _decision_key(decision)
    if not key:
        raise ValueError("Extraction review decision requires row_id or study_id + outcome_index")
    if not decision.row_id:
        decision.row_id = key

    next_revision = manifest.current_revision + 1
    decision.revision = next_revision
    decision.updated_at = datetime.now(timezone.utc).isoformat()

    replaced = False
    for idx, existing in enumerate(manifest.decisions):
        if _decision_key(existing) == key:
            manifest.decisions[idx] = decision
            replaced = True
            break
    if not replaced:
        manifest.decisions.append(decision)

    manifest.current_revision = next_revision
    project.save_json("extraction_review_decisions.json", manifest, subdir="extraction")
    return manifest


def _accepted_review_decisions(decisions: ExtractionReviewDecisionsFile) -> dict[str, ExtractionReviewDecision]:
    accepted = {}
    for decision in decisions.decisions:
        key = _decision_key(decision)
        if not key:
            continue
        if decision.decision.strip().lower() in {"accepted", "approved", "resolved", "verified"}:
            accepted[key] = decision
    return accepted


def apply_extraction_review_decisions_to_audit(
    audit: dict,
    decisions: ExtractionReviewDecisionsFile | None,
) -> dict:
    """Return an audit copy with accepted review decisions reflected in unresolved counts."""
    if not isinstance(audit, dict) or not decisions or not decisions.decisions:
        return audit
    accepted = _accepted_review_decisions(decisions)
    if not accepted:
        return audit

    resolved = deepcopy(audit)
    rows = resolved.get("rows") or []
    if not isinstance(rows, list):
        return resolved

    accepted_count = 0
    for row in rows:
        if not isinstance(row, dict):
            continue
        row_id = str(row.get("row_id") or "")
        decision = accepted.get(row_id)
        if not decision:
            continue
        accepted_count += 1
        row["review_decision"] = decision.model_dump()
        if decision.resolves_review:
            row["requires_review"] = False
        if decision.resolves_conflicts and row.get("conflicts"):
            row["resolved_conflicts"] = row.get("conflicts") or []
            row["conflicts"] = []

    summary = dict(resolved.get("summary") or {})
    summary["rows_requiring_review"] = sum(
        1 for row in rows if isinstance(row, dict) and row.get("requires_review")
    )
    summary["conflict_rows"] = sum(
        1 for row in rows if isinstance(row, dict) and row.get("conflicts")
    )
    summary["review_decisions_accepted"] = accepted_count
    summary["review_decisions_revision"] = decisions.current_revision
    resolved["summary"] = summary
    return resolved


def _override_matches(outcome: OutcomeData, outcome_index: int, override: ExtractionOverride) -> bool:
    if override.outcome_index is not None:
        return override.outcome_index == outcome_index
    if override.outcome_name:
        return _norm(override.outcome_name) == _norm(outcome.outcome_name)
    return False


def apply_extraction_overrides(
    studies: list[ExtractedStudy],
    overrides: ExtractionOverridesFile,
) -> int:
    """Apply saved user overrides to extracted studies in-place.

    Returns the number of field edits applied.
    """
    if not overrides.overrides:
        return 0

    applied = 0
    for study in studies:
        sid = _study_id(study)
        if not sid:
            continue
        relevant = [item for item in overrides.overrides if item.study_id == sid]
        if not relevant:
            continue

        for outcome_index, outcome in enumerate(study.outcomes):
            for override in relevant:
                if not _override_matches(outcome, outcome_index, override):
                    continue
                if override.field not in OutcomeData.model_fields:
                    continue

                data = outcome.model_dump()
                data[override.field] = override.value
                data["user_override_applied"] = True
                data["override_revision"] = override.revision
                study.outcomes[outcome_index] = OutcomeData.model_validate(data)
                applied += 1
    return applied


EXTRACTION_VALUE_FIELDS = [
    "events_intervention", "total_intervention", "events_control", "total_control",
    "mean_intervention", "sd_intervention", "n_intervention",
    "mean_control", "sd_control", "n_control",
    "median_intervention", "q1_intervention", "q3_intervention",
    "median_control", "q1_control", "q3_control",
    "effect_size", "ci_lower", "ci_upper", "p_value",
    "hazard_ratio", "hr_ci_lower", "hr_ci_upper", "hr_se",
    "events", "total_n", "correlation_r", "correlation_n",
    "pyears_intervention", "pyears_control",
    "timepoint", "accepted_timepoint", "timepoint_adjudication_note",
    "source_location", "source_page", "source_section", "source_quote",
    "extraction_confidence",
]


def has_count_conflict(row: dict) -> bool:
    """Return true when an audit row needs explicit arm-count verification."""
    conflicts = row.get("conflicts") or []
    if not isinstance(conflicts, list):
        return False
    for conflict in conflicts:
        sources = conflict.get("sources") or []
        message = str(conflict.get("message") or "")
        if "schema_count_validation" in sources or "Count fields require explicit whole-number counts" in message:
            return True
    return False


def load_extraction_outcome_rows(project: Project) -> dict[str, dict]:
    """Index persisted extraction outcomes by the audit row id convention."""
    studies = project.load_json("all_extractions.json", subdir="extraction") or []
    if not isinstance(studies, list):
        return {}
    rows: dict[str, dict] = {}
    for study in studies:
        if not isinstance(study, dict):
            continue
        characteristics = study.get("characteristics") or {}
        study_id = (
            characteristics.get("pmid")
            or characteristics.get("study_id")
            or characteristics.get("doi")
            or ""
        )
        for idx, outcome in enumerate(study.get("outcomes") or []):
            if not study_id or not isinstance(outcome, dict):
                continue
            rows[f"{study_id}:{idx}"] = {
                "study": characteristics,
                "outcome": outcome,
            }
    return rows


def _row_from_outcome_entry(row_id: str, outcome_entry: dict) -> dict:
    study = outcome_entry.get("study") or {}
    outcome = outcome_entry.get("outcome") or {}
    study_id, _, index_text = row_id.rpartition(":")
    try:
        outcome_index = int(index_text)
    except (TypeError, ValueError):
        outcome_index = None
    conflicts = outcome.get("conflicts") or []
    quote_verified = outcome.get("source_quote_verified")
    confidence = outcome.get("extraction_confidence")
    return {
        "row_id": row_id,
        "study_id": study.get("pmid") or study.get("study_id") or study.get("doi") or study_id,
        "outcome_index": outcome_index,
        "study_label": study.get("title") or study.get("study_id") or study.get("pmid") or study_id,
        "title": study.get("title"),
        "source_type": study.get("source_type"),
        "pdf_path": study.get("pdf_path"),
        "outcome_name": outcome.get("outcome_name") or "",
        "outcome_type": outcome.get("outcome_type") or "",
        "timepoint": outcome.get("timepoint"),
        "accepted_timepoint": outcome.get("accepted_timepoint"),
        "source_location": outcome.get("source_location"),
        "source_page": outcome.get("source_page"),
        "source_section": outcome.get("source_section"),
        "source_quote": outcome.get("source_quote"),
        "source_quote_match": outcome.get("source_quote_match"),
        "source_quote_verified": quote_verified,
        "extraction_confidence": confidence,
        "requires_review": bool(conflicts or quote_verified is False or str(confidence or "").lower() == "low"),
        "conflicts": conflicts,
        "user_override_applied": outcome.get("user_override_applied"),
        "override_revision": outcome.get("override_revision"),
    }


def _outcome_entry_has_source_card_material(outcome_entry: dict) -> bool:
    outcome = outcome_entry.get("outcome") or {}
    if any(outcome.get(field) not in (None, "", []) for field in (
        "source_quote", "source_quote_match", "source_location", "source_page", "source_section",
        "events_intervention", "total_intervention", "events_control", "total_control",
        "hazard_ratio", "effect_size", "ci_lower", "ci_upper",
    )):
        return True
    return bool(outcome.get("conflicts"))


def build_extraction_value_fields(row: dict, outcome_entry: dict | None) -> list[dict]:
    """Build per-field values for frontend review cards and artifact exports."""
    outcome = (outcome_entry or {}).get("outcome") or {}
    conflicts = row.get("conflicts") or []
    conflict_by_field: dict[str, list[dict]] = {}
    if isinstance(conflicts, list):
        for conflict in conflicts:
            field = str(conflict.get("field") or "")
            if field:
                conflict_by_field.setdefault(field, []).append(conflict)

    quote_verified = row.get("source_quote_verified")
    if quote_verified is None:
        quote_verified = outcome.get("source_quote_verified")
    confidence = row.get("extraction_confidence") or outcome.get("extraction_confidence")

    values = []
    for field in EXTRACTION_VALUE_FIELDS:
        value = outcome.get(field, row.get(field))
        if value is None or value == "":
            continue
        values.append({
            "field": field,
            "label": field.replace("_", " "),
            "value": value,
            "editable": True,
            "conflicts": conflict_by_field.get(field, []),
            "source_quote_verified": quote_verified,
            "extraction_confidence": confidence,
            "suggested_override": {
                "study_id": row.get("study_id"),
                "outcome_index": row.get("outcome_index"),
                "outcome_name": row.get("outcome_name"),
                "field": field,
                "value": value,
            },
        })
    return values


def _build_source_anchor(
    *,
    study: dict,
    row: dict,
    outcome: dict,
    quote_verified: bool | None,
) -> dict:
    pdf_path = study.get("pdf_path") or row.get("pdf_path") or ""
    page = row.get("source_page") if row.get("source_page") is not None else outcome.get("source_page")
    section = row.get("source_section") or outcome.get("source_section")
    location = row.get("source_location") or outcome.get("source_location")
    quote = row.get("source_quote") or outcome.get("source_quote")
    quote_match = row.get("source_quote_match") or outcome.get("source_quote_match")
    highlight_text = quote_match or quote or ""
    if pdf_path and highlight_text:
        kind = "pdf_text_quote"
    elif pdf_path:
        kind = "pdf_location"
    elif highlight_text:
        kind = "text_quote"
    else:
        kind = "missing_source"
    return {
        "kind": kind,
        "pdf_path": pdf_path or None,
        "page": page,
        "section": section,
        "location": location,
        "quote": quote,
        "quote_match": quote_match,
        "highlight_text": highlight_text or None,
        "verified": quote_verified,
        "can_open_pdf": bool(pdf_path),
        "needs_manual_location": not bool(page or section or location or highlight_text),
    }


def _build_trust_summary(
    *,
    quote_verified: bool | None,
    confidence: str | None,
    requires_review: bool,
    conflicts: list,
    review_reasons: list[str],
) -> dict:
    has_conflicts = bool(conflicts)
    if requires_review or has_conflicts or quote_verified is False or str(confidence or "").lower() == "low":
        status = "needs_review"
    elif quote_verified is True and str(confidence or "").lower() == "high":
        status = "verified"
    else:
        status = "check"
    return {
        "status": status,
        "quote_verified": quote_verified,
        "confidence": confidence,
        "requires_review": requires_review,
        "has_conflicts": has_conflicts,
        "review_reasons": review_reasons,
    }


def _normalize_with_offsets(text: str) -> tuple[str, list[int]]:
    normalized: list[str] = []
    offsets: list[int] = []
    previous_space = False
    for idx, char in enumerate(text):
        if char.isspace():
            if normalized and not previous_space:
                normalized.append(" ")
                offsets.append(idx)
            previous_space = True
            continue
        normalized.append(char.lower())
        offsets.append(idx)
        previous_space = False
    return "".join(normalized).strip(), offsets


def _find_text_span(full_text: str, needle: str) -> tuple[int, int, str] | None:
    if not full_text or not needle:
        return None
    direct = full_text.find(needle)
    if direct >= 0:
        return direct, direct + len(needle), full_text[direct: direct + len(needle)]

    normalized_text, text_offsets = _normalize_with_offsets(full_text)
    normalized_needle, _ = _normalize_with_offsets(needle)
    if not normalized_text or not normalized_needle:
        return None
    normalized_start = normalized_text.find(normalized_needle)
    if normalized_start < 0:
        return None
    normalized_end = normalized_start + len(normalized_needle) - 1
    if normalized_start >= len(text_offsets) or normalized_end >= len(text_offsets):
        return None
    start = text_offsets[normalized_start]
    end = text_offsets[normalized_end] + 1
    return start, end, full_text[start:end]


def _page_for_span(page_map: Any, start: int) -> int | None:
    if not isinstance(page_map, list):
        return None
    for item in page_map:
        if not isinstance(item, dict):
            continue
        try:
            item_start = int(item.get("start_char", 0))
            item_end = int(item.get("end_char", 0))
        except (TypeError, ValueError):
            continue
        if item_start <= start <= item_end:
            page = item.get("page_number")
            try:
                return int(page)
            except (TypeError, ValueError):
                return None
    return None


_NUMERIC_CONTEXT_FIELDS = {
    "events_intervention", "total_intervention", "events_control", "total_control",
    "mean_intervention", "sd_intervention", "n_intervention",
    "mean_control", "sd_control", "n_control",
    "effect_size", "ci_lower", "ci_upper", "p_value",
    "hazard_ratio", "hr_ci_lower", "hr_ci_upper", "hr_se",
    "events", "total_n", "correlation_r", "correlation_n",
    "pyears_intervention", "pyears_control",
}
_NUMERIC_PRIORITY_FIELDS = {
    "effect_size", "ci_lower", "ci_upper", "hazard_ratio", "hr_ci_lower", "hr_ci_upper", "hr_se",
}
_SOURCE_CONTEXT_STOPWORDS = {
    "with", "from", "into", "over", "under", "among", "between", "alone", "change",
    "baseline", "score", "scores", "patients", "patient", "outcome", "outcomes",
    "intervention", "control", "placebo", "group", "groups", "trial", "study",
    "month", "months", "days", "weeks", "year", "years", "including",
}


def _number_terms_from_value(value: Any) -> list[str]:
    terms: list[str] = []
    for item in re.findall(r"(?<![A-Za-z])[-+]?\d+(?:\.\d+)?", str(value)):
        item = item.lstrip("+")
        if not item:
            continue
        try:
            number = float(item)
        except ValueError:
            continue
        if abs(number) < 1e-12:
            continue
        if number.is_integer():
            canonical = str(int(number))
            terms.append(canonical)
        else:
            terms.append(item.rstrip("0").rstrip("."))
    deduped: list[str] = []
    for term in terms:
        if term and term not in deduped:
            deduped.append(term)
    return deduped


def _numeric_terms_from_card(card: dict) -> tuple[list[str], list[str]]:
    terms: list[str] = []
    priority_terms: list[str] = []
    for value_field in card.get("values") or []:
        if not isinstance(value_field, dict):
            continue
        field = str(value_field.get("field") or "")
        if field not in _NUMERIC_CONTEXT_FIELDS:
            continue
        extracted = _number_terms_from_value(value_field.get("value"))
        for term in extracted:
            if term not in terms:
                terms.append(term)
            if field in _NUMERIC_PRIORITY_FIELDS and term not in priority_terms:
                priority_terms.append(term)
    return terms, priority_terms


def _context_terms_from_card(card: dict) -> set[str]:
    outcome = card.get("outcome") or {}
    source = card.get("source") or {}
    raw = " ".join([
        str(outcome.get("name") or ""),
        str(source.get("quote") or ""),
        str(source.get("quote_match") or ""),
    ]).lower()
    terms = {
        token
        for token in re.findall(r"[a-z][a-z\-]{3,}", raw)
        if token not in _SOURCE_CONTEXT_STOPWORDS and not token.isdigit()
    }
    for compound in list(terms):
        if "-" not in compound:
            continue
        terms.update(
            part for part in compound.split("-")
            if len(part) >= 4 and part not in _SOURCE_CONTEXT_STOPWORDS
        )
    if "mortality" in terms:
        terms.update({"death", "deaths", "died"})
    if "hospitalization" in terms or "hospitalisation" in terms:
        terms.update({"hospital", "hospitalization", "hospitalisation"})
    if "cardiomyopathy" in terms or "questionnaire" in terms or "kccq" in raw:
        terms.update({"kccq", "kansas", "cardiomyopathy", "questionnaire"})
    if "heart" in terms and "failure" in terms:
        terms.update({"heart", "failure"})
    return terms


def _number_present(text: str, term: str) -> bool:
    pattern = rf"(?<![\d.]){re.escape(term)}(?![\d.])"
    return re.search(pattern, text, flags=re.I) is not None


def _term_present(text_lower: str, term: str) -> bool:
    if len(term) <= 4:
        return re.search(rf"\b{re.escape(term)}\b", text_lower) is not None
    return term in text_lower


def _find_numeric_context_span(full_text: str, card: dict, *, window: int = 520) -> tuple[int, int, str] | None:
    """Find a conservative numeric-context window when exact quote matching fails."""
    numeric_terms, priority_terms = _numeric_terms_from_card(card)
    context_terms = _context_terms_from_card(card)
    if len(numeric_terms) < 2 or not context_terms:
        return None
    # A compiled effect can be calculated from verified arm counts and thus not
    # appear verbatim in the report.  Search both reported-effect and raw-count
    # terms; accept the latter only when several numbers and outcome context
    # co-occur in the same local source window.
    search_terms = numeric_terms
    candidates: list[tuple[int, int, int, int]] = []
    for term in search_terms:
        pattern = rf"(?<![\d.]){re.escape(term)}(?![\d.])"
        for match in re.finditer(pattern, full_text, flags=re.I):
            start = max(0, match.start() - window)
            end = min(len(full_text), match.end() + window)
            segment = full_text[start:end]
            segment_lower = segment.lower()
            numeric_hits = {item for item in numeric_terms if _number_present(segment, item)}
            priority_hits = {item for item in priority_terms if _number_present(segment, item)}
            context_hits = {item for item in context_terms if _term_present(segment_lower, item)}
            required_numeric_hits = 2 if priority_hits else min(3, len(numeric_terms))
            if len(numeric_hits) < required_numeric_hits:
                continue
            if priority_terms and not priority_hits and len(numeric_hits) < min(3, len(numeric_terms)):
                continue
            if not context_hits:
                continue
            score = len(priority_hits) * 4 + len(numeric_hits) * 2 + min(len(context_hits), 4)
            candidates.append((score, len(segment), start, end))
    if not candidates:
        return None
    _, _, start, end = max(candidates, key=lambda item: (item[0], -item[1]))
    return start, end, full_text[start:end].strip()


def _load_known_source_text(card: dict) -> tuple[str, Any, str, dict[str, Any]] | None:
    """Return bundled known-source text only when the card's quote is found there."""
    path = DEFAULT_KNOWN_SOURCE_PATH
    if not path.exists():
        return None
    try:
        sources = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(sources, list):
        return None

    source = card.get("source") or {}
    anchor = card.get("source_anchor") or {}
    needles = [
        str(source.get("quote_match") or ""),
        str(anchor.get("highlight_text") or ""),
        str(source.get("quote") or ""),
    ]
    needles = [needle for needle in needles if needle.strip()]
    if not needles:
        return None

    source_location = str(source.get("location") or anchor.get("location") or "").strip().lower()
    source_file = str(Path("new_meta") / "data" / "known_source_evidence.json")
    for item in sources:
        if not isinstance(item, dict):
            continue
        text = str(item.get("text") or "")
        if not text:
            continue
        label = str(item.get("source_label") or "").strip().lower()
        if source_location and label and source_location != label:
            continue
        if any(_find_text_span(text, needle) for needle in needles):
            source_kind = (
                "benchmark_meta_comparator"
                if _known_source_item_is_secondary_benchmark(item)
                else "known_source_evidence"
            )
            return text, None, source_file, {
                "source_kind": source_kind,
                "source_url": item.get("url"),
                "source_label": item.get("source_label"),
                "source_id": item.get("source_id"),
            }
    return None


def _known_source_item_is_secondary_benchmark(item: dict[str, Any]) -> bool:
    text = " ".join(
        str(item.get(key) or "")
        for key in ("source_id", "source_label", "metadata_source", "text", "url")
    ).lower()
    return bool(
        "who react" in text
        or "figure 2" in text
        or "who_react_figure2" in text
        or "meta-analysis" in text
    )


def _load_parsed_source_text(project: Project, card: dict) -> tuple[str, Any, str, dict[str, Any]] | None:
    papers = project.load_json("parsed_papers.json", subdir="papers") or {}
    if isinstance(papers, dict):
        study = card.get("study") or {}
        candidates = [
            card.get("study_id"),
            study.get("pmid"),
            study.get("doi"),
            str(study.get("doi") or "").lower(),
        ]
        candidates.extend(
            str(value).split(":", 1)[-1]
            for value in list(candidates)
            if value and ":" in str(value)
        )
        for key in candidates:
            if not key:
                continue
            entry = papers.get(str(key))
            if isinstance(entry, dict) and entry.get("full_text"):
                return str(entry.get("full_text") or ""), entry.get("page_map"), "papers/parsed_papers.json", {}

    study_id = str(card.get("study_id") or "").split(":", 1)[-1]
    if study_id:
        papers_dir = project.base_dir / "papers"
        for suffix in (".fulltext.txt", ".clinicaltrials.txt", ".seed.txt"):
            path = papers_dir / f"{study_id}{suffix}"
            if path.exists() and path.is_file():
                return path.read_text(encoding="utf-8", errors="replace"), None, str(Path("papers") / path.name), {}
    return _load_known_source_text(card)


def build_source_context(project: Project, card: dict, *, window: int = 360) -> dict:
    """Build a quote-centered source excerpt for user trust review."""
    source = card.get("source") or {}
    anchor = card.get("source_anchor") or {}
    needle = (
        source.get("quote_match")
        or anchor.get("highlight_text")
        or source.get("quote")
        or ""
    )
    loaded = _load_parsed_source_text(project, card)
    if not loaded:
        return {
            "available": False,
            "match_strategy": "unavailable",
            "source_file": None,
            "source_url": None,
            "source_label": None,
            "page": source.get("page") or anchor.get("page"),
            "prefix": "",
            "match_text": needle,
            "suffix": "",
            "start_char": None,
            "end_char": None,
        }

    candidates = [loaded]
    known_source = _load_known_source_text(card)
    if known_source and known_source[2] != loaded[2]:
        candidates.append(known_source)

    unavailable_context: dict | None = None
    for full_text, page_map, source_file, source_meta in candidates:
        span = _find_text_span(full_text, str(needle))
        match_strategy = "known_source_quote" if source_meta.get("source_kind") == "known_source_evidence" else "quote"
        if not span:
            span = _find_numeric_context_span(full_text, card)
            match_strategy = "numeric_context" if span else "unavailable"
        if not span:
            unavailable_context = {
                "available": False,
                "match_strategy": match_strategy,
                "source_file": source_file,
                "source_url": source_meta.get("source_url"),
                "source_label": source_meta.get("source_label"),
                "page": source.get("page") or anchor.get("page"),
                "prefix": "",
                "match_text": needle,
                "suffix": "",
                "start_char": None,
                "end_char": None,
            }
            continue
        start, end, match_text = span
        if source_meta.get("source_kind") == "benchmark_meta_comparator":
            unavailable_context = {
                "available": False,
                "match_strategy": "secondary_meta_source_rejected",
                "source_file": source_file,
                "source_url": source_meta.get("source_url"),
                "source_label": source_meta.get("source_label"),
                "page": source.get("page") or anchor.get("page"),
                "prefix": "",
                "match_text": match_text or needle,
                "suffix": "",
                "start_char": None,
                "end_char": None,
            }
            continue

        prefix = full_text[max(0, start - window):start].strip()
        suffix = full_text[end:min(len(full_text), end + window)].strip()
        return {
            "available": True,
            "match_strategy": match_strategy,
            "source_file": source_file,
            "source_url": source_meta.get("source_url"),
            "source_label": source_meta.get("source_label"),
            "page": source.get("page") or anchor.get("page") or _page_for_span(page_map, start),
            "prefix": prefix,
            "match_text": match_text,
            "suffix": suffix,
            "start_char": start,
            "end_char": end,
        }

    return unavailable_context or {
        "available": False,
        "match_strategy": "unavailable",
        "source_file": None,
        "source_url": None,
        "source_label": None,
        "page": source.get("page") or anchor.get("page"),
        "prefix": "",
        "match_text": needle,
        "suffix": "",
        "start_char": None,
        "end_char": None,
    }


def summarize_source_context_cards(cards: list[dict]) -> dict:
    """Summarize quote-centered context coverage for WebSocket and package review UIs."""
    total = len(cards)
    available = sum(1 for card in cards if (card.get("source_context") or {}).get("available") is True)
    missing_cards = [
        _missing_source_context_summary(card)
        for card in cards
        if (card.get("source_context") or {}).get("available") is not True
    ]
    missing = len(missing_cards)
    return {
        "source_context_available_cards": available,
        "source_context_missing_cards": missing,
        "source_context_coverage": round(available / total, 4) if total else 1.0,
        "source_context_missing_review_cards": sum(1 for card in cards if (
            (card.get("source_context") or {}).get("available") is not True
            and bool(card.get("requires_review"))
        )),
        "missing_source_context_cards": missing_cards,
    }


def _missing_source_context_summary(card: dict) -> dict:
    study = card.get("study") or {}
    outcome = card.get("outcome") or {}
    source = card.get("source") or {}
    return {
        "row_id": card.get("row_id"),
        "study_id": card.get("study_id"),
        "study_label": study.get("title") or study.get("label") or "",
        "outcome_name": outcome.get("name") or "",
        "quote_verified": source.get("quote_verified"),
        "requires_review": bool(card.get("requires_review")),
        "missing_reason": "source_context_unavailable",
    }


def build_extraction_source_card(
    row: dict,
    outcome_entry: dict | None = None,
    *,
    current_revision: int = 0,
    review_revision: int = 0,
) -> dict:
    """Create the stable source-card contract for extraction trust review."""
    study = (outcome_entry or {}).get("study") or {}
    outcome = (outcome_entry or {}).get("outcome") or {}
    values = row.get("value_fields") or build_extraction_value_fields(row, outcome_entry)
    row_id = row.get("row_id")
    study_id = row.get("study_id")
    outcome_index = row.get("outcome_index")
    outcome_name = row.get("outcome_name") or outcome.get("outcome_name") or ""

    quote_verified = row.get("source_quote_verified")
    if quote_verified is None:
        quote_verified = outcome.get("source_quote_verified")

    conflicts = row.get("conflicts") or []
    confidence = row.get("extraction_confidence") or outcome.get("extraction_confidence")
    review_reasons = []
    if quote_verified is False:
        review_reasons.append("source_quote_unverified")
    if not (row.get("source_quote") or outcome.get("source_quote")):
        review_reasons.append("missing_source_quote")
    if str(row.get("extraction_confidence") or outcome.get("extraction_confidence") or "").lower() == "low":
        review_reasons.append("low_confidence")
    if conflicts:
        review_reasons.append("conflicts_present")
    if row.get("needs_user_count_verification") or has_count_conflict(row):
        review_reasons.append("count_conflict")
    source_anchor = _build_source_anchor(
        study=study,
        row=row,
        outcome=outcome,
        quote_verified=quote_verified,
    )
    requires_review = bool(row.get("requires_review"))
    trust = _build_trust_summary(
        quote_verified=quote_verified,
        confidence=confidence,
        requires_review=requires_review,
        conflicts=conflicts,
        review_reasons=review_reasons,
    )

    return {
        "row_id": row_id,
        "study_id": study_id,
        "outcome_index": outcome_index,
        "study": {
            "label": row.get("study_label"),
            "title": row.get("title") or study.get("title"),
            "pmid": study.get("pmid") or row.get("study_id"),
            "doi": study.get("doi"),
            "source_type": study.get("source_type") or row.get("source_type"),
            "pdf_path": study.get("pdf_path") or row.get("pdf_path"),
        },
        "outcome": {
            "name": outcome_name,
            "type": row.get("outcome_type") or outcome.get("outcome_type"),
            "timepoint": row.get("timepoint") or outcome.get("timepoint"),
            "accepted_timepoint": row.get("accepted_timepoint") or outcome.get("accepted_timepoint"),
        },
        "values": values,
        "source": {
            "location": row.get("source_location") or outcome.get("source_location"),
            "page": row.get("source_page") if row.get("source_page") is not None else outcome.get("source_page"),
            "section": row.get("source_section") or outcome.get("source_section"),
            "quote": row.get("source_quote") or outcome.get("source_quote"),
            "quote_match": row.get("source_quote_match") or outcome.get("source_quote_match"),
            "quote_verified": quote_verified,
        },
        "source_anchor": source_anchor,
        "confidence": confidence,
        "trust": trust,
        "conflicts": conflicts,
        "requires_review": requires_review,
        "review_reasons": review_reasons,
        "override": {
            "current_revision": current_revision,
            "user_override_applied": row.get("user_override_applied"),
            "override_revision": row.get("override_revision"),
            "save_message_type": "extraction_override",
            "rerun_message_type": "rerun_after_overrides",
        },
        "review_decision": row.get("review_decision"),
        "review_action": {
            "current_revision": review_revision,
            "save_message_type": "extraction_review_decision",
            "suggested_decision": {
                "row_id": row_id,
                "study_id": study_id,
                "outcome_index": outcome_index,
                "outcome_name": outcome_name,
                "decision": "accepted",
                "note": "Reviewer confirmed extracted values against the displayed source quote.",
                "resolves_review": True,
                "resolves_conflicts": True,
            },
        },
    }


def build_extraction_source_cards(project: Project, rows: list[dict] | None = None) -> list[dict]:
    """Build all extraction source cards for WebSocket and offline artifacts."""
    review_decisions = load_extraction_review_decisions(project)
    augment_from_persisted_extractions = rows is None
    if rows is None:
        audit = project.load_json("extraction_audit.json", subdir="extraction") or {}
        audit = apply_extraction_review_decisions_to_audit(
            audit,
            review_decisions,
        )
        rows = audit.get("rows") or []
    if not isinstance(rows, list):
        return []

    outcome_by_row = load_extraction_outcome_rows(project)
    current_revision = load_extraction_overrides(project).current_revision
    review_revision = review_decisions.current_revision

    source_rows: list[dict] = []
    existing_row_ids: set[str] = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        row_id = str(row.get("row_id") or "")
        if row_id and row_id in existing_row_ids:
            continue
        source_rows.append(row)
        if row_id:
            existing_row_ids.add(row_id)
    if augment_from_persisted_extractions:
        for row_id, outcome_entry in outcome_by_row.items():
            if row_id in existing_row_ids:
                continue
            if not _outcome_entry_has_source_card_material(outcome_entry):
                continue
            source_rows.append(_row_from_outcome_entry(row_id, outcome_entry))
            existing_row_ids.add(row_id)

    cards = []
    for row in source_rows:
        if not isinstance(row, dict):
            continue
        card = build_extraction_source_card(
            row,
            outcome_by_row.get(str(row.get("row_id") or "")),
            current_revision=current_revision,
            review_revision=review_revision,
        )
        card["source_context"] = build_source_context(project, card)
        cards.append(card)
    return cards


def summarize_selected_primary_source_context(cards: list[dict], selected_primary_rows: list[dict]) -> dict:
    """Summarize source-context coverage for rows actually used in the primary analysis."""
    selected_row_ids = [
        str(row.get("row_id") or "")
        for row in selected_primary_rows
        if isinstance(row, dict) and row.get("row_id")
    ]
    cards_by_row_id = {
        str(card.get("row_id") or ""): card
        for card in cards
        if isinstance(card, dict) and card.get("row_id")
    }
    selected_cards = [cards_by_row_id[row_id] for row_id in selected_row_ids if row_id in cards_by_row_id]
    missing_row_ids = [row_id for row_id in selected_row_ids if row_id not in cards_by_row_id]
    available = sum(
        1 for card in selected_cards
        if (card.get("source_context") or {}).get("available") is True
    )
    missing_cards = [
        _missing_source_context_summary(card)
        for card in selected_cards
        if (card.get("source_context") or {}).get("available") is not True
    ]
    for row_id in missing_row_ids:
        missing_cards.append({
            "row_id": row_id,
            "study_id": row_id.rsplit(":", 1)[0] if ":" in row_id else "",
            "study_label": "",
            "outcome_name": "",
            "quote_verified": None,
            "requires_review": True,
            "missing_reason": "selected_primary_source_card_missing",
        })
    total = len(selected_row_ids)
    missing = total - available
    return {
        "selected_primary_source_cards": len(selected_cards),
        "selected_primary_source_context_available_cards": available,
        "selected_primary_source_context_missing_cards": missing,
        "selected_primary_source_context_coverage": round(available / total, 4) if total else 1.0,
        "missing_selected_primary_source_context_cards": missing_cards,
    }
