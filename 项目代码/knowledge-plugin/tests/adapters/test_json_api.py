"""json-api families against recorded answers (2026-09-22) and the plan's traps.

openFDA: per-endpoint date formats (``YYYYMMDD`` / shortages ``MM/DD/YYYY``), links built from
recall event / application / ingredient, event-level Drugs@FDA identity, FAERS "data updated"
keyed on ``meta.last_updated``, and the 404 ``NOT_FOUND`` that means "nothing in the window".
ClinicalTrials.gov: the per-query date field and event-level ``reg:`` identity. WHO: half links.
medRxiv: cursor = cursor + count. PREPARE: contact PII never passes, drafts skipped, the internal
next link not followed. STAR: POST paging. MedHELM: config.js → summary.json.
"""

from __future__ import annotations

import json
from dataclasses import replace
from datetime import datetime, timedelta, timezone

from knowledge_plugin.adapters import REGISTRY
from knowledge_plugin.adapters.common import query_param
from knowledge_plugin.adapters.json_api import family_of
from knowledge_plugin.model import SourceState
from replay import load_case

ADAPTER = REGISTRY["json-api"]


def outputs(name):
    case = load_case(name)
    return case, [ADAPTER.parse(r, case.source, case.now) for r in case.results()]


def entries(name):
    case, outs = outputs(name)
    return case, [e for o in outs for e in o.entries]


def day(y, m, d):
    return datetime(y, m, d, tzinfo=timezone.utc)


# ------------------------------------------------------------------------------------------ openFDA

def test_enforcement_recall_mapping():
    case, found = entries("json-api/openfda-enforcement")
    assert "report_date:%5B20260823+TO+20260922%5D" in case.exchanges[0].spec.url  # the full 30-day window
    assert len(found) == 66
    recall = next(e for e in found if e.external_key == "D-0815-2026")
    assert recall.title == "Class II drug recall: Clindamycin Injection USP in 5% Dextrose (Baxter Healthcare Corporation)"
    assert recall.url == "https://www.accessdata.fda.gov/scripts/ires/index.cfm?Event=99500"
    assert recall.published_at == day(2026, 9, 9) and recall.date_precision == "day"  # YYYYMMDD report_date
    assert recall.facts == {"recall_class": "Class II", "fda_application": "ANDA208084",
                            "sponsor": "Baxter Healthcare Corporation"}
    assert "link-derived" in recall.defects
    assert "Reason: CGMP Deviations." in recall.summary and ".." not in recall.summary
    assert "Deerfield" in recall.summary  # the product description as FDA wrote it; the street address field is not used
    assert "1 Baxter Pkwy" not in recall.summary


def test_shortages_are_dated_by_their_event_not_by_reverification():
    case, outs = outputs("json-api/openfda-shortages")
    records = json.loads(case.results()[0].body)["results"]
    assert sum(1 for r in records if r["update_type"] == "Reverified") >= 90
    (output,) = outs
    assert output.notes == ["openfda_shortages_outside_window=99"]
    (shortage,) = output.entries
    assert shortage.external_key == "0378-9070-93:to be discontinued:2026-09-18"
    assert shortage.published_at == day(2026, 9, 18)  # MM/DD/YYYY
    assert shortage.url == ("https://www.accessdata.fda.gov/scripts/drugshortages/dsp_ActiveIngredientDetails.cfm"
                            "?AI=Rivastigmine+Film%2C+Extended+Release&st=d&tab=tabs-1")
    assert shortage.facts == {"fda_application": "ANDA205622", "sponsor": "Mylan Pharmaceuticals Inc., a Viatris Company"}
    assert "800-" not in shortage.summary  # contact_info (a phone number) never passes


def test_shortages_stop_paging_once_updates_leave_the_window():
    case, _ = outputs("json-api/openfda-shortages")
    late = case.now + timedelta(days=60)  # every update on the page is now older than the 30-day window
    output = ADAPTER.parse(case.results()[0], case.source, late)
    assert output.entries == [] and output.next is None


def test_drugsfda_emits_one_event_per_submission_in_the_window():
    case, outs = outputs("json-api/openfda-drugsfda")
    (output,) = outs
    assert len(output.entries) == 107
    assert query_param(output.next.url, "skip") == "100"
    event = next(e for e in output.entries if e.external_key == "ANDA203924:SUPPL-2")
    assert event.identity_hint == "fda:ANDA203924:SUPPL-2"
    assert event.title == "FDA approval: PRIMAQUINE PHOSPHATE — ANDA203924 SUPPL-2 (Labeling)"
    assert event.url == "https://www.accessdata.fda.gov/scripts/cder/daf/index.cfm?event=overview.process&ApplNo=203924"
    assert event.facts == {"fda_application": "ANDA203924", "fda_supplement": "SUPPL-2", "sponsor": "ALVOGEN"}
    assert event.published_at == day(2026, 9, 14)
    # older submissions of the same application (SUPPL-1 2025-08-15, ORIG-1 2014) are not news again
    assert not any(e.external_key in ("ANDA203924:SUPPL-1", "ANDA203924:ORIG-1") for e in output.entries)
    assert all(day(2026, 8, 23) <= e.published_at <= day(2026, 9, 22) for e in output.entries)
    new_drug = next(e for e in output.entries if e.external_key == "NDA218592:ORIG-1")
    assert new_drug.title == "FDA approval: PIXCLARA — NDA218592 ORIG-1 (Type 1 - New Molecular Entity)"


def test_faers_is_one_entry_per_last_updated_value():
    case, outs = outputs("json-api/openfda-event")
    (entry,) = outs[0].entries
    assert entry.external_key == "drug/event:last_updated:2026-07-30"
    assert entry.identity_hint == "fda:faers:2026-07-30"
    assert entry.url == "https://open.fda.gov/data/faers/?last_updated=2026-07-30"
    assert entry.published_at == day(2026, 7, 30)
    again = ADAPTER.parse(case.results()[0], case.source, case.now + timedelta(days=3)).entries[0]
    assert again.external_key == entry.external_key and again.summary == entry.summary  # same value: a no-op upsert


def test_no_matches_404_is_zero_entries_not_a_failure():
    case = load_case("json-api/openfda-no-matches")
    answer = case.exchanges[0].result
    assert answer.status == 404 and json.loads(answer.body)["error"]["code"] == "NOT_FOUND"
    output = ADAPTER.parse(answer, case.source, datetime.now(timezone.utc))
    assert output.entries == [] and output.next is None and output.notes == ["openfda_no_matches"]


def test_openfda_plans_ignore_last_success():
    case = load_case("json-api/openfda-enforcement")
    recent = SourceState(None, None, None, case.now - timedelta(hours=1), None, {})
    url = ADAPTER.plan(case.source, recent, case.now)[0].url
    assert "report_date:%5B20260823+TO+20260922%5D" in url  # still the whole 30-day look-back


# ---------------------------------------------------------------------------- ClinicalTrials.gov

def test_results_stream_is_dated_by_results_first_posted():
    case, outs = outputs("json-api/ctgov-results-first-posted")
    assert [o.next is not None for o in outs] == [True, False]
    assert query_param(case.exchanges[1].spec.url, "pageToken") == json.loads(case.results()[0].body)["nextPageToken"]
    found = [e for o in outs for e in o.entries]
    assert len(found) == 65
    status = json.loads(case.results()[0].body)["studies"][0]["protocolSection"]["statusModule"]
    assert status["studyFirstPostDateStruct"]["date"] == "2025-08-07"  # the record's first date field: a year old
    first = found[0]
    assert first.published_at == day(2026, 9, 21)  # ResultsFirstPostDate, the date that made it news
    assert first.identity_hint == "reg:NCT07110077:results-posted:2026-09-21"
    assert first.external_key == "NCT07110077:results-posted:2026-09-21"
    assert first.title.startswith("Results posted: ")
    assert first.registry_ids == ["NCT07110077"] and first.url == "https://clinicaltrials.gov/study/NCT07110077"
    assert first.facts == {"trial_phase": "NA", "trial_status": "COMPLETED", "trial_event": "results-posted",
                           "sponsor": "University of Buea"}


def test_stopped_trials_map_status_to_the_event():
    _, found = entries("json-api/ctgov-stopped-phase3")
    pairs = sorted({(e.facts["trial_event"], e.facts["trial_status"]) for e in found})
    assert pairs == [("terminated", "TERMINATED"), ("updated", "WITHDRAWN")]
    stopped = next(e for e in found if e.identity_hint == "reg:NCT07253688:terminated:2026-09-21")
    assert stopped.title.startswith("Terminated: Adjunctive Rifampin")
    assert stopped.summary.startswith("Why stopped: After reviewing the recruitment to date")


def test_ctgov_plan_limits_fields_so_no_contact_ever_arrives():
    case, found = entries("json-api/ctgov-phase3-new-registrations")
    url = ADAPTER.plan(case.source, case.state, case.now)[0].url
    assert "fields=NCTId,BriefTitle" in url and "CentralContact" not in url
    assert all("contactsLocationsModule" not in s["protocolSection"] for s in json.loads(case.results()[0].body)["studies"])
    assert found[0].identity_hint == "reg:NCT07830797:registered:2026-09-21"


# --------------------------------------------------------------------------------- WHO, medRxiv, FR

def test_who_half_links_are_completed_per_endpoint():
    _, news = entries("json-api/who-news")
    assert news[0].url == "https://www.who.int/news/item/21-09-2026-who-welcomes-strong-health-commitments-at-the-2026-brics-summit"
    assert news[0].summary is None and news[0].published_at == datetime(2026, 9, 21, 16, 0, tzinfo=timezone.utc)
    _, don = entries("json-api/who-disease-outbreak-news")
    assert don[0].url == "https://www.who.int/emergencies/disease-outbreak-news/item/2026-DON617"
    assert don[0].summary.startswith("Since the last Disease Outbreak News was published on 28 August 2026")
    _, publications = entries("json-api/who-publications")
    assert publications[0].url == "https://www.who.int/publications/i/item/18143601"
    assert all("link-derived" in e.defects for e in news + don + publications)


def test_medrxiv_details_cursor_advances_by_count():
    case, outs = outputs("json-api/medrxiv-details")
    assert json.loads(case.results()[0].body)["messages"][0]["count"] == 100  # not the 30 of older notes
    assert outs[0].next.url == "https://api.medrxiv.org/details/medrxiv/2026-09-20/2026-09-22/100/json"
    assert outs[1].next is None
    found = [e for o in outs for e in o.entries]
    assert len(found) == 138 == json.loads(case.results()[0].body)["messages"][0]["total"]
    first = found[0]
    assert first.external_key == first.doi == "10.64898/2026.09.08.26362319"
    assert first.url == "https://www.medrxiv.org/content/10.64898/2026.09.08.26362319v2"
    assert first.facts == {"author_count": 3, "journal": "medRxiv"}
    serialized = json.dumps([vars(e) for e in found], default=str)
    assert "author_corresponding" not in serialized and "Cheryl" not in serialized


def test_federal_register_documents():
    case, found = entries("json-api/federalregister-fda")
    assert "conditions[publication_date][gte]=2026-09-15" in case.exchanges[0].spec.url
    assert len(found) == 15
    assert found[0].external_key == "2026-19350"
    assert found[0].url == "https://www.federalregister.gov/documents/2026/09/22/2026-19350/nonclinical-testing-terminology"
    assert found[0].summary.endswith("Agencies: Health and Human Services Department, Food and Drug Administration.")


# ----------------------------------------------------------------------- MedHELM, PREPARE, STAR, Crossref

def test_medhelm_release_chain():
    case, outs = outputs("json-api/medhelm")
    assert [e.spec.url for e in case.exchanges] == [
        "https://crfm.stanford.edu/helm/medhelm/latest/config.js",
        "https://storage.googleapis.com/crfm-helm-public/medhelm/benchmark_output/releases/v4.0.0/summary.json"]
    assert outs[0].entries == [] and outs[0].next is not None
    (release,) = outs[1].entries
    assert release.external_key == "medhelm:v4.0.0" and release.published_at == day(2026, 1, 19)
    assert family_of(case.source) == "medhelm"


def test_prepare_drops_contact_data_and_drafts():
    case, outs = outputs("json-api/prepare-registry")
    provenance = case.provenance["exchanges"][0]
    assert provenance["redacted_keys"] == ["contact_address", "contact_email", "contact_name", "contact_phone",
                                           "contact_wechat"]
    (output,) = outs
    assert len(output.entries) == 17 and output.notes == ["prepare_skipped_stage=3"]
    serialized = json.dumps([vars(e) for e in output.entries], default=str, ensure_ascii=False)
    assert "REDACTED" not in serialized and "contact" not in serialized  # nothing of those fields reaches an entry
    first = output.entries[0]
    assert first.url == "https://www.guidelines-registry.cn/guide/836e3bb7-4c71-4368-984d-a8dcde3ec2a9"
    assert first.identity_hint == "reg:prepare-836e3bb7-4c71-4368-984d-a8dcde3ec2a9:registered:2026-09-22"
    assert first.published_at == datetime(2026, 9, 22, 9, 13, 17, tzinfo=timezone.utc)  # 17:13:17 China time
    assert first.facts == {"sponsor": "中国医师协会新生儿科医师分会早产儿专业委员会"} and first.language == "zh"
    assert sorted(r for e in output.entries for r in e.registry_ids) == ["PREPARE-2025CN1821", "PREPARE-2026CN2266"]


def test_prepare_never_follows_the_upstream_internal_next_link():
    case, outs = outputs("json-api/prepare-registry")
    assert json.loads(case.results()[0].body)["next"].startswith("http://10.0.24.8:8011/")
    assert outs[0].next.url == "https://www.guidelines-registry.cn/api/registration/guide/?page_size=20&page=2"


def test_star_pages_by_post_body():
    case, outs = outputs("json-api/star-rating")
    assert [e.spec.method for e in case.exchanges] == ["POST", "POST"]
    assert [json.loads(e.spec.body) for e in case.exchanges] == [{"page": 1, "limit": 40}, {"page": 2, "limit": 40}]
    assert json.loads(outs[1].next.body) == {"page": 3, "limit": 40}
    found = [e for o in outs for e in o.entries]
    assert len(found) == 80
    rating = next(e for e in found if e.external_key == "star:4550")
    assert rating.url == "https://rs.yiigle.com/cmaid/1512661"
    assert rating.registry_ids == ["PREPARE-2024CN159"]  # links the rating to the guideline's registration
    assert rating.summary.startswith("STAR 5.0 星（99.1 分），共识，2024。")


def test_crossref_retraction_stream_reuses_the_journal_mapping():
    _, found = entries("json-api/crossref-retraction-updates")
    assert len(found) == 20
    assert all(e.facts["is_correction_notice"] for e in found)
    assert {u["type"] for e in found for u in e.facts["update_to"]} == {"retraction"}


def test_generic_rows_are_recognised_by_host_and_star_needs_post():
    case = load_case("json-api/star-rating")
    generic = replace(case.source, config={**case.source.config, "family": "generic"})
    assert family_of(generic) == "star-rating"
    planned = ADAPTER.plan(generic, case.state, case.now)[0]
    assert planned.method == "POST" and json.loads(planned.body) == {"page": 1, "limit": 40}
    unknown = replace(case.source, config={"url": "https://example.org/api", "family": "nothing-like-it"})
    assert any("no json-api mapping" in p for p in ADAPTER.validate_config(unknown))
