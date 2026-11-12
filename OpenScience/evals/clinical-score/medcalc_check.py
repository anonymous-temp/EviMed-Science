"""Check `clinical_score` against the structured rows of MedCalc-Bench (test split), calculator by calculator.

MedCalc-Bench (NCBI, CC BY-SA 4.0) pairs a patient note with the entities its authors extracted from it, the answer their reference
implementation gives and a tolerance band. This script takes the entities as given and asks the tool for the same quantity, so it measures
the arithmetic and the definitions, never the reading of a note (that part is the model's, and is not measured here).

    python3 -I medcalc_check.py --csv <path to test_data.csv> [--json out.json] [--show N]

The data stays outside the repository. A row passes when the tool's value lies inside the row's [lower, upper] band (integers must be equal;
the dataset's own band for decimals is 5 percent). A calculator the tool does not have is reported as `not_in_tool`, a row the tool
refuses (a missing input, a unit it does not accept) as `refused`, never as a miss.
"""
import argparse
import ast
import collections
import csv
import datetime
import json
import os
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
MCP = HERE.parents[1] / "runtime" / "mcp" / "evimed-research"
sys.path.insert(0, str(MCP))
sys.dont_write_bytecode = True
import clinical_score_kit as kit  # noqa: E402
import clinical_scores  # noqa: E402

UNITS = {
    "mm hg": "mmHg", "mmhg": "mmHg", "beats per minute": "/min", "bpm": "/min", "breaths per minute": "/min", "msec": "ms",
    "degrees celsius": "C", "degrees fahrenheit": "F", "µl": "/uL", "mm^3": "/mm3", "µmol/l": "umol/L", "meq/l": "mEq/L", "lbs": "lb",
    "µiu/ml": "uIU/mL", "mcg/kg/min": "mcg/kg/min", "kg/m^2": "kg/m2",
}


def q(entity):
    """An entity [value, unit] as the tool's {value, unit}."""
    value, unit = entity[0], entity[1]
    return {"value": value, "unit": UNITS.get(str(unit).lower(), unit)}


def bare(entity):
    return entity[0] if isinstance(entity, (list, tuple)) else entity


def sex(value):
    return str(value).lower()


def flag(entities, *keys):
    return any(entities.get(key) is True for key in keys)


def get(entities, *names):
    """The first entity whose key matches one of `names` (case-insensitive)."""
    lowered = {key.lower(): key for key in entities}
    for name in names:
        if name.lower() in lowered:
            return entities[lowered[name.lower()]]
    return None


class Skip(Exception):
    """The tool does not have this calculator."""


def call(scale, inputs, version=None, **extra):
    arguments = {"action": "compute", "id": scale, "inputs": inputs, **extra}
    if version:
        arguments["version"] = version
    return clinical_scores.call(arguments)["data"]


def value_of(data):
    return data["result"]["value"]


# --- adapters: entities -> (scale, inputs, version) -------------------------------------------------------------

def a_cg(e, row):
    weight, height, age = get(e, "weight"), get(e, "height"), get(e, "age")
    h_cm = height[0] * (100 if height[1] == "m" else 1)
    bmi = weight[0] / (h_cm / 100) ** 2
    base = {"age": bare(age), "creatinine": q(get(e, "creatinine")), "sex": sex(e["sex"]), "height": {"value": h_cm, "unit": "cm"}, "weight": q(weight)}
    ibw = (50 if sex(e["sex"]) == "male" else 45.5) + 2.3 * max(h_cm / 2.54 - 60, 0)
    # The dataset's rule (stated in its question): adjusted weight when overweight or obese, the lesser of ideal and actual when normal, actual when underweight.
    if bmi >= 25:
        version = "adjusted_weight"
    elif bmi >= 18.5:
        version = "ideal_weight" if ibw < weight[0] else "actual_weight"
    else:
        version = "actual_weight"
    return "cockcroft_gault", base, version


def a_ckd(e, row):
    return "ckd_epi_2021", {"creatinine": q(e["creatinine"]), "age": bare(e["age"]), "sex": sex(e["sex"])}, None


def a_chads(e, row):
    return "cha2ds2_vasc", {"chf": flag(e, "Congestive Heart Failure"), "hypertension": flag(e, "Hypertension history"), "age": bare(e["age"]),
                            "diabetes": flag(e, "Diabetes history"), "stroke_tia_thromboembolism": flag(e, "Stroke", "Thromboembolism history"),
                            "vascular_disease": flag(e, "Vascular disease history"), "sex": sex(e["sex"])}, None


def a_map(e, row):
    return "mean_arterial_pressure", {"systolic": q(e["Systolic Blood Pressure"]), "diastolic": q(e["Diastolic Blood Pressure"])}, None


def hw(e):
    height, weight = get(e, "height"), get(e, "weight")
    return {"weight": q(weight), "height": q(height) if height[1] != "m" else {"value": height[0], "unit": "m"}}


def a_bmi(e, row):
    return "bmi", hw(e), None


def a_wells_pe(e, row):
    return "wells_pe", {"clinical_signs_dvt": flag(e, "Clinical signs and symptoms of Deep Vein Thrombosis"),
                        "pe_most_likely_diagnosis": flag(e, "Pulmonary Embolism is #1 diagnosis OR equally likely"),
                        "heart_rate": q(e["Heart Rate or Pulse"]),
                        "immobilisation_or_surgery": flag(e, "Immobilization for at least 3 days", "Surgery in the previous 4 weeks"),
                        "previous_pe_or_dvt": flag(e, "Previously Documented Pulmonary Embolism", "Previously documented Deep Vein Thrombosis"),
                        "hemoptysis": flag(e, "Hemoptysis"), "malignancy": flag(e, "Malignancy with treatment within 6 months or palliative")}, None


def a_mdrd(e, row):
    return "mdrd", {"creatinine": q(e["creatinine"]), "age": bare(e["age"]), "sex": sex(e["sex"]), "black_race": str(e.get("Race", "")).lower() == "black"}, MDRD_VERSION


MDRD_VERSION = "idms_175"


def a_ibw(e, row):
    height = get(e, "height")
    return "ideal_body_weight", {"height": {"value": height[0], "unit": height[1]}, "sex": sex(e["sex"])}, None


def qtc(version):
    def adapt(e, row):
        return "qtc", {"qt_interval": q(e["QT Interval"]), "heart_rate": q(e["Heart Rate or Pulse"])}, version
    return adapt


def a_childpugh(e, row):
    asc = {"absent": "absent", "slight": "slight", "moderate": "moderate"}[str(e["Ascites"]).lower()]
    enc = "none" if str(e["Encephalopathy"]).lower().startswith("no ") else "grade_1_2"
    return "child_pugh", {"bilirubin": q(e["Bilirubin"]), "albumin": q(e["Albumin"]), "inr": e["international normalized ratio"], "ascites": asc, "encephalopathy": enc}, "inr"


def a_wells_dvt(e, row):
    return "wells_dvt", {
        "active_cancer": flag(e, "Active cancer"),
        "paralysis_or_immobilisation": flag(e, "Paralysis, paresis, or recent plaster immobilization of the lower extremity"),
        "bedridden_or_major_surgery": flag(e, "Bedridden recently >3 days", "Major surgery within 12 weeks"),
        "deep_vein_tenderness": flag(e, "Localized tenderness along the deep venous system"), "entire_leg_swollen": flag(e, "Entire Leg Swollen"),
        "calf_swelling_3cm": flag(e, "Calf swelling >3 centimeters compared to the other leg"),
        "pitting_edema": flag(e, "Pitting edema, confined to symptomatic leg"),
        "collateral_superficial_veins": flag(e, "Collateral (nonvaricose) superficial veins present"),
        "previous_dvt": flag(e, "Previously documented Deep Vein Thrombosis"),
        "alternative_diagnosis_as_likely": flag(e, "Alternative diagnosis to Deep Vein Thrombosis as likely or more likely")}, None


def a_rcri(e, row):
    return "rcri", {"high_risk_surgery": flag(e, "Elevated-risk surgery"), "ischemic_heart_disease": flag(e, "History of ischemic heart disease"),
                    "heart_failure": flag(e, "Congestive Heart Failure criteria for the Cardiac Risk Index rule"),
                    "cerebrovascular_disease": flag(e, "History of cerebrovascular disease"), "insulin_treatment": flag(e, "Pre-operative treatment with insulin"),
                    "creatinine": q(e["Pre-operative creatinine"])}, None


def a_heart(e, row):
    history = {"highly suspicious": "highly_suspicious", "moderately suspicious": "moderately_suspicious", "slightly suspicious": "slightly_suspicious"}[e["Suspicion History"].lower()]
    ecg = {"normal": "normal", "non-specific repolarization disturbance": "nonspecific_repolarisation", "significant st deviation": "significant_st_deviation"}[e.get("Electrocardiogram Test", "Normal").lower()]
    troponin = {"less than or equal to normal limit": 1, "between the normal limit or up to three times the normal limit": 2, "greater than three times normal limit": 4}[e.get("Initial troponin", "less than or equal to normal limit").lower()]
    factors = sum(flag(e, key) for key in ("hypercholesterolemia", "parent or sibling with Cardiovascular disease before age 65", "Hypertension history",
                                             "Diabetes mellitus", "obesity", "smoking"))
    return "heart", {"history": history, "ecg": ecg, "age": bare(e["age"]), "risk_factor_count": factors,
                     "atherosclerotic_disease": flag(e, "atherosclerotic disease", "Transient Ischemic Attacks History"), "troponin": troponin}, "six_2008"


def a_centor(e, row):
    temp = get(e, "Temperature")
    fever = (temp[0] > 38) if "celsius" in temp[1] else (temp[0] > 100.4)
    return "centor_mcisaac", {"tonsillar_exudate": flag(e, "Exudate or swelling on tonsils"), "tender_anterior_cervical_nodes": flag(e, "Tender/swollen anterior cervical lymph nodes"),
                              "fever": fever, "absence_of_cough": e.get("Cough Absent", True), "age": bare(e["age"])}, None


def a_fluids(e, row):
    return "maintenance_fluids", {"weight": q(e["weight"])}, "hourly_4_2_1"


def a_meldna(e, row):
    return "meld_na", {"creatinine": q(e["creatinine"]), "bilirubin": q(e["Bilirubin"]), "inr": e["international normalized ratio"], "sodium": q(e["Sodium"]),
                       "dialysis": flag(e, "Continuous veno-venous hemodialysis for ≥24 hours in the past week", "Dialysis at least twice in the past week")}, "optn_2016"


def a_hasbled(e, row):
    return "has_bled", {"hypertension_uncontrolled": flag(e, "Hypertension"), "abnormal_renal_function": flag(e, "Renal disease criteria for the HAS-BLED rule"),
                        "abnormal_liver_function": flag(e, "Liver disease criteria for the HAS-BLED rule"), "stroke": flag(e, "Stroke"),
                        "bleeding_history_or_predisposition": flag(e, "Prior major bleeding or predisposition to bleeding"),
                        "labile_inr": flag(e, "Labile international normalized ratio"), "age": bare(e["age"]),
                        "antiplatelet_or_nsaid": flag(e, "Medication usage predisposing to bleeding"),
                        "alcohol_excess": (e.get("Number of Alcoholic Drinks Per Week") or 0) >= 8}, None


HYPER_VERSION = "hillier_2_4"      # the dataset's explanation names Hillier 1999 (0.024 per mg/dL)


def a_nahyper(e, row):
    return "sodium_correction_hyperglycemia", {"sodium": q(e["Sodium"]), "glucose": q(e["Glucose"])}, HYPER_VERSION


def a_gbs(e, row):
    return "glasgow_blatchford", {"urea_nitrogen": q(e["Blood Urea Nitrogen (BUN)"]), "hemoglobin": q(e["Hemoglobin"]), "sex": sex(e["sex"]),
                                  "systolic_bp": q(e["Systolic Blood Pressure"]), "heart_rate": q(e["Heart Rate or Pulse"]), "melaena": flag(e, "Melena present"),
                                  "syncope": flag(e, "Recent syncope"), "hepatic_disease": flag(e, "Hepatic disease history"),
                                  "cardiac_failure": flag(e, "Cardiac failure present")}, None


def a_osm(e, row):
    return "serum_osmolality", {"sodium": q(e["Sodium"]), "glucose": q(e["Glucose"]), "urea_nitrogen": q(e["Blood Urea Nitrogen (BUN)"])}, None


def a_charlson(e, row):
    return "charlson", {"myocardial_infarction": flag(e, "Myocardial infarction"), "congestive_heart_failure": flag(e, "Congestive Heart Failure"),
                        "peripheral_vascular_disease": flag(e, "Peripheral vascular disease"),
                        "cerebrovascular_disease": flag(e, "Cerebrovascular Accident", "Transient Ischemic Attacks History"),
                        "dementia": flag(e, "Dementia"), "chronic_pulmonary_disease": flag(e, "Chronic Pulmonary Disease"),
                        "connective_tissue_disease": flag(e, "Connective tissue disease"), "peptic_ulcer_disease": flag(e, "Peptic ulcer disease"),
                        "liver_disease": {"none": "none", "mild": "mild"}.get(str(e.get("Liver disease severity", "none")).lower(), "moderate_to_severe"),
                        "diabetes": {"none or diet-controlled": "none", "uncomplicated": "uncomplicated", "end-organ damage": "end_organ_damage"}[e.get("Diabetes mellitus", "none or diet-controlled")],
                        "hemiplegia": flag(e, "Hemiplegia"), "moderate_to_severe_renal_disease": flag(e, "Moderate to severe Chronic Kidney Disease"),
                        "solid_tumor": e.get("Solid tumor", "none"), "leukemia": flag(e, "Leukemia"), "lymphoma": flag(e, "Lymphoma"), "aids": flag(e, "AIDS"),
                        "age": bare(e["age"])}, "age_adjusted_1994"


def a_feverpain(e, row):
    return "fever_pain", {"fever_last_24h": flag(e, "Fever in past 24 hours"), "purulence": flag(e, "Purulent tonsils"), "attend_rapidly": flag(e, "Symptom onset <=3 days"),
                          "inflamed_tonsils": flag(e, "Severe tonsil inflammation"), "no_cough_or_coryza": e.get("Absence of cough or coryza", True)}, None


def a_fwd(e, row):
    age, s = bare(e["age"]), sex(e["sex"])
    population = "child" if age < 18 else ("elderly_" if age > 64 else "adult_") + s
    return "free_water_deficit", {"weight": q(e["weight"]), "sodium": q(e["Sodium"]), "population": population}, None


def electrolytes(e):
    return {"sodium": q(e["Sodium"]), "chloride": q(e["Chloride"]), "bicarbonate": q(e["Bicarbonate"])}


def a_ag(e, row):
    return "anion_gap", electrolytes(e), None


def a_curb(e, row):
    return "curb_65", {"confusion": flag(e, "Confusion"), "urea_nitrogen": q(e["Blood Urea Nitrogen (BUN)"]), "respiratory_rate": q(e["respiratory rate"]),
                       "systolic_bp": q(e["Systolic Blood Pressure"]), "diastolic_bp": q(e["Diastolic Blood Pressure"]), "age": bare(e["age"])}, None


def a_fena(e, row):
    return "fena", {"urine_sodium": q(e["Urine sodium"]), "plasma_sodium": q(e["Sodium"]), "urine_creatinine": q(e["Urine creatinine"]),
                    "plasma_creatinine": q(e["creatinine"])}, None


def a_ldl(e, row):
    return "ldl_friedewald", {"total_cholesterol": q(e["Total cholesterol"]), "hdl_cholesterol": q(e["high-density lipoprotein cholesterol"]), "triglycerides": q(e["Triglycerides"])}, None


def a_fram(e, row):
    return "framingham_hard_chd", {"sex": sex(e["sex"]), "age": bare(e["age"]), "total_cholesterol": q(e["Total cholesterol"]),
                                   "hdl_cholesterol": q(e["high-density lipoprotein cholesterol"]), "systolic_bp": q(e["Systolic Blood Pressure"]),
                                   "bp_treated": flag(e, "Blood pressure being treated with medicines"), "smoker": flag(e, "Smoker")}, "atp_iii_regression"


def a_perc(e, row):
    return "perc", {"age": bare(e["age"]), "heart_rate": q(e["Heart Rate or Pulse"]), "oxygen_saturation": q(e["O₂ saturation percentage"]),
                    "unilateral_leg_swelling": flag(e, "Unilateral Leg Swelling"), "hemoptysis": flag(e, "Hemoptysis"),
                    "recent_surgery_or_trauma": flag(e, "Recent surgery or trauma"),
                    "previous_pe_or_dvt": flag(e, "Previously Documented Pulmonary Embolism", "Previously documented Deep Vein Thrombosis"),
                    "hormone_use": flag(e, "Hormone use")}, None


def wbc(entity):
    value, unit = entity
    if unit == "L":          # cells per litre -> per uL
        return {"value": value / 1e6, "unit": "/uL"}
    if unit == "mL":
        return {"value": value / 1e3, "unit": "/uL"}
    return q(entity)


def a_sirs(e, row):
    inputs = {"temperature": q(e["Temperature"]), "heart_rate": q(e["Heart Rate or Pulse"]), "respiratory_rate": q(e["respiratory rate"]), "wbc": wbc(e["White blood cell count"])}
    if "PaCO2" in e:
        inputs["paco2"] = q(e["PaCO2"])
    return "sirs", inputs, None


def a_psi(e, row):
    inputs = {"age": bare(e["age"]), "sex": sex(e["sex"]), "nursing_home_resident": flag(e, "Nursing home resident"), "neoplastic_disease": flag(e, "Neoplastic disease"),
              "liver_disease": flag(e, "Liver disease history"), "congestive_heart_failure": flag(e, "Congestive Heart Failure"),
              "cerebrovascular_disease": flag(e, "Cerebrovascular disease history"), "renal_disease": flag(e, "Renal disease history"),
              "altered_mental_status": flag(e, "Altered mental status"), "respiratory_rate": q(e["respiratory rate"]), "systolic_bp": q(e["Systolic Blood Pressure"]),
              "temperature": q(e["Temperature"]), "heart_rate": q(e["Heart Rate or Pulse"]), "arterial_ph": e["pH"], "urea_nitrogen": q(e["Blood Urea Nitrogen (BUN)"]),
              "sodium": q(e["Sodium"]), "glucose": q(e["Glucose"]), "hematocrit": q(e["Hematocrit"]), "pao2": q(e["Partial pressure of oxygen"]),
              "pleural_effusion": flag(e, "Pleural effusion on x-ray")}
    return "psi_port", inputs, None


GCS_EYE = {"eyes open spontaneously": 4, "eye opening to verbal command": 3, "eye opening to pain": 2, "no eye opening": 1}
GCS_VERBAL = {"oriented": 5, "confused": 4, "inappropriate words": 3, "incomprehensible sounds": 2, "no verbal response": 1}
GCS_MOTOR = {"obeys commands": 6, "localizes pain": 5, "withdrawal from pain": 4, "flexion to pain": 3, "extension to pain": 2, "no motor response": 1}


def a_gcs(e, row):
    return "gcs", {"eye": GCS_EYE[e["Best eye response"].lower()], "verbal": GCS_VERBAL[e["Best verbal response"].lower()], "motor": GCS_MOTOR[e["Best motor response"].lower()]}, None


def a_apache(e, row):
    fio2 = e["FiO2"]
    inputs = {"temperature": q(e["Temperature"]), "heart_rate": q(e["Heart Rate or Pulse"]), "respiratory_rate": q(e["respiratory rate"]),
              "fio2": {"value": fio2[0], "unit": "%"}, "arterial_ph": e["pH"], "sodium": q(e["Sodium"]), "potassium": q(e["Potassium"]), "creatinine": q(e["creatinine"]),
              "acute_renal_failure": flag(e, "Acute renal failure"), "hematocrit": q(e["Hematocrit"]), "wbc": wbc(e["White blood cell count"]),
              "glasgow_coma_scale": e["Glasgow Coma Score"], "age": bare(e["age"]),
              "severe_organ_insufficiency_or_immunocompromised": flag(e, "History of severe organ failure or immunocompromise"),
              "admission_type": {"elective": "elective_postoperative", "emergency": "emergency_postoperative", "nonoperative": "non_operative"}[e.get("Surgery Type", "Nonoperative").lower()]}
    if "Mean arterial pressure" in e:
        mean = e["Mean arterial pressure"]
        inputs["mean_arterial_pressure"] = {"value": float(str(mean[0] if isinstance(mean, list) else mean).split()[0]), "unit": "mmHg"}
    else:
        s, d = e["Systolic Blood Pressure"][0], e["Diastolic Blood Pressure"][0]
        inputs["mean_arterial_pressure"] = {"value": round((s + 2 * d) / 3, 6), "unit": "mmHg"}
    if "PaO2" in e:
        inputs["pao2"] = q(e["PaO2"])
    if "A-a gradient" in e:
        inputs["aado2"] = {"value": bare(e["A-a gradient"]), "unit": "mmHg"}
    return "apache_ii", inputs, None


def a_sofa(e, row):
    pao2, fio2 = e["PaO2"][0], e["FiO2"][0]
    if "Systolic Blood Pressure" in e:
        s, d = e["Systolic Blood Pressure"][0], e["Diastolic Blood Pressure"][0]
        map_value = (s + 2 * d) / 3
    else:
        map_value = 65 if e.get("Hypotension") else 75     # only the flag was given: a value on the side of 70 mmHg it names
    inputs = {"pao2_fio2": {"value": pao2 / (fio2 / 100), "unit": "mmHg"},
              "respiratory_support": flag(e, "On mechanical ventilation", "Continuous positive airway pressure"),
              "platelets": q(e["Platelet count"]), "bilirubin": q(e["Bilirubin"]),
              "mean_arterial_pressure": {"value": map_value, "unit": "mmHg"},
              "dopamine": q(e["DOPamine"]) if "DOPamine" in e else {"value": 0, "unit": "ug/kg/min"},
              "dobutamine": q(e["DOBUTamine"]) if "DOBUTamine" in e else {"value": 0, "unit": "ug/kg/min"},
              "epinephrine": q(e["EPINEPHrine"]) if "EPINEPHrine" in e else {"value": 0, "unit": "ug/kg/min"},
              "norepinephrine": q(e["norEPINEPHrine"]) if "norEPINEPHrine" in e else {"value": 0, "unit": "ug/kg/min"},
              "glasgow_coma_scale": e["Glasgow Coma Score"], "creatinine": q(e["creatinine"])}
    if "Urine Output" in e:
        inputs["urine_output"] = q(e["Urine Output"])
    return "sofa", inputs, None


def a_caprini(e, row):
    surgery = str(e.get("Surgery Type", "")).lower()
    mobility = str(e.get("Mobility", "")).lower()
    age = bare(e["age"])
    inputs = {"age": age, "minor_surgery": surgery == "minor", "bmi_over_25": False, "swollen_legs": flag(e, "Current swollen legs"), "varicose_veins": flag(e, "Varicose veins"),
              "inflammatory_bowel_disease": flag(e, "History of inflammatory bowel disease"), "bed_rest_medical": mobility == "on bed rest",
              "acute_mi": flag(e, "Acute Myocardial infarction"), "heart_failure": flag(e, "Congestive Heart Failure in the last month"),
              "sepsis": flag(e, "Sepsis in the last month"), "serious_lung_disease": flag(e, "Pneumonia in the last month"),
              "abnormal_pulmonary_function": flag(e, "Chronic Obstructive Pulmonary Disease"), "major_surgery_within_month": flag(e, "Major Surgery in the last month"),
              "hormonal_contraception_or_hrt": False, "pregnant_or_postpartum": False, "obstetric_history": False,
              "arthroscopic_surgery": surgery == "arthroscopic", "major_open_surgery_over_45min": surgery == "major",
              "laparoscopic_surgery_over_45min": surgery == "laparoscopic", "malignancy": flag(e, "Present or previous malignancy"),
              "confined_to_bed_over_72h": mobility == "confined to bed >72 hours", "plaster_cast": flag(e, "Immobilizing plaster cast in the last month"),
              "central_venous_access": flag(e, "Current central venous access"),
              "history_dvt_pe": flag(e, "Previously documented Deep Vein Thrombosis", "Previously Documented Pulmonary Embolism"),
              "family_history_vte": flag(e, "Family history of thrombosis"), "factor_v_leiden": flag(e, "Positive Factor V Leiden"),
              "prothrombin_20210a": flag(e, "Positive prothrombin 20210A"), "elevated_homocysteine": flag(e, "Elevated serum homocysteine"),
              "lupus_anticoagulant": flag(e, "Positive lupus anticoagulant"), "anticardiolipin_antibodies": flag(e, "Elevated anticardiolipin antibody"),
              "heparin_induced_thrombocytopenia": flag(e, "Heparin-induced thrombocytopenia"), "other_thrombophilia": flag(e, "Other congenital or acquired thrombophilia"),
              "stroke_within_month": flag(e, "Stroke in the last month"), "multiple_trauma_within_month": flag(e, "Multiple trauma in the last month"),
              "elective_major_lower_limb_arthroplasty": surgery == "elective major lower extremity arthroplasty",
              "hip_pelvis_leg_fracture": flag(e, "Hip, pelvis, or leg fracture in the last month"),
              "acute_spinal_cord_injury": flag(e, "Acute spinal cord injury causing paralysis in the last month")}
    return "caprini", inputs, "caprini_2005"


def a_bsa(e, row):
    return "bsa", hw(e), "mosteller"


def a_abw(e, row):
    height = get(e, "height")
    return "adjusted_body_weight", {"weight": q(e["weight"]), "height": {"value": height[0], "unit": height[1]}, "sex": sex(e["sex"])}, None


def a_delta_gap(e, row):
    return "delta_gap", electrolytes(e), None


def a_delta_ratio(e, row):
    return "delta_ratio", electrolytes(e), None


def a_alb_ag(e, row):
    return "albumin_corrected_anion_gap", {**electrolytes(e), "albumin": q(e["Albumin"])}, None


STEROIDS = {"hydrocortisone": "hydrocortisone", "cortisone": "cortisone", "prednisone": "prednisone", "prednisolone": "prednisolone", "methylprednisolone": "methylprednisolone",
            "dexamethasone": "dexamethasone", "betamethasone": "betamethasone", "triamcinolone": "triamcinolone"}


def steroid(name):
    return STEROIDS[name.lower().split()[0]]


def a_steroid(e, row):
    source, target = e["input steroid"], e["target steroid"]
    return "steroid_conversion", {"from_drug": steroid(source[0]), "dose": {"value": float(source[1]), "unit": "mg"}, "to_drug": steroid(target)}, "nice_bnf"      # betamethasone 0.75 mg, as the dataset's table has it


OPIOIDS = {"methadone": "methadone", "tapentadol": "tapentadol", "fentanyl buccal": "fentanyl_buccal", "hydromorphone": "hydromorphone", "morphine": "morphine",
           "codeine": "codeine", "tramadol": "tramadol", "oxycodone": "oxycodone", "hydrocodone": "hydrocodone", "oxymorphone": "oxymorphone"}


def a_mme(e, row):
    drugs = []
    for key, value in e.items():
        if key.endswith(" Dose"):
            name = key[:-5]
            per_day = e.get(name + " Dose Per Day", [1])[0]
            drugs.append({"drug": OPIOIDS[name.lower()], "dose": {"value": value[0], "unit": "mg"}, "administrations_per_day": per_day})
    return "opioid_mme", {"opioids": drugs}, None


def a_pregnancy(kind):
    def adapt(e, row):
        lmp = datetime.datetime.strptime(e["Last menstrual date"], "%m/%d/%Y").date().isoformat()
        inputs = {"lmp": lmp}
        if "cycle length" in e:
            inputs["cycle_length"] = e["cycle length"]
        if "Current Date" in e:
            inputs["as_of"] = datetime.datetime.strptime(e["Current Date"], "%m/%d/%Y").date().isoformat()
        return "pregnancy_dates", inputs, "lmp_cycle_adjusted" if "cycle length" in e else "lmp_280_days"
    return adapt


def iso(us_date):
    """The dataset's MM/DD/YYYY as the tool prints a date."""
    return datetime.datetime.strptime(us_date, "%m/%d/%Y").date().isoformat()


def weeks_days(text):
    """The dataset's ('N weeks', 'M days') as the tool's 'NwMd'."""
    weeks, days = ast.literal_eval(text)
    return "%dw%dd" % (int(weeks.split()[0]), int(days.split()[0]))


ADAPTERS = {
    "Creatinine Clearance (Cockcroft-Gault Equation)": a_cg, "CKD-EPI Equations for Glomerular Filtration Rate": a_ckd,
    "CHA2DS2-VASc Score for Atrial Fibrillation Stroke Risk": a_chads, "Mean Arterial Pressure (MAP)": a_map, "Body Mass Index (BMI)": a_bmi,
    "Wells' Criteria for Pulmonary Embolism": a_wells_pe, "MDRD GFR Equation": a_mdrd, "Ideal Body Weight": a_ibw,
    "QTc Bazett Calculator": qtc("bazett"), "QTc Fridericia Calculator": qtc("fridericia"), "QTc Framingham Calculator": qtc("framingham"),
    "QTc Hodges Calculator": qtc("hodges"), "QTc Rautaharju Calculator": qtc("rautaharju_2014"),
    "Child-Pugh Score for Cirrhosis Mortality": a_childpugh, "Wells' Criteria for DVT": a_wells_dvt, "Revised Cardiac Risk Index for Pre-Operative Risk": a_rcri,
    "HEART Score for Major Cardiac Events": a_heart, "Centor Score (Modified/McIsaac) for Strep Pharyngitis": a_centor, "Maintenance Fluids Calculations": a_fluids,
    "MELD Na (UNOS/OPTN)": a_meldna, "HAS-BLED Score for Major Bleeding Risk": a_hasbled, "Sodium Correction for Hyperglycemia": a_nahyper,
    "Glasgow-Blatchford Bleeding Score (GBS)": a_gbs, "Serum Osmolality": a_osm, "Charlson Comorbidity Index (CCI)": a_charlson,
    "FeverPAIN Score for Strep Pharyngitis": a_feverpain, "Free Water Deficit": a_fwd, "Anion Gap": a_ag, "Delta Gap": a_delta_gap, "CURB-65 Score for Pneumonia Severity": a_curb,
    "Fractional Excretion of Sodium (FENa)": a_fena, "LDL Calculated": a_ldl, "Framingham Risk Score for Hard Coronary Heart Disease": a_fram,
    "PERC Rule for Pulmonary Embolism": a_perc, "SIRS Criteria": a_sirs, "PSI Score: Pneumonia Severity Index for CAP": a_psi, "Glasgow Coma Score (GCS)": a_gcs,
    "APACHE II Score": a_apache, "Sequential Organ Failure Assessment (SOFA) Score": a_sofa, "Caprini Score for Venous Thromboembolism (2005)": a_caprini,
    "Body Surface Area Calculator": a_bsa, "Adjusted Body Weight": a_abw, "Delta Ratio": a_delta_ratio,
    "Albumin Corrected Anion Gap": a_alb_ag, "Steroid Conversion Calculator": a_steroid, "Morphine Milligram Equivalents (MME) Calculator": a_mme,
    "Estimated Due Date": a_pregnancy("edd"), "Estimated Gestational Age": a_pregnancy("age"), "Estimated of Conception": a_pregnancy("conception"),
}


def extra_adapters():
    """Calculators added to the tool after the first run of this check; they are looked up in `clinical_scores.SCALES` by id."""
    return {
        "Calcium Correction for Hypoalbuminemia": ("corrected_calcium", lambda e: {"calcium": q(e["Calcium"]), "albumin": q(e["Albumin"])}),
        "Fibrosis-4 (FIB-4) Index for Liver Fibrosis": ("fib4", lambda e: {"age": bare(e["age"]), "ast": q(e["Aspartate aminotransferase"]),
                                                                           "alt": q(e["Alanine aminotransferase"]), "platelets": q(e["Platelet count"])}),
        "HOMA-IR (Homeostatic Model Assessment for Insulin Resistance)": ("homa_ir", lambda e: {"glucose": q(e["Glucose"]), "insulin": q(e["Insulin"])}),
        "Target weight": ("target_weight", lambda e: {"bmi": q(e["Body Mass Index (BMI)"]), "height": q(e["Height"] if "Height" in e else e["height"])}),
        "Albumin Corrected Delta Gap": ("delta_gap", lambda e: {**electrolytes(e), "albumin": q(e["Albumin"])}),
        "Albumin Corrected Delta Ratio": ("delta_ratio", lambda e: {**electrolytes(e), "albumin": q(e["Albumin"])}),
    }


def within(row, value):
    low, high = row["Lower Limit"], row["Upper Limit"]
    if row["Output Type"] == "date":
        return str(value) == (weeks_days(row["Ground Truth Answer"]) if row["Calculator Name"] == "Estimated Gestational Age" else iso(row["Ground Truth Answer"]))
    try:
        return float(low) - 1e-9 <= float(value) <= float(high) + 1e-9
    except (TypeError, ValueError):
        return str(value) == row["Ground Truth Answer"]


def run(csv_path, show=0):
    rows = list(csv.DictReader(open(csv_path, encoding="utf8")))
    extras = extra_adapters()
    table = collections.OrderedDict()
    misses = []
    for row in rows:
        name = row["Calculator Name"]
        stat = table.setdefault(name, collections.Counter())
        entities = ast.literal_eval(row["Relevant Entities"])
        stat["n"] += 1
        try:
            if name in ADAPTERS:
                scale, inputs, version = ADAPTERS[name](entities, row)
            elif name in extras and extras[name][0] in clinical_scores.SCALES:
                scale, builder = extras[name]
                inputs, version = builder(entities), None
            else:
                raise Skip
            data = call(scale, inputs, version)
            value = shown_value(name, row, data)
        except Skip:
            stat["not_in_tool"] += 1
            continue
        except kit.ScoreError as error:
            stat["refused"] += 1
            if len(misses) < 400:
                misses.append({"calculator": name, "row": row["Row Number"], "refused": error.code, "message": str(error)[:160]})
            continue
        except (KeyError, ValueError, TypeError) as error:
            stat["adapter_error"] += 1
            if len(misses) < 400:
                misses.append({"calculator": name, "row": row["Row Number"], "adapter_error": repr(error)[:160]})
            continue
        if within(row, value):
            stat["pass"] += 1
        else:
            stat["miss"] += 1
            misses.append({"calculator": name, "row": row["Row Number"], "tool": value, "truth": row["Ground Truth Answer"], "band": [row["Lower Limit"], row["Upper Limit"]]})
    return table, misses


def shown_value(name, row, data):
    """The tool's value in the form the dataset's answer is written in (dates, a pair of weeks and days, a unit the dataset fixes)."""
    value = data["result"]["value"]
    if row["Output Type"] == "decimal" and isinstance(data["result"].get("unrounded"), float):
        value = data["result"]["unrounded"]        # the tool prints rounded values and carries the unrounded one beside them
    if name == "Estimated Due Date":
        return value
    if name == "Estimated of Conception":
        return data["estimated_date_of_conception"]
    if name == "Estimated Gestational Age":
        return data["steps"]["gestational_age"]
    if name == "Steroid Conversion Calculator" and isinstance(value, dict):
        return next(iter(value.values()))
    if name == "LDL Calculated" and data["result"]["unit"] == "mmol/L":
        return value * 38.67
    if name == "Delta Gap" or name == "Albumin Corrected Delta Gap":
        return data["steps"]["delta_anion_gap"]
    return value


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--csv", required=True)
    parser.add_argument("--json")
    parser.add_argument("--show", type=int, default=0, help="print this many misses per calculator")
    args = parser.parse_args()
    table, misses = run(args.csv, args.show)
    total = collections.Counter()
    print("%-62s %4s %5s %5s %7s %8s" % ("calculator", "n", "pass", "miss", "refused", "not_in_tool"))
    for name, stat in table.items():
        total.update(stat)
        print("%-62s %4d %5d %5d %7d %8d%s" % (name, stat["n"], stat["pass"], stat["miss"], stat["refused"] + stat["adapter_error"], stat["not_in_tool"],
                                               "  adapter_error %d" % stat["adapter_error"] if stat["adapter_error"] else ""))
    print("TOTAL n=%d pass=%d miss=%d refused=%d not_in_tool=%d adapter_error=%d" % (total["n"], total["pass"], total["miss"], total["refused"], total["not_in_tool"], total["adapter_error"]))
    if args.show:
        seen = collections.Counter()
        for miss in misses:
            seen[miss["calculator"]] += 1
            if seen[miss["calculator"]] <= args.show:
                print(json.dumps(miss, ensure_ascii=False))
    if args.json:
        json.dump({"table": {name: dict(stat) for name, stat in table.items()}, "misses": misses}, open(args.json, "w"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
