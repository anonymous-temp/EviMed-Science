#!/usr/bin/env python3
"""Build the release image inventory with one sequential compressed-tar pass.

This reads Docker's compatibility manifest and raw configuration bytes. The
separate artifact admission inspector verifies the complete OCI/layer closure.
"""
from __future__ import annotations

import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import sys
import tarfile
import time


MAX_METADATA_BYTES = 4 * 1024 * 1024
MAX_TOTAL_METADATA_BYTES = 128 * 1024 * 1024
MAX_MEMBERS = 16384
CONFIG_PATH = re.compile(r"(?:[a-f0-9]{64}\.json|blobs/sha256/[a-f0-9]{64})\Z")


class InventoryError(ValueError):
    """A fixed operational diagnostic without archive contents or credentials."""


def require(condition, code):
    if not condition:
        raise InventoryError(code)


class BoundedTarInfo(tarfile.TarInfo):
    """Bound extension records before the standard parser allocates their body."""

    @classmethod
    def fromtarfile(cls, archive):
        depth = getattr(archive, "inventory_header_depth", 0) + 1
        require(depth <= 32, "tar_header_depth_limit")
        archive.inventory_header_depth = depth
        try:
            require(sum(len(k) + len(v) for k, v in archive.pax_headers.items()) <= 65536,
                    "pax_metadata_size_limit")
            member = super().fromtarfile(archive)
            require(len(member.name) <= 4096, "tar_name_size_limit")
            require(sum(len(k) + len(v) for k, v in archive.pax_headers.items()) <= 65536,
                    "pax_metadata_size_limit")
            return member
        finally:
            archive.inventory_header_depth -= 1

    def _proc_pax(self, archive):
        require(0 <= self.size <= 65536, "pax_metadata_size_limit")
        return super()._proc_pax(archive)

    def _proc_gnulong(self, archive):
        require(0 <= self.size <= 4097, "tar_name_size_limit")
        return super()._proc_gnulong(archive)

    def _proc_sparse(self, archive):
        raise InventoryError("sparse_archive_member")

    def _proc_gnusparse_10(self, next_member, pax_headers, archive):
        raise InventoryError("sparse_archive_member")


def parse_json(content):
    def unique_pairs(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "duplicate_json_key")
            result[key] = value
        return result

    def invalid_constant(_value):
        raise InventoryError("nonfinite_json_number")

    return json.loads(content, object_pairs_hook=unique_pairs, parse_constant=invalid_constant)


def read_inventory(source, expected_references):
    """Return the previous producer's exact inventory shape without gzip seeks.

    Only bounded config JSON is retained. Layers are skipped by the streaming tar
    reader, including when the compatibility manifest follows every layer.
    """
    require(isinstance(expected_references, list) and 0 < len(expected_references) <= MAX_MEMBERS,
            "expected_reference_inventory_invalid")
    require(all(isinstance(ref, str) and ref and len(ref) <= 512 for ref in expected_references),
            "expected_reference_invalid")
    require(len(expected_references) == len(set(expected_references)), "duplicate_expected_reference")
    configs, members, manifest = {}, {}, None
    metadata_bytes = sum(len(ref.encode("utf-8")) for ref in expected_references)
    with gzip.GzipFile(fileobj=source, mode="rb") as decompressed:
        with tarfile.open(fileobj=decompressed, mode="r|", tarinfo=BoundedTarInfo) as archive:
            count = 0
            while True:
                member = archive.next()
                # Streaming mode otherwise still retains all TarInfo objects.
                archive.members.clear()
                if member is None:
                    break
                count += 1
                require(count <= MAX_MEMBERS, "archive_member_limit")
                name = member.name
                require(name not in members, "duplicate_archive_path")
                require(not PurePosixPath(name).is_absolute() and ".." not in PurePosixPath(name).parts,
                        "invalid_archive_path")
                require(member.isdir() or (member.isfile() and not member.issparse()), "unsupported_archive_member")
                require(member.size >= 0, "invalid_archive_member_size")
                members[name] = member.size
                metadata_bytes += len(name.encode("utf-8"))
                require(metadata_bytes <= MAX_TOTAL_METADATA_BYTES, "metadata_total_limit")
                if not member.isfile() or (name != "manifest.json" and not CONFIG_PATH.fullmatch(name)):
                    continue
                if member.size > MAX_METADATA_BYTES:
                    require(name != "manifest.json", "metadata_size_limit")
                    # An OCI blob may be a huge layer. If referenced as a config,
                    # its size will be rejected after the manifest is available.
                    continue
                require(metadata_bytes + member.size <= MAX_TOTAL_METADATA_BYTES, "metadata_total_limit")
                # Small OCI blobs may be non-JSON layers; their temporary buffer
                # is bounded, and only configuration JSON enters the cache.
                content = archive.extractfile(member).read(MAX_METADATA_BYTES + 1)
                require(len(content) == member.size, "metadata_incomplete")
                if name == "manifest.json":
                    manifest = parse_json(content)
                    retained = True
                else:
                    try:
                        candidate = parse_json(content)
                    except (json.JSONDecodeError, UnicodeDecodeError):
                        del content
                        continue
                    retained = isinstance(candidate, dict) and "rootfs" in candidate
                    del candidate
                    if retained:
                        configs[name] = content
                if retained:
                    metadata_bytes += len(content)
                    require(metadata_bytes <= MAX_TOTAL_METADATA_BYTES, "metadata_total_limit")
                del content
        # Validate gzip's CRC/trailer even if tar ended before the gzip stream.
        while decompressed.read(1024 * 1024):
            pass

    require(isinstance(manifest, list) and 0 < len(manifest) <= MAX_MEMBERS, "manifest_invalid")
    images, seen_configs, seen_references = [], set(), set()
    for entry in manifest:
        require(isinstance(entry, dict) and isinstance(entry.get("Config"), str), "manifest_entry_invalid")
        name = entry["Config"]
        require(name not in seen_configs, "duplicate_manifest_config")
        seen_configs.add(name)
        require(members.get(name, 0) <= MAX_METADATA_BYTES, "config_metadata_size_limit")
        require(name in configs, "config_missing")
        references = entry.get("RepoTags")
        require(isinstance(references, list) and references and
                all(isinstance(ref, str) and ref for ref in references), "manifest_references_invalid")
        for reference in references:
            require(reference not in seen_references, "duplicate_manifest_reference")
            seen_references.add(reference)
        content = configs.pop(name)
        config = parse_json(content)
        digest = hashlib.sha256(content).hexdigest()
        require(name in {digest + ".json", "blobs/sha256/" + digest}, "config_digest_path_mismatch")
        require(config.get("os") == "linux" and config.get("architecture") == "amd64", "config_platform_mismatch")
        require(isinstance(config.get("rootfs"), dict) and isinstance(config.get("config", {}), dict),
                "config_shape_invalid")
        images.append({"references": references, "configDigest": "sha256:" + digest,
                       "platform": config.get("os", "") + "/" + config.get("architecture", ""),
                       "rootfs": config.get("rootfs"), "labels": config.get("config", {}).get("Labels", {})})
    require(seen_references == set(expected_references), "reference_inventory_mismatch")
    return images


def write_report(root, environment):
    root = Path(root)
    with (root / "images.txt").open("rb") as handle:
        references = handle.read(MAX_METADATA_BYTES + 1)
    require(len(references) <= MAX_METADATA_BYTES, "reference_metadata_size_limit")
    with (root / "images.tar.gz").open("rb") as source:
        images = read_inventory(source, references.decode("utf-8").splitlines())
    report = {"sourceRevision": environment["GITHUB_SHA"], "releaseId": environment["OPEN_SCIENCE_RELEASE_ID"],
              "workflowRun": environment["GITHUB_RUN_ID"], "workflowAttempt": environment["GITHUB_RUN_ATTEMPT"],
              "images": images}
    content = json.dumps(report, indent=2) + "\n"
    require(len(content.encode("utf-8")) <= MAX_METADATA_BYTES, "report_metadata_size_limit")
    (root / "manifest.json").write_text(content, encoding="utf-8")
    return len(images)


if __name__ == "__main__":
    started = time.monotonic()
    try:
        image_count = write_report(Path(os.environ["RUNNER_TEMP"]) / "evimed-release", os.environ)
    except InventoryError as exc:
        print(f"[package] image inventory rejected: {exc}", file=sys.stderr)
        raise SystemExit(1)
    except (OSError, EOFError, tarfile.TarError, UnicodeError, json.JSONDecodeError, RecursionError, KeyError):
        print("[package] image inventory failed validation", file=sys.stderr)
        raise SystemExit(1)
    print(f"[package] inventory complete: images={image_count}, elapsed={time.monotonic() - started:.1f}s")
