import importlib.util
import json
import os
import pathlib
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import frontier_search  # noqa: E402


def load_server():
    spec = importlib.util.spec_from_file_location("evimed_research_mcp_frontier", ROOT / "server.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def gateway_item(**overrides):
    """One item as the server's gateway projects it (frontierGateway.mjs)."""
    item = {
        "title": "司美格鲁肽降低射血分数保留心衰患者的心衰事件",
        "titleRaw": "Semaglutide and Heart Failure Outcomes in Obesity-Related HFpEF",
        "summary": "一项随机对照试验显示……",
        "reason": "改变 HFpEF 的治疗选择",
        "source": {"name": "NEJM", "type": "journal", "typeLabel": "期刊"},
        "evidenceType": "rct",
        "evidenceTypeLabel": "RCT",
        "publishedAt": "2026-09-20T00:00:00.000Z",
        "datePrecision": "day",
        "visibleAt": "2026-09-21T02:13:07.000Z",
        "url": "https://www.nejm.org/doi/full/10.1056/NEJMoa2600001",
        "doi": "10.1056/NEJMoa2600001",
        "pmid": "41000001",
        "registryIds": ["NCT04788511"],
        "flags": [],
        "selected": True,
        "safetyAlert": False,
    }
    item.update(overrides)
    return item


def gateway_answer(items, **overrides):
    data = {
        "query": {"q": "GLP-1 心衰", "lane": None, "specialty": None, "window": "30d", "mode": "selected", "limit": 8},
        "searchMode": "hybrid",
        "asOf": "2026-09-22T10:00:31.000Z",
        "items": items,
        "more": False,
        "unselectedSkipped": 0,
    }
    data.update(overrides)
    return {"data": data}


class _Gateway(BaseHTTPRequestHandler):
    """The server's route, scripted: it records what the runtime sent and
    answers whatever the test put on the class."""

    answer = (200, gateway_answer([]))
    seen = []

    def do_POST(self):  # noqa: N802 - http.server naming
        body = self.rfile.read(int(self.headers.get("content-length") or 0))
        type(self).seen.append({"path": self.path, "authorization": self.headers.get("authorization"), "body": json.loads(body)})
        status, payload = type(self).answer
        encoded = payload if isinstance(payload, bytes) else json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, *_args):
        return


class _GatewayCase(unittest.TestCase):
    def setUp(self):
        _Gateway.seen = []
        _Gateway.answer = (200, gateway_answer([]))
        self.http = ThreadingHTTPServer(("127.0.0.1", 0), _Gateway)
        threading.Thread(target=self.http.serve_forever, daemon=True).start()
        self.addCleanup(self.http.server_close)
        self.addCleanup(self.http.shutdown)
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        token_file = pathlib.Path(directory.name) / "gateway-token"
        token_file.write_text("runtime-token-for-tests\n", encoding="utf-8")
        os.chmod(token_file, 0o600)
        base = "http://127.0.0.1:%d" % self.http.server_address[1]
        environment = {
            "EVIMED_FRONTIER_GATEWAY_URL": base + "/internal/frontier/v1/search",
            "EVIMED_PUBLIC_SOURCE_GATEWAY_URL": base + "/internal/sources/v1/fetch",
            "EVIMED_MODEL_GATEWAY_TOKEN_FILE": str(token_file),
        }
        patcher = mock.patch.dict(os.environ, environment)
        patcher.start()
        self.addCleanup(patcher.stop)


class FrontierSearchTests(_GatewayCase):
    def test_the_tool_is_three_short_sentences_with_a_bounded_optional_schema(self):
        [definition] = frontier_search.tool_definitions()
        self.assertEqual(definition["name"], "frontier_search")
        description = definition["description"]
        self.assertLess(len(description), 450, "the description rides every request; details belong in the answer")
        self.assertEqual(description.count(". "), 2, "what it searches, when to use it, and that results are leads")
        self.assertIn("leads, not evidence", description)
        self.assertIn("cite", description)
        schema = definition["inputSchema"]
        self.assertNotIn("required", schema, "no field is required: without q it lists the newest items")
        self.assertFalse(schema["additionalProperties"])
        self.assertEqual(set(schema["properties"]), {"q", "lane", "specialty", "window", "mode", "limit"})
        self.assertEqual(schema["properties"]["q"]["maxLength"], 200)
        self.assertEqual(schema["properties"]["limit"]["maximum"], 20)
        self.assertEqual(schema["properties"]["window"]["enum"], ["24h", "3d", "7d", "30d"])
        self.assertEqual(schema["properties"]["mode"]["enum"], ["selected", "all"])
        self.assertNotIn("mixed", schema["properties"]["lane"]["enum"], "an item's lane is one of the eight, never mixed")

    def test_a_question_goes_to_the_servers_route_with_the_runtime_token_and_nothing_else(self):
        _Gateway.answer = (200, gateway_answer([
            gateway_item(),
            gateway_item(title="Short title only", titleRaw="Short title only", summary=None, reason=None,
                         flags=[{"key": "preprint", "label": "未经同行评议"}, {"key": "no-abstract", "label": "无摘要"}],
                         publishedAt="2026-09-19T06:30:00.000Z", datePrecision="instant", doi=None, pmid=None, registryIds=[],
                         source={"name": "medRxiv", "type": "preprint", "typeLabel": "预印本"}, evidenceType=None, evidenceTypeLabel=None,
                         selected=False, safetyAlert=True),
        ], more=True))
        result = frontier_search.search({"q": "  GLP-1   心衰 ", "specialty": "cardiology", "window": "7d", "limit": 5})
        [request] = _Gateway.seen
        self.assertEqual(request["path"], "/internal/frontier/v1/search")
        self.assertEqual(request["authorization"], "Bearer runtime-token-for-tests")
        self.assertEqual(request["body"], {"q": "GLP-1 心衰", "specialty": "cardiology", "window": "7d", "limit": 5})
        self.assertEqual(result["status"], "success")
        lead, preprint = result["data"]["items"]
        self.assertEqual(lead, {
            "title": "司美格鲁肽降低射血分数保留心衰患者的心衰事件",
            "originalTitle": "Semaglutide and Heart Failure Outcomes in Obesity-Related HFpEF",
            "summary": "一项随机对照试验显示……",
            "reason": "改变 HFpEF 的治疗选择",
            "source": "NEJM",
            "sourceType": "期刊",
            "evidenceType": "RCT",
            "publishedAt": "2026-09-20",
            "collectedAt": "2026-09-21T02:13Z",
            "url": "https://www.nejm.org/doi/full/10.1056/NEJMoa2600001",
            "doi": "10.1056/NEJMoa2600001",
            "pmid": "41000001",
            "registryIds": ["NCT04788511"],
            "selected": True,
        })
        self.assertEqual(preprint["flags"], ["安全警示", "预印本，尚未经同行评议", "无摘要"])
        self.assertEqual(preprint["publishedAt"], "2026-09-19T06:30Z", "an instant keeps its time; a day never gains one")
        for absent in ("originalTitle", "summary", "reason", "evidenceType", "doi", "pmid", "registryIds"):
            self.assertNotIn(absent, preprint, "an absent fact is left out, not sent as null")
        self.assertFalse(preprint["selected"])
        self.assertEqual(result["data"]["count"], 2)
        self.assertTrue(result["data"]["more"])
        self.assertEqual(result["data"]["asOf"], "2026-09-22T10:00Z")
        self.assertIn('for "GLP-1 心衰"', result["summary"])
        self.assertIn("more match", result["summary"])
        actions = " ".join(result["next_actions"])
        self.assertIn("leads", actions)
        self.assertIn("cite that original", actions)
        self.assertIn("尚未经同行评议", actions, "a preprint among the items is named in the words an answer must use")
        self.assertNotIn("sources", result, "leads are not evidence: the run records what it reads next, not this list")

    def test_without_a_question_the_newest_items_are_listed_and_the_defaults_are_the_gateways(self):
        _Gateway.answer = (200, gateway_answer([gateway_item()], query={
            "q": None, "lane": "safety", "specialty": None, "window": "30d", "mode": "selected", "limit": 8}, searchMode="list"))
        result = frontier_search.search({"lane": "safety"})
        self.assertEqual(_Gateway.seen[0]["body"], {"lane": "safety"})
        self.assertEqual(result["status"], "success")
        self.assertIn("the editors' picks, lane safety, last 30d", result["summary"])
        self.assertNotIn("search)", result["summary"], "a list is not a search and does not say which legs ran")

    def test_a_selected_search_that_dropped_unselected_matches_says_how_to_see_them(self):
        _Gateway.answer = (200, gateway_answer([], unselectedSkipped=3, searchMode="keyword"))
        result = frontier_search.search({"q": "罕见病"})
        self.assertEqual(result["status"], "warning")
        warnings = " ".join(result["warnings"])
        self.assertIn('3 more item(s) matched outside the editors\' picks; call again with mode "all"', warnings)
        self.assertIn("terms only", warnings)
        self.assertIn("not evidence that nothing happened", warnings)
        self.assertTrue(result["next_actions"], "a warning always says what to do next")
        self.assertEqual(result["data"]["unselectedSkipped"], 3)

    def test_times_are_read_as_instants_and_shown_in_utc(self):
        _Gateway.answer = (200, gateway_answer([gateway_item(
            visibleAt="2026-09-21T10:13:00+08:00", publishedAt="2026-09-21T07:30:00+08:00", datePrecision="instant",
        ), gateway_item(visibleAt="not a time", publishedAt="2026-09-20")]))
        first, second = frontier_search.search({})["data"]["items"]
        self.assertEqual(first["collectedAt"], "2026-09-21T02:13Z")
        self.assertEqual(first["publishedAt"], "2026-09-20T23:30Z")
        self.assertNotIn("collectedAt", second, "a time that is not one is left out, not guessed")
        self.assertNotIn("publishedAt", second, "a date without a zone is no instant")

    def test_retracted_items_are_called_out(self):
        _Gateway.answer = (200, gateway_answer([gateway_item(flags=[{"key": "retracted", "label": "已撤稿"}])]))
        result = frontier_search.search({"q": "x"})
        self.assertEqual(result["data"]["items"][0]["flags"], ["已撤稿"])
        self.assertTrue(any("do not use them as support" in warning for warning in result["warnings"]))

    def test_switched_off_the_tool_answers_disabled_without_a_request(self):
        with mock.patch.dict(os.environ, {"EVIMED_FRONTIER_GATEWAY_URL": ""}):
            with self.assertRaises(frontier_search.FrontierSearchError) as raised:
                frontier_search.search({"q": "q"})
        self.assertEqual(raised.exception.code, "frontier_disabled")
        self.assertFalse(raised.exception.retryable, "a feed this conversation does not have will not appear on a retry")
        self.assertEqual(_Gateway.seen, [])

    def test_the_gateways_own_code_and_words_reach_the_run_and_outages_are_retryable(self):
        _Gateway.answer = (503, {"error": "前沿动态 (the frontier feed) is not open to this account yet.", "code": "frontier_disabled"})
        with self.assertRaises(frontier_search.FrontierSearchError) as raised:
            frontier_search.search({"q": "q"})
        self.assertEqual(raised.exception.code, "frontier_disabled")
        self.assertFalse(raised.exception.retryable)
        self.assertIn("not open to this account", str(raised.exception))
        _Gateway.answer = (504, {"error": "Frontier search timed out.", "code": "frontier_search_timeout"})
        with self.assertRaises(frontier_search.FrontierSearchError) as raised:
            frontier_search.search({"q": "q"})
        self.assertEqual(raised.exception.code, "frontier_search_timeout")
        self.assertTrue(raised.exception.retryable)
        # A code from anything else on the path is not one a run's verdict can read.
        _Gateway.answer = (404, {"error": "Not found.", "code": "not_found"})
        with self.assertRaises(frontier_search.FrontierSearchError) as raised:
            frontier_search.search({"q": "q"})
        self.assertEqual(raised.exception.code, "frontier_search_upstream_error")
        _Gateway.answer = (502, b"<html>bad gateway</html>")
        with self.assertRaises(frontier_search.FrontierSearchError) as raised:
            frontier_search.search({"q": "q"})
        self.assertEqual(raised.exception.code, "frontier_search_upstream_error")
        self.assertTrue(raised.exception.retryable)

    def test_an_answer_without_items_is_invalid_not_empty(self):
        _Gateway.answer = (200, {"data": {"mode": "list"}})
        with self.assertRaises(frontier_search.FrontierSearchError) as raised:
            frontier_search.search({})
        self.assertEqual(raised.exception.code, "frontier_search_response_invalid")
        _Gateway.answer = (200, b"not json")
        with self.assertRaises(frontier_search.FrontierSearchError) as raised:
            frontier_search.search({})
        self.assertEqual(raised.exception.code, "frontier_search_response_invalid")

    def test_malformed_arguments_are_refused_before_any_request(self):
        for arguments, code in (
            ({"q": ""}, "frontier_search_query_invalid"),
            ({"q": "   "}, "frontier_search_query_invalid"),
            ({"q": 7}, "frontier_search_query_invalid"),
            ({"q": "x" * 201}, "frontier_search_query_invalid"),
            ({"q": "a\x00b"}, "frontier_search_query_invalid"),
            ({"lane": "mixed"}, "frontier_search_lane_invalid"),
            ({"specialty": "astrology"}, "frontier_search_specialty_invalid"),
            ({"window": "90d"}, "frontier_search_window_invalid"),
            ({"mode": "hot"}, "frontier_search_mode_invalid"),
            ({"limit": 0}, "frontier_search_limit_invalid"),
            ({"limit": 21}, "frontier_search_limit_invalid"),
            ({"limit": True}, "frontier_search_limit_invalid"),
        ):
            with self.subTest(arguments=arguments):
                with self.assertRaises(frontier_search.FrontierSearchError) as raised:
                    frontier_search.search(arguments)
                self.assertEqual(raised.exception.code, code)
        self.assertEqual(_Gateway.seen, [])

    def test_without_the_runtime_token_the_tool_says_unconfigured(self):
        with mock.patch.dict(os.environ, {"EVIMED_MODEL_GATEWAY_TOKEN_FILE": "", "EVIMED_MODEL_CONFIG_FILE": ""}):
            with self.assertRaises(frontier_search.FrontierSearchError) as raised:
                frontier_search.search({"q": "q"})
        self.assertEqual(raised.exception.code, "frontier_search_unconfigured")

    def test_eight_items_stay_near_six_thousand_characters(self):
        # As the server renders a result for the model (compact JSON, no ASCII
        # escaping). Typical lengths, then every text at the editor's own
        # ceilings (frontierEditor.mjs: title 40, summary 140, reason 50
        # characters) with a 160-character English title: both stay under the
        # kernel's 8,192-character tool-result pruning threshold.
        typical = gateway_item(title="心" * 28, titleRaw="Semaglutide " * 8 + "HFpEF", summary="证" * 110, reason="因" * 35)
        longest = gateway_item(
            title="心" * 40, titleRaw="Semaglutide " * 13 + "HFpEF", summary="证" * 140, reason="因" * 50,
            flags=[{"key": "preprint", "label": "未经同行评议"}],
        )
        sizes = {}
        for name, item in (("typical", typical), ("longest", longest)):
            _Gateway.answer = (200, gateway_answer([item] * 8))
            rendered = json.dumps(frontier_search.search({"q": "GLP-1 心衰"}), ensure_ascii=False, separators=(",", ":"))
            sizes[name] = (len(rendered), len(rendered.encode("utf-8")))
        self.assertLess(sizes["typical"][0], 6_000, sizes)
        self.assertLess(sizes["longest"][0], 7_000, sizes)
        self.assertLess(sizes["longest"][1], 11_000, sizes)


class FrontierSearchThroughTheServerTests(_GatewayCase):
    """What a run actually receives: the tool as `call_tool` dispatches it."""

    @classmethod
    def setUpClass(cls):
        cls.mcp = load_server()

    def test_a_success_carries_provenance_and_no_sources(self):
        _Gateway.answer = (200, gateway_answer([gateway_item()]))
        result = self.mcp.call_tool("frontier_search", {"q": "GLP-1 心衰", "mode": "selected"})
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["data"]["provenance"]["tool"], "frontier_search")
        self.assertEqual(result["data"]["provenance"]["arguments"], {"q": "GLP-1 心衰", "mode": "selected"})
        self.assertNotIn("sources", result)
        self.assertEqual(result["data"]["items"][0]["doi"], "10.1056/NEJMoa2600001")

    def test_off_is_an_error_the_run_can_answer_around(self):
        with mock.patch.dict(os.environ, {"EVIMED_FRONTIER_GATEWAY_URL": ""}):
            result = self.mcp.call_tool("frontier_search", {"q": "q"})
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["error"]["code"], "frontier_disabled")
        self.assertFalse(result["error"]["retryable"])
        self.assertIn("Answer without the feed", result["next_actions"][0])

    def test_the_schema_refuses_what_the_tool_would_before_a_request(self):
        result = self.mcp.call_tool("frontier_search", {"lane": "mixed"})
        self.assertEqual(result["error"]["code"], "invalid_input")
        result = self.mcp.call_tool("frontier_search", {"q": "q", "view": "all"})
        self.assertEqual(result["error"]["code"], "invalid_input")
        self.assertEqual(_Gateway.seen, [])

    def test_a_retryable_outage_says_retry_once(self):
        _Gateway.answer = (503, {"error": "Frontier search is unavailable.", "code": "frontier_search_unavailable"})
        result = self.mcp.call_tool("frontier_search", {"q": "q"})
        self.assertEqual(result["error"]["code"], "frontier_search_unavailable")
        self.assertTrue(result["error"]["retryable"])
        self.assertEqual(result["error"]["stopReason"], "retry")


if __name__ == "__main__":
    unittest.main()
