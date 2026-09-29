"""Evaluator-only references. Never copy this module or expected.json into a run.

Sequential case adapted from Ying Ma's TableMage-Analysis (BSD-3-Clause),
benchmarking/dataanalysisqa/label_scripts/breast_cancer.py, q5-q9.
See fixtures/source-manifest.json and THIRD_PARTY_LICENSES.txt.
"""
import json
from pathlib import Path
import platform
import subprocess

import numpy as np
import pandas as pd
import scipy
from scipy import stats
import sklearn
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import MinMaxScaler, StandardScaler
import statsmodels
import statsmodels.api as sm

HERE = Path(__file__).resolve().parent


def compute():
    data = pd.read_csv(HERE / 'fixtures/breast-cancer.csv')
    malignant = data.loc[data.breast_cancer_yn == 0, 'mean radius']
    benign = data.loc[data.breast_cancer_yn == 1, 'mean radius']
    welch = stats.ttest_ind(malignant, benign, equal_var=False)
    interval = welch.confidence_interval(.95)
    group = {'rows': len(data), 'malignant': len(malignant), 'benign': len(benign),
             'mean': float(data['mean radius'].mean()), 'sd': float(data['mean radius'].std()),
             'difference': float(malignant.mean() - benign.mean()),
             'interval': [float(interval.low), float(interval.high)],
             't': float(welch.statistic), 'df': float(welch.df), 'p': float(welch.pvalue)}
    train, test = train_test_split(data.index, test_size=.2, random_state=42)
    radius_scaler = MinMaxScaler().fit(data.loc[train, ['mean radius']])
    area_scaler = StandardScaler().fit(data.loc[train, ['mean area']])
    radius = radius_scaler.transform(data[['mean radius']]).ravel()
    area = area_scaler.transform(data[['mean area']]).ravel()
    radius_fit = sm.OLS(data.loc[train, 'breast_cancer_yn'], sm.add_constant(radius[train])).fit()
    area_fit = sm.OLS(data.loc[train, 'breast_cancer_yn'], sm.add_constant(area[train])).fit()
    q1, q3 = np.quantile(radius, [.25, .75])
    sequential = {'radiusSlope': float(radius_fit.params.iloc[1]), 'areaSlope': float(area_fit.params.iloc[1]),
                  'areaDifference': float(area[data.breast_cancer_yn == 0].mean() - area[data.breast_cancer_yn == 1].mean()),
                  'fifthRadius': float(np.sort(radius)[-5]),
                  'radiusOutliers': int(np.sum((radius < q1 - 1.5 * (q3 - q1)) | (radius > q3 + 1.5 * (q3 - q1)))),
                  'train': train.tolist(), 'test': test.tolist(),
                  'radiusMin': float(radius_scaler.data_min_[0]), 'radiusRange': float(radius_scaler.data_range_[0]),
                  'areaMean': float(area_scaler.mean_[0]), 'areaScale': float(area_scaler.scale_[0])}
    return {'groupComparison': group, 'sequential': sequential}


def main():
    references = compute()
    references['survival'] = json.loads(subprocess.check_output(['Rscript', '--vanilla', str(HERE / 'reference_survival.R'), str(HERE / 'fixtures/lung.csv')], text=True))
    references['referenceEnvironment'] = {'python': platform.python_version(), 'numpy': np.__version__,
        'pandas': pd.__version__, 'scipy': scipy.__version__, 'sklearn': sklearn.__version__, 'statsmodels': statsmodels.__version__}
    print(json.dumps(references, indent=2, allow_nan=False))


if __name__ == '__main__':
    main()
