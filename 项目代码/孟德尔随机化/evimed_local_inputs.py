"""Bounded, descriptor-based preparation of declared hosted GWAS inputs.

This module uses only the standard library so the adapter can load the same
reviewed implementation without importing an agent, an R engine, or a model.
"""

from __future__ import annotations

import base64
import binascii
import copy
import csv
import hashlib
import io
import json
import math
import os
import re
import stat
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

MAX_INPUT_BYTES = 128 * 1024 * 1024
MAX_INPUT_ROWS = 2_000_000
MANIFEST_NAME = "mendelian-randomization-inputs.json"
STANDARD_MAPPING = {
    "snp": "SNP",
    "beta": "beta",
    "se": "se",
    "effect_allele": "effect_allele",
    "other_allele": "other_allele",
    "eaf": "eaf",
    "pval": "pval",
}
SOURCE_KEYS = {
    "type",
    "path",
    "columnMapping",
    "sampleSize",
    "effectScale",
    "population",
    "instrumentsPreclumped",
    "clumpingProvenance",
}


#: Open repositories this engine reads without any credential (see
#: mr_agent/tools/open_sumstats.py). The adapter reads this to report that the
#: engine can run without OpenGWAS.
OPEN_DATA_SOURCES = ("gwas_catalog",)
OPEN_PROVENANCE_NAME = "mendelian-randomization-open-sources.json"
OPEN_INPUT_NAMES = {"exposure": "open-exposure.csv", "outcome": "open-outcome.csv"}


class MRInputError(ValueError):
    """A stable public error; never carries an OS path or underlying exception."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _invalid(message: str) -> MRInputError:
    return MRInputError("mr_input_invalid", message)


def _text(value: Any, limit: int) -> bool:
    return (
        isinstance(value, str)
        and bool(value.strip())
        and len(value) <= limit
        and not any(ord(char) < 32 or ord(char) == 127 for char in value)
    )


def relative_parts(value: Any) -> tuple[str, ...]:
    """Accept literal relative components before pathlib can normalize them."""
    if not _text(value, 512) or value.startswith("/") or "\\" in value or ":" in value:
        raise MRInputError(
            "mr_input_path_invalid", "GWAS files must use workspace-relative CSV or TSV paths."
        )
    parts = tuple(value.split("/"))
    if any(part in {"", ".", ".."} for part in parts):
        raise MRInputError(
            "mr_input_path_invalid", "GWAS paths must not contain empty, dot or parent components."
        )
    return parts


def _validate_source(source: Any) -> None:
    if not isinstance(source, dict):
        raise _invalid("Each GWAS source must be an object.")
    scale = source.get("effectScale")
    if "effectScale" in source and (not isinstance(scale, dict) or not scale or set(scale) - {"unit", "transformation", "evidence"}
                              or any(not _text(value, 1000) for value in scale.values())):
        raise _invalid("effectScale accepts only bounded unit, transformation and evidence declarations.")
    if source.get("type") == "opengwas":
        if (
            set(source) - {"effectScale"} != {"type", "gwasId"}
            or not isinstance(source["gwasId"], str)
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", source["gwasId"])
        ):
            raise _invalid("An OpenGWAS source requires one explicit GWAS identifier.")
        return
    if source.get("type") == "gwas_catalog":
        # One identifier the catalogue itself resolves: a study accession, or
        # the PubMed id of the paper when it has a single study with full
        # summary statistics. Never a trait name the engine would have to guess.
        keys = set(source) - {"type", "effectScale"}
        if not (
            (keys == {"accession"} and isinstance(source["accession"], str)
             and re.fullmatch(r"GCST\d{6,9}", source["accession"]))
            or (keys == {"pubmedId"} and isinstance(source["pubmedId"], str)
                and re.fullmatch(r"\d{1,9}", source["pubmedId"]))
        ):
            raise _invalid(
                "A GWAS Catalog source requires exactly one of accession (GCST...) or pubmedId."
            )
        return
    required = {"type", "path", "columnMapping", "instrumentsPreclumped"}
    if (
        source.get("type") != "local_file"
        or set(source) - SOURCE_KEYS
        or not required <= set(source)
    ):
        raise _invalid(
            "A local GWAS source requires a path, complete column mapping "
            "and explicit clumping flag."
        )
    parts = relative_parts(source["path"])
    if Path(parts[-1]).suffix.lower() not in {".csv", ".tsv"}:
        raise MRInputError("mr_input_path_invalid", "Only CSV and TSV GWAS files are supported.")
    mapping = source["columnMapping"]
    if (
        not isinstance(mapping, dict)
        or not set(STANDARD_MAPPING) <= set(mapping)
        or set(mapping) - set(STANDARD_MAPPING) - {"samplesize"}
        or any(not _text(value, 128) for value in mapping.values())
        or len(set(mapping.values())) != len(mapping)
    ):
        raise _invalid("Map each of the seven required GWAS columns to a distinct nonempty header.")
    if not isinstance(source["instrumentsPreclumped"], bool):
        raise _invalid("instrumentsPreclumped must be a JSON boolean.")
    if "sampleSize" in source and (
        isinstance(source["sampleSize"], bool)
        or not isinstance(source["sampleSize"], int)
        or not 1 <= source["sampleSize"] <= 1_000_000_000_000
    ):
        raise _invalid("sampleSize must be a positive integer no greater than 1000000000000.")
    if "population" in source and not _text(source["population"], 1000):
        raise _invalid(
            "population must be a nonempty declared population of at most 1000 characters."
        )
    if "clumpingProvenance" in source and not _text(source["clumpingProvenance"], 4000):
        raise _invalid(
            "clumpingProvenance must be a nonempty statement of at most 4000 characters."
        )
    if source["instrumentsPreclumped"] and not source.get("clumpingProvenance"):
        raise _invalid("Preclumped instruments require explicit source and selection provenance.")


def validate_request(request: dict[str, Any]) -> bool:
    """Validate source semantics; omitted paired sources retain legacy routing."""
    present = [key in request for key in ("exposureSource", "outcomeSource")]
    if not any(present):
        return False
    if not all(present):
        raise _invalid(
            "A local request must explicitly specify both exposureSource and outcomeSource."
        )
    for role in ("exposure", "outcome"):
        if not _text(request.get(role), 4000):
            raise _invalid("Exposure and outcome must be nonempty trait names.")
        _validate_source(request[f"{role}Source"])
    if request.get("analysisDirection", "forward") not in {"forward", "bidirectional"}:
        raise _invalid("analysisDirection must be forward or bidirectional.")
    types = {request[f"{role}Source"]["type"] for role in ("exposure", "outcome")}
    if "gwas_catalog" in types:
        if types != {"gwas_catalog"}:
            raise _invalid(
                "GWAS Catalog sources are read as a pair: give both exposureSource and "
                "outcomeSource as gwas_catalog, or supply local files."
            )
        if request.get("analysisDirection", "forward") != "forward":
            # Each direction selects its own instruments from its own exposure;
            # one job reads one direction honestly.
            raise MRInputError(
                "mr_input_direction_unsupported",
                "GWAS Catalog sources run one direction per job: start a forward job, then a "
                "second forward job with exposure and outcome swapped for the reverse direction.",
            )
        return True
    if "local_file" not in types:
        raise _invalid(
            "Explicit source objects require at least one local file; use "
            "legacy text inputs for remote-only analysis."
        )
    return True


def open_catalog_pair(request: dict[str, Any]) -> bool:
    """Both roles are GWAS Catalog studies the engine reads itself."""
    return validate_request(request) and all(
        request[f"{role}Source"]["type"] == "gwas_catalog" for role in ("exposure", "outcome")
    )


def require_remote_access(request: dict[str, Any], token_available: bool) -> None:
    """No-token execution may use only independently declared preclumped roles."""
    if token_available or open_catalog_pair(request):
        return
    if any(request[f"{role}Source"]["type"] == "opengwas" for role in ("exposure", "outcome")):
        raise MRInputError(
            "mr_input_remote_auth_required",
            "Mixed local/OpenGWAS analysis requires the configured OpenGWAS credential.",
        )
    roles = (
        ("exposure", "outcome")
        if request.get("analysisDirection") == "bidirectional"
        else ("exposure",)
    )
    if any(not request[f"{role}Source"]["instrumentsPreclumped"] for role in roles):
        raise MRInputError(
            "mr_input_clumping_required",
            "Without an OpenGWAS credential, each analyzed exposure needs "
            "supplied preclumped instruments and provenance.",
        )


def _jwt_expiry(token: str) -> float | None:
    """The ``exp`` claim of a JWT, read without verifying it; None when unreadable."""
    parts = token.split(".")
    if len(parts) != 3 or not parts[1]:
        return None
    try:
        payload = base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4))
        claims = json.loads(payload.decode("utf-8"))
    except (ValueError, UnicodeError, binascii.Error):
        return None
    expiry = claims.get("exp") if isinstance(claims, dict) else None
    if isinstance(expiry, bool) or not isinstance(expiry, (int, float)) or not math.isfinite(expiry):
        return None
    return float(expiry)


def opengwas_credential_state(token: str | None, *, now: float | None = None) -> dict[str, Any]:
    """Whether an OpenGWAS JWT can be used, decided without calling OpenGWAS.

    OpenGWAS has required a JWT since 1 May 2024 and issues it for 14 days, so
    an absent token and an expired one are the same outage. A token whose
    claims cannot be read is reported usable with no expiry: only OpenGWAS can
    judge it, and a health check must not call a third party. The token itself
    is never part of the answer.
    """
    value = (token or "").strip()
    if not value:
        return {"ready": False, "reason": "opengwas_token_missing", "expiresAt": None}
    expiry = _jwt_expiry(value)
    expires_at = (
        datetime.fromtimestamp(expiry, timezone.utc).isoformat().replace("+00:00", "Z")
        if expiry is not None
        else None
    )
    if expiry is not None and expiry <= (time.time() if now is None else now):
        return {"ready": False, "reason": "opengwas_token_expired", "expiresAt": expires_at}
    return {"ready": True, "reason": None, "expiresAt": expires_at}


def require_admission_credential(request: dict[str, Any], credential: dict[str, Any]) -> None:
    """Refuse at admission a job that could only fail for want of OpenGWAS.

    Legacy text requests select their instruments from OpenGWAS, and a declared
    OpenGWAS source reads it; both need a usable credential. Two local files
    with declared preclumped instruments need none. Before this, a job without
    a token was accepted, queued, and failed minutes later inside the engine.
    """
    if credential.get("ready"):
        return
    local = validate_request(request)
    if local and not any(
        request[f"{role}Source"]["type"] == "opengwas" for role in ("exposure", "outcome")
    ):
        # Local files only: the existing rule names what is missing (supplied
        # preclumped instruments), which is the researcher's to correct.
        require_remote_access(request, False)
        return
    expired = credential.get("reason") == "opengwas_token_expired"
    raise MRInputError(
        "mr_input_remote_auth_required",
        (
            f"blocked: OpenGWAS token expired ({credential.get('expiresAt')}). "
            if expired
            else "blocked: OpenGWAS token missing. "
        )
        + (
            "This analysis reads an OpenGWAS source, "
            if local
            else "This analysis selects its instruments from OpenGWAS by trait name, "
        )
        + "and neither this deployment nor this researcher has a usable OpenGWAS JWT. "
        "Without one, give both sides as GWAS Catalog studies "
        '({"type": "gwas_catalog", "accession": "GCST..."}), which are open, '
        "or two uploaded GWAS files with declared preclumped instruments.",
    )


def _identity(info: os.stat_result, *, directory: bool = False) -> dict[str, int]:
    value = {"device": info.st_dev, "inode": info.st_ino}
    if not directory:
        value.update(size=info.st_size, mtimeNs=info.st_mtime_ns, ctimeNs=info.st_ctime_ns)
    return value


@contextmanager
def directory_fd(root: Path | int, parts: tuple[str, ...] = ()) -> Iterator[int]:
    """Walk from an operator-owned root without following any child symlink."""
    if any(part in {"", ".", ".."} or "/" in part or "\\" in part for part in parts):
        raise MRInputError(
            "mr_input_path_invalid", "Managed directory components must remain inside their root."
        )
    descriptor = (
        os.dup(root)
        if isinstance(root, int)
        else os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    )
    try:
        for part in parts:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        yield descriptor
    finally:
        os.close(descriptor)


@contextmanager
def _regular_file(parent: int, parts: tuple[str, ...]) -> Iterator[int]:
    directory = os.dup(parent)
    descriptor = None
    try:
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = child
        descriptor = os.open(
            parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory
        )
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise MRInputError(
                "mr_input_path_invalid",
                "GWAS inputs must be ordinary files without symbolic or hard links.",
            )
        if info.st_size > MAX_INPUT_BYTES:
            raise MRInputError("mr_input_size_limit", "A GWAS input exceeds the 128 MiB limit.")
        yield descriptor
    finally:
        if descriptor is not None:
            os.close(descriptor)
        os.close(directory)


def capture_bindings(workspace: Path, request: dict[str, Any], data_root: Path) -> dict[str, Any]:
    """Capture identities at admission; read and normalize bytes only in worker."""
    local = validate_request(request)
    try:
        parts = workspace.absolute().relative_to(data_root.resolve()).parts
        with directory_fd(data_root.resolve(), parts) as parent:
            binding: dict[str, Any] = {
                "workspace": _identity(os.fstat(parent), directory=True),
                "files": {},
            }
            if not local:
                return binding
            for role in ("exposure", "outcome"):
                source = request[f"{role}Source"]
                if source["type"] == "local_file":
                    with _regular_file(parent, relative_parts(source["path"])) as descriptor:
                        binding["files"][role] = _identity(os.fstat(descriptor))
            return binding
    except (OSError, ValueError) as error:
        if isinstance(error, MRInputError):
            raise
        raise MRInputError(
            "mr_input_path_invalid", "A declared GWAS file or workspace is unavailable or unsafe."
        ) from None


def _read_source(parent: int, source: dict[str, Any], expected: dict[str, int]) -> bytes:
    with _regular_file(parent, relative_parts(source["path"])) as descriptor:
        if _identity(os.fstat(descriptor)) != expected:
            raise MRInputError(
                "mr_input_changed",
                "A GWAS input changed after this job was queued; submit a new job.",
            )
        with os.fdopen(os.dup(descriptor), "rb") as stream:
            contents = stream.read(MAX_INPUT_BYTES + 1)
        if len(contents) > MAX_INPUT_BYTES:
            raise MRInputError("mr_input_size_limit", "A GWAS input exceeds the 128 MiB limit.")
        if _identity(os.fstat(descriptor)) != expected:
            raise MRInputError(
                "mr_input_changed", "A GWAS input changed during its read; submit a new job."
            )
        return contents


def _normalized_row(row: list[str], indexes: list[int]) -> list[str]:
    values = [row[index].strip() for index in indexes]
    snp, beta, se, effect, other, eaf, pval = values
    if not re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", snp) or any(
        not re.fullmatch(r"[ACGTIDacgtid]{1,256}", allele) for allele in (effect, other)
    ):
        raise _invalid("SNP identifiers and alleles must use standard nonempty GWAS notation.")
    try:
        numbers = [float(value) for value in (beta, se, eaf, pval)]
    except ValueError:
        raise _invalid(
            "GWAS beta, standard error, allele frequency and p-value must be numeric."
        ) from None
    if (
        not all(math.isfinite(value) for value in numbers)
        or numbers[1] <= 0
        or not 0 <= numbers[2] <= 1
        or not 0 <= numbers[3] <= 1
    ):
        raise _invalid(
            "GWAS numeric values must be finite, SE positive, and EAF/p-value between zero and one."
        )
    values[3], values[4] = effect.upper(), other.upper()
    return values


def _normalize(contents: bytes, source: dict[str, Any]) -> tuple[bytes, int]:
    try:
        reader = csv.reader(
            io.StringIO(contents.decode("utf-8-sig"), newline=""),
            delimiter="\t" if source["path"].lower().endswith(".tsv") else ",",
            strict=True,
        )
        headers = next(reader)
        if (
            not headers
            or len(set(headers)) != len(headers)
            or any(not _text(header, 128) for header in headers)
        ):
            raise _invalid("GWAS headers must be nonempty and unique.")
        mapping = source["columnMapping"]
        if any(value not in headers for value in mapping.values()):
            raise _invalid("The supplied GWAS column mapping names a missing header.")
        indexes = [headers.index(mapping[key]) for key in STANDARD_MAPPING]
        output = io.StringIO(newline="")
        writer = csv.writer(output, lineterminator="\n")
        writer.writerow([*STANDARD_MAPPING.values(), *(["samplesize"] if "samplesize" in mapping else [])])
        seen: set[str] = set()
        for row in reader:
            if len(row) != len(headers):
                raise _invalid("A GWAS row does not match the header width.")
            values = _normalized_row(row, indexes)
            if values[0] in seen:
                raise _invalid("GWAS input contains duplicate SNP identifiers.")
            seen.add(values[0])
            if len(seen) > MAX_INPUT_ROWS:
                raise MRInputError(
                    "mr_input_size_limit", "A GWAS input exceeds the 2000000-row limit."
                )
            if "samplesize" in mapping:
                value = row[headers.index(mapping["samplesize"])].strip()
                if value and (not math.isfinite(float(value)) or not 0 < float(value) <= 1e12):
                    raise _invalid("Variant sample sizes must be positive finite numbers or empty.")
                values.append(value)
            writer.writerow(values)
        if not seen:
            raise _invalid("GWAS input must contain at least one data row.")
        return output.getvalue().encode("utf-8"), len(seen)
    except (UnicodeError, csv.Error, StopIteration):
        raise _invalid("GWAS input must be a nonempty, valid UTF-8 CSV or TSV table.") from None


def _write_new(parent: int, name: str, content: bytes) -> None:
    descriptor = os.open(
        name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent
    )
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())


def prepare_sources(
    workspace: Path,
    output_root: Path,
    request: dict[str, Any],
    bindings: dict[str, Any],
    data_root: Path,
    *,
    token_available: bool,
    output_directory_fd: int | None = None,
) -> dict[str, Any]:
    """Stage fixed filenames from safe FDs and publish relative input provenance."""
    validate_request(request)
    require_remote_access(request, token_available)
    prepared = copy.deepcopy(request)
    manifest: dict[str, Any] = {"schemaVersion": 1, "sources": {}}
    try:
        parts = workspace.absolute().relative_to(data_root.resolve()).parts
        output_parts = (
            output_root.absolute().relative_to(workspace.absolute()).parts
            if output_directory_fd is None
            else ()
        )
        with directory_fd(data_root.resolve(), parts) as parent:
            if _identity(os.fstat(parent), directory=True) != bindings.get("workspace"):
                raise MRInputError(
                    "mr_input_changed", "The project workspace changed after admission."
                )
            with directory_fd(
                output_directory_fd if output_directory_fd is not None else parent, output_parts
            ) as output:
                os.mkdir("inputs", mode=0o700, dir_fd=output)
                with directory_fd(output, ("inputs",)) as inputs:
                    for role in ("exposure", "outcome"):
                        source = request[f"{role}Source"]
                        if source["type"] != "local_file":
                            manifest["sources"][role] = copy.deepcopy(source)
                            continue
                        raw = _read_source(parent, source, bindings.get("files", {}).get(role, {}))
                        canonical, rows = _normalize(raw, source)
                        _write_new(inputs, f"{role}.csv", canonical)
                        manifest["sources"][role] = {
                            **copy.deepcopy(source),
                            "sha256": hashlib.sha256(raw).hexdigest(),
                            "bytes": len(raw),
                            "rows": rows,
                            "metadata_source": "provided_local_data",
                            "verification_status": "supplied_not_independently_verified",
                            "ld_rechecked": False,
                            "preparedPath": f"inputs/{role}.csv",
                            "preparedSha256": hashlib.sha256(canonical).hexdigest(),
                            "preparedBytes": len(canonical),
                        }
                        prepared[f"{role}Source"].update(
                            path=f"inputs/{role}.csv", columnMapping={**STANDARD_MAPPING, **({"samplesize": "samplesize"} if "samplesize" in source["columnMapping"] else {})}
                        )
                if capture_bindings(workspace, request, data_root) != bindings:
                    raise MRInputError(
                        "mr_input_changed",
                        "A GWAS input or its workspace changed during preparation.",
                    )
                _write_new(
                    output,
                    MANIFEST_NAME,
                    json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8"),
                )
        return {"request": prepared, "sources": copy.deepcopy(manifest["sources"])}
    except (OSError, ValueError) as error:
        if isinstance(error, MRInputError):
            raise
        raise MRInputError(
            "mr_input_path_invalid",
            "A GWAS input or managed job directory is unavailable or unsafe.",
        ) from None


def _manifest_failure() -> MRInputError:
    return MRInputError(
        "mr_input_manifest_invalid", "The prepared MR input manifest or its bound files is invalid."
    )


def _read_manifest(parent: int) -> dict[str, Any]:
    with (
        _regular_file(parent, (MANIFEST_NAME,)) as descriptor,
        os.fdopen(os.dup(descriptor), "rb") as stream,
    ):
        raw = stream.read(32 * 1024 + 1)
    if len(raw) > 32 * 1024:
        raise _manifest_failure()
    value = json.loads(raw)
    if (
        not isinstance(value, dict)
        or value.get("schemaVersion") != 1
        or not isinstance(value.get("sources"), dict)
    ):
        raise _manifest_failure()
    if set(value["sources"]) != {"exposure", "outcome"}:
        raise _manifest_failure()
    return value["sources"]


def _verify_prepared(
    parent: int, role: str, source: dict[str, Any], record: dict[str, Any]
) -> bytes:
    expected_path = f"inputs/{role}.csv"
    normalized_mapping = {**STANDARD_MAPPING, **({"samplesize": "samplesize"} if "samplesize" in record.get("columnMapping", {}) else {})}
    if source.get("path") != expected_path or source.get("columnMapping") != normalized_mapping:
        raise _manifest_failure()
    original = {key: value for key, value in record.items() if key in SOURCE_KEYS}
    _validate_source(original)
    expected_source = {**original, "path": expected_path, "columnMapping": normalized_mapping}
    if source != expected_source or record.get("preparedPath") != expected_path:
        raise _manifest_failure()
    if (
        record.get("metadata_source") != "provided_local_data"
        or record.get("verification_status") != "supplied_not_independently_verified"
        or record.get("ld_rechecked") is not False
    ):
        raise _manifest_failure()
    if not isinstance(record.get("sha256"), str) or not re.fullmatch(
        r"[a-f0-9]{64}", record["sha256"]
    ):
        raise _manifest_failure()
    if (
        isinstance(record.get("bytes"), bool)
        or not isinstance(record.get("bytes"), int)
        or not 1 <= record["bytes"] <= MAX_INPUT_BYTES
    ):
        raise _manifest_failure()
    with _regular_file(parent, ("inputs", f"{role}.csv")) as descriptor:
        expected = _identity(os.fstat(descriptor))
    raw = _read_source(parent, source, expected)
    if len(raw) != record.get("preparedBytes") or hashlib.sha256(raw).hexdigest() != record.get(
        "preparedSha256"
    ):
        raise _manifest_failure()
    normalized, rows = _normalize(raw, source)
    if normalized != raw or rows != record.get("rows"):
        raise _manifest_failure()
    return raw


def runner_sources(
    request: dict[str, Any],
    output_root: Path,
    private_root: Path,
    *,
    authority: dict[str, Any] | None = None,
    output_directory_fd: int | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Build existing DataSources from checked fixed files, copied out of user reach."""
    if not validate_request(request):
        return {}, {}
    from mr_agent.models import ColumnMapping, DataSource, DataSourceType
    from mr_agent.source_context import declared_scale, unknown_scale

    require_remote_access(request, bool(os.getenv("OPENGWAS_JWT", "").strip()))
    if (
        not isinstance(authority, dict)
        or authority.get("request") != request
        or not isinstance(authority.get("sources"), dict)
    ):
        raise _manifest_failure()
    sources = {}
    try:
        absolute = output_root.absolute()
        with directory_fd(
            output_directory_fd if output_directory_fd is not None else Path(absolute.anchor),
            () if output_directory_fd is not None else absolute.parts[1:],
        ) as parent:
            provenance = copy.deepcopy(authority["sources"])
            if _read_manifest(parent) != provenance:
                raise _manifest_failure()
            with directory_fd(private_root.resolve()) as private:
                for role in ("exposure", "outcome"):
                    source = request[f"{role}Source"]
                    record = provenance[role]
                    if source["type"] == "opengwas":
                        if record != source:
                            raise _manifest_failure()
                        sources[role] = DataSource(
                            source_type=DataSourceType.OPENGWAS,
                            gwas_id=source["gwasId"],
                            effect_scale=declared_scale(source.get("effectScale")),
                            trait_name=request[role],
                        )
                        continue
                    raw = _verify_prepared(parent, role, source, record)
                    _write_new(private, f"{role}.csv", raw)
                    sources[role] = DataSource(
                        source_type=DataSourceType.LOCAL_FILE,
                        file_path=str(private_root / f"{role}.csv"),
                        column_mapping=ColumnMapping(**source["columnMapping"]),
                        effect_scale=declared_scale(source.get("effectScale")),
                        trait_name=request[role],
                        sample_size=source.get("sampleSize"),
                        population=source.get("population"),
                        instruments_preclumped=source["instrumentsPreclumped"],
                        clumping_provenance=source.get("clumpingProvenance"),
                    )
        return sources, provenance
    except (OSError, ValueError, TypeError, KeyError) as error:
        if isinstance(error, MRInputError):
            raise
        raise _manifest_failure() from None


def open_catalog_sources(
    request: dict[str, Any],
    output_root: Path,
    private_root: Path,
    *,
    authority: dict[str, Any] | None = None,
    output_directory_fd: int | None = None,
    build: Any = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Read two GWAS Catalog studies into the standard files the local path analyses.

    The accepted request (the worker's authority) names the studies; nothing
    here chooses one. The exact rows analysed are published beside the
    manifest, with a record of every URL read, so the run can be traced and the
    replay package re-run offline.
    """
    from mr_agent.models import ColumnMapping, DataSource, DataSourceType
    from mr_agent.source_context import declared_scale, unknown_scale
    from mr_agent.tools import open_sumstats

    if (
        not open_catalog_pair(request)
        or not isinstance(authority, dict)
        or authority.get("request") != request
        or not isinstance(authority.get("sources"), dict)
    ):
        raise _manifest_failure()
    from mr_agent.source_context import merge_scale
    partial_error = None
    try:
        pair = (build or open_sumstats.build_pair)(request["exposureSource"], request["outcomeSource"])
    except open_sumstats.OpenSourceError as error:
        if error.partial_pair is None:
            raise MRInputError(error.code, str(error)) from None
        pair, partial_error = error.partial_pair, error
    for role in ("exposure", "outcome"):
        samples = pair.record[role].setdefault("sampleMetadata", {}) or {}
        samples["effectScale"] = merge_scale(declared_scale(request[f"{role}Source"].get("effectScale")), samples.get("effectScale") or unknown_scale())
        pair.record[role]["sampleMetadata"] = samples
    try:
        absolute = output_root.absolute()
        with directory_fd(
            output_directory_fd if output_directory_fd is not None else Path(absolute.anchor),
            () if output_directory_fd is not None else absolute.parts[1:],
        ) as parent:
            if _read_manifest(parent) != authority["sources"] or any(
                authority["sources"].get(role) != request[f"{role}Source"] for role in ("exposure", "outcome")
            ):
                raise _manifest_failure()
            with directory_fd(parent, ("inputs",)) as inputs, directory_fd(private_root.resolve()) as private:
                for role, rows in (("exposure", pair.exposure_rows), ("outcome", pair.outcome_rows)):
                    content = open_sumstats.csv_bytes(rows)
                    _write_new(private, OPEN_INPUT_NAMES[role], content)
                    _write_new(inputs, OPEN_INPUT_NAMES[role], content)
                    pair.record[role]["preparedPath"] = f"inputs/{OPEN_INPUT_NAMES[role]}"
                    pair.record[role]["preparedSha256"] = hashlib.sha256(content).hexdigest()
                    pair.record[role]["preparedRows"] = len(rows)
            _write_new(
                parent,
                OPEN_PROVENANCE_NAME,
                json.dumps(pair.record, ensure_ascii=False, indent=2).encode("utf-8"),
            )
    except (OSError, ValueError, TypeError, KeyError) as error:
        if isinstance(error, MRInputError):
            raise
        raise _manifest_failure() from None
    if partial_error is not None:
        raise MRInputError(partial_error.code, str(partial_error)) from None
    mapping = ColumnMapping(**STANDARD_MAPPING, samplesize="samplesize", chr="chr", pos="pos")
    sources = {}
    for role in ("exposure", "outcome"):
        study = pair.record[role]
        sources[role] = DataSource(
            source_type=DataSourceType.GWAS_CATALOG,
            gwas_id=study["accession"],
            file_path=str(private_root / OPEN_INPUT_NAMES[role]),
            column_mapping=mapping,
            trait_name=request[role],
            population=open_sumstats.population_label(study),
            instruments_preclumped=role == "exposure",
            clumping_provenance=open_sumstats.provenance_sentence(pair.record)[:4000] if role == "exposure" else None,
            selection=open_sumstats.selection_record(pair.record) if role == "exposure" else None,
            sample_size=(study.get("sampleMetadata") or {}).get("sampleSize"),
            effect_scale=(study.get("sampleMetadata") or {}).get("effectScale") or unknown_scale(),
        )
    return sources, pair.record


def bind_open_metadata(results: list[Any], record: dict[str, Any], request: dict[str, Any]) -> None:
    """Repository facts for catalogue sources, as the catalogue declares them."""
    from mr_agent.source_context import unknown_scale
    by_accession = {record[role]["accession"]: role for role in ("exposure", "outcome")}
    for result in results:
        for label in ("exposure", "outcome"):
            source_type = getattr(result, f"{label}_source_type")
            if getattr(source_type, "value", source_type) != "gwas_catalog":
                continue
            role = by_accession.get(getattr(result, f"{label}_id"))
            if role is None:
                raise _manifest_failure()
            study = record[role]
            samples = study.get("sampleMetadata") or {}
            setattr(result, f"{label}_scale", copy.deepcopy(samples.get("effectScale") or unknown_scale()))
            own_sizes = (study.get("sampleSize") or {}).get("originalVariantSampleSizes")
            if own_sizes:
                result.source_variant_sample_sizes[label] = copy.deepcopy(own_sizes)
            setattr(result, f"{label}_metadata", {
                "gwas_id": study["accession"],
                "trait": study.get("trait") or request[role],
                "requested_trait": request[role],
                # Verbatim as the catalogue declares them; not parsed into a number.
                "sample_size": study.get("initialSampleSize") or None,
                # As numbers, from the GWAS-SSF metadata file beside the harmonised data.
                "sample_size_total": samples.get("sampleSize"),
                "case_control_study": samples.get("caseControlStudy"),
                "case_count": samples.get("caseCount"),
                "control_count": samples.get("controlCount"),
                "population": "; ".join(study.get("discoveryAncestry") or []) or None,
                "pubmed_id": study.get("pubmedId") or None,
                "repository": study.get("repository"),
                "study_url": study.get("studyUrl"),
                "harmonised_file": study.get("harmonisedFile"),
                "licence": study.get("licence") or None,
                "metadata_source": "gwas_catalog",
                "verification_status": "read_from_repository",
            })
            if isinstance(samples.get("sampleSize"), int):
                setattr(result, f"sample_size_{label}", samples["sampleSize"])


def bind_result_provenance(
    results: list[Any], provenance: dict[str, Any], request: dict[str, Any]
) -> None:
    """Attach supplied local declarations without inventing repository metadata."""
    from mr_agent.source_context import declared_scale
    by_identifier = {
        f"{role}.csv": (role, record)
        for role, record in provenance.items()
        if record["type"] == "local_file"
    }
    for result in results:
        for label in ("exposure", "outcome"):
            source_type = getattr(result, f"{label}_source_type")
            if getattr(source_type, "value", source_type) != "local_file":
                continue
            pair = by_identifier.get(getattr(result, f"{label}_id"))
            if pair is None:
                raise _manifest_failure()
            role, record = pair
            setattr(result, f"{label}_scale", declared_scale(record.get("effectScale")))
            setattr(
                result,
                f"{label}_metadata",
                {
                    "trait": request[role],
                    "sample_size": record.get("sampleSize"),
                    "population": record.get("population"),
                    "metadata_source": "provided_local_data",
                    "verification_status": "supplied_not_independently_verified",
                    "ld_rechecked": False,
                    "input_provenance": copy.deepcopy(record),
                },
            )


def remote_metadata(sources: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Mixed-mode repository facts must come from the existing exact-ID client."""
    from mr_agent.tools import gwas
    from mr_agent.source_context import merge_scale, unknown_scale

    metadata = {}
    for source in sources.values():
        if source.is_local():
            continue
        try:
            metadata[source.gwas_id] = gwas.fetch_gwas_metadata(source.gwas_id)
            metadata[source.gwas_id]["effect_scale"] = merge_scale(source.effect_scale, metadata[source.gwas_id].get("effect_scale") or unknown_scale())
            source.effect_scale = copy.deepcopy(metadata[source.gwas_id]["effect_scale"])
            source.sample_size = metadata[source.gwas_id]["sample_size"]
            source.population = metadata[source.gwas_id]["population"]
        except gwas.OpenGwasAuthError:
            raise MRInputError(
                "mr_input_remote_auth_required",
                "OpenGWAS rejected the configured credential; remote metadata was not read.",
            ) from None
        except gwas.OpenGwasMetadataError:
            raise MRInputError(
                "mr_input_remote_metadata_unavailable",
                "Requested OpenGWAS metadata could not be verified.",
            ) from None
    return metadata


def bind_remote_metadata(results: list[Any], metadata: dict[str, dict[str, Any]]) -> None:
    """Attach verified remote metadata to both forward and reverse role slots."""
    for result in results:
        for role in ("exposure", "outcome"):
            source_type = getattr(result, f"{role}_source_type")
            if getattr(source_type, "value", source_type) != "opengwas":
                continue
            entry = metadata.get(getattr(result, f"{role}_id"))
            if entry is None:
                raise MRInputError(
                    "mr_input_remote_metadata_unavailable",
                    "The MR result does not match verified remote metadata.",
                )
            setattr(result, f"{role}_metadata", copy.deepcopy(entry))
            from mr_agent.source_context import unknown_scale
            setattr(result, f"{role}_scale", copy.deepcopy(entry.get("effect_scale") or unknown_scale()))
            setattr(result, f"sample_size_{role}", entry["sample_size"])


def verify_published_inputs(
    request: dict[str, Any],
    output_root: Path,
    expected: dict[str, Any],
    *,
    output_directory_fd: int | None = None,
) -> None:
    """Do not publish input copies changed while their private snapshot ran."""
    try:
        absolute = output_root.absolute()
        with directory_fd(
            output_directory_fd if output_directory_fd is not None else Path(absolute.anchor),
            () if output_directory_fd is not None else absolute.parts[1:],
        ) as parent:
            actual = _read_manifest(parent)
            if actual != expected:
                raise _manifest_failure()
            for role in ("exposure", "outcome"):
                source = request[f"{role}Source"]
                if source["type"] == "local_file":
                    _verify_prepared(parent, role, source, actual[role])
    except (OSError, ValueError, TypeError, KeyError) as error:
        if isinstance(error, MRInputError):
            raise
        raise _manifest_failure() from None
