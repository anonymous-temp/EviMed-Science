"""「虚拟临床研究」's six runtime tools, against a scripted gateway, and through the
server's own `call_tool` -- the path a run takes (a module test that only calls
the module proves the module, not the tool)."""

import importlib.util
import json
import os
import pathlib
import re
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


def domain_scenario_keys():
    """What each job kind's scenario may carry, read off the domain's own schemas
    (`VCR_SCENARIO_SCHEMAS`, the list the queue and the engine both validate
    against): per kind its method, the endpoint types that method implements, and
    per top-level key the endpoint types it is read for (``None`` for a method
    with no endpoint) and the names under it. A gate on anything but
    ``endpoint.type`` is a choice the scenario makes, so it does not narrow."""
    node = shutil.which("node")
    assert node, "node must be installed: the tool's scenario shapes are held to the domain's schemas"
    script = """
import('@evimed/domain').then((m) => {
  const gates = (when) => (Array.isArray(when) ? when : when ? [when] : []);
  const readFor = (when, endpoints) => endpoints.filter((type) => gates(when)
    .every((gate) => gate.path !== 'endpoint.type' || m.whenHolds(gate, { endpoint: { type } })));
  const under = (fields) => Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, names(field)]));
  const names = (node) => node.t === 'object' ? under(node.fields)
    : node.t === 'variant' ? Object.assign({ [node.on]: null }, ...Object.values(node.variants).map(under))
      : node.t === 'array' ? names(node.items) : null;
  const out = {};
  for (const [kind, method] of Object.entries(m.VCR_JOB_METHODS)) {
    const endpoints = [...m.VCR_ENGINE_METHODS[method].endpoints];
    out[kind] = { method, endpoints, keys: Object.fromEntries(Object.entries(m.VCR_SCENARIO_SCHEMAS[method].fields)
      .map(([key, field]) => [key, { endpoints: endpoints.length ? readFor(field.when, endpoints) : null, children: names(field) }])) };
  }
  console.log(JSON.stringify(out));
})
"""
    out = subprocess.run([node, "--input-type=module", "-e", script], cwd=OPEN_SCIENCE / "apps" / "server",
                         capture_output=True, text=True, timeout=60, check=True)
    return json.loads(out.stdout.strip().splitlines()[-1])


def domain_paths():
    """Every dotted key path each job kind's scenario may carry, from the validator's own schemas: an oracle that does not read the
    generated help. A list's items and a variant's members are paths like any other (``[]`` is not part of a name here)."""
    paths = {}

    def walk(children, prefix, out):
        for key, below in children.items():
            out.add(prefix + key)
            if isinstance(below, dict):
                walk(below, prefix + key + ".", out)

    for kind, entry in domain_scenario_keys().items():
        out = set()
        for key, field in entry["keys"].items():
            out.add(key)
            if isinstance(field["children"], dict):
                walk(field["children"], key + ".", out)
        paths[kind] = out
    return paths


class _Gateway(BaseHTTPRequestHandler):
    """The server's routes, scripted per operation: it records what the
    runtime sent and answers whatever the test put on the class."""

    answers = {}
    seen = []

    def do_POST(self):  # noqa: N802 - http.server naming
        body = self.rfile.read(int(self.headers.get("content-length") or 0))
        type(self).seen.append({"path": self.path, "authorization": self.headers.get("authorization"), "body": json.loads(body)})
        operation = self.path.rsplit("/", 1)[-1]
        answer = type(self).answers.get(operation, (404, {"error": "Not found.", "code": "not_found"}))
        # A list is a scripted sequence: each request takes the next answer, and the last one stays.
        if isinstance(answer, list):
            answer = answer.pop(0) if len(answer) > 1 else answer[0]
        status, payload = answer
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
            # A queued job is not waited for in these tests (the wait has its own, with a clock that does not sleep).
            vcr_platform.STATUS_WAIT_ENV: "0",
        }
        patcher = mock.patch.dict(os.environ, environment)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.server = load_server()


class VcrToolDefinitionTests(unittest.TestCase):
    def test_six_tools_with_closed_schemas(self):
        definitions = {tool["name"]: tool for tool in vcr_platform.tool_definitions()}
        self.assertEqual(set(definitions), {"vcr_read", "vcr_write", "vcr_simulate", "trial_registry_record", "curve_digitize", "evidence_pool"})
        for definition in definitions.values():
            schema = definition["inputSchema"]
            self.assertFalse(schema["additionalProperties"])
            self.assertEqual(schema["type"], "object")
            self.assertLess(len(definition["description"]), 2400, "a description rides every request of the run")
        self.assertEqual(definitions["vcr_read"]["inputSchema"]["properties"]["what"]["enum"], list(vcr_platform.READ_WHATS))
        self.assertEqual(definitions["vcr_write"]["inputSchema"]["properties"]["what"]["enum"], list(vcr_platform.WRITE_WHATS))

    def test_the_job_kinds_are_the_domain_s(self):
        kinds = domain_job_kinds()
        self.assertGreaterEqual(len(kinds), 24, "the first release's twenty-four, then the kinds appended after them")
        self.assertEqual(list(vcr_platform.JOB_KINDS), kinds)
        simulate = {tool["name"]: tool for tool in vcr_platform.tool_definitions()}["vcr_simulate"]
        self.assertEqual(simulate["inputSchema"]["properties"]["kind"]["enum"], kinds)

    def test_simulate_description_is_short_and_sends_the_run_to_the_shape_action_instead_of_typing_the_shapes(self):
        # A description rides every request of the run; the per-method shapes are served on demand from the generated help.
        description = {tool["name"]: tool for tool in vcr_platform.tool_definitions()}["vcr_simulate"]["description"]
        self.assertLess(len(description), 1700, "the shapes live in the shape action, not here")
        for fragment in ("action shape", "never guess a key", "refused by the field's path", "kind:'snapshot'", "vcr-analysis skill"):
            self.assertIn(fragment, description)
        for typed in ("accrual?", "dropoutAnnual", "design_simulation {", "truth{", "[time_to_event]", "isNull", "dropoutRate"):
            self.assertNotIn(typed, description, "a hand-typed shape is what drifted")
        self.assertIn("shape", vcr_platform.SIMULATE_ACTIONS)
        simulate = {tool["name"]: tool for tool in vcr_platform.tool_definitions()}["vcr_simulate"]
        self.assertEqual(simulate["inputSchema"]["properties"]["action"]["enum"], list(vcr_platform.SIMULATE_ACTIONS))
        self.assertEqual(simulate["inputSchema"]["required"], ["action"], "a shape call needs no scenario")

    def test_write_points_at_the_shape_action_and_names_real_kinds(self):
        description = {tool["name"]: tool for tool in vcr_platform.tool_definitions()}["vcr_write"]["description"]
        self.assertIn("action shape", description)
        for kind in ("design_analytic", "design_simulation", "generate_patients", "generate_patients_continuous", "generate_patients_binary", "generate_population"):
            self.assertIn(kind, description)
            self.assertIn(kind, vcr_platform.JOB_KINDS)
        for name, kinds in vcr_platform.OBJECT_SHAPES.items():
            self.assertTrue(set(kinds) <= set(vcr_platform.JOB_KINDS), "%s: %s" % (name, sorted(set(kinds) - set(vcr_platform.JOB_KINDS))))

    def test_the_help_file_says_every_key_the_validator_reads_and_none_it_refuses(self):
        # The oracle is the validator's own schema, read by Node; the subject is the file the tool renders. The domain's own test holds
        # the file's gates to the validator on probes (`packages/domain/test/vcrScenarioHelp.test.mjs`); this one holds the rendering to both.
        oracle = domain_paths()
        help_ = vcr_platform.scenario_help()
        self.assertEqual(set(help_["kinds"]), set(vcr_platform.JOB_KINDS))
        self.assertGreaterEqual(len(oracle), 24)
        walked = 0
        for kind in vcr_platform.JOB_KINDS:
            answer = vcr_platform.shape({"kind": kind})["data"]
            if answer.get("builtByPlatform"):
                continue
            lines = answer["keys"]
            rendered = {line.split(":", 1)[0].replace("[]", "") for line in lines}
            self.assertEqual(rendered, oracle[kind], kind)
            walked += len(rendered)
            for guess in ("accrual.months", "accrual.rate", "dropoutRate", "truth.isNull", "enrolment"):
                self.assertNotIn(guess, rendered, kind)
                self.assertFalse(any(line.startswith(guess + ":") for line in lines), kind)
        self.assertGreater(walked, 500, "the walk proves it walked")

    def test_shape_renders_accrual_with_its_real_keys_units_and_gate(self):
        answer = vcr_platform.shape({"kind": "design_analytic"})
        self.assertEqual(answer["status"], "success")
        data = answer["data"]
        self.assertEqual((data["kind"], data["method"]), ("design_analytic", "design.analytic"))
        lines = {line.split(":", 1)[0]: line for line in data["keys"]}
        self.assertEqual(lines["accrual.duration"], "accrual.duration: number >=0 (time units); required once accrual is given")
        self.assertIn("accrual.followup: number >=0 (time units)", lines["accrual.followup"])
        self.assertIn("number >=0 <1 (proportion per 12 time units); optional; default 0", lines["accrual.dropoutAnnual"])
        self.assertEqual(lines["accrual"], "accrual: object; optional; read only when endpoint.type is time_to_event")
        self.assertNotIn("read only when", lines["accrual.duration"], "a key inside accrual does not repeat accrual's own gate")
        self.assertIn("exactly one of truth.treatmentRate, truth.riskDifference, truth.oddsRatio", " ".join(data["rules"]))
        self.assertTrue(any("design_not_supported" in note for note in data["notes"]))
        # One valid example, and it is the one the domain checked.
        example = data["examples"][0]
        self.assertEqual(example["scenario"]["accrual"], {"duration": 12, "followup": 12, "dropoutAnnual": 0.05})
        self.assertIn("A key not listed is refused by its path", data["legend"])
        # The simulated generators read a variant: uniform or piecewise accrual.
        simulated = {line.split(":", 1)[0]: line for line in vcr_platform.shape({"kind": "design_simulation"})["data"]["keys"]}
        self.assertIn("one of uniform|piecewise; optional; default \"uniform\"", simulated["accrual.kind"])
        self.assertIn("read only when accrual.kind is piecewise", simulated["accrual.breaks"])
        self.assertNotIn("accrual.kind is", simulated["accrual.followup"], "shared by both variants")

    def test_shape_with_no_kind_lists_the_kinds_and_where_each_object_looks_its_shape_up(self):
        answer = vcr_platform.shape({})
        kinds = answer["data"]["kinds"]
        self.assertEqual(list(kinds), list(vcr_platform.JOB_KINDS))
        self.assertEqual(kinds["design_analytic"], "design.analytic (continuous|binary|time_to_event)")
        self.assertEqual(kinds["generate_patients"], "patients.time_to_event (time_to_event)")
        self.assertEqual(kinds["profile_snapshot"], "profile.snapshot")
        self.assertEqual(answer["data"]["objects"]["trial_scenario (configuration)"], ["design_analytic", "design_simulation"])

    def test_the_kinds_the_platform_builds_say_what_a_run_states_and_where_the_rest_comes_from(self):
        pool = vcr_platform.shape({"kind": "pool_evidence"})["data"]
        self.assertTrue(pool["builtByPlatform"])
        self.assertEqual(pool["runStates"], ["parameter", "endpointKey", "calibres", "armRole", "target", "method"])
        self.assertTrue(any("evidence_pool" in note for note in pool["notes"]))
        self.assertNotIn("examples", pool)
        match = vcr_platform.shape({"kind": "match_criteria"})["data"]
        self.assertEqual((match["runStates"], match["keys"]), ([], []))
        self.assertTrue(any("empty scenario" in note for note in match["notes"]))
        accrual = vcr_platform.shape({"kind": "accrual_forecast"})["data"]
        self.assertEqual(accrual["runStates"], ["target", "eventTarget", "eventHazard", "byTimes"])
        self.assertEqual([line.split(":", 1)[0] for line in accrual["keys"]], ["target", "eventTarget", "eventHazard", "byTimes"])

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
        _Gateway.answers["read"] = (429, {"error": "Too many 虚拟临床研究 calls in a minute.", "code": "vcr_gateway_rate_limited"})
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
        _Gateway.answers["read"] = (401, {"error": "虚拟临床研究 gateway authentication failed.", "code": "vcr_gateway_token_invalid"})
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
        _Gateway.answers["read"] = (404, {"error": "This conversation is not in a 虚拟临床研究 study.", "code": "vcr_no_study"})
        _Gateway.answers["write"] = (404, {"error": "This conversation is not in a 虚拟临床研究 study.", "code": "vcr_no_study"})
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

    def test_shape_answers_through_the_tool_without_asking_the_platform_and_with_the_module_off(self):
        result = self.server.call_tool("vcr_simulate", {"action": "shape", "kind": "design_simulation"})
        self.assertEqual(result["status"], "success")
        self.assertIn("reads", result["summary"])
        self.assertEqual(_Gateway.seen, [], "the shape is served from the file this build ships")
        with mock.patch.dict(os.environ, {"EVIMED_VCR_GATEWAY_URL": ""}):
            off = self.server.call_tool("vcr_simulate", {"action": "shape", "kind": "design_analytic"})
        self.assertEqual(off["status"], "success", "writing from a shape needs no study")
        self.assertTrue(off["data"]["keys"])
        bad = self.server.call_tool("vcr_simulate", {"action": "shape", "kind": "make_it_up"})
        self.assertEqual(bad["error"]["code"], "invalid_input")

    def test_a_build_without_the_help_says_so_by_name_and_the_run_goes_on(self):
        with mock.patch.object(vcr_platform, "HELP_FILE", os.path.join(tempfile.gettempdir(), "vcr-help-that-is-not-there.json")):
            vcr_platform._HELP.clear()
            try:
                result = self.server.call_tool("vcr_simulate", {"action": "shape", "kind": "design_analytic"})
                self.assertEqual(result["error"]["code"], "vcr_scenario_help_unavailable")
                self.assertFalse(result["error"].get("retryable", False))
                # A refused job still says what it was refused for; only the keys are missing.
                _Gateway.answers["simulate"] = (400, {"error": "作业不符合引擎协议：scenario.accrual.months（scenario_field_unknown）。", "code": "vcr_request_invalid",
                                                      "issues": [{"code": "scenario_field_unknown", "field": "scenario.accrual.months"}]})
                refused = self.server.call_tool("vcr_simulate", {"action": "start", "kind": "design_analytic", "scenario": {"accrual": {"months": 24}}})
                self.assertEqual(refused["error"]["code"], "vcr_request_invalid")
                self.assertIn("accrual.months", refused["error"]["message"])
            finally:
                vcr_platform._HELP.clear()

    def test_a_refused_scenario_carries_the_keys_of_the_place_it_was_refused(self):
        # What the pilot's run was told on 2026-10-04 named the path; what it needed beside it was what is read there.
        _Gateway.answers["simulate"] = (400, {"error": "作业不符合引擎协议：scenario.accrual.months（scenario_field_unknown）。", "code": "vcr_request_invalid",
                                              "issues": [{"code": "scenario_field_unknown", "field": "scenario.accrual.months"}]})
        result = self.server.call_tool("vcr_simulate", {"action": "start", "kind": "design_analytic",
                                                        "scenario": {"endpoint": {"type": "time_to_event"}, "accrual": {"months": 24}}})
        message = result["error"]["message"]
        self.assertEqual(result["error"]["code"], "vcr_request_invalid")
        self.assertIn("scenario.accrual.months", message, "the platform's own sentence is kept")
        self.assertIn("inside accrual the engine reads: duration, followup, dropoutAnnual", message)
        self.assertIn("vcr_simulate action shape, kind design_analytic", message)
        self.assertNotIn("months,", message.split("inside accrual", 1)[1], "the guess is not listed among what is read")
        # A key at the top of the scenario is answered with the scenario's own keys, gated ones tagged by the endpoint that reads them.
        _Gateway.answers["simulate"] = (400, {"error": "作业不符合引擎协议：scenario.covarites（scenario_field_unknown）。", "code": "vcr_request_invalid",
                                              "issues": [{"code": "scenario_field_unknown", "field": "scenario.covarites"}]})
        top = self.server.call_tool("vcr_simulate", {"action": "start", "kind": "weight_comparator", "scenario": {"covarites": ["age"]}})
        self.assertIn("inside the scenario the engine reads: covariates", top["error"]["message"])
        self.assertIn("tau[time_to_event]", top["error"]["message"])
        # A value out of range and a missing key are answered with the row itself: its type, unit and range.
        _Gateway.answers["simulate"] = (400, {"error": "作业不符合引擎协议：x。", "code": "vcr_request_invalid", "issues": [
            {"code": "scenario_value_invalid", "field": "scenario.accrual.dropoutAnnual"}, {"code": "scenario_field_missing", "field": "scenario.accrual.duration"},
            {"code": "design_not_supported", "field": "scenario.design.kind"}]})
        rows = self.server.call_tool("vcr_simulate", {"action": "start", "kind": "design_analytic", "scenario": {}})["error"]["message"]
        self.assertIn("accrual.dropoutAnnual: number >=0 <1 (proportion per 12 time units); optional; default 0", rows)
        self.assertIn("accrual.duration: number >=0 (time units); required once accrual is given", rows)
        self.assertIn("design.kind × endpoint.type this method implements", rows)

    def test_the_generators_answer_a_refusal_in_their_own_code_and_carry_the_keys_too(self):
        _Gateway.answers["simulate"] = (400, {"error": "作业不符合引擎协议：scenario.accrual.months（scenario_field_unknown）。", "code": "vcr_simulate_payload_invalid",
                                              "issues": [{"code": "scenario_field_unknown", "field": "scenario.accrual.months"}],
                                              "alternatives": [{"kind": "reference_scenario", "label": "x"}]})
        result = self.server.call_tool("vcr_simulate", {"action": "start", "kind": "generate_patients",
                                                        "scenario": {"endpoint": {"type": "time_to_event"}, "accrual": {"months": 24}}})
        self.assertEqual(result["error"]["code"], "vcr_simulate_payload_invalid")
        self.assertIn("inside accrual the engine reads: kind, duration[uniform], followup, dropoutAnnual, maxFollowup, breaks[piecewise], rates[piecewise], tail[piecewise]", result["error"]["message"])

    def test_a_refusal_without_findings_or_for_a_kind_the_platform_builds_is_passed_on_as_it_came(self):
        _Gateway.answers["simulate"] = (400, {"error": "合并只写 parameter、endpointKey：要合并的值来自本研究已通过核对的抽取值，不要自己带数。", "code": "vcr_simulate_payload_invalid"})
        plain = self.server.call_tool("vcr_simulate", {"action": "start", "kind": "pool_evidence", "scenario": {"studies": []}})
        self.assertEqual(plain["error"]["message"], "合并只写 parameter、endpointKey：要合并的值来自本研究已通过核对的抽取值，不要自己带数。")
        _Gateway.answers["simulate"] = (400, {"error": "x", "code": "vcr_request_invalid", "issues": [{"code": "scenario_field_unknown", "field": "scenario.studies"}]})
        built = self.server.call_tool("vcr_simulate", {"action": "start", "kind": "pool_evidence", "scenario": {"studies": []}})
        self.assertNotIn("the engine reads", built["error"]["message"], "the run states other keys for a kind the platform builds")
        # Findings the tool cannot trust are dropped, never rendered.
        self.assertEqual(vcr_platform._field_issues([{"code": "Bad Code", "field": "x"}, {"code": "ok_code", "field": ""}, {"code": "ok_code"}, "text", None]), [])
        self.assertEqual(vcr_platform._field_issues({"code": "ok_code", "field": "x"}), [])
        self.assertEqual(len(vcr_platform._field_issues([{"code": "ok_code", "field": "a%d" % i} for i in range(40)])), 20)

    def test_all_kinds_pass_the_runtime_check_and_others_never_leave_it(self):
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
        # a run must not sit polling a job only a person can release
        self.assertTrue(any("do not poll" in action and "researcher" in action for action in result["next_actions"]))
        self.assertTrue(any("report" in action for action in result["next_actions"]))

    def test_status_of_a_job_that_waits_for_a_person_says_the_same(self):
        _Gateway.answers["simulate"] = (200, {"data": {"action": "status", "jobId": "job_2", "state": "awaiting_budget", "awaitingBudget": True,
                                                       "message": "只有研究者确认后才会继续。"}})
        result = self.server.call_tool("vcr_simulate", {"action": "status", "jobId": "job_2"})
        self.assertEqual(result["status"], "warning")
        self.assertIn("waiting for the study's compute budget", result["summary"])
        self.assertTrue(any("do not poll" in action for action in result["next_actions"]))

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


class _Clock:
    """A clock that only moves when the code under test sleeps: the wait is measured without taking any time."""

    def __init__(self):
        self.now = 1000.0
        self.slept = []

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.slept.append(seconds)
        self.now += seconds


class VcrJobWaitTests(_GatewayCase):
    """What a queued job's answer tells the run, and how long the tool itself waits for it (`vcr_platform._wait_for_job`)."""

    def setUp(self):
        super().setUp()
        self.clock = _Clock()
        for target, replacement in (("_clock", self.clock.monotonic), ("_sleep", self.clock.sleep)):
            patcher = mock.patch.object(vcr_platform, target, replacement)
            patcher.start()
            self.addCleanup(patcher.stop)

    def start(self, **extra):
        return self.server.call_tool("vcr_simulate", {"action": "start", "kind": "design_simulation", "scenario": {}, **extra})

    def wait_for(self, seconds):
        patcher = mock.patch.dict(os.environ, {vcr_platform.STATUS_WAIT_ENV: seconds})
        patcher.start()
        self.addCleanup(patcher.stop)

    @staticmethod
    def job(state, **extra):
        return (200, {"data": {"action": "status", "jobId": "job_1", "state": state, **extra}})

    def asked_status(self):
        return [seen["body"] for seen in _Gateway.seen if seen["body"].get("action") == "status"]

    def test_a_running_job_s_answer_asks_for_no_status_loop_and_says_where_the_result_will_be(self):
        for action in ("start", "status"):
            _Gateway.answers["simulate"] = self.job("running", progress={"done": 3, "total": 10})
            arguments = {"action": "start", "kind": "design_simulation", "scenario": {}} if action == "start" else {"action": "status", "jobId": "job_1"}
            result = self.server.call_tool("vcr_simulate", arguments)
            self.assertEqual(result["status"], "success")
            self.assertIn("job_1 is running (3/10)", result["summary"])
            advice = " ".join(result["next_actions"])
            self.assertNotIn("Call again", advice)
            self.assertNotIn("action status", advice)
            self.assertIn("Do not wait for it in this turn", advice)
            self.assertIn("no status loop, no sleep or wait command", advice)
            self.assertIn("study page", advice)
            self.assertIn("notice", advice)
            self.assertIn("end the turn", advice)
            self.assertIn("vcr_read (what: results)", advice)

    def test_a_job_that_finishes_during_the_wait_comes_back_finished_from_one_start(self):
        self.wait_for("20")
        _Gateway.answers["simulate"] = [
            (200, {"data": {"action": "start", "jobId": "job_1", "state": "queued", "progress": {}}}),
            self.job("running", progress={"done": 1, "total": 4}),
            self.job("succeeded", result={"power": 0.81}),
        ]
        result = self.start()
        self.assertEqual(result["status"], "success")
        self.assertIn("job_1 succeeded", result["summary"])
        self.assertEqual(result["data"]["result"], {"power": 0.81})
        self.assertEqual(result["data"]["action"], "start")
        self.assertTrue(any("vcr_read (what: results)" in action for action in result["next_actions"]))
        self.assertEqual(self.asked_status(), [{"action": "status", "jobId": "job_1"}] * 2)
        self.assertEqual(self.clock.slept, [4.0, 4.0])

    def test_a_start_keeps_the_fields_only_the_start_answers_with(self):
        self.wait_for("20")
        _Gateway.answers["simulate"] = [
            (200, {"data": {"action": "start", "jobId": "job_1", "state": "queued", "refused": [{"study": "a", "reason": "no quote"}], "refusedCount": 1}}),
            self.job("succeeded", pooling={"pooled": 0.71}),
        ]
        result = self.server.call_tool("evidence_pool", {"action": "start", "parameter": "hazard_ratio", "endpointKey": "os"})
        self.assertIn("job_1 succeeded", result["summary"])
        self.assertEqual(result["data"]["refusedCount"], 1)
        self.assertEqual(result["data"]["pooling"], {"pooled": 0.71})

    def test_a_job_still_running_after_the_wait_answers_running_and_the_asking_is_bounded(self):
        self.wait_for("10")
        _Gateway.answers["simulate"] = [
            (200, {"data": {"action": "start", "jobId": "job_1", "state": "queued", "progress": {}}}),
            self.job("running", progress={"done": 2, "total": 10}),
        ]
        result = self.start()
        self.assertIn("job_1 is running (2/10)", result["summary"])
        self.assertNotIn("Call again", " ".join(result["next_actions"]))
        self.assertEqual(sum(self.clock.slept), 10.0)
        self.assertEqual(len(self.asked_status()), 3)
        self.assertLessEqual(len(_Gateway.seen), 1 + 3)

    def test_a_status_call_waits_the_same_way(self):
        self.wait_for("20")
        _Gateway.answers["simulate"] = [self.job("running"), self.job("failed", error={"code": "cpu_budget_exhausted", "message": "The CPU budget ran out."})]
        result = self.server.call_tool("vcr_simulate", {"action": "status", "jobId": "job_1"})
        self.assertEqual(result["status"], "warning")
        self.assertIn("job_1 failed", result["summary"])

    def test_the_wait_is_clamped_to_a_minute_and_falls_back_to_twenty_seconds(self):
        for configured, expected in (("500", 60.0), ("-5", 0.0), ("nan", 20.0), ("not a number", 20.0), ("", 20.0), ("7.5", 7.5)):
            with mock.patch.dict(os.environ, {vcr_platform.STATUS_WAIT_ENV: configured}):
                self.assertEqual(vcr_platform._status_wait_seconds(), expected, configured)
        with mock.patch.dict(os.environ):
            del os.environ[vcr_platform.STATUS_WAIT_ENV]
            self.assertEqual(vcr_platform._status_wait_seconds(), 20.0)
        self.wait_for("500")
        _Gateway.answers["simulate"] = self.job("running")
        self.start()
        self.assertEqual(sum(self.clock.slept), 60.0)

    def test_a_wait_of_zero_makes_no_second_request(self):
        self.wait_for("0")
        _Gateway.answers["simulate"] = (200, {"data": {"action": "start", "jobId": "job_1", "state": "queued", "progress": {}}})
        result = self.start()
        self.assertIn("job_1 is queued", result["summary"])
        self.assertEqual(len(_Gateway.seen), 1)
        self.assertEqual(self.clock.slept, [])

    def test_an_error_while_waiting_returns_the_last_good_answer_not_an_error(self):
        self.wait_for("20")
        for failure in ((503, {"error": "busy", "code": "vcr_gateway_unavailable"}), (200, b"not json")):
            _Gateway.seen = []
            self.clock.slept = []
            _Gateway.answers["simulate"] = [
                (200, {"data": {"action": "start", "jobId": "job_1", "state": "queued", "progress": {}}}),
                self.job("running", progress={"done": 1, "total": 4}),
                failure,
            ]
            result = self.start()
            self.assertNotIn("error", result)
            self.assertEqual(result["status"], "success")
            self.assertIn("job_1 is running (1/4)", result["summary"])
            self.assertEqual(len(self.asked_status()), 2)

    def test_nothing_is_waited_for_unless_a_job_is_computing(self):
        self.wait_for("20")
        for answer in (
            {"action": "start", "state": "not_started", "reason": "no_evidence"},
            {"action": "start", "jobId": "job_1", "state": "awaiting_budget", "awaitingBudget": True},
            {"action": "start", "jobId": "job_1", "state": "succeeded", "result": {}},
        ):
            _Gateway.seen = []
            _Gateway.answers["simulate"] = (200, {"data": answer})
            self.start()
            self.assertEqual(len(_Gateway.seen), 1, answer)
        _Gateway.seen = []
        _Gateway.answers["simulate"] = (200, {"data": {"action": "cancel", "jobId": "job_1", "state": "running"}})
        self.server.call_tool("vcr_simulate", {"action": "cancel", "jobId": "job_1"})
        self.assertEqual(len(_Gateway.seen), 1, "a cancel is answered, not waited on")
        self.assertEqual(self.clock.slept, [])


class CurveDigitizeTests(_GatewayCase):
    ARMS = [{"name": "control", "curve": {"color": "#d62728"}, "riskTable": [{"time": 0, "atRisk": 220}, {"time": 24, "atRisk": 90}], "totalEvents": 120},
            {"name": "treatment", "curve": {"legendOrder": 2}, "riskTable": [{"time": 0, "atRisk": 220}, {"time": 24, "atRisk": 120}]}]
    CALIBRATION = {"x": {"min": 0, "max": 48, "unit": "months"}, "y": {"min": 0, "max": 1, "scale": "fraction"}}

    def call(self, **extra):
        return self.server.call_tool("curve_digitize", {"imageArtifactId": "sources/fig2.png", "calibration": self.CALIBRATION, "arms": self.ARMS, **extra})

    def test_the_schema_has_no_place_for_a_coordinate_and_states_what_is_required_and_in_what_unit(self):
        definition = {tool["name"]: tool for tool in vcr_platform.tool_definitions()}["curve_digitize"]
        schema = definition["inputSchema"]
        self.assertEqual(schema["required"], ["imageArtifactId", "calibration", "arms"])
        self.assertEqual(set(schema["properties"]), set(vcr_platform.DIGITIZE_FIELDS))
        for forbidden in ("curve", "points", "provenance", "origin", "surv"):
            self.assertNotIn(forbidden, schema["properties"])
        arm = schema["properties"]["arms"]["items"]
        self.assertEqual(arm["required"], ["riskTable"])
        self.assertEqual(set(arm["properties"]["curve"]["properties"]), {"color", "legendOrder"})
        self.assertEqual(schema["properties"]["calibration"]["properties"]["y"]["properties"]["scale"]["enum"], ["fraction", "percent"])
        text = definition["description"]
        for stated in ("0.02", "0.6%", "FIRST and LAST tick", "never state a", "receiptId", "plot_area_ambiguous", "one colour"):
            self.assertIn(stated, text.replace("color", "colour") if stated == "one colour" else text)
        self.assertLess(len(text), 2400)

    def test_a_digitization_is_requested_with_a_calibration_and_never_a_point(self):
        _Gateway.answers["digitize"] = (200, {"data": {"state": "digitized", "receiptId": "crv_" + "a" * 32, "origin": "digitizer", "createdAt": "2026-10-04T00:00:00.000Z",
                                                       "digitization": {"statedBy": "run", "curves": [{"name": "control"}, {"name": "treatment"}], "warnings": []}}})
        result = self.call(imageSha256="b" * 64, reportedLogHazardRatio=-0.4)
        self.assertEqual(result["status"], "success")
        self.assertIn("crv_" + "a" * 32, result["summary"])
        self.assertIn("2 curve(s)", result["summary"])
        [seen] = _Gateway.seen
        self.assertEqual(seen["path"], "/internal/vcr/v1/digitize")
        self.assertEqual(seen["body"], {"imageArtifactId": "sources/fig2.png", "imageSha256": "b" * 64, "calibration": self.CALIBRATION, "arms": self.ARMS, "reportedLogHazardRatio": -0.4})
        self.assertTrue(any("receiptId" in action and "reconstruct_km" in action for action in result["next_actions"]))
        self.assertTrue(any("calibration as your reading of the axis labels" in action for action in result["next_actions"]))

    def test_a_warning_from_the_digitizer_is_carried_to_the_run(self):
        _Gateway.answers["digitize"] = (200, {"data": {"state": "digitized", "receiptId": "crv_" + "c" * 32, "digitization": {"curves": [{}], "warnings": ["curve_start_not_one: control starts at 0.909."]}}})
        result = self.call()
        self.assertEqual(result["status"], "warning")
        self.assertEqual(result["warnings"], ["curve_start_not_one: control starts at 0.909."])

    def test_a_refusal_to_trace_is_a_warning_that_says_what_to_state_and_records_nothing(self):
        _Gateway.answers["digitize"] = (200, {"data": {"state": "refused", "reason": "plot_area_ambiguous", "message": "2 plot areas were found.",
                                                       "candidates": [{"left": 79, "top": 15, "right": 616, "bottom": 373}, {"left": 79, "top": 412, "right": 616, "bottom": 502}]}})
        result = self.call()
        self.assertEqual(result["status"], "warning")
        self.assertIn("plot_area_ambiguous", result["summary"])
        self.assertIn("2 plot areas were found.", result["warnings"])
        self.assertTrue(any("plotArea" in action for action in result["next_actions"]))
        _Gateway.answers["digitize"] = (200, {"data": {"state": "refused", "reason": "colour_required", "message": "several colours", "palette": ["#d62728", "#1f77b4"]}})
        again = self.call()
        self.assertTrue(any("#d62728" in action for action in again["next_actions"]))

    def test_a_coordinate_or_an_origin_never_leaves_the_runtime(self):
        before = len(_Gateway.seen)
        for field in ("points", "curve", "provenance", "origin", "receiptId"):
            result = self.call(**{field: [{"time": 0, "surv": 1}]})
            self.assertEqual(result["error"]["code"], "invalid_input", field)
        missing = self.server.call_tool("curve_digitize", {"imageArtifactId": "sources/fig2.png", "calibration": self.CALIBRATION})
        self.assertEqual(missing["error"]["code"], "invalid_input")
        self.assertEqual(len(_Gateway.seen), before, "nothing was sent")

    def test_an_impossible_calibration_is_the_runs_to_fix_and_an_unavailable_digitizer_is_not(self):
        _Gateway.answers["digitize"] = (400, {"error": "x.max is greater than x.min.", "code": "vcr_curve_calibration_invalid"})
        result = self.call()
        self.assertEqual(result["error"]["code"], "vcr_curve_calibration_invalid")
        self.assertEqual(result["error"]["stopReason"], "invalid_input")
        _Gateway.answers["digitize"] = (503, {"error": "no digitizer", "code": "vcr_curve_digitizer_unavailable"})
        unavailable = self.call()
        self.assertEqual(unavailable["error"]["code"], "vcr_curve_digitizer_unavailable")
        self.assertEqual(unavailable["error"]["stopReason"], "unsupported")

    def test_a_deployment_without_the_module_says_so_as_a_warning(self):
        _Gateway.answers["digitize"] = (503, {"error": "off", "code": "vcr_disabled"})
        result = self.call()
        self.assertEqual(result["status"], "warning")
        self.assertIn("no 虚拟临床研究 study", result["summary"])


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
