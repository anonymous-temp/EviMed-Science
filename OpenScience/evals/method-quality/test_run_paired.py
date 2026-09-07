"""Offline tests for the paired method-quality runner. No server, no model."""

import importlib.util
import json
import pathlib
import tempfile
import threading
import unittest


RUNNER_FILE = pathlib.Path(__file__).resolve().parent / "run_paired.py"
SPLITS_FILE = pathlib.Path(__file__).resolve().parent / "splits.json"


def load_runner():
    spec = importlib.util.spec_from_file_location("method_quality_run_paired", RUNNER_FILE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


runner = load_runner()


class FakeBackend(runner.Transport):
    """A control plane that never existed.

    Enough of the surface for a whole batch to complete without a container, a
    kernel or a model call, and it records every request body so a test can ask
    what the runner actually sent.
    """

    def __init__(self, briefs, outcomes, artifacts=None, tool_calls=None):
        self.prompts = {runner.brief_prompt(brief): brief_id for brief_id, brief in briefs.items()}
        self.outcomes = outcomes
        self.artifacts = artifacts or {}
        self.tool_calls = tool_calls or {}
        self.requests = []
        self.dispatches = []
        self.sessions = {}
        self.runs = {}
        self.counter = 0
        self.lock = threading.Lock()

    def _next(self, prefix):
        with self.lock:
            self.counter += 1
            return f"{prefix}_{self.counter:04d}"

    def request(self, method, url, body=None, headers=None, timeout=60):
        path = url.split("://", 1)[-1].split("/", 1)[-1]
        path = "/" + path.split("?", 1)[0]
        with self.lock:
            self.requests.append((method, path, json.dumps(body, ensure_ascii=False, sort_keys=True) if body is not None else ""))
        if path == "/api/auth/login":
            return 200, {"data": {"csrfToken": "csrf-token"}}, {"set-cookie": "session=fake; Path=/"}
        if path == "/api/ready":
            return 200, {"data": {"ok": True, "runtimeCompactionPolicy": "basic"}}, {}
        if path == "/api/projects" and method == "GET":
            return 200, {"data": []}, {}
        if path == "/api/projects" and method == "POST":
            return 200, {"data": {"id": body["id"]}}, {}
        if path == "/api/files/upload":
            return 200, {"data": {"path": body["filename"]}}, {}
        if path.startswith("/api/memory/records/"):
            return 200, {"data": {"id": path.rsplit("/", 1)[-1], "version": body["expectedVersion"] + 1}}, {}
        if path == "/api/commands/start_runtime":
            return 200, {"data": "http://fake-runtime.invalid/api/runtime"}, {}
        if path.endswith("/api/runtime/sessions") and method == "POST":
            return 200, {"data": {"id": self._next("ses")}}, {}
        if path.startswith("/api/research-sessions/"):
            return 200, {"data": {"ok": True}}, {}
        if path == "/api/agent-runs/dispatch":
            brief_id = self.prompts[body["text"]]
            arm = body["dispatchId"].split("_")[1]
            run_id = self._next("run")
            outcome = dict(self.outcomes[(brief_id, arm)])
            with self.lock:
                self.dispatches.append({"runId": run_id, "briefId": brief_id, "arm": arm, "sessionId": body["sessionId"]})
                self.sessions[body["sessionId"]] = (brief_id, arm)
                self.runs[run_id] = {"id": run_id, **outcome}
            return 200, {"data": {"id": run_id}}, {}
        if path == "/api/agent-runs":
            with self.lock:
                return 200, {"data": list(self.runs.values())}, {}
        if path.startswith("/api/runtime/sessions/") and path.endswith("/transcript"):
            session_id = path.split("/")[4]
            key = self.sessions.get(session_id)
            calls = self.tool_calls.get(key, [])
            messages = [{
                "parts": [
                    {"type": "tool", "tool": call["tool"], "state": {"status": "completed", "input": call["args"]}}
                    for call in calls
                ],
            }]
            return 200, {"data": {"messages": messages, "lastSeq": len(calls)}}, {}
        if path == "/api/commands/read_artifact":
            text = self.artifacts.get(body["path"])
            if text is None:
                return 404, {"code": "artifact_not_found"}, {}
            return 200, {"data": {"encoding": "utf8", "data": text}}, {}
        raise AssertionError(f"the fake backend was asked for an unmodelled route: {method} {path}")


def succeeded(**overrides):
    record = {
        "status": "succeeded",
        "errorCode": None,
        "durationMs": 600_000,
        "model": "deepseek/deepseek-v4-pro",
        "verification": None,
        "qualityNotices": [],
        "artifacts": ["deliverables/report.md"],
        "methodsLoaded": [],
        "methodsInvoked": [],
        "repairRounds": {"content": 0, "structural": 0},
        "compaction": [],
        "transcript": {"path": ".openscience/transcripts/run.jsonl", "completeness": "complete", "bytes": 10, "sha256": "a" * 64, "messages": 3},
    }
    record.update(overrides)
    return record


def failed(**overrides):
    return succeeded(status="failed", errorCode="runtime_session_error", artifacts=[], **overrides)


class Harness:
    """One temp directory holding a briefs file, a splits registry and a config."""

    def __init__(self, stack, brief_ids, families=None, candidate_records=None):
        self.root = pathlib.Path(tempfile.mkdtemp(dir=stack))
        families = families or {}
        self.briefs = {
            brief_id: {
                "id": brief_id,
                "title": f"标题 {brief_id}",
                "family": families.get(brief_id, brief_id.split("-")[0]),
                "inputs": {"question": f"question for {brief_id}"},
                "mustDo": ["deliver a report"],
                "mustNotDo": ["invent a citation"],
            }
            for brief_id in brief_ids
        }
        self.briefs_file = self.root / "briefs.json"
        self.briefs_file.write_text(json.dumps({"schemaVersion": "1.0.0", "capability": "test-capability", "briefs": list(self.briefs.values())}), encoding="utf-8")
        self.splits_file = self.root / "splits.json"
        self.splits_file.write_text(json.dumps({
            "schemaVersion": 1,
            "dev": {"briefs": list(brief_ids)},
            "holdout": {"briefs": ["held-001-secret"]},
            "regression": {"briefs": []},
            "chronological": {"briefs": []},
        }), encoding="utf-8")
        self.config_file = self.root / "config.json"
        self.config_file.write_text(json.dumps({
            "id": "unit",
            "capability": "test-capability",
            "briefsFile": str(self.briefs_file),
            "briefs": list(brief_ids),
            "repeats": 1,
            "seed": 7,
            "concurrency": 1,
            "margin": 0.02,
            "bootstrapSamples": 200,
            "timeoutMinutes": 1,
            "pollSeconds": 0,
            "budget": {"latencyCapMs": 1_800_000, "costCap": 10},
            "baseline": {"methodSnapshot": {"id": "baseline", "records": []}, "compactionPolicy": "basic"},
            "candidate": {
                "methodSnapshot": {"id": "candidate", "records": candidate_records if candidate_records is not None else [{"id": "mem_1", "status": "active", "expectedVersion": 1}]},
                "compactionPolicy": "basic",
            },
        }), encoding="utf-8")
        self.splits = runner.load_splits(self.splits_file)
        self.config = runner.load_config(self.config_file, self.splits)
        self.results_dir = self.root / "results"

    def make_runner(self, backend, references=None, judge_call=None):
        references = references or {}
        secrets = runner.all_secrets(references)

        def client_factory():
            client = runner.PlatformClient(runner.LeakGuardTransport(backend, secrets), "http://control.invalid")
            client.headers = {"X-Open-Science-CSRF": "csrf-token"}
            return client

        return runner.PairedRunner(
            self.config,
            self.briefs,
            references,
            client_factory,
            judge_call=judge_call,
            results_dir=self.results_dir,
            log=lambda _message: None,
            sleep=lambda _seconds: None,
        )


class ResumeTests(unittest.TestCase):
    def setUp(self):
        self.stack = tempfile.TemporaryDirectory()
        self.addCleanup(self.stack.cleanup)
        self.brief_ids = ["fam-001-a", "fam-002-b", "two-001-c"]
        self.harness = Harness(self.stack.name, self.brief_ids, families={"fam-001-a": "fam", "fam-002-b": "fam", "two-001-c": "two"})
        self.outcomes = {}
        for brief_id in self.brief_ids:
            self.outcomes[(brief_id, "baseline")] = succeeded()
            self.outcomes[(brief_id, "candidate")] = succeeded()

    def test_a_second_pass_measures_nothing_it_already_has_on_disk(self):
        first = FakeBackend(self.harness.briefs, self.outcomes)
        self.harness.make_runner(first).execute()
        self.assertEqual(len(first.dispatches), len(self.brief_ids) * 2)

        second = FakeBackend(self.harness.briefs, self.outcomes)
        resumed = self.harness.make_runner(second)
        cells = resumed.execute()
        self.assertEqual(second.dispatches, [])
        self.assertEqual(resumed.skipped, len(self.brief_ids) * 2)
        self.assertEqual(resumed.executed, 0)
        self.assertEqual(len(cells), len(self.brief_ids) * 2)

    def test_an_interrupted_batch_keeps_the_cells_it_finished_and_redoes_only_the_rest(self):
        partial = FakeBackend(self.harness.briefs, self.outcomes)
        plans = runner.plan_cells(self.harness.config, self.harness.briefs)
        client = self.harness.make_runner(partial).client_factory()
        runtime_url = client.start_runtime()
        finished = self.harness.make_runner(partial).run_cell(client, runtime_url, plans[0])
        runner.write_json_atomic(
            runner.cell_path(self.harness.results_dir, "unit", plans[0]["briefId"], plans[0]["arm"], plans[0]["repeat"]),
            finished,
        )

        rest = FakeBackend(self.harness.briefs, self.outcomes)
        second = self.harness.make_runner(rest)
        second.execute()
        self.assertEqual(second.skipped, 1)
        self.assertEqual(len(rest.dispatches), len(self.brief_ids) * 2 - 1)

    def test_a_cell_that_errored_is_written_down_and_measured_again_next_pass(self):
        broken = FakeBackend(self.harness.briefs, {})  # every dispatch fails to resolve an outcome
        first = self.harness.make_runner(broken)
        cells = first.execute()
        self.assertEqual(first.executed, len(self.brief_ids) * 2)
        self.assertTrue(all(cell["complete"] is False and cell["error"] for cell in cells))

        healthy = FakeBackend(self.harness.briefs, self.outcomes)
        second = self.harness.make_runner(healthy)
        second.execute()
        self.assertEqual(second.skipped, 0)
        self.assertEqual(len(healthy.dispatches), len(self.brief_ids) * 2)

    def test_a_changed_arm_invalidates_every_cell_measured_under_the_old_one(self):
        first = FakeBackend(self.harness.briefs, self.outcomes)
        self.harness.make_runner(first).execute()
        moved = Harness(self.stack.name, self.brief_ids, candidate_records=[{"id": "mem_2", "status": "archived", "expectedVersion": 4}])
        moved.results_dir = self.harness.results_dir
        second = FakeBackend(moved.briefs, self.outcomes)
        resumed = moved.make_runner(second)
        resumed.execute()
        # The baseline arm is unchanged and resumes; the candidate arm moved and
        # is measured again, because a report must not mix two experiments.
        self.assertEqual(resumed.skipped, len(self.brief_ids))
        self.assertEqual(len(second.dispatches), len(self.brief_ids))


class HiddenReferenceTests(unittest.TestCase):
    def setUp(self):
        self.stack = tempfile.TemporaryDirectory()
        self.addCleanup(self.stack.cleanup)
        self.brief_ids = ["fam-001-a", "fam-002-b"]
        self.harness = Harness(self.stack.name, self.brief_ids)
        self.reference = runner.HiddenReference("fam-001-a", pathlib.Path("hidden/fam-001-a.reference.json"), {
            "goldenTrace": [
                {"turn": 1, "tool": "evimed_search", "args": {"query": "empagliflozin"}, "returnDigest": "sha256:" + "b" * 64},
                {"turn": 2, "tool": "write", "args": {"path": "deliverables/report.md"}},
            ],
            "expectedArtifacts": [{"path": "deliverables/report.md", "sha256": "c" * 64}],
            "deterministicChecks": [
                {"id": "no-fabricated-dose", "class": "safety", "kind": "artifact_not_contains", "path": "deliverables/report.md", "expected": "每日三次 200 mg"},
            ],
        })
        self.references = {"fam-001-a": self.reference}

    def test_the_answer_key_is_never_part_of_a_request_the_runner_sends(self):
        outcomes = {(brief_id, arm): succeeded() for brief_id in self.brief_ids for arm in ("baseline", "candidate")}
        backend = FakeBackend(self.harness.briefs, outcomes, artifacts={"deliverables/report.md": "一份报告"})
        self.harness.make_runner(backend, references=self.references).execute()
        self.assertTrue(backend.dispatches)
        secrets = runner.all_secrets(self.references)
        self.assertIn("c" * 64, secrets)
        for method, path, body in backend.requests:
            for secret in secrets:
                self.assertNotIn(secret, body, f"{method} {path} carried a hidden-reference value")

    def test_a_brief_that_quotes_its_own_answer_key_fails_at_dispatch_instead_of_scoring(self):
        poisoned = dict(self.harness.briefs)
        poisoned["fam-001-a"] = {
            **poisoned["fam-001-a"],
            "mustDo": [f"produce the artifact with digest {'c' * 64}"],
        }
        self.harness.briefs = poisoned
        outcomes = {(brief_id, arm): succeeded() for brief_id in self.brief_ids for arm in ("baseline", "candidate")}
        backend = FakeBackend(poisoned, outcomes)
        with self.assertRaises(runner.HiddenReferenceLeak):
            self.harness.make_runner(backend, references=self.references).execute()

    def test_the_guard_covers_uploads_and_not_only_the_dispatch_body(self):
        guard = runner.LeakGuardTransport(FakeBackend(self.harness.briefs, {}), {"c" * 64})
        with self.assertRaises(runner.HiddenReferenceLeak):
            guard.request("POST", "http://control.invalid/api/files/upload", body={"filename": "f.txt", "data": "c" * 64})

    def test_a_hidden_reference_is_never_read_from_the_briefs_a_run_is_given(self):
        prompt = runner.brief_prompt(self.harness.briefs["fam-001-a"])
        self.assertNotIn("goldenTrace", prompt)
        self.assertNotIn("evimed_search", prompt)
        self.assertNotIn("c" * 64, prompt)


class VerdictTests(unittest.TestCase):
    def test_an_interval_entirely_above_zero_is_the_only_way_to_claim_better(self):
        self.assertEqual(runner.interval_verdict(0.01, 0.06, 0.02), "better")
        self.assertEqual(runner.interval_verdict(0.0, 0.06, 0.02), "non_inferior")

    def test_an_interval_inside_the_margin_but_touching_zero_is_non_inferior(self):
        self.assertEqual(runner.interval_verdict(-0.019, 0.03, 0.02), "non_inferior")

    def test_an_interval_that_spans_the_margin_is_inconclusive_and_never_a_pass(self):
        self.assertEqual(runner.interval_verdict(-0.05, 0.01, 0.02), "inconclusive")
        self.assertEqual(runner.interval_verdict(-0.02, 0.01, 0.02), "inconclusive")
        self.assertEqual(runner.interval_verdict(-0.30, -0.02, 0.02), "inconclusive")

    def test_an_interval_entirely_below_the_margin_is_worse(self):
        self.assertEqual(runner.interval_verdict(-0.09, -0.03, 0.02), "worse")

    def test_a_missing_interval_is_inconclusive_rather_than_a_silent_pass(self):
        self.assertEqual(runner.interval_verdict(None, None, 0.02), "inconclusive")

    def test_one_worse_dimension_makes_the_whole_comparison_worse(self):
        verdicts = {dimension: "better" for dimension in runner.DIMENSIONS}
        verdicts["safety"] = "worse"
        verdict, reasons = runner.overall_verdict(verdicts, {"evidenceCompleteness": [], "safety": []})
        self.assertEqual(verdict, "worse")
        self.assertTrue(any("safety" in reason for reason in reasons))

    def test_a_new_regression_failure_outranks_every_improvement(self):
        verdicts = {dimension: "better" for dimension in runner.DIMENSIONS}
        verdict, reasons = runner.overall_verdict(verdicts, {"evidenceCompleteness": ["geo-001:artifact:report.md"], "safety": []})
        self.assertEqual(verdict, "worse")
        self.assertIn("regression", reasons[0])

    def test_an_inconclusive_non_compensatory_dimension_blocks_a_better_primary(self):
        verdicts = {dimension: "non_inferior" for dimension in runner.DIMENSIONS}
        verdicts["taskUtility"] = "better"
        verdicts["safety"] = "inconclusive"
        verdict, _reasons = runner.overall_verdict(verdicts, {"evidenceCompleteness": [], "safety": []})
        self.assertEqual(verdict, "inconclusive")

    def test_a_better_primary_with_nothing_worse_is_better(self):
        verdicts = {dimension: "non_inferior" for dimension in runner.DIMENSIONS}
        verdicts["taskUtility"] = "better"
        verdict, _reasons = runner.overall_verdict(verdicts, {"evidenceCompleteness": [], "safety": []})
        self.assertEqual(verdict, "better")


class TurnCoverageTests(unittest.TestCase):
    def setUp(self):
        self.golden = [
            {"turn": 1, "tool": "evimed_search", "args": {"query": "empagliflozin"}},
            {"turn": 2, "tool": "read", "args": {"path": "sources/1.md"}},
            {"turn": 3, "tool": "write", "args": {"path": "deliverables/report.md"}},
        ]

    def test_it_names_the_turn_a_run_started_to_diverge(self):
        observed = [
            {"tool": "evimed_search", "args": {"query": "empagliflozin"}},
            {"tool": "write", "args": {"path": "deliverables/report.md"}},
        ]
        coverage = runner.turn_coverage(self.golden, observed)
        self.assertEqual(coverage["turns"], 3)
        self.assertEqual(coverage["firstDivergenceTurn"], 2)
        self.assertEqual(coverage["toolMatchedTurns"], 2)

    def test_an_extra_optional_argument_is_not_a_divergence(self):
        observed = [
            {"tool": "evimed_search", "args": {"query": "empagliflozin", "limit": 20}},
            {"tool": "read", "args": {"path": "sources/1.md"}},
            {"tool": "write", "args": {"path": "deliverables/report.md"}},
        ]
        coverage = runner.turn_coverage(self.golden, observed)
        self.assertEqual(coverage["argMatchedTurns"], 3)
        self.assertIsNone(coverage["firstDivergenceTurn"])

    def test_a_wrong_argument_is_a_tool_match_and_an_argument_miss(self):
        observed = [
            {"tool": "evimed_search", "args": {"query": "dapagliflozin"}},
            {"tool": "read", "args": {"path": "sources/1.md"}},
            {"tool": "write", "args": {"path": "deliverables/report.md"}},
        ]
        coverage = runner.turn_coverage(self.golden, observed)
        self.assertEqual(coverage["toolMatchedTurns"], 3)
        self.assertEqual(coverage["argMatchedTurns"], 2)

    def test_coverage_is_not_a_dimension_and_cannot_reach_a_verdict(self):
        self.assertNotIn(runner.TURN_COVERAGE_KEY, runner.DIMENSIONS)
        verdicts = {dimension: "non_inferior" for dimension in runner.DIMENSIONS}
        verdicts[runner.TURN_COVERAGE_KEY] = "worse"
        with self.assertRaises(runner.EvalError):
            runner.overall_verdict(verdicts, {"evidenceCompleteness": [], "safety": []})


class ReportTests(unittest.TestCase):
    def setUp(self):
        self.stack = tempfile.TemporaryDirectory()
        self.addCleanup(self.stack.cleanup)
        self.brief_ids = ["fam-001-a", "fam-002-b", "two-001-c", "three-001-d"]
        self.harness = Harness(
            self.stack.name,
            self.brief_ids,
            families={"fam-001-a": "fam", "fam-002-b": "fam", "two-001-c": "two", "three-001-d": "three"},
        )
        self.golden = [{"turn": 1, "tool": "write", "args": {"path": "deliverables/report.md"}}]
        self.references = {
            brief_id: runner.HiddenReference(brief_id, pathlib.Path(f"hidden/{brief_id}.reference.json"), {
                "goldenTrace": self.golden,
                "expectedArtifacts": [{"path": "deliverables/report.md"}],
                "deterministicChecks": [],
            })
            for brief_id in self.brief_ids
        }

    def _outcomes(self, baseline_status, candidate_status):
        outcomes = {}
        for brief_id in self.brief_ids:
            outcomes[(brief_id, "baseline")] = baseline_status()
            outcomes[(brief_id, "candidate")] = candidate_status()
        return outcomes

    def test_a_candidate_that_delivers_where_the_baseline_fails_reports_better(self):
        outcomes = self._outcomes(failed, succeeded)
        backend = FakeBackend(self.harness.briefs, outcomes, artifacts={"deliverables/report.md": "报告"},
                              tool_calls={(brief_id, "candidate"): [{"tool": "write", "args": {"path": "deliverables/report.md"}}] for brief_id in self.brief_ids})
        cells = self.harness.make_runner(backend, references=self.references).execute()
        report = runner.build_report(self.harness.config, cells)
        self.assertEqual(report["verdict"], "better")
        self.assertEqual(report["dimensions"]["taskUtility"]["candidateMean"], 1.0)
        self.assertEqual(report["dimensions"]["taskUtility"]["baselineMean"], 0.0)
        self.assertEqual(report["cells"]["scored"], len(self.brief_ids) * 2)

    def test_two_identical_arms_report_non_inferior_rather_than_a_win(self):
        outcomes = self._outcomes(succeeded, succeeded)
        backend = FakeBackend(self.harness.briefs, outcomes, artifacts={"deliverables/report.md": "报告"})
        cells = self.harness.make_runner(backend, references=self.references).execute()
        report = runner.build_report(self.harness.config, cells)
        self.assertEqual(report["verdict"], "non_inferior")
        self.assertEqual(report["dimensions"]["taskUtility"]["pairedMeanDiff"], 0.0)

    def test_the_report_carries_turn_coverage_as_a_diagnostic_and_not_as_a_dimension(self):
        outcomes = self._outcomes(succeeded, succeeded)
        backend = FakeBackend(
            self.harness.briefs, outcomes, artifacts={"deliverables/report.md": "报告"},
            tool_calls={(brief_id, "candidate"): [{"tool": "write", "args": {"path": "deliverables/report.md"}}] for brief_id in self.brief_ids},
        )
        cells = self.harness.make_runner(backend, references=self.references).execute()
        report = runner.build_report(self.harness.config, cells)
        coverage = report["diagnostics"][runner.TURN_COVERAGE_KEY]
        self.assertEqual(coverage["byArm"]["candidate"]["argRatioMean"], 1.0)
        self.assertEqual(coverage["byArm"]["baseline"]["argRatioMean"], 0.0)
        self.assertNotIn(runner.TURN_COVERAGE_KEY, report["dimensions"])
        # Perfect coverage on one arm and none on the other, and the verdict is
        # still driven by the seven dimensions alone.
        self.assertEqual(report["verdict"], "non_inferior")

    def test_a_run_with_an_incomplete_transcript_is_excluded_from_the_paired_analysis(self):
        outcomes = self._outcomes(succeeded, succeeded)
        outcomes[("fam-001-a", "candidate")] = succeeded(transcript={
            "path": ".openscience/transcripts/run.jsonl", "completeness": "partial",
            "bytes": 1, "sha256": "a" * 64, "messages": 1,
        })
        backend = FakeBackend(self.harness.briefs, outcomes, artifacts={"deliverables/report.md": "报告"})
        cells = self.harness.make_runner(backend, references=self.references).execute()
        report = runner.build_report(self.harness.config, cells)
        self.assertEqual([item["reason"] for item in report["cells"]["excluded"]], ["transcript_partial"])
        self.assertEqual(report["dimensions"]["taskUtility"]["interval"]["pairs"], len(self.brief_ids) - 1)

    def test_the_ledger_receipt_of_every_run_is_kept_with_the_cell(self):
        outcomes = self._outcomes(succeeded, lambda: succeeded(
            methodsLoaded=[{"name": "m", "digest": "sha256:" + "d" * 64}],
            methodsInvoked=[{"name": "m", "digest": "sha256:" + "d" * 64}],
            repairRounds={"content": 1, "structural": 0},
            compaction=[{"at": "2026-09-07T00:00:00Z", "seq": 12, "replaced": 4, "tokens": 40_000, "policy": "basic"}],
        ))
        backend = FakeBackend(self.harness.briefs, outcomes, artifacts={"deliverables/report.md": "报告"})
        cells = self.harness.make_runner(backend, references=self.references).execute()
        candidate = next(cell for cell in cells if cell["arm"] == "candidate")
        self.assertEqual(candidate["run"]["repairRounds"], {"content": 1, "structural": 0})
        self.assertEqual(candidate["run"]["compaction"][0]["tokens"], 40_000)
        self.assertEqual(candidate["run"]["methodsLoaded"][0]["digest"], "sha256:" + "d" * 64)
        self.assertEqual(candidate["scores"]["reuse"], 1.0)


class WholeFlowTests(unittest.TestCase):
    def test_a_batch_runs_from_login_to_report_without_a_server(self):
        stack = tempfile.TemporaryDirectory()
        self.addCleanup(stack.cleanup)
        brief_ids = ["fam-001-a", "two-001-b", "three-001-c"]
        harness = Harness(stack.name, brief_ids)
        outcomes = {(brief_id, arm): succeeded() for brief_id in brief_ids for arm in ("baseline", "candidate")}
        backend = FakeBackend(harness.briefs, outcomes, artifacts={"deliverables/report.md": "报告正文"})
        client = runner.PlatformClient(runner.LeakGuardTransport(backend, set()), "http://control.invalid")
        client.login("evimed", "not-a-real-password")
        self.assertEqual(client.headers["X-Open-Science-CSRF"], "csrf-token")
        self.assertEqual(client.headers["Cookie"], "session=fake")
        client.ensure_project("eval-project", "评测项目")
        client.scope_to_project("eval-project")
        client.upload("knowledge-base/fixture.txt", b"fixture bytes")
        self.assertIn(("POST", "/api/files/upload", '{"data": "Zml4dHVyZSBieXRlcw==", "encoding": "base64", "filename": "knowledge-base/fixture.txt"}'), backend.requests)
        self.assertEqual(client.readiness()["ok"], True)

        cells = harness.make_runner(backend).execute()
        report = runner.build_report(harness.config, cells, environment=client.readiness())
        self.assertEqual(report["cells"]["scored"], len(brief_ids) * 2)
        self.assertIn(report["verdict"], runner.VERDICTS)
        self.assertEqual(report["environment"]["runtimeCompactionPolicy"], "basic")

    def test_the_method_snapshot_is_applied_before_the_run_that_is_meant_to_use_it(self):
        stack = tempfile.TemporaryDirectory()
        self.addCleanup(stack.cleanup)
        harness = Harness(stack.name, ["fam-001-a"])
        outcomes = {("fam-001-a", arm): succeeded() for arm in ("baseline", "candidate")}
        backend = FakeBackend(harness.briefs, outcomes, artifacts={"deliverables/report.md": "报告"})
        harness.make_runner(backend).execute()
        order = [f"{method} {path}" for method, path, _body in backend.requests]
        patch_index = order.index("PATCH /api/memory/records/mem_1")
        dispatch_indexes = [index for index, entry in enumerate(order) if entry == "POST /api/agent-runs/dispatch"]
        self.assertTrue(any(index > patch_index for index in dispatch_indexes))

    def test_a_failed_snapshot_stops_the_arm_instead_of_measuring_the_wrong_state(self):
        stack = tempfile.TemporaryDirectory()
        self.addCleanup(stack.cleanup)
        harness = Harness(stack.name, ["fam-001-a"])
        outcomes = {("fam-001-a", arm): succeeded() for arm in ("baseline", "candidate")}
        backend = FakeBackend(harness.briefs, outcomes)
        original = backend.request

        def refuse_patch(method, url, body=None, headers=None, timeout=60):
            if "/api/memory/records/" in url:
                return 409, {"code": "memory_conflict"}, {}
            return original(method, url, body=body, headers=headers, timeout=timeout)

        backend.request = refuse_patch
        cells = harness.make_runner(backend).execute()
        candidate = next(cell for cell in cells if cell["arm"] == "candidate")
        self.assertIs(candidate["complete"], False)
        self.assertIn("memory_conflict", candidate["error"])
        self.assertEqual([entry["arm"] for entry in backend.dispatches], ["baseline"])


class UsageJoinTests(unittest.TestCase):
    def test_only_settled_rows_are_billed_to_a_run(self):
        with tempfile.TemporaryDirectory() as directory:
            export = pathlib.Path(directory) / "account.json"
            export.write_text(json.dumps({"tables": {"usage": [
                {"runId": "run_1", "status": "settled", "actualCost": "1.25", "cacheHitTokens": "10", "cacheMissTokens": "90", "outputTokens": "5"},
                {"runId": "run_1", "status": "reserved", "actualCost": "9.00"},
                {"runId": "run_1", "status": "settled", "actualCost": "0.75", "cacheHitTokens": "0", "cacheMissTokens": "10", "outputTokens": "1"},
            ]}}), encoding="utf-8")
            lookup = runner.load_usage_lookup(export)
            self.assertEqual(lookup("run_1")["cost"], 2.0)
            self.assertEqual(lookup("run_1")["calls"], 2)
            self.assertIsNone(lookup("run_absent"))

    def test_no_export_means_cost_is_unavailable_rather_than_zero(self):
        lookup = runner.load_usage_lookup(None)
        self.assertIsNone(lookup("run_1"))


class ScoringTests(unittest.TestCase):
    def test_a_mounted_method_that_is_never_invoked_scores_zero_reuse(self):
        run = succeeded(methodsLoaded=[{"name": "m", "digest": "sha256:" + "e" * 64}], methodsInvoked=[])
        scores = runner.score_cell(run, {"referenceAvailable": False}, None, {}, None)
        self.assertEqual(scores["reuse"], 0.0)

    def test_the_judge_can_only_lower_a_deterministic_score_never_raise_it(self):
        run = failed()
        judge = {"scores": {"usefulness": 5, "correctness": 5, "evidenceHandling": 5, "safetyFraming": 5}}
        scores = runner.score_cell(run, {"referenceAvailable": False}, judge, {}, None)
        self.assertEqual(scores["taskUtility"], 0.0)

    def test_a_safety_check_failure_zeroes_safety_whatever_else_passed(self):
        run = succeeded()
        deterministic = {"referenceAvailable": True, "passed": 3, "total": 4, "safetyFailures": ["no-fabricated-dose"], "completenessFailures": []}
        scores = runner.score_cell(run, deterministic, None, {}, None)
        self.assertEqual(scores["safety"], 0.0)
        self.assertEqual(scores["taskUtility"], 1.0)

    def test_efficiency_is_unavailable_rather_than_guessed_when_no_cap_is_pre_registered(self):
        self.assertIsNone(runner.score_cell(succeeded(), {"referenceAvailable": False}, None, {}, None)["efficiency"])

    def test_an_artifact_the_harness_could_not_read_is_an_error_not_a_failed_check(self):
        reference = runner.HiddenReference("b", pathlib.Path("x"), {
            "deterministicChecks": [{"id": "quote", "kind": "artifact_contains", "path": "deliverables/report.md", "expected": "证据"}],
        })

        def refuse(_path):
            raise runner.EvalError("read_artifact -> HTTP 500")

        result = runner.run_deterministic_checks(reference, succeeded(), refuse)
        self.assertEqual(result["checks"][0]["status"], "error")
        self.assertIn("HTTP 500", result["checks"][0]["message"])

    def test_an_unsupported_deterministic_check_is_an_error_not_a_pass(self):
        reference = runner.HiddenReference("b", pathlib.Path("x"), {
            "deterministicChecks": [{"id": "future", "kind": "semantic_vibes"}],
        })
        result = runner.run_deterministic_checks(reference, succeeded(), lambda _path: {})
        self.assertEqual(result["checks"][0]["status"], "error")
        self.assertEqual(result["passed"], 0)


class ClusteringTests(unittest.TestCase):
    def test_a_declared_family_is_used_and_recorded_as_declared(self):
        family, source = runner.brief_family({"id": "review-001-a", "family": "kidney-outcomes"}, "clinical-evidence-synthesis")
        self.assertEqual((family, source), ("kidney-outcomes", "declared"))

    def test_an_undeclared_brief_is_its_own_cluster_and_the_report_says_so(self):
        family, source = runner.brief_family({"id": "review-001-a"}, "clinical-evidence-synthesis")
        self.assertEqual((family, source), ("review-001-a", "brief-id"))

    def test_a_generated_brief_clusters_by_the_chain_it_was_generated_from(self):
        family, source = runner.brief_family({"id": "g-1", "generated": {"chain": "chain-7"}}, "meta-analysis")
        self.assertEqual((family, source), ("meta-analysis:chain-7", "generated-chain"))

    def test_the_report_names_how_every_cluster_was_decided(self):
        stack = tempfile.TemporaryDirectory()
        self.addCleanup(stack.cleanup)
        brief_ids = ["fam-001-a", "fam-002-b"]
        harness = Harness(stack.name, brief_ids, families={"fam-001-a": "declared-family"})
        outcomes = {(brief_id, arm): succeeded() for brief_id in brief_ids for arm in ("baseline", "candidate")}
        backend = FakeBackend(harness.briefs, outcomes, artifacts={"deliverables/report.md": "报告"})
        cells = harness.make_runner(backend).execute()
        report = runner.build_report(harness.config, cells)
        self.assertEqual(report["clustering"]["sourceCounts"], {"declared": 4})
        self.assertIn("declared-family", report["clustering"]["families"])
        self.assertIn("only as wide as that assumption", report["clustering"]["note"])


class BootstrapTests(unittest.TestCase):
    def test_the_interval_resamples_families_not_observations(self):
        differences = {"fam-a": [0.5, 0.5, 0.5], "fam-b": [-0.5, -0.5, -0.5], "fam-c": [0.0, 0.0, 0.0]}
        interval = runner.cluster_bootstrap(differences, 500, seed=3)
        self.assertEqual(interval["families"], 3)
        self.assertEqual(interval["pairs"], 9)
        self.assertLess(interval["low"], 0)
        self.assertGreater(interval["high"], 0)

    def test_one_family_yields_no_interval_and_says_why(self):
        interval = runner.cluster_bootstrap({"only": [0.1, 0.2]}, 500, seed=3)
        self.assertIsNone(interval["low"])
        self.assertIn("one cluster", interval["reason"])

    def test_the_same_seed_and_the_same_cells_give_the_same_interval(self):
        differences = {"a": [0.1, 0.2], "b": [-0.1], "c": [0.3]}
        first = runner.cluster_bootstrap(differences, 400, seed=11)
        second = runner.cluster_bootstrap(differences, 400, seed=11)
        self.assertEqual(first["low"], second["low"])
        self.assertEqual(first["high"], second["high"])


class SplitsRegistryTests(unittest.TestCase):
    def setUp(self):
        self.splits = runner.load_splits(SPLITS_FILE)

    def test_the_shipped_registry_keeps_dev_and_holdout_disjoint(self):
        self.assertEqual(set(self.splits["dev"]["briefs"]) & set(self.splits["holdout"]["briefs"]), set())
        self.assertTrue(self.splits["holdout"]["briefs"])

    def test_every_registered_brief_lands_where_the_published_rule_puts_it(self):
        pinned = {item["id"] for item in self.splits["regression"]["pinned"]}
        for brief_id in self.splits["holdout"]["briefs"]:
            self.assertLess(runner.split_bucket(brief_id), 40, brief_id)
        for brief_id in self.splits["dev"]["briefs"]:
            if brief_id in pinned:
                continue
            self.assertGreaterEqual(runner.split_bucket(brief_id), 40, brief_id)

    def test_a_regression_brief_is_runnable_on_every_cycle(self):
        self.assertTrue(set(self.splits["regression"]["briefs"]) <= set(self.splits["dev"]["briefs"]))

    def test_a_brief_a_method_was_distilled_from_may_not_be_in_the_holdout(self):
        distillation_input = {
            "schemaVersion": 1,
            "trigger": "repair_accepted",
            "briefIds": ["geo-001-suxiao-baseline", "grant-001-nsfc-general"],
        }
        for brief_id in distillation_input["briefIds"]:
            self.assertNotEqual(runner.split_of(self.splits, brief_id), "holdout", brief_id)
        leaked = {"briefIds": ["ms-003-effect-estimate-corrected-late"]}
        self.assertEqual(runner.split_of(self.splits, leaked["briefIds"][0]), "holdout")

    def test_a_config_naming_an_unregistered_brief_is_refused(self):
        stack = tempfile.TemporaryDirectory()
        self.addCleanup(stack.cleanup)
        harness = Harness(stack.name, ["fam-001-a"])
        config = json.loads(harness.config_file.read_text(encoding="utf-8"))
        config["briefs"] = ["never-registered-999"]
        harness.config_file.write_text(json.dumps(config), encoding="utf-8")
        with self.assertRaises(runner.EvalError):
            runner.load_config(harness.config_file, harness.splits)

    def test_two_identical_arms_are_refused_before_any_run_is_paid_for(self):
        stack = tempfile.TemporaryDirectory()
        self.addCleanup(stack.cleanup)
        harness = Harness(stack.name, ["fam-001-a"])
        config = json.loads(harness.config_file.read_text(encoding="utf-8"))
        config["candidate"] = config["baseline"]
        harness.config_file.write_text(json.dumps(config), encoding="utf-8")
        with self.assertRaises(runner.EvalError):
            runner.load_config(harness.config_file, harness.splits)


class JudgeTests(unittest.TestCase):
    def test_an_out_of_range_judge_score_is_refused_rather_than_clamped(self):
        with self.assertRaises(ValueError):
            runner.parse_judge_output('{"usefulness": 9, "correctness": 3, "evidenceHandling": 3, "safetyFraming": 3}')

    def test_a_fenced_json_reply_parses_and_carries_the_prompt_version(self):
        parsed = runner.parse_judge_output(
            '```json\n{"usefulness": 4, "correctness": 5, "evidenceHandling": 4, "safetyFraming": 5,'
            ' "issues": [], "rationale": "sound"}\n```'
        )
        self.assertEqual(parsed["scores"]["correctness"], 5)
        self.assertEqual(parsed["promptVersion"], runner.JUDGE_PROMPT_VERSION)

    def test_the_judge_prompt_carries_the_brief_and_never_a_reference_answer(self):
        brief = {"id": "b", "title": "t", "inputs": {"question": "q"}, "mustDo": ["x"], "mustNotDo": ["y"]}
        system, user = runner.build_judge_messages(brief, "交付正文")
        self.assertIn("untrusted data", system)
        self.assertIn("must not invent", system)
        self.assertNotIn("goldenTrace", user)

    def test_one_non_json_reply_is_retried_before_the_call_is_given_up_on(self):
        attempts = {"n": 0}

        def flaky(_system, _user):
            attempts["n"] += 1
            if attempts["n"] == 1:
                return "the model briefly lost JSON mode"
            return '{"usefulness": 3, "correctness": 3, "evidenceHandling": 3, "safetyFraming": 3}'

        parsed = runner.judge_delivery({"id": "b"}, "正文", flaky, sleep=lambda _seconds: None)
        self.assertEqual(attempts["n"], 2)
        self.assertEqual(parsed["scores"]["usefulness"], 3)


if __name__ == "__main__":
    unittest.main()
