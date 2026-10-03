"""Extract only inventory-bound public artifact entries; never execute vendor code."""
import hashlib
import json
import posixpath
import shutil
import sys
import tarfile
from pathlib import Path, PurePosixPath

output, adapter, source = map(Path, sys.argv[1:4])
context = output / "context"
vendor = context / "vendor"
vendor.mkdir()
closure = json.loads((context / "dependency-closure.json").read_text())
expected = {entry["path"]: entry for entry in closure["files"]}
directories = {entry["path"]: entry for entry in closure["directories"]}
links = {name for name, entry in expected.items() if "link" in entry}
seen = set()
seen_directories = set()
with tarfile.open(output / "vendor.tar") as archive:
    for member in archive:
        name = member.name[2:] if member.name.startswith("./") else member.name
        name = name.rstrip("/")
        if name == "":
            name = "."
        parts = PurePosixPath(name).parts
        if name.startswith("/") or ".." in parts or any("/".join(parts[:i]) in links for i in range(1, len(parts))):
            raise ValueError("unsafe artifact path")
        if member.isdir():
            if name in seen_directories or name not in directories or member.mode != 0o555 or directories[name]["mode"] != member.mode:
                raise ValueError("artifact directory differs")
            seen_directories.add(name)
            continue
        if name in seen or name not in expected:
            raise ValueError("unexpected artifact entry")
        seen.add(name)
        entry = expected[name]
        if member.mode != entry["mode"] or member.mode != (0o777 if member.issym() else 0o444):
            raise ValueError("artifact mode differs")
        if member.issym():
            target = posixpath.normpath(posixpath.join(posixpath.dirname(name), member.linkname))
            if entry.get("link") != member.linkname or target.startswith("/") or target == ".." or target.startswith("../"):
                raise ValueError("unsafe artifact link")
        else:
            if not member.isfile():
                raise ValueError("artifact special entry")
            data = archive.extractfile(member).read()
            if len(data) != entry["bytes"] or hashlib.sha256(data).hexdigest() != entry["sha256"]:
                raise ValueError("artifact bytes differ")
    if seen != set(expected) or seen_directories != set(directories):
        raise ValueError("artifact inventory incomplete")
    archive.extractall(vendor)
for name in ("Dockerfile", "policy.mjs", "runner.mjs", "source-manifest.json"):
    shutil.copyfile(adapter / name, context / name)
shutil.copyfile(source / "LICENSE", context / "LICENSE")
