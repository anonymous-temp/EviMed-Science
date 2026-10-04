"""Stage ordinary specialist jobs and observe the files they produce.

Each engine uses a private working directory. The worker copies authorized inputs,
hashes outputs and publishes regular files after stopping the process group. No
operator signing key or privilege-changing capability is required. Optional process
credentials remain a utility argument; deployed ordinary jobs pass an empty mapping.
"""
from __future__ import annotations

import hashlib
import os
import select
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
from contextlib import ExitStack, closing, contextmanager
from pathlib import Path
from typing import Any, Iterator

from . import audit_receipt

#: What one job may publish, counted before anything reaches the workspace.
MAX_PUBLISHED_FILES = 1000
MAX_PUBLISHED_BYTES = 2 * 1024 * 1024 * 1024
_STOP_GROUP = (
    "import os,signal,sys\n"
    "try:\n    os.killpg(int(sys.argv[1]), signal.SIGKILL)\n"
    "except ProcessLookupError:\n    pass\n"
)
_REMOVE_TREE = "import shutil,sys\nshutil.rmtree(sys.argv[1], ignore_errors=True)\n"


class IsolatedJobError(RuntimeError):
    """The isolated run could not be completed safely; never carries a path or a secret."""


class ExecutionTimeout(IsolatedJobError):
    """The engine ran past its wall clock; its process group has been stopped and reaped.

    Raised by `run` once there is nothing left running, so the caller can still
    publish what the engine had written before it was stopped.
    """


@contextmanager
def analysis_group(credentials: dict[str, Any] | None) -> Iterator[None]:
    """Hold the analysis group as the owner's effective group.

    Everything the owner creates meanwhile is group-owned by the analysis group,
    so the engine can read the request and inputs and write its outputs, and
    the owner can read what the engine writes -- with SETGID alone, never
    CHOWN or a DAC override.
    """
    previous = os.getegid()
    try:
        if credentials and "group" in credentials:
            os.setegid(credentials["group"])
        yield
    finally:
        if os.getegid() != previous:
            os.setegid(previous)


def _as_analysis(credentials: dict[str, Any], code: str, argument: str) -> None:
    """A fixed helper under the analysis identity, for what only it may do to its own processes and files."""
    subprocess.run(
        [sys.executable, "-I", "-c", code, argument],
        env={}, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        timeout=60, check=False, **credentials,
    )


@contextmanager
def stage(credentials: dict[str, Any] | None, *, parent: str | None = None) -> Iterator[Path]:
    """A private working tree for one job: ``input``, ``output``, ``home`` and ``tmp``.

    Removed on the way out: first by the analysis identity, which owns what the
    engine created, then by the owner.
    """
    with analysis_group(credentials):
        path = Path(tempfile.mkdtemp(prefix="evimed-job-", dir=parent))
        try:
            os.chmod(path, 0o770)
            for name in ("input", "output", "home", "tmp"):
                (path / name).mkdir(mode=0o770)
                os.chmod(path / name, 0o770)
            yield path
        finally:
            if credentials:
                try:
                    _as_analysis(credentials, _REMOVE_TREE, str(path))
                except (OSError, subprocess.SubprocessError):
                    pass
            shutil.rmtree(path, ignore_errors=True)


def read_input(workspace: Path, relative: str) -> tuple[bytes, dict[str, Any]]:
    """One workspace file the engine needs, read by the owner, and its receipt row.

    Read before the stage exists, with the owner's own group: the workspace's
    permissions were never meant for the analysis group.
    """
    blob = audit_receipt._read_file(workspace, relative)
    return blob, {"path": relative, "bytes": len(blob), "sha256": audit_receipt.digest(blob)}


def hand_over(blob: bytes, name: str, target_directory: Path) -> Path:
    """Put bytes the owner read where the engine can read them, and nowhere else."""
    target = target_directory / Path(name).name
    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o640)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(blob)
        stream.flush()
        os.fsync(stream.fileno())
    os.chmod(target, 0o640)
    return target


def _wait_for_exit(pid: int, timeout: float | None) -> bool:
    """True once the process has exited (left unreaped); False when `timeout` seconds pass first.

    No timeout waits as long as the engine runs.
    """
    if hasattr(os, "waitid"):
        if timeout is None:
            os.waitid(os.P_PID, pid, os.WEXITED | os.WNOWAIT)
            return True
        deadline = time.monotonic() + timeout
        while True:
            if os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None:
                return True
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return False
            time.sleep(min(0.05, remaining))
    # macOS exposes process-exit notification through kqueue. Like WNOWAIT, it
    # leaves the child unreaped until its group is stopped.
    with closing(select.kqueue()) as queue:
        event = select.kevent(pid, filter=select.KQ_FILTER_PROC, flags=select.KQ_EV_ADD, fflags=select.KQ_NOTE_EXIT)
        try:
            return bool(queue.control([event], 1, timeout))
        except ProcessLookupError:
            # A very short-lived child can exit before registration.
            # This owner has not waited/reaped it, so its PID is held.
            return True


def run(
    command: list[str], *, credentials: dict[str, Any], cwd: str, env: dict[str, str], log: Any,
    timeout: float | None = None,
) -> int:
    """Run the engine in its own session and stop everything it left behind.

    The leader is waited for without being reaped, so its process-group id
    cannot be reused while the rest of the group is killed; then it is reaped.
    A child that outlived the engine could otherwise still write into the stage
        between the worker's observation and publication.

    `timeout` is the engine's wall clock (`job_slots.execution_timeout()`): an
    engine that hangs would hold its slot, and the deployment's one job at a
    time, forever. When it runs out the whole group is stopped like any other
    exit and the engine is reaped, and then `ExecutionTimeout` is raised, so the
    caller can still publish what the engine had written.
    """
    process = subprocess.Popen(
        command, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
        start_new_session=True, **credentials,
    )
    exited = True
    try:
        exited = _wait_for_exit(process.pid, timeout)
    finally:
        if credentials:
            _as_analysis(credentials, _STOP_GROUP, str(process.pid))
        else:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
    code = process.wait()
    if not exited:
        raise ExecutionTimeout("the engine ran past its execution limit")
    return code


def _walk(directory: int, parts: tuple[str, ...], found: list[tuple[tuple[str, ...], int]]) -> None:
    for name in sorted(os.listdir(directory)):
        info = os.stat(name, dir_fd=directory, follow_symlinks=False)
        if stat.S_ISDIR(info.st_mode):
            with audit_receipt.directory_fd(directory, (name,)) as child:
                _walk(child, (*parts, name), found)
        elif stat.S_ISREG(info.st_mode):
            found.append(((*parts, name), info.st_size))
        else:
            # A link or a device is never published: following one is how an
            # engine would hand the owner a file it may not read itself.
            raise IsolatedJobError("the engine left something other than files and directories in its output")
        if len(found) > MAX_PUBLISHED_FILES:
            raise IsolatedJobError("the engine produced more files than one job may publish")


@contextmanager
def _destination_directory(root: int, parts: tuple[str, ...]) -> Iterator[int]:
    """Create and open directories relative to a pinned descriptor, never links."""
    with ExitStack() as stack:
        parent = stack.enter_context(audit_receipt.directory_fd(root))
        for part in parts:
            if audit_receipt._parts(part) != [part]:
                raise IsolatedJobError("the output directory is invalid")
            try:
                os.mkdir(part, mode=0o755, dir_fd=parent)
            except FileExistsError:
                pass
            parent = stack.enter_context(audit_receipt.directory_fd(parent, (part,)))
        yield parent


def _assert_directory_at(root: int, parts: tuple[str, ...], descriptor: int) -> None:
    """A replaced directory cannot produce a receipt for a different path."""
    with audit_receipt.directory_fd(root, parts) as current:
        before, now = os.fstat(descriptor), os.fstat(current)
        if (before.st_dev, before.st_ino) != (now.st_dev, now.st_ino):
            raise IsolatedJobError("the output directory changed during publication")


def publish(source: Path, output_root: Path, workspace: Path) -> list[dict[str, Any]]:
    """Publish regular files through pinned, no-follow workspace descriptors.

    O_EXCL preserves existing results. Reopening the descriptor chain before and
    after each write detects replaced parents before emitting relative receipts.
    """
    found: list[tuple[tuple[str, ...], int]] = []
    output_parts = output_root.relative_to(workspace).parts
    if not workspace.is_absolute():
        raise IsolatedJobError("the workspace directory is invalid")
    workspace_parts = workspace.parts[1:]
    with (audit_receipt.directory_fd(source) as directory,
          audit_receipt.directory_fd(workspace.anchor) as filesystem_fd,
          audit_receipt.directory_fd(filesystem_fd, workspace_parts) as workspace_fd,
          audit_receipt.directory_fd(workspace_fd, output_parts) as output_fd):
        _walk(directory, (), found)
        if sum(size for _, size in found) > MAX_PUBLISHED_BYTES:
            raise IsolatedJobError("the engine's outputs exceed what one job may publish")
        rows = []
        for parts, _ in found:
            blob = audit_receipt._read_file(directory, "/".join(parts))
            _assert_directory_at(filesystem_fd, workspace_parts, workspace_fd)
            _assert_directory_at(workspace_fd, output_parts, output_fd)
            parent_parts = (*output_parts, *parts[:-1])
            with _destination_directory(output_fd, parts[:-1]) as parent:
                _assert_directory_at(workspace_fd, parent_parts, parent)
                descriptor = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                     0o644, dir_fd=parent)
                with os.fdopen(descriptor, "wb") as stream:
                    stream.write(blob)
                    stream.flush()
                    os.fsync(stream.fileno())
                _assert_directory_at(workspace_fd, parent_parts, parent)
                _assert_directory_at(filesystem_fd, workspace_parts, workspace_fd)
            rows.append({
                "path": "/".join((*output_parts, *parts)),
                "bytes": len(blob),
                "sha256": hashlib.sha256(blob).hexdigest(),
            })
    return rows


def file_row(workspace: Path, target: Path) -> dict[str, Any]:
    """The receipt row of a file the owner itself wrote into the workspace."""
    relative = target.relative_to(workspace).as_posix()
    blob = audit_receipt._read_file(workspace, relative)
    return {"path": relative, "bytes": len(blob), "sha256": audit_receipt.digest(blob)}
