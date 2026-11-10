# evals/paper-gold

Published results as a corpus, and the library that scores against it. Nothing here imports `apps/server`.

Public: the method manifests (FAERS ROR, meta REML, MR IVW: publication ids, source hashes, per-case outcome counts, no input and no number), the aggregate and economics reference manifests, the calibration candidates. Hidden, built by `prepare_*` from preserved primary sources into the protected evaluation directory (`paper-gold/candidate-cases`): the inputs and reference numbers.

Library: `numericScore` and `tolerance.mjs` (a printed number to half a unit of its last digit, another implementation's output to a relative 1e-6; `tolerance-vectors.json` is shared with the Python port in `score_existing_methods.py`), and `promotion.mjs`, the rule a tool is promoted by on published papers (at least five reproduced publications and a one-sided 95% Clopper-Pearson lower bound of at least 0.5: 5 of 5 meets it at 0.55, 5 of 6 does not at 0.42, 7 of 8 does at 0.53; the first measured outcome of a paper stands and a publication's failure is not hidden by a pass).

Measured 2026-11-04 as a benchmark family for tool-patch rounds and rejected: 16 independent publications in the method manifests (22 with the aggregate and economics ones, 34 counting twelve derived interval cases), against the 37 a qualified claim needs (25 confirmation groups inside the failure slice plus 12 development rows).
