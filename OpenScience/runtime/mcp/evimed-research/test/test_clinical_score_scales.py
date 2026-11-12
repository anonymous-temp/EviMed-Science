"""`clinical_score`: every scale against a worked example.

Each case says where its expected value comes from:

  SRC   the output is printed in the source itself (a paper, guideline, label or the author's own site)
  REF   an independent computation made by a different person's script while the definition was being verified (the
        inputs and outputs are in the verification notes, not derived from this code)
  HAND  worked by hand from the definition; the arithmetic is in the comment

None of the values below was read from any benchmark. A case that checks a boundary says which boundary and which
source states it.
"""
import json
import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.dont_write_bytecode = True
import clinical_score_kit as kit
import clinical_scores


def compute(scale, inputs, version=None, **extra):
    arguments = {"action": "compute", "id": scale, "inputs": inputs, **extra}
    if version:
        arguments["version"] = version
    reply = clinical_scores.call(arguments)
    json.dumps(reply)   # whatever a score returns goes over the wire as JSON: no date, set or tuple may leak into it
    return reply["data"]


def value(scale, inputs, version=None, **extra):
    return compute(scale, inputs, version, **extra)["result"]["value"]


def only(inputs, *names):
    return {name: inputs[name] for name in names}


MELD_ITEMS = ("bilirubin", "inr", "creatinine", "dialysis")


def alternatives(data):
    return {row["version"]: row.get("value") for row in data["alternatives"]}


class Cardiology(unittest.TestCase):
    def test_heart_versions_differ_at_their_printed_boundaries(self):
        base = {"history": "highly_suspicious", "ecg": "nonspecific_repolarisation", "age": 70, "risk_factor_count": 2, "atherosclerotic_disease": False, "troponin": 1.25}
        # HAND: age 2 + history 2 + ECG 1 + risk factors 1 + troponin 1.25x (1) = 7, high by both versions (Six 2008, Backus 2013)
        data = compute("heart", base)
        self.assertEqual((data["result"]["value"], data["version"]), (7, "backus_2013"))
        self.assertEqual(alternatives(data), {"six_2008": 7})
        # age 45: Backus prints "<=45" = 0, Six's text "45-65" = 1; age 65 scores 2 in both
        self.assertEqual(value("heart", {**base, "age": 45}) - value("heart", {**base, "age": 44}), 0)
        self.assertEqual(value("heart", {**base, "age": 45}, "six_2008") - value("heart", {**base, "age": 44}, "six_2008"), 1)
        self.assertEqual(value("heart", {**base, "age": 65}), value("heart", {**base, "age": 70}))
        # troponin 2.5x: Backus ">1-<3" = 1, Six ">2x" = 2; exactly 3x is 2 in both
        low = {**base, "troponin": 2.5}
        self.assertEqual(value("heart", low, "six_2008") - value("heart", low), 1)
        self.assertEqual(value("heart", {**base, "troponin": 3}), value("heart", {**base, "troponin": 3}, "six_2008"))
        # a history of atherosclerotic disease scores the risk-factor item 2 whatever the count
        self.assertEqual(value("heart", {**base, "risk_factor_count": 0, "atherosclerotic_disease": True}) - value("heart", {**base, "risk_factor_count": 0}), 2)

    def test_cha2ds2_vasc(self):
        # HAND: 72-year-old woman with hypertension and diabetes: H 1 + D 1 + age 65-74 1 + sex 1 = 4
        woman = {"chf": False, "hypertension": True, "age": 72, "diabetes": True, "stroke_tia_thromboembolism": False, "vascular_disease": False, "sex": "female"}
        data = compute("cha2ds2_vasc", woman)
        self.assertEqual(data["result"]["value"], 4)
        self.assertIn("recommended", data["result"]["category"])
        self.assertEqual(data["annual_event_rate_percent_by_source"]["Friberg 2012, Swedish AF cohort, ischaemic stroke"], 4.8)
        # HAND: 80-year-old man with prior TIA and heart failure: age 2 + stroke/TIA 2 + CHF 1 = 5
        self.assertEqual(value("cha2ds2_vasc", {**woman, "hypertension": False, "diabetes": False, "age": 80, "stroke_tia_thromboembolism": True, "chf": True, "sex": "male"}), 5)
        # SRC (ESC 2020 Table 8): maximum 9; the sex point alone is low risk in a woman and a score of 1 in a man is "consider"
        every = {**woman, "chf": True, "age": 80, "stroke_tia_thromboembolism": True, "vascular_disease": True}
        self.assertEqual(value("cha2ds2_vasc", every), 9)
        only_sex = {key: False for key in woman}
        only_sex.update({"age": 50, "sex": "female"})
        self.assertIn("low risk", compute("cha2ds2_vasc", only_sex)["result"]["category"])
        self.assertIn("considered", compute("cha2ds2_vasc", {**only_sex, "sex": "male", "hypertension": True})["result"]["category"])
        # the age points are exclusive: 65 earns 1, 75 earns 2
        self.assertEqual((value("cha2ds2_vasc", {**only_sex, "age": 64}), value("cha2ds2_vasc", {**only_sex, "age": 65}), value("cha2ds2_vasc", {**only_sex, "age": 75})), (1, 2, 3))

    def test_has_bled(self):
        # HAND: 70 years (+1), systolic 170 (+1), on aspirin (+1), 10 drinks a week (+1) = 4, high
        inputs = {"hypertension_uncontrolled": True, "abnormal_renal_function": False, "abnormal_liver_function": False, "stroke": False, "bleeding_history_or_predisposition": False,
                  "labile_inr": False, "age": 70, "antiplatelet_or_nsaid": True, "alcohol_excess": True}
        data = compute("has_bled", inputs)
        self.assertEqual(data["result"]["value"], 4)
        self.assertIn("high", data["result"]["category"])
        # SRC (ESC 2020 Table 10): "Aged >65": 65 earns nothing, 66 earns 1; maximum 9
        self.assertEqual(value("has_bled", {**inputs, "age": 65}), 3)
        self.assertEqual(value("has_bled", {key: (True if isinstance(v, bool) else 70) for key, v in inputs.items()}), 9)

    def test_framingham_hard_chd_tables_and_regression_against_an_independent_script(self):
        # REF: eight cases worked by the verifier's own script from the ATP III tables and the Framingham coefficients
        # (sex, age, TC, HDL, SBP, treated, smoker, table points, table risk, regression risk %)
        cases = [("male", 57, 220, 45, 135, False, True, 16, "25%", 17.1), ("male", 55, 210, 40, 130, False, True, 16, "25%", 16.5),
                 ("male", 45, 180, 55, 118, False, False, 6, "2%", 1.6), ("male", 70, 260, 38, 165, True, True, 19, ">=30%", 32.4),
                 ("female", 60, 240, 45, 150, True, False, 19, "8%", 6.6), ("female", 50, 200, 60, 120, False, False, 10, "1%", 0.5),
                 ("female", 65, 230, 50, 140, False, True, 19, "8%", 7.3), ("female", 55, 220, 55, 125, False, False, 13, "2%", 1.3)]
        for sex, age, tc, hdl, sbp, treated, smoker, points, risk, cox in cases:
            with self.subTest(sex=sex, age=age):
                inputs = {"sex": sex, "age": age, "total_cholesterol": "%d mg/dL" % tc, "hdl_cholesterol": "%d mg/dL" % hdl, "systolic_bp": "%d mmHg" % sbp, "bp_treated": treated, "smoker": smoker}
                data = compute("framingham_hard_chd", inputs)
                self.assertEqual((data["result"]["value"], data["steps"]["ten_year_risk"]), (points, risk))
                other = alternatives(data)
                self.assertAlmostEqual(other["atp_iii_regression"], cox, places=1)
                self.assertEqual(other["atp_iii_regression"], other["atp_iii_regression_treatment_any_sbp"], "the treatment flag only matters when treated and SBP <= 120")
        # the flag reading matters only below SBP 120 while treated
        treated_low = {"sex": "male", "age": 60, "total_cholesterol": "200 mg/dL", "hdl_cholesterol": "50 mg/dL", "systolic_bp": "110 mmHg", "bp_treated": True, "smoker": False}
        other = alternatives(compute("framingham_hard_chd", treated_low))
        self.assertLess(other["atp_iii_regression"], other["atp_iii_regression_treatment_any_sbp"])
        with self.assertRaises(kit.ScoreError) as caught:
            compute("framingham_hard_chd", {**treated_low, "age": 85})
        self.assertEqual(caught.exception.code, kit.NOT_APPLICABLE)


class Liver(unittest.TestCase):
    CP = {"bilirubin": "2.5 mg/dL", "albumin": "3.0 g/dL", "inr": 1.8, "ascites": "mild", "encephalopathy": "grade 1"}

    def test_child_pugh(self):
        # HAND: bilirubin 2.5 (2) + albumin 3.0 (2) + INR 1.8 (2) + slight ascites (2) + grade 1 (2) = 10, class C
        data = compute("child_pugh", self.CP)
        self.assertEqual(data["result"]["value"], 10)
        self.assertIn("class C", data["result"]["category"])
        self.assertEqual(alternatives(data)["inr_pbc_psc"], 9, "the PBC/PSC bilirubin bands put 2.5 mg/dL in the 1-point band")
        # HAND: the minimum, class A
        best = {"bilirubin": "1.2 mg/dL", "albumin": "4.0 g/dL", "inr": 1.1, "ascites": "absent", "encephalopathy": "none"}
        self.assertEqual((value("child_pugh", best), "class A" in compute("child_pugh", best)["result"]["category"]), (5, True))
        # boundaries implied by the FDA table: 3.0 mg/dL, 2.8 g/dL and INR 2.3 all fall in the 2-point column
        edge = {**best, "bilirubin": "3.0 mg/dL", "albumin": "2.8 g/dL", "inr": 2.3}
        self.assertEqual(value("child_pugh", edge), 5 + 3)
        self.assertEqual(value("child_pugh", {**edge, "bilirubin": "3.1 mg/dL", "albumin": "2.79 g/dL", "inr": 2.31}), 5 + 6)
        # the unit is converted, not guessed: 51.3 umol/L is 3.0 mg/dL
        self.assertEqual(value("child_pugh", {**best, "bilirubin": "51.3 umol/L"}), 5 + 1)
        self.assertEqual(value("child_pugh", {**best, "albumin": "28 g/L"}), 5 + 1)
        # Pugh's own coagulation measure, seconds over control
        pt = {key: val for key, val in best.items() if key != "inr"}
        self.assertEqual(value("child_pugh", {**pt, "pt_prolonged": "5 s"}, "pt_seconds"), 5 + 1)
        self.assertEqual(value("child_pugh", {**pt, "pt_prolonged": "6.5 s"}, "pt_seconds"), 5 + 2)

    def test_meld_family_against_an_independent_script(self):
        # REF case A: bilirubin 2.0, INR 1.5, creatinine 1.5, Na 130, albumin 3.0, female
        a = {"bilirubin": "2.0 mg/dL", "inr": 1.5, "creatinine": "1.5 mg/dL", "sodium": "130 mmol/L", "albumin": "3.0 g/dL", "sex": "female", "dialysis": False}
        data = compute("meld_na", a)
        self.assertEqual(value("meld", only(a, *MELD_ITEMS)), 17)
        self.assertAlmostEqual(data["result"]["unrounded"], 22.313, places=3)
        self.assertEqual((data["result"]["value"], alternatives(data)), (22, {"kim_2008": 23, "biggins_2006": 25, "meld_3_0": 24}))
        self.assertEqual(value("meld_3_0", a), 24)
        self.assertEqual(value("meld_3_0", {**a, "sex": "male"}), 22)
        # REF case B: bilirubin 12, INR 2.6, creatinine 3.8, Na 124 (-> 125), albumin 2.4, male
        b = {"bilirubin": "12 mg/dL", "inr": 2.6, "creatinine": "3.8 mg/dL", "sodium": "124 mmol/L", "albumin": "2.4 g/dL", "sex": "male", "dialysis": False}
        self.assertEqual(value("meld", only(b, *MELD_ITEMS)), 39)
        self.assertEqual(value("meld", {**only(b, *MELD_ITEMS), "dialysis": True}), 40, "dialysis sets creatinine to 4.0")
        self.assertEqual(value("meld_3_0", b), 40, "40.76 rounds to 41 and the OPTN cap is 40")
        self.assertEqual(compute("meld_na", b, "biggins_2006")["result"]["value"], 56, "Biggins 2006 can exceed 40")
        # REF case C: everything at its bound gives the minimum, 6
        c = {"bilirubin": "0.6 mg/dL", "inr": 1.0, "creatinine": "0.8 mg/dL", "sodium": "140 mmol/L", "albumin": "4.0 g/dL", "sex": "male", "dialysis": False}
        self.assertEqual((value("meld", only(c, *MELD_ITEMS)), value("meld_3_0", c)), (6, 6))
        # SRC (Kim 2008 NEJM): "a patient with a MELD score of 10 and a serum sodium of 125 would have a MELDNa score of 21"
        kim = {"bilirubin": "1.0 mg/dL", "inr": 1.0, "creatinine": "1.45 mg/dL", "sodium": "125 mmol/L", "dialysis": False}
        self.assertEqual(value("meld_na", kim, "kim_2008"), 21)
        # a unit slip is refused, not scaled: umol/L creatinine written as mg/dL is out of range
        with self.assertRaises(kit.ScoreError) as caught:
            compute("meld", {**only(kim, *MELD_ITEMS), "creatinine": "130 mg/dL"})
        self.assertEqual(caught.exception.code, kit.OUT_OF_RANGE)

    def test_glasgow_blatchford(self):
        # HAND: man, urea 9.0 mmol/L (3), Hb 11.0 (3), SBP 95 (2), pulse 110 (1), melaena (1), hepatic disease (2) = 12
        case = {"urea_nitrogen": "9.0 mmol/L", "hemoglobin": "11.0 g/dL", "sex": "male", "systolic_bp": "95 mmHg", "heart_rate": 110, "melaena": True, "syncope": False,
                "hepatic_disease": True, "cardiac_failure": False}
        data = compute("glasgow_blatchford", case)
        self.assertEqual(data["result"]["value"], 12)
        self.assertEqual(alternatives(data)["modified"], 3 + 3 + 2 + 1)
        # HAND: woman, urea 7.0 (2), Hb 11.0 (1), SBP 105 (1), pulse 90 (0), nothing else = 4; the same Hb in a man scores 3
        woman = {**case, "urea_nitrogen": "7.0 mmol/L", "sex": "female", "systolic_bp": "105 mmHg", "heart_rate": 90, "melaena": False, "hepatic_disease": False}
        self.assertEqual(value("glasgow_blatchford", woman), 4)
        self.assertEqual(value("glasgow_blatchford", {**woman, "sex": "male"}), 6)
        # maximum 23: urea >=25 (6) + Hb <10 (6) + SBP <90 (3) + pulse (1) + melaena (1) + syncope (2) + hepatic (2) + cardiac (2)
        worst = {"urea_nitrogen": "25 mmol/L", "hemoglobin": "9 g/dL", "sex": "male", "systolic_bp": "80 mmHg", "heart_rate": 120, "melaena": True, "syncope": True, "hepatic_disease": True, "cardiac_failure": True}
        self.assertEqual(value("glasgow_blatchford", worst), 23)
        # each unit is compared with the cut-off printed in it: urea 6.5 mmol/L and BUN 18.2 mg/dL both earn 2
        zero = {**woman, "urea_nitrogen": "6.4 mmol/L", "sex": "male", "hemoglobin": "14 g/dL", "systolic_bp": "130 mmHg", "heart_rate": 70}
        self.assertEqual((value("glasgow_blatchford", zero), value("glasgow_blatchford", {**zero, "urea_nitrogen": "6.5 mmol/L"}),
                          value("glasgow_blatchford", {**zero, "urea_nitrogen": "18.2 mg/dL"}), value("glasgow_blatchford", {**zero, "urea_nitrogen": "18.1 mg/dL"})), (0, 2, 2, 0))


class Renal(unittest.TestCase):
    def test_ckd_epi_2009_and_2021_against_an_independent_script(self):
        # REF (mL/min/1.73 m2): man 50 y creatinine 1.0 -> 87.37 (2009) and 91.69 (2021); woman 65 y 0.6 -> 95.65 / 99.55;
        # Black woman 40 y 1.4 -> 54.33 (2009, with the race term) / 48.77 (2021); man 70 y 2.5 -> 25.08 / 26.96
        cases = [("male", 50, 1.0, False, 87.37, 91.69), ("female", 65, 0.6, False, 95.65, 99.55), ("female", 40, 1.4, True, 54.33, 48.77), ("male", 70, 2.5, False, 25.08, 26.96)]
        for sex, age, scr, black, old, new in cases:
            with self.subTest(sex=sex, age=age):
                inputs = {"creatinine": "%g mg/dL" % scr, "age": age, "sex": sex}
                self.assertAlmostEqual(compute("ckd_epi_2009", {**inputs, "black_race": black})["result"]["unrounded"], old, places=1)
                self.assertAlmostEqual(compute("ckd_epi_2021", inputs)["result"]["unrounded"], new, places=1)
        # the 2009 equation restated with an age base of 0.9929 (Inker 2021 Table 2): 86.93 for the first case
        data = compute("ckd_epi_2009", {"creatinine": "1.0 mg/dL", "age": 50, "sex": "male", "black_race": False})
        self.assertAlmostEqual(alternatives(data)["inker_2021_table2"], 86.9, places=1)
        # a child is outside the population of both equations
        with self.assertRaises(kit.ScoreError) as caught:
            compute("ckd_epi_2021", {"creatinine": "0.6 mg/dL", "age": 9, "sex": "male"})
        self.assertEqual(caught.exception.code, kit.NOT_APPLICABLE)
        # creatinine in umol/L is converted at 88.4
        self.assertEqual(value("ckd_epi_2021", {"creatinine": "88.4 umol/L", "age": 50, "sex": "male"}), value("ckd_epi_2021", {"creatinine": "1.0 mg/dL", "age": 50, "sex": "male"}))

    def test_mdrd_both_constants_against_an_independent_script(self):
        # REF: man 50 y, creatinine 1.0: 175-form 79.10, 186-form 84.07; woman 65 y 0.6: 100.33 / 106.64; Black woman 40 y 1.4: 50.48 / 53.65
        for sex, age, scr, black, new, old in (("male", 50, 1.0, False, 79.10, 84.07), ("female", 65, 0.6, False, 100.33, 106.64), ("female", 40, 1.4, True, 50.48, 53.65)):
            with self.subTest(age=age):
                data = compute("mdrd", {"creatinine": "%g mg/dL" % scr, "age": age, "sex": sex, "black_race": black})
                self.assertAlmostEqual(data["result"]["unrounded"], new, places=1)
                self.assertAlmostEqual(alternatives(data)["original_186"], old, places=1)

    def test_cockcroft_gault(self):
        # SRC (the abstract): Ccr = (140 - age) x weight / (72 x Scr), 15% less in females. HAND: man 50 y 70 kg 1.0 -> 87.5; woman 65 y 60 kg 0.8 -> 66.41
        self.assertEqual(value("cockcroft_gault", {"age": 50, "weight": "70 kg", "creatinine": "1.0 mg/dL", "sex": "male"}), 87.5)
        self.assertAlmostEqual(compute("cockcroft_gault", {"age": 65, "weight": "60 kg", "creatinine": "0.8 mg/dL", "sex": "female"})["result"]["unrounded"], 66.41, places=2)
        # the weight basis is a version: ideal body weight needs the height, and the alternative says so when it is absent
        data = compute("cockcroft_gault", {"age": 50, "weight": "70 kg", "creatinine": "1.0 mg/dL", "sex": "male"})
        self.assertIn("height", {row["version"]: row for row in data["alternatives"]}["ideal_weight"]["not_computed"])
        tall = compute("cockcroft_gault", {"age": 50, "weight": "100 kg", "creatinine": "1.0 mg/dL", "sex": "male", "height": "175 cm"})
        values = alternatives(tall)
        self.assertLess(values["ideal_weight"], tall["result"]["value"])
        self.assertLess(values["ideal_weight"], values["adjusted_weight"])
        self.assertLess(values["adjusted_weight"], tall["result"]["value"])
        # pounds are converted
        self.assertEqual(value("cockcroft_gault", {"age": 50, "weight": {"value": 154.3235835, "unit": "lb"}, "creatinine": "1.0 mg/dL", "sex": "male"}), 87.5)

    def test_fena(self):
        # HAND: urine Na 10, plasma Na 140, urine Cr 100, plasma Cr 2.0 -> 100 x (10 x 2.0) / (140 x 100) = 0.143%
        data = compute("fena", {"urine_sodium": "10 mmol/L", "plasma_sodium": "140 mmol/L", "urine_creatinine": "100 mg/dL", "plasma_creatinine": "2.0 mg/dL"})
        self.assertEqual(data["result"]["value"], 0.14)
        self.assertIn("below 1%", data["result"]["category"])
        # HAND: 60, 138, 40, 3.0 -> 3.26%
        data = compute("fena", {"urine_sodium": "60 mmol/L", "plasma_sodium": "138 mmol/L", "urine_creatinine": "40 mg/dL", "plasma_creatinine": "3.0 mg/dL"})
        self.assertEqual(data["result"]["value"], 3.26)
        # the two creatinines may be in different units; they are converted before the ratio
        mixed = compute("fena", {"urine_sodium": "60 mmol/L", "plasma_sodium": "138 mmol/L", "urine_creatinine": "3536 umol/L", "plasma_creatinine": "3.0 mg/dL"})
        self.assertAlmostEqual(mixed["result"]["value"], 3.26, places=1)


class CriticalCare(unittest.TestCase):
    def test_gcs(self):
        # SRC (Teasdale, glasgowcomascale.org): "E2V4M6 = 12"; "a total score of 8 could be E2V2M4 or E1V1M6"
        self.assertEqual(value("gcs", {"eye": 2, "verbal": 4, "motor": 6}), 12)
        self.assertEqual((value("gcs", {"eye": 2, "verbal": 2, "motor": 4}), value("gcs", {"eye": 1, "verbal": 1, "motor": 6})), (8, 8))
        self.assertEqual((value("gcs", {"eye": 1, "verbal": 1, "motor": 1}), value("gcs", {"eye": 4, "verbal": 5, "motor": "6"})), (3, 15))
        self.assertIn("severe", compute("gcs", {"eye": 2, "verbal": 2, "motor": 4})["result"]["category"])
        # SRC (the FAQ): "Do not use number '1' to record a missing component; use NT" and "Do not report a total score when a component is Not Testable"
        with self.assertRaises(kit.ScoreError) as caught:
            compute("gcs", {"eye": 3, "verbal": "NT", "motor": 5})
        self.assertEqual(caught.exception.code, kit.NOT_APPLICABLE)
        with self.assertRaises(kit.ScoreError) as caught:
            compute("gcs", {"eye": 5, "verbal": 4, "motor": 5})
        self.assertEqual(caught.exception.code, kit.INPUT_INVALID)

    def test_sirs_and_qsofa(self):
        # HAND (SIRS, Bone 1992 thresholds are strict): T 38.4 (>38), HR 95 (>90), RR 18, WBC 10 -> 2 criteria
        sirs = {"temperature": "38.4 C", "heart_rate": 95, "respiratory_rate": 18, "wbc": "10 10^9/L"}
        data = compute("sirs", sirs)
        self.assertEqual(data["result"]["value"], 2)
        self.assertNotIn("could_be_higher", data)
        self.assertEqual(value("sirs", {**sirs, "temperature": "38.0 C", "heart_rate": 90}), 0, "38.0 and 90 are not above the thresholds")
        # PaCO2 below 32 is a second route to the respiratory criterion; when it was not given and could change the answer, the result says so
        none = compute("sirs", {**sirs, "temperature": "37 C", "heart_rate": 80})
        self.assertEqual(none["result"]["value"], 0)
        self.assertEqual(none["could_be_higher"]["possible_maximum"], 2)
        self.assertEqual(value("sirs", {**sirs, "temperature": "37 C", "heart_rate": 80, "paco2": "30 mmHg", "bands_percent": "12 %"}), 2)
        # 100.4 F is exactly 38.0 C, which is not above 38; 101 F is 38.3 C, which is; 39.1 F is not a body temperature in any unit and is refused
        self.assertEqual((value("sirs", {**sirs, "temperature": "100.4 F", "heart_rate": 80}), value("sirs", {**sirs, "temperature": "101 F", "heart_rate": 80})), (0, 1))
        with self.assertRaises(kit.ScoreError) as caught:
            compute("sirs", {**sirs, "temperature": "39.1 F"})
        self.assertEqual(caught.exception.code, kit.OUT_OF_RANGE)
        # HAND (qSOFA, Singer 2016): RR 24, SBP 95, altered mentation -> 3; RR 21, SBP 101 -> 0; thresholds RR >= 22 and SBP <= 100
        self.assertEqual(value("qsofa", {"respiratory_rate": 24, "altered_mentation": True, "systolic_bp": "95 mmHg"}), 3)
        self.assertEqual(value("qsofa", {"respiratory_rate": 21, "altered_mentation": False, "systolic_bp": "101 mmHg"}), 0)
        self.assertEqual(value("qsofa", {"respiratory_rate": 22, "altered_mentation": False, "systolic_bp": "100 mmHg"}), 2)
        self.assertIn("positive", compute("qsofa", {"respiratory_rate": 22, "altered_mentation": False, "systolic_bp": "100 mmHg"})["result"]["category"])

    def test_sofa(self):
        base = {"pao2_fio2": "450 mmHg", "respiratory_support": False, "platelets": "300 10^9/L", "bilirubin": "1.0 mg/dL", "mean_arterial_pressure": "80 mmHg", "dopamine": "0 ug/kg/min",
                "dobutamine": "0 ug/kg/min", "epinephrine": "0 ug/kg/min", "norepinephrine": "0 ug/kg/min", "glasgow_coma_scale": 15, "creatinine": "1.0 mg/dL"}
        self.assertEqual(value("sofa", base), 0)
        # HAND (Sepsis-3 Table 1): PaO2/FiO2 180 ventilated 3 + platelets 90 (2) + bilirubin 2.4 (2) + norepinephrine 0.15 (4) + GCS 12 (2) + creatinine 2.5 (2) = 15
        sick = {**base, "pao2_fio2": "180 mmHg", "respiratory_support": True, "platelets": "90 10^9/L", "bilirubin": "2.4 mg/dL", "norepinephrine": "0.15 ug/kg/min", "glasgow_coma_scale": 12, "creatinine": "2.5 mg/dL"}
        data = compute("sofa", sick)
        self.assertEqual((data["result"]["value"], data["steps"]["organ_scores"]["cardiovascular"]), (15, 4))
        # scores 3 and 4 of the respiratory system need respiratory support; without it a PaO2/FiO2 of 90 scores 2
        self.assertEqual(value("sofa", {**base, "pao2_fio2": "90 mmHg"}), 2)
        self.assertEqual(value("sofa", {**base, "pao2_fio2": "90 mmHg", "respiratory_support": True}), 4)
        # SRC (Table 1): the SI cut-offs are printed, so umol/L is compared as printed: 33 umol/L scores 2, though it is 1.93 mg/dL
        self.assertEqual((value("sofa", {**base, "bilirubin": "33 umol/L"}), value("sofa", {**base, "bilirubin": "1.93 mg/dL"})), (2, 1))
        self.assertEqual((value("sofa", {**base, "creatinine": "171 umol/L"}), value("sofa", {**base, "creatinine": "170 umol/L"})), (2, 1))
        # urine output can raise the renal score, and its absence is said
        self.assertEqual(value("sofa", {**base, "urine_output": "150 mL/day"}), 4)
        self.assertIn("Urine output was not given", compute("sofa", base)["notes"][0])
        # a pressor-free patient with MAP below 70 scores 1; dobutamine at any dose scores 2; dopamine over 15 scores 4
        self.assertEqual(value("sofa", {**base, "mean_arterial_pressure": "65 mmHg"}), 1)
        self.assertEqual(value("sofa", {**base, "dobutamine": "2 ug/kg/min"}), 2)
        self.assertEqual(value("sofa", {**base, "dopamine": "15.5 ug/kg/min"}), 4)

    def test_apache_ii(self):
        worst = {"temperature": "41 C", "mean_arterial_pressure": "160 mmHg", "heart_rate": 180, "respiratory_rate": 50, "fio2": "60 %", "aado2": "500 mmHg", "arterial_ph": 7.7,
                 "sodium": "180 mmol/L", "potassium": "7 mmol/L", "creatinine": "3.5 mg/dL", "acute_renal_failure": True, "hematocrit": "60 %", "wbc": "40 10^9/L",
                 "glasgow_coma_scale": 3, "age": 75, "severe_organ_insufficiency_or_immunocompromised": True, "admission_type": "non_operative"}
        # SRC (Merck Manual table adapted from Knaus 1985): "Minimum score = 0; maximum score = 71"
        data = compute("apache_ii", worst)
        self.assertEqual((data["result"]["value"], data["steps"]), (71, {"acute_physiology_score": 60, "age_points": 6, "chronic_health_points": 5}))
        normal = {"temperature": "37 C", "mean_arterial_pressure": "90 mmHg", "heart_rate": 80, "respiratory_rate": 16, "fio2": "0.3 fraction", "pao2": "90 mmHg", "arterial_ph": 7.4,
                  "sodium": "140 mmol/L", "potassium": "4 mmol/L", "creatinine": "1.0 mg/dL", "acute_renal_failure": False, "hematocrit": "40 %", "wbc": "8 10^9/L",
                  "glasgow_coma_scale": 15, "age": 40, "severe_organ_insufficiency_or_immunocompromised": False, "admission_type": "non_operative"}
        self.assertEqual(value("apache_ii", normal), 0)
        # chronic health: 5 points non-operative or emergency postoperative, 2 elective postoperative; age 75 scores 6 and 74 scores 5
        chronic = {**normal, "severe_organ_insufficiency_or_immunocompromised": True}
        self.assertEqual((value("apache_ii", chronic), value("apache_ii", {**chronic, "admission_type": "elective_postoperative"})), (5, 2))
        self.assertEqual((value("apache_ii", {**normal, "age": 74}), value("apache_ii", {**normal, "age": 75}), value("apache_ii", {**normal, "age": 44}), value("apache_ii", {**normal, "age": 45})), (5, 6, 0, 2))
        # oxygenation: FiO2 >= 0.5 is scored from the A-aDO2, and without it the calculation says what is missing
        with self.assertRaises(kit.ScoreError) as caught:
            compute("apache_ii", {k: v for k, v in {**normal, "fio2": "0.6 fraction"}.items() if k != "pao2"})
        self.assertEqual((caught.exception.code, caught.exception.data["missing"]), (kit.MISSING_INPUTS, ["aado2"]))
        self.assertEqual(value("apache_ii", {**normal, "fio2": "0.6 fraction", "aado2": "250 mmHg"}), 2)
        # creatinine 2.0 scores 3, doubled to 6 in acute renal failure; GCS contributes 15 minus the score
        self.assertEqual(value("apache_ii", {**normal, "creatinine": "2.0 mg/dL"}), 3)
        self.assertEqual(value("apache_ii", {**normal, "creatinine": "2.0 mg/dL", "acute_renal_failure": True}), 6)
        self.assertEqual(value("apache_ii", {**normal, "glasgow_coma_scale": 9}), 6)
        # a measurement not taken is scored 0 only when the caller says so
        without = {k: v for k, v in normal.items() if k != "potassium"}
        with self.assertRaises(kit.ScoreError):
            compute("apache_ii", without)
        reply = clinical_scores.call({"action": "compute", "id": "apache_ii", "inputs": without, "assume_absent": ["potassium"]})
        self.assertEqual((reply["status"], reply["data"]["result"]["value"]), ("warning", 0))

    def test_psi_port(self):
        calm = {"age": 45, "sex": "female", "nursing_home_resident": False, "neoplastic_disease": False, "liver_disease": False, "congestive_heart_failure": False, "cerebrovascular_disease": False,
                "renal_disease": False, "altered_mental_status": False, "respiratory_rate": 16, "systolic_bp": "120 mmHg", "temperature": "37 C", "heart_rate": 80}
        # HAND (Fine 1997 step 1): 45 years, no comorbid condition, no examination finding -> class I with no laboratory values
        data = compute("psi_port", calm)
        self.assertEqual((data["result"]["value"], data["steps"]["risk_class"]), ("Class I", 1))
        labs = {"arterial_ph": 7.30, "urea_nitrogen": "35 mg/dL", "sodium": "128 mmol/L", "glucose": "100 mg/dL", "hematocrit": "40 %", "pao2": "80 mmHg", "pleural_effusion": True}
        # HAND: 70-year-old man, nursing home +10, CHF +10, RR 32 +20, pH 7.30 +30, BUN 35 +20, Na 128 +20, effusion +10, age 70 = 190, class V
        old = {**calm, "age": 70, "sex": "male", "nursing_home_resident": True, "congestive_heart_failure": True, "respiratory_rate": 32, **labs}
        data = compute("psi_port", old)
        self.assertEqual((data["result"]["value"], data["steps"]["risk_class"]), (190, 5))
        # women score age minus 10; the class II/III boundary is 70/71 points
        woman = {**calm, "age": 61, "congestive_heart_failure": True, **{k: v for k, v in labs.items()}}
        woman.update({"arterial_ph": 7.4, "urea_nitrogen": "10 mg/dL", "sodium": "140 mmol/L", "pleural_effusion": False})
        self.assertEqual(value("psi_port", woman), 51 + 10)
        self.assertEqual(value("psi_port", {**woman, "age": 71}), 61 + 10, "ten years older, ten points more")
        # BUN is compared with its own unit: 30 mg/dL and 11 mmol/L both earn 20; 29.9 and 10.9 do not
        self.assertEqual((value("psi_port", {**woman, "urea_nitrogen": "30 mg/dL"}) - value("psi_port", woman), value("psi_port", {**woman, "urea_nitrogen": "11 mmol/L"}) - value("psi_port", woman),
                          value("psi_port", {**woman, "urea_nitrogen": "10.9 mmol/L"}) - value("psi_port", woman)), (20, 20, 0))
        # not class I, and a laboratory value missing: refused with the list, and assume_absent names exactly what is assumed
        sparse = {k: v for k, v in old.items() if k not in ("glucose", "pao2")}
        with self.assertRaises(kit.ScoreError) as caught:
            compute("psi_port", sparse)
        self.assertEqual(caught.exception.code, kit.MISSING_INPUTS)
        reply = clinical_scores.call({"action": "compute", "id": "psi_port", "inputs": sparse, "assume_absent": ["glucose", "pao2"]})
        self.assertEqual((reply["data"]["result"]["value"], reply["data"]["assumed_absent"]), (190, ["glucose", "pao2"]))

    def test_curb_65(self):
        base = {"confusion": False, "urea_nitrogen": "7 mmol/L", "respiratory_rate": 29, "systolic_bp": "90 mmHg", "diastolic_bp": "61 mmHg", "age": 64}
        self.assertEqual(value("curb_65", base), 0, "urea > 7, RR >= 30, SBP < 90, DBP <= 60 and age >= 65 are the thresholds, so none is met here")
        # HAND (Lim 2003): 72 years, new confusion, urea 9 mmol/L, RR 24, BP 110/70 -> confusion + urea + age = 3
        data = compute("curb_65", {"confusion": True, "urea_nitrogen": "9 mmol/L", "respiratory_rate": 24, "systolic_bp": "110 mmHg", "diastolic_bp": "70 mmHg", "age": 72})
        self.assertEqual(data["result"]["value"], 3)
        self.assertEqual(alternatives(data), {"crb_65": 2})
        # each unit is compared with its own cut-off: urea 7.1 mmol/L and BUN 19.1 mg/dL earn the point, 7.0 and 19.0 do not
        self.assertEqual((value("curb_65", {**base, "urea_nitrogen": "7.1 mmol/L"}), value("curb_65", {**base, "urea_nitrogen": "19.1 mg/dL"}), value("curb_65", {**base, "urea_nitrogen": "19.0 mg/dL"})), (1, 1, 0))
        # one point for low blood pressure however many of the two readings are low
        self.assertEqual(value("curb_65", {**base, "systolic_bp": "85 mmHg", "diastolic_bp": "50 mmHg"}), 1)
        self.assertEqual((value("curb_65", {**base, "diastolic_bp": "60 mmHg"}), value("curb_65", {**base, "age": 65}), value("curb_65", {**base, "respiratory_rate": 30})), (1, 1, 1))
        # CRB-65 asks for no urea
        crb = {k: v for k, v in base.items() if k != "urea_nitrogen"}
        self.assertEqual(value("curb_65", crb, "crb_65"), 0)


class Thrombosis(unittest.TestCase):
    def test_wells_dvt(self):
        none = {key: False for key in ("active_cancer", "paralysis_or_immobilisation", "bedridden_or_major_surgery", "deep_vein_tenderness", "entire_leg_swollen", "calf_swelling_3cm",
                                       "pitting_edema", "collateral_superficial_veins", "previous_dvt", "alternative_diagnosis_as_likely")}
        # HAND (NICE NG158 Table 1): active cancer, entire leg swollen, calf swelling 3 cm, alternative diagnosis as likely (-2) = 1: moderate, DVT unlikely
        case = {**none, "active_cancer": True, "entire_leg_swollen": True, "calf_swelling_3cm": True, "alternative_diagnosis_as_likely": True}
        data = compute("wells_dvt", case)
        self.assertEqual((data["result"]["value"], data["two_level"]), (1, "DVT unlikely (score 1 or less)"))
        self.assertIn("moderate", data["result"]["category"])
        # the same patient with pitting oedema and no alternative diagnosis = 4: high, DVT likely
        data = compute("wells_dvt", {**case, "pitting_edema": True, "alternative_diagnosis_as_likely": False})
        self.assertEqual((data["result"]["value"], data["two_level"]), (4, "DVT likely (score 2 or more)"))
        self.assertEqual(value("wells_dvt", {**none, "alternative_diagnosis_as_likely": True}), -2)
        self.assertEqual(value("wells_dvt", {key: (key != "alternative_diagnosis_as_likely") for key in none}), 9)

    def test_wells_pe(self):
        none = {"clinical_signs_dvt": False, "pe_most_likely_diagnosis": False, "heart_rate": 90, "immobilisation_or_surgery": False, "previous_pe_or_dvt": False, "hemoptysis": False, "malignancy": False}
        # HAND (Wells 2000): HR 110 (1.5) + immobilisation (1.5) + malignancy (1) = 4.0: moderate, PE unlikely (<= 4)
        case = {**none, "heart_rate": 110, "immobilisation_or_surgery": True, "malignancy": True}
        data = compute("wells_pe", case)
        self.assertEqual((data["result"]["value"], data["two_level"]), (4, "PE unlikely (score 4 or less)"))
        self.assertIn("moderate", data["result"]["category"])
        # adding haemoptysis gives 5.0, PE likely; DVT signs + PE most likely + HR 105 = 7.5, high
        self.assertEqual(compute("wells_pe", {**case, "hemoptysis": True})["two_level"], "PE likely (score above 4)")
        high = compute("wells_pe", {**none, "clinical_signs_dvt": True, "pe_most_likely_diagnosis": True, "heart_rate": 105})
        self.assertEqual((high["result"]["value"], "high" in high["result"]["category"]), (7.5, True))
        # the paper's three-level boundaries: 1.5 is low (< 2), 2 is moderate, 6 is moderate, 6.5 is high
        tiers = lambda **change: compute("wells_pe", {**none, **change})["result"]["category"]
        self.assertIn("low", tiers(heart_rate=101))
        self.assertIn("moderate", tiers(heart_rate=101, hemoptysis=True))
        self.assertIn("moderate", tiers(clinical_signs_dvt=True, pe_most_likely_diagnosis=True))
        self.assertIn("high", tiers(heart_rate=101, pe_most_likely_diagnosis=True, hemoptysis=True, malignancy=True))
        self.assertEqual(value("wells_pe", {key: (True if isinstance(v, bool) else 110) for key, v in none.items()}), 12.5)

    def test_rcri(self):
        none = {"high_risk_surgery": False, "ischemic_heart_disease": False, "heart_failure": False, "cerebrovascular_disease": False, "insulin_treatment": False, "creatinine": "1.0 mg/dL"}
        # HAND: intraperitoneal surgery, prior MI, creatinine 2.4 mg/dL, insulin = 4 -> class IV
        data = compute("rcri", {**none, "high_risk_surgery": True, "ischemic_heart_disease": True, "insulin_treatment": True, "creatinine": "2.4 mg/dL"})
        self.assertEqual(data["result"]["value"], 4)
        self.assertIn("class IV", data["result"]["category"])
        self.assertEqual(data["major_cardiac_complication_percent"]["Lee 1999 validation cohort (n=1422)"], 11)
        # SRC (Lee 1999 abstract): the creatinine threshold is above 2.0 mg/dL; 176.8 umol/L is exactly 2.0
        self.assertEqual((value("rcri", {**none, "creatinine": "2.0 mg/dL"}), value("rcri", {**none, "creatinine": "2.01 mg/dL"}), value("rcri", {**none, "creatinine": "177 umol/L"})), (0, 1, 1))
        self.assertEqual(value("rcri", {**none, "creatinine": "176 umol/L"}), 0)

    def test_perc(self):
        # HAND (Kline 2008): age 42, pulse 88, SaO2 98%, none of the five findings -> PERC negative
        clean = {"age": 42, "heart_rate": 88, "oxygen_saturation": "98 %", "unilateral_leg_swelling": False, "hemoptysis": False, "recent_surgery_or_trauma": False, "previous_pe_or_dvt": False, "hormone_use": False}
        data = compute("perc", clean)
        self.assertEqual(data["result"]["value"], 0)
        self.assertIn("PERC negative", data["result"]["category"])
        # SaO2 94% fails the 2008 criterion (>= 95%); age 50 and pulse 100 fail theirs
        self.assertEqual((value("perc", {**clean, "oxygen_saturation": "94 %"}), value("perc", {**clean, "age": 50}), value("perc", {**clean, "age": 49}), value("perc", {**clean, "heart_rate": 100})), (1, 1, 0, 1))
        self.assertIn("PERC positive", compute("perc", {**clean, "hormone_use": True})["result"]["category"])

    def test_caprini(self):
        # HAND (2005 weights): 66 years (2) + laparoscopic surgery over 45 min (2) + history of DVT (3) + central venous access (2) = 9, highest
        inputs = {"age": 66, "laparoscopic_surgery_over_45min": True, "history_dvt_pe": True, "central_venous_access": True}
        data = clinical_scores.call({"action": "compute", "id": "caprini", "inputs": inputs, "assume_absent": ["all"]})["data"]
        self.assertEqual(data["result"]["value"], 9)
        self.assertIn("highest", data["result"]["category"])
        self.assertEqual(len(data["assumed_absent"]), len(clinical_scores.SCALES["caprini"].items) - 4)
        # age bands are exclusive: 40 earns nothing, 41 one, 61 two, 75 three
        ages = [clinical_scores.call({"action": "compute", "id": "caprini", "inputs": {"age": a}, "assume_absent": ["all"]})["data"]["result"]["value"] for a in (40, 41, 60, 61, 74, 75)]
        self.assertEqual(ages, [0, 1, 1, 2, 2, 3])
        # a surgical patient with one 5-point finding and one 1-point finding is "highest" at 6; the ACCP table has no 'multiple trauma' item
        trauma = {"age": 30, "multiple_trauma_within_month": True, "minor_surgery": True}
        data = clinical_scores.call({"action": "compute", "id": "caprini", "inputs": trauma, "assume_absent": ["all"]})["data"]
        self.assertEqual(data["result"]["value"], 6)
        self.assertEqual(alternatives(data)["accp_2012_table7"], 1)
        # without assume_absent the missing findings are listed and nothing is computed
        with self.assertRaises(kit.ScoreError) as caught:
            compute("caprini", {"age": 30})
        self.assertEqual(caught.exception.code, kit.MISSING_INPUTS)
        self.assertEqual(caught.exception.data["possible_range"]["min"], 0)


class Infection(unittest.TestCase):
    def test_centor_and_mcisaac(self):
        child = {"tonsillar_exudate": True, "tender_anterior_cervical_nodes": True, "fever": True, "absence_of_cough": True, "age": 8}
        # HAND: 8-year-old with all four findings = 4 + 1 (age 3-14) = 5 (modified), 4 (original, with its 56% culture probability)
        data = compute("centor_mcisaac", child)
        self.assertEqual((data["result"]["value"], alternatives(data)), (5, {"centor_1981": 4}))
        self.assertIn("56%", compute("centor_mcisaac", child, "centor_1981")["result"]["category"])
        # HAND: 50-year-old with fever and no cough only = 2 - 1 = 1 (modified), 2 (original)
        adult = {"tonsillar_exudate": False, "tender_anterior_cervical_nodes": False, "fever": True, "absence_of_cough": True, "age": 50}
        self.assertEqual((value("centor_mcisaac", adult), value("centor_mcisaac", adult, "centor_1981")), (1, 2))
        # age bands: 14 earns +1, 15 earns 0, 44 earns 0, 45 earns -1
        self.assertEqual([value("centor_mcisaac", {**adult, "age": a}) for a in (14, 15, 44, 45)], [3, 2, 2, 1])
        with self.assertRaises(kit.ScoreError) as caught:
            compute("centor_mcisaac", {**adult, "age": 2})
        self.assertEqual(caught.exception.code, kit.NOT_APPLICABLE)
        # SRC (Centor 1981 abstract): all four variables 56%, three 32%, two 15%, one 6.5%, none 2.5%
        for variables, probability in ((3, "32%"), (2, "15%"), (1, "6.5%"), (0, "2.5%")):
            inputs = dict(zip(("tonsillar_exudate", "tender_anterior_cervical_nodes", "fever", "absence_of_cough"), [i < variables for i in range(4)]))
            self.assertIn(probability, compute("centor_mcisaac", {**inputs, "age": 30}, "centor_1981")["result"]["category"])

    def test_fever_pain(self):
        inputs = {"fever_last_24h": True, "purulence": True, "attend_rapidly": True, "inflamed_tonsils": False, "no_cough_or_coryza": True}
        # HAND (NICE NG84): four points -> "most likely to benefit", 62-65%
        data = compute("fever_pain", inputs)
        self.assertEqual(data["result"]["value"], 4)
        self.assertIn("62-65%", data["result"]["category"])
        self.assertIn("13-18%", compute("fever_pain", {key: False for key in inputs})["result"]["category"])
        self.assertIn("34-40%", compute("fever_pain", {**{key: False for key in inputs}, "purulence": True, "fever_last_24h": True})["result"]["category"])


class Chemistry(unittest.TestCase):
    def test_anion_gap_family(self):
        # HAND: Na 140, Cl 100, HCO3 10 -> AG 30; delta AG 18, delta HCO3 14 -> delta gap 4, delta ratio 18/14 = 1.29 (a pure high-gap acidosis)
        chem = {"sodium": "140 mmol/L", "chloride": "100 mmol/L", "bicarbonate": "10 mmol/L"}
        self.assertEqual(value("anion_gap", chem), 30)
        self.assertEqual(value("delta_gap", chem), 4)
        data = compute("delta_ratio", chem)
        self.assertEqual(data["result"]["value"], 1.29)
        self.assertIn("pure high-anion-gap", data["result"]["category"])
        # the other baseline: normal anion gap 10 -> delta gap 6, delta ratio 1.43
        self.assertEqual((alternatives(compute("delta_gap", chem))["ag10_hco3_24"], alternatives(data)["ag10_hco3_24"]), (6, 1.43))
        # the potassium-inclusive gap needs potassium and says so when it is absent
        self.assertIn("potassium", {row["version"]: row for row in compute("anion_gap", chem)["alternatives"]}["with_potassium"]["not_computed"])
        self.assertEqual(value("anion_gap", {**chem, "potassium": "4 mmol/L"}, "with_potassium"), 34)
        # a bicarbonate of exactly 24 leaves the delta ratio undefined, and says so
        with self.assertRaises(kit.ScoreError) as caught:
            compute("delta_ratio", {**chem, "bicarbonate": "24 mmol/L"})
        self.assertEqual(caught.exception.code, kit.NOT_APPLICABLE)

    def test_albumin_corrected_anion_gap_versions(self):
        # HAND (Figge 1998 and the textbook rule): AG 10, albumin 2.0 g/dL -> textbook 10 + 2.5 x (4.0 - 2.0) = 15, Figge 10 + 2.5 x (4.4 - 2.0) = 16, Feldman 10 + 2.3 x 2.0 = 14.6
        chem = {"sodium": "140 mmol/L", "chloride": "104 mmol/L", "bicarbonate": "26 mmol/L", "albumin": "2.0 g/dL"}
        data = compute("albumin_corrected_anion_gap", chem)
        self.assertEqual((data["result"]["value"], alternatives(data)), (15.0, {"figge_1998": 16.0, "feldman_2005": 14.6}))
        # albumin in g/L is converted: 20 g/L is 2.0 g/dL
        self.assertEqual(value("albumin_corrected_anion_gap", {**chem, "albumin": "20 g/L"}), 15.0)

    def test_osmolality_sodium_correction_and_free_water(self):
        # HAND: Na 140, glucose 90 mg/dL, BUN 14 mg/dL -> 280 + 5.0 + 5.0 = 290.0; the SI inputs of the same patient (5.0 and 5.0 mmol/L) give the same
        mgdl = {"sodium": "140 mmol/L", "glucose": "90 mg/dL", "urea_nitrogen": "14 mg/dL"}
        self.assertEqual(value("serum_osmolality", mgdl), 290.0)
        self.assertEqual(value("serum_osmolality", {**mgdl, "glucose": "5.0 mmol/L", "urea_nitrogen": "5.0 mmol/L"}), 290.0)
        # ethanol 200 mg/dL adds 54.05 (/3.7, Purssell 2001) or 43.48 (/4.6, Hoffman 1993)
        self.assertAlmostEqual(value("serum_osmolality", {**mgdl, "ethanol": 200}, "with_ethanol_3_7"), 344.1, places=1)
        self.assertAlmostEqual(value("serum_osmolality", {**mgdl, "ethanol": 200}, "with_ethanol_4_6"), 333.5, places=1)
        # HAND (Katz 1.6 and Hillier 2.4): Na 125, glucose 600 mg/dL -> 125 + 1.6 x 5 = 133.0 and 125 + 2.4 x 5 = 137.0
        data = compute("sodium_correction_hyperglycemia", {"sodium": "125 mmol/L", "glucose": "600 mg/dL"})
        self.assertEqual((data["result"]["value"], alternatives(data)), (133.0, {"hillier_2_4": 137.0}))
        # SRC (JBDS 2023): "corrected Na+ = 122 + (2.4 x 4) = 131.6"; the glucose 4 x 5.5 mmol/L above normal is 500 mg/dL (the input is reconstructed)
        self.assertEqual(value("sodium_correction_hyperglycemia", {"sodium": "122 mmol/L", "glucose": "500 mg/dL"}, "hillier_2_4"), 131.6)
        # HAND: 70 kg man, Na 160: TBW 42 L, deficit 42 x (160/140 - 1) = 6.00 L, or 5.25 L with the (1 - 140/Na) form; the elderly woman: 27 L x (156/140 - 1) = 3.09
        man = {"weight": "70 kg", "sodium": "160 mmol/L", "population": "adult_male"}
        data = compute("free_water_deficit", man)
        self.assertEqual((data["result"]["value"], alternatives(data)), (6.0, {"one_minus_140_over_na": 5.25}))
        self.assertEqual(value("free_water_deficit", {"weight": "60 kg", "sodium": "156 mmol/L", "population": "elderly_female"}), 3.09)
        with self.assertRaises(kit.ScoreError) as caught:
            compute("free_water_deficit", {**man, "sodium": "135 mmol/L"})
        self.assertEqual(caught.exception.code, kit.NOT_APPLICABLE)


class Medication(unittest.TestCase):
    def test_opioid_mme_against_the_cdc_examples(self):
        # SRC (CDC 2016 and 2022 footnote): hydrocodone 5 mg four times a day = 20 mg = 20 MME/day; extended-release oxycodone 10 mg twice a day = 20 mg = 30 MME/day
        hydrocodone = {"opioids": [{"drug": "hydrocodone", "dose": {"value": 5, "unit": "mg"}, "administrations_per_day": 4}]}
        oxycodone = {"opioids": [{"drug": "oxycodone", "dose": {"value": 10, "unit": "mg"}, "administrations_per_day": 2}]}
        for version in ("cdc_2022", "cdc_2016"):
            self.assertEqual((value("opioid_mme", hydrocodone, version), value("opioid_mme", oxycodone, version)), (20, 30), version)
        # the versions differ drug by drug: hydromorphone 4 (2016) against 5.0 (2022); methadone 30 mg/day is 8 x 30 = 240 (2016 band 21-40) against 4.7 x 30 = 141
        hydromorphone = {"opioids": [{"drug": "hydromorphone", "dose": {"value": 8, "unit": "mg"}, "administrations_per_day": 3}]}
        data = compute("opioid_mme", hydromorphone)
        self.assertEqual((data["result"]["value"], alternatives(data)["cdc_2016"]), (120, 96))
        methadone = {"opioids": [{"drug": "methadone", "dose": {"value": 30, "unit": "mg/day"}}]}
        data = compute("opioid_mme", methadone)
        self.assertEqual((data["result"]["value"], alternatives(data)["cdc_2016"]), (141, 240))
        # the 2016 bands: 20 mg/day x 4, 21 x 8, 41 x 10, 61 x 12 (the whole daily dose takes its band's factor)
        self.assertEqual([value("opioid_mme", {"opioids": [{"drug": "methadone", "dose": {"value": mg, "unit": "mg/day"}}]}, "cdc_2016") for mg in (20, 21, 41, 61)], [80, 168, 410, 732])
        # transdermal fentanyl is the patch strength in mcg/h x 2.4; several opioids add
        mixed = {"opioids": [{"drug": "fentanyl_transdermal", "dose": {"value": 25, "unit": "mcg/h"}}, {"drug": "morphine", "dose": {"value": 30, "unit": "mg/day"}}]}
        self.assertEqual(value("opioid_mme", mixed), 60 + 30)
        # tramadol has a factor only in 2022 (0.2): 50 mg x 4 = 200 mg -> 40; the 2016 alternative says it has no row
        tramadol = {"opioids": [{"drug": "tramadol", "dose": {"value": 50, "unit": "mg"}, "administrations_per_day": 4}]}
        data = compute("opioid_mme", tramadol)
        self.assertEqual(data["result"]["value"], 40)
        self.assertIn("no row", {row["version"]: row for row in data["alternatives"]}["cdc_2016"]["not_computed"])

    def test_opioid_mme_refuses_a_dose_without_its_unit_or_frequency(self):
        for bad, code in (({"drug": "morphine", "dose": 30}, kit.INPUT_INVALID), ({"drug": "morphine", "dose": {"value": 30, "unit": "mg"}}, kit.INPUT_INVALID),
                          ({"drug": "morphine", "dose": {"value": 30, "unit": "g"}}, kit.UNIT_INVALID), ({"drug": "fentanyl_transdermal", "dose": {"value": 25, "unit": "mg"}}, kit.UNIT_INVALID),
                          ({"drug": "heroin", "dose": {"value": 30, "unit": "mg/day"}}, kit.INPUT_INVALID)):
            with self.subTest(bad=bad):
                with self.assertRaises(kit.ScoreError) as caught:
                    compute("opioid_mme", {"opioids": [bad]})
                self.assertEqual(caught.exception.code, code)

    def test_steroid_conversion(self):
        # SRC (Goodman and Gilman 2023 as copied in a protocol): "Triamcinolone 8 mg x 1.25 = Prednisone 10 mg"
        self.assertEqual(value("steroid_conversion", {"from_drug": "triamcinolone", "dose": 8, "to_drug": "prednisone"}), 10)
        # HAND (FDA Decadron label equivalents 0.75 : 4 : 5 : 20 : 25): dexamethasone 6 mg = prednisone 40 mg = hydrocortisone 160 mg; methylprednisolone 16 mg = prednisone 20 mg
        table = value("steroid_conversion", {"from_drug": "dexamethasone", "dose": "6 mg"})
        self.assertEqual((table["prednisone"], table["hydrocortisone"], table["methylprednisolone"]), (40, 160, 32))
        self.assertEqual(value("steroid_conversion", {"from_drug": "methylprednisolone", "dose": 16, "to_drug": "prednisone"}), 20)
        # betamethasone is the version-dependent drug: 3 mg = 25 mg prednisone with Liu 2013 (0.6), 20 mg with NICE/BNF (0.75)
        data = compute("steroid_conversion", {"from_drug": "betamethasone", "dose": 3, "to_drug": "prednisone"})
        self.assertEqual((data["result"]["value"], alternatives(data)["nice_bnf"]), (25, 20))
        # deflazacort is only in the NICE table
        data = compute("steroid_conversion", {"from_drug": "prednisone", "dose": 10, "to_drug": "deflazacort"}, "nice_bnf")
        self.assertEqual(data["result"]["value"], 12)
        with self.assertRaises(kit.ScoreError):
            compute("steroid_conversion", {"from_drug": "deflazacort", "dose": 6})


class BodyAndCardiac(unittest.TestCase):
    def test_bmi(self):
        # SRC (WHO TRS 894, section 2.3): "an adult who weighs 70 kg and whose height is 1.75 m will have a BMI of 22.9"
        data = compute("bmi", {"weight": "70 kg", "height": "1.75 m"})
        self.assertEqual((data["result"]["value"], data["result"]["category"]), (22.9, "normal weight"))
        # SRC (Table 2.1): <18.5, 18.5-24.99, 25-29.99 (pre-obese), 30-34.99, 35-39.99, >=40, compared on the exact value
        for kg, category in ((53.4, "underweight"), (53.5, "normal weight"), (72.2, "normal weight"), (72.3, "overweight (pre-obese)"), (86.7, "obesity class I"),
                             (101.2, "obesity class II"), (115.6, "obesity class III")):
            self.assertEqual(compute("bmi", {"weight": "%g kg" % kg, "height": "170 cm"})["result"]["category"], category, kg)
        # HAND: 95 kg, 1.70 m -> 32.87, class I; pounds and inches convert
        self.assertEqual(value("bmi", {"weight": "95 kg", "height": "1.70 m"}), 32.9)
        self.assertEqual(value("bmi", {"weight": {"value": 209.4392, "unit": "lb"}, "height": {"value": 66.92913, "unit": "in"}}), 32.9)

    def test_bsa_against_an_independent_script(self):
        # REF (m2, the verifier's script): 70 kg 175 cm -> Mosteller 1.8447, Du Bois 1.8481, Haycock 1.8468, Gehan-George 1.8539, Boyd 1.8507;
        # 60 kg 150 cm -> 1.5811, 1.5479, 1.5991, 1.6045, 1.6240; 10 kg 75 cm -> 0.4564, 0.4373, 0.4635, 0.4762, 0.4806
        cases = {("70 kg", "175 cm"): (1.8447, 1.8481, 1.8468, 1.8539, 1.8507), ("60 kg", "150 cm"): (1.5811, 1.5479, 1.5991, 1.6045, 1.6240), ("10 kg", "75 cm"): (0.4564, 0.4373, 0.4635, 0.4762, 0.4806)}
        for (weight, height), expected in cases.items():
            data = compute("bsa", {"weight": weight, "height": height})
            got = {data["version"]: data["result"]["unrounded"], **{row["version"]: row["value"] for row in data["alternatives"]}}
            self.assertEqual(data["version"], "mosteller")
            for name, want in zip(("mosteller", "dubois", "haycock", "gehan_george", "boyd"), expected):
                self.assertAlmostEqual(got[name], want, delta=0.0006, msg="%s %s %s" % (name, weight, height))
        # SRC (Du Bois and Du Bois 1916, a chart reading): a man 150 cm tall weighing 60 kg has "approximately 1.55 square meters"
        self.assertAlmostEqual(value("bsa", {"weight": "60 kg", "height": "150 cm"}, "dubois"), 1.55, places=2)

    def test_ideal_and_adjusted_body_weight(self):
        # HAND (constants of Peterson 2016, Table 3): man 70 in -> Devine 50 + 23 = 73.0, Robinson 52 + 19 = 71.0, Miller 56.2 + 14.1 = 70.3, Hamwi 166 lb = 75.3 kg
        man = {"height": {"value": 70, "unit": "in"}, "sex": "male"}
        data = compute("ideal_body_weight", man)
        self.assertEqual((data["result"]["value"], alternatives(data)), (73.0, {"robinson": 71.0, "miller": 70.3, "hamwi": 75.3}))
        # woman 64 in -> 45.5 + 9.2 = 54.7, 49 + 6.8 = 55.8, 53.1 + 5.44 = 58.5, Hamwi 120 lb = 54.4 kg
        woman = {"height": {"value": 64, "unit": "in"}, "sex": "female"}
        data = compute("ideal_body_weight", woman)
        self.assertEqual((data["result"]["value"], alternatives(data)), (54.7, {"robinson": 55.8, "miller": 58.5, "hamwi": 54.4}))
        # under 60 inches the formulas extrapolate and the result says so
        self.assertIn("extrapolates", compute("ideal_body_weight", {"height": "150 cm", "sex": "female"})["notes"][0])
        # HAND: IBW 73.0, actual 120 kg: 73 + 0.4 x 47 = 91.8; 0.3 -> 87.1; 0.43 -> 93.2
        abw = {**man, "weight": "120 kg"}
        data = compute("adjusted_body_weight", abw)
        self.assertEqual((data["result"]["value"], alternatives(data)), (91.8, {"factor_0_3": 87.1, "factor_0_43": 93.2}))

    def test_mean_arterial_pressure(self):
        # HAND: (120 + 2 x 80) / 3 = 93.3, equal to 80 + (120 - 80) / 3
        self.assertEqual(value("mean_arterial_pressure", {"systolic": "120 mmHg", "diastolic": "80 mmHg"}), 93.3)
        # SRC (Klabunde): 120/80 "approximately 93 mmHg"; the Meaney form on the 210/90 example quoted for it: 130 against 139
        data = compute("mean_arterial_pressure", {"systolic": "210 mmHg", "diastolic": "90 mmHg"})
        self.assertEqual((data["result"]["value"], alternatives(data)), (130.0, {"meaney_0_412": 139.4}))
        self.assertAlmostEqual(value("mean_arterial_pressure", {"systolic": "16 kPa", "diastolic": "10.665 kPa"}), 93.3, delta=0.2)

    def test_friedewald_ldl(self):
        # HAND: 200 - 50 - 150/5 = 120 mg/dL; the same patient in mmol/L (5.2, 1.3, 1.7): 5.2 - 1.3 - 1.7/2.2 = 3.127 mmol/L
        self.assertEqual(value("ldl_friedewald", {"total_cholesterol": "200 mg/dL", "hdl_cholesterol": "50 mg/dL", "triglycerides": "150 mg/dL"}), 120.0)
        si = compute("ldl_friedewald", {"total_cholesterol": "5.2 mmol/L", "hdl_cholesterol": "1.3 mmol/L", "triglycerides": "1.7 mmol/L"})
        self.assertEqual((si["result"]["value"], si["result"]["unit"]), (3.1, "mmol/L"))
        # the estimate is not valid from 400 mg/dL (4.5 mmol/L) up, as in Friedewald 1972
        for tg in ("400 mg/dL", "4.6 mmol/L"):
            with self.assertRaises(kit.ScoreError) as caught:
                compute("ldl_friedewald", {"total_cholesterol": "300 mg/dL", "hdl_cholesterol": "40 mg/dL", "triglycerides": tg})
            self.assertEqual(caught.exception.code, kit.NOT_APPLICABLE)
        self.assertEqual(value("ldl_friedewald", {"total_cholesterol": "300 mg/dL", "hdl_cholesterol": "40 mg/dL", "triglycerides": "399 mg/dL"}), 180.2)

    def test_qtc_formulas(self):
        # HAND: QT 400 ms, heart rate 80 (RR 0.75 s): Bazett 400/sqrt(0.75) = 461.9, Fridericia 400/0.75^(1/3) = 440.3, Framingham 400 + 154 x 0.25 = 438.5, Hodges 400 + 1.75 x 20 = 435.0
        data = compute("qtc", {"qt_interval": "400 ms", "heart_rate": 80})
        self.assertEqual((data["version"], data["result"]["value"], alternatives(data)), ("bazett", 461.9, {"fridericia": 440.3, "framingham": 438.5, "hodges": 435.0, "rautaharju_2014": 444.4}))
        # REF (the verifier's arithmetic, QT in ms): QT 400, HR 75 -> Bazett 447.21, Fridericia 430.89, Framingham 430.80, Hodges 426.25, Rautaharju 2014 433.33;
        # QT 380, HR 100 -> 490.58, 450.54, 441.60, 450.00, 464.44; QT 440, HR 50 -> 401.66, 414.06, 409.20, 422.50, 415.56
        for qt, hr, expected in ((400, 75, (447.21, 430.89, 430.80, 426.25, 433.33)), (380, 100, (490.58, 450.54, 441.60, 450.00, 464.44)), (440, 50, (401.66, 414.06, 409.20, 422.50, 415.56))):
            data = compute("qtc", {"qt_interval": "%d ms" % qt, "heart_rate": hr})
            got = {data["version"]: data["result"]["unrounded"], **{row["version"]: row["value"] for row in data["alternatives"]}}
            for name, want in zip(("bazett", "fridericia", "framingham", "hodges", "rautaharju_2014"), expected):
                self.assertAlmostEqual(got[name], want, delta=0.06, msg="%s QT %d HR %d" % (name, qt, hr))
        # at 60 beats a minute (RR = 1 s) every correction but the 2014 model returns the measured QT
        data = compute("qtc", {"qt_interval": "0.4 s", "heart_rate": 60})
        self.assertEqual((data["result"]["value"], {name: v for name, v in alternatives(data).items() if name != "rautaharju_2014"}),
                         (400.0, {"fridericia": 400.0, "framingham": 400.0, "hodges": 400.0}))
        self.assertEqual(alternatives(data)["rautaharju_2014"], 400.0, "(120 + 60) / 180 = 1")

    def test_maintenance_fluids(self):
        # HAND (Holliday-Segar): 70 kg -> 4 x 10 + 2 x 10 + 1 x 50 = 110 mL/h and 1000 + 500 + 20 x 50 = 2500 mL/day; 8 kg -> 32 mL/h, 800 mL/day; 15 kg -> 50 mL/h, 1250 mL/day
        for weight, hourly, daily in ((70, 110, 2500), (8, 32, 800), (15, 50, 1250), (10, 40, 1000), (20, 60, 1500)):
            data = compute("maintenance_fluids", {"weight": "%d kg" % weight})
            self.assertEqual((data["result"]["value"], data["result"]["unit"], alternatives(data)["daily_100_50_20"]), (hourly, "mL/h", daily), weight)
        # SRC (Holliday, Ray and Friedman 2007, Table 5, the 1957 rules by weight): 12 kg 1100, 16 kg 1300, 20 kg 1500, 30 kg 1700, 45 kg 2000, 70 kg 2500 mL/day
        for weight, daily in ((12, 1100), (16, 1300), (20, 1500), (30, 1700), (45, 2000), (70, 2500)):
            self.assertEqual(value("maintenance_fluids", {"weight": "%d kg" % weight}, "daily_100_50_20"), daily, weight)
        # the hourly rule is not the table's hourly column (rounded to 5): 70 kg gives 110 mL/h, the table 100

    def test_pregnancy_dates(self):
        # SRC (ACOG CO 700): "By convention, the EDD is 280 days after the first day of the LMP". HAND: 1 January 2026 + 280 days = 8 October 2026; 70 days on 12 March is 10 weeks 0 days, first trimester
        data = compute("pregnancy_dates", {"lmp": "2026-01-01", "as_of": "2026-03-12"})
        self.assertEqual((data["version"], data["result"]["value"], data["estimated_date_of_conception"]), ("lmp_280_days", "2026-10-08", "2026-01-15"))
        self.assertEqual((data["steps"]["gestational_age"], data["steps"]["trimester"], data["steps"]["days_to_due_date"]), ("10w0d", 1, 210))
        # ACOG trimesters: first up to 13 6/7 weeks (97 days), second 14 0/7 to 27 6/7, third from 28 0/7
        trimesters = [compute("pregnancy_dates", {"lmp": "2026-01-01", "as_of": day})["steps"]["trimester"] for day in ("2026-04-08", "2026-04-09", "2026-07-15", "2026-07-16")]
        self.assertEqual(trimesters, [1, 2, 2, 3])
        # HAND (python date arithmetic, the verifier's examples): Naegele's calendar rule differs from +280 days by 0 to 2 days
        for lmp, days280, calendar in (("2024-03-01", "2024-12-06", "2024-12-08"), ("2023-06-10", "2024-03-16", "2024-03-17"), ("2023-12-25", "2024-09-30", "2024-10-02"),
                                       ("2025-01-31", "2025-11-07", "2025-11-07"), ("2024-05-31", "2025-03-07", "2025-03-07")):
            data = compute("pregnancy_dates", {"lmp": lmp})
            self.assertEqual((data["result"]["value"], alternatives(data)["naegele_calendar"]), (days280, calendar), lmp)
        # the cycle adjustment: 32 days is 4 days later than 28; 28 days is no change
        self.assertEqual(value("pregnancy_dates", {"lmp": "2023-06-10", "cycle_length": "32 days"}, "lmp_cycle_adjusted"), "2024-03-20")
        self.assertEqual(value("pregnancy_dates", {"lmp": "2026-01-01", "cycle_length": "28 days"}, "lmp_cycle_adjusted"), "2026-10-08")
        # SRC (ACOG CO 700): a day-5 embryo gives an EDD 261 days from the transfer date, a day-3 embryo 263; HAND: conception 10 January 2024 + 266 days
        self.assertEqual(value("pregnancy_dates", {"transfer_date": "2024-01-10", "embryo_age": 5}, "ivf_transfer"), "2024-09-27")
        self.assertEqual(value("pregnancy_dates", {"transfer_date": "2024-01-10", "embryo_age": 3}, "ivf_transfer"), "2024-09-29")
        self.assertEqual(value("pregnancy_dates", {"conception_date": "2024-01-10"}, "conception"), "2024-10-02")
        # HAND: due 6 December 2024, on 15 September 2024 82 days remain, so 198 days = 28 weeks 2 days
        data = compute("pregnancy_dates", {"estimated_due_date": "2024-12-06", "as_of": "2024-09-15"}, "from_due_date")
        self.assertEqual((data["steps"]["gestational_age"], data["steps"]["trimester"], data["steps"]["days_to_due_date"]), ("28w2d", 3, 82))
        for bad in ("01/01/2026", "2026-02-30", "yesterday"):
            with self.assertRaises(kit.ScoreError) as caught:
                compute("pregnancy_dates", {"lmp": bad})
            self.assertEqual(caught.exception.code, kit.INPUT_INVALID)


class LaboratoryIndices(unittest.TestCase):
    def test_corrected_calcium_in_either_unit(self):
        # HAND: 8.0 + 0.8 x (4.0 - 2.5) = 9.2 mg/dL; 2.0 mmol/L is 8.016 mg/dL, 25 g/L is 2.5 g/dL, so 8.016 + 1.2 = 9.216
        self.assertEqual(value("corrected_calcium", {"calcium": "8.0 mg/dL", "albumin": "2.5 g/dL"}), 9.2)
        data = compute("corrected_calcium", {"calcium": "2.0 mmol/L", "albumin": "25 g/L"})
        self.assertEqual((data["result"]["value"], data["result"]["unit"]), (9.22, "mg/dL"))
        self.assertAlmostEqual(data["steps"]["corrected_mmol_per_L"], 9.216 / 4.008, places=9)
        with self.assertRaises(kit.ScoreError) as caught:
            compute("corrected_calcium", {"calcium": "8.0", "albumin": "2.5 g/dL"})
        self.assertEqual(caught.exception.code, kit.UNIT_INVALID)

    def test_fib4_and_its_cut_offs(self):
        # HAND: 60 x 40 / (200 x sqrt(25)) = 2400 / 1000 = 2.4; a platelet count per microlitre is converted to 10^9/L
        inputs = {"age": 60, "ast": "40 U/L", "alt": "25 U/L", "platelets": "200 10^9/L"}
        data = compute("fib4", inputs)
        self.assertEqual(data["result"]["value"], 2.4)
        self.assertIn("indeterminate", data["result"]["category"])
        self.assertEqual(value("fib4", {**inputs, "platelets": "200000 /uL"}), 2.4)
        # the same value is below the NAFLD upper cut-off 2.67 and above no lower one: both versions say indeterminate, 3.25 and 2.67 differ at 3.0
        high = compute("fib4", {**inputs, "platelets": "80 10^9/L"})
        self.assertEqual(high["result"]["value"], 6.0)
        self.assertEqual({row["version"]: row["category"] for row in high["alternatives"]}["nafld_shah_2009"], "2.67 or above: advanced fibrosis likely")
        mid = compute("fib4", {**inputs, "platelets": "160 10^9/L"})   # 2400 / 800 = 3.0
        self.assertEqual(mid["result"]["value"], 3.0)
        self.assertIn("indeterminate", mid["result"]["category"])
        self.assertIn("likely", {row["version"]: row["category"] for row in mid["alternatives"]}["nafld_shah_2009"])
        with self.assertRaises(kit.ScoreError) as caught:
            compute("fib4", {**inputs, "alt": "0 U/L"})
        self.assertIn(caught.exception.code, (kit.OUT_OF_RANGE, kit.NOT_APPLICABLE))

    def test_homa_ir_uses_the_divisor_of_the_unit_given(self):
        # HAND: 90 mg/dL x 9 / 405 = 2.0 and 5 mmol/L x 9 / 22.5 = 2.0; a pmol/L insulin of 62.505 is 9.0 uIU/mL
        self.assertEqual(value("homa_ir", {"glucose": "90 mg/dL", "insulin": "9 uIU/mL"}), 2.0)
        data = compute("homa_ir", {"glucose": "5 mmol/L", "insulin": "9 uIU/mL"})
        self.assertEqual(data["result"]["value"], 2.0)
        self.assertIn("22.5", data["formula"])
        self.assertAlmostEqual(compute("homa_ir", {"glucose": "5 mmol/L", "insulin": "62.505 pmol/L"})["result"]["unrounded"], 2.0, places=6)

    def test_target_weight(self):
        # HAND: BMI 25 at 2.00 m is 25 x 4 = 100 kg; at 78 inches (1.9812 m) and BMI 22.6, 88.7 kg
        self.assertEqual(value("target_weight", {"bmi": "25 kg/m2", "height": "200 cm"}), 100.0)
        self.assertEqual(value("target_weight", {"bmi": "22.6 kg/m^2", "height": "78 in"}), 88.7)

    def test_the_delta_scales_correct_for_albumin_only_when_it_is_given(self):
        # HAND: Na 140, Cl 100, HCO3 14 -> AG 26; albumin 2.0 g/dL adds 2.5 x 2.0 = 5, so 31; delta AG 19, delta HCO3 10 -> delta gap 9, ratio 1.9
        chem = {"sodium": "140 mmol/L", "chloride": "100 mmol/L", "bicarbonate": "14 mmol/L"}
        plain = compute("delta_gap", chem)
        self.assertEqual((plain["result"]["value"], plain["steps"]["delta_anion_gap"]), (4.0, 14))
        corrected = compute("delta_gap", {**chem, "albumin": "2.0 g/dL"})
        self.assertEqual((corrected["result"]["value"], corrected["steps"]["delta_anion_gap"], corrected["steps"]["albumin_corrected_anion_gap"]), (9.0, 19, 31))
        self.assertEqual(value("delta_ratio", {**chem, "albumin": "2.0 g/dL"}), 1.9)
        self.assertEqual(value("delta_ratio", chem), 1.4)


class PooledCohortEquations(unittest.TestCase):
    CASE = {"age": 55, "total_cholesterol": "213 mg/dL", "hdl_cholesterol": "50 mg/dL", "systolic_bp": "120 mmHg", "bp_treated": False, "smoker": False, "diabetes": False}

    def test_the_four_equations_on_one_patient(self):
        # SRC (the guideline's worked cases, as remembered): white woman 2.1%, African American woman 3.0%.
        # REF (an independent script, the formula typed afresh): white man 5.4%, African American man 6.1%.
        expected = {("female", "white_or_other"): 2.1, ("female", "african_american"): 3.0, ("male", "white_or_other"): 5.4, ("male", "african_american"): 6.1}
        for (sex, race), risk in expected.items():
            self.assertEqual(value("ascvd_pce", {**self.CASE, "sex": sex, "race": race}), risk, (sex, race))

    def test_treatment_and_smoking_raise_the_risk_and_the_category_follows(self):
        base = {**self.CASE, "sex": "male", "race": "white"}
        smoker = compute("ascvd_pce", {**base, "smoker": True})
        self.assertIn("intermediate", smoker["result"]["category"])
        everything = compute("ascvd_pce", {**base, "smoker": True, "diabetes": True, "bp_treated": True})
        self.assertGreater(everything["result"]["value"], smoker["result"]["value"])
        self.assertIn("high", everything["result"]["category"])

    def test_age_outside_the_derivation_range_is_declined(self):
        with self.assertRaises(kit.ScoreError) as caught:
            compute("ascvd_pce", {**self.CASE, "sex": "male", "race": "white", "age": 35})
        self.assertEqual(caught.exception.code, kit.NOT_APPLICABLE)


if __name__ == "__main__":
    unittest.main()
