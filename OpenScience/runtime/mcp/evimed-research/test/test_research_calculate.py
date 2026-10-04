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
sys.path.insert(0, str(ROOT / "test"))
import research_calculate
import calculation_inputs

CONTEXT = {"v": 1, "sessionId": "session", "callId": "call", "rootCallId": "root-call",
           "provider": "deepseek-official", "model": "deepseek-flash", "reasoningEffort": "high"}
# The two methods the R engine runs. Their inputs are held to the control
# plane's VCR replay in apps/server/test/engineToolContract.test.mjs.
VCR_METHODS = {"design.analytic", "comparator.evalue"}


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

    def test_a_session_on_the_pro_model_starts_a_calculation(self):
        context = {**CONTEXT, "model": "deepseek-v4-pro"}
        result = self.server.call_tool("research_calculate", {"action": "start", "method": "meta.dl",
                                                              "inputPath": "data/studies.json", "__evimed_execution_context": context})
        self.assertEqual(result["status"], "success")
        self.assertEqual(Gateway.seen[0]["context"], context)

    # The description offered meta.dl `studies {id,label,yi,vi}` and nothing
    # else, and maxNodes as an option; the executor requires effectMeasure and
    # outcome too, and maxNodes, and answers a wrong input with a failed job
    # and no reason. What the tool says is now rendered from one table.
    def test_the_description_states_what_every_method_reads(self):
        tool = self.server.TOOLS["research_calculate"]
        self.assertEqual(tuple(research_calculate.METHOD_INPUTS), research_calculate.METHODS)
        self.assertEqual(tool["inputSchema"]["properties"]["method"]["enum"], list(research_calculate.METHODS))
        for method, spec in research_calculate.METHOD_INPUTS.items():
            with self.subTest(method=method):
                self.assertIn("%s %s -- %s" % (method, research_calculate._shape(spec["input"]), spec["note"]), tool["description"])
        self.assertIn("meta.dl {studies[{id,label,yi,vi}],effectMeasure:MD|SMD|RD|OR|RR|HR|IRR,outcome} -- ", tool["description"])
        self.assertIn("faers.signals {tables[{id,a,b,c,d}]} -- ", tool["description"])
        self.assertIn("{edges[{source,target,weight,source_freq,target_freq}]} -- ", tool["description"])
        self.assertIn("{scenario{riskRatio,confidenceLimit?,scale?:risk_ratio|odds_ratio|hazard_ratio,rare?}} -- ", tool["description"])
        self.assertIn("{design{kind:two_arm_fixed},endpoint{type:time_to_event},truth{hazardRatio,controlMedian}}", tool["description"])
        self.assertIn("parameters.maxNodes is required", tool["description"])
        self.assertIn("optional parameters yates, correctZeroCells", tool["description"])
        # Paid for on every request that offers the tool, and refused by the
        # model gateway past 8 KiB: a form added to the table is weighed here.
        self.assertLessEqual(len(tool["description"]), 2400)
        named = {name for spec in research_calculate.METHOD_INPUTS.values()
                 for names in spec.get("parameters", {}).values() for name in names}
        self.assertEqual(named, set(tool["inputSchema"]["properties"]["parameters"]["properties"]))
        self.assertEqual(named, set(calculation_inputs.PARAMETERS))

    def test_the_executor_runs_every_described_input_and_refuses_each_step_away_from_it(self):
        executed = set(calculation_inputs.deterministic_replay.METHODS)
        self.assertEqual(set(research_calculate.METHODS) - executed, VCR_METHODS)
        self.assertEqual(len(executed), 3)
        for method in sorted(executed):
            inputs, parameters = calculation_inputs.cases(method), calculation_inputs.parameter_cases(method)
            self.assertGreaterEqual(len(inputs["refused"]), 8, method)
            for value in inputs["admitted"]:
                for accepted in parameters["admitted"]:
                    with self.subTest(method=method, admitted=value, parameters=accepted):
                        self.assertEqual(calculation_inputs.verdict(method, value, accepted), "admitted")
            for value in inputs["refused"]:
                with self.subTest(method=method, refused=value):
                    self.assertEqual(calculation_inputs.verdict(method, value, parameters["admitted"][0]), "replay_input_invalid")
            for refused in parameters["refused"]:
                with self.subTest(method=method, parameters=refused):
                    self.assertEqual(calculation_inputs.verdict(method, inputs["admitted"][0], refused), "replay_input_invalid")
        # The shape the old description offered, and the option it called optional.
        studies = calculation_inputs.cases("meta.dl")["admitted"][0]["studies"]
        self.assertEqual(calculation_inputs.verdict("meta.dl", {"studies": studies}), "replay_input_invalid")
        edges = calculation_inputs.cases("bibliometric.network")["admitted"][0]
        self.assertEqual(calculation_inputs.verdict("bibliometric.network", edges, {}), "replay_input_invalid")

    def test_a_parameter_is_admitted_or_refused_here_exactly_as_its_method_is_described(self):
        for method in research_calculate.METHODS:
            parameters = calculation_inputs.parameter_cases(method)
            base = {"action": "start", "method": method, "inputPath": "data/input.json", "__evimed_execution_context": CONTEXT}
            for accepted in parameters["admitted"]:
                with self.subTest(method=method, admitted=accepted):
                    seen = len(Gateway.seen)
                    self.assertEqual(self.server.call_tool("research_calculate", {**base, "parameters": accepted})["status"], "success")
                    self.assertEqual(Gateway.seen[seen]["body"]["parameters"], accepted)
            for refused in parameters["refused"]:
                with self.subTest(method=method, refused=refused):
                    seen = len(Gateway.seen)
                    result = self.server.call_tool("research_calculate", {**base, "parameters": refused})
                    self.assertEqual(result["error"]["code"], "invalid_input" if "unexpected" in refused else "result_input_invalid")
                    self.assertEqual(len(Gateway.seen), seen)
        missing = self.server.call_tool("research_calculate", {"action": "start", "method": "bibliometric.network",
                                                               "inputPath": "data/edges.json", "__evimed_execution_context": CONTEXT})
        self.assertEqual(missing["error"]["message"], "bibliometric.network requires parameters.maxNodes.")
        self.assertEqual(missing["error"]["stopReason"], "invalid_input")
        self.assertIn("nothing was started", missing["next_actions"][0])

    def test_a_failed_calculation_points_the_run_at_its_input_file(self):
        Gateway.answer = {"data": {"id": "calculation-job", "state": "failed", "error": {"code": "result_replay_failed"}}}
        result = self.server.call_tool("research_calculate", {"action": "status", "jobId": "calculation-job"})
        self.assertEqual(result["status"], "warning")
        self.assertEqual(result["data"]["error"]["code"], "result_replay_failed")
        self.assertIn("compare the input file with its method's shape", result["next_actions"][-1])
        Gateway.answer = {"data": {"id": "calculation-job", "state": "canceled"}}
        result = self.server.call_tool("research_calculate", {"action": "cancel", "jobId": "calculation-job"})
        self.assertEqual(result["next_actions"], ["Read the named failure and continue from preserved work."])

    def test_a_calculation_the_executor_declined_says_why_and_what_to_correct(self):
        # The control plane passes the executor's named refusal through as the job's error code; the run is told what
        # it means, and is not sent to compare its file with the method's shape when the executor already said what is wrong.
        for code, reason in research_calculate.REFUSAL_REASONS.items():
            with self.subTest(code=code):
                Gateway.answer = {"data": {"id": "calculation-job", "state": "failed", "error": {"code": code}}}
                result = self.server.call_tool("research_calculate", {"action": "status", "jobId": "calculation-job"})
                self.assertEqual(result["status"], "warning")
                self.assertEqual(result["warnings"][0], reason)
                self.assertIn("prior results remain available", result["warnings"][1])
                self.assertIn("Correct that one input", result["next_actions"][-1])
                self.assertNotIn("compare the input file", " ".join(result["next_actions"]))
        # A code it does not know is not given a sentence, and an unreadable input keeps the older hint.
        for code in ("replay_input_invalid", "replay_made_up", "result_replay_failed"):
            with self.subTest(code=code):
                Gateway.answer = {"data": {"id": "calculation-job", "state": "failed", "error": {"code": code}}}
                result = self.server.call_tool("research_calculate", {"action": "status", "jobId": "calculation-job"})
                self.assertEqual(len(result["warnings"]), 1)
                self.assertIn("compare the input file with its method's shape", result["next_actions"][-1])
        # A refusal is only a failed calculation's reason: a canceled one with the same code is just canceled.
        Gateway.answer = {"data": {"id": "calculation-job", "state": "canceled", "error": {"code": "replay_single_study"}}}
        result = self.server.call_tool("research_calculate", {"action": "status", "jobId": "calculation-job"})
        self.assertEqual(len(result["warnings"]), 1)

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

    def test_render_sends_the_two_paths_and_the_named_calculations_for_an_owned_turn(self):
        version = "rv_" + "a" * 64
        Gateway.answer = {"data": {"id": version, "state": "rendered", "unresolved": [{"path": "pool.nothing", "reason": "no_such_value"}], "unbound": []}}
        calculations = {"pool": {"jobId": "replay_" + "b" * 64}, "stat": {"resultsPath": "analysis-results.json", "receiptPath": "analysis-run.json"},
                        "earlier": {"versionId": version}}
        result = self.server.call_tool("research_calculate", {"action": "render", "templatePath": "reports/template.md",
                                                              "outputPath": "reports/report.md", "calculations": calculations,
                                                              "__evimed_execution_context": CONTEXT})
        self.assertEqual(result["status"], "success")
        self.assertIn("未计算", result["warnings"][0], "an unresolved reference is said, not hidden, and the report was still written")
        observed = Gateway.seen[0]
        self.assertEqual(observed["path"], "/internal/results/v1/render")
        self.assertEqual(observed["context"], CONTEXT)
        self.assertEqual(observed["body"], {"templatePath": "reports/template.md", "outputPath": "reports/report.md", "calculations": calculations})

    def test_render_refuses_what_cannot_be_an_operation_before_any_request_is_made(self):
        base = {"action": "render", "templatePath": "reports/template.md", "outputPath": "reports/report.md",
                "calculations": {"pool": {"versionId": "rv_" + "a" * 64}}, "__evimed_execution_context": CONTEXT}
        self.assertEqual(self.server.call_tool("research_calculate", {key: value for key, value in base.items() if key != "__evimed_execution_context"})
                         ["error"]["code"], "result_execution_context_unavailable")
        for changed in [{"templatePath": "../template.md"}, {"outputPath": "/etc/report.md"}, {"outputPath": "a\\b.md"}, {"calculations": {}},
                        {"calculations": {"1pool": {"versionId": "rv_" + "a" * 64}}}, {"calculations": {"pool": {"jobId": "not-a-job"}}},
                        {"calculations": {"pool": {"versionId": "rv_" + "a" * 64, "jobId": "replay_" + "b" * 64}}},
                        {"calculations": {"pool": {"receiptPath": "analysis-run.json"}}},
                        {"calculations": {"pool": {"resultsPath": "../../secret.json"}}},
                        {"calculations": {"a%d" % index: {"versionId": "rv_" + "a" * 64} for index in range(9)}}]:
            with self.subTest(changed=changed):
                result = self.server.call_tool("research_calculate", {**base, **changed})
                self.assertEqual(result["error"]["code"], "result_input_invalid")
        self.assertEqual(self.server.call_tool("research_calculate", {**base, "method": "meta.dl"})["status"], "error")
        self.assertEqual(Gateway.seen, [])


if __name__ == "__main__":
    unittest.main()
