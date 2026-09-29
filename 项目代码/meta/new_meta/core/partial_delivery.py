"""Readable last-resort evidence report when one requested calculation cannot finish."""
from __future__ import annotations

import json


def write_partial_report(project, phase):
    """Preserve a saved draft or describe available rows without inventing a synthesis."""
    draft = project.get_path("draft.md", subdir="manuscript")
    studies = project.load_json("all_extractions.json", subdir="extraction") or []
    screening = project.load_json("full_text_screening.json", subdir="screening") or []
    protocol = project.load_json("protocol.json") or {}
    if not draft.is_file() and not studies and not screening:
        return False
    limitation = phase.summary + " No unsupported pooled estimate or verification claim is supplied."
    if draft.is_file() and draft.read_text(encoding="utf-8").strip():
        text = draft.read_text(encoding="utf-8")
        if limitation not in text:
            text += "\n\n## Evidence limitations\n\n" + limitation + "\n"
    else:
        title = protocol.get("research_question") or "Available research evidence"
        lines = [f"# {title}", "", "## Scope and limitations", "", limitation,
                 "", "This partial research report retains extracted evidence. Independent verification and "
                 "methodological assessments may be incomplete; individual extracted values below are not a pooled result.",
                 "", "## Available study evidence", ""]
        for study in studies:
            c = study.get("characteristics") or {}
            lines.extend([f"### {c.get('title') or c.get('study_id') or c.get('pmid') or 'Study'}", "",
                          f"Study identifier: {c.get('pmid') or c.get('study_id') or 'unavailable'}.", ""])
            for outcome in study.get("outcomes") or []:
                numbers = {key: value for key, value in outcome.items()
                           if isinstance(value, (int, float)) and not isinstance(value, bool)
                           and key not in {"source_page", "override_revision"}}
                lines.append(f"- {outcome.get('outcome_name') or 'Reported outcome'}: extracted values "
                             + json.dumps(numbers, ensure_ascii=False, allow_nan=False) + ".")
            if c.get("doi"):
                lines.extend(["", "DOI: " + c["doi"]])
            lines.append("")
        if screening:
            lines.extend(["## Source coverage", ""])
            for row in screening:
                paper = row.get("paper") or {}
                lines.append(f"- {paper.get('title') or paper.get('pmid') or paper.get('doi') or 'Source'}: "
                             f"{row.get('decision') or 'unresolved'}. {row.get('reason') or ''}")
        text = "\n".join(lines) + "\n"
    project.save_text("draft.md", text, subdir="manuscript")
    project.save_json("report_state.json", {"report_type": "narrative", "completion": "partial",
                                           "verification": "unverified", "reason": phase.summary}, subdir="analysis")
    project.add_warning("synthesis", limitation, code=phase.error_code or "partial_analysis")
    project.save_checkpoint("manuscript")
    return True
