"""The scheduling rules as pure functions (plan 10.2.2, 10.2.8): when to poll next, how fast to back
off, what state a source's health is in. Pure so each rule is a unit test, not an integration run.

- **Spread, not queue.** A source's regular polls land on a fixed phase inside its interval, taken
  from the hash of its id: 154 journals on a 3-hour cadence arrive about 70 s apart instead of
  together, and the shared Crossref bucket never builds a queue. The platform's own limiter reports
  "host busy" after 15 s of waiting, which is why queueing would read as mass failure.
- **Adaptive cadence.** Three successful polls in a row without a new entry stretch the interval by
  1.5 up to the source's ceiling; one new entry snaps it back to the floor. A weekly journal speeds
  up on issue day, a dormant blog slows down, nobody maintains it.
- **Failure backoff.** 2^n from a base of min(floor, 30 min), capped at 6 hours; three days in a
  failure streak is ``unreadable``. A refusal by the plugin's own budget (daily cap, paused host)
  is not the source's failure and moves nothing here.
- **Health** (four states plus new/disabled): ``degraded`` below 80 % success over 24 h,
  ``unreadable`` after three days of failures, ``drifted`` when a list that used to have items
  parses to nothing twice in a row or its dates vanish twice in a row (a redesign broke the
  selectors — the main maintenance cost of list pages).
"""

from __future__ import annotations

import hashlib
import math
from datetime import datetime, timedelta, timezone

UNREADABLE_AFTER = timedelta(days=3)
DEGRADED_BELOW = 0.8
BACKOFF_CAP_S = 6 * 3600
BACKOFF_BASE_MAX_S = 1800
EMPTY_POLLS_BEFORE_SLOWDOWN = 3
SLOWDOWN_FACTOR = 1.5
DRIFT_STREAK = 2
FULL_RESCAN_EVERY = timedelta(hours=24)

# List-shaped reads always show their latest items, so "zero items" means the parser broke.
# Windowed API queries legitimately return nothing on a quiet day and never drift.
DRIFT_ACCESSES = frozenset({"html-list", "browser-list", "rss", "atom"})
API_ACCESSES = frozenset({"crossref-issn", "eutils-query", "europepmc", "json-api", "evimed-api"})


def phase_of(source_id: str, interval_s: int) -> int:
    return int(hashlib.sha256(source_id.encode("utf-8")).hexdigest()[:12], 16) % max(1, interval_s)


def next_slot(source_id: str, interval_s: int, now: datetime) -> datetime:
    """The first time ``t >= now + interval/2`` with ``t ≡ phase(source) (mod interval)``."""
    interval_s = max(1, int(interval_s))
    phase = phase_of(source_id, interval_s)
    earliest = now.timestamp() + interval_s / 2
    k = math.ceil((earliest - phase) / interval_s)
    return datetime.fromtimestamp(k * interval_s + phase, tz=timezone.utc)


def adapt_interval(interval_s: int, floor_s: int, ceiling_s: int, new_entries: int, empty_polls: int) -> tuple[int, int]:
    """(next interval, next empty-poll count) after a successful poll."""
    if new_entries > 0:
        return floor_s, 0
    empty_polls += 1
    if empty_polls >= EMPTY_POLLS_BEFORE_SLOWDOWN:
        return min(ceiling_s, max(floor_s, int(interval_s * SLOWDOWN_FACTOR))), 0
    return max(floor_s, min(interval_s, ceiling_s)), empty_polls


def failure_delay_s(floor_s: int, failures: int) -> int:
    """Seconds until the next attempt after ``failures`` consecutive failures (``failures >= 1``)."""
    base = min(max(300, floor_s), BACKOFF_BASE_MAX_S)
    return int(min(base * (2 ** max(0, failures - 1)), BACKOFF_CAP_S))


def is_drifted(access: str, last_nonempty_at: datetime | None, zero_streak: int, ever_dated: bool, undated_streak: int) -> bool:
    if access not in DRIFT_ACCESSES:
        return False
    return (last_nonempty_at is not None and zero_streak >= DRIFT_STREAK) or (ever_dated and undated_streak >= DRIFT_STREAK)


def health_state(*, enabled: bool, last_ok_at: datetime | None, failing_since: datetime | None, now: datetime,
                 success_rate_24h: float | None, drifted: bool) -> str:
    if not enabled:
        return "disabled"
    if failing_since is not None and now - failing_since >= UNREADABLE_AFTER:
        return "unreadable"
    if drifted:
        return "drifted"
    if last_ok_at is None:
        return "new" if failing_since is None else "degraded"
    if success_rate_24h is not None and success_rate_24h < DEGRADED_BELOW:
        return "degraded"
    return "healthy"


def priority(*, safety_feed: bool, source_type: str, access: str) -> int:
    """Claim order when several sources are due: 0 is read first (plan 10.2.2 "优先级")."""
    if safety_feed or source_type == "regulator":
        return 0
    if source_type in ("journal", "preprint") or access in API_ACCESSES:
        return 1
    if source_type in ("media", "company"):
        return 2
    return 3


def wants_full_rescan(config: dict, last_full_scan_at: datetime | None, now: datetime) -> bool:
    """Incremental queries re-read their whole look-back window once a day (plan 10.2.2)."""
    if not config.get("incremental"):
        return False
    return last_full_scan_at is None or now - last_full_scan_at >= FULL_RESCAN_EVERY


def next_utc_midnight(now: datetime) -> datetime:
    return datetime(now.year, now.month, now.day, tzinfo=timezone.utc) + timedelta(days=1)


FULL_WALK_RETRY_AFTER = timedelta(hours=24)


def wants_full_walk(config: dict, last_full_scan_at: datetime | None, last_full_attempt_at: datetime | None,
                    now: datetime) -> bool:
    """A periodic deep walk (``config.full_walk_every_s``) with its own request cap.

    For lists that cannot be read incrementally — the STAR guideline ratings are ordered by rating,
    not date, so a new rating is only found by walking all ~152 pages. The regular poll stays capped
    at ``max_pages``; the walk runs when the last completed one is older than its period, and a walk
    that failed is not retried within 24 hours, so a failing upstream costs one walk a day at most.
    """
    every = config.get("full_walk_every_s")
    if not every:
        return False
    if last_full_scan_at is not None and now - last_full_scan_at < timedelta(seconds=int(every)):
        return False
    if last_full_attempt_at is not None and now - last_full_attempt_at < FULL_WALK_RETRY_AFTER:
        return False
    return True
