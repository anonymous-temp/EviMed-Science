"""A longitudinal dataset and its second delivery, for the dataset-semantics checks.

`visits_v1.csv` is forty patients with three to six visits each (180 rows); `patients.csv`
and `outcomes.csv` are the other two tables a real extract has. `visits_v2.csv` is the same
extract delivered again with exactly three differences and nothing else:

- one **renamed column**: `sbp` is now `systolic_bp`;
- one **unit change**: `creatinine` is now in mg/dL (it was µmol/L) under the same header;
- **duplicated visit rows**: three visits appear twice, identical.

Built from a fixed seed, so the files are the same bytes on every machine and the committed
copies under `fixtures/semantics/` can be uploaded to a project by hand for the live exercise;
`test_data_semantics_checks.py` holds the committed copies equal to what this builds.
"""

from __future__ import annotations

import csv
import io
import random
from datetime import date, timedelta
from pathlib import Path

UMOL_PER_MGDL = 88.4
PATIENTS = 40
VISIT_COUNTS = (3, 4, 5, 6)
DUPLICATED = (7, 61, 130)  # 0-based positions in v1 of the visits that appear twice in v2


def _csv(rows) -> str:
    out = io.StringIO()
    csv.writer(out, lineterminator="\n").writerows(rows)
    return out.getvalue()


def build():
    """{file name: text} of every fixture file."""
    rng = random.Random(20261004)
    patients = [["patient_id", "sex", "arm", "site"]]
    visits = [["patient_id", "visit_no", "visit_date", "sbp", "creatinine", "heart_rate"]]
    outcomes = [["patient_id", "window_start", "event_date", "event"]]
    for index in range(PATIENTS):
        patient_id = "P%03d" % (index + 1)
        patients.append([patient_id, "M" if rng.random() < 0.5 else "F", "A" if index % 2 == 0 else "B", "S%d" % (index % 3 + 1)])
        count = VISIT_COUNTS[index % len(VISIT_COUNTS)]
        first = date(2023, 1, 1) + timedelta(days=index % 20)
        dates = []
        for visit in range(1, count + 1):
            when = first + timedelta(days=30 * visit)
            dates.append(when)
            visits.append([patient_id, str(visit), when.isoformat(), str(rng.randint(100, 180)), "%.1f" % rng.uniform(55, 180), str(rng.randint(55, 105)) if rng.random() > 0.05 else ""])
        # The window opens at the third visit; the event comes a month after the last.
        outcomes.append([patient_id, dates[2].isoformat(), (dates[-1] + timedelta(days=30)).isoformat(), str(int(rng.random() < 0.3))])
    v2 = [["patient_id", "visit_no", "visit_date", "systolic_bp", "creatinine", "heart_rate"]]
    for position, row in enumerate(visits[1:]):
        converted = [row[0], row[1], row[2], row[3], "%.2f" % (float(row[4]) / UMOL_PER_MGDL), row[5]]
        v2.append(converted)
        if position in DUPLICATED:
            v2.append(list(converted))
    dictionary = [
        ["variable", "label", "unit", "type"],
        ["patient_id", "Patient identifier", "", "text"],
        ["visit_no", "Visit number", "", "integer"],
        ["visit_date", "Date of visit", "", "date"],
        ["sbp", "Systolic blood pressure", "mmHg", "integer"],
        ["creatinine", "Serum creatinine", "umol/L", "number"],
        ["heart_rate", "Heart rate", "beats/min", "integer"],
    ]
    return {
        "visits_v1.csv": _csv(visits), "visits_v2.csv": _csv(v2), "patients.csv": _csv(patients),
        "outcomes.csv": _csv(outcomes), "dictionary.csv": _csv(dictionary),
    }


def write(directory) -> dict:
    """Write every fixture file under `directory`; returns {name: Path}."""
    base = Path(directory)
    base.mkdir(parents=True, exist_ok=True)
    paths = {}
    for name, text in build().items():
        paths[name] = base / name
        paths[name].write_text(text, encoding="utf-8", newline="")
    return paths


if __name__ == "__main__":  # regenerate the committed copies: python3 test/semantics_fixtures.py
    write(Path(__file__).resolve().parent / "fixtures" / "semantics")
