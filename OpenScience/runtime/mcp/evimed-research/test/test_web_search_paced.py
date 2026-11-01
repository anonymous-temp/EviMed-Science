"""What a model is told when the web-search gateway held its project to the pace: the wait the gateway named and its sentence reach the
tool result, so a run waits and asks again instead of reading a busy gateway as an empty web (web_search through the MCP tool)."""
import email.message
import importlib.util
import io
import json
import os
import pathlib
import sys
import unittest
import urllib.error
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import public_sources  # noqa: E402


def load_server():
    spec = importlib.util.spec_from_file_location("evimed_research_mcp_websearch_paced", ROOT / "server.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def refusal(status, body, retry_after=None):
    headers = email.message.Message()
    headers["Content-Type"] = "application/json"
    if retry_after is not None:
        headers["Retry-After"] = str(retry_after)
    return urllib.error.HTTPError("http://gateway.invalid/internal/search/v1/query", status, "error", headers, io.BytesIO(json.dumps(body).encode()))


class Opener:
    def __init__(self, error):
        self.error = error

    def open(self, request, timeout=None):
        raise self.error


class WebSearchPaced(unittest.TestCase):
    def call(self, error):
        with mock.patch.dict(os.environ, {"EVIMED_WEB_SEARCH_GATEWAY_URL": "http://gateway.invalid/internal/search/v1/query"}), \
                mock.patch.object(public_sources, "_gateway_settings", return_value=("http://gateway.invalid", "token")), \
                mock.patch.object(public_sources, "_OPENER", Opener(error)):
            return load_server().call_tool("web_search", {"query": "aripiprazole dosing"})

    def test_the_gateways_wait_and_sentence_reach_the_model(self):
        said = "This project may make 300 web searches a minute; ask again in 17 s."
        result = self.call(refusal(429, {"error": said, "code": "web_search_project_rate_limited", "retryAfterSeconds": 17}, retry_after=17))
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["error"]["code"], "web_search_project_rate_limited")
        self.assertIs(result["error"]["retryable"], True)
        self.assertEqual(result["error"]["retryAfterSeconds"], 17)
        self.assertIn(said.rstrip("."), result["summary"])
        self.assertIn("HTTP 429", result["summary"])
        actions = " ".join(result["next_actions"])
        self.assertIn("Wait about 17 s", actions)
        self.assertIn("says nothing about what the web holds", actions)

    def test_the_header_is_read_when_the_body_carries_no_wait(self):
        result = self.call(refusal(429, {"error": "slow down", "code": "web_search_project_rate_limited"}, retry_after=5))
        self.assertEqual(result["error"]["retryAfterSeconds"], 5)

    def test_a_refusal_with_no_wait_keeps_the_old_advice_and_names_no_wait(self):
        result = self.call(refusal(503, {"error": "The web-search backend is not available.", "code": "web_search_unavailable"}))
        self.assertNotIn("retryAfterSeconds", result["error"])
        self.assertEqual(result["error"]["code"], "web_search_unavailable")
        self.assertIn("The web-search backend is not available", result["summary"])
        self.assertEqual(result["next_actions"], ["Retry once the backend recovers."])
        # A body that is not JSON costs the sentence and the code, never the verdict.
        garbled = refusal(502, {})
        garbled.fp = io.BytesIO(b"<html>bad gateway</html>")
        broken = self.call(garbled)
        self.assertEqual(broken["error"]["code"], "web_search_upstream_error")
        self.assertIs(broken["error"]["retryable"], True)


if __name__ == "__main__":
    unittest.main()
