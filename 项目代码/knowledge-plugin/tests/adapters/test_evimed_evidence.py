"""``json-api`` family ``evimed-evidence``: the platform's own feed of what its evidence may offer the frontier (flywheel F09).

The recording is made by the platform's own feed code over a seeded database
(``OpenScience/apps/server/test/helpers/evidenceFeedFixture.mjs``; no upstream exists but that code), and the platform's
test holds it equal to what the feed builds today. What the plugin must do with it: read each card as one entry keyed on
the card, never hand the platform a DOI or PMID (a card is not the work it is about, and the platform folds two sightings
of one work into one item), pass an interpretation's registry numbers on for event clustering and nothing of a first-hand
card's, refuse a feed it does not know the version of, and page by the feed's own cursor.
"""

from __future__ import annotations

import json
from dataclasses import replace

import pytest

from knowledge_plugin.adapters import REGISTRY, validate_config
from knowledge_plugin.adapters.common import query_param
from knowledge_plugin.model import FetchError, FetchResult
from knowledge_plugin.normalize import prepare
from replay import load_case

ADAPTER = REGISTRY["json-api"]
CASE = "json-api/evimed-evidence"


@pytest.fixture(scope="module")
def case():
    return load_case(CASE)


def parsed(case, payload=None, **overrides):
    """The recorded answer, or the recorded answer with `payload` in its place, read by the adapter."""
    (result,) = case.results()
    if payload is not None:
        result = replace(result, body=json.dumps(payload).encode("utf-8"))
    source = replace(case.source, **overrides) if overrides else case.source
    return ADAPTER.parse(result, source, case.now)


def recorded_payload(case):
    return json.loads(case.results()[0].body)


def test_each_card_is_one_entry_keyed_on_the_card_and_never_on_the_work_it_is_about(case):
    output = parsed(case)
    assert [e.title for e in output.entries] == ["单中心房颤患者的抗凝出血事件", "对一项房颤 Meta 分析的复算", "阿哌沙班在房颤患者中预防卒中"]
    payload = recorded_payload(case)
    for entry, item in zip(output.entries, payload["items"]):
        assert entry.external_key == item["id"] and entry.url == item["url"]
        assert entry.url.startswith("https://www.evimed.test/evidence/c/ec_")
        assert entry.doi is None and entry.pmid is None, "a card is not the work it is about: the platform would fold it into that work's item"
        assert entry.summary == item["summary"] and entry.language == "zh"
        assert entry.facts == {}, "nothing the contract does not whitelist"
        assert entry.defects == [] or entry.defects == ["short-summary"]
    # The card's own address is its identity, a rung of the ladder below every identifier.
    sources = case.source
    identities = [prepare(entry, sources).identity_key for entry in output.entries]
    assert all(identity.startswith("url:") for identity in identities) and len(set(identities)) == 3


def test_publication_is_the_first_publication_and_not_the_last_edit(case):
    payload = recorded_payload(case)
    output = parsed(case)
    assert [e.published_at.isoformat() for e in output.entries] == ["2026-10-04T09:15:00+00:00", "2026-10-04T05:30:00+00:00", "2026-10-03T02:00:00+00:00"]
    assert [i["publishedAt"] for i in payload["items"]] == ["2026-10-04T09:15:00.000Z", "2026-10-04T05:30:00.000Z", "2026-10-03T02:00:00.000Z"]
    assert {e.date_precision for e in output.entries} == {"instant"}
    edited = json.loads(json.dumps(payload))
    edited["items"][0]["updatedAt"] = "2026-10-05T07:00:00.000Z"
    assert parsed(case, edited).entries[0].published_at == output.entries[0].published_at


def test_an_interpretation_names_the_trial_it_is_about_and_a_first_hand_card_names_nothing(case):
    output = parsed(case)
    payload = recorded_payload(case)
    by_originality = {item["originality"]: entry for item, entry in zip(payload["items"], output.entries)}
    assert by_originality["brief"].registry_ids == ["NCT00412984"], "an interpretation is found beside the study it is about"
    assert by_originality["recalculation"].registry_ids == [] and by_originality["original_research"].registry_ids == [], "a first-hand card forms its own event"
    # Even a first-hand card whose feed entry lists registry numbers hands none on.
    forged = json.loads(json.dumps(payload))
    forged["items"][1]["about"]["registryIds"] = ["NCT01234567"]
    assert parsed(case, forged).entries[1].registry_ids == []


def test_the_source_is_the_platforms_own_and_polls_the_address_of_the_deployment(case):
    assert case.source.platform_produced is True
    assert validate_config(case.source) == []
    (request,) = ADAPTER.plan(case.source, case.state, case.now)
    assert request.url == "https://www.evimed.test/evidence/feed.json" and request.method == "GET"
    assert request.api is True and request.conditional is True, "the feed answers an ETag, and an unchanged page is a 304"
    # The row names its feed one way or another.
    nameless = replace(case.source, config={"family": "evimed-evidence", "max_pages": 5})
    assert any("evimed-evidence names its feed" in problem for problem in validate_config(nameless))
    assert validate_config(replace(case.source, config={"family": "evimed-evidence", "url_env": "EVIMED_EVIDENCE_FEED_URL"})) == []


def test_the_feeds_cursor_is_followed_on_its_own_url(case):
    payload = recorded_payload(case)
    assert parsed(case).next is None
    more = {**payload, "next": "eyJ1IjoiMjAyNi0xMC0wM1QwMjowMDowMC4wMDAwMDBaIiwiaSI6ImVjX3gifQ"}
    follow = parsed(case, more).next
    assert query_param(follow.url, "cursor") == more["next"] and follow.url.startswith("https://www.evimed.test/evidence/feed.json?")
    assert follow.conditional is False and follow.api is True


def test_a_card_that_is_not_on_the_platforms_host_or_has_no_title_is_not_handed_on(case):
    payload = recorded_payload(case)
    mixed = json.loads(json.dumps(payload))
    mixed["items"][0]["url"] = "https://elsewhere.example/evidence/c/ec_1"
    mixed["items"][1]["title"] = "  "
    mixed["items"][2]["id"] = ""
    assert parsed(case, mixed).entries == []
    mixed["items"][0]["url"] = "/evidence/c/ec_1"
    assert parsed(case, mixed).entries == [], "a path alone is not an address the plugin can hand on"


def test_a_version_this_reader_does_not_know_is_refused_by_name(case):
    payload = recorded_payload(case)
    with pytest.raises(FetchError) as raised:
        parsed(case, {**payload, "version": "evimed-evidence-feed/2"})
    assert raised.value.outcome == "parse-error" and raised.value.detail == "evimed_evidence_version_unsupported"
    for wrong in ({"items": []}, {"version": "something-else/1", "items": []}, {"version": "evimed-evidence-feed/1"}, [], "text"):
        with pytest.raises(FetchError) as shape:
            parsed(case, wrong)
        assert shape.value.detail == "evimed_evidence_unexpected_shape", wrong
    (result,) = case.results()
    with pytest.raises(FetchError) as refused:
        ADAPTER.parse(FetchResult(request=result.request, final_url=result.final_url, status=404, headers={}, body=b"{}", fetched_at=result.fetched_at), case.source, case.now)
    assert refused.value.outcome == "http-error" and refused.value.detail == "evimed_evidence_http_404"
    with pytest.raises(FetchError) as html:
        ADAPTER.parse(replace(result, body=b"<html>not json</html>"), case.source, case.now)
    assert html.value.detail == "evimed_evidence_not_json"
