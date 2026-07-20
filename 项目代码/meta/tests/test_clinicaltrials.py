from new_meta.tools import clinicaltrials
from new_meta.tools.clinicaltrials import extract_nct_ids, fetch_study_cached, search_studies_cached, study_to_record


def test_clinicaltrials_study_to_record_preserves_nct_and_pico_text() -> None:
    record = study_to_record(
        {
            "protocolSection": {
                "identificationModule": {
                    "nctId": "NCT04348305",
                    "briefTitle": "Hydrocortisone for COVID-19 and Severe Hypoxia",
                },
                "statusModule": {
                    "overallStatus": "COMPLETED",
                    "startDateStruct": {"date": "April 2020"},
                },
                "descriptionModule": {
                    "briefSummary": "Trial of hydrocortisone in severe COVID-19.",
                },
                "conditionsModule": {"conditions": ["COVID-19", "Severe hypoxia"]},
                "armsInterventionsModule": {
                    "interventions": [{"name": "Hydrocortisone"}, {"name": "Placebo"}],
                },
                "outcomesModule": {
                    "primaryOutcomes": [{"measure": "Days alive without life support"}],
                    "secondaryOutcomes": [{"measure": "Mortality at day 28"}],
                },
                "eligibilityModule": {"eligibilityCriteria": "Adults with severe hypoxia."},
                "sponsorCollaboratorsModule": {"leadSponsor": {"name": "Rigshospitalet, Denmark"}},
            }
        }
    )

    assert record["source"] == "clinicaltrials"
    assert record["trial_registration"] == "NCT04348305"
    assert record["nct_id"] == "NCT04348305"
    assert record["title"] == "Hydrocortisone for COVID-19 and Severe Hypoxia"
    assert record["year"] == 2020
    assert "Hydrocortisone" in record["abstract"]
    assert "Mortality at day 28" in record["abstract"]


def test_extract_nct_ids_deduplicates_case_insensitive() -> None:
    assert extract_nct_ids("nct04348305 and NCT04348305 plus NCT04244591") == [
        "NCT04348305",
        "NCT04244591",
    ]


def test_clinicaltrials_search_sanitizes_pubmed_style_long_query(monkeypatch) -> None:
    captured = {}

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {"studies": []}

    def fake_get(url, params=None, timeout=5, headers=None):
        captured["query"] = params["query.term"]
        return FakeResponse()

    monkeypatch.setattr(clinicaltrials.requests, "get", fake_get)
    raw_query = (
        '"SARS-CoV-2"[mh] COVID-19 Coronavirus Infections covid 2019-ncov nCoV '
        'Critical Illness Intensive Care Units "Respiration, Artificial" critically ill ICU '
        'mechanical ventilation ventilat respiratory support non-invasive NIV high flow HFNC '
        'Adrenal Cortex Hormones dexamethasone hydrocortisone methylprednisolone randomized trial'
    )

    _, status = clinicaltrials.search_studies_with_status(raw_query, max_results=50)

    assert status["status"] == "ok"
    assert captured["query"] != raw_query
    assert len(captured["query"]) <= 240
    assert "[mh]" not in captured["query"]
    assert "," not in captured["query"]
    assert "SARS-CoV-2" not in captured["query"]
    assert "non-invasive" not in captured["query"]
    assert "dexamethasone" in captured["query"]
    assert "hydrocortisone" in captured["query"]


def test_clinicaltrials_search_cache_reuses_successful_payload(monkeypatch, tmp_path) -> None:
    calls = {"n": 0}

    def fake_search(query, max_results=20, timeout=5):
        calls["n"] += 1
        return (
            [{"title": "Hydrocortisone for COVID-19", "source": "clinicaltrials"}],
            {"query": query, "status": "ok", "n_records": 1, "error": ""},
        )

    monkeypatch.setattr(clinicaltrials, "search_studies_with_status", fake_search)

    first, first_status = search_studies_cached("COVID hydrocortisone", cache_dir=tmp_path)
    second, second_status = search_studies_cached("COVID hydrocortisone", cache_dir=tmp_path)

    assert calls["n"] == 1
    assert first == second
    assert first_status["status"] == "ok"
    assert second_status["status"] == "cached"


def test_clinicaltrials_fetch_cache_reuses_successful_nct_payload(monkeypatch, tmp_path) -> None:
    calls = {"n": 0}

    def fake_fetch(nct_id, timeout=5):
        calls["n"] += 1
        return (
            {"title": "Steroids-SARI", "trial_registration": nct_id, "source": "clinicaltrials"},
            {"nct_id": nct_id, "status": "ok", "n_records": 1, "error": ""},
        )

    monkeypatch.setattr(clinicaltrials, "fetch_study_with_status", fake_fetch)

    first, first_status = fetch_study_cached("NCT04244591", cache_dir=tmp_path)
    second, second_status = fetch_study_cached("NCT04244591", cache_dir=tmp_path)

    assert calls["n"] == 1
    assert first == second
    assert first_status["status"] == "ok"
    assert second_status["status"] == "cached"


def test_clinicaltrials_search_cache_reuses_recent_failure(monkeypatch, tmp_path) -> None:
    calls = {"n": 0}

    def fake_search(query, max_results=20, timeout=5):
        calls["n"] += 1
        return (
            [],
            {"query": query, "status": "failed", "n_records": 0, "error": "timeout"},
        )

    monkeypatch.setattr(clinicaltrials, "FAILED_CACHE_TTL", 3600)
    monkeypatch.setattr(clinicaltrials, "search_studies_with_status", fake_search)

    first, first_status = search_studies_cached("COVID hydrocortisone", cache_dir=tmp_path)
    second, second_status = search_studies_cached("COVID hydrocortisone", cache_dir=tmp_path)

    assert calls["n"] == 1
    assert first == second == []
    assert first_status["status"] == "failed"
    assert second_status["status"] == "cached_failed"


def test_clinicaltrials_search_cache_ignores_legacy_payload_without_schema_version(monkeypatch, tmp_path) -> None:
    legacy_path = tmp_path / "clinicaltrials_query_legacy.json"
    monkeypatch.setattr(clinicaltrials, "_cache_path", lambda cache_dir, kind, key: legacy_path)
    legacy_path.write_text(
        '{"records":[],"status":{"query":"old","status":"failed","n_records":0,"error":"400 bad request"},"cached_at":9999999999}',
        encoding="utf-8",
    )
    calls = {"n": 0}

    def fake_search(query, max_results=20, timeout=5):
        calls["n"] += 1
        return (
            [{"title": "Recovered registry result", "source": "clinicaltrials"}],
            {"query": query, "status": "ok", "n_records": 1, "error": ""},
        )

    monkeypatch.setattr(clinicaltrials, "search_studies_with_status", fake_search)

    records, status = search_studies_cached("COVID hydrocortisone", cache_dir=tmp_path)

    assert calls["n"] == 1
    assert records[0]["title"] == "Recovered registry result"
    assert status["status"] == "ok"


def test_clinicaltrials_search_cache_does_not_reuse_bad_request_failures(monkeypatch, tmp_path) -> None:
    calls = {"n": 0}

    def fake_search(query, max_results=20, timeout=5):
        calls["n"] += 1
        return (
            [],
            {
                "query": query,
                "status": "failed",
                "n_records": 0,
                "error": "400 Client Error: Bad Request",
            },
        )

    monkeypatch.setattr(clinicaltrials, "FAILED_CACHE_TTL", 3600)
    monkeypatch.setattr(clinicaltrials, "search_studies_with_status", fake_search)

    search_studies_cached("bad pubmed style query", cache_dir=tmp_path)
    search_studies_cached("bad pubmed style query", cache_dir=tmp_path)

    assert calls["n"] == 2


def test_clinicaltrials_fetch_cache_reuses_recent_failure(monkeypatch, tmp_path) -> None:
    calls = {"n": 0}

    def fake_fetch(nct_id, timeout=5):
        calls["n"] += 1
        return None, {"nct_id": nct_id, "status": "failed", "n_records": 0, "error": "timeout"}

    monkeypatch.setattr(clinicaltrials, "FAILED_CACHE_TTL", 3600)
    monkeypatch.setattr(clinicaltrials, "fetch_study_with_status", fake_fetch)

    first, first_status = fetch_study_cached("NCT04348305", cache_dir=tmp_path)
    second, second_status = fetch_study_cached("NCT04348305", cache_dir=tmp_path)

    assert calls["n"] == 1
    assert first is second is None
    assert first_status["status"] == "failed"
    assert second_status["status"] == "cached_failed"
