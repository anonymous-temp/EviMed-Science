"""Resolve claim-map support sources against manuscript facts."""
from __future__ import annotations

import json
import re
from copy import deepcopy
from typing import Any

from new_meta.schemas.manuscript_contract import SourceSpan


def resolve_claim_sources(claim_map: list[dict[str, Any]], facts: dict[str, Any]) -> dict[str, Any]:
    """Annotate claims with source-resolution status and exclude unsupported claims."""
    facts = facts if isinstance(facts, dict) else {}
    claims = deepcopy(claim_map or [])
    study_index = _study_index(facts.get("study_cards") or [])
    background_index = _background_reference_index(
        (facts.get("background_evidence") or {}).get("references") or []
    )
    resolved = []
    unresolved = []
    for item in claims:
        if not isinstance(item, dict):
            continue
        status = _resolve_one_claim(item, facts, study_index, background_index)
        item["source_resolution"] = status
        if status["resolved"]:
            if status.get("source_spans"):
                item["source_spans"] = status.get("source_spans") or []
            resolved.append(item.get("id") or item.get("claim") or "")
        else:
            item["can_write_main_text"] = False
            item["manuscript_use"] = "exclude"
            unresolved.append({
                "id": item.get("id") or "",
                "section": item.get("section") or "",
                "claim": item.get("claim") or "",
                "support_source": item.get("support_source") or "",
                "reason": status["reason"],
            })

    return {
        "claim_map": claims,
        "summary": {
            "claim_count": len(claims),
            "resolved_count": len(resolved),
            "unresolved_count": len(unresolved),
        },
        "unresolved_claims": unresolved,
    }


def _resolve_one_claim(
    item: dict[str, Any],
    facts: dict[str, Any],
    study_index: dict[str, dict],
    background_index: dict[str, dict],
) -> dict[str, Any]:
    source = str(item.get("support_source") or "").strip()
    compact_source = _norm(source)
    study_id = str(item.get("source_study_id") or "").strip()
    reference_id = str(item.get("reference_id") or "").strip()
    quote = str(item.get("source_quote") or "").strip()
    contradiction = _claim_contradicts_structured_facts(item, facts)
    if contradiction:
        return _fail(contradiction)

    if study_id and _norm(study_id) in study_index:
        card = study_index[_norm(study_id)]
        if quote and not _quote_supported_by_source(quote, _study_card_source_text(card)):
            return _fail("source_quote_not_found_in_resolved_source")
        return _ok(
            "study_card",
            {
                "study_id": study_id,
                "source_quote_present": bool(quote),
                "source_spans": [_span(
                    source_id=study_id,
                    study_id=str(card.get("study_id") or study_id),
                    source_type="study_card",
                    location=str(item.get("source_location") or card.get("title") or ""),
                    quote=quote,
                    verified=bool(quote),
                    support_strength="direct" if quote else "indirect",
                )],
            },
        )

    if reference_id and _norm(reference_id) in background_index:
        ref = background_index[_norm(reference_id)]
        source_text = _background_reference_source_text(ref)
        if _background_quote_contradicts_source_numbers(quote, source_text):
            return _fail("source_quote_not_found_in_resolved_source")
        verified = bool(quote and _quote_supported_by_source(quote, source_text))
        resolved_reference_id = str(ref.get("id") or ref.get("pmid") or ref.get("doi") or reference_id)
        return _ok(
            "background_reference",
            {
                "reference_id": resolved_reference_id,
                "title": ref.get("title") or "",
                "source_quote_present": bool(quote),
                "source_spans": [_span(
                    source_id=resolved_reference_id or _norm(reference_id),
                    reference_id=resolved_reference_id,
                    source_type="background_reference",
                    location=str(item.get("source_location") or ref.get("title") or ""),
                    quote=quote,
                    verified=verified,
                    support_strength="direct" if verified else "indirect",
                )],
            },
        )

    structured_tokens = {
        "researchquestion": bool(facts.get("research_question") or facts.get("protocol") or facts.get("pico")),
        "protocol": bool(facts.get("protocol") or facts.get("protocol_summary") or facts.get("research_question")),
        "pico": bool(facts.get("pico") or facts.get("protocol") or facts.get("primary_outcome") or facts.get("research_question")),
        "endpointdefinition": bool(facts.get("domain_controversy_candidates") or facts.get("primary_effect") or facts.get("pico")),
        "endpointdefinitioncaveat": bool(facts.get("domain_controversy_candidates") or facts.get("primary_effect") or facts.get("pico")),
        "endpointdefinitiondiscussion": bool(facts.get("domain_controversy_candidates") or facts.get("primary_effect") or facts.get("pico")),
        "primaryeffect": bool(facts.get("primary_effect")),
        "primaryoutcome": bool(facts.get("primary_effect") or facts.get("primary_outcome")),
        "absoluteeffects": bool(facts.get("absolute_effects")),
        "absoluteeffect": bool(facts.get("absolute_effects")),
        "metares": bool(facts.get("primary_effect") or facts.get("meta_results")),
        "metaanalysis": bool(facts.get("primary_effect")),
        "synthesisresult": bool(facts.get("synthesis_result")),
        "primaryestimates": bool((facts.get("synthesis_result") or {}).get("primary_estimates")),
        "grade": bool(facts.get("grade")),
        "methodcertainty": bool(facts.get("grade") and facts.get("method_family")),
        "prisma": bool(facts.get("prisma")),
        "selectedprimaryrows": bool((facts.get("evidence_readiness") or {}).get("selected_primary_rows")),
        "backgroundevidence": bool(background_index),
        "domaincontroversy": bool(facts.get("domain_controversy_candidates")),
        "studycards": bool(study_index),
    }
    matched_structured_tokens = [
        token
        for token, available in structured_tokens.items()
        if token in compact_source and available
    ]
    if matched_structured_tokens:
        selected_token = ""
        if quote:
            for token in matched_structured_tokens:
                if _quote_supported_by_structured_fact(token, quote, facts):
                    selected_token = token
                    break
            if not selected_token:
                return _fail("source_quote_not_found_in_structured_fact")
        else:
            selected_token = matched_structured_tokens[0]
        return _ok(
            "structured_fact",
            {
                "matched_token": selected_token,
                "source_quote_present": bool(quote),
                "source_spans": [_span(
                    source_id=selected_token,
                    source_type="structured_fact",
                    location=str(item.get("source_location") or source or selected_token),
                    quote=quote,
                    verified=True,
                    support_strength="structured",
                )],
            },
        )

    for token, ref in background_index.items():
        if token and token in compact_source:
            source_text = _background_reference_source_text(ref)
            if _background_quote_contradicts_source_numbers(quote, source_text):
                return _fail("source_quote_not_found_in_resolved_source")
            verified = bool(quote and _quote_supported_by_source(quote, source_text))
            reference_id = str(ref.get("id") or ref.get("pmid") or ref.get("doi") or "")
            return _ok(
                "background_reference",
                {
                    "reference_id": reference_id,
                    "title": ref.get("title") or "",
                    "source_quote_present": bool(quote),
                    "source_spans": [_span(
                        source_id=reference_id or token,
                        reference_id=reference_id,
                        source_type="background_reference",
                        location=str(item.get("source_location") or ref.get("title") or ""),
                        quote=quote,
                        verified=verified,
                        support_strength="direct" if verified else "indirect",
                    )],
                },
            )

    for token, card in study_index.items():
        if token and token in compact_source:
            if quote and not _quote_supported_by_source(quote, _study_card_source_text(card)):
                return _fail("source_quote_not_found_in_resolved_source")
            study_id = str(card.get("study_id") or "")
            return _ok(
                "study_card",
                {
                    "study_id": study_id,
                    "title": card.get("title") or "",
                    "source_quote_present": bool(quote),
                    "source_spans": [_span(
                        source_id=study_id or token,
                        study_id=study_id,
                        source_type="study_card",
                        location=str(item.get("source_location") or card.get("title") or ""),
                        quote=quote,
                        verified=bool(quote),
                        support_strength="direct" if quote else "indirect",
                    )],
                },
            )

    if quote:
        return _fail("source_quote_without_resolvable_source")
    if not source:
        return _fail("missing_support_source")
    return _fail("support_source_not_resolved")


def _claim_contradicts_structured_facts(item: dict[str, Any], facts: dict[str, Any]) -> str:
    """Reject claims that negate analysis outputs already present in facts.

    Source quotes can support the existence of a trial endpoint, but they should
    not allow a claim map to say that an analysis output was unavailable when the
    current review has already calculated it. This is a source-fact consistency
    check, not a style filter.
    """
    claim = str(item.get("claim") or "")
    caveat = str(item.get("caveat") or "")
    support = str(item.get("support_source") or "")
    text = " ".join(part for part in (claim, caveat, support) if part).lower()
    if not text.strip():
        return ""

    absolute_effects = facts.get("absolute_effects") if isinstance(facts.get("absolute_effects"), dict) else {}
    scenarios = absolute_effects.get("scenarios") if isinstance(absolute_effects, dict) else []
    has_absolute_effect = bool(scenarios)
    if has_absolute_effect and _negates_available_absolute_effect(text):
        return "claim_contradicts_available_absolute_effects"

    primary = facts.get("primary_effect") if isinstance(facts.get("primary_effect"), dict) else {}
    has_primary_synthesis = bool(primary.get("pooled_effect") or primary.get("effect") or primary.get("n_studies"))
    n_studies = _to_int(primary.get("n_studies"))
    if has_primary_synthesis and n_studies >= 2 and _negates_available_primary_synthesis(text):
        return "claim_contradicts_available_primary_synthesis"

    if _has_study_card_safety_notes(facts) and _negates_available_safety_notes(text):
        return "claim_contradicts_available_safety_notes"
    return ""


def _negates_available_absolute_effect(text: str) -> bool:
    return bool(
        re.search(
            r"(未提供|没有|缺少|无法获得|不能报告|仅能报告|only report|not provided|unavailable|not available|no\s+)"
            r".{0,40}(绝对风险|绝对效应|绝对获益|风险差|需治疗人数|需治数|\barr\b|\bnnt\b|absolute risk|absolute effect|absolute benefit|risk difference|number needed)",
            text,
            flags=re.I,
        )
        or re.search(
            r"(绝对风险|绝对效应|绝对获益|风险差|需治疗人数|需治数|\barr\b|\bnnt\b|absolute risk|absolute effect|absolute benefit|risk difference|number needed)"
            r".{0,40}(未提供|没有|缺少|无法获得|不能报告|not provided|unavailable|not available)",
            text,
            flags=re.I,
        )
    )


def _negates_available_primary_synthesis(text: str) -> bool:
    return bool(
        re.search(
            r"(无法|不能|不宜|仅能|only|cannot|can not|unable)"
            r".{0,36}(跨研究|合并|荟萃|meta-analysis|synthesi[sz]e|pool|pooled|integrat|compare)",
            text,
            flags=re.I,
        )
        or re.search(
            r"(各研究|each study|individual stud)"
            r".{0,30}(仅能|只能|独立解读|only be interpreted independently|interpreted independently)",
            text,
            flags=re.I,
        )
    )


def _has_study_card_safety_notes(facts: dict[str, Any]) -> bool:
    for card in facts.get("study_cards") or []:
        if isinstance(card, dict) and any(str(item or "").strip() for item in (card.get("safety_notes") or [])):
            return True
    return False


def _negates_available_safety_notes(text: str) -> bool:
    if _affirms_available_safety_notes(text):
        return False
    return bool(
        re.search(
            r"(未提供|没有|缺少|无法获得|not provided|unavailable|not available|absent|no\s+)"
            r".{0,50}(安全|不良事件|safety|adverse event|serious adverse|discontinuation)",
            text,
            flags=re.I,
        )
        or re.search(
            r"(安全|不良事件|safety|adverse event|serious adverse|discontinuation)"
            r".{0,50}(未提供|没有|缺少|无法获得|not provided|unavailable|not available|absent)",
            text,
            flags=re.I,
        )
    )


def _affirms_available_safety_notes(text: str) -> bool:
    if re.search(r"\b(not available|unavailable|not provided)\b", text, flags=re.I):
        return False
    return bool(
        re.search(
            r"(safety notes|safety data|adverse[- ]event data|serious adverse[- ]event data)"
            r".{0,50}\b(available|retained|summari[sz]ed|provided)\b",
            text,
            flags=re.I,
        )
        or re.search(
            r"\b(available|retained|summari[sz]ed|provided)\b"
            r".{0,50}(safety notes|safety data|adverse[- ]event data|serious adverse[- ]event data)",
            text,
            flags=re.I,
        )
        or re.search(r"(安全性|不良事件).{0,20}(可用|已有|保留|叙述)", text)
    )


def _to_int(value: Any) -> int:
    try:
        return int(float(value))
    except Exception:
        return 0


def _study_index(cards: list[dict[str, Any]]) -> dict[str, dict]:
    index: dict[str, dict] = {}
    for card in cards:
        if not isinstance(card, dict):
            continue
        for key in ("study_id", "pmid", "doi", "title", "label"):
            token = _norm(card.get(key))
            if token:
                index[token] = card
    return index


def _background_reference_index(refs: list[dict[str, Any]]) -> dict[str, dict]:
    index: dict[str, dict] = {}
    for ref in refs:
        if not isinstance(ref, dict):
            continue
        for key in ("id", "pmid", "doi", "title", "citation", "source"):
            token = _norm(ref.get(key))
            if token:
                index[token] = ref
    return index


def _quote_supported_by_structured_fact(token: str, quote: str, facts: dict[str, Any]) -> bool:
    source_text = _structured_fact_source_text(token, facts)
    quote_numbers = _normalized_numbers(quote, include_variants=False)
    if quote_numbers:
        source_numbers = _normalized_numbers(source_text, include_variants=True)
        return bool(source_numbers) and quote_numbers <= source_numbers
    return bool(str(source_text or "").strip())


def _structured_fact_source_text(token: str, facts: dict[str, Any]) -> str:
    token = _norm(token)
    key_groups: dict[str, tuple[str, ...]] = {
        "researchquestion": ("research_question", "protocol", "protocol_summary", "pico", "primary_outcome"),
        "protocol": ("research_question", "protocol", "protocol_summary", "pico", "primary_outcome"),
        "pico": ("research_question", "protocol", "protocol_summary", "pico", "primary_outcome"),
        "endpointdefinition": ("domain_controversy_candidates", "primary_effect", "primary_outcome", "pico"),
        "endpointdefinitioncaveat": ("domain_controversy_candidates", "primary_effect", "primary_outcome", "pico"),
        "endpointdefinitiondiscussion": ("domain_controversy_candidates", "primary_effect", "primary_outcome", "pico"),
        "primaryeffect": ("primary_effect", "primary_population", "meta_results", "evidence_readiness"),
        "primaryoutcome": ("primary_effect", "primary_population", "primary_outcome", "meta_results", "evidence_readiness"),
        "metares": ("primary_effect", "primary_population", "meta_results", "evidence_readiness"),
        "metaanalysis": ("primary_effect", "primary_population", "meta_results", "evidence_readiness"),
        "absoluteeffect": ("absolute_effects", "baseline_risk_scenarios"),
        "absoluteeffects": ("absolute_effects", "baseline_risk_scenarios"),
        "grade": ("grade", "grade_profile", "grade_inputs", "primary_effect"),
        "prisma": ("prisma", "prisma_flow", "prisma_counts"),
        "selectedprimaryrows": ("evidence_readiness",),
        "backgroundevidence": ("background_evidence",),
        "domaincontroversy": ("domain_controversy_candidates",),
        "studycards": ("study_cards",),
    }
    keys = key_groups.get(token, ())
    parts: list[str] = []
    for key in keys:
        if key in facts:
            parts.append(_serialize_source_value(key, facts.get(key)))
    parts.extend(_structured_fact_rendered_summaries(token, facts))
    return "\n".join(part for part in parts if str(part or "").strip())


def _serialize_source_value(label: str, value: Any) -> str:
    try:
        rendered = json.dumps(value, ensure_ascii=False, sort_keys=True)
    except (TypeError, ValueError):
        rendered = str(value)
    return f"{label}: {rendered}"


def _structured_fact_rendered_summaries(token: str, facts: dict[str, Any]) -> list[str]:
    summaries: list[str] = []
    primary = facts.get("primary_effect") if isinstance(facts.get("primary_effect"), dict) else {}
    if token in {"primaryeffect", "primaryoutcome", "metares", "metaanalysis", "grade"} and primary:
        measure = str(primary.get("effect_measure") or primary.get("measure") or "").strip()
        effect = primary.get("pooled_effect", primary.get("effect"))
        ci_lower = primary.get("ci_lower")
        ci_upper = primary.get("ci_upper")
        n_studies = primary.get("n_studies")
        primary_population = facts.get("primary_population") if isinstance(facts.get("primary_population"), dict) else {}
        total_n = primary.get("total_n", primary.get("participants", primary_population.get("selected_total_participants")))
        if effect is not None:
            summaries.extend([
                f"Pooled effect {effect}",
                f"Pooled {measure} {effect}".strip(),
                f"{measure} {effect}".strip(),
            ])
        if ci_lower is not None and ci_upper is not None:
            summaries.extend([
                f"95% CI {ci_lower} to {ci_upper}",
                f"confidence interval {ci_lower} to {ci_upper}",
            ])
        if n_studies is not None:
            summaries.append(f"{n_studies} studies contributed to the primary meta-analysis")
        if total_n is not None:
            summaries.append(f"{total_n} participants contributed to the primary meta-analysis")
    absolute = facts.get("absolute_effects") if isinstance(facts.get("absolute_effects"), dict) else {}
    if token in {"absoluteeffect", "absoluteeffects"} and absolute:
        for scenario in absolute.get("scenarios") or []:
            if not isinstance(scenario, dict):
                continue
            for key in (
                "assumed_control_risk_per_1000",
                "intervention_risk_per_1000",
                "events_avoided_per_1000",
                "events_added_per_1000",
                "risk_difference_per_1000",
                "nnt",
                "nnh",
            ):
                if scenario.get(key) is not None:
                    summaries.append(f"{key} {scenario.get(key)}")
    grade = facts.get("grade") if isinstance(facts.get("grade"), dict) else {}
    if token == "grade" and grade:
        if grade.get("certainty"):
            summaries.append(f"Certainty {grade.get('certainty')}")
        for domain in grade.get("domains") or []:
            summaries.append(_serialize_source_value("grade_domain", domain))
    return summaries


def _study_card_source_text(card: dict[str, Any]) -> str:
    parts: list[str] = []
    scalar_keys = (
        "study_id",
        "display_name",
        "title",
        "design",
        "country_or_setting",
        "population",
        "intervention",
        "comparator",
        "follow_up",
        "primary_outcome",
        "outcome_window",
        "distinctive_feature",
        "source_quote",
    )
    for key in scalar_keys:
        parts.append(str(card.get(key) or ""))
    for key in (
        "clinical_quirks",
        "risk_notes",
        "safety_notes",
        "applicability_notes",
        "unresolved_questions",
        "audit_notes",
    ):
        values = card.get(key)
        if isinstance(values, list):
            parts.extend(str(item or "") for item in values)
    for claim in card.get("source_backed_claims") or []:
        if isinstance(claim, dict):
            parts.extend(str(claim.get(key) or "") for key in (
                "claim",
                "source_quote",
                "source_location",
                "caveat",
            ))
    return "\n".join(part for part in parts if part.strip())


def _background_reference_source_text(ref: dict[str, Any]) -> str:
    parts: list[str] = []
    for key in (
        "id",
        "pmid",
        "doi",
        "title",
        "citation",
        "source",
        "abstract",
        "summary",
        "source_quote",
        "quote",
        "snippet",
        "content",
        "evidence",
    ):
        value = ref.get(key)
        if isinstance(value, list):
            parts.extend(str(item or "") for item in value)
        elif isinstance(value, dict):
            parts.append(" ".join(str(item or "") for item in value.values()))
        else:
            parts.append(str(value or ""))
    return "\n".join(part for part in parts if part.strip())


def _background_quote_contradicts_source_numbers(quote: str, source_text: str) -> bool:
    if not quote:
        return False
    if _quote_supported_by_source(quote, source_text):
        return False
    quote_numbers = _normalized_numbers(quote, include_variants=False)
    if not quote_numbers:
        return False
    source_numbers = _normalized_numbers(source_text, include_variants=True)
    return not source_numbers or not quote_numbers <= source_numbers


def _quote_supported_by_source(quote: str, source_text: str) -> bool:
    quote_norm = _norm_words(quote)
    if not quote_norm:
        return True
    source_norm = _norm_words(source_text)
    if not source_norm:
        return False
    if quote_norm in source_norm:
        return True
    quote_numbers = re.findall(r"\d+(?:\.\d+)?", quote_norm)
    if any(number not in source_norm for number in quote_numbers):
        return False
    quote_tokens = _content_tokens(quote_norm)
    if len(quote_tokens) < 4:
        return False
    source_tokens = _content_tokens(source_norm)
    if not source_tokens:
        return False
    overlap = len(quote_tokens & source_tokens) / max(1, len(quote_tokens))
    return overlap >= 0.82


def _normalized_numbers(value: Any, *, include_variants: bool = True) -> set[str]:
    out: set[str] = set()
    text = re.sub(r"(?<=\d),(?=\d)", "", str(value or ""))
    for raw in re.findall(r"\d+(?:\.\d+)?", text):
        try:
            number = float(raw)
        except ValueError:
            continue
        out.add(f"{number:g}")
        if not include_variants:
            continue
        out.add(f"{number:.0f}")
        out.add(f"{number:.1f}")
        out.add(f"{number:.2f}")
        out.add(f"{number:.3f}")
        out.add(f"{number:.4f}")
    return out


def _norm_words(value: Any) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9\u4e00-\u9fff.%/+-]+", " ", str(value or "").lower())).strip()


def _content_tokens(text: str) -> set[str]:
    return {
        token
        for token in re.findall(r"[a-z0-9\u4e00-\u9fff.%/+-]+", text.lower())
        if len(token) >= 3 or re.search(r"\d", token)
    }


def _norm(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").lower())


def _ok(kind: str, detail: dict[str, Any]) -> dict[str, Any]:
    return {"resolved": True, "kind": kind, "reason": "", **detail}


def _fail(reason: str) -> dict[str, Any]:
    return {"resolved": False, "kind": "", "reason": reason}


def _span(
    *,
    source_id: str = "",
    reference_id: str = "",
    study_id: str = "",
    source_type: str = "",
    location: str = "",
    quote: str = "",
    verified: bool = False,
    support_strength: str = "unverified",
) -> dict[str, Any]:
    return SourceSpan(
        source_id=source_id,
        reference_id=reference_id,
        study_id=study_id,
        source_type=source_type,
        location=location,
        quote=quote,
        verified=verified,
        support_strength=support_strength,
    ).model_dump()
