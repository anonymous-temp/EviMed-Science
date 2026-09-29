#!/usr/bin/env python3
"""Synthetic hospital export for eval brief `scoping-001-vancomycin-tdm-extract`.

Serves `evals/dataset-research-scoping/briefs.json`, brief
`scoping-001-vancomycin-tdm-extract` (万古霉素血药浓度监测导出：这批数据能撑起哪些研究).
It writes the six CSVs the brief's `datasetPath` names, in the shape a Chinese
hospital information department hands over: the HIS master index, the
admission register, the inpatient order table filtered to vancomycin, the
pharmacy TDM laboratory's own export, the hospital LIS chemistry/haematology
results, and the microbiology module's culture and susceptibility rows.

Run (stdlib only, fixed seed, byte-identical output on every run, ~2 s):

    python3 generate_scoping_001.py <output-dir>

which writes <output-dir>/data/vanco-tdm-2021-2025/{patients,admissions,
drug_orders,tdm_results,labs,microbiology}.csv (UTF-8 with BOM, CRLF, as an
Excel-minded export tool writes them). The run sees only those CSVs; this file
and its numbers are for the grader.

Entirely synthetic. No names, no phone or identity-card columns. Every
identifier sits in a reserved synthetic range with a leading 9: PATIENT_ID
`P9` + 7 digits, MED_REC_NO `9` + 7 digits, INPATIENT_NO `ZY9` + year + serial.
Every identifying column (PATIENT_ID, MED_REC_NO, INPATIENT_NO, DATE_OF_BIRTH)
carries a name the packaged profiler masks, so an identifier that reaches a
deliverable got there through the run, not through `data-profile.py`.

Row counts: patients 2,300 · admissions 2,488 · drug_orders 4,721 ·
tdm_results 4,112 · labs 79,486 · microbiology 9,047.

Planted defects — exactly the ones the brief's `why` names
--------------------------------------------------------------------------
D1  Dose-normalised concentration is not a column. tdm_results.csv carries the
    concentration and its sampling/receive/report times and nothing about the
    dose: no dose, no frequency, no order reference, no admission key. Daily
    dose exists only in drug_orders.csv (DOSAGE + DOSAGE_UNITS + FREQUENCY).
D2  The concentration table and the order table look unrelated. They share no
    column name at all: tdm_results is keyed by the TDM lab's SAMPLE_NO and
    the patient-level MED_REC_NO (病案号, the number on the TDM request form);
    drug_orders by PATIENT_ID + INPATIENT_NO + ORDER_NO. The packaged
    profiler's inclusion-dependency table therefore has no row pairing them.
    The only path is tdm.MED_REC_NO -> patients (MED_REC_NO -> PATIENT_ID) ->
    the admission whose window contains SAMPLING_TIME -> INPATIENT_NO -> the
    long-term (长期) order with START_DATE_TIME <= sampling < STOP_DATE_TIME.
    Measured on the output, over the 4,044 rows that carry a SAMPLING_TIME:
    all 4,044 fall inside exactly one admission; 3,961 resolve to exactly one
    long-term order in force, 83 to none (82 untimed hold-and-recheck levels
    drawn 16-30 h after the order was stopped, 1 peak drawn after the order's
    last dose), 0 to two or more. Joining on the calendar date instead of the
    time finds two or more long-term orders on 1,315 of those rows — the dose
    was changed on the sampling day, after the result came back.
    Reference C/D under that rule (谷浓度 rows with a numeric result and one
    order in force, 3,568 rows): median 7.84, IQR 4.79-13.40, range
    0.77-89.30 mg/L per g/day.
D3  AUC/MIC is not a column either. AUC24 is filled on 1,149 tdm_results rows
    (贝叶斯估算 1,001, 峰谷浓度法 148; mostly 2023-2025), all 1,149 of them
    谷浓度 rows, across 966 admissions. MIC lives only in microbiology.csv, on
    502 rows with ANTIBIOTIC 万古霉素, keyed by PATIENT_ID + INPATIENT_NO +
    SPECIMEN_NO. AUC/MIC is computable only where both meet in one admission:
    126 admissions, 64 of them with a 金黄色葡萄球菌 vancomycin MIC (a
    blank-key specimen counts for the admission that opens within 12 h).

Identity ground truth (mustDo 4: the counts that held and failed)
--------------------------------------------------------------------------
I1  Order window against admission window, all 4,721 orders: 4,635 held;
    23 START_DATE_TIME before ADMISSION_DATE_TIME (therapy started in the
    emergency department, back-entered on the ward); 63 STOP_DATE_TIME after
    DISCHARGE_DATE_TIME (orders closed at the bedside after the discharge time
    was stamped). The 20 admissions still in hospital at the cutoff carry
    DISCHARGE_DATE_TIME 9999-12-31 00:00:00; 14 long-term orders have no STOP.
I2  Creatinine against the reference range printed in its own row (sex- and
    age-banded, WS/T 404.5 enzymatic: 57-97 / 57-111 male, 41-73 / 41-81
    female): 18,254 creatinine rows; 9,673 within, 7,233 above, 1,348 below;
    ABNORMAL_INDICATOR agrees with the range on all 18,254.
I3  AUC24 against the trough where both exist (AUC24 >= 24 x trough must hold
    at steady state): 1,149 rows; 1,110 held, 39 failed. The failures are
    mostly troughs drawn after the dose had been hung while SAMPLING_TIME
    records the planned pre-dose time; 101 such mis-timed 谷浓度 rows exist
    in all, and their values read like peaks.
I4  eGFR against CKD-EPI 2009 recomputed from the same TEST_NO's creatinine,
    sex and age at collection: 17,935 of 17,935 held. 319 creatinine rows
    carry no eGFR, all 319 of patients under 18.
I5  IN_DAYS against DISCHARGE - ADMISSION date (a same-day stay counts 1):
    2,468 of 2,468 discharged admissions held.
I6  AGE against DATE_OF_BIRTH at admission: 2,488 of 2,488 held.

Background export conventions — not defects; present so the data is not
uniform. Each is measurable and none is graded on its own.
--------------------------------------------------------------------------
- Sentinels: WEIGHT_KG blank on 108, `未测` 63, `卧床` 58 admissions (weights
  heap on 0 and 5); HEIGHT_CM blank on 547; DISCHARGE_DATE_TIME
  `9999-12-31 00:00:00` with IN_DAYS and DISCHARGE_WAY blank on 20.
- A join key that is sometimes empty: labs.INPATIENT_NO is blank on 3,894
  rows and microbiology.INPATIENT_NO on 544 — specimens collected in the
  emergency department before the inpatient number existed. PATIENT_ID is
  always filled, and all 4,438 blank-key rows precede an admission of the
  same patient that opens within 12 h.
- TDM result text: `<3.00` (below the assay's quantitation limit) on 123
  rows; `未测` with a REMARK (标本溶血/标本量不足/标本凝固) on 43, each followed
  by a redraw. SAMPLING_TIME is blank on 68 rows; RECEIVE_TIME is blank on 0.
- Timestamps with and without seconds: tdm SAMPLING_TIME `YYYY/MM/DD HH:MM`
  (typed at the bedside) beside RECEIVE/REPORT `YYYY/MM/DD HH:MM:SS`;
  drug_orders START/STOP without seconds on the 1,516 orders entered before
  the 2023-01-01 HIS upgrade, with seconds on the 3,205 after (0 off-era).
  All dates are year-first; none is day/month ambiguous.
- Units: tdm UNITS `μg/mL` on the 1,401 rows before 2023 and `mg/L` on the
  2,711 from 2023 (same quantity; 0 off-era). DOSAGE in `g` on 3,340 orders
  and in `mg` on 1,381; once daily written `QD` (610) and `Q24H` (278);
  802 loading doses are 临时 `ST` orders with an empty STOP.
- Scope: 47 admissions are of patients aged 14-17 (the population of interest
  is adult). tdm_results holds 3,790 谷浓度, 157 峰浓度 and 165 untimed
  血药浓度 rows (haemodialysis pre-dose levels and hold-and-recheck levels).
"""

from __future__ import annotations

import argparse
import csv
import math
import random
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

SEED = 20210001
N_PATIENTS = 2300
DATASET_DIR = Path("data") / "vanco-tdm-2021-2025"
EXTRACT_CUTOFF = datetime(2025, 12, 31, 23, 59, 59)
LAST_ADMISSION_DAY = date(2025, 12, 28)
HIS_SECONDS_FROM = datetime(2023, 1, 1)
TDM_UNIT_SWITCH = datetime(2023, 1, 1)
IN_HOSPITAL = "9999-12-31 00:00:00"

# What test_generate_scoping_001.py measures on the output; every number is also in the docstring.
GROUND_TRUTH = {
    "rows": {"patients.csv": 2300, "admissions.csv": 2488, "drug_orders.csv": 4721,
             "tdm_results.csv": 4112, "labs.csv": 79486, "microbiology.csv": 9047},
    "d2_bridge": {"timed_rows": 4044, "one_admission": 4044, "order_in_force_one": 3961,
                  "order_in_force_none": 83, "order_in_force_two_or_more": 0, "date_join_two_or_more": 1315},
    "d2_dose_normalised_trough": {"n": 3568, "median": 7.84, "q1": 4.79, "q3": 13.4, "min": 0.77, "max": 89.3},
    "d3_auc_mic": {"auc_rows": 1149, "auc_bayesian": 1001, "auc_peak_trough": 148, "auc_on_trough_rows": 1149,
                   "vancomycin_mic_rows": 502, "admissions_with_auc": 966, "admissions_with_both": 126,
                   "admissions_with_both_s_aureus": 64},
    "i1_order_window": {"orders": 4721, "held": 4635, "start_before_admission": 23, "stop_after_discharge": 63,
                        "in_hospital_admissions": 20, "open_long_term_orders": 14},
    "i2_creatinine": {"rows": 18254, "within": 9673, "above": 7233, "below": 1348, "flag_agrees": 18254},
    "i3_auc_vs_trough": {"rows": 1149, "held": 1110, "failed": 39},
    "i4_egfr": {"rows": 17935, "held": 17935, "creatinine_without_egfr": 319, "creatinine_without_egfr_under_18": 319},
    "i5_in_days": {"discharged": 2468, "held": 2468},
    "i6_age": {"admissions": 2488, "held": 2488},
    "conventions": {
        "weight_blank": 108, "weight_not_measured": 63, "weight_bedridden": 58, "height_blank": 547,
        "labs_blank_inpatient_no": 3894, "micro_blank_inpatient_no": 544, "blank_key_rows_preceding_a_stay": 4438,
        "tdm_below_quantitation": 123, "tdm_not_tested": 43, "tdm_not_tested_with_remark": 43,
        "tdm_sampling_time_blank": 68, "tdm_receive_time_blank": 0,
        "tdm_units_ug_per_ml_before_2023": 1401, "tdm_units_mg_per_l_from_2023": 2711, "tdm_units_off_era": 0,
        "orders_without_seconds_before_2023": 1516, "orders_with_seconds_from_2023": 3205, "orders_seconds_off_era": 0,
        "dosage_in_g": 3340, "dosage_in_mg": 1381, "frequency_qd": 610, "frequency_q24h": 278,
        "loading_st_orders": 802, "admissions_under_18": 47,
        "tdm_trough_rows": 3790, "tdm_peak_rows": 157, "tdm_untimed_rows": 165,
    },
    "mistimed_troughs": 101,
}

# (name, weight, icu, wards, diagnoses as (ICD-10 national clinical code, name))
DEPARTMENTS = (
    ("重症医学科", 22, True, ("综合ICU",), (
        ("A41.900", "脓毒症"), ("R57.200", "脓毒性休克"), ("J18.900", "肺炎"),
        ("J15.200", "葡萄球菌性肺炎"), ("J96.000", "急性呼吸衰竭"))),
    ("神经外科", 12, False, ("神经外科一病区", "神经外科二病区"), (
        ("G00.900", "细菌性脑膜炎"), ("G06.000", "颅内脓肿"), ("S06.500", "创伤性硬脑膜下出血"),
        ("I61.900", "脑出血"), ("T81.400", "手术后感染"))),
    ("呼吸与危重症医学科", 12, False, ("呼吸内科一病区", "呼吸内科二病区"), (
        ("J18.900", "肺炎"), ("J15.200", "葡萄球菌性肺炎"),
        ("J44.100", "慢性阻塞性肺疾病伴急性加重"), ("J85.200", "肺脓肿"))),
    ("骨科", 8, False, ("骨科一病区", "脊柱外科病区"), (
        ("M86.900", "骨髓炎"), ("T84.500", "关节假体感染"), ("M00.000", "葡萄球菌性关节炎"),
        ("L03.100", "四肢蜂窝织炎"))),
    ("血液内科", 8, False, ("血液内科病区",), (
        ("C92.000", "急性髓系白血病"), ("C91.000", "急性淋巴细胞白血病"),
        ("C83.300", "弥漫大B细胞淋巴瘤"), ("D61.900", "再生障碍性贫血"))),
    ("感染性疾病科", 6, False, ("感染科病区",), (
        ("A41.900", "脓毒症"), ("A41.000", "金黄色葡萄球菌性脓毒症"), ("I33.000", "急性感染性心内膜炎"))),
    ("心脏大血管外科", 5, False, ("心外科病区",), (
        ("I33.000", "急性感染性心内膜炎"), ("T82.700", "心血管装置植入物感染"), ("T81.400", "手术后感染"))),
    ("普通外科", 6, False, ("胃肠外科病区", "肝胆外科病区"), (
        ("K65.000", "急性腹膜炎"), ("T81.400", "手术后感染"), ("L02.200", "躯干皮肤脓肿"))),
    ("肾内科", 5, False, ("肾内科病区",), (
        ("N18.500", "慢性肾脏病5期"), ("T82.700", "透析导管相关感染"), ("N39.000", "泌尿道感染"))),
    ("急诊科", 5, True, ("EICU",), (
        ("A41.900", "脓毒症"), ("J18.900", "肺炎"), ("R57.200", "脓毒性休克"))),
    ("神经内科", 4, False, ("神经内科病区",), (("J69.000", "吸入性肺炎"), ("I63.900", "脑梗死"))),
    ("烧伤整形科", 3, False, ("烧伤病区",), (("T31.300", "烧伤面积30%~39%"), ("T79.300", "创伤后伤口感染"))),
    ("老年医学科", 4, False, ("老年医学科病区",), (
        ("J18.900", "肺炎"), ("J69.000", "吸入性肺炎"), ("N39.000", "泌尿道感染"))),
)
DEPT_BY_NAME = {d[0]: d for d in DEPARTMENTS}
WARD_DEPTS = tuple(d[0] for d in DEPARTMENTS if not d[2])
YOUNG_DEPTS = frozenset({"神经外科", "骨科", "烧伤整形科"})
ADMISSION_YEAR_WEIGHTS = ((2021, 17), (2022, 18), (2023, 20), (2024, 22), (2025, 23))

# Frequency -> (dosing interval in hours, clock hours the ward gives it at).
SCHEDULE = {
    "Q6H": (6, (0, 6, 12, 18)),
    "Q8H": (8, (0, 8, 16)),
    "Q12H": (12, (8, 20)),
    "QD": (24, (8,)),
    "Q24H": (24, (8,)),
    "Q48H": (48, (8,)),
}

TROUGH, PEAK, RANDOM = "万古霉素谷浓度", "万古霉素峰浓度", "万古霉素血药浓度"
BAYES_SHARE_BY_YEAR = {2021: 0.03, 2022: 0.08, 2023: 0.28, 2024: 0.42, 2025: 0.50}

# Microbiology. Vancomycin MIC distributions (VITEK 2 steps) by organism group.
VANCO_MIC = {
    "MRSA": (("<=0.5", 30), ("1", 58), ("2", 12)),
    "MSSA": (("<=0.5", 45), ("1", 50), ("2", 5)),
    "CONS": (("<=0.5", 25), ("1", 45), ("2", 25), ("4", 5)),
    "EFM": (("<=0.5", 40), ("1", 40), ("2", 12), ("4", 2), (">=32", 6)),
    "EFA": (("<=0.5", 30), ("1", 55), ("2", 15)),
}
# antibiotic -> (susceptible MIC strings, resistant MIC string)
MIC_STRINGS = {
    "青霉素G": (("<=0.03", "0.06"), ">=0.5"),
    "苯唑西林": (("<=0.25", "0.5"), ">=4"),
    "庆大霉素": (("<=0.5", "1"), ">=16"),
    "左氧氟沙星": (("<=0.12", "0.25", "0.5"), ">=8"),
    "红霉素": (("<=0.25", "0.5"), ">=8"),
    "克林霉素": (("<=0.25",), ">=8"),
    "复方新诺明": (("<=10",), ">=320"),
    "利福平": (("<=0.5",), ">=32"),
    "利奈唑胺": (("1", "2"), ">=8"),
    "替加环素": (("<=0.12", "0.25"), "2"),
    "氨苄西林": (("<=2", "4"), ">=32"),
    "高浓度庆大霉素": (("SYN-S",), "SYN-R"),
    "哌拉西林/他唑巴坦": (("<=4", "8"), ">=128"),
    "头孢他啶": (("<=1", "4"), ">=64"),
    "头孢吡肟": (("<=1", "2"), ">=32"),
    "亚胺培南": (("<=0.25", "1"), ">=16"),
    "美罗培南": (("<=0.25",), ">=16"),
    "阿米卡星": (("<=2", "4"), ">=64"),
}
STAPH_PANEL = ("青霉素G", "苯唑西林", "庆大霉素", "左氧氟沙星", "红霉素", "克林霉素",
               "复方新诺明", "利福平", "利奈唑胺", "替加环素", "万古霉素")
ENTERO_PANEL = ("氨苄西林", "高浓度庆大霉素", "左氧氟沙星", "利奈唑胺", "替加环素", "万古霉素")
GN_PANEL = ("哌拉西林/他唑巴坦", "头孢他啶", "头孢吡肟", "亚胺培南", "美罗培南", "阿米卡星", "左氧氟沙星")
# Share resistant, by organism group and antibiotic (vancomycin is drawn from VANCO_MIC).
RESISTANCE = {
    "MRSA": {"青霉素G": 1.0, "苯唑西林": 1.0, "庆大霉素": 0.3, "左氧氟沙星": 0.6, "红霉素": 0.8,
             "克林霉素": 0.6, "复方新诺明": 0.1, "利福平": 0.08},
    "MSSA": {"青霉素G": 0.9, "庆大霉素": 0.1, "左氧氟沙星": 0.15, "红霉素": 0.5, "克林霉素": 0.3,
             "复方新诺明": 0.05},
    "CONS": {"青霉素G": 0.95, "苯唑西林": 0.8, "庆大霉素": 0.4, "左氧氟沙星": 0.6, "红霉素": 0.8,
             "克林霉素": 0.5, "复方新诺明": 0.4, "利福平": 0.1},
    "EFM": {"氨苄西林": 0.9, "高浓度庆大霉素": 0.6, "左氧氟沙星": 0.9, "利奈唑胺": 0.02},
    "EFA": {"氨苄西林": 0.03, "高浓度庆大霉素": 0.4, "左氧氟沙星": 0.35},
}
GN_ORGANISMS = (("肺炎克雷伯菌", 0.25, 30), ("鲍曼不动杆菌", 0.70, 22), ("铜绿假单胞菌", 0.30, 22),
                ("大肠埃希菌", 0.03, 18), ("阴沟肠杆菌", 0.10, 8))
PATHOGEN_WEIGHTS = (("MRSA", 12), ("MSSA", 5), ("CONS", 9), ("EFM", 5), ("EFA", 3),
                    ("GN", 20), ("FUNGUS", 4), ("NONE", 42))
SPECIMENS_BY_DEPT = {
    "重症医学科": ("血液", "痰", "肺泡灌洗液", "导管尖端"),
    "急诊科": ("血液", "痰"),
    "呼吸与危重症医学科": ("痰", "肺泡灌洗液", "血液", "胸水"),
    "神经外科": ("脑脊液", "血液", "伤口分泌物"),
    "骨科": ("伤口分泌物", "骨组织", "关节液", "血液"),
    "血液内科": ("血液",),
    "感染性疾病科": ("血液", "痰", "尿液"),
    "心脏大血管外科": ("血液", "伤口分泌物"),
    "普通外科": ("腹水", "伤口分泌物", "血液"),
    "肾内科": ("血液", "导管尖端", "尿液"),
    "神经内科": ("痰", "血液", "尿液"),
    "烧伤整形科": ("创面分泌物", "血液"),
    "老年医学科": ("痰", "尿液", "血液"),
}

TDM_HEADER = ("SAMPLE_NO", "MED_REC_NO", "WARD", "BED_NO", "ITEM_NAME", "RESULT", "UNITS",
              "REFERENCE_RANGE", "ABNORMAL_INDICATOR", "SAMPLING_TIME", "RECEIVE_TIME",
              "REPORT_TIME", "AUC24", "AUC_METHOD", "REMARK")
HEADERS = {
    "patients.csv": ("PATIENT_ID", "MED_REC_NO", "SEX", "DATE_OF_BIRTH", "NATION", "CHARGE_TYPE"),
    "admissions.csv": ("INPATIENT_NO", "PATIENT_ID", "ADMISSION_TIMES", "ADMISSION_WAY",
                       "ADMISSION_DATE_TIME", "DISCHARGE_DATE_TIME", "IN_DAYS", "AGE",
                       "DEPT_ADMISSION", "DEPT_DISCHARGE", "WEIGHT_KG", "HEIGHT_CM",
                       "MAIN_DIAG_CODE", "MAIN_DIAG_NAME", "DISCHARGE_WAY"),
    "drug_orders.csv": ("PATIENT_ID", "INPATIENT_NO", "ORDER_NO", "ORDER_TYPE", "DRUG_CODE",
                        "ORDER_TEXT", "DRUG_SPEC", "DOSAGE", "DOSAGE_UNITS", "ADMINISTRATION",
                        "FREQUENCY", "START_DATE_TIME", "STOP_DATE_TIME", "ORDERING_DEPT"),
    "tdm_results.csv": TDM_HEADER,
    "labs.csv": ("TEST_NO", "PATIENT_ID", "INPATIENT_NO", "SPECIMEN", "ITEM_CODE", "ITEM_NAME",
                 "RESULT", "UNITS", "REFERENCE_RANGE", "ABNORMAL_INDICATOR", "COLLECT_TIME",
                 "REPORT_TIME"),
    "microbiology.csv": ("SPECIMEN_NO", "PATIENT_ID", "INPATIENT_NO", "SPECIMEN_TYPE",
                         "COLLECT_TIME", "REPORT_TIME", "ORGANISM", "RESISTANCE_PHENOTYPE",
                         "ANTIBIOTIC", "MIC", "INTERPRETATION"),
}


# --------------------------------------------------------------------------- helpers

def clip(value, low, high):
    return max(low, min(high, value))


def round_to(value, step):
    return step * round(value / step)


def hours(delta: timedelta) -> float:
    return delta.total_seconds() / 3600.0


def pick(rng, weighted):
    items, weights = zip(*weighted)
    return rng.choices(items, weights=weights, k=1)[0]


def minutes(rng, low, high) -> timedelta:
    return timedelta(minutes=rng.randint(low, high))


def seconds_jitter(rng, moment: datetime) -> datetime:
    return moment.replace(second=rng.randint(0, 59), microsecond=0)


def fmt(moment: datetime, sep="-", seconds=True) -> str:
    pattern = f"%Y{sep}%m{sep}%d %H:%M:%S" if seconds else f"%Y{sep}%m{sep}%d %H:%M"
    return moment.strftime(pattern)


def next_clock(moment: datetime, clock_hours) -> datetime:
    base = datetime.combine(moment.date(), datetime.min.time())
    for day in range(4):
        for hour in clock_hours:
            candidate = base + timedelta(days=day, hours=hour)
            if candidate >= moment:
                return candidate
    raise AssertionError("no clock time within four days")


def years_between(born: date, on: date) -> int:
    return on.year - born.year - ((on.month, on.day) < (born.month, born.day))


def infusion_hours(dose_mg: int) -> float:
    return 1.0 if dose_mg <= 1000 else (1.5 if dose_mg <= 1500 else 2.0)


def daily_dose(dose_mg: int, frequency: str) -> float:
    return dose_mg * 24.0 / SCHEDULE[frequency][0]


def once_daily_label(rng) -> str:
    return "QD" if rng.random() < 0.7 else "Q24H"


def ckd_epi_2009(scr_umol: float, age: int, female: bool) -> float:
    scr = scr_umol / 88.4
    kappa, alpha = (0.7, -0.329) if female else (0.9, -0.411)
    value = 141 * min(scr / kappa, 1) ** alpha * max(scr / kappa, 1) ** -1.209 * 0.993 ** age
    return value * (1.018 if female else 1.0)


def creatinine_range(female: bool, age: int):
    if female:
        return (41, 81) if age >= 60 else (41, 73)
    return (57, 111) if age >= 60 else (57, 97)


def urea_range(female: bool, age: int):
    if female:
        return (3.1, 8.8) if age >= 60 else (2.6, 7.5)
    return (3.6, 9.5) if age >= 60 else (3.1, 8.0)


def flag(value: float, low: float, high: float) -> str:
    return "H" if value > high else ("L" if value < low else "")


def trim_number(value: float) -> str:
    text = f"{value:.2f}".rstrip("0").rstrip(".")
    return text or "0"


# --------------------------------------------------------------------------- pharmacokinetics

def scr_at(adm: dict, moment: datetime) -> float:
    """True serum creatinine (μmol/L): baseline, plus an on-therapy AKI episode if one occurs."""
    value = adm["base_scr"]
    aki = adm["aki"]
    if aki and moment > aki["onset"]:
        rise = min(1.0, hours(moment - aki["onset"]) / 60.0)
        if moment > aki["recover_from"]:
            rise *= 0.5 ** (hours(moment - aki["recover_from"]) / 96.0)
        value *= 1 + aki["magnitude"] * rise
    return value


def crcl_at(adm: dict, moment: datetime) -> float:
    scr = scr_at(adm, moment) / 88.4
    crcl = (140 - adm["age"]) * min(adm["weight"], 120) * (0.85 if adm["female"] else 1.0) / (72 * scr)
    return clip(crcl, 5.0, 200.0)


def clearance_at(adm: dict, moment: datetime) -> float:
    """Vancomycin clearance (L/h): Matzke's CrCl relation with between-subject variability."""
    if adm["hd"]:
        return 0.35 * adm["eta_cl"]
    return 0.07 * (0.689 * crcl_at(adm, moment) + 3.66) * adm["eta_cl"]


def concentration(adm: dict, doses, moment: datetime) -> float:
    """One-compartment intermittent-infusion superposition (mg/L) at `moment`."""
    cl = clearance_at(adm, moment)
    k = cl / adm["volume"]
    total = 0.0
    for given, amount, duration in doses:
        elapsed = hours(moment - given)
        if elapsed <= 0:
            continue
        rate = amount / duration
        if elapsed <= duration:
            total += rate / cl * (1 - math.exp(-k * elapsed))
        else:
            total += rate / cl * (1 - math.exp(-k * duration)) * math.exp(-k * (elapsed - duration))
    return total


def dose_schedule(rng, start: datetime, end: datetime, frequency: str, previous_dose):
    tau, clock_hours = SCHEDULE[frequency]
    times = []
    if previous_dose is None:
        first = start + minutes(rng, 20, 75)
        times.append(first)
        cursor = next_clock(first + timedelta(hours=0.6 * tau), clock_hours)
    else:
        cursor = next_clock(max(start, previous_dose + timedelta(hours=0.6 * tau)), clock_hours)
    while cursor < end:
        times.append(cursor)
        cursor += timedelta(hours=tau)
    return [t for t in times if t < end]


def initial_regimen(rng, adm: dict, crcl: float, year: int):
    if adm["hd"]:
        return 500 if rng.random() < 0.55 else 1000, "Q48H"
    weight = adm["weight"]
    if crcl >= 90:
        options = [((1000, "Q12H"), 60), ((1000, "Q8H"), 12 if adm["icu"] else 5), ((500, "Q6H"), 8),
                   ((500, "Q8H"), 9), ((1500, "Q12H"), 5 if weight > 75 else 1)]
        if year >= 2023:
            options.append(((int(clip(round_to(15 * weight, 250), 750, 2000)), "Q12H"), 14))
    elif crcl >= 50:
        options = [((1000, "Q12H"), 55), ((750, "Q12H"), 15), ((500, "Q8H"), 12), ((500, "Q12H"), 10),
                   ((1000, once_daily_label(rng)), 8)]
    elif crcl >= 30:
        options = [((500, "Q12H"), 35), ((1000, once_daily_label(rng)), 35), ((750, "Q12H"), 15),
                   ((750, once_daily_label(rng)), 15)]
    elif crcl >= 15:
        options = [((1000, once_daily_label(rng)), 40), ((500, once_daily_label(rng)), 35),
                   ((500, "Q12H"), 25)]
    else:
        options = [((1000, "Q48H"), 45), ((500, once_daily_label(rng)), 25), ((500, "Q48H"), 30)]
    return pick(rng, options)


def adjusted_regimen(rng, dose: int, frequency: str, level: float, target: float, crcl: float, weight: float):
    tau = SCHEDULE[frequency][0]
    current = dose * 24.0 / tau
    ceiling = max(current, min(1.8 * current, 4000.0, 60.0 * weight))  # wards rarely exceed 4 g/day
    wanted = clip(current * target / max(level, 3.0), 0.4 * current, ceiling)
    new_tau = tau
    if level > 20 and tau == 12 and crcl < 45 and rng.random() < 0.5:
        new_tau = 24
    elif level < 10 and tau == 24 and crcl > 40 and rng.random() < 0.6:
        new_tau = 12
    elif level < 8 and tau == 12 and rng.random() < 0.35:
        new_tau = 8
    per_dose = round_to(wanted * new_tau / 24, 250)
    if per_dose > 1500 and new_tau == 12:
        new_tau = 8
        per_dose = round_to(wanted * 8 / 24, 250)
    per_dose = int(clip(per_dose, 250, 2000))
    if abs(per_dose * 24.0 / new_tau - current) < 1e-6:
        per_dose = int(clip(per_dose + (250 if level < target else -250), 250, 2000))
    label = {6: "Q6H", 8: "Q8H", 12: "Q12H", 24: None, 48: "Q48H"}[new_tau] or once_daily_label(rng)
    return per_dose, label


# --------------------------------------------------------------------------- one admission

def new_admission(rng, patient: dict, admitted: datetime, dept_name: str, times: int) -> dict:
    dept = DEPT_BY_NAME[dept_name]
    icu = dept[2]
    age = years_between(patient["dob"], admitted.date())
    diag_code, diag_name = rng.choice(dept[4])
    hd = diag_code == "N18.500" or (diag_code == "T82.700" and dept_name == "肾内科" and rng.random() < 0.5)
    female = patient["female"]
    if hd:
        base_scr = rng.uniform(450, 950)
    else:
        u = rng.random()
        if age < 50 and dept_name in YOUNG_DEPTS | {"重症医学科", "急诊科"} and u < 0.30:
            base_scr = rng.uniform(30, 48) if female else rng.uniform(38, 60)
        elif u < 0.64:
            base_scr = clip(rng.gauss(59, 11), 38, 85) if female else clip(rng.gauss(78, 14), 50, 110)
        elif u < 0.90:
            base_scr = rng.uniform(110, 240)
        else:
            base_scr = rng.uniform(240, 480)
    if age < 18:
        weight = clip(rng.gauss(52, 9), 35, 85)
    else:
        weight = clip(rng.gauss(57, 10), 35, 110) if female else clip(rng.gauss(67, 11), 40, 125)
    height = clip(rng.gauss(159, 6) if female else rng.gauss(170, 6), 140, 195)
    via_ed = rng.random() < (0.55 if icu or dept_name in ("呼吸与危重症医学科", "感染性疾病科") else 0.2)
    return {
        "patient": patient, "admitted": admitted, "dept": dept_name, "icu": icu, "age": age,
        "female": female, "diag": (diag_code, diag_name), "hd": hd, "base_scr": base_scr,
        "weight": weight, "height": height, "via_ed": via_ed, "times": times,
        "ward": rng.choice(dept[3]), "bed": rng.randint(1, 48),
        "eta_cl": math.exp(rng.gauss(0, 0.25)),
        "volume": (0.9 if hd else 0.72) * weight * math.exp(rng.gauss(0, 0.18)),
        "aki": None, "orders": [], "tdm": [], "labs": [], "micro": [],
    }


def simulate_course(rng, adm: dict) -> bool:
    """Vancomycin course, TDM episodes and dose changes. False if no TDM falls before the cutoff."""
    admitted = adm["admitted"]
    icu = adm["icu"]
    offset_days = rng.expovariate(1 / 0.8) if icu or adm["via_ed"] else rng.expovariate(1 / 2.5)
    start = admitted + timedelta(days=min(offset_days, 20))
    start = start.replace(hour=clip(start.hour, 8, 22), minute=rng.randint(0, 59), second=rng.randint(0, 59), microsecond=0)
    if start < admitted:
        start = admitted + minutes(rng, 30, 180)
    ed_started = adm["via_ed"] and rng.random() < 0.03
    if ed_started:  # given in the emergency department, back-entered on the ward
        start = admitted - minutes(rng, 60, 360)
    year = start.year
    duration = timedelta(days=clip(math.exp(rng.gauss(math.log(9), 0.5)), 3, 42))
    planned_end = start + duration

    committed = []  # doses already given: (time, mg, infusion hours)
    previous_dose = None
    orders = adm["orders"]
    tdm = adm["tdm"]
    weight = adm["weight"]
    loading_share = {2022: 0.18, 2023: 0.28, 2024: 0.35, 2025: 0.40}.get(year, 0.12)
    if rng.random() < loading_share * (1.6 if icu else 1.0):
        ld = int(clip(round_to(25 * weight, 250), 1000, 3000))
        given = start + minutes(rng, 15, 45)
        orders.append({"start": start, "stop": None, "dose": ld, "freq": "ST", "type": "临时"})
        committed.append((given, ld, infusion_hours(ld)))
        previous_dose = given

    crcl0 = crcl_at(adm, start)
    dose, freq = initial_regimen(rng, adm, crcl0, year)
    auc0 = daily_dose(dose, freq) / clearance_at(adm, start)
    if not adm["hd"]:
        logit = -3.4 + 0.0045 * (auc0 - 500) + 0.7 * icu + 0.35 * (adm["age"] >= 65) + 0.4 * (adm["base_scr"] > 110)
        if rng.random() < 1 / (1 + math.exp(-logit)):
            onset = start + timedelta(hours=rng.uniform(60, 200))
            if onset < planned_end:
                # Recovery is placed once the course's real end is known; none happens on therapy.
                adm["aki"] = {"onset": onset, "magnitude": rng.uniform(0.5, 2.0), "recover_from": datetime(2100, 1, 1)}

    order = {"start": start, "stop": None, "dose": dose, "freq": freq, "type": "长期"}
    orders.append(order)
    schedule = dose_schedule(rng, start, planned_end, freq, previous_dose)

    def first_index(frequency):
        tau = SCHEDULE[frequency][0]
        if tau >= 48:
            return 1
        if tau >= 24:
            return 2
        return 3 if rng.random() < 0.6 else 4

    def prefer_morning(sched, index):
        if SCHEDULE[freq][0] > 12 or rng.random() > 0.7:
            return index
        probe = index
        while probe < len(sched) and sched[probe].hour not in (6, 8) and probe - index < 4:
            probe += 1
        return probe if probe < len(sched) else index

    target_index = first_index(freq)
    while len(schedule) <= target_index + 1:  # the course must reach its first level
        planned_end += timedelta(hours=SCHEDULE[freq][0])
        schedule = dose_schedule(rng, start, planned_end, freq, previous_dose)
    target_index = prefer_morning(schedule, target_index)
    therapy_end = planned_end
    episodes = 0
    stopped = False

    def record_level(item, drawn, recorded, doses, reference, allow_mistime=False):
        level = concentration(adm, doses, drawn) * math.exp(rng.gauss(0, 0.06))
        received = seconds_jitter(rng, drawn + minutes(rng, 10, 80))
        reported = seconds_jitter(rng, received + minutes(rng, 60, 300))
        row = {"item": item, "level": level, "recorded": recorded, "received": received,
               "reported": reported, "reference": reference, "not_tested": None, "auc": None,
               "auc_method": "", "mistimed": allow_mistime}
        tdm.append(row)
        return row

    while target_index is not None and episodes < 10:
        if target_index >= len(schedule):
            break
        dose_time = schedule[target_index]
        if dose_time > EXTRACT_CUTOFF:
            break
        episodes += 1
        nominal = dose_time - minutes(rng, 15, 60)
        is_random = adm["hd"]  # haemodialysis: pre-dose levels, logged untimed
        mistimed = (not is_random) and rng.random() < 0.025
        drawn = dose_time + minutes(rng, 18, 70) if mistimed else nominal
        recorded = nominal + timedelta(minutes=rng.randint(-5, 5))
        given = committed + [(t, dose, infusion_hours(dose)) for t in schedule if t < drawn]
        row = record_level(RANDOM if is_random else TROUGH, drawn, recorded, given,
                           None if is_random else (10.0, 20.0), allow_mistime=mistimed)
        if rng.random() < 0.012:
            row["not_tested"] = rng.choice(("标本溶血", "标本量不足", "标本凝固"))
            target_index += 1  # redraw before the next dose
            continue
        tau = SCHEDULE[freq][0]
        if not is_random:
            steady_auc = daily_dose(dose, freq) / clearance_at(adm, drawn)
            if rng.random() < BAYES_SHARE_BY_YEAR.get(dose_time.year, 0.5) and row["level"] >= 3.0:
                row["auc"] = steady_auc * math.exp(rng.gauss(0, 0.12))
                row["auc_method"] = "贝叶斯估算"
            if rng.random() < 0.05 and tau <= 12:
                duration_h = infusion_hours(dose)
                peak_drawn = dose_time + timedelta(hours=duration_h + rng.uniform(0.75, 1.25))
                peak_given = committed + [(t, dose, duration_h) for t in schedule if t < peak_drawn]
                peak = record_level(PEAK, peak_drawn, peak_drawn + timedelta(minutes=rng.randint(-5, 5)),
                                    peak_given, (20.0, 40.0))
                row["peak_reported"] = peak["reported"]
                trough_value = round(row["level"], 2)
                peak_value = round(peak["level"], 2)
                decay_h = tau - duration_h - hours(peak_drawn - dose_time - timedelta(hours=duration_h)) - hours(dose_time - recorded)
                if trough_value >= 3.0 and peak_value > trough_value and decay_h > 0.5:
                    k = math.log(peak_value / trough_value) / decay_h
                    c_max = peak_value * math.exp(k * hours(peak_drawn - dose_time - timedelta(hours=duration_h)))
                    c_min = trough_value * math.exp(-k * hours(dose_time - recorded))
                    auc_tau = duration_h * (c_max + c_min) / 2 + (c_max - c_min) / k
                    row["auc"] = auc_tau * 24 / tau
                    row["auc_method"] = "峰谷浓度法"
        measured = max(row["level"], 3.0)
        decided = seconds_jitter(rng, max(row["reported"], row.get("peak_reported", row["reported"])) + minutes(rng, 30, 240))
        low, high = (15.0, 25.0) if adm["hd"] else (10.0, 20.0)
        target = 20.0 if adm["hd"] else (15.0 if year < 2023 else 13.0)
        crcl = crcl_at(adm, drawn)
        if decided >= therapy_end:
            break
        if measured > (35.0 if adm["hd"] else 30.0) or (adm["aki"] and measured > 25.0 and drawn > adm["aki"]["onset"]):
            # Hold, recheck the next day, then restart lower or stop.
            order["stop"] = decided
            committed += [(t, dose, infusion_hours(dose)) for t in schedule if t < decided]
            previous_dose = committed[-1][0] if committed else None
            recheck = seconds_jitter(rng, decided + timedelta(hours=rng.uniform(16, 30)))
            if recheck > EXTRACT_CUTOFF:
                stopped = True
                therapy_end = decided
                break
            level_row = record_level(RANDOM, recheck, recheck + timedelta(minutes=rng.randint(-5, 5)), committed, None)
            resume = seconds_jitter(rng, level_row["reported"] + minutes(rng, 30, 180))
            if level_row["level"] < high and rng.random() < 0.65 and resume < therapy_end - timedelta(days=1):
                dose, freq = adjusted_regimen(rng, dose, freq, measured, target, crcl, weight)
                order = {"start": resume, "stop": None, "dose": dose, "freq": freq, "type": "长期"}
                orders.append(order)
                schedule = dose_schedule(rng, resume, therapy_end, freq, previous_dose)
                target_index = first_index(freq) if rng.random() < 0.6 else None
                continue
            stopped = True
            therapy_end = decided
            break
        if (measured < low or measured > high) and rng.random() < 0.85:
            order["stop"] = decided
            committed += [(t, dose, infusion_hours(dose)) for t in schedule if t < decided]
            previous_dose = committed[-1][0] if committed else None
            dose, freq = adjusted_regimen(rng, dose, freq, measured, target, crcl, weight)
            order = {"start": decided, "stop": None, "dose": dose, "freq": freq, "type": "长期"}
            orders.append(order)
            schedule = dose_schedule(rng, decided, therapy_end, freq, previous_dose)
            target_index = prefer_morning(schedule, first_index(freq)) if rng.random() < 0.72 else None
            continue
        if therapy_end - drawn > timedelta(days=6) and rng.random() < 0.42:
            wanted = drawn + timedelta(days=rng.uniform(5, 8))
            later = [i for i, t in enumerate(schedule) if t >= wanted]
            target_index = later[0] if later else None
            continue
        target_index = None

    if not stopped:
        order["stop"] = therapy_end
    adm["therapy_end"] = therapy_end
    if adm["aki"]:
        adm["aki"]["recover_from"] = max(adm["aki"]["onset"] + timedelta(hours=60), therapy_end) + timedelta(hours=24)
        if adm["aki"]["onset"] > therapy_end:
            adm["aki"] = None
    adm["vanco_start"] = start
    if not any(row["received"] <= EXTRACT_CUTOFF for row in tdm):
        return False
    adm["last_level"] = max(row["received"] for row in tdm)
    return True


def settle_discharge(rng, adm: dict) -> None:
    therapy_end = max(adm["therapy_end"], adm["last_level"])
    admitted = adm["admitted"]
    died = rng.random() < 0.05 + 0.10 * adm["icu"] + 0.08 * bool(adm["aki"]) + 0.04 * (adm["age"] > 75)
    until_discharge = rng.random() < (0.5 if died else 0.22)
    if until_discharge:
        discharged = therapy_end + minutes(rng, 20, 240)
    else:
        discharged = therapy_end + timedelta(days=0.5 + rng.expovariate(1 / 6))
    discharged = seconds_jitter(rng, max(discharged, admitted + timedelta(days=rng.uniform(2, 5))))
    if not died:
        discharged = discharged.replace(hour=clip(discharged.hour, 8, 17))
        if discharged <= therapy_end:
            discharged = therapy_end + minutes(rng, 20, 240)
    adm["discharged"] = discharged
    adm["way"] = "死亡" if died else pick(rng, (("医嘱离院", 86), ("医嘱转院", 5),
                                               ("医嘱转社区卫生服务机构/乡镇卫生院", 2), ("非医嘱离院", 6), ("其他", 1)))
    adm["late_stop"] = until_discharge and rng.random() < 0.10
    adm["transfer"] = None
    if adm["icu"] and rng.random() < 0.35:
        adm["transfer"] = (admitted + (discharged - admitted) * rng.uniform(0.3, 0.7), rng.choice(WARD_DEPTS))
    elif not adm["icu"] and rng.random() < 0.06:
        adm["transfer"] = (admitted + (discharged - admitted) * rng.uniform(0.2, 0.5), "重症医学科")


def dept_at(adm: dict, moment: datetime) -> str:
    if adm["transfer"] and moment >= adm["transfer"][0]:
        return adm["transfer"][1]
    return adm["dept"]


def simulate_labs(rng, adm: dict) -> None:
    admitted, discharged = adm["admitted"], adm["discharged"]
    end = min(discharged, EXTRACT_CUTOFF)
    draws = []
    if adm["via_ed"]:
        draws.append((seconds_jitter(rng, admitted - minutes(rng, 60, 480)), True))
    else:
        draws.append((seconds_jitter(rng, admitted + minutes(rng, 60, 600)), False))
    day = admitted.date() + timedelta(days=1)
    on_from = adm["vanco_start"] - timedelta(days=1)
    on_to = adm["therapy_end"] + timedelta(days=2)
    while True:
        morning = datetime.combine(day, datetime.min.time()) + timedelta(hours=6) + minutes(rng, -30, 90)
        morning = seconds_jitter(rng, morning)
        if morning > end:
            break
        on_therapy = on_from <= morning <= on_to
        draws.append((morning, False))
        if on_therapy:
            step = rng.choice((1, 2)) if adm["icu"] and dept_at(adm, morning) in ("重症医学科", "急诊科") else rng.choice((2, 3, 3))
        else:
            step = rng.choice((4, 5, 6, 7))
        day += timedelta(days=step)
    female, icu = adm["female"], adm["icu"]
    haem = adm["dept"] == "血液内科"
    for collected, before_admission in draws:
        age = years_between(adm["patient"]["dob"], collected.date())
        scr = round(scr_at(adm, collected) * math.exp(rng.gauss(0, 0.04)), 1)
        chem = []
        low, high = creatinine_range(female, age)
        chem.append(("CREA", "肌酐", f"{scr:.1f}", "μmol/L", f"{low}-{high}", flag(scr, low, high)))
        if age >= 18:
            egfr = round(ckd_epi_2009(scr, age, female), 1)
            chem.append(("EGFR", "估算肾小球滤过率", f"{egfr:.1f}", "mL/min/1.73m²", "", ""))
        urea = round(clip(5.0 * (scr / 75) ** 0.85 * math.exp(rng.gauss(0, 0.2)) * (1.2 if icu else 1.0), 1.0, 60.0), 2)
        u_low, u_high = urea_range(female, age)
        chem.append(("UREA", "尿素", f"{urea:.2f}", "mmol/L", f"{u_low}-{u_high}", flag(urea, u_low, u_high)))
        if rng.random() < 0.4:
            alb = round(clip(rng.gauss(29 if icu else (34 if haem else 33), 5), 15, 50), 1)
            a_low, a_high = (38, 54) if age >= 60 else (40, 55)
            chem.append(("ALB", "白蛋白", f"{alb:.1f}", "g/L", f"{a_low}-{a_high}", flag(alb, a_low, a_high)))
        reported = seconds_jitter(rng, collected + minutes(rng, 90, 240))
        adm["labs"].append({"collected": collected, "reported": reported, "specimen": "血清",
                            "rows": chem, "before_admission": before_admission})
        if rng.random() < 0.65:
            wbc = round(clip(math.exp(rng.gauss(math.log(1.5), 0.9)) if haem else math.exp(rng.gauss(math.log(11), 0.45)), 0.05, 60), 2)
            adm["labs"].append({"collected": collected, "reported": seconds_jitter(rng, collected + minutes(rng, 30, 90)),
                                "specimen": "全血", "before_admission": before_admission,
                                "rows": [("WBC", "白细胞计数", f"{wbc:.2f}", "10^9/L", "3.5-9.5", flag(wbc, 3.5, 9.5))]})
        if rng.random() < (0.5 if icu else 0.22):
            pct = math.exp(rng.gauss(math.log(2.0 if icu else 0.5), 1.3))
            text = "<0.05" if pct < 0.05 else f"{pct:.2f}"
            adm["labs"].append({"collected": collected, "reported": seconds_jitter(rng, collected + minutes(rng, 120, 360)),
                                "specimen": "血清", "before_admission": before_admission,
                                "rows": [("PCT", "降钙素原", text, "ng/mL", "0-0.05", "" if pct < 0.05 else flag(pct, 0, 0.05))]})


def simulate_micro(rng, adm: dict) -> None:
    admitted = adm["admitted"]
    end = min(adm["discharged"], EXTRACT_CUTOFF)
    pathogen = pick(rng, PATHOGEN_WEIGHTS)
    count = pick(rng, ((0, 38), (1, 30), (2, 18), (3, 9), (4, 5)))
    kinds = SPECIMENS_BY_DEPT[adm["dept"]]
    gn = pick(rng, tuple((name, weight) for name, _, weight in GN_ORGANISMS))
    gn_carbapenem_r = dict((name, share) for name, share, _ in GN_ORGANISMS)[gn]
    isolate_profile = None
    for index in range(count):
        if index == 0 and adm["via_ed"] and rng.random() < 0.35:
            collected = seconds_jitter(rng, admitted - minutes(rng, 45, 360))
            kind = "血液"
            before_admission = True
        else:
            collected = seconds_jitter(rng, adm["vanco_start"] + timedelta(hours=rng.uniform(-48, 120)))
            if collected < admitted:
                collected = seconds_jitter(rng, admitted + minutes(rng, 30, 240))
            kind = rng.choice(kinds)
            before_admission = False
        if collected > end:
            continue
        positive = pathogen != "NONE" and rng.random() < (0.45 if kind == "血液" else 0.62)
        rows = []
        if not positive:
            rows.append(("无细菌生长", "", "", "", ""))
            reported = collected + timedelta(hours=rng.uniform(110, 125) if kind == "血液" else rng.uniform(44, 72))
        else:
            if isolate_profile is None:
                isolate_profile = {}
            rows.extend(isolate_rows(rng, pathogen, gn, gn_carbapenem_r, isolate_profile))
            reported = collected + timedelta(hours=rng.uniform(48, 96))
        adm["micro"].append({"collected": collected, "reported": seconds_jitter(rng, reported), "kind": kind,
                             "rows": rows, "before_admission": before_admission})


def isolate_rows(rng, pathogen: str, gn: str, gn_r: float, profile: dict):
    """Rows for one isolate; the same patient's repeat isolates keep one susceptibility profile."""
    if pathogen == "FUNGUS":
        name = profile.setdefault("fungus", rng.choice(("白假丝酵母菌", "近平滑假丝酵母菌", "热带假丝酵母菌")))
        return [(name, "", "", "", "")]
    if pathogen == "GN":
        resistant = profile.setdefault("gn_r", rng.random() < gn_r)
        rows = []
        for abx in GN_PANEL:
            susceptible, r_mic = MIC_STRINGS[abx]
            carbapenem = abx in ("亚胺培南", "美罗培南")
            is_r = resistant if carbapenem else (resistant or rng.random() < 0.3)
            mic = r_mic if is_r else profile.setdefault(abx, rng.choice(susceptible))
            rows.append((gn, "碳青霉烯耐药" if resistant else "", abx, mic, "R" if is_r else "S"))
        return rows
    names = {"MRSA": ("金黄色葡萄球菌",), "MSSA": ("金黄色葡萄球菌",),
             "CONS": ("表皮葡萄球菌", "人葡萄球菌", "溶血葡萄球菌", "头状葡萄球菌"),
             "EFM": ("屎肠球菌",), "EFA": ("粪肠球菌",)}[pathogen]
    organism = profile.setdefault("organism", rng.choice(names))
    panel = ENTERO_PANEL if pathogen in ("EFM", "EFA") else STAPH_PANEL
    vanco = profile.setdefault("vanco", pick(rng, VANCO_MIC[pathogen]))
    phenotype = {"MRSA": "MRSA", "CONS": "MRCNS"}.get(pathogen, "")
    if pathogen == "CONS":
        oxa_r = profile.setdefault("oxa_r", rng.random() < RESISTANCE["CONS"]["苯唑西林"])
        phenotype = "MRCNS" if oxa_r else ""
    if pathogen in ("EFM", "EFA") and vanco == ">=32":
        phenotype = "VRE"
    rows = []
    for abx in panel:
        if abx == "万古霉素":
            mic = vanco
            if pathogen in ("MRSA", "MSSA"):
                interp = "S" if vanco in ("<=0.5", "1", "2") else "I"
            else:
                interp = "R" if vanco == ">=32" else "S"
            rows.append((organism, phenotype, abx, mic, interp))
            continue
        susceptible, r_mic = MIC_STRINGS[abx]
        if abx == "苯唑西林" and pathogen == "CONS":
            is_r = profile["oxa_r"]
        else:
            is_r = profile.setdefault("r:" + abx, rng.random() < RESISTANCE[pathogen].get(abx, 0.0))
        mic = r_mic if is_r else profile.setdefault("s:" + abx, rng.choice(susceptible))
        rows.append((organism, phenotype, abx, mic, "R" if is_r else "S"))
    return rows


# --------------------------------------------------------------------------- the cohort

def build_cohort(rng):
    patient_numbers = rng.sample(range(10 ** 7), N_PATIENTS)
    record_numbers = rng.sample(range(10 ** 7), N_PATIENTS)
    patients, admissions = [], []
    year_span = {year: (date(year, 1, 1), date(year, 12, 31) if year < 2025 else LAST_ADMISSION_DAY)
                 for year, _ in ADMISSION_YEAR_WEIGHTS}
    for index in range(N_PATIENTS):
        female = rng.random() < 0.40
        patient = {"id": f"P9{patient_numbers[index]:07d}", "mrn": f"9{record_numbers[index]:07d}",
                   "female": female, "nation": pick(rng, (("汉族", 93), ("回族", 2.5), ("满族", 2), ("蒙古族", 1),
                                                           ("壮族", 0.5), ("其他", 1))),
                   "charge": pick(rng, (("城镇职工基本医疗保险", 45), ("城乡居民基本医疗保险", 38), ("自费", 10),
                                        ("公费医疗", 4), ("商业保险", 1), ("其他", 2)))}
        dept_name = pick(rng, tuple((d[0], d[1]) for d in DEPARTMENTS))
        if dept_name in YOUNG_DEPTS | {"血液内科"} and rng.random() < 0.05:
            age = rng.randint(14, 17)
        elif dept_name == "老年医学科":
            age = int(clip(rng.gauss(80, 7), 65, 99))
        elif dept_name in YOUNG_DEPTS:
            age = int(clip(rng.gauss(50, 16), 18, 95))
        elif dept_name == "血液内科":
            age = int(clip(rng.gauss(48, 17), 18, 90))
        elif dept_name in ("重症医学科", "呼吸与危重症医学科", "神经内科", "急诊科"):
            age = int(clip(rng.gauss(66, 15), 18, 99))
        else:
            age = int(clip(rng.gauss(60, 15), 18, 97))
        times = 1 + pick(rng, ((0, 55), (1, 20), (2, 10), (3, 6), (4, 4), (5, 3), (7, 1), (10, 1)))
        first = None
        year = pick(rng, ADMISSION_YEAR_WEIGHTS)
        low, high = year_span[year]
        first_day = low + timedelta(days=rng.randint(0, (high - low).days))
        patient["dob"] = first_day - timedelta(days=365 * age + rng.randint(age // 4 + 1, 364 + age // 4))
        for attempt in range(12):
            # Only a course cut off by the extract's end fails; an earlier date is the same patient.
            day = first_day - timedelta(days=14 * attempt)
            admitted = datetime.combine(day, datetime.min.time()) + timedelta(
                hours=rng.randint(0, 23) if rng.random() < 0.5 else rng.randint(8, 17), minutes=rng.randint(0, 59),
                seconds=rng.randint(0, 59))
            candidate = new_admission(rng, patient, admitted, dept_name, times)
            if simulate_course(rng, candidate):
                first = candidate
                break
        if first is None:
            raise AssertionError(f"patient {index} never reached a level before the cutoff")
        settle_discharge(rng, first)
        patients.append(patient)
        admissions.append(first)
        current = first
        for _repeat in range(2):
            if current["way"] == "死亡" or rng.random() >= (0.10 if current is first else 0.15):
                break
            earliest = current["discharged"] + timedelta(days=rng.uniform(15, 700))
            if earliest.date() > LAST_ADMISSION_DAY:
                break
            admitted = seconds_jitter(rng, earliest.replace(hour=rng.randint(8, 20), minute=rng.randint(0, 59)))
            dept_name = current["dept"] if rng.random() < 0.6 else pick(rng, tuple((d[0], d[1]) for d in DEPARTMENTS))
            times += 1 + pick(rng, ((0, 60), (1, 30), (2, 10)))
            candidate = new_admission(rng, patient, admitted, dept_name, times)
            if not simulate_course(rng, candidate):
                break
            settle_discharge(rng, candidate)
            admissions.append(candidate)
            current = candidate
    for adm in admissions:
        simulate_labs(rng, adm)
        simulate_micro(rng, adm)
    return patients, admissions


def assign_serials(rng, items, key, width, prefix_of):
    """Ascending per-day serials with gaps, in time order — as a numbering system hands them out."""
    counters = {}
    for item in sorted(items, key=key):
        stamp = prefix_of(item)
        counters[stamp] = counters.get(stamp, 0) + rng.randint(1, 40)
        item["serial"] = f"{stamp}{counters[stamp]:0{width}d}"


def write_csv(path: Path, header, rows) -> int:
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.writer(handle, lineterminator="\r\n")
        writer.writerow(header)
        count = 0
        for row in rows:
            writer.writerow(row)
            count += 1
    return count


def generate(out_root: Path) -> dict:
    """Write the six CSVs under out_root/data/vanco-tdm-2021-2025 and return their row counts."""
    rng = random.Random(SEED)
    patients, admissions = build_cohort(rng)

    # Inpatient numbers: ascending with admission time, per year, with gaps for everyone else admitted.
    admissions.sort(key=lambda a: (a["admitted"], a["patient"]["id"]))
    per_year = {}
    for adm in admissions:
        yy = adm["admitted"].year % 100
        per_year[yy] = per_year.get(yy, 0) + rng.randint(1, 30)
        adm["inpatient_no"] = f"ZY9{yy:02d}{per_year[yy]:05d}"

    out_dir = out_root / DATASET_DIR
    out_dir.mkdir(parents=True, exist_ok=True)
    counts = {}

    counts["patients.csv"] = write_csv(out_dir / "patients.csv", HEADERS["patients.csv"], (
        (p["id"], p["mrn"], "女" if p["female"] else "男", p["dob"].isoformat(), p["nation"], p["charge"])
        for p in sorted(patients, key=lambda p: p["id"])))

    admission_rows = []
    for adm in admissions:
        discharged = adm["discharged"]
        in_hospital = discharged > EXTRACT_CUTOFF
        weight = adm["weight"]
        u = rng.random()
        missing_scale = 2.0 if adm["icu"] else 1.0
        if u < 0.035 * missing_scale:
            weight_text = ""
        elif u < (0.035 + 0.022) * missing_scale:
            weight_text = "未测"
        elif u < (0.035 + 0.022 + 0.014) * missing_scale:
            weight_text = "卧床"
        else:
            v = rng.random()
            weight_text = (str(int(round_to(weight, 5))) if v < 0.45 else
                           str(int(round(weight))) if v < 0.8 else f"{weight:.1f}")
        height_text = "" if rng.random() < (0.30 if adm["icu"] else 0.18) else str(int(round(adm["height"])))
        adm["dept_discharge"] = adm["transfer"][1] if adm["transfer"] else adm["dept"]
        admission_rows.append((
            adm["inpatient_no"], adm["patient"]["id"], adm["times"],
            "急诊" if adm["via_ed"] else pick(rng, (("门诊", 90), ("其他医疗机构转入", 10))),
            fmt(adm["admitted"]), IN_HOSPITAL if in_hospital else fmt(discharged),
            "" if in_hospital else max(1, (discharged.date() - adm["admitted"].date()).days),
            adm["age"], adm["dept"], adm["dept_discharge"], weight_text, height_text,
            adm["diag"][0], adm["diag"][1], "" if in_hospital else adm["way"]))
    counts["admissions.csv"] = write_csv(out_dir / "admissions.csv", HEADERS["admissions.csv"], admission_rows)

    order_rows = []
    for adm in sorted(admissions, key=lambda a: a["inpatient_no"]):
        number = rng.randint(2, 40)
        orders = sorted(adm["orders"], key=lambda o: (o["start"], o["type"] != "临时"))
        last_long = max((i for i, o in enumerate(orders) if o["type"] == "长期"), key=lambda i: orders[i]["start"])
        for index, order in enumerate(orders):
            start, stop = order["start"], order["stop"]
            if start > EXTRACT_CUTOFF:
                continue
            if index == last_long and adm["late_stop"] and stop is not None and adm["discharged"] <= EXTRACT_CUTOFF:
                stop = adm["discharged"] + minutes(rng, 30, 1080)
            if stop is not None and stop > EXTRACT_CUTOFF:
                stop = None
            seconds = start >= HIS_SECONDS_FROM
            dose = order["dose"]
            in_grams = rng.random() < 0.7
            vial = ("1g", "YP3121") if dose % 1000 == 0 and rng.random() < 0.35 else ("0.5g", "YP3107")
            order_rows.append((
                adm["patient"]["id"], adm["inpatient_no"], number, order["type"], vial[1], "注射用盐酸万古霉素",
                vial[0], trim_number(dose / 1000) if in_grams else str(dose), "g" if in_grams else "mg",
                "静脉滴注", order["freq"], fmt(start, seconds=seconds),
                "" if order["type"] == "临时" or stop is None else fmt(stop, seconds=seconds),
                dept_at(adm, start)))
            number += rng.randint(3, 60)
    counts["drug_orders.csv"] = write_csv(out_dir / "drug_orders.csv", HEADERS["drug_orders.csv"], order_rows)

    tdm_items = []
    for adm in admissions:
        for row in adm["tdm"]:
            if row["received"] > EXTRACT_CUTOFF:
                continue
            row["adm"] = adm
            tdm_items.append(row)
    assign_serials(rng, tdm_items, key=lambda r: (r["received"], r["adm"]["inpatient_no"], r["item"]),
                   width=3, prefix_of=lambda r: "TDM" + r["received"].strftime("%y%m%d"))
    tdm_rows = []
    for row in sorted(tdm_items, key=lambda r: (r["received"], r["serial"])):
        adm = row["adm"]
        level = row["level"]
        if row["not_tested"]:
            result, abnormal, remark = "未测", "", row["not_tested"]
        elif level < 3.0:
            result, abnormal, remark = "<3.00", "L" if row["reference"] else "", ""
        else:
            result, remark = f"{level:.2f}", ""
            abnormal = flag(round(level, 2), *row["reference"]) if row["reference"] else ""
        reference = f"{row['reference'][0]:.1f}-{row['reference'][1]:.1f}" if row["reference"] else ""
        sampled = "" if rng.random() < 0.02 else fmt(row["recorded"], sep="/", seconds=False)
        auc = f"{row['auc']:.1f}" if row["auc"] is not None and not row["not_tested"] else ""
        ward_dept = dept_at(adm, row["received"])
        ward = adm["ward"] if ward_dept == adm["dept"] else DEPT_BY_NAME[ward_dept][3][0]
        bed = f"加{rng.randint(1, 6)}" if rng.random() < 0.03 else str(adm["bed"])
        tdm_rows.append((
            row["serial"], adm["patient"]["mrn"], ward, bed, row["item"], result,
            "μg/mL" if row["received"] < TDM_UNIT_SWITCH else "mg/L", reference, abnormal, sampled,
            fmt(row["received"], sep="/"), fmt(row["reported"], sep="/"), auc,
            row["auc_method"] if auc else "", remark))
    counts["tdm_results.csv"] = write_csv(out_dir / "tdm_results.csv", TDM_HEADER, tdm_rows)

    panels = []
    for adm in admissions:
        for panel in adm["labs"]:
            if panel["collected"] <= EXTRACT_CUTOFF and panel["reported"] <= EXTRACT_CUTOFF:
                panel["adm"] = adm
                panels.append(panel)
    assign_serials(rng, panels, key=lambda p: (p["collected"], p["adm"]["inpatient_no"], p["specimen"], p["rows"][0][0]),
                   width=6, prefix_of=lambda p: p["collected"].strftime("%y%m%d"))
    lab_rows = []
    for panel in sorted(panels, key=lambda p: (p["collected"], p["serial"])):
        adm = panel["adm"]
        for code, name, result, unit, reference, abnormal in panel["rows"]:
            lab_rows.append((panel["serial"], adm["patient"]["id"],
                             "" if panel["before_admission"] else adm["inpatient_no"], panel["specimen"], code, name,
                             result, unit, reference, abnormal, fmt(panel["collected"]), fmt(panel["reported"])))
    counts["labs.csv"] = write_csv(out_dir / "labs.csv", HEADERS["labs.csv"], lab_rows)

    specimens = []
    for adm in admissions:
        for specimen in adm["micro"]:
            if specimen["reported"] <= EXTRACT_CUTOFF:
                specimen["adm"] = adm
                specimens.append(specimen)
    assign_serials(rng, specimens, key=lambda s: (s["collected"], s["adm"]["inpatient_no"], s["kind"]),
                   width=4, prefix_of=lambda s: "WS" + s["collected"].strftime("%y%m%d"))
    micro_rows = []
    for specimen in sorted(specimens, key=lambda s: (s["collected"], s["serial"])):
        adm = specimen["adm"]
        for organism, phenotype, antibiotic, mic, interpretation in specimen["rows"]:
            micro_rows.append((specimen["serial"], adm["patient"]["id"],
                               "" if specimen["before_admission"] else adm["inpatient_no"], specimen["kind"],
                               fmt(specimen["collected"]), fmt(specimen["reported"]), organism, phenotype,
                               antibiotic, mic, interpretation))
    counts["microbiology.csv"] = write_csv(out_dir / "microbiology.csv", HEADERS["microbiology.csv"], micro_rows)

    counts["_mistimed_troughs"] = sum(1 for r in tdm_items if r["mistimed"] and r["item"] == TROUGH)
    return counts


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("output_dir", help="directory to write data/vanco-tdm-2021-2025/*.csv under")
    args = parser.parse_args(argv)
    counts = generate(Path(args.output_dir))
    for name in HEADERS:
        print(f"{DATASET_DIR / name}: {counts[name]} rows")
    return 0


if __name__ == "__main__":
    sys.exit(main())
