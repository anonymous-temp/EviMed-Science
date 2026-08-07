#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tdm_dose_features.py
====================
Builds the aripiprazole dose-prediction feature matrix from a 5-sheet HIS/TDM
extract (病案首页 / 医嘱记录 / 检验 / 诊断记录 / 体征).

Design target: one row per TDM *sampling event* (not per patient), because the
schema supports repeat sampling within an admission and the dose history is
time-resolved via 医嘱记录.START_DATETIME / END_DATETIME.

Three modelling framings are supported off the same matrix:
  A  INVERSE / dose reconstruction : y = prescribed daily dose (mg/d)
  B  FORWARD  / concentration      : y = log(total aripiprazole, ng/mL)
  C  WINDOW   / attainment         : y = in / below / above therapeutic range

Privacy: no direct identifier ever leaves this module. Subjects are relabelled
S1..Sn by ascending PATIENT_ID; the mapping is held in memory only.

Usage:
    python3 tdm_dose_features.py /path/to/extract.xlsx
    python3 tdm_dose_features.py /path/to/extract.xlsx --csv out.csv

Requires: openpyxl, numpy, pandas (scipy/sklearn only for the demo models).
"""

from __future__ import annotations

import argparse
import math
import re
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta

import numpy as np
import openpyxl
import pandas as pd

# ---------------------------------------------------------------------------
# 1. PHARMACOLOGICAL CONSTANTS
# ---------------------------------------------------------------------------

# Aripiprazole terminal half-life, FDA label (ABILIFY USPI, 14.x Clinical Pharm):
# aripiprazole 75 h, dehydro-aripiprazole 94 h, in CYP2D6 extensive metabolisers.
T_HALF_ARI_H = 75.0
T_HALF_DHA_H = 94.0
K_ARI = math.log(2) / T_HALF_ARI_H          # 0.009242 /h
K_DHA = math.log(2) / T_HALF_DHA_H

# Therapeutic reference ranges. Taken from the extract's own REFFR_SCOPE column
# (the lab's registered range), which for parent aripiprazole coincides with the
# AGNP consensus guideline (Hiemke et al., Pharmacopsychiatry 2018;51:9-62).
REF_RANGE = {
    "阿立哌唑": (100.0, 350.0),
    "总阿立哌唑": (150.0, 500.0),
    "奥氮平": (20.0, 80.0),
    "氯氮平": (350.0, 600.0),
    "氯硝西泮": (4.0, 80.0),
    "帕利哌酮（帕潘立酮）": (20.0, 60.0),
}

STEADY_STATE_HALF_LIVES = 5.0               # 5 * 75 h = 375 h = 15.6 d


# ---------------------------------------------------------------------------
# 2. INGREDIENT NORMALISATION
# ---------------------------------------------------------------------------
# Finding from the extract: neither DRUG_NAME nor DRUG_CODE is a stable
# ingredient key.
#   * DRUG_CODE 12310 carries two DRUG_NAMEs ('博思清', '阿立哌唑口崩片(国产)')
#   * DRUG_NAME '阿立哌唑口崩片(国产)' carries two DRUG_CODEs (11757, 12310)
#   * brand-only DRUG_NAMEs hide the ingredient ('博思清', '安律凡', '来士普',
#     '芮达', '安坦片', '德巴金片', '天晴甘平', '川青')
# ORDER_CONTENT is the canonical string: it is always 'generic[brand]'
# (e.g. '阿立哌唑口崩片(国产)[博思清]'). Resolve on ORDER_CONTENT first, then
# fall back to DRUG_NAME.

INGREDIENT_PATTERNS: list[tuple[str, str]] = [
    ("aripiprazole",     r"阿立哌唑|博思清|安律凡"),
    ("olanzapine",       r"奥氮平"),
    ("clozapine",        r"氯氮平"),
    ("quetiapine",       r"喹硫平"),
    ("paliperidone",     r"帕利哌酮|帕潘立酮|芮达"),
    ("risperidone",      r"利培酮|维思通"),
    ("haloperidol",      r"氟哌啶醇"),
    ("chlorpromazine",   r"氯丙嗪"),
    ("sertraline",       r"舍曲林|左洛复"),
    ("escitalopram",     r"艾司西酞普兰|来士普"),
    ("fluoxetine",       r"氟西汀|百忧解"),
    ("paroxetine",       r"帕罗西汀|赛乐特"),
    ("duloxetine",       r"度洛西汀"),
    ("bupropion",        r"安非他酮|乐孚亭"),
    ("venlafaxine",      r"文拉法辛|博乐欣"),
    ("promethazine",     r"异丙嗪|非那根"),
    ("diphenhydramine",  r"苯海拉明"),
    ("propranolol",      r"普萘洛尔|心得安"),
    ("metoprolol",       r"美托洛尔|倍他乐克"),
    ("trihexyphenidyl",  r"苯海索|安坦"),
    ("valproate",        r"丙戊酸|德巴金"),
    ("carbamazepine",    r"卡马西平|得理多"),
    ("oxcarbazepine",    r"奥卡西平|万仪|曲莱"),
    ("lamotrigine",      r"拉莫三嗪"),
    ("phenytoin",        r"苯妥英"),
    ("phenobarbital",    r"苯巴比妥"),
    ("gabapentin",       r"加巴喷丁"),
    ("lithium",          r"碳酸锂"),
    ("lorazepam",        r"劳拉西泮|罗拉"),
    ("clonazepam",       r"氯硝西泮"),
    ("rifampicin",       r"利福平"),
    ("ketoconazole",     r"酮康唑"),
    ("itraconazole",     r"伊曲康唑"),
    ("fluconazole",      r"氟康唑"),
    ("clarithromycin",   r"克拉霉素"),
    ("erythromycin",     r"红霉素"),
    ("diltiazem",        r"地尔硫"),
    ("verapamil",        r"维拉帕米"),
    ("tenofovir",        r"替诺福韦"),
    ("entecavir",        r"恩替卡韦"),
    ("glycyrrhizinate",  r"甘草酸|天晴甘平|复方甘草|异甘草酸"),
    ("ligustrazine",     r"川芎嗪|川青"),
    ("lactulose",        r"乳果糖|杜秘克"),
    ("scopolamine",      r"东莨菪碱"),
]

# Herbal single ingredients with reported CYP modulation (used for the TCM
# co-exposure block; see references in the accompanying analysis).
TCM_CYP3A4_INHIBIT = r"五味子|柚|葡萄柚"           # Schisandra (schisandrin A/B)
TCM_CYP3A4_INDUCE = r"甘草|贯叶连翘|圣约翰"        # glycyrrhizin, hypericum
TCM_ANY_HERB_WAYS = {"煎服", "先煎", "另包", "冲服"}


def ingredient_of(order_content: str | None, drug_name: str | None) -> str | None:
    """Resolve an order row to a single normalised ingredient token."""
    for text in (order_content, drug_name):
        if not text:
            continue
        for token, pattern in INGREDIENT_PATTERNS:
            if re.search(pattern, text):
                return token
    return None


# ---------------------------------------------------------------------------
# 3. CYP INTERACTION DICTIONARY
# ---------------------------------------------------------------------------
# Strength tiers follow the FDA in-vitro/clinical DDI classification and the
# Flockhart Cytochrome P450 Drug Interaction Table (Flockhart DA et al.,
# Indiana University School of Medicine, Division of Clinical Pharmacology).
# Aripiprazole is cleared by CYP2D6 (hydroxylation) and CYP3A4
# (dehydrogenation to dehydro-aripiprazole and N-dealkylation) - ABILIFY USPI.

CYP2D6_INHIBITORS = {
    "paroxetine": "strong", "fluoxetine": "strong", "bupropion": "strong",
    "quinidine": "strong", "duloxetine": "moderate", "terbinafine": "moderate",
    "chlorpromazine": "moderate", "diphenhydramine": "moderate",
    "promethazine": "moderate", "haloperidol": "weak", "sertraline": "weak",
    "escitalopram": "weak", "propranolol": "weak",
}
CYP3A4_INHIBITORS = {
    "ketoconazole": "strong", "itraconazole": "strong",
    "clarithromycin": "strong", "ritonavir": "strong",
    "fluconazole": "moderate", "diltiazem": "moderate",
    "verapamil": "moderate", "erythromycin": "moderate",
}
CYP3A4_INDUCERS = {
    "rifampicin": "strong", "carbamazepine": "strong",
    "phenytoin": "strong", "phenobarbital": "strong",
    "oxcarbazepine": "moderate",
}
STRENGTH_WEIGHT = {"strong": 3.0, "moderate": 2.0, "weak": 1.0}


# ---------------------------------------------------------------------------
# 4. HEPATIC / RENAL COVARIATE CODES
# ---------------------------------------------------------------------------
HEPATIC_ICD = re.compile(r"^(B18|K7[0-6])")          # viral hepatitis, liver disease
HEPATIC_DRUGS = {"tenofovir", "entecavir", "glycyrrhizinate"}


# ---------------------------------------------------------------------------
# 5. LOW-LEVEL PARSING
# ---------------------------------------------------------------------------

def parse_dt(value) -> datetime | None:
    """The extract writes D/M/Y [H:M:S] as text (verified: '18/12/2020')."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    s = str(value).strip()
    for fmt in ("%d/%m/%Y %H:%M:%S", "%d/%m/%Y %H:%M", "%d/%m/%Y"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


SAMPLENO_DATE = re.compile(r"^(\d{8})")


def collection_date(sampleno, test_date, apply_date) -> datetime | None:
    """
    SAMPLENO is 'YYYYMMDD' + assay-code + sequence and encodes the COLLECTION
    date. TEST_DATE is the ANALYSIS date and can lag collection (observed lag
    0 d in 4/5 sample sets, 4 d in one). Collection date must come from
    SAMPLENO; falling back to TEST_DATE silently corrupts time-on-therapy.
    """
    if sampleno:
        m = SAMPLENO_DATE.match(str(sampleno))
        if m:
            try:
                return datetime.strptime(m.group(1), "%Y%m%d")
            except ValueError:
                pass
    return parse_dt(test_date) or parse_dt(apply_date)


FREQ_RE = re.compile(r"^(QD|QN|BID|TID|QID|QOD|Q\d+H)(\d*)$")
FREQ_PER_DAY = {"QD": 1.0, "QN": 1.0, "BID": 2.0, "TID": 3.0, "QID": 4.0, "QOD": 0.5}
FREQ_WEEKLY = re.compile(r"^W(\d)D(\d*)$")       # W4D8 etc: k administrations/week


def doses_per_day(freq: str | None) -> float | None:
    """
    Decode the site's local FREQUENCY vocabulary.

    The trailing integer is an administration-slot code, not a count:
    QD9/QD11/QD12/QD15/QD16/QD20 and BID1/BID4/BID5/BID8 all appear. Decoding
    BIDn as twice daily is externally validated by the TDM values themselves
    (see analysis: paliperidone 6 mg 'BID4' -> 86.4 ng/mL requires 12 mg/d;
    aripiprazole 10 mg 'BID4' -> 372-503 ng/mL total requires 20 mg/d).

    Returns None for ONCE / PRN / ALWAYS, which are not standing daily doses.
    """
    if not freq:
        return None
    f = str(freq).strip().upper()
    if f in ("ONCE", "PRN", "ALWAYS", "ALWAYS1", "ST"):
        return None
    m = FREQ_RE.match(f)
    if m:
        head = m.group(1)
        if head.startswith("Q") and head.endswith("H") and head[1:-1].isdigit():
            return 24.0 / float(head[1:-1])
        return FREQ_PER_DAY.get(head)
    m = FREQ_WEEKLY.match(f)
    if m:                                     # hypothesis; only hits herb orders
        return float(m.group(1)) / 7.0
    return None


# ---------------------------------------------------------------------------
# 6. WORKBOOK LOADING
# ---------------------------------------------------------------------------

def _sheet(wb, name) -> pd.DataFrame:
    rows = list(wb[name].iter_rows(values_only=True))
    hdr = [h if h is not None else f"_unnamed{i}" for i, h in enumerate(rows[0])]
    return pd.DataFrame(rows[1:], columns=hdr)


@dataclass
class Extract:
    face: pd.DataFrame
    orders: pd.DataFrame
    labs: pd.DataFrame
    diagnoses: pd.DataFrame
    vitals: pd.DataFrame
    subject_label: dict = field(default_factory=dict)   # CASE_NO -> 'S1'...

    @classmethod
    def load(cls, path: str) -> "Extract":
        wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
        ex = cls(
            face=_sheet(wb, "病案首页"),
            orders=_sheet(wb, "医嘱记录"),
            labs=_sheet(wb, "检验"),
            diagnoses=_sheet(wb, "诊断记录"),
            vitals=_sheet(wb, "体征"),
        )
        # PATIENT_ID is mixed str/int (zero-padded strings coexist with ints).
        pid = ex.face[["PATIENT_ID", "CASE_NO"]].copy()
        pid["_num"] = pid["PATIENT_ID"].map(lambda v: int(str(v)))
        pid = pid.sort_values("_num").reset_index(drop=True)
        ex.subject_label = {
            row.CASE_NO: f"S{i + 1}" for i, row in enumerate(pid.itertuples())
        }
        return ex


# ---------------------------------------------------------------------------
# 7. DOSE-HISTORY EXPANSION
# ---------------------------------------------------------------------------

@dataclass
class DoseEvent:
    when: datetime
    mg: float


def expand_dose_events(orders: pd.DataFrame, case_no, ingredient: str,
                       horizon_end: datetime) -> list[DoseEvent]:
    """
    Turn overlapping/renewed standing orders into a discrete dose-event series.

    De-duplication rule: two standing orders (LONG_D_NO == 1) of the same
    ingredient whose [START, END) windows overlap are treated as ONE regimen -
    the later-starting order supersedes the earlier from its start time. This
    matters: the extract contains a same-ingredient overlap under two different
    DRUG_NAMEs, and naive summation would double the daily dose.
    """
    sel = []
    for r in orders[orders["CASE_NO"] == case_no].itertuples():
        if ingredient_of(r.ORDER_CONTENT, r.DRUG_NAME) != ingredient:
            continue
        if r.MEDICATION_WAY in ("出院带药", "领药", "退药"):   # take-home / stock moves
            continue
        if r.DOSAGE_UNIT not in ("mg", "g", "ml"):
            continue
        n = doses_per_day(r.FREQUENCY)
        if n is None:
            continue
        start = parse_dt(r.START_DATETIME)
        end = parse_dt(r.END_DATETIME)
        if start is None:
            continue
        mg = float(r.DOSAGE) * (1000.0 if r.DOSAGE_UNIT == "g" else 1.0)
        sel.append({"start": start, "end": end or horizon_end,
                    "mg": mg, "n_per_day": n, "long": r.LONG_D_NO})

    if not sel:
        return []
    sel.sort(key=lambda d: d["start"])
    for i in range(len(sel) - 1):                # supersede on overlap
        if sel[i]["end"] > sel[i + 1]["start"]:
            sel[i]["end"] = sel[i + 1]["start"]

    events: list[DoseEvent] = []
    for seg in sel:
        n = seg["n_per_day"]
        if n <= 0:
            continue
        interval = timedelta(hours=24.0 / n)
        t = seg["start"]
        stop = min(seg["end"], horizon_end)
        guard = 0
        while t < stop and guard < 5000:
            events.append(DoseEvent(t, seg["mg"]))
            t += interval
            guard += 1
    return events


def exposure_index(events: list[DoseEvent], t: datetime, k: float = K_ARI) -> float:
    """
    E(t) = sum_i D_i * exp(-k (t - t_i))   [mg]

    One-compartment superposition with instantaneous input. Absorption is
    ignored deliberately: aripiprazole ka corresponds to Tmax 3-5 h against a
    75 h terminal half-life, so the absorption phase contributes <5% distortion
    outside the first interval. E(t) is the model-based replacement for
    'daily dose', and unlike daily dose it is correct during titration,
    non-steady-state, and washout.
    """
    return sum(d.mg * math.exp(-k * (t - d.when).total_seconds() / 3600.0)
               for d in events if d.when <= t)


def current_daily_dose(orders: pd.DataFrame, case_no, ingredient: str,
                       t: datetime) -> float:
    """Prescribed mg/day in force at time t (the INVERSE model's target)."""
    total = 0.0
    for r in orders[orders["CASE_NO"] == case_no].itertuples():
        if ingredient_of(r.ORDER_CONTENT, r.DRUG_NAME) != ingredient:
            continue
        if r.MEDICATION_WAY in ("出院带药", "领药", "退药"):
            continue
        n = doses_per_day(r.FREQUENCY)
        if n is None or r.DOSAGE_UNIT not in ("mg", "g"):
            continue
        start, end = parse_dt(r.START_DATETIME), parse_dt(r.END_DATETIME)
        if start is None or start > t or (end is not None and end < t):
            continue
        mg = float(r.DOSAGE) * (1000.0 if r.DOSAGE_UNIT == "g" else 1.0)
        total = max(total, mg * n)      # max, not sum: overlaps are renewals
    return total


# ---------------------------------------------------------------------------
# 8. COVARIATE BLOCKS
# ---------------------------------------------------------------------------

def weight_features(vitals: pd.DataFrame, case_no, t: datetime) -> dict:
    rows = []
    for r in vitals[vitals["CASE_NO"] == case_no].itertuples():
        if r.SIGN_TYPE not in ("体重", "身高"):
            continue
        d = parse_dt(r.RECORD_DATE)
        try:
            v = float(r.RECORD_CONTENT)
        except (TypeError, ValueError):
            continue
        if d is not None:
            rows.append((d, r.SIGN_TYPE, v))
    w = sorted({(d, v) for d, s, v in rows if s == "体重"})
    h = [v for d, s, v in rows if s == "身高"]
    out = {"wt_kg": np.nan, "ht_cm": np.nan, "bmi": np.nan,
           "wt_slope_kg_per_wk": np.nan, "wt_n_obs": len(w)}
    if h:
        out["ht_cm"] = float(np.median(h))
    if w:
        nearest = min(w, key=lambda dv: abs((dv[0] - t).total_seconds()))
        out["wt_kg"] = nearest[1]
        if len(w) >= 2:
            x = np.array([(d - w[0][0]).total_seconds() / 86400.0 for d, _ in w])
            y = np.array([v for _, v in w])
            if np.ptp(x) > 0:
                out["wt_slope_kg_per_wk"] = float(np.polyfit(x, y, 1)[0] * 7.0)
        if not math.isnan(out["ht_cm"]) and out["ht_cm"] > 0:
            out["bmi"] = out["wt_kg"] / (out["ht_cm"] / 100.0) ** 2
    return out


def comedication_features(orders: pd.DataFrame, case_no, t: datetime) -> dict:
    """Flags for drugs active in the 7 days before sampling (~2.2 half-lives
    of aripiprazole; long enough to matter, short enough to be attributable)."""
    win_start = t - timedelta(days=7)
    active, herbs, herb_g = set(), set(), 0.0
    for r in orders[orders["CASE_NO"] == case_no].itertuples():
        start, end = parse_dt(r.START_DATETIME), parse_dt(r.END_DATETIME)
        if start is None:
            continue
        end = end or t
        if end < win_start or start > t:
            continue
        ing = ingredient_of(r.ORDER_CONTENT, r.DRUG_NAME)
        if ing:
            active.add(ing)
        if r.DOSAGE_UNIT == "g" or r.MEDICATION_WAY in TCM_ANY_HERB_WAYS:
            name = str(r.DRUG_NAME or "")
            herbs.add(name)
            if r.DOSAGE_UNIT == "g":
                try:
                    herb_g += float(r.DOSAGE) * (doses_per_day(r.FREQUENCY) or 1.0)
                except (TypeError, ValueError):
                    pass

    def score(table):
        return sum(STRENGTH_WEIGHT[table[d]] for d in active if d in table)

    herb_text = " ".join(herbs)
    return {
        "n_comeds": len(active),
        "cyp2d6_inhib_score": score(CYP2D6_INHIBITORS),
        "cyp3a4_inhib_score": score(CYP3A4_INHIBITORS),
        "cyp3a4_induc_score": score(CYP3A4_INDUCERS),
        "any_cyp2d6_inhib": int(any(d in CYP2D6_INHIBITORS for d in active)),
        "n_tcm_herbs": len(herbs),
        "tcm_daily_g": round(herb_g, 1),
        "tcm_cyp3a4_inhib": int(bool(re.search(TCM_CYP3A4_INHIBIT, herb_text))),
        "tcm_cyp3a4_induc": int(bool(re.search(TCM_CYP3A4_INDUCE, herb_text))),
        "comed_antipsychotics": sum(
            d in active for d in
            ("olanzapine", "clozapine", "quetiapine", "paliperidone",
             "risperidone", "haloperidol", "chlorpromazine")),
        "comed_smoking_inducible": int("clozapine" in active or "olanzapine" in active),
        "_active": sorted(active),
    }


def hepatic_features(face: pd.DataFrame, diagnoses: pd.DataFrame,
                     orders: pd.DataFrame, case_no) -> dict:
    codes: set[str] = set()
    f = face[face["CASE_NO"] == case_no]
    for col in ("MAIN_DIAGNOSIS_CODE", "OTHER_DIAGNOSIS_CODE", "OUTP_DIAGNOSIS_CODE"):
        for v in f[col].dropna():
            codes.update(str(v).split("|"))
    for v in diagnoses[diagnoses["CASE_NO"] == case_no]["DIAGNOSIS_CODE"].dropna():
        codes.add(str(v))
    codes = {c.strip() for c in codes if c and str(c).strip()}
    hep_codes = {c for c in codes if HEPATIC_ICD.match(c)}
    hep_drugs = {
        ing for r in orders[orders["CASE_NO"] == case_no].itertuples()
        if (ing := ingredient_of(r.ORDER_CONTENT, r.DRUG_NAME)) in HEPATIC_DRUGS
    }
    icd = {c for c in codes if re.match(r"^[A-Z]\d{2}", c)}
    return {
        "hepatic_dx": int(bool(hep_codes)),
        "hepatoprotectant_or_antiviral": int(bool(hep_drugs)),
        "hepatic_composite": int(bool(hep_codes) or bool(hep_drugs)),
        "dx_schizophrenia": int(any(c.startswith("F2") for c in icd)),
        "dx_bipolar": int(any(c.startswith("F3") for c in icd)),
        "dx_anxiety": int(any(c.startswith("F4") for c in icd)),
        "dx_eps": int(any(c.startswith("G24") for c in icd)),
        "n_icd_codes": len(icd),
        "n_tcm_syndrome_codes": len(codes) - len(icd),
    }


# ---------------------------------------------------------------------------
# 9. FEATURE MATRIX
# ---------------------------------------------------------------------------

ANALYTES = ("阿立哌唑", "脱氢阿立哌唑", "总阿立哌唑")


def build_matrix(ex: Extract) -> pd.DataFrame:
    labs = ex.labs.copy()
    labs["_collect"] = [
        collection_date(s, td, ad) for s, td, ad in
        zip(labs["SAMPLENO"], labs["TEST_DATE"], labs["APPLY_DATE"])
    ]
    horizon = max(d for d in labs["_collect"] if d is not None) + timedelta(days=1)

    rows = []
    keys = labs.groupby(["CASE_NO", "_collect"], dropna=True).groups.keys()
    for case_no, t in sorted(keys, key=lambda kv: (str(kv[0]), kv[1])):
        blk = labs[(labs["CASE_NO"] == case_no) & (labs["_collect"] == t)]
        conc = {}
        for r in blk.itertuples():
            try:
                conc[r.PROJECT_NAME] = float(r.TEST_RESULT)
            except (TypeError, ValueError):
                pass
        if "阿立哌唑" not in conc:
            continue

        parent = conc["阿立哌唑"]
        dha = conc.get("脱氢阿立哌唑", np.nan)
        total = conc.get("总阿立哌唑", parent + (dha if dha == dha else 0.0))

        events = expand_dose_events(ex.orders, case_no, "aripiprazole", horizon)
        past = [d for d in events if d.when <= t]
        E = exposure_index(events, t)
        dose_now = current_daily_dose(ex.orders, case_no, "aripiprazole", t)
        first_dose = min((d.when for d in past), default=None)
        days_on = (t - first_dose).total_seconds() / 86400.0 if first_dose else 0.0
        f_ss = 1.0 - math.exp(-K_ARI * days_on * 24.0) if days_on > 0 else 0.0
        last_dose_h = ((t - max(d.when for d in past)).total_seconds() / 3600.0
                       if past else np.nan)

        face = ex.face[ex.face["CASE_NO"] == case_no]
        sex = int(face["SEX"].iloc[0]) if len(face) else np.nan
        age_raw = str(face["AGE"].iloc[0]) if len(face) else ""
        age = float(re.sub(r"\D", "", age_raw) or "nan")
        admit = parse_dt(face["IN_DATE"].iloc[0]) if len(face) else None

        row = {
            "subject": ex.subject_label.get(case_no, "S?"),
            "sample_seq": None,
            "age_y": age,
            "sex_male": int(sex == 1) if sex == sex else np.nan,
            # --- concentration block (the INVERSE model's features) ---
            "c_parent": parent,
            "c_dha": dha,
            "c_total": total,
            "mr_dha_over_parent": dha / parent if parent else np.nan,
            "log_c_total": math.log(total) if total > 0 else np.nan,
            # --- dose / time block ---
            "dose_mg_per_day": dose_now,
            "exposure_index_mg": E,
            "n_prior_doses": len(past),
            "days_on_therapy": days_on,
            "frac_steady_state": f_ss,
            "at_steady_state": int(days_on >= STEADY_STATE_HALF_LIVES * T_HALF_ARI_H / 24.0),
            "h_since_last_dose": last_dose_h,
            "day_of_admission": ((t - admit).total_seconds() / 86400.0
                                 if admit else np.nan),
            # --- derived PK ---
            "cd_ratio_total": total / dose_now if dose_now else np.nan,
            "cd_ratio_parent": parent / dose_now if dose_now else np.nan,
            "alpha_ng_ml_per_mg_index": total / E if E > 0 else np.nan,
            "cl_f_L_per_h": (K_ARI * 1000.0 / (total / E)) if E > 0 and total > 0 else np.nan,
            # --- window ---
            "in_window_parent": int(REF_RANGE["阿立哌唑"][0] <= parent
                                    <= REF_RANGE["阿立哌唑"][1]),
            "in_window_total": int(REF_RANGE["总阿立哌唑"][0] <= total
                                   <= REF_RANGE["总阿立哌唑"][1]),
            "window_class_parent": ("below" if parent < REF_RANGE["阿立哌唑"][0]
                                    else "above" if parent > REF_RANGE["阿立哌唑"][1]
                                    else "in"),
            "window_class_total": ("below" if total < REF_RANGE["总阿立哌唑"][0]
                                   else "above" if total > REF_RANGE["总阿立哌唑"][1]
                                   else "in"),
            # --- other measured analytes on the same sample ---
            "n_analytes_on_panel": len(conc),
            "co_tdm_clozapine": conc.get("氯氮平", np.nan),
            "co_tdm_olanzapine": conc.get("奥氮平", np.nan),
            "co_tdm_paliperidone": conc.get("帕利哌酮（帕潘立酮）", np.nan),
        }
        row.update(weight_features(ex.vitals, case_no, t))
        cm = comedication_features(ex.orders, case_no, t)
        row["_active_comeds"] = ";".join(cm.pop("_active"))
        row.update(cm)
        row.update(hepatic_features(ex.face, ex.diagnoses, ex.orders, case_no))
        if row["wt_kg"] == row["wt_kg"] and dose_now:
            row["dose_mg_per_kg"] = dose_now / row["wt_kg"]
        else:
            row["dose_mg_per_kg"] = np.nan
        rows.append(row)

    df = pd.DataFrame(rows).sort_values(["subject"]).reset_index(drop=True)
    df["sample_seq"] = df.groupby("subject").cumcount() + 1
    return df


# ---------------------------------------------------------------------------
# 10. MODEL FRAMINGS (demonstration harness)
# ---------------------------------------------------------------------------

FEATURES_INVERSE = [           # framing A: C -> D
    "log_c_total", "mr_dha_over_parent", "frac_steady_state",
    "wt_kg", "age_y", "sex_male", "hepatic_composite",
    "any_cyp2d6_inhib", "tcm_cyp3a4_inhib",
]
FEATURES_FORWARD = [           # framing B: D + covariates -> C
    "dose_mg_per_day", "frac_steady_state", "wt_kg", "age_y", "sex_male",
    "hepatic_composite", "cyp2d6_inhib_score", "tcm_cyp3a4_inhib",
]


def loocv_linear(X: np.ndarray, y: np.ndarray, ridge: float = 1.0):
    """Leave-one-out CV for ridge regression, implemented directly so the
    harness runs with n < p (which it must, on a schema sample)."""
    n = len(y)
    preds = np.empty(n)
    for i in range(n):
        m = np.ones(n, bool)
        m[i] = False
        Xt, yt = X[m], y[m]
        mu, sd = Xt.mean(0), Xt.std(0)
        sd[sd == 0] = 1.0
        Zt = (Xt - mu) / sd
        A = Zt.T @ Zt + ridge * np.eye(Zt.shape[1])
        b = np.linalg.solve(A, Zt.T @ (yt - yt.mean()))
        preds[i] = ((X[i] - mu) / sd) @ b + yt.mean()
    resid = y - preds
    ss_res = float((resid ** 2).sum())
    ss_tot = float(((y - y.mean()) ** 2).sum())
    return {
        "pred": preds,
        "rmse": float(np.sqrt(ss_res / n)),
        "mae": float(np.abs(resid).mean()),
        "q2": 1.0 - ss_res / ss_tot if ss_tot > 0 else np.nan,
    }


def calibrate_alpha(df: pd.DataFrame) -> float:
    """Population F/V surrogate: geometric mean of C_total / E(t) over samples
    with a reconstructable dose history."""
    a = df["alpha_ng_ml_per_mg_index"].dropna()
    a = a[a > 0]
    return float(np.exp(np.log(a).mean())) if len(a) else np.nan


def shape_factor(tau_h: float = 24.0, hours_since_last: float = 12.0,
                 frac_ss: float = 1.0, k: float = K_ARI) -> float:
    """
    Phi = E(t) per 1 mg/day of maintenance dose, for a regimen of interval tau
    sampled `hours_since_last` after the last dose, at accumulation fraction
    frac_ss. Closed form of the superposition sum used by exposure_index().
    """
    d_unit = tau_h / 24.0                      # mg per administration for 1 mg/d
    return d_unit * math.exp(-k * hours_since_last) / (1 - math.exp(-k * tau_h)) * frac_ss


def reconstruct_dose(c_total: float, alpha_hat: float, phi: float) -> float:
    """
    Framing A. D_daily = C / (alpha_hat * Phi).

    alpha_hat is the covariate-predicted individual C-per-unit-exposure
    (ng/mL per mg of exposure index); Phi is the regimen shape factor. When the
    order record is available Phi = E(t)/D_recorded exactly; when the regimen is
    unknown (the clinical dose-reconstruction case) Phi comes from
    shape_factor() under an assumed once-daily steady-state regimen.
    """
    if not (alpha_hat and alpha_hat > 0 and phi and phi > 0):
        return float("nan")
    return c_total / (alpha_hat * phi)


# ---------------------------------------------------------------------------
# 11. SAMPLE SIZE (Riley)
# ---------------------------------------------------------------------------

def riley_continuous(p: int, r2_adj: float, s: float = 0.9) -> float:
    """Riley RD et al., Stat Med 2019;38:1276-96 / BMJ 2020;368:m441, criterion
    (i): n = p / ((S - 1) * ln(1 - R2adj / S))."""
    return p / ((s - 1.0) * math.log(1.0 - r2_adj / s))


def riley_binary(p: int, r2_cs_adj: float, s: float = 0.9) -> float:
    """Same criterion on the Cox-Snell R^2 scale for a binary outcome."""
    return p / ((s - 1.0) * math.log(1.0 - r2_cs_adj / s))


def max_r2_cs(phi: float) -> float:
    """Upper bound on Cox-Snell R^2 at outcome prevalence phi (Riley 2020)."""
    return 1.0 - (phi ** phi * (1.0 - phi) ** (1.0 - phi)) ** 2


# ---------------------------------------------------------------------------
# 12. CLI
# ---------------------------------------------------------------------------

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("workbook")
    ap.add_argument("--csv", help="write the de-identified feature matrix here")
    args = ap.parse_args(argv)

    ex = Extract.load(args.workbook)
    df = build_matrix(ex)

    pd.set_option("display.width", 200, "display.max_columns", 200)
    core = ["subject", "sample_seq", "age_y", "sex_male", "wt_kg", "bmi",
            "dose_mg_per_day", "days_on_therapy", "frac_steady_state",
            "c_parent", "c_dha", "c_total", "mr_dha_over_parent",
            "cd_ratio_total", "alpha_ng_ml_per_mg_index", "cl_f_L_per_h",
            "window_class_parent", "window_class_total"]
    print("=== FEATURE MATRIX (core columns) ===")
    print(df[core].to_string(index=False))
    print(f"\nrows={len(df)}  columns={df.shape[1]}  subjects={df['subject'].nunique()}")

    alpha = calibrate_alpha(df)
    print(f"\npopulation alpha (geometric mean C_total/E) = {alpha:.3f} ng/mL per mg-index")

    print("\n=== FRAMING A: mechanistic dose reconstruction (leave-one-out alpha) ===")
    for r in df.itertuples():
        if r.dose_mg_per_day and r.dose_mg_per_day > 0:
            others = df[df.index != r.Index]
            a = calibrate_alpha(others)
            h = r.h_since_last_dose if r.h_since_last_dose == r.h_since_last_dose else 12.0
            dhat = reconstruct_dose(r.c_total, a, h) * (r.frac_steady_state or 1.0)
            print(f"  {r.subject}#{r.sample_seq}  actual={r.dose_mg_per_day:5.1f} "
                  f"predicted={dhat:6.1f} mg/d   error={dhat - r.dose_mg_per_day:+6.1f}")

    print("\n=== Riley minimum sample sizes ===")
    for p, r2 in ((9, 0.5), (9, 0.3), (15, 0.5), (15, 0.3)):
        print(f"  continuous outcome, p={p:2d} R2adj={r2}: n >= {riley_continuous(p, r2):6.0f}")
    for phi in (0.35, 0.5):
        cap = max_r2_cs(phi)
        print(f"  binary outcome phi={phi}: max Cox-Snell R2 = {cap:.3f}; "
              f"p=9 at 0.15*max -> n >= {riley_binary(9, 0.15 * cap):.0f}")

    if args.csv:
        df.to_csv(args.csv, index=False)
        print(f"\nwrote {args.csv}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
