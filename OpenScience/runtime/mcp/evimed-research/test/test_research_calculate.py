"""The production MCP path to owned initial calculations, against a gateway."""
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
import research_calculate

CONTEXT = {"v": 1, "sessionId": "session", "callId": "call", "rootCallId": "root-call",
           "provider": "deepseek-official", "model": "deepseek-flash", "reasoningEffort": "high"}


class Gateway(BaseHTTPRequestHandler):
    seen = []
    answer = {"data": {"id": "calculation-job", "state": "queued"}}
    status = 200

    def do_POST(self):
        value = json.loads(self.rfile.read(int(self.headers["content-length"])))
        type(self).seen.append({"path": self.path, "body": value, "authorization": self.headers.get("authorization"),
                               "context": json.loads(self.headers["X-EviMed-Execution-Context"]) if self.headers.get("X-EviMed-Execution-Context") else None})
        body = json.dumps(type(self).answer).encode()
        self.send_response(type(self).status); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

    def log_message(self, *_args):
        pass


class ResearchCalculationTests(unittest.TestCase):
    def setUp(self):
        Gateway.seen, Gateway.status = [], 200
        Gateway.answer = {"data": {"id": "calculation-job", "state": "queued"}}
        http = ThreadingHTTPServer(("127.0.0.1", 0), Gateway)
        threading.Thread(target=http.serve_forever, daemon=True).start()
        self.addCleanup(http.server_close); self.addCleanup(http.shutdown)
        temporary = tempfile.TemporaryDirectory(); self.addCleanup(temporary.cleanup)
        token = pathlib.Path(temporary.name) / "gateway-token"; token.write_text("test-runtime-token\n"); token.chmod(0o600)
        base = f"http://127.0.0.1:{http.server_address[1]}"
        patcher = mock.patch.dict(os.environ, {"EVIMED_RESULT_GATEWAY_URL": base + "/internal/results/v1",
                                               "EVIMED_PUBLIC_SOURCE_GATEWAY_URL": base + "/internal/sources/v1/fetch",
                                               "EVIMED_MODEL_GATEWAY_TOKEN_FILE": str(token), "EVIMED_DISABLED_TOOLS": ""})
        patcher.start(); self.addCleanup(patcher.stop)
        spec = importlib.util.spec_from_file_location("evimed_calculation_mcp", ROOT / "server.py")
        self.server = importlib.util.module_from_spec(spec); spec.loader.exec_module(self.server)

    def test_initial_calculation_is_exposed_and_actual_context_and_input_path_reach_gateway(self):
        self.assertIn("research_calculate", {item["name"] for item in self.server.list_tools()})
        arguments = {"action": "start", "method": "meta.dl", "inputPath": "data/studies.json",
                     "parameters": {}, "__evimed_execution_context": CONTEXT}
        result = self.server.call_tool("research_calculate", arguments)
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["data"]["id"], "calculation-job")
        observed = Gateway.seen[0]
        self.assertEqual(observed["path"], "/internal/results/v1/start")
        self.assertEqual(observed["authorization"], "Bearer test-runtime-token")
        self.assertEqual(observed["context"], CONTEXT)
        self.assertEqual(observed["body"]["inputPath"], "data/studies.json")
        self.assertNotIn("codeDigest", observed["body"])
        self.assertNotIn("action", observed["body"])
        self.server.call_tool("research_calculate", arguments)
        self.assertEqual(Gateway.seen[0]["body"]["requestId"], Gateway.seen[1]["body"]["requestId"])

    def test_no_recipe_execution_or_unowned_turn_is_accepted(self):
        base = {"action": "start", "method": "meta.dl", "inputPath": "data/studies.json"}
        self.assertEqual(self.server.call_tool("research_calculate", base)["error"]["code"], "result_execution_context_unavailable")
        for changed in [{"inputPath": "../patient.csv"}, {"method": "user.script"}, {"parameters": {"script": "run.py"}},
                        {"parameters": {"maxNodes": 10}}, {"inputPath": "/private/data.json"}]:
            result = self.server.call_tool("research_calculate", {**base, **changed, "__evimed_execution_context": CONTEXT})
            self.assertEqual(result["status"], "error")
        self.assertEqual(Gateway.seen, [])

    def test_status_and_cancel_expose_completed_partial_or_failed_outcome_without_withholding_prior_work(self):
        Gateway.answer = {"data": {"id": "calculation-job", "state": "succeeded", "resultVersionId": "rv_version", "artifacts": [{"path": "result.json"}]}}
        result = self.server.call_tool("research_calculate", {"action": "status", "jobId": "calculation-job"})
        self.assertEqual(result["data"]["resultVersionId"], "rv_version")
        Gateway.answer = {"data": {"id": "calculation-job", "state": "ownership_unknown", "cleanup": "unknown"}}
        result = self.server.call_tool("research_calculate", {"action": "cancel", "jobId": "calculation-job"})
        self.assertEqual(result["status"], "warning")
        self.assertEqual(result["data"]["cleanup"], "unknown")
        self.assertEqual(Gateway.seen[-1]["path"], "/internal/results/v1/cancel")

    def test_named_refusal_disabled_gateway_and_bad_response_remain_explicit(self):
        Gateway.status = 422; Gateway.answer = {"code": "result_input_changed", "error": "untrusted text is not reflected"}
        result = self.server.call_tool("research_calculate", {"action": "status", "jobId": "calculation-job"})
        self.assertEqual(result["error"]["code"], "result_input_changed")
        Gateway.status = 200; Gateway.answer = {"data": {"values": [1]}}
        result = self.server.call_tool("research_calculate", {"action": "status", "jobId": "calculation-job"})
        self.assertEqual(result["error"]["code"], "result_response_invalid")
        with mock.patch.dict(os.environ, {"EVIMED_RESULT_GATEWAY_URL": ""}):
            result = self.server.call_tool("research_calculate", {"action": "status", "jobId": "calculation-job"})
        self.assertEqual(result["error"]["code"], "result_engine_unavailable")

    def test_streamed_response_uses_one_total_deadline_and_size_limit(self):
        class Stream:
            def read1(self, _size):
                return b"x"
        with mock.patch.object(research_calculate.time, "monotonic", side_effect=[1, 2, 4]):
            with self.assertRaises(TimeoutError):
                research_calculate._read_response(Stream(), 3, 10)
        with self.assertRaises(research_calculate.ResearchCalculateError) as caught:
            research_calculate._read_response(Stream(), research_calculate.time.monotonic() + 1, 1)
        self.assertEqual(caught.exception.code, "result_response_too_large")


if __name__ == "__main__":
    unittest.main()
