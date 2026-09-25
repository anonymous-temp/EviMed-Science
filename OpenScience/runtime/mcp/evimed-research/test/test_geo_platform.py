"""「循证 GEO」's three runtime tools, against a scripted gateway, and through
the server's own `call_tool` -- the path a run takes (a module test that only
calls the module proves the module, not the tool)."""

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

import geo_platform  # noqa: E402


def load_server():
    spec = importlib.util.spec_from_file_location("evimed_research_mcp_geo", ROOT / "server.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _Gateway(BaseHTTPRequestHandler):
    """The server's routes, scripted per operation: it records what the
    runtime sent and answers whatever the test put on the class."""

    answers = {}
    seen = []

    def do_POST(self):  # noqa: N802 - http.server naming
        body = self.rfile.read(int(self.headers.get("content-length") or 0))
        type(self).seen.append({"path": self.path, "authorization": self.headers.get("authorization"), "body": json.loads(body)})
        operation = self.path.rsplit("/", 1)[-1]
        status, payload = type(self).answers.get(operation, (404, {"error": "Not found.", "code": "not_found"}))
        encoded = payload if isinstance(payload, bytes) else json.dumps(payload, ensure_ascii=False).encode("utf-8")
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
        _Gateway.answers = {}
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
            "EVIMED_GEO_GATEWAY_URL": base + "/internal/geo/v1",
            "EVIMED_PUBLIC_SOURCE_GATEWAY_URL": base + "/internal/sources/v1/fetch",
            "EVIMED_MODEL_GATEWAY_TOKEN_FILE": str(token_file),
            "EVIMED_DISABLED_TOOLS": "",
        }
        patcher = mock.patch.dict(os.environ, environment)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.server = load_server()


class GeoToolDefinitionTests(unittest.TestCase):
    def test_three_short_tools_with_closed_schemas(self):
        definitions = {tool["name"]: tool for tool in geo_platform.tool_definitions()}
        self.assertEqual(set(definitions), {"geo_read", "geo_write", "social_posts_search"})
        for definition in definitions.values():
            self.assertLess(len(definition["description"]), 450, "a description rides every request of the run")
            schema = definition["inputSchema"]
            self.assertFalse(schema["additionalProperties"])
            self.assertEqual(schema["type"], "object")
        self.assertEqual(definitions["geo_read"]["inputSchema"]["required"], ["what"])
        self.assertEqual(definitions["geo_read"]["inputSchema"]["properties"]["what"]["enum"], list(geo_platform.READ_WHATS))
        self.assertEqual(definitions["geo_write"]["inputSchema"]["properties"]["what"]["enum"], list(geo_platform.WRITE_WHATS))
        social = definitions["social_posts_search"]["inputSchema"]
        self.assertEqual(social["required"], ["query"])
        self.assertEqual(social["properties"]["platforms"]["items"]["enum"], list(geo_platform.SOCIAL_PLATFORMS))
        self.assertIn("never zero", definitions["social_posts_search"]["description"])

    def test_without_a_route_every_tool_says_disabled_without_asking(self):
        with mock.patch.dict(os.environ, {"EVIMED_GEO_GATEWAY_URL": ""}):
            for call in (
                lambda: geo_platform.read({"what": "claims"}),
                lambda: geo_platform.write({"what": "step", "data": {"step": "evidence", "status": "running"}}),
                lambda: geo_platform.social_search({"query": "降糖药"}),
            ):
                with self.assertRaises(geo_platform.GeoPlatformError) as caught:
                    call()
                self.assertEqual(caught.exception.code, "geo_disabled")
                self.assertFalse(caught.exception.retryable)


class GeoReadTests(_GatewayCase):
    def test_a_read_posts_the_what_and_filter_with_the_runtime_token_through_call_tool(self):
        _Gateway.answers["read"] = (200, {"data": {"what": "metrics", "items": [{"metricId": "M-01", "cell": {"value": 0.18, "numerator": 56,
            "denominator": 310, "ciLow": 0.14, "ciHigh": 0.23, "status": "ok", "dataType": "measured"}}], "more": True}})
        result = self.server.call_tool("geo_read", {"what": "metrics", "filter": {"engine": "deepseek", "limit": 10}})
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["data"]["items"][0]["cell"]["denominator"], 310)
        self.assertTrue(any("offset" in action for action in result["next_actions"]))
        [seen] = _Gateway.seen
        self.assertEqual(seen["path"], "/internal/geo/v1/read")
        self.assertEqual(seen["authorization"], "Bearer runtime-token-for-tests")
        self.assertEqual(seen["body"], {"what": "metrics", "filter": {"engine": "deepseek", "limit": 10}})

    def test_the_gateway_s_own_codes_reach_the_run_and_nothing_else_does(self):
        _Gateway.answers["read"] = (404, {"error": "This conversation is not in a 循证 GEO project.", "code": "geo_no_project"})
        result = self.server.call_tool("geo_read", {"what": "project"})
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["error"]["code"], "geo_no_project")
        self.assertFalse(result["error"]["retryable"])
        _Gateway.answers["read"] = (502, {"error": "bad gateway", "code": "proxy_exploded"})
        result = self.server.call_tool("geo_read", {"what": "project"})
        self.assertEqual(result["error"]["code"], "geo_upstream_error")
        self.assertTrue(result["error"]["retryable"])

    def test_a_what_outside_the_vocabulary_never_leaves_the_runtime(self):
        result = self.server.call_tool("geo_read", {"what": "passwords"})
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["error"]["code"], "invalid_input")
        self.assertEqual(_Gateway.seen, [])


class GeoWriteTests(_GatewayCase):
    def test_a_partly_refused_write_is_a_warning_naming_each_refused_item(self):
        _Gateway.answers["write"] = (200, {"data": {"what": "claims", "ok": True, "ids": ["gcl_1"], "issues": [
            {"index": 1, "field": "quote", "code": "missing", "message": "quote is required."}]}})
        result = self.server.call_tool("geo_write", {"what": "claims", "items": [{"claimKey": "a"}, {"claimKey": "b"}]})
        self.assertEqual(result["status"], "warning")
        self.assertIn("1 written, 1 refused", result["summary"])
        self.assertEqual(result["warnings"], ["item 1, quote: quote is required."])
        self.assertEqual(_Gateway.seen[0]["body"], {"what": "claims", "items": [{"claimKey": "a"}, {"claimKey": "b"}]})

    def test_a_write_that_wrote_nothing_says_so_and_a_clean_one_succeeds(self):
        _Gateway.answers["write"] = (200, {"data": {"what": "lock_questions", "ok": False, "ids": [], "issues": [
            {"field": "pools", "code": "pools_missing", "message": "Every pool needs a measured question; missing: P4."}]}})
        refused = self.server.call_tool("geo_write", {"what": "lock_questions", "data": {}})
        self.assertEqual(refused["status"], "warning")
        self.assertTrue(refused["summary"].startswith("Nothing was written"))
        _Gateway.answers["write"] = (200, {"data": {"what": "step", "ok": True, "ids": ["geo_1"], "issues": []}})
        done = self.server.call_tool("geo_write", {"what": "step", "data": {"step": "evidence", "status": "done"}})
        self.assertEqual(done["status"], "success")

    def test_items_and_data_together_are_refused_before_a_request(self):
        with self.assertRaises(geo_platform.GeoPlatformError) as caught:
            geo_platform.write({"what": "claims", "items": [{}], "data": {}})
        self.assertEqual(caught.exception.code, "geo_write_payload_invalid")
        self.assertEqual(_Gateway.seen, [])


class SocialPostsTests(_GatewayCase):
    def test_collected_posts_come_back_as_they_were_minimised(self):
        post = {"platform": "xhs", "url": "https://www.xiaohongshu.com/discovery/item/abc", "postId": "abc", "excerpt": "二甲双胍饭前还是饭后吃？",
                "engagement": {"likes": 3, "favs": 1, "shares": 0, "comments": 2}, "collectedAt": "2026-09-25T02:00:00.000Z", "comments": ["饭后"]}
        _Gateway.answers["social"] = (200, {"data": {"query": "二甲双胍", "sort": "hot", "status": "collected",
            "platforms": [{"platform": "xhs", "status": "collected", "posts": 1}], "posts": [post]}})
        result = self.server.call_tool("social_posts_search", {"query": "二甲双胍", "platforms": ["xhs"], "limit": 5})
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["data"]["posts"], [post])
        self.assertEqual(_Gateway.seen[0]["path"], "/internal/geo/v1/social")
        self.assertEqual(_Gateway.seen[0]["body"], {"query": "二甲双胍", "platforms": ["xhs"], "limit": 5})

    def test_a_channel_that_did_not_answer_is_no_signal_never_zero(self):
        _Gateway.answers["social"] = (200, {"data": {"status": "request_failed", "platforms": [{"platform": "xhs", "status": "request_failed", "posts": 0}],
            "posts": []}})
        result = self.server.call_tool("social_posts_search", {"query": "降糖药"})
        self.assertEqual(result["status"], "warning")
        self.assertIn("无信号", " ".join(result["warnings"]))
        self.assertEqual(result["data"]["status"], "request_failed")

    def test_an_unconfigured_channel_is_not_retried(self):
        _Gateway.answers["social"] = (503, {"error": "The social channel is not configured.", "code": "social_posts_unconfigured"})
        result = self.server.call_tool("social_posts_search", {"query": "降糖药"})
        self.assertEqual(result["error"]["code"], "social_posts_unconfigured")
        self.assertFalse(result["error"]["retryable"])


class GeoOfferedOnlyWhereOnTests(_GatewayCase):
    def test_a_deployment_that_disables_them_neither_lists_nor_runs_them(self):
        with mock.patch.dict(os.environ, {"EVIMED_DISABLED_TOOLS": "geo_read,geo_write,social_posts_search"}):
            names = {tool["name"] for tool in self.server.list_tools()}
            self.assertFalse(names & {"geo_read", "geo_write", "social_posts_search"})
            result = self.server.call_tool("geo_read", {"what": "claims"})
            self.assertEqual(result["error"]["code"], "tool_disabled")
        self.assertEqual(_Gateway.seen, [])
        self.assertTrue({"geo_read", "geo_write", "social_posts_search"} <= self.server.OPTIONAL_TOOLS)


if __name__ == "__main__":
    unittest.main()
