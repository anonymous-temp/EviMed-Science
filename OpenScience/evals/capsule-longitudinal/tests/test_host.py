"""The host wrapper with an injected process runner and clock: the waits, the deletion that never raises, the capability probe, the browser
hand-over. No docker, no server, no browser."""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))
import host as hosting  # noqa: E402


class Clock:
    def __init__(self):
        self.t = 0.0

    def now(self):
        return self.t

    def sleep(self, seconds):
        self.t += seconds


def completed(stdout="", returncode=0, stderr=""):
    return subprocess.CompletedProcess([], returncode, stdout, stderr)


class Runner:
    """A `subprocess.run` that answers psql by a function of the query and records every other call."""

    def __init__(self, sql=lambda q: "", others=None):
        self.sql, self.others, self.calls = sql, others or {}, []

    def __call__(self, argv, input=None, capture_output=True, text=True, timeout=None):
        self.calls.append((argv, input))
        if argv[:2] == ["docker", "exec"] and "psql" in " ".join(argv):
            return completed(self.sql(input or ""))
        key = next((k for k in self.others if k in " ".join(argv)), None)
        return self.others[key](argv) if key else completed("")


def make(sql=lambda q: "", others=None, **config):
    clock = Clock()
    runner = Runner(sql, others)
    host = hosting.Host(hosting.HostConfig(public_url="https://example.invalid", runtime_image="img:1", **config), run=runner, sleep=clock.sleep, now=clock.now)
    return host, runner, clock


class Waits(unittest.TestCase):
    def test_memory_is_settled_after_a_completed_commit_with_none_pending_twice_running(self):
        answers = iter(["pending|1", "completed|1", "completed|1\npending|1", "completed|1", "completed|1"])
        host, _, clock = make(lambda q: next(answers))
        account = hosting.Account(host, "cl-x-1", "pw")
        info = host.wait_memory(account, "2026-10-25T00:00:00Z", grace=25, timeout=360, poll=6)
        self.assertTrue(info["settled"])
        self.assertEqual((info["completed"], info["pending"]), (1, 0))
        self.assertGreaterEqual(clock.t, 25 + 6 * 4)

    def test_memory_that_never_settles_is_reported_not_raised(self):
        host, _, clock = make(lambda q: "pending|1")
        info = host.wait_memory(hosting.Account(host, "cl-x-1", "pw"), "2026-10-25T00:00:00Z", timeout=60, poll=6)
        self.assertFalse(info["settled"])
        self.assertEqual(info["pending"], 1)
        self.assertGreaterEqual(clock.t, 60)

    def test_a_job_is_seen_then_finishes(self):
        answers = iter(["", "queued", "running", "completed"])
        host, _, _ = make(lambda q: next(answers))
        result = host.wait_job(hosting.Account(host, "cl-x-1", "pw"), "distill", appear=150, finish=600, poll=15)
        self.assertEqual((result["seen"], result["done"]), (True, True))
        self.assertEqual(result["states"], ["completed"])

    def test_a_job_that_never_appears_is_not_seen(self):
        host, _, _ = make(lambda q: "")
        result = host.wait_job(hosting.Account(host, "cl-x-1", "pw"), "distill", appear=60, finish=600, poll=15)
        self.assertEqual((result["seen"], result["done"]), (False, False))

    def test_the_evidence_wait_returns_as_soon_as_a_wanted_verdict_is_there(self):
        rows = iter(["follow-up|correction|r|q|conversation", "follow-up|correction|r|q|conversation\nfollow-up|adopt|r2|q2|conversation"])
        host, _, _ = make(lambda q: next(rows))
        found = host.wait_evidence(hosting.Account(host, "cl-x-1", "pw"), ("adopt",), timeout=100, poll=10)
        self.assertEqual([r["verdict"] for r in found], ["correction", "adopt"])


class Accounts(unittest.TestCase):
    def test_deleting_never_raises_and_says_whether_the_account_is_gone(self):
        host, runner, _ = make(lambda q: "0")
        account = hosting.Account(host, "cl-x-1", "pw")
        account.csrf = "tok"
        host.http = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("the server is down"))
        self.assertTrue(host.delete(account), "the ledger says it is gone")
        host2, _, _ = make(lambda q: "1")
        account2 = hosting.Account(host2, "cl-x-2", "pw")
        account2.csrf = "tok"
        host2.http = lambda *a, **k: hosting.Reply(500, {})
        self.assertFalse(host2.delete(account2), "still there: a leak")
        host3, _, _ = make(lambda q: (_ for _ in ()).throw(RuntimeError("sql")))
        host3.http = lambda *a, **k: hosting.Reply(200, {})
        self.assertFalse(host3.delete(hosting.Account(host3, "cl-x-3", "pw")), "unknown is not deleted")

    def test_deletion_stops_the_runtime_first_and_sends_the_account_delete_with_the_csrf_token(self):
        host, _, _ = make(lambda q: "0")
        sent = []
        host.http = lambda opener, method, route, data=None, csrf=None, project=None, timeout=120: (sent.append((method, route, csrf, data)), hosting.Reply(200, {"data": {"user": {"id": "cl-x-1"}}}))[1]
        account = hosting.Account(host, "cl-x-1", "pw")
        account.csrf = "tok"
        host.delete(account)
        routes = [(m, r) for m, r, _, _ in sent]
        self.assertEqual(routes[0], ("POST", "/api/commands/stop_runtime"))
        self.assertEqual(routes[-1], ("DELETE", "/api/account"))
        self.assertEqual(sent[-1][3], {"confirm": "cl-x-1", "password": "pw"})
        self.assertEqual(sent[-1][2], "tok")

    def test_a_project_is_made_by_the_products_route_and_the_header_names_it(self):
        host, _, _ = make()
        seen = []
        host.http = lambda opener, method, route, data=None, csrf=None, project=None, timeout=120: (seen.append((method, route, project)), hosting.Reply(200, {"data": {"id": "p9"}}))[1]
        account = hosting.Account(host, "cl-x-1", "pw")
        self.assertEqual(account.create_project("甲"), "p9")
        account.api("GET", "/api/memory/profile", project="p9")
        self.assertEqual(seen, [("POST", "/api/projects", None), ("GET", "/api/memory/profile", "p9")])


class Probes(unittest.TestCase):
    def test_the_capabilities_are_read_from_the_deployed_tree(self):
        others = {"node --input-type": lambda argv: completed(json.dumps(["correction", "preference", "rejection", "accept", "none", "adopt"])),
                  "grep -rl": lambda argv: completed("/app/apps/server/src/memoryImport.mjs\n")}
        caps = make(others=others)[0].capabilities()
        self.assertEqual(caps, {"adoptVerdict": True, "importRoute": True})

    def test_a_tree_without_them_says_false_and_an_unreadable_probe_says_nothing(self):
        others = {"node --input-type": lambda argv: completed(json.dumps(["correction", "none"])), "grep -rl": lambda argv: completed("", returncode=1)}
        self.assertEqual(make(others=others)[0].capabilities(), {"adoptVerdict": False, "importRoute": False})
        broken = {"node --input-type": lambda argv: completed("not json"), "grep -rl": lambda argv: completed("", returncode=2)}
        self.assertEqual(make(others=broken)[0].capabilities(), {"adoptVerdict": None, "importRoute": None})


class Browser(unittest.TestCase):
    def test_the_plan_is_handed_over_through_a_file_and_the_credentials_through_a_private_env_file(self):
        work = Path(tempfile.mkdtemp())
        seen = {}

        def docker_run(argv):
            env_file = argv[argv.index("--env-file") + 1]
            seen["mode"] = oct(Path(env_file).stat().st_mode & 0o777)
            seen["env"] = Path(env_file).read_text()
            seen["argv"] = argv
            (work / "s1-1-result.json").write_text(json.dumps({"turns": [{"label": "t1", "status": "succeeded"}]}))
            return completed("driver log")
        host, _, _ = make(others={"docker run": docker_run}, out_dir=work, secrets_dir=str(work))
        account = hosting.Account(host, "cl-x-1", "pw")
        result = host.browse(account, {"project": None, "newConversation": False, "steps": []}, "s1-1")
        self.assertEqual(result["turns"][0]["status"], "succeeded")
        self.assertEqual(seen["mode"], "0o600")
        self.assertIn("USERNAME=cl-x-1", seen["env"])
        self.assertNotIn("--network", " ".join(seen["argv"]), "the default bridge network: never --network host")
        self.assertEqual(list(work.glob("cl-env-*")), [], "the env file is deleted at once")
        self.assertEqual(json.loads((work / "s1-1-plan.json").read_text())["steps"], [])

    def test_a_driver_that_wrote_nothing_is_an_error_not_an_empty_success(self):
        work = Path(tempfile.mkdtemp())
        host, _, _ = make(others={"docker run": lambda argv: completed("", returncode=2, stderr="boom")}, out_dir=work, secrets_dir=str(work))
        result = host.browse(hosting.Account(host, "cl-x-1", "pw"), {"steps": []}, "s2-1")
        self.assertEqual(result["turns"], [])
        self.assertIn("wrote no result", result["error"])

    def test_the_driver_script_parses(self):
        done = subprocess.run(["node", "--check", str(HERE / "composer-driver.mjs")], capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)


if __name__ == "__main__":
    unittest.main()
