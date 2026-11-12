"""Additive clinical scores: each item earns points by a published rule, the points are summed and the total is read
against the source's own bands.

Every rule is written as the source states it, with its unit. Where a source prints cut-offs in two units (a bilirubin
in mg/dL and in umol/L) both tables are kept and the caller's unit is compared natively. Where the literature holds more
than one form of a score, each is a `Version`; the default is stated and the others' totals come back with it.
"""
from __future__ import annotations

import math

from clinical_score_kit import MISSING_INPUTS, NOT_APPLICABLE, Bool, Choice, Num, Outcome, Scale, ScoreError, Version, constant, points_total, round_half_up

SCALES = []


def _add(scale):
    SCALES.append(scale)
    return scale


def B(rule, points, *, lt=None, le=None, gt=None, ge=None):
    """One band of a numeric item: the rule as written, a test on the value in the band table's unit, and its points."""
    def test(x):
        return ((lt is None or x < lt) and (le is None or x <= le) and (gt is None or x > gt) and (ge is None or x >= ge))
    return (rule, test, points)


def bands_of(*rows):
    """Total -> (label, extra) for a list of (highest total in the band or None, label[, extra])."""
    def interpret(total, ctx=None):
        for row in rows:
            limit, label = row[0], row[1]
            if limit is None or total <= limit:
                return label, (row[2] if len(row) > 2 else {})
        raise AssertionError(total)
    return interpret


_VERSION_IDS = {"cha2ds2_vasc": "lip_2010", "has_bled": "pisters_2010", "qsofa": "sepsis3_2016", "gcs": "teasdale_2014", "wells_dvt": "wells_2003", "wells_pe": "wells_2000",
                "rcri": "lee_1999", "perc": "kline_2008", "fever_pain": "little_2013"}


def additive(scale_id, name, group, items, interpret, *, source, scope, label=None, version_id="published", maximum=None,
             aliases=(), bands=None, example=None, note=None, extra_versions=()):
    """A scale whose one default version sums the points of every required item."""
    requires = [item.id for item in items if item.required]
    version_id = _VERSION_IDS.get(scale_id, version_id)
    holder = {}

    def compute(ctx):
        outcome = points_total(ctx, holder["version"], lambda total: interpret(total, ctx)[0], maximum=maximum)
        outcome.extra = {**interpret(outcome.value, ctx)[1], **outcome.extra}
        return outcome

    version = Version(version_id, label or name, source, compute, requires, note=note, additive=True)
    holder["version"] = version
    scale = Scale(scale_id, name, group, items, [version, *extra_versions], source=source, scope=scope, aliases=aliases, bands=bands, example=example)
    return _add(scale)


# ---------------------------------------------------------------------------------------------------------------
# Cardiology and thrombosis
# ---------------------------------------------------------------------------------------------------------------

_SIX_2008 = "Six AJ, Backus BE, Kelder JC. Chest pain in the emergency room: value of the HEART score. Neth Heart J 2008;16:191-196."
_BACKUS_2013 = "Backus BE et al. A prospective validation of the HEART score for chest pain patients at the emergency department. Int J Cardiol 2013;168:2153-2158."


def _heart_version(version_id, label, source, age_bands, troponin_bands):
    items_used = ("history", "ecg", "age", "risk_factor_count", "atherosclerotic_disease", "troponin")

    def compute(ctx):
        rows = []
        for item in ("history", "ecg"):
            rows.append(ctx.scored_row(item))
        for item, bands in (("age", age_bands), ("troponin", troponin_bands)):
            value = ctx.value(item)
            for rule, test, points in bands:
                if test(value):
                    rows.append(ctx.row(item, "%s: %+d" % (rule, points) if points else "%s: 0" % rule, points))
                    break
        count, disease = ctx.value("risk_factor_count"), ctx.value("atherosclerotic_disease")
        if disease or count >= 3:
            points, rule = 2, "history of atherosclerotic disease" if disease else ">= 3 risk factors"
        elif count >= 1:
            points, rule = 1, "1 or 2 risk factors"
        else:
            points, rule = 0, "no risk factors known"
        rows.append(ctx.row("risk_factor_count", "%s: %+d" % (rule, points) if points else "%s: 0" % rule, points))
        rows.append(ctx.row("atherosclerotic_disease", "counted with the risk factors (a history of atherosclerotic disease scores 2 alone)"))
        total = sum(row.get("points", 0) for row in rows)
        category, extra = _HEART_BANDS(total)
        return Outcome(total, "points", category=category, rows=rows, formula="History + ECG + Age + Risk factors + Troponin (each 0-2; maximum 10)", extra=extra)
    return Version(version_id, label, source, compute, items_used)


_HEART_BANDS = bands_of(
    (3, "low risk (0-3)", {"major_adverse_cardiac_events_within_6_weeks": {
        "Backus 2013 (n=2388)": "1.7%", "Backus 2010 multicentre (n=880)": "0.99%", "Six 2008 (n=120, any of AMI/PCI/CABG/death)": "2.5%"}}),
    (6, "intermediate risk (4-6)", {"major_adverse_cardiac_events_within_6_weeks": {
        "Backus 2013 (n=2388)": "16.6%", "Backus 2010 multicentre (n=880)": "11.6%", "Six 2008 (n=120, any of AMI/PCI/CABG/death)": "20.3%"}}),
    (None, "high risk (7-10)", {"major_adverse_cardiac_events_within_6_weeks": {
        "Backus 2013 (n=2388)": "50.1%", "Backus 2010 multicentre (n=880)": "65.2%", "Six 2008 (n=120, any of AMI/PCI/CABG/death)": "72.7%"}}))

_add(Scale("heart", "HEART score", "Cardiology",
           [Choice("history", "History (clinician's judgement of the chest-pain history)",
                   [("slightly_suspicious", "slightly or non-suspicious", 0), ("moderately_suspicious", "moderately suspicious", 1), ("highly_suspicious", "highly suspicious", 2)]),
            Choice("ecg", "ECG", [("normal", "normal", 0), ("nonspecific_repolarisation", "non-specific repolarisation disturbance (LBBB, LVH, digoxin effect, unchanged known abnormality, no significant ST deviation)", 1),
                                  ("significant_st_deviation", "significant ST-segment depression or elevation (no LBBB, LVH or digoxin)", 2)]),
            Num("age", "Age", "age", lo=0, hi=130, bare=True, note="a plain number is read as years"),
            Num("risk_factor_count", "Number of risk factors (diabetes, current or recent smoker, hypertension, hypercholesterolaemia, family history of CAD, obesity)",
                "number", lo=0, hi=6, integer=True, bare=True),
            Bool("atherosclerotic_disease", "History of atherosclerotic disease (prior revascularisation, MI, stroke or peripheral arterial disease)", 2),
            Num("troponin", "First troponin as a multiple of the assay's upper reference limit", "iu_ratio", lo=0, hi=100000, bare=True,
                note="a plain number is read as multiples of the upper reference limit (x_ULN)")],
           [_heart_version("backus_2013", "HEART as validated by Backus 2013 (age <=45 / 46-64 / >=65; troponin <=1x / <3x / >=3x)", _BACKUS_2013,
                           [B("<=45 years", 0, le=45), B("46-64 years", 1, gt=45, lt=65), B(">=65 years", 2, ge=65)],
                           [B("<=1 x ULN", 0, le=1), B(">1 and <3 x ULN", 1, gt=1, lt=3), B(">=3 x ULN", 2, ge=3)]),
            _heart_version("six_2008", "HEART as derived by Six 2008 (age <45 / 45-64 / >=65; troponin <=1x / <=2x / >2x)", _SIX_2008,
                           [B("<45 years", 0, lt=45), B("45-64 years", 1, ge=45, lt=65), B(">=65 years", 2, ge=65)],
                           [B("<=1 x ULN", 0, le=1), B(">1 and <=2 x ULN", 1, gt=1, le=2), B(">2 x ULN", 2, gt=2)])],
           source=_BACKUS_2013 + " " + _SIX_2008, scope="Adults with undifferentiated chest pain at the emergency department; the history item is a judgement the caller makes, not a measurement.",
           aliases=("heart score", "chest pain"), bands={"0-3": "low", "4-6": "intermediate", "7-10": "high"}))


_LIP_2010 = "Lip GYH et al. Refining clinical risk stratification for predicting stroke and thromboembolism in atrial fibrillation (CHA2DS2-VASc). Chest 2010;137:263-272."
_ESC_2020 = "Hindricks G et al. 2020 ESC Guidelines for the diagnosis and management of atrial fibrillation. Eur Heart J 2021;42:373-498 (Table 8)."
# Annual event rates by score (%/year) as printed in the sources; they are different cohorts and different endpoints, so they
# come back side by side and none is chosen for the reader.
_CHADSVASC_RATES = {
    "Lip 2010, Euro Heart Survey, thromboembolism": [0, 0.6, 1.6, 3.9, 1.9, 3.2, 3.6, 8.0, 11.1, 100],
    "2014 AHA/ACC/HRS guideline table, adjusted stroke rate (after Lip, Lancet 2012)": [0, 1.3, 2.2, 3.2, 4.0, 6.7, 9.8, 9.6, 6.7, 15.2],
    "Friberg 2012, Swedish AF cohort, ischaemic stroke": [0.2, 0.6, 2.2, 3.2, 4.8, 7.2, 9.7, 11.2, 10.8, 12.2],
    "Friberg 2012, Swedish AF cohort, stroke/TIA/systemic embolism": [0.3, 0.9, 2.9, 4.6, 6.7, 10.0, 13.6, 15.7, 15.2, 17.4],
}


def _chadsvasc(total, ctx=None):
    female = ctx is not None and ctx.value("sex") == "female"
    low, consider, recommended = (0, 1, 2) if not female else (1, 2, 3)
    if total <= low:
        label = "low risk: no antithrombotic therapy recommended (ESC 2020: score 0 in men, 1 in women)"
    elif total == consider:
        label = "oral anticoagulation should be considered (ESC 2020: score 1 in men, 2 in women)"
    else:
        label = "oral anticoagulation recommended (ESC 2020: score >=2 in men, >=3 in women)"
    return label, {"annual_event_rate_percent_by_source": {name: rates[total] for name, rates in _CHADSVASC_RATES.items()}}


additive("cha2ds2_vasc", "CHA2DS2-VASc score", "Cardiology",
         [Bool("chf", "Congestive heart failure: clinical heart failure, or objective moderate-to-severe LV dysfunction, or hypertrophic cardiomyopathy", 1),
          Bool("hypertension", "Hypertension (history of hypertension, or on antihypertensive treatment)", 1),
          Num("age", "Age", "age", lo=0, hi=130, bare=True, bands=[B("<65", 0, lt=65), B("65-74", 1, ge=65, lt=75), B(">=75", 2, ge=75)],
              note="a plain number is read as years"),
          Bool("diabetes", "Diabetes mellitus (treated with oral agents or insulin, or fasting glucose >125 mg/dL, 7 mmol/L)", 1),
          Bool("stroke_tia_thromboembolism", "Previous stroke, TIA or thromboembolism", 2),
          Bool("vascular_disease", "Vascular disease (angiographically significant CAD, previous myocardial infarction, peripheral artery disease or aortic plaque)", 1),
          Choice("sex", "Sex category", [("male", "male", 0), ("female", "female", 1)])],
         _chadsvasc, source=_LIP_2010 + " " + _ESC_2020, maximum=9,
         scope="Non-valvular atrial fibrillation. The sex category is a risk modifier rather than a risk factor (ESC 2020), so the treatment threshold differs by sex.",
         aliases=("cha2ds2-vasc", "chads-vasc", "chadsvasc", "stroke risk atrial fibrillation"),
         bands={"0 (men) / 1 (women)": "low", "1 (men) / 2 (women)": "consider anticoagulation", ">=2 (men) / >=3 (women)": "anticoagulation recommended"})

_PISTERS_2010 = "Pisters R et al. A novel user-friendly score (HAS-BLED) to assess 1-year risk of major bleeding in patients with atrial fibrillation. Chest 2010;138:1093-1100."
_ESC_2020_T10 = "Hindricks G et al. 2020 ESC AF guidelines, Table 10 (item definitions)."
_HASBLED_BANDS = bands_of(
    (1, "low risk (0-1)", {"bleeds_per_100_patient_years": {"0": 1.13, "1": 1.02}}),
    (2, "moderate risk (2)", {"bleeds_per_100_patient_years": {"2": 1.88}}),
    (None, "high risk (>=3): closer review and correction of modifiable factors, not by itself a contraindication to anticoagulation", {}))

additive("has_bled", "HAS-BLED score", "Cardiology",
         [Bool("hypertension_uncontrolled", "Uncontrolled hypertension (systolic BP >160 mmHg)", 1),
          Bool("abnormal_renal_function", "Abnormal renal function (dialysis, transplant, creatinine >200 umol/L = 2.26 mg/dL)", 1),
          Bool("abnormal_liver_function", "Abnormal liver function (cirrhosis, or bilirubin >2x normal with AST/ALT/ALP >3x normal)", 1),
          Bool("stroke", "Previous stroke", 1),
          Bool("bleeding_history_or_predisposition", "Previous major bleeding, or predisposition (bleeding diathesis, anaemia, severe thrombocytopenia)", 1),
          Bool("labile_inr", "Labile INR (time in therapeutic range <60%; only when on a vitamin K antagonist)", 1),
          Num("age", "Age", "age", lo=0, hi=130, bare=True, bands=[B("<=65", 0, le=65), B(">65", 1, gt=65)], note="a plain number is read as years"),
          Bool("antiplatelet_or_nsaid", "Concomitant antiplatelet or NSAID use", 1),
          Bool("alcohol_excess", "Excessive alcohol (>=8 drinks per week in Pisters 2010; >14 units per week in ESC 2020)", 1)],
         _HASBLED_BANDS, source=_PISTERS_2010 + " " + _ESC_2020_T10, maximum=9,
         scope="Patients with atrial fibrillation on or considered for oral anticoagulation. A flag for review, not a decision rule.",
         aliases=("has bled", "hasbled", "bleeding risk"), bands={"0-1": "low", "2": "moderate", ">=3": "high"})


# ---------------------------------------------------------------------------------------------------------------
# Liver
# ---------------------------------------------------------------------------------------------------------------

_PUGH_1973 = "Pugh RNH et al. Transection of the oesophagus for bleeding oesophageal varices. Br J Surg 1973;60:646-649."
_FDA_CP = "FDA CDER guidance 'Pharmacokinetics in Patients with Impaired Hepatic Function', Table 1 'Child-Pugh Classification' (citing Pugh 1973)."
_PBC_BILIRUBIN = "Bilirubin bands for primary biliary cholangitis / primary sclerosing cholangitis (<4, 4-10, >10 mg/dL): Zeng QL et al. World J Gastroenterol 2007;13:4056 (Table 3); a later adaptation, not in Pugh's table."

ASCITES = Choice("ascites", "Ascites", [("absent", "absent", 1), ("slight", "slight (mild, or controlled with diuretics)", 2),
                                         ("moderate", "moderate or worse (moderate to severe, or refractory to diuretics)", 3)],
                 aliases={"none": "absent", "no": "absent", "mild": "slight", "controlled": "slight", "grade 1": "slight", "moderate_to_severe": "moderate",
                          "severe": "moderate", "refractory": "moderate", "tense": "moderate", "grade 2": "moderate", "grade 3": "moderate"})
ENCEPHALOPATHY = Choice("encephalopathy", "Hepatic encephalopathy (West Haven grade)",
                        [("none", "none", 1), ("grade_1_2", "grade 1 or 2", 2), ("grade_3_4", "grade 3 or 4", 3)],
                        aliases={"0": "none", "absent": "none", "grade 0": "none", "1": "grade_1_2", "2": "grade_1_2", "grade 1": "grade_1_2", "grade 2": "grade_1_2",
                                 "grade_1": "grade_1_2", "grade_2": "grade_1_2", "3": "grade_3_4", "4": "grade_3_4", "grade 3": "grade_3_4", "grade 4": "grade_3_4",
                                 "grade_3": "grade_3_4", "grade_4": "grade_3_4", "coma": "grade_3_4"})
ALBUMIN_CP = Num("albumin", "Serum albumin", "albumin", lo=0.5, hi=8,
                 bands=[B(">3.5", 1, gt=3.5), B("2.8-3.5", 2, ge=2.8, le=3.5), B("<2.8", 3, lt=2.8)], band_unit="g/dL")
BILIRUBIN_CP = Num("bilirubin", "Serum total bilirubin", "bilirubin", lo=0.05, hi=80,
                   bands=[B("<2", 1, lt=2), B("2-3", 2, ge=2, le=3), B(">3", 3, gt=3)], band_unit="mg/dL",
                   note="umol/L is converted at 17.1 umol/L per mg/dL, so the cut-offs are 34.2 and 51.3 umol/L")
BILIRUBIN_PBC = Num("bilirubin", "Serum total bilirubin", "bilirubin", lo=0.05, hi=80,
                    bands=[B("<4", 1, lt=4), B("4-10", 2, ge=4, le=10), B(">10", 3, gt=10)], band_unit="mg/dL")
INR_CP = Num("inr", "INR", "ratio", lo=0.5, hi=20, bare=True, bands=[B("<1.7", 1, lt=1.7), B("1.7-2.3", 2, ge=1.7, le=2.3), B(">2.3", 3, gt=2.3)])
PT_CP = Num("pt_prolonged", "Prothrombin time prolonged over control", "interval", lo=0, hi=120000, band_unit="ms",
            bands=[B("<4 s", 1, lt=4000), B("4-6 s", 2, ge=4000, le=6000), B(">6 s", 3, gt=6000)], note="seconds over the laboratory control; accepts s or ms")

_CP_BANDS = bands_of((6, "Child-Pugh class A (5-6): well-compensated"), (9, "Child-Pugh class B (7-9): significant functional compromise"),
                     (None, "Child-Pugh class C (10-15): decompensated"))


def _cp_version(version_id, label, source, coagulation, bilirubin, note=None):
    items = ("bilirubin", "albumin", coagulation, "ascites", "encephalopathy")

    def compute(ctx):
        rows = []
        for item in items:
            parsed = ctx.parsed[item]
            definition = (bilirubin if item == "bilirubin" else PT_CP if item == "pt_prolonged" else ctx.scale.items[item])
            points, rule = definition.points_of(parsed)
            rows.append(ctx.row(item, rule, points))
        total = sum(row["points"] for row in rows)
        return Outcome(total, "points", category=_CP_BANDS(total)[0], rows=rows, formula="sum of the five item points (5-15)")
    return Version(version_id, label, source, compute, items, note=note, additive=False)


_add(Scale("child_pugh", "Child-Pugh score", "Liver",
           [BILIRUBIN_CP, ALBUMIN_CP, INR_CP, PT_CP, ASCITES, ENCEPHALOPATHY],
           [_cp_version("inr", "Child-Pugh with INR (FDA table)", _PUGH_1973 + " " + _FDA_CP, "inr", BILIRUBIN_CP),
            _cp_version("pt_seconds", "Child-Pugh as Pugh 1973 scored coagulation (seconds prolonged)", _PUGH_1973, "pt_prolonged", BILIRUBIN_CP,
                        note="Pugh's own coagulation measure; INR cut-offs 1.7 and 2.3 were later substituted. Do not score both."),
            _cp_version("inr_pbc_psc", "Child-Pugh with INR and the PBC/PSC bilirubin bands", _PBC_BILIRUBIN, "inr", BILIRUBIN_PBC,
                        note="Only for primary biliary cholangitis or primary sclerosing cholangitis, where conjugated bilirubin runs high.")],
           source=_PUGH_1973 + " " + _FDA_CP, scope="Chronic liver disease (cirrhosis). The score does not define how ascites or encephalopathy is assessed (with or without treatment); say which when reporting.",
           aliases=("child-turcotte-pugh", "child pugh", "ctp", "cirrhosis severity"),
           bands={"5-6": "class A", "7-9": "class B", "10-15": "class C"}))


# ---------------------------------------------------------------------------------------------------------------
# Emergency, infection and critical care
# ---------------------------------------------------------------------------------------------------------------

def _count_scale(scale_id, name, group, items, interpret, **kwargs):
    return additive(scale_id, name, group, items, interpret, **kwargs)


_BONE_1992 = "Bone RC et al. Definitions for sepsis and organ failure and guidelines for the use of innovative therapies in sepsis (ACCP/SCCM Consensus Conference). Chest 1992;101:1644-1655."


def _sirs(ctx):
    rows, met = [], 0
    undetermined = []

    def criterion(item, rule, truth, extra_items=()):
        nonlocal met
        row = ctx.row(item, "%s: %s" % (rule, "met" if truth else "not met"), 1 if truth else 0)
        met += 1 if truth else 0
        rows.append(row)
        return row

    criterion("temperature", ">38 C or <36 C", ctx.value("temperature") > 38 or ctx.value("temperature") < 36)
    criterion("heart_rate", ">90 /min", ctx.value("heart_rate") > 90)
    resp_met = ctx.value("respiratory_rate") > 20 or (ctx.has("paco2") and ctx.value("paco2") < 32)
    criterion("respiratory_rate", "respiratory rate >20 /min or PaCO2 <32 mmHg", resp_met)
    if ctx.has("paco2"):
        rows.append(ctx.row("paco2", "PaCO2 <32 mmHg: %s" % ("met" if ctx.value("paco2") < 32 else "not met")))
    elif not resp_met:
        undetermined.append("the respiratory criterion (PaCO2 was not given; respiratory rate alone did not meet it)")
    wbc_met = ctx.value("wbc") > 12 or ctx.value("wbc") < 4 or (ctx.has("bands_percent") and ctx.value("bands_percent") > 10)
    criterion("wbc", "white cells >12 or <4 x10^9/L, or >10% immature (band) forms", wbc_met)
    if ctx.has("bands_percent"):
        rows.append(ctx.row("bands_percent", "bands >10%%: %s" % ("met" if ctx.value("bands_percent") > 10 else "not met")))
    elif not wbc_met:
        undetermined.append("the white-cell criterion (band percentage was not given; the count alone did not meet it)")
    category = "SIRS present (>= 2 criteria)" if met >= 2 else "SIRS criteria not met (< 2)"
    extra = {}
    if undetermined and met < 2 <= met + len(undetermined):
        extra["could_be_higher"] = {"undetermined": undetermined, "possible_maximum": met + len(undetermined),
                                    "note": "an optional item that was not given could have met a criterion; the count above uses what was given"}
        category = "SIRS criteria not met on the items given; undetermined (an item not given could reach 2)"
    return Outcome(met, "criteria met", category=category, rows=rows, formula="number of the four criteria met; SIRS needs two or more", extra=extra)


_add(Scale("sirs", "SIRS criteria", "Critical care",
           [Num("temperature", "Temperature", "temperature", lo=20, hi=46), Num("heart_rate", "Heart rate", "rate", lo=0, hi=350, bare=True),
            Num("respiratory_rate", "Respiratory rate", "rate", lo=0, hi=120, bare=True), Num("wbc", "White blood cell count", "count", lo=0, hi=1000),
            Num("paco2", "Arterial PaCO2 (optional second route to the respiratory criterion)", "pressure", lo=5, hi=200, required=False),
            Num("bands_percent", "Immature (band) forms, percent of white cells (optional third route to the white-cell criterion)", "percent", lo=0, hi=100, required=False)],
           [Version("accp_sccm_1992", "ACCP/SCCM consensus definition", _BONE_1992, _sirs, ("temperature", "heart_rate", "respiratory_rate", "wbc"))],
           source=_BONE_1992, scope="Adults. Two or more criteria define SIRS (Sepsis-3 no longer uses it to define sepsis).", aliases=("systemic inflammatory response",),
           bands={">=2": "SIRS present"}))


_SINGER_2016 = "Singer M et al. The Third International Consensus Definitions for Sepsis and Septic Shock (Sepsis-3). JAMA 2016;315:801-810."
_SEYMOUR_2016 = "Seymour CW et al. Assessment of clinical criteria for sepsis: for the Third International Consensus Definitions for Sepsis and Septic Shock. JAMA 2016;315:762-774."
additive("qsofa", "qSOFA (quick SOFA)", "Critical care",
         [Num("respiratory_rate", "Respiratory rate", "rate", lo=0, hi=120, bare=True, bands=[B("<22", 0, lt=22), B(">=22", 1, ge=22)]),
          Bool("altered_mentation", "Altered mentation (Glasgow Coma Scale <15)", 1),
          Num("systolic_bp", "Systolic blood pressure", "pressure", lo=20, hi=350, bands=[B(">100", 0, gt=100), B("<=100", 1, le=100)])],
         bands_of((1, "qSOFA negative (0-1)"), (None, "qSOFA positive (>= 2): higher risk of poor outcome with suspected infection; assess for organ dysfunction")),
         source=_SINGER_2016 + " " + _SEYMOUR_2016, maximum=3, scope="Adults outside intensive care with suspected infection; a prompt to look for organ dysfunction, not a diagnosis.",
         aliases=("quick sofa",), bands={"0-1": "negative", ">=2": "positive"})

_TEASDALE_1974 = "Teasdale G, Jennett B. Assessment of coma and impaired consciousness. A practical scale. Lancet 1974;2:81-84; labels and the untestable rule as in the Glasgow Coma Scale assessment aid (Teasdale 2015, glasgowcomascale.org)."
_NT = "a component that cannot be tested is recorded as NT, never as 1, and no total is given (Teasdale 2014/2015); report the components that were tested"
additive("gcs", "Glasgow Coma Scale", "Critical care",
         [Choice("eye", "Eye opening", [(4, "spontaneous", 4), (3, "to sound", 3), (2, "to pressure", 2), (1, "none", 1), ("NT", "not testable (eyes closed by a local factor)", None)],
                 aliases={"nt": "NT", "spontaneously": 4, "to voice": 3, "to speech": 3, "to pain": 2, "no response": 1}, unscorable={"NT": _NT}),
          Choice("verbal", "Verbal response", [(5, "orientated", 5), (4, "confused", 4), (3, "words (intelligible single words)", 3), (2, "sounds (only moans or groans)", 2), (1, "none", 1),
                                               ("NT", "not testable (e.g. intubated)", None)],
                 aliases={"nt": "NT", "oriented": 5, "inappropriate words": 3, "incomprehensible sounds": 2, "no response": 1}, unscorable={"NT": _NT}),
          Choice("motor", "Best motor response", [(6, "obeys commands", 6), (5, "localising", 5), (4, "normal flexion (withdrawal)", 4), (3, "abnormal flexion", 3), (2, "extension", 2),
                                                  (1, "none", 1), ("NT", "not testable (e.g. paralysed)", None)],
                 aliases={"nt": "NT", "localizes": 5, "withdraws": 4, "abnormal extension": 2, "no response": 1}, unscorable={"NT": _NT})],
         bands_of((8, "severe (3-8)"), (12, "moderate (9-12)"), (None, "mild (13-15)")),
         source=_TEASDALE_1974, maximum=15,
         scope="Any age over 5 years without modification. The severity bands are from a secondary review; the scale itself is best reported as its three components (for example E3V4M5).",
         aliases=("glasgow coma", "coma scale"), bands={"3-8": "severe", "9-12": "moderate", "13-15": "mild"})



def _curb_version(version_id, label, with_urea):
    items = (["confusion"] + (["urea_nitrogen"] if with_urea else []) + ["respiratory_rate", "systolic_bp", "diastolic_bp", "age"])

    def compute(ctx):
        rows = [ctx.scored_row("confusion")]
        if with_urea:
            rows.append(ctx.scored_row("urea_nitrogen"))
        rows.append(ctx.scored_row("respiratory_rate"))
        sbp, dbp = ctx.value("systolic_bp"), ctx.value("diastolic_bp")
        low = sbp < 90 or dbp <= 60
        rows.append(ctx.row("systolic_bp", "systolic <90 mmHg or diastolic <=60 mmHg: %s" % ("+1" if low else "0"), 1 if low else 0))
        rows.append(ctx.row("diastolic_bp", "scored with the systolic pressure (one point for either)"))
        rows.append(ctx.scored_row("age"))
        total = sum(row.get("points", 0) for row in rows)
        category, extra = (_CURB_BANDS if with_urea else _CRB_BANDS)(total)
        return Outcome(total, "points", category=category, rows=rows, extra=extra,
                       formula="one point each for confusion, %srespiratory rate >=30/min, low blood pressure, age >=65 (maximum %d)" % ("urea >7 mmol/L (BUN >19 mg/dL), " if with_urea else "", 5 if with_urea else 4))
    return Version(version_id, label, "Lim WS et al. Defining community acquired pneumonia severity on presentation to hospital: an international derivation and validation study. Thorax 2003;58:377-382.",
                   compute, items)


_CURB_NOTE = {"mortality_note": "30-day mortality in Lim 2003 rose from 0.7% at a score of 0 to 57% at 5 (abstract); the intermediate per-score figures differ between published copies (score 2 is printed as 3% and as 13%) and are not restated here"}
_CURB_BANDS = bands_of((1, "low severity (0-1): the BTS/NICE grouping treats this as suitable for home treatment", _CURB_NOTE),
                       (2, "moderate severity (2): the BTS/NICE grouping suggests short-stay or hospital-supervised treatment", _CURB_NOTE),
                       (None, "high severity (>=3): the BTS/NICE grouping treats this as severe pneumonia", _CURB_NOTE))
_CRB_BANDS = bands_of((0, "low risk (0)", {}), (2, "intermediate risk (1-2)", {}), (None, "high risk (3-4)", {}))

_add(Scale("curb_65", "CURB-65", "Respiratory",
           [Bool("confusion", "New confusion (abbreviated mental test score 8 or less, or new disorientation in person, place or time)", 1),
            Num("urea_nitrogen", "Blood urea", "urea_nitrogen", lo=1, hi=300, band_unit="mg/dL",
                bands=[B("<=19", 0, le=19), B(">19", 1, gt=19)], alt_bands={"mmol/L": [B("<=7", 0, le=7), B(">7", 1, gt=7)]},
                note="mg/dL is urea nitrogen (BUN); mmol/L is urea; each is compared with the cut-off printed in its own unit"),
            Num("respiratory_rate", "Respiratory rate", "rate", lo=0, hi=120, bare=True, bands=[B("<30", 0, lt=30), B(">=30", 1, ge=30)]),
            Num("systolic_bp", "Systolic blood pressure", "pressure", lo=20, hi=350), Num("diastolic_bp", "Diastolic blood pressure", "pressure", lo=10, hi=250),
            Num("age", "Age", "age", lo=0, hi=130, bare=True, bands=[B("<65", 0, lt=65), B(">=65", 1, ge=65)], note="a plain number is read as years")],
           [_curb_version("curb_65", "CURB-65 (with urea)", True), _curb_version("crb_65", "CRB-65 (no blood test)", False)],
           source="Lim WS et al. Thorax 2003;58:377-382.", scope="Adults with community-acquired pneumonia at presentation; supports, and does not replace, clinical judgement.",
           aliases=("curb65", "crb-65", "crb65", "pneumonia severity"), bands={"0-1": "low", "2": "moderate", "3-5": "high"}))


_WELLS_2003 = "Wells PS et al. Evaluation of D-dimer in the diagnosis of suspected deep-vein thrombosis. N Engl J Med 2003;349:1227-1235; items as in NICE NG158 Table 1 (adapted from Wells 2003)."
_WELLS_DVT_ITEMS = [
    Bool("active_cancer", "Active cancer (treatment ongoing, within 6 months, or palliative)", 1),
    Bool("paralysis_or_immobilisation", "Paralysis, paresis or recent plaster immobilisation of the lower extremities", 1),
    Bool("bedridden_or_major_surgery", "Recently bedridden for 3 days or more, or major surgery within 12 weeks requiring general or regional anaesthesia", 1),
    Bool("deep_vein_tenderness", "Localised tenderness along the distribution of the deep venous system", 1),
    Bool("entire_leg_swollen", "Entire leg swollen", 1),
    Bool("calf_swelling_3cm", "Calf swelling at least 3 cm larger than the asymptomatic side (measured 10 cm below the tibial tuberosity)", 1),
    Bool("pitting_edema", "Pitting oedema confined to the symptomatic leg", 1),
    Bool("collateral_superficial_veins", "Collateral superficial veins (non-varicose)", 1),
    Bool("previous_dvt", "Previously documented deep-vein thrombosis", 1),
    Bool("alternative_diagnosis_as_likely", "An alternative diagnosis is at least as likely as deep-vein thrombosis", -2),
]


def _wells_dvt(total, ctx=None):
    label = "low probability (<= 0)" if total <= 0 else "moderate probability (1-2)" if total <= 2 else "high probability (>= 3)"
    return label, {"two_level": "DVT likely (score 2 or more)" if total >= 2 else "DVT unlikely (score 1 or less)",
                   "dvt_prevalence_percent_low_moderate_high": {"Wells 1997 cohort (n=593, original rule)": [3, 17, 75], "pooled 14 studies (Wells, JAMA 2006)": [5, 17, 53]}}


additive("wells_dvt", "Wells score for deep-vein thrombosis", "Thrombosis", _WELLS_DVT_ITEMS, _wells_dvt, source=_WELLS_2003, maximum=9,
         scope="Outpatients with suspected first lower-extremity DVT; the score sets the pre-test probability and does not diagnose. The 1997 original had nine items (no 'previous DVT'; surgery within 4 weeks); it was inferred from a secondary paper only and is not implemented.",
         aliases=("wells criteria dvt", "dvt probability", "wells dvt"), bands={"<=0": "low", "1-2": "moderate", ">=3": "high", "two-level": "<=1 unlikely, >=2 likely"})

_WELLS_PE = ("Wells PS et al. Derivation of a simple clinical model to categorize patients probability of pulmonary embolism. Thromb Haemost 2000;83:416-420 (items, points and cut-offs in the abstract); "
             "wording of the items as in NICE NG158 Table 2; probabilities from Wells et al. Ann Intern Med 2001;135:98-107.")


def _wells_pe(total, ctx=None):
    label = "low probability (< 2)" if total < 2 else "moderate probability (2 to 6)" if total <= 6 else "high probability (> 6)"
    return label, {"two_level": "PE unlikely (score 4 or less)" if total <= 4 else "PE likely (score above 4)",
                   "pe_prevalence_percent_low_moderate_high": {"Wells 2001, emergency department (n=930)": [1.3, 16.2, 37.5]}}


additive("wells_pe", "Wells score for pulmonary embolism", "Thrombosis",
         [Bool("clinical_signs_dvt", "Clinical signs and symptoms of DVT (minimum of leg swelling and pain on palpation of the deep veins)", 3),
          Bool("pe_most_likely_diagnosis", "An alternative diagnosis is less likely than pulmonary embolism", 3),
          Num("heart_rate", "Heart rate", "rate", lo=0, hi=350, bare=True, bands=[B("<=100", 0, le=100), B(">100", 1.5, gt=100)]),
          Bool("immobilisation_or_surgery", "Immobilisation for more than 3 days, or surgery in the previous 4 weeks", 1.5),
          Bool("previous_pe_or_dvt", "Previous pulmonary embolism or deep-vein thrombosis", 1.5),
          Bool("hemoptysis", "Haemoptysis", 1),
          Bool("malignancy", "Malignancy (on treatment, treated in the last 6 months, or palliative)", 1)],
         _wells_pe, source=_WELLS_PE, maximum=12.5,
         scope="Patients with suspected pulmonary embolism. Some guidelines print integer cut-offs for the three-level rule (0-1, 2-6, 7 or more) that differ at 1.5 and 6.5; the cut-offs here are the paper's (< 2, 2 to 6, > 6).",
         aliases=("wells criteria pe", "pe probability", "wells pulmonary embolism"), bands={"<2": "low", "2-6": "moderate", ">6": "high", "two-level": "<=4 unlikely, >4 likely"})

_LEE_1999 = "Lee TH et al. Derivation and prospective validation of a simple index for prediction of cardiac risk of major noncardiac surgery. Circulation 1999;100:1043-1049 (the six predictors and creatinine > 2.0 mg/dL are in the abstract; the sub-definitions are textbook-level)."


def _rcri(total, ctx=None):
    cls = min(total, 3)
    third = "7 (6.6 in reproductions)"
    rates = {"Lee 1999 derivation cohort (n=2893)": [0.5, 1.3, 4, 9][cls], "Lee 1999 validation cohort (n=1422)": [0.4, 0.9, third, 11][cls],
             "Duceppe 2017 CCS guideline, 30-day death, MI or cardiac arrest (secondary report)": [3.9, 6.0, 10.1, 15][cls]}
    return "class %s (%s)" % (["I: 0 factors", "II: 1 factor", "III: 2 factors", "IV: 3 or more factors"][cls], "major cardiac complication rate differs by cohort"), {"major_cardiac_complication_percent": rates}


additive("rcri", "Revised Cardiac Risk Index", "Perioperative",
         [Bool("high_risk_surgery", "High-risk surgery (intraperitoneal, intrathoracic or suprainguinal vascular)", 1),
          Bool("ischemic_heart_disease", "History of ischaemic heart disease (MI, positive exercise test, current chest pain from ischaemia, nitrate use, or pathological Q waves)", 1),
          Bool("heart_failure", "History of congestive heart failure (pulmonary oedema, PND, bibasilar rales, S3 gallop, or pulmonary vascular redistribution on chest film)", 1),
          Bool("cerebrovascular_disease", "History of cerebrovascular disease (stroke or TIA)", 1),
          Bool("insulin_treatment", "Pre-operative treatment with insulin", 1),
          Num("creatinine", "Pre-operative serum creatinine", "creatinine", lo=0.05, hi=60, bands=[B("<=2.0", 0, le=2.0), B(">2.0", 1, gt=2.0)])],
         _rcri, source=_LEE_1999, maximum=6, scope="Adults having major non-cardiac surgery. The complication rates are cohort-specific; the later guideline rates are on a broader outcome and are higher.",
         aliases=("lee index", "cardiac risk index", "revised cardiac risk", "rcri"), bands={"0": "class I", "1": "class II", "2": "class III", ">=3": "class IV"})

_KLINE_2008 = "Kline JA et al. Prospective multicenter evaluation of the pulmonary embolism rule-out criteria. J Thromb Haemost 2008;6:772-780 (criteria as in the abstract; derivation: Kline 2004, J Thromb Haemost 2:1247)."
additive("perc", "Pulmonary Embolism Rule-out Criteria (PERC)", "Thrombosis",
         [Num("age", "Age", "age", lo=0, hi=130, bare=True, bands=[B("<50", 0, lt=50), B(">=50", 1, ge=50)], note="a plain number is read as years"),
          Num("heart_rate", "Heart rate", "rate", lo=0, hi=350, bare=True, bands=[B("<100", 0, lt=100), B(">=100", 1, ge=100)]),
          Num("oxygen_saturation", "Room-air oxygen saturation", "percent", lo=30, hi=100, bands=[B(">=95", 0, ge=95), B("<95", 1, lt=95)]),
          Bool("unilateral_leg_swelling", "Unilateral leg swelling", 1), Bool("hemoptysis", "Haemoptysis", 1),
          Bool("recent_surgery_or_trauma", "Surgery or trauma requiring hospitalisation within 4 weeks", 1),
          Bool("previous_pe_or_dvt", "Prior venous thromboembolism (pulmonary embolism or deep-vein thrombosis)", 1), Bool("hormone_use", "Exogenous oestrogen use", 1)],
         bands_of((0, "PERC negative: all eight criteria met; with low clinical suspicion (gestalt probability below 15%) PE can be excluded without further testing"),
                  (None, "PERC positive: at least one criterion not met; the rule does not exclude PE")),
         source=_KLINE_2008, maximum=8, scope="Only for patients with low clinical suspicion of pulmonary embolism (< 15%). The saturation threshold is the rule's; an altitude adjustment (< 90% at 1518 m) was a later post-hoc proposal and is not applied.",
         aliases=("pulmonary embolism rule-out", "perc rule"), bands={"0": "negative", ">=1": "positive"})

_LITTLE_2013 = "Little P et al. Clinical score and rapid antigen detection test to guide antibiotic use for sore throats (PRISM). BMJ 2013;347:f5806; items, probabilities and management bands as in NICE NG84 (2018)."
additive("fever_pain", "FeverPAIN score", "Infection",
         [Bool("fever_last_24h", "Fever during the previous 24 hours", 1), Bool("purulence", "Purulence (pus on the tonsils)", 1),
          Bool("attend_rapidly", "Attends rapidly (within 3 days after onset of symptoms)", 1), Bool("inflamed_tonsils", "Severely inflamed tonsils", 1),
          Bool("no_cough_or_coryza", "No cough or coryza", 1)],
         bands_of((1, "0-1: thought to carry a 13-18% likelihood of streptococcus; NICE NG84: do not offer an antibiotic prescription", {}),
                  (3, "2-3: 34-40%; NICE NG84: consider no antibiotic with advice, or a back-up prescription", {}),
                  (None, "4-5: 62-65%; NICE NG84: consider an immediate antibiotic prescription, or a back-up prescription with advice", {})),
         source=_LITTLE_2013, maximum=5, scope="Adults and children 3 years and over with acute sore throat in primary care. NICE lists 'severely inflamed' where the trial paper says 'inflamed'.",
         aliases=("fever pain", "sore throat score"), bands={"0-1": "low", "2-3": "moderate", "4-5": "high"})

_CENTOR_1981 = "Centor RM et al. The diagnosis of strep throat in adults in the emergency room. Med Decis Making 1981;1:239-246 (the four variables and the five probabilities are in the abstract)."
_MCISAAC_2004 = ("McIsaac WJ et al. Empirical validation of guidelines for the management of pharyngitis in children and adults. JAMA 2004;291:1587-1595; the age adjustment as in McIsaac, CMAJ 1998;158:75 and "
                 "CMAJ 2000;163:811 (abstracts only; the age bands are from calculator-level pages that agree: 3-14 +1, 15-44 0, 45 and over -1).")
_CENTOR_ITEMS = [Bool("tonsillar_exudate", "Tonsillar swelling or exudate", 1), Bool("tender_anterior_cervical_nodes", "Tender or swollen anterior cervical lymph nodes", 1),
                 Bool("fever", "Temperature above 38 C (100.4 F), or a history of fever", 1), Bool("absence_of_cough", "Absence of cough", 1)]
_AGE_MCISAAC = Num("age", "Age", "age", lo=0, hi=130, bare=True, bands=[B("3-14", 1, ge=3, lt=15), B("15-44", 0, ge=15, lt=45), B(">=45", -1, ge=45)], note="a plain number is read as years; under 3 is outside the score")


def _mcisaac_compute(ctx):
    if ctx.value("age") < 3:
        raise ScoreError(NOT_APPLICABLE, "The modified Centor (McIsaac) score is for people 3 years and over (group A streptococcal pharyngitis is rare below 3).", {"item": "age"})
    outcome = points_total(ctx, ctx.scale.versions["mcisaac_modified"], lambda total: "score %d" % total, formula="sum of the four Centor items and the age adjustment (range -1 to 5)")
    total = outcome.value
    outcome.category = ("0 or below: probability of group A streptococcus about 1-2.5%" if total <= 0 else "1: about 5-10%" if total == 1 else "2-3: about 11-35%" if total <= 3 else "4-5: about 51-53%")
    outcome.notes = ["Probability bands are from calculator-level pages (WikEM) and a second page prints different ones (CanadiEM: 1-10%, 10-28%, 38-63%); management differs by guideline (NICE: antibiotic only at Centor 3-4; IDSA 2012: test, do not treat empirically)."]
    return outcome


def _centor_compute(ctx):
    outcome = points_total(ctx, ctx.scale.versions["centor_1981"], lambda total: "score %d" % total, formula="one point for each of the four variables (0-4)")
    outcome.category = "%d of 4 variables: probability of a positive streptococcal culture %s (Centor 1981, adults in an emergency room)" % (outcome.value, {0: "2.5%", 1: "6.5%", 2: "15%", 3: "32%", 4: "56%"}[outcome.value])
    outcome.notes = ["NICE NG84 reads Centor 0-2 as a 3-17% likelihood (no antibiotic) and 3-4 as 32-56% (consider an immediate or back-up antibiotic)."]
    return outcome


_add(Scale("centor_mcisaac", "Centor / modified Centor (McIsaac) score", "Infection", [*_CENTOR_ITEMS, _AGE_MCISAAC],
           [Version("mcisaac_modified", "Modified Centor (McIsaac): four items plus age adjustment", _MCISAAC_2004, _mcisaac_compute, tuple(i.id for i in _CENTOR_ITEMS) + ("age",), additive=True),
            Version("centor_1981", "Original Centor: four items, no age", _CENTOR_1981, _centor_compute, tuple(i.id for i in _CENTOR_ITEMS), additive=True)],
           source=_MCISAAC_2004 + " " + _CENTOR_1981, scope="Sore throat in someone 3 years or older; a probability of group A streptococcus, not a diagnosis.",
           aliases=("centor", "modified centor", "mcisaac", "strep score", "sore throat"), bands={"mcisaac -1..5": "age-adjusted", "centor 0..4": "no age"}))

# ---------------------------------------------------------------------------------------------------------------
# Caprini venous thromboembolism risk
# ---------------------------------------------------------------------------------------------------------------

_CAPRINI_2005 = ("Caprini JA. Thrombosis risk assessment as a guide to quality patient care. Dis Mon 2005;51:70-78 (the table itself was not readable; the items and weights are those of two reproductions that agree, "
                 "MDCalc 'Caprini Score for VTE (2005)' and J Vasc Surg Venous Lymphat Disord 2021, Table I).")
_ACCP_2012 = "Gould MK et al. Prevention of VTE in nonorthopedic surgical patients. Chest 2012;141(2 Suppl):e227S-e277S, Table 7 (the panel's adaptation of the Caprini model)."
_CAPRINI_ITEMS = [
    ("age", None, None),
    ("minor_surgery", "Minor surgery planned", 1), ("bmi_over_25", "Body mass index above 25 kg/m2", 1), ("swollen_legs", "Swollen legs (current)", 1),
    ("varicose_veins", "Varicose veins", 1), ("inflammatory_bowel_disease", "History of inflammatory bowel disease", 1), ("bed_rest_medical", "Medical patient currently at bed rest", 1),
    ("acute_mi", "Acute myocardial infarction (< 1 month)", 1), ("heart_failure", "Congestive heart failure (< 1 month)", 1), ("sepsis", "Sepsis (< 1 month)", 1),
    ("serious_lung_disease", "Serious lung disease including pneumonia (< 1 month)", 1), ("abnormal_pulmonary_function", "Abnormal pulmonary function (COPD)", 1),
    ("major_surgery_within_month", "Major surgery (< 1 month) - in the 2005 reproductions, absent from the ACCP table", 1),
    ("hormonal_contraception_or_hrt", "Oral contraceptives or hormone replacement therapy", 1), ("pregnant_or_postpartum", "Pregnancy or postpartum (< 1 month)", 1),
    ("obstetric_history", "History of unexplained stillborn infant, recurrent spontaneous abortion (3 or more), premature birth with toxaemia or growth-restricted infant", 1),
    ("arthroscopic_surgery", "Arthroscopic surgery", 2), ("major_open_surgery_over_45min", "Major open surgery (> 45 minutes)", 2), ("laparoscopic_surgery_over_45min", "Laparoscopic surgery (> 45 minutes)", 2),
    ("malignancy", "Malignancy (present or previous)", 2), ("confined_to_bed_over_72h", "Patient confined to bed (> 72 hours)", 2), ("plaster_cast", "Immobilising plaster cast (< 1 month)", 2),
    ("central_venous_access", "Central venous access", 2),
    ("history_dvt_pe", "History of DVT or pulmonary embolism", 3), ("family_history_vte", "Family history of thrombosis", 3), ("factor_v_leiden", "Positive factor V Leiden", 3),
    ("prothrombin_20210a", "Positive prothrombin 20210A", 3), ("elevated_homocysteine", "Elevated serum homocysteine", 3), ("lupus_anticoagulant", "Positive lupus anticoagulant", 3),
    ("anticardiolipin_antibodies", "Elevated anticardiolipin antibodies", 3), ("heparin_induced_thrombocytopenia", "Heparin-induced thrombocytopenia", 3),
    ("other_thrombophilia", "Other congenital or acquired thrombophilia", 3),
    ("stroke_within_month", "Stroke (< 1 month)", 5), ("multiple_trauma_within_month", "Multiple trauma (< 1 month) - in the 2005 reproductions, absent from the ACCP table", 5),
    ("elective_major_lower_limb_arthroplasty", "Elective major lower-extremity arthroplasty", 5), ("hip_pelvis_leg_fracture", "Hip, pelvis or leg fracture (< 1 month)", 5),
    ("acute_spinal_cord_injury", "Acute spinal cord injury (paralysis) (< 1 month)", 5),
]
_CAPRINI_AGE = Num("age", "Age", "age", lo=0, hi=130, bare=True, bands=[B("<=40", 0, le=40), B("41-60", 1, gt=40, lt=61), B("61-74", 2, ge=61, lt=75), B(">=75", 3, ge=75)],
                   note="a plain number is read as years; the bands are exclusive")
_CAPRINI_BOOLS = [Bool(item_id, label, points) for item_id, label, points in _CAPRINI_ITEMS if item_id != "age"]
_ACCP_DROPPED = {"major_surgery_within_month", "multiple_trauma_within_month"}


def _caprini_interpret(total):
    return ("lowest risk (0-1)" if total <= 1 else "moderate risk (2)" if total == 2 else "high risk (3-4)" if total <= 4 else "highest risk (5 or more)",
            {"names_in_the_ACCP_guideline": "very low (0-1), low (2), moderate (3-4), high (5 or more): the same cut-offs under other names"})


def _caprini_version(version_id, label, source, drop):
    requires = ["age"] + [i.id for i in _CAPRINI_BOOLS if i.id not in drop]
    holder = {}

    def compute(ctx):
        outcome = points_total(ctx, holder["v"], lambda total: _caprini_interpret(total)[0], formula="sum of the item weights (1, 2, 3 or 5); no maximum")
        outcome.extra = _caprini_interpret(outcome.value)[1]
        return outcome
    holder["v"] = Version(version_id, label, source, compute, requires, additive=True)
    return holder["v"]


_add(Scale("caprini", "Caprini risk assessment for venous thromboembolism", "Thrombosis", [_CAPRINI_AGE, *_CAPRINI_BOOLS],
           [_caprini_version("caprini_2005", "Caprini 2005 (as reproduced)", _CAPRINI_2005, set()),
            _caprini_version("accp_2012_table7", "ACCP 2012 adaptation (no 'major surgery < 1 month', no 'multiple trauma')", _ACCP_2012, _ACCP_DROPPED)],
           source=_CAPRINI_2005 + " " + _ACCP_2012, scope="Surgical and hospitalised medical patients. Weights of the 2010 and 2013 revisions (cancer split, smoking, transfusion, BMI above 40) differ and were not retrievable, so they are not implemented.",
           aliases=("caprini score", "vte risk", "dvt prophylaxis risk", "venous thromboembolism risk"), bands={"0-1": "lowest", "2": "moderate", "3-4": "high", ">=5": "highest"}))


_BLATCHFORD_2000 = "Blatchford O, Murray WR, Blatchford M. A risk score to predict need for treatment for upper-gastrointestinal haemorrhage. Lancet 2000;356:1318-1321 (items and points as reproduced in Am Fam Physician 2001;63:1415, World J Gastroenterol 2017;23:7450 Table 1 and World J Gastrointest Pharmacol Ther 2015;6:172 Table 2)."
_CHENG_2012 = "Cheng DW et al. A modified Glasgow Blatchford Score improves risk stratification in upper gastrointestinal bleed. Aliment Pharmacol Ther 2012;36:782-789 (the item list as described by Shahrami A et al., Emerg 2018: urea, haemoglobin, systolic pressure and pulse only; Cheng's full text was not read)."
_GBS_UREA = Num("urea_nitrogen", "Blood urea (mmol/L) or blood urea nitrogen (mg/dL)", "urea_nitrogen", lo=1, hi=400, band_unit="mg/dL",
                bands=[B("<18.2", 0, lt=18.2), B("18.2 to <22.4", 2, ge=18.2, lt=22.4), B("22.4 to <28.0", 3, ge=22.4, lt=28.0), B("28.0 to <70.0", 4, ge=28.0, lt=70.0), B(">=70.0", 6, ge=70.0)],
                alt_bands={"mmol/L": [B("<6.5", 0, lt=6.5), B("6.5 to <8.0", 2, ge=6.5, lt=8.0), B("8.0 to <10.0", 3, ge=8.0, lt=10.0), B("10.0 to <25.0", 4, ge=10.0, lt=25.0), B(">=25.0", 6, ge=25.0)]},
                note="mmol/L is blood urea as the Lancet paper printed it; mg/dL is the urea-nitrogen equivalent (x2.8) as the American Family Physician summary states it")
_GBS_SBP = Num("systolic_bp", "Systolic blood pressure", "pressure", lo=20, hi=350, bands=[B(">=110", 0, ge=110), B("100-109", 1, ge=100, lt=110), B("90-99", 2, ge=90, lt=100), B("<90", 3, lt=90)])
_GBS_PULSE = Num("heart_rate", "Pulse", "rate", lo=0, hi=350, bare=True, bands=[B("<100", 0, lt=100), B(">=100", 1, ge=100)])
_GBS_HB_MEN = [B(">=13.0", 0, ge=13.0), B("12.0 to <13.0", 1, ge=12.0, lt=13.0), B("10.0 to <12.0", 3, ge=10.0, lt=12.0), B("<10.0", 6, lt=10.0)]
_GBS_HB_WOMEN = [B(">=12.0", 0, ge=12.0), B("10.0 to <12.0", 1, ge=10.0, lt=12.0), B("<10.0", 6, lt=10.0)]
_GBS_HB = Num("hemoglobin", "Haemoglobin", "hemoglobin", lo=1, hi=25, bands=_GBS_HB_MEN, band_unit="g/dL", note="scored against the table for the sex given")


def _gbs_version(version_id, label, source, full):
    items = ["urea_nitrogen", "hemoglobin", "sex", "systolic_bp", "heart_rate"] + (["melaena", "syncope", "hepatic_disease", "cardiac_failure"] if full else [])

    def compute(ctx):
        rows = [ctx.scored_row("urea_nitrogen")]
        hb = ctx.parsed["hemoglobin"]
        table = _GBS_HB_WOMEN if ctx.value("sex") == "female" else _GBS_HB_MEN
        points = next(p for _rule, test, p in table if test(hb.value))
        rule = next(r for r, test, _p in table if test(hb.value))
        rows.append(ctx.row("hemoglobin", "%s g/dL (%s): %s" % (rule, ctx.value("sex"), "%+d" % points if points else "0"), points))
        rows.append(ctx.row("sex", "selects the haemoglobin table"))
        rows += [ctx.scored_row("systolic_bp"), ctx.scored_row("heart_rate")]
        if full:
            rows += [ctx.scored_row(i) for i in ("melaena", "syncope", "hepatic_disease", "cardiac_failure")]
        total = sum(row.get("points", 0) for row in rows)
        category = ("0: lowest risk (any patient scoring above 0 is at risk of needing an intervention)" if total == 0 else
                    "1: within the 0-1 low-risk threshold some guidelines use for outpatient management" if total == 1 else
                    "2 or more: above the low-risk thresholds" if total < 6 or not full else
                    "6 or more: more than 50% risk of needing an intervention in the validation group")
        return Outcome(total, "points", category=category, rows=rows, formula="sum of the item points (maximum %d)" % (23 if full else 16))
    return Version(version_id, label, source, compute, items)


_add(Scale("glasgow_blatchford", "Glasgow-Blatchford score", "Gastroenterology",
           [_GBS_UREA, _GBS_HB, Choice("sex", "Sex (selects the haemoglobin table)", [("male", "male", 0), ("female", "female", 0)]), _GBS_SBP, _GBS_PULSE,
            Bool("melaena", "Presentation with melaena", 1), Bool("syncope", "Presentation with syncope", 2), Bool("hepatic_disease", "Hepatic disease (history or clinical or laboratory evidence)", 2),
            Bool("cardiac_failure", "Cardiac failure (history or clinical or echocardiographic evidence)", 2)],
           [_gbs_version("glasgow_blatchford", "Glasgow-Blatchford score (0-23)", _BLATCHFORD_2000, True),
            _gbs_version("modified", "Modified Glasgow-Blatchford (urea, haemoglobin, systolic pressure, pulse; 0-16)", _CHENG_2012, False)],
           source=_BLATCHFORD_2000, scope="Adults with suspected upper gastrointestinal bleeding at presentation, before endoscopy.", aliases=("blatchford", "gbs", "upper gi bleed", "glasgow blatchford bleeding score"),
           bands={"0": "lowest risk", ">=6": ">50% risk of needing an intervention"}))


# ---------------------------------------------------------------------------------------------------------------
# SOFA
# ---------------------------------------------------------------------------------------------------------------

_SOFA = ("Singer M et al. Sepsis-3. JAMA 2016;315:801-810, Table 1 (adapted from Vincent JL et al. The SOFA score to describe organ dysfunction/failure. Intensive Care Med 1996;22:707-710).")
_DOSE = "ug/kg/min"


def _sofa(ctx):
    rows = []

    def add(item, points, rule):
        rows.append(ctx.row(item, "%s: %s" % (rule, "%+d" % points if points else "0"), points))
        return points

    pf, support = ctx.value("pao2_fio2"), ctx.value("respiratory_support")
    resp = 0 if pf >= 400 else 1 if pf >= 300 else 2 if pf >= 200 else (3 if support and pf >= 100 else 4 if support else 2)
    rule = ("PaO2/FiO2 >=400" if pf >= 400 else "PaO2/FiO2 <400" if pf >= 300 else "PaO2/FiO2 <300" if pf >= 200 else
            ("PaO2/FiO2 <200 with respiratory support" if pf >= 100 else "PaO2/FiO2 <100 with respiratory support") if support else "PaO2/FiO2 <200 without respiratory support scores as <300")
    r = add("pao2_fio2", resp, rule)
    rows.append(ctx.row("respiratory_support", "scores 3 and 4 need respiratory support"))
    plt = ctx.value("platelets")
    p = add("platelets", 0 if plt >= 150 else 1 if plt >= 100 else 2 if plt >= 50 else 3 if plt >= 20 else 4,
            ">=150 x10^9/L" if plt >= 150 else "<150" if plt >= 100 else "<100" if plt >= 50 else "<50" if plt >= 20 else "<20")
    bp = ctx.parsed["bilirubin"]
    if bp.unit == "umol/L":   # the 2016 table prints umol/L cut-offs of its own (20, 33, 102, 204); compared as printed
        v = bp.native
        b = add("bilirubin", 0 if v < 20 else 1 if v < 33 else 2 if v < 102 else 3 if v <= 204 else 4,
                "<20 umol/L" if v < 20 else "20-32" if v < 33 else "33-101" if v < 102 else "102-204" if v <= 204 else ">204")
    else:
        v = bp.value
        b = add("bilirubin", 0 if v < 1.2 else 1 if v < 2.0 else 2 if v < 6.0 else 3 if v < 12.0 else 4,
                "<1.2 mg/dL" if v < 1.2 else "1.2-1.9" if v < 2.0 else "2.0-5.9" if v < 6.0 else "6.0-11.9" if v < 12.0 else ">=12.0")
    mapp, dop, dob, epi, nor = ctx.value("mean_arterial_pressure"), ctx.value("dopamine"), ctx.value("dobutamine"), ctx.value("epinephrine"), ctx.value("norepinephrine")
    if dop > 15 or epi > 0.1 or nor > 0.1:
        cv, rule = 4, "dopamine >15 or epinephrine >0.1 or norepinephrine >0.1 ug/kg/min"
    elif dop > 5 or epi > 0 or nor > 0:
        cv, rule = 3, "dopamine >5 to 15 or epinephrine <=0.1 or norepinephrine <=0.1 ug/kg/min"
    elif dop > 0 or dob > 0:
        cv, rule = 2, "dopamine up to 5 or dobutamine at any dose"
    elif mapp < 70:
        cv, rule = 1, "MAP <70 mmHg"
    else:
        cv, rule = 0, "MAP >=70 mmHg and no vasoactive drug"
    c = add("mean_arterial_pressure", cv, rule)
    rows += [ctx.row(i) for i in ("dopamine", "dobutamine", "epinephrine", "norepinephrine")]
    gcs = ctx.value("glasgow_coma_scale")
    n = add("glasgow_coma_scale", 0 if gcs == 15 else 1 if gcs >= 13 else 2 if gcs >= 10 else 3 if gcs >= 6 else 4,
            "15" if gcs == 15 else "13-14" if gcs >= 13 else "10-12" if gcs >= 10 else "6-9" if gcs >= 6 else "<6")
    cp = ctx.parsed["creatinine"]
    if cp.unit == "umol/L":
        v = cp.native
        renal = 0 if v < 110 else 1 if v < 171 else 2 if v < 300 else 3 if v <= 440 else 4
        rule = "<110 umol/L" if v < 110 else "110-170" if v < 171 else "171-299" if v < 300 else "300-440" if v <= 440 else ">440"
    else:
        v = cp.value
        renal = 0 if v < 1.2 else 1 if v < 2.0 else 2 if v < 3.5 else 3 if v < 5.0 else 4
        rule = "<1.2 mg/dL" if v < 1.2 else "1.2-1.9" if v < 2.0 else "2.0-3.4" if v < 3.5 else "3.5-4.9" if v < 5.0 else ">=5.0"
    notes = []
    if ctx.has("urine_output"):
        uo = ctx.value("urine_output")
        by_urine = 4 if uo < 200 else 3 if uo < 500 else 0
        if by_urine > renal:
            renal, rule = by_urine, "urine output %g mL/day" % uo
        rows.append(ctx.row("urine_output"))
    else:
        notes.append("Urine output was not given; the renal points come from creatinine alone (urine output <500 mL/day scores 3 and <200 scores 4).")
    k = add("creatinine", renal, rule)
    total = r + p + b + c + n + k
    organ = {"respiration": r, "coagulation": p, "liver": b, "cardiovascular": c, "central_nervous_system": n, "renal": k}
    return Outcome(total, "points", rows=rows, steps={"organ_scores": organ}, notes=notes,
                   formula="sum of six organ scores, 0-4 each (worst value of the period); an acute rise of 2 or more points from baseline indicates organ dysfunction (Sepsis-3), baseline assumed 0 if no known pre-existing dysfunction",
                   constants=[constant("catecholamine dose unit", "ug/kg/min, for at least 1 hour", _SOFA)])


_add(Scale("sofa", "SOFA score (Sequential Organ Failure Assessment)", "Critical care",
           [Num("pao2_fio2", "PaO2/FiO2", "pressure", lo=10, hi=800, note="mmHg (kPa accepted: 53.3 kPa = 400 mmHg)"),
            Bool("respiratory_support", "On respiratory support (mechanical ventilation, including CPAP)", 0),
            Num("platelets", "Platelet count", "count", lo=0, hi=3000), Num("bilirubin", "Total bilirubin", "bilirubin", lo=0.05, hi=80),
            Num("mean_arterial_pressure", "Mean arterial pressure", "pressure", lo=10, hi=250),
            Num("dopamine", "Dopamine dose (0 if none)", "dose_rate_mass", lo=0, hi=100, absent_value=0.0),
            Num("dobutamine", "Dobutamine dose (0 if none; any dose scores 2)", "dose_rate_mass", lo=0, hi=100, absent_value=0.0),
            Num("epinephrine", "Epinephrine dose (0 if none)", "dose_rate_mass", lo=0, hi=20, absent_value=0.0),
            Num("norepinephrine", "Norepinephrine dose (0 if none)", "dose_rate_mass", lo=0, hi=20, absent_value=0.0),
            Num("glasgow_coma_scale", "Glasgow Coma Scale total", "number", lo=3, hi=15, bare=True, integer=True),
            Num("creatinine", "Serum creatinine", "creatinine", lo=0.05, hi=60),
            Num("urine_output", "Urine output (optional; can raise the renal score)", "urine_volume", lo=0, hi=20000, required=False)],
           [Version("sepsis3_2016", "SOFA as tabulated in Sepsis-3 (JAMA 2016)", _SOFA, _sofa,
                    ("pao2_fio2", "respiratory_support", "platelets", "bilirubin", "mean_arterial_pressure", "dopamine", "dobutamine", "epinephrine", "norepinephrine", "glasgow_coma_scale", "creatinine"),
                    note="The 1996 table reads dopamine '<=5' and '>5' where 2016 prints '<5' and '5.1-15' (a dose of exactly 5 is unassigned in the 2016 print and scores 2 here), and '>400'/'>150' for score 0 where 2016 prints '>=400'/'>=150'.")],
           source=_SOFA, scope="Critically ill adults; use the worst value in the period and the catecholamine dose given for at least one hour. Higher scores are worse (maximum 24).",
           aliases=("sequential organ failure assessment", "sepsis-related organ failure assessment", "sepsis 3")))


# ---------------------------------------------------------------------------------------------------------------
# APACHE II
# ---------------------------------------------------------------------------------------------------------------

_KNAUS_1985 = "Knaus WA et al. APACHE II: a severity of disease classification system. Crit Care Med 1985;13:818-829 (table as transcribed in the Merck Manual Professional Edition 'APACHE II scoring system', adapted from Knaus 1985; the 1985 full text was not available)."


# (rule, test, points) tables, first match wins. Written from the highest abnormal value down, as the paper prints them.
_APS_TABLES = {
    "temperature": ("C", [(">=41", lambda x: x >= 41, 4), ("39-40.9", lambda x: x >= 39, 3), ("38.5-38.9", lambda x: x >= 38.5, 1), ("36-38.4", lambda x: x >= 36, 0),
                          ("34-35.9", lambda x: x >= 34, 1), ("32-33.9", lambda x: x >= 32, 2), ("30-31.9", lambda x: x >= 30, 3), ("<30", lambda x: True, 4)]),
    "mean_arterial_pressure": ("mmHg", [(">=160", lambda x: x >= 160, 4), ("130-159", lambda x: x >= 130, 3), ("110-129", lambda x: x >= 110, 2), ("70-109", lambda x: x >= 70, 0),
                                        ("50-69", lambda x: x >= 50, 2), ("<50", lambda x: True, 4)]),
    "heart_rate": ("/min", [(">=180", lambda x: x >= 180, 4), ("140-179", lambda x: x >= 140, 3), ("110-139", lambda x: x >= 110, 2), ("70-109", lambda x: x >= 70, 0),
                            ("55-69", lambda x: x >= 55, 2), ("40-54", lambda x: x >= 40, 3), ("<40", lambda x: True, 4)]),
    "respiratory_rate": ("/min", [(">=50", lambda x: x >= 50, 4), ("35-49", lambda x: x >= 35, 3), ("25-34", lambda x: x >= 25, 1), ("12-24", lambda x: x >= 12, 0),
                                  ("10-11", lambda x: x >= 10, 1), ("6-9", lambda x: x >= 6, 2), ("<6", lambda x: True, 4)]),
    "arterial_ph": ("", [(">=7.7", lambda x: x >= 7.7, 4), ("7.6-7.69", lambda x: x >= 7.6, 3), ("7.5-7.59", lambda x: x >= 7.5, 1), ("7.33-7.49", lambda x: x >= 7.33, 0),
                         ("7.25-7.32", lambda x: x >= 7.25, 2), ("7.15-7.24", lambda x: x >= 7.15, 3), ("<7.15", lambda x: True, 4)]),
    "sodium": ("mmol/L", [(">=180", lambda x: x >= 180, 4), ("160-179", lambda x: x >= 160, 3), ("155-159", lambda x: x >= 155, 2), ("150-154", lambda x: x >= 150, 1), ("130-149", lambda x: x >= 130, 0),
                           ("120-129", lambda x: x >= 120, 2), ("111-119", lambda x: x >= 111, 3), ("<=110", lambda x: True, 4)]),
    "potassium": ("mmol/L", [(">=7", lambda x: x >= 7, 4), ("6-6.9", lambda x: x >= 6, 3), ("5.5-5.9", lambda x: x >= 5.5, 1), ("3.5-5.4", lambda x: x >= 3.5, 0), ("3-3.4", lambda x: x >= 3, 1),
                             ("2.5-2.9", lambda x: x >= 2.5, 2), ("<2.5", lambda x: True, 4)]),
    "creatinine": ("mg/dL", [(">=3.5", lambda x: x >= 3.5, 4), ("2-3.4", lambda x: x >= 2, 3), ("1.5-1.9", lambda x: x >= 1.5, 2), ("0.6-1.4", lambda x: x >= 0.6, 0), ("<0.6", lambda x: True, 2)]),
    "hematocrit": ("%", [(">=60", lambda x: x >= 60, 4), ("50-59.9", lambda x: x >= 50, 2), ("46-49.9", lambda x: x >= 46, 1), ("30-45.9", lambda x: x >= 30, 0), ("20-29.9", lambda x: x >= 20, 2), ("<20", lambda x: True, 4)]),
    "wbc": ("x10^9/L", [(">=40", lambda x: x >= 40, 4), ("20-39.9", lambda x: x >= 20, 2), ("15-19.9", lambda x: x >= 15, 1), ("3-14.9", lambda x: x >= 3, 0), ("1-2.9", lambda x: x >= 1, 2), ("<1", lambda x: True, 4)]),
    "serum_bicarbonate": ("mmol/L", [(">=52", lambda x: x >= 52, 4), ("41-51.9", lambda x: x >= 41, 3), ("32-40.9", lambda x: x >= 32, 1), ("22-31.9", lambda x: x >= 22, 0), ("18-21.9", lambda x: x >= 18, 2),
                                     ("15-17.9", lambda x: x >= 15, 3), ("<15", lambda x: True, 4)]),
    "age": ("years", [("75 or older", lambda x: x >= 75, 6), ("65-74", lambda x: x >= 65, 5), ("55-64", lambda x: x >= 55, 3), ("45-54", lambda x: x >= 45, 2), ("up to 44", lambda x: True, 0)]),
}
_APACHE_MORTALITY = {
    "Knaus 1985 as printed by the Merck Manual calculator: non-operative / post-operative death rate (%)": {
        "0-4": "4 / 1", "5-9": "8 / 3", "10-14": "15 / 7", "15-19": "24 / 12 (other copies print 25 for non-operative)", "20-24": "40 / 30", "25-29": "55 / 35", "30-34": "about 73 / about 73", ">=35": "85 / 88"}}


def _apache_ii(ctx):
    rows = []
    notes = ["A measurement that was not taken is scored 0 only when the caller named it in assume_absent; that convention is the trial worksheets', not stated in the 1985 paper."] if ctx.assumed else []

    def score(item, table_key=None):
        parsed = ctx.parsed[item]
        if parsed.forced_points is not None:
            rows.append(ctx.row(item, "not measured, scored 0", 0))
            return 0
        _unit, table = _APS_TABLES[table_key or item]
        for rule, test, points in table:
            if test(parsed.value):
                rows.append(ctx.row(item, "%s: %s" % (rule, "%+d" % points if points else "0"), points))
                return points
        raise AssertionError(item)

    total_aps = 0
    for item in ("temperature", "mean_arterial_pressure", "heart_rate", "respiratory_rate"):
        total_aps += score(item)
    # oxygenation: A-aDO2 when FiO2 >= 0.5, PaO2 when below
    fio2 = ctx.value("fio2")
    rows.append(ctx.row("fio2"))
    needed = "aado2" if fio2 >= 0.5 else "pao2"
    if not ctx.has(needed):
        if needed in ctx.requested_absent:
            rows.append({"item": needed, "input": "assumed absent", "assumed_absent": True, "points": 0, "rule": "not measured, scored 0"})
            ox = 0
        else:
            raise ScoreError(MISSING_INPUTS, "With FiO2 %s the oxygenation is scored from %s, which was not given." % ("0.5 or above" if fio2 >= 0.5 else "below 0.5", needed),
                             {"missing": [needed], "computed": False, "why": "FiO2 >= 0.5 is scored from the A-aDO2, below 0.5 from the PaO2", "can_assume_absent": True})
    else:
        value = ctx.value(needed)
        if needed == "aado2":
            ox, rule = ((4, ">=500") if value >= 500 else (3, "350-499") if value >= 350 else (2, "200-349") if value >= 200 else (0, "<200"))
        else:
            ox, rule = ((0, ">70") if value > 70 else (1, "61-70") if value >= 61 else (3, "55-60") if value >= 55 else (4, "<55"))
        rows.append(ctx.row(needed, "%s mmHg (FiO2 %s 0.5): %s" % (rule, ">=" if fio2 >= 0.5 else "<", "%+d" % ox if ox else "0"), ox))
    total_aps += ox
    # acid-base: arterial pH, or venous bicarbonate when no blood gas was taken
    ph = ctx.parsed["arterial_ph"]
    if ph.forced_points is not None and ctx.has("serum_bicarbonate"):
        total_aps += score("serum_bicarbonate")
        rows.append(ctx.row("arterial_ph", "no arterial pH: venous bicarbonate scored instead"))
    else:
        total_aps += score("arterial_ph")
    for item in ("sodium", "potassium"):
        total_aps += score(item)
    cr_points = score("creatinine")
    total_aps += cr_points
    if ctx.value("acute_renal_failure") and ctx.parsed["creatinine"].forced_points is None:
        total_aps += cr_points
        rows.append(ctx.row("acute_renal_failure", "acute renal failure doubles the creatinine points: +%d" % cr_points, cr_points))
    else:
        rows.append(ctx.row("acute_renal_failure", "creatinine points not doubled"))
    for item in ("hematocrit", "wbc"):
        total_aps += score(item)
    gcs = ctx.parsed["glasgow_coma_scale"]
    if gcs.forced_points is not None:
        rows.append(ctx.row("glasgow_coma_scale", "not measured, scored 0", 0))
        gcs_points = 0
    else:
        gcs_points = 15 - int(gcs.value)
        rows.append(ctx.row("glasgow_coma_scale", "15 - GCS = %d" % gcs_points, gcs_points))
    total_aps += gcs_points
    age_points = score("age")
    chronic = 0
    if ctx.value("severe_organ_insufficiency_or_immunocompromised"):
        chronic = 2 if ctx.value("admission_type") == "elective_postoperative" else 5
    rows.append(ctx.row("severe_organ_insufficiency_or_immunocompromised", "chronic health points: %s" % (
        "none" if not chronic else "%d (%s)" % (chronic, "elective postoperative" if chronic == 2 else "non-operative or emergency postoperative")), chronic))
    rows.append(ctx.row("admission_type"))
    total = total_aps + age_points + chronic
    return Outcome(total, "points", rows=rows, notes=notes,
                   steps={"acute_physiology_score": total_aps, "age_points": age_points, "chronic_health_points": chronic},
                   formula="acute physiology score (12 variables, worst value in the first 24 h) + age points + chronic health points",
                   extra={"score_to_hospital_death_rate": _APACHE_MORTALITY})


_APACHE_ITEMS = [
    Num("temperature", "Rectal (core) temperature, worst in 24 h", "temperature", lo=20, hi=46, absent_points=0),
    Num("mean_arterial_pressure", "Mean arterial pressure", "pressure", lo=10, hi=300, absent_points=0),
    Num("heart_rate", "Heart rate (ventricular response)", "rate", lo=0, hi=350, bare=True, absent_points=0),
    Num("respiratory_rate", "Respiratory rate (ventilated or not)", "rate", lo=0, hi=120, bare=True, absent_points=0),
    Num("fio2", "FiO2", "fraction", lo=0.15, hi=1.0, note="a fraction (0.21-1.0) or a percentage written with %"),
    Num("pao2", "PaO2 (used when FiO2 is below 0.5)", "pressure", lo=10, hi=700, required=False),
    Num("aado2", "A-aDO2 (used when FiO2 is 0.5 or above)", "pressure", lo=0, hi=800, required=False),
    Num("arterial_ph", "Arterial pH", "ratio", lo=6.5, hi=8.0, bare=True, absent_points=0),
    Num("serum_bicarbonate", "Venous serum bicarbonate (only when no arterial blood gas was taken)", "electrolyte", lo=2, hi=60, required=False),
    Num("sodium", "Serum sodium", "electrolyte", lo=80, hi=200, absent_points=0),
    Num("potassium", "Serum potassium", "electrolyte", lo=1, hi=12, absent_points=0),
    Num("creatinine", "Serum creatinine", "creatinine", lo=0.05, hi=60, absent_points=0),
    Bool("acute_renal_failure", "Acute renal failure (doubles the creatinine points)", 0),
    Num("hematocrit", "Haematocrit", "percent", lo=5, hi=80, absent_points=0),
    Num("wbc", "White blood cell count", "count", lo=0, hi=1000, absent_points=0),
    Num("glasgow_coma_scale", "Glasgow Coma Scale total (the points are 15 minus it)", "number", lo=3, hi=15, bare=True, integer=True, absent_points=0),
    Num("age", "Age", "age", lo=0, hi=130, bare=True),
    Bool("severe_organ_insufficiency_or_immunocompromised", "Severe organ insufficiency or immunocompromised state that preceded this admission (biopsy-proven cirrhosis with portal hypertension or hepatic failure history; NYHA class IV; severe chronic respiratory disease or ventilator dependence; chronic dialysis; immunosuppression)", 0),
    Choice("admission_type", "Admission type", [("non_operative", "non-operative", 0), ("emergency_postoperative", "emergency postoperative", 0), ("elective_postoperative", "elective postoperative", 0)]),
]
_add(Scale("apache_ii", "APACHE II", "Critical care", _APACHE_ITEMS,
           [Version("knaus_1985", "APACHE II (Knaus 1985)", _KNAUS_1985, _apache_ii,
                    ("temperature", "mean_arterial_pressure", "heart_rate", "respiratory_rate", "fio2", "arterial_ph", "sodium", "potassium", "creatinine", "acute_renal_failure",
                     "hematocrit", "wbc", "glasgow_coma_scale", "age", "severe_organ_insufficiency_or_immunocompromised", "admission_type"))],
           source=_KNAUS_1985, scope="Adult ICU patients, worst value in the first 24 hours. The diagnosis-weighted predicted death rate is not computed: its weights were found only in one secondary transcription.",
           aliases=("apache 2", "acute physiology and chronic health evaluation"), bands={"0-71": "higher is worse"}))


_FINE_1997 = ("Fine MJ et al. A prediction rule to identify low-risk patients with community-acquired pneumonia. N Engl J Med 1997;336:243-250 "
              "(points as tabulated in J Fam Pract 2008;57:195, Table 2 and the Merck Manual Professional table, both from Fine 1997; the 1997 paper was not readable).")
_PSI_COHORTS = {1: (0.1, 0.1), 2: (0.6, 0.6), 3: (0.9, 2.8), 4: (9.3, 8.2), 5: (27.0, 29.2)}


def _psi(ctx):
    rows = []
    age, female = ctx.value("age"), ctx.value("sex") == "female"
    comorbid = ("neoplastic_disease", "liver_disease", "congestive_heart_failure", "cerebrovascular_disease", "renal_disease")
    exam = ("altered_mental_status", "respiratory_rate", "systolic_bp", "temperature", "heart_rate")

    def flagged(item):
        value = ctx.value(item)
        return {"respiratory_rate": lambda: value >= 30, "systolic_bp": lambda: value < 90, "temperature": lambda: value < 35 or value >= 40,
                "heart_rate": lambda: value >= 125}.get(item, lambda: bool(value))()

    step1 = age <= 50 and not any(flagged(i) for i in comorbid + exam)
    if step1:
        for item in ("age", "sex") + comorbid + exam:
            rows.append(ctx.row(item))
        cls = 1
        return Outcome("Class I", "", category="lowest risk: age 50 or under, none of the five comorbid conditions and none of the five examination findings, so no points are summed",
                       rows=rows, steps={"risk_class": cls}, formula="step 1 of the rule: class I when age is 50 or under and none of the comorbid conditions or examination findings is present",
                       extra={"thirty_day_mortality_percent_by_cohort": {"PORT cohort (n=2287)": _PSI_COHORTS[1][0], "MedisGroups validation cohort (n=38039)": _PSI_COHORTS[1][1]}})
    # step 2: points; the laboratory and radiographic items are needed here and only here
    labs = ("arterial_ph", "urea_nitrogen", "sodium", "glucose", "hematocrit", "pleural_effusion")
    need = [item for item in labs if not ctx.has(item) and item not in ctx.requested_absent]
    if not (ctx.has("pao2") or ctx.has("oxygen_saturation") or {"pao2", "oxygen_saturation"} & ctx.requested_absent):
        need.append("pao2 or oxygen_saturation")
    if need:
        raise ScoreError(MISSING_INPUTS, "Not risk class I, so the laboratory and radiographic points are needed: %s." % ", ".join(need),
                         {"missing": need, "computed": False, "can_assume_absent": True, "why": "class I (age 50 or under, no comorbid condition, no examination finding) needs no laboratory values"})
    total = (age - 10 if female else age)
    rows.append(ctx.row("age", "%s: %+d" % ("women: age minus 10" if female else "men: age in years", total), total))
    rows.append(ctx.row("sex", "selects the age points"))

    def add(item, points, rule):
        nonlocal total
        total += points
        rows.append(ctx.row(item, "%s: %s" % (rule, "%+d" % points if points else "0"), points))

    for item, points in (("nursing_home_resident", 10), ("neoplastic_disease", 30), ("liver_disease", 20), ("congestive_heart_failure", 10), ("cerebrovascular_disease", 10),
                         ("renal_disease", 10), ("altered_mental_status", 20)):
        value = ctx.value(item)
        add(item, points if value else 0, "present" if value else "absent")
    add("respiratory_rate", 20 if ctx.value("respiratory_rate") >= 30 else 0, "respiratory rate >=30/min")
    add("systolic_bp", 20 if ctx.value("systolic_bp") < 90 else 0, "systolic pressure <90 mmHg")
    t = ctx.value("temperature")
    add("temperature", 15 if (t < 35 or t >= 40) else 0, "temperature <35 C or >=40 C")
    add("heart_rate", 10 if ctx.value("heart_rate") >= 125 else 0, "pulse >=125/min")

    def lab(item, points, test, rule, absent_rule="not measured, scored 0"):
        if ctx.has(item):
            add(item, points if test(ctx.parsed[item]) else 0, rule)
        else:
            rows.append({"item": item, "input": "assumed absent", "assumed_absent": True, "points": 0, "rule": absent_rule})

    lab("arterial_ph", 30, lambda p: p.value < 7.35, "arterial pH <7.35")
    lab("urea_nitrogen", 20, lambda p: (p.native >= 11 if p.unit == "mmol/L" else p.native >= 30), "blood urea nitrogen >=30 mg/dL (11 mmol/L)")
    lab("sodium", 20, lambda p: p.value < 130, "sodium <130 mmol/L")
    lab("glucose", 10, lambda p: (p.native >= 14 if p.unit == "mmol/L" else p.native >= 250), "glucose >=250 mg/dL (14 mmol/L)")
    lab("hematocrit", 10, lambda p: p.value < 30, "haematocrit <30%")
    hypoxemic = (ctx.has("pao2") and ctx.value("pao2") < 60) or (ctx.has("oxygen_saturation") and ctx.value("oxygen_saturation") < 90)
    add("pao2", 10 if hypoxemic else 0, "PaO2 <60 mmHg or oxygen saturation <90%") if (ctx.has("pao2") or ctx.has("oxygen_saturation")) else rows.append(
        {"item": "pao2", "input": "assumed absent", "assumed_absent": True, "points": 0, "rule": "not measured, scored 0"})
    if ctx.has("oxygen_saturation"):
        rows.append(ctx.row("oxygen_saturation", "read with the PaO2 criterion"))
    lab("pleural_effusion", 10, lambda p: bool(p.value), "pleural effusion on the chest film")
    cls = 2 if total <= 70 else 3 if total <= 90 else 4 if total <= 130 else 5
    return Outcome(total, "points", category="risk class %s (%s points)" % (["", "I", "II", "III", "IV", "V"][cls], "<=70" if cls == 2 else "71-90" if cls == 3 else "91-130" if cls == 4 else ">130"),
                   rows=rows, steps={"risk_class": cls}, formula="age (men: years; women: years - 10) + the points of every present item (maximum nominal total 395)",
                   extra={"thirty_day_mortality_percent_by_cohort": {"PORT cohort (n=2287)": _PSI_COHORTS[cls][0], "MedisGroups validation cohort (n=38039)": _PSI_COHORTS[cls][1]},
                          "disposition_in_the_paper": "classes I-III outpatient, IV-V hospitalise (Fine 1997 as summarised in J Fam Pract 2008)"})


_add(Scale("psi_port", "Pneumonia Severity Index (PORT score)", "Respiratory",
           [Num("age", "Age", "age", lo=0, hi=130, bare=True), Choice("sex", "Sex", [("male", "male", 0), ("female", "female", 0)]), Bool("nursing_home_resident", "Nursing home resident", 10),
            Bool("neoplastic_disease", "Neoplastic disease (active cancer, other than basal or squamous cell skin cancer)", 30), Bool("liver_disease", "Liver disease (cirrhosis or other chronic liver disease)", 20),
            Bool("congestive_heart_failure", "Congestive heart failure", 10), Bool("cerebrovascular_disease", "Cerebrovascular disease", 10), Bool("renal_disease", "Renal disease", 10),
            Bool("altered_mental_status", "Altered mental status", 20), Num("respiratory_rate", "Respiratory rate", "rate", lo=0, hi=120, bare=True),
            Num("systolic_bp", "Systolic blood pressure", "pressure", lo=20, hi=350), Num("temperature", "Temperature", "temperature", lo=20, hi=46),
            Num("heart_rate", "Pulse", "rate", lo=0, hi=350, bare=True),
            Num("arterial_ph", "Arterial pH", "ratio", lo=6.5, hi=8.0, bare=True, required=False, note="needed unless the patient is risk class I"),
            Num("urea_nitrogen", "Blood urea nitrogen (mg/dL) or urea (mmol/L)", "urea_nitrogen", lo=0.5, hi=400, required=False, note="needed unless the patient is risk class I"),
            Num("sodium", "Serum sodium", "electrolyte", lo=80, hi=200, required=False, note="needed unless the patient is risk class I"),
            Num("glucose", "Serum glucose", "glucose", lo=10, hi=3000, required=False, note="needed unless the patient is risk class I"),
            Num("hematocrit", "Haematocrit", "percent", lo=5, hi=80, required=False, note="needed unless the patient is risk class I"),
            Num("pao2", "Arterial PaO2", "pressure", lo=10, hi=700, required=False, note="PaO2 or oxygen saturation is needed unless the patient is risk class I"),
            Num("oxygen_saturation", "Oxygen saturation", "percent", lo=30, hi=100, required=False),
            Bool("pleural_effusion", "Pleural effusion on the chest radiograph", 10, required=False, note="needed unless the patient is risk class I")],
           [Version("fine_1997", "Pneumonia Severity Index (Fine 1997)", _FINE_1997, _psi,
                    ("age", "sex", "nursing_home_resident", "neoplastic_disease", "liver_disease", "congestive_heart_failure", "cerebrovascular_disease", "renal_disease", "altered_mental_status",
                     "respiratory_rate", "systolic_bp", "temperature", "heart_rate"))],
           source=_FINE_1997, scope="Adults with community-acquired pneumonia. Risk class I is assigned by the stepwise rule (age 50 or under and no comorbid condition or examination finding) and needs no laboratory values; "
                                      "otherwise points are summed. The paper's definitions of altered mental status and the comorbid conditions were not available.",
           aliases=("psi", "port score", "pneumonia severity index", "fine score"), bands={"class I": "rule", "<=70": "II", "71-90": "III", "91-130": "IV", ">130": "V"}))


# ---------------------------------------------------------------------------------------------------------------
# Framingham risk score for "hard" coronary heart disease (NCEP ATP III)
# ---------------------------------------------------------------------------------------------------------------

_ATP3 = ("NCEP Expert Panel. Third Report on Detection, Evaluation, and Treatment of High Blood Cholesterol in Adults (ATP III) Final Report, NIH 02-5215, 2002, Tables III.1-5 and III.1-6 "
         "(the same tables in the NHLBI Quick Desk Reference 01-3305 and on the Framingham Heart Study page 'Hard Coronary Heart Disease (10-year risk)').")
_FHS_COX = "Framingham Heart Study, 'Hard Coronary Heart Disease (10-year risk)' (ATP III, JAMA 2001), the HARD CHD FUNCTION table of coefficients, means and average 10-year survival."
# points by age band (20-34, 35-39, ..., 75-79)
_AGE_BANDS = ((20, 34), (35, 39), (40, 44), (45, 49), (50, 54), (55, 59), (60, 64), (65, 69), (70, 74), (75, 79))
_FRAMINGHAM = {
    "male": {
        "age": (-9, -4, 0, 3, 6, 8, 10, 11, 12, 13),
        "cholesterol": {(0, 160): (0, 0, 0, 0, 0), (160, 200): (4, 3, 2, 1, 0), (200, 240): (7, 5, 3, 1, 0), (240, 280): (9, 6, 4, 2, 1), (280, 10 ** 6): (11, 8, 5, 3, 1)},
        "smoker": (8, 5, 3, 1, 1),
        "sbp": {(0, 120): (0, 0), (120, 130): (0, 1), (130, 140): (1, 2), (140, 160): (1, 2), (160, 10 ** 6): (2, 3)},
        "risk": {**{p: 1 for p in range(0, 5)}, 5: 2, 6: 2, 7: 3, 8: 4, 9: 5, 10: 6, 11: 8, 12: 10, 13: 12, 14: 16, 15: 20, 16: 25},
        "below": 0, "top": 17,
        "cox": {"ln_age": (52.009610, 3.8926095), "ln_total": (20.014077, 5.3441475), "ln_hdl": (-0.905964, 3.7731132), "ln_sbp": (1.305784, 4.8618212), "treated": (0.241549, 0.1180474),
                "smoker": (12.096316, 0.3356020), "ln_age_ln_total": (-4.605038, 20.8111562), "ln_age_smoker": (-2.843670, 1.2890301), "ln_age_sq": (-2.933230, 15.2144965),
                "survival": 0.940200, "smoker_age_cap": 70},
    },
    "female": {
        "age": (-7, -3, 0, 3, 6, 8, 10, 12, 14, 16),
        "cholesterol": {(0, 160): (0, 0, 0, 0, 0), (160, 200): (4, 3, 2, 1, 1), (200, 240): (8, 6, 4, 2, 1), (240, 280): (11, 8, 5, 3, 2), (280, 10 ** 6): (13, 10, 7, 4, 2)},
        "smoker": (9, 7, 4, 2, 1),
        "sbp": {(0, 120): (0, 0), (120, 130): (1, 3), (130, 140): (2, 4), (140, 160): (3, 5), (160, 10 ** 6): (4, 6)},
        "risk": {**{p: 1 for p in range(9, 13)}, 13: 2, 14: 2, 15: 3, 16: 4, 17: 5, 18: 6, 19: 8, 20: 11, 21: 14, 22: 17, 23: 22, 24: 27},
        "below": 9, "top": 25,
        "cox": {"ln_age": (31.764001, 3.9213204), "ln_total": (22.465206, 5.3628984), "ln_hdl": (-1.187731, 4.0146369), "ln_sbp": (2.552905, 4.8376494), "treated": (0.420251, 0.1428020),
                "smoker": (13.075430, 0.3236202), "ln_age_ln_total": (-5.060998, 21.0557746), "ln_age_smoker": (-2.996945, 1.2519882),
                "survival": 0.987670, "smoker_age_cap": 78},
    },
}


def _framingham_inputs(ctx):
    sex, age = ctx.value("sex"), ctx.value("age")
    if not 30 <= age < 80:
        raise ScoreError(NOT_APPLICABLE, "The ATP III hard-CHD risk is defined for ages 30 to 79 (the tables list younger bands only for extrapolation).", {"item": "age"})
    return sex, age, ctx.value("total_cholesterol"), ctx.value("hdl_cholesterol"), ctx.value("systolic_bp"), ctx.value("bp_treated"), ctx.value("smoker")


def _framingham_points(ctx):
    sex, age, tc, hdl, sbp, treated, smoker = _framingham_inputs(ctx)
    t = _FRAMINGHAM[sex]
    band = next(i for i, (lo, hi) in enumerate(_AGE_BANDS) if lo <= age <= hi + 0.999999)
    decade = band // 2   # 20-39, 40-49, 50-59, 60-69, 70-79
    age_points = t["age"][band]
    tc_points = next(v[decade] for (lo, hi), v in t["cholesterol"].items() if lo <= tc < hi)
    smoke_points = t["smoker"][decade] if smoker else 0
    hdl_points = -1 if hdl >= 60 else 0 if hdl >= 50 else 1 if hdl >= 40 else 2
    sbp_points = next(v[1 if treated else 0] for (lo, hi), v in t["sbp"].items() if lo <= sbp < hi)
    total = age_points + tc_points + smoke_points + hdl_points + sbp_points
    if total < t["below"]:
        risk, shown = "<1%", "less than 1%"
    elif total >= t["top"]:
        risk, shown = ">=30%", "30% or more"
    else:
        risk, shown = "%d%%" % t["risk"][total], "%d%%" % t["risk"][total]
    rows = [ctx.row("sex"), ctx.row("age", "age band %d-%d: %+d" % (*_AGE_BANDS[band], age_points), age_points),
            ctx.row("total_cholesterol", "total cholesterol %g mg/dL at ages %s: %+d" % (tc, ("20-39", "40-49", "50-59", "60-69", "70-79")[decade], tc_points), tc_points),
            ctx.row("smoker", "smoker at ages %s: %+d" % (("20-39", "40-49", "50-59", "60-69", "70-79")[decade], smoke_points) if smoker else "non-smoker: 0", smoke_points),
            ctx.row("hdl_cholesterol", "HDL %g mg/dL: %+d" % (hdl, hdl_points), hdl_points),
            ctx.row("systolic_bp", "systolic %g mmHg, %s: %+d" % (sbp, "treated" if treated else "untreated", sbp_points), sbp_points), ctx.row("bp_treated")]
    return Outcome(total, "points", category="10-year risk of myocardial infarction or coronary death: %s" % shown, rows=rows, formula="sum of the ATP III point tables, read off the 10-year risk table",
                   steps={"ten_year_risk": risk}, rounding="whole-percent bands; below the lowest and above the highest row the table gives <1% and >=30%",
                   constants=[constant("point and risk tables", "ATP III Tables III.1-5 (men) and III.1-6 (women)", _ATP3)],
                   notes=["Smoking means any cigarette smoking in the past month; blood pressure is the average of recent values whether or not treated; cholesterol is the average of at least two measurements (ATP III)."])


def _framingham_cox(treated_any_sbp):
    def compute(ctx):
        sex, age, tc, hdl, sbp, treated, smoker = _framingham_inputs(ctx)
        c = _FRAMINGHAM[sex]["cox"]
        ln_age = math.log(age)
        flag = 1 if (treated and (treated_any_sbp or sbp > 120)) else 0
        age_for_smoker = math.log(min(age, c["smoker_age_cap"]))
        values = {"ln_age": ln_age, "ln_total": math.log(tc), "ln_hdl": math.log(hdl), "ln_sbp": math.log(sbp), "treated": flag, "smoker": 1 if smoker else 0,
                  "ln_age_ln_total": ln_age * math.log(tc), "ln_age_smoker": age_for_smoker * (1 if smoker else 0)}
        if sex == "male":
            values["ln_age_sq"] = ln_age ** 2
        linear = sum(c[name][0] * value for name, value in values.items())
        centred = sum(c[name][0] * c[name][1] for name in values)
        risk = 1 - c["survival"] ** math.exp(linear - centred)
        return Outcome(round_half_up(100 * risk, 1), "%", unrounded=100 * risk, rounding="1 decimal",
                       category="10-year risk of myocardial infarction or coronary death (continuous ATP III function)",
                       formula="risk = 1 - S0^exp(sum(b x) - sum(b x_mean)), x = ln(age), ln(total), ln(HDL), ln(SBP), treated flag, smoker, ln(age) x ln(total), ln(age) x smoker%s" % (", ln(age)^2 (men)" if sex == "male" else ""),
                       constants=[constant("coefficients and means (%s)" % sex, ", ".join("%s %g/%g" % (name, c[name][0], c[name][1]) for name in values), _FHS_COX),
                                  constant("average 10-year survival S0", c["survival"], _FHS_COX), constant("smoker x age cap", c["smoker_age_cap"], _FHS_COX + " ('If Age > %d then use Ln(%d)*SMOKER')" % (c["smoker_age_cap"], c["smoker_age_cap"]))],
                       rows=[ctx.row(i) for i in ("sex", "age", "total_cholesterol", "hdl_cholesterol", "systolic_bp", "bp_treated", "smoker")],
                       steps={"linear_predictor": linear, "mean_centred_term": centred, "treated_flag": flag},
                       notes=["The printed variable is 'TRT for HTN (SBP > 120)'; this version counts treatment only when systolic pressure is above 120, which matches the point tables (treated and untreated score alike below 120). "
                              "The page does not say so in words." if not treated_any_sbp else "This reading counts treatment at any systolic pressure."])
    return compute


_FRAMINGHAM_REQ = ("sex", "age", "total_cholesterol", "hdl_cholesterol", "systolic_bp", "bp_treated", "smoker")
_add(Scale("framingham_hard_chd", "Framingham 10-year risk of hard coronary heart disease (ATP III)", "Cardiology",
           [Choice("sex", "Sex", [("male", "male", 0), ("female", "female", 0)]), Num("age", "Age (30 to 79)", "age", lo=0, hi=130, bare=True),
            Num("total_cholesterol", "Total cholesterol", "cholesterol", lo=50, hi=1000), Num("hdl_cholesterol", "HDL cholesterol", "cholesterol", lo=5, hi=250),
            Num("systolic_bp", "Systolic blood pressure", "pressure", lo=60, hi=300), Bool("bp_treated", "Treated for hypertension", 0), Bool("smoker", "Cigarette smoker (any in the past month)", 0)],
           [Version("atp_iii_points", "ATP III point tables (paper-and-pencil)", _ATP3, _framingham_points, _FRAMINGHAM_REQ),
            Version("atp_iii_regression", "ATP III continuous (Cox) function; hypertension treatment counts above SBP 120", _FHS_COX, _framingham_cox(False), _FRAMINGHAM_REQ,
                    note="ATP III says the tables approximate the Framingham equations; the two differ by about one percentage point at the median and by up to ten or more at high point totals."),
            Version("atp_iii_regression_treatment_any_sbp", "ATP III continuous function; treatment flag at any systolic pressure", _FHS_COX, _framingham_cox(True), _FRAMINGHAM_REQ,
                    note="The source labels the flag 'TRT for HTN (SBP > 120)' without saying whether it applies below 120; this is the other reading.")],
           source=_ATP3 + " " + _FHS_COX, scope="Adults 30-79 free of coronary heart disease, diabetes and intermittent claudication; outcome is myocardial infarction plus coronary death (hard CHD), not total CHD.",
           aliases=("framingham", "framingham risk score", "atp iii", "10-year cardiovascular risk", "hard chd"), bands={"points": "10-year risk by table"}))


# ---------------------------------------------------------------------------------------------------------------
# Charlson comorbidity index
# ---------------------------------------------------------------------------------------------------------------

_CHARLSON_1987 = ("Charlson ME et al. A new method of classifying prognostic comorbidity in longitudinal studies: development and validation. J Chronic Dis 1987;40:373-383 "
                  "(weights 1, 2, 3 and 6 as listed by CASRAI and MDCalc, which agree; the 1987 paper's table was not readable).")
_CHARLSON_1994 = "Charlson M et al. Validation of a combined comorbidity index. J Clin Epidemiol 1994;47:1245-1251 (one point per decade of age from 50)."
_CCI_ITEMS = [
    Bool("myocardial_infarction", "History of definite or probable myocardial infarction (ECG and/or enzyme changes)", 1),
    Bool("congestive_heart_failure", "Congestive heart failure (exertional or paroxysmal nocturnal dyspnoea that responded to digitalis, diuretics or afterload reduction)", 1),
    Bool("peripheral_vascular_disease", "Peripheral vascular disease (claudication, bypass for arterial insufficiency, gangrene, or untreated aneurysm of 6 cm or more)", 1),
    Bool("cerebrovascular_disease", "Cerebrovascular disease (stroke with minor or no residua, or TIA)", 1),
    Bool("dementia", "Dementia (chronic cognitive deficit)", 1),
    Bool("chronic_pulmonary_disease", "Chronic pulmonary disease", 1),
    Bool("connective_tissue_disease", "Connective tissue disease", 1),
    Bool("peptic_ulcer_disease", "Peptic ulcer disease (any history of treatment for ulcer disease or ulcer bleeding)", 1),
    Choice("liver_disease", "Liver disease", [("none", "none", 0), ("mild", "mild: chronic hepatitis, or cirrhosis without portal hypertension", 1),
                                              ("moderate_to_severe", "moderate or severe: cirrhosis with portal hypertension, with or without variceal bleeding", 3)],
           aliases={"no": "none", "moderate": "moderate_to_severe", "severe": "moderate_to_severe"}, absent_key="none"),
    Choice("diabetes", "Diabetes mellitus", [("none", "none or diet-controlled", 0), ("uncomplicated", "treated, without end-organ damage", 1), ("end_organ_damage", "with end-organ damage", 2)],
           aliases={"no": "none", "diet_controlled": "none", "complicated": "end_organ_damage"}, absent_key="none"),
    Bool("hemiplegia", "Hemiplegia", 2),
    Bool("moderate_to_severe_renal_disease", "Moderate or severe renal disease (creatinine above 3 mg/dL, dialysis, kidney transplant, uraemia)", 2),
    Choice("solid_tumor", "Solid tumour", [("none", "none", 0), ("localized", "localised, without metastases", 2), ("metastatic", "metastatic", 6)],
           aliases={"no": "none", "non_metastatic": "localized"}, absent_key="none"),
    Bool("leukemia", "Leukaemia (acute or chronic)", 2), Bool("lymphoma", "Lymphoma", 2), Bool("aids", "AIDS (not HIV infection alone)", 6),
]
_CCI_REQ = tuple(item.id for item in _CCI_ITEMS)


def _charlson(age_adjusted):
    def compute(ctx):
        rows = [ctx.scored_row(item) for item in _CCI_REQ]
        comorbidity = sum(row["points"] for row in rows)
        total = comorbidity
        steps = {"comorbidity_points": comorbidity}
        if age_adjusted:
            age = ctx.value("age")
            points = 0 if age < 50 else 1 if age < 60 else 2 if age < 70 else 3 if age < 80 else 4
            rows.append(ctx.row("age", "%s: %s" % ("<50" if points == 0 else "%d-%d" % (40 + 10 * points, 49 + 10 * points) if points < 4 else ">=80", "%+d" % points if points else "0"), points))
            total += points
            steps["age_points"] = points
        survival = 0.983 ** math.exp(total * 0.9)
        return Outcome(total, "points", rows=rows, steps=steps,
                       formula="sum of the condition weights (1, 2, 3, 6)%s; maximum %d" % (" + 1 per decade of age from 50 (to +4 at 80 and over)" if age_adjusted else "", 37 if age_adjusted else 33),
                       extra={"ten_year_survival_estimate": {"value": round_half_up(survival, 4), "formula": "0.983 ^ exp(0.9 x CCI)",
                                                              "source": "as printed in secondary sources only (Janssen protocol NSMM-5001, Omni Calculator); the primary paper was not readable and it is not stated whether the age-adjusted score is meant"}})
    return compute


_add(Scale("charlson", "Charlson comorbidity index", "Comorbidity", [*_CCI_ITEMS, Num("age", "Age", "age", lo=0, hi=130, bare=True, required=False)],
           [Version("age_adjusted_1994", "Charlson index with the age points (Charlson 1994)", _CHARLSON_1987 + " " + _CHARLSON_1994, _charlson(True), _CCI_REQ + ("age",)),
            Version("comorbidity_only_1987", "Charlson comorbidity score without age (Charlson 1987)", _CHARLSON_1987, _charlson(False), _CCI_REQ,
                    note="Quan 2011 re-estimated the weights for 12 conditions on administrative data (five of them to 0); that update is not implemented because its weight table was not retrievable.")],
           source=_CHARLSON_1987 + " " + _CHARLSON_1994, scope="Adults. Liver disease, diabetes and solid tumour are single choices, so a pair is never scored twice. The ten-year survival formula is a secondary-source figure.",
           aliases=("cci", "charlson comorbidity", "age-adjusted charlson", "comorbidity index")))
