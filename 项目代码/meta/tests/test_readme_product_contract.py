from pathlib import Path


README = Path(__file__).resolve().parents[1] / "README.md"


def test_readme_leads_with_one_topic_to_article_command() -> None:
    text = README.read_text(encoding="utf-8")

    assert 'metaagent --topic "' in text
    assert "--skip-confirm" in text
    assert "Automatic full-text retrieval runs before any upload request" in text
    assert "methodological certainty" in text
    assert "clinically distinct analysis sets" in text


def test_readme_truthfully_lists_released_method_scope() -> None:
    text = README.read_text(encoding="utf-8")

    for capability in (
        "Pairwise parallel-group RCT",
        "Single-arm prevalence",
        "Single-arm incidence",
        "Diagnostic accuracy",
        "Adjusted cohort NRSI",
        "Adjusted prognostic factor",
        "External-validation c-statistic",
    ):
        assert capability in text
    assert "Not production-released" in text
    assert "network meta-analysis" in text.lower()
    assert "dose-response" in text.lower()
    assert "IPD" in text


def test_readme_runtime_and_acquisition_claims_match_product() -> None:
    text = README.read_text(encoding="utf-8")

    assert "Python 3.10–3.12" in text
    assert "SCIHUB_BASE_URL" not in text
    assert "Python >= 3.9" not in text
    assert "The system will walk through a 12-step pipeline interactively" not in text
