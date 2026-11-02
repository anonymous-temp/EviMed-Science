"""The source lifecycle's rules, as pure functions (fr-sources, 2026-10-22)."""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from knowledge_plugin.lifecycle import SourceFacts, TrialFacts, retirement, trial_verdict

NOW = datetime(2026, 10, 22, 6, 0, tzinfo=timezone.utc)
TODAY = NOW.date()


def days_ago(*ns: int) -> list[date]:
    return [TODAY - timedelta(days=n) for n in ns]


def facts(**overrides) -> SourceFacts:
    base = dict(id="s", first_contact_at=NOW - timedelta(days=40), last_ok_at=NOW - timedelta(hours=2),
                new_days=days_ago(1, 3, 5, 7))
    return SourceFacts(**{**base, **overrides})


def test_a_source_is_silent_after_ninety_quiet_days_whatever_its_rhythm_or_origin():
    """Owner 2026-11-02: 「3个月没有更新再退役」. BMJ Medicine had been retired after 14 quiet days against a gap of 3."""
    assert retirement(facts(new_days=days_ago(14, 17, 20, 23, 26, 29)), NOW) is None
    assert retirement(facts(new_days=days_ago(89), first_contact_at=NOW - timedelta(days=200)), NOW) is None
    decision = retirement(facts(new_days=[], first_contact_at=NOW - timedelta(days=90)), NOW)
    assert decision.reason == "silent" and decision.evidence == {"quiet_days": 90}
    assert retirement(facts(new_days=days_ago(120), first_contact_at=NOW - timedelta(days=200)), NOW).reason == "silent"
    assert retirement(facts(new_days=[], first_contact_at=NOW - timedelta(days=89)), NOW) is None, "young: quiet since its first contact"


def test_silence_is_not_judged_for_young_failing_safety_or_operator_sources():
    quiet = dict(new_days=days_ago(100), first_contact_at=NOW - timedelta(days=200))
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


def test_off_topic_never_retires_a_source_the_feed_selected_from():
    # 中国政府网 最新政策 (2026-10-22): most of the State Council's policies are not medical, the one that was is selected.
    policy = facts(screened=40, off_topic=38, selected=1)
    assert retirement(policy, NOW) is None
    assert retirement(facts(screened=40, off_topic=38, selected=0), NOW).reason == "off-topic"
    assert retirement(facts(screened=40, off_topic=38, selected=None), NOW).reason == "off-topic"   # an older platform


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
