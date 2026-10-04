"""「虚拟临研」's six runtime tools, against a scripted gateway, and through the
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


def _shape_items(text, at):
    """One brace level of a shape: ``key``, ``key?``, ``key[]``, ``key[e|f]``,
    ``key{...}``, ``key[{...}]``, ``a|b|c`` and the elision ``...``. Returns
    ``({name: {"only": set | None, "children": dict | None}}, position)``."""
    items = {}
    while at < len(text):
        while at < len(text) and text[at] in " ,":
            at += 1
        if at >= len(text):
            break
        if text[at] == "}":
            return items, at + 1
        if text.startswith("...", at):
            at += 3
            continue
        match = re.compile(r"[A-Za-z][A-Za-z0-9_]*(?:\|[A-Za-z][A-Za-z0-9_]*)*").match(text, at)
        assert match, "the shape cannot be read at: %r" % text[at:at + 40]
        at = match.end()
        only = None
        children = None
        if text.startswith("?", at):
            at += 1
        if text.startswith("[]", at):
            at += 2
        elif text.startswith("[{", at):
            children, at = _shape_items(text, at + 2)
            assert text.startswith("]", at), "an array of objects closes with }]: %r" % text[at:at + 20]
            at += 1
        elif text.startswith("[", at):
            close = text.index("]", at)
            only = set(text[at + 1:close].split("|"))
            at = close + 1
        if text.startswith("{", at):
            children, at = _shape_items(text, at + 1)
        for name in match.group(0).split("|"):
            items[name] = {"only": only, "children": children}
    return items, at


def scenario_shapes(description):
    """The scenario shapes a description offers, by job kind."""
    body = description.split("Shapes", 1)[1].split("):", 1)[1].split(". Truth spells", 1)[0]
    shapes = {}
    previous = None
    for entry in body.split("; "):
        entry = entry.strip()
        same = re.fullmatch(r"(\w+) the same plus (\w+)\[\] and (\w+)\[\]", entry)
        if same:
            shapes[same.group(1)] = {**shapes[previous], **{name: {"only": None, "children": None} for name in same.group(2, 3)}}
            continue
        names, _, rest = entry.partition(" {")
        items, _ = _shape_items(rest, 0)
        for name in re.split(r", | and ", names):
            shapes[name] = items
            previous = name
    return shapes


def shape_problems(shapes, schema):
    """Every place a shape offers what the domain's schema refuses, in words."""
    problems = []

    def under(where, offered, declared):
        for name, entry in (offered or {}).items():
            if declared is None or name not in declared:
                problems.append("%s offers %s, which the schema does not read" % (where, name))
            else:
                under("%s.%s" % (where, name), entry["children"], declared[name])

    for kind, shape in shapes.items():
        if kind not in schema:
            problems.append("%s is not a job kind" % kind)
            continue
        declared = schema[kind]
        for key, offered in shape.items():
            if key not in declared["keys"]:
                problems.append("%s offers %s, which %s does not read" % (kind, key, declared["method"]))
                continue
            read_for = declared["keys"][key]["endpoints"]
            narrowed = read_for is not None and set(read_for) != set(declared["endpoints"])
            if read_for is not None and not read_for:
                problems.append("%s offers %s, which %s refuses for every endpoint it implements" % (kind, key, declared["method"]))
            elif (offered["only"] or None) != (set(read_for) if narrowed else None):
                problems.append("%s.%s is read for %s and the shape says %s" % (
                    kind, key, sorted(read_for) if narrowed else "every endpoint", sorted(offered["only"]) if offered["only"] else "nothing"))
            under("%s.%s" % (kind, key), offered["children"], declared["keys"][key]["children"])
    return problems


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

    def test_simulate_states_the_scenario_shapes_and_points_at_the_skill(self):
        description = {tool["name"]: tool for tool in vcr_platform.tool_definitions()}["vcr_simulate"]["description"]
        for fragment in ("design_simulation", "truth.null", "accrual.dropoutAnnual", "kind:'snapshot'", "vcr-analysis skill", "refused by name"):
            self.assertIn(fragment, description)
        self.assertNotIn("isNull", description)
        self.assertNotIn("dropoutRate", description)

    def test_every_key_a_shape_offers_is_one_the_schema_reads_and_an_endpoint_only_key_says_which(self):
        description = {tool["name"]: tool for tool in vcr_platform.tool_definitions()}["vcr_simulate"]["description"]
        schema = domain_scenario_keys()
        shapes = scenario_shapes(description)
        # The walk proves it walked: the shapes were read, and so were the schemas behind them.
        self.assertGreaterEqual(len(shapes), 14, sorted(shapes))
        self.assertTrue(set(shapes) <= set(vcr_platform.JOB_KINDS), sorted(set(shapes) - set(vcr_platform.JOB_KINDS)))
        self.assertEqual(schema["generate_patients_binary"]["endpoints"], ["binary"])
        self.assertEqual(schema["generate_patients_binary"]["keys"]["accrual"]["endpoints"], [], "the domain refuses accrual for a binary set")
        self.assertEqual(schema["design_simulation"]["keys"]["accrual"]["endpoints"], ["time_to_event"])
        self.assertEqual(shape_problems(shapes, schema), [])
        # What the pilot's run was refused for (2026-10-03): `accrual` offered on every patient generator.
        self.assertIn("accrual", shapes["generate_patients"])
        self.assertNotIn("accrual", shapes["generate_patients_binary"])
        self.assertNotIn("accrual", shapes["generate_patients_continuous"])
        for kind in ("design_analytic", "design_simulation", "design_grid"):
            self.assertEqual(shapes[kind]["accrual"]["only"], {"time_to_event"}, kind)
        self.assertEqual(shapes["assurance"]["truth"]["only"], {"continuous", "binary"})
        self.assertIn("accrual (enrolment, follow-up, dropout as accrual.dropoutAnnual) exists only for a time_to_event endpoint", description)

    def test_the_shape_check_fails_on_a_key_the_schema_refuses(self):
        # The same check, on the sentences the description used to carry and on ones nobody wrote: it has to be able to fail.
        schema = domain_scenario_keys()
        stale = ("Shapes (legend): generate_patients_binary {design{nTreat,nControl?}, endpoint, truth, accrual?}; "
                 "design_simulation {design{kind,nTreat}, endpoint{type}, truth{null?,...}, accrual?}; "
                 "assurance {design, endpoint, designPrior{mean,sd}, truth?, analysis}; "
                 "weight_comparator {covariates[], tau[binary]}; rmst {tau, dropoutRate?}; "
                 "procova {endpoint, truth{effect,riskRatio}}. Truth spells")
        problems = shape_problems(scenario_shapes(stale), schema)
        self.assertEqual(len(problems), 6, problems)
        for fragment in (
            "generate_patients_binary offers accrual, which patients.binary refuses for every endpoint it implements",
            "design_simulation.accrual is read for ['time_to_event'] and the shape says nothing",
            "assurance.truth is read for ['binary', 'continuous'] and the shape says nothing",
            "weight_comparator.tau is read for ['time_to_event'] and the shape says ['binary']",
            "rmst offers dropoutRate, which comparator.rmst does not read",
            "procova.truth offers riskRatio, which the schema does not read",
        ):
            self.assertIn(fragment, problems)

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
        self.assertIn("no 虚拟临研 study", result["summary"])


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
