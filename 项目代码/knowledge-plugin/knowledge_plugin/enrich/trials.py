"""ClinicalTrials.gov for ``/text``: phase, status, enrollment and sponsor of a registered trial.

``GET /api/v2/studies/<NCT>?fields=…`` — ``fields`` keeps the answer to what is used; the full
record carries central-contact names, phones and e-mails that must never pass the plugin. The
trial facts are deterministic registry data the platform shows next to an item (plan 10.3.4);
the detailed description (or the brief summary) is the text of a registry entry.
"""

from __future__ import annotations

import json
from typing import Any

from ..adapters.common import clean_markup
from .common import Endpoints, Trace, get

STUDY_FIELDS = "NCTId,OverallStatus,Phase,EnrollmentCount,LeadSponsorName,BriefSummary,DetailedDescription"


def study_url(endpoints: Endpoints, nct: str) -> str:
    return f"{endpoints.ctgov_studies}/{nct}?fields={STUDY_FIELDS}"


def parse_study(payload: Any) -> tuple[dict[str, Any], str | None]:
    """``(trial_facts, text)`` of one study answer."""
    protocol = (payload or {}).get("protocolSection") or {} if isinstance(payload, dict) else {}
    status = protocol.get("statusModule") or {}
    design = protocol.get("designModule") or {}
    sponsor = ((protocol.get("sponsorCollaboratorsModule") or {}).get("leadSponsor") or {}).get("name")
    enrollment = (design.get("enrollmentInfo") or {}).get("count")
    facts = {
        "phase": "/".join(design.get("phases") or []) or None,
        "status": status.get("overallStatus") or None,
        "enrollment": enrollment if isinstance(enrollment, int) else None,
        "sponsor": clean_markup(sponsor) or None,
    }
    description = protocol.get("descriptionModule") or {}
    text = clean_markup(description.get("detailedDescription"), keep_paragraphs=True) or \
        clean_markup(description.get("briefSummary"), keep_paragraphs=True) or None
    return {k: v for k, v in facts.items() if v is not None}, text


async def trial(fetcher: Any, endpoints: Endpoints, nct: str, trace: Trace) -> tuple[dict[str, Any], str | None]:
    attempt = await get(fetcher, study_url(endpoints, nct))
    if attempt.result is None:
        trace.record(attempt, "ctgov_study")
        return {}, None
    if attempt.result.status == 404:
        trace.notes.append("ctgov_study_not_found")
        return {}, None
    try:
        payload = json.loads(attempt.result.body.decode("utf-8", errors="replace"))
    except ValueError:
        trace.notes.append("ctgov_study_unreadable")
        return {}, None
    return parse_study(payload)
