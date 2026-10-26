import math
import csv
import json
import subprocess
import sys
import shutil
from pathlib import Path

import pytest

from judge import comparison_reference, check_bindings, prediction_reference

FIXTURES = Path(__file__).parent / 'fixtures'


def test_unit_and_label_corrections_preserve_people_and_uncertainty_direction():
    raw = comparison_reference(FIXTURES)
    cm = comparison_reference(FIXTURES, scale=.1)
    corrected = comparison_reference(FIXTURES, corrected=True)
    assert raw['nA'] == raw['nB'] == 40
    assert cm['difference'] == pytest.approx(raw['difference'] / 10)
    assert cm['p'] == raw['p']
    assert corrected['difference'] == pytest.approx(-raw['difference'])
    assert corrected['low'] == pytest.approx(-raw['high'])


def test_supplement_normalizes_units_and_accounts_for_duplicate_and_missing_patients():
    result = comparison_reference(FIXTURES, supplement=True, scale=.1)
    assert result['rawRows'] == 101
    assert result['patients'] == 100
    assert result['duplicates'] == 1
    assert result['missing'] == 2
    assert result['nA'] == result['nB'] == 49


def test_coding_correction_cannot_hide_changed_measurements_or_patients(tmp_path):
    shutil.copytree(FIXTURES, tmp_path, dirs_exist_ok=True)
    file = tmp_path / 'coding-correction.csv'
    with file.open() as handle:
        rows = list(csv.DictReader(handle))
    for row in rows:
        row['marker_mm'] = str(float(row['marker_mm']) + 100)
    with file.open('w') as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    with pytest.raises(ValueError, match='group-only'):
        comparison_reference(tmp_path, corrected=True)


def test_missing_misbound_or_nonfinite_metrics_never_pass():
    expected = {'difference': 2., 'nA': 40}
    bindings = [{'reference': 'difference', 'source': ['d']}, {'reference': 'nA', 'source': ['n']}]
    assert check_bindings({'d': 2., 'n': 40}, expected, bindings)['passed']
    for bad in ({'d': 20., 'n': 40}, {'d': math.nan, 'n': 40}, {'d': 2.}):
        assert not check_bindings(bad, expected, bindings)['passed']
    assert not check_bindings({'d': 2.}, expected, [])['passed']


def test_prediction_reference_uses_source_malignant_label_and_actual_returned_probability():
    source = [{'id': '0', 'breast_cancer_yn': '0'}, {'id': '1', 'breast_cancer_yn': '1'}, {'id': '2', 'breast_cancer_yn': '0'}, {'id': '3', 'breast_cancer_yn': '1'}]
    returned = [{'id': str(i), 'p': p} for i, p in enumerate([.9, .2, .7, .4])]
    result = prediction_reference(source, returned, id_column='id', probability_column='p', threshold=.3)
    assert result['auc'] == 1
    assert result['brier'] == pytest.approx(.075)
    assert result['tp'] == 2 and result['fp'] == 1 and result['tn'] == 1
    with pytest.raises(ValueError):
        prediction_reference(source, returned + [returned[0]], id_column='id', probability_column='p')
    split = [{**row, 'split': 'test' if i < 2 else 'train'} for i, row in enumerate(returned)]
    heldout = prediction_reference(source, split, id_column='id', probability_column='p', split_column='split', test_label='test')
    assert heldout['n'] == 2 and heldout['brier'] == pytest.approx(.025)
    for bad in [True, False, '0.3']:
        with pytest.raises(ValueError):
            prediction_reference(source, returned, id_column='id', probability_column='p', threshold=bad)


def test_cli_prediction_uses_frozen_source_and_records_exact_bytes(tmp_path, monkeypatch):
    with (FIXTURES / 'breast-cancer.csv').open() as file:
        source = list(csv.DictReader(file))
    event = next(row for row in source if row['breast_cancer_yn'] == '0')
    nonevent = next(row for row in source if row['breast_cancer_yn'] == '1')
    workspace = tmp_path / 'turn-0/workspace'
    workspace.mkdir(parents=True)
    (workspace / 'predictions.csv').write_text(f"row,p\n{event['']},0.9\n{nonevent['']},0.2\n")
    result = workspace / 'results.json'
    result.write_text('{"auc":1,"n":2}')
    binding = {'turns': [{'index': 0, 'referenceKind': 'prediction', 'results': 'results.json',
        'predictions': 'predictions.csv', 'predictionOptions': {'id_column': 'row', 'source_id_column': '', 'probability_column': 'p'},
        'required': ['auc', 'n'], 'bindings': [{'reference': 'auc', 'source': ['auc']}, {'reference': 'n', 'source': ['n']}]}]}
    bindings = tmp_path / 'bindings.json'
    bindings.write_text(json.dumps(binding))
    out = tmp_path / 'verdict.json'
    command = [sys.executable, str(Path(__file__).with_name('judge.py')), '--artifacts', str(tmp_path), '--bindings', str(bindings), '--out', str(out)]
    subprocess.run(command, check=True)
    before = json.loads(out.read_text())
    assert before['passed']
    assert {'numpy', 'scipy', 'scikit-learn'} <= set(before['versions'])
    assert {'bindings', 'judge', 'fixture', 'results', 'predictions'} <= {item['role'] for item in before['inputs']}
    result.write_text('{"auc":1, "n":2}\n')
    subprocess.run(command, check=True)
    after = json.loads(out.read_text())
    assert after['passed'] and before['inputs'] != after['inputs']
    # The received bytes, not a later reopening of a mutable path, own the verdict.
    import judge
    original_read = Path.read_bytes
    prediction_path = workspace / 'predictions.csv'
    original_predictions = original_read(prediction_path)

    def read_then_change(path):
        payload = original_read(path)
        if path == prediction_path:
            path.write_text(f"row,p\n{event['']},0.1\n{nonevent['']},0.9\n")
        return payload

    monkeypatch.setattr(Path, 'read_bytes', read_then_change)
    monkeypatch.setattr(sys, 'argv', command[1:])
    assert judge.main() == 0
    verified = json.loads(out.read_text())
    import hashlib
    assert next(item for item in verified['inputs'] if item['role'] == 'predictions')['sha256'] == hashlib.sha256(original_predictions).hexdigest()
