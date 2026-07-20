"""Project-level quality gate checks for manuscript-ready runs."""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from new_meta.core.claim_alignment import claim_alignment_input_hash


def run_quality_gate(project_dir: str | Path, *, require_real_smoke: bool | None = None) -> dict[str, Any]:
    """Evaluate deterministic manuscript quality gates for a project directory."""
    base = Path(project_dir)
    require_real = (
        os.getenv("META_REQUIRE_REAL_SMOKE", "").strip().lower() in {"1", "true", "yes", "on"}
        if require_real_smoke is None
        else require_real_smoke
    )
    checks: list[dict[str, Any]] = []
    checks.append(_check_effect_selection_audit(base))
    checks.append(_check_claim_source_resolution(base))
    checks.append(_check_citation_contract(base))
    checks.append(_check_claim_source_alignment(base))
    checks.append(_check_claim_map_authoring(base))
    checks.append(_check_golden_benchmarks())
    checks.append(_check_real_smoke_manifest(base, required=require_real))
    failed = [item for item in checks if item["status"] == "fail"]
    warnings = [item for item in checks if item["status"] == "warn"]
    return {
        "status": "fail" if failed else "warn" if warnings else "pass",
        "checks": checks,
        "failed_count": len(failed),
        "warning_count": len(warnings),
    }


def _check_effect_selection_audit(base: Path) -> dict[str, Any]:
    rows = _load_json(base / "analysis" / "effect_selection_audit.json", default=[])
    if not rows:
        return _warn("effect_selection_audit", "analysis/effect_selection_audit.json is missing or empty.")
    selected = [row for row in rows if row.get("in_final_primary_analysis")]
    missing_tier = [
        row.get("row_id") or row.get("study_id") or ""
        for row in selected
        if not row.get("source_provenance_tier")
    ]
    if missing_tier:
        return _fail("effect_selection_audit", "Selected primary rows lack source_provenance_tier.", rows=missing_tier[:20])
    return _pass("effect_selection_audit", f"{len(selected)} selected primary row(s) carry provenance tiers.")


def _check_claim_source_resolution(base: Path) -> dict[str, Any]:
    claim_map_path = base / "manuscript" / "claim_map.json"
    claim_map = _load_json(claim_map_path, default=None)
    audit = _load_json(base / "manuscript" / "claim_source_resolution_audit.json", default={})
    if not claim_map_path.exists():
        return _fail("claim_source_resolution", "claim_map.json is required before submission-ready authoring.")
    if not isinstance(claim_map, list):
        return _fail("claim_source_resolution", "claim_map.json must contain an array of manuscript claims.")
    writable = _writable_claims(claim_map)
    if not writable:
        return _fail("claim_source_resolution", "claim_map.json contains no writable main-text claims.")
    if not audit:
        return _fail("claim_source_resolution", "claim_map.json exists but claim_source_resolution_audit.json is missing.")
    summary = audit.get("summary") or {}
    unresolved = int(summary.get("unresolved_count") or 0)
    if unresolved:
        return _warn("claim_source_resolution", f"{unresolved} claim(s) were excluded because support sources did not resolve.")
    return _pass("claim_source_resolution", "All writable claim-map items resolved to supplied sources.")


def _check_citation_contract(base: Path) -> dict[str, Any]:
    claim_map = _load_json(base / "manuscript" / "claim_map.json", default=None)
    if not isinstance(claim_map, list):
        return _fail("citation_contract", "claim_map.json is required before citation contracts can be validated.")
    writable_claims = _writable_claims(claim_map)
    if not writable_claims:
        return _fail("citation_contract", "Writable claim-map items are required for a submission-ready citation contract.")
    contract = _load_json(base / "manuscript" / "citation_contract.json", default={})
    if not contract:
        return _fail("citation_contract", "Writable claim-map items exist but citation_contract.json is missing.")
    items = contract.get("items") if isinstance(contract, dict) else None
    if not isinstance(items, list):
        return _fail("citation_contract", "citation_contract.json does not contain an items array.")
    contract_claim_ids = {
        str(item.get("claim_id") or "").strip()
        for item in items
        if isinstance(item, dict)
    }
    writable_claim_ids = {
        str(claim.get("id") or "").strip()
        for claim in writable_claims
        if str(claim.get("id") or "").strip()
    }
    missing_contract = sorted(writable_claim_ids - contract_claim_ids)
    if missing_contract:
        return _fail(
            "citation_contract",
            "Writable claim-map items are missing citation contract entries.",
            rows=missing_contract[:20],
        )
    broken: list[str] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        claim_id = str(item.get("claim_id") or "")
        if not claim_id:
            broken.append("<missing-claim-id>")
            continue
        spans = item.get("source_spans")
        if not isinstance(spans, list) or not spans:
            broken.append(claim_id)
            continue
        if not any(str(span.get("source_id") or span.get("reference_id") or span.get("study_id") or "").strip() for span in spans if isinstance(span, dict)):
            broken.append(claim_id)
            continue
        source_types = {
            str(span.get("source_type") or "").strip().lower()
            for span in spans
            if isinstance(span, dict)
        }
        structured_only = bool(source_types) and source_types <= {"structured_fact", "analysis", "protocol", "grade"}
        if structured_only:
            continue
        if not str(item.get("citation") or "").strip():
            broken.append(claim_id)
            continue
        if not item.get("reference_numbers"):
            broken.append(claim_id)
            continue
    if broken:
        return _fail("citation_contract", "Citation contract entries lack citation, reference numbers, or source spans.", rows=broken[:20])
    return _pass("citation_contract", f"{len(items)} citation contract item(s) carry citation and source-span data.")


def _check_claim_source_alignment(base: Path) -> dict[str, Any]:
    claim_map = _load_json(base / "manuscript" / "claim_map.json", default=None)
    if not isinstance(claim_map, list):
        return _fail("claim_source_alignment", "claim_map.json is required before source-alignment review.")
    facts = _load_json(base / "manuscript" / "manuscript_facts.json", default={})
    if not isinstance(facts, dict):
        facts = {}
    output_language = str(facts.get("output_language") or _load_json(base / "manuscript" / "manuscript_output_language.json", default="") or "").strip()
    contract = _load_json(base / "manuscript" / "citation_contract.json", default={})
    items = contract.get("items") if isinstance(contract, dict) else None
    if not isinstance(items, list):
        return _warn("claim_source_alignment", "No citation_contract.json items were available for source-alignment review.")
    indirect_claim_ids = sorted({
        str(item.get("claim_id") or "").strip()
        for item in items
        if isinstance(item, dict) and _has_indirect_external_source_span(item)
    })
    indirect_claim_ids = [claim_id for claim_id in indirect_claim_ids if claim_id]
    if not indirect_claim_ids:
        return _pass("claim_source_alignment", "No indirect external claim sources require LLM semantic alignment.")
    audit = _load_json(base / "manuscript" / "claim_source_alignment_audit.json", default={})
    if not audit:
        return _fail(
            "claim_source_alignment",
            "Indirect external claim sources require claim_source_alignment_audit.json.",
            rows=indirect_claim_ids[:20],
        )
    status = str(audit.get("status") or "").strip().lower()
    if status != "ok":
        return _fail(
            "claim_source_alignment",
            f"Claim source-alignment audit did not pass (status={status or 'missing'}).",
            rows=indirect_claim_ids[:20],
        )
    if audit.get("enabled") is False:
        return _fail(
            "claim_source_alignment",
            "Claim source-alignment audit was disabled despite indirect external claim sources.",
            rows=indirect_claim_ids[:20],
        )
    expected_hash = claim_alignment_input_hash(claim_map, facts, output_language=output_language)
    observed_hash = str(audit.get("alignment_input_hash") or "").strip()
    if not observed_hash:
        return _fail(
            "claim_source_alignment",
            "Claim source-alignment audit lacks alignment_input_hash for stale-audit detection.",
            rows=indirect_claim_ids[:20],
        )
    if observed_hash != expected_hash:
        return _fail(
            "claim_source_alignment",
            "Claim source-alignment audit hash does not match the current claim map and manuscript facts.",
            rows=indirect_claim_ids[:20],
        )
    reviewed_ids = {
        str(item or "").strip()
        for item in (audit.get("reviewed_claim_ids") or [])
        if str(item or "").strip()
    }
    missing_reviewed_ids = sorted(set(indirect_claim_ids) - reviewed_ids)
    if missing_reviewed_ids:
        return _fail(
            "claim_source_alignment",
            "Claim source-alignment audit did not explicitly review all indirect external claim ids.",
            rows=missing_reviewed_ids[:20],
        )
    reviewed = _to_int(audit.get("reviewed_claims"))
    writable_count = len([
        claim for claim in claim_map
        if isinstance(claim, dict)
        and claim.get("can_write_main_text", True) is not False
        and str(claim.get("manuscript_use") or "main").lower() != "exclude"
    ])
    if reviewed < len(indirect_claim_ids) or (writable_count and reviewed < min(writable_count, 24)):
        return _fail(
            "claim_source_alignment",
            "Claim source-alignment audit did not review enough claims for indirect external sources.",
            rows=indirect_claim_ids[:20],
        )
    excluded = audit.get("excluded_claims")
    if isinstance(excluded, list) and excluded:
        return _warn(
            "claim_source_alignment",
            "Claim source-alignment audit excluded claim(s); verify regenerated claim map and manuscript.",
            rows=[str((item or {}).get("id") or "") for item in excluded if isinstance(item, dict)][:20],
        )
    return _pass(
        "claim_source_alignment",
        f"{len(indirect_claim_ids)} indirect external claim source(s) were covered by LLM semantic alignment.",
    )


def _check_claim_map_authoring(base: Path) -> dict[str, Any]:
    claim_map = _load_json(base / "manuscript" / "claim_map.json", default=None)
    if not isinstance(claim_map, list):
        return _fail("claim_map_authoring", "claim_map.json is required before claim-map authoring can be validated.")
    if not _writable_claims(claim_map):
        return _fail("claim_map_authoring", "No writable claim-map claims were available for manuscript authoring.")
    audit = _load_json(base / "manuscript" / "claim_map_authoring_audit.json", default={})
    if not isinstance(audit, dict) or not audit:
        return _fail("claim_map_authoring", "claim_map_authoring_audit.json is required to prove open sections were authored from approved claims.")
    status = str(audit.get("status") or "").strip().lower()
    if status not in {"ok", "pass"}:
        return _fail("claim_map_authoring", f"Claim-map authoring audit did not pass (status={status or 'missing'}).")
    accepted = _to_int(audit.get("accepted_sections"))
    if accepted <= 0:
        return _fail("claim_map_authoring", "Claim-map authoring audit did not accept any open manuscript section.")
    return _pass("claim_map_authoring", f"{accepted} open manuscript section(s) were authored from the approved claim map.")


def _has_indirect_external_source_span(item: dict[str, Any]) -> bool:
    spans = item.get("source_spans")
    if not isinstance(spans, list):
        return False
    for span in spans:
        if not isinstance(span, dict):
            continue
        source_type = str(span.get("source_type") or "").strip().lower()
        if source_type in {"structured_fact", "analysis", "protocol", "grade"}:
            continue
        support = str(span.get("support_strength") or "").strip().lower()
        verified = span.get("verified") is True
        if support not in {"direct", "structured"} or not verified:
            return True
    return False


def _writable_claims(claim_map: list[Any]) -> list[dict[str, Any]]:
    return [
        claim for claim in claim_map
        if isinstance(claim, dict)
        and claim.get("can_write_main_text", True) is not False
        and str(claim.get("manuscript_use") or "main").lower() != "exclude"
    ]


def _check_golden_benchmarks() -> dict[str, Any]:
    root = Path(__file__).resolve().parents[2] / "docs" / "benchmarks"
    expected = [
        root / "corticosteroids_covid_2020.manifest.json",
        root / "sglt2_hfpef_2022.manifest.json",
    ]
    missing = [str(path) for path in expected if not path.exists()]
    if missing:
        return _fail("golden_benchmarks", "Golden benchmark manifests are missing.", rows=missing)
    return _pass("golden_benchmarks", f"{len(expected)} golden benchmark manifest(s) are present.")


def _check_real_smoke_manifest(base: Path, *, required: bool) -> dict[str, Any]:
    path = base / "quality" / "real_llm_pdf_web_smoke.json"
    if not path.exists():
        status = "fail" if required else "warn"
        return {"name": "real_llm_pdf_web_smoke", "status": status, "message": "Real LLM/PDF/Web smoke has not been run."}
    data = _load_json(path, default={})
    if data.get("ok") is True:
        return _pass("real_llm_pdf_web_smoke", "Real LLM/PDF/Web smoke manifest reports ok=true.")
    return _fail("real_llm_pdf_web_smoke", "Real LLM/PDF/Web smoke manifest exists but did not report ok=true.")


def _load_json(path: Path, *, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def _to_int(value: Any) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return 0


def _pass(name: str, message: str, **extra: Any) -> dict[str, Any]:
    return {"name": name, "status": "pass", "message": message, **extra}


def _warn(name: str, message: str, **extra: Any) -> dict[str, Any]:
    return {"name": name, "status": "warn", "message": message, **extra}


def _fail(name: str, message: str, **extra: Any) -> dict[str, Any]:
    return {"name": name, "status": "fail", "message": message, **extra}
