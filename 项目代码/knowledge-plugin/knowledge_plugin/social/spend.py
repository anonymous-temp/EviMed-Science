"""What the paid providers cost, per call, and the daily caps that stop them (contract 1.5.0, ``Health.providers``).

Every call to SocialData (X), Dajiala (WeChat) and the GEO social crawler is one ``provider_calls`` row, written after the
answer with what the provider says it cost — Dajiala's own ``cost_money``, SocialData's ``objects × US$0.0002`` (its
published price per returned object), one request for the crawler, whose cost is the GEO module's capacity rather than
money. A cap is a sum over the current **Asia/Shanghai** calendar day (the day the owner's balance and the platform's
frontier budget are kept in); before a call the caller asks ``check`` with the call's largest possible cost, and a call
that would pass the cap is not made: ``SpendCapReached`` names the next day's start, and that adapter waits until then.
Nothing else stops — the other adapters, the stream and the rest of the crawler go on.

``/v1/health`` reads the last 24 h of the same table (``providers``): calls, spend, what the provider says is left (Dajiala's
``remain_money``; the crawler's requests left today), and the last error. Rows are kept 30 days.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, time, timedelta, timezone
from decimal import Decimal

try:
    from zoneinfo import ZoneInfo

    SHANGHAI = ZoneInfo("Asia/Shanghai")
except Exception:  # pragma: no cover - an image without tzdata: China keeps no daylight time, so the offset is the zone
    SHANGHAI = timezone(timedelta(hours=8))

SOCIALDATA = "socialdata"
DAJIALA = "dajiala"
SOCIAL_CRAWL = "geo-social-crawl"
CURRENCIES = {SOCIALDATA: "USD", DAJIALA: "CNY", SOCIAL_CRAWL: "requests"}
OUTCOMES = ("ok", "missing", "refused", "rate-limited", "balance", "failed")
RETENTION = timedelta(days=30)


class SpendCapReached(Exception):
    """A call would pass its provider's daily cap; ``retry_at`` is the start of the next Shanghai day."""

    def __init__(self, provider: str, retry_at: datetime) -> None:
        super().__init__(f"{provider}: daily cap reached")
        self.provider = provider
        self.retry_at = retry_at


def day_window(now: datetime) -> tuple[datetime, datetime]:
    """The current Asia/Shanghai calendar day as UTC instants ``[start, end)``."""
    local = now.astimezone(SHANGHAI)
    start = datetime.combine(local.date(), time.min, tzinfo=SHANGHAI)
    return start.astimezone(timezone.utc), (start + timedelta(days=1)).astimezone(timezone.utc)


@dataclass(frozen=True)
class Cap:
    provider: str
    amount: float           # in the provider's currency (CURRENCIES); requests for the crawler


class ProviderLedger:
    def __init__(self, pool, clock) -> None:
        self._pool = pool
        self._clock = clock

    async def spent_today(self, provider: str, now: datetime | None = None) -> float:
        start, _ = day_window(now or self._clock())
        async with self._pool.connection() as conn:
            row = await (await conn.execute(
                """SELECT coalesce(sum(amount), 0) AS amount FROM evimed_knowledge.provider_calls
                    WHERE provider = %s AND called_at >= %s""", (provider, start))).fetchone()
        return float(row["amount"])

    async def check(self, cap: Cap, estimate: float, now: datetime | None = None) -> None:
        """Raise ``SpendCapReached`` when ``estimate`` more would pass the cap today."""
        now = now or self._clock()
        if await self.spent_today(cap.provider, now) + estimate > cap.amount + 1e-9:
            raise SpendCapReached(cap.provider, day_window(now)[1])

    async def record(self, provider: str, *, purpose: str, outcome: str, objects: int = 0, amount: float = 0.0,
                     remaining: float | None = None, error: str | None = None, now: datetime | None = None) -> None:
        async with self._pool.connection() as conn:
            await conn.execute(
                """INSERT INTO evimed_knowledge.provider_calls
                     (provider, called_at, purpose, outcome, objects, amount, currency, remaining, error)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                (provider, now or self._clock(), purpose[:60], outcome if outcome in OUTCOMES else "failed",
                 max(0, int(objects)), Decimal(str(round(max(0.0, amount), 6))), CURRENCIES[provider],
                 None if remaining is None else Decimal(str(round(remaining, 4))), (error or None) and error[:200]),
            )

    async def health(self, caps: dict[str, Cap], now: datetime | None = None) -> list[dict]:
        """``Health.providers``: one row per provider that has a cap configured or a call in the last 24 h."""
        now = now or self._clock()
        start, _ = day_window(now)
        async with self._pool.connection() as conn:
            rows = await (await conn.execute(
                """SELECT provider, count(*) FILTER (WHERE called_at > %(since)s) AS calls,
                          coalesce(sum(amount) FILTER (WHERE called_at > %(since)s), 0) AS spent,
                          coalesce(sum(amount) FILTER (WHERE called_at >= %(day)s), 0) AS today,
                          (array_agg(remaining ORDER BY called_at DESC) FILTER (WHERE remaining IS NOT NULL))[1] AS remaining,
                          (array_agg(coalesce(error, outcome) ORDER BY called_at DESC)
                             FILTER (WHERE outcome NOT IN ('ok', 'missing') AND called_at > %(since)s))[1] AS last_error
                     FROM evimed_knowledge.provider_calls WHERE called_at > %(oldest)s GROUP BY provider""",
                {"since": now - timedelta(hours=24), "day": start, "oldest": min(start, now - timedelta(hours=24))},
            )).fetchall()
        seen = {row["provider"]: row for row in rows}
        out: list[dict] = []
        for name in sorted(set(seen) | set(caps)):
            if name not in CURRENCIES:
                continue
            row = seen.get(name) or {"calls": 0, "spent": 0, "today": 0, "remaining": None, "last_error": None}
            currency = CURRENCIES[name]
            entry: dict = {"name": name, "calls_24h": int(row["calls"]),
                           "spend_24h": {"amount": _money(row["spent"]), "currency": currency},
                           "spend_today": {"amount": _money(row["today"]), "currency": currency}}
            cap = caps.get(name)
            if cap is not None:
                entry["daily_cap"] = {"amount": _money(cap.amount), "currency": currency}
            if name == SOCIAL_CRAWL and cap is not None:
                entry["remaining"] = {"amount": max(0, int(cap.amount) - int(row["today"])), "currency": currency}
            elif row["remaining"] is not None:
                entry["remaining"] = {"amount": _money(row["remaining"]), "currency": currency}
            if row["last_error"]:
                entry["last_error"] = str(row["last_error"])[:200]
            out.append(entry)
        return out

    async def purge(self, now: datetime | None = None) -> int:
        async with self._pool.connection() as conn:
            result = await conn.execute("DELETE FROM evimed_knowledge.provider_calls WHERE called_at < %s",
                                        ((now or self._clock()) - RETENTION,))
        return result.rowcount or 0


def _money(value) -> float:
    return float(round(Decimal(value), 4))


def caps_from(settings) -> dict[str, Cap]:
    """The caps of the providers this deployment configured (a provider without its key or address has none)."""
    caps: dict[str, Cap] = {}
    if settings.secret("socialdata_key"):
        caps[SOCIALDATA] = Cap(SOCIALDATA, float(settings.socialdata_daily_usd))
    if settings.secret("dajiala_key"):
        caps[DAJIALA] = Cap(DAJIALA, float(settings.dajiala_daily_cny))
    if settings.social_crawl_url:
        caps[SOCIAL_CRAWL] = Cap(SOCIAL_CRAWL, float(settings.social_crawl_daily))
    return caps
