"""HTTP face of `vcr-engine`.

The control plane's `vcrEngineClient.mjs` speaks exactly these five routes
(build contract section 3.3):

    POST /jobs                 -> 202 {jobId, accepted}
    GET  /jobs/{id}            -> {jobId, state, progress:{done,total}, cpuSeconds}
    POST /jobs/{id}/cancel     -> {canceled: true}
    GET  /jobs/{id}/result     -> the full engine result
    GET  /health               -> {ok, engineVersion, rVersion, methods, packageLockHash}

Hidden knowledge:

- **Global concurrency is one, deliberately.** The production host is a
  four-core box shared with other products (plan 11.4). A second concurrent
  job would not halve anyone's wall clock, it would double both jobs' and make
  the CPU ceiling meaningless. When the engine moves to its own compute node
  the number becomes a config value; the interface does not change.
- **The CPU ceiling is an rlimit on the child, not a timer in the parent.** A
  wall-clock timer punishes a job for being descheduled by a noisy neighbour.
  `RLIMIT_CPU` counts the CPU the job actually used, sends SIGXCPU at the soft
  limit and SIGKILL at the hard one, and needs no supervision.
- **Cancel is a file plus a signal, in that order.** The file lets R finish
  the batch it is in and keep its checkpoint (AC-38); the signal is the
  fallback for a process that is wedged somewhere that never checks. A cancel
  that only sent a signal would throw away completed batches.
- **The queue is in memory and the results are on disk.** A restart loses
  queued jobs -- the control plane owns the ledger and re-queues them -- but it
  never loses a finished result or a checkpoint. Putting the queue in a
  database here would be a second source of truth about what is running.
- **No model, no network egress, no data volume.** The engine opens exactly
  the files a job names in `inputs[].location`. There is no client for
  anything in this process.
"""

from __future__ import annotations

import json
import os
import resource
import shutil
import signal
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from queue import Queue
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.responses import JSONResponse

ENGINE_ROOT = Path(os.environ.get("VCR_ENGINE_ROOT", Path(__file__).resolve().parent.parent))
WORK_ROOT = Path(os.environ.get("VCR_ENGINE_WORK_DIR", "/var/lib/vcr-engine/jobs"))
R_LIBS = os.environ.get("VCR_R_LIBS", "")
RSCRIPT = os.environ.get("VCR_RSCRIPT", "Rscript")
TOKEN = os.environ.get("VCR_ENGINE_TOKEN", "")
DEFAULT_CPU_SECONDS = float(os.environ.get("VCR_ENGINE_CPU_SECONDS", "600"))
MAX_CPU_SECONDS = float(os.environ.get("VCR_ENGINE_MAX_CPU_SECONDS", "3600"))
CORES = os.environ.get("VCR_ENGINE_CORES", "1")

TERMINAL = {"succeeded", "failed", "canceled", "not_estimable"}


@dataclass
class Job:
    job_id: str
    body: dict[str, Any]
    directory: Path
    state: str = "queued"
    cpu_limit: float = DEFAULT_CPU_SECONDS
    started_at: float | None = None
    finished_at: float | None = None
    pid: int | None = None
    error: str | None = None
    lock: threading.Lock = field(default_factory=threading.Lock)

    def progress(self) -> dict[str, Any]:
        path = self.directory / "progress.json"
        if not path.exists():
            return {"done": 0, "total": int(self.body.get("replicates") or 1)}
        try:
            return json.loads(path.read_text())
        except (OSError, json.JSONDecodeError):
            return {"done": 0, "total": int(self.body.get("replicates") or 1)}


class Engine:
    """One worker, one queue, results on disk."""

    def __init__(self) -> None:
        self.jobs: dict[str, Job] = {}
        self.queue: Queue[str] = Queue()
        self.lock = threading.Lock()
        self.current: str | None = None
        WORK_ROOT.mkdir(parents=True, exist_ok=True)
        self.worker = threading.Thread(target=self._run_forever, daemon=True)
        self.worker.start()

    def submit(self, body: dict[str, Any]) -> Job:
        job_id = str(body.get("jobId") or f"job_{uuid.uuid4().hex[:16]}")
        with self.lock:
            if job_id in self.jobs:
                raise HTTPException(status.HTTP_409_CONFLICT, detail="job_already_submitted")
            directory = WORK_ROOT / job_id
            directory.mkdir(parents=True, exist_ok=True)
            (directory / "job.json").write_text(json.dumps(body, ensure_ascii=False))
            cpu = float(body.get("cpuSecondsLimit") or DEFAULT_CPU_SECONDS)
            job = Job(job_id=job_id, body=body, directory=directory,
                      cpu_limit=min(cpu, MAX_CPU_SECONDS))
            self.jobs[job_id] = job
        self.queue.put(job_id)
        return job

    def get(self, job_id: str) -> Job:
        job = self.jobs.get(job_id)
        if job is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail="job_not_found")
        return job

    def cancel(self, job_id: str) -> bool:
        job = self.get(job_id)
        with job.lock:
            if job.state in TERMINAL:
                return False
            # The file first: R finishes its batch, writes its checkpoint and
            # returns `canceled` with whatever it completed.
            (job.directory / "CANCEL").write_text("1")
            job.state = "canceling"
            pid = job.pid
        if pid is not None:
            deadline = time.time() + 15
            while time.time() < deadline and job.state == "canceling":
                time.sleep(0.2)
            if job.state == "canceling":
                try:
                    os.kill(pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
        return True

    def result(self, job_id: str) -> dict[str, Any]:
        job = self.get(job_id)
        path = job.directory / "result.json"
        if not path.exists():
            raise HTTPException(status.HTTP_409_CONFLICT, detail="result_not_ready")
        return json.loads(path.read_text())

    def _run_forever(self) -> None:
        while True:
            job_id = self.queue.get()
            job = self.jobs.get(job_id)
            if job is None:
                continue
            if (job.directory / "CANCEL").exists():
                job.state = "canceled"
                continue
            self.current = job_id
            try:
                self._run(job)
            except Exception as exc:  # noqa: BLE001 - the queue must survive anything
                job.state = "failed"
                job.error = str(exc)
            finally:
                self.current = None
                job.finished_at = time.time()

    def _run(self, job: Job) -> None:
        env = dict(os.environ)
        env["VCR_ENGINE_ROOT"] = str(ENGINE_ROOT)
        env["VCR_ENGINE_CORES"] = CORES
        if R_LIBS:
            env["VCR_R_LIBS"] = R_LIBS
        limit = int(job.cpu_limit)

        def apply_limits() -> None:
            # Soft limit raises SIGXCPU, hard limit is a hard kill a little
            # later so a handler has room to write a checkpoint.
            resource.setrlimit(resource.RLIMIT_CPU, (limit, limit + 30))
            os.setsid()

        job.state = "running"
        job.started_at = time.time()
        proc = subprocess.Popen(
            [RSCRIPT, str(ENGINE_ROOT / "service" / "run_job.R"),
             str(job.directory / "job.json"), str(job.directory)],
            env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            preexec_fn=apply_limits,
        )
        job.pid = proc.pid
        _, err = proc.communicate()
        result_path = job.directory / "result.json"
        if result_path.exists():
            try:
                job.state = json.loads(result_path.read_text())["status"]
            except (OSError, json.JSONDecodeError, KeyError):
                job.state = "failed"
                job.error = "result.json was written but could not be read back"
        else:
            job.state = "canceled" if (job.directory / "CANCEL").exists() else "failed"
            job.error = (err or b"").decode("utf-8", "replace")[-4000:]


engine: Engine | None = None
app = FastAPI(title="vcr-engine", version="1.0.0")


def require_token(request: Request) -> None:
    if not TOKEN:
        return
    header = request.headers.get("authorization", "")
    if not header.startswith("Bearer ") or header[7:] != TOKEN:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="unauthorized")


def get_engine() -> Engine:
    global engine  # noqa: PLW0603 - one process, one queue
    if engine is None:
        engine = Engine()
    return engine


@app.get("/health")
def health() -> dict[str, Any]:
    out = subprocess.run(
        [RSCRIPT, "-e",
         'source(file.path(Sys.getenv("VCR_ENGINE_ROOT"), "R", "engine.R"));'
         'vcr_engine_load(Sys.getenv("VCR_ENGINE_ROOT"));'
         'cat(jsonlite::toJSON(vcr_engine_health(), auto_unbox = TRUE))'],
        env={**os.environ, "VCR_ENGINE_ROOT": str(ENGINE_ROOT), "VCR_R_LIBS": R_LIBS},
        capture_output=True, text=True, timeout=120,
    )
    if out.returncode != 0:
        return JSONResponse({"ok": False, "detail": out.stderr[-2000:]}, status_code=503)
    return json.loads(out.stdout)


@app.post("/jobs", status_code=status.HTTP_202_ACCEPTED)
async def submit(request: Request, _: None = Depends(require_token)) -> dict[str, Any]:
    body = await request.json()
    job = get_engine().submit(body)
    return {"jobId": job.job_id, "accepted": True}


@app.get("/jobs/{job_id}")
def state(job_id: str, _: None = Depends(require_token)) -> dict[str, Any]:
    job = get_engine().get(job_id)
    progress = job.progress()
    return {
        "jobId": job.job_id,
        "state": job.state,
        "progress": {"done": int(progress.get("done", 0)), "total": int(progress.get("total", 0))},
        "cpuSeconds": float(progress.get("cpuSeconds", 0.0)),
        "cpuSecondsLimit": job.cpu_limit,
        "error": job.error,
    }


@app.post("/jobs/{job_id}/cancel")
def cancel(job_id: str, _: None = Depends(require_token)) -> dict[str, Any]:
    return {"canceled": get_engine().cancel(job_id)}


@app.get("/jobs/{job_id}/result")
def result(job_id: str, _: None = Depends(require_token)) -> dict[str, Any]:
    return get_engine().result(job_id)


@app.delete("/jobs/{job_id}")
def discard(job_id: str, _: None = Depends(require_token)) -> dict[str, Any]:
    job = get_engine().get(job_id)
    if job.state not in TERMINAL:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="job_still_running")
    shutil.rmtree(job.directory, ignore_errors=True)
    get_engine().jobs.pop(job_id, None)
    return {"discarded": True}
