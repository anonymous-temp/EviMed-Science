"""Attach user-supplied full texts to an existing project.

This module handles the post-run repair path for evidence-gap projects: when a
primary publication was only available as abstract text, a user can upload the
PDF later and the project artifacts are updated so a resume can re-parse,
re-extract, and regenerate evidence-readiness state.
"""
from __future__ import annotations

import re
import shutil
from difflib import SequenceMatcher
from pathlib import Path
from typing import Callable, Any

from new_meta.core.pdf_intake import parse_user_pdfs, save_pdf_intake_manifest
from new_meta.core.project import Project
from new_meta.tools.utils import paper_identity


def attach_user_fulltexts_to_project(
    project: Project,
    pdf_paths: list[str],
    *,
    session_id: str | None = None,
    parse_func: Callable[[str], dict] | None = None,
    progress_cb: Callable[[Any], None] | None = None,
) -> dict[str, Any]:
    """Attach uploaded PDFs to existing project records and clear downstream.

    The function is intentionally conservative: only matched PDFs update
    existing records. Unmatched PDFs remain visible in `pdf_intake_manifest.json`
    with `requires_user_review=True` rather than being silently converted into
    synthetic PubMed records.
    """
    if not pdf_paths:
        return {
            "ok": True,
            "project_dir": str(project.base_dir),
            "uploaded": 0,
            "matched": 0,
            "unmatched": 0,
            "matches": [],
            "cleared_checkpoints": [],
            "requires_resume": False,
            "message": "No uploaded full texts were provided.",
        }

    staged_paths = _stage_uploaded_fulltexts(project, pdf_paths)
    manifest, parsed_by_path = parse_user_pdfs(
        staged_paths,
        project.base_dir,
        session_id=session_id or project.base_dir.name,
        parse_func=parse_func,
        progress_cb=progress_cb,
    )

    pdf_download_data = _load_list(project.load_json("pdf_download_results.json"))
    ft_screening_data = _load_list(project.load_json("full_text_screening.json", subdir="screening"))
    search_data = _load_list(project.load_json("search_results.json"))
    candidates = _candidate_records(pdf_download_data, ft_screening_data, search_data)

    matches: list[dict[str, Any]] = []
    matched_identities: set[str] = set()
    used_candidate_ids: set[str] = set()

    for record in manifest.files:
        parsed = parsed_by_path.get(record.local_path) or {}
        if record.parse_status != "ok" or not parsed.get("full_text"):
            record.requires_user_review = True
            continue
        match = _best_candidate_match(record.local_path, parsed, candidates, used_candidate_ids)
        if not match:
            record.requires_user_review = True
            continue

        candidate = match["candidate"]
        identity = paper_identity(candidate)
        used_candidate_ids.add(identity)
        matched_identities.add(identity)
        record.matched_pmid = str(candidate.get("pmid") or "") or None
        record.matched_title = str(candidate.get("title") or "") or None
        record.match_score = match["score"]
        record.match_method = match["method"]
        record.requires_user_review = match["score"] < 0.9

        _attach_to_matching_records(pdf_download_data, identity, record.local_path)
        _attach_to_matching_fulltext_screening(ft_screening_data, identity, record.local_path)
        if not any(paper_identity(item) == identity for item in pdf_download_data):
            restored = dict(candidate)
            _mark_user_fulltext(restored, record.local_path)
            pdf_download_data.append(restored)

        matches.append({
            "file": record.filename,
            "local_path": record.local_path,
            "paper_id": identity,
            "pmid": candidate.get("pmid") or "",
            "doi": candidate.get("doi") or "",
            "title": candidate.get("title") or "",
            "match_score": match["score"],
            "match_method": match["method"],
            "text_chars": record.text_chars,
            "table_count": record.table_count,
            "cache_hit": record.cache_hit,
        })

    save_pdf_intake_manifest(manifest, project.base_dir)

    if matches:
        project.save_json("pdf_download_results.json", pdf_download_data)
        if ft_screening_data:
            project.save_json("full_text_screening.json", ft_screening_data, subdir="screening")
        _save_matched_parsed_papers(project, matches, parsed_by_path)
        _remove_resolved_text_source_warnings(project, matched_identities)
        cleared = project.clear_downstream("pdf_download")
    else:
        cleared = []

    unmatched = [
        item.model_dump()
        for item in manifest.files
        if not item.matched_pmid and not item.matched_title
    ]
    return {
        "ok": True,
        "project_dir": str(project.base_dir),
        "uploaded": len(pdf_paths),
        "matched": len(matches),
        "unmatched": len(unmatched),
        "matches": matches,
        "unmatched_files": unmatched,
        "cleared_checkpoints": cleared,
        "requires_resume": bool(matches),
        "rerun_from_step": "pdf_parsing" if matches else "",
        "next_actions": (
            [{
                "type": "resume_project",
                "project_dir": str(project.base_dir),
                "from_step": "pdf_parsing",
                "message": "Resume the project so uploaded full texts are re-parsed and downstream evidence is regenerated.",
            }]
            if matches else
            [{
                "type": "review_unmatched_uploads",
                "project_dir": str(project.base_dir),
                "message": "Review unmatched uploaded files before adding them to the evidence set.",
            }]
        ),
        "manifest_path": str(project.base_dir / "pdf_intake_manifest.json"),
        "message": (
            "Uploaded full texts were attached. Resume the project to rerun parsing, "
            "screening, extraction, meta-analysis, and manuscript validation."
            if matches else
            "No uploaded full text could be matched to existing project records."
        ),
    }


def _stage_uploaded_fulltexts(project: Project, pdf_paths: list[str]) -> list[str]:
    """Copy uploaded full-text files into the project for stable resume."""
    project_root = project.base_dir.resolve()
    dest_dir = project.base_dir / "user_fulltexts"
    dest_dir.mkdir(parents=True, exist_ok=True)
    staged: list[str] = []
    for raw_path in pdf_paths:
        source = Path(raw_path)
        if not source.exists():
            staged.append(str(source))
            continue
        resolved = source.resolve()
        if project_root == resolved or project_root in resolved.parents:
            staged.append(str(resolved))
            continue
        dest = _unique_destination(dest_dir, source.name)
        shutil.copy2(source, dest)
        staged.append(str(dest))
    return staged


def _unique_destination(dest_dir: Path, filename: str) -> Path:
    candidate = dest_dir / filename
    if not candidate.exists():
        return candidate
    stem = candidate.stem
    suffix = candidate.suffix
    for idx in range(2, 1000):
        candidate = dest_dir / f"{stem}_{idx}{suffix}"
        if not candidate.exists():
            return candidate
    raise RuntimeError(f"Could not allocate upload filename for {filename}")


def _load_list(value: Any) -> list[dict[str, Any]]:
    return value if isinstance(value, list) else []


def _candidate_records(
    pdf_download_data: list[dict[str, Any]],
    ft_screening_data: list[dict[str, Any]],
    search_data: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    by_id: dict[str, dict[str, Any]] = {}
    for source in (pdf_download_data, [item.get("paper", item) for item in ft_screening_data], search_data):
        for item in source:
            if not isinstance(item, dict):
                continue
            identity = paper_identity(item)
            if identity and identity != "unknown":
                by_id.setdefault(identity, item)
    return list(by_id.values())


def _best_candidate_match(
    pdf_path: str,
    parsed: dict[str, Any],
    candidates: list[dict[str, Any]],
    used_candidate_ids: set[str],
) -> dict[str, Any] | None:
    best: dict[str, Any] | None = None
    for candidate in candidates:
        identity = paper_identity(candidate)
        if identity in used_candidate_ids:
            continue
        score, method = _candidate_match_score(pdf_path, parsed, candidate)
        if score < 0.55:
            continue
        if best is None or (
            score,
            _match_method_priority(method),
        ) > (
            best["score"],
            _match_method_priority(best["method"]),
        ):
            best = {"candidate": candidate, "score": round(score, 3), "method": method}
    return best


def _candidate_match_score(pdf_path: str, parsed: dict[str, Any], paper: dict[str, Any]) -> tuple[float, str]:
    filename = Path(pdf_path).stem.lower()
    full_text = str(parsed.get("full_text") or "").lower()
    text_head = full_text[:12000]
    pmid = str(paper.get("pmid") or "").strip()
    doi = _normalise_doi(paper.get("doi"))
    title = str(paper.get("title") or "").strip()
    title_norm = _normalise_text(title)
    filename_norm = _normalise_text(filename)

    if pmid and pmid in filename:
        return 1.0, "filename_pmid"
    if doi:
        doi_file = doi.replace("/", "_").replace(".", "_").lower()
        doi_suffix = doi.split("/")[-1]
        if doi in filename or doi_file in filename or (len(doi_suffix) >= 5 and doi_suffix in filename):
            return 1.0, "filename_doi"
    if title_norm and filename_norm and title_norm == filename_norm:
        return 1.0, "filename_title"
    if title_norm and filename_norm and title_norm in filename_norm:
        return 0.99, "filename_title"
    if title_norm and filename_norm and filename_norm in title_norm:
        length_ratio = len(filename_norm) / max(len(title_norm), 1)
        return min(0.94, 0.82 + 0.14 * length_ratio), "filename_title_partial"
    if title_norm and filename_norm:
        filename_ratio = SequenceMatcher(None, filename_norm, title_norm).ratio()
        if filename_ratio >= 0.92:
            return 0.99, "filename_title"

    if doi:
        if doi in text_head:
            return 0.98, "text_doi"
    if pmid and pmid in text_head:
        return 0.98, "text_pmid"

    if title_norm and title_norm in _normalise_text(text_head):
        return 0.95, "text_title"

    inferred_title = _infer_title_from_text(parsed) or filename.replace("_", " ")
    ratio = SequenceMatcher(None, _normalise_text(inferred_title), title_norm).ratio() if title_norm else 0.0
    overlap = _title_token_overlap(title, text_head)
    score = max(ratio, overlap)
    method = "title_similarity" if ratio >= overlap else "text_title_overlap"
    return score, method


def _match_method_priority(method: str) -> int:
    """Prefer direct filename/identifier evidence over loose text overlap."""
    priorities = {
        "filename_pmid": 100,
        "filename_doi": 95,
        "filename_title": 90,
        "text_doi": 80,
        "text_pmid": 75,
        "filename_title_partial": 70,
        "text_title": 60,
        "title_similarity": 40,
        "text_title_overlap": 20,
    }
    return priorities.get(method, 0)


def _attach_to_matching_records(records: list[dict[str, Any]], identity: str, pdf_path: str) -> None:
    for item in records:
        if paper_identity(item) == identity:
            _mark_user_fulltext(item, pdf_path)


def _attach_to_matching_fulltext_screening(rows: list[dict[str, Any]], identity: str, pdf_path: str) -> None:
    for row in rows:
        paper = row.get("paper", row) if isinstance(row, dict) else {}
        if isinstance(paper, dict) and paper_identity(paper) == identity:
            _mark_user_fulltext(paper, pdf_path)


def _mark_user_fulltext(paper: dict[str, Any], pdf_path: str) -> None:
    paper["pdf_path"] = pdf_path
    paper["fulltext_available"] = True
    paper["text_availability"] = "full_text"
    paper["fulltext_source"] = "user_upload"
    paper["user_uploaded_full_text"] = True
    paper.pop("needs_user_full_text", None)


def _save_matched_parsed_papers(project: Project, matches: list[dict[str, Any]], parsed_by_path: dict[str, dict]) -> None:
    parsed_cache = project.load_json("parsed_papers.json", subdir="papers") or {}
    for item in matches:
        parsed = parsed_by_path.get(item["local_path"])
        if parsed:
            parsed_cache[item["paper_id"]] = parsed
    project.save_json("parsed_papers.json", parsed_cache, subdir="papers")


def _remove_resolved_text_source_warnings(project: Project, resolved_identities: set[str]) -> None:
    warnings = project.load_json("text_source_warnings.json") or []
    remaining = []
    for warning in warnings:
        if paper_identity(warning) not in resolved_identities:
            remaining.append(warning)
    project.save_json("text_source_warnings.json", remaining)


def _infer_title_from_text(parsed: dict[str, Any]) -> str:
    text = str(parsed.get("full_text") or "")
    for raw_line in text.splitlines()[:20]:
        line = raw_line.strip()
        if len(line) >= 12 and not line.lower().startswith("[page"):
            return line
    return ""


def _title_token_overlap(title: str, text: str) -> float:
    title_tokens = _content_tokens(title)
    if not title_tokens:
        return 0.0
    text_tokens = _content_tokens(text[:12000])
    overlap = title_tokens & text_tokens
    return len(overlap) / len(title_tokens)


def _content_tokens(text: str) -> set[str]:
    stopwords = {
        "a", "an", "and", "are", "as", "for", "in", "of", "on", "or", "the",
        "to", "with", "without", "trial", "study", "patients", "patient",
    }
    return {
        token
        for token in re.findall(r"[a-z0-9]+", (text or "").lower())
        if len(token) > 2 and token not in stopwords
    }


def _normalise_doi(value: Any) -> str:
    text = str(value or "").strip().lower()
    return re.sub(r"^https?://(?:dx\.)?doi\.org/", "", text)


def _normalise_text(value: Any) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", str(value or "").lower())).strip()
