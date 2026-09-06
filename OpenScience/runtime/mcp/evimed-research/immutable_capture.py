"""Content-addressed source captures published once inside the managed workspace."""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import stat
from pathlib import Path


class ImmutableCaptureError(Exception):
    """A source capture cannot be safely created or its existing bytes differ."""


def _matches(directory: int, name: str, payload: bytes) -> bool:
    try:
        descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    except FileNotFoundError:
        return False
    with os.fdopen(descriptor, "rb") as source:
        metadata = os.fstat(source.fileno())
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size != len(payload):
            raise ImmutableCaptureError("An existing immutable source artifact does not match its capture.")
        if source.read(len(payload) + 1) != payload:
            raise ImmutableCaptureError("An existing immutable source artifact does not match its capture.")
    return True


def _publish(directory: int, name: str, payload: bytes) -> None:
    if _matches(directory, name, payload):
        return
    temporary = ".%s.%s.tmp" % (name, secrets.token_hex(8))
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
    try:
        with os.fdopen(descriptor, "wb") as target:
            target.write(payload)
            target.flush()
            os.fsync(target.fileno())
        try:
            # Linking a fully written sibling publishes atomically without ever
            # replacing a file another retrieval already bound into evidence.
            os.link(temporary, name, src_dir_fd=directory, dst_dir_fd=directory, follow_symlinks=False)
            os.fsync(directory)
        except FileExistsError:
            if not _matches(directory, name, payload):
                raise ImmutableCaptureError("The source capture changed during publication.")
    finally:
        os.unlink(temporary, dir_fd=directory)


def preserve(workspace: Path, relative_root: Path, artifacts: dict[str, bytes]) -> dict[str, str]:
    """Reuse a complete byte-identical capture; changed bytes get a new version."""
    if relative_root.is_absolute() or ".." in relative_root.parts:
        raise ImmutableCaptureError("Managed source capture paths must stay in the workspace.")
    if not artifacts or any(not name or Path(name).name != name or "\\" in name or name in {".", ".."} for name in artifacts):
        raise ImmutableCaptureError("Source capture artifacts must use plain file names.")
    hashes = {name: hashlib.sha256(payload).hexdigest() for name, payload in artifacts.items()}
    version = hashlib.sha256(json.dumps(hashes, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
    relative = relative_root / version
    directory = None
    try:
        directory = os.open(workspace, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        for component in relative.parts:
            try:
                os.mkdir(component, 0o700, dir_fd=directory)
            except FileExistsError:
                pass
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
        for name, payload in artifacts.items():
            _publish(directory, name, payload)
    except OSError as error:
        raise ImmutableCaptureError("The managed source capture could not be safely preserved.") from error
    finally:
        if directory is not None:
            os.close(directory)
    return {name: (relative / name).as_posix() for name in artifacts}
