"""Pytest collection helpers for legacy script-style checks."""
import sys

import pytest

collect_ignore = ["test_deep.py", "test_e2e.py", "test_phase_fixes.py"]


@pytest.fixture
def patch_writing_helper(monkeypatch):
    """Replace a helper the writing agent imported by name.

    The agent is split across new_meta.agents.writing.*, and each module binds
    the helpers it uses at import time, so patching one module would leave the
    other call paths on the real implementation.
    """

    def patch(name, value):
        patched = []
        for module_name, module in list(sys.modules.items()):
            if module_name.startswith("new_meta.agents.writing") and hasattr(module, name):
                monkeypatch.setattr(module, name, value)
                patched.append(module_name)
        assert patched, f"no writing agent module imported {name}"
        return patched

    return patch


@pytest.fixture(autouse=True)
def forbid_unmocked_protocol_scope_calls(monkeypatch):
    """A new scope precondition must never turn an offline fixture into a live call."""
    from new_meta.agents.research_planner import ResearchPlanner
    from new_meta.core.llm import LLMClient
    original_check = ResearchPlanner.check_scope
    original_structured = LLMClient.structured_output
    original_call = LLMClient._call

    def guarded(self, topic, protocol):
        if (getattr(self.llm.structured_output, "__func__", None) is original_structured
                and getattr(self.llm._call, "__func__", None) is original_call):
            raise AssertionError("Provide a mocked independent scope response or a scope receipt; live scope-model calls are forbidden in unit tests")
        return original_check(self, topic, protocol)

    monkeypatch.setattr(ResearchPlanner, "check_scope", guarded)
