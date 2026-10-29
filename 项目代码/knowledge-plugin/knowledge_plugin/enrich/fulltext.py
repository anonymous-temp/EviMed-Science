"""Open-access full text for ``/text``: Europe PMC's ``fullTextXML`` of a PMC article, read as ``jats.jats_text``.

``GET https://www.ebi.ac.uk/europepmc/webservices/rest/<PMCID>/fullTextXML`` answers the JATS document of an article in
Europe PMC's open-access subset (measured 2026-10-22: BMC Med Res Methodol PMC10905822, 373 KB, 200) and 404 for any
other PMCID (an author manuscript outside the subset, or a PMCID not yet loaded). The PMCID comes from PubMed's
``ArticleIdList``, Europe PMC's core record or OpenAlex's ``ids.pmcid``. The host is Europe PMC's search host, so the
reads share its budget (``budget.host_rules``: ``www.ebi.ac.uk``).
"""

from __future__ import annotations

import re
from typing import Any

from .common import Endpoints, Trace, get
from .jats import jats_text

_PMCID = re.compile(r"^PMC[0-9]{1,10}$")


def fulltext_url(endpoints: Endpoints, pmcid: str) -> str:
    return f"{endpoints.europepmc_rest}/{pmcid}/fullTextXML"


async def europepmc_fulltext(fetcher: Any, endpoints: Endpoints, pmcid: str | None,
                             trace: Trace) -> tuple[str | None, str | None]:
    """``(abstract, whole text)`` from Europe PMC's open-access XML; ``(None, None)`` when there is none."""
    pmcid = (pmcid or "").strip().upper()
    if not _PMCID.match(pmcid):
        return None, None
    attempt = await get(fetcher, fulltext_url(endpoints, pmcid))
    if attempt.result is None:
        if attempt.error is not None and attempt.error.status == 404:
            trace.notes.append("europepmc_fulltext_not_found")
        else:
            trace.record(attempt, "europepmc_fulltext")
        return None, None
    if attempt.result.status != 200:
        trace.notes.append(f"europepmc_fulltext_http_{attempt.result.status}")
        return None, None
    abstract, body = jats_text(attempt.result.body)
    if body is None:
        trace.notes.append("europepmc_fulltext_without_body")
    return abstract, body


__all__ = ["europepmc_fulltext", "fulltext_url"]
