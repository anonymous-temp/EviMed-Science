"""Shared primary-effect selection primitives for every execution entry point."""
from __future__ import annotations

import math
import re

from new_meta.core.provenance import (
    BENCHMARK_ALLOWED_TIERS,
    PRIMARY_ALLOWED_TIERS,
    annotate_source_provenance,
)
from new_meta.engines import effect_size as es_engine
from new_meta.schemas.meta_result import StudyEffect
from new_meta.schemas.protocol import ResearchProtocol
from new_meta.schemas.risk_of_bias import ResultRoBAssessment, StudyRoB
from new_meta.tools.utils import study_label


def _prefer_display_author_order(characteristics) -> bool:
    source_format = " ".join([
        getattr(characteristics, "source_type", "") or "",
        getattr(characteristics, "metadata_source", "") or "",
    ]).lower()
    return "pubmed" not in source_format


def _display_study_label(characteristics) -> str:
    return study_label(
        getattr(characteristics, "authors", []) or [],
        getattr(characteristics, "year", 0) or 0,
        prefer_display_order=_prefer_display_author_order(characteristics),
    )


def _subgroup_is_pooled_intervention_contrast(subgroup: str) -> bool:
    value = subgroup.strip().lower()
    if not value:
        return False
    patient_markers = (
        "invasive mechanical ventilation", "mechanical ventilation", "oxygen",
        "no oxygen", "older", "younger", "male", "female", "diabetes",
        "renal", "kidney", "subgroup of patients", "among patients", "among those",
    )
    if any(marker in value for marker in patient_markers):
        return False
    pooled_markers = ("pooled", "combined", "all corticosteroid", "all treatment")
    contrast_markers = (
        " vs ", " versus ", " compared with ", " compared to ", " no ",
        " control", " usual care", " placebo", " standard care",
    )
    return any(marker in value for marker in pooled_markers) and any(
        marker in value for marker in contrast_markers
    )


def _protocol_requires_critical_care(protocol: ResearchProtocol) -> bool:
    population = (getattr(getattr(protocol, "pico", None), "population", "") or "").lower()
    return any(term in population for term in (
        "critical", "critically ill", "icu", "intensive care", "mechanical ventilation",
        "mechanically ventilated", "vasopressor", "ecmo", "ards",
    ))


def _study_population_confirms_critical_care(study) -> bool:
    characteristics = getattr(study, "characteristics", None)
    text = " ".join(
        str(getattr(characteristics, attr, "") or "").lower()
        for attr in ("title", "population_description", "intervention_description", "control_description")
    )
    return any(term in text for term in (
        "critically ill", "critical illness", "icu", "intensive care",
        "mechanical ventilation", "mechanically ventilated", "vasopressor", "ecmo", "ards",
    ))


def _study_population_appears_broader_than_protocol(study, protocol: ResearchProtocol) -> bool:
    if not _protocol_requires_critical_care(protocol):
        return False
    characteristics = getattr(study, "characteristics", None)
    text = " ".join(
        str(getattr(characteristics, attr, "") or "").lower()
        for attr in ("title", "population_description")
    )
    if any(term in text for term in (
        "hospitalized", "hospitalised", "hospitalized patients",
        "hospitalised patients", "severe covid",
    )):
        return True
    return not _study_population_confirms_critical_care(study)


def _outcome_is_protocol_population_subgroup(outcome, study, protocol: ResearchProtocol) -> bool:
    if not _study_population_appears_broader_than_protocol(study, protocol):
        return False
    subgroup_text = str(getattr(outcome, "subgroup", "") or "").lower()
    critical_markers = (
        "invasive mechanical ventilation", "mechanically ventilated", "mechanical ventilation",
        "icu", "intensive care", "vasopressor", "ecmo", "ards",
    )
    text = " ".join(
        str(getattr(outcome, attr, "") or "").lower()
        for attr in ("subgroup", "outcome_name", "source_quote", "source_section", "source_location")
    )
    exclusion_markers = (
        "not receiving invasive", "without invasive", "oxygen only", "no oxygen",
        "no respiratory support", "non-invasive only",
    )
    if subgroup_text and any(marker in subgroup_text for marker in critical_markers):
        return not any(marker in subgroup_text for marker in exclusion_markers)
    if any(marker in text for marker in exclusion_markers):
        return False
    return any(marker in text for marker in critical_markers)


def _is_overall_outcome(outcome) -> bool:
    subgroup = (getattr(outcome, "subgroup", None) or "").strip().lower()
    if (
        subgroup
        and subgroup not in {"overall", "total", "all", "all participants", "intention-to-treat", "itt"}
        and not _subgroup_is_pooled_intervention_contrast(subgroup)
    ):
        return False
    evidence_text = " ".join(
        str(getattr(outcome, attr, "") or "").lower()
        for attr in ("outcome_name", "source_location", "source_quote", "source_section")
    )
    subgroup_markers = [
        "among patients receiving", "among those receiving",
        "receiving invasive mechanical ventilation", "invasive mechanical ventilation",
        "oxygen without invasive", "oxygen only", "no oxygen received",
        "no respiratory support", "not receiving invasive mechanical ventilation",
        "mechanical ventilation subgroup", "subgroup",
    ]
    return not any(marker in evidence_text for marker in subgroup_markers)


def primary_population_rank(outcome, study, protocol: ResearchProtocol) -> int:
    if _outcome_is_protocol_population_subgroup(outcome, study, protocol):
        return 2
    if _is_overall_outcome(outcome):
        return 1
    return 0


def _normalise_reference_token(value: object) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").strip().lower())


def _study_identity_tokens_from_characteristics(characteristics) -> set[str]:
    tokens: set[str] = set()
    for attr in ("pmid", "doi", "study_id", "title"):
        token = _normalise_reference_token(
            getattr(characteristics, attr, "") if characteristics is not None else ""
        )
        if token:
            tokens.add(token)
    return tokens


def _paper_identity_tokens(paper: dict) -> set[str]:
    raw = paper.get("paper") if isinstance(paper.get("paper"), dict) else paper
    if not isinstance(raw, dict):
        return set()
    return {
        token
        for token in (_normalise_reference_token(raw.get(key)) for key in ("pmid", "doi", "study_id", "id", "title"))
        if token
    }


def build_paper_source_lookup(papers: list[dict]) -> dict[str, dict]:
    lookup: dict[str, dict] = {}
    for paper in papers or []:
        raw = paper.get("paper") if isinstance(paper.get("paper"), dict) else paper
        if not isinstance(raw, dict):
            continue
        record = {
            "text_availability": raw.get("text_availability") or paper.get("text_availability") or "",
            "fulltext_source": raw.get("fulltext_source") or paper.get("fulltext_source") or "",
            "pdf_path": raw.get("pdf_path") or paper.get("pdf_path") or "",
            "fulltext_path": raw.get("fulltext_path") or paper.get("fulltext_path") or "",
        }
        for token in _paper_identity_tokens(raw):
            lookup[token] = record
    return lookup


def source_record_for_study(study, source_lookup: dict[str, dict]) -> dict:
    for token in _study_identity_tokens_from_characteristics(getattr(study, "characteristics", None)):
        if token in source_lookup:
            return source_lookup[token]
    return {}


def build_rob_lookup(rob_results: list[StudyRoB]) -> dict[str, list[StudyRoB]]:
    lookup: dict[str, list[StudyRoB]] = {}
    for rob in rob_results or []:
        tokens = {_normalise_reference_token(getattr(rob, "study_id", ""))}
        if isinstance(rob, ResultRoBAssessment):
            tokens.add(_normalise_reference_token(rob.result_id))
        for token in tokens:
            if token and rob not in lookup.setdefault(token, []):
                lookup[token].append(rob)
    return lookup


def rob_for_study(
    study,
    effect: StudyEffect | None,
    rob_lookup: dict[str, list[StudyRoB]],
    *,
    outcome=None,
) -> StudyRoB | None:
    tokens = _study_identity_tokens_from_characteristics(getattr(study, "characteristics", None))
    if effect is not None:
        tokens.add(_normalise_reference_token(effect.study_id))
        tokens.add(_normalise_reference_token(effect.study_label))
    candidates: list[StudyRoB] = []
    for token in tokens:
        for candidate in rob_lookup.get(token, []):
            if candidate not in candidates:
                candidates.append(candidate)
    result_specific = [item for item in candidates if isinstance(item, ResultRoBAssessment)]
    if result_specific and outcome is not None:
        outcome_name = _normalise_reference_token(getattr(outcome, "outcome_name", ""))
        timepoint = _normalise_reference_token(getattr(outcome, "accepted_timepoint", "") or getattr(outcome, "timepoint", ""))
        subgroup = _normalise_reference_token(getattr(outcome, "subgroup", ""))

        def score(item: ResultRoBAssessment) -> tuple[int, int, int]:
            item_name = _normalise_reference_token(item.outcome_name)
            item_timepoint = _normalise_reference_token(item.timepoint)
            item_subgroup = _normalise_reference_token(item.subgroup)
            return (
                int(bool(outcome_name) and item_name == outcome_name),
                int(not timepoint or not item_timepoint or item_timepoint == timepoint),
                int(not subgroup or not item_subgroup or item_subgroup == subgroup),
            )

        ranked = sorted(result_specific, key=score, reverse=True)
        if ranked and score(ranked[0])[0]:
            return ranked[0]
    legacy = [item for item in candidates if not isinstance(item, ResultRoBAssessment)]
    if legacy:
        return legacy[0]
    if len(result_specific) == 1 and outcome is None:
        return result_specific[0]
    return None


def primary_candidate_block_reason(
    audit_row: dict,
    outcome,
    rob: StudyRoB | None,
    *,
    benchmark_reference_manifest: dict | None = None,
) -> str:
    annotate_source_provenance(audit_row)
    tier = str(audit_row.get("source_provenance_tier") or "unknown")
    allowed_tiers = BENCHMARK_ALLOWED_TIERS if benchmark_reference_manifest else PRIMARY_ALLOWED_TIERS
    if tier not in allowed_tiers:
        return f"source_provenance_not_allowed:{tier}"
    text_availability = str(audit_row.get("text_availability") or "").lower()
    if text_availability in {"abstract_only", "metadata_only"}:
        return f"limited_text_source:{text_availability}"
    if getattr(outcome, "source_quote_verified", False) is not True:
        return "source_quote_not_verified"
    if rob is None:
        return "missing_risk_of_bias_assessment"
    if getattr(rob, "is_synthetic", False):
        return "synthetic_risk_of_bias_assessment"
    if not str(getattr(rob, "overall_judgment", "") or "").strip():
        return "empty_risk_of_bias_judgment"
    return ""


def _benchmark_reference_alias_index(reference_manifest: dict | None) -> dict[str, str]:
    index: dict[str, str] = {}
    for trial in (reference_manifest or {}).get("expected_trials") or []:
        slug = str(trial.get("slug") or "").strip()
        if not slug:
            continue
        aliases = set(trial.get("aliases") or [])
        aliases.update([slug, slug.replace("_", " "), trial.get("label"), trial.get("nct_id")])
        for alias in aliases:
            token = _normalise_reference_token(alias)
            if token:
                index[token] = slug
    return index


def _candidate_reference_text(study, outcome) -> str:
    characteristics = getattr(study, "characteristics", None)
    parts = [
        str(getattr(characteristics, attr, "") or "")
        for attr in (
            "study_id", "pmid", "doi", "title", "journal", "source_type", "metadata_source",
        )
    ]
    parts.extend(
        str(getattr(outcome, attr, "") or "")
        for attr in (
            "source_location", "source_section", "source_quote", "source_quote_match",
            "subgroup", "outcome_name",
        )
    )
    return " ".join(parts)


def _benchmark_reference_slug_for_candidate(
    study,
    outcome,
    reference_manifest: dict | None,
) -> str:
    alias_index = _benchmark_reference_alias_index(reference_manifest)
    if not alias_index:
        return ""
    characteristics = getattr(study, "characteristics", None)
    for value in (
        getattr(characteristics, "study_id", ""),
        getattr(characteristics, "pmid", ""),
        getattr(characteristics, "doi", ""),
    ):
        slug = alias_index.get(_normalise_reference_token(value))
        if slug:
            return slug
    normalized_text = _normalise_reference_token(_candidate_reference_text(study, outcome))
    for token, slug in alias_index.items():
        if token and len(token) >= 5 and token in normalized_text:
            return slug
    return ""


def _benchmark_reference_candidate_score(study, outcome) -> tuple[int, int, int, int, int, int]:
    characteristics = getattr(study, "characteristics", None)
    source_text = " ".join([
        str(getattr(characteristics, "source_type", "") or ""),
        str(getattr(characteristics, "metadata_source", "") or ""),
    ]).lower()
    has_counts = all(
        getattr(outcome, field, None) is not None
        for field in ("events_intervention", "total_intervention", "events_control", "total_control")
    )
    return (
        int(getattr(outcome, "manual_adjudication", False) is True),
        int("primary_trial_or_registry_seed" in source_text or "trial_registry_seed" in source_text),
        int(getattr(outcome, "source_quote_verified", False) is True),
        int(has_counts),
        int(bool(getattr(characteristics, "pmid", "") or "")),
        int(bool(getattr(characteristics, "doi", "") or "")),
    )


def filter_benchmark_reference_primary_candidates(
    candidates,
    reference_manifest: dict | None,
    audit_rows: list[dict],
    logger,
):
    """Constrain explicit benchmark runs to their declared original trial set."""
    if not (reference_manifest or {}).get("expected_trials"):
        return candidates

    audit_by_row_id = {str(row.get("row_id") or ""): row for row in audit_rows}
    grouped: dict[str, list[tuple[tuple[int, int, int, int, int, int], object, object, object, str]]] = {}
    for study, outcome, effect, row_id in candidates:
        slug = _benchmark_reference_slug_for_candidate(study, outcome, reference_manifest)
        row = audit_by_row_id.get(str(row_id))
        if row is not None:
            row["benchmark_reference_source_id"] = reference_manifest.get("source_id")
            row["benchmark_reference_trial"] = slug
        if not slug:
            if row is not None:
                row["decision"] = "excluded"
                row["reason"] = "outside_benchmark_reference_trial_set"
            logger.warning(
                "Excluding primary candidate %s from benchmark reproduction: not in expected trial set.",
                getattr(effect, "study_id", ""),
            )
            continue
        grouped.setdefault(slug, []).append(
            (_benchmark_reference_candidate_score(study, outcome), study, outcome, effect, row_id)
        )

    selected = []
    for slug, items in grouped.items():
        items.sort(key=lambda item: item[0], reverse=True)
        chosen = items[0]
        selected.append((chosen[1], chosen[2], chosen[3], chosen[4]))
        for dropped in items[1:]:
            row = audit_by_row_id.get(str(dropped[4]))
            if row is not None:
                row["decision"] = "excluded"
                row["reason"] = "benchmark_reference_duplicate_lower_ranked"
            logger.warning(
                "Excluding duplicate candidate %s for benchmark trial %s; keeping higher-ranked source %s.",
                getattr(dropped[3], "study_id", ""),
                slug,
                getattr(chosen[3], "study_id", ""),
            )
    return selected


def _candidate_quality(study, outcome) -> tuple[int, int, int, int, int]:
    characteristics = study.characteristics
    title = (characteristics.title or "").lower()
    return (
        int(getattr(outcome, "manual_adjudication", False) is True),
        int(bool(characteristics.pmid)),
        int(bool(characteristics.doi)),
        int("preliminary" not in title),
        int(bool(getattr(outcome, "source_quote_verified", False))),
    )


def _manual_reference_source_key(outcome) -> str:
    if getattr(outcome, "manual_adjudication", False) is not True:
        return ""
    source_location = re.sub(r"\s+", " ", str(getattr(outcome, "source_location", "") or "").strip().lower())
    source_section = re.sub(r"\s+", " ", str(getattr(outcome, "source_section", "") or "").strip().lower())
    return source_location or source_section or "__manual_reference__"


def _manual_reference_set_key(candidates) -> str:
    counts: dict[str, int] = {}
    for _, outcome, _ in candidates:
        key = _manual_reference_source_key(outcome)
        if key:
            counts[key] = counts.get(key, 0) + 1
    if not counts:
        return ""
    key, count = max(counts.items(), key=lambda item: item[1])
    return key if count >= 2 else ""


def _primary_effect_identity_key(study, outcome, effect) -> tuple[str, str, str]:
    characteristics = getattr(study, "characteristics", None)
    study_key = (
        getattr(characteristics, "pmid", None)
        or getattr(characteristics, "doi", None)
        or getattr(characteristics, "study_id", None)
        or getattr(effect, "study_id", None)
        or getattr(effect, "study_label", "")
    )
    if not study_key and getattr(outcome, "total_intervention", None) and getattr(outcome, "total_control", None):
        study_key = f"unknown_totals_{int(outcome.total_intervention)}_{int(outcome.total_control)}"
    return (
        _normalise_reference_token(study_key),
        _normalise_reference_token(getattr(outcome, "outcome_name", "") or ""),
        _normalise_reference_token(getattr(outcome, "timepoint", "") or ""),
    )


def _totals_outcome_key(outcome) -> tuple[int, int, str] | None:
    if not (getattr(outcome, "total_intervention", None) and getattr(outcome, "total_control", None)):
        return None
    return (
        int(outcome.total_intervention),
        int(outcome.total_control),
        _normalise_reference_token(getattr(outcome, "outcome_name", "") or ""),
    )


def _looks_like_preliminary_publication(study, effect) -> bool:
    characteristics = getattr(study, "characteristics", None)
    text = " ".join(str(value or "").lower() for value in (
        getattr(characteristics, "title", ""), getattr(characteristics, "doi", ""),
        getattr(characteristics, "source_type", ""), getattr(characteristics, "metadata_source", ""),
        getattr(effect, "study_id", ""), getattr(effect, "study_label", ""),
    ))
    return any(marker in text for marker in ("preprint", "preliminary", "medrxiv", "biorxiv"))


def dedupe_primary_effect_candidates(candidates, logger) -> list[StudyEffect]:
    manual_reference_key = _manual_reference_set_key(candidates)
    if manual_reference_key:
        filtered = []
        for study, outcome, effect in candidates:
            if _manual_reference_source_key(outcome) == manual_reference_key:
                filtered.append((study, outcome, effect))
            else:
                logger.warning(
                    "Source-adjudicated primary reference set detected; excluding non-adjudicated "
                    "primary candidate %s from the main analysis pending review.", effect.study_id,
                )
        candidates = filtered
    totals_groups: dict[tuple[int, int, str], list[tuple[object, object, StudyEffect]]] = {}
    for study, outcome, effect in candidates:
        totals_key = _totals_outcome_key(outcome)
        if totals_key:
            totals_groups.setdefault(totals_key, []).append((study, outcome, effect))
    duplicate_publication_totals = {
        key for key, items in totals_groups.items()
        if len(items) > 1 and any(_looks_like_preliminary_publication(study, effect) for study, _, effect in items)
    }
    by_key = {}
    for study, outcome, effect in candidates:
        totals_key = _totals_outcome_key(outcome)
        key = (
            ("duplicate_publication_totals", *totals_key)
            if totals_key in duplicate_publication_totals
            else _primary_effect_identity_key(study, outcome, effect)
        )
        score = _candidate_quality(study, outcome)
        current = by_key.get(key)
        if current is None or score > current[0]:
            if current is not None:
                logger.warning(
                    "Duplicate primary-effect candidate detected for study/outcome key %s; "
                    "keeping higher-quality publication (%s over %s)",
                    key, effect.study_id, current[3].study_id,
                )
            by_key[key] = (score, study, outcome, effect)
        else:
            logger.warning(
                "Duplicate primary-effect candidate detected for study/outcome key %s; "
                "dropping lower-quality publication %s", key, effect.study_id,
            )
    return [entry[3] for entry in by_key.values()]


def effect_is_poolable(effect: StudyEffect) -> tuple[bool, str]:
    if not math.isfinite(effect.yi):
        return False, "nonfinite_effect_size"
    if not math.isfinite(effect.vi) or effect.vi <= 0:
        return False, "nonpositive_or_nonfinite_variance"
    if not math.isfinite(effect.se) or effect.se <= 0:
        return False, "nonpositive_or_nonfinite_standard_error"
    if abs(effect.yi) >= 50 or effect.vi >= 100:
        return False, "extreme_effect_size_or_variance"
    return True, ""


def _primary_outcome_rank(outcome, target: str) -> tuple[int, int, int, int, int, int, int, int]:
    name_lower = (getattr(outcome, "outcome_name", "") or "").strip().lower()
    target_lower = target.strip().lower()
    name_days = set(re.findall(r"\b(\d+)\s*[- ]?\s*day", name_lower))
    target_days = set(re.findall(r"\b(\d+)\s*[- ]?\s*day", target_lower))
    has_counts = all(
        getattr(outcome, field, None) is not None
        for field in ("events_intervention", "total_intervention", "events_control", "total_control")
    )
    return (
        int(name_lower == target_lower), int(bool(name_days & target_days)),
        int(target_lower in name_lower or name_lower in target_lower),
        int("all-cause" in name_lower), int("mortality" in name_lower),
        int(bool(getattr(outcome, "source_quote_verified", False))), int(has_counts),
        -int(name_lower in {"death", "deaths"}),
    )


def primary_candidate_rank(
    outcome,
    study,
    protocol: ResearchProtocol,
) -> tuple[int, int, int, int, int, int, int, int, int, int]:
    return (
        int(getattr(outcome, "manual_adjudication", False) is True),
        primary_population_rank(outcome, study, protocol),
        *_primary_outcome_rank(outcome, protocol.pico.outcome_primary),
    )


def compute_study_effect(study, outcome, protocol, logger) -> StudyEffect | None:
    try:
        yi, vi = es_engine.compute_effect_size(
            outcome_type=outcome.outcome_type,
            effect_measure=protocol.effect_measure,
            mean_i=outcome.mean_intervention, sd_i=outcome.sd_intervention, n_i=outcome.n_intervention,
            mean_c=outcome.mean_control, sd_c=outcome.sd_control, n_c=outcome.n_control,
            median_i=outcome.median_intervention, q1_i=outcome.q1_intervention,
            q3_i=outcome.q3_intervention, min_i=outcome.min_intervention, max_i=outcome.max_intervention,
            median_c=outcome.median_control, q1_c=outcome.q1_control,
            q3_c=outcome.q3_control, min_c=outcome.min_control, max_c=outcome.max_control,
            events_i=outcome.events_intervention, total_i=outcome.total_intervention,
            events_c=outcome.events_control, total_c=outcome.total_control,
            effect=outcome.effect_size, ci_lower=outcome.ci_lower, ci_upper=outcome.ci_upper,
            p_value=outcome.p_value, hr=outcome.hazard_ratio,
            hr_ci_lower=outcome.hr_ci_lower, hr_ci_upper=outcome.hr_ci_upper, hr_se=outcome.hr_se,
            events_single=outcome.events, total_n=outcome.total_n,
            correlation_r=outcome.correlation_r, correlation_n=outcome.correlation_n,
            pyears_i=outcome.pyears_intervention, pyears_c=outcome.pyears_control,
        )
        characteristics = study.characteristics
        return StudyEffect(
            study_id=characteristics.pmid or characteristics.study_id,
            study_label=_display_study_label(characteristics),
            yi=yi,
            vi=vi,
            se=vi ** 0.5,
            subgroup=outcome.subgroup,
        )
    except Exception as exc:
        logger.warning(
            "Cannot compute effect size for %s: %s",
            study.characteristics.study_id,
            exc,
        )
        return None
