"""Multi-step clinical formulas: renal function, liver allocation, body size, electrolytes, dosing and dates.

Every constant sits next to its source. Where the literature holds more than one published form (the MDRD constant, the
corrected anion gap, an opioid conversion table), each form is a `Version` of the score: the default is stated, and the
result carries the others' values.
"""
from __future__ import annotations

import datetime
import math
import re

from clinical_score_kit import (INPUT_INVALID, NOT_APPLICABLE, UNIT_INVALID, Bool, Choice, Date, Item, Num, Outcome, Parsed, Scale, ScoreError,
                                Version, constant, round_half_up)

SCALES = []


def _add(scale):
    SCALES.append(scale)
    return scale


def _rows(ctx, version):
    return [ctx.row(item) for item in version.requires]


SEX = Choice("sex", "Sex (as the equation defines it)", [("male", "male", 0), ("female", "female", 0)])
AGE = Num("age", "Age", "age", lo=0, hi=130, bare=True, note="a plain number is read as years")
WEIGHT = Num("weight", "Body weight", "weight", lo=0.3, hi=650)
HEIGHT = Num("height", "Height", "height", lo=20, hi=275)
CREATININE = Num("creatinine", "Serum creatinine", "creatinine", lo=0.05, hi=60)


def _ln(value):
    return math.log(value)


# ---------------------------------------------------------------------------------------------------------------
# Renal function
# ---------------------------------------------------------------------------------------------------------------

_LEVEY_2009 = "Levey AS et al. A new equation to estimate glomerular filtration rate. Ann Intern Med 2009;150(9):604-612."
_INKER_2021 = "Inker LA et al. New creatinine- and cystatin C-based equations to estimate GFR without race. N Engl J Med 2021;385:1737-1749."
_EGFR_UNIT = "mL/min/1.73 m2"


def _ckd_epi_2009(age_base, source, version_id):
    def compute(ctx):
        scr, age, female, black = ctx.value("creatinine"), ctx.value("age"), ctx.value("sex") == "female", ctx.value("black_race")
        if age < 18:
            raise ScoreError(NOT_APPLICABLE, "CKD-EPI 2009 was derived and validated in adults (18 years and over).")
        kappa, alpha = (0.7, -0.329) if female else (0.9, -0.411)
        egfr = 141 * min(scr / kappa, 1) ** alpha * max(scr / kappa, 1) ** -1.209 * age_base ** age * (1.018 if female else 1) * (1.159 if black else 1)
        return Outcome(round_half_up(egfr, 1), _EGFR_UNIT, unrounded=egfr, rounding="1 decimal",
                       formula="141 x min(Scr/k, 1)^a x max(Scr/k, 1)^-1.209 x %s^age x 1.018 [female] x 1.159 [Black]" % age_base,
                       constants=[constant("k", kappa, source + " (0.7 women, 0.9 men)"), constant("a", alpha, source + " (-0.329 women, -0.411 men)"),
                                  constant("141", 141, source), constant("exponent of max", -1.209, source), constant("age base", age_base, source),
                                  constant("female factor", 1.018 if female else 1, source), constant("Black factor", 1.159 if black else 1, source)],
                       rows=_rows(ctx, ckd_epi_2009_versions[version_id]), steps={"min(Scr/k,1)": min(scr / kappa, 1), "max(Scr/k,1)": max(scr / kappa, 1)})
    return compute


def _ckd_epi_2021(ctx):
    scr, age, female = ctx.value("creatinine"), ctx.value("age"), ctx.value("sex") == "female"
    if age < 18:
        raise ScoreError(NOT_APPLICABLE, "CKD-EPI 2021 was derived and validated in adults (18 years and over).")
    kappa, alpha = (0.7, -0.241) if female else (0.9, -0.302)
    egfr = 142 * min(scr / kappa, 1) ** alpha * max(scr / kappa, 1) ** -1.200 * 0.9938 ** age * (1.012 if female else 1)
    return Outcome(round_half_up(egfr, 1), _EGFR_UNIT, unrounded=egfr, rounding="1 decimal",
                   formula="142 x min(Scr/k, 1)^a x max(Scr/k, 1)^-1.200 x 0.9938^age x 1.012 [female]",
                   constants=[constant("k", kappa, _INKER_2021 + " (0.7 women, 0.9 men)"), constant("a", alpha, _INKER_2021 + " (-0.241 women, -0.302 men)"),
                              constant("142", 142, _INKER_2021), constant("exponent of max", -1.200, _INKER_2021), constant("0.9938", 0.9938, _INKER_2021),
                              constant("female factor", 1.012 if female else 1, _INKER_2021)],
                   rows=_rows(ctx, ckd_epi_2021_version), steps={"min(Scr/k,1)": min(scr / kappa, 1), "max(Scr/k,1)": max(scr / kappa, 1)})


_INKER_2021_T2 = _INKER_2021 + " Table 2 restates the 2009 equation with an age base of 0.9929."
ckd_epi_2009_versions = {
    "levey_2009": Version("levey_2009", "CKD-EPI creatinine equation (2009, with race term; age base 0.993 as in the paper)", _LEVEY_2009, _ckd_epi_2009(0.993, _LEVEY_2009, "levey_2009"),
                          ("creatinine", "age", "sex", "black_race")),
    "inker_2021_table2": Version("inker_2021_table2", "CKD-EPI 2009 as restated in Inker 2021 Table 2 (age base 0.9929)", _INKER_2021_T2, _ckd_epi_2009(0.9929, _INKER_2021_T2, "inker_2021_table2"),
                                 ("creatinine", "age", "sex", "black_race"), note="The same equation; the age base differs in the fourth decimal (a 50-year-old man with creatinine 1.0 mg/dL: 87.37 against 86.93)."),
}
ckd_epi_2021_version = Version("inker_2021", "CKD-EPI creatinine equation (2021, race-free)", _INKER_2021, _ckd_epi_2021,
                               ("creatinine", "age", "sex"))

_add(Scale("ckd_epi_2009", "CKD-EPI 2009 (creatinine)", "Renal",
           [CREATININE, AGE, SEX, Bool("black_race", "Black race (the equation's race term)", 0)],
           list(ckd_epi_2009_versions.values()), source=_LEVEY_2009,
           scope="Adults with stable creatinine; not valid in acute kidney injury, pregnancy or extremes of muscle mass. Race term is part of the 2009 equation.",
           aliases=("ckd-epi", "egfr", "ckd epi 2009")))
_add(Scale("ckd_epi_2021", "CKD-EPI 2021 (creatinine, race-free)", "Renal",
           [CREATININE, AGE, SEX], [ckd_epi_2021_version], source=_INKER_2021,
           scope="Adults with stable creatinine; not valid in acute kidney injury or pregnancy.", aliases=("ckd-epi 2021", "egfr")))


_LEVEY_1999 = "Levey AS et al. A more accurate method to estimate glomerular filtration rate from serum creatinine. Ann Intern Med 1999;130:461-470."
_LEVEY_2006 = "Levey AS et al. Using standardized serum creatinine values in the MDRD study equation. Ann Intern Med 2006;145:247-254."


def _mdrd(constant_value, source):
    def compute(ctx):
        scr, age, female, black = ctx.value("creatinine"), ctx.value("age"), ctx.value("sex") == "female", ctx.value("black_race")
        egfr = constant_value * scr ** -1.154 * age ** -0.203 * (0.742 if female else 1) * (1.212 if black else 1)
        return Outcome(round_half_up(egfr, 1), _EGFR_UNIT, unrounded=egfr, rounding="1 decimal",
                       formula="%s x Scr^-1.154 x age^-0.203 x 0.742 [female] x 1.212 [Black]" % constant_value,
                       constants=[constant("leading constant", constant_value, source), constant("Scr exponent", -1.154, source),
                                  constant("age exponent", -0.203, source), constant("female factor", 0.742 if female else 1, source),
                                  constant("Black factor", 1.212 if black else 1, source)], rows=[ctx.row(i) for i in ("creatinine", "age", "sex", "black_race")])
    return compute


_add(Scale("mdrd", "MDRD study equation (4-variable)", "Renal",
           [CREATININE, AGE, SEX, Bool("black_race", "Black race (the equation's race term)", 0)],
           [Version("idms_175", "IDMS-traceable creatinine (leading constant 175)", _LEVEY_2006, _mdrd(175, _LEVEY_2006), ("creatinine", "age", "sex", "black_race")),
            Version("original_186", "Original calibration (leading constant 186)", _LEVEY_1999, _mdrd(186, _LEVEY_1999), ("creatinine", "age", "sex", "black_race"),
                    note="186 was fitted to non-standardised creatinine; with an IDMS-traceable creatinine it over-estimates by about 6%.")],
           source=_LEVEY_2006, scope="Adults with chronic kidney disease; not validated above 90 mL/min/1.73 m2 or in acute kidney injury.", aliases=("mdrd gfr", "egfr")))


def _cockcroft_gault(basis):
    def compute(ctx):
        age, scr, female = ctx.value("age"), ctx.value("creatinine"), ctx.value("sex") == "female"
        weight = ctx.value("weight")
        steps, rows = {}, [ctx.row(i) for i in ("age", "weight", "creatinine", "sex")]
        if basis != "actual":
            if not ctx.has("height"):
                raise ScoreError(INPUT_INVALID, "The %s-weight form needs height." % basis)
            ibw = _devine(ctx.value("height"), female)
            steps["ideal_body_weight_kg"] = ibw
            rows.append(ctx.row("height"))
            weight = ibw if basis == "ideal" else ibw + 0.4 * (weight - ibw)
            steps["weight_used_kg"] = weight
        crcl = (140 - age) * weight / (72 * scr) * (0.85 if female else 1)
        return Outcome(round_half_up(crcl, 1), "mL/min", unrounded=crcl, rounding="1 decimal", steps=steps, rows=rows,
                       formula="(140 - age) x weight / (72 x Scr) x 0.85 [female]",
                       constants=[constant("140", 140, _CG), constant("72", 72, _CG), constant("female factor", 0.85 if female else 1, _CG)])
    return compute


_CG = "Cockcroft DW, Gault MH. Prediction of creatinine clearance from serum creatinine. Nephron 1976;16:31-41."
_add(Scale("cockcroft_gault", "Cockcroft-Gault creatinine clearance", "Renal",
           [AGE, WEIGHT, CREATININE, SEX, Num("height", "Height (only for the ideal- and adjusted-weight forms)", "height", lo=20, hi=275, required=False)],
           [Version("actual_weight", "Actual body weight (as published)", _CG, _cockcroft_gault("actual"), ("age", "weight", "creatinine", "sex")),
            Version("ideal_weight", "Ideal body weight (Devine)", _CG + " Weight basis: common dosing practice, not the paper.", _cockcroft_gault("ideal"),
                    ("age", "weight", "creatinine", "sex", "height")),
            Version("adjusted_weight", "Adjusted body weight (IBW + 0.4 x (actual - IBW))", _CG + " Weight basis: common dosing practice, not the paper.",
                    _cockcroft_gault("adjusted"), ("age", "weight", "creatinine", "sex", "height"))],
           source=_CG, scope="Adults; stable creatinine; not an indexed GFR (mL/min, not per 1.73 m2).", aliases=("creatinine clearance", "crcl", "cg")))


# ---------------------------------------------------------------------------------------------------------------
# Body size
# ---------------------------------------------------------------------------------------------------------------

def _devine(height_cm, female):
    inches = height_cm / 2.54
    return (45.5 if female else 50.0) + 2.3 * (inches - 60)


def _bmi(ctx):
    weight, height = ctx.value("weight"), ctx.value("height") / 100
    bmi = weight / height ** 2
    bands = [(18.5, "underweight"), (25.0, "normal weight"), (30.0, "overweight (pre-obese)"), (35.0, "obesity class I"),
             (40.0, "obesity class II")]
    category = next((name for limit, name in bands if bmi < limit), "obesity class III")
    return Outcome(round_half_up(bmi, 1), "kg/m2", category=category, unrounded=bmi, rounding="1 decimal; the category is read on the unrounded value",
                   formula="weight (kg) / height (m)^2", rows=_rows(ctx, bmi_version), steps={"height_m": height})


bmi_version = Version("quetelet", "Body mass index (Quetelet), WHO adult categories", "WHO. Obesity: preventing and managing the global epidemic. WHO Technical Report Series 894, 2000.",
                      _bmi, ("weight", "height"))
_add(Scale("bmi", "Body mass index", "Body size", [WEIGHT, HEIGHT], [bmi_version], source=bmi_version.source,
           scope="Adults (the WHO categories do not apply to children, whose BMI is read against growth charts).", aliases=("body mass index",),
           bands={"<18.5": "underweight", "18.5-24.9": "normal weight", "25.0-29.9": "overweight (pre-obese)", "30.0-34.9": "obesity class I",
                  "35.0-39.9": "obesity class II", ">=40": "obesity class III"}))


def _bsa(name, formula, source, fn):
    def compute(ctx):
        weight, height = ctx.value("weight"), ctx.value("height")
        value = fn(weight, height)
        return Outcome(round_half_up(value, 3), "m2", unrounded=value, rounding="3 decimals", formula=formula, rows=_rows(ctx, bsa_versions[name]),
                       constants=[constant("formula", formula, source)])
    return compute


_BSA_SOURCES = {
    "mosteller": "Mosteller RD. Simplified calculation of body-surface area. N Engl J Med 1987;317:1098.",
    "dubois": "Du Bois D, Du Bois EF. A formula to estimate the approximate surface area if height and weight be known. Arch Intern Med 1916;17:863-871.",
    "haycock": "Haycock GB, Schwartz GJ, Wisotsky DH. Geometric method for measuring body surface area. J Pediatr 1978;93:62-66.",
    "gehan_george": "Gehan EA, George SL. Estimation of human body surface area from height and weight. Cancer Chemother Rep 1970;54:225-235.",
    "boyd": "Boyd E. The Growth of the Surface Area of the Human Body. University of Minnesota Press, 1935.",
}
_BSA_FORMULAS = {
    "mosteller": ("sqrt(height_cm x weight_kg / 3600)", lambda w, h: math.sqrt(h * w / 3600)),
    "dubois": ("0.007184 x weight_kg^0.425 x height_cm^0.725", lambda w, h: 0.007184 * w ** 0.425 * h ** 0.725),
    "haycock": ("0.024265 x weight_kg^0.5378 x height_cm^0.3964", lambda w, h: 0.024265 * w ** 0.5378 * h ** 0.3964),
    "gehan_george": ("0.0235 x weight_kg^0.51456 x height_cm^0.42246", lambda w, h: 0.0235 * w ** 0.51456 * h ** 0.42246),
    "boyd": ("0.0003207 x height_cm^0.3 x weight_g^(0.7285 - 0.0188 x log10(weight_g))",
             lambda w, h: 0.0003207 * h ** 0.3 * (w * 1000) ** (0.7285 - 0.0188 * math.log10(w * 1000))),
}
bsa_versions = {}
for _name, (_formula, _fn) in _BSA_FORMULAS.items():
    bsa_versions[_name] = Version(_name, _name.replace("_", " ").title(), _BSA_SOURCES[_name], _bsa(_name, _formula, _BSA_SOURCES[_name], _fn), ("weight", "height"))
_add(Scale("bsa", "Body surface area", "Body size", [WEIGHT, HEIGHT], list(bsa_versions.values()), default="mosteller",
           source="; ".join(_BSA_SOURCES.values()), scope="The formulas agree within about 3% in adults of ordinary build; they diverge in infants and in extreme body size.",
           aliases=("body surface area", "mosteller", "dubois")))


def _ibw(name, male_base, female_base, per_inch_male, per_inch_female, source, pounds=False):
    def compute(ctx):
        inches = ctx.value("height") / 2.54
        female = ctx.value("sex") == "female"
        over = inches - 60
        base, step = (female_base, per_inch_female) if female else (male_base, per_inch_male)
        value = (base + step * over) * (0.45359237 if pounds else 1)
        notes = ["Height is under 5 feet (60 in); Devine's equations are stated for 60 in or more and the others give no lower limit, so this extrapolates."] if over < 0 else []
        unit_text = "lb" if pounds else "kg"
        return Outcome(round_half_up(value, 1), "kg", unrounded=value, rounding="1 decimal", notes=notes, steps={"inches_over_60": over},
                       formula="%s%s %s + %s %s x (height_in - 60)%s [%s]" % ("(" if pounds else "", base, unit_text, step, unit_text, ") x 0.45359237 kg/lb" if pounds else "", "female" if female else "male"),
                       constants=[constant("base", "%s %s" % (base, unit_text), source), constant("per inch over 60", "%s %s" % (step, unit_text), source)], rows=_rows(ctx, ibw_versions[name]))
    return compute


_IBW_SOURCES = {
    "devine": "Devine BJ. Gentamicin therapy. Drug Intell Clin Pharm 1974;8:650-655 (constants as tabulated in Peterson CM et al., Am J Clin Nutr 2016;103:1197, Table 3).",
    "robinson": "Robinson JD et al. Determination of ideal body weight for drug dosage calculations. Am J Hosp Pharm 1983;40:1016-1019 (constants as tabulated in Peterson 2016, Table 3).",
    "miller": "Miller DR et al. Determining ideal-body-weight. Am J Hosp Pharm 1983;40:1622-1623 (constants as tabulated in Peterson 2016, Table 3).",
    "hamwi": "Hamwi GJ. Therapy: changing dietary concepts. In: Danowski TS, ed. Diabetes Mellitus: Diagnosis and Treatment. American Diabetes Association, 1964 (106 lb + 6 lb per inch, women 100 lb + 5 lb, as tabulated in Peterson 2016, Table 3; converted at 0.45359237 kg/lb).",
}
ibw_versions = {
    "devine": Version("devine", "Devine 1974 (M 50 kg, F 45.5 kg, +2.3 kg per inch over 60)", _IBW_SOURCES["devine"], _ibw("devine", 50.0, 45.5, 2.3, 2.3, _IBW_SOURCES["devine"]), ("height", "sex")),
    "robinson": Version("robinson", "Robinson 1983 (M 52 kg + 1.9, F 49 kg + 1.7 per inch)", _IBW_SOURCES["robinson"], _ibw("robinson", 52.0, 49.0, 1.9, 1.7, _IBW_SOURCES["robinson"]), ("height", "sex")),
    "miller": Version("miller", "Miller 1983 (M 56.2 kg + 1.41, F 53.1 kg + 1.36 per inch)", _IBW_SOURCES["miller"], _ibw("miller", 56.2, 53.1, 1.41, 1.36, _IBW_SOURCES["miller"]), ("height", "sex")),
    "hamwi": Version("hamwi", "Hamwi 1964 (M 106 lb + 6 lb, F 100 lb + 5 lb per inch over 60)", _IBW_SOURCES["hamwi"], _ibw("hamwi", 106.0, 100.0, 6.0, 5.0, _IBW_SOURCES["hamwi"], pounds=True), ("height", "sex")),
}
_add(Scale("ideal_body_weight", "Ideal body weight", "Body size", [HEIGHT, SEX], list(ibw_versions.values()), default="devine",
           source="; ".join(_IBW_SOURCES.values()), scope="Adults at or above about 5 feet; a dosing convention, not a healthy-weight target.", aliases=("ibw",)))


_ABW_SOURCE = ("Schwartz SN et al. A controlled investigation of the pharmacokinetics of gentamicin and tobramycin in obese subjects. J Infect Dis 1978;138:499-505 and Bauer LA et al. Eur J Clin Pharmacol 1983;24:643-647 "
               "(ABW = IBW + 0.4 x (TBW - IBW), as tabulated in Velissaris D et al., J Clin Med Res 2014;6:227, Table 1); Winter MA et al., Pharmacotherapy 2012;32:604 found the 0.4 form least biased for Cockcroft-Gault in obesity.")


def _abw(factor, source):
    def compute(ctx):
        weight, height, female = ctx.value("weight"), ctx.value("height"), ctx.value("sex") == "female"
        ibw = _devine(height, female)
        adjusted = ibw + factor * (weight - ibw)
        return Outcome(round_half_up(adjusted, 1), "kg", unrounded=adjusted, rounding="1 decimal", steps={"ideal_body_weight_kg": ibw},
                       formula="IBW (Devine) + %g x (actual weight - IBW)" % factor, constants=[constant("correction factor", factor, source)],
                       rows=[ctx.row(i) for i in ("weight", "height", "sex")])
    return compute


_ABW_WURTZ = "Wurtz R et al. Antimicrobial dosing in obese patients. Clin Infect Dis 1997;25:112-118 (0.3 for hydrophilic antibiotics, as cited in Velissaris 2014)."
_ABW_TRAYNOR = "Traynor AM et al. Aminoglycoside dosing weight correction factors for patients of various body sizes. Antimicrob Agents Chemother 1995;39:545-548 (0.43, for overweight patients)."
abw_versions = [Version("factor_0_4", "IBW + 0.4 x (actual - IBW)", _ABW_SOURCE, _abw(0.4, _ABW_SOURCE), ("weight", "height", "sex")),
                Version("factor_0_3", "IBW + 0.3 x (actual - IBW) (hydrophilic antibiotics)", _ABW_WURTZ, _abw(0.3, _ABW_WURTZ), ("weight", "height", "sex")),
                Version("factor_0_43", "IBW + 0.43 x (actual - IBW) (Traynor 1995, overweight)", _ABW_TRAYNOR, _abw(0.43, _ABW_TRAYNOR), ("weight", "height", "sex"))]
_add(Scale("adjusted_body_weight", "Adjusted (dosing) body weight", "Body size", [WEIGHT, HEIGHT, SEX], abw_versions, source=_ABW_SOURCE,
           scope="Dosing in obesity; the correction factor is drug-specific (generally 0.3 to 0.6, 0.4 for aminoglycosides and Cockcroft-Gault) and the ideal weight is Devine's. Factors of 0.25 and 0.5 were not found in a source.",
           aliases=("abw", "dosing weight", "adjusted weight")))


def _map(fraction, source):
    def compute(ctx):
        sbp, dbp = ctx.value("systolic"), ctx.value("diastolic")
        value = dbp + fraction * (sbp - dbp)
        return Outcome(round_half_up(value, 1), "mmHg", unrounded=value, rounding="1 decimal", rows=_rows(ctx, map_versions[0 if fraction < 0.4 else 1]),
                       formula="DBP + %s x (SBP - DBP)%s" % ("1/3" if fraction < 0.4 else fraction, " = (SBP + 2 x DBP) / 3" if fraction < 0.4 else ""),
                       constants=[constant("fraction of the pulse pressure", "1/3" if fraction < 0.4 else fraction, source)],
                       notes=["At high heart rates the true mean pressure is closer to the arithmetic mean of systolic and diastolic pressure (Klabunde); heart-rate-dependent forms (Razminia 2004, Moran 1995) exist and are not implemented."])
    return compute


_MAP_STANDARD = ("Standard form (Gauer 1960; the earlier Wezler and Boger 1939): MAP = DBP + (SBP - DBP)/3, as stated in Klabunde, Cardiovascular Physiology Concepts ('Arterial blood pressure': 120/80 gives approximately 93 mmHg) "
                 "and in arXiv 2503.23140.")
_MAP_MEANEY = "Meaney E et al. Formula and nomogram for the sphygmomanometric calculation of the mean arterial pressure. Heart 2000;84:64 (0.412 of the pulse pressure; the paper's text was not readable, the coefficient is as used by papers citing it)."
map_versions = [Version("one_third", "MAP = DBP + (SBP - DBP)/3", _MAP_STANDARD, _map(1 / 3, _MAP_STANDARD), ("systolic", "diastolic")),
                Version("meaney_0_412", "MAP = DBP + 0.412 x (SBP - DBP)", _MAP_MEANEY, _map(0.412, _MAP_MEANEY), ("systolic", "diastolic"))]
_add(Scale("mean_arterial_pressure", "Mean arterial pressure", "Cardiovascular",
           [Num("systolic", "Systolic blood pressure", "pressure", lo=20, hi=350), Num("diastolic", "Diastolic blood pressure", "pressure", lo=10, hi=250)],
           map_versions, source=_MAP_STANDARD + " " + _MAP_MEANEY, scope="Resting heart rate for the one-third form; the 0.412 form was fitted to catheter-measured pressures in 150 patients.", aliases=("map",)))


# ---------------------------------------------------------------------------------------------------------------
# Lipids, ECG intervals, fluids and dates
# ---------------------------------------------------------------------------------------------------------------

_FRIEDEWALD = ("Friedewald WT, Levy RI, Fredrickson DS. Estimation of the concentration of low-density lipoprotein cholesterol in plasma, without use of the preparative ultracentrifuge. "
               "Clin Chem 1972;18:499-502 (mg/100 ml only; the mmol/L divisor 2.2 is the clinical convention, e.g. the MSD Manual calculator, not in the paper).")


def _ldl(ctx):
    tc, hdl, tg = ctx.value("total_cholesterol"), ctx.value("hdl_cholesterol"), ctx.value("triglycerides")
    tg_unit = ctx.parsed["triglycerides"]
    if (tg_unit.native >= 4.5) if tg_unit.unit == "mmol/L" else tg >= 400:
        raise ScoreError(NOT_APPLICABLE, "The Friedewald estimate is not valid when triglycerides are 400 mg/dL (4.5 mmol/L) or higher "
                         "(Friedewald 1972: not accurate when they exceed 400 mg/100 ml; the validated set had less than 400).")
    si = all(ctx.parsed[i].unit == "mmol/L" for i in ("total_cholesterol", "hdl_cholesterol", "triglycerides"))
    if si:
        tc_s, hdl_s, tg_s = (ctx.parsed[i].native for i in ("total_cholesterol", "hdl_cholesterol", "triglycerides"))
        value, unit, divisor = tc_s - hdl_s - tg_s / 2.2, "mmol/L", "TG / 2.2"
        steps = {"ldl_mg_dl_equivalent": value * 38.67}
    else:
        value, unit, divisor = tc - hdl - tg / 5, "mg/dL", "TG / 5"
        steps = {"ldl_mmol_l_equivalent": value / 38.67}
    return Outcome(round_half_up(value, 1), unit, unrounded=value, rounding="1 decimal", steps=steps, rows=_rows(ctx, ldl_version),
                   formula="LDL = total cholesterol - HDL cholesterol - %s" % divisor,
                   constants=[constant("VLDL divisor", 2.2 if si else 5, _FRIEDEWALD + (" (SI form: mmol/L divisor 2.2; the exact conversion of 5 mg/dL is 2.18)" if si else " (mg/dL divisor 5)"))])


ldl_version = Version("friedewald", "Friedewald estimate (TG/5 in mg/dL; TG/2.2 when all three are in mmol/L)", _FRIEDEWALD, _ldl,
                      ("total_cholesterol", "hdl_cholesterol", "triglycerides"))
_add(Scale("ldl_friedewald", "LDL cholesterol (Friedewald)", "Lipids",
           [Num("total_cholesterol", "Total cholesterol", "cholesterol", lo=20, hi=1500), Num("hdl_cholesterol", "HDL cholesterol", "cholesterol", lo=1, hi=300),
            Num("triglycerides", "Triglycerides (fasting)", "triglycerides", lo=1, hi=10000)],
           [ldl_version], source=_FRIEDEWALD, scope="Valid for triglycerides under 400 mg/dL (4.5 mmol/L); refused above that. Fasting sample.", aliases=("ldl", "friedewald")))


def _qtc(name, formula, source, fn):
    def compute(ctx):
        qt, hr = ctx.value("qt_interval"), ctx.value("heart_rate")
        rr = 60.0 / hr
        value = fn(qt, rr, hr)
        return Outcome(round_half_up(value, 1), "ms", unrounded=value, rounding="1 decimal", steps={"rr_interval_s": rr}, rows=_rows(ctx, qtc_versions[name]),
                       formula=formula, constants=[constant("formula", formula, source)])
    return compute


_QTC = {
    "bazett": ("QT / sqrt(RR), RR in seconds", "Bazett HC. An analysis of the time-relations of electrocardiograms. Heart 1920;7:353-370 (the symbol form as printed in Vandenberk B et al., J Am Heart Assoc 2016;5:e003264; the 1920 paper was not read).",
               lambda qt, rr, hr: qt / math.sqrt(rr)),
    "fridericia": ("QT / RR^(1/3), RR in seconds", "Fridericia LS. Die Systolendauer im Elektrokardiogramm bei normalen Menschen und bei Herzkranken. Acta Med Scand 1920;53:469-486 (English translation: Ann Noninvasive Electrocardiol 2003;8:343-351, "
               "which derives the cube-root law; the symbol form as printed in Vandenberk 2016).", lambda qt, rr, hr: qt / rr ** (1 / 3)),
    "framingham": ("QT + 154 x (1 - RR), QT in ms, RR in seconds", "Sagie A et al. An improved method for adjusting the QT interval for heart rate (the Framingham Heart Study). Am J Cardiol 1992;70:797-801 "
                   "('QTLC = QT + 0.154 (1 - RR)', seconds; abstract read).", lambda qt, rr, hr: qt + 154 * (1 - rr)),
    "hodges": ("QT + 1.75 x (HR - 60), QT in ms, HR in beats/min", "Hodges M, Salerno D, Erlien D. Bazett's QT correction reviewed. J Am Coll Cardiol 1983;1:694 (formula as printed in Phan DQ et al., J Pediatr 2015;166:960 and Rabkin SW et al., "
               "J Geriatr Cardiol 2016;13:740; the 1983 abstract was not available).", lambda qt, rr, hr: qt + 1.75 * (hr - 60)),
    "rautaharju_2014": ("QT x (120 + HR) / 180, QT in ms, HR in beats/min", "Rautaharju PM, Mason JW, Akiyama T. New age- and sex-specific criteria for QT prolongation based on rate correction formulas that minimize bias at the upper normal limits. "
                        "Int J Cardiol 2014;174:535-540 ('QTcMod = QT x (120 + HR)/180'; abstract read).", lambda qt, rr, hr: qt * (120 + hr) / 180),
}
qtc_versions = {name: Version(name, name.replace("_", " ").title() + " correction", source, _qtc(name, formula, source, fn), ("qt_interval", "heart_rate"))
                for name, (formula, source, fn) in _QTC.items()}
_add(Scale("qtc", "Corrected QT interval", "Cardiovascular",
           [Num("qt_interval", "Measured QT interval", "interval", lo=150, hi=1200),
            Num("heart_rate", "Heart rate", "rate", lo=20, hi=300, bare=True, note="a plain number is read as beats per minute")],
           list(qtc_versions.values()), default="bazett", source="; ".join(v.source for v in qtc_versions.values()),
           scope="Heart rate from the same ECG. Bazett over-corrects at fast rates and under-corrects at slow ones; the AHA/ACCF/HRS 2009 statement prefers linear regression functions to Bazett and advises against rate correction when the RR interval varies greatly (atrial fibrillation) "
                 "or the end of the T wave is unreliable.", aliases=("qt", "qtc")))


_HS_DAILY = ("Holliday MA, Segar WE. The maintenance need for water in parenteral fluid therapy. Pediatrics 1957;19:823-832 (the 1957 paper was not readable; the 100/50/20 mL/kg/day form is as stated in "
             "NICE NG29 section 1.4.1 and in Holliday MA, Ray PE, Friedman AL, Arch Dis Child 2007;92:546, Table 5, whose rows it reproduces).")
_HS_HOURLY = ("The '4-2-1' hourly rule is the 100/50/20 rule divided by 24 and rounded (4.17, 2.08, 0.83 mL/kg/h); it is not printed in the 1957 paper (Holliday 2007 lists hourly allowances rounded to the nearest 5 mL/h, 100 mL/h at 70 kg). "
              "Derived from " + _HS_DAILY)


def _fluids(hourly):
    def compute(ctx):
        w = ctx.value("weight")
        notes = ["Maintenance only: deficits and ongoing losses are added separately (Holliday and Segar). NICE NG29 (children) notes that over 24 hours males rarely need more than 2,500 mL and females more than 2,000 mL; "
                 "NICE CG174 (adults) prescribes 25-30 mL/kg/day of water for routine maintenance, less in the elderly or frail, and adjusts to ideal body weight in obesity."]
        if hourly:
            value = 4 * min(w, 10) + 2 * max(min(w, 20) - 10, 0) + 1 * max(w - 20, 0)
            return Outcome(round_half_up(value, 1), "mL/h", unrounded=value, rounding="1 decimal", rows=_rows(ctx, fluids_versions[0]), notes=notes,
                           formula="4 mL/h per kg for the first 10 kg + 2 mL/h per kg for the next 10 kg + 1 mL/h per kg above 20 kg",
                           constants=[constant("4-2-1", "4/2/1 mL/kg/h", _HS_HOURLY)])
        value = 100 * min(w, 10) + 50 * max(min(w, 20) - 10, 0) + 20 * max(w - 20, 0)
        return Outcome(round_half_up(value, 1), "mL/day", unrounded=value, rounding="1 decimal", rows=_rows(ctx, fluids_versions[1]), notes=notes,
                       formula="100 mL/kg for the first 10 kg + 50 mL/kg for the next 10 kg + 20 mL/kg above 20 kg",
                       constants=[constant("100-50-20", "100/50/20 mL/kg/day", _HS_DAILY)])
    return compute


fluids_versions = [Version("hourly_4_2_1", "Hourly '4-2-1' rule (the daily rule divided by 24 and rounded)", _HS_HOURLY, _fluids(True), ("weight",),
                           note="The default is the form most used at the bedside; the daily form below is the one the guideline text prints. They differ above 20 kg (70 kg: 110 mL/h = 2,640 mL/day against 2,500 mL/day)."),
                   Version("daily_100_50_20", "Holliday-Segar daily rule, 100/50/20 mL/kg/day", _HS_DAILY, _fluids(False), ("weight",))]
_add(Scale("maintenance_fluids", "Maintenance fluid requirement", "Fluids",
           [Num("weight", "Body weight", "weight", lo=0.3, hi=300)], fluids_versions, source=_HS_DAILY,
           scope="Maintenance water only. Derived from children's metabolic rates (the 1957 bands run to 70 kg) and applied to adults by convention; adult guidance (NICE CG174) is 25-30 mL/kg/day.",
           aliases=("4-2-1", "holliday-segar", "iv fluids")))


_ACOG_700 = "ACOG Committee Opinion No. 700: Methods for estimating the due date. Obstet Gynecol 2017;129:e150-e154 (read in full)."
_LMP_280 = _ACOG_700 + " 'By convention, the EDD is 280 days after the first day of the LMP', which assumes a regular 28-day cycle with ovulation on day 14."
_NAEGELE_CAL = ("Naegele's rule as taught in the patient-education pages of East Carolina University Health and University Hospitals and in Wikipedia 'Estimated date of delivery' (count back three calendar months, add one year and seven days); "
                "the rule is not in ACOG CO 700 and Naegele's 1812 text was not read. A day that does not exist in the target month is moved to the month's last day (a choice; no source says).")
_CYCLE_ADJUSTED = ("Cycle-length adjustment: EDD = LMP + 280 days + (cycle length - 28 days). ACOG CO 700 gives the reason (a 28-day cycle with ovulation on day 14) but no rule; the arithmetic is from a calculator's documentation "
                   "(metricgate.com) and agrees with a teaching-exam item (LMP 10 June, 32-day cycle: 17 March becomes 21 March). Treat as calculator-level.")
_ACOG_CONCEPTION = _ACOG_700 + " Conception or ovulation falls 14 days after the LMP on that convention, so the EDD is 266 days after conception (280 - 14)."
_ACOG_IVF = _ACOG_700 + " 'For a day-5 embryo, the EDD would be 261 days from the embryo replacement date ... a day-3 embryo, 263 days' (266 minus the embryo's age)."


def _weeks_days(days):
    return "%dw%dd" % divmod(int(days), 7)


def _dates(ctx, edd, basis, formula, constants, rows):
    extra = {"estimated_due_date": edd.isoformat(), "estimated_date_of_conception": (edd - datetime.timedelta(days=266)).isoformat()}
    notes = ["Dating by the last menstrual period assumes a regular cycle and a reliable recall of its first day; ACOG advises confirming or redating with ultrasound, and an EDD without an ultrasound before 22 0/7 weeks is suboptimally dated."] if basis == "lmp" else []
    steps = {}
    if ctx.has("as_of"):
        as_of = ctx.value("as_of")
        ga = 280 - (edd - as_of).days
        steps = {"gestational_age_days": ga, "gestational_age": _weeks_days(ga) if ga >= 0 else "before the dating reference",
                 "trimester": None if ga < 0 else (1 if ga < 14 * 7 else 2 if ga < 28 * 7 else 3), "days_to_due_date": (edd - as_of).days}
        notes.append("Trimesters as ACOG defines them: first up to 13 6/7 weeks, second 14 0/7 to 27 6/7, third 28 0/7 onward.")
    return Outcome(edd.isoformat(), "", formula=formula, constants=constants, rows=rows, steps=steps, notes=notes, extra=extra)


def _edd_lmp(ctx):
    lmp = ctx.value("lmp")
    return _dates(ctx, lmp + datetime.timedelta(days=280), "lmp", "EDD = LMP + 280 days",
                  [constant("pregnancy length", "280 days (40 weeks)", _LMP_280)], [ctx.row(i) for i in ("lmp", "as_of") if ctx.has(i)])


def _add_months(day, months):
    index = day.year * 12 + day.month - 1 + months
    year, month = divmod(index, 12)
    month += 1
    last = (datetime.date(year + (month == 12), month % 12 + 1, 1) - datetime.timedelta(days=1)).day
    return datetime.date(year, month, min(day.day, last))


def _edd_naegele_calendar(ctx):
    lmp = ctx.value("lmp")
    shifted = _add_months(lmp, 9)   # back three calendar months and forward one year
    edd = shifted + datetime.timedelta(days=7)
    return _dates(ctx, edd, "lmp", "EDD = (LMP - 3 calendar months + 1 year) + 7 days",
                  [constant("Naegele", "-3 months, +1 year, +7 days", _NAEGELE_CAL)], [ctx.row(i) for i in ("lmp", "as_of") if ctx.has(i)])


def _edd_lmp_cycle(ctx):
    lmp, cycle = ctx.value("lmp"), ctx.value("cycle_length")
    return _dates(ctx, lmp + datetime.timedelta(days=280 + round(cycle) - 28), "lmp", "EDD = LMP + 280 days + (cycle length - 28 days)",
                  [constant("pregnancy length", "280 days (40 weeks)", _LMP_280), constant("reference cycle length", "28 days", _CYCLE_ADJUSTED)],
                  [ctx.row(i) for i in ("lmp", "cycle_length", "as_of") if ctx.has(i)])


def _edd_conception(ctx):
    conception = ctx.value("conception_date")
    return _dates(ctx, conception + datetime.timedelta(days=266), "conception", "EDD = date of conception + 266 days (38 weeks)",
                  [constant("conception to term", "266 days (38 weeks)", _ACOG_CONCEPTION)], [ctx.row(i) for i in ("conception_date", "as_of") if ctx.has(i)])


def _edd_ivf(ctx):
    transfer, age = ctx.value("transfer_date"), ctx.value("embryo_age")
    return _dates(ctx, transfer + datetime.timedelta(days=266 - round(age)), "ivf", "EDD = embryo transfer date + 266 days - embryo age in days (day-5: 261, day-3: 263)",
                  [constant("conception to term", "266 days", _ACOG_IVF)], [ctx.row(i) for i in ("transfer_date", "embryo_age", "as_of") if ctx.has(i)])


def _gestational_age_from_edd(ctx):
    edd = ctx.value("estimated_due_date")
    return _dates(ctx, edd, "edd", "gestational age (days) = 280 - (EDD - date)", [constant("pregnancy length", "280 days (40 weeks)", _LMP_280)],
                  [ctx.row(i) for i in ("estimated_due_date", "as_of")])


_add(Scale("pregnancy_dates", "Pregnancy dating (estimated due date and gestational age)", "Obstetrics",
           [Date("lmp", "First day of the last menstrual period"), Num("cycle_length", "Usual menstrual cycle length", "days", lo=15, hi=60, bare=True, note="a plain number is read as days"),
            Date("conception_date", "Date of conception or ovulation"), Date("transfer_date", "Date of embryo transfer (IVF)"),
            Num("embryo_age", "Age of the transferred embryo in days (3 for a day-3 embryo, 5 for a blastocyst)", "days", lo=1, hi=8, bare=True),
            Date("estimated_due_date", "Estimated due date already assigned"), Date("as_of", "Date to state the gestational age on", required=False)],
           [Version("lmp_280_days", "LMP + 280 days (ACOG convention)", _LMP_280, _edd_lmp, ("lmp",)),
            Version("naegele_calendar", "Naegele's rule by calendar (-3 months, +1 year, +7 days)", _NAEGELE_CAL, _edd_naegele_calendar, ("lmp",),
                    note="Differs from LMP + 280 days by 0 to 2 days because months differ in length."),
            Version("lmp_cycle_adjusted", "LMP + 280 days, adjusted for the cycle length", _CYCLE_ADJUSTED, _edd_lmp_cycle, ("lmp", "cycle_length")),
            Version("conception", "Date of conception + 266 days", _ACOG_CONCEPTION, _edd_conception, ("conception_date",)),
            Version("ivf_transfer", "Embryo transfer date + 266 days - embryo age", _ACOG_IVF, _edd_ivf, ("transfer_date", "embryo_age")),
            Version("from_due_date", "Gestational age on a date from an assigned due date", _LMP_280, _gestational_age_from_edd, ("estimated_due_date", "as_of"))],
           source=_ACOG_700, scope="A calendar estimate; an ultrasound-based date takes precedence when it differs by more than the ACOG thresholds (more than 5 days up to 8 6/7 weeks, 7 days to 15 6/7, 10 days to 21 6/7, 14 days to 27 6/7, 21 days after).",
           aliases=("due date", "edd", "gestational age", "naegele", "ivf due date", "estimated due date")))


# ---------------------------------------------------------------------------------------------------------------
# Liver allocation: MELD, MELD-Na and MELD 3.0
# ---------------------------------------------------------------------------------------------------------------

_OPTN = ("OPTN Policies, Policy 9.1.D 'MELD Score' (2016-2023 text: effective 1/17/2019 and 12/6/2021, identical; "
         "https://optn.transplant.hrsa.gov/policies-bylaws/policies/).")
_OPTN_2024 = "OPTN Policies, Policy 9.1.D 'MELD Score', effective 12/11/2024 (MELD 3.0 in force since 2023-07-13)."
_KIM_2008 = "Kim WR et al. Hyponatremia and mortality among patients on the liver-transplant waiting list. N Engl J Med 2008;359:1018-1026."
_BIGGINS_2006 = "Biggins SW et al. Evidence-based incorporation of serum sodium concentration into MELD. Gastroenterology 2006;130:1652-1660."
_KIM_2021 = "Kim WR et al. MELD 3.0: the Model for End-stage Liver Disease updated for the modern era. Gastroenterology 2021;161:1887-1895."
_KAMATH_2007 = "Kamath PS, Kim WR. The Model for End-Stage Liver Disease (MELD). Hepatology 2007;45:797-805 (the original authors' statement of the equation and its bounds)."

BILIRUBIN = Num("bilirubin", "Total bilirubin", "bilirubin", lo=0.05, hi=80)
INR = Num("inr", "INR", "ratio", lo=0.5, hi=20, bare=True)
SODIUM = Num("sodium", "Serum sodium", "electrolyte", lo=80, hi=200)
MELD_CREATININE = Num("creatinine", "Serum creatinine", "creatinine", lo=0.05, hi=40)
DIALYSIS = Bool("dialysis", "Two or more dialysis treatments, or 24 hours of CVVHD, in the 7 days before the creatinine", 0,
                note="when true the policy sets creatinine to its ceiling")


def _meld_inputs(ctx, ceiling):
    dialysis = ctx.value("dialysis")
    cr = ctx.value("creatinine")
    cr_used = ceiling if (dialysis or cr > ceiling) else max(cr, 1.0)
    return cr_used, max(ctx.value("bilirubin"), 1.0), max(ctx.value("inr"), 1.0)


def _meld_i_value(ctx):
    cr, bili, inr = _meld_inputs(ctx, 4.0)
    raw = 0.957 * math.log(cr) + 0.378 * math.log(bili) + 1.120 * math.log(inr) + 0.643
    meld_i = min(round_half_up(round_half_up(raw, 1) * 10), 40)
    return meld_i, raw, cr, bili, inr


def _meld(ctx):
    meld_i, raw, cr, bili, inr = _meld_i_value(ctx)
    return Outcome(meld_i, "points", unrounded=raw * 10, rounding="the sum is rounded to a tenth, then multiplied by 10; maximum 40",
                   formula="10 x round1(0.957 x ln(Cr) + 0.378 x ln(bilirubin) + 1.120 x ln(INR) + 0.643), each laboratory value below 1.0 set to 1.0, creatinine set to 4.0 if above 4.0 or on dialysis",
                   constants=[constant("coefficients", "0.957, 0.378, 1.120, 0.643", _OPTN), constant("ceiling for creatinine", 4.0, _OPTN), constant("floor for laboratory values", 1.0, _OPTN),
                              constant("maximum", 40, _OPTN)],
                   rows=[ctx.row(i) for i in ("creatinine", "bilirubin", "inr", "dialysis")], steps={"creatinine_used": cr, "bilirubin_used": bili, "inr_used": inr},
                   notes=["Equivalent to the original 9.57 x ln(Cr) + 3.78 x ln(bilirubin) + 11.2 x ln(INR) + 6.43 of %s" % _KAMATH_2007])


def _meld_na_optn(ctx):
    meld_i, raw, cr, bili, inr = _meld_i_value(ctx)
    na_used = min(max(ctx.value("sodium"), 125), 137)
    value = meld_i + 1.32 * (137 - na_used) - 0.033 * meld_i * (137 - na_used) if meld_i > 11 else float(meld_i)
    return Outcome(round_half_up(value), "points", unrounded=value, rounding="to the nearest whole number (the policy text does not state a rounding for this step)",
                   formula="MELD(i) if MELD(i) <= 11, else MELD(i) + 1.32 x (137 - Na) - 0.033 x MELD(i) x (137 - Na), sodium bounded to 125-137",
                   constants=[constant("1.32 and 0.033", "1.32, 0.033", _OPTN), constant("sodium bounds", "125 to 137 mmol/L", _OPTN)],
                   rows=[ctx.row(i) for i in ("creatinine", "bilirubin", "inr", "sodium", "dialysis")], steps={"MELD(i)": meld_i, "sodium_used": na_used})


def _kim_2008_meld(ctx):
    cr, bili, inr = _meld_inputs(ctx, 4.0)
    return round_half_up(9.57 * math.log(cr) + 3.78 * math.log(bili) + 11.2 * math.log(inr) + 6.43), cr, bili, inr


def _meld_na_kim(ctx):
    meld, cr, bili, inr = _kim_2008_meld(ctx)
    na_used = min(max(ctx.value("sodium"), 125), 140)
    value = meld - na_used - 0.025 * meld * (140 - na_used) + 140
    return Outcome(round_half_up(value), "points", unrounded=value, rounding="MELD and MELDNa each rounded to the nearest integer",
                   formula="MELDNa = MELD - Na - 0.025 x MELD x (140 - Na) + 140, sodium bounded to 125-140; MELD = 9.57 ln(Cr) + 3.78 ln(bilirubin) + 11.2 ln(INR) + 6.43",
                   constants=[constant("0.025 and 140", "0.025, 140", _KIM_2008), constant("sodium bounds", "125 to 140 mmol/L", _KIM_2008)],
                   rows=[ctx.row(i) for i in ("creatinine", "bilirubin", "inr", "sodium", "dialysis")], steps={"MELD": meld, "sodium_used": na_used})


def _meld_na_biggins(ctx):
    meld, cr, bili, inr = _kim_2008_meld(ctx)
    na_used = min(max(ctx.value("sodium"), 120), 135)
    value = meld + 1.59 * (135 - na_used)
    return Outcome(round_half_up(value), "points", unrounded=value, rounding="to the nearest integer (the abstract does not state a rounding)",
                   formula="MELD-Na = MELD + 1.59 x (135 - Na), sodium bounded to 120-135 (may exceed 40)",
                   constants=[constant("1.59 and 135", "1.59, 135", _BIGGINS_2006), constant("sodium bounds", "120 to 135 mEq/L", _BIGGINS_2006)],
                   rows=[ctx.row(i) for i in ("creatinine", "bilirubin", "inr", "sodium", "dialysis")], steps={"MELD": meld, "sodium_used": na_used})


def _meld_3(ctx):
    cr, bili, inr = _meld_inputs(ctx, 3.0)
    na_used = min(max(ctx.value("sodium"), 125), 137)
    alb_used = min(max(ctx.value("albumin"), 1.5), 3.5)
    female = ctx.value("sex") == "female"
    value = ((1.33 if female else 0) + 4.56 * math.log(bili) + 0.82 * (137 - na_used) - 0.24 * (137 - na_used) * math.log(bili)
             + 9.09 * math.log(inr) + 11.14 * math.log(cr) + 1.85 * (3.5 - alb_used) - 1.83 * (3.5 - alb_used) * math.log(cr) + 6)
    return Outcome(min(max(round_half_up(value), 6), 40), "points", unrounded=value, rounding="to the nearest whole number, minimum 6, maximum 40",
                   formula="1.33 [female] + 4.56 ln(bili) + 0.82 (137-Na) - 0.24 (137-Na) ln(bili) + 9.09 ln(INR) + 11.14 ln(Cr) + 1.85 (3.5-alb) - 1.83 (3.5-alb) ln(Cr) + 6",
                   constants=[constant("coefficients", "1.33, 4.56, 0.82, 0.24, 9.09, 11.14, 1.85, 1.83, 6", _KIM_2021 + "; " + _OPTN_2024),
                              constant("bounds", "bilirubin, INR, creatinine >= 1.0; creatinine <= 3.0 (3.0 on dialysis); sodium 125-137; albumin 1.5-3.5 g/dL", _OPTN_2024)],
                   rows=[ctx.row(i) for i in ("creatinine", "bilirubin", "inr", "sodium", "albumin", "sex", "dialysis")],
                   steps={"creatinine_used": cr, "sodium_used": na_used, "albumin_used": alb_used})


_BASE = ("creatinine", "bilirubin", "inr", "dialysis")
_add(Scale("meld", "MELD score (MELD(i))", "Liver", [MELD_CREATININE, BILIRUBIN, INR, DIALYSIS],
           [Version("optn_meld_i", "UNOS/OPTN MELD, initial score (2002-2023 policy)", _OPTN, _meld, _BASE)],
           source=_OPTN + " " + _KAMATH_2007, scope="Candidates 12 years and over; initial MELD without the sodium step. Current US allocation uses MELD 3.0 (since 2023-07-13).",
           aliases=("model for end-stage liver disease", "meld(i)")))
_add(Scale("meld_na", "MELD-Na", "Liver", [MELD_CREATININE, BILIRUBIN, INR, SODIUM, DIALYSIS, Num("albumin", "Serum albumin (MELD 3.0 only)", "albumin", lo=0.5, hi=8, required=False),
                                         Choice("sex", "Sex (MELD 3.0 only)", [("male", "male", 0), ("female", "female", 0)], required=False)],
           [Version("optn_2016", "UNOS/OPTN MELD-Na, 2016-2023 policy (1.32 form)", _OPTN, _meld_na_optn, _BASE + ("sodium",)),
            Version("kim_2008", "Kim 2008 NEJM MELDNa", _KIM_2008, _meld_na_kim, _BASE + ("sodium",)),
            Version("biggins_2006", "Biggins 2006 MELD-Na (1.59 form)", _BIGGINS_2006, _meld_na_biggins, _BASE + ("sodium",)),
            Version("meld_3_0", "MELD 3.0 (current OPTN policy; needs albumin and sex)", _KIM_2021 + " " + _OPTN_2024, _meld_3, _BASE + ("sodium", "albumin", "sex"))],
           source=_OPTN + " " + _KIM_2008 + " " + _BIGGINS_2006 + " " + _KIM_2021,
           scope="Candidates for liver transplantation 12 years and over (MELD 3.0: 18 and over). Dialysis sets creatinine to its ceiling (4.0 mg/dL; 3.0 for MELD 3.0).",
           aliases=("meld-na", "meldna", "meld sodium")))
_add(Scale("meld_3_0", "MELD 3.0", "Liver", [MELD_CREATININE, BILIRUBIN, INR, SODIUM, DIALYSIS, Num("albumin", "Serum albumin", "albumin", lo=0.5, hi=8),
                                           Choice("sex", "Sex", [("male", "male", 0), ("female", "female", 0)])],
           [Version("optn_2024", "MELD 3.0 as in OPTN policy 9.1.D", _KIM_2021 + " " + _OPTN_2024, _meld_3, _BASE + ("sodium", "albumin", "sex"))],
           source=_KIM_2021 + " " + _OPTN_2024, scope="Adults 18 and over listed for liver transplant (adolescents 12-17 have a different constant, not implemented).",
           aliases=("meld 3",)))


# ---------------------------------------------------------------------------------------------------------------
# Acid-base, electrolytes and renal indices
# ---------------------------------------------------------------------------------------------------------------

NA = Num("sodium", "Serum sodium", "electrolyte", lo=80, hi=200)
CL = Num("chloride", "Serum chloride", "electrolyte", lo=50, hi=160)
HCO3 = Num("bicarbonate", "Serum bicarbonate (total CO2)", "electrolyte", lo=2, hi=60)
ALBUMIN = Num("albumin", "Serum albumin", "albumin", lo=0.5, hi=8)

_AG_NOTE = ("Reference ranges depend on the method: about 8-16 mEq/L with flame photometry, 3-12 with ion-selective electrodes (Winter 1990; Figge 2018); "
            "each laboratory sets its own.")
_KRAUT_2007 = "Kraut JA, Madias NE. Serum anion gap: its uses and limitations in clinical medicine. Clin J Am Soc Nephrol 2007;2:162-174."


def _anion_gap(with_k):
    def compute(ctx):
        na, cl, hco3 = ctx.value("sodium"), ctx.value("chloride"), ctx.value("bicarbonate")
        k = ctx.value("potassium") if with_k else 0.0
        gap = na + k - cl - hco3
        return Outcome(round_half_up(gap, 1), "mEq/L", unrounded=gap, rounding="1 decimal", notes=[_AG_NOTE],
                       formula="Na%s - Cl - HCO3" % (" + K" if with_k else ""), rows=[ctx.row(i) for i in (("sodium", "potassium") if with_k else ("sodium",)) + ("chloride", "bicarbonate")],
                       constants=[constant("definition", "unmeasured anions minus unmeasured cations, all in mEq/L", _KRAUT_2007)])
    return compute


_add(Scale("anion_gap", "Serum anion gap", "Acid-base", [NA, CL, HCO3, Num("potassium", "Serum potassium (only for the potassium-inclusive form)", "electrolyte", lo=1, hi=12, required=False)],
           [Version("without_potassium", "Na - (Cl + HCO3)", _KRAUT_2007, _anion_gap(False), ("sodium", "chloride", "bicarbonate")),
            Version("with_potassium", "(Na + K) - (Cl + HCO3)", "Figge J, Bellomo R, Egi M. J Crit Care 2018;44:101-110 (AGK = Na + K - Cl - HCO3).", _anion_gap(True),
                    ("sodium", "potassium", "chloride", "bicarbonate"), note="The reference range is about 4 mEq/L higher when potassium is included.")],
           source=_KRAUT_2007, scope="Venous or arterial chemistry from one sample; the reference range is the laboratory's.", aliases=("ag",)))


def _corrected_ag(reference, per_g_dl, source):
    def compute(ctx):
        gap = ctx.value("sodium") - ctx.value("chloride") - ctx.value("bicarbonate")
        albumin = ctx.value("albumin")
        corrected = gap + per_g_dl * (reference - albumin)
        return Outcome(round_half_up(corrected, 1), "mEq/L", unrounded=corrected, rounding="1 decimal", steps={"observed_anion_gap": gap, "albumin_correction": per_g_dl * (reference - albumin)},
                       formula="(Na - Cl - HCO3) + %g x (%g - albumin g/dL)" % (per_g_dl, reference), notes=[_AG_NOTE],
                       rows=[ctx.row(i) for i in ("sodium", "chloride", "bicarbonate", "albumin")],
                       constants=[constant("correction per g/dL", per_g_dl, source), constant("reference albumin g/dL", reference, source)])
    return compute


_FIGGE_1998 = "Figge J, Jabor A, Kazda A, Fencl V. Anion gap and hypoalbuminemia. Crit Care Med 1998;26:1807-1810 (+0.25 mEq/L per g/L fall; the reference albumin 44 g/L = 4.4 g/dL is as used by Figge 2018, J Crit Care 44:101)."
_FELDMAN_2005 = "Feldman M, Soni N, Dickson B. Influence of hypoalbuminemia or hyperalbuminemia on the serum anion gap. J Lab Clin Med 2005;146:317-320."
_TEXTBOOK_AG = "Textbook rule of thumb: +2.5 mEq/L per 1 g/dL albumin below 4.0 g/dL (e.g. MSD Manual calculator; Wikipedia 'Anion gap'; MDCalc Journal review 2025). Not from a single primary source."
_add(Scale("albumin_corrected_anion_gap", "Albumin-corrected anion gap", "Acid-base", [NA, CL, HCO3, ALBUMIN],
           [Version("textbook_2_5", "Anion gap + 2.5 x (4.0 - albumin g/dL)", _TEXTBOOK_AG, _corrected_ag(4.0, 2.5, _TEXTBOOK_AG), ("sodium", "chloride", "bicarbonate", "albumin")),
            Version("figge_1998", "Anion gap + 2.5 x (4.4 - albumin g/dL) (Figge: 0.25 per g/L, normal albumin 44 g/L)", _FIGGE_1998, _corrected_ag(4.4, 2.5, _FIGGE_1998),
                    ("sodium", "chloride", "bicarbonate", "albumin")),
            Version("feldman_2005", "Anion gap + 2.3 x (4.0 - albumin g/dL)", _FELDMAN_2005, _corrected_ag(4.0, 2.3, _FELDMAN_2005), ("sodium", "chloride", "bicarbonate", "albumin"))],
           source=_FIGGE_1998 + " " + _TEXTBOOK_AG, scope="The default is the textbook form most calculators use; Figge's published reference albumin is 4.4 g/dL, which adds 1.0 mEq/L more. Both are reported.",
           aliases=("corrected anion gap", "albumin adjusted anion gap")))


_WRENN_1990 = "Wrenn K. The delta (delta) gap: an approach to mixed acid-base disorders. Ann Emerg Med 1990;19:1310-1313."
_RASTEGAR_2007 = "Rastegar A. Use of the DeltaAG/DeltaHCO3- ratio in the diagnosis of mixed acid-base disorders. J Am Soc Nephrol 2007;18:2429-2431."


def _delta(kind, normal_ag, normal_hco3):
    def compute(ctx):
        gap = ctx.value("sodium") - ctx.value("chloride") - ctx.value("bicarbonate")
        d_ag, d_hco3 = gap - normal_ag, normal_hco3 - ctx.value("bicarbonate")
        steps = {"anion_gap": gap, "delta_anion_gap": d_ag, "delta_bicarbonate": d_hco3}
        rows = [ctx.row(i) for i in ("sodium", "chloride", "bicarbonate")]
        constants = [constant("normal anion gap", normal_ag, "convention of the version (12 in most textbooks; 10-12 in MDCalc)"),
                     constant("normal bicarbonate", normal_hco3, "24 mEq/L in every source read")]
        if kind == "gap":
            value = d_ag - d_hco3
            category = ("concurrent metabolic alkalosis suggested (delta gap > +6)" if value > 6 else
                        "concurrent non-gap (hyperchloraemic) metabolic acidosis suggested (delta gap < -6)" if value < -6 else
                        "no additional disorder suggested (delta gap within -6 to +6)")
            return Outcome(round_half_up(value, 1), "mEq/L", category=category, unrounded=value, rounding="1 decimal", steps=steps, rows=rows, constants=constants,
                           formula="delta gap = (anion gap - %g) - (%g - HCO3)" % (normal_ag, normal_hco3), notes=["Wrenn's cut-offs of +/-6 are for a high-gap acidosis; Paulson 1993 found +/-8 in diabetic ketoacidosis."])
        if d_hco3 == 0:
            raise ScoreError(NOT_APPLICABLE, "The delta ratio is undefined when the bicarbonate deficit is zero (bicarbonate equals %g)." % normal_hco3)
        ratio = d_ag / d_hco3
        category = ("pure normal-anion-gap acidosis (< 0.4)" if ratio < 0.4 else "mixed high- and normal-anion-gap acidosis (0.4-0.8)" if ratio < 0.8 else
                    "pure high-anion-gap acidosis (0.8-2.0)" if ratio <= 2.0 else "high-anion-gap acidosis with a pre-existing metabolic alkalosis or compensated respiratory acidosis (> 2.0)")
        return Outcome(round_half_up(ratio, 2), "ratio", category=category, unrounded=ratio, rounding="2 decimals", steps=steps, rows=rows, constants=constants,
                       formula="delta ratio = (anion gap - %g) / (%g - HCO3)" % (normal_ag, normal_hco3),
                       notes=["Bands as in Rastegar 2007 and the textbooks citing it; sources differ at the edges (some use 1.0 and 2.0 only, Paulson and Gadallah 0.8-1.2); "
                              "the ratio is not interpretable when the bicarbonate deficit is small or the anion gap is below normal."])
    return compute


_DELTA_REQ = ("sodium", "chloride", "bicarbonate")
_add(Scale("delta_gap", "Delta gap (delta-delta)", "Acid-base", [NA, CL, HCO3],
           [Version("ag12_hco3_24", "Normal anion gap 12, normal bicarbonate 24", _WRENN_1990 + " Normal values as in Tsapenko, Oman Med J 2013;28:73 and the textbooks.", _delta("gap", 12, 24), _DELTA_REQ),
            Version("ag10_hco3_24", "Normal anion gap 10, normal bicarbonate 24", "Normal anion gap 10 as in MDCalc Journal review 2025 (10 to 12).", _delta("gap", 10, 24), _DELTA_REQ)],
           source=_WRENN_1990, scope="High-anion-gap metabolic acidosis; the normal values used are the version's, not the patient's own baseline.", aliases=("delta delta", "delta-delta", "delta anion gap")))
_add(Scale("delta_ratio", "Delta ratio (delta anion gap / delta bicarbonate)", "Acid-base", [NA, CL, HCO3],
           [Version("ag12_hco3_24", "Normal anion gap 12, normal bicarbonate 24", _RASTEGAR_2007 + " Normal values as in the textbooks citing it.", _delta("ratio", 12, 24), _DELTA_REQ),
            Version("ag10_hco3_24", "Normal anion gap 10, normal bicarbonate 24", "Normal anion gap 10 as in MDCalc Journal review 2025 (10 to 12).", _delta("ratio", 10, 24), _DELTA_REQ)],
           source=_RASTEGAR_2007, scope="High-anion-gap metabolic acidosis; undefined when the bicarbonate deficit is zero.", aliases=("delta ratio", "delta-delta ratio")))


def _fena(ctx):
    u_na, p_na, u_cr, p_cr = ctx.value("urine_sodium"), ctx.value("plasma_sodium"), ctx.value("urine_creatinine"), ctx.value("plasma_creatinine")
    value = 100 * (u_na * p_cr) / (p_na * u_cr)
    category = ("below 1%: prerenal pattern" if value < 1 else "1% to 2%: indeterminate" if value <= 2 else "above 2%: intrinsic renal (tubular) pattern")
    return Outcome(round_half_up(value, 2), "%", category=category, unrounded=value, rounding="2 decimals",
                   formula="FENa = 100 x (urine Na x plasma creatinine) / (plasma Na x urine creatinine)",
                   rows=[ctx.row(i) for i in ("urine_sodium", "plasma_sodium", "urine_creatinine", "plasma_creatinine")],
                   notes=["Thresholds: prerenal < 1% (Espinel 1976); intrinsic > 2% in reference tables and > 3% in Espinel's original series; > 1% in Steiner 1984 and MedlinePlus. "
                          "Unreliable with diuretics, chronic kidney disease or when urine output is not low (oliguria, < 500 mL/day)."])


_ESPINEL_1976 = "Espinel CH. The FENa test. Use in the differential diagnosis of acute renal failure. JAMA 1976;236:579-581."
_add(Scale("fena", "Fractional excretion of sodium (FENa)", "Renal",
           [Num("urine_sodium", "Urine sodium", "electrolyte", lo=0, hi=400), Num("plasma_sodium", "Serum sodium", "electrolyte", lo=80, hi=200),
            Num("urine_creatinine", "Urine creatinine", "creatinine", lo=0.1, hi=1000), Num("plasma_creatinine", "Serum creatinine", "creatinine", lo=0.05, hi=60)],
           [Version("espinel_1976", "FENa = UNa x PCr / (PNa x UCr) x 100", _ESPINEL_1976, _fena, ("urine_sodium", "plasma_sodium", "urine_creatinine", "plasma_creatinine"))],
           source=_ESPINEL_1976, scope="Oliguric acute kidney injury; creatinine of urine and plasma may be in different units (both are converted).", aliases=("fractional excretion of sodium",)))


_ADROGUE = "Adrogue HJ, Madias NE. Hypernatremia. N Engl J Med 2000;342:1493-1499 (total-body-water fractions as tabulated in MDCalc Journal 2025 and Namdar 2010, GMS Ger Med Sci 8:Doc11)."
_TBW = {"adult_male": 0.6, "adult_female": 0.5, "elderly_male": 0.5, "elderly_female": 0.45, "child": 0.6}


def _fwd(form):
    def compute(ctx):
        weight, na, group = ctx.value("weight"), ctx.value("sodium"), ctx.value("population")
        if na < 140:
            raise ScoreError(NOT_APPLICABLE, "A free water deficit is defined for hypernatraemia; serum sodium %g is below 140 mmol/L." % na)
        tbw = _TBW[group] * weight
        value = tbw * (na / 140 - 1) if form == "adrogue" else tbw * (1 - 140 / na)
        formula = "TBW x (Na / 140 - 1)" if form == "adrogue" else "TBW x (1 - 140 / Na)"
        return Outcome(round_half_up(value, 2), "L", unrounded=value, rounding="2 decimals", steps={"total_body_water_L": tbw, "tbw_fraction": _TBW[group]},
                       formula="%s; TBW = fraction x weight" % formula, rows=[ctx.row(i) for i in ("weight", "sodium", "population")],
                       constants=[constant("target sodium", 140, _ADROGUE), constant("TBW fraction", _TBW[group], _ADROGUE)],
                       notes=["Yun 2023 (Korean J Intern Med 38:290) deducts 5% for the elderly (elderly men 0.55); dehydrated patients are often given lower fractions (0.4-0.5). "
                              "The deficit is a replacement estimate: add the ongoing losses and correct no faster than 10 mEq/L in 24 h."])
    return compute


_add(Scale("free_water_deficit", "Free water deficit (hypernatraemia)", "Acid-base",
           [WEIGHT, Num("sodium", "Serum sodium", "electrolyte", lo=80, hi=250),
            Choice("population", "Group for the total-body-water fraction", [("adult_male", "adult man (0.6)", 0), ("adult_female", "adult woman (0.5)", 0), ("elderly_male", "elderly man (0.5)", 0),
                                                                              ("elderly_female", "elderly woman (0.45)", 0), ("child", "child (0.6)", 0)])],
           [Version("adrogue_madias", "TBW x (Na/140 - 1)", _ADROGUE, _fwd("adrogue"), ("weight", "sodium", "population")),
            Version("one_minus_140_over_na", "TBW x (1 - 140/Na) (the pre-loss water as TBW)", "Cheuvront SN et al., as quoted by Deranged Physiology 'Hypernatremia'. A secondary quotation.", _fwd("cheuvront"),
                    ("weight", "sodium", "population"))],
           source=_ADROGUE, scope="Adults and children with a serum sodium above 140 mmol/L.", aliases=("water deficit", "hypernatremia")))


def _osmolality(ethanol_divisor, source):
    def compute(ctx):
        na = ctx.value("sodium")
        glucose = ctx.parsed["glucose"]
        urea = ctx.parsed["urea_nitrogen"]
        g_term = glucose.native if glucose.unit == "mmol/L" else glucose.native / 18
        u_term = urea.native if urea.unit == "mmol/L" else urea.native / 2.8
        value = 2 * na + g_term + u_term
        rows = [ctx.row(i) for i in ("sodium", "glucose", "urea_nitrogen")]
        ethanol_term = None
        if ethanol_divisor:
            ethanol_term = ctx.value("ethanol") / ethanol_divisor
            value += ethanol_term
            rows.append(ctx.row("ethanol"))
        return Outcome(round_half_up(value, 1), "mOsm/kg", unrounded=value, rounding="1 decimal",
                       steps={"sodium_term": 2 * na, "glucose_term": g_term, "urea_term": u_term, **({"ethanol_term": ethanol_term} if ethanol_term is not None else {})},
                       formula="2 x Na + glucose/18 + BUN/2.8 (mg/dL), or 2 x Na + glucose + urea (mmol/L)%s" % (" + ethanol (mg/dL)/%g" % ethanol_divisor if ethanol_divisor else ""),
                       constants=[constant("glucose divisor (mg/dL)", 18, source), constant("BUN divisor (mg/dL)", 2.8, source)]
                       + ([constant("ethanol divisor (mg/dL)", ethanol_divisor, source)] if ethanol_divisor else []),
                       notes=["Each term uses the unit it was given in: mg/dL terms are divided, mmol/L terms are added as they are. Normal measured osmolality is about 275-295 mOsm/kg."])
    return compute


_SMITHLINE = "Smithline N, Gardner KD Jr. Gaps - anionic and osmolal. JAMA 1976;236:1594-1597; formula as quoted in Purssell RA et al. Ann Emerg Med 2001;38:653-659."
_HOFFMAN_1993 = "Hoffman RS et al. Osmol gaps revisited: normal values and limitations. J Toxicol Clin Toxicol 1993;31:81-93 (ethanol/4.6)."
_PURSSELL_2001 = "Purssell RA et al. Derivation and validation of a formula to calculate the contribution of ethanol to the osmolal gap. Ann Emerg Med 2001;38:653-659 (ethanol/3.7)."
_OSM_ITEMS = [NA, Num("glucose", "Serum glucose", "glucose", lo=10, hi=3000), Num("urea_nitrogen", "Blood urea nitrogen (mg/dL) or urea (mmol/L)", "urea_nitrogen", lo=0.5, hi=400),
              Num("ethanol", "Serum ethanol (mg/dL)", "number", lo=0, hi=1500, required=False, bare=True, note="only for the ethanol versions; a plain number is read as mg/dL")]
_add(Scale("serum_osmolality", "Calculated serum osmolality", "Acid-base", _OSM_ITEMS,
           [Version("smithline_gardner", "2Na + glucose/18 + BUN/2.8", _SMITHLINE, _osmolality(None, _SMITHLINE), ("sodium", "glucose", "urea_nitrogen")),
            Version("with_ethanol_3_7", "... + ethanol/3.7 (Purssell)", _PURSSELL_2001, _osmolality(3.7, _PURSSELL_2001), ("sodium", "glucose", "urea_nitrogen", "ethanol")),
            Version("with_ethanol_4_6", "... + ethanol/4.6 (Hoffman)", _HOFFMAN_1993, _osmolality(4.6, _HOFFMAN_1993), ("sodium", "glucose", "urea_nitrogen", "ethanol"))],
           source=_SMITHLINE, scope="Other published equations differ by additive constants and potassium terms (65 in Faria 2017 review); this is the standard one.", aliases=("osmolality", "osmolarity", "serum osm")))


def _na_correction(factor, source, name):
    def compute(ctx):
        na, glucose = ctx.value("sodium"), ctx.value("glucose")
        value = na + factor * (glucose - 100) / 100
        return Outcome(round_half_up(value, 1), "mmol/L", unrounded=value, rounding="1 decimal",
                       formula="Na + %g x (glucose - 100) / 100, glucose in mg/dL" % factor, rows=[ctx.row("sodium"), ctx.row("glucose")],
                       constants=[constant("sodium fall per 100 mg/dL of glucose above 100", factor, source), constant("reference glucose (mg/dL)", 100, "ADA 2009 (Kitabchi), Ing 2020 Front Med 7:477")],
                       notes=["Hillier 1999 found the relation non-linear: 1.6 up to a glucose of about 400 mg/dL and about 4.0 above it."])
    return compute


_KATZ = "Katz MA. Hyperglycemia-induced hyponatremia - calculation of expected serum sodium depression. N Engl J Med 1973;289:843-844 (1.6 mEq/L per 100 mg/dL; quoted by Hillier 1999)."
_HILLIER = "Hillier TA, Abbott RD, Barrett EJ. Hyponatremia: evaluating the correction factor for hyperglycemia. Am J Med 1999;106:399-403."
_add(Scale("sodium_correction_hyperglycemia", "Corrected serum sodium for hyperglycaemia", "Acid-base", [NA, Num("glucose", "Serum glucose", "glucose", lo=10, hi=3000)],
           [Version("katz_1_6", "1.6 mEq/L per 100 mg/dL above 100 (Katz)", _KATZ, _na_correction(1.6, _KATZ, "katz"), ("sodium", "glucose")),
            Version("hillier_2_4", "2.4 mEq/L per 100 mg/dL above 100 (Hillier)", _HILLIER, _na_correction(2.4, _HILLIER, "hillier"), ("sodium", "glucose"))],
           source=_KATZ + " " + _HILLIER, scope="Hyperglycaemia with a low measured sodium; the corrected value is an estimate of the sodium at normal glucose.", aliases=("corrected sodium", "sodium correction", "hyperglycemia sodium")))


# ---------------------------------------------------------------------------------------------------------------
# Opioid morphine milligram equivalents
# ---------------------------------------------------------------------------------------------------------------

_CDC_2016 = ("Dowell D, Haegerich TM, Chou R. CDC Guideline for Prescribing Opioids for Chronic Pain - United States, 2016. MMWR Recomm Rep 2016;65(1):1-49 "
             "(Table 'Calculating total daily dose of opioids for safer dosage'; adapted from Von Korff 2008 and the Washington State agency guideline).")
_CDC_2022 = ("Dowell D, Ragan KR, Jones CM, Baldwin GT, Chou R. CDC Clinical Practice Guideline for Prescribing Opioids for Pain - United States, 2022. MMWR Recomm Rep 2022;71(3):1-95 "
             "(Table 'Calculating total daily dose of opioids'; adapted from Von Korff 2008 and Nielsen 2016).")
# Doses are mg/day except fentanyl transdermal, which is mcg/hour. A factor of None means the version's table has no row for the drug.
_MME_2022 = {"codeine": 0.15, "fentanyl_transdermal": 2.4, "hydrocodone": 1.0, "hydromorphone": 5.0, "methadone": 4.7, "morphine": 1.0, "oxycodone": 1.5, "oxymorphone": 3.0,
             "tapentadol": 0.4, "tramadol": 0.2}
_MME_2016 = {"codeine": 0.15, "fentanyl_transdermal": 2.4, "hydrocodone": 1.0, "hydromorphone": 4.0, "methadone": "banded", "morphine": 1.0, "oxycodone": 1.5, "oxymorphone": 3.0,
             "tapentadol": 0.4, "tramadol": None}
_METHADONE_2016 = [(20, 4), (40, 8), (60, 10), (None, 12)]   # mg/day band upper limit -> factor; the printed table stops at 80 mg/day


class OpioidList(Item):
    """A list of opioids with the dose each is taken at: {drug, dose: {value, unit}, administrations_per_day}.

    A dose in mg is per administration and needs `administrations_per_day`; a dose in mg/day is the daily total;
    transdermal fentanyl is the patch strength in mcg/h."""
    kind = "list"

    def brief(self):
        return "list of {drug, dose: {value, unit}, administrations_per_day}"

    def parse(self, raw):
        if not isinstance(raw, list) or not raw or len(raw) > 12:
            raise ScoreError(INPUT_INVALID, "%s is a list of one to twelve opioids, each {drug, dose: {value, unit}, administrations_per_day}." % self.id, {"item": self.id})
        entries = []
        for position, entry in enumerate(raw):
            if not isinstance(entry, dict) or set(entry) - {"drug", "dose", "administrations_per_day"} or entry.get("drug") not in _MME_2022:
                raise ScoreError(INPUT_INVALID, "%s[%d]: give drug (one of %s), dose and administrations_per_day." % (self.id, position, ", ".join(_MME_2022)),
                                 {"item": self.id, "drugs": list(_MME_2022)})
            drug, dose = entry["drug"], entry.get("dose")
            if isinstance(dose, str):
                match = re.match(r"^\s*([0-9.]+)\s*(\S+)\s*$", dose)
                dose = {"value": float(match.group(1)), "unit": match.group(2)} if match else None
            if (not isinstance(dose, dict) or set(dose) != {"value", "unit"} or isinstance(dose["value"], bool) or not isinstance(dose["value"], (int, float))
                    or not math.isfinite(dose["value"]) or dose["value"] < 0):
                raise ScoreError(INPUT_INVALID, "%s[%d]: dose is {value, unit} with a non-negative number." % (self.id, position), {"item": self.id})
            unit = str(dose["unit"]).replace(" ", "").replace("µ", "u").replace("μ", "u").lower()
            if drug == "fentanyl_transdermal":
                if unit not in ("mcg/h", "ug/h", "mcg/hr", "ug/hr", "mcg/hour"):
                    raise ScoreError(UNIT_INVALID, "%s[%d]: transdermal fentanyl is the patch strength in mcg/h." % (self.id, position), {"item": self.id, "accepted_units": ["mcg/h"]})
                daily = dose["value"]   # the factor is applied to mcg/h
                shown = "%g mcg/h" % dose["value"]
            elif unit in ("mg/day", "mg/d", "mg/24h"):
                daily, shown = float(dose["value"]), "%g mg/day" % dose["value"]
            elif unit == "mg":
                per_day = entry.get("administrations_per_day")
                if isinstance(per_day, bool) or not isinstance(per_day, (int, float)) or not 0 < per_day <= 48:
                    raise ScoreError(INPUT_INVALID, "%s[%d]: a dose in mg needs administrations_per_day (a number above 0)." % (self.id, position), {"item": self.id})
                daily, shown = float(dose["value"]) * per_day, "%g mg x %g/day" % (dose["value"], per_day)
            else:
                raise ScoreError(UNIT_INVALID, "%s[%d]: dose unit %r is not mg (per administration), mg/day or, for transdermal fentanyl, mcg/h." % (self.id, position, dose["unit"]),
                                 {"item": self.id, "accepted_units": ["mg", "mg/day", "mcg/h (transdermal fentanyl)"]})
            entries.append({"drug": drug, "daily_dose": daily, "shown": shown})
        return Parsed(self, raw, entries)

    def describe(self):
        return {**super().describe(), "accepts": "list of {drug, dose: {value, unit}, administrations_per_day}", "drugs": list(_MME_2022),
                "units": "dose in mg (per administration, with administrations_per_day) or mg/day; transdermal fentanyl in mcg/h"}


def _mme(table, source, name):
    def compute(ctx):
        total, rows, notes = 0.0, [], []
        for entry in ctx.value("opioids"):
            drug, daily = entry["drug"], entry["daily_dose"]
            factor = table[drug]
            if factor is None:
                raise ScoreError(NOT_APPLICABLE, "%s has no row in the %s table." % (drug, name), {"item": "opioids", "drug": drug})
            if factor == "banded":
                factor = next(f for limit, f in _METHADONE_2016 if limit is None or daily <= limit)
                rule = "methadone %g mg/day: factor %g (2016 bands 1-20 = 4, 21-40 = 8, 41-60 = 10, >=61 = 12; the whole daily dose takes its band's factor)" % (daily, factor)
            else:
                rule = "%s %s x %g" % (drug, entry["shown"], factor)
            mme = daily * factor
            total += mme
            rows.append({"item": "opioids", "drug": drug, "input": entry["shown"], "daily_dose": daily, "factor": factor, "rule": rule, "mme_per_day": round_half_up(mme, 2)})
        notes.append("Do not use the MME total to convert from one opioid to another; incomplete cross-tolerance means the new opioid is dosed well below the calculated equivalent.")
        if "2022" in name:
            notes.append("Buprenorphine for pain is not in the table (partial agonist ceiling effects); the factors are not for opioid use disorder treatment. CDC 2022 thresholds: below 50, 50 or more, 90 or more MME/day.")
        return Outcome(round_half_up(total, 2), "MME/day", unrounded=total, rounding="2 decimals", rows=rows, notes=notes,
                       formula="sum over opioids of (total daily dose in mg, or mcg/h for transdermal fentanyl) x conversion factor",
                       constants=[constant("factors", ", ".join("%s %s" % (d, f) for d, f in table.items()), source)])
    return compute


_add(Scale("opioid_mme", "Opioid morphine milligram equivalents (MME) per day", "Medication",
           [OpioidList("opioids", "Opioids taken, with the dose of each")],
           [Version("cdc_2022", "CDC 2022 clinical practice guideline table", _CDC_2022, _mme(_MME_2022, _CDC_2022, "CDC 2022"), ("opioids",)),
            Version("cdc_2016", "CDC 2016 guideline table (hydromorphone 4, dose-banded methadone, no tramadol)", _CDC_2016, _mme(_MME_2016, _CDC_2016, "CDC 2016"), ("opioids",))],
           source=_CDC_2022 + " " + _CDC_2016, scope="Opioids prescribed for pain. Only the guideline tables are implemented; the CDC analytic compilation's other agents (buprenorphine, levorphanol, meperidine, butorphanol, pentazocine) are not included.",
           aliases=("mme", "morphine milligram equivalents", "opioid conversion", "morphine equivalent")))


# ---------------------------------------------------------------------------------------------------------------
# Corticosteroid equivalent doses
# ---------------------------------------------------------------------------------------------------------------

_DECADRON = "FDA label for Decadron (dexamethasone) Elixir: 'Dexamethasone 0.75 mg = methylprednisolone and triamcinolone 4 mg = prednisolone and prednisone 5 mg = hydrocortisone 20 mg = cortisone 25 mg'."
_LIU_2013 = ("Liu D et al. A practical guide to the monitoring and management of the complications of systemic corticosteroid therapy. Allergy Asthma Clin Immunol 2013;9:30, Table 3 "
             "(approximate equivalent doses for oral or IV use; betamethasone 0.6 mg).")
_NICE_BNF = "NICE/BNF 'Equivalent anti-inflammatory doses of oral corticosteroids' as reproduced by GPnotebook: prednisolone 5 mg = betamethasone 0.75 mg = cortisone acetate 25 mg = dexamethasone 0.75 mg = deflazacort 6 mg = hydrocortisone 20 mg = methylprednisolone 4 mg = triamcinolone 4 mg."
_STEROID_LIU = {"hydrocortisone": 20.0, "cortisone": 25.0, "prednisone": 5.0, "prednisolone": 5.0, "methylprednisolone": 4.0, "triamcinolone": 4.0, "dexamethasone": 0.75, "betamethasone": 0.6}
_STEROID_NICE = {**_STEROID_LIU, "betamethasone": 0.75, "deflazacort": 6.0}
_STEROIDS = ["hydrocortisone", "cortisone", "prednisone", "prednisolone", "methylprednisolone", "triamcinolone", "dexamethasone", "betamethasone", "deflazacort"]


def _steroid(table, source):
    def compute(ctx):
        source_drug, dose = ctx.value("from_drug"), ctx.value("dose")
        if source_drug not in table:
            raise ScoreError(NOT_APPLICABLE, "%s has no row in this table." % source_drug, {"item": "from_drug", "drugs": list(table)})
        base = dose / table[source_drug]
        converted = {drug: round_half_up(base * mg, 3) for drug, mg in table.items()}
        rows = [ctx.row("from_drug"), ctx.row("dose")]
        target = ctx.parsed["to_drug"].value if ctx.has("to_drug") else None
        if target is not None and target not in table:
            raise ScoreError(NOT_APPLICABLE, "%s has no row in this table." % target, {"item": "to_drug", "drugs": list(table)})
        if target is not None:
            rows.append(ctx.row("to_drug"))
        return Outcome(converted[target] if target else converted, "mg", rows=rows, steps={"equipotent_dose_mg_of_each": dict(table)},
                       formula="dose x (equipotent dose of the target / equipotent dose of the starting drug), the equipotent doses being those of the table",
                       constants=[constant("equipotent doses (mg)", ", ".join("%s %g" % (d, mg) for d, mg in table.items()), source)],
                       notes=["Anti-inflammatory equivalence for oral or intravenous use only; it ignores mineralocorticoid effect and duration of action, and intramuscular or intra-articular potency can differ greatly. "
                              "Sources disagree on betamethasone (0.6 or 0.75 mg) and deflazacort (5, 6 or 7.5 mg)."])
    return compute


_add(Scale("steroid_conversion", "Corticosteroid dose conversion", "Medication",
           [Choice("from_drug", "Corticosteroid the dose is given in", [(drug, drug, 0) for drug in _STEROIDS]),
            Num("dose", "Dose of that drug", "mass_dose", lo=0, hi=100000, bare=True, note="a plain number is read as mg"),
            Choice("to_drug", "Corticosteroid to express it in (omit for all)", [(drug, drug, 0) for drug in _STEROIDS], required=False)],
           [Version("liu_2013", "Equipotent doses of Liu 2013 / FDA label core set (betamethasone 0.6 mg)", _LIU_2013 + " " + _DECADRON, _steroid(_STEROID_LIU, _LIU_2013 + " " + _DECADRON), ("from_drug", "dose")),
            Version("nice_bnf", "Equipotent doses of NICE/BNF (betamethasone 0.75 mg, deflazacort 6 mg)", _NICE_BNF, _steroid(_STEROID_NICE, _NICE_BNF), ("from_drug", "dose"))],
           source=_LIU_2013 + " " + _NICE_BNF, scope="Systemic glucocorticoids, oral or intravenous. Answers every drug of the table unless to_drug names one.",
           aliases=("steroid equivalents", "glucocorticoid conversion", "prednisone equivalent", "steroid dose")))
