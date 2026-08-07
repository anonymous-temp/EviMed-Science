#!/usr/bin/env python3
"""Phase 1/4 - data quality checks (Kahn 2016 categories), recomputable.

Verification checks against local metadata and internal consistency; no
external benchmark is available for these values, so no item is reported as a
Kahn 'validation' check.

Recomputable: `python3 scripts/quality_checks.py` in /workspace.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pandas as pd

WORK = Path(__file__).resolve().parent.parent
DATA = WORK / "20260803TDM.xlsx"


def d16(v):
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


def main() -> None:
    fp = pd.read_excel(DATA, sheet_name="病案首页")
    ords = pd.read_excel(DATA, sheet_name="医嘱记录")
    labs = pd.read_excel(DATA, sheet_name="检验")
    vit = pd.read_excel(DATA, sheet_name="体征")
    diag = pd.read_excel(DATA, sheet_name="诊断记录")

    ids = sorted(set(int(v) for v in fp["PATIENT_ID"]))
    P = {v: f"P{i+1}" for i, v in enumerate(ids)}
    fp["P"] = fp["PATIENT_ID"].map(P)

    fp["IN"] = fp["IN_DATE"].apply(d16)
    fp["DIS"] = fp["DIS_DATE"].apply(d16)
    fp["BIRTH"] = fp["BIRTHDATE"].apply(d16)

    out = {}

    # --- atemporal plausibility: age at admission vs birthdate ---
    fp["age_from_birth"] = ((fp["IN"] - fp["BIRTH"]).dt.days / 365.25).astype(float)
    fp["age_from_text"] = fp["AGE"].astype(str).str.extract(r"(\d+)").astype(float)
    fp["age_mismatch"] = (fp["age_from_birth"] - fp["age_from_text"]).abs() > 1.5
    out["ageVsBirthdate"] = {
        "patientsChecked": int(len(fp)),
        "mismatchCount": int(fp["age_mismatch"].sum()),
        "perPatient": {r["P"]: round(float(r["age_from_birth"]), 1) for _, r in fp.iterrows()},
    }

    # --- temporal plausibility: IN < DIS, DAY_TOTAL consistency ---
    fp["los_days"] = (fp["DIS"] - fp["IN"]).dt.days
    fp["daytotal_mismatch"] = (fp["los_days"] - fp["DAY_TOTAL"]).abs() > 2
    out["admissionWindow"] = {
        "inBeforeDisAll": bool((fp["IN"] < fp["DIS"]).all()),
        "dayTotalMismatchCount": int(fp["daytotal_mismatch"].sum()),
        "losByPatient": {r["P"]: int(r["los_days"]) for _, r in fp.iterrows()},
    }

    # --- TDM samples inside admission window ---
    labs["IN"] = labs["PATIENT_ID"].map(fp.set_index("PATIENT_ID")["IN"])
    labs["DIS"] = labs["PATIENT_ID"].map(fp.set_index("PATIENT_ID")["DIS"])
    labs["TD"] = labs["TEST_DATE"].apply(d16)
    labs["AD"] = labs["APPLY_DATE"].apply(d16)
    out["tdmTiming"] = {
        "applyBeforeTestAll": bool((labs["AD"] <= labs["TD"]).all()),
        "testInsideAdmission": int(((labs["TD"] >= labs["IN"]) & (labs["TD"] <= labs["DIS"])).sum()),
        "testTotal": int(len(labs)),
    }

    # --- vitals inside admission and daily cadence ---
    vit["P"] = vit["PATIENT_ID"].map(P)
    vit["RD"] = vit["RECORD_DATE"].apply(d16)
    vit["IN"] = vit["PATIENT_ID"].map(fp.set_index("PATIENT_ID")["IN"])
    vit["DIS"] = vit["PATIENT_ID"].map(fp.set_index("PATIENT_ID")["DIS"])
    out["vitalsTiming"] = {
        "insideAdmission": int(((vit["RD"] >= vit["IN"]) & (vit["RD"] <= vit["DIS"])).sum()),
        "total": int(len(vit)),
        "allAt1400": bool((vit["RD"].dt.hour == 14).all()),
    }

    # --- orders: end >= start when both present (sentinel excluded) ---
    ords["ST"] = ords["START_DATETIME"].apply(d16)
    ords["EN"] = ords["END_DATETIME"].apply(d16)
    ords["sent"] = ords["END_DATETIME"].astype(str).str.match(r"^\s*0{1,4}[-/]0{1,2}[-/]0{1,4}")
    both = ords[~ords["sent"] & ords["ST"].notna() & ords["EN"].notna()]
    out["orderTimeOrder"] = {
        "endAfterStartAll": bool((both["EN"] >= both["ST"]).all()),
        "checkedRows": int(len(both)),
        "sentinelEndRows": int(ords["sent"].sum()),
    }

    # --- diagnosis record CASE_NO join integrity ---
    out["diagnosisJoin"] = {
        "patientIdFill": float(diag["PATIENT_ID"].notna().mean()),
        "caseNoFill": float(diag["CASE_NO"].notna().mean()),
        "caseNoDistinct": int(diag["CASE_NO"].nunique()),
        "frontPageCases": int(fp["CASE_NO"].nunique()),
    }

    # --- sex/blood code sets (local vocabularies, unverified semantics) ---
    out["localVocabularies"] = {
        "SEX_values": sorted(fp["SEX"].unique().tolist()),
        "BLOOD_TYPE_values": sorted(fp["BLOOD_TYPE"].unique().tolist()),
        "BLOOD_RH_values": sorted(fp["BLOOD_RH"].unique().tolist()),
        "FREQUENCY_distinct": int(ords["FREQUENCY"].nunique()),
        "ORDER_TYPE_values": sorted(ords["ORDER_TYPE"].unique().tolist()),
        "ADM_WAY_values": sorted(fp["ADM_WAY"].unique().tolist()),
        "DIS_WAY_values": sorted(fp["DIS_WAY"].unique().tolist()),
        "DIS_RESULT_values": sorted(fp["DIS_RESULT"].unique().tolist()),
    }

    # --- drug order coverage by analyte ---
    names = ords[ords["DRUG_FLAG"] == 1]["DRUG_NAME"].astype(str)
    for drug in ["阿立哌唑", "奥氮平", "氯氮平", "氯硝西泮", "帕利哌酮"]:
        direct = names.str.contains(drug, na=False).sum()
        brand = names.isin(["芮达"]).sum() if drug == "帕利哌酮" else 0
        out.setdefault("drugOrderCoverage", {})[drug] = {
            "genericNameOrders": int(direct), "brandNameOrders": int(brand),
        }

    (WORK / "scoping-run-quality.json").write_text(
        json.dumps(out, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")
    print(json.dumps(out, ensure_ascii=False, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
