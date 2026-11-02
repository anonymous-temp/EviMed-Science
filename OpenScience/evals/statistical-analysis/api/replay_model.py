"""Replay a saved WDBC baseline ONLY in a disposable, no-network, no-credential container."""
import argparse
import hashlib
import json
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.metrics import roc_auc_score, brier_score_loss, confusion_matrix


def artifact(folder, filename):
    items = json.loads((folder / "downloads.json").read_text())
    matches = [item for item in items if item["filename"] == filename]
    if len(matches) != 1:
        raise ValueError(f"Expected one {filename} artifact")
    item = matches[0]
    if Path(item["stored"]).name != item["stored"]:
        raise ValueError("Unsafe artifact path")
    path = folder / item["stored"]
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 50 * 1024 * 1024:
        raise ValueError("Unsafe artifact file")
    if hashlib.sha256(path.read_bytes()).hexdigest() != item["sha256"]:
        raise ValueError("Artifact digest changed")
    return path


def replay(directory, source):
    first = directory / "turn-0"
    raw = pd.read_csv(source, index_col=0)
    predictions = pd.read_csv(artifact(first, "test-predictions.csv"))
    split = pd.read_csv(artifact(first, "split.csv"))
    if predictions.row_id.duplicated().any() or split.row_id.duplicated().any():
        raise ValueError("Duplicate source row IDs")
    if set(split.row_id) != set(raw.index) or not set(split.split) <= {"train", "test"}:
        raise ValueError("Split does not identify the source cohort")
    train_ids = split.loc[split.split == "train", "row_id"].tolist()
    test_ids = split.loc[split.split == "test", "row_id"].tolist()
    if set(train_ids) & set(test_ids) or set(predictions.row_id) != set(test_ids):
        raise ValueError("Invalid held-out assignment")
    # Untrusted model deserialization is intentionally isolated by the caller's container.
    saved = joblib.load(artifact(first, "model.joblib"))
    if saved["outcome_code"] != 0 or saved["positive_label"] != "malignant":
        raise ValueError("Positive-class declaration differs from the frozen source")
    features = [column for column in raw.columns if column != "breast_cancer_yn"]
    if saved["features"] != features:
        raise ValueError("Unexpected predictors")
    pipeline = saved["primary_pipeline"]
    xtrain = raw.loc[train_ids, features]
    np.testing.assert_allclose(pipeline.named_steps["scaler"].mean_, xtrain.mean().to_numpy(), rtol=1e-10, atol=1e-10)
    np.testing.assert_allclose(pipeline.named_steps["scaler"].var_, xtrain.var(ddof=0).to_numpy(), rtol=1e-10, atol=1e-10)
    label_index = list(pipeline.classes_).index(1)
    probability = pipeline.predict_proba(raw.loc[predictions.row_id, features])[:, label_index]
    np.testing.assert_allclose(probability, predictions.p_primary, rtol=1e-10, atol=1e-12)
    y = (raw.loc[predictions.row_id, "breast_cancer_yn"].to_numpy() == 0).astype(int)
    np.testing.assert_array_equal(y, predictions.y_malignant)
    references = {"nTrain": len(train_ids), "nTest": len(test_ids), "malignantTest": int(y.sum()),
                  "auc": roc_auc_score(y, probability), "brier": brier_score_loss(y, probability),
                  "confusionAt03": confusion_matrix(y, probability >= .3, labels=[0, 1]).tolist()}
    result = json.loads((first / "result.json").read_text())["result"]["structuredResults"]
    np.testing.assert_allclose(references["auc"], result["metrics"]["auc_test"]["estimate"], atol=1e-10)
    np.testing.assert_allclose(references["brier"], result["metrics"]["brier_test"]["estimate"], atol=1e-10)
    return {"schemaVersion": 1, "case": "wdbc-prediction", "independentReplayPassed": True,
            "numbers": references, "trainingScalerMatchesSource": True,
            "maximumProbabilityDifference": float(np.max(np.abs(probability-predictions.p_primary.to_numpy()))),
            "scope": "saved primary pipeline and selected numerical outputs; not external validity or all prose",
            "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
            "modelSha256": hashlib.sha256(artifact(first, "model.joblib").read_bytes()).hexdigest()}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts", type=Path, required=True)
    parser.add_argument("--source", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(replay(args.artifacts, args.source), indent=2))
