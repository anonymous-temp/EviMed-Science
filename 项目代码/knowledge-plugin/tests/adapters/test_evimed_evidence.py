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
from pathlib import Path
from urllib.parse import urlsplit

import pytest

from knowledge_plugin.adapters import REGISTRY, validate_config
from knowledge_plugin.adapters.common import query_param
from knowledge_plugin.fetch import is_public_address
from knowledge_plugin.model import FetchError, FetchResult, SourceConfig
from knowledge_plugin.normalize import prepare
from knowledge_plugin.registry import resolve_env_url
from replay import load_case

REGISTRY_FILE = Path(__file__).resolve().parents[2] / "registry" / "sources.json"

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


def _row():
    return next(r for r in json.loads(REGISTRY_FILE.read_text(encoding="utf-8"))["sources"] if r["id"] == "evimed-evidence")


def _source(row):
    return SourceConfig(**{name: row.get(name) for name in SourceConfig.__dataclass_fields__})


def _feed(public, base, count=3):
    """A feed as the platform builds it for a deployment whose public address is `public`: every card linked on that address."""
    return {"version": "evimed-evidence-feed/1", "generatedAt": "2026-10-10T08:00:00.000Z", "next": None, "items": [
        {"id": f"ec_{n}", "url": f"{public}{base}/c/ec_{n}", "title": f"证据卡 {n}", "summary": "一张证据卡的摘要。", "publishedAt": "2026-10-09T08:00:00.000Z",
         "updatedAt": "2026-10-09T08:00:00.000Z", "originality": "original_research", "primary": True, "about": {"doi": [], "pmid": [], "registryIds": []}}
        for n in range(1, count + 1)]}


@pytest.mark.parametrize("base", ["/evidence", "/evimed-evidence"])
@pytest.mark.parametrize("public", ["https://science.example.com", "https://82.156.128.153"])
def test_the_feed_address_the_platforms_public_url_gives_is_a_source_the_plugin_reads_card_for_card(case, public, base):
    # F12e: the deployment's default for EVIMED_EVIDENCE_FEED_URL is `$OPEN_SCIENCE_PUBLIC_URL<evidence base>/feed.json`, the address the
    # platform builds every card link on, so the host the feed is read from is the host of each card.
    url = f"{public}{base}/feed.json"
    resolved = resolve_env_url(_row(), {"EVIMED_EVIDENCE_FEED_URL": url})
    assert resolved["enabled"] is True and resolved["config"]["url"] == url and resolved["config"]["allowed_hosts"] == [urlsplit(url).hostname]
    source = _source(resolved)
    assert validate_config(source) == []
    (request,) = ADAPTER.plan(source, case.state, case.now)
    assert request.url == url and request.api is True
    (recorded,) = case.results()
    result = replace(recorded, request=request, final_url=url, body=json.dumps(_feed(public, base)).encode("utf-8"))
    assert [entry.url for entry in ADAPTER.parse(result, source, case.now).entries] == [f"{public}{base}/c/ec_{n}" for n in (1, 2, 3)]


def test_an_address_inside_the_compose_network_cannot_be_the_feed_address_the_cards_would_all_be_dropped(case):
    # F12e, why the default is the public address and not `http://open-science-web:8787/...`: the plugin keeps only the cards linked on the
    # host it read the feed from, and the platform links its cards on its public address. (The fetcher also refuses any address that is
    # not a global one, which is what a compose service name resolves to: `is_public_address`.)
    assert not any(is_public_address(address) for address in ("172.18.0.5", "10.0.3.2", "192.168.16.4", "127.0.0.1"))
    internal = resolve_env_url(_row(), {"EVIMED_EVIDENCE_FEED_URL": "http://open-science-web:8787/evidence/feed.json"})
    assert internal["config"]["allowed_hosts"] == ["open-science-web"]
    source = _source(internal)
    (recorded,) = case.results()
    result = replace(recorded, body=json.dumps(_feed("https://science.example.com", "/evidence")).encode("utf-8"))
    assert ADAPTER.parse(result, source, case.now).entries == []


def test_a_platform_whose_public_evidence_pages_are_off_has_no_feed_to_offer_and_that_is_not_a_failure_of_the_source(case):
    # F12e: with the feed address on by default, a deployment that has not switched its public evidence pages on (the shipped default)
    # answers the feed 404 by name. The source then reads as empty, instead of failing until it is called unreadable.
    (recorded,) = case.results()
    off = replace(recorded, status=404, body=json.dumps({"error": "The public evidence pages are not enabled.", "code": "evidence_public_not_enabled"}).encode("utf-8"))
    output = ADAPTER.parse(off, case.source, case.now)
    assert output.entries == [] and output.next is None and output.notes == ["evimed_evidence_not_enabled"]
    # Any other 404, and the same code on any other status, is a failure by name, as before.
    for body in (b"{}", b'{"code": "something_else"}', b"<html>not found</html>", b"[]", b'"x"', b""):
        with pytest.raises(FetchError) as refused:
            ADAPTER.parse(replace(off, body=body), case.source, case.now)
        assert refused.value.outcome == "http-error" and refused.value.detail == "evimed_evidence_http_404", body
    with pytest.raises(FetchError) as server:
        ADAPTER.parse(replace(off, status=500), case.source, case.now)
    assert server.value.detail == "evimed_evidence_http_500"
