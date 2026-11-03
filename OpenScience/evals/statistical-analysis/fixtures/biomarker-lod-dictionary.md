# Biomarker file dictionary (synthetic)

Invented for evaluation; it describes no patient.

- `participant_id`: one row per participant; each appears once.
- `group`: `control` or `treated`, as allocated.
- `biomarker_ngml`: serum concentration in ng/mL. The assay's limit of quantification is 0.5 ng/mL. A value written `<0.5` means the measurement was below that limit: the concentration exists but is unknown, and it is not zero and not 0.5.
