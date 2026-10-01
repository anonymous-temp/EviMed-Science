"""「虚拟临研」's five runtime tools, against a scripted gateway, and through the
server's own `call_tool` -- the path a run takes (a module test that only calls
the module proves the module, not the tool)."""

import importlib.util
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import vcr_platform  # noqa: E402

OPEN_SCIENCE = ROOT.parents[2]


def load_server():
    spec = importlib.util.spec_from_file_location("evimed_research_mcp_vcr", ROOT / "server.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def domain_job_kinds():
    """The engine's job kinds as the domain publishes them: the one list the tool copies."""
    node = shutil.which("node")
    assert node, "node must be installed: the tool's copy of the job kinds is held equal to the domain's"
    out = subprocess.run(
        [node, "--input-type=module", "-e", "import('@evimed/domain').then((m) => console.log(JSON.stringify(m.VCR_JOB_KINDS)))"],
        cwd=OPEN_SCIENCE / "apps" / "server", capture_output=True, text=True, timeout=60, check=True,
    )
    return json.loads(out.stdout.strip().splitlines()[-1])


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
            "EVIMED_VCR_GATEWAY_URL": base + "/internal/vcr/v1",
            "EVIMED_PUBLIC_SOURCE_GATEWAY_URL": base + "/internal/sources/v1/fetch",
            "EVIMED_MODEL_GATEWAY_TOKEN_FILE": str(token_file),
            "EVIMED_DISABLED_TOOLS": "",
        }
        patcher = mock.patch.dict(os.environ, environment)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.server = load_server()


class VcrToolDefinitionTests(unittest.TestCase):
    def test_five_tools_with_closed_schemas(self):
        definitions = {tool["name"]: tool for tool in vcr_platform.tool_definitions()}
        self.assertEqual(set(definitions), {"vcr_read", "vcr_write", "vcr_simulate", "trial_registry_record", "evidence_pool"})
        for definition in definitions.values():
            schema = definition["inputSchema"]
            self.assertFalse(schema["additionalProperties"])
            self.assertEqual(schema["type"], "object")
            self.assertLess(len(definition["description"]), 2400, "a description rides every request of the run")
        self.assertEqual(definitions["vcr_read"]["inputSchema"]["properties"]["what"]["enum"], list(vcr_platform.READ_WHATS))
        self.assertEqual(definitions["vcr_write"]["inputSchema"]["properties"]["what"]["enum"], list(vcr_platform.WRITE_WHATS))

    def test_the_job_kinds_are_the_domain_s_twenty_four(self):
        kinds = domain_job_kinds()
        self.assertEqual(len(kinds), 24)
        self.assertEqual(list(vcr_platform.JOB_KINDS), kinds)
        simulate = {tool["name"]: tool for tool in vcr_platform.tool_definitions()}["vcr_simulate"]
        self.assertEqual(simulate["inputSchema"]["properties"]["kind"]["enum"], kinds)

    def test_simulate_states_the_scenario_shapes_and_points_at_the_skill(self):
        description = {tool["name"]: tool for tool in vcr_platform.tool_definitions()}["vcr_simulate"]["description"]
        for fragment in ("design_simulation", "truth.null", "accrual.dropoutAnnual", "kind:'snapshot'", "vcr-analysis skill", "refused by name"):
            self.assertIn(fragment, description)
        self.assertNotIn("isNull", description)
        self.assertNotIn("dropoutRate", description)

    def test_read_says_what_matching_returns(self):
        description = {tool["name"]: tool for tool in vcr_platform.tool_definitions()}["vcr_read"]["description"]
        self.assertIn("matching", description)
        self.assertIn("subjectKey", description)
        self.assertIn("pseudonym", description)

    def test_evidence_pool_names_a_parameter_and_never_takes_numbers(self):
        properties = {tool["name"]: tool for tool in vcr_platform.tool_definitions()}["evidence_pool"]["inputSchema"]["properties"]
        self.assertEqual(set(properties), {"action", "parameter", "endpointKey", "calibres", "method", "jobId"})
        self.assertNotIn("studies", properties)

    def test_the_response_cap_is_four_mebibytes(self):
        self.assertEqual(vcr_platform.MAX_RESPONSE_BYTES, 4 * 1024 * 1024)

    def test_without_a_route_every_tool_says_there_is_no_study_data_without_asking(self):
        # The module off, or not open to this account: the tool worked, there is simply nothing to read,
        # said as a warning the run goes on from -- and no request is made.
        with mock.patch.dict(os.environ, {"EVIMED_VCR_GATEWAY_URL": ""}):
            for call in (
                lambda: vcr_platform.read({"what": "study"}),
                lambda: vcr_platform.write({"what": "step", "data": {"step": "evidence", "requested": True}}),
                lambda: vcr_platform.simulate({"action": "start", "kind": "design_analytic", "scenario": {}}),
                lambda: vcr_platform.registry_record({"registryId": "NCT01234567"}),
                lambda: vcr_platform.evidence_pool({"action": "start", "parameter": "hazard_ratio", "endpointKey": "os"}),
            ):
                result = call()
                self.assertEqual(result["status"], "warning")
                self.assertEqual(result["data"]["code"], "vcr_disabled")
                self.assertIn("Go on without", " ".join(result["next_actions"]))


class VcrReadWriteTests(_GatewayCase):
    def test_a_read_posts_the_what_and_filter_with_the_runtime_token_through_call_tool(self):
        _Gateway.answers["read"] = (200, {"data": {"what": "matching", "subjects": [{"subjectKey": "s_ab12", "summary": "eligible"}], "more": True}})
        result = self.server.call_tool("vcr_read", {"what": "matching", "filter": {"subjectKey": "s_ab12", "limit": 10}})
        self.assertEqual(result["status"], "warning")
        self.assertTrue(any("offset" in action for action in result["next_actions"]))
        [seen] = _Gateway.seen
        self.assertEqual(seen["path"], "/internal/vcr/v1/read")
        self.assertEqual(seen["authorization"], "Bearer runtime-token-for-tests")
        self.assertEqual(seen["body"], {"what": "matching", "filter": {"subjectKey": "s_ab12", "limit": 10}})

    def test_the_documents_and_sources_filters_reach_the_gateway(self):
        _Gateway.answers["read"] = (200, {"data": {"what": "subject_document", "text": "…"}})
        self.server.call_tool("vcr_read", {"what": "subject_document", "filter": {"subjectKey": "s_ab12", "documentId": "doc_1"}})
        self.assertEqual(_Gateway.seen[0]["body"]["filter"], {"subjectKey": "s_ab12", "documentId": "doc_1"})

    def test_a_part_of_the_platform_that_is_not_composed_is_named_and_only_that_step_is_affected(self):
        _Gateway.answers["read"] = (200, {"data": {"what": "precedents", "available": False, "message": "证据检索未接入。"}})
        result = self.server.call_tool("vcr_read", {"what": "precedents"})
        self.assertEqual(result["status"], "warning")
        self.assertIn("证据检索未接入。", result["warnings"])

    def test_the_gateway_s_own_codes_reach_the_run_and_nothing_else_does(self):
        _Gateway.answers["read"] = (429, {"error": "Too many 虚拟临研 calls in a minute.", "code": "vcr_gateway_rate_limited"})
        result = self.server.call_tool("vcr_read", {"what": "study"})
        self.assertEqual(result["error"]["code"], "vcr_gateway_rate_limited")
        self.assertTrue(result["error"]["retryable"])
        self.assertEqual(result["error"]["stopReason"], "retry")
        _Gateway.answers["read"] = (502, {"error": "bad gateway", "code": "proxy_exploded"})
        result = self.server.call_tool("vcr_read", {"what": "study"})
        self.assertEqual(result["error"]["code"], "vcr_upstream_error")
        self.assertTrue(result["error"]["retryable"])

    def test_a_credential_refusal_is_not_the_run_getting_a_field_wrong(self):
        # `vcr_gateway_token_invalid` ends in `_invalid` like a malformed field does; the run cannot fix it by changing the call.
        _Gateway.answers["read"] = (401, {"error": "虚拟临研 gateway authentication failed.", "code": "vcr_gateway_token_invalid"})
        result = self.server.call_tool("vcr_read", {"what": "study"})
        self.assertEqual(result["error"]["code"], "vcr_gateway_token_invalid")
        self.assertNotEqual(result["error"]["stopReason"], "invalid_input")
        self.assertEqual(result["error"]["stopReason"], "unsupported")
        self.assertNotIn("Correct the named field", " ".join(result["next_actions"]))
        # A field the run did get wrong still is.
        _Gateway.answers["read"] = (400, {"error": "filter takes only: kind.", "code": "vcr_read_filter_invalid"})
        wrong = self.server.call_tool("vcr_read", {"what": "study"})
        self.assertEqual(wrong["error"]["stopReason"], "invalid_input")

    def test_outside_a_study_a_read_or_write_is_a_warning_that_names_why(self):
        _Gateway.answers["read"] = (404, {"error": "This conversation is not in a 虚拟临研 study.", "code": "vcr_no_study"})
        _Gateway.answers["write"] = (404, {"error": "This conversation is not in a 虚拟临研 study.", "code": "vcr_no_study"})
        read = self.server.call_tool("vcr_read", {"what": "assumptions"})
        self.assertEqual(read["status"], "warning")
        self.assertEqual(read["data"]["code"], "vcr_no_study")
        write = self.server.call_tool("vcr_write", {"what": "assumption", "items": [{"key": "hazard_ratio"}]})
        self.assertEqual(write["status"], "warning")
        self.assertIn("no assumption to write", write["summary"])

    def test_a_what_outside_the_vocabulary_never_leaves_the_runtime(self):
        result = self.server.call_tool("vcr_read", {"what": "passwords"})
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["error"]["code"], "invalid_input")
        self.assertEqual(_Gateway.seen, [])

    def test_a_partly_refused_write_names_each_refused_item_and_items_with_data_is_refused_early(self):
        _Gateway.answers["write"] = (200, {"data": {"what": "assumption", "ok": True, "ids": ["asm_1"], "issues": [
            {"index": 1, "field": "key", "code": "vcr_write_value_invalid", "message": "key is a lowercase name."}]}})
        result = self.server.call_tool("vcr_write", {"what": "assumption", "items": [{"key": "hazard_ratio"}, {"key": "Bad Key"}]})
        self.assertEqual(result["status"], "warning")
        self.assertIn("1 written, 1 refused", result["summary"])
        self.assertEqual(result["warnings"], ["item 1, key: key is a lowercase name."])
        with self.assertRaises(vcr_platform.VcrPlatformError) as caught:
            vcr_platform.write({"what": "assumption", "items": [{}], "data": {}})
        self.assertEqual(caught.exception.code, "vcr_write_payload_invalid")
        self.assertEqual(len(_Gateway.seen), 1)

    def test_an_answer_over_the_cap_is_refused_by_name(self):
        _Gateway.answers["read"] = (200, b'{"data": {"pad": "' + b"x" * (vcr_platform.MAX_RESPONSE_BYTES + 10) + b'"}}')
        result = self.server.call_tool("vcr_read", {"what": "results"})
        self.assertEqual(result["error"]["code"], "vcr_response_too_large")


class VcrSimulateTests(_GatewayCase):
    def test_a_start_posts_exactly_the_frozen_scenario_and_answers_the_job(self):
        scenario = {"design": {"kind": "two_arm_fixed", "nTreat": 120, "nControl": 60}, "endpoint": {"type": "time_to_event"},
                    "truth": {"hazardRatio": 0.7, "controlMedian": 6, "null": False}, "analysis": {"method": "logrank", "alpha": 0.025, "sided": 1}}
        _Gateway.answers["simulate"] = (200, {"data": {"action": "start", "jobId": "job_1", "state": "queued", "progress": {}}})
        result = self.server.call_tool("vcr_simulate", {"action": "start", "kind": "design_simulation", "scenario": scenario, "subjectId": "scn_1"})
        self.assertEqual(result["status"], "success")
        self.assertIn("job_1 is queued", result["summary"])
        self.assertEqual(_Gateway.seen[0]["path"], "/internal/vcr/v1/simulate")
        self.assertEqual(_Gateway.seen[0]["body"], {"action": "start", "kind": "design_simulation", "scenario": scenario, "subjectId": "scn_1"})

    def test_all_twenty_four_kinds_pass_the_runtime_check_and_others_never_leave_it(self):
        _Gateway.answers["simulate"] = (200, {"data": {"action": "start", "jobId": "job_1", "state": "queued"}})
        for kind in vcr_platform.JOB_KINDS:
            self.server.call_tool("vcr_simulate", {"action": "start", "kind": kind, "scenario": {}})
        self.assertEqual([seen["body"]["kind"] for seen in _Gateway.seen], list(vcr_platform.JOB_KINDS))
        before = len(_Gateway.seen)
        result = self.server.call_tool("vcr_simulate", {"action": "start", "kind": "make_it_up"})
        self.assertEqual(result["error"]["code"], "invalid_input")
        self.assertEqual(len(_Gateway.seen), before)

    def test_a_job_over_the_budget_is_a_warning_the_run_goes_on_from(self):
        _Gateway.answers["simulate"] = (200, {"data": {"action": "start", "jobId": "job_2", "state": "awaiting_budget", "awaitingBudget": True,
                                                       "message": "这项计算超出研究的计算预算，已停在确认处。"}})
        result = self.server.call_tool("vcr_simulate", {"action": "start", "kind": "design_grid", "scenario": {}})
        self.assertEqual(result["status"], "warning")
        self.assertIn("waiting for the study's compute budget", result["summary"])
        self.assertIn("这项计算超出研究的计算预算，已停在确认处。", result["warnings"])

    def test_a_failed_job_keeps_what_it_computed_and_never_a_zero(self):
        _Gateway.answers["simulate"] = (200, {"data": {"action": "status", "jobId": "job_3", "state": "failed",
                                                       "error": {"code": "cpu_budget_exhausted", "message": "The CPU budget ran out.", "partial": True}}})
        result = self.server.call_tool("vcr_simulate", {"action": "status", "jobId": "job_3"})
        self.assertEqual(result["status"], "warning")
        self.assertIn("kept its completed batches", result["summary"])
        self.assertTrue(any("never write a zero" in action for action in result["next_actions"]))

    def test_status_and_cancel_need_the_job_id_the_start_answered_with(self):
        with self.assertRaises(vcr_platform.VcrPlatformError) as caught:
            vcr_platform.simulate({"action": "status"})
        self.assertEqual(caught.exception.code, "vcr_simulate_payload_invalid")
        self.assertEqual(_Gateway.seen, [])
        _Gateway.answers["simulate"] = (200, {"data": {"action": "cancel", "jobId": "job_4", "state": "canceled", "canceled": True}})
        cancelled = self.server.call_tool("vcr_simulate", {"action": "cancel", "jobId": "job_4"})
        self.assertEqual(cancelled["status"], "warning")
        self.assertEqual(_Gateway.seen[0]["body"], {"action": "cancel", "jobId": "job_4"})


class EvidencePoolTests(_GatewayCase):
    def test_start_names_the_parameter_and_the_endpoint_and_carries_no_numbers(self):
        _Gateway.answers["simulate"] = (200, {"data": {"action": "start", "jobId": "job_5", "state": "queued", "jobs": [{"calibre": "overall", "jobId": "job_5"}]}})
        result = self.server.call_tool("evidence_pool", {"action": "start", "parameter": "hazard_ratio", "endpointKey": "os",
                                                         "calibres": ["overall", "closest"], "method": "random_effects_reml"})
        self.assertEqual(result["status"], "success")
        [seen] = _Gateway.seen
        self.assertEqual(seen["path"], "/internal/vcr/v1/simulate")
        self.assertEqual(seen["body"], {"action": "start", "kind": "pool_evidence", "subjectId": "hazard_ratio",
                                        "scenario": {"parameter": "hazard_ratio", "endpointKey": "os", "calibres": ["overall", "closest"],
                                                     "method": "random_effects_reml"}})

    def test_the_old_shape_with_the_model_s_own_numbers_is_refused_before_a_request(self):
        result = self.server.call_tool("evidence_pool", {"action": "start", "parameter": "hazard_ratio", "endpointKey": "os",
                                                         "studies": [{"sourceRef": "a", "estimate": 0.7}]})
        self.assertEqual(result["error"]["code"], "invalid_input")
        self.assertEqual(_Gateway.seen, [])
        with self.assertRaises(vcr_platform.VcrPlatformError) as caught:
            vcr_platform.evidence_pool({"action": "start", "parameter": "hazard_ratio"})
        self.assertEqual(caught.exception.code, "vcr_simulate_payload_invalid")
        self.assertIn("endpointKey", str(caught.exception))
        self.assertEqual(_Gateway.seen, [])

    def test_a_pool_that_could_not_start_says_why_and_status_reads_the_job(self):
        _Gateway.answers["simulate"] = (200, {"data": {"action": "start", "state": "not_started", "reason": "no_evidence",
                                                       "message": "没有通过核对的抽取值。", "jobs": []}})
        result = self.server.call_tool("evidence_pool", {"action": "start", "parameter": "dropout_rate", "endpointKey": "os"})
        self.assertEqual(result["status"], "warning")
        self.assertIn("no_evidence", result["summary"])
        self.assertIn("没有通过核对的抽取值。", result["warnings"])
        _Gateway.answers["simulate"] = (200, {"data": {"action": "status", "jobId": "job_6", "state": "succeeded",
                                                       "pooling": {"pooled": 0.71, "predictionInterval": [0.52, 0.97]}}})
        status = self.server.call_tool("evidence_pool", {"action": "status", "jobId": "job_6"})
        self.assertEqual(status["status"], "success")
        self.assertEqual(_Gateway.seen[-1]["body"], {"action": "status", "jobId": "job_6"})


class RegistryRecordTests(_GatewayCase):
    def test_a_record_is_a_success_and_asks_for_the_registry_by_id(self):
        _Gateway.answers["read"] = (200, {"data": {"record": {"registryId": "NCT01234567", "arms": []}}})
        result = self.server.call_tool("trial_registry_record", {"registryId": "NCT01234567", "registry": "ctgov"})
        self.assertEqual(result["status"], "success")
        self.assertEqual(_Gateway.seen[0]["body"], {"what": "trial_registry_record", "filter": {"registryId": "NCT01234567", "registry": "ctgov"}})

    def test_no_registry_status_and_no_unavailable_channel_is_ever_a_success(self):
        for answer in (
            {"available": False, "code": "registry_unavailable", "message": "试验登记检索未接入。"},
            {"available": False, "code": "registry_not_configured"},
            {"status": "registry_unavailable", "message": "The registry did not answer."},
            {"status": "registry_answer_unreadable"},
            {"code": "registry_record_unreadable"},
        ):
            _Gateway.answers["read"] = (200, {"data": answer})
            result = self.server.call_tool("trial_registry_record", {"registryId": "NCT01234567"})
            self.assertEqual(result["status"], "warning", answer)
            self.assertNotEqual(result["status"], "success")
            self.assertTrue(result["warnings"])

    def test_a_record_that_is_not_there_is_not_a_trial_that_did_not_happen(self):
        _Gateway.answers["read"] = (200, {"data": {"status": "registry_not_found", "message": "No such record."}})
        result = self.server.call_tool("trial_registry_record", {"registryId": "NCT00000000"})
        self.assertEqual(result["status"], "warning")
        self.assertIn("no record NCT00000000", result["summary"])
        self.assertTrue(any("did not happen" in action for action in result["next_actions"]))

    def test_an_answer_with_no_record_is_a_warning_and_a_gateway_registry_error_reaches_the_run(self):
        _Gateway.answers["read"] = (200, {"data": {}})
        self.assertEqual(self.server.call_tool("trial_registry_record", {"registryId": "NCT01234567"})["status"], "warning")
        _Gateway.answers["read"] = (503, {"error": "The registry is not configured.", "code": "registry_not_configured"})
        result = self.server.call_tool("trial_registry_record", {"registryId": "NCT01234567"})
        self.assertEqual(result["error"]["code"], "registry_not_configured")


if __name__ == "__main__":
    unittest.main()
