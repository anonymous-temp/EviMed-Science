#!/usr/bin/env python3
"""What the release audit says when its evidence has gone out of date.

Two defects, both reproduced against the real checker on 2026-09-10:

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

These tests are also the guard on the fix: they assert the window is not
widened and that a fresh probe covering too few tools is still refused.
"""

from __future__ import annotations

import contextlib
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

_spec = importlib.util.spec_from_file_location("evimed_release_audit_under_test", HERE / "verify_release_audit.py")
audit = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(audit)

REGISTRY = {"health", "literature_search", "web_search", "guideline_search"}


def probe(*, days_ago, tools, prefix=""):
    at = datetime.now(timezone.utc) - timedelta(days=days_ago)
    return {
        "schemaVersion": 3,
        "probedAt": at.isoformat().replace("+00:00", "Z"),
        "registered": len(tools),
        "results": [{"tool": "%s%s" % (prefix, name)} for name in tools],
    }


class ToolProbeCurrency(unittest.TestCase):
    def test_a_current_complete_probe_raises_nothing(self):
        audit.tool_probe_currency(probe(days_ago=1, tools=REGISTRY), REGISTRY, set())

    def test_the_window_is_fourteen_days_and_was_not_widened(self):
        # The probe cannot be refreshed without a live deployment, and widening
        # the window is the one repair that would make this green while proving
        # less. Pinned so that doing it is a test change somebody has to make on
        # purpose.
        self.assertEqual(audit.TOOL_PROBE_WINDOW_DAYS, 14)
        with self.assertRaises(SystemExit) as raised:
            audit.tool_probe_currency(probe(days_ago=15, tools=REGISTRY), REGISTRY, set())
        self.assertIn("the window is 14 days", str(raised.exception))

    def test_a_fresh_probe_that_covers_too_few_tools_is_still_refused(self):
        # The failure the old ordering hid: freshness alone is not currency.
        with self.assertRaises(SystemExit) as raised:
            audit.tool_probe_currency(probe(days_ago=0, tools={"health"}), REGISTRY, set())
        message = str(raised.exception)
        self.assertIn("the registry declares 4", message)
        self.assertIn("never probed", message)
        for name in REGISTRY - {"health"}:
            self.assertIn(name, message)

    def test_a_stale_undersized_probe_reports_both_reasons_at_once(self):
        with self.assertRaises(SystemExit) as raised:
            audit.tool_probe_currency(probe(days_ago=41, tools={"health"}), REGISTRY, set())
        message = str(raised.exception)
        self.assertIn("days ago", message)
        self.assertIn("the registry declares 4", message)
        self.assertIn("run_tool_audit.py", message)
        self.assertIn("no deployment reachable", message)

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
            audit.tool_probe_currency(probe(days_ago=41, tools=REGISTRY), REGISTRY, set())
        self.assertIn("tool-probe-v3.json", str(raised.exception))


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
                           summary="No fresh terminal managed job with verified artifacts was found.")
        return {
            "schemaVersion": 3,
            "probedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
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
        self.assertIn("No fresh terminal managed job", message)
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
