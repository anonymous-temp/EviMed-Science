"""Convert the feature's saved judgments into the official evaluators' input.

Input is a JSONL of saved judgments, one record per patient:

  { patientId, status, ranking: [ { registryId, fit, confidence, verdict, rank, criteria? } ],
    failed: [ { registryId, code } ], usage?: { inputTokens, outputTokens, costCny } }

Output is one full_email_<patient_id>.json per case with a cover_page_list in the
saved rank order, exactly the file the official TrialGPT 2.0 evaluators load. A
candidate with no saved judgment follows every judged one, in the order the case
listed it, and is counted. Nothing is ever reordered by a gold label: this module
never sees one.
"""
from collections import Counter
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))  # python -I does not add the script directory

from common import PATIENT_ID, canonical_trial_id, read_jsonl

FINISHED_STATUSES = frozenset({"complete", "completed", "done", "finished", "succeeded"})


def _number(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def convert_subject(case, record, absent="input-order"):
    """One official payload and its counts. `record` is None when nothing was saved for the patient."""
    candidates = [canonical_trial_id(trial) for trial in case["candidateIds"]]
    known = set(candidates)
    entries = (record or {}).get("ranking") or []
    judged, seen, foreign, duplicate = [], set(), 0, 0
    for position, entry in enumerate(entries):
        trial = canonical_trial_id(entry.get("registryId"))
        if trial not in known:
            foreign += 1
        elif trial in seen:
            duplicate += 1
        else:
            seen.add(trial)
            rank = _number(entry.get("rank"))
            judged.append((rank is None, rank if rank is not None else 0, position, trial, entry))
    judged.sort(key=lambda item: item[:3])

    codes = {}
    for failure in (record or {}).get("failed") or []:
        trial = canonical_trial_id(failure.get("registryId"))
        if trial in known and trial not in seen:
            codes.setdefault(trial, str(failure.get("code") or "unknown"))

    rows = []
    for _, _, _, trial, entry in judged:
        score, confidence = _number(entry.get("fit")), _number(entry.get("confidence"))
        rows.append({"trial_id": trial, "score": score if score is not None else 0.0,
                     "confidence": confidence if confidence is not None else 0.0,
                     "final_score": (score or 0.0) + (confidence or 0.0), "verdict": entry.get("verdict"),
                     "rank": _number(entry.get("rank")), "judged": True})
    for trial in candidates:
        if trial not in seen:
            rows.append({"trial_id": trial, "score": 0.0, "confidence": 0.0, "final_score": 0.0, "verdict": None,
                         "rank": None, "judged": False, "failure_code": codes.get(trial)})

    status = (record or {}).get("status")
    counts = {"hasRecord": record is not None, "status": status if isinstance(status, str) else None,
              "candidates": len(candidates), "judged": len(judged), "unjudged": len(candidates) - len(judged),
              "failed": dict(Counter(codes.values())), "foreignRanked": foreign, "duplicateRanked": duplicate}
    payload = {"patient_id": case["patientId"], "patient_ID": case["patientId"], "cover_page_list": rows,
               "metadata": counts}
    if absent == "skip" and record is None:
        return None, counts
    return payload, counts


def usage_of(record):
    usage = (record or {}).get("usage") or {}
    return {"inputTokens": _number(usage.get("inputTokens")) or 0, "outputTokens": _number(usage.get("outputTokens")) or 0,
            "costCny": _number(usage.get("costCny")) or _number((record or {}).get("costCny")) or 0.0,
            "reported": bool(usage) or _number((record or {}).get("costCny")) is not None}


def convert(cases_path, judgments_path, out_dir, absent="input-order"):
    """Write one official file per case; returns aggregate completion counts (no patient ids)."""
    cases = read_jsonl(cases_path)
    by_patient = {case["patientId"]: case for case in cases}
    records, duplicates, unknown = {}, 0, 0
    for record in read_jsonl(judgments_path) if judgments_path else []:
        pid = record.get("patientId")
        if pid not in by_patient:
            unknown += 1
            continue
        duplicates += pid in records
        records[pid] = record  # the last saved record for a patient stands

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    for stale in out.glob("full_email_*.json"):
        stale.unlink()
    totals = Counter()
    failed, statuses, usage_total = Counter(), Counter(), Counter()
    for case in cases:
        pid = case["patientId"]
        if not PATIENT_ID.match(pid):
            raise ValueError("Unsafe patient id")
        record = records.get(pid)
        payload, counts = convert_subject(case, record, absent)
        totals["patients"] += 1
        totals["patientsWithRecord"] += counts["hasRecord"]
        totals["patientsFinished"] += str(counts["status"] or "").lower() in FINISHED_STATUSES
        totals["pairs"] += counts["candidates"]
        totals["pairsJudged"] += counts["judged"]
        totals["pairsUnjudged"] += counts["unjudged"]
        totals["patientsBelowK"] += counts["judged"] < 10  # the rest of their ten places are filled by input order
        totals["foreignRanked"] += counts["foreignRanked"]
        totals["duplicateRanked"] += counts["duplicateRanked"]
        failed.update(counts["failed"])
        statuses[counts["status"] or ("(none)" if counts["hasRecord"] else "(no record)")] += 1
        usage = usage_of(record)
        for key in ("inputTokens", "outputTokens", "costCny"):
            usage_total[key] += usage[key]
        usage_total["patientsReporting"] += usage["reported"]
        if payload is not None:
            (out / f"full_email_{pid}.json").write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return {**totals, "pairsFailedByCode": dict(failed), "statusCounts": dict(statuses),
            "duplicateRecords": duplicates, "recordsForUnknownPatients": unknown,
            "usage": {key: usage_total[key] for key in ("inputTokens", "outputTokens", "costCny", "patientsReporting")}}


def main():
    import argparse
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--cases", type=Path, required=True, help="a board's cases.jsonl")
    parser.add_argument("--judgments", type=Path, required=True, help="saved judgments, one JSON record per line")
    parser.add_argument("--out", type=Path, required=True, help="directory for full_email_<patient_id>.json")
    parser.add_argument("--absent", choices=("input-order", "skip"), default="input-order",
                        help="a patient with no saved record: list every candidate unjudged (default), or write no file")
    args = parser.parse_args()
    print(json.dumps(convert(args.cases, args.judgments, args.out, args.absent), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
