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
