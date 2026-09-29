"""Independent public-data arithmetic and frozen-source checks, not live acceptance."""
import hashlib
import json
from pathlib import Path
import subprocess

import numpy as np
import pandas as pd
from scipy import stats
from sklearn.datasets import load_breast_cancer
from sklearn.model_selection import train_test_split

from reference_values import compute

HERE = Path(__file__).resolve().parent
EXPECTED = json.loads((HERE / 'expected.json').read_text())


def test_source_fingerprints_and_semantic_coding():
    manifest = json.loads((HERE / 'fixtures/source-manifest.json').read_text())
    for source in manifest['sources']:
        assert hashlib.sha256((HERE / 'fixtures' / source['path']).read_bytes()).hexdigest() == source['sha256']
    data = pd.read_csv(HERE / 'fixtures/breast-cancer.csv')
    original = load_breast_cancer()
    np.testing.assert_array_equal(data.breast_cancer_yn, original.target)
    np.testing.assert_allclose(data[original.feature_names], original.data, rtol=0, atol=0)
    assert original.target_names.tolist() == ['malignant', 'benign']


def test_welch_reference_with_independent_arithmetic():
    data = pd.read_csv(HERE / 'fixtures/breast-cancer.csv')
    a = data.loc[data.breast_cancer_yn == 0, 'mean radius'].to_numpy()
    b = data.loc[data.breast_cancer_yn == 1, 'mean radius'].to_numpy()
    difference = np.mean(a) - np.mean(b)
    va, vb = np.var(a, ddof=1) / len(a), np.var(b, ddof=1) / len(b)
    df = (va + vb) ** 2 / (va ** 2 / (len(a) - 1) + vb ** 2 / (len(b) - 1))
    se = np.sqrt(va + vb)
    interval = difference + np.array([-1, 1]) * stats.t.ppf(.975, df) * se
    expected = EXPECTED['groupComparison']
    assert (len(a), len(b)) == (212, 357)
    np.testing.assert_allclose(difference, expected['difference'], atol=1e-8, rtol=0)
    np.testing.assert_allclose(interval, expected['interval'], atol=1e-8, rtol=0)
    np.testing.assert_allclose(2 * stats.t.sf(abs(difference / se), df), expected['p'], rtol=1e-6, atol=0)


def test_sequential_reference_recomputed_without_scaler_or_regression_library():
    data = pd.read_csv(HERE / 'fixtures/breast-cancer.csv')
    train, test = train_test_split(data.index, test_size=.2, random_state=42)
    radius = data['mean radius'].to_numpy()
    area = data['mean area'].to_numpy()
    radius = (radius - radius[train].min()) / np.ptp(radius[train])
    area = (area - area[train].mean()) / area[train].std(ddof=0)
    y = data.breast_cancer_yn.to_numpy()
    slope = lambda x: np.sum((x[train] - x[train].mean()) * (y[train] - y[train].mean())) / np.sum((x[train] - x[train].mean()) ** 2)
    q1, q3 = np.quantile(radius, [.25, .75])
    observed = [slope(radius), slope(area), area[y == 0].mean() - area[y == 1].mean(), sorted(radius)[-5],
                int(((radius < q1 - 1.5 * (q3 - q1)) | (radius > q3 + 1.5 * (q3 - q1))).sum())]
    seq = EXPECTED['sequential']
    np.testing.assert_allclose(observed, [seq[key] for key in ['radiusSlope', 'areaSlope', 'areaDifference', 'fifthRadius', 'radiusOutliers']], atol=1e-10, rtol=0)
    assert [round(x, 3) for x in observed] == [-2.006, -0.336, 1.454, 0.858, 14]
    assert train.tolist() == seq['train'] and test.tolist() == seq['test']
    # The reusable evaluator starts from raw data on every call, unlike the
    # upstream global-dataframe reference, whose transformations are sequential.
    assert compute()['sequential'] == compute()['sequential'] == seq


def test_native_r_reference_and_censoring():
    actual = json.loads(subprocess.check_output(['Rscript', '--vanilla', str(HERE / 'reference_survival.R'), str(HERE / 'fixtures/lung.csv')], text=True))
    expected = EXPECTED['survival']
    assert (actual['rows'], actual['events'], actual['censored'], actual['median']) == (228, 165, 63, 310)
    for key, value in expected.items():
        if isinstance(value, (int, float)):
            np.testing.assert_allclose(actual[key], value, atol=1e-7, rtol=0)


def test_briefs_keep_goldens_outside_model_input():
    briefs = json.loads((HERE / 'briefs.json').read_text())['briefs']
    assert len(briefs) == 3
    for brief in briefs:
        assert set(['id', 'title', 'why', 'inputs', 'mustDo', 'mustNotDo', 'gradedOn']) <= brief.keys()
        for fixture in brief['fixtures']:
            assert (HERE / fixture['source']).is_file()
            assert fixture['source'].endswith('.csv')
        assert 'expected.json' not in json.dumps(brief['inputs'])
        assert 'reference_values' not in json.dumps(brief['inputs'])


def test_dataset_and_adapted_code_licenses_are_distinguished():
    source = json.loads((HERE / 'fixtures/source-manifest.json').read_text())['sources'][0]
    assert source['license'] == 'CC-BY-4.0'
    assert source['originalSource'] == 'https://archive.ics.uci.edu/dataset/17/breast+cancer+wisconsin+diagnostic'
    assert source['adaptedReferenceLicense'] == 'BSD-3-Clause'
    attribution = (HERE / 'fixtures/THIRD_PARTY_LICENSES.txt').read_text()
    assert 'CC BY 4.0' in attribution
    assert 'https://creativecommons.org/licenses/by/4.0/' in attribution
