"""Ledger of every record the engine drops before inclusion.

PRISMA 2020 (Page et al., BMJ 2021;372:n71, flow-diagram template; E&E item
16a) accounts for every identified record: "Records removed before screening:
duplicate records removed; records marked as ineligible by automation tools;
records removed for other reasons", then "Records screened", "Reports sought
for retrieval", "Reports not retrieved" and "Reports assessed for
eligibility". A ranking that eliminates records before screening is reported
as marked ineligible by automation tools.

Until 2026-09-28 the engine only counted some of these (ma-001, tranexamic
acid in knee arthroplasty): 196 records cut by the relevance cap were counted
but never listed, 882 PubMed hits past the retrieval limit and 148 OpenAlex
records past the supplement cap appeared nowhere, and 38 records that passed
title/abstract screening but had no full text vanished between screening and
full-text assessment. This module writes one auditable artefact,
``screening/records_removed.json``, with one entry per drop stage: the closed
reason, the PRISMA slot it is counted in, the rule that caused it, the count,
and the records themselves (identifiers and title only, never abstracts).

Writing a step replaces that step's previous entries, so a re-run or a resume
never double-counts.
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
from typing import Any, Iterable

logger = logging.getLogger("metaagent.record_drops")

LEDGER_FILENAME = "records_removed.json"
LEDGER_SUBDIR = "screening"
SCHEMA_VERSION = 1

# PRISMA slots a ledger entry is counted in (closed vocabulary).
SLOT_NOT_RETRIEVED_FROM_SOURCE = "not_retrieved_from_source"
SLOT_DUPLICATES = "duplicates_removed"
SLOT_AUTOMATION = "automation_ineligible"
SLOT_OTHER = "removed_other_reasons"
SLOT_REPORTS_NOT_RETRIEVED = "reports_not_retrieved"
PRISMA_SLOTS = (
    SLOT_NOT_RETRIEVED_FROM_SOURCE,
    SLOT_DUPLICATES,
    SLOT_AUTOMATION,
    SLOT_OTHER,
    SLOT_REPORTS_NOT_RETRIEVED,
)

# The PRISMA 2020 template has three "removed before screening" lines. A
# source hit that was never retrieved is counted among the records identified
# (the search matched it), so it has to leave the flow on one of them: it was
# not ranked or judged by the engine, so it is "removed for other reasons",
# with its own reason. The ledger keeps the finer slot for the audit.
PRISMA_LINE_BY_SLOT = {
    SLOT_NOT_RETRIEVED_FROM_SOURCE: SLOT_OTHER,
    SLOT_DUPLICATES: SLOT_DUPLICATES,
    SLOT_AUTOMATION: SLOT_AUTOMATION,
    SLOT_OTHER: SLOT_OTHER,
    SLOT_REPORTS_NOT_RETRIEVED: SLOT_REPORTS_NOT_RETRIEVED,
}

# Closed reason codes -> (slot, reason label used as the key of the PRISMA
# reasons dicts). The labels are code-set, never model text; writers map them
# to prose (fallback_content._NOT_SCREENED_REASON_LABELS).
REASON_SOURCE_RETRIEVAL_LIMIT = "source_retrieval_limit"
REASON_SOURCE_METADATA_UNAVAILABLE = "source_metadata_unavailable"
REASON_DUPLICATE = "duplicate_record"
REASON_SUPPLEMENT_RELEVANCE_CAP = "supplement_relevance_cap"
REASON_RELEVANCE_CAP = "relevance_cap"
REASON_OUTSIDE_DATE_RANGE = "outside_date_range"
REASON_FULL_TEXT_NOT_RETRIEVED = "full_text_not_retrieved"

LABEL_RELEVANCE_CAP = "relevance cap before screening"
LABEL_SUPPLEMENT_RELEVANCE_CAP = "supplementary-source relevance cap"
LABEL_OUTSIDE_DATE_RANGE = "outside the protocol date range"
LABEL_SOURCE_RETRIEVAL_LIMIT = "not retrieved from the source (retrieval limit)"
LABEL_SOURCE_METADATA_UNAVAILABLE = "source metadata unavailable"

REASONS: dict[str, tuple[str, str]] = {
    REASON_SOURCE_RETRIEVAL_LIMIT: (SLOT_NOT_RETRIEVED_FROM_SOURCE, LABEL_SOURCE_RETRIEVAL_LIMIT),
    REASON_SOURCE_METADATA_UNAVAILABLE: (SLOT_OTHER, LABEL_SOURCE_METADATA_UNAVAILABLE),
    REASON_DUPLICATE: (SLOT_DUPLICATES, "duplicate record"),
    REASON_SUPPLEMENT_RELEVANCE_CAP: (SLOT_AUTOMATION, LABEL_SUPPLEMENT_RELEVANCE_CAP),
    REASON_RELEVANCE_CAP: (SLOT_AUTOMATION, LABEL_RELEVANCE_CAP),
    REASON_OUTSIDE_DATE_RANGE: (SLOT_OTHER, LABEL_OUTSIDE_DATE_RANGE),
    REASON_FULL_TEXT_NOT_RETRIEVED: (SLOT_REPORTS_NOT_RETRIEVED, "full text not retrieved"),
}

# Why a report sought for retrieval was not retrieved, from the record's own
# text_availability (closed vocabulary set by the retrieval code).
REPORT_ABSTRACT_ONLY = "abstract only"
REPORT_METADATA_ONLY = "registry metadata only"
REPORT_NO_TEXT = "no text retrieved"

_TITLE_MAX_CHARS = 300


def record_id(paper: dict) -> str:
    """A stable identifier for a record: PMID, else DOI, else a source ID, else a title hash."""
    for key in ("pmid", "doi", "trial_registration", "nct_id", "openalex_id", "s2_paper_id"):
        value = str(paper.get(key) or "").strip()
        if value:
            return value
    title = re.sub(r"\s+", " ", str(paper.get("title") or "").strip().lower())
    if title:
        return "title:" + hashlib.sha1(title.encode("utf-8")).hexdigest()[:12]
    return ""


def record_sources(paper: dict) -> list[str]:
    sources: list[str] = []
    for candidate in (*(paper.get("retrieval_sources") or []), paper.get("source"), paper.get("source_type")):
        normalized = str(candidate or "").strip().lower()
        if normalized and normalized not in sources:
            sources.append(normalized)
    return sources


def compact_record(paper: dict, **extra: Any) -> dict:
    """Identifiers and title of a record, bounded; never the abstract."""
    title = re.sub(r"\s+", " ", str(paper.get("title") or "")).strip()
    record = {
        "id": record_id(paper),
        "pmid": str(paper.get("pmid") or "").strip(),
        "doi": str(paper.get("doi") or "").strip(),
        "title": title[:_TITLE_MAX_CHARS],
        "sources": record_sources(paper),
    }
    for key, value in extra.items():
        if value is None or value == "":
            continue
        record[key] = value
    return record


def entry(
    *,
    step: str,
    stage: str,
    reason: str,
    records: Iterable[dict] = (),
    count: int | None = None,
    rule: dict | None = None,
    source: str = "",
) -> dict:
    """One drop site: what was removed, why, by which rule, and where PRISMA counts it."""
    if reason not in REASONS:
        raise ValueError(f"unknown drop reason: {reason}")
    slot, label = REASONS[reason]
    listed = list(records)
    total = len(listed) if count is None else max(int(count), len(listed))
    payload = {
        "step": step,
        "stage": stage,
        "reason": reason,
        "reason_label": label,
        "prisma_slot": slot,
        "prisma_line": PRISMA_LINE_BY_SLOT[slot],
        "rule": dict(rule or {}),
        "count": total,
        "records_listed": len(listed),
        "records_complete": len(listed) == total,
        "records": listed,
    }
    if source:
        payload["source"] = source
    return payload


def _ledger_path(project):
    return project.get_path(LEDGER_FILENAME, subdir=LEDGER_SUBDIR)


def load_ledger(project) -> dict:
    """The ledger on disk, or an empty one."""
    path = _ledger_path(project)
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, dict) and isinstance(data.get("entries"), list):
                return data
        except (OSError, json.JSONDecodeError):
            logger.warning("Ignoring unreadable drop ledger at %s", path)
    return {"schema_version": SCHEMA_VERSION, "entries": []}


def slot_totals(entries: Iterable[dict]) -> dict[str, int]:
    totals = {slot: 0 for slot in PRISMA_SLOTS}
    for item in entries:
        slot = item.get("prisma_slot")
        if slot in totals:
            totals[slot] += int(item.get("count") or 0)
    return totals


def line_reasons(entries: Iterable[dict], prisma_line: str) -> dict[str, int]:
    """Counts per reason label of the entries that land on one PRISMA line."""
    reasons: dict[str, int] = {}
    for item in entries:
        if item.get("prisma_line") != prisma_line:
            continue
        count = int(item.get("count") or 0)
        if count <= 0:
            continue
        label = str(item.get("reason_label") or item.get("reason") or "")
        reasons[label] = reasons.get(label, 0) + count
    return reasons


def _write(project, ledger: dict) -> dict:
    entries = [item for item in ledger.get("entries") or [] if isinstance(item, dict)]
    payload = {
        "schema_version": SCHEMA_VERSION,
        "description": (
            "Every record removed before inclusion, one entry per drop stage; "
            "prisma_slot names the PRISMA 2020 count the entry is part of."
        ),
        "totals": slot_totals(entries),
        "entries": entries,
    }
    project.save_json(LEDGER_FILENAME, payload, subdir=LEDGER_SUBDIR)
    return payload


def write_step(project, step: str, entries: Iterable[dict]) -> dict:
    """Replace every entry of ``step`` with ``entries`` (idempotent on re-run)."""
    ledger = load_ledger(project)
    kept = [item for item in ledger.get("entries") or [] if item.get("step") != step]
    return _write(project, {"entries": kept + list(entries)})


def write_stage(project, new_entry: dict) -> dict:
    """Replace the entry of one stage (idempotent on re-run)."""
    ledger = load_ledger(project)
    kept = [item for item in ledger.get("entries") or [] if item.get("stage") != new_entry.get("stage")]
    return _write(project, {"entries": kept + [new_entry]})


class SearchAccount:
    """Records identified per source, and every drop, for one search run.

    PRISMA arithmetic holds by construction: every list a stage shrinks is
    counted as the difference between what went in and what came out, so
    identified - duplicates - automation - other = records screened.
    """

    def __init__(self, step: str = "search") -> None:
        self.step = step
        self.identified: dict[str, int] = {}
        self.database_hits: dict[str, dict] = {}
        self.entries: list[dict] = []

    def identify(self, source: str, count: int) -> None:
        count = max(0, int(count or 0))
        if count or source not in self.identified:
            self.identified[source] = self.identified.get(source, 0) + count

    def hits(self, source: str, *, hits: int | None, retrieved: int, not_retrieved: int) -> None:
        self.database_hits[source] = {
            "hits": hits,
            "retrieved": int(retrieved),
            "not_retrieved": int(not_retrieved),
        }

    def add(
        self,
        stage: str,
        reason: str,
        records: Iterable[dict] = (),
        *,
        count: int | None = None,
        rule: dict | None = None,
        source: str = "",
        keep_empty: bool = False,
    ) -> dict | None:
        item = entry(
            step=self.step,
            stage=stage,
            reason=reason,
            records=records,
            count=count,
            rule=rule,
            source=source,
        )
        if item["count"] <= 0 and not keep_empty:
            return None
        self.entries = [existing for existing in self.entries if existing.get("stage") != stage]
        self.entries.append(item)
        return item

    def removed(
        self,
        stage: str,
        reason: str,
        papers: Iterable[dict],
        *,
        rule: dict | None = None,
        source: str = "",
        extra: dict[int, dict] | None = None,
        keep_empty: bool = False,
    ) -> dict | None:
        """Record papers removed at ``stage``; ``extra`` maps id(paper) to added fields."""
        extra = extra or {}
        records = [compact_record(paper, **extra.get(id(paper), {})) for paper in papers]
        return self.add(stage, reason, records, rule=rule, source=source, keep_empty=keep_empty)

    def duplicates(
        self,
        stage: str,
        merges: Iterable[tuple[dict, dict]],
        *,
        unlisted: int = 0,
        rule: dict | None = None,
        source: str = "",
    ) -> dict | None:
        """Record duplicates, each with the record it was merged into."""
        records = [
            compact_record(dropped, kept_as=record_id(kept))
            for dropped, kept in merges
        ]
        return self.add(
            stage,
            REASON_DUPLICATE,
            records,
            count=len(records) + max(0, int(unlisted or 0)),
            rule=rule,
            source=source,
        )

    @property
    def total_identified(self) -> int:
        return sum(self.identified.values())

    def slot_totals(self) -> dict[str, int]:
        return slot_totals(self.entries)

    def line_reasons(self, prisma_line: str) -> dict[str, int]:
        return line_reasons(self.entries, prisma_line)

    def screened_by_arithmetic(self) -> int:
        totals = self.slot_totals()
        return (
            self.total_identified
            - totals[SLOT_DUPLICATES]
            - totals[SLOT_AUTOMATION]
            - totals[SLOT_OTHER]
            - totals[SLOT_NOT_RETRIEVED_FROM_SOURCE]
        )

    def write(self, project) -> dict:
        return write_step(project, self.step, self.entries)


def report_unavailability(paper: dict) -> str:
    """Why a report sought for retrieval was not retrieved (closed vocabulary)."""
    availability = str(paper.get("text_availability") or "").strip().lower()
    source = str(paper.get("fulltext_source") or "").strip().lower()
    if availability == "abstract_only" or source in {"europe_pmc_abstract", "structured_abstract", "abstract"}:
        return REPORT_ABSTRACT_ONLY
    if availability == "metadata_only":
        return REPORT_METADATA_ONLY
    return REPORT_NO_TEXT


def apply_full_text_retrieval(
    project,
    *,
    sought: Iterable[dict],
    not_retrieved: Iterable[dict],
) -> dict:
    """Count reports sought for retrieval and those not retrieved, and list the latter.

    ``sought`` is every report the review tried to obtain in full (records
    included at title/abstract plus unmatched user uploads); ``not_retrieved``
    those left without usable full text (abstract only, registry metadata only,
    or nothing). Sets the PRISMA counts and replaces the ledger's full-text
    entry, so a re-run of the step does not double-count.
    """
    sought = list(sought)
    not_retrieved = list(not_retrieved)
    reasons: dict[str, int] = {}
    records = []
    for paper in not_retrieved:
        why = report_unavailability(paper)
        reasons[why] = reasons.get(why, 0) + 1
        records.append(compact_record(
            paper,
            unavailability=why,
            text_availability=str(paper.get("text_availability") or "") or None,
            fulltext_route=str(paper.get("fulltext_route") or "") or None,
            fulltext_source=str(paper.get("fulltext_source") or "") or None,
        ))
    project.prisma.set_full_text_retrieval(sought=len(sought), not_retrieved_reasons=reasons)
    item = entry(
        step="full_text",
        stage="full_text_not_retrieved",
        reason=REASON_FULL_TEXT_NOT_RETRIEVED,
        records=records,
        rule={
            "sought": len(sought),
            "usable_full_text": (
                "a PDF, publisher/PMC full-text XML or HTML, a registry record rendered as text, "
                "or a user upload; an abstract or registry metadata alone is not a report"
            ),
            "by_reason": reasons,
        },
    )
    write_step(project, "full_text", [item])
    return item
