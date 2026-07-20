"""Reconcile extracted RCT dependencies with the compiled method plan.

Protocol planning happens before full text is available, so an apparently
standard parallel-RCT review can later contain cluster, crossover, or eligible
multi-arm contrasts.  This module promotes those source-backed dependencies
into the typed extraction fields used by the complex-RCT engine.  It never
invents cluster ICCs, crossover correlations, or multi-arm covariance: the
only automatically derived covariance is the analytic shared-control
covariance from a source-verified 2x2 table.
"""
from __future__ import annotations

import math
import re
from typing import Any

from new_meta.core.evidence_gate import outcome_matches
from new_meta.engines import effect_size as effect_size_engine
from new_meta.schemas.protocol import ResearchProtocol
from new_meta.schemas.study import ExtractedStudy, OutcomeData


_RATIO_MEASURES = {"OR", "RR"}
_Z_975 = 1.959963984540054


def reconcile_extracted_rct_designs(
    protocol: ResearchProtocol,
    studies: list[ExtractedStudy],
    *,
    parsed_papers: dict[str, dict] | None = None,
) -> dict[str, Any]:
    """Annotate source-backed comparative dependencies and update RCT designs.

    The returned report is deterministic and suitable for persistence.  The
    protocol and study objects are mutated only when the review is an
    intervention RCT and the extracted fields justify the change.
    """
    if not _is_intervention_rct(protocol):
        return {
            "schema_version": 1,
            "status": "not_applicable",
            "changed": False,
            "detected_designs": [],
            "multi_arm_studies": [],
            "comparative_rows": 0,
            "reported_effects_recovered": 0,
        }

    parsed_lookup = _parsed_source_lookup(parsed_papers or {})
    recovered_effects = 0
    for study in studies:
        source_text = _source_text_for_study(study, parsed_lookup)
        if not source_text:
            continue
        for outcome in study.outcomes:
            if _matches_primary_outcome(outcome.outcome_name, protocol.pico.outcome_primary):
                recovered_effects += int(
                    _recover_protocol_effect_from_source(outcome, source_text, protocol)
                )

    detected_designs: set[str] = set()
    multi_arm_studies: list[str] = []
    comparative_rows = 0
    changed = recovered_effects > 0
    for study in studies:
        characteristics = study.characteristics
        study_id = str(
            characteristics.pmid
            or characteristics.doi
            or characteristics.study_id
            or characteristics.title
        ).strip()
        primary_rows = [
            (index, outcome)
            for index, outcome in enumerate(study.outcomes)
            if _is_source_backed_primary_contrast(outcome, protocol)
        ]
        if not primary_rows:
            continue

        eligible_rows = [
            (index, outcome)
            for index, outcome in primary_rows
            if _arm_matches_intervention(outcome.treatment_arm, protocol.pico.intervention)
            and _arm_matches_comparator(outcome.reference_arm, protocol.pico.comparator)
        ]
        if not eligible_rows:
            continue

        distinct_treatments = {
            _normalise_arm(outcome.treatment_arm)
            for _, outcome in eligible_rows
            if str(outcome.treatment_arm or "").strip()
        }
        distinct_comparators = {
            _normalise_arm(outcome.reference_arm)
            for _, outcome in eligible_rows
            if str(outcome.reference_arm or "").strip()
        }
        is_multi_arm = len(eligible_rows) >= 2 and len(distinct_treatments) >= 2 and len(distinct_comparators) == 1
        base_design = _map_extracted_design(characteristics.study_design)
        design = "multi_arm_rct" if is_multi_arm else base_design
        detected_designs.add(design)
        if is_multi_arm:
            multi_arm_studies.append(study_id)
            if "multi" not in str(characteristics.study_design or "").lower():
                characteristics.study_design = "multi-arm RCT"
                changed = True

        estimand_id = _estimand_id(protocol)
        prepared: list[tuple[OutcomeData, str, float]] = []
        for index, outcome in eligible_rows:
            treatment = str(outcome.treatment_arm or characteristics.intervention_description or "Intervention").strip()
            comparator = str(outcome.reference_arm or characteristics.control_description or "Comparator").strip()
            contrast_id = _contrast_id(study_id, treatment, comparator, index)
            updates = {
                "comparative_design": design,
                "treatment_arm": treatment,
                "reference_arm": comparator,
                "contrast_id": contrast_id,
                "estimand_id": estimand_id,
            }
            if design in {"parallel_rct", "multi_arm_rct"} and _has_complete_2x2(outcome):
                updates["precision_basis"] = (
                    "source_reported_effect"
                    if _has_protocol_reported_effect(outcome, protocol)
                    else "computed_from_source_verified_2x2"
                )
            for field, value in updates.items():
                if getattr(outcome, field) != value:
                    setattr(outcome, field, value)
                    changed = True
            if str(outcome.subgroup or "").strip().lower() == "overall":
                outcome.subgroup = None
                changed = True
            if "per-protocol" in str(outcome.outcome_name or "").lower() and not outcome.subgroup:
                outcome.subgroup = "per_protocol"
                changed = True
            normalized_timepoint = _normalise_early_postoperative_timepoint(outcome.timepoint)
            if normalized_timepoint and outcome.accepted_timepoint != normalized_timepoint:
                outcome.accepted_timepoint = normalized_timepoint
                outcome.timepoint_adjudication = "deterministic_semantic_normalization"
                outcome.timepoint_adjudication_note = (
                    "Equivalent wording for the same explicitly reported early postoperative window was normalized."
                )
                changed = True
            comparative_rows += 1
            if is_multi_arm:
                _, variance = _computed_protocol_effect(outcome, protocol)
                prepared.append((outcome, contrast_id, variance))

        if is_multi_arm:
            for left_index, (left, left_id, _) in enumerate(prepared):
                for right, right_id, _ in prepared[left_index + 1:]:
                    covariance = _shared_control_covariance(left, right, protocol.effect_measure)
                    if covariance is None:
                        # Leave the dependency unresolved. The complex engine will
                        # fail closed instead of treating correlated rows as independent.
                        continue
                    if left.covariance_with.get(right_id) != covariance:
                        left.covariance_with[right_id] = covariance
                        changed = True
                    if right.covariance_with.get(left_id) != covariance:
                        right.covariance_with[left_id] = covariance
                        changed = True

    if detected_designs:
        desired = [_display_design(item) for item in sorted(detected_designs)]
        existing_mapped = {
            _map_extracted_design(item)
            for item in (list(protocol.study_designs or []) or [protocol.study_design or ""])
            if str(item).strip()
        }
        if existing_mapped != detected_designs:
            protocol.study_designs = desired
            protocol.study_design = desired[0] if len(desired) == 1 else "mixed RCT designs"
            changed = True

    return {
        "schema_version": 1,
        "status": "reconciled",
        "changed": changed,
        "detected_designs": sorted(detected_designs),
        "multi_arm_studies": sorted(set(multi_arm_studies)),
        "comparative_rows": comparative_rows,
        "reported_effects_recovered": recovered_effects,
    }


def canonical_outcome_name(outcome: OutcomeData, protocol: ResearchProtocol) -> str:
    """Return the protocol label for a clearly matching primary outcome."""
    if _matches_primary_outcome(outcome.outcome_name, protocol.pico.outcome_primary):
        return str(protocol.pico.outcome_primary or outcome.outcome_name).strip()
    return str(outcome.outcome_name or "").strip()


def comparative_effect_from_outcome(
    outcome: OutcomeData,
    protocol: ResearchProtocol,
) -> dict[str, float | str | None]:
    """Materialize one typed comparative estimate without relabeling a report."""
    measure = str(protocol.effect_measure or outcome.reported_effect_measure or "").upper()
    if _has_protocol_reported_effect(outcome, protocol):
        return {
            "measure": measure,
            "estimate": float(outcome.effect_size),
            "standard_error": outcome.reported_effect_standard_error,
            "variance": None,
            "ci_lower": float(outcome.ci_lower) if outcome.ci_lower is not None else None,
            "ci_upper": float(outcome.ci_upper) if outcome.ci_upper is not None else None,
            "scale": str(outcome.reported_effect_scale or "original"),
        }
    yi, variance = _computed_protocol_effect(outcome, protocol)
    se = math.sqrt(variance)
    if measure in _RATIO_MEASURES:
        estimate = math.exp(yi)
        lower = math.exp(yi - _Z_975 * se)
        upper = math.exp(yi + _Z_975 * se)
        scale = "original"
    else:
        estimate = yi
        lower = yi - _Z_975 * se
        upper = yi + _Z_975 * se
        scale = "original"
    return {
        "measure": measure,
        "estimate": estimate,
        "standard_error": se,
        "variance": variance,
        "ci_lower": lower,
        "ci_upper": upper,
        "scale": scale,
    }


def _is_intervention_rct(protocol: ResearchProtocol) -> bool:
    family = str(getattr(protocol, "review_family", "") or "").strip().lower()
    if family and family != "intervention_rct":
        return False
    design_text = " ".join([
        str(getattr(protocol, "study_design", "") or ""),
        *[str(item) for item in (getattr(protocol, "study_designs", []) or [])],
    ]).lower()
    return not re.search(r"observational|cohort|case[- ]?control|non[- ]?random", design_text)


def _parsed_source_lookup(parsed_papers: dict[str, dict]) -> dict[str, str]:
    lookup: dict[str, str] = {}
    for key, value in parsed_papers.items():
        if not isinstance(value, dict):
            continue
        text = str(value.get("full_text") or "")
        if not text:
            continue
        tokens = {str(key).strip().lower()}
        for field in ("pmid", "doi", "paper_id", "study_id"):
            token = str(value.get(field) or "").strip().lower()
            if token:
                tokens.add(token)
        for token in tokens:
            if token:
                lookup[token] = text
    return lookup


def _source_text_for_study(study: ExtractedStudy, lookup: dict[str, str]) -> str:
    c = study.characteristics
    for value in (c.pmid, c.doi, c.study_id):
        token = str(value or "").strip().lower()
        if token in lookup:
            return lookup[token]
    return ""


def _recover_protocol_effect_from_source(
    outcome: OutcomeData,
    source_text: str,
    protocol: ResearchProtocol,
) -> bool:
    measure = str(protocol.effect_measure or "").upper()
    if measure not in {"RR", "OR"} or _has_protocol_reported_effect(outcome, protocol):
        return False
    aliases = r"RR|risk\s+ratio|relative\s+risk" if measure == "RR" else r"OR|odds\s+ratio"
    pattern = re.compile(
        rf"\b(?:{aliases})\b\s*[,=:]?\s*(\d+(?:[.·]\d+)?)"
        rf"[^\n.]{{0,100}}?95\s*%\s*CI\s*[,=:]?\s*(\d+(?:[.·]\d+)?)\s*[\-–—to]+\s*(\d+(?:[.·]\d+)?)",
        flags=re.IGNORECASE,
    )
    matches = list(pattern.finditer(source_text))
    if not matches:
        return False
    expected = None
    if _has_complete_2x2(outcome):
        try:
            yi, _ = _computed_protocol_effect(outcome, protocol)
            expected = math.exp(yi) if measure in _RATIO_MEASURES else yi
        except (TypeError, ValueError, ZeroDivisionError):
            expected = None
    outcome_tokens = {
        token for token in re.findall(r"[a-z]{5,}", str(outcome.outcome_name or "").lower())
        if token not in {"incidence", "postoperative", "outcome"}
    }

    def score(match: re.Match) -> tuple[float, int, int]:
        window = source_text[max(0, match.start() - 260):match.end() + 160].lower()
        point = float(match.group(1).replace("·", "."))
        proximity = -abs(point - expected) if expected is not None else 0.0
        return (proximity, sum(token in window for token in outcome_tokens), -match.start())

    selected = max(matches, key=score)
    try:
        point, lower, upper = [float(value.replace("·", ".")) for value in selected.groups()]
    except (TypeError, ValueError):
        return False
    if not (point > 0 and lower > 0 and upper >= lower):
        return False
    if expected is not None and abs(point - expected) > max(0.02, 0.05 * abs(expected)):
        return False
    start = source_text.rfind("\n", max(0, selected.start() - 500), selected.start())
    end = source_text.find("\n", selected.end(), min(len(source_text), selected.end() + 500))
    start = 0 if start < 0 else start + 1
    end = len(source_text) if end < 0 else end
    quote = " ".join(source_text[start:end].split())
    outcome.effect_size = point
    outcome.ci_lower = lower
    outcome.ci_upper = upper
    outcome.reported_effect_measure = measure
    outcome.reported_effect_scale = "original"
    outcome.source_quote = quote
    outcome.source_quote_match = quote[:500]
    outcome.source_quote_verified = True
    outcome.source_section = outcome.source_section or "Results"
    outcome.source_location = outcome.source_location or "Results"
    return True


def _is_source_backed_primary_contrast(outcome: OutcomeData, protocol: ResearchProtocol) -> bool:
    return (
        _matches_primary_outcome(outcome.outcome_name, protocol.pico.outcome_primary)
        and outcome.source_quote_verified is True
        and _has_complete_2x2(outcome)
    )


def _has_complete_2x2(outcome: OutcomeData) -> bool:
    return all(
        getattr(outcome, field) is not None
        for field in ("events_intervention", "total_intervention", "events_control", "total_control")
    )


def _has_protocol_reported_effect(outcome: OutcomeData, protocol: ResearchProtocol) -> bool:
    basic = (
        str(outcome.reported_effect_measure or "").upper() == str(protocol.effect_measure or "").upper()
        and outcome.effect_size is not None
        and (
            outcome.reported_effect_standard_error is not None
            or (outcome.ci_lower is not None and outcome.ci_upper is not None)
        )
        and outcome.source_quote_verified is True
    )
    if not basic:
        return False
    if not _has_complete_2x2(outcome):
        return True
    try:
        yi, _ = _computed_protocol_effect(outcome, protocol)
        computed = math.exp(yi) if str(protocol.effect_measure or "").upper() in _RATIO_MEASURES else yi
        reported = float(outcome.effect_size)
    except (TypeError, ValueError, ZeroDivisionError):
        return False
    return abs(reported - computed) <= max(0.02, 0.05 * abs(computed))


def _computed_protocol_effect(outcome: OutcomeData, protocol: ResearchProtocol) -> tuple[float, float]:
    if not _has_complete_2x2(outcome):
        raise ValueError("source-verified 2x2 counts are required for a derived RCT effect")
    return effect_size_engine.compute_effect_size(
        outcome_type="dichotomous",
        effect_measure=str(protocol.effect_measure or "").upper(),
        events_i=outcome.events_intervention,
        total_i=outcome.total_intervention,
        events_c=outcome.events_control,
        total_c=outcome.total_control,
    )


def _shared_control_covariance(
    left: OutcomeData,
    right: OutcomeData,
    measure: str,
) -> float | None:
    if not (_has_complete_2x2(left) and _has_complete_2x2(right)):
        return None
    if left.events_control != right.events_control or left.total_control != right.total_control:
        return None
    events = float(left.events_control)
    total = float(left.total_control)
    non_events = total - events
    if min(events, non_events) <= 0:
        events = events + 0.5 if events == 0 else events
        non_events = non_events + 0.5 if non_events == 0 else non_events
        total = events + non_events
    normalized = str(measure or "").upper()
    if normalized == "RR":
        return 1.0 / events - 1.0 / total
    if normalized == "OR":
        return 1.0 / events + 1.0 / non_events
    if normalized == "RD":
        risk = events / total
        return risk * (1.0 - risk) / total
    return None


def _matches_primary_outcome(name: str, primary: str) -> bool:
    return outcome_matches(name, primary)


def _arm_matches_intervention(arm: str | None, intervention: str) -> bool:
    if not str(arm or "").strip():
        return True
    arm_norm = _normalise_label(arm)
    intervention_norm = _normalise_label(intervention)
    tokens = [
        token for token in intervention_norm.split()
        if len(token) >= 4 and token not in {
            "intravenous", "perioperative", "intraoperative", "postoperative",
            "preoperative", "alone", "combination", "agents", "duration", "dose",
        }
    ]
    if any(token in arm_norm for token in tokens):
        return True
    # Common drug-arm abbreviations such as DEX-0.3 are accepted only when
    # they are an unambiguous prefix of the named intervention.
    return any(
        len(token) >= 6 and re.search(rf"\b{re.escape(token[:3])}(?:\b|[-_\d])", arm_norm)
        for token in tokens
    )


def _arm_matches_comparator(arm: str | None, comparator: str) -> bool:
    if not str(arm or "").strip():
        return True
    arm_norm = _normalise_label(arm)
    comparator_norm = _normalise_label(comparator)
    if any(token in arm_norm for token in comparator_norm.split() if len(token) >= 4):
        return True
    if any(token in comparator_norm for token in ("placebo", "usual care", "control")):
        return any(token in arm_norm for token in ("placebo", "saline", "control", "usual care"))
    return False


def _map_extracted_design(value: str) -> str:
    normalized = _normalise_label(value)
    if "cluster" in normalized:
        return "cluster_rct"
    if "crossover" in normalized or "cross over" in normalized:
        return "crossover_rct"
    if "multi arm" in normalized:
        return "multi_arm_rct"
    return "parallel_rct"


def _normalise_early_postoperative_timepoint(value: str | None) -> str:
    text = _normalise_label(value or "")
    if not text:
        return ""
    if re.search(r"(?:first|within)\s+7\s+(?:postoperative\s+)?days?", text):
        return "within 7 postoperative days"
    return ""


def _display_design(value: str) -> str:
    return {
        "parallel_rct": "parallel RCT",
        "cluster_rct": "cluster RCT",
        "crossover_rct": "crossover RCT",
        "multi_arm_rct": "multi-arm RCT",
    }[value]


def _estimand_id(protocol: ResearchProtocol) -> str:
    return ":".join([
        "primary",
        _slug(protocol.pico.outcome_primary),
        _slug(protocol.pico.intervention),
        "vs",
        _slug(protocol.pico.comparator),
    ])


def _contrast_id(study_id: str, treatment: str, comparator: str, index: int) -> str:
    return f"{_slug(study_id)}:{_slug(treatment)}-vs-{_slug(comparator)}:{index}"


def _normalise_arm(value: str | None) -> str:
    return _normalise_label(value or "")


def _normalise_label(value: str) -> str:
    return " ".join(re.sub(r"[^a-z0-9]+", " ", str(value or "").lower()).split())


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(value or "").lower()).strip("-")[:80] or "unknown"
