import json
import os
import pathlib
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

import kb_search  # noqa: E402

SOURCE = "src_" + "a" * 32


class _Gateway(BaseHTTPRequestHandler):
    """The server's route, scripted: it records what the runtime sent and
    answers whatever the test put on the class."""

    answer = (200, {"data": {}})
    seen = []

    def do_POST(self):  # noqa: N802 - http.server naming
        body = self.rfile.read(int(self.headers.get("content-length") or 0))
        type(self).seen.append({"path": self.path, "authorization": self.headers.get("authorization"), "body": json.loads(body)})
        status, payload = type(self).answer
        encoded = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, *_args):
        return


class KbSearchTests(unittest.TestCase):
    def setUp(self):
        _Gateway.seen = []
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _Gateway)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        token_file = pathlib.Path(directory.name) / "gateway-token"
        token_file.write_text("runtime-token-for-tests\n", encoding="utf-8")
        os.chmod(token_file, 0o600)
        base = "http://127.0.0.1:%d" % self.server.server_address[1]
        environment = {
            "EVIMED_KB_SEARCH_GATEWAY_URL": base + "/internal/kb/v1/search",
            "EVIMED_PUBLIC_SOURCE_GATEWAY_URL": base + "/internal/sources/v1/fetch",
            "EVIMED_MODEL_GATEWAY_TOKEN_FILE": str(token_file),
        }
        patcher = mock.patch.dict(os.environ, environment)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_the_tool_is_one_short_definition_with_a_bounded_schema(self):
        [definition] = kb_search.tool_definitions()
        self.assertEqual(definition["name"], "kb_search")
        self.assertLess(len(definition["description"]), 400, "the description rides every request; details belong in the answer")
        schema = definition["inputSchema"]
        self.assertEqual(schema["required"], ["query"])
        self.assertFalse(schema["additionalProperties"])
        self.assertEqual(schema["properties"]["limit"]["maximum"], 20)

    def test_a_question_goes_to_the_servers_route_with_the_runtime_token_and_nothing_else(self):
        _Gateway.answer = (200, {"data": {"mode": "hybrid", "query": "利伐沙班", "library": {"documents": 3},
            "hits": [{"sourceId": SOURCE, "title": "指南", "page": 2, "start": 10, "end": 20, "snippet": "利伐沙班 15 mg", "score": 0.03}]}})
        result = kb_search.search({"query": " 利伐沙班 剂量 ", "limit": 5, "sourceIds": [SOURCE]})
        [request] = _Gateway.seen
        self.assertEqual(request["path"], "/internal/kb/v1/search")
        self.assertEqual(request["authorization"], "Bearer runtime-token-for-tests")
        self.assertEqual(request["body"], {"query": "利伐沙班 剂量", "limit": 5, "sourceIds": [SOURCE]})
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["data"]["hits"][0]["page"], 2)
        self.assertIn("verbatim", " ".join(result["next_actions"]))

    def test_a_small_library_answer_tells_the_model_to_read_the_files(self):
        _Gateway.answer = (200, {"data": {"mode": "small-library", "library": {"documents": 2, "searchable": 2, "tokens": 9000},
            "hits": [], "files": [{"sourceId": SOURCE, "title": "指南", "path": ".evimed-knowledge/.evimed-derived/x/index.md"}]}})
        result = kb_search.search({"query": "anything"})
        self.assertEqual(result["status"], "success")
        self.assertIn("read the 1 listed files directly", result["summary"])

    def test_a_keyword_only_miss_is_a_warning_that_says_silence_is_not_evidence(self):
        _Gateway.answer = (200, {"data": {"mode": "keyword", "query": "q", "library": {}, "hits": []}})
        result = kb_search.search({"query": "q"})
        self.assertEqual(result["status"], "warning")
        self.assertTrue(any("not evidence" in warning for warning in result["warnings"]))
        self.assertTrue(any("terms only" in warning for warning in result["warnings"]))

    def test_switched_off_the_tool_answers_disabled_without_a_request(self):
        with mock.patch.dict(os.environ, {"EVIMED_KB_SEARCH_GATEWAY_URL": ""}):
            with self.assertRaises(kb_search.KbSearchError) as raised:
                kb_search.search({"query": "q"})
        self.assertEqual(raised.exception.code, "kb_search_disabled")
        self.assertFalse(raised.exception.retryable)
        self.assertEqual(_Gateway.seen, [])

    def test_the_gateways_own_code_reaches_the_run_and_outages_are_retryable(self):
        _Gateway.answer = (503, {"error": "switched off", "code": "kb_search_disabled"})
        with self.assertRaises(kb_search.KbSearchError) as raised:
            kb_search.search({"query": "q"})
        self.assertEqual(raised.exception.code, "kb_search_disabled")
        self.assertTrue(raised.exception.retryable)
        _Gateway.answer = (504, {"error": "slow", "code": "kb_search_timeout"})
        with self.assertRaises(kb_search.KbSearchError) as raised:
            kb_search.search({"query": "q"})
        self.assertEqual(raised.exception.code, "kb_search_timeout")

    def test_malformed_arguments_are_refused_before_any_request(self):
        for arguments, code in (
            ({"query": ""}, "kb_search_query_invalid"),
            ({"query": "x" * 513}, "kb_search_query_invalid"),
            ({"query": "q", "limit": 0}, "kb_search_limit_invalid"),
            ({"query": "q", "limit": True}, "kb_search_limit_invalid"),
            ({"query": "q", "sourceIds": ["not-a-source"]}, "kb_search_source_ids_invalid"),
        ):
            with self.assertRaises(kb_search.KbSearchError) as raised:
                kb_search.search(arguments)
            self.assertEqual(raised.exception.code, code)
        self.assertEqual(_Gateway.seen, [])

    def test_without_the_runtime_token_the_tool_says_unconfigured(self):
        with mock.patch.dict(os.environ, {"EVIMED_MODEL_GATEWAY_TOKEN_FILE": "", "EVIMED_MODEL_CONFIG_FILE": ""}):
            with self.assertRaises(kb_search.KbSearchError) as raised:
                kb_search.search({"query": "q"})
        self.assertEqual(raised.exception.code, "kb_search_unconfigured")


if __name__ == "__main__":
    unittest.main()
