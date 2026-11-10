#!/usr/bin/env python3
"""Paired stay-level bootstrap of frozen HR predictions; not fit or site uncertainty."""
import csv, json, os, random, pathlib
from statistics import mean
root = pathlib.Path(__file__).resolve().parents[3]
p = pathlib.Path(os.environ.get('VCR_EVAL_OUTPUT', root / '.evimed-local/acceptance/vcr-professional-full-20261105/clinical')).resolve()
rng = random.Random(20261105)
output = {'replicates': 500, 'seed': 20261105, 'scope': 'Paired stay bootstrap on fixed fitted predictions; excludes training, generator, hospital and selection uncertainty.', 'splits': {}}
for split in 'bc':
    with (p / f'hr-{split}-paired.csv').open() as f: rows = list(csv.DictReader(f))
    with (p / f'hr-pred-{split}' / 'prognostic-predictions.csv').open() as f: pred = {r['patientId']: float(r['prediction']) for r in csv.DictReader(f)}
    values = [(float(r['hr_early']), float(r['hr_24']), pred[r['USUBJID']]) for r in rows]
    def stats(sample):
        actual = [t for _, t, _ in sample]; prediction = [v for _, _, v in sample]
        xbar, ybar = mean(prediction), mean(actual)
        variance = sum((x-xbar)**2 for x in prediction)
        slope = sum((x-xbar)*(y-ybar) for x,y in zip(prediction,actual))/variance
        return {'model_mae': mean(abs(v-t) for _,t,v in sample), 'persistence_mae': mean(abs(e-t) for e,t,_ in sample), 'mae_improvement': mean(abs(e-t)-abs(v-t) for e,t,v in sample), 'calibration_slope': slope, 'calibration_intercept': ybar-slope*xbar}
    point = stats(values); distributions = {k: [] for k in point}
    for _ in range(500):
        result = stats([values[rng.randrange(len(values))] for _ in values])
        for k,v in result.items(): distributions[k].append(v)
    output['splits'][split] = {k: {'point': v, 'bootstrap95': [sorted(distributions[k])[12], sorted(distributions[k])[487]]} for k,v in point.items()}
(p/'hr-uncertainty.json').write_text(json.dumps(output, indent=2)+'\n')
print(json.dumps(output))
