#!/usr/bin/env python3
"""What the release audit says when its evidence no longer covers the source.

Evidence is valid for as long as what it certifies is unchanged, and age alone never
expires it (owner ruling, 2026-10-04): the fourteen-day window this file used to pin
turned `pnpm audit:capabilities` red on every machine two weeks after each probe
although nothing had changed. The tests below pin the replacement: a probe is judged
by the tool registry it covers and the identity of the source it was taken on, a
change names which, and a calendar bound exists only as an operator's own flag.

Two defects that shaped the messages, both reproduced against the real checker on
2026-09-10:

  1. `pnpm audit:capabilities` said exactly "tool audit evidence is stale" and
     nothing else, because freshness was the first thing `verify_tools()`
     checked -- so the run died before loading the registry and could not
     notice that the probe covers 25 tools while the registry declares 34, nor
     that it records them under the retired `evimed_` prefix. Refreshing the
     timestamp would have produced a second, different failure.
  2. `verify_sources()` compared the catalog against eleven numbers written
     into this file. Adding one data source made the release red with
     "reviewed data-source count drifted", and the only way past was to edit
     the expectation.

These tests are also the guard on the fix: a probe covering too few tools is
still refused whatever its age, and the identity check is what replaces the window.
"""

from __future__ import annotations

import contextlib
import copy
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import audit_identity

_spec = importlib.util.spec_from_file_location("evimed_release_audit_under_test", HERE / "verify_release_audit.py")
audit = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(audit)

REGISTRY = {"health", "literature_search", "web_search", "guideline_search"}
IDENTITY = audit_identity.tool_source_identity()


def probe(*, days_ago, tools, prefix="", identity=IDENTITY):
    at = datetime.now(timezone.utc) - timedelta(days=days_ago)
    document = {
        "schemaVersion": 3,
        "probedAt": at.isoformat().replace("+00:00", "Z"),
        "registered": len(tools),
        "results": [{"tool": "%s%s" % (prefix, name)} for name in tools],
    }
    if identity is not None:
        document["sourceIdentity"] = copy.deepcopy(identity)
    return document


class ToolProbeCurrency(unittest.TestCase):
    def test_a_current_complete_probe_raises_nothing(self):
        audit.tool_probe_currency(probe(days_ago=1, tools=REGISTRY), REGISTRY, set())

    def test_age_alone_never_expires_a_probe(self):
        # The probe cannot be refreshed without a live deployment, and a calendar
        # window made a probe of an untouched source red on every machine two weeks
        # later. What it certifies is unchanged, so it stands, at any age.
        for days in (15, 41, 400, 3650):
            with self.subTest(days_ago=days):
                audit.tool_probe_currency(probe(days_ago=days, tools=REGISTRY), REGISTRY, set())
        self.assertFalse(hasattr(audit, "TOOL_PROBE_WINDOW_DAYS"), "the window was not removed, only widened")

    def test_a_time_from_the_future_is_still_no_evidence(self):
        with self.assertRaises(SystemExit) as raised:
            audit.tool_probe_currency(probe(days_ago=-1, tools=REGISTRY), REGISTRY, set())
        self.assertIn("tool audit timestamp is in the future", str(raised.exception))

    def test_an_operator_may_bound_the_age_and_default_is_no_bound(self):
        self.assertIsNone(audit.OPERATOR_MAX_AGE_DAYS)
        with patch.object(audit, "OPERATOR_MAX_AGE_DAYS", 30):
            audit.tool_probe_currency(probe(days_ago=1, tools=REGISTRY), REGISTRY, set())
            with self.assertRaises(SystemExit) as raised:
                audit.tool_probe_currency(probe(days_ago=41, tools=REGISTRY), REGISTRY, set())
        self.assertIn("past the operator's bound of 30 days", str(raised.exception))

    def test_a_probe_that_covers_too_few_tools_is_still_refused(self):
        # The failure the old ordering hid: a recent probe is not a covering one.
        with self.assertRaises(SystemExit) as raised:
            audit.tool_probe_currency(probe(days_ago=0, tools={"health"}), REGISTRY, set())
        message = str(raised.exception)
        self.assertIn("tool audit evidence does not cover the current source", message)
        self.assertIn("the registry declares 4", message)
        self.assertIn("never probed", message)
        for name in REGISTRY - {"health"}:
            self.assertIn(name, message)

    def test_an_old_undersized_probe_reports_the_tools_and_never_its_age(self):
        with self.assertRaises(SystemExit) as raised:
            audit.tool_probe_currency(probe(days_ago=41, tools={"health"}), REGISTRY, set())
        message = str(raised.exception)
        self.assertIn("the registry declares 4", message)
        self.assertNotIn("days ago", message)
        self.assertNotIn("window", message)
        self.assertIn("run_tool_audit.py", message)
        self.assertIn("no deployment reachable", message)

    def test_a_probe_with_no_recorded_identity_reads_as_identity_not_recorded(self):
        with self.assertRaises(SystemExit) as raised:
            audit.tool_probe_currency(probe(days_ago=1, tools=REGISTRY, identity=None), REGISTRY, set())
        message = str(raised.exception)
        self.assertIn("identity not recorded, re-probe", message)
        self.assertIn("sourceIdentity", message)
        self.assertNotIn("never probed", message)

    def test_a_probe_taken_on_other_source_names_which_identity_moved(self):
        server_moved = copy.deepcopy(IDENTITY)
        server_moved["mcpSource"]["sha256"] = "0" * 64
        with self.assertRaises(SystemExit) as raised:
            audit.tool_probe_currency(probe(days_ago=1, tools=REGISTRY, identity=server_moved), REGISTRY, set())
        message = str(raised.exception)
        self.assertIn("the research MCP server source (runtime/mcp/evimed-research) changed since", message)
        self.assertNotIn("tool-name registry (packages", message)
        names_moved = copy.deepcopy(IDENTITY)
        names_moved["toolNames"]["sha256"] = "1" * 64
        with self.assertRaises(SystemExit) as raised:
            audit.tool_probe_currency(probe(days_ago=400, tools=REGISTRY, identity=names_moved), REGISTRY, set())
        message = str(raised.exception)
        self.assertIn("the tool-name registry (packages/domain/src/toolNames.mjs) changed since", message)
        self.assertNotIn("MCP server source", message)
        self.assertIn("refresh:", message)

    def test_the_retired_prefix_is_named_rather_than_read_as_missing_probes(self):
        with self.assertRaises(SystemExit) as raised:
            audit.tool_probe_currency(probe(days_ago=0, tools=REGISTRY, prefix="evimed_"), REGISTRY, set())
        message = str(raised.exception)
        self.assertIn("retired `evimed_` prefix", message)
        # Once unwrapped they are the registry, so nothing may be reported as
        # never probed: that diff is what made one rename read as 59 holes.
        self.assertNotIn("never probed", message)

    def test_a_tool_the_deployment_declined_is_a_denominator_not_a_hole(self):
        audit.tool_probe_currency(probe(days_ago=1, tools=REGISTRY - {"web_search"}), REGISTRY, {"web_search"})

    def test_the_message_names_the_evidence_file(self):
        with self.assertRaises(SystemExit) as raised:
            audit.tool_probe_currency(probe(days_ago=41, tools={"health"}), REGISTRY, set())
        self.assertIn("tool-probe-v3.json", str(raised.exception))

    def test_the_shipped_recording_says_what_it_lacks_instead_of_its_age(self):
        # Until the runner records an identity the committed probe cannot claim
        # one, and the audit says exactly that; the day it is regenerated this
        # test only checks that age is not what is said.
        document = json.loads((HERE / "results" / "tool-probe-v3.json").read_text(encoding="utf-8"))
        server = audit.load_module("evimed_release_tool_registry", audit.REPO / "runtime" / "mcp" / "evimed-research" / "server.py")
        registry = {item["name"] for item in server.TOOL_DEFINITIONS}
        try:
            audit.tool_probe_currency(document, registry, set(document.get("notOffered", [])))
        except SystemExit as raised:
            self.assertNotIn("days ago", str(raised))
            self.assertNotIn("window", str(raised))
            if "sourceIdentity" not in document:
                self.assertIn("identity not recorded, re-probe", str(raised))


class ToolSourceIdentity(unittest.TestCase):
    """The digests a probe is taken on, from the tree it is asked about."""

    def _tree(self, root):
        mcp = root / "runtime/mcp/evimed-research"
        (mcp / "test").mkdir(parents=True)
        (mcp / "__pycache__").mkdir()
        (root / "packages/domain/src").mkdir(parents=True)
        (mcp / "execution_evidence.py").write_bytes((audit.REPO / "runtime/mcp/evimed-research/execution_evidence.py").read_bytes())
        (mcp / "server.py").write_text("TOOL_DEFINITIONS = []\n")
        (mcp / "test" / "test_server.py").write_text("assert True\n")
        (mcp / "__pycache__" / "server.pyc").write_bytes(b"\x00")
        (root / "packages/domain/src/toolNames.mjs").write_text("export const NAMES = []\n")
        return mcp

    def test_it_follows_what_executes_and_the_names_the_model_is_offered_and_nothing_else(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            mcp = self._tree(root)
            before = audit_identity.tool_source_identity(root)
            self.assertEqual(set(before), {"schemaVersion", "mcpSource", "toolNames"})
            self.assertEqual(before, audit_identity.tool_source_identity(root), "deterministic")
            # Neither a test nor a compiled cache is what a probe certifies.
            (mcp / "test" / "test_server.py").write_text("assert 1 == 1\n")
            (mcp / "__pycache__" / "server.pyc").write_bytes(b"\x01")
            self.assertEqual(audit_identity.tool_source_identity(root), before)
            self.assertEqual(audit_identity.identity_changes(before, audit_identity.tool_source_identity(root)), [])
            (mcp / "server.py").write_text("TOOL_DEFINITIONS = [1]\n")
            moved = audit_identity.identity_changes(before, audit_identity.tool_source_identity(root))
            self.assertEqual(moved, [audit_identity.IDENTITY_PARTS["mcpSource"]])
            (root / "packages/domain/src/toolNames.mjs").write_text("export const NAMES = ['x']\n")
            self.assertEqual(audit_identity.identity_changes(before, audit_identity.tool_source_identity(root)), list(audit_identity.IDENTITY_PARTS.values()))

    def test_a_record_that_is_not_an_identity_certifies_nothing(self):
        current = audit_identity.tool_source_identity()
        for recorded in (None, {}, "x", {"schemaVersion": 2}, {"schemaVersion": 1, "mcpSource": {"sha256": current["mcpSource"]["sha256"]}}):
            with self.subTest(recorded=recorded):
                self.assertTrue(audit_identity.identity_changes(recorded, current))

    def test_the_runner_records_the_identity_the_verifier_computes(self):
        import run_tool_audit as runner
        self.assertIs(runner.tool_source_identity, audit_identity.tool_source_identity, "one implementation, imported by both")
        self.assertEqual(audit_identity.tool_source_identity(), IDENTITY)


class UncertifiedToolsAreNamed(unittest.TestCase):
    """A fresh probe that falls short says which tools, and what they said.

    The refusal itself is unchanged -- every offered tool must be certified --
    but "all 40 tools are not execution-certified" made the reader open the
    document to learn which. Run against the real registry, so the document
    below passes every currency check and reaches the count.
    """

    def _document(self):
        server = audit.load_module("evimed_release_tool_registry", audit.REPO / "runtime" / "mcp" / "evimed-research" / "server.py")
        registry = sorted(item["name"] for item in server.TOOL_DEFINITIONS)
        self.assertGreater(len(registry), 30, "the registry did not load; this test proved nothing")
        results = [{"tool": name, "operational": True, "probeType": "executed_tool_call", "status": "success"} for name in registry]
        for row in results:
            if row["tool"] == "mendelian_randomization":
                row.update(operational=False, probeType="no_completed_job_receipt", status="unverified",
                           summary="No terminal managed job with verified artifacts and a recorded source equal to this tree's was found.")
        return {
            "schemaVersion": 3,
            "probedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "sourceIdentity": copy.deepcopy(IDENTITY),
            "registered": len(registry),
            "notOffered": [],
            "executionCertified": len(registry) - 1,
            "operational": len(registry) - 1,
            "unverified": 1,
            "errors": 0,
            "complete": False,
            "results": results,
        }, len(registry)

    def test_a_short_count_names_each_uncertified_tool_and_its_reason(self):
        document, expected = self._document()
        real_read = audit.read
        audit.read = lambda name: document if name == "tool-probe-v3.json" else real_read(name)
        try:
            with self.assertRaises(SystemExit) as raised:
                audit.verify_tools()
        finally:
            audit.read = real_read
        message = str(raised.exception)
        self.assertIn("%d of %d tools are execution-certified" % (expected - 1, expected), message)
        self.assertIn("mendelian_randomization (no_completed_job_receipt", message)
        self.assertIn("No terminal managed job with verified artifacts", message)
        # Only the one that failed: a certified tool named here would be noise.
        self.assertNotIn("health (", message)


class ProbeFixturesCoverTheRegistry(unittest.TestCase):
    """Every declared tool has a probe fixture or a receipt harvester.

    `reference_list` shipped with neither, so `run_tool_audit.py` refused to
    start against any deployment -- a defect only a live run could find, which
    is why the refresh stayed undone. Checked here offline instead.
    """

    def test_fixtures_and_specialists_are_exactly_the_registry(self):
        import run_tool_audit as runner

        server = audit.load_module("evimed_release_tool_registry", audit.REPO / "runtime" / "mcp" / "evimed-research" / "server.py")
        registry = {item["name"] for item in server.TOOL_DEFINITIONS}
        self.assertGreater(len(registry), 30, "the registry did not load; this test proved nothing")
        fixtured = set(runner.TASK_FIXTURES) | set(runner.SPECIALISTS)
        self.assertEqual(sorted(registry - fixtured), [], "declared but never probed")
        self.assertEqual(sorted(fixtured - registry), [], "fixtured but no longer declared")
        self.assertFalse(set(runner.TASK_FIXTURES) & set(runner.SPECIALISTS))

    def test_every_fixture_matches_its_tools_published_schema(self):
        # `social_posts_search` changed to one platform per call and its
        # fixture kept `platforms`, so the live probe got `invalid_input`
        # before any crawl -- a refusal the schema alone predicts. The same
        # validator the server runs before dispatch, over every fixture.
        import run_tool_audit as runner

        server = audit.load_module("evimed_release_tool_registry", audit.REPO / "runtime" / "mcp" / "evimed-research" / "server.py")
        schemas = {item["name"]: item["inputSchema"] for item in server.TOOL_DEFINITIONS}
        checked = 0
        for tool, arguments in runner.TASK_FIXTURES.items():
            with self.subTest(tool=tool):
                server._validate(arguments, schemas[tool], "arguments")
                checked += 1
        self.assertEqual(checked, len(runner.TASK_FIXTURES))
        self.assertGreater(checked, 30, "no fixture was validated; this test proved nothing")


class RegistryTailToolsAreCertifiable(unittest.TestCase):
    """`evidence_pool`, `research_calculate`, `trial_registry_record`, `vcr_read`, `vcr_simulate`, `vcr_write`.

    The recorded probe predates all six, so the audit says it covers 40 of 47. The
    runner has carried a fixture for each since they were declared, and a fixture
    nobody has watched certify is a promise: here each one is run through the real
    MCP server against stub gateways that answer as the deployed ones do (a project
    with no study; an owned calculation job), and must come back operational by
    the runner's own criterion. `research_calculate` is the one a probe cannot make
    up for itself: a calculation starts only from a native conversation turn, so it
    is probed on a job the project already owns, and without one it says so.
    """

    TOOLS = ("evidence_pool", "research_calculate", "trial_registry_record", "vcr_read", "vcr_simulate", "vcr_write")
    JOB = "replay_" + "ab" * 32

    def setUp(self):
        import http.server
        import os
        import threading
        seen = self.seen = []

        class Gateway(http.server.BaseHTTPRequestHandler):
            def do_POST(handler):
                body = json.loads(handler.rfile.read(int(handler.headers["content-length"])))
                seen.append((handler.path, body))
                if handler.path.startswith("/internal/results/v1/"):
                    status, answer = (200, {"data": {"id": body["jobId"], "state": "succeeded"}}) if body.get("jobId") == self.JOB \
                        else (404, {"error": "The calculation is unavailable.", "code": "result_replay_unavailable"})
                else:  # the 虚拟临研 gateway of a project that has no study
                    status, answer = 404, {"error": "no study", "code": "vcr_no_study"}
                payload = json.dumps(answer).encode()
                handler.send_response(status)
                handler.send_header("Content-Length", str(len(payload)))
                handler.end_headers()
                handler.wfile.write(payload)

            def log_message(handler, *_args):
                pass

        http_server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Gateway)
        threading.Thread(target=http_server.serve_forever, daemon=True).start()
        self.addCleanup(http_server.server_close)
        self.addCleanup(http_server.shutdown)
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.workspace = Path(temporary.name).resolve()
        token = self.workspace / "gateway-token"
        token.write_text("test-runtime-token\n")
        token.chmod(0o600)
        base = "http://127.0.0.1:%d" % http_server.server_address[1]
        environment = patch.dict(os.environ, {
            "EVIMED_RESULT_GATEWAY_URL": base + "/internal/results/v1", "EVIMED_VCR_GATEWAY_URL": base + "/internal/vcr/v1",
            "EVIMED_PUBLIC_SOURCE_GATEWAY_URL": base + "/internal/sources/v1/fetch", "EVIMED_MODEL_GATEWAY_TOKEN_FILE": str(token),
            "EVIMED_DISABLED_TOOLS": "",
        })
        environment.start()
        self.addCleanup(environment.stop)
        self.server = audit.load_module("evimed_release_tool_probe_server", audit.REPO / "runtime" / "mcp" / "evimed-research" / "server.py")

    def _probe(self, **overrides):
        import run_tool_audit as runner
        fixtures = {tool: dict(runner.TASK_FIXTURES[tool]) for tool in self.TOOLS}
        fixtures.update(overrides)
        with patch.object(runner, "REPO", self.workspace.parent), patch.dict(runner.TASK_FIXTURES, fixtures, clear=True):
            return {row["tool"]: row for row in runner.run_task_probes(self.server, self.workspace)}

    def test_every_fixture_exists_and_each_comes_back_operational_with_the_job_it_needs(self):
        rows = self._probe(research_calculate={"action": "status", "jobId": self.JOB})
        self.assertEqual(sorted(rows), sorted(self.TOOLS))
        for tool, row in rows.items():
            with self.subTest(tool=tool):
                self.assertIs(row["operational"], True, row["summary"])
                self.assertIn(row["status"], ("success", "warning"))
        self.assertEqual(rows["research_calculate"]["status"], "success")
        self.assertTrue(any(path.endswith("/status") and body["jobId"] == self.JOB for path, body in self.seen))
        self.assertTrue(all(rows[tool]["status"] == "warning" for tool in self.TOOLS if tool.startswith("vcr_") or tool in ("evidence_pool", "trial_registry_record")),
                        "a project with no study is a warning the route and token certified, never a calculation")

    def test_research_calculate_without_an_owned_job_says_what_it_needs_instead_of_asking_about_a_fake_one(self):
        rows = self._probe()
        row = rows["research_calculate"]
        self.assertIs(row["operational"], False)
        self.assertEqual(row["probeType"], "no_owned_calculation_job")
        self.assertIn("EVIMED_RESULT_REPLAY_AUDIT_JOB_ID", row["summary"])
        self.assertFalse(any(path.startswith("/internal/results/v1/") for path, _body in self.seen), "no gateway call about an id nobody holds")
        for tool in self.TOOLS:
            if tool != "research_calculate":
                self.assertIs(rows[tool]["operational"], True, tool)


class IncompleteProbeRecording(unittest.TestCase):
    """What `run_tool_audit.py` writes when a tool cannot be certified.

    By default nothing: a partial document must not quietly stand in for a
    complete one. `--record-incomplete` writes it, and says so in the document
    rather than only on stderr.
    """

    def test_disabled_module_is_not_called_or_saved_as_an_execution(self):
        import run_tool_audit as runner
        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary).resolve()
            workspace = repo / "owned"
            workspace.mkdir()
            called = []
            server = SimpleNamespace(
                disabled_tools=lambda: {"vcr_read"},
                call_tool=lambda name, arguments: called.append(name) or {"status": "success"},
            )
            with patch.object(runner, "REPO", repo), patch.dict(
                runner.TASK_FIXTURES, {"health": {}, "vcr_read": {"what": "study"}}, clear=True
            ):
                rows = runner.run_task_probes(server, workspace)
            self.assertEqual(called, ["health"])
            self.assertEqual([row["tool"] for row in rows], ["health"])
            self.assertFalse((workspace / ".evimed-audit/tool-responses/vcr_read.json").exists())

    def _run(self, *extra):
        import run_tool_audit as runner

        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        repo = Path(temporary.name).resolve()
        server = SimpleNamespace(
            list_tools=lambda: [{"name": "health"}, {"name": "peer_review"}],
            TOOL_DEFINITIONS=[{"name": "health"}, {"name": "peer_review"}],
            OPTIONAL_TOOLS=set(),
            disabled_tools=lambda: set(),
            call_tool=lambda name, arguments: {"status": "success", "summary": "answered"},
        )
        argv = ["run_tool_audit.py", "--probe-workspace", str(repo / "ws"), "--output-dir", str(repo / "out"), *extra]
        with patch.object(runner, "REPO", repo), patch.object(runner, "load_server", return_value=server), \
                patch.dict(runner.TASK_FIXTURES, {"health": {}}, clear=True), \
                patch.dict(runner.SPECIALISTS, {"peer_review": ("peer-review-runs", "review-")}, clear=True), \
                patch.object(sys, "argv", argv), contextlib.redirect_stdout(io.StringIO()), \
                contextlib.redirect_stderr(io.StringIO()) as stderr:
            with self.assertRaises(SystemExit) as raised:
                runner.main()
        return raised.exception.code, repo / "out", stderr.getvalue()

    def test_by_default_an_incomplete_probe_writes_nothing(self):
        code, output, stderr = self._run()
        self.assertEqual(code, 1)
        self.assertFalse((output / "tool-probe-v3.json").exists())
        self.assertFalse((output / "evidence").exists())
        self.assertIn("not written", stderr)

    def test_record_incomplete_writes_a_document_that_says_it_is_incomplete(self):
        code, output, stderr = self._run("--record-incomplete")
        self.assertEqual(code, 1, "an incomplete probe still exits non-zero")
        document = json.loads((output / "tool-probe-v3.json").read_text(encoding="utf-8"))
        self.assertIs(document["complete"], False)
        self.assertEqual((document["registered"], document["executionCertified"], document["unverified"]), (2, 1, 1))
        rows = {row["tool"]: row for row in document["results"]}
        self.assertIs(rows["health"]["operational"], True)
        self.assertEqual(rows["peer_review"]["probeType"], "no_completed_job_receipt")
        self.assertTrue((output / "evidence" / ".evimed-audit" / "tool-responses" / "health.json").is_file())
        self.assertIn("recorded incomplete", stderr)
        self.assertIn("peer_review", stderr)


class CurrentSkillInventory(unittest.TestCase):
    def test_source_scan_uses_native_composition_and_dispatch_scopes(self):
        from audit_inventory import skill_composition
        composition = skill_composition(audit.REPO)
        packages = {row["id"]: row for row in composition["packages"]}
        self.assertEqual(composition["basis"], "source-planned-image-composition")
        self.assertEqual(composition["imageObservation"], "unknown")
        self.assertEqual(packages["evimed/open-domain-answer"]["scope"], "agent")
        self.assertEqual(packages["capability-skills/meta-analysis"]["scope"], "delegated")
        self.assertTrue(any(name.startswith("community/") for name in packages))
        self.assertNotIn("evimed/meta-analysis", packages)
        self.assertFalse(any(name.startswith("external/") for name in packages))
        self.assertTrue(all(row["manifestSha256"] == audit.file_sha256(audit.REPO / row["manifest"]) for row in packages.values()))

    def test_equal_counts_with_changed_body_or_scope_are_refused(self):
        from audit_inventory import skill_composition, skill_execution_coverage
        composition = skill_composition(audit.REPO)
        coverage = skill_execution_coverage(audit.REPO, audit.RESULTS, composition)
        summary = {"schemaVersion": 5, "sourcePlannedComposition": composition, "imageObservation": "unknown", "executionCoverage": coverage}
        for field, value in [("manifestSha256", "0" * 64), ("scope", "agent")]:
            with self.subTest(field=field):
                changed = json.loads(json.dumps(summary))
                changed["sourcePlannedComposition"]["packages"][0][field] = value
                with tempfile.TemporaryDirectory() as temporary, patch.object(audit, "REPORTS", Path(temporary)), patch.object(audit, "read", return_value={"summary": changed}):
                    (Path(temporary) / "skill-audit-v5.json").touch()
                    with self.assertRaisesRegex(SystemExit, "name/path/digest/dispatch scope"):
                        audit.verify_skills()

    def test_source_only_never_certifies_a_new_skill(self):
        from audit_inventory import skill_composition, skill_execution_coverage
        composition = skill_composition(audit.REPO)
        with tempfile.TemporaryDirectory() as temporary:
            coverage = skill_execution_coverage(audit.REPO, Path(temporary), composition)
        self.assertTrue(coverage)
        self.assertTrue(all(row["state"] == "unknown" and row["evidence"] is None for row in coverage))

    def test_old_skill_schema_is_not_reinterpreted_as_current(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(audit, "REPORTS", Path(temporary)):
            (Path(temporary) / "skill-audit-v4.json").write_text('{"summary":{"freshWebGlobalSkillPackages":58}}')
            with self.assertRaisesRegex(SystemExit, "retired runtime tree"):
                audit.verify_skills()

    def test_matching_task_artifacts_are_required_and_body_changes_invalidate(self):
        from audit_inventory import sha256, skill_execution_coverage
        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary)
            manifest = repo / "runtime/skills/office/docx/SKILL.md"
            manifest.parent.mkdir(parents=True)
            manifest.write_text("public instructions")
            entrypoint = manifest.parent / "convert.py"
            entrypoint.write_text("bounded program")
            artifact = repo / "artifact.docx"
            artifact.write_bytes(b"retained public output")
            results = repo / "results"
            results.mkdir()
            row = {"package": "office/docx", "operation": "task", "passed": True, "returnCode": 0,
                   "manifestSha256": sha256(manifest), "entrypoint": entrypoint.relative_to(repo).as_posix(),
                   "entrypointSha256": sha256(entrypoint), "checks": {"readable": True},
                   "artifacts": [{"path": "artifact.docx", "bytes": artifact.stat().st_size, "sha256": sha256(artifact)}]}
            report = {"schemaVersion": 1, "finishedAt": datetime.now(timezone.utc).isoformat(),
                      "environment": {"dependencyContract": "selected audit runtime plus package-declared dependencies"}, "installedPackagesExamined": 1, "executionCertified": 1, "failed": 0, "packages": [row]}
            (results / "platform-skill-execution-v1.json").write_text(json.dumps(report))
            def state():
                composition = {"packages": [{"id": "office/docx", "manifestSha256": sha256(manifest)}]}
                return skill_execution_coverage(repo, results, composition)[0]["state"]
            self.assertEqual(state(), "bounded-historical-task-matched")
            artifact.write_bytes(b"altered output")
            self.assertEqual(state(), "unknown")
            artifact.write_bytes(b"retained public output")
            manifest.write_text("different scientific instructions")
            self.assertEqual(state(), "unknown")
            manifest.write_text("public instructions")
            entrypoint.write_text("different calculation")
            self.assertEqual(state(), "unknown")

    def test_stale_or_incompatible_dependencies_do_not_certify(self):
        from audit_inventory import skill_composition, skill_execution_coverage
        composition = skill_composition(audit.REPO)
        document = json.loads((audit.RESULTS / "platform-skill-execution-v1.json").read_text())
        with tempfile.TemporaryDirectory() as temporary:
            results = Path(temporary)
            for mutation in [{"finishedAt": "2000-01-01T00:00:00Z"}, {"environment": {"dependencyContract": "unmatched dependencies"}}]:
                with self.subTest(mutation=mutation):
                    changed = {**document, **mutation}
                    (results / "platform-skill-execution-v1.json").write_text(json.dumps(changed))
                    self.assertTrue(all(row["state"] == "unknown" for row in skill_execution_coverage(audit.REPO, results, composition)))

    def test_missing_preset_path_and_unexplained_copy_are_refused(self):
        from audit_inventory import skill_composition
        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary)
            for name in ["deploy/runtime-dsh", "packages/domain/src", "runtime/skills/core/one"]:
                (repo / name).mkdir(parents=True)
            (repo / "runtime/skills/core/one/SKILL.md").write_text("instructions")
            (repo / "packages/domain/src/skillRoots.mjs").write_text("source: 'runtime/skills/core'")
            dockerfile = repo / "deploy/runtime-dsh/Dockerfile"
            installer = repo / "deploy/runtime-dsh/install-runtime.sh"
            dockerfile.write_text("COPY runtime/skills/core /opt/evimed/skills/core\n")
            installer.write_text("")
            with self.assertRaisesRegex(SystemExit, "never reaches the native preset"):
                skill_composition(repo)
            installer.write_text("cp -a /opt/evimed/skills/core /opt/evimed/socket/presets/evimed-universal/skills/core\n")
            self.assertEqual(skill_composition(repo)["packages"][0]["id"], "core/one")
            dockerfile.write_text("COPY runtime/skills/core /some/unexplained/location\n")
            with self.assertRaisesRegex(SystemExit, "unexplained destination"):
                skill_composition(repo)

    def test_generator_preserves_historical_outputs_and_unknown_is_fail_closed(self):
        import build_skill_audit as builder
        original_is_file = Path.is_file
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "input.json"
            source.write_text(json.dumps({"items": json.loads((audit.RESULTS / 'skill-audit-v4.json').read_text())["items"]}))
            output = root / "out"
            output.mkdir()
            historical = output / "skill-audit-v4.json"
            historical.write_text("historical bytes")
            with patch.object(sys, "argv", ["build", "--input", str(source), "--output-dir", str(output)]), contextlib.redirect_stdout(io.StringIO()):
                builder.main()
            self.assertEqual(historical.read_text(), "historical bytes")
            current = json.loads((output / "skill-audit-v5.json").read_text())
            self.assertEqual(current["summary"]["imageObservation"], "unknown")
            self.assertTrue(current["summary"]["unknownExecutionPackageIds"])
            # Read retained evidence from its real root; only the new summary is injected.
            with patch.object(audit, "read", return_value=current), patch.object(audit.Path, "is_file", autospec=True) as exists:
                exists.side_effect = lambda item: True if item == audit.REPORTS / "skill-audit-v5.json" else original_is_file(item)
                with self.assertRaisesRegex(SystemExit, "current skill task evidence is unknown"):
                    audit.verify_skills()
            with patch.object(sys, "argv", ["build", "--input", str(source), "--output-dir", str(output)]), self.assertRaisesRegex(SystemExit, "already exists"):
                builder.main()

    def test_generator_and_verifier_read_the_selected_evidence_directory(self):
        import build_skill_audit as builder
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            evidence = root / "new-evidence"
            evidence.mkdir()
            output = root / "new-report"
            source = audit.RESULTS / "skill-audit-v4.json"
            with patch.object(sys, "argv", ["build", "--input", str(source), "--output-dir", str(output),
                                           "--evidence-dir", str(evidence)]), contextlib.redirect_stdout(io.StringIO()):
                builder.main()
            summary = json.loads((output / "skill-audit-v5.json").read_text())["summary"]
            self.assertTrue(all(item["state"] == "missing" for item in summary["historicalExecutionEvidence"]))
            with patch.object(audit, "REPORTS", output), patch.object(audit, "RESULTS", evidence):
                with self.assertRaisesRegex(SystemExit, "current skill task evidence is unknown"):
                    audit.verify_skills()
            self.assertEqual(list(evidence.iterdir()), [])

    def test_retired_notebook_and_legacy_target_are_not_claimed_current(self):
        import build_skill_audit as builder
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "input.json"
            source.write_text(json.dumps({"items": [{"name": "open-notebook"}, {"name": "literature-review"}, {"name": "markitdown"}]}))
            with patch.object(sys, "argv", ["build", "--input", str(source), "--output-dir", str(root / "out")]), contextlib.redirect_stdout(io.StringIO()):
                builder.main()
            rows = {row["sourceName"]: row for row in json.loads((root / "out/skill-audit-v5.json").read_text())["items"]}
            self.assertNotIn("open-notebook", builder.BUNDLED)
            self.assertEqual(rows["open-notebook"]["disposition"], "retired_product_mapping")
            self.assertEqual(rows["literature-review"]["targetStates"], [{"target": "external/ai4s-skills/literature-survey", "state": "historical-target-not-shipped"}])
            for row in rows.values():
                self.assertEqual(row["releaseStatus"], "historical_mapping_unverified")
                self.assertEqual(row["runtimePackagesSourcePlanned"], [])
                self.assertEqual(row["runtimePackagesBoundedHistoricalTaskMatched"], [])
                self.assertEqual(row["currentImageExecution"], "unknown")

    def test_curated_producer_refuses_existing_report_and_artifacts_before_execution(self):
        import run_skill_execution_audit as producer
        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary)
            output = repo / "new-results"
            with patch.object(producer, "ROOT", repo), patch.object(producer, "RESULT_FILE", output / "skill-execution-v1.json"), patch.object(producer, "ARTIFACT_ROOT", output / "skill-execution-v1-artifacts"), patch.object(producer, "LOCK_FILE", output / ".lock"):
                producer.configure_output(output)
                artifact = output / "skill-execution-v1-artifacts/retained.json"
                artifact.parent.mkdir(parents=True)
                artifact.write_bytes(b"actual prior evidence")
                with patch.object(producer, "dependency_environment") as execute, self.assertRaisesRegex(SystemExit, "never removed"):
                    producer.run_audit()
                execute.assert_not_called()
                self.assertEqual(artifact.read_bytes(), b"actual prior evidence")
                with self.assertRaisesRegex(SystemExit, "NEW --output-dir"):
                    producer.configure_output(output)
                with self.assertRaisesRegex(SystemExit, "exact audit repository root"):
                    producer.configure_output(repo.parent / "outside-receipt-root")

    def test_disabled_names_cannot_hide_required_unknown_or_duplicate_tools(self):
        from audit_inventory import validate_disabled
        for disabled in [["typo"], ["health"], ["vcr_read", "vcr_read"]]:
            with self.subTest(disabled=disabled), self.assertRaises(SystemExit):
                validate_disabled({"health", "vcr_read"}, {"vcr_read"}, disabled)
        self.assertEqual(validate_disabled({"health", "vcr_read"}, {"vcr_read"}, ["vcr_read"]), {"vcr_read"})

    def test_optional_config_is_recorded_without_inventing_execution(self):
        import run_tool_audit as runner
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            server = SimpleNamespace(TOOL_DEFINITIONS=[{"name": "health"}, {"name": "vcr_read"}], OPTIONAL_TOOLS={"vcr_read"},
                                     list_tools=lambda: [{"name": "health"}], disabled_tools=lambda: {"vcr_read"},
                                     call_tool=lambda name, args: {"status": "success"})
            with patch.object(runner, "REPO", root), patch.object(runner, "load_server", return_value=server), patch.dict(runner.TASK_FIXTURES, {"health": {}, "vcr_read": {}}, clear=True), patch.dict(runner.SPECIALISTS, {}, clear=True), patch.object(sys, "argv", ["probe", "--probe-workspace", str(root / "ws"), "--output-dir", str(root / "out")]), contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(SystemExit) as raised:
                    runner.main()
                self.assertEqual(raised.exception.code, 0)
            result = json.loads((root / "out/tool-probe-v3.json").read_text())
            self.assertEqual(result["notOffered"], ["vcr_read"])
            self.assertEqual([row["tool"] for row in result["results"]], ["health"])
            self.assertEqual(result["toolAvailability"], [{"tool": "health", "state": "offered", "basis": "runtime-list-tools"}, {"tool": "vcr_read", "state": "notOffered", "basis": "explicit-deployment-disable"}])


class SourceCountsAreDerived(unittest.TestCase):
    """The catalog, its published summary and the connector registry agree.

    Run against the real catalog: a fixture here would prove that a fixture is
    self-consistent. The mutation cases below then perturb the summary the
    product publishes and require the checker to notice.
    """

    @classmethod
    def setUpClass(cls):
        # `public_sources` and its siblings import each other by their real
        # names, so the server has to put their directory on the path first --
        # the same order `verify_tools()` establishes in a real run.
        audit.load_module("evimed_release_tool_registry", audit.REPO / "runtime" / "mcp" / "evimed-research" / "server.py")
        cls.catalog = audit.load_module(
            "evimed_source_catalog_counts_test",
            audit.REPO / "runtime" / "mcp" / "evimed-research" / "source_catalog.py",
        )

    def test_no_count_in_the_audit_is_written_down(self):
        source = (HERE / "verify_release_audit.py").read_text(encoding="utf-8")
        body = source.split("def verify_sources")[1].split("\ndef ")[0]
        # The eleven literals that used to live here. Any bare integer other
        # than 0 in a comparison is the defect coming back.
        import re

        written = sorted({int(value) for value in re.findall(r"==\s*(\d+)", body)} - {0})
        self.assertEqual(written, [], "verify_sources compares against written-down counts: %s" % written)

    def test_the_real_catalog_reconciles_three_ways(self):
        summary = self.catalog.integration_summary()
        rows = self.catalog.sources()
        counted = Counter(str(item.get("connectionState")) for item in rows)
        self.assertGreater(len(rows), 0, "the catalog is empty; this test proved nothing")
        self.assertEqual(summary["reviewedTotal"], len(rows))
        self.assertEqual(dict(summary["connectionStateCounts"]), dict(counted))
        self.assertEqual(summary["notConnected"], len(rows) - summary["connectedPublic"] - summary["skillGuidanceOnly"])

    def _verify_sources_with(self, perturb):
        """Run the real `verify_sources()` over a perturbed summary."""
        real_load = audit.load_module

        def load(name, module_file):
            module = real_load(name, module_file)
            if Path(module_file).name == "source_catalog.py":
                summary = module.integration_summary()
                module.integration_summary = lambda: perturb(dict(summary))
            return module

        audit.load_module = load
        try:
            audit.verify_sources()
        finally:
            audit.load_module = real_load

    def test_the_checker_passes_on_the_catalog_as_it_stands(self):
        self._verify_sources_with(lambda summary: summary)

    def test_a_summary_that_miscounts_its_own_rows_is_caught(self):
        with self.assertRaises(SystemExit) as raised:
            self._verify_sources_with(lambda summary: {**summary, "reviewedTotal": summary["reviewedTotal"] + 1})
        self.assertIn("does not reconcile with the catalog", str(raised.exception))

    def test_a_state_moved_between_buckets_is_caught_even_though_the_total_holds(self):
        # The mutation the total cannot see: one source reclassified from
        # blocked-by-licence to blocked-by-approval. The sum is unchanged, so
        # only a per-state comparison against the rows notices.
        def reclassify(summary):
            states = dict(summary["connectionStateCounts"])
            states["blocked_license"] = states.get("blocked_license", 0) - 1
            states["blocked_approval"] = states.get("blocked_approval", 0) + 1
            return {**summary, "connectionStateCounts": states}

        with self.assertRaises(SystemExit) as raised:
            self._verify_sources_with(reclassify)
        self.assertIn("do not reconcile with the catalog rows", str(raised.exception))

    def test_adding_a_data_source_does_not_blow_the_audit_up(self):
        # The property the eleven literals cost: a catalog that grew by one, in
        # every count that describes it, is a legitimate change and not a
        # release blocker.
        def grow(summary):
            states = dict(summary["connectionStateCounts"])
            states["blocked_license"] = states.get("blocked_license", 0) + 1
            return {
                **summary,
                "reviewedTotal": summary["reviewedTotal"] + 1,
                "notConnected": summary["notConnected"] + 1,
                "connectionStateCounts": states,
            }

        # It still fails, because the *rows* did not grow -- which is the point:
        # the check is against the catalog, not against a number. The message
        # names the disagreement rather than a count nobody can interpret.
        with self.assertRaises(SystemExit) as raised:
            self._verify_sources_with(grow)
        self.assertIn("rows", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
