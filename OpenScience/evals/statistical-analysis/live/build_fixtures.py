"""Small synthetic continuity data plus the suite's frozen public WDBC data.

The formula makes fixture reproduction independent of an RNG/library version.
These are test subjects, not clinical records. Gold answers stay outside fixtures.
"""
import csv
import json
import hashlib
import math
from pathlib import Path
import shutil

HERE = Path(__file__).resolve().parent
OUT = HERE / 'fixtures'
OUT.mkdir(exist_ok=True)


def row(i):
    group = 'A' if i % 2 else 'B'
    return {'patient_id': f'S{i:03d}', 'group': group, 'age': 35 + i % 41,
            'marker_mm': round(10 + (3 if group == 'B' else 0) + math.sin(i) * 2 + i % 5 / 10, 6)}


def write(name, rows):
    with (OUT / name).open('w', newline='') as file:
        writer = csv.DictWriter(file, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)


write('cohort.csv', [row(i) for i in range(1, 81)])
extra = [row(i) for i in range(81, 101)] + [row(1)]
for r in extra:
    r['marker_cm'] = '' if r['patient_id'] in ('S083', 'S094') else round(r.pop('marker_mm') / 10, 7)
    r.pop('marker_mm', None)
write('supplement.csv', extra)
write('coding-correction.csv', [dict(row(i), group='A' if i % 2 == 0 else 'B') for i in range(1, 81)])
shutil.copyfile(HERE.parent / 'fixtures/breast-cancer.csv', OUT / 'breast-cancer.csv')
(OUT / 'dictionary.md').write_text('''# Continuity fixture dictionary

Synthetic, deterministic test records; no clinical efficacy claim is warranted.
Each patient_id is one independent subject, with one intended baseline observation.
Groups A and B are observational categories, not randomized interventions.
marker_mm is a continuous baseline measurement in millimetres. A blank is missing.
An identical repeat patient is an export duplicate; conflicting repeats require a stated resolution.
''')
(OUT / 'wdbc-dictionary.md').write_text('''# WDBC source and coding

Frozen UCI Wisconsin Diagnostic Breast Cancer data, mirrored by sklearn.datasets.load_breast_cancer.
Source: https://archive.ics.uci.edu/dataset/17/breast+cancer+wisconsin+diagnostic
breast_cancer_yn: 0 = malignant; 1 = benign. Malignancy is the event of interest.
Unnamed: 0 is a serialized row index, not a predictor. One record per tumor; this extract has no longitudinal patient identifier.
The features are measurements computed from digitized FNA images; this is exploratory public-data reanalysis, not clinical deployment validation.
''')
manifest = {'synthetic': ['cohort.csv', 'supplement.csv', 'coding-correction.csv'], 'public': ['breast-cancer.csv']}
manifest['derived'] = sorted(file.name for file in OUT.glob('prior-*') if file.is_file())
manifest['sha256'] = {file.name: hashlib.sha256(file.read_bytes()).hexdigest() for file in sorted(OUT.iterdir()) if file.is_file()}
(HERE / 'fixture-sources.json').write_text(json.dumps(manifest, indent=2) + '\n')
