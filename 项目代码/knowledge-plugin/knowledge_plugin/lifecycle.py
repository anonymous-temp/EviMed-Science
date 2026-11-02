"""The source lifecycle: when a source is retired, when a trial is admitted, when a retired source comes back.

The rules are pure functions over facts the database already holds (``collect_facts`` reads them), so each one is a unit
test and the first run on production can be printed before it is applied (``python -m knowledge_plugin lifecycle``).

Retirement (any source: a file row, a medical-discovery feed, an AI request, a discovered source):

- **robots** — the source's own polls were refused by robots.txt twice in a row (``robots_disallow``). A robots.txt that
  could not be read is not a refusal (``robots.py`` keeps the last copy read).
- **forbidden** — 401 or 403 is what it has answered for seven days (the failure streak started at least seven days ago
  and its last answer is one of them).
- **silent** — nothing new for 90 days (owner, 2026-11-02: 「3个月没有更新再退役」), any source. It replaced a rule measured
  against each source's own rhythm, which retired BMJ Medicine and Google's health blog after 14 quiet days. A first contact
  delivers many keys on one day and counts as that one day. Official safety feeds are exempt: their silence is the good news.
- **off-topic** — the platform's own screen (``source_screening``, reported by the platform) judged more than half of
  what the source delivered not medical, and fewer than three entries in its window were medical. The second clause
  keeps a general journal (Nature: 9 medical of 122 in 14 days) and retires a general tech feed (3,261 screened, 40
  medical, at the cost of every screen).

Exempt from everything: a platform-produced source (the platform's own evidence feed). Exempt from all but robots: a
source an operator switched on (``operator_enabled``). A retired source keeps its row, entries and fetch history; a
re-check (``recheck_after``) that finds it permitted, readable and fresh again brings it back. Off-topic is never
re-checked automatically.

A trial (seven days at a low rate, as an ordinary registry row) is admitted when the source produced at least one new
entry after its first poll and the platform's screen judged no more than half of what it screened not medical. When the
platform has reported nothing for it, a source with a medical basis in data (a MEDLINE journal, a curated directory, a
request) is admitted on its own fetch results; one without waits up to seven more days for the platform's verdict and
then fails ``unjudged``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timedelta

SILENT_AFTER_DAYS = 90
FORBIDDEN_AFTER = timedelta(days=7)
ROBOTS_STREAK = 2
OFF_TOPIC_SHARE = 0.5
OFF_TOPIC_MIN_SCREENED = 5
OFF_TOPIC_MEDICAL_FLOOR = 3
SCREENING_FRESH = timedelta(days=3)
TRIAL_DAYS = 7
TRIAL_VERDICT_GRACE = timedelta(days=7)
# When a retired source is looked at again (``None``: only an operator brings it back).
RECHECK_AFTER = {"robots": timedelta(days=30), "forbidden": timedelta(days=7), "silent": timedelta(days=14),
                 "off-topic": None}
RETIREMENT_REASONS = tuple(RECHECK_AFTER)


@dataclass
class SourceFacts:
    """What the rules read about one source (``collect_facts`` builds it from the tables)."""

    id: str
    enabled: bool = True
    retired: bool = False
    operator_enabled: bool | None = None
    safety_feed: bool = False
    platform_produced: bool = False
    first_contact_at: datetime | None = None
    last_ok_at: datetime | None = None
    failing_since: datetime | None = None
    last_error_code: str | None = None
    consecutive_failures: int = 0
    new_days: list[date] = field(default_factory=list)      # days with a new key, the last ``SILENT_AFTER_DAYS`` and one
    screened: int | None = None                             # the platform's screen, when reported recently
    off_topic: int | None = None
    selected: int | None = None                             # items the platform selected (its 30 days), when reported


@dataclass
class Retirement:
    source_id: str
    reason: str
    evidence: dict


def retirement(facts: SourceFacts, now: datetime) -> Retirement | None:
    """The reason this source is retired now, or ``None`` (see the module docstring for each rule)."""
    if not facts.enabled or facts.retired or facts.platform_produced:
        return None
    code = facts.last_error_code or ""
    if code == "robots-denied:robots_disallow" and facts.consecutive_failures >= ROBOTS_STREAK:
        return Retirement(facts.id, "robots", {"consecutive_refusals": facts.consecutive_failures})
    if facts.operator_enabled is True:
        return None
    if (code in ("blocked:http_401", "blocked:http_403") and facts.failing_since is not None
            and now - facts.failing_since >= FORBIDDEN_AFTER):
        return Retirement(facts.id, "forbidden", {"answer": code.split(":", 1)[1],
                                                  "failing_since": facts.failing_since.isoformat()})
    if (facts.screened is not None and facts.off_topic is not None and facts.screened >= OFF_TOPIC_MIN_SCREENED
            and facts.off_topic / facts.screened > OFF_TOPIC_SHARE
            and facts.screened - facts.off_topic < OFF_TOPIC_MEDICAL_FLOOR and not facts.selected):
        return Retirement(facts.id, "off-topic", {"screened": facts.screened, "not_medical": facts.off_topic})
    if facts.safety_feed or facts.first_contact_at is None or facts.failing_since is not None:
        return None    # a failing source is quiet because it fails: its health says so, silence is not the reason
    today = now.date()
    quiet = (today - max(facts.new_days)).days if facts.new_days else (today - facts.first_contact_at.date()).days
    if quiet < SILENT_AFTER_DAYS:
        return None
    return Retirement(facts.id, "silent", {"quiet_days": quiet})


@dataclass
class TrialFacts:
    trial_until: datetime
    medical_basis: str | None
    ok_polls: int                    # polls that read the source during the trial
    new_entries: int                 # entries first seen after the first poll, not backfill
    screened: int | None = None      # the platform's screen, when reported recently
    off_topic: int | None = None


def trial_verdict(facts: TrialFacts, now: datetime) -> tuple[str, str | None]:
    """``("wait", None)`` while the trial runs; then ``admit``, ``reject`` (off-topic), ``fail`` with its reason, or
    ``extend`` (waiting for the platform's verdict on a source with no medical basis in data)."""
    if now < facts.trial_until:
        return "wait", None
    if facts.ok_polls == 0:
        return "fail", "unreadable"
    if facts.new_entries == 0:
        return "fail", "no_new_entry"
    if facts.screened:
        if (facts.off_topic or 0) / facts.screened > OFF_TOPIC_SHARE:
            return "reject", "off_topic"
        return "admit", "screened"
    if facts.medical_basis:
        return "admit", f"basis:{facts.medical_basis}"
    if now < facts.trial_until + TRIAL_VERDICT_GRACE:
        return "extend", "awaiting_screening"
    return "fail", "unjudged"


# ------------------------------------------------------------------------------------ database


async def screening_of(conn, now: datetime) -> dict[str, tuple[int, int, int | None]]:
    """The platform's recent verdicts: ``{source_id: (screened, off_topic, selected)}`` (``selected`` null when the
    platform did not say)."""
    rows = await (await conn.execute(
        "SELECT source_id, screened, off_topic, selected FROM evimed_knowledge.source_screening WHERE reported_at > %s",
        (now - SCREENING_FRESH,),
    )).fetchall()
    return {row["source_id"]: (row["screened"], row["off_topic"], row["selected"]) for row in rows}


async def collect_facts(conn, now: datetime) -> list[SourceFacts]:
    """Every source the lifecycle may judge (enabled, not retired), with its days of new keys and the platform's verdicts."""
    rows = await (await conn.execute(
        """SELECT id, enabled, retired_at, operator_enabled, safety_feed, platform_produced, first_contact_at, last_ok_at,
                  failing_since, last_error_code, consecutive_failures
             FROM evimed_knowledge.sources WHERE enabled AND retired_at IS NULL ORDER BY id""",
    )).fetchall()
    days = await (await conn.execute(
        """SELECT source_id, array_agg(DISTINCT (first_seen_at AT TIME ZONE 'UTC')::date) AS days
             FROM evimed_knowledge.seen_keys WHERE first_seen_at > %s GROUP BY source_id""",
        (now - timedelta(days=SILENT_AFTER_DAYS + 1),),
    )).fetchall()
    new_days = {row["source_id"]: list(row["days"] or []) for row in days}
    screening = await screening_of(conn, now)
    facts = []
    for row in rows:
        screened, off_topic, selected = screening.get(row["id"], (None, None, None))
        facts.append(SourceFacts(
            id=row["id"], enabled=row["enabled"], retired=row["retired_at"] is not None,
            operator_enabled=row["operator_enabled"], safety_feed=row["safety_feed"],
            platform_produced=bool(row["platform_produced"]), first_contact_at=row["first_contact_at"],
            last_ok_at=row["last_ok_at"], failing_since=row["failing_since"], last_error_code=row["last_error_code"],
            consecutive_failures=row["consecutive_failures"], new_days=new_days.get(row["id"], []),
            screened=screened, off_topic=off_topic, selected=selected))
    return facts


async def retirement_plan(conn, now: datetime) -> list[Retirement]:
    return [decision for facts in await collect_facts(conn, now) if (decision := retirement(facts, now))]


async def retired_ids(conn) -> set[str]:
    rows = await (await conn.execute("SELECT source_id FROM evimed_knowledge.source_lifecycle")).fetchall()
    return {row["source_id"] for row in rows}
