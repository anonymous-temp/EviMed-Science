from new_meta.tools.utils import first_author_lastname, paper_identity, safe_identifier
from new_meta.tools.reference_manager import ReferenceManager


def test_paper_identity_falls_back_from_pmid_to_doi() -> None:
    assert paper_identity({"pmid": "", "doi": "10.1101/abc"}) == "10.1101/abc"


def test_paper_identity_uses_title_hash_when_ids_missing() -> None:
    first = paper_identity({"title": "A Trial of Corticosteroids"})
    second = paper_identity({"title": "A  Trial   of Corticosteroids"})

    assert first == second
    assert first.startswith("title_")


def test_safe_identifier_removes_path_separators() -> None:
    assert safe_identifier("10.1101/2020.06.22") == "10.1101_2020.06.22"


def test_first_author_lastname_handles_display_names_without_breaking_pubmed_order() -> None:
    assert first_author_lastname(["Stefan D. Anker"]) == "Anker"
    assert first_author_lastname(["Scott D. Solomon"]) == "Solomon"
    assert first_author_lastname(["Rudolf A. de Boer"]) == "de Boer"
    assert first_author_lastname(["Anker Stefan D"]) == "Anker"
    assert first_author_lastname(["Packer M"]) == "Packer"


def test_reference_manager_author_year_uses_family_name_for_display_names() -> None:
    manager = ReferenceManager()

    assert manager.get_author_year({"authors": ["Stefan D. Anker", "Javed Butler"], "year": 2021}) == "Anker & Butler, 2021"
