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

    def test_a_recall_names_the_time_of_the_question_only_when_it_has_one(self):
        bodies = []

        def opener(request, timeout=None):
            bodies.append(json.loads(request.data.decode("utf-8")))
            return Response({"data": {"items": [], "contextOnly": True}})

        with mock.patch.dict(server.os.environ, CONFIGURED, clear=True):
            server.call_tool("memory_recall", {"query": "dose"}, opener)
            server.call_tool("memory_recall", {"query": "dose", "asOf": "2025-06-30"}, opener)

        self.assertNotIn("asOf", bodies[0])
        self.assertEqual(bodies[1]["asOf"], "2025-06-30")
        recall = server.TOOLS[0]
        self.assertIn("asOf", recall["inputSchema"]["properties"])
        self.assertIn("uncertain", recall["description"])

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


    def test_the_kinds_are_the_services_own_and_a_recall_can_ask_for_every_one(self):
        # The enum carried `method`, `constraint` and `background`, which the service refuses: a recall for "method" answered 400.
        # The node test `agentMemoryMcp.test.mjs` holds this tuple equal to the domain's, in order.
        self.assertEqual(len(server.FACT_KINDS), 14)
        for kind in ("method", "constraint", "background"):
            self.assertNotIn(kind, server.FACT_KINDS)
        for kind in ("profile", "method_preference", "writing_style", "tooling", "tension"):
            self.assertIn(kind, server.FACT_KINDS)
        recall, note = server.TOOLS
        self.assertEqual(recall["inputSchema"]["properties"]["factKinds"]["items"]["enum"], list(server.FACT_KINDS))
        self.assertEqual(recall["inputSchema"]["properties"]["factKinds"]["maxItems"], len(server.FACT_KINDS))
        self.assertEqual(note["inputSchema"]["properties"]["factKind"]["enum"], list(server.FACT_KINDS))

    def test_a_recall_names_capsules_and_methods_and_the_person_it_is_for(self):
        seen = {}

        def opener(request, timeout=None):
            seen["body"] = json.loads(request.data.decode("utf-8"))
            seen["subject"] = request.headers.get("X-subject")
            return Response({"data": {"items": [], "methods": []}})

        arguments = {"query": "同病异治", "capsuleIds": ["cap_a", "cap_b"], "methods": "capsules", "subject": "doctor-17"}
        with mock.patch.dict(server.os.environ, CONFIGURED, clear=True):
            server.call_tool("memory_recall", arguments, opener)
        self.assertEqual(seen["body"], {"query": "同病异治", "capsuleIds": ["cap_a", "cap_b"], "methods": "capsules"})
        self.assertEqual(seen["subject"], "doctor-17", "the person is a header, never a field of the body")
        properties = server.TOOLS[0]["inputSchema"]["properties"]
        self.assertEqual(properties["capsuleIds"]["maxItems"], 8)
        self.assertEqual(properties["methods"]["enum"], ["all", "own", "capsules", "none"])
        self.assertIn("subject", properties)
        self.assertIn("subject", server.TOOLS[1]["inputSchema"]["properties"])

    def test_the_subject_is_the_calls_own_or_the_processes_default_or_none(self):
        seen = []

        def opener(request, timeout=None):
            seen.append(request.headers.get("X-subject"))
            return Response({"data": {"entry": {"id": "e1"}, "reviewRequired": True}})

        note = {"factKind": "preference", "content": "处方先看舌脉"}
        with mock.patch.dict(server.os.environ, CONFIGURED, clear=True):
            server.call_tool("memory_note", note, opener)
        with mock.patch.dict(server.os.environ, {**CONFIGURED, "EVIMED_MEMORY_SUBJECT": "doctor-default"}, clear=True):
            server.call_tool("memory_note", note, opener)
            server.call_tool("memory_note", {**note, "subject": "doctor-own"}, opener)
            server.call_tool("memory_note", {**note, "subject": "  "}, opener)
        self.assertEqual(seen, [None, "doctor-default", "doctor-own", "doctor-default"])

    def test_the_adapter_still_holds_no_policy_about_the_subject(self):
        # A refusal of the named person (a key that may not name one, an identifier that is none) is the service's, and arrives as its own code.
        def opener(_request, timeout=None):
            raise urllib.error.HTTPError(
                "https://evimed.example", 400, "Bad Request", {},
                __import__("io").BytesIO(json.dumps({"error": {"code": "agent_key_subject_unsupported", "message": "Only an integration key may name a subject."}}).encode("utf-8")),
            )

        with mock.patch.dict(server.os.environ, CONFIGURED, clear=True):
            result = server.call_tool("memory_recall", {"query": "x", "subject": "doctor-1"}, opener)
        self.assertEqual(result["code"], "agent_key_subject_unsupported")


if __name__ == "__main__":
    unittest.main()
