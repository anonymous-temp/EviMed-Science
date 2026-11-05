# Patient matching

State: complete. Assessed: 1/1.

| Patient | Trial | Work state | Clinical eligibility | Priority | Rationale |
| --- | --- | --- | --- | --- | --- |
| P3077400b23eef602 | prt_202f1fa3ee824044a546d9 | complete | eligible |  | Both supplied protocol criteria are satisfied on preserved evidence: age 62 years (>= 18) and BMI 20.0 kg/m2 (< 25), the latter from the registered exact BMI calculation on weight 80 kg and height 2 m. Eligibility is therefore met. No prioritization or ranking criterion (e.g., competing-trial preference, biomarker, or urgency rule) was supplied in the frozen protocol, so recommendation priority is left unset rather than inferred; eligibility must not be read as a priority score. |

## P3077400b23eef602 / prt_202f1fa3ee824044a546d9

- crt_11cdd2019c8f43518f3c33: satisfied (stated). The protocol requires age at least 18 years. The preserved patient passage states 'Age 62 years.', so the subject is 44 years above the threshold and the criterion is satisfied on stated evidence with no inference required.
- crt_c54479bc89bf460087a17f: satisfied (computed). The protocol requires BMI less than 25 kg/m2. The registered BMI calculator (Quetelet, WHO adult categories) computed 80 kg / (2 m)^2 = 20.0 kg/m2 (unrounded 20, category normal weight), with both operands linked to their exact patient evidence passages. The exact calculated value 20.0 kg/m2 is below 25 kg/m2, so the criterion is satisfied on a computed basis.

Unresolved facts: None stated.

Assumptions: Only the two supplied protocol criteria (age >= 18 years, BMI < 25 kg/m2) were assessed; no disease, recruitment, or other requirements were added, and no protocol exclusions were present to evaluate.; Patient coverage was reported complete with no limitations, so the absence of further patient facts was not treated as a negative finding..
