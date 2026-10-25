"""How long, and how often, a top journal's research paper is asked for its text (c3-primary, 2026-10-25).

Measured on 2026-10-25 on the 484 top-journal (authority 4-5) items the platform still held or had given up on: the
text rule asked an entry every 12 hours for 14 days and then answered ``unavailable``. Of the 111 that a model read as
original research, the abstract existed today for 23 (OpenAlex 14 in the first two days, PubMed or Europe PMC 8 up to
twenty days after first sight, a publisher feed 3), and 62 of them had been given up on. PubMed's records for JAMA's research
papers stay in ``Publisher`` status (no abstract) for weeks, Europe PMC indexed four Science Bulletin papers 19-20 days
after their first sight, and OpenAlex created the NEJM papers' records one day after the plugin's first try. So for those
entries the wait is longer (``EXTENDED_HORIZON``) and its cadence decays (``retry_delay_s``): often while an index is
likely to learn the paper, rarely when only a late indexing can.

Which entries: a journal of authority ``MIN_AUTHORITY`` or more, with a DOI or PMID, that PubMed has not typed as something
that has no abstract (an editorial, a letter, a news item...). That is a closed list of PubMed's own publication types; it is
not a reading of the title. An entry no index has typed yet is asked, since "not indexed" is the normal first answer.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any, Iterable

MIN_AUTHORITY = 4
EXTENDED_HORIZON = timedelta(days=21)
# (age of the entry at which the step ends, delay before the next ask), by the entry's age since first sight.
RETRY_STEPS = ((12 * 3600, 3600), (48 * 3600, 3 * 3600), (7 * 86400, 8 * 3600))
RETRY_LAST_S = 24 * 3600
# PubMed publication types of something that has no abstract to wait for.
NON_RESEARCH_TYPES = frozenset({
    "editorial", "letter", "comment", "news", "newspaper article", "published erratum", "retraction notice",
    "video-audio media", "interview", "biography", "portrait", "historical article", "personal narrative",
    "introductory journal article", "webcast", "lecture", "address", "patient education handout",
})
# The citation states of a PubMed record that is final: it has no abstract and will not get one.
COMPLETE_CITATION_STATUSES = frozenset({"medline", "pubmed-not-medline"})


def known_types(row: dict, *extra: Iterable[str] | None) -> set[str]:
    """The PubMed publication types the entry is known to carry (its stored ones and ``extra``), lower-cased."""
    found: set[str] = set()
    for source in (row.get("known_publication_types"), *extra):
        if isinstance(source, (list, tuple, set, frozenset)):
            found.update(str(item).strip().lower() for item in source if isinstance(item, str))
    return found


def is_primary_candidate(row: dict, *extra_types: Iterable[str] | None) -> bool:
    """A top journal's entry that may be a research paper still waiting for its abstract (module docstring)."""
    try:
        authority = int(row.get("source_authority") or 0)
    except (TypeError, ValueError):
        return False
    if row.get("source_type") != "journal" or authority < MIN_AUTHORITY or not (row.get("doi") or row.get("pmid")):
        return False
    return not (known_types(row, *extra_types) & NON_RESEARCH_TYPES)


def horizon(row: dict, default: timedelta, *extra_types: Iterable[str] | None) -> timedelta:
    """How long after first sight the entry is asked: ``EXTENDED_HORIZON`` for a candidate, else ``default``."""
    return max(default, EXTENDED_HORIZON) if is_primary_candidate(row, *extra_types) else default


def retry_delay_s(age_s: float) -> int:
    """Seconds before a candidate is asked again, by its age: hourly on the first half day, every 3 hours to the
    second day, every 8 hours to the end of the first week, daily after it."""
    for until, delay in RETRY_STEPS:
        if age_s < until:
            return delay
    return RETRY_LAST_S


__all__ = ["COMPLETE_CITATION_STATUSES", "EXTENDED_HORIZON", "MIN_AUTHORITY", "NON_RESEARCH_TYPES", "horizon",
           "is_primary_candidate", "known_types", "retry_delay_s"]
