"""Real-run smoke manifest for LLM/PDF/Web-backed projects."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def build_real_smoke_manifest(project_dir: str | Path) -> dict[str, Any]:
    """Return a manifest showing whether a project used real LLM/PDF/Web paths.

    This is an artifact check, not a substitute for a full benchmark. It is
    intentionally evidence-based: ok=true only when current project artifacts
    show a real LLM authoring pass, parsed/downloaded full-text material, search
    or web retrieval output, and a passing manuscript quality gate.
    """
    base = Path(project_dir)
    checks = [
        _check_llm_authoring(base),
        _check_pdf_or_fulltext(base),
        _check_web_or_search(base),
        _check_manuscript_quality(base),
    ]
    failed = [item for item in checks if item["status"] != "pass"]
    return {
        "schema_version": 1,
        "ok": not failed,
        "checks": checks,
        "failed_count": len(failed),
    }


def write_real_smoke_manifest(project_dir: str | Path) -> dict[str, Any]:
    base = Path(project_dir)
    manifest = build_real_smoke_manifest(base)
    out_dir = base / "quality"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "real_llm_pdf_web_smoke.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return manifest


def _check_llm_authoring(base: Path) -> dict[str, Any]:
    audit = _load_json(base / "manuscript" / "claim_map_authoring_audit.json")
    accepted = int((audit or {}).get("accepted_sections") or 0) if isinstance(audit, dict) else 0
    usage_exists = (base / "llm_usage_manifest.json").exists()
    if accepted > 0:
        return _pass(
            "real_llm_authoring",
            f"Claim-map authoring accepted {accepted} section(s).",
            paths=["manuscript/claim_map_authoring_audit.json"],
            llm_usage_manifest=usage_exists,
        )
    return _fail(
        "real_llm_authoring",
        "No accepted LLM claim-map authoring section was recorded.",
        paths=["manuscript/claim_map_authoring_audit.json"],
        llm_usage_manifest=usage_exists,
    )


def _check_pdf_or_fulltext(base: Path) -> dict[str, Any]:
    pdfs = list((base / "user_fulltexts").glob("*.pdf")) + list((base / "papers").glob("*.pdf"))
    parse_cache = list((base / "pdf_parse_cache").glob("*.json"))
    parsed = base / "papers" / "parsed_papers.json"
    if pdfs and (parse_cache or parsed.exists()):
        return _pass(
            "real_pdf_or_fulltext",
            f"Found {len(pdfs)} PDF file(s) and {len(parse_cache)} parse-cache artifact(s).",
            paths=["user_fulltexts/", "papers/", "pdf_parse_cache/"],
        )
    return _fail(
        "real_pdf_or_fulltext",
        "No usable PDF/full-text parsing evidence was found.",
        paths=["user_fulltexts/", "papers/", "pdf_parse_cache/", "papers/parsed_papers.json"],
    )


def _check_web_or_search(base: Path) -> dict[str, Any]:
    search_results = _load_json(base / "search_results.json")
    source_counts = _load_json(base / "search_source_counts.json")
    evidence_context = base / "search" / "evidence_context.json"
    clinicaltrials_cache = list((base / "papers" / "clinicaltrials_cache").glob("*.json"))
    result_count = len(search_results) if isinstance(search_results, list) else 0
    if result_count > 0 and (source_counts or evidence_context.exists() or clinicaltrials_cache):
        return _pass(
            "real_web_or_search",
            f"Found {result_count} search result(s) and web/search context artifacts.",
            paths=["search_results.json", "search_source_counts.json", "search/"],
            clinicaltrials_cache_count=len(clinicaltrials_cache),
        )
    return _fail(
        "real_web_or_search",
        "No real search/web retrieval artifact was found.",
        paths=["search_results.json", "search_source_counts.json", "search/"],
    )


def _check_manuscript_quality(base: Path) -> dict[str, Any]:
    quality = _load_json(base / "manuscript" / "manuscript_quality_gate.json")
    if isinstance(quality, dict) and quality.get("passed") is True:
        return _pass(
            "manuscript_quality",
            "Manuscript quality gate passed.",
            paths=["manuscript/manuscript_quality_gate.json"],
        )
    return _fail(
        "manuscript_quality",
        "Manuscript quality gate did not pass.",
        paths=["manuscript/manuscript_quality_gate.json"],
    )


def _load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _pass(name: str, message: str, **extra: Any) -> dict[str, Any]:
    return {"name": name, "status": "pass", "message": message, **extra}


def _fail(name: str, message: str, **extra: Any) -> dict[str, Any]:
    return {"name": name, "status": "fail", "message": message, **extra}


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Write real LLM/PDF/Web smoke manifest for a MetaAgent project.")
    parser.add_argument("project_dir")
    args = parser.parse_args()
    print(json.dumps(write_real_smoke_manifest(args.project_dir), ensure_ascii=False, indent=2))
