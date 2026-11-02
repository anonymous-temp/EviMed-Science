import importlib.util
import hashlib
import json
from pathlib import Path

import pytest


spec = importlib.util.spec_from_file_location("api_artifact_judge", Path(__file__).with_name("judge.py"))
judge_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(judge_module)


def make_capture(tmp_path, estimate):
    turn = tmp_path / "turn-0"
    turn.mkdir()
    values = judge_module.reference("paired-sleep")
    values["estimate"] = estimate
    (turn / "result.json").write_text(json.dumps({"result": {"structuredResults": values}}))
    (turn / "downloads.json").write_text("[]")
    return {"case": "paired-sleep", "turns": [{"index": 0, "requireFigure": False, "required": list(values),
            "bindings": {name: {"path": ["result", "structuredResults", name]} for name in values}}]}


def test_wrong_primary_result_fails_independent_check(tmp_path):
    bindings = make_capture(tmp_path, -1.58)
    result = judge_module.judge(tmp_path, bindings)
    assert result["passed"] is False
    assert next(row for row in result["checks"] if row["quantity"] == "estimate")["reference"] == pytest.approx(1.58)


def test_boolean_cannot_masquerade_as_an_estimate(tmp_path):
    bindings = make_capture(tmp_path, True)
    with pytest.raises(ValueError, match="finite number"):
        judge_module.judge(tmp_path, bindings)


def test_required_quantity_and_figure_cannot_be_omitted(tmp_path):
    bindings = make_capture(tmp_path, 1.58)
    bindings["turns"][0]["requireFigure"] = True
    assert judge_module.judge(tmp_path, bindings)["passed"] is False
    bindings["turns"][0]["bindings"].pop("pValue")
    with pytest.raises(ValueError, match="Every required"):
        judge_module.judge(tmp_path, bindings)


def test_empty_or_duplicate_turns_cannot_pass(tmp_path):
    with pytest.raises(ValueError, match="nonempty"):
        judge_module.judge(tmp_path, {"case": "paired-sleep", "turns": []})
    bindings = make_capture(tmp_path, 1.58)
    bindings["turns"].append(bindings["turns"][0])
    with pytest.raises(ValueError, match="unique"):
        judge_module.judge(tmp_path, bindings)


@pytest.mark.parametrize("bad", [float("inf"), float("nan"), -1, True])
def test_relative_tolerance_cannot_hide_a_wrong_answer(tmp_path, bad):
    bindings = make_capture(tmp_path, -10000)
    bindings["turns"][0]["bindings"]["estimate"]["relativeTolerance"] = bad
    with pytest.raises(ValueError, match="tolerance"):
        judge_module.judge(tmp_path, bindings)


def test_a_non_svg_root_is_not_a_figure(tmp_path):
    bindings = make_capture(tmp_path, 1.58)
    bindings["turns"][0]["requireFigure"] = True
    raw = b'<notsvg width="100" height="100"><path d="M 0 0 L 100 100"/></notsvg>'
    (tmp_path / "turn-0/fake.svg").write_bytes(raw)
    (tmp_path / "turn-0/downloads.json").write_text(json.dumps([{"stored": "fake.svg", "filename": "fake.svg", "role": "figure", "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}]))
    assert judge_module.judge(tmp_path, bindings)["passed"] is False
