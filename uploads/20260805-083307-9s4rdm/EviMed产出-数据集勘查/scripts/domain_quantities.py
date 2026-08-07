#!/usr/bin/env python3
"""Phase 2 - domain-derived quantities for the TDM scoping run.

Everything printed or written here is an aggregate or a pseudonym-labelled
value. Real PATIENT_ID/CASE_NO values are used only for joins inside the script
and are never emitted. Pseudonyms P1..P5 are assigned in the stable order of
sorted PATIENT_ID.

Recomputable: run `python3 scripts/domain_quantities.py` in /workspace.
"""
from __future__ import annotations

import json
import re
from collections import defaultdict
from pathlib import Path

import pandas as pd

WORK = Path(__file__).resolve().parent.parent
DATA = WORK / "20260803TDM.xlsx"


def load(name: str) -> pd.DataFrame:
    return pd.read_excel(DATA, sheet_name=name)


def d16(v) -> pd.Timestamp:
    """Day-first parse: 25/12/2020 11:40:02 -> 2020-12-25 11:40:02.

    Sentinel '0/0/0 00:00:00' (105/915 order rows) means 'still active / unset'
    and is returned as NaT rather than raising.
    """
    if pd.isna(v):
        return pd.NaT
    s = str(v).strip()
    if not s or re.match(r"^\s*0{1,4}[-/]0{1,2}[-/]0{1,4}", s):
        return pd.NaT
    try:
        return pd.to_datetime(s, format="%d/%m/%Y %H:%M:%S")
    except ValueError:
        try:
            return pd.to_datetime(s, format="%d/%m/%Y")
        except ValueError:
            return pd.to_datetime(s, dayfirst=True)


def pseudonym_map(frames: dict[str, pd.DataFrame]) -> dict[int, str]:
    ids = set()
    for df in frames.values():
        if "PATIENT_ID" in df.columns:
            ids |= {int(v) for v in df["PATIENT_ID"].dropna()}
    order = sorted(ids)
    return {v: f"P{i + 1}" for i, v in enumerate(order)}


def decode_frequency(freq: str) -> tuple[str, float | None]:
    """Return (pattern, doses_per_day) with the local-course coding decoded.

    Vocabulary observed (30 values): ONCE, QD, QN, BID, TID, QOD, PRN, ALWAYS,
    and suffixed course forms QD<n> (once daily for n days), BID<n>, TID<n>,
    W<d>D<w> (d days per week for w weeks), W<d>D (d days per week), ALWAYS<n>.
    The numeric suffix is a course length, NOT a multiplicity, so daily dose
    uses the bare frequency multiplier: QD=1, BID=2, TID=3, QN=1, WxDy=d/7
    (average), QOD=0.5, PRN=NaN (as-needed, not computable).
    """
    f = freq.strip().upper()
    base = re.sub(r"\d+$", "", f)
    mult = {"QD": 1.0, "QN": 1.0, "BID": 2.0, "TID": 3.0, "QOD": 0.5}
    if f == "ONCE":
        return "once", None
    if f == "ALWAYS" or f == "ALWAYS1":
        return "standing", 1.0
    if f == "PRN":
        return "prn", None
    m = re.match(r"^W(\d+)D(\d*)$", f)
    if m:
        days = int(m.group(1))
        return ("W" + m.group(1) + "D" + m.group(2), days / 7.0)
    if base in mult:
        return (base, mult[base])
    return (f, None)


def daily_dose(row) -> float | None:
    if row["FREQUENCY"] is None or pd.isna(row["FREQUENCY"]):
        return None
    _, mult = decode_frequency(str(row["FREQUENCY"]))
    if mult is None:
        return None
    try:
        dose = float(row["DOSAGE"])
    except (TypeError, ValueError):
        return None
    return dose * mult


def split_ref(scope) -> tuple[float | None, float | None]:
    if pd.isna(scope) or not str(scope).strip():
        return None, None
    m = re.match(r"^\s*([\d.]+)\s*-\s*([\d.]+)\s*$", str(scope))
    if not m:
        return None, None
    return float(m.group(1)), float(m.group(2))


def main() -> None:
    fp = load("病案首页")
    ords = load("医嘱记录")
    labs = load("检验")
    diag = load("诊断记录")
    vit = load("体征")
    frames = {"fp": fp, "ords": ords, "labs": labs, "diag": diag, "vit": vit}
    P = pseudonym_map(frames)

    # ---------- 1. decoded frequency inventory ----------
    freq_rows = ords[["FREQUENCY"]].drop_duplicates()
    decoded = []
    for f in freq_rows["FREQUENCY"]:
        pat, mult = decode_frequency(f)
        decoded.append({"value": f, "pattern": pat, "dosesPerDay": mult,
                        "courseDurationDays": re.sub(r"^W\d+D?", "", f) if re.match(r"^W\d+D", f) else None})
    decoded.sort(key=lambda d: d["value"])

    # ---------- 2. per-drug active daily dose at each TDM test date ----------
    drug_keywords = {
        "阿立哌唑": "阿立哌唑",
        "奥氮平": "奥氮平",
        "氯氮平": "氯氮平",
        "氯硝西泮": "氯硝西泮",
        "帕利哌酮": "帕利哌酮",
    }
    # Brand-name aliases observed in the orders table. 芮达 = paliperidone ER;
    # 安律凡 = aripiprazole (already covered by generic string).
    brand_aliases = {"芮达": "帕利哌酮"}
    ords["START"] = ords["START_DATETIME"].apply(d16)
    ords["END"] = ords["END_DATETIME"].apply(d16)
    ords["END_SENTINEL"] = ords["END_DATETIME"].astype(str).str.match(
        r"^\s*0{1,4}[-/]0{1,2}[-/]0{1,4}")

    lab = labs.copy()
    # Sample labels S1..S6 in stable (TEST_DATE, SAMPLENO) order; the raw sample
    # numbers never leave the data.
    lab["S"] = lab.assign(_k=range(len(lab))).apply(
        lambda r: None, axis=1)
    order = (lab[["SAMPLENO", "TEST_DATE"]].drop_duplicates()
             .assign(_d=lab[["SAMPLENO", "TEST_DATE"]].drop_duplicates()["TEST_DATE"].apply(d16))
             .sort_values(["_d", "SAMPLENO"]))
    lab_map = {s: f"S{i + 1}" for i, s in enumerate(order["SAMPLENO"])}
    lab["S"] = lab["SAMPLENO"].map(lab_map)
    lab["P"] = lab["PATIENT_ID"].map(P)
    lab["TEST_DATE_TS"] = lab["TEST_DATE"].apply(d16)
    lab["drug"] = lab["PROJECT_NAME"].map(
        lambda n: next((k for k in drug_keywords if k in str(n)), None))

    events = []
    for _, row in lab.iterrows():
        pid = int(row["PATIENT_ID"])
        drug = row["drug"]
        if drug is None:
            events.append({"pseudonym": row["P"], "sample": row["S"],
                           "testDate": str(row["TEST_DATE"]), "project": row["PROJECT_NAME"],
                           "result": float(row["TEST_RESULT"]), "ref": str(row["REFFR_SCOPE"]),
                           "drug": drug, "doseMgPerDay": None, "cdRatio": None,
                           "daysOnDrug": None, "activeOrders": 0})
            continue
        same = ords[(ords["PATIENT_ID"] == pid) &
                    (ords["DRUG_NAME"].astype(str).str.contains(drug, na=False) |
                     ords["DRUG_NAME"].astype(str).isin([k for k, v in brand_aliases.items() if v == drug]))]
        active = same[(same["START"] <= row["TEST_DATE_TS"]) &
                      ((same["END_SENTINEL"]) | (same["END"] >= row["TEST_DATE_TS"]))]
        active_drug = active[active["MEDICATION_WAY"] != "出院带药"]
        doses = active_drug.apply(daily_dose, axis=1).dropna()
        # Sum, not mean: simultaneous orders (e.g. 100 mg QD + 300 mg QN) are
        # additive parts of one daily regimen.
        dose = float(doses.sum()) if len(doses) else None
        start_dates = [d for d in same["START"].dropna() if d <= row["TEST_DATE_TS"]]
        days_on = (row["TEST_DATE_TS"] - min(start_dates)).days if start_dates else None
        ref_lo, ref_hi = split_ref(row["REFFR_SCOPE"])
        res = float(row["TEST_RESULT"])
        if ref_lo is not None and ref_hi is not None:
            if res < ref_lo:
                pos = "below"
            elif res > ref_hi:
                pos = "above"
            else:
                pos = "within"
        else:
            pos = "no-ref"
        events.append({
            "pseudonym": row["P"], "sample": row["S"], "testDate": str(row["TEST_DATE"]),
            "project": row["PROJECT_NAME"], "drug": drug, "result": res,
            "ref": str(row["REFFR_SCOPE"]), "refPosition": pos,
            "doseMgPerDay": round(dose, 2) if dose is not None else None,
            "cdRatio": round(res / dose, 3) if dose else None,
            "daysOnDrug": days_on, "activeOrders": int(len(active)),
        })

    # aripiprazole metabolite-to-parent ratios per sample
    ari = [e for e in events if e["drug"] == "阿立哌唑"]
    by_sample = defaultdict(dict)
    for e in ari:
        by_sample[e["sample"]][e["project"]] = e
    ratios = []
    for sample, d in sorted(by_sample.items()):
        par = d.get("阿立哌唑", {}).get("result")
        met = d.get("脱氢阿立哌唑", {}).get("result")
        tot = d.get("总阿立哌唑", {}).get("result")
        ratios.append({
            "sample": sample, "pseudonym": d.get("阿立哌唑", {}).get("pseudonym"),
            "testDate": d.get("阿立哌唑", {}).get("testDate"),
            "parent": par, "dehydro": met, "total": tot,
            "dehydroParentRatio": round(met / par, 3) if (par and met) else None,
            "totalParentRatio": round(tot / par, 3) if (par and tot) else None,
        })

    # ---------- 3. vitals: composite split + per-patient daily series ----------
    vit["P"] = vit["PATIENT_ID"].map(P)
    vit["DATE"] = vit["RECORD_DATE"].apply(d16)
    bp = vit[vit["SIGN_TYPE"] == "血压"].copy()
    bp["SYS"], bp["DIA"] = None, None
    for i, r in bp.iterrows():
        m = re.match(r"^\s*(\d{2,3})\s*/\s*(\d{2,3})\s*$", str(r["RECORD_CONTENT"]))
        if m:
            bp.at[i, "SYS"] = int(m.group(1))
            bp.at[i, "DIA"] = int(m.group(2))
    bp_parsed = bp[bp["SYS"].notna()].copy()

    wt = vit[vit["SIGN_TYPE"] == "体重"]["RECORD_CONTENT"].astype(float)
    ht = vit[vit["SIGN_TYPE"] == "身高"]["RECORD_CONTENT"].astype(float)

    vit_summary = {
        "rows": int(len(vit)),
        "perPatientRows": {p: int(vit[vit["P"] == p].shape[0]) for p in ["P1", "P2", "P3", "P4", "P5"]},
        "signTypeCounts": {k: int(v) for k, v in vit["SIGN_TYPE"].value_counts().items()},
        "bpCompositeCount": int(len(bp)), "bpParsedCount": int(len(bp_parsed)),
        "bpParseFailures": int(len(bp) - len(bp_parsed)),
        "bpMeanSys": float(bp_parsed["SYS"].mean()) if len(bp_parsed) else None,
        "bpMeanDia": float(bp_parsed["DIA"].mean()) if len(bp_parsed) else None,
        "weightCount": int(len(wt)), "heightCount": int(len(ht)),
    }

    # ---------- 4. order-level exposure facts ----------
    drug_orders = ords[ords["DRUG_FLAG"] == 1]
    disch = drug_orders[drug_orders["MEDICATION_WAY"] == "出院带药"]
    standing = drug_orders[drug_orders["FREQUENCY"].isin(["ALWAYS", "ALWAYS1"])]
    orders_summary = {
        "rows": int(len(ords)), "drugOrders": int(len(drug_orders)),
        "dischargeTakeHome": int(len(disch)),
        "dischargeOnsetWithinAdmission": int(disch["START"].notna().sum()),
        "standingOrders": int(len(standing)),
        "endSentinelRows": int(ords["END_SENTINEL"].sum()),
        "cancelled": int((ords["ORDER_STATE"] == "已作废").sum()),
    }

    out = {
        "nPatients": len(P), "pseudonyms": list(P.values()),
        "frequencyVocabulary": decoded, "ordersSummary": orders_summary,
        "tdmEvents": events, "aripiprazoleRatios": ratios, "vitalsSummary": vit_summary,
    }
    (WORK / "scoping-run-phase2.json").write_text(
        json.dumps(out, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")

    print("=== TDM events (pseudonym-labelled) ===")
    hdr = f"{'P':4} {'sample':<16} {'date':<12} {'drug':<12} {'result':>8} {'ref':<14} {'pos':<7} {'mg/d':>7} {'C/D':>7} {'daysOn':>7}"
    print(hdr)
    for e in events:
        print(f"{e['pseudonym']:4} {e['sample']:<16} {e['testDate']:<12} {e['drug'] or e['project']:<12} "
              f"{e['result']:>8} {e['ref']:<14} {e['refPosition']:<7} "
              f"{str(e['doseMgPerDay']):>7} {str(e['cdRatio']):>7} {str(e['daysOnDrug']):>7}")
    print("\n=== aripiprazole ratios ===")
    for r in ratios:
        print(r)
    print("\n=== vitals summary ===")
    print(json.dumps(vit_summary, ensure_ascii=False, indent=2))
    print("\n=== orders summary ===")
    print(json.dumps(orders_summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
