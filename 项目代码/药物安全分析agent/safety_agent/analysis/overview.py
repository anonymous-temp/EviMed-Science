"""Case-overview aggregation: FAERS profile counts for the target drug.

All numbers come from openFDA count queries; nothing is estimated. The
layer fires the independent count queries concurrently (bounded by a
semaphore to stay polite with the openFDA rate limit) and records the
exact search strings for the traceability appendix.
"""

from __future__ import annotations

import asyncio
from datetime import date

from safety_agent.openfda.client import OpenFDAClient
from safety_agent.core.exceptions import NoResults
from safety_agent.openfda.queries import (
    FIELD_DRUG_EXACT,
    FIELD_REACTION_EXACT,
    outcome_clause,
)

from .models import CaseOverview, CountBucket

#: FAERS coverage starts in 2004.
_FIRST_FAERS_YEAR = 2004

_AGE_BUCKETS: tuple[tuple[str, int | None, int | None], ...] = (
    ("<18", None, 17),
    ("18-44", 18, 44),
    ("45-64", 45, 64),
    ("65-74", 65, 74),
    ("75+", 75, None),
)

_OUTCOMES: tuple[str, ...] = (
    "death",
    "life_threatening",
    "hospitalization",
    "disabling",
    "congenital_anomaly",
    "other",
)

_SEX_LABELS = {"1": "male", "2": "female", "0": "not reported"}

_OUTCOME_LABELS = {
    "death": "death (死亡)",
    "life_threatening": "life-threatening (危及生命)",
    "hospitalization": "hospitalization (住院)",
    "disabling": "disability (致残)",
    "congenital_anomaly": "congenital anomaly (先天异常)",
    "other": "other serious (其他严重)",
}


class OverviewBuilder:
    """Runs the count queries behind :class:`CaseOverview`."""

    def __init__(self, client: OpenFDAClient, *, concurrency: int = 8) -> None:
        self._client = client
        self._sem = asyncio.Semaphore(concurrency)

    async def build(self, drug_search: str, drug_name: str) -> CaseOverview:
        total = await self._count(drug_search)
        yearly, sex, age, outcomes, countries, concomitant, indications = (
            await asyncio.gather(
                self._yearly(drug_search),
                self._sex(drug_search),
                self._age(drug_search),
                self._outcomes(drug_search),
                self._countries(drug_search),
                self._concomitant_drugs(drug_search, drug_name),
                self._indications(drug_search),
            )
        )
        return CaseOverview(
            total_reports=total,
            yearly=yearly,
            sex=sex,
            age_buckets=age,
            outcomes=outcomes,
            countries=countries,
            concomitant_drugs=concomitant,
            indications=indications,
        )

    # -- individual aggregations -------------------------------------------

    async def _count(self, search: str) -> int:
        async with self._sem:
            try:
                return await self._client.count_total(search)
            except NoResults:
                # An empty subgroup (most commonly a pre-launch year) is a
                # legitimate zero, not evidence that the drug has no data.
                return 0

    async def _count_terms(self, field: str, search: str, limit: int) -> list[CountBucket]:
        async with self._sem:
            try:
                terms = await self._client.count_terms(field, search, limit=limit)
            except NoResults:
                return []
        return [CountBucket(term=t.term, count=t.count) for t in terms]

    async def _yearly(self, drug_search: str) -> list[CountBucket]:
        this_year = date.today().year
        years = list(range(_FIRST_FAERS_YEAR, this_year + 1))

        async def one(year: int) -> CountBucket:
            clause = f"receivedate:[{year}0101 TO {year}1231]"
            count = await self._count(f"({drug_search}) AND {clause}")
            return CountBucket(term=str(year), count=count)

        return list(await asyncio.gather(*(one(y) for y in years)))

    async def _sex(self, drug_search: str) -> list[CountBucket]:
        buckets = await self._count_terms("patient.patientsex", drug_search, 10)
        return [
            CountBucket(term=_SEX_LABELS.get(b.term, f"code {b.term}"), count=b.count)
            for b in buckets
        ]

    async def _age(self, drug_search: str) -> list[CountBucket]:
        from safety_agent.openfda.queries import age_range_clause

        async def one(label: str, lo: int | None, hi: int | None) -> CountBucket:
            clause = age_range_clause(lo, hi)
            count = await self._count(f"({drug_search}) AND {clause}")
            return CountBucket(term=label, count=count)

        return list(
            await asyncio.gather(*(one(label, lo, hi) for label, lo, hi in _AGE_BUCKETS))
        )

    async def _outcomes(self, drug_search: str) -> list[CountBucket]:
        async def one(outcome: str) -> CountBucket:
            count = await self._count(f"({drug_search}) AND {outcome_clause(outcome)}")
            return CountBucket(term=_OUTCOME_LABELS[outcome], count=count)

        return list(await asyncio.gather(*(one(o) for o in _OUTCOMES)))

    async def _countries(self, drug_search: str) -> list[CountBucket]:
        # occurcountry is an ES text field: aggregations need the .exact
        # keyword variant (plain occurcountry makes openFDA answer 500).
        return await self._count_terms("occurcountry.exact", drug_search, 10)

    async def _concomitant_drugs(self, drug_search: str, drug_name: str) -> list[CountBucket]:
        buckets = await self._count_terms(FIELD_DRUG_EXACT, drug_search, 50)
        needle = drug_name.strip().lower()
        # Drop the target drug itself (incl. salt/brand spellings containing it).
        filtered = [b for b in buckets if needle not in b.term.strip().lower()]
        return filtered[:10]

    async def _indications(self, drug_search: str) -> list[CountBucket]:
        return await self._count_terms("patient.drug.drugindication.exact", drug_search, 10)


def top_reactions_query(drug_search: str) -> str:
    """The count query behind the top-PT signal candidate list."""
    return f"{drug_search} [count {FIELD_REACTION_EXACT}]"
