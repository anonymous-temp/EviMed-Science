#!/usr/bin/env python3
"""Check an EviMed research package without the platform.

    python3 -I verify.py                       # the package this script sits in (an extracted directory)
    python3 -I verify.py PACKAGE               # an extracted directory, or the .zip itself
    python3 -I verify.py PACKAGE --compare F   # also compare numbers you reproduced (a JSON file) with the stated ones

What it checks: that every file the manifest lists is there with the size and sha-256 it states; that nothing else is
there (an extra file, a link, a name that would land outside the package); that the versions in the manifest agree with
their files; that every input, code and environment a version records is either a file or a named omission; and that the
completeness the manifest declares is the one its omissions and gaps give. It prints one JSON report. Exit status: 0 the
package is as declared, 1 it is not, 2 it could not be read as a package, 3 (with --compare) the numbers you gave differ.

What it does not do: it runs, imports and installs nothing from the package, opens no network connection and writes no
file. Reading a .zip never extracts it. It is standard library only (hashlib, json, zipfile) so there is nothing to
install, and it drops the package directory from the import path before it imports anything, so a package that ships
a json.py or a hashlib.py is not run by it. `-I` does the same from the outside; use it.

What a pass does not mean: the hashes show the files are the ones the manifest lists, not that the manifest is the
one the platform wrote. Someone who rewrites the files and the manifest together passes. Take the manifest digest this
prints from the sender, over a channel the package did not come through. A pass says nothing about whether the science
is applicable ("scientific_applicability": "not_assessed"), and this file's own digest is printed so you can compare it
with a copy you trust.

--compare uses the rule the platform's own replay comparison uses: a key is the same when the numbers are equal or
differ by no more than max(absoluteTolerance, relativeTolerance * |expected|), where the tolerances are the ones the
original declared (reproduction.json). Your file may state none. Units must agree.
"""
import os
import sys

# A package is untrusted input, and Python puts the running script's directory first on the import path: a package that
# ships its own json.py would be imported in place of the standard library. Drop that entry before anything is imported
# (os and sys are loaded by the interpreter itself and cannot be shadowed).
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:] = [entry for entry in sys.path if entry not in ("", ".") and os.path.abspath(entry) != _HERE]
sys.dont_write_bytecode = True

import argparse  # noqa: E402
import hashlib  # noqa: E402
import json  # noqa: E402
import re  # noqa: E402
import stat  # noqa: E402
import zipfile  # noqa: E402

FORMAT = "evimed-research-result"
HEX64 = re.compile(r"^[0-9a-f]{64}$")
VERSION_ID = re.compile(r"^rv_[0-9a-f]{64}$")
KNOWN_REASONS = {"bytes_not_captured", "input_unavailable", "input_deleted", "preserved_bytes_unreadable",
                 "over_package_limit", "credential_shaped_text"}
MAX_ENTRY = 1 << 30
MAX_JSON = 64 << 20
ROLE_OF_FIELD = (("inputs", "input"), ("code", "code"), ("environment", "environment"))


def refuse_constant(name):
    raise ValueError("%s is not a JSON number" % name)


def load_json(data):
    return json.loads(data.decode("utf-8"), parse_constant=refuse_constant)


def unsafe(name):
    """Why a name could not be a file inside the package, or None."""
    if not isinstance(name, str) or not name or len(name) > 4096:
        return "empty_or_too_long"
    if "\\" in name or any(ord(char) < 32 for char in name):
        return "control_or_backslash"
    if name.startswith("/") or re.match(r"^[A-Za-z]:", name):
        return "absolute"
    if any(part in ("", ".", "..") for part in name.split("/")):
        return "dot_segments"
    return None


class Directory:
    def __init__(self, root):
        self.root = root

    def entries(self):
        found = []
        for base, dirs, files in os.walk(self.root, followlinks=False):
            for name in dirs + files:
                full = os.path.join(base, name)
                info = os.lstat(full)
                relative = os.path.relpath(full, self.root).replace(os.sep, "/")
                if stat.S_ISLNK(info.st_mode):
                    found.append((relative, "link", 0))
                elif stat.S_ISREG(info.st_mode):
                    found.append((relative, "file", info.st_size))
                elif not stat.S_ISDIR(info.st_mode):
                    found.append((relative, "other", 0))
        return found

    def chunks(self, name):
        with open(os.path.join(self.root, *name.split("/")), "rb") as stream:
            while True:
                chunk = stream.read(1 << 20)
                if not chunk:
                    return
                yield chunk


class Archive:
    def __init__(self, path):
        self.zip = zipfile.ZipFile(path)

    def entries(self):
        found = []
        for info in self.zip.infolist():
            if info.is_dir():
                continue
            mode = (info.external_attr >> 16) & 0xFFFF
            kind = "link" if stat.S_ISLNK(mode) else "other" if mode and not stat.S_ISREG(mode) else "file"
            found.append((info.filename, kind, info.file_size))
        return found

    def chunks(self, name):
        with self.zip.open(name) as stream:
            while True:
                chunk = stream.read(1 << 20)
                if not chunk:
                    return
                yield chunk


def read_bytes(source, name, limit):
    """The bytes of one entry, or None when it is larger than `limit` (it is not read past that)."""
    data = bytearray()
    for chunk in source.chunks(name):
        data += chunk
        if len(data) > limit:
            return None
    return bytes(data)


def sha256(source, name, limit):
    """(digest, size) of one entry; digest is None when the entry is longer than `limit` (it is not read past that)."""
    digest, size = hashlib.sha256(), 0
    for chunk in source.chunks(name):
        size += len(chunk)
        if size > limit:
            return None, size
        digest.update(chunk)
    return digest.hexdigest(), size


def check(source):
    """Check the package; returns (report, manifest, files by archive path)."""
    problems, warnings = [], []

    def problem(code, path=None, detail=None):
        problems.append({"code": code, **({"path": path} if path is not None else {}), **({"detail": detail} if detail is not None else {})})

    report = {"format": None, "version": None, "executed": False, "scientific_applicability": "not_assessed"}
    listed = {}
    entries = {}
    for name, kind, size in source.entries():
        if name in entries or name.casefold() in {other.casefold() for other in entries}:
            problem("file_duplicate", name)
        entries[name] = (kind, size)
        if kind != "file":
            problem("file_not_regular", name, kind)
        reason = unsafe(name)
        if reason:
            problem("file_unsafe_path", name, reason)

    manifest = None
    if "manifest.json" not in entries or entries["manifest.json"][0] != "file":
        problem("manifest_missing", "manifest.json")
    else:
        data = read_bytes(source, "manifest.json", MAX_JSON)
        if data is None:
            problem("manifest_unreadable", "manifest.json", "too_large")
        else:
            report["manifestSha256"] = hashlib.sha256(data).hexdigest()
            try:
                manifest = load_json(data)
            except ValueError as error:
                problem("manifest_unreadable", "manifest.json", str(error)[:120])
    if not isinstance(manifest, dict) or manifest.get("format") != FORMAT:
        if manifest is not None:
            problem("format_unknown", "manifest.json", "not an %s manifest" % FORMAT)
        return finish(report, problems, warnings, None, {}), None, {}
    report["format"], report["version"] = manifest.get("format"), manifest.get("version")

    for item in manifest.get("files") if isinstance(manifest.get("files"), list) else []:
        path = item.get("archivePath") if isinstance(item, dict) else None
        reason = unsafe(path)
        if reason:
            problem("file_unsafe_path", str(path)[:200], reason)
            continue
        if path in listed:
            problem("file_duplicate", path, "listed twice in the manifest")
            continue
        listed[path] = item
        if path not in entries:
            problem("file_missing", path)
            continue
        if entries[path][0] != "file":
            continue  # a link or a special file is never read through; it was reported above
        declared, digest = item.get("bytes"), item.get("sha256")
        if not isinstance(declared, int) or isinstance(declared, bool) or declared < 0 or not isinstance(digest, str) or not HEX64.match(digest):
            problem("file_declaration_invalid", path)
            continue
        if declared > MAX_ENTRY:
            problem("entry_too_large", path)
            continue
        actual, size = sha256(source, path, declared)
        if actual is None or size != declared:
            problem("file_size_mismatch", path, "declared %d, found %s" % (declared, "more" if actual is None else size))
        elif actual != digest:
            problem("file_hash_mismatch", path)
    for name in sorted(set(entries) - set(listed) - {"manifest.json"}):
        problem("file_undeclared", name)

    versions = {}
    for version in manifest.get("versions") if isinstance(manifest.get("versions"), list) else []:
        if not isinstance(version, dict) or not VERSION_ID.match(str(version.get("versionId"))):
            problem("version_invalid")
            continue
        versions[version["versionId"]] = version
    bundled = {}
    for path, item in listed.items():
        version_id = item.get("versionId")
        if version_id is None:
            continue
        version = versions.get(version_id)
        if version is None:
            problem("file_version_unknown", path, version_id)
        elif version.get("digest") != item.get("sha256") or version.get("size") != item.get("bytes"):
            problem("version_digest_mismatch", path, version_id)
        else:
            bundled[version_id] = path
    selected = manifest.get("selectedVersionId")
    omissions = manifest.get("omissions") if isinstance(manifest.get("omissions"), list) else []
    if selected not in versions and not any(isinstance(o, dict) and o.get("versionId") == selected for o in omissions):
        problem("selected_unlisted", None, str(selected)[:80])
    elif selected not in bundled:
        warnings.append({"code": "selected_bytes_not_included", "path": None, "detail": str(selected)[:80]})

    accounted = 0
    for version_id, version in versions.items():
        references = [(role, ref) for field, role in ROLE_OF_FIELD for ref in
                      (version.get(field) if isinstance(version.get(field), list) else [version.get(field)] if version.get(field) else [])
                      if isinstance(ref, dict)]
        for role, ref in references:
            child = ref.get("versionId") if ref.get("availability") == "captured" else None
            if child and child in bundled:
                if versions.get(child, {}).get("digest") != ref.get("digest"):
                    problem("dependency_digest_mismatch", bundled[child], version_id)
                else:
                    accounted += 1
                continue
            if any(isinstance(o, dict) and o.get("requiredBy") == version_id and o.get("role") == role and o.get("kind") == ref.get("kind")
                   and o.get("id") == ref.get("id") and o.get("versionId") == ref.get("versionId") for o in omissions):
                accounted += 1
            else:
                problem("dependency_unaccounted", None, "%s %s of %s" % (role, str(ref.get("id"))[:80], version_id))
    for omission in omissions:
        if not isinstance(omission, dict) or omission.get("reason") not in KNOWN_REASONS:
            warnings.append({"code": "omission_reason_unknown", "detail": str(omission.get("reason") if isinstance(omission, dict) else omission)[:80]})

    gaps = manifest.get("coverageGaps") if isinstance(manifest.get("coverageGaps"), list) else []
    derived = "partial" if omissions or gaps else "captured"
    declared = manifest.get("completeness")
    report["completeness"] = {"declared": declared, "derived": derived, "consistent": declared == derived}
    if declared != derived:
        problem("completeness_inconsistent", None, "declared %s, omissions and gaps give %s" % (declared, derived))
    report["dependencies"] = {"accounted": accounted, "omitted": len(omissions)}

    for key in ("execution", "verification", "reproduction"):
        name = (manifest.get("records") or {}).get(key) if isinstance(manifest.get("records"), dict) else None
        if name is None:
            continue
        data = read_bytes(source, name, MAX_JSON) if name in listed and entries.get(name, ("", 0))[0] == "file" else None
        try:
            record = load_json(data) if data is not None else None
        except ValueError:
            record = None
        if not isinstance(record, dict):
            problem("record_unreadable", str(name)[:200], key)
            continue
        for entry in record.get("versions") or record.get("calculations") or []:
            if isinstance(entry, dict) and entry.get("versionId") not in versions:
                problem("record_version_unknown", name, str(entry.get("versionId"))[:80])
            if isinstance(entry, dict) and key == "reproduction":
                for item in entry.get("inputs") or []:
                    if isinstance(item, dict) and item.get("archivePath") is not None and item["archivePath"] not in listed:
                        problem("reproduction_input_missing", name, str(item["archivePath"])[:200])
    report["files"] = len(listed)
    return finish(report, problems, warnings, manifest, listed), manifest, listed


def finish(report, problems, warnings, manifest, listed):
    failed = sorted({p["path"] for p in problems if p["code"] in ("file_missing", "file_size_mismatch", "file_hash_mismatch", "file_unsafe_path", "file_not_regular",
                                                              "file_duplicate", "file_declaration_invalid", "entry_too_large") and "path" in p})
    report["bytes"] = "changed" if any(p["code"] in ("file_missing", "file_size_mismatch", "file_hash_mismatch", "file_undeclared", "file_unsafe_path",
                                                      "file_not_regular", "file_duplicate", "file_declaration_invalid", "entry_too_large", "manifest_missing",
                                                      "manifest_unreadable") for p in problems) else "identical"
    report["failed"] = failed
    report["undeclared"] = sorted(p["path"] for p in problems if p["code"] == "file_undeclared")
    report["problems"] = problems
    report["warnings"] = warnings
    report["ok"] = not problems
    if manifest is not None:
        report["selectedVersionId"] = manifest.get("selectedVersionId")
    return report


def number_rows(value):
    """The {key, value, unit} rows of whatever the user gave: a list of rows, {machineValues: rows}, or {key: number}."""
    if isinstance(value, dict) and isinstance(value.get("machineValues"), list):
        value = value["machineValues"]
    if isinstance(value, dict):
        value = [{"key": key, "value": number} for key, number in value.items()]
    if not isinstance(value, list):
        raise ValueError("expected a list of {key, value, unit}")
    rows = []
    for row in value:
        number = row.get("value") if isinstance(row, dict) else None
        if not isinstance(row, dict) or not isinstance(row.get("key"), str) or isinstance(number, bool) or not isinstance(number, (int, float)):
            raise ValueError("every row needs a text key and a numeric value")
        if number != number or number in (float("inf"), float("-inf")):
            raise ValueError("%s is not finite" % row["key"])
        rows.append(row)
    return rows


def compare(expected, reproduced):
    """The platform's own rule (compareResultNumbers): the tolerance is the original's, never the rerun's."""
    left = {row["key"]: row for row in expected}
    right = {row["key"]: row for row in reproduced}
    values = []
    for key in list(left) + [key for key in right if key not in left]:
        a, b = left.get(key), right.get(key)
        if a is None or b is None:
            values.append({"key": key, "status": "missing", "before": a["value"] if a else None, "after": b["value"] if b else None})
        elif (a.get("unit") or "") != (b.get("unit") or ""):
            values.append({"key": key, "status": "incompatible-unit", "before": a["value"], "after": b["value"]})
        else:
            difference = abs(b["value"] - a["value"])
            tolerance = max(a.get("absoluteTolerance") or 0, (a.get("relativeTolerance") or 0) * abs(a["value"]))
            status = "identical" if a["value"] == b["value"] else "within-tolerance" if difference <= tolerance else "changed"
            values.append({"key": key, "unit": a.get("unit"), "before": a["value"], "after": b["value"], "absoluteDifference": difference,
                           "tolerance": tolerance, "status": status})
    overall = ("not-assessed" if not values else "identical" if all(v["status"] == "identical" for v in values)
               else "within-tolerance" if all(v["status"] in ("identical", "within-tolerance") for v in values) else "changed")
    return {"status": overall, "values": values}


def compare_with_package(source, manifest, listed, path, version_id):
    name = (manifest.get("records") or {}).get("reproduction") if isinstance(manifest.get("records"), dict) else None
    if name is None or name not in listed:
        return {"status": "not-assessed", "reason": "the package carries no reproduction record"}
    record = load_json(read_bytes(source, name, MAX_JSON) or b"{}")
    calculations = [c for c in record.get("calculations", []) if isinstance(c, dict)]
    wanted = version_id or manifest.get("selectedVersionId")
    found = next((c for c in calculations if c.get("versionId") == wanted), None)
    if found is None:
        return {"status": "not-assessed", "reason": "no reproduction record for %s" % wanted,
                "available": [c.get("versionId") for c in calculations]}
    with open(path, "rb") as stream:
        reproduced = number_rows(load_json(stream.read(MAX_JSON)))
    result = compare((found.get("expected") or {}).get("values") or [], reproduced)
    result.update({"versionId": wanted, "basis": found.get("basis"), "toleranceSource": "frozen_original",
                   "reproductionStatus": found.get("status"), "scientificApplicability": "not_assessed"})
    return result


def main(argv):
    parser = argparse.ArgumentParser(description="Check an EviMed research package without the platform.")
    parser.add_argument("package", nargs="?", default=_HERE, help="an extracted package directory (default: this script's) or the .zip")
    parser.add_argument("--compare", metavar="FILE", help="a JSON file of numbers you reproduced, compared with the stated ones")
    parser.add_argument("--version-id", help="the result version --compare is about (default: the selected one)")
    args = parser.parse_args(argv)
    try:
        source = Directory(args.package) if os.path.isdir(args.package) else Archive(args.package)
        report, manifest, listed = check(source)
        with open(os.path.abspath(__file__), "rb") as own:
            report["verifierSha256"] = hashlib.sha256(own.read()).hexdigest()
        status = 0 if report["ok"] else 1
        if args.compare and manifest is not None:
            try:
                report["compare"] = compare_with_package(source, manifest, listed, args.compare, args.version_id)
                if status == 0 and report["compare"]["status"] in ("changed", "not-assessed"):
                    status = 3
            except (OSError, ValueError) as error:
                report["compare"] = {"status": "unreadable", "detail": str(error)[:200]}
                status = 2
    except (OSError, ValueError, zipfile.BadZipFile) as error:
        print(json.dumps({"ok": False, "error": "unreadable", "detail": str(error)[:200], "executed": False}))
        return 2
    print(json.dumps(report, indent=2, sort_keys=True))
    return status


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
