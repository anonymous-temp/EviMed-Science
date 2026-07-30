"""The reference requirement must track the evidence a review actually has."""
from new_meta.core.artifact_package_citation_audit import (
    CITATION_AUDIT_MIN_REFERENCES,
    CITATION_AUDIT_PUBLICATION_MIN_REFERENCES,
    _publication_min_references,
)


def _facts(n_studies: int) -> dict:
    return {"report_type": "meta", "primary_effect": {"n_studies": n_studies}}


def test_a_thin_review_is_not_asked_to_pad_its_background() -> None:
    assert _publication_min_references(_facts(3)) == CITATION_AUDIT_MIN_REFERENCES + 3
    assert _publication_min_references(_facts(3)) < CITATION_AUDIT_PUBLICATION_MIN_REFERENCES


def test_an_invisible_evidence_base_keeps_the_full_target() -> None:
    # A long formal draft with no readable facts must not benefit from the doubt.
    assert _publication_min_references(_facts(0)) == CITATION_AUDIT_PUBLICATION_MIN_REFERENCES
    assert _publication_min_references({}) == CITATION_AUDIT_PUBLICATION_MIN_REFERENCES


def test_a_full_evidence_base_still_reaches_the_publication_target() -> None:
    assert _publication_min_references(_facts(8)) == CITATION_AUDIT_PUBLICATION_MIN_REFERENCES
    assert _publication_min_references(_facts(40)) == CITATION_AUDIT_PUBLICATION_MIN_REFERENCES
