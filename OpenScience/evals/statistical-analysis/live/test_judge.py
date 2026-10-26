import math
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
