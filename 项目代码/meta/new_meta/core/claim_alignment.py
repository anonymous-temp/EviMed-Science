"""Shared claim-source alignment payload helpers."""
from __future__ import annotations

import hashlib
import json
from typing import Any


def source_backed_claims_for_alignment(claims: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return writable source-backed claims that need semantic alignment."""
    return [
        item for item in claims or []
        if isinstance(item, dict)
        and item.get("can_write_main_text", True)
        and str(item.get("manuscript_use") or "main") != "exclude"
        and (
            str(item.get("source_quote") or "").strip()
            or str(item.get("source_location") or "").strip()
            or str(item.get("support_source") or "").strip()
        )
    ]


def claim_alignment_payload(
    claims: list[dict[str, Any]],
    facts: dict[str, Any],
    *,
    output_language: str,
) -> dict[str, Any]:
    """Build the stable payload reviewed by the LLM source-alignment judge."""
    facts = facts if isinstance(facts, dict) else {}
    source_backed = source_backed_claims_for_alignment(claims)
    compact_claims = []
    for item in source_backed[:24]:
        compact_claims.append({
            "id": item.get("id"),
            "section": item.get("section"),
            "claim_type": item.get("claim_type"),
            "argument_step": item.get("argument_step"),
            "claim": item.get("claim"),
            "support_source": item.get("support_source"),
            "source_study_id": item.get("source_study_id"),
            "source_location": item.get("source_location"),
            "source_quote": item.get("source_quote"),
            "caveat": item.get("caveat"),
        })
    facts_context = {
        "output_language": output_language,
        "pico": facts.get("pico"),
        "research_question": facts.get("research_question"),
        "primary_effect": facts.get("primary_effect") if isinstance(facts.get("primary_effect"), dict) else {},
        "primary_population": facts.get("primary_population") if isinstance(facts.get("primary_population"), dict) else {},
        "absolute_effects": facts.get("absolute_effects") or {},
        "grade": facts.get("grade") if isinstance(facts.get("grade"), dict) else {},
        "study_cards": (facts.get("study_cards") or [])[:8],
    }
    return {
        "schema_version": 1,
        "output_language": output_language,
        "reviewed_claim_ids": [
            str(item.get("id") or "").strip()
            for item in compact_claims
            if str(item.get("id") or "").strip()
        ],
        "facts_context": facts_context,
        "claims": compact_claims,
    }


def claim_alignment_input_hash(
    claims: list[dict[str, Any]],
    facts: dict[str, Any],
    *,
    output_language: str,
) -> str:
    """Return a stable hash proving which claim/fact payload was reviewed."""
    payload = claim_alignment_payload(claims, facts, output_language=output_language)
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()
