"""X's line of automatic source discovery (c2-gplug 2026-10-25, review G7): accounts quoted in what we already read,
validated through SocialData, then the ordinary seven-day trial (``discovery.py``, ``lifecycle.py``).

The ``social`` line collects X candidates (``discovery_lines.social``: the author of a quoted post, key ``x:<handle>``), and
until now every one of them waited — 43 sat in ``adapter_unavailable:x`` for three days and the validated count was zero.
SocialData is live and a user lookup costs one object, so an X candidate is validated like a WeChat one, with the same
protocol ``tools/verify_x_accounts.py`` applied to the seed list on 2026-10-22:

1. **The handle** is a closed format (1–15 letters, digits or underscores). A candidate that is only a display name is not
   asked about.
2. **One user lookup** (``GET /twitter/user/<handle>``, one object): the account exists, is public, answers to that handle
   and is not one we already read (by handle or by user id, retired sources included).
3. **One page of its recent posts** (``from:<handle> -filter:replies since:<30 days ago>``, at most 20 objects): the
   account posted something of its own — not a retweet, by its own user id — dated within 30 days. A date comparison, not a
   judgement of content.
4. **The trial row** is an ordinary X row (access ``socialdata``, mode ``signal``, an hourly read in a shared shard, priority
   of a new source), so the collector reads it like any listed account and the lifecycle admits or drops it on the
   platform's screen of what it delivered. Whether the account is medical is that screen's call, as for WeChat — nothing
   here reads a bio or a post for meaning.

The bound: at most ``VALIDATIONS_PER_DAY`` accounts a Shanghai day (counted in the provider ledger under the purposes
``discovery-user`` / ``discovery-search``, so a restart never resets it), and every call goes through the SocialData
client, so it is also held by the day's spend cap (``KNOWLEDGE_PLUGIN_SOCIALDATA_DAILY_USD``) and is booked at the
published ``objects × US$0.0002``. An account costs about US$0.004; twenty a day is about US$0.08.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from ..discovery import Verdict
from ..registry import RegistryError, parse_registry
from .providers import ProviderError
from .spend import SOCIALDATA, SpendCapReached
from .x import _HANDLE, _NOT_LANGUAGES, published

log = logging.getLogger("knowledge_plugin.social.x_discovery")

VALIDATIONS_PER_DAY = 20
USER_PURPOSE = "discovery-user"
SEARCH_PURPOSE = "discovery-search"
FRESH_DAYS = 30
BUSINESS_KINDS = frozenset({"business", "government"})     # what X itself states about an account (``verified_type``)


def handle_of(candidate: dict) -> str | None:
    """The handle an ``x:<handle>`` candidate names, or ``None`` when the key is anything else or not a handle."""
    key = candidate.get("key") or ""
    if not key.startswith("x:"):
        return None
    handle = key[2:].lstrip("@")
    return handle if _HANDLE.match(handle) else None


@dataclass
class KnownX:
    """The X accounts already read or on trial: lower-cased handles and user ids."""

    handles: set[str] = field(default_factory=set)
    user_ids: set[str] = field(default_factory=set)

    def add(self, *, handle: str | None = None, user_id: str | None = None) -> None:
        if isinstance(handle, str) and handle.strip():
            self.handles.add(handle.strip().lstrip("@").lower())
        if user_id not in (None, ""):
            self.user_ids.add(str(user_id))

    def has_handle(self, handle: str | None) -> bool:
        return bool(handle) and handle.lstrip("@").lower() in self.handles

    def has_user_id(self, user_id: str | None) -> bool:
        return user_id not in (None, "") and str(user_id) in self.user_ids


async def known_x_accounts(conn) -> KnownX:
    """Every X row in the source table (retired included: a retired account comes back by its re-check) and every X row on
    trial or admitted in the candidates."""
    known = KnownX()
    rows = await (await conn.execute("SELECT config FROM evimed_knowledge.sources WHERE access = 'socialdata'")).fetchall()
    candidates = await (await conn.execute(
        """SELECT row FROM evimed_knowledge.source_candidates
            WHERE row IS NOT NULL AND row->>'access' = 'socialdata'""")).fetchall()
    for config in [row["config"] or {} for row in rows] + [(c["row"].get("config") or {}) for c in candidates]:
        known.add(handle=config.get("handle"), user_id=config.get("user_id"))
    return known


def language_of(tweets: list[dict]) -> str:
    """The most common language X states for the account's own posts, ``en`` when it states none."""
    stated = Counter(str(t.get("lang") or "").lower() for t in tweets)
    for code, _ in stated.most_common():
        if code and code not in _NOT_LANGUAGES and len(code) <= 8:
            return code
    return "en"


def trial_row(user: dict, handle: str, tweets: list[dict], line: str) -> dict:
    """The registry row of a discovered account on trial: an ordinary X row read hourly in a shared shard."""
    user_id = str(user["id_str"])
    name = str(user.get("name") or handle).strip() or handle
    role = "organisation" if str(user.get("verified_type") or "").lower() in BUSINESS_KINDS else "person"
    return {
        "id": "discovered-x-" + hashlib.sha256(user_id.encode("utf-8")).hexdigest()[:20],
        "name": f"{name}（X @{handle}）"[:160], "homepage": f"https://x.com/{handle}", "lane": "mixed", "source_type": "media",
        "access": "socialdata", "egress": "api", "authority": 2, "safety_feed": False, "owner_entity": name[:200],
        "launch_tier": "P2", "language": language_of(tweets), "poll_floor_s": 3600, "poll_ceiling_s": 7200, "enabled": True,
        "disabled_reason": None, "category": f"x-discovered-{line}",
        "config": {"url": f"https://x.com/{handle}", "handle": handle, "user_id": user_id, "mode": "signal", "role": role},
    }


class XValidator:
    """Validates ``x:`` candidates (module docstring). Serialized, at most ``VALIDATIONS_PER_DAY`` a Shanghai day."""

    def __init__(self, socialdata, ledger, clock, known: KnownX, *, per_day: int = VALIDATIONS_PER_DAY) -> None:
        self.socialdata = socialdata
        self.ledger = ledger
        self.clock = clock
        self.known = known
        self.per_day = per_day
        self._lock = asyncio.Lock()

    async def validate(self, candidate: dict) -> Verdict:
        handle = handle_of(candidate)
        if handle is None:
            return Verdict("failed", "x_key_invalid")
        if self.known.has_handle(handle):
            return Verdict("failed", "known")
        if not self.socialdata.configured:
            return Verdict("deferred", "adapter_unavailable:x")
        async with self._lock:
            now = self.clock()
            if await self.ledger.calls_today(SOCIALDATA, USER_PURPOSE, now) >= self.per_day:
                return Verdict("deferred", "x_validation_budget")
            try:
                user = await self.socialdata.user(handle, purpose=USER_PURPOSE)
                gate = self.gate(user, handle)
                if gate is not None:
                    return gate
                since = (now - timedelta(days=FRESH_DAYS)).date().isoformat()
                tweets, _ = await self.socialdata.search(f"from:{user.get('screen_name') or handle} -filter:replies since:{since}",
                                                         purpose=SEARCH_PURPOSE)
            except SpendCapReached:
                return Verdict("deferred", "socialdata_daily_cap")
            except ProviderError as error:
                return Verdict("deferred", f"socialdata_{error.kind}")
        return self.judge(candidate, user, handle, tweets, now)

    def gate(self, user: dict | None, handle: str) -> Verdict | None:
        """What the user lookup alone settles: no such account, a private one, another handle, one we already read."""
        if not user or not user.get("id_str"):
            return Verdict("failed", "x_not_found")
        validation = {"user_id": str(user["id_str"]), "screen_name": str(user.get("screen_name") or "")[:40]}
        if user.get("protected"):
            return Verdict("failed", "x_protected", validation=validation)
        if str(user.get("screen_name") or handle).lower() != handle.lower():
            return Verdict("failed", "x_handle_mismatch", validation=validation)
        if self.known.has_user_id(user["id_str"]):
            return Verdict("failed", "known", validation=validation)
        return None

    def judge(self, candidate: dict, user: dict, handle: str, tweets: list[dict], now: datetime) -> Verdict:
        user_id = str(user["id_str"])
        own = [t for t in tweets if not t.get("retweeted_status") and str((t.get("user") or {}).get("id_str")) == user_id]
        dated = sorted((d for d in (published(t) for t in own) if d), reverse=True)
        validation = {"user_id": user_id, "followers": user.get("followers_count"), "posts_on_page": len(own)}
        fresh = [d for d in dated if d >= now - timedelta(days=FRESH_DAYS)]
        if not fresh:
            return Verdict("failed", "no_fresh_items", validation={**validation, "only_retweets": bool(tweets and not own),
                                                                    "newest": dated[0].isoformat() if dated else None})
        row = trial_row(user, handle, own, candidate["line"])
        try:
            parse_registry({"sources": [row]})
        except RegistryError as error:
            return Verdict("failed", f"row_invalid:{error.problems[0][:80]}", validation=validation)
        self.known.add(handle=handle, user_id=user_id)
        validation.update(fresh=len(fresh), newest=fresh[0].isoformat())
        return Verdict("trial", None, row, validation, candidate.get("medical_basis"))
