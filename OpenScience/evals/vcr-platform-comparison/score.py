"""Score the product's saved patient-trial view, never a replacement model answer."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path

from alignment import align, native_label, score_aligned


def read(path):
    return json.loads(path.read_text())


def extract(campaign, reference, collection, planned=None):
    sources = {source["id"]:source for source in reference["sources"]}
    units, issues, cases, seen = [], [], [], set()
    for file in sorted(campaign.glob("*/case.json")):
        record = read(file)
        patient = record["caseId"]
        if patient != file.parent.name or patient in seen or planned is not None and patient not in planned:
            raise ValueError("Case artifact identity differs from the frozen campaign")
        seen.add(patient)
        if record.get("cleanup", {}).get("deleted") is not True:
            issues.append({"patient":patient,"kind":"account_cleanup_failed"})
        case_units = 0
        for entry in record.get("trialDetails", []):
            trial = entry.get("registryId")
            page = entry.get("detail", {}).get("patientTrials", {})
            metadata = next((row for row in page.get("trials", []) if row.get("id") == entry.get("id")), {})
            if not trial or metadata.get("registryId") != trial:
                issues.append({"patient":patient,"trial":trial,"kind":"trial_identity_mismatch",
                               "actualRegistryId":metadata.get("registryId"),"rejectedCriteria":(page.get("selected")or{}).get("criteria",[])})
                continue
            provenance = metadata.get("collection") or {}
            verified = all(provenance.get(key) == collection[key] for key in ("id","sourceVersion","databaseSha256"))
            selected = page.get("selected") or {}
            if selected.get("id") != entry.get("id"):
                issues.append({"patient":patient,"trial":trial,"kind":"wrong_selected_trial"})
                continue
            if not verified:
                issues.append({"patient":patient,"trial":trial,"kind":"unverified_source_collection"})
            for clause in selected.get("criteria", []):
                kind = clause.get("kind")
                source_id = str(trial) + ":" + str(kind)
                source = sources.get(source_id)
                if kind not in ("inclusion","exclusion") or not clause.get("criterionId"):
                    issues.append({"patient":patient,"trial":trial,"kind":"unmapped_platform_identity","rejectedCriterion":clause})
                    continue
                units.append({"id":patient+":"+str(trial)+":"+clause["criterionId"], "patient_id":patient,
                    "trial_id":trial,"criterion_type":kind,"source_id":source_id,
                    "source_version":source["version"] if verified and source else "unverified",
                    "text":clause.get("text") or "", "state":clause.get("state") if clause.get("decidedBy") else None,
                    "applicable":clause.get("applicable"), "evidence":clause.get("evidenceItems", [])})
                case_units += 1
        cases.append({"patient":patient,"status":record.get("status"),"runId":record.get("runId"),
                      "studyId":record.get("studyId"),"criteria":case_units})
    for patient in sorted((set(planned) if planned is not None else set()) - seen):
        cases.append({"patient":patient,"status":"missing_artifact","criteria":0})
        issues.append({"patient":patient,"kind":"missing_case_artifact"})
    return units,issues,cases


def score(campaign, reference_path, collection_path, gold_path, out):
    frozen = read(campaign / "FROZEN.json")
    digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
    here = Path(__file__).parent
    if (digest(here / "alignment.py") != frozen["alignmentCodeSha256"]
            or digest(here / "alignment-policy.json") != frozen["alignmentPolicySha256"]):
        raise ValueError("Scorer alignment differs from the pre-inference freeze")
    verified=[]
    for file,key in [(reference_path,"referenceSha256"),(collection_path,"collectionManifestSha256"),(gold_path,"goldSha256")]:
        raw=file.read_bytes()
        if hashlib.sha256(raw).hexdigest()!=frozen.get(key):
            raise ValueError("Reference, collection or target differs from the pre-inference freeze")
        verified.append(json.loads(raw))
    reference,collection,gold=verified
    selected = set(frozen["planned"])
    reference["gold_units"] = [unit for unit in reference["gold_units"] if unit["patient_id"] in selected]
    units,issues,cases = extract(campaign,reference,collection,selected)
    payload = {**reference,"platform_units":units}
    alignment = align(payload)
    targets = {str(row["annotation_id"]):row["expert_eligibility"] for row in gold}
    historical = {str(row["annotation_id"]):row["gpt4_eligibility"] for row in gold}
    measures = score_aligned(alignment,units,targets)
    matched = [row for row in alignment["rows"] if row["status"] == "aligned"]
    by_id = {unit["id"]:unit for unit in units}
    confusion = Counter((targets[row["gold_id"]],native_label(by_id[row["platform_ids"][0]]) or "missing") for row in matched)
    correct = sum(historical[row["gold_id"]] == targets[row["gold_id"]] for row in matched)
    result = {"scope":"known-candidate product matching; not retrieval or clinical validation",
        "sourceSha":frozen["sourceSha"],"measures":measures,
        "historical_on_same_aligned_ids":{"correct":correct,"denominator":len(matched),"agreement":correct/len(matched) if matched else None},
        "confusion":[{"gold":a,"prediction":p,"n":n}for(a,p),n in sorted(confusion.items())],
        "alignmentBuckets":alignment["buckets"],"platformBuckets":alignment["platform_buckets"],
        "cases":cases,"issues":issues,"goldSha256":digest(gold_path),"referenceSha256":digest(reference_path)}
    out.mkdir(parents=True,exist_ok=False)
    for name,data in [("alignment.json",alignment),("product-units.json",units),("summary.json",result)]:
        (out/name).write_text(json.dumps(data,ensure_ascii=False,indent=2)+"\n")
    return measures


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    for name in ("campaign","reference","collection","gold","out"):parser.add_argument("--"+name,type=Path,required=True)
    args=parser.parse_args()
    print(json.dumps(score(args.campaign,args.reference,args.collection,args.gold,args.out),indent=2))
