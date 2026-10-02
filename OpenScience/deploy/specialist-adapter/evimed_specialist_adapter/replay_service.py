"""Owned replay attempts on the existing specialist isolation/publication path.

Control-plane job JWTs use the existing workload signing secret and a separate
audience. An ordinary runtime token cannot admit a recipe. Durable scientific
job ownership remains in the control plane; these files track the adapter's
actual process and publication, including uncertain ownership after restart.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import signal
import site
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

from fastapi import Body, FastAPI, HTTPException, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from . import audit_receipt, deterministic_replay, isolated_job
from .security import _b64url_decode, _signing_secret

REPLAY_AUDIENCE = "evimed-result-replay"
_SAFE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}")
_JOB_ID = re.compile(r"(?:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|replay_[a-f0-9]{64}|replay-[a-z0-9-]{8,80})")
_DIGEST = re.compile(r"[a-f0-9]{64}")
_AUTH = HTTPBearer(auto_error=False)
TERMINAL = {"succeeded", "failed", "canceled", "timed_out", "ownership_unknown"}


def verify_replay_token(token: str, now_seconds: int | None = None) -> dict[str, Any]:
    try:
        if not isinstance(token, str) or len(token) > 8192:
            raise ValueError()
        header, body, signature = token.split(".")
        expected = base64.urlsafe_b64encode(hmac.new(_signing_secret().encode(), f"{header}.{body}".encode(), hashlib.sha256).digest()).decode().rstrip("=")
        value = json.loads(_b64url_decode(body))
        now = int(time.time()) if now_seconds is None else now_seconds
        if (not hmac.compare_digest(signature, expected) or json.loads(_b64url_decode(header)) != {"alg": "HS256", "typ": "JWT"}
                or not isinstance(value, dict) or set(value) != {"v", "aud", "userId", "projectId", "jobId", "recipeDigest", "iat", "exp", "jti"}
                or value["v"] != 1 or value["aud"] != REPLAY_AUDIENCE
                or not isinstance(value["userId"], str) or not _SAFE_ID.fullmatch(value["userId"])
                or not isinstance(value["projectId"], str) or not _SAFE_ID.fullmatch(value["projectId"])
                or not isinstance(value["jobId"], str) or not _JOB_ID.fullmatch(value["jobId"])
                or not isinstance(value["recipeDigest"], str) or not _DIGEST.fullmatch(value["recipeDigest"])
                or type(value["iat"]) is not int or type(value["exp"]) is not int
                or value["iat"] > now + 30 or value["exp"] <= now or not 0 < value["exp"] - value["iat"] <= 900
                or not isinstance(value["jti"], str) or not re.fullmatch(r"[A-Za-z0-9_-]{3,256}", value["jti"])):
            raise ValueError()
        return value
    except (ValueError, TypeError, KeyError, RuntimeError, OSError):
        raise HTTPException(401, detail="replay_job_token_required") from None


def replay_claims(credentials: HTTPAuthorizationCredentials | None = Security(_AUTH)) -> dict[str, Any]:
    if credentials is None or credentials.scheme.casefold() != "bearer":
        raise HTTPException(401, detail="replay_job_token_required")
    return verify_replay_token(credentials.credentials)


class ReplayJobs:
    def __init__(self, workspace_for_claims, *, timeout_seconds=300, cancel_grace_seconds=2):
        self.workspace_for_claims = workspace_for_claims
        self.timeout_seconds = timeout_seconds
        self.cancel_grace_seconds = cancel_grace_seconds
        self.lock = threading.RLock()
        self.running: dict[tuple, dict] = {}
        self.capacity = threading.BoundedSemaphore(1)

    def _scope(self, claims):
        workspace = self.workspace_for_claims(claims)
        root = Path(os.getenv("EVIMED_DATA_ROOT", "/data")).resolve()
        project = root / "users" / claims["userId"] / "projects" / claims["projectId"]
        # Project metadata is outside every active runtime workspace mount.
        with audit_receipt.directory_fd(project):
            pass
        return workspace, project

    def _read(self, project, claims):
        try:
            state = json.loads(audit_receipt._read_file(project, f".openscience/result-replays/{claims['jobId']}.json", 256 * 1024))
        except FileNotFoundError:
            raise HTTPException(404, detail="replay_job_not_found") from None
        if state.get("recipeDigest") != claims["recipeDigest"] or state.get("jobId") != claims["jobId"]:
            raise HTTPException(409, detail="replay_job_conflict")
        return state

    def _write(self, project, state, *, exclusive=False):
        # Pin the directory chain while creating/renaming, just as publication does.
        with audit_receipt.directory_fd(project) as root:
            with isolated_job._destination_directory(root, (".openscience", "result-replays")) as directory:
                name = f"{state['jobId']}.json"
                temporary = f".{name}.{secrets.token_hex(8)}"
                payload = deterministic_replay.canonical(state)
                if len(payload) > 256 * 1024:
                    raise ValueError("replay_state_too_large")
                descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
                try:
                    with os.fdopen(descriptor, "wb") as stream:
                        stream.write(payload); stream.flush(); os.fsync(stream.fileno())
                    if exclusive:
                        os.link(temporary, name, src_dir_fd=directory, dst_dir_fd=directory, follow_symlinks=False)
                    else:
                        os.replace(temporary, name, src_dir_fd=directory, dst_dir_fd=directory)
                finally:
                    try:
                        os.unlink(temporary, dir_fd=directory)
                    except FileNotFoundError:
                        pass

    def start(self, claims, recipe):
        try:
            recipe = deterministic_replay.validate_recipe(recipe)
        except ValueError:
            raise HTTPException(422, detail="replay_recipe_invalid") from None
        recipe_digest = deterministic_replay.digest(deterministic_replay.canonical(recipe))
        if recipe_digest != claims["recipeDigest"]:
            raise HTTPException(403, detail="replay_recipe_not_owned")
        workspace, project = self._scope(claims)
        key = (claims["userId"], claims["projectId"], claims["jobId"])
        with self.lock:
            try:
                return self.status(claims)
            except HTTPException as error:
                if error.status_code != 404:
                    raise
            # Reauthorization and hash checking happen before process creation.
            try:
                blob = audit_receipt._read_file(workspace, recipe["input"]["path"], deterministic_replay.MAX_INPUT_BYTES)
                if deterministic_replay.digest(blob) != recipe["input"]["sha256"]:
                    raise deterministic_replay.ReplayError("replay_input_changed")
                actual = deterministic_replay.manifest(recipe["method"])
                if actual["codeDigest"] != recipe["codeDigest"]:
                    raise deterministic_replay.ReplayError("replay_code_changed")
                if actual["environmentDigest"] != recipe["environmentDigest"]:
                    raise deterministic_replay.ReplayError("replay_environment_incompatible")
            except (OSError, ValueError) as error:
                raise HTTPException(422, detail=getattr(error, "code", "replay_input_unavailable")) from None
            if not self.capacity.acquire(blocking=False):
                raise HTTPException(503, detail="replay_engine_busy")
            state = {"schemaVersion": 1, "jobId": claims["jobId"], "recipeDigest": recipe_digest,
                     "state": "queued", "createdAt": time.time(), "updatedAt": time.time(), "cleanup": "pending"}
            owned = {"cancel": threading.Event(), "thread": None}
            try:
                self._write(project, state, exclusive=True)
                self.running[key] = owned
                thread = threading.Thread(target=self._execute, args=(key, owned, workspace, project, state, recipe, blob), daemon=True)
                owned["thread"] = thread
                thread.start()
            except FileExistsError:
                self.capacity.release(); return self.status(claims)
            except Exception:
                self.capacity.release(); self.running.pop(key, None); raise
            return self._public(state)

    def _execute(self, key, owned, workspace, project, state, recipe, blob):
        process = None
        try:
            with isolated_job.stage({}) as stage:
                input_file = isolated_job.hand_over(blob, "frozen-input.json", stage / "input")
                recipe_file = isolated_job.hand_over(deterministic_replay.canonical(recipe), "recipe.json", stage / "input")
                environment = {"PATH": os.getenv("PATH", "/usr/bin:/bin"), "PYTHONHASHSEED": "0",
                               "PYTHONPATH": os.pathsep.join([str(Path(__file__).resolve().parent.parent), site.getusersitepackages()]), "HOME": str(stage / "home"),
                               "TMPDIR": str(stage / "tmp"), "OMP_NUM_THREADS": "1", "OPENBLAS_NUM_THREADS": "1"}
                for spec in deterministic_replay.METHODS.values():
                    if spec["environment"] in os.environ:
                        environment[spec["environment"]] = os.environ[spec["environment"]]
                command = [sys.executable, "-m", "evimed_specialist_adapter.deterministic_replay", "--recipe", str(recipe_file),
                           "--input", str(input_file), "--output", str(stage / "output" / "result.json")]
                with (stage / "execution.log").open("wb") as log:
                    process = subprocess.Popen(command, cwd=stage, env=environment, stdin=subprocess.DEVNULL,
                                               stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                    state.update(state="running", updatedAt=time.time()); self._write(project, state)
                    deadline = time.monotonic() + self.timeout_seconds
                    canceled, timed_out = False, False
                    while not os.waitid(os.P_PID, process.pid, os.WEXITED | os.WNOWAIT | os.WNOHANG):
                        if owned["cancel"].is_set() or time.monotonic() >= deadline:
                            canceled = owned["cancel"].is_set(); timed_out = not canceled
                            os.killpg(process.pid, signal.SIGTERM)
                            grace = time.monotonic() + self.cancel_grace_seconds
                            while time.monotonic() < grace and not os.waitid(os.P_PID, process.pid, os.WEXITED | os.WNOWAIT | os.WNOHANG):
                                time.sleep(0.01)
                            break
                        time.sleep(0.01)
                    # The leader is unreaped, so the process group cannot have
                    # been reused when any remaining children are killed.
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    return_code = process.wait(timeout=5)
                if canceled or timed_out:
                    state.update(state="canceled" if canceled else "timed_out", error="replay_canceled" if canceled else "replay_timeout")
                elif return_code != 0:
                    diagnostic = (stage / "execution.log").read_text(errors="replace")[-1024:].strip().splitlines()
                    code = diagnostic[-1] if diagnostic and re.fullmatch(r"replay_[a-z_]{1,80}", diagnostic[-1]) else "replay_execution_failed"
                    state.update(state="failed", error=code)
                else:
                    output = json.loads(audit_receipt._read_file(stage / "output", "result.json", 8 * 1024 * 1024))
                    receipt = output["receipt"]
                    if (receipt["recipeDigest"] != state["recipeDigest"]
                            or receipt["outputDigest"] != deterministic_replay.digest(deterministic_replay.canonical(output["result"]))):
                        raise ValueError("replay_result_mismatch")
                    with audit_receipt.directory_fd(workspace) as root:
                        with isolated_job._destination_directory(root, ("result-replays", state["jobId"], "output")):
                            pass
                    output_root = workspace / "result-replays" / state["jobId"] / "output"
                    artifacts = isolated_job.publish(stage / "output", output_root, workspace)
                    state.update(state="succeeded", artifacts=artifacts, receipt=receipt,
                                 machineValues=output["machineValues"],
                                 resultPath=f"result-replays/{state['jobId']}/output/result.json")
            state.update(cleanup="unknown" if stage.exists() else "confirmed", finishedAt=time.time(), updatedAt=time.time()); self._write(project, state)
        except Exception:
            cleanup = "confirmed"
            if process is not None and process.returncode is None:
                try:
                    os.killpg(process.pid, signal.SIGKILL); process.wait(timeout=5)
                except (OSError, subprocess.TimeoutExpired):
                    cleanup = "unknown"
            state.update(state="failed", error="replay_execution_failed", cleanup=cleanup, finishedAt=time.time(), updatedAt=time.time())
            try:
                self._write(project, state)
            except (OSError, ValueError):
                pass
        finally:
            with self.lock:
                self.running.pop(key, None)
            self.capacity.release()

    def status(self, claims):
        _, project = self._scope(claims)
        key = (claims["userId"], claims["projectId"], claims["jobId"])
        with self.lock:
            state = self._read(project, claims)
            if state["state"] not in TERMINAL and key not in self.running:
                # Restart is not proof the worker stopped; never launch again.
                state.update(state="ownership_unknown", cleanup="unknown", error="replay_process_ownership_unknown")
            return self._public(state)

    def cancel(self, claims):
        key = (claims["userId"], claims["projectId"], claims["jobId"])
        _, project = self._scope(claims)
        with self.lock:
            owned = self.running.get(key)
            if owned:
                owned["cancel"].set()
            else:
                try:
                    self._read(project, claims)
                except HTTPException as error:
                    if error.status_code != 404:
                        raise
                    # A timed-out HTTP start may still be scheduled. Reserve
                    # the canceled identity so its late admission cannot run.
                    canceled = {"schemaVersion": 1, "jobId": claims["jobId"], "recipeDigest": claims["recipeDigest"],
                                "state": "canceled", "cleanup": "confirmed", "createdAt": time.time(), "updatedAt": time.time()}
                    try:
                        self._write(project, canceled, exclusive=True)
                    except FileExistsError:
                        pass
        if owned:
            owned["thread"].join(timeout=self.cancel_grace_seconds + 7)
        return self.status(claims)

    @staticmethod
    def _public(state):
        return {key: value for key, value in state.items() if key not in {"createdAt", "updatedAt", "finishedAt"}}


def install_replay_routes(instance: FastAPI, workspace_for_claims, *, manager=None):
    jobs = manager or ReplayJobs(workspace_for_claims)

    @instance.get("/api/v1/evimed/result-replays/capabilities")
    def capabilities(claims: dict = Security(replay_claims)):
        jobs._scope(claims)
        methods = []
        for method in deterministic_replay.METHODS:
            try:
                methods.append({"available": True, **deterministic_replay.manifest(method)})
            except deterministic_replay.ReplayError as error:
                methods.append({"method": method, "available": False, "reason": error.code})
        return {"schemaVersion": 1, "methods": methods}

    @instance.post("/api/v1/evimed/result-replays")
    def start(body: dict = Body(...), claims: dict = Security(replay_claims)):
        if set(body) != {"jobId", "recipe"} or body["jobId"] != claims["jobId"]:
            raise HTTPException(422, detail="replay_job_invalid")
        return jobs.start(claims, body["recipe"])

    @instance.get("/api/v1/evimed/result-replays/{job_id}")
    def status(job_id: str, claims: dict = Security(replay_claims)):
        if job_id != claims["jobId"]:
            raise HTTPException(403, detail="replay_job_not_owned")
        return jobs.status(claims)

    @instance.post("/api/v1/evimed/result-replays/{job_id}/cancel")
    def cancel(job_id: str, claims: dict = Security(replay_claims)):
        if job_id != claims["jobId"]:
            raise HTTPException(403, detail="replay_job_not_owned")
        return jobs.cancel(claims)

    return jobs
