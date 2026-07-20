"""2x2 contingency tables for FAERS disproportionality analysis.

Cell convention (standard in pharmacovigilance, same as the OpenScience
evimed-research connector):

                target ADR    all other ADRs
    target drug      a              b
    all other drugs  c              d

The four cells come from four openFDA count queries (joint, drug, event,
grand total) with ``b = drug_total - a``, ``c = event_total - a`` and
``d = N - a - b - c``.
"""

from __future__ import annotations

import asyncio
import math
from dataclasses import dataclass

#: Haldane-Anscombe correction applied to every cell when any cell is 0,
#: so ratio statistics stay defined (documented in disproportionality.py).
HALDANE_ANSCOMBE = 0.5


@dataclass(frozen=True)
class ContingencyTable2x2:
    a: float
    b: float
    c: float
    d: float

    def __post_init__(self) -> None:
        for name in ("a", "b", "c", "d"):
            value = getattr(self, name)
            if not math.isfinite(value) or value < 0:
                raise ValueError(f"cell {name} must be finite and >= 0, got {value}")

    @property
    def n(self) -> float:
        """Grand total N = a + b + c + d."""
        return self.a + self.b + self.c + self.d

    @property
    def needs_correction(self) -> bool:
        return self.a == 0 or self.b == 0 or self.c == 0 or self.d == 0

    def corrected(self, increment: float = HALDANE_ANSCOMBE) -> "ContingencyTable2x2":
        """Haldane-Anscombe corrected copy (adds 0.5 to every cell)."""
        return ContingencyTable2x2(
            a=self.a + increment,
            b=self.b + increment,
            c=self.c + increment,
            d=self.d + increment,
        )


def build_table_from_counts(
    joint: int,
    drug_total: int,
    event_total: int,
    grand_total: int,
) -> ContingencyTable2x2:
    """Assemble a 2x2 table from openFDA count-query results.

    Raises ValueError on inconsistent inputs instead of silently clamping:
    a drug-event joint count cannot exceed either marginal, and the grand
    total must cover a + b + c.
    """
    for name, value in (
        ("joint", joint),
        ("drug_total", drug_total),
        ("event_total", event_total),
        ("grand_total", grand_total),
    ):
        if not isinstance(value, int) or value < 0:
            raise ValueError(f"{name} must be a non-negative int, got {value!r}")
    if joint > drug_total:
        raise ValueError(
            f"inconsistent counts: joint ({joint}) > drug_total ({drug_total})"
        )
    if joint > event_total:
        raise ValueError(
            f"inconsistent counts: joint ({joint}) > event_total ({event_total})"
        )
    a, b, c = joint, drug_total - joint, event_total - joint
    d = grand_total - a - b - c
    if d < 0:
        raise ValueError(
            "inconsistent counts: grand_total "
            f"({grand_total}) < a+b+c ({a + b + c}); the four count queries "
            "must share the same scoping filters"
        )
    return ContingencyTable2x2(a=float(a), b=float(b), c=float(c), d=float(d))


async def fetch_contingency_table(
    client: "object",
    drug_search: str,
    reaction_search: str,
    *,
    scope_search: str | None = None,
) -> ContingencyTable2x2:
    """Fetch the four openFDA counts concurrently and build the table.

    ``scope_search`` (optional extra clauses, e.g. a date range) is ANDed
    into every query so all four counts share one universe; when omitted,
    the grand total is the whole FAERS database. ``client`` is an
    OpenFDAClient (typed loosely to keep signals importable without httpx).
    """
    def scoped(search: str) -> str:
        return f"({search}) AND ({scope_search})" if scope_search else search

    joint_q = f"({drug_search}) AND ({reaction_search})"
    joint, drug_total, event_total, grand_total = await asyncio.gather(
        client.count_total(scoped(joint_q)),
        client.count_total(scoped(drug_search)),
        client.count_total(scoped(reaction_search)),
        client.count_total(scope_search),
    )
    return build_table_from_counts(joint, drug_total, event_total, grand_total)
