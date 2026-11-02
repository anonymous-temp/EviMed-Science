import copy
import importlib.util
from pathlib import Path

import pytest

SOURCE = Path(__file__).resolve().parents[2] / "capabilities/statistical-analysis/scripts/analysis_checks.py"
spec = importlib.util.spec_from_file_location("conversion_checks", SOURCE)
checks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checks)


def original():
    return {"schemaVersion": 1, "analyses": [{"id": "primary", "method": "paired t", "estimate": 1.58,
        "interval": [0.7, 2.46], "pValue": .0028, "n": 10, "estimateUnit": "hours"},
        {"id": "normality", "method": "Shapiro-Wilk", "estimate": .83, "pValue": .033, "estimateUnit": "unitless"}]}


def test_only_named_dimensional_values_change_and_diagnostics_keep_their_method():
    source = original()
    before = copy.deepcopy(source)
    result = checks.convert_result_units(source, factor=60, value_paths=[['analyses', 0, 'estimate'], ['analyses', 0, 'interval', 0], ['analyses', 0, 'interval', 1]], unit_paths=[['analyses', 0, 'estimateUnit']], unit='minutes')
    assert result['analyses'][0]['estimate'] == pytest.approx(94.8)
    assert result['analyses'][0]['interval'] == pytest.approx([42, 147.6])
    assert result['analyses'][1] == source['analyses'][1]
    assert result['analyses'][0]['pValue'] == source['analyses'][0]['pValue']
    assert result['analyses'][0]['n'] == 10
    assert source == before


@pytest.mark.parametrize('path', [['analyses',0,'pValue'],['analyses',0,'n'],['analyses',-1,'estimate'],['analyses',True,'estimate']])
def test_dimensionless_or_invalid_paths_are_refused(path):
    with pytest.raises(ValueError):
        checks.convert_result_units(original(), factor=60, value_paths=[path], unit_paths=[], unit='minutes')


def test_duplicate_paths_and_nonfinite_factors_cannot_silently_corrupt_results():
    path = ['analyses',0,'estimate']
    with pytest.raises(ValueError):
        checks.convert_result_units(original(), factor=60, value_paths=[path,path], unit_paths=[], unit='minutes')
    with pytest.raises(ValueError):
        checks.convert_result_units(original(), factor=float('inf'), value_paths=[path], unit_paths=[], unit='minutes')
