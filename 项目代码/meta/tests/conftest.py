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


@pytest.fixture(autouse=True)
def forbid_unmocked_extraction_verification_calls(monkeypatch):
    """Missing verifier fixture evidence must fail instead of reaching a provider."""
    from new_meta.agents.data_extraction_agent import DataExtractionAgent
    from new_meta.core.agent_base import BaseAgent
    from new_meta.core.llm import LLMClient
    original_structured = LLMClient.structured_output
    original_call = LLMClient._call
    original_agent_call = BaseAgent.call_llm_structured

    def protect(method):
        def guarded(self, *args, **kwargs):
            if (getattr(self.call_llm_structured, "__func__", None) is original_agent_call
                    and getattr(self.llm.structured_output, "__func__", None) is original_structured
                    and getattr(self.llm._call, "__func__", None) is original_call):
                raise AssertionError("Provide a mocked independent extraction verification response; live verifier-model calls are forbidden in unit tests")
            return method(self, *args, **kwargs)
        return guarded

    for name in ("_check_extraction", "_refine_extraction"):
        monkeypatch.setattr(DataExtractionAgent, name, protect(getattr(DataExtractionAgent, name)))


@pytest.fixture(autouse=True)
def forbid_external_http_transports(monkeypatch):
    """Offline tests may use MockTransport or loopback HTTP fixtures only."""
    import ipaddress
    import httpx

    attempts = []
    original_sync = httpx.HTTPTransport.handle_request
    original_async = httpx.AsyncHTTPTransport.handle_async_request

    def check(request):
        host = request.url.host.casefold().rstrip(".")
        if host == "localhost":
            return
        try:
            if ipaddress.ip_address(host).is_loopback:
                return
        except ValueError:
            pass
        # Never record credentials, request bodies, or URL query parameters.
        attempts.append(f"{request.method} {host}")
        raise AssertionError("Unexpected external HTTP request blocked; provide an offline transport fixture")

    def handle_request(transport, request):
        check(request)
        return original_sync(transport, request)

    async def handle_async_request(transport, request):
        check(request)
        return await original_async(transport, request)

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", handle_request)
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", handle_async_request)
    yield
    assert not attempts, f"Unexpected external HTTP attempts occurred even if caught by production code: {attempts}"
