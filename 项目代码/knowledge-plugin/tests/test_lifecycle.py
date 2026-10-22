"""The source lifecycle's rules, as pure functions (fr-sources, 2026-10-22)."""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from knowledge_plugin.lifecycle import SourceFacts, TrialFacts, retirement, rhythm, rhythm_multiple, trial_verdict

NOW = datetime(2026, 10, 22, 6, 0, tzinfo=timezone.utc)
TODAY = NOW.date()


def days_ago(*ns: int) -> list[date]:
    return [TODAY - timedelta(days=n) for n in ns]


def facts(**overrides) -> SourceFacts:
    base = dict(id="s", first_contact_at=NOW - timedelta(days=40), last_ok_at=NOW - timedelta(hours=2),
                new_days=days_ago(1, 3, 5, 7))
    return SourceFacts(**{**base, **overrides})


def test_rhythm_reads_distinct_days_inside_the_window():
    r = rhythm(days_ago(1, 1, 8, 15, 22, 200), TODAY)
    assert (r.evidence_days, r.median_gap_days, r.quiet_days) == (4, 7.0, 1)
    assert rhythm([], TODAY).quiet_days is None
    assert rhythm_multiple(rhythm(days_ago(3, 10), TODAY)) is None            # two days: no rhythm to measure


def test_a_weekly_source_quiet_for_three_weeks_is_slow_not_silent():
    weekly = facts(new_days=days_ago(21, 28, 35, 42, 49))
    assert retirement(weekly, NOW) is None                                      # 21 / 7 = 3 times its gap
    gone = facts(new_days=days_ago(30, 37, 44, 51, 58))
    decision = retirement(gone, NOW)
    assert decision.reason == "silent" and decision.evidence["quiet_days"] == 30   # 30 / 7 > 4


def test_unmeasured_rhythm_waits_longer_for_a_curated_row():
    once = dict(new_days=days_ago(22), first_contact_at=NOW - timedelta(days=22))
    assert retirement(facts(**once), NOW).reason == "silent"                    # discovered: 14 days
    assert retirement(facts(curated=True, **once), NOW) is None                  # a file row: 60 days
    old = dict(new_days=[], first_contact_at=NOW - timedelta(days=61))
    assert retirement(facts(curated=True, **old), NOW).reason == "silent"


def test_silence_is_not_judged_for_young_failing_safety_or_operator_sources():
    quiet = dict(new_days=days_ago(30))
    assert retirement(facts(first_contact_at=NOW - timedelta(days=10), new_days=[]), NOW) is None
    assert retirement(facts(failing_since=NOW - timedelta(days=2), **quiet), NOW) is None
    assert retirement(facts(safety_feed=True, **quiet), NOW) is None
    assert retirement(facts(operator_enabled=True, **quiet), NOW) is None
    assert retirement(facts(platform_produced=True, **quiet), NOW) is None
    assert retirement(facts(**quiet), NOW).reason == "silent"


def test_robots_needs_two_refusals_in_a_row_and_beats_an_operator():
    one = facts(last_error_code="robots-denied:robots_disallow", consecutive_failures=1)
    assert retirement(one, NOW) is None
    two = facts(last_error_code="robots-denied:robots_disallow", consecutive_failures=2, operator_enabled=True)
    assert retirement(two, NOW).reason == "robots"
    unreadable = facts(last_error_code="robots-denied:robots_unreachable", consecutive_failures=9)
    assert retirement(unreadable, NOW) is None


def test_forbidden_after_seven_days_of_401_or_403():
    young = facts(last_error_code="blocked:http_403", failing_since=NOW - timedelta(days=6))
    assert retirement(young, NOW) is None
    old = facts(last_error_code="blocked:http_403", failing_since=NOW - timedelta(days=13))
    assert retirement(old, NOW).reason == "forbidden"
    other = facts(last_error_code="http-error:http_500", failing_since=NOW - timedelta(days=13))
    assert retirement(other, NOW) is None


def test_off_topic_keeps_a_general_journal_and_retires_a_general_feed():
    nature = facts(screened=122, off_topic=113)                                  # 9 medical in the window
    assert retirement(nature, NOW) is None
    tech = facts(screened=168, off_topic=166)
    assert retirement(tech, NOW).reason == "off-topic"
    few = facts(screened=4, off_topic=4)
    assert retirement(few, NOW) is None                                          # too few to judge


def trial(**overrides) -> TrialFacts:
    base = dict(trial_until=NOW - timedelta(hours=1), medical_basis=None, ok_polls=12, new_entries=3)
    return TrialFacts(**{**base, **overrides})


def test_trial_verdicts():
    assert trial_verdict(trial(trial_until=NOW + timedelta(days=2)), NOW) == ("wait", None)
    assert trial_verdict(trial(ok_polls=0), NOW) == ("fail", "unreadable")
    assert trial_verdict(trial(new_entries=0), NOW) == ("fail", "no_new_entry")
    assert trial_verdict(trial(screened=10, off_topic=6), NOW) == ("reject", "off_topic")
    assert trial_verdict(trial(screened=10, off_topic=5), NOW) == ("admit", "screened")
    assert trial_verdict(trial(medical_basis="nlm-catalog"), NOW) == ("admit", "basis:nlm-catalog")
    assert trial_verdict(trial(), NOW) == ("extend", "awaiting_screening")
    assert trial_verdict(trial(trial_until=NOW - timedelta(days=8)), NOW) == ("fail", "unjudged")
    assert trial_verdict(trial(screened=0, off_topic=0, medical_basis="directory"), NOW) == ("admit", "basis:directory")
