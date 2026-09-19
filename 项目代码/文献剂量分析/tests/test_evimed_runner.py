import json

import evimed_runner


def test_runner_passes_requested_output_language(tmp_path, monkeypatch):
    captured = {}

    class FakePipeline:
        def __init__(self, **kwargs):
            captured.update(kwargs)
            self.articles = [{"pmid": "1"}]
            self.output_dir = kwargs["config"].output_dir

        def run(self):
            (self.output_dir / "report.md").write_text(
                "# 中文文献计量报告\n" + "经验证的报告内容。" * 20,
                encoding="utf-8",
            )

    class FakeConfig:
        def __init__(self, output_dir):
            self.output_dir = output_dir

    monkeypatch.setattr(
        "bibliometric.config.load_config",
        lambda output_dir: FakeConfig(tmp_path),
    )
    monkeypatch.setattr("bibliometric.pipeline.AnalysisPipeline", FakePipeline)

    request_path = tmp_path / "request.json"
    request_path.write_text(
        json.dumps({
            "topic": "osimertinib",
            "dateFrom": "2021",
            "dateTo": "2025",
            "maxRecords": 20,
            "outputLanguage": "zh",
        }),
        encoding="utf-8",
    )

    assert evimed_runner.run(request_path, tmp_path) == 0
    assert captured["lang"] == "zh"
    result = json.loads((tmp_path / "result.json").read_text(encoding="utf-8"))
    assert result["status"] == "succeeded"
    assert result["records"] == 1


def test_runner_reports_what_the_job_spent_on_either_outcome(tmp_path, monkeypatch):
    """result.json carries the job's provider usage for EviMed's usage ledger,
    and a failed job's tokens were paid for too."""
    from bibliometric.llm import usage as provider_usage

    class SpendingPipeline:
        fail = False

        def __init__(self, **kwargs):
            self.articles = [{"pmid": "1"}]
            self.output_dir = kwargs["config"].output_dir

        def run(self):
            provider_usage.record({"prompt_tokens": 900, "prompt_cache_hit_tokens": 700,
                                   "prompt_cache_miss_tokens": 200, "completion_tokens": 80}, "deepseek-flash")
            if self.fail:
                raise RuntimeError("pipeline exploded")
            (self.output_dir / "report.md").write_text("# 报告\n" + "内容。" * 60, encoding="utf-8")

    class FakeConfig:
        def __init__(self, output_dir):
            self.output_dir = output_dir

    for fail, code in ((False, 0), (True, 1)):
        provider_usage.reset()
        SpendingPipeline.fail = fail
        out = tmp_path / f"out-{code}"
        out.mkdir()
        monkeypatch.setattr("bibliometric.config.load_config", lambda output_dir, out=out: FakeConfig(out))
        monkeypatch.setattr("bibliometric.pipeline.AnalysisPipeline", SpendingPipeline)
        request_path = tmp_path / "request.json"
        request_path.write_text(json.dumps({"topic": "osimertinib", "maxRecords": 20}), encoding="utf-8")
        assert evimed_runner.run(request_path, out) == code
        result = json.loads((out / "result.json").read_text(encoding="utf-8"))
        assert result["usage"] == {"requests": 1, "cacheHitTokens": 700, "cacheMissTokens": 200,
                                   "outputTokens": 80, "model": "deepseek-flash"}, result
    provider_usage.reset()
