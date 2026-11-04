"""Freeze saved protocol predictions before a separate, private n2c2 gold join."""
import argparse
from collections import Counter
import hashlib
import io
import json
from pathlib import Path
import re
import runpy
import tempfile
import unicodedata
import zipfile
import xml.etree.ElementTree as ET
import contextlib
import sys

HERE = Path(__file__).resolve().parent
DEFINITION = HERE / "n2c2-protocol.json"


def sha(value):
    return hashlib.sha256(value).hexdigest()


def raw_json(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode()


def read(path):
    return json.loads(path.read_bytes())


def private(path):
    path = path.resolve()
    if not any(path.parts[i:i + 2] == (".evimed-local", "acceptance") for i in range(len(path.parts) - 1)):
        raise ValueError("n2c2 outputs require a private acceptance directory")
    return path


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with path.open("xb") as stream:
        stream.write(raw_json(value))
    path.chmod(0o600)


def normalize(value):
    return " ".join(unicodedata.normalize("NFKC", value or "").split())


def clause_matches(text, criterion):
    # Only remove an explicit public criterion identifier, never clinical words.
    text = re.sub(r"^\s*(?:\[" + re.escape(criterion["tag"]) + r"\]|"
                  + re.escape(criterion["tag"]) + r"\s*:)\s*", "", text or "")
    return normalize(text) == normalize(criterion["text"])


def predictions(case, definitions):
    matching = case.get("matching") or case.get("partialMatching") or {}
    selected = matching.get("selected") or {}
    roster = matching.get("candidateRoster") or []
    source_rows = selected.get("criteria") or []
    owned = (bool(selected.get("assessmentId")) and len(roster) == 1
             and (selected.get("candidate") or {}).get("id") == roster[0]
             and matching.get("direction") == "trial_to_patient")
    result = []
    for criterion in definitions:
        matches = [row for row in source_rows if clause_matches(row.get("text"), criterion)]
        base = {"tag": criterion["tag"], "caseStatus": case.get("status", "missing_artifact"),
                "assessmentId": selected.get("assessmentId"), "platformCriterionIds": [row.get("criterionId") for row in matches]}
        if not owned:
            result.append({**base, "state": "unprocessed", "reason": "saved_protocol_assessment_unavailable"})
        elif len(matches) != 1 or matches[0].get("kind") != "inclusion":
            result.append({**base, "state": "unmapped", "reason": "literal_clause_or_kind_unresolved"})
        else:
            row = matches[0]
            if not row.get("decidedBy"):
                state = "unprocessed"
            elif row.get("applicable") is False:
                state = "not_applicable"
            elif row.get("state") in ("satisfied", "not_satisfied", "pending_recheck"):
                state = row["state"]
            elif row.get("state") == "unknown":
                state = "clinical_unknown"
            else:
                state = "unprocessed"
            result.append({**base, "state": state, "rawState": row.get("state"),
                           "decidedBy": row.get("decidedBy"), "applicable": row.get("applicable"),
                           "applicabilityState": row.get("applicabilityState"),
                           "missingReason": row.get("reason"), "recheckAt": row.get("recheckAt"),
                           "requestNote": row.get("requestNote")})
    return result


def freeze(campaign, manifest_file, out):
    out = private(out)
    if out.exists():
        raise FileExistsError("Prediction freeze already exists")
    manifest, frozen = read(manifest_file), read(campaign / "FROZEN.json")
    definition_bytes = DEFINITION.read_bytes()
    definitions = json.loads(definition_bytes)["criteria"]
    if (manifest.get("task") != "protocol_matching" or manifest.get("dataset") != "n2c2-2018-t1"
            or sha(manifest_file.read_bytes()) != frozen.get("manifestSha256")
            or frozen.get("task") != "protocol_matching"
            or frozen.get("protocolDefinitionSha256") != sha(definition_bytes)
            or frozen.get("split") != manifest["split"]):
        raise ValueError("Prediction campaign and frozen dataset definition differ")
    if (campaign / "summary.json").exists():
        summary = read(campaign / "summary.json")
        if not summary.get("finishedAt"):
            raise ValueError("Finish or stop the campaign before freezing predictions")
    planned = frozen["planned"]
    by_id = {case["id"]: case for case in manifest["cases"]}
    if not planned or len(set(planned)) != len(planned) or any(case not in by_id for case in planned):
        raise ValueError("Frozen patient selection differs from input manifest")
    provenance_file = manifest_file.parent / "provenance.json"
    if sha(provenance_file.read_bytes()) != manifest["provenanceSha256"]:
        raise ValueError("Original document provenance changed")
    source = {row["caseId"]: row for row in read(provenance_file)["cases"]}
    hashes, units, cases = {}, [], []
    seen = {key: set() for key in ("accountId", "projectId", "sessionId")}
    for case_id in planned:
        file = campaign / case_id / "case.json"
        if file.exists():
            record = read(file)
            if record["caseId"] != case_id:
                raise ValueError("Retained patient artifact identity differs")
            hashes[case_id] = sha(file.read_bytes())
            for key in seen:
                identity = record.get(key)
                if identity and identity in seen[key]:
                    raise ValueError("Patients share an account, project or session")
                if identity:
                    seen[key].add(identity)
        else:
            record = {"caseId": case_id, "status": "missing_artifact"}
            hashes[case_id] = None
        for row in predictions(record, definitions):
            units.append({"caseId": case_id, "originalXmlId": source[case_id]["originalXmlId"], **row})
        cases.append({"caseId": case_id, "status": record.get("status"), "cleanup": record.get("cleanup")})
    out.mkdir(mode=0o700, parents=True)
    save(out / "predictions.json", units)
    artifact = {"schema": 1, "dataset": "n2c2-2018-t1", "split": manifest["split"],
                "priorExposure": True, "manifestPath": str(manifest_file.resolve()),
                "manifestSha256": sha(manifest_file.read_bytes()), "campaignPath": str(campaign.resolve()),
                "campaignFrozenSha256": sha((campaign / "FROZEN.json").read_bytes()),
                "predictionSha256": sha((out / "predictions.json").read_bytes()), "caseHashes": hashes,
                "cases": cases, "patients": len(planned), "denominator": len(planned) * 13,
                "sealedGoldSha256": manifest["sealedGoldSha256"], "sourceArchiveSha256": manifest["sourceArchiveSha256"],
                "protocolDefinitionSha256": sha(definition_bytes),
                "scorerSha256": sha(Path(__file__).read_bytes()), "goldJoined": False}
    save(out / "PREDICTIONS_FROZEN.json", artifact)
    return {"patients": len(planned), "units": len(units), "states": dict(Counter(row["state"] for row in units))}


def gold_labels(archive_file, prefix, tags):
    found = {}
    with zipfile.ZipFile(archive_file) as archive:
        for member in archive.namelist():
            path = Path(member)
            if not member.startswith(prefix) or not member.endswith(".xml") or "__MACOSX" in path.parts:
                continue
            body = archive.read(member)
            if b"<!ENTITY" in body.upper() or b"<!DOCTYPE" in body.upper():
                raise ValueError("Unexpected XML declaration in labels")
            root = ET.fromstring(body)
            values = root.findall("./TAGS/*")
            if len(values) != 13 or {value.tag for value in values} != set(tags):
                raise ValueError("Reference labels do not contain all thirteen unique criteria")
            labels = {value.tag: value.attrib.get("met") for value in values}
            if any(value not in ("met", "not met") for value in labels.values()):
                raise ValueError("Reference label is outside the official binary vocabulary")
            if path.stem in found:
                raise ValueError("Duplicate original reference identity")
            found[path.stem] = labels
    return found


def binary(row, reading):
    state, tag = row["state"], row["tag"]
    if state == "satisfied":
        return "met"
    if state == "not_satisfied":
        return "not met"
    # Only clinical unknowns participate in annotation-default sensitivity c.
    if state == "clinical_unknown" and reading == "c" and tag in ("ENGLISH", "MAKES-DECISIONS"):
        return "met"
    return "not met"


def f1(tp, fp, fn):
    return 2 * tp / (2 * tp + fp + fn) if 2 * tp + fp + fn else 0.0


def binary_metrics(rows, labels, reading, per_criterion=True):
    counts = Counter()
    for row in rows:
        target = labels[row["originalXmlId"]][row["tag"]] == "met"
        predicted = binary(row, reading) == "met"
        counts["tp" if target and predicted else "fn" if target else "fp" if predicted else "tn"] += 1
    result = {"denominator": len(rows), "tp": counts["tp"], "fp": counts["fp"], "fn": counts["fn"], "tn": counts["tn"],
            "microOverallF1": (f1(counts["tp"], counts["fp"], counts["fn"])
                               + f1(counts["tn"], counts["fn"], counts["fp"])) / 2}
    if per_criterion:
        tags = [item["tag"] for item in read(DEFINITION)["criteria"]]
        result["perCriterion"] = {tag: binary_metrics([row for row in rows if row["tag"] == tag], labels, reading, False)
                                  for tag in tags}
        result["macroOverallF1"] = sum(value["microOverallF1"] for value in result["perCriterion"].values()) / 13
    return result


def complete_assessment_patients(units):
    grouped = {}
    for row in units:
        grouped.setdefault(row["caseId"], []).append(row)
    admissible = {"satisfied", "not_satisfied", "clinical_unknown"}
    return {case for case, rows in grouped.items()
            if len(rows) == 13 and len({row["tag"] for row in rows}) == 13
            and all(row["state"] in admissible for row in rows)}


def official_score(script_bytes, rows, labels, reading, folder):
    gold, system = folder / "gold", folder / "system"
    gold.mkdir(mode=0o700)
    system.mkdir(mode=0o700)
    ids = sorted({row["originalXmlId"] for row in rows})
    by_pair = {(row["originalXmlId"], row["tag"]): row for row in rows}
    for patient in ids:
        for target, reference in [(gold, True), (system, False)]:
            root = ET.Element("PatientMatching")
            ET.SubElement(root, "TEXT")  # Official scoring reads TAGS only. No patient text is copied.
            block = ET.SubElement(root, "TAGS")
            for tag in labels[patient]:
                value = labels[patient][tag] if reference else binary(by_pair[(patient, tag)], reading)
                ET.SubElement(block, tag, met=value)
            file = target / (patient + ".xml")
            file.write_bytes(ET.tostring(root))
            file.chmod(0o600)
    script = folder / "track1_eval.py"
    script.write_bytes(script_bytes)
    script.chmod(0o600)
    sys.modules.setdefault("xml.etree.cElementTree", ET)
    import xml.etree
    xml.etree.cElementTree = ET
    previous = sys.argv
    stream = io.StringIO()
    try:
        sys.argv = [str(script), str(gold), str(system)]
        with contextlib.redirect_stdout(stream), contextlib.redirect_stderr(stream):
            runpy.run_path(str(script), run_name="__main__")
    finally:
        sys.argv = previous
    return stream.getvalue()


def score(prediction_dir, source_root, out):
    out = private(out)
    meta = read(prediction_dir / "PREDICTIONS_FROZEN.json")
    definition = read(DEFINITION)
    if (meta.get("goldJoined") is not False or meta["scorerSha256"] != sha(Path(__file__).read_bytes())
            or meta["protocolDefinitionSha256"] != sha(DEFINITION.read_bytes())
            or meta["predictionSha256"] != sha((prediction_dir / "predictions.json").read_bytes())):
        raise ValueError("Predictions or scoring protocol changed after the label-blind freeze")
    manifest_file = Path(meta["manifestPath"])
    if sha(manifest_file.read_bytes()) != meta["manifestSha256"]:
        raise ValueError("Frozen input manifest changed")
    campaign = Path(meta["campaignPath"])
    if sha((campaign / "FROZEN.json").read_bytes()) != meta["campaignFrozenSha256"]:
        raise ValueError("Campaign attribution changed after prediction freeze")
    for case_id, expected in meta["caseHashes"].items():
        current = campaign / case_id / "case.json"
        if (sha(current.read_bytes()) if current.exists() else None) != expected:
            raise ValueError("A retained first-attempt prediction changed")
    pins = definition["source"]["archiveSha256"]
    split = meta["split"]
    relative = "sealed/n2c2-t1_gold_standard_test_data.zip" if split == "test" else "raw/train.zip"
    archive = source_root / relative
    if sha(archive.read_bytes()) != pins[relative]:
        raise ValueError("Original reference archive differs")
    script_archive = source_root / "raw/track1_eval_script.zip"
    if sha(script_archive.read_bytes()) != pins["raw/track1_eval_script.zip"]:
        raise ValueError("Official evaluation code differs")
    # This is the first point where any gold labels are decoded.
    tags = [row["tag"] for row in definition["criteria"]]
    labels = gold_labels(archive, "n2c2-t1_gold_standard_test_data/" if split == "test" else "train/", tags)
    units = read(prediction_dir / "predictions.json")
    if len(units) != meta["denominator"]:
        raise ValueError("Frozen denominator differs")
    correct = sum(row["state"] in ("satisfied", "not_satisfied")
                  and binary(row, "b") == labels[row["originalXmlId"]][row["tag"]] for row in units)
    decisive = sum(row["state"] in ("satisfied", "not_satisfied") for row in units)
    good_patients = complete_assessment_patients(units)
    complete = [row for row in units if row["caseId"] in good_patients]
    result = {"dataset": "n2c2-2018-t1", "split": split, "priorExposure": True,
              "scope": "real protocol matching through automated product conversation",
              "native": {"patients": meta["patients"], "denominator": len(units), "correctDecisive": correct,
                         "strictAgreement": correct / len(units), "decisive": decisive,
                         "agreementWhenDecisive": correct / decisive if decisive else None,
                         "states": dict(Counter(row["state"] for row in units)),
                         "executionStates": dict(Counter(case["status"] for case in meta["cases"]))},
              "readings": {}, "predictionFreezeSha256": sha((prediction_dir / "PREDICTIONS_FROZEN.json").read_bytes())}
    out.mkdir(mode=0o700, parents=True, exist_ok=False)
    with zipfile.ZipFile(script_archive) as zipped:
        official = zipped.read("track1_eval.py")
    for reading in ("b", "c"):
        entry = {"interpretation": "b: clinical unknown read as not met" if reading == "b" else
                 "c: b except clinical unknown for ENGLISH/MAKES-DECISIONS read as met",
                 "completeAssessmentPatients": len(good_patients), "excludedProcessingOrMappingPatients": meta["patients"] - len(good_patients),
                 "completeAssessments": binary_metrics(complete, labels, reading) if complete else None,
                 "allAttemptMechanicalFailureAsNotMet": binary_metrics(units, labels, reading),
                 "mechanicallyImputedByState": dict(Counter(row["state"] for row in units if row["state"] not in ("satisfied", "not_satisfied")))}
        for name, subset in [("complete", complete), ("all-attempt-mechanical", units)]:
            if subset:
                with tempfile.TemporaryDirectory(prefix=".official-", dir=out) as scratch:
                    text = official_score(official, subset, labels, reading, Path(scratch))
                file = out / ("official-" + reading + "-" + name + ".txt")
                file.write_text(text)
                file.chmod(0o600)
        result["readings"][reading] = entry
    save(out / "metrics.json", result)
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    first = commands.add_parser("freeze")
    for name in ("campaign", "manifest", "out"):
        first.add_argument("--" + name, required=True, type=Path)
    second = commands.add_parser("score")
    for name in ("predictions", "source-root", "out"):
        second.add_argument("--" + name, required=True, type=Path)
    args = parser.parse_args()
    try:
        result = freeze(args.campaign, args.manifest, args.out) if args.command == "freeze" else score(args.predictions, args.source_root, args.out)
        print(json.dumps(result))
    except Exception:
        raise SystemExit("n2c2 scoring refused; inspect the private freeze and provenance")
