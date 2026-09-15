"""The adapter holds no policy, and these cases are what asserts that.

Every rule about external memory — inferred, pending, scope, rate — belongs to
the control plane. What this file checks is that the adapter passes the call
through without adding an opinion, and that when it cannot reach the service it
says which of the three reasons it is.
"""

import importlib.util
import json
import pathlib
import sys
import unittest
import urllib.error
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("evimed_memory_mcp", ROOT / "server.py")
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class Response:
    def __init__(self, payload):
        self._payload = json.dumps(payload).encode("utf-8")

    def read(self, _size=None):
        return self._payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


CONFIGURED = {"EVIMED_MEMORY_API_URL": "https://evimed.example/api/agent-memory/v1", "EVIMED_MEMORY_API_KEY": "evk_x"}


class AdapterTests(unittest.TestCase):
    def test_two_tools_and_no_more(self):
        # The catalogue is a first-turn cost. Recall and note are what an agent
        # does with memory; records and episodes are operator actions with an
        # HTTP endpoint of their own.
        self.assertEqual([tool["name"] for tool in server.TOOLS], ["memory_recall", "memory_note"])

    def test_a_note_never_carries_an_origin(self):
        seen = {}

        def opener(request, timeout=None):
            seen["url"] = request.full_url
            seen["body"] = json.loads(request.data.decode("utf-8"))
            seen["auth"] = request.headers.get("Authorization")
            return Response({"data": {"entry": {"id": "e1"}, "reviewRequired": True}})

        with mock.patch.dict(server.os.environ, CONFIGURED, clear=True):
            result = server.call_tool("memory_note", {"factKind": "preference", "content": "用中文"}, opener)

        self.assertTrue(result["ok"])
        self.assertEqual(seen["url"], "https://evimed.example/api/agent-memory/v1/note")
        self.assertEqual(sorted(seen["body"]), ["content", "factKind"])
        self.assertEqual(seen["auth"], "Bearer evk_x")
        self.assertTrue(result["data"]["reviewRequired"])

    def test_the_services_own_code_reaches_the_model(self):
        # A scope refusal and a rate limit need different next moves, and
        # "HTTP 403" tells the model neither.
        def opener(_request, timeout=None):
            raise urllib.error.HTTPError(
                "https://evimed.example", 403, "Forbidden", {},
                __import__("io").BytesIO(json.dumps(
                    {"error": {"code": "agent_key_scope_denied", "message": "no write scope"}}
                ).encode("utf-8")),
            )

        with mock.patch.dict(server.os.environ, CONFIGURED, clear=True):
            result = server.call_tool("memory_note", {"factKind": "preference", "content": "x"}, opener)
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "agent_key_scope_denied")

    def test_unconfigured_and_unauthenticated_are_different_answers(self):
        with mock.patch.dict(server.os.environ, {}, clear=True):
            self.assertEqual(server.call_tool("memory_recall", {"query": "x"})["code"], "memory_adapter_unconfigured")
        with mock.patch.dict(server.os.environ, {"EVIMED_MEMORY_API_URL": "https://evimed.example/v1"}, clear=True):
            self.assertEqual(server.call_tool("memory_recall", {"query": "x"})["code"], "memory_adapter_unauthenticated")

    def test_a_key_file_is_preferred_to_a_key_in_the_environment(self):
        import tempfile
        with tempfile.NamedTemporaryFile("w", suffix=".key", delete=False) as handle:
            handle.write("evk_from_file\n")
            path = handle.name
        seen = {}

        def opener(request, timeout=None):
            seen["auth"] = request.headers.get("Authorization")
            return Response({"data": {"items": []}})

        with mock.patch.dict(server.os.environ, {**CONFIGURED, "EVIMED_MEMORY_API_KEY_FILE": path}, clear=True):
            server.call_tool("memory_recall", {"query": "x"}, opener)
        self.assertEqual(seen["auth"], "Bearer evk_from_file")

    def test_an_unreachable_service_is_reported_and_not_raised(self):
        def opener(_request, timeout=None):
            raise urllib.error.URLError("connection refused")

        with mock.patch.dict(server.os.environ, CONFIGURED, clear=True):
            result = server.call_tool("memory_recall", {"query": "x"}, opener)
        self.assertEqual(result["code"], "memory_service_unavailable")

    def test_the_protocol_surface_answers_initialize_list_and_call(self):
        initialize = server.handle_request({"jsonrpc": "2.0", "id": 1, "method": "initialize"})
        self.assertEqual(initialize["result"]["serverInfo"]["name"], "evimed-memory")
        listed = server.handle_request({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        self.assertEqual(len(listed["result"]["tools"]), 2)
        missing = server.handle_request({
            "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": {"name": "memory_note", "arguments": {"factKind": "preference"}},
        })
        self.assertIn("missing required argument", missing["error"]["message"])
        unknown = server.handle_request({
            "jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "memory_wipe", "arguments": {}},
        })
        self.assertEqual(unknown["error"]["code"], -32601)

    def test_a_failed_call_is_marked_as_an_error_in_the_protocol_result(self):
        with mock.patch.dict(server.os.environ, {}, clear=True):
            answer = server.handle_request({
                "jsonrpc": "2.0", "id": 5, "method": "tools/call",
                "params": {"name": "memory_recall", "arguments": {"query": "x"}},
            })
        self.assertTrue(answer["result"]["isError"])


if __name__ == "__main__":
    unittest.main()
