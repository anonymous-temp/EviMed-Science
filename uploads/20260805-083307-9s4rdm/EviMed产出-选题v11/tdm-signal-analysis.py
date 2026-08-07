#!/usr/bin/env python3
"""Phase 2 — deterministic TDM signal-quantity computation (kept artifact).

For every lab draw, reconstruct the active daily dose at the draw date from the
order table and compute the domain quantities that carry TDM information:

  - dose-normalized concentration  C/D = C(ng/mL) / D(mg/day)   [parent and total]
  - metabolite-to-parent ratio     DHA/ARI
  - position within assay reference range
  - steady-state plausibility vs 5 x half-life since last dose change
  - ambiguity range of C/D under the local FREQUENCY decoding scenarios

Local-frequency handling: QD/QN/QDxx -> 1 administration/day, BID/BIDx -> 2,
TID -> 3, QOD -> 0.5. For 'BID4' the suffix is a local schedule template whose
semantics are unverifiable from this file, so the daily dose is carried as an
interval [dose x 1, dose x 2] and every C/D derived from it as a range. ONCE
orders are take-home/discharge or TCM batch orders and are excluded from the
in-hospital regimen unless MEDICATION_WAY marks them 口服/煎服 with a date span.

Only pseudonyms are emitted. Half-lives (ari ~75 h, dehydro ~94 h, olanzapine
~30 h, clozapine ~16 h, paliperidone ~24 h, clonazepam ~35 h) are literature
values from the AGNP-TDM consensus [Hiemke 2018], to be re-verified in Phase 3.

Run:  python3 tdm-signal-analysis.py
"""
from __future__ import annotations

import json
import re
from collections import Counter
from datetime import datetime, timedelta
from pathlib import Path

import pandas as pd

SRC = Path("20260803TDM.xlsx")
FRONT, ORDERS, LABS = [pd.read_excel(SRC, sheet_name=s) for s in ["病案首页", "医嘱记录", "检验"]]

PIDS = sorted(FRONT["PATIENT_ID"].dropna().unique())
PSEUDO = {pid: f"P{i+1}" for i, pid in enumerate(PIDS)}
FRONT["P"] = FRONT["PATIENT_ID"].map(PSEUDO)
ORDERS["P"] = ORDERS["PATIENT_ID"].map(PSEUDO)
LABS["P"] = LABS["PATIENT_ID"].map(PSEUDO)

# frequency decode: administrations per day (multiplier on the per-dose amount)
FREQ_MULT = {
    "QD": 1, "QD11": 1, "QD12": 1, "QD16": 1, "QN": 1,
    "BID": 2, "BID1": 2, "BID5": 2, "BID8": 2, "TID": 3, "TID4": 3,
    # BID4: ambiguous local template; scenario A = 1x, scenario B = 2x per day
    "BID4": (1, 2),
}
HALF_LIFE_H = {"阿立哌唑": 75.0, "总阿立哌唑": 75.0, "脱氢阿立哌唑": 94.0,
               "奥氮平": 30.0, "氯氮平": 16.0, "帕利哌酮（帕潘立酮）": 24.0,
               "氯硝西泮": 35.0}
# project name -> order DRUG_NAME substrings (generic + local brand names)
PROJECT_ORDERS = {
    "阿立哌唑": ["阿立哌唑", "博思清", "安律凡"],
    "总阿立哌唑": ["阿立哌唑", "博思清", "安律凡"],
    "脱氢阿立哌唑": ["阿立哌唑", "博思清", "安律凡"],
    "奥氮平": ["奥氮平"],
    "氯氮平": ["氯氮平"],
    "帕利哌酮（帕潘立酮）": ["芮达", "帕利哌酮"],
    "氯硝西泮": ["氯硝西泮"],
}
ACTIVE_WAYS = {"口服", "静滴", "肌注+注射器5ml", "塞肛"}

def parse_dt(v):
    for fmt in ("%d/%m/%Y %H:%M:%S", "%d/%m/%Y %H:%M", "%d/%m/%Y"):
        try:
            return datetime.strptime(str(v).strip(), fmt)
        except ValueError:
            continue
    return None

SENTINEL = re.compile(r"^\s*0+[/-]0+[/-]0+.*$")

def daily_dose_at(patient: str, draw_date, drug_substr: str):
    """Sum the active daily dose (mg) for drug_substr on draw_date.

    Returns (lo, hi) — equal when unambiguous. Excludes 出院带药/退药/ONCE
    without a 口服-style way. Orders whose END is the sentinel date count as
    active through the end of the extract window.
    """
    orders = ORDERS[(ORDERS["P"] == patient) & (ORDERS["DRUG_FLAG"] == 1)]
    pat = "|".join(PROJECT_ORDERS.get(drug_substr, [drug_substr]))
    orders = orders[orders["DRUG_NAME"].astype(str).str.contains(pat, regex=True, na=False)]
    orders = orders[~orders["MEDICATION_WAY"].astype(str).isin(["出院带药", "退药"])]
    lo = hi = 0.0
    active_list = []
    for _, r in orders.iterrows():
        way = str(r["MEDICATION_WAY"])
        freq = str(r["FREQUENCY"])
        start = parse_dt(r["START_DATETIME"])
        end_raw = str(r["END_DATETIME"]).strip()
        end = None if SENTINEL.match(end_raw) else parse_dt(end_raw)
        if start is None:
            continue
        if freq == "ONCE":
            # single administration; only counts if 口服-style with a real span
            if way not in ACTIVE_WAYS or end is None:
                continue
            active = start <= draw_date <= end
            mult = (1, 1)
        else:
            active = start <= draw_date and (end is None or draw_date <= end)
            mult = FREQ_MULT.get(freq, (1, 1))
            if isinstance(mult, int):
                mult = (mult, mult)
        if not active:
            continue
        active_list.append((str(r["DRUG_NAME"]), float(r["DOSAGE"]), mult))
    if not active_list:
        return 0.0, 0.0
    # Same DRUG_NAME + distinct schedules (e.g. clozapine 100 mg QD12 + 300 mg
    # QN) is a split regimen: both are dispensed, sum under lo and hi mults.
    # Different DRUG_NAMEs overlapping for the same substance is a possible
    # brand duplication: lo = largest single-brand total, hi = sum of all.
    brands: dict[str, list] = {}
    for name, d, m in active_list:
        brands.setdefault(name, []).append((d, m))
    if len(brands) == 1:
        return sum(d * m[0] for _, d, m in active_list), sum(d * m[1] for _, d, m in active_list)
    lo = max(sum(d * m[0] for d, m in v) for v in brands.values())
    hi = sum(d * m[1] for _, d, m in active_list)
    return lo, hi

def ss_plausible(patient: str, drug_substr: str, draw_date, hl_h: float) -> tuple[bool, str]:
    """Days since the latest dose change (start or end of an order for the drug)
    before draw_date, vs 5 x half-life."""
    orders = ORDERS[(ORDERS["P"] == patient) & (ORDERS["DRUG_FLAG"] == 1)]
    pat = "|".join(PROJECT_ORDERS.get(drug_substr, [drug_substr]))
    orders = orders[orders["DRUG_NAME"].astype(str).str.contains(pat, regex=True, na=False)]
    orders = orders[~orders["MEDICATION_WAY"].astype(str).isin(["出院带药", "退药"])]
    events = []
    for _, r in orders.iterrows():
        start = parse_dt(r["START_DATETIME"])
        end_raw = str(r["END_DATETIME"]).strip()
        end = None if SENTINEL.match(end_raw) else parse_dt(end_raw)
        if start is not None and start <= draw_date:
            events.append(start)
        if end is not None and end <= draw_date:
            events.append(end)
    if not events:
        return False, "no order event before draw"
    last = max(events)
    days = (draw_date - last).total_seconds() / 86400.0
    ok = days >= 5 * hl_h / 24.0
    return ok, f"{days:.1f}d since last change (5x t1/2={5*hl_h/24:.1f}d)"

rows = []
for _, lab in LABS.iterrows():
    p = lab["P"]
    proj = str(lab["PROJECT_NAME"])
    conc = float(lab["TEST_RESULT"])
    draw = parse_dt(lab["TEST_DATE"])
    ref = str(lab["REFFR_SCOPE"])
    lo_r, hi_r = (None, None)
    if re.match(r"^\d+(\.\d+)?\s*-\s*\d+(\.\d+)?$", ref):
        lo_r, hi_r = map(float, ref.split("-"))
    pos = (conc - lo_r) / (hi_r - lo_r) if (lo_r is not None and hi_r > lo_r) else None
    hl = HALF_LIFE_H.get(proj)
    ss, ss_note = ss_plausible(p, proj, draw, hl) if hl else (None, "no half-life table entry")
    dose = daily_dose_at(p, draw, proj)
    cd = None if dose[1] == 0 else (conc / dose[0], conc / dose[1])
    rows.append({
        "patient": p, "draw": draw.strftime("%Y-%m-%d"), "project": proj,
        "concentration": conc, "ref_lo": lo_r, "ref_hi": hi_r,
        "ref_position": round(pos, 3) if pos is not None else None,
        "daily_dose_mg": dose, "cd_range": [round(cd[0], 2), round(cd[1], 2)] if cd else None,
        "steady_state": ss, "ss_note": ss_note,
    })

tbl = pd.DataFrame(rows)
tbl.to_csv("tdm-signal-table.csv", index=False)
print(tbl[["patient", "draw", "project", "concentration", "ref_position",
           "daily_dose_mg", "cd_range", "steady_state"]].to_string())

# metabolite ratio per draw
print("\n=== Dehydro/aripiprazole ratio per draw ===")
for p in PSEUDO.values():
    sub = tbl[(tbl.patient == p) & (tbl.project.isin(["阿立哌唑", "脱氢阿立哌唑"]))]
    if len(sub) < 2:
        continue
    for draw in sub.draw.unique():
        a = sub[(sub.draw == draw) & (sub.project == "阿立哌唑")].concentration
        d = sub[(sub.draw == draw) & (sub.project == "脱氢阿立哌唑")].concentration
        if len(a) and len(d):
            print(f"{p} {draw}: DHA/ARI = {d.iloc[0]/a.iloc[0]:.2f}")

# summary statistics
print("\n=== Spread of C/D (total aripiprazole), per decoding scenario ===")
ari = tbl[tbl.project == "总阿立哌唑"]
for idx, label in [(0, "lo"), (1, "hi")]:
    vals = [r[1][idx] for r in ari[["patient", "cd_range"]].values if isinstance(r[1], list) and r[1][0] > 0]
    if vals:
        vals.sort()
        print(f"scenario {label}: n={len(vals)} min={min(vals):.1f} median={pd.Series(vals).median():.1f} max={max(vals):.1f} spread={max(vals)/min(vals):.1f}x")
print("\nOut-of-range draws (concentration outside REFFR_SCOPE):")
out = tbl[(tbl.ref_lo.notna()) & ((tbl.concentration < tbl.ref_lo) | (tbl.concentration > tbl.ref_hi))]
print(out[["patient", "draw", "project", "concentration", "ref_lo", "ref_hi"]].to_string(index=False))
