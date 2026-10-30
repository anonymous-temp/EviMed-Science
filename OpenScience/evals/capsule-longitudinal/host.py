"""The serving host, as the capsule longitudinal check meets it: throwaway accounts through the product's own HTTP API, a real browser
typing into the native composer, and read-only SQL on the control plane's database.

Hard-won facts this file encodes (2026-10-24, `live-memory-check-through-native-composer`; the reference run is `live6.py` with its two
browser scripts):

  * The follow-up judge and the turn commit fire only for a turn typed into the kernel's own composer: a message dispatched through
    the HTTP API into an existing session never reaches them, so every turn of every scenario is typed by a browser, inside the `/__evimed/f/` frame.
  * That browser runs from the runtime image (Chromium and playwright-core from its python package) on docker's DEFAULT bridge
    network, never `--network host`: on the host network Chromium sees `ERR_NETWORK_CHANGED` when a new runtime container adds its
    veth and the first open times out after 60 s.
  * `/app/chat` reopens the last conversation; 「新对话」 makes a new one. A project is selected by `openScience.projectId` in the tab's
    storage, which `composer-driver.mjs` sets before the page loads.
  * Account deletion cascades through the usage ledger, so spend is read before it. A runtime stop that lands just after the delete can
    recreate a file under the account's data directory: the driver stops the runtime first.

Everything that touches a process or the network goes through `Host`, whose `run` and `sleep` are injectable: the tests drive the
scenarios with a fake and never reach a server.
"""
from __future__ import annotations

import http.cookiejar
import json
import os
import secrets
import ssl
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse

HERE = Path(__file__).resolve().parent


@dataclass
class Reply:
    status: int
    body: object

    @property
    def ok(self) -> bool:
        return 200 <= self.status < 300

    @property
    def data(self):
        return self.body.get("data") if isinstance(self.body, dict) else None


@dataclass
class HostConfig:
    root: str = "/srv/evimed-science"
    web_container: str = "web-open-science-web-1"
    pg_container: str = "web-evimed-postgres-1"
    public_url: str | None = None
    runtime_image: str | None = None
    out_dir: Path = field(default_factory=lambda: HERE / "results" / "work")
    secrets_dir: str | None = None

    @property
    def env_file(self) -> str:
        return f"{self.root}/current/OpenScience/deploy/web/.env"


class Host:
    def __init__(self, config: HostConfig, run=subprocess.run, sleep=time.sleep, now=time.time):
        self.config, self._run, self.sleep, self.now = config, run, sleep, now
        self._public: str | None = config.public_url
        self._image: str | None = config.runtime_image

    # ------------------------------------------------------------------------------------------------------------------ plumbing
    def sh(self, argv: list[str], input: str | None = None, timeout: int = 600) -> subprocess.CompletedProcess:
        return self._run(argv, input=input, capture_output=True, text=True, timeout=timeout)

    @property
    def public_url(self) -> str:
        if self._public is None:
            values = {}
            for line in Path(self.config.env_file).read_text(encoding="utf-8").splitlines():
                if "=" in line and not line.lstrip().startswith("#"):
                    key, _, value = line.partition("=")
                    values[key] = value
            self._public = values["OPEN_SCIENCE_PUBLIC_URL"].rstrip("/")
        return self._public

    @property
    def runtime_image(self) -> str:
        if self._image is None:
            self._image = self.sh(["docker", "exec", self.config.web_container, "printenv", "OPEN_SCIENCE_RUNTIME_CONTAINER_IMAGE"]).stdout.strip()
            if not self._image:
                raise RuntimeError("the web container names no runtime image")
        return self._image

    def psql(self, query: str) -> str:
        out = self.sh(["docker", "exec", "-i", self.config.pg_container, "sh", "-c", 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -F"|"'], input=query)
        if out.stderr.strip():
            raise RuntimeError("sql: " + out.stderr.strip()[:200])
        return out.stdout.strip()

    def rows(self, query: str) -> list[list[str]]:
        text = self.psql(query)
        return [line.split("|") for line in text.splitlines() if line.strip()]

    # -------------------------------------------------------------------------------------------------------------------- http
    def opener(self):
        jar = http.cookiejar.CookieJar()
        return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar), urllib.request.HTTPSHandler(context=ssl.create_default_context()))

    def http(self, opener, method: str, route: str, data=None, csrf: str | None = None, project: str | None = None, timeout: int = 120) -> Reply:
        headers = {"Content-Type": "application/json", "Origin": self.public_url}
        if csrf:
            headers["x-open-science-csrf"] = csrf
        if project:
            headers["X-Open-Science-Project"] = project
        request = urllib.request.Request(self.public_url + route, None if data is None else json.dumps(data).encode(), headers, method=method)
        try:
            with opener.open(request, timeout=timeout) as response:
                raw = response.read()
                return Reply(response.status, json.loads(raw) if raw else {})
        except urllib.error.HTTPError as error:
            raw = error.read()
            try:
                body = json.loads(raw) if raw else {}
            except ValueError:
                body = {"raw": raw[:200].decode("utf-8", "replace")}
            return Reply(error.code, body)

    # ----------------------------------------------------------------------------------------------------------------- accounts
    def register(self, label: str) -> "Account":
        username = f"cl-{label}-{secrets.token_hex(4)}"
        account = Account(self, username, secrets.token_urlsafe(18))
        registered = self.http(self.opener(), "POST", "/api/auth/register", {"username": username, "password": account.password})
        if not registered.ok:
            raise RuntimeError(f"registering a throwaway account answered {registered.status}")
        account.login()
        return account

    def user_exists(self, username: str) -> bool:
        return self.psql(f"select count(*) from evimed_control.users where id='{username}';") != "0"

    def delete(self, account: "Account") -> bool:
        """Delete a throwaway account (what it learnt goes with it) and say whether it is gone. Never raises: a leak is a FAIL line."""
        try:
            account.stop_runtime()
        except Exception:  # noqa: BLE001
            pass
        try:
            if not account.csrf:
                account.login()
            me = account.api("GET", "/api/me").data or {}
            uid = (me.get("user") or {}).get("id") or me.get("id") or account.username
            # A 503 is the memory engine still finishing the account's last extraction or its own deletion: asked again, a few
            # times, before the account is called a leak (2026-10-27: three accounts read as leaks after one attempt each).
            for attempt in range(6):
                reply = account.api("DELETE", "/api/account", {"confirm": uid, "password": account.password})
                if reply.status != 503:
                    break
                time.sleep(20)
        except Exception:  # noqa: BLE001
            pass
        try:
            return not self.user_exists(account.username)
        except Exception:  # noqa: BLE001
            return False

    # ---------------------------------------------------------------------------------------------------------------- the browser
    def browse(self, account: "Account", plan: dict, name: str, timeout: int = 3300) -> dict:
        """Type the plan's turns into the account's native composer, in a real browser, and return what the driver recorded.
        The result file is written after every turn, so a turn that fails leaves the turns before it."""
        out = Path(self.config.out_dir)
        out.mkdir(parents=True, exist_ok=True)
        (out / f"{name}-plan.json").write_text(json.dumps(plan, ensure_ascii=False), encoding="utf-8")
        result_file = out / f"{name}-result.json"
        if result_file.exists():
            result_file.unlink()
        fd, env_path = tempfile.mkstemp(prefix="cl-env-", dir=self.config.secrets_dir)
        try:
            with os.fdopen(fd, "w") as handle:
                handle.write(f"BASE={self.public_url}\nUSERNAME={account.username}\nPASSWORD={account.password}\nPLAN=/out/{name}-plan.json\nRESULT=/out/{name}-result.json\n")
            os.chmod(env_path, 0o600)
            core = 'OPEN_SCIENCE_PLAYWRIGHT_CORE="$(python -c "import os, playwright; print(os.path.join(os.path.dirname(playwright.__file__), \\"driver\\", \\"package\\"))")" exec node /walk/driver.mjs'
            done = self.sh(["docker", "run", "--rm", "--env-file", env_path, "-v", f"{HERE}/composer-driver.mjs:/walk/driver.mjs:ro", "-v", f"{out}:/out",
                            "--entrypoint", "sh", self.runtime_image, "-c", core], timeout=timeout)
        finally:
            os.unlink(env_path)
        result = json.loads(result_file.read_text(encoding="utf-8")) if result_file.exists() else {"turns": [], "error": "the driver wrote no result"}
        result["log"] = (done.stdout or "")[-1500:]
        if done.returncode and not result.get("error"):
            result["error"] = f"the driver exited {done.returncode}: {(done.stderr or '')[-300:]}"
        return result

    # ------------------------------------------------------------------------------------------------------------------ waiting
    def wait_memory(self, account: "Account", since: str, grace: int = 25, timeout: int = 360, poll: int = 6) -> dict:
        """Wait for the turn commit and its extraction: a few seconds after an attended turn ends the control plane commits its
        conversation, and the engine's extraction settles it. Settled = at least one commit completed since `since` and none pending,
        twice running, after a grace period for the commit to be armed. Returns what the ledger says, never raises."""
        self.sleep(grace)
        deadline = self.now() + timeout
        quiet = 0
        info: dict = {"completed": 0, "pending": 0, "failed": 0, "settled": False}
        while self.now() < deadline:
            counts = {r[0]: int(r[1]) for r in self.rows(
                f"select state, count(*) from evimed_memory.native_commits where user_id='{account.username}' and created_at > '{since}'::timestamptz group by 1;")}
            info = {"completed": counts.get("completed", 0), "pending": counts.get("pending", 0), "failed": counts.get("failed", 0), "settled": False}
            quiet = quiet + 1 if info["completed"] >= 1 and info["pending"] == 0 else 0
            if quiet >= 2:
                info["settled"] = True
                return info
            self.sleep(poll)
        return info

    def wait_job(self, account: "Account", kind: str, appear: int = 150, finish: int = 1200, poll: int = 15) -> dict:
        """Wait for a job of this kind to be queued (up to `appear`) and then to leave the queue (up to `finish`)."""
        start = self.now()
        seen = False
        states: list[str] = []
        while self.now() - start < appear + finish:
            rows = self.rows(f"select status from evimed_product.jobs where user_id='{account.username}' and kind='{kind}' order by created_at;")
            states = [r[0] for r in rows]
            if states:
                seen = True
            busy = any(s in ("queued", "running", "leased", "pending") for s in states)
            if seen and not busy:
                return {"seen": True, "states": states, "done": True}
            if not seen and self.now() - start > appear:
                return {"seen": False, "states": [], "done": False}
            self.sleep(poll)
        return {"seen": seen, "states": states, "done": False}

    # ---------------------------------------------------------------------------------------------------------------- evidence
    def learning_evidence(self, account: "Account") -> list[dict]:
        rows = self.rows("select detail->>'evidence', coalesce(detail->>'verdict',''), left(coalesce(detail->>'rule',''),160), left(coalesce(detail->>'quote',''),120), "
                         f"coalesce(detail->>'scope','') from evimed_product.feedback_events where user_id='{account.username}' and trigger_kind='learning-evidence' order by occurred_at;")
        return [{"evidence": r[0], "verdict": r[1], "rule": r[2], "quote": r[3], "scope": r[4]} for r in rows]

    def wait_evidence(self, account: "Account", verdicts: tuple[str, ...], timeout: int = 150, poll: int = 10) -> list[dict]:
        deadline = self.now() + timeout
        rows: list[dict] = []
        while self.now() < deadline:
            rows = self.learning_evidence(account)
            if any(r["verdict"] in verdicts for r in rows):
                return rows
            self.sleep(poll)
        return rows

    def cost(self, account: "Account") -> list[list[str]]:
        return self.rows("select purpose, count(*), round(sum(coalesce(actual_cost, reserved_cost))::numeric, 4) from evimed_usage.model_requests "
                         f"where user_id='{account.username}' group by 1 order by 1;")

    def capabilities(self) -> dict:
        """What the deployed tree can do that a scenario waits on: the `adopt` verdict, the import route. None when it cannot be told."""
        out: dict = {"adoptVerdict": None, "importRoute": None}
        probe = self.sh(["docker", "exec", "-w", "/app/apps/server", self.config.web_container, "node", "--input-type=module", "-e",
                         "import { LEARNING_EVIDENCE_VERDICTS as v } from '@evimed/domain'; process.stdout.write(JSON.stringify(v))"])
        try:
            out["adoptVerdict"] = "adopt" in json.loads(probe.stdout)
        except ValueError:
            pass
        grep = self.sh(["docker", "exec", self.config.web_container, "grep", "-rl", "/api/memory/import", "/app/apps/server/src"])
        if grep.returncode in (0, 1):
            out["importRoute"] = bool(grep.stdout.strip())
        return out


class Account:
    """One throwaway account's HTTP session (cookie jar and CSRF token)."""

    def __init__(self, host: Host, username: str, password: str):
        self.host, self.username, self.password = host, username, password
        self.opener = host.opener()
        self.csrf: str | None = None
        self.projects: dict[str, str] = {}

    def login(self) -> None:
        reply = self.host.http(self.opener, "POST", "/api/auth/login", {"username": self.username, "password": self.password})
        if not reply.ok:
            raise RuntimeError(f"login answered {reply.status}")
        self.csrf = ((reply.data or {}).get("csrfToken")) if isinstance(reply.data, dict) else None

    def api(self, method: str, route: str, data=None, project: str | None = None) -> Reply:
        return self.host.http(self.opener, method, route, data, csrf=self.csrf, project=project)

    def create_project(self, name: str) -> str:
        reply = self.api("POST", "/api/projects", {"name": name})
        project = (reply.data or {}).get("id") if isinstance(reply.data, dict) else None
        if not reply.ok or not project:
            raise RuntimeError(f"creating a project answered {reply.status}")
        self.projects[name] = project
        return project

    def stop_runtime(self, project: str | None = None) -> None:
        self.api("POST", "/api/commands/stop_runtime", {}, project=project)
        for name, project_id in list(self.projects.items()):
            self.api("POST", "/api/commands/stop_runtime", {}, project=project_id)

    def memory_records(self, project: str | None = None) -> list[dict]:
        reply = self.api("GET", "/api/memory/profile", project=project)
        data = reply.data if isinstance(reply.data, dict) else {}
        return [r for r in data.get("records") or [] if isinstance(r, dict)]

    def profile(self, project: str | None = None) -> dict:
        reply = self.api("GET", "/api/memory/profile", project=project)
        return reply.data if isinstance(reply.data, dict) else {}


def host_from_args(args) -> Host:
    config = HostConfig(root=args.root, web_container=args.web_container, pg_container=args.pg_container, public_url=args.public_url,
                        runtime_image=args.runtime_image, out_dir=Path(args.work_dir), secrets_dir=args.secrets_dir)
    if config.public_url and urlparse(config.public_url).scheme not in ("http", "https"):
        raise SystemExit("--public-url must be an http(s) address")
    return Host(config)
