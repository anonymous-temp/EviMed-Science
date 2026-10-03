import csv, json, os

D = "/workspace/deliverables/hfpef-sglt2-appraisal"
with open(os.path.join(D, "appraisal-table.json"), encoding="utf-8") as f:
    data = json.load(f)

studies = data["studies"]
bodies = data["bodies"]

# --- validate certainty arithmetic ---
CERT_RANK = {"very-low": 0, "low": 1, "moderate": 2, "high": 3}
START = {"high": 3, "low": 1}
errors = []
for b in bodies:
    start = START.get(b["startingCertainty"])
    if start is None:
        errors.append(f"body '{b['outcome']}': bad startingCertainty {b['startingCertainty']}")
        continue
    down = sum(d["steps"] for d in b["downgrades"])
    up = sum(1 for _ in b["upgrades"])
    calc = max(0, min(3, start - down + up))
    # map calc rank back to word
    calc_word = [k for k, v in CERT_RANK.items() if v == calc][0]
    if calc_word != b["certainty"]:
        errors.append(f"body '{b['outcome']}': certainty {b['certainty']} != computed {calc_word} (start {b['startingCertainty']} - {down} + {up})")

# --- validate study ids ---
ids = {s["id"] for s in studies}
for b in bodies:
    for sid in b["studies"]:
        if sid not in ids:
            errors.append(f"body '{b['outcome']}' references unknown study {sid}")

appraised_ids = {s["id"] for s in studies if s.get("appraised")}
# every appraised study appears in at least one body
for s in studies:
    if s.get("appraised") and s["id"] not in {sid for b in bodies for sid in b["studies"]}:
        errors.append(f"appraised study {s['id']} not in any body")

# --- write appraisal-table.csv ---
csv_path = os.path.join(D, "appraisal-table.csv")
cols = ["id", "design", "appraised", "citation", "identifier_type", "identifier_value",
        "riskOfBias_rating", "riskOfBias_reason", "indirectness_rating", "indirectness_reason",
        "imprecision_rating", "imprecision_reason", "notAppraisedReason"]
with open(csv_path, "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(cols)
    for s in studies:
        dom = s.get("domains", {})
        def domv(k, part):
            return dom.get(k, {}).get(part, "")
        ident = s.get("identifier", {})
        w.writerow([
            s["id"], s["design"], "true" if s.get("appraised") else "false", s.get("citation", ""),
            ident.get("type", ""), ident.get("value", ""),
            domv("riskOfBias", "rating"), domv("riskOfBias", "reason"),
            domv("indirectness", "rating"), domv("indirectness", "reason"),
            domv("imprecision", "rating"), domv("imprecision", "reason"),
            s.get("notAppraisedReason", "")
        ])

# --- write citation-ledger.csv ---
ledger_path = os.path.join(D, "citation-ledger.csv")
with open(ledger_path, "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(["id", "identifier_type", "identifier_value", "citation"])
    for s in studies:
        ident = s.get("identifier", {})
        w.writerow([s["id"], ident.get("type", ""), ident.get("value", ""), s.get("citation", "")])

# --- report counts ---
n_total = len(studies)
n_appraised = len(appraised_ids)
n_not = n_total - n_appraised
print(f"studies_total={n_total}")
print(f"studies_appraised={n_appraised}")
print(f"studies_not_appraised={n_not}")
print(f"bodies={len(bodies)}")
for b in bodies:
    print(f"body_outcome={b['outcome']} certainty={b['certainty']} studies={b['studies']}")
print("errors:", errors if errors else "none")
