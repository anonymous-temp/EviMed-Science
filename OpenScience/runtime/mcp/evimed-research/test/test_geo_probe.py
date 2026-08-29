"""The probe client's whole job is refusing to flatten a failure into an absence.

A source fetch that fails leaves a hole somebody notices. A probe that fails and
gets recorded produces a visibility number that is wrong and looks exactly like
a correct one, so every test here is a variation on one question: can a caller
reading this result tell "we asked and nothing came back" from "we never asked"?
"""

from __future__ import annotations

import importlib.util
import io
import json
import pathlib
import sys
import unittest
import urllib.error
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

spec = importlib.util.spec_from_file_location("geo_probe", ROOT / "geo_probe.py")
geo_probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(geo_probe)

GATEWAY = "https://gateway.internal/internal/geo-probe/v1"


def gateway_returns(payload):
    body = json.dumps(payload).encode("utf-8")

    class _Response(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    def opener(request, timeout=None):  # noqa: ARG001
        opener.request = request
        return _Response(body)

    return opener


def run(arguments, payload):
    opener = gateway_returns(payload)
    with mock.patch.dict("os.environ", {"EVIMED_GEO_PROBE_GATEWAY_URL": GATEWAY}), \
         mock.patch.object(geo_probe.public_sources, "_gateway_settings", lambda: ("secret", "runtime-token")), \
         mock.patch.object(geo_probe.public_sources, "_OPENER", mock.Mock(open=opener)):
        return geo_probe.probe(arguments), opener


class ProbeResultTests(unittest.TestCase):
    def test_a_measured_round_reports_success_and_keeps_the_surface(self):
        result, opener = run(
            {"op": "ask", "question": "速效救心丸可以长期服用吗？", "providers": ["deepseek"], "deep": 1},
            {
                "data": {
                    "surface": {"mode": "deep", "session": "new_chat"},
                    "results": [{"provider": "deepseek", "inDenominator": True, "answerDigest": "a" * 64}],
                    "inDenominator": ["deepseek"],
                },
                "measurement": "ok",
            },
        )
        self.assertEqual(result["status"], "success")
        self.assertIn("deep", result["summary"])
        # The surface travels with the number. Without it the same question in
        # a different mode looks like a contradiction rather than a different
        # measurement, which is how a client with a phone collapses a report.
        self.assertTrue(any("deep" in action and "new_chat" in action for action in result["next_actions"]))
        self.assertEqual(json.loads(opener.request.data)["deep"], 1)

    def test_a_round_where_every_vendor_failed_is_an_error_not_an_empty_success(self):
        result, _ = run(
            {"op": "ask", "question": "q", "providers": ["deepseek", "kimi"]},
            {
                "data": {
                    "surface": {"mode": "default", "session": "new_chat"},
                    "results": [
                        {"provider": "deepseek", "inDenominator": False, "error": "会话失效"},
                        {"provider": "kimi", "inDenominator": False, "error": "服务繁忙"},
                    ],
                    "inDenominator": [],
                },
                "measurement": "failed",
            },
        )
        self.assertEqual(result["status"], "error")
        self.assertTrue(any("not a measurement" in w for w in result["warnings"]))
        self.assertTrue(any("会话失效" in w for w in result["warnings"]))

    def test_a_partly_failed_round_is_a_warning_and_names_who_failed(self):
        result, _ = run(
            {"op": "ask", "question": "q", "providers": ["deepseek", "kimi"]},
            {
                "data": {
                    "surface": {"mode": "default", "session": "new_chat"},
                    "results": [
                        {"provider": "deepseek", "inDenominator": True},
                        {"provider": "kimi", "inDenominator": False, "error": "服务繁忙"},
                    ],
                    "inDenominator": ["deepseek"],
                },
                "measurement": "ok",
            },
        )
        self.assertEqual(result["status"], "warning")
        self.assertTrue(any("kimi" in w for w in result["warnings"]))
        # A denominator that silently shrank overstates visibility: 1/1 instead
        # of 1/2 is not a rounding difference, it is double the number.
        self.assertTrue(any("denominator" in a for a in result["next_actions"]))

    def test_an_unready_vendor_is_a_warning_and_is_never_a_vendor_that_stayed_silent(self):
        result, _ = run(
            {"op": "providers"},
            {"data": {"providers": [
                {"provider": "deepseek", "ready": True},
                {"provider": "kimi", "ready": False, "state": "no_tab"},
            ], "ready": ["deepseek"]}, "measurement": "ok"},
        )
        self.assertEqual(result["status"], "warning")
        self.assertTrue(any("never asked" in w for w in result["warnings"]))
        self.assertTrue(any("kimi" in w for w in result["warnings"]))

    def test_all_vendors_ready_is_a_plain_success(self):
        result, _ = run(
            {"op": "providers"},
            {"data": {"providers": [{"provider": "deepseek", "ready": True}], "ready": ["deepseek"]}, "measurement": "ok"},
        )
        self.assertEqual(result["status"], "success")


class ProbeRefusalTests(unittest.TestCase):
    def test_an_unconfigured_deployment_says_the_channel_is_absent(self):
        with mock.patch.dict("os.environ", {}, clear=True):
            with self.assertRaises(geo_probe.GeoProbeError) as caught:
                geo_probe.probe({"op": "providers"})
        self.assertEqual(caught.exception.code, "geo_probe_unconfigured")
        # The message has to tell the run what to write instead, or it will
        # write an estimate and present it as a measurement.
        self.assertIn("not measured", str(caught.exception).lower().replace("measured visibility is unavailable", "not measured"))

    def test_a_busy_probe_is_retryable_because_the_host_serves_one_caller(self):
        def opener(request, timeout=None):  # noqa: ARG001
            raise urllib.error.HTTPError(GATEWAY, 429, "busy", {}, io.BytesIO(b'{"code":"geo_probe_busy"}'))

        with mock.patch.dict("os.environ", {"EVIMED_GEO_PROBE_GATEWAY_URL": GATEWAY}), \
             mock.patch.object(geo_probe.public_sources, "_gateway_settings", lambda: ("secret", "token")), \
             mock.patch.object(geo_probe.public_sources, "_OPENER", mock.Mock(open=opener)):
            with self.assertRaises(geo_probe.GeoProbeError) as caught:
                geo_probe.probe({"op": "ask", "question": "q"})
        self.assertEqual(caught.exception.code, "geo_probe_busy")
        self.assertTrue(caught.exception.retryable)

    def test_an_unreachable_gateway_is_retryable_and_never_an_empty_result(self):
        def opener(request, timeout=None):  # noqa: ARG001
            raise urllib.error.URLError("connection refused")

        with mock.patch.dict("os.environ", {"EVIMED_GEO_PROBE_GATEWAY_URL": GATEWAY}), \
             mock.patch.object(geo_probe.public_sources, "_gateway_settings", lambda: ("secret", "token")), \
             mock.patch.object(geo_probe.public_sources, "_OPENER", mock.Mock(open=opener)):
            with self.assertRaises(geo_probe.GeoProbeError) as caught:
                geo_probe.probe({"op": "ask", "question": "q"})
        self.assertEqual(caught.exception.code, "geo_probe_unavailable")
        self.assertTrue(caught.exception.retryable)

    def test_the_closed_vocabularies_are_enforced_before_the_call(self):
        for arguments, code in (
            ({"op": "fetch"}, "geo_probe_op_invalid"),
            ({"op": "ask", "question": ""}, "geo_probe_question_invalid"),
            ({"op": "ask", "question": "x" * 2_001}, "geo_probe_question_invalid"),
            ({"op": "ask", "question": "q", "providers": ["chatgpt"]}, "geo_probe_provider_invalid"),
            ({"op": "ask", "question": "q", "deep": 2}, "geo_probe_flag_invalid"),
            ({"op": "screenshot"}, "geo_probe_screenshot_name_invalid"),
        ):
            with mock.patch.dict("os.environ", {"EVIMED_GEO_PROBE_GATEWAY_URL": GATEWAY}):
                with self.assertRaises(geo_probe.GeoProbeError) as caught:
                    geo_probe.probe(arguments)
            self.assertEqual(caught.exception.code, code, arguments)


class ProbeToolRegistrationTests(unittest.TestCase):
    def test_the_tool_is_published_and_dispatches(self):
        spec_server = importlib.util.spec_from_file_location("evimed_research_mcp_probe", ROOT / "server.py")
        server = importlib.util.module_from_spec(spec_server)
        spec_server.loader.exec_module(server)
        self.assertIn("geo_visibility_probe", server.TOOLS)

        # The exception has to come from the server's own import of the module.
        # Raising this file's copy of GeoProbeError produces a different class
        # object, sails past server.py's except clause, and the test fails for a
        # reason that has nothing to do with the dispatch it is checking.
        busy = server.geo_probe.GeoProbeError("geo_probe_busy", "busy", True)
        with mock.patch.object(server.geo_probe, "probe", side_effect=busy):
            result = server.call_tool("geo_visibility_probe", {"op": "ask", "question": "q"})
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["error"]["code"], "geo_probe_busy")
        self.assertTrue(result["error"]["retryable"])


if __name__ == "__main__":
    unittest.main()
