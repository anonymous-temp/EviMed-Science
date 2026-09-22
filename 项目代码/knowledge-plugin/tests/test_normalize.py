"""Normalisation: canonical URL, identity ladder, entry id, defects, the date clamp, facts, hashing."""

from __future__ import annotations

import hashlib
from datetime import datetime, timedelta, timezone

import pytest

from knowledge_plugin.model import NormalizedEntry, SourceConfig
from knowledge_plugin.normalize import (
    Rejected, canonical_url, entry_id_for, identity_key, is_backfill, is_correction_title, is_masthead_title,
    normalize_doi, prepare, resolve_dates, whitelist_facts,
)

NOW = datetime(2026, 9, 22, 8, 0, tzinfo=timezone.utc)


def source(**overrides) -> SourceConfig:
    base = dict(id="test-source", name="Test", homepage=None, lane="evidence", source_type="journal",
                access="rss", egress="direct", authority=3, safety_feed=False, owner_entity="Test Org",
                launch_tier="P0", language="en", region="US", poll_floor_s=3600, poll_ceiling_s=21600, config={})
    base.update(overrides)
    return SourceConfig(**base)


def entry(**overrides) -> NormalizedEntry:
    base = dict(external_key="guid-1", url="https://example.org/a/1", title="A trial of something",
                summary="S" * 120, published_at=NOW - timedelta(hours=2))
    base.update(overrides)
    return NormalizedEntry(**base)


# ------------------------------------------------------------------ canonical URL


@pytest.mark.parametrize("raw, expected", [
    ("HTTP://WWW.Example.COM:80/a%7Eb?utm_source=x&b=2&a=1#frag", "https://www.example.com/a~b?a=1&b=2"),
    ("https://example.com", "https://example.com/"),
    ("https://example.com/x?fbclid=1&gclid=2&utm_medium=feed", "https://example.com/x"),
    ("https://example.com:8443/x", "https://example.com:8443/x"),
    ("https://pubmed.ncbi.nlm.nih.gov/12345/?utm_campaign=pubmed-2", "https://pubmed.ncbi.nlm.nih.gov/12345/"),
])
def test_canonical_url(raw, expected):
    assert canonical_url(raw) == expected


def test_canonical_url_keeps_meaningful_parameters():
    assert canonical_url("https://www.huanqiukexue.com/?feed=rss2&p=5") == "https://www.huanqiukexue.com/?feed=rss2&p=5"


# ------------------------------------------------------------------ identity ladder


def test_identity_ladder_order():
    canon = "https://example.org/x"
    url_key = "url:" + hashlib.sha256(canon.encode()).hexdigest()
    assert identity_key("10.1/abc", "123", "reg:NCT01234567:registered:2026-09-01", canon) == "doi:10.1/abc"
    assert identity_key(None, "123", "reg:NCT01234567:registered:2026-09-01", canon) == "pmid:123"
    assert identity_key(None, None, "wx:biz:mid:1", canon) == "wx:biz:mid:1"
    assert identity_key(None, None, "reg:NCT01234567:results-posted:2026-09-01", canon) == "reg:NCT01234567:results-posted:2026-09-01"
    assert identity_key(None, None, "fda:NDA021436:SUPPL-45", canon) == "fda:NDA021436:SUPPL-45"
    assert identity_key(None, None, None, canon) == url_key


def test_event_level_hint_is_used_for_registry_sources():
    prepared = prepare(entry(identity_hint="reg:NCT01234567:results-posted:2026-09-20", url="https://clinicaltrials.gov/study/NCT01234567"),
                       source(access="json-api"))
    assert prepared.identity_key == "reg:NCT01234567:results-posted:2026-09-20"


def test_malformed_hint_is_ignored_not_trusted():
    prepared = prepare(entry(identity_hint="reg:NCT01234567:whatever:yesterday"), source())
    assert prepared.identity_key.startswith("url:")
    assert "invalid_identity_hint" in prepared.notes


def test_doi_normalisation_and_identity():
    assert normalize_doi("https://doi.org/10.1056/NEJMoa2412345.") == "10.1056/nejmoa2412345"
    assert normalize_doi("doi: 10.1000/XYZ") == "10.1000/xyz"
    assert normalize_doi("not a doi") is None
    prepared = prepare(entry(doi="https://doi.org/10.1056/NEJMoa2412345", pmid="999"), source())
    assert prepared.identity_key == "doi:10.1056/nejmoa2412345"


def test_entry_id_format():
    assert entry_id_for("src", "key") == "src:" + hashlib.sha256(b"key").hexdigest()[:32]
    prepared = prepare(entry(), source())
    assert prepared.entry_id == entry_id_for("test-source", "guid-1")


def test_overlong_external_key_is_hashed():
    prepared = prepare(entry(external_key="k" * 600), source())
    assert prepared.external_key.startswith("sha256:") and len(prepared.external_key) == 71


# ------------------------------------------------------------------ defects


def test_no_summary_and_short_summary():
    assert "no-summary" in prepare(entry(summary=None), source()).defects
    short = prepare(entry(summary="Too short."), source())
    assert "short-summary" in short.defects and "no-summary" not in short.defects


def test_oversize_summary_is_cut_and_flagged():
    prepared = prepare(entry(summary="word " * 5000), source())
    assert len(prepared.summary) <= 20_000
    assert "oversize-truncated" in prepared.defects


def test_truncated_summary_is_flagged():
    prepared = prepare(entry(summary="A long enough feed summary that ends in the usual way for teasers. " * 2 + "Read more"), source())
    assert "truncated-summary" in prepared.defects


def test_encoding_replacement_characters_are_flagged():
    prepared = prepare(entry(title="Bad �� title"), source())
    assert "encoding" in prepared.defects


def test_link_derived_from_identifiers():
    prepared = prepare(entry(url="", doi="10.1000/abc"), source())
    assert prepared.url == "https://doi.org/10.1000/abc" and "link-derived" in prepared.defects
    prepared = prepare(entry(url="not-a-url", pmid="12345"), source())
    assert prepared.url == "https://pubmed.ncbi.nlm.nih.gov/12345/"
    prepared = prepare(entry(url="", registry_ids=["nct01234567"]), source())
    assert prepared.url == "https://clinicaltrials.gov/study/NCT01234567"


def test_rejections():
    with pytest.raises(Rejected) as no_title:
        prepare(entry(title="   "), source())
    assert no_title.value.code == "no_title"
    with pytest.raises(Rejected) as no_link:
        prepare(entry(url=""), source())
    assert no_link.value.code == "no_link"


def test_title_is_capped_at_1000():
    prepared = prepare(entry(title="T" * 1500), source())
    assert len(prepared.title) == 1000 and "oversize-truncated" in prepared.defects


def test_unknown_adapter_defects_are_dropped():
    prepared = prepare(entry(defects=["encoding", "made-up"]), source())
    assert "made-up" not in prepared.defects and "encoding" in prepared.defects


def test_language_falls_back_to_the_source():
    assert prepare(entry(language="und"), source(language="zh")).language == "zh"
    assert prepare(entry(language="und"), source(language="mul")).language == "und"
    assert prepare(entry(language="en-GB"), source(language="zh")).language == "en-GB"


# ------------------------------------------------------------------ dates: inference and the clamp


def test_no_date_uses_first_sighting():
    prepared = prepare(entry(published_at=None), source())
    published, precision, defects = resolve_dates(prepared, NOW)
    assert (published, precision, defects) == (NOW, "inferred", ["no-date"])


def test_beijing_time_labelled_gmt_is_clamped():
    """The infosechot case: +8 h passes a "more than 24 h ahead" check; any future instant clamps."""
    prepared = prepare(entry(published_at=NOW + timedelta(hours=8)), source())
    assert resolve_dates(prepared, NOW) == (NOW, "inferred", ["future-date"])


def test_any_future_instant_clamps():
    prepared = prepare(entry(published_at=NOW + timedelta(seconds=1)), source())
    assert resolve_dates(prepared, NOW)[2] == ["future-date"]


def test_past_instant_passes():
    when = NOW - timedelta(minutes=5)
    assert resolve_dates(prepare(entry(published_at=when), source()), NOW) == (when, "instant", [])


def test_day_precision_uses_the_earliest_zone():
    first_seen = datetime(2026, 9, 22, 17, 0, tzinfo=timezone.utc)      # already 23 Sep in Beijing
    tomorrow = prepare(entry(published_at=datetime(2026, 9, 23, tzinfo=timezone.utc), date_precision="day"), source())
    assert resolve_dates(tomorrow, first_seen)[1] == "day"               # a Beijing "today" is not future
    later = prepare(entry(published_at=datetime(2026, 9, 25, tzinfo=timezone.utc), date_precision="day"), source())
    assert resolve_dates(later, first_seen) == (first_seen, "inferred", ["future-date"])


def test_content_hash_ignores_inferred_dates():
    undated = entry(published_at=None)
    assert prepare(undated, source()).content_sha256 == prepare(undated, source()).content_sha256
    future = entry(published_at=NOW + timedelta(hours=3))
    first = prepare(future, source())
    # the hash is over the adapter's own date, so a later sighting of the same item is a no-op
    assert first.content_sha256 == prepare(future, source()).content_sha256


def test_content_hash_changes_with_content_not_tracking_parameters():
    a = prepare(entry(url="https://example.org/a?utm_source=rss"), source())
    b = prepare(entry(url="https://example.org/a?utm_source=email"), source())
    c = prepare(entry(summary="S" * 121), source())
    assert a.content_sha256 == b.content_sha256
    assert a.content_sha256 != c.content_sha256


# ------------------------------------------------------------------ first-contact guard


def test_backfill_only_on_first_contact_and_only_old_or_undated():
    old = prepare(entry(published_at=NOW - timedelta(days=8)), source())
    recent = prepare(entry(published_at=NOW - timedelta(days=6)), source())
    undated = prepare(entry(published_at=None), source())
    future = prepare(entry(published_at=NOW + timedelta(hours=8)), source())
    assert is_backfill(old, NOW, True) and not is_backfill(old, NOW, False)
    assert not is_backfill(recent, NOW, True)
    assert is_backfill(undated, NOW, True)
    assert not is_backfill(future, NOW, True)


# ------------------------------------------------------------------ facts


def test_facts_whitelist_drops_unknown_keys_and_wrong_types():
    kept, dropped = whitelist_facts({
        "journal": "NEJM", "author_count": 12, "contact_email": "someone@example.org", "phone": "123",
        "is_masthead": "yes", "trial_event": "results-posted", "update_to": [{"type": "retraction", "doi": "10.1/x", "extra": 1}],
        "author_count_str": "3",
    })
    assert kept == {"journal": "NEJM", "author_count": 12, "trial_event": "results-posted",
                    "update_to": [{"type": "retraction", "doi": "10.1/x"}]}
    assert set(dropped) == {"contact_email", "phone", "is_masthead", "author_count_str"}


def test_trial_event_outside_the_vocabulary_is_dropped():
    kept, dropped = whitelist_facts({"trial_event": "exploded"})
    assert kept == {} and dropped == ["trial_event"]


def test_masthead_is_flagged_not_dropped():
    prepared = prepare(entry(title="Editorial Board"), source())
    assert prepared.facts.get("is_masthead") is True
    assert is_masthead_title("  TABLE OF CONTENTS. ")
    assert is_masthead_title("编委会")
    assert not is_masthead_title("Editorial board diversity in oncology journals")


@pytest.mark.parametrize("title, flagged", [
    ("Correction to: Semaglutide in heart failure", True),
    ("Erratum", True),
    ("Retraction Note: A study of X", True),
    ("Expression of Concern: Y", True),
    ("Correction of adolescent idiopathic scoliosis with a new rod", False),
    ("RETRACTED: The original article", False),
    ("更正：关于某研究的说明", True),
    ("Correction for Smith et al., Gut microbiota in heart failure", True),     # PNAS notice style
    ("Correction for multiple testing in cluster randomised trials", False),    # a methods paper
    ("Erratum in: Lancet. 2026;408:1234", True),
])
def test_correction_titles(title, flagged):
    assert is_correction_title(title) is flagged


def test_update_to_marks_a_correction_notice():
    prepared = prepare(entry(title="Notice", facts={"update_to": [{"type": "correction", "doi": "10.1/abc"}]}), source())
    assert prepared.facts["is_correction_notice"] is True



def test_registry_ids_keep_their_canonical_case():
    from knowledge_plugin.normalize import normalize_registry_ids
    assert normalize_registry_ids(["chictr2600132031", "ChiCTR2600132031", "nct01234567", " ISRCTN12345678 "]) == [
        "ChiCTR2600132031", "NCT01234567", "ISRCTN12345678"]


def test_a_blurb_repeated_across_a_page_is_not_any_entry_s_summary():
    from knowledge_plugin.normalize import drop_boilerplate_summaries

    blurb = "Want to stay on top of the science and politics driving biotech today? Sign up."
    made = lambda key, summary: prepare(entry(external_key=key, url=f"https://statnews.com/{key}", summary=summary), source(id="stat-biotech"))
    page = [made(f"story-{index}", blurb) for index in range(3)]
    own = made("own", "Its own hundred-character summary of what the piece actually says, with the detail a reader needs.")
    assert drop_boilerplate_summaries(page + [own]) == 3
    assert [item.summary for item in page] == [None, None, None]
    assert all("no-summary" in item.defects and "short-summary" not in item.defects for item in page)
    assert own.summary is not None and "no-summary" not in own.defects
    twice = [made(f"pair-{index}", blurb) for index in range(2)]
    assert drop_boilerplate_summaries(twice) == 0, "two entries are not yet a pattern"
