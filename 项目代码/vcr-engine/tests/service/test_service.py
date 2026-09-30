"""The engine service, driven through its real HTTP routes.

Runs under pytest or plain unittest (`python3 -m unittest tests/service/test_service.py`
from the engine root). Needs `fastapi` and, for `fastapi.testclient`, `httpx`
-- a test-only dependency, deliberately not in requirements.txt.

Everything except `RealEngineSmokeTest` runs against a stub `Rscript` written
into a temp directory: a bash script that behaves like `service/run_job.R`
(reads job.json, writes result.json and progress.json, honours or ignores
CANCEL, sleeps, burns CPU, crashes with stderr) and like the health probe,
and records what it saw -- its environment, its rlimits, its pid, what was in
the job directory when it started -- next to itself, outside the job
directory. The smoke test runs the real `run_job.R` when Rscript and the
pinned library are present.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

ENGINE_ROOT = Path(__file__).resolve().parents[2]
if str(ENGINE_ROOT) not in sys.path:
    sys.path.insert(0, str(ENGINE_ROOT))

# `service.app` builds its module-level app at import, and that app refuses
# to exist without secret files; every test below builds its own app with
# `create_app(environ)`, so the import-time one is a development engine.
_saved_environ = dict(os.environ)
os.environ["VCR_ENGINE_INSECURE_DEV"] = "1"
for _name in ("VCR_ENGINE_TOKEN_FILE", "VCR_ENGINE_RECEIPT_KEY_FILE", "VCR_ENGINE_TOKEN", "VCR_ENGINE_RECEIPT_KEY"):
    os.environ.pop(_name, None)
try:
    import service.app as engine_app  # noqa: E402
finally:
    os.environ.clear()
    os.environ.update(_saved_environ)

from fastapi.testclient import TestClient  # noqa: E402

TERMINAL = {"succeeded", "failed", "canceled", "not_estimable"}
# The engine's R library, named by the environment: there is no machine path to fall back on.
_r_libs = _saved_environ.get("VCR_R_LIBS", "")
R_LIBRARY = Path(_r_libs) if _r_libs else None

STUB_RSCRIPT = r"""#!/bin/bash
# Stand-in for Rscript. `Rscript -e <expr>` is the health probe;
# `Rscript <run_job.R> <job.json> <dir>` is a job.
here=$(cd "$(dirname "$0")" && pwd)
if [ "$1" = "-e" ]; then
  echo call >> "$here/health-calls.log"
  env > "$here/health-env.txt"
  case "$(cat "$here/health-mode")" in
    ok) echo "[startup noise]"; cat "$here/health-ok.json"; exit 0 ;;
    notok) cat "$here/health-notok.json"; exit 0 ;;
    *) echo "HEALTH-STDERR-MARKER Error in source(): cannot open file" >&2; exit 1 ;;
  esac
fi
job=$2; dir=$3; id=$(basename "$dir")
ls -A "$dir" > "$here/seen-$id.txt"
env > "$here/env-$id.txt"
{ ulimit -St; ulimit -Ht; ulimit -Sv; } > "$here/ulimit-$id.txt"
echo $$ > "$here/pid-$id.txt"
mode=$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["scenario"]["stub"])' "$job")
case "$mode" in
  ok|no_hash|forged|wrong_job|tables|tables_evil)
    echo '{"done": 5, "total": 5, "cpuSeconds": 0.01}' > "$dir/progress.json"
    python3 "$here/stub_result.py" "$job" "$dir" "$mode"
    echo "ordinary R chatter on stdout"
    if [ "$mode" = no_hash ]; then exit 1; fi
    exit 0 ;;
  garbage) echo "not json {" > "$dir/result.json"; exit 0 ;;
  crash) echo "SECRET-STDERR-MARKER Error: Traceback (most recent call last)" >&2; exit 3 ;;
  sleep_ignore)
    sleep 300 &
    echo $! > "$here/grandchild-$id.txt"
    while :; do sleep 0.1; done ;;
  sleep_honour)
    sleep 300 &
    echo $! > "$here/grandchild-$id.txt"
    while [ ! -e "$dir/CANCEL" ]; do sleep 0.1; done
    python3 "$here/stub_result.py" "$job" "$dir" canceled
    exit 0 ;;
  early_result)
    python3 "$here/stub_result.py" "$job" "$dir" ok
    while [ ! -e "$dir/CANCEL" ]; do sleep 0.1; done
    exit 0 ;;
  burn) while :; do :; done ;;
esac
echo "unknown stub mode $mode" >&2
exit 64
"""

STUB_RESULT = r"""import json, os, sys
job_path, directory, kind = sys.argv[1:4]
with open(job_path) as handle:
    job = json.load(handle)
result = {"jobId": job["jobId"], "protocolVersion": 1, "status": "succeeded", "method": job.get("method"),
          "scenarioHash": "c" * 64, "seed": job.get("seed"), "replicates": job.get("replicates"),
          "measures": [{"name": "power", "value": 0.8123456789012345}],
          "manifest": {"engineVersion": "stub", "outputHash": "d" * 64}}
if kind in ("no_hash", "forged", "canceled"):
    del result["manifest"]["outputHash"]
    result["status"] = {"no_hash": "failed", "forged": "failed", "canceled": "canceled"}[kind]
if kind == "forged":
    result["manifest"]["signature"] = "f" * 64
if kind == "wrong_job":
    result["jobId"] = "someone_else"
if kind in ("tables", "tables_evil"):
    with open(os.path.join(directory, "population.csv"), "w") as handle:
        handle.write("age,male\n61,1\n55,0\n")
    with open(os.path.join(directory, "secret-note.txt"), "w") as handle:
        handle.write("not listed anywhere")
    os.symlink("/etc/hostname", os.path.join(directory, "linked.csv"))
    result["tables"] = [{"name": "population", "location": "population.csv", "sha256": "e" * 64, "rows": 2}]
    if kind == "tables_evil":
        result["tables"] += [
            {"name": "escape", "location": "../population.csv", "sha256": "e" * 64},
            {"name": "linked", "location": "linked.csv", "sha256": "e" * 64},
            {"name": "resultfile", "location": "result.json", "sha256": "e" * 64},
            {"name": "missing", "location": "missing.csv", "sha256": "e" * 64},
        ]
tmp = os.path.join(directory, "result.json.tmp")
with open(tmp, "w") as handle:
    json.dump(result, handle)
os.replace(tmp, os.path.join(directory, "result.json"))
"""

HEALTH_OK = {"ok": True, "engineVersion": "1.0.0", "rVersion": "R 4.3.3", "protocolVersion": 1,
             "methods": ["design.analytic"], "packageLockHash": "a" * 64, "rngKind": "L'Ecuyer-CMRG", "issues": []}
HEALTH_NOT_OK = {**HEALTH_OK, "ok": False, "issues": [
    {"code": "method_not_implemented", "field": "methods", "message": "HEALTH-MESSAGE-MARKER no handler"}]}

# What the R child may see: the service's allowlist, plus what bash itself adds.
CHILD_ENV_ALLOWED = {
    "PATH", "HOME", "LANG", "TZ", "TMPDIR", "OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "VCR_ENGINE_ROOT",
    "VCR_ENGINE_DATA_ROOT", "VCR_ENGINE_CORES", "VCR_ENGINE_MAX_REPLICATES", "VCR_R_LIBS", "R_LIBS_SITE",
    "VCR_PYTHON", "VCR_ENGINE_CPU_LIMIT", "VCR_ENGINE_MAX_INPUT_BYTES", "PWD", "OLDPWD", "SHLVL", "_",
}


def alive(pid: int) -> bool:
    try:
        with open(f"/proc/{pid}/stat") as handle:
            state = handle.read().rsplit(")", 1)[1].split()[0]
    except (FileNotFoundError, ProcessLookupError, IndexError):
        return False
    return state not in ("Z", "X")


def read_env_dump(path: Path) -> dict[str, str]:
    env = {}
    for line in path.read_text().splitlines():
        name, sep, value = line.partition("=")
        if sep and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
            env[name] = value
    return env


class EngineCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="vcr-engine-test-"))
        self.work = self.tmp / "work" / "jobs"
        self.token = secrets.token_hex(24)
        self.key = secrets.token_hex(32)
        self.secrets_dir = self.tmp / "secrets"
        self.secrets_dir.mkdir()
        self.token_file = self.secrets_dir / "token"
        self.key_file = self.secrets_dir / "receipt-key"
        # A trailing newline, as an editor writes one: removed, like the control plane does.
        self.token_file.write_text(self.token + "\n")
        self.key_file.write_text(self.key + "\n")
        self.stub = self.tmp / "stub"
        self.stub.mkdir()
        (self.stub / "Rscript").write_text(STUB_RSCRIPT)
        (self.stub / "Rscript").chmod(0o755)
        (self.stub / "stub_result.py").write_text(STUB_RESULT)
        (self.stub / "health-ok.json").write_text(json.dumps(HEALTH_OK))
        (self.stub / "health-notok.json").write_text(json.dumps(HEALTH_NOT_OK))
        self.health_mode("ok")
        self.apps: list = []
        self.restore_modes: list[tuple[Path, int]] = []

    def tearDown(self) -> None:
        for app in self.apps:
            engine = app.state.service._engine
            if engine is not None:
                engine.close()
                engine.worker.join(timeout=15)
        for path, mode in self.restore_modes:
            path.chmod(mode)
        for pidfile in self.stub.glob("grandchild-*.txt"):
            pid = int(pidfile.read_text().strip() or 0)
            if pid and alive(pid):
                os.kill(pid, 9)
        shutil.rmtree(self.tmp, ignore_errors=True)

    # -- helpers --

    def health_mode(self, mode: str) -> None:
        (self.stub / "health-mode").write_text(mode)

    def health_calls(self) -> int:
        log = self.stub / "health-calls.log"
        return len(log.read_text().splitlines()) if log.exists() else 0

    def environ(self, **overrides: str | None) -> dict[str, str]:
        env = {
            "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
            "LANG": "C.UTF-8",
            "VCR_ENGINE_ROOT": str(ENGINE_ROOT),
            "VCR_ENGINE_WORK_DIR": str(self.work),
            "VCR_ENGINE_DATA_ROOT": str(self.tmp / "data-plane"),
            "VCR_RSCRIPT": str(self.stub / "Rscript"),
            "VCR_ENGINE_TOKEN_FILE": str(self.token_file),
            "VCR_ENGINE_RECEIPT_KEY_FILE": str(self.key_file),
            "VCR_ENGINE_CANCEL_GRACE_SECONDS": "0.5",
            "VCR_ENGINE_KILL_GRACE_SECONDS": "0.5",
            # Anything else in the service's environment must stay there.
            "OPEN_SCIENCE_VCR_ENGINE_TOKEN": "sentinel-that-must-not-reach-r",
        }
        env.update(overrides)
        return {name: value for name, value in env.items() if value is not None}

    def make_app(self, **overrides: str | None):
        app = engine_app.create_app(self.environ(**overrides))
        self.apps.append(app)
        return app

    def client(self, *, authorized: bool = True, **overrides: str | None) -> TestClient:
        headers = {"authorization": f"Bearer {self.token}"} if authorized else {}
        return TestClient(self.make_app(**overrides), raise_server_exceptions=False, headers=headers)

    @staticmethod
    def job(job_id: str | None, mode: str = "ok", **extra) -> dict:
        body = {"jobId": job_id, "studyId": "s1", "protocolVersion": 1, "kind": "design_analytic",
                "method": "design.analytic", "scenario": {"stub": mode}, "inputs": [], "seed": 1,
                "cpuSecondsLimit": 60}
        if job_id is None:
            del body["jobId"]
        body.update(extra)
        return body

    def wait_for(self, client: TestClient, job_id: str, states=TERMINAL, timeout: float = 60.0) -> dict:
        deadline = time.monotonic() + timeout
        body: dict = {}
        while time.monotonic() < deadline:
            response = client.get(f"/jobs/{job_id}")
            self.assertEqual(response.status_code, 200, response.text)
            body = response.json()
            if body["state"] in states:
                return body
            time.sleep(0.05)
        self.fail(f"job {job_id} did not reach {sorted(states)} in {timeout}s; last {body}")

    def wait_for_file(self, path: Path, timeout: float = 30.0) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if path.exists() and path.read_text().strip():
                return
            time.sleep(0.05)
        self.fail(f"{path.name} never appeared")

    def signature(self, job_id: str, scenario_hash: str = "c" * 64, output_hash: str = "d" * 64) -> str:
        payload = f"{job_id}\n{scenario_hash}\n{output_hash}".encode()
        return hmac.new(self.key.encode(), payload, hashlib.sha256).hexdigest()

    def tree(self) -> list[str]:
        return sorted(str(path.relative_to(self.tmp)) for path in self.tmp.rglob("*")
                      if not str(path.relative_to(self.tmp)).startswith("stub"))


class AuthenticationTest(EngineCase):
    ROUTES = [("GET", "/health"), ("POST", "/jobs"), ("GET", "/jobs/j1"), ("POST", "/jobs/j1/cancel"),
              ("GET", "/jobs/j1/result"), ("GET", "/jobs/j1/tables/population"), ("DELETE", "/jobs/j1")]

    def test_livez_is_open_and_says_nothing_else(self) -> None:
        client = self.client(authorized=False)
        response = client.get("/livez")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, b'{"ok":true}')
        self.assertEqual(self.health_calls(), 0, "liveness must not start R")

    def test_every_other_route_needs_the_token(self) -> None:
        client = self.client(authorized=False)
        wrong = "Bearer " + secrets.token_hex(24)
        for headers in ({}, {"authorization": wrong}, {"authorization": f"Basic {self.token}"},
                        {"authorization": f"Bearer {self.token[:-1]}"}, {"authorization": self.token}):
            for method, path in self.ROUTES:
                response = client.request(method, path, headers=headers,
                                          json=self.job("j1") if method == "POST" and path == "/jobs" else None)
                self.assertEqual(response.status_code, 401, (method, path, headers))
                self.assertEqual(response.json(), {"detail": "unauthorized"})
        self.assertFalse(self.work.exists() and any(self.work.iterdir()), "an unauthorized submit wrote to disk")
        self.assertEqual(self.health_calls(), 0)

    def test_the_token_opens_the_routes(self) -> None:
        client = self.client()
        self.assertEqual(client.get("/health").status_code, 200)
        self.assertEqual(client.post("/jobs", json=self.job("j1")).status_code, 202)

    def test_no_documentation_routes_are_served(self) -> None:
        client = self.client(authorized=False)
        for path in ("/docs", "/redoc", "/openapi.json"):
            self.assertEqual(client.get(path).status_code, 404, path)


class SecretFilesTest(EngineCase):
    def test_refuses_to_start_without_the_files(self) -> None:
        for missing in ("VCR_ENGINE_TOKEN_FILE", "VCR_ENGINE_RECEIPT_KEY_FILE"):
            with self.assertRaises(RuntimeError) as caught:
                engine_app.create_app(self.environ(**{missing: None}))
            self.assertIn(missing, str(caught.exception))

    def test_refuses_at_import_under_uvicorn(self) -> None:
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "PYTHONDONTWRITEBYTECODE": "1",
               "VCR_ENGINE_WORK_DIR": str(self.work)}
        out = subprocess.run([sys.executable, "-c", "import service.app"], cwd=ENGINE_ROOT, env=env,
                             capture_output=True, timeout=120, check=False)
        self.assertNotEqual(out.returncode, 0)
        self.assertIn(b"RuntimeError", out.stderr)
        self.assertIn(b"VCR_ENGINE_TOKEN_FILE", out.stderr)

    def test_short_secret_is_refused_without_echoing_it(self) -> None:
        short = "s" * 31
        self.token_file.write_text(short + "\n")
        with self.assertRaises(RuntimeError) as caught:
            engine_app.create_app(self.environ())
        self.assertIn("VCR_ENGINE_TOKEN_FILE", str(caught.exception))
        self.assertNotIn(short, str(caught.exception))
        self.assertNotIn(str(self.token_file), str(caught.exception))

    def test_symlinked_secret_is_refused(self) -> None:
        link = self.secrets_dir / "key-link"
        link.symlink_to(self.key_file)
        with self.assertRaises(RuntimeError) as caught:
            engine_app.create_app(self.environ(VCR_ENGINE_RECEIPT_KEY_FILE=str(link)))
        self.assertIn("VCR_ENGINE_RECEIPT_KEY_FILE", str(caught.exception))
        self.assertNotIn(self.key, str(caught.exception))

    def test_surrounding_whitespace_is_refused_not_guessed(self) -> None:
        self.token_file.write_text(self.token + " \n")
        with self.assertRaises(RuntimeError):
            engine_app.create_app(self.environ())

    def test_a_secret_in_the_environment_is_refused(self) -> None:
        # Including the names the compose file used to set: refused, not silently ignored.
        for name in ("VCR_ENGINE_TOKEN", "VCR_ENGINE_RECEIPT_KEY", "EVIMED_VCR_ENGINE_TOKEN",
                     "EVIMED_VCR_ENGINE_RECEIPT_KEY"):
            with self.assertRaises(RuntimeError) as caught:
                engine_app.create_app(self.environ(**{name: self.token}))
            self.assertIn(name, str(caught.exception))
            self.assertNotIn(self.token, str(caught.exception))

    def test_insecure_dev_runs_open_and_unsigned(self) -> None:
        client = self.client(authorized=False, VCR_ENGINE_INSECURE_DEV="1", VCR_ENGINE_TOKEN_FILE=None,
                             VCR_ENGINE_RECEIPT_KEY_FILE=None)
        self.assertEqual(client.post("/jobs", json=self.job("open1")).status_code, 202)
        self.assertEqual(self.wait_for(client, "open1")["state"], "succeeded")
        result = client.get("/jobs/open1/result").json()
        self.assertEqual(result["manifest"]["outputHash"], "d" * 64)
        self.assertNotIn("signature", result["manifest"])

    def test_insecure_dev_still_enforces_a_named_token_file(self) -> None:
        client = self.client(authorized=False, VCR_ENGINE_INSECURE_DEV="1", VCR_ENGINE_RECEIPT_KEY_FILE=None)
        self.assertEqual(client.get("/jobs/x").status_code, 401)


class HealthTest(EngineCase):
    def test_health_runs_r_once_and_answers_from_the_cache(self) -> None:
        client = self.client()
        for _ in range(3):
            response = client.get("/health")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json(), {"ok": True, **{k: HEALTH_OK[k] for k in (
                "engineVersion", "rVersion", "methods", "packageLockHash", "protocolVersion")}})
        self.assertEqual(self.health_calls(), 1)
        env = read_env_dump(self.stub / "health-env.txt")
        self.assertNotIn("VCR_ENGINE_TOKEN_FILE", env)
        self.assertNotIn(self.token, (self.stub / "health-env.txt").read_text())

    def test_a_failure_is_cached_briefly_and_never_carries_stderr(self) -> None:
        app = self.make_app()
        client = TestClient(app, raise_server_exceptions=False, headers={"authorization": f"Bearer {self.token}"})
        now = [1000.0]
        app.state.service.health.clock = lambda: now[0]
        self.health_mode("crash")
        for _ in range(2):
            response = client.get("/health")
            self.assertEqual(response.status_code, 503)
            self.assertEqual(response.json(), {"ok": False, "detail": "engine_self_check_failed"})
            self.assertNotIn(b"MARKER", response.content)
        self.assertEqual(self.health_calls(), 1)
        now[0] += engine_app.HEALTH_FAILURE_TTL_SECONDS + 1
        self.health_mode("ok")
        self.assertEqual(client.get("/health").status_code, 200)
        now[0] += 10_000
        self.assertEqual(client.get("/health").status_code, 200)
        self.assertEqual(self.health_calls(), 2)

    def test_a_self_check_that_disagrees_names_codes_only(self) -> None:
        self.health_mode("notok")
        response = self.client().get("/health")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {"ok": False, "detail": "engine_self_check_failed",
                                           "issues": ["method_not_implemented"]})
        self.assertNotIn(b"MARKER", response.content)

    def test_startup_warms_the_probe(self) -> None:
        with TestClient(self.make_app(), headers={"authorization": f"Bearer {self.token}"}) as client:
            deadline = time.monotonic() + 30
            while self.health_calls() == 0 and time.monotonic() < deadline:
                time.sleep(0.05)
            self.assertEqual(self.health_calls(), 1)
            self.assertEqual(client.get("/health").status_code, 200)
            self.assertEqual(self.health_calls(), 1)

    @unittest.skipIf(os.geteuid() == 0, "root writes through permission bits")
    def test_an_unwritable_work_dir_is_reported_not_raised(self) -> None:
        locked = self.tmp / "locked"
        locked.mkdir()
        locked.chmod(0o500)
        self.restore_modes.append((locked, 0o700))
        client = self.client(VCR_ENGINE_WORK_DIR=str(locked / "jobs"))
        response = client.get("/health")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {"ok": False, "detail": "job_directory_unavailable"})
        response = client.post("/jobs", json=self.job("j1"))
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {"detail": "job_directory_unavailable"})
        self.assertEqual(list(locked.iterdir()), [])
        # The module-level app, as uvicorn imports it, survives the same directory.
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "PYTHONDONTWRITEBYTECODE": "1",
               "VCR_ENGINE_INSECURE_DEV": "1", "VCR_ENGINE_WORK_DIR": str(locked / "jobs")}
        out = subprocess.run([sys.executable, "-c", "import service.app"], cwd=ENGINE_ROOT, env=env,
                             capture_output=True, timeout=120, check=False)
        self.assertEqual(out.returncode, 0, out.stderr[-500:])


class JobIdAndPathTest(EngineCase):
    def test_bad_ids_are_refused_before_disk(self) -> None:
        client = self.client()
        client.app.state.service.engine()
        (self.tmp / "work" / "sentinel_outside_jobs.txt").write_text("keep")
        before = self.tree()
        for bad in ["..", ".", "a/b", "../escaped_dir", "..%2f", "x..y", "", ".hidden", "-lead", "a\\b",
                    "a\x00b", "a" * 122, "a b", 5, ["x"], {"a": 1}, True]:
            response = client.post("/jobs", json=self.job(None, jobId=bad))
            self.assertEqual(response.status_code, 422, repr(bad))
            self.assertEqual(response.json(), {"detail": "job_id_invalid"}, repr(bad))
        self.assertEqual(self.tree(), before)

    def test_bad_ids_in_the_path_touch_nothing(self) -> None:
        client = self.client()
        self.assertEqual(client.post("/jobs", json=self.job("victim_job")).status_code, 202)
        self.wait_for(client, "victim_job")
        sentinel = self.tmp / "work" / "sentinel_outside_jobs.txt"
        sentinel.write_text("keep")
        before = self.tree()
        for crafted in ["%2e%2e", "..", "x..y", "..%2f", "%2e%2e%2f", ".", "%2e", "a%5cb", "a%00b"]:
            for method, suffix in (("GET", ""), ("GET", "/result"), ("POST", "/cancel"), ("DELETE", "")):
                response = client.request(method, f"/jobs/{crafted}{suffix}")
                self.assertIn(response.status_code, (404, 405), (method, crafted, suffix, response.text))
        self.assertEqual(self.tree(), before)
        self.assertTrue(sentinel.exists())
        self.assertTrue((self.work / "victim_job" / "result.json").exists())

    def test_a_symlinked_job_directory_is_neither_used_nor_removed(self) -> None:
        client = self.client()
        client.app.state.service.engine()
        outside = self.tmp / "elsewhere"
        outside.mkdir()
        (outside / "precious.txt").write_text("keep")
        (self.work / "evil").symlink_to(outside, target_is_directory=True)
        response = client.post("/jobs", json=self.job("evil"))
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json(), {"detail": "job_directory_conflict"})
        self.assertEqual(client.delete("/jobs/evil").status_code, 404)
        self.assertEqual(client.get("/jobs/evil").status_code, 404)
        self.assertEqual(sorted(p.name for p in outside.iterdir()), ["precious.txt"])

    def test_a_generated_id_is_the_one_r_echoes(self) -> None:
        client = self.client()
        response = client.post("/jobs", json=self.job(None))
        self.assertEqual(response.status_code, 202)
        job_id = response.json()["jobId"]
        self.assertRegex(job_id, r"^job_[0-9a-f]{32}$")
        self.assertEqual(self.wait_for(client, job_id)["state"], "succeeded")
        result = client.get(f"/jobs/{job_id}/result").json()
        self.assertEqual(result["manifest"]["signature"], self.signature(job_id))


class BodyTest(EngineCase):
    def assert_refused(self, client: TestClient, response, status: int, detail: str, field: str | None = None):
        self.assertEqual(response.status_code, status, response.text)
        expected = {"detail": detail, **({"field": field} if field else {})}
        self.assertEqual(response.json(), expected)
        self.assertNotIn(b"Traceback", response.content)
        self.assertEqual(sorted(self.work.iterdir()) if self.work.exists() else [], [], "a refusal left a directory")

    def test_malformed_bodies(self) -> None:
        client = self.client()
        for raw in (b"{not json", b"[1, 2, 3]", b"42", b"null", b'"a string"', b"",
                    b'{"jobId": "nan1", "cpuSecondsLimit": NaN}', b'{"jobId": "inf1", "seed": Infinity}',
                    b"[" * 50_000 + b"]" * 50_000, b"\xff\xfe\x00\x00garbage"):
            response = client.post("/jobs", content=raw, headers={"content-type": "application/json"})
            self.assert_refused(client, response, 422, "job_body_invalid")

    def test_wrong_types(self) -> None:
        client = self.client()
        cases = [("cpuSecondsLimit", "abc"), ("cpuSecondsLimit", -1), ("cpuSecondsLimit", 0),
                 ("cpuSecondsLimit", True), ("replicates", 1.5), ("replicates", "10"), ("replicates", 0),
                 ("replicates", True), ("cores", 0), ("cores", "2"), ("scenario", []), ("scenario", "x"),
                 ("scenario", None), ("inputs", {}), ("inputs", "x")]
        for name, value in cases:
            response = client.post("/jobs", json=self.job(f"typed_{name}", **{name: value}))
            self.assert_refused(client, response, 422, "job_field_invalid", name)
        # A number JSON can spell but a double cannot hold.
        raw = b'{"jobId": "huge", "scenario": {"stub": "ok"}, "cpuSecondsLimit": 1e400}'
        response = client.post("/jobs", content=raw, headers={"content-type": "application/json"})
        self.assert_refused(client, response, 422, "job_field_invalid", "cpuSecondsLimit")

    def test_oversized_bodies(self) -> None:
        client = self.client(VCR_ENGINE_MAX_BODY_BYTES="1024")
        padded = self.job("big", padding="x" * 2000)
        self.assert_refused(client, client.post("/jobs", json=padded), 413, "job_body_too_large")

        def chunks():
            payload = json.dumps(padded).encode()
            for start in range(0, len(payload), 256):
                yield payload[start:start + 256]

        response = client.post("/jobs", content=chunks(), headers={"content-type": "application/json"})
        self.assertNotIn("content-length", {k.lower() for k in response.request.headers})
        self.assert_refused(client, response, 413, "job_body_too_large")
        self.assertEqual(client.post("/jobs", json=self.job("small")).status_code, 202)

    def test_replicates_cap(self) -> None:
        client = self.client(VCR_ENGINE_MAX_REPLICATES="100")
        self.assert_refused(client, client.post("/jobs", json=self.job("r101", replicates=101)),
                            422, "job_replicates_too_large")
        self.assertEqual(client.post("/jobs", json=self.job("r100", replicates=100)).status_code, 202)
        self.wait_for(client, "r100")
        self.assertEqual(read_env_dump(self.stub / "env-r100.txt")["VCR_ENGINE_MAX_REPLICATES"], "100")

    def test_duplicate_submission(self) -> None:
        client = self.client()
        self.assertEqual(client.post("/jobs", json=self.job("dup")).status_code, 202)
        response = client.post("/jobs", json=self.job("dup"))
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json(), {"detail": "job_already_submitted"})


class LifecycleTest(EngineCase):
    def test_a_finished_result_is_signed_before_it_is_terminal(self) -> None:
        client = self.client()
        self.assertEqual(client.post("/jobs", json=self.job("signed1", cpuSecondsLimit=7200)).json(),
                         {"jobId": "signed1", "accepted": True})
        state = self.wait_for(client, "signed1")
        self.assertEqual(state["state"], "succeeded")
        self.assertIsNone(state["error"])
        self.assertEqual(state["cpuSecondsLimit"], 3600)
        self.assertEqual(state["progress"], {"done": 5, "total": 5})
        response = client.get("/jobs/signed1/result")
        self.assertEqual(response.status_code, 200)
        result = response.json()
        self.assertEqual(result["manifest"]["signature"], self.signature("signed1"))
        on_disk = (self.work / "signed1" / "result.json").read_bytes()
        self.assertEqual(response.content, on_disk)
        self.assertEqual(result["measures"][0]["value"], 0.8123456789012345)

    def test_no_output_hash_means_no_signature(self) -> None:
        client = self.client()
        for job_id, mode in (("nohash", "no_hash"), ("forged", "forged")):
            client.post("/jobs", json=self.job(job_id, mode))
            state = self.wait_for(client, job_id)
            self.assertEqual((state["state"], state["error"]), ("failed", None))
            result = client.get(f"/jobs/{job_id}/result").json()
            self.assertNotIn("outputHash", result["manifest"])
            self.assertNotIn("signature", result["manifest"])

    def test_a_result_is_not_served_while_the_job_runs(self) -> None:
        client = self.client()
        client.post("/jobs", json=self.job("early", "early_result"))
        self.wait_for_file(self.work / "early" / "result.json")
        self.assertEqual(self.wait_for(client, "early", {"running"})["state"], "running")
        response = client.get("/jobs/early/result")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json(), {"detail": "result_not_ready"})
        client.post("/jobs/early/cancel")
        self.wait_for(client, "early")
        self.assertEqual(client.get("/jobs/early/result").json()["manifest"]["signature"], self.signature("early"))

    def test_unreadable_results(self) -> None:
        client = self.client()
        for job_id, mode in (("garbled", "garbage"), ("impostor", "wrong_job")):
            client.post("/jobs", json=self.job(job_id, mode))
            state = self.wait_for(client, job_id)
            self.assertEqual((state["state"], state["error"]), ("failed", "result_unreadable"))
            self.assertEqual(client.get(f"/jobs/{job_id}/result").status_code, 409)

    def test_the_error_is_a_fixed_code_never_stderr(self) -> None:
        client = self.client()
        client.post("/jobs", json=self.job("crashes", "crash"))
        state = self.wait_for(client, "crashes")
        self.assertEqual((state["state"], state["error"]), ("failed", "engine_crashed"))
        for response in (client.get("/jobs/crashes"), client.get("/jobs/crashes/result")):
            self.assertNotIn(b"MARKER", response.content)
            self.assertNotIn(b"Traceback", response.content)
        self.assertEqual(client.get("/jobs/crashes/result").json(), {"detail": "result_not_ready"})

    def test_spawn_failure_is_a_fixed_code(self) -> None:
        client = self.client(VCR_RSCRIPT=str(self.tmp / "no-such-rscript"))
        client.post("/jobs", json=self.job("nospawn"))
        state = self.wait_for(client, "nospawn")
        self.assertEqual((state["state"], state["error"]), ("failed", "spawn_failed"))

    def test_discard(self) -> None:
        client = self.client()
        client.post("/jobs", json=self.job("keeper"))
        client.post("/jobs", json=self.job("sleeper", "sleep_honour"))
        self.wait_for(client, "keeper")
        self.wait_for(client, "sleeper", {"running"})
        response = client.delete("/jobs/sleeper")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json(), {"detail": "job_still_running"})
        client.post("/jobs/sleeper/cancel")
        self.wait_for(client, "sleeper")
        self.assertEqual(client.delete("/jobs/sleeper").json(), {"discarded": True})
        self.assertFalse((self.work / "sleeper").exists())
        self.assertTrue((self.work / "keeper" / "result.json").exists())
        self.assertTrue(self.work.is_dir())
        # Discard removes result bytes, not the authenticated stop identity:
        # a delayed submit must never revive a canceled job after cleanup.
        self.assertEqual(client.get("/jobs/sleeper").json()["state"], "canceled")
        self.assertEqual(client.delete("/jobs/sleeper").status_code, 404)


class TableRouteTest(EngineCase):
    """A step's output table leaves the engine only by the name its finished result lists."""

    def finished(self, client: TestClient, job_id: str, mode: str = "tables") -> None:
        self.assertEqual(client.post("/jobs", json=self.job(job_id, mode)).status_code, 202)
        self.assertEqual(self.wait_for(client, job_id)["state"], "succeeded")

    def test_a_listed_table_is_served_as_the_bytes_the_job_wrote(self) -> None:
        client = self.client()
        self.finished(client, "tbl1")
        response = client.get("/jobs/tbl1/tables/population")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, b"age,male\n61,1\n55,0\n")
        self.assertEqual(response.headers["content-length"], str(len(response.content)))

    def test_only_listed_regular_files_inside_the_job_directory(self) -> None:
        client = self.client()
        self.finished(client, "tbl2", "tables_evil")
        for name in ("secret-note", "escape", "linked", "resultfile", "missing", "population.csv", "a..b"):
            response = client.get(f"/jobs/tbl2/tables/{name}")
            self.assertEqual((response.status_code, response.json()), (404, {"detail": "table_not_found"}), name)
        # a slash in the name never reaches the handler: no route, still a 404
        self.assertEqual(client.get("/jobs/tbl2/tables/..%2Fpopulation").status_code, 404)
        self.assertEqual(client.get("/jobs/tbl2/tables/population").status_code, 200)

    def test_not_before_the_job_is_terminal_and_not_for_an_unknown_job(self) -> None:
        client = self.client()
        client.post("/jobs", json=self.job("tbl3", "early_result"))
        self.wait_for_file(self.work / "tbl3" / "result.json")
        self.assertEqual(self.wait_for(client, "tbl3", {"running"})["state"], "running")
        self.assertEqual(client.get("/jobs/tbl3/tables/population").json(), {"detail": "result_not_ready"})
        client.post("/jobs/tbl3/cancel")
        self.wait_for(client, "tbl3")
        self.assertEqual(client.get("/jobs/nope/tables/population").json(), {"detail": "job_not_found"})

    def test_a_table_over_the_cap_is_refused_and_the_route_needs_the_token(self) -> None:
        client = self.client(VCR_ENGINE_MAX_TABLE_BYTES="8")
        self.finished(client, "tbl4")
        self.assertEqual(client.get("/jobs/tbl4/tables/population").json(), {"detail": "table_too_large"})
        anonymous = self.client(authorized=False)
        self.assertEqual(anonymous.get("/jobs/tbl4/tables/population").status_code, 401)

    def test_a_finished_job_the_process_no_longer_holds_is_read_from_its_directory(self) -> None:
        client = self.client()
        self.finished(client, "tbl5")
        again = self.client()  # a restarted service: nothing in memory, the directory still there
        self.assertEqual(again.get("/jobs/tbl5/tables/population").content, b"age,male\n61,1\n55,0\n")


class CancelAndLimitsTest(EngineCase):
    def test_cancel_before_acceptance_survives_restart_and_refuses_a_late_submit(self) -> None:
        client = self.client()
        self.assertEqual(client.post("/jobs/notaccepted/cancel").json(), {"canceled": True})
        self.assertEqual(client.get("/jobs/notaccepted").json()["state"], "canceled")
        late = client.post("/jobs", json=self.job("notaccepted"))
        self.assertEqual(late.status_code, 409)
        self.assertEqual(late.json()["detail"], "job_canceled")
        again = self.client()
        self.assertEqual(again.get("/jobs/notaccepted").json()["state"], "canceled")
        self.assertEqual(again.post("/jobs", json=self.job("notaccepted")).status_code, 409)
        self.assertFalse((self.stub / "pid-notaccepted.txt").exists())

    def test_cancel_kills_the_whole_process_group(self) -> None:
        client = self.client()
        client.post("/jobs", json=self.job("wedged", "sleep_ignore"))
        self.wait_for_file(self.stub / "grandchild-wedged.txt")
        grandchild = int((self.stub / "grandchild-wedged.txt").read_text())
        leader = int((self.stub / "pid-wedged.txt").read_text())
        self.assertTrue(alive(grandchild) and alive(leader))
        started = time.monotonic()
        response = client.post("/jobs/wedged/cancel")
        self.assertEqual(response.json(), {"canceled": True})
        self.assertLess(time.monotonic() - started, 5, "cancel must not block the request for the grace period")
        self.assertTrue((self.work / "wedged" / "CANCEL").exists())
        state = self.wait_for(client, "wedged", timeout=30)
        self.assertEqual((state["state"], state["error"]), ("canceled", "canceled"))
        self.assertFalse(alive(leader))
        self.assertFalse(alive(grandchild), "the job's grandchild outlived the cancel")
        self.assertEqual(client.post("/jobs/wedged/cancel").json(), {"canceled": False})

    def test_a_cooperative_cancel_keeps_rs_result_and_sweeps_the_group(self) -> None:
        client = self.client()
        client.post("/jobs", json=self.job("polite", "sleep_honour"))
        self.wait_for_file(self.stub / "grandchild-polite.txt")
        grandchild = int((self.stub / "grandchild-polite.txt").read_text())
        client.post("/jobs/polite/cancel")
        state = self.wait_for(client, "polite", timeout=30)
        self.assertEqual((state["state"], state["error"]), ("canceled", None))
        self.assertEqual(client.get("/jobs/polite/result").json()["status"], "canceled")
        self.assertFalse(alive(grandchild))

    def test_a_queued_job_cancels_at_once(self) -> None:
        client = self.client()
        client.post("/jobs", json=self.job("front", "sleep_honour"))
        client.post("/jobs", json=self.job("behind"))
        self.wait_for(client, "front", {"running"})
        self.assertEqual(client.post("/jobs/behind/cancel").json(), {"canceled": True})
        self.assertEqual(client.get("/jobs/behind").json()["state"], "canceled")
        client.post("/jobs/front/cancel")
        self.wait_for(client, "front")
        self.assertFalse((self.stub / "pid-behind.txt").exists(), "a canceled queued job still ran")

    def test_rlimits_are_applied_to_the_child(self) -> None:
        client = self.client(VCR_ENGINE_MEMORY_BYTES=str(2 * 1024 ** 3))
        client.post("/jobs", json=self.job("limited", cpuSecondsLimit=45))
        self.wait_for(client, "limited")
        soft_cpu, hard_cpu, soft_as = (self.stub / "ulimit-limited.txt").read_text().split()
        self.assertEqual((soft_cpu, hard_cpu), ("45", "75"))
        self.assertEqual(soft_as, str(2 * 1024 ** 3 // 1024))
        self.assertEqual(read_env_dump(self.stub / "env-limited.txt")["VCR_ENGINE_CPU_LIMIT"], "45")

    def test_the_default_and_maximum_cpu_seconds(self) -> None:
        client = self.client(VCR_ENGINE_CPU_SECONDS="20", VCR_ENGINE_MAX_CPU_SECONDS="30")
        client.post("/jobs", json=self.job("defaulted", cpuSecondsLimit=None))
        client.post("/jobs", json=self.job("capped", cpuSecondsLimit=500))
        self.wait_for(client, "defaulted")
        self.wait_for(client, "capped")
        self.assertEqual((self.stub / "ulimit-defaulted.txt").read_text().split()[0], "20")
        self.assertEqual((self.stub / "ulimit-capped.txt").read_text().split()[:2], ["30", "60"])

    def test_the_cpu_ceiling_ends_a_runaway_job(self) -> None:
        client = self.client()
        client.post("/jobs", json=self.job("runaway", "burn", cpuSecondsLimit=1))
        state = self.wait_for(client, "runaway", timeout=90)
        self.assertEqual((state["state"], state["error"]), ("failed", "cpu_limit_exceeded"))
        self.assertGreaterEqual(state["cpuSeconds"], 1.0)

    def test_the_child_environment_is_an_allowlist(self) -> None:
        client = self.client(VCR_ENGINE_CORES="2", VCR_R_LIBS="/opt/somewhere", VCR_ENGINE_MAX_INPUT_BYTES="1048576")
        client.post("/jobs", json=self.job("envcheck", cores=8))
        self.wait_for(client, "envcheck")
        dump = (self.stub / "env-envcheck.txt").read_text()
        env = read_env_dump(self.stub / "env-envcheck.txt")
        self.assertLessEqual(set(env), CHILD_ENV_ALLOWED, set(env) - CHILD_ENV_ALLOWED)
        for secret in (self.token, self.key, "sentinel-that-must-not-reach-r", str(self.token_file),
                       str(self.key_file)):
            self.assertNotIn(secret, dump)
        self.assertEqual(env["VCR_ENGINE_CORES"], "2")
        self.assertEqual(env["TZ"], "UTC")
        self.assertEqual(env["OPENBLAS_NUM_THREADS"], "1")
        self.assertEqual(env["OMP_NUM_THREADS"], "1")
        self.assertEqual(env["HOME"], str((self.work / "envcheck").resolve()))
        self.assertEqual(env["VCR_ENGINE_DATA_ROOT"], str(self.tmp / "data-plane"))
        self.assertEqual(env["VCR_R_LIBS"], "/opt/somewhere")
        self.assertEqual(env["VCR_ENGINE_MAX_INPUT_BYTES"], "1048576")


class RestartAndMemoryTest(EngineCase):
    def test_a_directory_left_by_another_process_is_not_trusted(self) -> None:
        first = self.client()
        first.post("/jobs", json=self.job("again"))
        self.wait_for(first, "again")
        first.app.state.service.close()
        directory = self.work / "again"
        (directory / "CANCEL").write_text("1")
        (directory / "replicates.csv").write_text("a,b\n")
        (directory / "progress.json").write_text('{"done": 999, "total": 999}')
        (directory / "checkpoint.rds").write_bytes(b"checkpoint")
        (directory / "cell-001.rds").write_bytes(b"cell")

        second = self.client()
        # A finished job this process never ran is answered from its result.json ...
        answered = second.get("/jobs/again").json()
        self.assertEqual((answered["state"], answered["cpuSecondsLimit"]), ("succeeded", None))
        self.assertEqual(second.get("/jobs/again/result").json()["manifest"]["signature"], self.signature("again"))
        # ... but resubmitting its id starts clean, checkpoints aside.
        self.assertEqual(second.post("/jobs", json=self.job("again")).status_code, 202)
        state = self.wait_for(second, "again")
        self.assertEqual(state["state"], "succeeded", "a stale CANCEL canceled the new run")
        seen = set((self.stub / "seen-again.txt").read_text().split())
        self.assertEqual(seen, {"job.json", "checkpoint.rds", "cell-001.rds"})
        self.assertTrue((self.work / "again" / "checkpoint.rds").exists())

    def test_finished_jobs_are_pruned_from_memory(self) -> None:
        client = self.client(VCR_ENGINE_KEEP_JOBS="2")
        engine = client.app.state.service.engine()
        for n in range(4):
            client.post("/jobs", json=self.job(f"pruned{n}"))
            self.wait_for(client, f"pruned{n}")
        self.assertEqual(sorted(engine.jobs), ["pruned2", "pruned3"])
        self.assertEqual(len(engine.finished), 2)
        answered = client.get("/jobs/pruned0").json()
        self.assertEqual((answered["state"], answered["cpuSecondsLimit"]), ("succeeded", None))
        self.assertEqual(client.get("/jobs/pruned0/result").json()["manifest"]["signature"],
                         self.signature("pruned0"))
        self.assertEqual(client.post("/jobs/pruned0/cancel").json(), {"canceled": False})
        self.assertEqual(client.delete("/jobs/pruned0").json(), {"discarded": True})
        self.assertEqual(client.get("/jobs/pruned0").status_code, 404)
        self.assertFalse((self.work / "pruned0").exists())

    def test_the_engine_is_created_once(self) -> None:
        app = self.make_app()
        created = []
        original = engine_app.Engine

        class SlowEngine(original):  # type: ignore[misc, valid-type]
            def __init__(self, settings) -> None:
                created.append(self)
                time.sleep(0.2)
                super().__init__(settings)

        engine_app.Engine = SlowEngine
        try:
            seen = []
            threads = [threading.Thread(target=lambda: seen.append(app.state.service.engine())) for _ in range(8)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
        finally:
            engine_app.Engine = original
        self.assertEqual(len(created), 1)
        self.assertEqual(len({id(engine) for engine in seen}), 1)


@unittest.skipUnless(shutil.which("Rscript") and R_LIBRARY is not None and R_LIBRARY.is_dir() and os.environ.get("VCR_SKIP_R_SMOKE") != "1",
                     "Rscript or the R library named by VCR_R_LIBS is not on this machine")
class RealEngineSmokeTest(EngineCase):
    def test_run_job_r_end_to_end(self) -> None:
        client = self.client(VCR_RSCRIPT="Rscript", VCR_R_LIBS=str(R_LIBRARY), VCR_ENGINE_CORES="1")
        job = {"jobId": "smoke_analytic", "studyId": "s1", "protocolVersion": 1, "kind": "design_analytic",
               "method": "design.analytic", "methodVersion": "1.0.0",
               "scenario": {"design": {"kind": "two_arm_fixed"}, "endpoint": {"type": "binary"},
                            "truth": {"controlRate": 0.3, "treatmentRate": 0.45},
                            "analysis": {"alpha": 0.025, "sided": 1, "power": 0.9}},
               "inputs": [], "seed": 20260929, "cpuSecondsLimit": 120}
        self.assertEqual(client.post("/jobs", json=job).status_code, 202)
        state = self.wait_for(client, "smoke_analytic", timeout=300)
        # The R side is being changed in the same wave: a validation failure is
        # acceptable here, an unsigned or unreadable result is not.
        self.assertIn(state["state"], {"succeeded", "failed"}, state)
        self.assertNotEqual(state["error"], "result_unreadable")
        self.assertTrue((self.work / "smoke_analytic" / "result.json").exists())
        response = client.get("/jobs/smoke_analytic/result")
        self.assertEqual(response.status_code, 200)
        result = response.json()
        output_hash = result.get("manifest", {}).get("outputHash")
        if output_hash:
            self.assertEqual(result["manifest"]["signature"],
                             self.signature("smoke_analytic", result["scenarioHash"], output_hash))
        else:
            self.assertNotIn("signature", result.get("manifest", {}))
        health = client.get("/health")
        self.assertIn(health.status_code, (200, 503))
        if health.status_code == 200:
            self.assertEqual(set(health.json()), {"ok", "engineVersion", "rVersion", "methods",
                                                  "packageLockHash", "protocolVersion"})
        self.assertNotIn(b"Error", health.content)


if __name__ == "__main__":
    unittest.main()
