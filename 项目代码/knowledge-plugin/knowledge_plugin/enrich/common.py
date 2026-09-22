"""What the enrichment steps share: the endpoint table, the fetch wrapper, outcome classes.

An enrichment step either learns something, learns that there is nothing to learn, or could not
ask. Only the last one is a reason to try again later, so ``FetchError`` outcomes are split into
``TRANSIENT`` (timeout, 5xx/429 ``http-error``, the plugin's own ``host-budget``) and everything
else (challenge pages, robots, blocked hosts, 404s, unreadable bodies), which will not change by
waiting. Requests to the public APIs go out with no ``allowed_hosts``: they are the plugin's own
tools, not the source's hosts (the core's fetcher still pins DNS and refuses private addresses,
and injects the NCBI ``tool``/``email``/``api_key`` and the Unpaywall ``email`` per host).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ..model import FetchError, FetchResult, RequestSpec

TRANSIENT_OUTCOMES = frozenset({"timeout", "http-error", "host-budget"})


@dataclass(frozen=True)
class Endpoints:
    """Bases of the enrichment APIs; ``from_settings`` reads ``settings.enrichment`` when present."""

    pubmed_esearch: str = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi"
    pubmed_efetch: str = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi"
    europepmc_search: str = "https://www.ebi.ac.uk/europepmc/webservices/rest/search"
    crossref_works: str = "https://api.crossref.org/works"
    unpaywall: str = "https://api.unpaywall.org/v2"
    ctgov_studies: str = "https://clinicaltrials.gov/api/v2/studies"
    medrxiv_details: str = "https://api.medrxiv.org/details"
    evimed_literature: str = "https://www.evimed.com/api-evimed/medicine-api/ai-api/review/api/v2/literature-guide"
    evimed_instruction: str = "https://www.evimed.com/api-evimed/medicine-api/ai-api/review/api/instruction"

    @classmethod
    def from_settings(cls, settings: Any) -> "Endpoints":
        configured = getattr(settings, "enrichment", None)
        if configured is None:
            return cls()
        values = {name: getattr(configured, name) for name in cls.__dataclass_fields__
                  if isinstance(getattr(configured, name, None), str) and getattr(configured, name)}
        return cls(**values)


@dataclass
class Attempt:
    """The outcome of one enrichment request: a result, or the ``FetchError`` that stopped it."""

    result: FetchResult | None = None
    error: FetchError | None = None

    @property
    def transient(self) -> bool:
        return self.error is not None and self.error.outcome in TRANSIENT_OUTCOMES

    def note(self, step: str) -> str:
        if self.error is None:
            return f"{step}_ok"
        return f"{step}_{self.error.outcome}:{self.error.detail}"[:120]


@dataclass
class Trace:
    """Notes and the transient flag collected across the steps of one entry."""

    notes: list[str] = field(default_factory=list)
    transient: bool = False

    def record(self, attempt: Attempt, step: str) -> None:
        if attempt.error is not None:
            self.notes.append(attempt.note(step))
            self.transient = self.transient or attempt.transient


async def get(fetcher: Any, url: str, *, api: bool = True, source_id: str | None = None, egress: str = "direct",
              method: str = "GET", body: bytes | None = None, headers: dict | None = None) -> Attempt:
    """One request through the core's protected fetcher; a ``FetchError`` is returned, not raised."""
    spec = RequestSpec(url=url, method=method, body=body, headers=dict(headers or {}), conditional=False, api=api)
    try:
        result = await fetcher.fetch(spec, source_id=source_id, egress=egress)
    except FetchError as error:
        return Attempt(error=error)
    return Attempt(result=result)
