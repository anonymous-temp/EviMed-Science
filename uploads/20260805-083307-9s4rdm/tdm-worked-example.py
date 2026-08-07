#!/usr/bin/env python3
"""TDM extract: the derived quantities the scoping runs never computed.

Every number in 参考示例.md comes from here. Run it against the workbook to
reproduce them. Subjects are S1..S5 by ascending PATIENT_ID; no source
identifier is emitted.
"""
import argparse, collections, datetime as dt, json, re
import openpyxl

def load(path):
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    T = {}
    for ws in wb.worksheets:
        rows = list(ws.iter_rows(values_only=True))
        hdr = [str(h) if h is not None else f"_u{i}" for i, h in enumerate(rows[0])]
        T[ws.title] = [dict(zip(hdr, r)) for r in rows[1:]]
    wb.close()
    return T

def day(s):
    s = str(s).split()[0]
    for f in ("%d/%m/%Y", "%Y-%m-%d"):
        try: return dt.datetime.strptime(s, f).date()
        except ValueError: pass
    return None

DOSES_PER_DAY = {"QD": 1, "QN": 1, "BID": 2, "TID": 3, "QID": 4, "QOD": 0.5}
def per_day(freq):
    """The trailing digits are an in-house schedule code, not a count."""
    m = re.match(r"^(QD|QN|BID|TID|QID|QOD)\d*$", str(freq or "").upper())
    return DOSES_PER_DAY[m.group(1)] if m else None

def analyse(path):
    T = load(path)
    pid = sorted({str(r["PATIENT_ID"]) for r in T["病案首页"]})
    S = {p: f"S{i+1}" for i, p in enumerate(pid)}
    out = {}

    # 1. The identity that licenses using any of the three aripiprazole numbers.
    panel = collections.defaultdict(dict)
    for r in T["检验"]:
        try: panel[(S[str(r["PATIENT_ID"])], day(r["TEST_DATE"]))][str(r["PROJECT_NAME"])] = float(r["TEST_RESULT"])
        except (TypeError, ValueError, KeyError): pass
    identity = []
    for k, v in sorted(panel.items(), key=lambda x: (x[0][0], str(x[0][1]))):
        if {"阿立哌唑", "脱氢阿立哌唑", "总阿立哌唑"} <= v.keys():
            got = v["阿立哌唑"] + v["脱氢阿立哌唑"]
            identity.append({"subject": k[0], "date": str(k[1]), "parent": v["阿立哌唑"],
                             "metabolite": v["脱氢阿立哌唑"], "sum": round(got, 1),
                             "reportedTotal": v["总阿立哌唑"], "passes": abs(got - v["总阿立哌唑"]) <= 1.0})
    out["identity_total_equals_parent_plus_metabolite"] = {
        "checked": len(identity), "passed": sum(x["passes"] for x in identity), "rows": identity}

    # 2. Metabolic ratio — the CYP2D6 activity phenotype the data already carries.
    mr = [{"subject": k[0], "date": str(k[1]), "MR": round(v["脱氢阿立哌唑"] / v["阿立哌唑"], 3)}
          for k, v in sorted(panel.items(), key=lambda x: (x[0][0], str(x[0][1])))
          if v.get("阿立哌唑") and "脱氢阿立哌唑" in v]
    vals = [x["MR"] for x in mr]
    out["metabolic_ratio"] = {"rows": mr, "min": min(vals), "max": max(vals),
                              "fold": round(max(vals) / min(vals), 2)}

    # 3. Exposure, reconstructed from the order in force on the sampling date.
    orders = [o for o in T["医嘱记录"]
              if "阿立哌唑" in str(o.get("DRUG_NAME") or "") and str(o.get("MEDICATION_WAY")) == "口服"]
    cd, unmatched = [], []
    for lab in [r for r in T["检验"] if str(r.get("PROJECT_NAME")) == "阿立哌唑"]:
        s, td = S[str(lab["PATIENT_ID"])], day(lab["TEST_DATE"])
        live = [o for o in orders if S[str(o["PATIENT_ID"])] == s and day(o["START_DATETIME"]) and day(o["START_DATETIME"]) <= td]
        if not live:
            unmatched.append({"subject": s, "date": str(td), "concentration": float(lab["TEST_RESULT"]),
                              "note": "measured with no oral order in force — carryover, prior therapy, or an adherence question"})
            continue
        o = max(live, key=lambda x: day(x["START_DATETIME"]))
        n = per_day(o["FREQUENCY"])
        try: unit = float(str(o["DOSAGE"]).replace("mg", ""))
        except (TypeError, ValueError): continue
        if not n: continue
        daily = unit * n
        cd.append({"subject": s, "date": str(td), "dailyDoseMg": daily,
                   "concentration": float(lab["TEST_RESULT"]),
                   "CD": round(float(lab["TEST_RESULT"]) / daily, 2)})
    ratios = [x["CD"] for x in cd]
    out["dose_normalised_concentration"] = {
        "rows": cd, "unmatched": unmatched,
        "min": min(ratios), "max": max(ratios), "fold": round(max(ratios) / min(ratios), 2)}

    # 4. The within-subject repeat: what one measurement can and cannot mean.
    by_subject = collections.defaultdict(list)
    for x in cd: by_subject[x["subject"]].append(x)
    out["within_subject_repeat"] = [
        {"subject": s, "first": r[0], "second": r[1],
         "doseUnchanged": r[0]["dailyDoseMg"] == r[1]["dailyDoseMg"],
         "relativeChange": round((r[1]["concentration"] - r[0]["concentration"]) / r[0]["concentration"], 3)}
        for s, v in by_subject.items() if len(v) == 2 for r in [sorted(v, key=lambda x: x["date"])]]

    # 5. Position against the reference range carried in the row itself.
    pos = []
    for r in T["检验"]:
        m = re.match(r"^([\d.]+)-([\d.]+)$", str(r.get("REFFR_SCOPE") or ""))
        if not m: continue
        try: v = float(r["TEST_RESULT"])
        except (TypeError, ValueError): continue
        lo, hi = float(m.group(1)), float(m.group(2))
        pos.append({"subject": S[str(r["PATIENT_ID"])], "analyte": str(r["PROJECT_NAME"]),
                    "value": v, "low": lo, "high": hi,
                    "state": "within" if lo <= v <= hi else ("below" if v < lo else "above")})
    counts = collections.Counter(x["state"] for x in pos)
    out["reference_range_position"] = {"rows": pos, "counts": dict(counts),
                                       "outOfRangeRate": round(1 - counts["within"] / len(pos), 3)}

    # 6. Vitals as the adverse-effect channel, and one impossible value.
    vitals = collections.defaultdict(list)
    for r in T["体征"]:
        vitals[str(r.get("SIGN_TYPE"))].append(r)
    bp = []
    for r in vitals.get("血压", []):
        m = re.match(r"^(\d+)/(\d+)$", str(r.get("RECORD_CONTENT") or ""))
        if m: bp.append((int(m.group(1)), int(m.group(2))))
    pulse = [float(r["RECORD_CONTENT"]) for r in vitals.get("脉搏", []) if str(r.get("RECORD_CONTENT") or "").replace(".", "").isdigit()]
    temp = [float(r["RECORD_CONTENT"]) for r in vitals.get("体温", []) if str(r.get("RECORD_CONTENT") or "").replace(".", "").isdigit()]
    weight = collections.defaultdict(list)
    for r in vitals.get("体重", []):
        try: weight[S[str(r["PATIENT_ID"])]].append((day(r["RECORD_DATE"]), float(r["RECORD_CONTENT"])))
        except (TypeError, ValueError, KeyError): pass
    out["adverse_effect_channel"] = {
        "pulse": {"n": len(pulse), "max": max(pulse), "tachycardiaOver100": sum(1 for x in pulse if x > 100)},
        "temperature": {"n": len(temp), "max": max(temp), "febrileAtOrOver37_3": sum(1 for x in temp if x >= 37.3)},
        "bloodPressure": {"n": len(bp),
                          "implausibleDiastolic": [f"{a}/{b}" for a, b in bp if b < 40 or b >= a]},
        "weightTrajectory": [
            {"subject": s, "n": len(v), "firstKg": sorted(v)[0][1], "lastKg": sorted(v)[-1][1],
             "deltaKg": round(sorted(v)[-1][1] - sorted(v)[0][1], 1),
             "days": (sorted(v)[-1][0] - sorted(v)[0][0]).days}
            for s, v in sorted(weight.items()) if len(v) >= 2 and all(d for d, _ in v)],
    }
    return out

if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Derived quantities for the TDM extract.")
    ap.add_argument("workbook")
    ap.add_argument("--json")
    a = ap.parse_args()
    res = analyse(a.workbook)
    text = json.dumps(res, ensure_ascii=False, indent=2)
    if a.json: open(a.json, "w", encoding="utf-8").write(text)
    print(text)
