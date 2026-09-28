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
- **Transient failures are re-sent inside the poll.** A timeout, a 5xx without ``Retry-After``, a
  dropped connection or PubMed's ``esearchresult.ERROR`` is re-sent up to twice per poll, 1.5–4.5 s
  and then 3–9 s later (jittered), before the poll counts as failed. Each re-send is a request in the
  fetch log, and a poll that got through on one names what it met in its ``error_detail``
  (``retried:http_500``). A long outage still fails the poll: this cures blips, not outages.
- **Health** (four states plus new/disabled): ``unreadable`` after three days of failures;
  ``drifted`` when a list that used to have items parses to nothing twice in a row or its dates
  vanish twice in a row (a redesign broke the selectors — the main maintenance cost of list pages);
  ``degraded`` while the source is failing now, or when over 24 h it failed in two or more separate
  episodes and fewer than 80 % of (successful polls + failure episodes) were successes. A streak of
  failed polls is one episode: backoff re-polls a failing source every 30 min to 6 h while a healthy
  one waits its 3–24 h cadence, so counting polls made one four-hour upstream outage outweigh a day
  of successes and held a recovered source ``degraded`` for the rest of the 24 h (13 PubMed streams
  after NCBI's outage of 2026-09-27 02:30–06:20Z). Polls the plugin itself declined (its budget, an
  exit or key this deployment lacks) are neither. The rule is re-applied hourly, so a state never
  waits for the next poll of a source on a daily cadence to catch up with the window.
"""

from __future__ import annotations

import hashlib
import math
from datetime import datetime, timedelta, timezone
from typing import Iterable

from .model import SUCCESS_OUTCOMES

UNREADABLE_AFTER = timedelta(days=3)
DEGRADED_BELOW = 0.8
FLAPPING_EPISODES = 2
TRANSIENT_RETRIES = 2
TRANSIENT_RETRY_BASE_S = 3.0
TRANSIENT_RETRY_CAP_S = 20.0
# Failures of an ``http-error`` outcome a quick re-send can cure: the connection or the upstream
# hiccuped, nothing about the request is wrong (timeouts are their own outcome, always transient).
# PubMed answers a backend error as HTTP 200 with ``esearchresult.ERROR`` (``eutils_search_error``,
# 19 of the 36 PubMed failures of 2026-09-27).
TRANSIENT_DETAILS = frozenset({"connect_failed", "relay_upstream_unreachable", "transport_readerror",
                               "transport_writeerror", "transport_remoteprotocolerror", "transport_networkerror",
                               "navigation_failed", "navigation_interrupted", "eutils_search_error"})
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


def is_transient(outcome: str, detail: str, status: int | None, retry_after_s: float | None) -> bool:
    """A failure worth re-sending within the poll (see module docstring). An upstream that named a
    time to come back (429, 503 with ``Retry-After``) has paused the host instead; a refusal, a
    challenge, a 4xx or a parse error would answer the same again."""
    if retry_after_s is not None:
        return False
    if outcome == "timeout":
        return True
    if outcome != "http-error":
        return False
    if status is not None and 500 <= status <= 599 and status not in (501, 505):
        return True
    return detail in TRANSIENT_DETAILS


def transient_retry_delay_s(attempt: int, jitter: float) -> float:
    """Seconds before re-send ``attempt`` (1-based); ``jitter`` in [0, 1) spreads it over ±50 %."""
    base = min(TRANSIENT_RETRY_BASE_S * (2 ** max(0, attempt - 1)), TRANSIENT_RETRY_CAP_S)
    return base * (0.5 + min(max(jitter, 0.0), 1.0))


def reliability(outcomes: Iterable[str]) -> tuple[int, int]:
    """(successful polls, failure episodes) of polls in time order; a run of failures is one episode.
    The caller has already dropped the polls the plugin declined itself."""
    successes = episodes = 0
    failing = False
    for outcome in outcomes:
        if outcome in SUCCESS_OUTCOMES:
            successes += 1
            failing = False
        elif not failing:
            episodes += 1
            failing = True
    return successes, episodes


def health_state(*, enabled: bool, last_ok_at: datetime | None, failing_since: datetime | None, now: datetime,
                 successes_24h: int, failure_episodes_24h: int, drifted: bool) -> str:
    if not enabled:
        return "disabled"
    if failing_since is not None and now - failing_since >= UNREADABLE_AFTER:
        return "unreadable"
    if drifted:
        return "drifted"
    if last_ok_at is None:
        return "new" if failing_since is None else "degraded"
    if failing_since is not None:
        return "degraded"                      # failing now, after its in-poll retries
    if failure_episodes_24h >= FLAPPING_EPISODES:
        if successes_24h / (successes_24h + failure_episodes_24h) < DEGRADED_BELOW:
            return "degraded"                  # recovered, but it keeps falling over
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
