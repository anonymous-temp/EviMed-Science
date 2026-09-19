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


def test_runner_reports_what_the_job_spent_on_either_outcome(tmp_path, monkeypatch):
    """result.json carries the job's provider usage for EviMed's usage ledger;
    a failed job's tokens were paid for too."""
    import json

    import evimed_runner
    from src.services import llm_usage as provider_usage

    async def spend_then(outcome):
        provider_usage.record({"prompt_tokens": 800, "prompt_cache_hit_tokens": 600,
                               "prompt_cache_miss_tokens": 200, "completion_tokens": 90}, "deepseek-flash")
        if outcome == "failed":
            raise RuntimeError("review exploded")
        return {"status": "succeeded"}

    for outcome, code in (("succeeded", 0), ("failed", 1)):
        provider_usage.reset()
        monkeypatch.setattr(evimed_runner, "_review", lambda request, output_dir, outcome=outcome: spend_then(outcome))
        request = tmp_path / "request.json"
        request.write_text(json.dumps({"manuscript": "paper.pdf"}), encoding="utf-8")
        out = tmp_path / outcome
        assert evimed_runner.run(request, out) == code
        result = json.loads((out / "result.json").read_text(encoding="utf-8"))
        assert result["status"] == outcome
        assert result["usage"] == {"requests": 1, "cacheHitTokens": 600, "cacheMissTokens": 200,
                                   "outputTokens": 90, "model": "deepseek-flash"}
    provider_usage.reset()
