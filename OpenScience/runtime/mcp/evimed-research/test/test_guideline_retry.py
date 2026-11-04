"""`guideline_search` asks the EviMed index once more when it timed out, and a second failure is a status the model can read, not the end of the turn.

On 2026-11-04 the index timed out on 3 of 10 live guideline calls and its text-block endpoint timed out too. The tests use a fake transport: no network.
"""

import importlib.util
import os
import pathlib
import sys
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import public_sources as sources  # noqa: E402


def load_server():
    spec = importlib.util.spec_from_file_location("evimed_research_mcp_guideline_retry", ROOT / "server.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


TIMEOUT = sources.PublicSourceError("public_source_unavailable", "Public source is unavailable: timed out.", True)
GUIDE = ({"total": 1, "list": [{"guideId": "g1", "title": "A guideline", "url": "https://example.org/g1", "summary": "Text."}]}, "review/api/guide")
BLOCKS = ({"guides": [{"guideId": "g2", "title": "A guideline", "url": "https://example.org/g2", "blocks": ["A passage."]}]}, "review/api/guide-block")
PUBMED = {"status": "warning", "summary": "PubMed.", "data": {"items": [{"title": "From PubMed"}]}, "sources": [{"id": "PMID:1"}], "warnings": []}


class PublicConnectorRetryTests(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.object(sources.time, "sleep")
        self.sleep = patcher.start()
        self.addCleanup(patcher.stop)
        for name in ("_preserve_guideline_text",):
            other = mock.patch.object(sources, name, return_value=None)
            other.start()
            self.addCleanup(other.stop)

    def test_a_timeout_is_asked_again_once_and_the_second_answer_is_used(self):
        for mode, answer in (("records", GUIDE), ("blocks", BLOCKS)):
            with self.subTest(mode=mode):
                with mock.patch.object(sources, "_evimed_post", side_effect=[TIMEOUT, answer]) as post:
                    result = sources.guideline({"query": "hypertension", "mode": mode})
                self.assertEqual(post.call_count, 2)
                self.assertEqual(result["data"]["items"][0]["title"], "A guideline")
        self.assertEqual(self.sleep.call_count, 2)

    def test_http_5xx_and_429_are_asked_again_but_a_refusal_is_not(self):
        server_error = sources.PublicSourceError("public_source_http_error", "The EviMed index returned HTTP 503.", True)
        with mock.patch.object(sources, "_evimed_post", side_effect=[server_error, GUIDE]) as post:
            sources.guideline({"query": "hypertension"})
        self.assertEqual(post.call_count, 2)
        refusal = sources.PublicSourceError("public_source_http_error", "The EviMed index refused this request with HTTP 400.", False)
        with mock.patch.object(sources, "_evimed_post", side_effect=refusal) as post, mock.patch.object(sources, "_pubmed", return_value=PUBMED):
            result = sources.guideline({"query": "hypertension"})
        self.assertEqual(post.call_count, 1)
        self.assertIn("EviMed guideline search was unavailable: ", result["warnings"][0])
        self.assertNotIn("after one retry", result["warnings"][0])
        unreadable = sources.PublicSourceError("evimed_evidence_invalid_response", "unsuccessful", False)
        with mock.patch.object(sources, "_evimed_post", side_effect=unreadable) as post, mock.patch.object(sources, "_pubmed", return_value=PUBMED):
            sources.guideline({"query": "hypertension"})
        self.assertEqual(post.call_count, 1)

    def test_two_timeouts_return_the_pubmed_records_with_a_warning_that_says_the_index_was_asked_twice(self):
        for mode, words in (("records", "search"), ("blocks", "text blocks")):
            with self.subTest(mode=mode):
                with mock.patch.object(sources, "_evimed_post", side_effect=[TIMEOUT, TIMEOUT]) as post, mock.patch.object(sources, "_pubmed", return_value=dict(PUBMED, warnings=[])):
                    result = sources.guideline({"query": "hypertension", "mode": mode})
                self.assertEqual(post.call_count, 2)
                self.assertEqual(result["data"]["items"][0]["title"], "From PubMed")
                self.assertIn("EviMed guideline %s was unavailable after one retry" % words, result["warnings"][0])
                if mode == "blocks":
                    self.assertIn("records, not guideline passages", result["warnings"][0])

    def test_a_key_the_deployment_does_not_have_is_not_asked_again(self):
        unconfigured = sources.SourceNotConfigured("evimed-evidence", "EviMed 证据库")
        with mock.patch.object(sources, "_evimed_post", side_effect=unconfigured) as post, mock.patch.object(sources, "_pubmed", return_value=dict(PUBMED, warnings=[])):
            sources.guideline({"query": "hypertension"})
        self.assertEqual(post.call_count, 1)


class ServerBoundaryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = load_server()

    def test_the_index_and_pubmed_both_down_is_a_failure_result_not_an_exception(self):
        still_down = sources.PublicSourceError("public_source_unavailable", "Public source is unavailable: timed out.", True)
        with mock.patch.dict(os.environ, {"EVIMED_GUIDELINE_SEARCH_URL": ""}), mock.patch.object(sources.time, "sleep"), \
             mock.patch.object(sources, "_evimed_post", side_effect=still_down), mock.patch.object(sources, "_pubmed", side_effect=still_down):
            result = self.server.call_tool("guideline_search", {"query": "hypertension", "mode": "blocks"})
        self.assertEqual(result["status"], "error")
        self.assertTrue(result["error"]["retryable"])
        self.assertTrue(result["next_actions"])

    def test_a_private_guideline_adapter_that_timed_out_is_asked_once_more(self):
        down = self.server.failure("adapter_unavailable", "guideline_search could not reach its upstream adapter: timed out", True, "stop", ["retry"])
        good = self.server.success("Retrieved.", data={"items": []})
        with mock.patch.object(self.server, "_adapter_call_once", side_effect=[down, good]) as once, mock.patch.object(self.server.time, "sleep"):
            result = self.server._adapter_call("guideline_search", {"query": "hypertension"})
        self.assertEqual(once.call_count, 2)
        self.assertEqual(result["status"], "success")
        with mock.patch.object(self.server, "_adapter_call_once", side_effect=[down, down]) as once, mock.patch.object(self.server.time, "sleep"):
            result = self.server._adapter_call("guideline_search", {"query": "hypertension"})
        self.assertEqual(once.call_count, 2)
        self.assertEqual(result["error"]["code"], "adapter_unavailable")
        with mock.patch.object(self.server, "_adapter_call_once", side_effect=[down]) as once:
            self.server._adapter_call("literature_search", {"query": "hypertension"})
        self.assertEqual(once.call_count, 1, "only the guideline adapter is asked again")


if __name__ == "__main__":
    unittest.main()
