#!/usr/bin/env python3
"""A fixed 24-hour ICU HR persistence baseline, with no fitting or treatment claim."""
import csv, io, json, math, os, pathlib, tarfile
from statistics import mean
root = pathlib.Path(__file__).resolve().parents[3]
raw = pathlib.Path(os.environ.get('VCR_EVAL_RAW_DIR', root / '.evimed-local/acceptance/vcr-benchmark-20261029/numeric/raw')).resolve()
out = pathlib.Path(os.environ.get('VCR_EVAL_OUTPUT', root / '.evimed-local/acceptance/vcr-professional-full-20261105/clinical')).resolve()
result = {'protocol': 'Last observed valid HR from 0-6h predicts HR closest to 24h within 23-25h. Whole stay split A/B/C; no learned parameters. Includes only records with both measurements; no physiologic range filtering.', 'splits': {}}
for split in 'abc':
    errors, gaps, paired, counts = [], [], [], {'records': 0, 'no_early_hr': 0, 'no_target_hr': 0, 'no_both': 0}
    with tarfile.open(raw / f'set-{split}.tar.gz') as archive:
        for member in archive:
            if not member.isfile() or not member.name.endswith('.txt'):
                continue
            counts['records'] += 1
            early, target = [], []
            with archive.extractfile(member) as source:
                for row in csv.DictReader(io.TextIOWrapper(source, encoding='utf-8-sig', newline='')):
                    if row['Parameter'] != 'HR':
                        continue
                    try:
                        h, m = map(int, row['Time'].split(':')); t = 60*h+m; v = float(row['Value'])
                    except (KeyError, ValueError):
                        continue
                    if not math.isfinite(v) or v == -1:
                        continue
                    if 0 <= t <= 360: early.append((t, v))
                    if 1380 <= t <= 1500: target.append((t, v))
            if not early: counts['no_early_hr'] += 1
            if not target: counts['no_target_hr'] += 1
            if not early or not target:
                counts['no_both'] += 1
                continue
            first = max(early, key=lambda x: x[0]); last = min(target, key=lambda x: (abs(x[0]-1440), x[0]))
            errors.append(first[1]-last[1]); gaps.append(last[0]-first[0]); paired.append((f'{split}{counts["records"]:04d}', first[1], last[1]))
    out.mkdir(parents=True, exist_ok=True)
    with (out / f'hr-{split}-paired.csv').open('w', newline='') as f:
        writer = csv.writer(f); writer.writerow(['USUBJID','hr_early','hr_24']); writer.writerows(paired)
    counts.update(scored=len(errors), mae_bpm=mean(map(abs, errors)) if errors else None,
                  rmse_bpm=math.sqrt(mean(x*x for x in errors)) if errors else None,
                  bias_bpm=mean(errors) if errors else None, mean_gap_hours=mean(gaps)/60 if gaps else None)
    result['splits'][split] = counts
out.mkdir(parents=True, exist_ok=True)
(out / 'hr-baseline.json').write_text(json.dumps(result, indent=2)+'\n')
print(json.dumps(result))
