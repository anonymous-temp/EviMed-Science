"""Run a shared-adapter engine as the separate analysis UID.

A signed receipt is worth only as much as the key behind it, and the engine is
the one process in this container that handles untrusted input -- a
manuscript, a retrieved record, a model's answer. So when this adapter holds an
audit signing key (docker-compose.specialist-audit.yml), no engine runs with
the adapter's identity: it runs as the analysis UID that
``audit_receipt.analysis_credentials`` names, in a private stage under /tmp it
can write, with the inputs it needs copied in by the owner process and no way
into the workspace or the key. The owner hashes what it hands over and what
comes back, and publishes the outputs into the workspace itself, so the rows it
signs are bytes it held and the engine can no longer change. The MR engine does
the same inside its own ``evimed_mr_job.py``; this is that property for every
other engine the adapter runs.

Every function here also runs with empty credentials (no UID change), which is
how the test suite drives it without root; the UID change itself is the one
thing only a Linux owner process with SETUID/SETGID can exercise.
"""
from __future__ import annotations

import hashlib
import os
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
from contextlib import contextmanager
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


def run(command: list[str], *, credentials: dict[str, Any], cwd: str, env: dict[str, str], log: Any) -> int:
    """Run the engine in its own session and stop everything it left behind.

    The leader is waited for without being reaped, so its process-group id
    cannot be reused while the rest of the group is killed; then it is reaped.
    A child that outlived the engine could otherwise still write into the stage
    between publication and the signature.
    """
    process = subprocess.Popen(
        command, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
        start_new_session=True, **credentials,
    )
    try:
        os.waitid(os.P_PID, process.pid, os.WEXITED | os.WNOWAIT)
    finally:
        if credentials:
            _as_analysis(credentials, _STOP_GROUP, str(process.pid))
        else:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
    return process.wait()


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


def publish(source: Path, output_root: Path, workspace: Path) -> list[dict[str, Any]]:
    """Copy the engine's outputs into the workspace, receipting each as it is written.

    Read through no-follow descriptors, written with O_EXCL: nothing the engine
    arranged in its stage can make the owner read or overwrite anything else.
    Returns the rows, workspace-relative.
    """
    found: list[tuple[tuple[str, ...], int]] = []
    with audit_receipt.directory_fd(source) as directory:
        _walk(directory, (), found)
        if sum(size for _, size in found) > MAX_PUBLISHED_BYTES:
            raise IsolatedJobError("the engine's outputs exceed what one job may publish")
        rows = []
        for parts, _ in found:
            blob = audit_receipt._read_file(directory, "/".join(parts))
            target = output_root.joinpath(*parts)
            for parent in reversed(target.relative_to(output_root).parents[:-1]):
                (output_root / parent).mkdir(mode=0o755, exist_ok=True)
            descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(blob)
                stream.flush()
                os.fsync(stream.fileno())
            rows.append({
                "path": target.relative_to(workspace).as_posix(),
                "bytes": len(blob),
                "sha256": hashlib.sha256(blob).hexdigest(),
            })
    return rows


def file_row(workspace: Path, target: Path) -> dict[str, Any]:
    """The receipt row of a file the owner itself wrote into the workspace."""
    relative = target.relative_to(workspace).as_posix()
    blob = audit_receipt._read_file(workspace, relative)
    return {"path": relative, "bytes": len(blob), "sha256": audit_receipt.digest(blob)}
