"""Offline gold-anchor coverage; never calls a model or reads held-out data.

Synthetic selection is an explicit audit of dev skeleton attributes, not a product
classifier. Only positive reported safety histories qualify; hypothetical pregnancy,
food preferences and ordinary medication regimens do not. These dev files contain
no positive implant/pregnancy/contraindication plants. All selected IDs are allergies
or reported sensitivities, including food and pollen histories.

Storage denominators count each fact at every snapshot after its first introduction.
A named person's gold label must occur in the same file as the anchor; an allergy
assigned to a similarly named different person is not retained correctly. The
mother's explicit source relationship supplies the audited U03 aliases. Opening
coverage counts candidate answers for the selected plants, excluding file listings.
"""
import argparse
import json
from pathlib import Path

SELECTED = {
    "M02": ["x23"], "P03": ["x09"], "P05": ["x09"], "P06": ["x09"],
    "U01": ["x42"], "U02": ["x23", "x42"], "U03": ["x19", "x38"],
    "U04": ["x24", "x42"], "U05": ["x42"], "U06": ["x38"],
}


def read(path):
    return json.loads(path.read_text())


def marked(body):
    inside = False
    out = []
    for line in body.splitlines():
        if line.startswith("# ") or line.startswith("## "):
            inside = line.startswith("## ") and line.rstrip().endswith("[evimed-safety-notes]")
        elif inside:
            out.append(line)
    return "\n".join(out)


def contains(text, anchor):
    # Literal scorer anchor with whitespace normalized, not a semantic verdict.
    return "".join(anchor.split()) in "".join(text.split())


def audit(run, data):
    med = "med-m10" in run.name
    gold = {g["itemId"]: g for g in read(data / "med-m10-dev/gold.json")["items"]} if med else {}
    rows, answers = [], []
    for case in sorted((run / "cases").iterdir()):
        if med:
            g = gold[case.name]
            facts = [("allergy", g["store"][0]["current"], g["plants"][0]["allergySession"], [])]
            questions = g["questions"]
        else:
            g = read(data / "dev" / case.name / "gold.json")
            schedule = read(data / "dev" / case.name / "schedule.json")["sessions"]
            skeleton = read(data / "dev" / case.name / "skeleton.json")
            labels = {p["id"]: p["label"].split("（")[0] for p in skeleton["people"]}
            facts = [(s["plantId"], s["current"], min(session["index"] for session in schedule
                      if any(i.get("plantId") == s["plantId"] for i in session["inserts"])),
                      (["李秀兰", "母亲", "妈妈"] if case.name == "U03" and s["plantId"] == "x19"
                       else [labels[s["subject"]]] if s["subject"] != "self" else []))
                     for s in g["store"] if s["plantId"] in SELECTED.get(case.name, [])]
            questions = g["questions"]
        for snap in sorted((case / "snapshots").glob("*.json")):
            s = read(snap)
            for plant, anchor, since, labels in facts:
                if s["afterSession"] < since:
                    continue
                bodies = s["files"]
                rows.append(dict(case=case.name, snapshot=snap.name, plant=plant, anchor=anchor,
                                 anchor_stored=contains("\n".join(bodies.values()), anchor),
                                 stored=any(contains(b, anchor) and (not labels or any(label in n + b for label in labels))
                                            for n, b in bodies.items()),
                                 marked=any(contains(marked(b), anchor) and (not labels or any(label in n + b for label in labels))
                                            for n, b in bodies.items())))
        path = case / "answers.jsonl"
        if not path.exists():
            continue
        for line in path.read_text().splitlines():
            a = json.loads(line)
            q = next(q for q in questions if q["qid"] == a["qid"])
            for plant, anchor, _, labels in facts:
                if q.get("plantId") != plant:
                    continue
                opening = a.get("opening", {})
                # A filename in the stock plugin's listing does not expose its fact.
                profile = (opening.get("profileBlock") or "").split("<available-memories>")[0]
                text = profile + "\n" + (opening.get("residentBlock") or "")
                answers.append(dict(case=case.name, qid=a["qid"], plant=plant, anchor=anchor,
                                    present=contains(text, anchor) and (not labels or any(label in text for label in labels))))
    return dict(run=run.name, snapshot_opportunities=len(rows), stored=sum(r["stored"] for r in rows),
                marked=sum(r["marked"] for r in rows), needed_answers=len(answers),
                opening=sum(a["present"] for a in answers), snapshots=rows, answers=answers)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("runs", type=Path, nargs="+")
    args = parser.parse_args()
    if any("sealed" in part for part in args.data.parts):
        raise ValueError("Only development data is allowed")
    print(json.dumps([audit(r, args.data) for r in args.runs], ensure_ascii=False, indent=2))
