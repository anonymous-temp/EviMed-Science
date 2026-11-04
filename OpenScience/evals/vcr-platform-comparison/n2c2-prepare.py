"""Prepare private, label-free n2c2 patient inputs from the supplied original archives."""
import argparse
from datetime import date, datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import tempfile
import zipfile
import xml.etree.ElementTree as ET

HERE = Path(__file__).resolve().parent
PROTOCOL = HERE / "n2c2-protocol.json"
PINS = json.loads(PROTOCOL.read_bytes())["source"]["archiveSha256"]
SPLITS = {"train": ("raw/train.zip", "train/", 202),
          "test": ("raw/unannotated_test_data.zip", "test_notags/", 86)}
OPEN, CLOSE = b"<TEXT><![CDATA[", b"]]></TEXT>"
DATE = re.compile(r"^Record date: (\d{4}-\d{2}-\d{2})[ \t]*$", re.M)


def sha(value):
    return hashlib.sha256(value).hexdigest()


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode()


def private_path(path):
    resolved = path.resolve()
    parts = resolved.parts
    if not any(parts[i:i + 2] == (".evimed-local", "acceptance") for i in range(len(parts) - 1)):
        raise ValueError("Protected outputs require a private acceptance directory")
    return resolved


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with path.open("xb") as stream:
        stream.write(encoded(value))
    path.chmod(0o600)


def authorization(record, source_root, pins=PINS):
    if (set(record) != {"schema", "dataset", "userConfirmed", "provider", "destination", "purpose",
                        "confirmationReference", "experimentId", "dataProvenance"}
            or set(record.get("dataProvenance", {})) != {"kind", "sourceRoot", "archiveSha256"}
            or not re.fullmatch(r"vcrbench-[a-z0-9][a-z0-9-]{3,33}", str(record.get("experimentId", "")))
            or record.get("schema") != 1 or record.get("dataset") != "n2c2-2018-t1"
            or record.get("userConfirmed") is not True or record.get("provider") != "deepseek-official"
            or record.get("destination") != "https://api.deepseek.com"
            or record.get("purpose") != "vcr-platform-evaluation"
            or not isinstance(record.get("confirmationReference"), str)
            or not re.fullmatch(r"[A-Za-z0-9_.:/-]{1,200}", record["confirmationReference"])
            or record.get("dataProvenance", {}).get("kind") != "user-supplied"
            or record["dataProvenance"].get("sourceRoot") != str(source_root.resolve())
            or record["dataProvenance"].get("archiveSha256") != pins):
        raise ValueError("Dataset-specific user authorization and source provenance are required")


def protocol_text(protocol):
    criteria = protocol["criteria"]
    if len(criteria) != 13 or len({row["tag"] for row in criteria}) != 13:
        raise ValueError("Require all thirteen unique published criteria")
    lines = ["n2c2 2018 Track 1 research cohort-assessment protocol",
             "Source: Annotation Guidelines: Clinical Trial Cohort Selection, version 3, section 3.",
             "Assess the thirteen original propositions separately as positive inclusion requirements.",
             "Preserve each complete source clause and its tag in the saved protocol.",
             "Keep a clinical unknown when evidence does not establish the proposition.",
             "This protocol records research criteria, with no clinical enrollment action.", "",
             "Chronology from the original annotation guide"]
    lines.extend("- " + rule for rule in protocol["chronology"])
    lines.extend(["", "Inclusion Criteria"])
    lines.extend("[" + row["tag"] + "] " + row["text"] for row in criteria)
    # The scoringOnly block never reaches the model.
    return "\n".join(lines) + "\n"


def patient_text(raw, split):
    if b"<!DOCTYPE" in raw.upper() or b"<!ENTITY" in raw.upper():
        raise ValueError("XML entities and external declarations are forbidden")
    if raw.count(OPEN) != 1 or raw.count(CLOSE) != 1:
        raise ValueError("Require one original CDATA text block")
    element = ET.fromstring(raw)
    if element.tag != "PatientMatching" or len(element.findall("TEXT")) != 1:
        raise ValueError("Unexpected original patient document structure")
    tags = element.find("TAGS")
    if tags is None or (split == "test" and len(tags) != 0):
        raise ValueError("Test inputs must be unannotated")
    if split == "train" and len(tags) != 13:
        raise ValueError("Training annotation geometry differs")
    start = raw.index(OPEN) + len(OPEN)
    stop = raw.index(CLOSE, start)
    text_bytes = raw[start:stop]
    text = text_bytes.decode("utf-8")
    if "<TAGS" in text or ' met="' in text:
        raise ValueError("Annotation markup inside patient text")
    headers = list(DATE.finditer(text))
    if not headers:
        raise ValueError("Original record dates are required")
    segments = []
    for index, match in enumerate(headers):
        date.fromisoformat(match[1])
        begin = 0 if index == 0 else match.start()
        end = headers[index + 1].start() if index + 1 < len(headers) else len(text)
        fragment = text[begin:end]
        segments.append({"ordinal": index + 1, "recordDate": match[1],
                         "start": begin, "end": end, "offsetUnit": "unicode-codepoint",
                         "utf16Start": len(text[:begin].encode("utf-16-le")) // 2,
                         "utf16End": len(text[:end].encode("utf-16-le")) // 2,
                         "sha256": sha(fragment.encode())})
    return text_bytes, {"xmlSha256": sha(raw), "textSha256": sha(text_bytes),
                        "textByteSpan": [start, stop], "asOf": max(s["recordDate"] for s in segments),
                        "segments": segments, "annotationElementsRemoved": len(tags)}


def archive_patients(path, prefix):
    with zipfile.ZipFile(path) as archive:
        seen = set()
        for item in sorted(archive.infolist(), key=lambda item: item.filename):
            name = PurePosixPath(item.filename)
            if name.parts and name.parts[0] == "__MACOSX":
                continue
            if name.is_absolute() or ".." in name.parts or stat.S_ISLNK(item.external_attr >> 16):
                raise ValueError("Unsafe archive path")
            if item.is_dir():
                continue
            if not item.filename.startswith(prefix) or name.suffix != ".xml" or len(name.parts) != 2:
                raise ValueError("Unexpected original archive member")
            if item.filename in seen or item.file_size > 5 * 1024 * 1024:
                raise ValueError("Duplicate or oversized original XML")
            seen.add(item.filename)
            yield item.filename, archive.read(item)


def build_split(archive, split, out, published, protocol, expected_count):
    prefix = SPLITS[split][1]
    protocol_bytes = protocol_text(protocol).encode()
    cases, provenance = [], []
    for index, (member, raw) in enumerate(archive_patients(archive, prefix), 1):
        text, basis = patient_text(raw, split)
        case_id = "n2c2-" + split + "-" + str(index).zfill(3)
        folder = out / "model-inputs" / case_id
        folder.mkdir(parents=True, mode=0o700)
        files = []
        for name, data in [("patient.txt", text), ("protocol.txt", protocol_bytes)]:
            (folder / name).write_bytes(data)
            (folder / name).chmod(0o600)
            files.append({"path": str(published / "model-inputs" / case_id / name),
                          "name": name, "sha256": sha(data), "bytes": len(data)})
        record = {"caseId": case_id, "originalXmlId": PurePosixPath(member).stem,
                  "archiveMember": member, **basis}
        provenance.append(record)
        cases.append({"id": case_id, "asOf": basis["asOf"], "files": files,
                      "provenanceSha256": sha(encoded(record))})
    if len(cases) != expected_count:
        raise ValueError("Original patient count differs from the pinned split")
    return cases, provenance


def prepare(source_root, auth_file, out, splits=("train", "test")):
    os.umask(0o077)
    out = private_path(out)
    if out.exists():
        raise FileExistsError("Prepared input sets are immutable")
    source_root = source_root.resolve()
    raw_auth = auth_file.read_bytes()
    auth = json.loads(raw_auth)
    authorization(auth, source_root)
    for relative, expected in PINS.items():
        original = source_root / relative
        if original.is_symlink() or not original.is_file() or sha(original.read_bytes()) != expected:
            raise ValueError("Supplied dataset bytes differ from the explicit provenance")
    protocol_bytes = PROTOCOL.read_bytes()
    protocol = json.loads(protocol_bytes)
    if protocol["source"]["guideSha256"] != PINS["raw/Cohort_selection_AnnGuide_ver3.pdf"]:
        raise ValueError("Protocol source provenance differs")
    out.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.TemporaryDirectory(prefix=".n2c2-prepare-", dir=out.parent) as scratch:
        stage = Path(scratch) / "prepared"
        stage.mkdir(mode=0o700)
        manifests = []
        patient_sets = {}
        for split in splits:
            relative, _, count = SPLITS[split]
            split_out = stage / split
            split_out.mkdir(mode=0o700)
            cases, provenance = build_split(source_root / relative, split, split_out, out / split, protocol, count)
            patient_sets[split] = {row["originalXmlId"] for row in provenance}
            save(split_out / "provenance.json", {"split": split, "cases": provenance})
            manifest = {"version": 1, "task": "protocol_matching", "dataset": "n2c2-2018-t1",
                        "split": split, "patients": len(cases), "criteriaPerPatient": 13,
                        "priorExposure": True, "holdoutStatus": "previously exposed evaluation material",
                        "authorizationBinding": str(out / "authorization-binding.json"),
                        "authorizationSha256": sha(raw_auth), "sourceArchiveSha256": PINS[relative],
                        "sealedGoldSha256": PINS["sealed/n2c2-t1_gold_standard_test_data.zip"],
                        "guideSha256": protocol["source"]["guideSha256"],
                        "protocolDefinitionSha256": sha(protocol_bytes),
                        "provenanceSha256": sha((split_out / "provenance.json").read_bytes()), "cases": cases}
            save(split_out / "cases.json", manifest)
            manifests.append({"split": split, "manifestPath": str(out / split / "cases.json"),
                              "manifestSha256": sha((split_out / "cases.json").read_bytes()),
                              "inputSetSha256": sha(encoded([case["files"] for case in cases]))})
        if patient_sets.get("train", set()) & patient_sets.get("test", set()):
            raise ValueError("Patient identities overlap between original splits")
        save(stage / "authorization-binding.json", {
            "schema": 1, "dataset": "n2c2-2018-t1", "authorization": auth,
            "authorizationSha256": sha(raw_auth), "authorizationFile": str(auth_file.resolve()),
            "manifests": manifests, "preparedAt": datetime.now(timezone.utc).isoformat(),
            "preparerSha256": sha(Path(__file__).read_bytes())})
        stage.rename(out)
    return {"dataset": "n2c2-2018-t1", "splits": {row["split"]: SPLITS[row["split"]][2] for row in manifests},
            "authorizationBindingSha256": sha((out / "authorization-binding.json").read_bytes())}


def verify_prepared(manifest_file):
    manifest_file = private_path(manifest_file)
    manifest = json.loads(manifest_file.read_bytes())
    binding = json.loads(Path(manifest["authorizationBinding"]).read_bytes())
    original_bytes = Path(binding["authorizationFile"]).read_bytes()
    original = json.loads(original_bytes)
    source_root = Path(original["dataProvenance"]["sourceRoot"])
    authorization(original, source_root)
    if sha(original_bytes) != binding["authorizationSha256"] or original != binding["authorization"]:
        raise ValueError("Original user authorization differs from the inline snapshot")
    for relative, expected in PINS.items():
        if sha((source_root / relative).read_bytes()) != expected:
            raise ValueError("Original archive bytes changed")
    split = manifest["split"]
    relative, prefix, count = SPLITS[split]
    if len(manifest["cases"]) != count:
        raise ValueError("Split patient count changed")
    source_rows = list(archive_patients(source_root / relative, prefix))
    records = json.loads((manifest_file.parent / "provenance.json").read_bytes())["cases"]
    protocol = json.loads(PROTOCOL.read_bytes())
    expected_protocol = protocol_text(protocol).encode()
    if len(source_rows) != count or len(records) != count:
        raise ValueError("Source case inventory changed")
    for index, ((member, raw), case, record) in enumerate(zip(source_rows, manifest["cases"], records), 1):
        case_id = "n2c2-" + split + "-" + str(index).zfill(3)
        text, basis = patient_text(raw, split)
        expected = {"caseId": case_id, "originalXmlId": PurePosixPath(member).stem,
                    "archiveMember": member, **basis}
        if case["id"] != case_id or record != expected or case["asOf"] != basis["asOf"]:
            raise ValueError("Original document, patient or record dates differ")
        files = {row["name"]: row for row in case["files"]}
        if set(files) != {"patient.txt", "protocol.txt"}:
            raise ValueError("Only original text and the published protocol are supplied")
        for name, expected_bytes in [("patient.txt", text), ("protocol.txt", expected_protocol)]:
            file = manifest_file.parent / "model-inputs" / case_id / name
            if files[name]["path"] != str(file) or file.read_bytes() != expected_bytes:
                raise ValueError("Model input differs from its exact authorized original")
    return {"dataset": "n2c2-2018-t1", "split": split, "patients": count, "originalInputsVerified": True}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path)
    parser.add_argument("--authorization", type=Path)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--verify-manifest", type=Path)
    args = parser.parse_args()
    try:
        if args.verify_manifest:
            result = verify_prepared(args.verify_manifest)
        elif args.source_root and args.authorization and args.out:
            result = prepare(args.source_root, args.authorization, args.out)
        else:
            raise ValueError("Explicit source, authorization and private output are required")
        print(json.dumps(result))
    except Exception:
        raise SystemExit("n2c2 preparation refused; inspect private provenance without printing records")
