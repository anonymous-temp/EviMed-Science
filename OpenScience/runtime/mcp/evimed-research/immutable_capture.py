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


# The digest ledger every capture carries, written beside the artifacts it
# describes.
#
# `.evimed-sources/` was writable by the run until 2026-09-10, and every
# verbatim-quote check in the clinical gate reads the bytes on disk: a run that
# could edit a preserved full text did not have to fabricate a source, only
# correct one, and the quote would then match. The write guard now refuses those
# paths (`PROTECTED_WRITE_PREFIXES` in @evimed/domain), which stops the model's
# own tools. It does not prove after the fact that nothing else did.
#
# The digests were already computed here — `preserve` hashes every payload to
# build the version — and then thrown away, so verifying a capture later meant
# fetching the source again. They are written down instead. The manifest is
# derived entirely from bytes this function already has, so a re-capture of
# identical content produces identical manifest bytes and `_publish` reuses it.
CAPTURE_MANIFEST_NAME = "capture.json"
CAPTURE_MANIFEST_SCHEMA = 1


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


def _manifest_payload(version: str, hashes: dict[str, str]) -> bytes:
    """The manifest bytes for one capture. Deterministic: same capture, same bytes."""
    return json.dumps(
        {"schemaVersion": CAPTURE_MANIFEST_SCHEMA, "version": version, "artifacts": dict(sorted(hashes.items()))},
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")


def verify_capture(workspace: Path, capture_dir: Path) -> list[str]:
    """What no longer matches in a preserved capture. Empty means intact.

    Reads the manifest written at capture time and re-hashes every artifact it
    names. Returns findings rather than raising, because a caller wants all of
    them — "which of these five sources was edited" is the question, and an
    exception answers only the first.

    Two things are checked, and both are needed. Each artifact against its
    recorded digest, which catches an edit. And the directory name against the
    manifest's own version, which catches a manifest replaced wholesale to
    describe the edit: the directory name is `sha256` over the artifact digests,
    so a consistent lie has to change the path, and the path is what the
    evidence rows and the citations point at.
    """
    findings: list[str] = []
    directory = workspace / capture_dir
    manifest_path = directory / CAPTURE_MANIFEST_NAME
    if not manifest_path.is_file() or manifest_path.is_symlink():
        return ["%s has no %s, so its artifacts cannot be verified" % (capture_dir.as_posix(), CAPTURE_MANIFEST_NAME)]
    try:
        manifest = json.loads(manifest_path.read_bytes().decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return ["%s/%s is not readable JSON" % (capture_dir.as_posix(), CAPTURE_MANIFEST_NAME)]
    recorded = manifest.get("artifacts")
    if not isinstance(recorded, dict) or not recorded:
        return ["%s/%s records no artifact digests" % (capture_dir.as_posix(), CAPTURE_MANIFEST_NAME)]
    for name, digest in sorted(recorded.items()):
        artifact = directory / name
        if not artifact.is_file() or artifact.is_symlink():
            findings.append("%s/%s is recorded in the capture and is not on disk" % (capture_dir.as_posix(), name))
            continue
        actual = hashlib.sha256(artifact.read_bytes()).hexdigest()
        if actual != digest:
            findings.append(
                "%s/%s was edited after capture (recorded %s, on disk %s)"
                % (capture_dir.as_posix(), name, str(digest)[:12], actual[:12])
            )
    expected_version = hashlib.sha256(
        json.dumps({k: str(v) for k, v in recorded.items()}, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    if capture_dir.name != expected_version:
        findings.append(
            "%s does not match the digests its manifest records (expected directory %s)"
            % (capture_dir.as_posix(), expected_version)
        )
    return findings


def preserve(workspace: Path, relative_root: Path, artifacts: dict[str, bytes]) -> dict[str, str]:
    """Reuse a complete byte-identical capture; changed bytes get a new version."""
    if relative_root.is_absolute() or ".." in relative_root.parts:
        raise ImmutableCaptureError("Managed source capture paths must stay in the workspace.")
    if not artifacts or any(not name or Path(name).name != name or "\\" in name or name in {".", ".."} for name in artifacts):
        raise ImmutableCaptureError("Source capture artifacts must use plain file names.")
    if CAPTURE_MANIFEST_NAME in artifacts:
        raise ImmutableCaptureError("%s is the capture's own digest ledger and cannot be an artifact." % CAPTURE_MANIFEST_NAME)
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
        # Last, so a manifest never describes a capture that failed halfway.
        _publish(directory, CAPTURE_MANIFEST_NAME, _manifest_payload(version, hashes))
    except OSError as error:
        raise ImmutableCaptureError("The managed source capture could not be safely preserved.") from error
    finally:
        if directory is not None:
            os.close(directory)
    # Deliberately not calling `verify_capture` here. Re-capturing the same
    # source supplies the same artifact set — the set is what names the
    # directory — so `_publish` has already compared every one of them byte for
    # byte. `verify_capture` exists for the caller that holds a path and no
    # bytes: the control plane checking a finished package, long after the
    # retrieval that produced it.
    return {name: (relative / name).as_posix() for name in artifacts}
