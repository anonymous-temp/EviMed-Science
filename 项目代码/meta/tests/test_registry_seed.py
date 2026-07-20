from new_meta.tools.registry_seed import load_seed_trials, search_seed_records, seed_to_record


def test_registry_seed_loads_metadata_only_records() -> None:
    seeds = load_seed_trials()
    nct_ids = {seed["nct_id"] for seed in seeds}

    assert "NCT04244591" in nct_ids
    assert "NCT04348305" in nct_ids
    assert all("expected_events_intervention" not in seed for seed in seeds)


def test_registry_seed_search_matches_steroids_sari_without_event_counts() -> None:
    records, status = search_seed_records(
        '("COVID-19"[tiab]) AND ("methylprednisolone"[tiab] OR "glucocorticoid"[tiab]) '
        'AND ("respiratory failure"[tiab] OR "critically ill"[tiab]) AND '
        '("standard care"[tiab]) AND ("randomized controlled trial"[tiab])',
        year_range=(2020, 2020),
    )

    by_nct = {record["nct_id"]: record for record in records}
    record = by_nct["NCT04244591"]
    assert status["n_records"] >= 1
    assert record["source"] == "registry_seed"
    assert record["source_type"] == "registry_seed"
    assert record["metadata_only"] is True
    assert record["text_availability"] == "metadata_only"
    assert record["needs_user_full_text"] is True
    assert "Steroids-SARI" in record["abstract"]
    assert "events_intervention" not in record
    assert "expected_events_intervention" not in record


def test_seed_to_record_preserves_registry_identity() -> None:
    record = seed_to_record({
        "nct_id": "NCT00000001",
        "title": "Example Trial",
        "aliases": ["Example Alias"],
        "brief_summary": "Randomized trial.",
        "conditions": ["Condition"],
        "interventions": ["Intervention", "Control"],
        "year": 2020,
        "source_url": "https://example.org/NCT00000001",
        "source_urls": [
            "https://clinicaltrials.gov/study/NCT00000001",
            "https://example.org/result-page",
        ],
    })

    assert record["trial_registration"] == "NCT00000001"
    assert record["nct_id"] == "NCT00000001"
    assert record["url"] == "https://example.org/NCT00000001"
    assert record["source_urls"] == [
        "https://clinicaltrials.gov/study/NCT00000001",
        "https://example.org/result-page",
    ]
    assert record["source_warning"] == "registry_seed_metadata_only"
    assert record["text_availability"] == "metadata_only"
