"""HTTP face of `vcr-engine`.

The control plane's `vcrEngineClient.mjs` speaks exactly these routes
(integration contract section 3.5):

    GET    /livez               -> {"ok": true}                     no token, nothing else
    GET    /health              -> {ok, engineVersion, rVersion, methods, packageLockHash, protocolVersion}
    POST   /jobs                -> 202 {jobId, accepted}
    GET    /jobs/{id}           -> {jobId, state, progress:{done,total}, cpuSeconds, cpuSecondsLimit, error}
    POST   /jobs/{id}/cancel    -> {canceled}
    GET    /jobs/{id}/result    -> the full engine result, receipt signed
    GET    /jobs/{id}/tables/{name} -> one table the finished result lists, as the bytes the job wrote
    DELETE /jobs/{id}           -> {discarded: true}

Every refusal is `{"detail": "<fixed code>"}` (plus `field` for
`job_field_invalid`): 401 unauthorized, 404 job_not_found, 409
job_already_submitted / job_canceled / job_still_running / result_not_ready /
job_directory_conflict, 413 job_body_too_large / table_too_large, 404 table_not_found, 422 job_body_invalid /
job_id_invalid / job_field_invalid / job_replicates_too_large, 503
job_directory_unavailable / engine_self_check_failed. A job's `error` is
one of engine_crashed, cpu_limit_exceeded, memory_limit_exceeded, canceled,
result_unreadable, spawn_failed. No response ever carries R's stderr or a
Python traceback: the stderr tail goes to this process's log.

Configuration (environment; secrets only ever as files):

    VCR_ENGINE_TOKEN_FILE, VCR_ENGINE_RECEIPT_KEY_FILE   required, >= 32 bytes, no symlink
    VCR_ENGINE_INSECURE_DEV=1       lets either file be missing (open routes / unsigned results)
    VCR_ENGINE_WORK_DIR=/jobs       VCR_ENGINE_DATA_ROOT=/data-plane (handed to R, read-only)
    VCR_ENGINE_ROOT, VCR_R_LIBS, VCR_RSCRIPT=Rscript, VCR_PYTHON (the parquet bridge's python)
    VCR_ENGINE_CPU_SECONDS=600      a job's default; VCR_ENGINE_MAX_CPU_SECONDS=3600 caps any job
    VCR_ENGINE_CORES=1              the ceiling a job's `cores` can only lower
    VCR_ENGINE_MAX_REPLICATES=200000, VCR_ENGINE_MEMORY_BYTES=0 (RLIMIT_AS when > 0)
    VCR_ENGINE_MAX_INPUT_BYTES (unset: R's own cap on one input file)
    VCR_ENGINE_MAX_TABLE_BYTES=536870912 (the largest output table this service will hand out)
    VCR_ENGINE_MAX_BODY_BYTES=8 MiB, VCR_ENGINE_KEEP_JOBS=500 (finished jobs held in memory)
    VCR_ENGINE_CANCEL_GRACE_SECONDS=15, VCR_ENGINE_KILL_GRACE_SECONDS=5 (CANCEL -> SIGTERM -> SIGKILL)

Hidden knowledge:

- **Global concurrency is one, deliberately.** The production host is a
  four-core box shared with other products (plan 11.4). A second concurrent
  job would not halve anyone's wall clock, it would double both jobs' and make
  the CPU ceiling meaningless. When the engine moves to its own compute node
  the number becomes a config value; the interface does not change.
- **The CPU ceiling is an rlimit on the child, not a timer in the parent.** A
  wall-clock timer punishes a job for being descheduled by a noisy neighbour.
  `RLIMIT_CPU` counts the CPU the job actually used. R is told the limit
  (`VCR_ENGINE_CPU_LIMIT`) and stops itself at 0.9 of it with its partial
  result; SIGXCPU at the soft limit and SIGKILL at the hard one are for a
  job that never reached a checkpoint.
- **Cancel is a file, then signals to the process group, in that order.** The
  file lets R finish the batch it is in and keep its checkpoint (AC-38); the
  signals are the fallback for a process wedged somewhere that never checks.
  They go to the group, because a job that forked (a parallel worker, a
  bridge) must not outlive its cancel.
- An authenticated cancellation also retains a signed marker beside job
  directories. It refuses a delayed submission after cancellation or restart,
  including a cancel sent before the submit response arrived. Discarding result
  bytes keeps that marker; no patient data or provider credential is in it.
- **The queue is in memory and the results are on disk.** A restart loses
  queued jobs -- the control plane owns the ledger and re-queues them -- but it
  never loses a finished result or a checkpoint. A job directory found on disk
  that this process did not create is not trusted: resubmitting its id clears
  everything in it except the checkpoints, which R re-validates by scenario
  hash and seed. A finished job no longer held in memory (after a restart, or
  pruned past `VCR_ENGINE_KEEP_JOBS`) is answered from its `result.json`.
- **A table leaves only by the name its result gave it.** A step's output (a
  generated population, a reconstructed curve's pseudo-patients) is the next
  step's input, and the engine's work volume is not the control plane's: the
  control plane asks for a table by the name the finished result lists, checks
  the sha256 the result carries, and files it in the data plane itself. The
  route opens `<job dir>/<location>` only when that exact pair is in the
  result, refuses a symlink or anything not a regular file, and stops at
  `VCR_ENGINE_MAX_TABLE_BYTES` -- so it cannot be made to read another job's
  directory or a file the result never wrote.
- **Secrets live in files and stay in this process.** The token and the
  receipt key are read once, without following symlinks, and the R child gets
  an allowlisted environment -- never a copy of this one.
- **Nothing a caller sends becomes a path until it is checked.** A job id is
  matched against the protocol pattern before it touches memory or disk, and
  its directory must resolve to a direct child of the work directory before
  anything is created in it or removed.
- **No model, no network egress.** The engine opens exactly the files a job
  names under `VCR_ENGINE_DATA_ROOT`. There is no client for anything in this
  process.
"""

from __future__ import annotations

import collections
import contextlib
import hashlib
import hmac
import json
import logging
import math
import os
import re
import resource
import shutil
import signal
import stat
import subprocess
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from queue import Queue
from typing import Any, Callable, Mapping

from fastapi import Depends, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response, StreamingResponse
from starlette.concurrency import run_in_threadpool

LOG = logging.getLogger("vcr_engine")

TERMINAL = frozenset({"succeeded", "failed", "canceled", "not_estimable"})
# The protocol id pattern (`@evimed/domain` vcrEngineJob.mjs); `..`, slashes
# and NUL are refused on top of it so a widened pattern cannot reopen a path.
JOB_ID_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,120}")
SECRET_MIN_BYTES = 32
SECRET_MAX_BYTES = 8 * 1024
RESULT_MAX_BYTES = 64 * 1024 * 1024
PROGRESS_MAX_BYTES = 64 * 1024
OUTPUT_TAIL_BYTES = 4000
CPU_HARD_GRACE_SECONDS = 30
HEALTH_TIMEOUT_SECONDS = 120
# A failed self-check is retried after this long, so a broken R is reported
# promptly and a repaired one is noticed without a restart.
HEALTH_FAILURE_TTL_SECONDS = 30.0
HEALTH_FIELDS = ("engineVersion", "rVersion", "methods", "packageLockHash", "protocolVersion")
HEALTH_EXPRESSION = (
    'local({ lib <- Sys.getenv("VCR_R_LIBS", ""); if (nzchar(lib)) .libPaths(c(lib, .libPaths())) }); '
    'root <- Sys.getenv("VCR_ENGINE_ROOT"); '
    'source(file.path(root, "R", "engine.R")); '
    "vcr_engine_load(root); "
    'cat(jsonlite::toJSON(vcr_engine_health(), auto_unbox = TRUE, null = "null", digits = NA), "\\n", sep = "")'
)


class Refusal(Exception):
    """A request this service declines, answered as `{"detail": code}`."""

    def __init__(self, status_code: int, code: str, *, headers: dict[str, str] | None = None,
                 **extra: Any) -> None:
        super().__init__(code)
        self.status_code = status_code
        self.code = code
        self.headers = headers
        self.extra = extra


def field_invalid(name: str) -> Refusal:
    return Refusal(422, "job_field_invalid", field=name)


# --- configuration ---------------------------------------------------------


@dataclass(frozen=True)
class Settings:
    engine_root: Path
    work_dir: Path
    data_root: str
    r_libs: str
    rscript: str
    token: bytes | None
    receipt_key: bytes | None
    cpu_seconds: float
    max_cpu_seconds: float
    cores: int
    max_replicates: int
    max_input_bytes: int
    max_table_bytes: int
    memory_bytes: int
    max_body_bytes: int
    keep_jobs: int
    cancel_grace_seconds: float
    kill_grace_seconds: float
    path: str
    lang: str
    tmpdir: str
    r_libs_site: str
    python: str


def read_secret_file(name: str, path: str) -> bytes:
    """Read one secret file. Messages name the variable, never the value or the path."""
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK
    try:
        fd = os.open(path, flags)
    except OSError:
        raise RuntimeError(f"{name}: the file cannot be opened as a regular file "
                           "without following a symlink") from None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise RuntimeError(f"{name}: the file is not a regular file")
        data = bytearray()
        while len(data) <= SECRET_MAX_BYTES + 2:
            chunk = os.read(fd, 4096)
            if not chunk:
                break
            data += chunk
    finally:
        os.close(fd)
    # One LF or CRLF terminator is removed, exactly as the control plane's
    # readSecretFile does. Any other surrounding whitespace is refused rather
    # than stripped: the control plane would keep it, and a token or receipt
    # key the two sides read differently fails every call with no clue why.
    secret = bytes(data)
    if secret.endswith(b"\r\n"):
        secret = secret[:-2]
    elif secret.endswith(b"\n"):
        secret = secret[:-1]
    if len(secret) > SECRET_MAX_BYTES:
        raise RuntimeError(f"{name}: the file is larger than a secret can be")
    if b"\0" in secret or secret != secret.strip():
        raise RuntimeError(f"{name}: the secret carries NUL bytes or surrounding whitespace")
    if len(secret) < SECRET_MIN_BYTES:
        raise RuntimeError(f"{name}: the secret is shorter than {SECRET_MIN_BYTES} bytes")
    return secret


def _number(environ: Mapping[str, str], name: str, default: float, *, integer: bool = False,
            minimum: float = 0.0, exclusive: bool = False) -> Any:
    raw = str(environ.get(name, "") or "").strip()
    if not raw:
        return default
    try:
        value: float = int(raw) if integer else float(raw)
    except ValueError:
        raise RuntimeError(f"{name} is not a {'whole ' if integer else ''}number") from None
    if not math.isfinite(value) or value < minimum or (exclusive and value == minimum):
        raise RuntimeError(f"{name} is out of range")
    return value


LEGACY_SECRET_VARIABLES = {
    "VCR_ENGINE_TOKEN": "VCR_ENGINE_TOKEN_FILE",
    "VCR_ENGINE_RECEIPT_KEY": "VCR_ENGINE_RECEIPT_KEY_FILE",
    "EVIMED_VCR_ENGINE_TOKEN": "VCR_ENGINE_TOKEN_FILE",
    "EVIMED_VCR_ENGINE_RECEIPT_KEY": "VCR_ENGINE_RECEIPT_KEY_FILE",
}


def load_settings(environ: Mapping[str, str]) -> Settings:
    # A secret handed over in the environment is refused, not ignored: ignored,
    # it is a configuration that looks applied and is not (and it sits in
    # `docker inspect`).
    for legacy, replacement in LEGACY_SECRET_VARIABLES.items():
        if environ.get(legacy):
            raise RuntimeError(f"{legacy} is not read: put the secret in a file and name the file "
                               f"in {replacement}")
    insecure = environ.get("VCR_ENGINE_INSECURE_DEV", "") == "1"
    secrets: dict[str, bytes | None] = {}
    for name in ("VCR_ENGINE_TOKEN_FILE", "VCR_ENGINE_RECEIPT_KEY_FILE"):
        path = environ.get(name, "")
        if path:
            secrets[name] = read_secret_file(name, path)
        elif insecure:
            secrets[name] = None
        else:
            raise RuntimeError(f"{name} is not set: the engine refuses to start without its token and "
                               "receipt key files (VCR_ENGINE_INSECURE_DEV=1 runs an open, unsigned "
                               "development engine)")
    # A file that is named is read and enforced even in development mode;
    # the flag only lets a missing one be missing.
    relaxed = [what for what, missing in (("every route is open", secrets["VCR_ENGINE_TOKEN_FILE"] is None),
                                          ("results are unsigned", secrets["VCR_ENGINE_RECEIPT_KEY_FILE"] is None))
               if missing]
    if relaxed:
        LOG.warning("VCR_ENGINE_INSECURE_DEV=1: %s. This is a development engine, never a deployment.",
                    " and ".join(relaxed))
    return Settings(
        engine_root=Path(environ.get("VCR_ENGINE_ROOT") or Path(__file__).resolve().parent.parent),
        work_dir=Path(environ.get("VCR_ENGINE_WORK_DIR") or "/jobs"),
        data_root=environ.get("VCR_ENGINE_DATA_ROOT") or "/data-plane",
        r_libs=environ.get("VCR_R_LIBS", ""),
        rscript=environ.get("VCR_RSCRIPT") or "Rscript",
        token=secrets["VCR_ENGINE_TOKEN_FILE"],
        receipt_key=secrets["VCR_ENGINE_RECEIPT_KEY_FILE"],
        cpu_seconds=_number(environ, "VCR_ENGINE_CPU_SECONDS", 600.0, exclusive=True),
        max_cpu_seconds=_number(environ, "VCR_ENGINE_MAX_CPU_SECONDS", 3600.0, exclusive=True),
        cores=_number(environ, "VCR_ENGINE_CORES", 1, integer=True, minimum=1),
        max_replicates=_number(environ, "VCR_ENGINE_MAX_REPLICATES", 200000, integer=True, minimum=1),
        # 0 = unset: R applies its own default cap on one input file.
        max_input_bytes=_number(environ, "VCR_ENGINE_MAX_INPUT_BYTES", 0, integer=True),
        max_table_bytes=_number(environ, "VCR_ENGINE_MAX_TABLE_BYTES", 512 * 1024 * 1024, integer=True, minimum=1),
        memory_bytes=_number(environ, "VCR_ENGINE_MEMORY_BYTES", 0, integer=True),
        max_body_bytes=_number(environ, "VCR_ENGINE_MAX_BODY_BYTES", 8 * 1024 * 1024, integer=True, minimum=1),
        keep_jobs=_number(environ, "VCR_ENGINE_KEEP_JOBS", 500, integer=True),
        cancel_grace_seconds=_number(environ, "VCR_ENGINE_CANCEL_GRACE_SECONDS", 15.0),
        kill_grace_seconds=_number(environ, "VCR_ENGINE_KILL_GRACE_SECONDS", 5.0),
        path=environ.get("PATH") or "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        lang=environ.get("LANG") or "C.UTF-8",
        tmpdir=environ.get("TMPDIR") or "/tmp",
        r_libs_site=environ.get("R_LIBS_SITE", ""),
        python=environ.get("VCR_PYTHON", ""),
    )


def child_environment(settings: Settings, *, home: Path | str, cpu_limit: int | None) -> dict[str, str]:
    """The R child's whole environment: an allowlist, never a copy of ours.

    This process holds the token and the receipt key (and whatever else its
    container was given); R runs job-supplied scenarios and has no use for
    either, so nothing reaches it unless it is named here.
    """
    env = {
        "PATH": settings.path,
        "HOME": str(home),
        "LANG": settings.lang,
        "TZ": "UTC",
        "TMPDIR": settings.tmpdir,
        "OPENBLAS_NUM_THREADS": "1",
        "OMP_NUM_THREADS": "1",
        "VCR_ENGINE_ROOT": str(settings.engine_root),
        "VCR_ENGINE_DATA_ROOT": settings.data_root,
        # The ceiling. A job's own `cores` can only lower it; R applies min().
        "VCR_ENGINE_CORES": str(settings.cores),
        "VCR_ENGINE_MAX_REPLICATES": str(settings.max_replicates),
    }
    if settings.r_libs:
        env["VCR_R_LIBS"] = settings.r_libs
    if settings.r_libs_site:
        env["R_LIBS_SITE"] = settings.r_libs_site
    if settings.python:
        env["VCR_PYTHON"] = settings.python
    if settings.max_input_bytes > 0:
        env["VCR_ENGINE_MAX_INPUT_BYTES"] = str(settings.max_input_bytes)
    if cpu_limit is not None:
        env["VCR_ENGINE_CPU_LIMIT"] = str(cpu_limit)
    return env


# --- files -----------------------------------------------------------------


def valid_job_id(value: Any) -> bool:
    return (isinstance(value, str) and JOB_ID_PATTERN.fullmatch(value) is not None
            and ".." not in value and "/" not in value and "\\" not in value and "\0" not in value)


def job_directory(root: Path, job_id: str) -> Path | None:
    """The job's directory if it is, and resolves to, a direct child of `root`."""
    if not valid_job_id(job_id):
        return None
    candidate = root / job_id
    try:
        if candidate.is_symlink():
            return None
        resolved = candidate.resolve()
    except (OSError, RuntimeError):
        return None
    if resolved.parent != root or resolved.name != job_id:
        return None
    return resolved


def read_regular_file(path: Path, limit: int) -> bytes | None:
    """A regular file's bytes, never through a symlink, or None."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    except OSError:
        return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            return None
        data = bytearray()
        while len(data) <= limit:
            chunk = os.read(fd, 1 << 16)
            if not chunk:
                break
            data += chunk
        return None if len(data) > limit else bytes(data)
    except OSError:
        return None
    finally:
        os.close(fd)


TABLE_NAME_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,80}")
TABLE_CHUNK_BYTES = 1 << 20


def open_regular_file(path: Path) -> tuple[int, int] | None:
    """An open descriptor and the size of a regular file (never through a symlink), or None."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError:
        return None
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            os.close(fd)
            return None
        return fd, info.st_size
    except OSError:
        os.close(fd)
        return None


def write_atomically(path: Path, data: bytes) -> None:
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


def clear_stale(directory: Path) -> None:
    """Empty a job directory this process did not create, keeping checkpoints.

    Nothing in it is trusted: a CANCEL would cancel the new run, a result.json
    would be served as its answer. Checkpoints (`*.rds`) stay because R checks
    them against the scenario hash and seed before resuming from one.
    """
    with os.scandir(directory) as entries:
        for entry in entries:
            if entry.is_dir(follow_symlinks=False) or entry.name.endswith(".rds"):
                continue
            os.unlink(os.path.join(directory, entry.name))


def load_result(directory: Path) -> tuple[bytes, dict[str, Any]] | None:
    raw = read_regular_file(directory / "result.json", RESULT_MAX_BYTES)
    if raw is None:
        return None
    try:
        parsed = json.loads(raw)
    except (ValueError, RecursionError):
        return None
    return (raw, parsed) if isinstance(parsed, dict) else None


def receipt_signature(key: bytes | None, result: Mapping[str, Any]) -> str | None:
    """hex HMAC-SHA256(key, jobId \\n scenarioHash \\n outputHash); None when there is nothing to sign."""
    if key is None:
        return None
    manifest = result.get("manifest")
    output_hash = manifest.get("outputHash") if isinstance(manifest, dict) else None
    job_id, scenario_hash = result.get("jobId"), result.get("scenarioHash")
    if not (isinstance(output_hash, str) and output_hash and isinstance(job_id, str)
            and isinstance(scenario_hash, str)):
        return None
    payload = f"{job_id}\n{scenario_hash}\n{output_hash}".encode("utf-8")
    return hmac.new(key, payload, hashlib.sha256).hexdigest()


def _int(value: Any, default: int) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return default
    return int(value)


def _float(value: Any, default: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return default
    return float(value)


def read_progress(directory: Path, total: int) -> tuple[int, int, float]:
    raw = read_regular_file(directory / "progress.json", PROGRESS_MAX_BYTES)
    try:
        progress = json.loads(raw) if raw is not None else {}
    except (ValueError, RecursionError):
        progress = {}
    if not isinstance(progress, dict):
        progress = {}
    return (_int(progress.get("done"), 0), _int(progress.get("total"), total),
            _float(progress.get("cpuSeconds"), 0.0))


# --- the child -------------------------------------------------------------


def _clamped(which: int, soft: int, hard: int) -> tuple[int, int]:
    # Raising a hard limit above the one this process inherited needs
    # CAP_SYS_RESOURCE, which the container drops; lowering never does.
    _, inherited = resource.getrlimit(which)
    if inherited != resource.RLIM_INFINITY:
        hard = min(hard, inherited)
        soft = min(soft, hard)
    return soft, hard


def apply_child_limits(pid: int, cpu_seconds: int, memory_bytes: int) -> None:
    """Set the child's CPU (and address-space) limits from here, after spawn.

    Not in a `preexec_fn`: that runs Python between fork and exec, which is
    unsafe in a process with other threads (the event loop, the thread pool,
    this worker) -- a lock another thread held at fork time stays held in the
    child forever. Not through a wrapper (`prlimit ... Rscript`, `sh -c
    'ulimit -t ...; exec Rscript'`) either, which would add a binary and a
    shell the image has to guarantee. `Popen` returns only after the exec
    succeeded, so when this runs the child is the R launcher starting the
    interpreter, hundreds of milliseconds before any job code; the CPU it
    spent until now counts against the limit anyway, and Rscript execs R in
    the same pid, so the limit follows the interpreter.
    """
    resource.prlimit(pid, resource.RLIMIT_CPU,
                     _clamped(resource.RLIMIT_CPU, cpu_seconds, cpu_seconds + CPU_HARD_GRACE_SECONDS))
    if memory_bytes > 0:
        resource.prlimit(pid, resource.RLIMIT_AS, _clamped(resource.RLIMIT_AS, memory_bytes, memory_bytes))


class OutputTail:
    """Drain a pipe, keeping only its last bytes (for the log, never a response)."""

    def __init__(self, stream: Any) -> None:
        self.buffer = bytearray()
        self.stream = stream
        self.thread = threading.Thread(target=self._pump, name="vcr-engine-output", daemon=True)
        self.thread.start()

    def _pump(self) -> None:
        fd = self.stream.fileno()
        while True:
            try:
                chunk = os.read(fd, 1 << 16)
            except OSError:
                return
            if not chunk:
                return
            self.buffer += chunk
            del self.buffer[:-OUTPUT_TAIL_BYTES]

    def text(self) -> str:
        self.thread.join(timeout=5)
        with contextlib.suppress(OSError):
            self.stream.close()
        return bytes(self.buffer).decode("utf-8", "replace")


# --- jobs ------------------------------------------------------------------


@dataclass(eq=False)
class Job:
    job_id: str
    directory: Path
    total: int
    cpu_limit: int
    state: str = "queued"
    error: str | None = None
    pid: int | None = None
    # True from spawn until the leader is reaped. While it is, the leader's pid
    # -- and so the process-group id -- cannot be reused, which is what makes a
    # signal to the group safe.
    running: bool = False
    cancel_requested: bool = False
    cpu_used: float | None = None
    started_at: float | None = None
    finished_at: float | None = None
    lock: threading.Lock = field(default_factory=threading.Lock, repr=False)
    done: threading.Event = field(default_factory=threading.Event, repr=False)


def validate_job_body(body: Any, settings: Settings) -> tuple[str, int, int]:
    """Check what this service itself relies on; the job protocol is R's and the domain's to check."""
    if not isinstance(body, dict):
        raise Refusal(422, "job_body_invalid")
    raw_id = body.get("jobId")
    if raw_id is None:
        job_id = f"job_{uuid.uuid4().hex}"
    elif valid_job_id(raw_id):
        job_id = raw_id
    else:
        raise Refusal(422, "job_id_invalid")

    def positive_number(value: Any) -> bool:
        return (isinstance(value, (int, float)) and not isinstance(value, bool)
                and math.isfinite(value) and value > 0)

    def positive_integer(value: Any) -> bool:
        return isinstance(value, int) and not isinstance(value, bool) and value > 0

    cpu = body.get("cpuSecondsLimit")
    if cpu is not None and not positive_number(cpu):
        raise field_invalid("cpuSecondsLimit")
    replicates = body.get("replicates")
    if replicates is not None:
        if not positive_integer(replicates):
            raise field_invalid("replicates")
        if replicates > settings.max_replicates:
            raise Refusal(422, "job_replicates_too_large")
    cores = body.get("cores")
    if cores is not None and not positive_integer(cores):
        raise field_invalid("cores")
    if "scenario" in body and not isinstance(body["scenario"], dict):
        raise field_invalid("scenario")
    if "inputs" in body and not isinstance(body["inputs"], list):
        raise field_invalid("inputs")
    limit = min(float(cpu) if cpu is not None else settings.cpu_seconds, settings.max_cpu_seconds)
    return job_id, replicates or 1, max(1, math.ceil(limit))


class WorkDir:
    """The job work directory: created on first use, and never a reason to crash."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.root: Path | None = None
        self.lock = threading.Lock()

    def ready(self) -> Path | None:
        with self.lock:
            if self.root is not None:
                return self.root
            try:
                self.path.mkdir(parents=True, exist_ok=True)
                root = self.path.resolve(strict=True)
                if not root.is_dir():
                    raise NotADirectoryError(str(root))
                # Writable is proved by writing: a read-only mount passes
                # every permission-bit check a stat could make.
                fd, probe = tempfile.mkstemp(prefix=".writable-", dir=root)
                os.close(fd)
                os.unlink(probe)
            except OSError as exc:
                LOG.error("the job work directory is unavailable (%s)", exc.__class__.__name__)
                return None
            self.root = root
            return root


class Engine:
    """One worker, one queue, results on disk."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.work = WorkDir(settings.work_dir)
        self.work.ready()
        self.jobs: dict[str, Job] = {}
        self.finished: collections.deque[Job] = collections.deque()
        self.queue: Queue[str | None] = Queue()
        self.lock = threading.Lock()
        self.worker = threading.Thread(target=self._run_forever, name="vcr-engine-worker", daemon=True)
        self.worker.start()

    def close(self) -> None:
        """Stop the worker and the job it runs: a result nobody is left to sign is not a result."""
        self.queue.put(None)
        with self.lock:
            running = [job for job in self.jobs.values() if job.running]
        for job in running:
            with job.lock:
                job.cancel_requested = True
            self._signal_group(job, signal.SIGKILL)

    # -- the routes' side --

    def _cancellation_path(self, job_id: str) -> Path:
        if not valid_job_id(job_id):
            raise Refusal(404, "job_not_found")
        root = self.work.ready()
        if root is None:
            raise Refusal(503, "job_directory_unavailable")
        return root / f".canceled-{job_id}"

    def _was_canceled(self, job_id: str) -> bool:
        marker = self._cancellation_path(job_id)
        raw = read_regular_file(marker, 256)
        if raw is None:
            if os.path.lexists(marker):
                raise Refusal(409, "job_directory_conflict")
            return False
        message = f"canceled:{job_id}".encode()
        expected = hmac.new(self.settings.receipt_key or self.settings.token or b"insecure-dev", message, hashlib.sha256).hexdigest().encode()
        if not hmac.compare_digest(raw, expected):
            raise Refusal(409, "job_directory_conflict")
        return True

    def _keep_cancellation(self, job_id: str) -> None:
        marker = self._cancellation_path(job_id)
        message = f"canceled:{job_id}".encode()
        signed = hmac.new(self.settings.receipt_key or self.settings.token or b"insecure-dev", message, hashlib.sha256).hexdigest().encode()
        try:
            write_atomically(marker, signed)
        except OSError:
            raise Refusal(503, "job_directory_unavailable") from None

    def submit(self, body: Any) -> Job:
        job_id, total, cpu_limit = validate_job_body(body, self.settings)
        payload = dict(body)
        payload["jobId"] = job_id
        try:
            # Written from what was validated, so R reads the same object this
            # process checked (duplicate keys, for one, collapse here once).
            data = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
        except (ValueError, RecursionError):
            raise Refusal(422, "job_body_invalid") from None
        root = self.work.ready()
        if root is None:
            raise Refusal(503, "job_directory_unavailable")
        directory = job_directory(root, job_id)
        if directory is None:
            raise Refusal(409, "job_directory_conflict")
        with self.lock:
            if self._was_canceled(job_id):
                raise Refusal(409, "job_canceled")
            if job_id in self.jobs:
                raise Refusal(409, "job_already_submitted")
            created = False
            try:
                if os.path.lexists(directory):
                    if directory.is_symlink() or not directory.is_dir():
                        raise Refusal(409, "job_directory_conflict")
                    clear_stale(directory)
                else:
                    directory.mkdir(mode=0o700)
                    created = True
                write_atomically(directory / "job.json", data)
            except OSError as exc:
                if created:
                    shutil.rmtree(directory, ignore_errors=True)
                LOG.error("job %s: its directory could not be prepared (%s)", job_id, exc.__class__.__name__)
                raise Refusal(503, "job_directory_unavailable") from None
            job = Job(job_id=job_id, directory=directory, total=total, cpu_limit=cpu_limit)
            self.jobs[job_id] = job
        self.queue.put(job_id)
        return job

    def _known(self, job_id: str) -> Job | None:
        if not valid_job_id(job_id):
            raise Refusal(404, "job_not_found")
        with self.lock:
            return self.jobs.get(job_id)

    @staticmethod
    def _answer(directory: Path, job_id: str) -> tuple[bytes, dict[str, Any]] | None:
        """The job's own finished result, or None."""
        loaded = load_result(directory)
        if loaded is None or loaded[1].get("status") not in TERMINAL or loaded[1].get("jobId") != job_id:
            return None
        return loaded

    def _on_disk(self, job_id: str) -> tuple[Path, bytes, dict[str, Any]] | None:
        """A finished job this process no longer holds, read from its verified directory."""
        root = self.work.ready()
        directory = job_directory(root, job_id) if root is not None else None
        loaded = self._answer(directory, job_id) if directory is not None else None
        return None if loaded is None else (directory, loaded[0], loaded[1])

    def describe(self, job_id: str) -> dict[str, Any]:
        job = self._known(job_id)
        if job is None:
            disk = self._on_disk(job_id)
            if disk is None:
                if self._was_canceled(job_id):
                    return {"jobId": job_id, "state": "canceled", "progress": {"done": 0, "total": 0},
                            "cpuSeconds": 0, "cpuSecondsLimit": None, "error": "canceled"}
                raise Refusal(404, "job_not_found")
            directory, _, result = disk
            done, total, cpu = read_progress(directory, _int(result.get("replicates"), 1))
            return {"jobId": job_id, "state": result["status"], "progress": {"done": done, "total": total},
                    "cpuSeconds": cpu, "cpuSecondsLimit": None, "error": None}
        done, total, cpu = read_progress(job.directory, job.total)
        with job.lock:
            return {"jobId": job.job_id, "state": job.state, "progress": {"done": done, "total": total},
                    "cpuSeconds": job.cpu_used if job.cpu_used is not None else cpu,
                    "cpuSecondsLimit": job.cpu_limit, "error": job.error}

    def result(self, job_id: str) -> bytes:
        job = self._known(job_id)
        if job is None:
            disk = self._on_disk(job_id)
            if disk is None:
                raise Refusal(404, "job_not_found")
            return disk[1]
        # Not before the job is terminal: R renames result.json into place
        # before this process has signed it.
        # And not when the seal refused it: that file is not this job's signed answer.
        if job.state not in TERMINAL or job.error == "result_unreadable":
            raise Refusal(409, "result_not_ready")
        loaded = self._answer(job.directory, job_id)
        if loaded is None:
            raise Refusal(409, "result_not_ready")
        return loaded[0]

    def table(self, job_id: str, name: str) -> tuple[int, int]:
        """An open descriptor and the size of one table the job's result lists.

        The result is read from disk (the bytes that were signed), the table is
        looked up in it by name, and the file is `<job dir>/<location>` with the
        location a bare file name: a table nobody listed, a location that is a
        path, and a file that is not a regular file are all `table_not_found`.
        """
        if not valid_job_id(job_id):
            raise Refusal(404, "job_not_found")
        job = self._known(job_id)
        if job is None:
            disk = self._on_disk(job_id)
            if disk is None:
                raise Refusal(404, "job_not_found")
            directory, result = disk[0], disk[2]
        else:
            if job.state not in TERMINAL or job.error == "result_unreadable":
                raise Refusal(409, "result_not_ready")
            loaded = self._answer(job.directory, job_id)
            if loaded is None:
                raise Refusal(409, "result_not_ready")
            directory, result = job.directory, loaded[1]
        if TABLE_NAME_PATTERN.fullmatch(name) is None or ".." in name:
            raise Refusal(404, "table_not_found")
        tables = result.get("tables")
        listed = [entry for entry in (tables if isinstance(tables, list) else [])
                  if isinstance(entry, dict) and entry.get("name") == name]
        location = listed[0].get("location") if listed else None
        if (not isinstance(location, str) or TABLE_NAME_PATTERN.fullmatch(location) is None or ".." in location
                or location in ("result.json", "job.json", "progress.json")):
            raise Refusal(404, "table_not_found")
        opened = open_regular_file(directory / location)
        if opened is None:
            raise Refusal(404, "table_not_found")
        if opened[1] > self.settings.max_table_bytes:
            os.close(opened[0])
            raise Refusal(413, "table_too_large")
        return opened

    def cancel(self, job_id: str) -> bool:
        if not valid_job_id(job_id):
            raise Refusal(404, "job_not_found")
        # Serialize with submit before retaining the authenticated cancellation:
        # its response may precede a delayed POST /jobs under the same identity.
        with self.lock:
            job = self.jobs.get(job_id)
            if job is None and self._on_disk(job_id) is not None:
                return False
            self._keep_cancellation(job_id)
        if job is None:
            return True
        with job.lock:
            if job.state in TERMINAL:
                return False
            if job.state == "canceling":
                return True
            if job.state == "queued":
                job.state, job.error, job.finished_at = "canceled", "canceled", time.time()
                job.done.set()
                queued = True
            else:
                queued = False
                job.cancel_requested = True
                job.state = "canceling"
                try:
                    write_atomically(job.directory / "CANCEL", b"1")
                except OSError as exc:
                    LOG.error("job %s: CANCEL could not be written (%s); signals follow", job_id,
                              exc.__class__.__name__)
        if queued:
            self._record_finished(job)
        else:
            threading.Thread(target=self._escalate, args=(job,), name="vcr-engine-cancel", daemon=True).start()
        return True

    def discard(self, job_id: str) -> None:
        if not valid_job_id(job_id):
            raise Refusal(404, "job_not_found")
        root = self.work.ready()
        if root is None:
            raise Refusal(503, "job_directory_unavailable")
        with self.lock:
            job = self.jobs.get(job_id)
            if job is not None and job.state not in TERMINAL:
                raise Refusal(409, "job_still_running")
            directory = job_directory(root, job_id)
            if directory is None or (job is not None and directory != job.directory):
                raise Refusal(404, "job_not_found")
            if job is None and not directory.is_dir():
                raise Refusal(404, "job_not_found")
            if directory.is_dir():
                try:
                    shutil.rmtree(directory)
                except OSError as exc:
                    LOG.error("job %s: its directory could not be removed (%s)", job_id, exc.__class__.__name__)
                    raise Refusal(503, "job_directory_unavailable") from None
            if job is not None:
                del self.jobs[job_id]
                with contextlib.suppress(ValueError):
                    self.finished.remove(job)

    # -- the worker's side --

    def _escalate(self, job: Job) -> None:
        if job.done.wait(self.settings.cancel_grace_seconds):
            return
        self._signal_group(job, signal.SIGTERM)
        if job.done.wait(self.settings.kill_grace_seconds):
            return
        self._signal_group(job, signal.SIGKILL)

    @staticmethod
    def _signal_group(job: Job, sig: int) -> None:
        with job.lock:
            if not job.running or job.pid is None:
                return
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.killpg(job.pid, sig)

    def _record_finished(self, job: Job) -> None:
        with self.lock:
            self.finished.append(job)
            while len(self.finished) > self.settings.keep_jobs:
                old = self.finished.popleft()
                if self.jobs.get(old.job_id) is old and old.state in TERMINAL:
                    del self.jobs[old.job_id]

    def _finish(self, job: Job, state: str, error: str | None) -> None:
        with job.lock:
            job.state, job.error, job.finished_at = state, error, time.time()
            job.done.set()
        self._record_finished(job)

    def _run_forever(self) -> None:
        while True:
            job_id = self.queue.get()
            if job_id is None:
                return
            with self.lock:
                job = self.jobs.get(job_id)
            if job is None:
                continue
            with job.lock:
                if job.state != "queued":
                    continue
                job.state, job.started_at = "running", time.time()
            try:
                self._run(job)
            except Exception:  # noqa: BLE001 - the queue must survive anything
                LOG.exception("job %s: the worker failed", job.job_id)
                if not job.done.is_set():
                    self._finish(job, "failed", "engine_crashed")

    def _run(self, job: Job) -> None:
        s = self.settings
        argv = [s.rscript, str(s.engine_root / "service" / "run_job.R"),
                str(job.directory / "job.json"), str(job.directory)]
        try:
            proc = subprocess.Popen(
                argv, env=child_environment(s, home=job.directory, cpu_limit=job.cpu_limit),
                cwd=str(job.directory), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT, start_new_session=True, close_fds=True)
        except OSError as exc:
            LOG.error("job %s: the R child could not be started (%s)", job.job_id, exc.__class__.__name__)
            self._finish(job, "failed", "spawn_failed")
            return
        with job.lock:
            job.pid, job.running = proc.pid, True
        limits_applied = True
        try:
            output = OutputTail(proc.stdout)
            try:
                apply_child_limits(proc.pid, job.cpu_limit, s.memory_bytes)
            except OSError as exc:
                limits_applied = False
                LOG.error("job %s: resource limits could not be applied (%s)", job.job_id, exc.__class__.__name__)
                self._signal_group(job, signal.SIGKILL)
            # Wait without reaping, so the sweep below runs while the zombie
            # leader still pins its id.
            os.waitid(os.P_PID, proc.pid, os.WEXITED | os.WNOWAIT)
        finally:
            # Sweep the group, then reap: whatever the job forked ends with it,
            # and whatever went wrong above, no R outlives this call.
            with job.lock:
                with contextlib.suppress(ProcessLookupError, PermissionError):
                    os.killpg(proc.pid, signal.SIGKILL)
                _, wait_status, usage = os.wait4(proc.pid, 0)
                job.running = False
                proc.returncode = os.waitstatus_to_exitcode(wait_status)
                job.cpu_used = round(usage.ru_utime + usage.ru_stime, 3)
                cancel_requested = job.cancel_requested
        tail = output.text()
        code = proc.returncode

        if not limits_applied:
            state, error = "failed", "spawn_failed"
        elif os.path.lexists(job.directory / "result.json"):
            state, error = self._seal(job)
        elif cancel_requested:
            state, error = "canceled", "canceled"
        elif code == -signal.SIGXCPU or (job.cpu_used or 0.0) >= job.cpu_limit:
            state, error = "failed", "cpu_limit_exceeded"
        elif code == -signal.SIGKILL:
            # Not a cancel and not the CPU hard limit: the kernel's OOM killer
            # is the one other sender of SIGKILL to this group.
            state, error = "failed", "memory_limit_exceeded"
        elif s.memory_bytes > 0 and "cannot allocate" in tail:
            state, error = "failed", "memory_limit_exceeded"
        else:
            state, error = "failed", "engine_crashed"
        if state != "succeeded" or code != 0:
            LOG.warning("job %s ended %s (%s), exit %s, cpu %.1fs; output tail:\n%s",
                        job.job_id, state, error or "-", code, job.cpu_used or 0.0, tail)
        self._finish(job, state, error)

    def _seal(self, job: Job) -> tuple[str, str | None]:
        """Sign R's result and write it back before the state turns terminal."""
        loaded = load_result(job.directory)
        if loaded is None:
            return "failed", "result_unreadable"
        result = loaded[1]
        if result.get("status") not in TERMINAL or result.get("jobId") != job.job_id:
            return "failed", "result_unreadable"
        manifest = result.get("manifest")
        if isinstance(manifest, dict):
            # Only this process holds the key: a signature already present was
            # not made with it, so it goes, and none is invented without an
            # outputHash to sign.
            changed = manifest.pop("signature", None) is not None
            signature = receipt_signature(self.settings.receipt_key, result)
            if signature is not None:
                manifest["signature"] = signature
                changed = True
            if changed:
                try:
                    write_atomically(job.directory / "result.json",
                                     json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
                except (OSError, ValueError) as exc:
                    LOG.error("job %s: the signed result could not be written (%s)", job.job_id,
                              exc.__class__.__name__)
                    return "failed", "result_unreadable"
        return result["status"], None


# --- health ----------------------------------------------------------------


class HealthProbe:
    """R's self-check, run once and remembered (a failure only briefly)."""

    def __init__(self, settings: Settings, clock: Callable[[], float] = time.monotonic) -> None:
        self.settings = settings
        self.clock = clock
        self.lock = threading.Lock()
        self.cached: tuple[float, int, dict[str, Any]] | None = None

    def get(self) -> tuple[int, dict[str, Any]]:
        # Callers queue behind one probe instead of each starting an R.
        with self.lock:
            now = self.clock()
            if self.cached is not None and now < self.cached[0]:
                return self.cached[1], self.cached[2]
            code, body = self._probe()
            self.cached = (math.inf if code == 200 else now + HEALTH_FAILURE_TTL_SECONDS, code, body)
            return code, body

    def _probe(self) -> tuple[int, dict[str, Any]]:
        failed = (503, {"ok": False, "detail": "engine_self_check_failed"})
        s = self.settings
        try:
            out = subprocess.run(
                [s.rscript, "-e", HEALTH_EXPRESSION],
                env=child_environment(s, home=s.tmpdir, cpu_limit=None), cwd=s.tmpdir,
                stdin=subprocess.DEVNULL, capture_output=True, timeout=HEALTH_TIMEOUT_SECONDS,
                start_new_session=True, check=False)
        except (OSError, subprocess.TimeoutExpired) as exc:
            LOG.error("engine self-check could not run (%s)", exc.__class__.__name__)
            return failed
        lines = [line for line in out.stdout.decode("utf-8", "replace").splitlines() if line.strip()]
        try:
            health = json.loads(lines[-1]) if out.returncode == 0 and lines else None
        except ValueError:
            health = None
        if not isinstance(health, dict):
            LOG.error("engine self-check failed, exit %s; stderr tail:\n%s", out.returncode,
                      out.stderr[-OUTPUT_TAIL_BYTES:].decode("utf-8", "replace"))
            return failed
        if health.get("ok") is not True:
            issues = health.get("issues") if isinstance(health.get("issues"), list) else []
            codes = [issue.get("code") for issue in issues if isinstance(issue, dict)]
            codes = [code for code in codes if isinstance(code, str) and re.fullmatch(r"[a-z0-9_]{1,64}", code)]
            LOG.error("engine self-check reported problems: %s", ", ".join(codes) or "unnamed")
            return 503, {"ok": False, "detail": "engine_self_check_failed", "issues": codes}
        return 200, {"ok": True, **{name: health.get(name) for name in HEALTH_FIELDS}}


# --- the app ---------------------------------------------------------------


class Service:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.health = HealthProbe(settings)
        self._engine: Engine | None = None
        self._engine_lock = threading.Lock()

    def engine(self) -> Engine:
        engine = self._engine
        if engine is None:
            with self._engine_lock:
                if self._engine is None:
                    self._engine = Engine(self.settings)
                engine = self._engine
        return engine

    def warm(self) -> None:
        try:
            self.engine()
            self.health.get()
        except Exception:  # noqa: BLE001 - a warm-up must never take the server down
            LOG.exception("engine warm-up failed")

    def close(self) -> None:
        if self._engine is not None:
            self._engine.close()


async def read_json_body(request: Request, cap: int) -> Any:
    declared = request.headers.get("content-length")
    if declared is not None:
        try:
            if int(declared) > cap:
                raise Refusal(413, "job_body_too_large")
        except ValueError:
            raise Refusal(422, "job_body_invalid") from None
    body = bytearray()
    async for chunk in request.stream():
        body += chunk
        if len(body) > cap:
            raise Refusal(413, "job_body_too_large")

    def refuse_constant(_: str) -> Any:
        raise ValueError("NaN and Infinity are not JSON")

    try:
        return json.loads(bytes(body), parse_constant=refuse_constant)
    except (ValueError, RecursionError):
        raise Refusal(422, "job_body_invalid") from None


def create_app(environ: Mapping[str, str] | None = None) -> FastAPI:
    """Build the service. Raises RuntimeError when its secrets are missing or unusable."""
    settings = load_settings(os.environ if environ is None else environ)
    service = Service(settings)

    @contextlib.asynccontextmanager
    async def lifespan(_: FastAPI):  # type: ignore[no-untyped-def]
        # R's self-check takes seconds; running it now means the first
        # /health answers from the cache instead of racing a client timeout.
        threading.Thread(target=service.warm, name="vcr-engine-warm", daemon=True).start()
        yield
        service.close()

    app = FastAPI(title="vcr-engine", version="1.0.0", docs_url=None, redoc_url=None,
                  openapi_url=None, lifespan=lifespan)
    app.router.redirect_slashes = False
    app.state.service = service

    @app.exception_handler(Refusal)
    async def refused(_: Request, exc: Refusal) -> JSONResponse:
        return JSONResponse({"detail": exc.code, **exc.extra}, status_code=exc.status_code, headers=exc.headers)

    @app.exception_handler(RequestValidationError)
    async def invalid(_: Request, __: RequestValidationError) -> JSONResponse:
        return JSONResponse({"detail": "job_body_invalid"}, status_code=422)

    @app.exception_handler(Exception)
    async def crashed(_: Request, exc: Exception) -> JSONResponse:
        LOG.error("request failed (%s)", exc.__class__.__name__)
        return JSONResponse({"detail": "engine_internal_error"}, status_code=500)

    async def require_token(request: Request) -> None:
        token = settings.token
        if token is None:
            return
        scheme, _, presented = request.headers.get("authorization", "").partition(" ")
        # Headers arrive latin-1 decoded; encoding back gives the bytes sent.
        if scheme.lower() != "bearer" or not hmac.compare_digest(
                presented.strip().encode("latin-1", "replace"), token):
            raise Refusal(401, "unauthorized", headers={"WWW-Authenticate": "Bearer"})

    authorized = [Depends(require_token)]

    # On the event loop, not the thread pool: liveness must not wait behind
    # requests queued there (a /health waiting on the first R self-check).
    @app.get("/livez")
    async def livez() -> JSONResponse:
        return JSONResponse({"ok": True})

    @app.get("/health", dependencies=authorized)
    def health() -> JSONResponse:
        if service.engine().work.ready() is None:
            return JSONResponse({"ok": False, "detail": "job_directory_unavailable"}, status_code=503)
        code, body = service.health.get()
        return JSONResponse(body, status_code=code)

    @app.post("/jobs", status_code=202, dependencies=authorized)
    async def submit(request: Request) -> JSONResponse:
        body = await read_json_body(request, settings.max_body_bytes)
        job = await run_in_threadpool(lambda: service.engine().submit(body))
        return JSONResponse({"jobId": job.job_id, "accepted": True}, status_code=202)

    @app.get("/jobs/{job_id}", dependencies=authorized)
    def state(job_id: str) -> JSONResponse:
        return JSONResponse(service.engine().describe(job_id))

    @app.post("/jobs/{job_id}/cancel", dependencies=authorized)
    def cancel(job_id: str) -> JSONResponse:
        return JSONResponse({"canceled": service.engine().cancel(job_id)})

    @app.get("/jobs/{job_id}/result", dependencies=authorized)
    def result(job_id: str) -> Response:
        # The bytes on disk, not a re-serialization: what was signed is what is served.
        return Response(service.engine().result(job_id), media_type="application/json")

    @app.get("/jobs/{job_id}/tables/{name}", dependencies=authorized)
    def table(job_id: str, name: str) -> StreamingResponse:
        fd, size = service.engine().table(job_id, name)

        def chunks():  # type: ignore[no-untyped-def]
            # The descriptor is closed when the body is done or the client goes.
            try:
                while True:
                    block = os.read(fd, TABLE_CHUNK_BYTES)
                    if not block:
                        return
                    yield block
            finally:
                os.close(fd)

        return StreamingResponse(chunks(), media_type="text/csv", headers={"content-length": str(size)})

    @app.delete("/jobs/{job_id}", dependencies=authorized)
    def discard(job_id: str) -> JSONResponse:
        service.engine().discard(job_id)
        return JSONResponse({"discarded": True})

    return app


app = create_app()
