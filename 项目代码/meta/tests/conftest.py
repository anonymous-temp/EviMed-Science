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
