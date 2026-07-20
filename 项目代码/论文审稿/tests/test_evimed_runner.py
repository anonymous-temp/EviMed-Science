from types import SimpleNamespace

from evimed_runner import _report_markdown


def test_report_markdown_explains_empty_optional_sections():
    narrative = SimpleNamespace(
        title="Evidence review",
        overall_evaluation="Overall evaluation with sufficient detail.",
        key_strengths_narrative="   ",
        critical_issues_narrative="A critical issue with supporting evidence.",
        minor_suggestions_narrative="",
        recommendation_narrative="Major revision.",
    )
    result = SimpleNamespace(
        document_title="Fallback title",
        narrative_report=narrative,
    )

    report = _report_markdown(result)

    assert "未识别到可由手稿原文充分支持的明确优势" in report
    assert "未识别到独立于上述关键问题之外" in report
    assert "## Key strengths\n\n\n\n##" not in report
