"""evimed-api against recorded answers of the owner's EviMed evidence API (2026-09-22).

ChiCTR daily scan (registry 0, relevance-ranked, new = registered within 14 days, event-level
identity), guideline weekly scan (the index lags about six months: nothing new), and the API's own
"no key" answer — an HTTP 200 whose body says ``code: 401``. The key never appears in a request
the adapter builds nor in any fixture.
"""

from __future__ import annotations

import json
from dataclasses import replace
from datetime import datetime, timezone

import pytest

from knowledge_plugin.adapters import REGISTRY
from knowledge_plugin.adapters.evimed_api import CHICTR_TERMS, chictr_id
from knowledge_plugin.model import FetchError, SourceState
from replay import load_case

ADAPTER = REGISTRY["evimed-api"]


def test_chictr_plan_is_one_post_per_specialty_without_credentials():
    case = load_case("evimed-api/chictr")
    planned = ADAPTER.plan(case.source, case.state, case.now)
    assert len(planned) == 20 == len(CHICTR_TERMS)
    bodies = [json.loads(p.body) for p in planned]
    assert [b["query"] for b in bodies] == list(CHICTR_TERMS)
    assert bodies[0] == {"query": "肿瘤", "count": 100, "registry": 0, "startYear": 2026}
    for request in planned:
        assert request.method == "POST" and request.api is True and request.conditional is False
        assert request.headers == {"Content-Type": "application/json"}  # the fetcher adds Authorization
        assert "Bearer" not in json.dumps(request.headers) and "key" not in request.url
    january = datetime(2027, 1, 5, tzinfo=timezone.utc)  # the 14-day window starts in the previous year
    assert json.loads(ADAPTER.plan(case.source, case.state, january)[0].body)["startYear"] == 2026


def test_chictr_answers_become_registration_events_inside_the_window():
    case = load_case("evimed-api/chictr")
    first = case.results()[0]
    records = json.loads(first.body)["data"]["list"]
    assert len(records) == 100 and json.loads(first.body)["data"]["total"] > 100
    output = ADAPTER.parse(first, case.source, case.now)
    assert output.notes == ["evimed_chictr_outside_window=97"]  # relevance-ranked: most hits are older
    (entry, *_) = output.entries
    assert entry.external_key == "ChiCTR2600132724:registered:2026-09-17"
    assert entry.identity_hint == "reg:ChiCTR2600132724:registered:2026-09-17"
    assert entry.registry_ids == ["ChiCTR2600132724"]
    assert entry.url == "https://trialsearch.who.int/Trial2.aspx?TrialID=ChiCTR2600132724"
    assert entry.published_at == datetime(2026, 9, 17, tzinfo=timezone.utc) and entry.date_precision == "day"
    assert entry.facts == {"trial_phase": "其它", "trial_status": "正在进行", "trial_event": "registered"}
    assert entry.language == "zh" and entry.summary.startswith("疾病：")
    counts = [len(ADAPTER.parse(r, case.source, case.now).entries) for r in case.results()]
    assert counts == [3, 3, 6]


def test_the_v1_endpoint_carries_the_sponsor_and_the_same_identity():
    case = load_case("evimed-api/chictr-v1")
    (answer,) = case.results()
    records = json.loads(answer.body)["data"]["list"]
    assert case.source.config["url"].endswith("/review/api/clinical-trial")  # v1, the adapter's default
    assert len(records) == 100 and all(r.get("primarySponsor") for r in records)
    assert all("interventions" not in r and "id" not in r for r in records)  # v1 has no interventions
    output = ADAPTER.parse(answer, case.source, case.now)
    assert output.notes == ["evimed_chictr_outside_window=96"] and len(output.entries) == 4
    entry = output.entries[-1]
    assert entry.identity_hint == "reg:ChiCTR2600132609:registered:2026-09-16"  # the v2 form
    assert entry.facts == {"trial_phase": "其它", "trial_status": "尚未开始", "trial_event": "registered",
                           "sponsor": "首都医科大学附属北京友谊医院"}
    assert entry.url == "https://www.chictr.org.cn/showproj.html?proj=341854" and "申办方：" in entry.summary
    v2 = load_case("evimed-api/chictr")
    assert all("sponsor" not in e.facts for r in v2.results() for e in ADAPTER.parse(r, v2.source, v2.now).entries)
    default = replace(case.source, config={k: v for k, v in case.source.config.items() if k != "url"})
    assert ADAPTER.plan(default, case.state, case.now)[0].url == case.source.config["url"]


def test_chictr_ids_are_normalised_to_the_registry_form():
    assert chictr_id({"registrationNo": "chictr2600122474", "id": ""}) == "ChiCTR2600122474"
    assert chictr_id({"id": "ChiCTR-IOR-17012345"}) == "ChiCTR-IOR-17012345"
    assert chictr_id({"registrationNo": "NCT01234567"}) is None
    case = load_case("evimed-api/chictr")
    raw = json.loads(case.results()[0].body)["data"]["list"]
    assert any(r["registrationNo"].startswith("chictr") for r in raw)  # lower-cased by the API, as recorded
    phases = {e.facts.get("trial_phase") for r in case.results() for e in ADAPTER.parse(r, case.source, case.now).entries}
    assert all(p is None or p == p.upper() or not p.isascii() for p in phases)


def test_guideline_scan_finds_nothing_new_because_the_index_lags():
    case = load_case("evimed-api/guide")
    for result in case.results():
        output = ADAPTER.parse(result, case.source, case.now)
        records = json.loads(result.body)["data"]["guide"]["list"]
        assert output.entries == [] and output.notes == [f"evimed_guide_outside_window={len(records)}"]
        newest = max(r["publicationDate"] for r in records if len(r.get("publicationDate") or "") == 10)
        assert newest < "2026-08-23"  # the newest dated guideline is older than the 30-day window
    records = [r for result in case.results() for r in json.loads(result.body)["data"]["guide"]["list"]]
    assert any(r.get("publicationDate") == "2026" for r in records)  # year-only dates exist and are never "new"


def test_guideline_records_inside_the_window_become_entries():
    case = load_case("evimed-api/guide")
    record = next(r for r in json.loads(case.results()[0].body)["data"]["guide"]["list"]
                  if len(r.get("publicationDate") or "") == 10)
    published = datetime.fromisoformat(record["publicationDate"]).replace(tzinfo=timezone.utc)
    output = ADAPTER.parse(case.results()[0], case.source, published.replace(hour=12))  # as if polled that day
    entry = next(e for e in output.entries if e.external_key == f"evimed-guide:{record['id']}")
    assert entry.url == record["url"] and entry.published_at == published
    assert entry.facts.get("sponsor") == record["publisher"]


def test_a_missing_key_inside_http_200_is_blocked():
    case = load_case("evimed-api/no-key")
    answer = case.exchanges[0].result
    assert answer.status == 200 and json.loads(answer.body) == {"msg": "当前api_key不存在", "code": 401}
    with pytest.raises(FetchError) as raised:
        ADAPTER.parse(answer, case.source, datetime.now(timezone.utc))
    assert (raised.value.outcome, raised.value.detail) == ("blocked", "evimed_unauthorized")


def test_config_keys_of_the_core_registry_rows_are_understood():
    case = load_case("evimed-api/guide")
    groups = replace(case.source, config={**{k: v for k, v in case.source.config.items() if k != "queries"},
                                          "query": "指南 共识", "publisher_groups": [["中华医学会"], ["NCCN"]], "max_pages": 35})
    bodies = [json.loads(p.body) for p in ADAPTER.plan(groups, case.state, case.now)]
    assert bodies == [{"query": "指南 共识", "type": "guide", "count": 100, "startYear": 2026, "publishers": ["中华医学会"]},
                      {"query": "指南 共识", "type": "guide", "count": 100, "startYear": 2026, "publishers": ["NCCN"]}]
    terms = replace(case.source, config={"family": "chictr", "terms": ["肿瘤"], "registry": 0, "count": 100})
    assert json.loads(ADAPTER.plan(terms, SourceState(None, None, None, None, None, {}), case.now)[0].body)["query"] == "肿瘤"
    small = replace(case.source, config={**case.source.config, "max_pages": 2})
    assert any("max_pages" in p for p in ADAPTER.validate_config(small))
    assert ADAPTER.validate_config(case.source) == []
