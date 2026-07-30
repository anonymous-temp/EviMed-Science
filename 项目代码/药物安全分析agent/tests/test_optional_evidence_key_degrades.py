"""A missing optional guideline credential must not take the analysis down."""
from pathlib import Path

from safety_agent.core.config import Settings
from safety_agent.evidence.evimed import EviMedEvidenceClient


def test_an_unreadable_key_file_disables_enrichment_instead_of_raising(tmp_path: Path) -> None:
    settings = Settings(evimed_evidence_search_key_file=tmp_path / "absent.api-key")
    assert settings.resolved_evimed_evidence_search_key.get_secret_value() == ""
    assert EviMedEvidenceClient.from_settings(settings).enabled is False


def test_a_readable_key_file_still_enables_enrichment(tmp_path: Path) -> None:
    key_file = tmp_path / "evimed.api-key"
    key_file.write_text("test-key-value\n", encoding="utf-8")
    key_file.chmod(0o600)
    settings = Settings(
        evimed_evidence_search_key_file=key_file,
        evimed_evidence_search_url="https://example.invalid/api",
    )
    assert settings.resolved_evimed_evidence_search_key.get_secret_value() == "test-key-value"
    assert EviMedEvidenceClient.from_settings(settings).enabled is True


def test_an_insecure_key_file_is_still_refused(tmp_path: Path) -> None:
    # A group-readable credential is an operator error, not a missing optional
    # feature, so it must keep failing loudly.
    key_file = tmp_path / "evimed.api-key"
    key_file.write_text("unsafe-test-key\n", encoding="utf-8")
    key_file.chmod(0o640)
    settings = Settings(evimed_evidence_search_key_file=key_file)
    try:
        settings.resolved_evimed_evidence_search_key
    except ValueError as error:
        assert "owner-only" in str(error)
    else:
        raise AssertionError("an insecure credential file must not be accepted")
