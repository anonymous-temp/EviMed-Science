"""Replay a saved WDBC pipeline ONLY inside the no-network acceptance sandbox.

Joblib can execute code. Never run this against user artifacts on the host.
The artifact paths/keys here name the observed 2026-10-26 public-data run; a
different artifact layout needs an explicitly reviewed adapter, not guessing.
This verifies saved state, train-only scaling and predictions. It does not prove
that every upstream tuning choice avoided the held-out set; inspect code too.
"""
import hashlib
import importlib.metadata
import json
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from scipy.special import logit
from sklearn.metrics import roc_auc_score, average_precision_score
import statsmodels.api as sm

ROOT = Path('/workspace')
PACKAGE = ROOT / 'deliverables/statistical-analysis-package'
data = pd.read_csv(ROOT / 'data/breast-cancer.csv')
predictions = pd.read_csv(PACKAGE / 'predictions.csv')
if list(data.iloc[:, 0]) != list(predictions.record_id):
    raise ValueError('Returned predictions do not preserve the source record identity.')
z = (data.breast_cancer_yn.to_numpy() == 0).astype(int)
if not np.array_equal(predictions.y_true.to_numpy(), data.breast_cancer_yn.to_numpy()):
    raise ValueError('Prediction labels disagree with the frozen source labels.')
if set(predictions.split) != {'train', 'test'}:
    raise ValueError('Expected an explicitly preserved train/test split.')
saved = joblib.load(PACKAGE / 'fitted-model.joblib')
model, features = saved['l2'], saved['features']
if features != list(data.columns[1:-1]):
    raise ValueError('Unexpected predictor set; identifier/target or omitted features need review.')
x = data[features].to_numpy()
train = predictions.split.to_numpy() == 'train'
test = ~train
scaler = model.named_steps['scaler']
np.testing.assert_allclose(scaler.mean_, x[train].mean(axis=0), rtol=1e-12, atol=1e-12)
np.testing.assert_allclose(scaler.var_, x[train].var(axis=0), rtol=1e-12, atol=1e-12)
classes = list(model.classes_)
probability = model.predict_proba(x)[:, classes.index(1)]
# The artifact rounds its CSV to six decimal places; the saved model remains full precision.
np.testing.assert_allclose(probability, predictions.p_malignant.to_numpy(), rtol=0, atol=5.01e-7)
p, y = probability[test], z[test]
eps = 1e-12
calibration = sm.Logit(y, sm.add_constant(logit(np.clip(p, eps, 1-eps)))).fit(disp=0, maxiter=200)
boundaries = int(np.sum((p == 0) | (p == 1)))
metrics = {'n': int(test.sum()), 'events': int(y.sum()), 'auc': float(roc_auc_score(y, p)),
           'averagePrecision': float(average_precision_score(y, p)), 'brier': float(np.mean((p-y)**2)),
           'calibration': {'intercept': float(calibration.params[0]), 'slope': float(calibration.params[1]),
                           'epsilon': eps, 'boundaryProbabilities': boundaries, 'clippedProbabilities': int(np.sum((p < eps) | (p > 1-eps))),
                           'interpretation': 'clipped-logit diagnostic; not an unclipped calibration certification'}}
for threshold in (.5, .3):
    positive = p >= threshold
    metrics[f'threshold{threshold}'] = {'tp': int(sum(positive & (y == 1))), 'fn': int(sum(~positive & (y == 1))),
                                     'fp': int(sum(positive & (y == 0))), 'tn': int(sum(~positive & (y == 0)))}
inputs = []
for file in [ROOT / 'data/breast-cancer.csv', PACKAGE / 'predictions.csv', PACKAGE / 'fitted-model.joblib', Path(__file__)]:
    payload = file.read_bytes()
    inputs.append({'path': str(file), 'sha256': hashlib.sha256(payload).hexdigest(), 'bytes': len(payload)})
print(json.dumps({'passed': True, 'checks': ['source-labels', 'source-record-identities', 'predictor-exclusions', 'training-only-scaler', 'saved-model-prediction-replay'],
                  'metrics': metrics, 'inputs': inputs, 'versions': {name: importlib.metadata.version(name) for name in ('numpy', 'scipy', 'pandas', 'scikit-learn', 'statsmodels', 'joblib')}}, indent=2, allow_nan=False))
