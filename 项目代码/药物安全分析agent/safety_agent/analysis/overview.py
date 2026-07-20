"""Case-overview aggregation: FAERS profile counts for the target drug.

All numbers come from openFDA count queries; nothing is estimated. The
layer fires the independent count queries concurrently (bounded by a
semaphore to stay polite with the openFDA rate limit) and records the
exact search strings for the traceability appendix.
"""

from __future__ import annotations

import asyncio
from datetime import date
import re

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

    async def build(
        self,
        drug_search: str,
        drug_name: str,
        drug_aliases: tuple[str, ...] = (),
    ) -> CaseOverview:
        total = await self._count(drug_search)
        yearly, sex, age, outcomes, countries, concomitant, indications = (
            await asyncio.gather(
                self._yearly(drug_search),
                self._sex(drug_search, total),
                self._age(drug_search, total),
                self._outcomes(drug_search),
                self._countries(drug_search, total),
                self._concomitant_drugs(
                    drug_search, drug_name, drug_aliases=drug_aliases
                ),
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

    async def _sex(self, drug_search: str, total: int) -> list[CountBucket]:
        buckets = await self._count_terms("patient.patientsex", drug_search, 10)
        counts: dict[str, int] = {}
        for bucket in buckets:
            label = _SEX_LABELS.get(bucket.term, f"code {bucket.term}")
            counts[label] = counts.get(label, 0) + bucket.count
        missing = max(total - sum(counts.values()), 0)
        if missing:
            counts["not reported"] = counts.get("not reported", 0) + missing
        return [
            CountBucket(term=term, count=count)
            for term, count in sorted(counts.items(), key=lambda item: (-item[1], item[0]))
        ]

    async def _age(self, drug_search: str, total: int) -> list[CountBucket]:
        from safety_agent.openfda.queries import age_years_range_clause

        async def one(label: str, lo: int | None, hi: int | None) -> CountBucket:
            clause = age_years_range_clause(lo, hi)
            count = await self._count(f"({drug_search}) AND {clause}")
            return CountBucket(term=label, count=count)

        buckets = list(
            await asyncio.gather(*(one(label, lo, hi) for label, lo, hi in _AGE_BUCKETS))
        )
        missing = max(total - sum(bucket.count for bucket in buckets), 0)
        if missing:
            buckets.append(CountBucket(term="not reported", count=missing))
        return buckets

    async def _outcomes(self, drug_search: str) -> list[CountBucket]:
        async def one(outcome: str) -> CountBucket:
            count = await self._count(f"({drug_search}) AND {outcome_clause(outcome)}")
            return CountBucket(term=_OUTCOME_LABELS[outcome], count=count)

        return list(await asyncio.gather(*(one(o) for o in _OUTCOMES)))

    async def _countries(self, drug_search: str, total: int) -> list[CountBucket]:
        # occurcountry is an ES text field: aggregations need the .exact
        # keyword variant (plain occurcountry makes openFDA answer 500).
        # Keep the explicit missing bucket outside the top-10 ranking. Summing
        # an aggregation page is invalid because it can omit a long tail.
        buckets = await self._count_terms("occurcountry.exact", drug_search, 10)
        reported = await self._count(f"({drug_search}) AND occurcountry:*")
        missing = max(total - reported, 0)
        return [*buckets, CountBucket(term="not reported", count=missing)]

    async def _concomitant_drugs(
        self,
        drug_search: str,
        drug_name: str,
        *,
        drug_aliases: tuple[str, ...] = (),
    ) -> list[CountBucket]:
        buckets = await self._count_terms(FIELD_DRUG_EXACT, drug_search, 50)
        needles = {
            _normalized_product_name(value)
            for value in (drug_name, *drug_aliases)
            if value.strip()
        }
        # Drop generic, salt and brand spellings of the target itself.  The
        # live API still cannot bind the remaining product name to a C-role
        # array element; exact concomitant-role semantics require a frozen
        # report-level snapshot and remain explicitly labelled as such.
        filtered = [
            bucket
            for bucket in buckets
            if not _is_target_product(bucket.term, needles)
        ]
        return filtered[:10]

    async def _indications(self, drug_search: str) -> list[CountBucket]:
        return await self._count_terms("patient.drug.drugindication.exact", drug_search, 10)


def top_reactions_query(drug_search: str) -> str:
    """The count query behind the top-PT signal candidate list."""
    return f"{drug_search} [count {FIELD_REACTION_EXACT}]"


def _normalized_product_name(value: str) -> str:
    return " ".join(re.sub(r"[\W_]+", " ", value.casefold()).split())


def _is_target_product(candidate: str, needles: set[str]) -> bool:
    """Match exact names and salt/form suffixes without short substrings.

    The previous bidirectional substring rule treated a short alias such as
    ``at`` as matching unrelated products such as ``atorvastatin``. Product
    variants remain covered when one normalized name is a token-boundary
    prefix of the other and the shorter name is at least four characters.
    """
    product = _normalized_product_name(candidate)
    for needle in needles:
        if product == needle:
            return True
        shorter, longer = sorted((product, needle), key=len)
        if len(shorter) >= 4 and longer.startswith(shorter + " "):
            return True
    return False
