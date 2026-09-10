"""Prompt output keys and code read keys must be the same vocabulary (R041),
templated candidates must not stand in for findings (R042), and the mock reply
must not reach a managed run (R043)."""

import ast
import json
import os
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
PROMPTS_SOURCE = (ROOT / "config" / "prompts.py").read_text(encoding="utf-8")
MODULES_SOURCE = (ROOT / "modules" / "new_analysis_modules.py").read_text(encoding="utf-8")

# module tag -> (prompt constant, module class, the variable holding the parsed reply)
MODULES = {
    "M1": ("M1_PROBLEM_LANDSCAPE_PROMPT", "M1_ProblemLandscapeModule", "analysis_result"),
    "M2": ("M2_RESEARCH_ECOSYSTEM_PROMPT", "M2_ResearchEcosystemModule", "ecosystem_analysis"),
    "M3": ("M3_EVIDENCE_SYSTEM_PROMPT", "M3_EvidenceSystemModule", "system_analysis"),
    "M4": ("M4_SCIENTIFIC_CONTRADICTION_PROMPT", "M4_ScientificContradictionModule",
           "contradiction_analysis"),
    "M5": ("M5_BREAKTHROUGH_OPPORTUNITY_PROMPT", "M5_BreakthroughOpportunityModule",
           "bom_analysis"),
    "M6": ("M6_RESEARCH_AGENDA_PROMPT", "M6_ResearchAgendaModule", "agenda"),
}


def _prompt_bodies():
    bodies = {}
    for node in ast.parse(PROMPTS_SOURCE).body:
        if (isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name)
                and isinstance(node.value, ast.Constant)):
            bodies[node.targets[0].id] = node.value.value
    return bodies


def _schema_block(prompt: str) -> str:
    """The JSON schema the prompt asks for, with .format() escaping undone."""
    marker = prompt.find("输出JSON格式")
    if marker < 0:
        marker = prompt.find("输出要求")
    body = prompt[marker:]
    start = body.find("{{")
    assert start >= 0, "prompt has no JSON schema block"
    depth, index = 0, start
    while index < len(body) - 1:
        pair = body[index:index + 2]
        if pair == "{{":
            depth += 1
            index += 2
            continue
        if pair == "}}":
            depth -= 1
            index += 2
            if depth == 0:
                return body[start:index].replace("{{", "{").replace("}}", "}")
            continue
        index += 1
    raise AssertionError("unterminated JSON schema block")


def _top_level_keys(block: str) -> set[str]:
    depth, keys, index = 0, set(), 0
    while index < len(block):
        char = block[index]
        if char in "{[":
            depth += 1
        elif char in "}]":
            depth -= 1
        elif depth == 1 and char == '"':
            end = block.find('"', index + 1)
            if end > 0 and re.match(r"\s*:", block[end + 1:end + 4]):
                keys.add(block[index + 1:end])
            index = end
        index += 1
    return keys


def _class_node(class_name: str) -> ast.ClassDef:
    for node in ast.walk(ast.parse(MODULES_SOURCE)):
        if isinstance(node, ast.ClassDef) and node.name == class_name:
            return node
    raise AssertionError(f"class {class_name} not found")


def _keys_read(class_name: str, variable: str) -> set[str]:
    keys = set()
    for node in ast.walk(_class_node(class_name)):
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr == "get"
                and isinstance(node.func.value, ast.Name)
                and node.func.value.id == variable
                and node.args and isinstance(node.args[0], ast.Constant)
                and isinstance(node.args[0].value, str)):
            keys.add(node.args[0].value)
    return keys


def _fallback_dicts(class_name: str) -> list[set[str]]:
    """Keys of the dict literals the module returns when the model call fails."""
    out = []
    for node in ast.walk(_class_node(class_name)):
        if isinstance(node, ast.Return) and isinstance(node.value, ast.Dict):
            keys = {k.value for k in node.value.keys
                    if isinstance(k, ast.Constant) and isinstance(k.value, str)}
            if "deep_analysis" in keys:
                out.append(keys)
    return out


# --------------------------------------------------------------------- R041

@pytest.mark.parametrize("tag", sorted(MODULES))
def test_every_key_the_code_reads_is_a_key_the_prompt_emits(tag):
    prompt_name, class_name, variable = MODULES[tag]
    emitted = _top_level_keys(_schema_block(_prompt_bodies()[prompt_name]))
    read = _keys_read(class_name, variable)
    assert read, f"{tag}: found no reads off {variable}; the test would pass vacuously"
    assert read <= emitted, (
        f"{tag} reads keys the prompt never emits: {sorted(read - emitted)}"
    )


@pytest.mark.parametrize("tag", sorted(MODULES))
def test_the_failure_fallback_uses_the_same_key_vocabulary(tag):
    prompt_name, class_name, _ = MODULES[tag]
    emitted = _top_level_keys(_schema_block(_prompt_bodies()[prompt_name]))
    fallbacks = _fallback_dicts(class_name)
    assert fallbacks, f"{tag}: no failure fallback dict found"
    for keys in fallbacks:
        assert keys <= emitted, f"{tag} fallback emits unknown keys: {sorted(keys - emitted)}"


def test_m3_feeds_m5_a_populated_bridge_gap_list():
    """bridge_gaps was read off a key M3's prompt never emitted, so M5's prompt
    received an empty list on every run."""
    assert 'system_analysis.get("bridge_gaps"' not in MODULES_SOURCE
    assert '"bridge_gaps": [' in MODULES_SOURCE
    assert 'signal.get("bottleneck"' in MODULES_SOURCE


# --------------------------------------------------------------------- R042

def test_the_templated_opportunities_are_gone():
    assert "_fallback_opportunities" not in MODULES_SOURCE
    assert '"opportunity_id": "BOM-F' not in MODULES_SOURCE


def test_too_few_grounded_opportunities_fails_the_module():
    from models.schemas import ModuleOutput  # noqa: F401  (import shape check)
    from modules.new_analysis_modules import MIN_GROUNDED_OPPORTUNITIES

    assert MIN_GROUNDED_OPPORTUNITIES == 2
    source = MODULES_SOURCE[MODULES_SOURCE.index("class M5_BreakthroughOpportunityModule"):]
    guard = source[source.index("if len(opportunities) < MIN_GROUNDED_OPPORTUNITIES:"):]
    body = guard[:guard.index("charts = []")]
    assert 'status="failed"' in body
    assert "insufficient_grounded_opportunities" in body


def test_the_runner_reports_the_module_failure_code(tmp_path, monkeypatch):
    import evimed_runner

    class _Failure(RuntimeError):
        code = "insufficient_grounded_opportunities"

    async def _boom(request, output_dir):
        raise _Failure("research-topic pipeline contains failed analysis modules: "
                       "M5_BREAKTHROUGH_OPPORTUNITY")

    monkeypatch.setattr(evimed_runner, "_analyze", _boom)
    request = tmp_path / "request.json"
    request.write_text(json.dumps({"direction": "sepsis"}), encoding="utf-8")

    assert evimed_runner.run(request, tmp_path) == 1
    result = json.loads((tmp_path / "result.json").read_text(encoding="utf-8"))
    assert result["status"] == "failed"
    assert result["errorCode"] == "insufficient_grounded_opportunities"


# --------------------------------------------------------------------- R043

def _service():
    from services.llm_service import LLMService

    service = LLMService.__new__(LLMService)
    service.client = None
    return service


def test_a_managed_run_never_receives_the_development_stub(monkeypatch):
    from services.llm_service import LLMUnavailableError

    monkeypatch.setenv("EVIMED_MANAGED_RUN", "1")
    monkeypatch.setenv("EVIMED_MOCK", "1")
    with pytest.raises(LLMUnavailableError):
        _service()._get_mock_response("任何题目", json_mode=True)


def test_a_missing_key_fails_instead_of_answering_about_rituximab(monkeypatch):
    from services.llm_service import LLMUnavailableError

    monkeypatch.delenv("EVIMED_MANAGED_RUN", raising=False)
    monkeypatch.delenv("EVIMED_MOCK", raising=False)
    with pytest.raises(LLMUnavailableError) as raised:
        _service()._get_mock_response("脓毒症的研究选题", json_mode=True)
    assert "DEEPSEEK_API_KEY" in str(raised.value)


def test_the_stub_is_still_available_for_local_development(monkeypatch):
    monkeypatch.delenv("EVIMED_MANAGED_RUN", raising=False)
    monkeypatch.setenv("EVIMED_MOCK", "1")
    reply = json.loads(_service()._get_mock_response("任何题目", json_mode=True))
    assert reply["pico_entities"]["intervention"] == ["rituximab"]


def test_the_managed_runner_marks_itself_before_anything_calls_the_model():
    source = (ROOT / "evimed_runner.py").read_text(encoding="utf-8")
    marker = source.index('os.environ["EVIMED_MANAGED_RUN"] = "1"')
    # It has to be set at import time, before TaskService/LLMService are built.
    assert "def " not in source[:marker]


# ------------------------------------------------- module ledger (class D)

def _completed(module_outputs, evidence_records):
    from types import SimpleNamespace

    return SimpleNamespace(module_outputs=module_outputs, evidence_records=evidence_records)


def test_every_successful_module_is_ok_and_the_run_is_not_degraded():
    import evimed_runner
    from models.schemas import ModuleOutput

    completed = _completed(
        {f"M{i}": ModuleOutput(module_id=f"M{i}", status="success") for i in range(1, 7)},
        [object()],
    )
    modules = evimed_runner._module_ledger(completed, completed.evidence_records)
    assert set(modules) == {f"M{i}" for i in range(1, 7)} | {"evidenceRetrieval"}
    assert all(entry["status"] == "ok" for entry in modules.values())
    assert evimed_runner._degraded(modules) is False


def test_a_failed_module_is_fatal_and_keeps_its_reason():
    import evimed_runner
    from models.schemas import ModuleOutput

    completed = _completed(
        {
            "M5_BREAKTHROUGH_OPPORTUNITY": ModuleOutput(
                module_id="M5_BREAKTHROUGH_OPPORTUNITY", status="failed",
                error_message=(
                    "insufficient_grounded_opportunities: 1 of 2 required breakthrough "
                    "opportunities were traceable to retrieved evidence"
                ),
            ),
        },
        [object()],
    )
    modules = evimed_runner._module_ledger(completed, completed.evidence_records)
    entry = modules["M5_BREAKTHROUGH_OPPORTUNITY"]
    assert entry["status"] == "failed"
    assert entry["fatal"] is True
    assert "insufficient_grounded_opportunities" in entry["reason"]


def test_an_empty_evidence_set_is_a_fatal_ledger_entry():
    import evimed_runner

    modules = evimed_runner._module_ledger(_completed({}, []), [])
    assert modules["evidenceRetrieval"]["fatal"] is True


def test_the_failed_result_json_carries_the_ledger(tmp_path, monkeypatch):
    import evimed_runner

    class _Failure(RuntimeError):
        code = "insufficient_grounded_opportunities"
        modules = {"M5_BREAKTHROUGH_OPPORTUNITY": {"status": "failed", "fatal": True}}

    async def _boom(request, output_dir):
        raise _Failure("failed analysis modules")

    monkeypatch.setattr(evimed_runner, "_analyze", _boom)
    request = tmp_path / "request.json"
    request.write_text(json.dumps({"direction": "sepsis"}), encoding="utf-8")
    assert evimed_runner.run(request, tmp_path) == 1
    result = json.loads((tmp_path / "result.json").read_text(encoding="utf-8"))
    assert result["degraded"] is True
    assert result["modules"]["M5_BREAKTHROUGH_OPPORTUNITY"]["fatal"] is True
