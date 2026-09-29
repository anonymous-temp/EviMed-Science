"""The scoping-001 synthetic export is deterministic, the right size, synthetic, and
carries exactly the defects its brief grades — each found by measuring the CSVs.

Everything below reads the generated files, never the generator's internals, so
a planted defect counts as present only if a run could find it the same way.
The measured numbers must equal `GROUND_TRUTH` in the generator, and every one
of them must be written in the generator's docstring, which is the grader's
copy.
"""

from __future__ import annotations

import csv
import hashlib
import importlib.util
import re
import statistics
import sys
from collections import Counter, defaultdict
from datetime import date, datetime
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
GENERATOR = HERE / "generate_scoping_001.py"
PROFILER = REPO / "capabilities" / "dataset-research-scoping" / "scripts" / "profile_dataset.py"
TABLES = ("patients.csv", "admissions.csv", "drug_orders.csv", "tdm_results.csv", "labs.csv", "microbiology.csv")

# The secret scanner's subject-label rule (scripts/ops/audit-source-secrets.mjs).
SUBJECT_LABEL = re.compile(r"(?<![/=?&#])\bP\d{6,}\b")
SYNTHETIC_SUBJECT = re.compile(r"^P9\d{5,}$")
TAU_HOURS = {"Q6H": 6, "Q8H": 8, "Q12H": 12, "QD": 24, "Q24H": 24, "Q48H": 48}
NUMERIC = re.compile(r"^\d+(?:\.\d+)?$")
FAR_FUTURE = datetime(9999, 12, 31)


def load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


generator = load("generate_scoping_001", GENERATOR)


@pytest.fixture(scope="module")
def dataset(tmp_path_factory):
    root = tmp_path_factory.mktemp("scoping-001")
    counts = generator.generate(root)
    return root / generator.DATASET_DIR, counts


@pytest.fixture(scope="module")
def measured(dataset):
    return measure(dataset[0])


# --------------------------------------------------------------------------- measurement

def read(directory: Path, name: str):
    with (directory / name).open(encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def parse(value: str):
    """Year-first timestamps with '-' or '/', with or without seconds; the in-hospital sentinel is open."""
    if not value:
        return None
    if value.startswith("9999-12-31"):
        return FAR_FUTURE
    return datetime.fromisoformat(value.replace("/", "-"))


def years_between(born: date, on: date) -> int:
    return on.year - born.year - ((on.month, on.day) < (born.month, born.day))


def ckd_epi_2009(scr_umol: float, age: int, female: bool) -> float:
    scr = scr_umol / 88.4
    kappa, alpha = (0.7, -0.329) if female else (0.9, -0.411)
    value = 141 * min(scr / kappa, 1) ** alpha * max(scr / kappa, 1) ** -1.209 * 0.993 ** age
    return value * (1.018 if female else 1.0)


def order_daily_grams(order: dict) -> float:
    dose = float(order["DOSAGE"]) * (1.0 if order["DOSAGE_UNITS"] == "g" else 0.001)
    return dose * 24 / TAU_HOURS[order["FREQUENCY"]]


def measure(directory: Path) -> dict:
    patients = read(directory, "patients.csv")
    admissions = read(directory, "admissions.csv")
    orders = read(directory, "drug_orders.csv")
    tdm = read(directory, "tdm_results.csv")
    labs = read(directory, "labs.csv")
    micro = read(directory, "microbiology.csv")
    result = {"rows": {name: len(rows) for name, rows in zip(TABLES, (patients, admissions, orders, tdm, labs, micro))}}

    person = {p["PATIENT_ID"]: p for p in patients}
    pid_by_mrn = {p["MED_REC_NO"]: p["PATIENT_ID"] for p in patients}
    admission = {a["INPATIENT_NO"]: a for a in admissions}
    stays = defaultdict(list)
    for a in admissions:
        stays[a["PATIENT_ID"]].append((parse(a["ADMISSION_DATE_TIME"]), parse(a["DISCHARGE_DATE_TIME"]), a["INPATIENT_NO"]))
    long_orders = defaultdict(list)
    for o in orders:
        if o["ORDER_TYPE"] == "长期":
            long_orders[o["INPATIENT_NO"]].append((parse(o["START_DATE_TIME"]), parse(o["STOP_DATE_TIME"]) or FAR_FUTURE, o))

    def stay_of(pid: str, moment: datetime):
        found = [ino for start, stop, ino in stays[pid] if start <= moment <= stop]
        return found

    # D2: the time-conditioned bridge from a concentration to the order in force.
    timed = one_stay = date_ambiguous = 0
    in_force = Counter()
    ratios = []
    for row in tdm:
        if not row["SAMPLING_TIME"]:
            continue
        timed += 1
        sampled = parse(row["SAMPLING_TIME"])
        found = stay_of(pid_by_mrn[row["MED_REC_NO"]], sampled)
        if len(found) != 1:
            continue
        one_stay += 1
        candidates = long_orders[found[0]]
        active = [o for start, stop, o in candidates if start <= sampled < stop]
        in_force["one" if len(active) == 1 else ("none" if not active else "two_or_more")] += 1
        same_day = [o for start, stop, o in candidates if start.date() <= sampled.date() <= stop.date()]
        if len(same_day) >= 2:
            date_ambiguous += 1
        if row["ITEM_NAME"] == "万古霉素谷浓度" and NUMERIC.match(row["RESULT"]) and len(active) == 1:
            ratios.append(float(row["RESULT"]) / order_daily_grams(active[0]))
    q1, median, q3 = statistics.quantiles(ratios, n=4)
    result["d2_bridge"] = {"timed_rows": timed, "one_admission": one_stay, "order_in_force_one": in_force["one"],
                           "order_in_force_none": in_force["none"], "order_in_force_two_or_more": in_force["two_or_more"],
                           "date_join_two_or_more": date_ambiguous}
    result["d2_dose_normalised_trough"] = {"n": len(ratios), "median": round(median, 2), "q1": round(q1, 2),
                                           "q3": round(q3, 2), "min": round(min(ratios), 2), "max": round(max(ratios), 2)}

    # D3: AUC on the concentration rows, MIC only in microbiology; they meet per admission.
    auc_rows = [r for r in tdm if r["AUC24"]]
    auc_stays = set()
    for row in auc_rows:
        moment = parse(row["SAMPLING_TIME"] or row["RECEIVE_TIME"])
        found = stay_of(pid_by_mrn[row["MED_REC_NO"]], moment)
        if len(found) == 1:
            auc_stays.add(found[0])
    mic_rows = [r for r in micro if r["ANTIBIOTIC"] == "万古霉素" and r["MIC"]]
    mic_stays, aureus_stays = set(), set()
    for row in mic_rows:
        ino = row["INPATIENT_NO"]
        if not ino:  # collected before the inpatient number existed: the stay that opens within 12 h
            collected = parse(row["COLLECT_TIME"])
            later = [i for start, _stop, i in stays[row["PATIENT_ID"]] if 0 < (start - collected).total_seconds() <= 12 * 3600]
            ino = later[0] if len(later) == 1 else ""
        if ino:
            mic_stays.add(ino)
            if row["ORGANISM"] == "金黄色葡萄球菌":
                aureus_stays.add(ino)
    methods = Counter(r["AUC_METHOD"] for r in auc_rows)
    result["d3_auc_mic"] = {"auc_rows": len(auc_rows), "auc_bayesian": methods["贝叶斯估算"],
                            "auc_peak_trough": methods["峰谷浓度法"],
                            "auc_on_trough_rows": sum(1 for r in auc_rows if r["ITEM_NAME"] == "万古霉素谷浓度"),
                            "vancomycin_mic_rows": len(mic_rows), "admissions_with_auc": len(auc_stays),
                            "admissions_with_both": len(auc_stays & mic_stays),
                            "admissions_with_both_s_aureus": len(auc_stays & aureus_stays)}

    # I1: order window against admission window.
    held = before = after = 0
    for o in orders:
        a = admission[o["INPATIENT_NO"]]
        start, stop = parse(o["START_DATE_TIME"]), parse(o["STOP_DATE_TIME"])
        admitted, discharged = parse(a["ADMISSION_DATE_TIME"]), parse(a["DISCHARGE_DATE_TIME"])
        if start < admitted:
            before += 1
        elif stop is not None and discharged != FAR_FUTURE and stop > discharged:
            after += 1
        else:
            held += 1
    in_hospital = {a["INPATIENT_NO"] for a in admissions if a["DISCHARGE_DATE_TIME"].startswith("9999")}
    result["i1_order_window"] = {"orders": len(orders), "held": held, "start_before_admission": before,
                                 "stop_after_discharge": after, "in_hospital_admissions": len(in_hospital),
                                 "open_long_term_orders": sum(1 for o in orders if o["ORDER_TYPE"] == "长期"
                                                              and not o["STOP_DATE_TIME"])}

    # I2: creatinine against the reference range printed in its own row.
    creatinine = [r for r in labs if r["ITEM_CODE"] == "CREA"]
    within = above = below = agrees = 0
    for r in creatinine:
        low, high = (float(x) for x in r["REFERENCE_RANGE"].split("-"))
        value = float(r["RESULT"])
        expected = "H" if value > high else ("L" if value < low else "")
        above += expected == "H"
        below += expected == "L"
        within += expected == ""
        agrees += expected == r["ABNORMAL_INDICATOR"]
    result["i2_creatinine"] = {"rows": len(creatinine), "within": within, "above": above, "below": below,
                               "flag_agrees": agrees}

    # I3: AUC24 >= 24 x trough wherever both exist.
    pairs = [r for r in tdm if r["ITEM_NAME"] == "万古霉素谷浓度" and r["AUC24"] and NUMERIC.match(r["RESULT"])]
    ok = sum(1 for r in pairs if float(r["AUC24"]) >= 24 * float(r["RESULT"]))
    result["i3_auc_vs_trough"] = {"rows": len(pairs), "held": ok, "failed": len(pairs) - ok}

    # I4: eGFR against CKD-EPI 2009 from the same specimen's creatinine.
    creatinine_by_test = {r["TEST_NO"]: r for r in creatinine}
    egfr = [r for r in labs if r["ITEM_CODE"] == "EGFR"]
    egfr_ok = 0
    for r in egfr:
        source = creatinine_by_test[r["TEST_NO"]]
        p = person[r["PATIENT_ID"]]
        age = years_between(date.fromisoformat(p["DATE_OF_BIRTH"]), parse(r["COLLECT_TIME"]).date())
        egfr_ok += abs(ckd_epi_2009(float(source["RESULT"]), age, p["SEX"] == "女") - float(r["RESULT"])) <= 0.051
    with_egfr = {r["TEST_NO"] for r in egfr}
    minors = sum(1 for r in creatinine if r["TEST_NO"] not in with_egfr and years_between(
        date.fromisoformat(person[r["PATIENT_ID"]]["DATE_OF_BIRTH"]), parse(r["COLLECT_TIME"]).date()) < 18)
    result["i4_egfr"] = {"rows": len(egfr), "held": egfr_ok, "creatinine_without_egfr": len(creatinine) - len(with_egfr),
                         "creatinine_without_egfr_under_18": minors}

    # I5, I6: length of stay and age are consistent with the dates they derive from.
    discharged = [a for a in admissions if a["DISCHARGE_DATE_TIME"] and not a["DISCHARGE_DATE_TIME"].startswith("9999")]
    los_ok = sum(1 for a in discharged if int(a["IN_DAYS"]) == max(
        1, (parse(a["DISCHARGE_DATE_TIME"]).date() - parse(a["ADMISSION_DATE_TIME"]).date()).days))
    age_ok = sum(1 for a in admissions if int(a["AGE"]) == years_between(
        date.fromisoformat(person[a["PATIENT_ID"]]["DATE_OF_BIRTH"]), parse(a["ADMISSION_DATE_TIME"]).date()))
    result["i5_in_days"] = {"discharged": len(discharged), "held": los_ok}
    result["i6_age"] = {"admissions": len(admissions), "held": age_ok}

    # Background conventions.
    blank_key_labs = [r for r in labs if not r["INPATIENT_NO"]]
    blank_key_micro = [r for r in micro if not r["INPATIENT_NO"]]

    def precedes_a_stay(row):
        collected = parse(row["COLLECT_TIME"])
        return any(0 < (start - collected).total_seconds() <= 12 * 3600 for start, _stop, _ino in stays[row["PATIENT_ID"]])

    weights = Counter(a["WEIGHT_KG"] for a in admissions if not NUMERIC.match(a["WEIGHT_KG"]))
    items = Counter(r["ITEM_NAME"] for r in tdm)
    units_by_era = Counter((r["UNITS"], parse(r["RECEIVE_TIME"]).year >= 2023) for r in tdm)
    start_shapes = Counter((len(o["START_DATE_TIME"]), parse(o["START_DATE_TIME"]).year >= 2023) for o in orders)
    result["conventions"] = {
        "weight_blank": weights[""], "weight_not_measured": weights["未测"], "weight_bedridden": weights["卧床"],
        "height_blank": sum(1 for a in admissions if not a["HEIGHT_CM"]),
        "labs_blank_inpatient_no": len(blank_key_labs), "micro_blank_inpatient_no": len(blank_key_micro),
        "blank_key_rows_preceding_a_stay": sum(1 for r in blank_key_labs + blank_key_micro if precedes_a_stay(r)),
        "tdm_below_quantitation": sum(1 for r in tdm if r["RESULT"].startswith("<")),
        "tdm_not_tested": sum(1 for r in tdm if r["RESULT"] == "未测"),
        "tdm_not_tested_with_remark": sum(1 for r in tdm if r["RESULT"] == "未测" and r["REMARK"]),
        "tdm_sampling_time_blank": sum(1 for r in tdm if not r["SAMPLING_TIME"]),
        "tdm_receive_time_blank": sum(1 for r in tdm if not r["RECEIVE_TIME"]),
        "tdm_units_ug_per_ml_before_2023": units_by_era[("μg/mL", False)],
        "tdm_units_mg_per_l_from_2023": units_by_era[("mg/L", True)],
        "tdm_units_off_era": units_by_era[("μg/mL", True)] + units_by_era[("mg/L", False)],
        "orders_without_seconds_before_2023": start_shapes[(16, False)],
        "orders_with_seconds_from_2023": start_shapes[(19, True)],
        "orders_seconds_off_era": start_shapes[(19, False)] + start_shapes[(16, True)],
        "dosage_in_g": sum(1 for o in orders if o["DOSAGE_UNITS"] == "g"),
        "dosage_in_mg": sum(1 for o in orders if o["DOSAGE_UNITS"] == "mg"),
        "frequency_qd": sum(1 for o in orders if o["FREQUENCY"] == "QD"),
        "frequency_q24h": sum(1 for o in orders if o["FREQUENCY"] == "Q24H"),
        "loading_st_orders": sum(1 for o in orders if o["FREQUENCY"] == "ST" and o["ORDER_TYPE"] == "临时"
                                 and not o["STOP_DATE_TIME"]),
        "admissions_under_18": sum(1 for a in admissions if int(a["AGE"]) < 18),
        "tdm_trough_rows": items["万古霉素谷浓度"], "tdm_peak_rows": items["万古霉素峰浓度"],
        "tdm_untimed_rows": items["万古霉素血药浓度"],
    }
    return result


# --------------------------------------------------------------------------- tests

def test_generation_is_deterministic(dataset, tmp_path):
    directory, _ = dataset
    generator.generate(tmp_path)
    for name in TABLES:
        first = hashlib.sha256((directory / name).read_bytes()).hexdigest()
        second = hashlib.sha256((tmp_path / generator.DATASET_DIR / name).read_bytes()).hexdigest()
        assert first == second, f"{name} differs between two runs"


def test_row_counts_match_the_brief(dataset, measured):
    _, counts = dataset
    rows = measured["rows"]
    assert rows == generator.GROUND_TRUTH["rows"]
    assert {name: counts[name] for name in TABLES} == rows
    # The brief: about 2,300 inpatients and 4,100 concentration tests.
    assert rows["patients.csv"] == 2300
    assert abs(rows["tdm_results.csv"] - 4100) <= 60


def test_d1_dose_normalised_concentration_is_not_a_column(dataset):
    directory, _ = dataset
    tdm_header = set(read(directory, "tdm_results.csv")[0])
    orders_header = set(read(directory, "drug_orders.csv")[0])
    assert not tdm_header & orders_header, "the concentration and order tables must share no column name"
    assert not [c for c in tdm_header if re.search(r"DOS|FREQ|ORDER|PATIENT_ID|INPATIENT", c)]
    assert {"DOSAGE", "DOSAGE_UNITS", "FREQUENCY"} <= orders_header


def test_d2_profiler_reports_the_two_tables_as_unrelated(dataset):
    directory, _ = dataset
    profiler = load("profile_dataset_for_scoping_001", PROFILER)
    profile, values = profiler.profile_tables(sorted(directory / name for name in TABLES))
    profiler.mask_by_value_overlap(profile, values)
    joins = profiler.discover_joins(values)
    pairs = {(j["left"].split(".csv.")[0], j["right"].split(".csv.")[0]) for j in joins}
    assert ("drug_orders", "tdm_results") not in pairs and ("tdm_results", "drug_orders") not in pairs
    by_name = {(j["left"], j["right"]): j for j in joins}
    # The bridge exists, and only through the patient index and the admission register.
    assert by_name[("patients.csv.MED_REC_NO", "tdm_results.csv.MED_REC_NO")]["containment"] == 1.0
    assert by_name[("admissions.csv.INPATIENT_NO", "drug_orders.csv.INPATIENT_NO")]["containment"] == 1.0
    assert by_name[("admissions.csv.PATIENT_ID", "patients.csv.PATIENT_ID")]["containment"] == 1.0
    # Every identifier column is masked by the packaged profiler itself, and nothing else is.
    masked = {(t["name"], c["name"]) for t in profile["tables"] for c in t["columns"] if c["vocabulary"]["identifying"]}
    assert masked == {
        ("patients.csv", "PATIENT_ID"), ("patients.csv", "MED_REC_NO"), ("patients.csv", "DATE_OF_BIRTH"),
        ("admissions.csv", "PATIENT_ID"), ("admissions.csv", "INPATIENT_NO"),
        ("drug_orders.csv", "PATIENT_ID"), ("drug_orders.csv", "INPATIENT_NO"),
        ("tdm_results.csv", "MED_REC_NO"),
        ("labs.csv", "PATIENT_ID"), ("labs.csv", "INPATIENT_NO"),
        ("microbiology.csv", "PATIENT_ID"), ("microbiology.csv", "INPATIENT_NO"),
    }
    # No trap from another brief rides along: no mixed code systems, no type conflicts, no day-first dates.
    assert profiler.find_type_conflicts(profile["tables"]) == []
    for table in profile["tables"]:
        for column in table["columns"]:
            assert not column["codeShapes"].get("mixed"), (table["name"], column["name"])
            assert column["dateAmbiguity"]["ambiguous"] == 0, (table["name"], column["name"])


def test_d2_the_time_join_resolves_the_order_in_force(measured):
    bridge = measured["d2_bridge"]
    assert bridge == generator.GROUND_TRUTH["d2_bridge"]
    assert bridge["one_admission"] == bridge["timed_rows"]
    assert bridge["order_in_force_one"] > 0.9 * bridge["timed_rows"]
    assert bridge["order_in_force_none"] > 0  # levels drawn after an order was stopped
    assert bridge["date_join_two_or_more"] > 0.1 * bridge["timed_rows"]  # a date-only join is ambiguous
    assert measured["d2_dose_normalised_trough"] == generator.GROUND_TRUTH["d2_dose_normalised_trough"]


def test_d3_auc_mic_exists_only_where_two_tables_meet(measured):
    d3 = measured["d3_auc_mic"]
    assert d3 == generator.GROUND_TRUTH["d3_auc_mic"]
    assert d3["auc_on_trough_rows"] == d3["auc_rows"] == d3["auc_bayesian"] + d3["auc_peak_trough"]
    assert 0 < d3["admissions_with_both_s_aureus"] <= d3["admissions_with_both"] < d3["admissions_with_auc"]


def test_identities_hold_and_fail_where_stated(measured):
    for key in ("i1_order_window", "i2_creatinine", "i3_auc_vs_trough", "i4_egfr", "i5_in_days", "i6_age"):
        assert measured[key] == generator.GROUND_TRUTH[key], key
    i1 = measured["i1_order_window"]
    assert i1["start_before_admission"] > 0 and i1["stop_after_discharge"] > 0
    assert i1["held"] + i1["start_before_admission"] + i1["stop_after_discharge"] == i1["orders"]
    assert measured["i2_creatinine"]["flag_agrees"] == measured["i2_creatinine"]["rows"]
    assert measured["i3_auc_vs_trough"]["failed"] > 0
    assert measured["i4_egfr"]["held"] == measured["i4_egfr"]["rows"]
    assert measured["i4_egfr"]["creatinine_without_egfr"] == measured["i4_egfr"]["creatinine_without_egfr_under_18"]
    assert measured["i5_in_days"]["held"] == measured["i5_in_days"]["discharged"]
    assert measured["i6_age"]["held"] == measured["i6_age"]["admissions"]


def test_background_conventions_are_present(dataset, measured):
    conventions = measured["conventions"]
    assert conventions == generator.GROUND_TRUTH["conventions"]
    assert conventions["blank_key_rows_preceding_a_stay"] == (
        conventions["labs_blank_inpatient_no"] + conventions["micro_blank_inpatient_no"])
    assert conventions["tdm_not_tested"] == conventions["tdm_not_tested_with_remark"] > 0
    assert conventions["tdm_units_off_era"] == conventions["orders_seconds_off_era"] == 0
    assert conventions["tdm_receive_time_blank"] == 0
    _, counts = dataset
    assert counts["_mistimed_troughs"] == generator.GROUND_TRUTH["mistimed_troughs"]


def test_ground_truth_is_written_in_the_docstring():
    doc = generator.__doc__
    def walk(value):
        if isinstance(value, dict):
            for item in value.values():
                yield from walk(item)
        else:
            yield value
    missing = []
    for value in walk(generator.GROUND_TRUTH):
        text = f"{value:,}" if isinstance(value, int) else f"{value:.2f}"
        if text not in doc:
            missing.append(text)
    assert not missing, f"docstring lacks {missing}"


def test_identifiers_are_synthetic(dataset):
    directory, _ = dataset
    labels = []
    for path in [directory / name for name in TABLES] + [GENERATOR, Path(__file__)]:
        labels += SUBJECT_LABEL.findall(path.read_text(encoding="utf-8-sig"))
    assert len(labels) > 2300, "the scan found no PATIENT_IDs; the scan, not the data, is wrong"
    assert all(SYNTHETIC_SUBJECT.match(label) for label in labels)
    patients = read(directory, "patients.csv")
    assert all(p["MED_REC_NO"].startswith("9") for p in patients)
    assert all(a["INPATIENT_NO"].startswith("ZY9") for a in read(directory, "admissions.csv"))


def test_no_personal_value_shapes_beyond_date_of_birth(dataset):
    directory, _ = dataset
    profiler = load("profile_dataset_for_scoping_001_shapes", PROFILER)
    shapes = {}
    for name in TABLES:
        rows = read(directory, name)
        for column in rows[0]:
            if profiler.IDENTIFIER_PERSONAL_NAMES.match(column):
                shapes[(name, column)] = "column-name"
            shape = profiler.identifying_value_shape([r[column] for r in rows])
            if shape:
                shapes[(name, column)] = shape
    assert shapes == {("patients.csv", "DATE_OF_BIRTH"): "birth-date"}
