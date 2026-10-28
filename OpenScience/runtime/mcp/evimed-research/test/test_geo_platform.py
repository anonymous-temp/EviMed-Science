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
        self.assertNotIn("required", social, "a read on needs the job id alone, a search a query and platforms")
        self.assertEqual(social["oneOf"], [{"type": "object", "required": ["query", "platform"]}, {"type": "object", "required": ["query", "platforms"]},
                                           {"type": "object", "required": ["jobId"]}])
        self.assertEqual(social["properties"]["jobId"]["pattern"], "^[A-Fa-f0-9]{32}$")
        self.assertEqual(social["properties"]["platforms"]["maxItems"], 6)
        self.assertEqual(social["properties"]["platform"]["enum"], list(geo_platform.SOCIAL_PLATFORMS))
        self.assertIn("one asynchronous job", definitions["social_posts_search"]["description"])
        self.assertIn("never zero", definitions["social_posts_search"]["description"])
        self.assertIn("pending", definitions["social_posts_search"]["description"])
        self.assertIn("jobId", definitions["social_posts_search"]["description"])

    def test_the_actions_read_says_it_is_lean_and_how_to_read_one_whole(self):
        read = {tool["name"]: tool for tool in geo_platform.tool_definitions()}["geo_read"]
        self.assertIn("lean rows", read["description"])
        self.assertIn("counts", read["description"])
        self.assertIn("filter.key or groupId reads one whole", read["description"])
        key = read["inputSchema"]["properties"]["filter"]["properties"]["key"]
        self.assertEqual((key["type"], key["minLength"], key["maxLength"]), ("string", 1, 240))

    def test_without_a_route_every_tool_says_disabled_without_asking(self):
        with mock.patch.dict(os.environ, {"EVIMED_GEO_GATEWAY_URL": ""}):
            for call in (
                lambda: geo_platform.read({"what": "claims"}),
                lambda: geo_platform.write({"what": "step", "data": {"step": "evidence", "status": "running"}}),
                lambda: geo_platform.social_search({"query": "降糖药", "platform": "xhs"}),
            ):
                with self.assertRaises(geo_platform.GeoPlatformError) as caught:
                    call()
                self.assertEqual(caught.exception.code, "geo_disabled")
                self.assertFalse(caught.exception.retryable)


class GeoReadTests(_GatewayCase):
    def test_source_analysis_filters_survive_native_boundary_and_reject_invalid_types(self):
        _Gateway.answers["read"] = (200, {"data": {"rows": [], "page": {"total": 0}}})
        for selector in [
            {"viewId": "V17", "sourceType": "unknown", "sourceRelationship": "wrong", "topN": 1},
            {"viewId": "V18", "sourceLevel": "page", "sourceSearch": "portal?doc=001", "sourceRelationship": "mentions", "topN": 50},
            {"viewId": "V19", "sourceLevel": "page", "sourceFacet": "group", "topN": 10},
            {"viewId": "V22", "sourceLevel": "page"},
            {"viewId": "V10"},
            {"viewId": "V16", "evidenceKind": "claims"},
            {"viewId": "V16", "evidenceKind": "findings"},
        ]:
            result = self.server.call_tool("geo_read", {"what": "analysis", "filter": selector})
            self.assertEqual(result["status"], "success")
            self.assertEqual(_Gateway.seen[-1]["body"]["filter"], selector)
        sent = len(_Gateway.seen)
        for field, value in [("sourceType", ""), ("sourceType", "x" * 101), ("sourceSearch", "x" * 301),
                             ("sourceRelationship", "owned"), ("sourceLevel", "host"), ("topN", 0),
                             ("topN", 51), ("topN", 1.5), ("topN", "15"), ("sourceFacet", "audience")]:
            result = self.server.call_tool("geo_read", {"what": "analysis", "filter": {"viewId": "V18", field: value}})
            self.assertEqual(result["status"], "error")
        self.assertEqual(len(_Gateway.seen), sent)

    def test_evidence_view_cannot_replace_frozen_context_or_target_another_resource(self):
        sent = len(_Gateway.seen)
        for what, selector in [
            ("analysis", {"viewId": "V10", "evidenceKind": "claims"}),
            ("analysis", {"viewId": "V16", "evidenceKind": "other"}),
            ("analysis", {"viewId": "V16", "evidenceKind": "claims", "planContextRef": "gpc_" + "a" * 64}),
            ("claims", {"viewId": "V16", "evidenceKind": "findings"}),
        ]:
            result = self.server.call_tool("geo_read", {"what": what, "filter": selector})
            self.assertEqual(result["status"], "error")
        self.assertEqual(len(_Gateway.seen), sent)

    def test_error_distribution_and_exact_group_filters_preserve_scope(self):
        _Gateway.answers["read"] = (200, {"data": {"rows": [], "page": {"total": 0}}})
        for what, selector in [
            ("analysis", {"viewId": "V13", "errorFacet": "severity", "errorView": "withdrawn", "selectionRef": "gsel_original"}),
            ("diagnosis", {"errorFingerprint": "chosen", "errorLimit": 500, "errorOffset": 500, "selectionRef": "gsel_original"}),
        ]:
            result = self.server.call_tool("geo_read", {"what": what, "filter": selector})
            self.assertEqual(result["status"], "success", result)
            self.assertEqual(_Gateway.seen[-1]["body"]["filter"], selector)
        sent = len(_Gateway.seen)
        for what, selector in [
            ("analysis", {"viewId": "V16", "errorFacet": "type"}),
            ("analysis", {"viewId": "V13", "errorFacet": "other"}),
            ("analysis", {"viewId": "V13", "errorView": "other"}),
            ("analysis", {"viewId": "V13", "errorView": "all", "planContextRef": "gpc_" + "a" * 64}),
            ("claims", {"errorFingerprint": "chosen"}),
            ("diagnosis", {"errorFingerprint": " "}),
            ("diagnosis", {"errorFingerprint": "bad\\nkey".replace("\\n", "\n")}),
            ("diagnosis", {"errorFingerprint": "x" * 241}),
            ("diagnosis", {"errorFingerprint": "chosen", "planContextRef": "gpc_" + "a" * 64}),
        ]:
            result = self.server.call_tool("geo_read", {"what": what, "filter": selector})
            self.assertEqual(result["status"], "error", result)
        self.assertEqual(len(_Gateway.seen), sent)

    def test_analysis_rejects_all_unsupported_diagnosis_list_filters(self):
        sent = len(_Gateway.seen)
        for selector in [{"errorSeverities": ["S4"]}, {"errorStatuses": ["open"]}, {"errorTypes": ["number"]},
                         {"errorSearch": "x"}, {"errorLimit": 5}, {"errorOffset": 1}, {"questionId": "q"},
                         {"errorTrace": "traced"}, {"errorJudgmentState": "active"}, {"errorFingerprint": "f"}]:
            result = self.server.call_tool("geo_read", {"what": "analysis", "filter": {"viewId": "V13", **selector}})
            self.assertEqual(result["status"], "error", result)
        self.assertEqual(len(_Gateway.seen), sent)

    def test_publication_analysis_closed_descriptors_preserve_intended_facets(self):
        _Gateway.answers["read"] = (200, {"data": {"rows": [], "page": {"total": 0}}})
        for selector in [{"viewId": "V23", "publicationFacet": facet} for facet in ("group", "audience", "channel")] + [{"viewId": "V24"}]:
            result = self.server.call_tool("geo_read", {"what": "analysis", "filter": selector})
            self.assertEqual(result["status"], "success", result)
            self.assertEqual(_Gateway.seen[-1]["body"]["filter"], selector)
        sent = len(_Gateway.seen)
        for selector in [{"viewId": "V24", "publicationFacet": "group"}, {"viewId": "V23", "publicationFacet": "platform"},
                         {"viewId": "V23", "publicationFacet": "group", "planContextRef": "gpc_" + "a" * 64}] + [
                {"viewId": "V23", key: value} for key, value in (("audience", "patient"), ("sourceId", "source"), ("url", "https://example.org"),
                    ("key", "key"), ("strategyVersion", 1), ("member", {}), ("answerLimit", 20), ("answerOffset", 1))]:
            result = self.server.call_tool("geo_read", {"what": "analysis", "filter": selector})
            self.assertEqual(result["status"], "error", result)
        self.assertEqual(len(_Gateway.seen), sent)

    def test_finance_analysis_preserves_only_its_exact_version_selectors(self):
        _Gateway.answers["read"] = (200, {"data": {"rows": [], "page": {"total": 0}}})
        for selector in ({"viewId": "V25", "financeFacet": "ledger"},
                         {"viewId": "V25", "financeFacet": "group"},
                         {"viewId": "V26", "strategyVersion": 2, "targetVersion": 1},
                         {"viewId": "V26"}):
            result = self.server.call_tool("geo_read", {"what": "analysis", "filter": selector})
            self.assertEqual(result["status"], "success", result)
            self.assertEqual(_Gateway.seen[-1]["body"]["filter"], selector)
        sent = len(_Gateway.seen)
        for selector in ({"viewId": "V23", "strategyVersion": 1}, {"viewId": "V25", "targetVersion": 1},
                         {"viewId": "V26", "strategyVersion": True}, {"viewId": "V26", "targetVersion": 0},
                         {"viewId": "V26", "financeFacet": "group"}, {"viewId": "V25", "financeFacet": "project"},
                         {"planContextRef": "gpc_" + "a" * 64, "strategyVersion": 1},
                         {"planContextRef": "gpc_" + "a" * 64, "financeFacet": "ledger"}):
            result = self.server.call_tool("geo_read", {"what": "analysis", "filter": selector})
            self.assertEqual(result["status"], "error", result)
        self.assertEqual(len(_Gateway.seen), sent)

    def test_history_analysis_retains_exact_selection_and_refuses_live_frozen_overrides(self):
        _Gateway.answers["read"] = (200, {"data": {"rows": [], "page": {"total": 0}}})
        for selector in ({"viewId": "V15", "selectionRef": "gsel_history"},
                         {"viewId": "V27", "metricId": "M-06", "dimension": "project", "clientTags": ["selected"]},
                         {"planContextRef": "gpc_" + "a" * 64, "rowKey": "historical-event", "columnKey": "objects", "offset": 37, "limit": 37}):
            result = self.server.call_tool("geo_read", {"what": "analysis", "filter": selector})
            self.assertEqual(result["status"], "success", result)
            self.assertEqual(_Gateway.seen[-1]["body"]["filter"], selector)
        sent = len(_Gateway.seen)
        for selector in ({"viewId": "V15", "metricId": "M-01"}, {"viewId": "V27", "metricId": "M-16"},
                         {"viewId": "V27", "dimension": "group"}, {"viewId": "V27", "sourceSearch": "foreign"},
                         {"viewId": "V15", "planContextRef": "gpc_" + "a" * 64},
                         {"viewId": "V27", "targetVersion": 1}):
            result = self.server.call_tool("geo_read", {"what": "analysis", "filter": selector})
            self.assertEqual(result["status"], "error", result)
        self.assertEqual(len(_Gateway.seen), sent)

    def test_target_version_never_crosses_http_for_other_resources(self):
        _Gateway.answers["read"] = (200, {"data": {"rows": [], "page": {"total": 0}}})
        sent = len(_Gateway.seen)
        for what in ("claims", "strategy"):
            for selector in ({"targetVersion": 1}, {"targetVersion": 1, "strategyVersion": 17},
                             {"targetVersion": 1, "planContextRef": "gpc_" + "a" * 64}):
                with self.subTest(what=what, selector=selector):
                    result = self.server.call_tool("geo_read", {"what": what, "filter": selector})
                    self.assertEqual(result["status"], "error", result)
                    self.assertEqual(len(_Gateway.seen), sent)
        for what, selector in (("strategy", {"strategyVersion": 17}),
                               ("analysis", {"viewId": "V26", "strategyVersion": 17, "targetVersion": 2}),
                               ("analysis", {"planContextRef": "gpc_" + "a" * 64, "rowKey": "old", "columnKey": "objects", "offset": 51, "limit": 37})):
            result = self.server.call_tool("geo_read", {"what": what, "filter": selector})
            self.assertEqual(result["status"], "success", result)
            self.assertEqual(_Gateway.seen[-1]["body"], {"what": what, "filter": selector})
        self.assertEqual(len(_Gateway.seen), sent + 3)

    def test_analysis_resources_reject_signal_targets_and_frozen_live_overrides_before_http(self):
        sent = len(_Gateway.seen)
        for view in ("V23", "V24"):
            for selector in ({"viewId": view, "targetKey": "live-target"},
                             {"viewId": view, "planContextRef": "gpc_" + "a" * 64}):
                with self.subTest(selector=selector):
                    result = self.server.call_tool("geo_read", {"what": "analysis", "filter": selector})
                    self.assertEqual(result["status"], "error", result)
        for override in ({"selectionRef": "gsel_live"}, {"metricId": "M-01"}, {"rowKey": "one"},
                         {"rowKey": "one", "columnKey": "orders"}, {"columnKey": "objects"}):
            result = self.server.call_tool("geo_read", {"what": "analysis", "filter": {"planContextRef": "gpc_" + "a" * 64, **override}})
            self.assertEqual(result["status"], "error", result)
        self.assertEqual(len(_Gateway.seen), sent)

    def test_frozen_object_continuation_preserves_exact_selectors_and_offset(self):
        selector = {"planContextRef": "gpc_" + "a" * 64, "rowKey": "same-claim", "columnKey": "objects", "offset": 51, "limit": 37}
        items = [{"id": "old-observation", "originalAssessment": {"assessmentVersion": "original", "assessment": {"statements": [{"verdict": "wrong"}]}}}]
        _Gateway.answers["read"] = (200, {"data": {"items": items, "total": 250, "nextOffset": 52, "readingsKind": "submitted_input"}})
        result = self.server.call_tool("geo_read", {"what": "analysis", "filter": selector})
        self.assertEqual(result["status"], "success", result)
        self.assertEqual(_Gateway.seen[-1]["body"], {"what": "analysis", "filter": selector})
        self.assertEqual(result["data"]["items"], items)
        self.assertEqual(result["data"]["nextOffset"], 52)

    def test_confirmed_relationship_and_opportunity_analysis_forward_exact_native_selectors(self):
        selectors = [
            {"viewId": "V20", "selectionRef": "gsel_d3", "sourceSearch": "shared.example/s?id=001", "sourceRelationship": "all"},
            {"viewId": "V21", "selectionRef": "gsel_d3"},
            {"viewId": "V21", "ownedMetricId": "M-08", "selectionRef": "gsel_d3", "limit": 20, "offset": 20},
            {"viewId": "V21", "ownedMetricId": "M-08S", "selectionRef": "gsel_d3", "rowKey": "exact-group", "columnKey": "owned", "expectedDigest": "a" * 64},
        ]
        for selector in selectors:
            with self.subTest(selector=selector):
                rows = [{"key": "exact-group", "values": {"owned": {"value": None, "state": "unknown"}, "sample": {"value": 0, "state": "known"}}}]
                _Gateway.answers["read"] = (200, {"data": {"view": selector, "rows": rows, "page": {"total": 1}}})
                before = len(_Gateway.seen)
                result = self.server.call_tool("geo_read", {"what": "analysis", "filter": selector})
                self.assertEqual(result["status"], "success", result)
                self.assertEqual(len(_Gateway.seen), before + 1)
                self.assertEqual(_Gateway.seen[-1]["body"], {"what": "analysis", "filter": selector})
                self.assertEqual(result["data"]["rows"], rows)
                self.assertEqual(result["data"]["view"], selector)

    def test_owned_source_metric_invalid_values_views_and_frozen_overrides_make_no_gateway_request(self):
        _Gateway.answers["read"] = (200, {"data": {"rows": []}})
        controls = [
            ("analysis", {"viewId": "V21", "ownedMetricId": value})
            for value in ("M-09", "M-08B", "M-01", "m-08s", "", None, 8, True, ["M-08"], {"id": "M-08"})
        ] + [
            ("analysis", {"viewId": "V20", "ownedMetricId": "M-08"}),
            ("analysis", {"viewId": "V19", "ownedMetricId": "M-08S"}),
            ("analysis", {"ownedMetricId": "M-08"}),
            ("analysis", {"viewId": "V99"}),
            ("analysis", {"viewId": "V21", "ownedMetricId": "M-08", "planContextRef": "gpc_" + "a" * 64}),
            ("claims", {"viewId": "V21", "ownedMetricId": "M-08S"}),
        ]
        for what, selector in controls:
            with self.subTest(what=what, selector=selector):
                result = self.server.call_tool("geo_read", {"what": what, "filter": selector})
                self.assertEqual(result["status"], "error", result)
                self.assertFalse(result["error"]["retryable"])
                self.assertEqual(_Gateway.seen, [])
        selected = {"planContextRef": "gpc_" + "a" * 64, "offset": 0, "limit": 1}
        result = self.server.call_tool("geo_read", {"what": "analysis", "filter": selected})
        self.assertEqual(result["status"], "success")
        self.assertEqual(_Gateway.seen[-1]["body"], {"what": "analysis", "filter": selected})

    def test_signal_material_pages_keep_the_bound_context_and_exact_target(self):
        selected = {"planContextRef": "gpc_" + "a" * 64, "targetKey": "target_exact", "limit": 1, "offset": 2}
        _Gateway.answers["read"] = (200, {"data": {"items": [{"part": 2, "text": "Preserved material"}], "total": 4, "more": True, "nextOffset": 3}})
        result = self.server.call_tool("geo_read", {"what": "signal", "filter": selected})
        self.assertEqual(result["status"], "success")
        self.assertEqual(_Gateway.seen[-1]["body"], {"what": "signal", "filter": selected})
        self.assertTrue(any("filter.offset=3" in action for action in result["next_actions"]))
        count = len(_Gateway.seen)
        result = self.server.call_tool("geo_read", {"what": "signal", "filter": {**selected, "targetKey": "x" * 161}})
        self.assertEqual(result["status"], "error")
        self.assertEqual(len(_Gateway.seen), count)

    def test_metric_matrix_and_round_descriptors_survive_the_native_tool_boundary(self):
        _Gateway.answers["read"] = (200, {"data": {"rows": [], "page": {"total": 0}}})
        for selector in [
            {"viewId": "V02", "timeGrain": "round", "dimension": "engine"},
            {"viewId": "V03", "metricId": "M-01", "dimension": "group"},
            {"viewId": "V08", "metricId": "M-16", "entityKey": "registered-rival", "timeGrain": "round"},
            {"viewId": "V09"},
            {"viewId": "V05", "entityKind": "generic", "entityKey": "Preserved generic", "dimension": "group"},
        ]:
            result = self.server.call_tool("geo_read", {"what": "analysis", "filter": selector})
            self.assertEqual(result["status"], "success")
            self.assertEqual(_Gateway.seen[-1]["body"]["filter"], selector)
        sent = len(_Gateway.seen)
        for field, value in [("timeGrain", "year"), ("entityKind", "market"), ("entityKey", 4)]:
            result = self.server.call_tool("geo_read", {"what": "analysis", "filter": {"viewId": "V05", field: value}})
            self.assertEqual(result["status"], "error")
        self.assertEqual(len(_Gateway.seen), sent)

    def test_diagnosis_progress_follows_its_page_cursor_without_losing_the_round(self):
        _Gateway.answers["read"] = (200, {"data": {"roundId": "round_one", "cells": [{"jobId": "job_first"}],
            "page": {"total": 51, "more": True, "nextOffset": 50}}})
        first = self.server.call_tool("geo_read", {"what": "diagnosis_progress", "filter": {"round": "round_one", "limit": 50}})
        self.assertTrue(any("filter.offset=50" in action for action in first["next_actions"]))
        self.assertFalse(any("errorOffset" in action for action in first["next_actions"]))
        _Gateway.answers["read"] = (200, {"data": {"roundId": "round_one", "cells": [{"jobId": "job_last"}],
            "page": {"total": 51, "more": False, "nextOffset": None}}})
        second = self.server.call_tool("geo_read", {"what": "diagnosis_progress", "filter": {"round": "round_one", "limit": 50, "offset": 50}})
        self.assertEqual(second["next_actions"], [])
        self.assertEqual(second["data"]["cells"], [{"jobId": "job_last"}])
        self.assertEqual(_Gateway.seen[-1]["body"]["filter"], {"round": "round_one", "limit": 50, "offset": 50})

    def test_error_and_source_pages_name_their_authoritative_continuation_offsets(self):
        cases = [
            ("errors", "page", "errorOffset", {"errorLimit": 2, "errorOffset": 0}),
            ("diagnosis", "errorPage", "errorOffset", {"errorLimit": 2, "errorOffset": 0}),
            ("sources", "answerPage", "answerOffset", {"sourceId": "source_one", "answerLimit": 2, "answerOffset": 0}),
        ]
        for what, page_key, offset_key, scope in cases:
            with self.subTest(what=what):
                scope = {"selectionRef": "gsel_one", **scope}
                _Gateway.answers["read"] = (200, {"data": {page_key: {"more": True, "nextOffset": 2}, "items": ["first"]}})
                first = self.server.call_tool("geo_read", {"what": what, "filter": scope})
                self.assertTrue(any("filter.%s=2" % offset_key in action for action in first["next_actions"]))
                self.assertFalse(any("filter.offset" in action for action in first["next_actions"]))
                _Gateway.answers["read"] = (200, {"data": {page_key: {"more": False, "nextOffset": None}, "items": ["second"]}})
                second = self.server.call_tool("geo_read", {"what": what, "filter": {**scope, offset_key: 2}})
                self.assertEqual(second["data"]["items"], ["second"])
                self.assertEqual(second["next_actions"], [])
                self.assertEqual(_Gateway.seen[-1]["body"]["filter"][offset_key], 2)

    def test_nullable_member_dimensions_are_validated_before_the_gateway_call(self):
        _Gateway.answers["read"] = (200, {"data": {"items": [], "more": False}})
        for value in [None, "P2"]:
            result = self.server.call_tool("geo_read", {"what": "snapshots", "filter": {"member": {"metricId": "M-06", "scope": "project", "pool": value}}})
            self.assertEqual(result["status"], "success")
        requests = len(_Gateway.seen)
        for value in [17, True, ["P2"], {"unexpected": True}]:
            with self.subTest(value=value):
                result = self.server.call_tool("geo_read", {"what": "snapshots", "filter": {"member": {"metricId": "M-06", "scope": "project", "pool": value}}})
                self.assertEqual(result["status"], "error")
                self.assertEqual(len(_Gateway.seen), requests, "invalid union types must not reach the gateway")

    def test_scoped_member_continuation_preserves_its_identity_and_supports_the_full_selection(self):
        schema = geo_platform.tool_definitions()[0]["inputSchema"]["properties"]["filter"]
        self.assertGreaterEqual(schema["properties"]["offset"]["maximum"], 20000)
        selection = {"reference": "gsel_one", "dataRevision": "revision-one"}
        _Gateway.answers["read"] = (200, {"data": {"selection": selection, "items": [], "more": False, "total": 20000}})
        scope = {"selectionRef": "gsel_one", "member": {"metricId": "M-06", "scope": "project", "pool": None, "observationDate": "2026-10-01"}, "offset": 19950, "limit": 50}
        result = self.server.call_tool("geo_read", {"what": "snapshots", "filter": scope})
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["data"]["selection"], selection)
        self.assertEqual(_Gateway.seen[0]["body"]["filter"], scope)
        before = len(_Gateway.seen)
        invalid = self.server.call_tool("geo_read", {"what": "snapshots", "filter": {**scope, "member": {**scope["member"], "observationDate": ""}}})
        self.assertEqual(invalid["status"], "error")
        self.assertEqual(len(_Gateway.seen), before)

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

    def test_a_lean_list_says_where_the_next_page_starts_and_how_to_read_one_action_whole(self):
        _Gateway.answers["read"] = (200, {"data": {"what": "actions", "detail": "lean", "total": 40, "more": True, "nextOffset": 11, "omitted": 29,
                                                    "counts": {"total": 40}, "actions": [{"key": "fill_gap:g:a"}]}})
        result = self.server.call_tool("geo_read", {"what": "actions"})
        self.assertEqual(result["status"], "success")
        self.assertTrue(any("filter.offset=11" in action for action in result["next_actions"]), result["next_actions"])
        self.assertTrue(any("filter.key" in action and "whole" in action for action in result["next_actions"]), result["next_actions"])
        self.assertEqual(result["data"]["counts"], {"total": 40}, "the sums reach the run untouched")
        # a whole entry (a key or a group) is not told to be read whole again, and a list with nothing left has no cursor to follow
        _Gateway.answers["read"] = (200, {"data": {"what": "actions", "detail": "whole", "total": 1, "more": False, "actions": [{"key": "fill_gap:g:a"}]}})
        whole = self.server.call_tool("geo_read", {"what": "actions", "filter": {"key": "fill_gap:g:a"}})
        self.assertEqual(whole["next_actions"], [])
        self.assertEqual(_Gateway.seen[-1]["body"], {"what": "actions", "filter": {"key": "fill_gap:g:a"}})
        _Gateway.answers["read"] = (200, {"data": {"what": "claims", "items": [], "more": True}})
        plain = self.server.call_tool("geo_read", {"what": "claims"})
        self.assertEqual(plain["next_actions"], ["Call again with filter.offset to read the next page, or narrow the filter."])

    def test_the_gateway_s_own_codes_reach_the_run_and_nothing_else_does(self):
        _Gateway.answers["read"] = (429, {"error": "Too many GEO calls in a minute.", "code": "geo_gateway_rate_limited"})
        result = self.server.call_tool("geo_read", {"what": "project"})
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["error"]["code"], "geo_gateway_rate_limited")
        self.assertTrue(result["error"]["retryable"])
        _Gateway.answers["read"] = (502, {"error": "bad gateway", "code": "proxy_exploded"})
        result = self.server.call_tool("geo_read", {"what": "project"})
        self.assertEqual(result["error"]["code"], "geo_upstream_error")
        self.assertTrue(result["error"]["retryable"])

    def test_outside_a_geo_project_a_read_or_write_is_a_warning_that_names_why(self):
        _Gateway.answers["read"] = (404, {"error": "This conversation is not in a 循证 GEO project.", "code": "geo_no_project"})
        _Gateway.answers["write"] = (404, {"error": "This conversation is not in a 循证 GEO project.", "code": "geo_no_project"})
        read = self.server.call_tool("geo_read", {"what": "claims"})
        self.assertEqual(read["status"], "warning")
        self.assertEqual(read["data"]["code"], "geo_no_project")
        write = self.server.call_tool("geo_write", {"what": "step", "data": {"step": "diagnosis", "status": "none"}})
        self.assertEqual(write["status"], "warning")
        self.assertIn("no step to write", write["summary"])

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

    def test_fields_the_page_does_not_keep_are_notices_that_name_what_it_keeps_not_refusals(self):
        message = ("Not stored by the platform (kept only in the files): title, impact. "
                   "This object keeps: gapId, class, groupId, judgment, rank.")
        _Gateway.answers["write"] = (200, {"data": {"what": "strategy", "ok": True, "ids": ["1"], "issues": [
            {"indexes": [0, 1, 2], "count": 3, "path": "gaps", "field": "title,impact", "code": "ignored_fields", "message": message}]}})
        result = self.server.call_tool("geo_write", {"what": "strategy", "data": {"gaps": [{}]}})
        self.assertEqual(result["status"], "warning")
        self.assertEqual(result["summary"], "Wrote strategy: 1 written, 1 field name(s) not kept.")
        self.assertNotIn("refused", result["summary"])
        self.assertEqual(result["warnings"], ["title,impact: " + message])
        self.assertEqual(len(result["next_actions"]), 1)
        self.assertIn("names each notice lists", result["next_actions"][0])

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


class GeoStopReasonTests(_GatewayCase):
    """What the run is told to do next, by the gateway's code (2026-10-25): a payload the store refused or one too large is the run's
    to correct and send again, and a refused credential is the deployment's -- as vcr_platform.py already says for its own codes."""

    def test_a_payload_the_store_refused_or_one_too_large_is_the_runs_to_correct_not_to_give_up(self):
        _Gateway.answers["write"] = (422, {"error": "The platform's store refused this write; check the closed words, then write it again.",
                                           "code": "geo_write_rejected"})
        rejected = self.server.call_tool("geo_write", {"what": "claims", "items": [{"claimKey": "a"}]})
        self.assertEqual((rejected["error"]["code"], rejected["error"]["stopReason"], rejected["error"]["retryable"]),
                         ("geo_write_rejected", "invalid_input", False))
        self.assertNotIn("Go on without", " ".join(rejected["next_actions"]))
        _Gateway.answers["write"] = (413, {"error": "The GEO request was too large.", "code": "geo_request_too_large"})
        large = self.server.call_tool("geo_write", {"what": "claims", "items": [{"claimKey": "a"}]})
        self.assertEqual(large["error"]["stopReason"], "invalid_input")
        self.assertIn("smaller", " ".join(large["next_actions"]))

    def test_a_refused_credential_is_the_deployments_never_a_field_the_run_got_wrong(self):
        for code in ("geo_gateway_token_invalid", "geo_gateway_token_missing"):
            _Gateway.answers["read"] = (401, {"error": "GEO gateway authentication failed.", "code": code})
            result = self.server.call_tool("geo_read", {"what": "claims"})
            self.assertEqual((result["error"]["code"], result["error"]["stopReason"]), (code, "unsupported"))
            self.assertNotIn("Correct the named field", " ".join(result["next_actions"]))
        self.assertEqual(geo_platform.GeoPlatformError("geo_read_filter_invalid", "x").stop_reason(), "invalid_input")
        self.assertEqual(geo_platform.GeoPlatformError("geo_gateway_unreachable", "x", retryable=True).stop_reason(), "retry")
        self.assertEqual(geo_platform.GeoPlatformError("geo_disabled", "x").stop_reason(), "unsupported")

    def test_a_diagnosis_refusal_with_its_own_next_step_says_it_and_an_acknowledgement_is_the_users(self):
        expected = {
            "geo_recovery_acknowledgment_required": ("needs_user", "Ask the user"),
            "geo_recovery_exhausted": ("unsupported", "not measured"),
            "geo_request_key_conflict": ("invalid_input", "new requestKey"),
        }
        for code, (stop, words) in expected.items():
            _Gateway.answers["write"] = (409, {"error": "Refused: %s" % code, "code": code})
            result = self.server.call_tool("geo_write", {"what": "recover_diagnosis", "data": {"roundId": "r1", "requestKey": "k1", "jobIds": ["j1"]}})
            self.assertEqual((result["error"]["code"], result["error"]["stopReason"]), (code, stop))
            self.assertIn(words, " ".join(result["next_actions"]))
            self.assertNotIn("Go on without", " ".join(result["next_actions"]))

    def test_the_write_offers_no_plan_context_the_gateway_would_refuse(self):
        write = {tool["name"]: tool for tool in geo_platform.tool_definitions()}["geo_write"]
        self.assertNotIn("planContextRef", write["inputSchema"]["properties"])
        self.assertNotIn("same requestKey", write["description"])
        self.assertIn("new requestKey", write["description"])

    def test_the_write_says_a_questions_write_adds_to_the_map_unless_it_replaces_it(self):
        write = {tool["name"]: tool for tool in geo_platform.tool_definitions()}["geo_write"]
        self.assertIn("data.replace:true", write["description"])


class SocialPostsTests(_GatewayCase):
    def test_collected_posts_come_back_as_they_were_minimised(self):
        post = {"platform": "xhs", "url": "https://www.xiaohongshu.com/discovery/item/abc", "postId": "abc", "excerpt": "二甲双胍饭前还是饭后吃？",
                "engagement": {"likes": 3, "favs": 1, "shares": 0, "comments": 2}, "collectedAt": "2026-09-25T02:00:00.000Z", "comments": ["饭后"]}
        _Gateway.answers["social"] = (200, {"data": {"query": "二甲双胍", "sort": "hot", "status": "collected",
            "platforms": [{"platform": "xhs", "status": "collected", "posts": 1}], "posts": [post]}})
        result = self.server.call_tool("social_posts_search", {"query": "二甲双胍", "platform": "xhs", "limit": 5})
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["data"]["posts"], [post])
        self.assertEqual(_Gateway.seen[0]["path"], "/internal/geo/v1/social")
        self.assertEqual(_Gateway.seen[0]["body"], {"query": "二甲双胍", "platforms": ["xhs"], "limit": 5})

    def test_multiple_platforms_share_one_call_and_invalid_selections_never_cross_boundary(self):
        _Gateway.answers["social"] = (200, {"data": {"status": "partial_collected", "platforms": [], "posts": []}})
        result = self.server.call_tool("social_posts_search", {"query": "q" * 256, "platforms": ["xhs", "zhihu"]})
        self.assertEqual(result["status"], "warning")
        self.assertEqual(_Gateway.seen[0]["body"]["platforms"], ["xhs", "zhihu"])
        for selection in ({"platform": "xhs", "platforms": ["xhs"]}, {"platforms": []}, {"platforms": ["xhs", "xhs"]}, {"platforms": ["unknown"]}):
            result = self.server.call_tool("social_posts_search", {"query": "q", **selection})
            self.assertEqual(result["status"], "error")
        self.assertEqual(len(_Gateway.seen), 1)

    def test_a_channel_that_did_not_answer_is_no_signal_never_zero(self):
        _Gateway.answers["social"] = (200, {"data": {"status": "request_failed", "platforms": [{"platform": "xhs", "status": "request_failed", "posts": 0}],
            "posts": []}})
        result = self.server.call_tool("social_posts_search", {"query": "降糖药", "platform": "zhihu"})
        self.assertEqual(result["status"], "warning")
        self.assertIn("无信号", " ".join(result["warnings"]))
        self.assertEqual(result["data"]["status"], "request_failed")

    def test_a_pending_search_is_still_running_and_says_how_to_read_it_without_searching_again(self):
        job = "a1" * 16
        _Gateway.answers["social"] = (200, {"data": {"query": "降糖药", "sort": "hot", "status": "pending", "reason": "pending", "jobId": job,
            "platforms": [{"platform": "xhs", "status": "collected", "posts": 1}, {"platform": "zhihu", "status": "request_failed", "posts": 0, "reason": "pending"}],
            "posts": [{"platform": "xhs", "postId": "1"}]}})
        result = self.server.call_tool("social_posts_search", {"query": "降糖药", "platforms": ["xhs", "zhihu"]})
        self.assertEqual(result["status"], "warning")
        self.assertEqual(result["data"]["status"], "pending")
        self.assertEqual(result["data"]["jobId"], job)
        self.assertEqual(len(result["data"]["posts"]), 1, "what is collected so far is kept")
        self.assertIn("still running", result["summary"])
        text = " ".join(result["warnings"] + result["next_actions"])
        self.assertIn("not failed", text)
        self.assertIn("Do not search again", text)
        self.assertIn(job, text)
        self.assertNotIn("shorter or more colloquial", text, "a running job is not a failed query")

    def test_a_pending_search_with_no_readable_id_says_a_repeat_joins_it(self):
        _Gateway.answers["social"] = (200, {"data": {"status": "pending", "platforms": [], "posts": []}})
        result = self.server.call_tool("social_posts_search", {"query": "降糖药", "platform": "xhs"})
        self.assertEqual(result["data"]["status"], "pending")
        self.assertNotIn("jobId", result["data"])
        self.assertIn("joins the running job", " ".join(result["next_actions"]))
        _Gateway.answers["social"] = (200, {"data": {"status": "pending", "jobId": "../x", "platforms": [], "posts": []}})
        self.assertNotIn("jobId", self.server.call_tool("social_posts_search", {"query": "降糖药", "platform": "xhs"})["data"], "an id of another shape is not passed on")

    def test_a_job_id_alone_reads_on_through_the_gateway_and_renders_as_a_search_does(self):
        job = "B2" * 16
        post = {"platform": "xhs", "postId": "late", "excerpt": "饭前吃"}
        _Gateway.answers["social_job"] = (200, {"data": {"jobId": job, "query": "二甲双胍", "sort": "hot", "status": "collected",
            "platforms": [{"platform": "xhs", "status": "collected", "posts": 1}], "posts": [post]}})
        result = self.server.call_tool("social_posts_search", {"jobId": job})
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["data"]["posts"], [post])
        self.assertEqual(result["data"]["query"], "二甲双胍")
        self.assertEqual((_Gateway.seen[0]["path"], _Gateway.seen[0]["body"]), ("/internal/geo/v1/social_job", {"jobId": job}))
        _Gateway.answers["social_job"] = (200, {"data": {"jobId": job, "query": "二甲双胍", "status": "pending", "platforms": [], "posts": []}})
        again = self.server.call_tool("social_posts_search", {"jobId": job})
        self.assertEqual(again["data"]["status"], "pending")
        self.assertEqual(again["data"]["jobId"], job)

    def test_a_job_id_is_read_alone_and_in_its_own_shape_before_anything_crosses(self):
        job = "a1" * 16
        for arguments in ({"jobId": job, "query": "q"}, {"jobId": job, "platform": "xhs"}, {"jobId": job, "limit": 3}, {"jobId": "abc"}, {"jobId": "z" * 32},
                          {"jobId": 7}, {"query": "q"}, {}):
            self.assertEqual(self.server.call_tool("social_posts_search", arguments)["status"], "error", arguments)
        # The handler holds the same line when called directly.
        with self.assertRaises(geo_platform.GeoPlatformError) as caught:
            geo_platform.social_search({"jobId": job, "query": "q"})
        self.assertEqual(caught.exception.code, "social_posts_job_invalid")
        self.assertEqual(_Gateway.seen, [])

    def test_a_job_that_is_not_this_projects_is_refused_by_name_with_the_next_step(self):
        _Gateway.answers["social_job"] = (404, {"error": "This project started no social search with that jobId.", "code": "social_posts_job_unknown"})
        result = self.server.call_tool("social_posts_search", {"jobId": "a1" * 16})
        self.assertEqual(result["error"]["code"], "social_posts_job_unknown")
        self.assertFalse(result["error"]["retryable"])
        self.assertIn("search again", " ".join(result["next_actions"]))
        _Gateway.answers["social_job"] = (503, {"error": "The record could not be read.", "code": "social_posts_job_unavailable"})
        self.assertTrue(self.server.call_tool("social_posts_search", {"jobId": "a1" * 16})["error"]["retryable"])

    def test_the_gateways_platform_bound_reaches_the_run_as_its_own_words(self):
        _Gateway.answers["social"] = (400, {"error": "At most 2 platforms per call (the collector serves them one at a time, 30-120 s each): ask the others in another call.",
                                            "code": "social_posts_platform_invalid"})
        result = self.server.call_tool("social_posts_search", {"query": "q", "platforms": ["xhs", "zhihu", "douyin"]})
        self.assertEqual(result["error"]["code"], "social_posts_platform_invalid")
        self.assertIn("At most 2 platforms", result["error"]["message"])
        self.assertFalse(result["error"]["retryable"])

    def test_an_unconfigured_channel_is_not_retried(self):
        _Gateway.answers["social"] = (503, {"error": "The social channel is not configured.", "code": "social_posts_unconfigured"})
        result = self.server.call_tool("social_posts_search", {"query": "降糖药", "platform": "zhihu"})
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
