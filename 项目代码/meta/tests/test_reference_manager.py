from new_meta.tools import reference_manager
from new_meta.tools.reference_manager import ReferenceManager


def test_reference_manager_enriches_missing_journal_volume_and_pages_from_doi_metadata(monkeypatch) -> None:
    monkeypatch.setattr(
        reference_manager,
        "_fetch_crossref_metadata",
        lambda doi: {
            "journal": "New England Journal of Medicine",
            "volume": "385",
            "issue": "16",
            "pages": "1451-1461",
            "year": 2021,
        },
    )
    manager = ReferenceManager()

    manager.add({
        "title": "Empagliflozin in Heart Failure with a Preserved Ejection Fraction",
        "authors": ["Anker SD", "Butler J"],
        "year": 2021,
        "journal": "",
        "doi": "10.1056/NEJMoa2107038",
        "pmid": "34449189",
    })

    entry = manager.entries[0]
    assert entry["journal"] == "New England Journal of Medicine"
    assert entry["volume"] == "385"
    assert entry["issue"] == "16"
    assert entry["pages"] == "1451-1461"
    assert "*New England Journal of Medicine*. 2021;385(16):1451-1461." in manager.to_numbered_list()
    assert "volume = {385}" in manager.to_bibtex()
    assert "pages = {1451-1461}" in manager.to_bibtex()


def test_reference_manager_does_not_call_doi_enrichment_when_journal_details_are_complete(monkeypatch) -> None:
    calls = []
    monkeypatch.setattr(reference_manager, "_fetch_crossref_metadata", lambda doi: calls.append(doi) or {})
    manager = ReferenceManager()

    manager.add({
        "title": "Complete reference",
        "authors": ["Smith J"],
        "year": 2024,
        "journal": "Lancet",
        "volume": "400",
        "pages": "1-9",
        "doi": "10.1000/example",
    })

    assert calls == []
    assert "*Lancet*. 2024;400:1-9." in manager.to_numbered_list()


def test_reference_manager_caps_extreme_bibtex_author_lists_with_others(monkeypatch) -> None:
    monkeypatch.setattr(reference_manager, "_fetch_crossref_metadata", lambda doi: {})
    manager = ReferenceManager()
    authors = [f"Author {index}" for index in range(1, 80)]

    manager.add({
        "title": "Large collaborative trial",
        "authors": authors,
        "year": 2024,
        "journal": "JAMA",
        "volume": "330",
        "pages": "1-9",
        "doi": "10.1000/large",
    })

    bibtex = manager.to_bibtex()
    assert "Author 1 and Author 2 and Author 3 and Author 4 and Author 5 and Author 6 and others" in bibtex
    assert "Author 7" not in bibtex


def test_reference_manager_bibtex_keys_do_not_contain_spaces(monkeypatch) -> None:
    monkeypatch.setattr(reference_manager, "_fetch_crossref_metadata", lambda doi: {})
    manager = ReferenceManager()

    manager.add({
        "title": "Targeted Steroids for ARDS Due to COVID-19 Pneumonia",
        "authors": ["University of Colorado, Denver"],
        "year": 2020,
        "journal": "ClinicalTrials.gov",
        "url": "https://clinicaltrials.gov/study/NCT04360876",
    })

    first_line = manager.to_bibtex().splitlines()[0]

    assert first_line == "@article{universityofcolorado2020_1,"


def test_crossref_metadata_uses_article_number_when_page_range_is_absent() -> None:
    metadata = reference_manager._crossref_message_to_reference_metadata({
        "container-title": ["Trials"],
        "volume": "21",
        "issue": "1",
        "article-number": "717",
        "issued": {"date-parts": [[2020, 8, 1]]},
    })

    assert metadata["journal"] == "Trials"
    assert metadata["volume"] == "21"
    assert metadata["pages"] == "717"
