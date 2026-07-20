#!/usr/bin/env python3
"""Bounded deterministic execution baseline for curated EviMed science skills."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sys
from collections import Counter, defaultdict, deque
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import optimize, stats
from sklearn.decomposition import PCA
from sklearn.linear_model import LinearRegression, LogisticRegression
from sklearn.metrics import accuracy_score, mean_squared_error
from sklearn.model_selection import KFold, StratifiedKFold, cross_val_predict
from sklearn.neural_network import MLPClassifier, MLPRegressor
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler


MAX_INPUT_BYTES = 32 * 1024 * 1024
MAX_ROWS = 200_000
MAX_COLUMNS = 2_000
MAX_TEXT_CHARS = 2_000_000
SCHEMA_VERSION = 1

PLAN_SKILLS = {
    "experimental-design",
    "hypothesis-development",
    "research-grant-development",
}
TABLE_SKILLS = {
    "astronomy-data-analysis",
    "bulk-rna-seq",
    "cancer-functional-genomics",
    "clinical-machine-learning",
    "digital-pathology-analysis",
    "drug-discovery-data",
    "exploratory-data-analysis",
    "flow-cytometry-analysis",
    "geospatial-analysis",
    "medical-imaging-data",
    "scientific-data-engineering",
    "scientific-deep-learning",
    "single-cell-analysis",
    "statistical-analysis",
}


class SkillExecutionError(Exception):
    """A deterministic, user-actionable skill execution error."""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def safe_input(path_value: str | None) -> Path | None:
    if not path_value:
        return None
    path = Path(path_value).expanduser()
    if path.is_symlink() or not path.is_file():
        raise SkillExecutionError("Input must be a regular non-symlink file.")
    size = path.stat().st_size
    if size <= 0 or size > MAX_INPUT_BYTES:
        raise SkillExecutionError("Input must be non-empty and no larger than 32 MiB.")
    return path.resolve()


def safe_output_dir(path_value: str) -> Path:
    path = Path(path_value).expanduser()
    if path.exists() and path.is_symlink():
        raise SkillExecutionError("Output directory must not be a symbolic link.")
    path.mkdir(parents=True, exist_ok=True)
    if not path.is_dir():
        raise SkillExecutionError("Output path is not a directory.")
    return path.resolve()


def read_request(input_path: Path | None, smoke: bool, skill: str) -> dict:
    if input_path is None:
        if not smoke:
            raise SkillExecutionError("Provide --input or use --smoke for the bounded fixture.")
        return smoke_request(skill)
    if input_path.suffix.casefold() == ".json":
        try:
            value = json.loads(input_path.read_text(encoding="utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise SkillExecutionError("Input JSON is invalid.") from error
        if not isinstance(value, dict):
            raise SkillExecutionError("Input JSON must be an object.")
        return value
    return {"data_path": str(input_path), "task": input_path.stem}


def smoke_request(skill: str) -> dict:
    if skill in PLAN_SKILLS:
        return {
            "task": "Evaluate a preregistered two-group biomedical study",
            "objective": "Estimate the mean treatment effect with uncertainty",
            "population": "Adults meeting the prespecified eligibility criteria",
            "exposure": "Intervention",
            "comparator": "Control",
            "outcome": "Continuous primary outcome at 12 weeks",
            "constraints": ["allocation concealment", "intention-to-treat", "missing-data sensitivity"],
        }
    if skill == "bayesian-modeling":
        return {"successes": 32, "trials": 50, "prior_alpha": 1, "prior_beta": 1}
    if skill == "biomedical-knowledge-graph":
        return {"edges": [["DRUG:A", "GENE:B"], ["GENE:B", "DISEASE:C"], ["DRUG:A", "DISEASE:C"]]}
    if skill == "biosequence-analysis" or skill == "phylogenetic-analysis":
        return {"sequences": {"sample-a": "ATGCGTACGTAA", "sample-b": "ATGCGTTCGTAA", "sample-c": "ATGAGTTCGTAA"}}
    if skill == "cheminformatics":
        return {"formula": "C9H8O4", "name": "acetylsalicylic acid"}
    if skill == "citation-integrity":
        return {"text": "Claim one [1]. Claim two DOI:10.1000/example.1.\n\nReferences\n[1] Example. doi:10.1000/example.1"}
    if skill == "genome-variant-analysis":
        return {"variants": [{"chrom": "1", "pos": 100, "ref": "A", "alt": "G", "qual": 60}, {"chrom": "1", "pos": 140, "ref": "C", "alt": "CT", "qual": 40}]}
    if skill == "markdown-mermaid-writing":
        return {"title": "Research flow", "nodes": ["Question", "Evidence", "Analysis", "Conclusion"]}
    if skill == "mass-spectrometry-analysis":
        return {"spectra": [{"precursor_mz": 445.12, "peaks": [[100.1, 20], [200.2, 80], [300.3, 40]]}]}
    if skill == "materials-science-analysis":
        return {"formula": "Fe2O3", "lattice": {"a": 5.04, "b": 5.04, "c": 13.75, "alpha": 90, "beta": 90, "gamma": 120}}
    if skill == "metabolic-network-modeling":
        return {"stoichiometry": [[-1, 0, 1], [1, -1, 0]], "objective": [0, 1, 0], "bounds": [[0, 10], [0, 10], [0, 10]]}
    if skill == "pathway-enrichment":
        return {"genes": ["A", "B", "C"], "background": ["A", "B", "C", "D", "E", "F"], "gene_sets": {"pathway-1": ["A", "B", "D"], "pathway-2": ["E", "F"]}}
    if skill == "quantum-computing-analysis":
        return {"gates": ["H", "Z", "H"]}
    if skill == "reproducible-workflows":
        return {"files": [], "steps": ["validate-input", "analyze", "render-report"]}
    if skill == "simulation-optimization":
        return {"initial": [-1.2, 1.0], "objective": "rosenbrock"}
    if skill == "survival-analysis":
        return {"time": [5, 6, 6, 8, 10, 12, 15, 18], "event": [1, 0, 1, 1, 0, 1, 0, 1], "group": [0, 0, 0, 0, 1, 1, 1, 1]}
    if skill == "time-series-forecasting" or skill == "biomedical-signal-analysis":
        x = np.linspace(0, 4 * math.pi, 64)
        return {"values": [float(v) for v in (np.sin(x) + 0.03 * x)], "horizon": 8, "sampling_hz": 4}
    if skill == "biomedical-database-search":
        return {"query": "BRCA1", "records": [{"id": "GENE:672", "title": "BRCA1 DNA repair associated", "source": "ncbi-gene"}]}
    rows = []
    rng = np.random.default_rng(20260719)
    for index in range(48):
        group = index % 2
        feature = float(rng.normal(group * 0.6, 1))
        rows.append({
            "sample_id": f"S{index + 1:03d}",
            "group": group,
            "feature_a": feature,
            "feature_b": float(rng.normal(0, 1)),
            "outcome": float(1.5 * feature + group + rng.normal(0, 0.5)),
        })
    return {"task": f"Bounded {skill} fixture", "records": rows, "target": "group"}


def frame_from_request(request: dict) -> pd.DataFrame:
    records = request.get("records")
    if isinstance(records, list) and records and all(isinstance(row, dict) for row in records):
        frame = pd.DataFrame(records)
    else:
        path_value = request.get("data_path")
        if not isinstance(path_value, str) or not path_value.strip():
            raise SkillExecutionError("This skill requires records or data_path.")
        path = safe_input(path_value)
        suffix = path.suffix.casefold()
        if suffix in {".csv", ".tsv"}:
            frame = pd.read_csv(path, sep="\t" if suffix == ".tsv" else ",", nrows=MAX_ROWS + 1)
        elif suffix in {".json", ".jsonl"}:
            frame = pd.read_json(path, lines=suffix == ".jsonl")
        else:
            raise SkillExecutionError("Supported table inputs are CSV, TSV, JSON, and JSONL.")
    if len(frame) > MAX_ROWS or len(frame.columns) > MAX_COLUMNS:
        raise SkillExecutionError("Table exceeds the bounded row or column limit.")
    if frame.empty:
        raise SkillExecutionError("Table contains no rows.")
    return frame


def numeric_summary(frame: pd.DataFrame) -> tuple[list[dict], dict]:
    numeric = frame.select_dtypes(include=[np.number]).replace([np.inf, -np.inf], np.nan)
    rows = []
    for name in numeric.columns:
        series = numeric[name].dropna()
        rows.append({
            "column": str(name),
            "count": int(series.size),
            "missing": int(frame[name].isna().sum()),
            "mean": float(series.mean()) if len(series) else None,
            "std": float(series.std(ddof=1)) if len(series) > 1 else None,
            "min": float(series.min()) if len(series) else None,
            "median": float(series.median()) if len(series) else None,
            "max": float(series.max()) if len(series) else None,
        })
    meta = {
        "rows": int(len(frame)),
        "columns": int(len(frame.columns)),
        "duplicateRows": int(frame.duplicated().sum()),
        "missingCells": int(frame.isna().sum().sum()),
        "numericColumns": [str(value) for value in numeric.columns],
    }
    return rows, meta


def analyze_table(skill: str, request: dict) -> tuple[dict, list[str]]:
    frame = frame_from_request(request)
    summary, meta = numeric_summary(frame)
    findings: dict = {"table": meta, "numericSummary": summary}
    warnings: list[str] = []
    numeric = frame.select_dtypes(include=[np.number]).replace([np.inf, -np.inf], np.nan)
    target = str(request.get("target") or "")

    if skill in {"clinical-machine-learning", "scientific-deep-learning"}:
        if target not in frame.columns:
            target = str(frame.columns[-1])
        features = numeric.drop(columns=[target], errors="ignore").dropna(axis=1)
        valid = pd.concat([features, frame[target]], axis=1).dropna()
        if len(valid) < 20 or features.shape[1] < 1:
            raise SkillExecutionError("Machine-learning baseline requires at least 20 complete rows and one numeric feature.")
        x = valid[features.columns].to_numpy(dtype=float)
        y = valid[target].to_numpy()
        unique, class_counts = np.unique(y, return_counts=True)
        classification = len(unique) <= max(20, int(math.sqrt(len(y))))
        if classification:
            minimum_class_count = int(class_counts.min())
            if len(unique) < 2 or minimum_class_count < 2:
                raise SkillExecutionError("Classification requires at least two classes with two complete rows per class.")
            splitter = StratifiedKFold(n_splits=min(5, minimum_class_count), shuffle=True, random_state=20260719)
            estimator = MLPClassifier(hidden_layer_sizes=(16, 8), max_iter=1000, random_state=20260719) if skill == "scientific-deep-learning" else LogisticRegression(max_iter=1000, random_state=20260719)
            model = make_pipeline(StandardScaler(), estimator)
            predictions = cross_val_predict(model, x, y, cv=splitter, method="predict")
            findings["model"] = {"task": "classification", "crossValidatedAccuracy": float(accuracy_score(y, predictions)), "folds": splitter.n_splits, "target": target}
        else:
            splitter = KFold(n_splits=5, shuffle=True, random_state=20260719)
            estimator = MLPRegressor(hidden_layer_sizes=(16, 8), max_iter=1000, random_state=20260719) if skill == "scientific-deep-learning" else LinearRegression()
            model = make_pipeline(StandardScaler(), estimator)
            predictions = cross_val_predict(model, x, y.astype(float), cv=splitter)
            findings["model"] = {"task": "regression", "crossValidatedRmse": float(mean_squared_error(y.astype(float), predictions) ** 0.5), "folds": 5, "target": target}
        warnings.append("This is a bounded baseline, not a clinically validated predictive model.")
    elif skill == "bulk-rna-seq":
        counts = numeric.clip(lower=0)
        library_sizes = counts.sum(axis=1)
        findings["rnaSeqQc"] = {"librarySizeMedian": float(library_sizes.median()), "zeroFraction": float((counts == 0).sum().sum() / max(1, counts.size))}
        warnings.append("The baseline performs count-matrix QC only; differential inference requires a replicated design and a validated count model.")
    elif skill == "single-cell-analysis":
        matrix = numeric.clip(lower=0).to_numpy(dtype=float)
        totals = matrix.sum(axis=1)
        detected = (matrix > 0).sum(axis=1)
        components = min(3, matrix.shape[0] - 1, matrix.shape[1])
        fitted_pca = PCA(n_components=max(1, components), random_state=20260719).fit(np.log1p(matrix))
        findings["singleCellQc"] = {"cellCount": int(matrix.shape[0]), "featureCount": int(matrix.shape[1]), "medianCountsPerCell": float(np.median(totals)), "medianDetectedFeatures": float(np.median(detected)), "pcaExplainedVariance": [float(v) for v in fitted_pca.explained_variance_ratio_]}
        warnings.append("Cell-level QC is descriptive; sample-aware biological inference requires donor metadata and pseudobulk or hierarchical models.")
    elif skill == "flow-cytometry-analysis":
        values = numeric.to_numpy(dtype=float)
        q01, q99 = np.nanquantile(values, [0.01, 0.99], axis=0)
        findings["flowQc"] = {"events": int(values.shape[0]), "channels": int(values.shape[1]), "robustRanges": {str(column): [float(q01[i]), float(q99[i])] for i, column in enumerate(numeric.columns)}}
        warnings.append("No biological gate is inferred automatically; apply a prespecified gating strategy and controls.")
    elif skill in {"digital-pathology-analysis", "medical-imaging-data"}:
        values = numeric.to_numpy(dtype=float)
        findings["imagingQc"] = {"observations": int(values.shape[0]), "features": int(values.shape[1]), "globalMean": float(np.nanmean(values)), "globalStd": float(np.nanstd(values)), "nonFinite": int((~np.isfinite(values)).sum())}
        warnings.append("This baseline validates derived numeric imaging features; it does not decode DICOM or whole-slide pixels.")
    elif skill == "geospatial-analysis":
        lat = next((column for column in frame.columns if str(column).casefold() in {"lat", "latitude"}), None)
        lon = next((column for column in frame.columns if str(column).casefold() in {"lon", "lng", "longitude"}), None)
        if lat is not None and lon is not None:
            valid = frame[[lat, lon]].apply(pd.to_numeric, errors="coerce").dropna()
            if not valid.empty:
                findings["geospatial"] = {"validPoints": int(len(valid)), "latitudeRange": [float(valid[lat].min()), float(valid[lat].max())], "longitudeRange": [float(valid[lon].min()), float(valid[lon].max())]}
        else:
            warnings.append("No latitude/longitude columns were detected; only general table QC was performed.")
    elif skill == "statistical-analysis" and numeric.shape[1] >= 2:
        pair = numeric.iloc[:, :2].dropna()
        if len(pair) >= 3:
            slope, intercept, r_value, p_value, stderr = stats.linregress(pair.iloc[:, 0], pair.iloc[:, 1])
            findings["association"] = {"x": str(pair.columns[0]), "y": str(pair.columns[1]), "slope": float(slope), "intercept": float(intercept), "r": float(r_value), "pValue": float(p_value), "slopeStandardError": float(stderr), "n": int(len(pair))}
    elif skill == "cancer-functional-genomics":
        findings["screenQc"] = {"mostNegativeFeatures": [row["column"] for row in sorted(summary, key=lambda item: item["mean"] if item["mean"] is not None else math.inf)[:10]]}
        warnings.append("Dependency scores are context-specific and are not evidence of clinical efficacy.")
    elif skill == "drug-discovery-data":
        id_columns = [str(column) for column in frame.columns if any(token in str(column).casefold() for token in ("compound", "scaffold", "patient", "subject", "id"))]
        findings["leakageChecks"] = {"candidateGroupingColumns": id_columns, "exactDuplicateRows": int(frame.duplicated().sum())}
        warnings.append("Split by compound, scaffold, target, patient, or time as scientifically appropriate; random-row splits may leak information.")
    elif skill == "astronomy-data-analysis":
        warnings.append("Units, coordinate frame, calibration, and uncertainty columns must be confirmed before physical interpretation.")
    elif skill == "scientific-data-engineering":
        findings["schema"] = {str(column): str(dtype) for column, dtype in frame.dtypes.items()}
    return findings, warnings


def analyze_plan(skill: str, request: dict) -> tuple[dict, list[str]]:
    required = ["objective", "population", "exposure", "comparator", "outcome"]
    missing = [field for field in required if not str(request.get(field) or "").strip()]
    if missing:
        raise SkillExecutionError("Planning request is missing: %s." % ", ".join(missing))
    plan = {field: request[field] for field in required}
    plan["constraints"] = request.get("constraints") if isinstance(request.get("constraints"), list) else []
    plan["qualityGates"] = [
        "Define the estimand and analysis population.",
        "Predeclare primary outcome, time point, and multiplicity handling.",
        "Record allocation, masking, missing-data, and sensitivity procedures.",
        "Link every material claim to evidence or an executed result.",
    ]
    if skill == "hypothesis-development":
        plan["hypothesis"] = f"In {plan['population']}, {plan['exposure']} changes {plan['outcome']} relative to {plan['comparator']}."
        plan["falsifiers"] = ["Effect estimate is compatible with the prespecified null margin.", "Direction reverses under a justified sensitivity analysis."]
    elif skill == "research-grant-development":
        plan["workPackages"] = ["Evidence gap confirmation", "Protocol and analysis", "Execution and quality control", "Dissemination and reuse"]
    else:
        plan["designChecks"] = ["Randomization or confounding control", "Independent replication unit", "Sample-size justification", "Protocol deviations"]
    return {"plan": plan}, []


def analyze_special(skill: str, request: dict) -> tuple[dict, list[str]]:
    if skill == "bayesian-modeling":
        successes = int(request.get("successes", -1)); trials = int(request.get("trials", -1))
        alpha = float(request.get("prior_alpha", 1)); beta = float(request.get("prior_beta", 1))
        if trials <= 0 or successes < 0 or successes > trials or alpha <= 0 or beta <= 0:
            raise SkillExecutionError("Provide valid binomial data and positive Beta prior parameters.")
        post_a, post_b = alpha + successes, beta + trials - successes
        interval = stats.beta.ppf([0.025, 0.975], post_a, post_b)
        return {"posterior": {"distribution": "Beta", "alpha": post_a, "beta": post_b, "mean": post_a / (post_a + post_b), "credibleInterval95": [float(interval[0]), float(interval[1])] }}, ["Interpretation depends on the stated likelihood and prior; inspect sensitivity to defensible priors."]
    if skill == "biomedical-knowledge-graph":
        edges = request.get("edges")
        if not isinstance(edges, list) or not edges:
            raise SkillExecutionError("Provide a non-empty edges array.")
        graph: dict[str, set[str]] = defaultdict(set)
        for edge in edges:
            if not isinstance(edge, list) or len(edge) != 2:
                raise SkillExecutionError("Each graph edge must contain two node identifiers.")
            a, b = map(str, edge); graph[a].add(b); graph[b].add(a)
        seen: set[str] = set(); components = []
        for node in graph:
            if node in seen: continue
            queue = deque([node]); seen.add(node); current = []
            while queue:
                value = queue.popleft(); current.append(value)
                for neighbor in graph[value] - seen: seen.add(neighbor); queue.append(neighbor)
            components.append(current)
        return {"graph": {"nodes": len(graph), "edges": len(edges), "components": len(components), "degree": dict(sorted(((node, len(neighbors)) for node, neighbors in graph.items()), key=lambda item: (-item[1], item[0])))}}, ["Graph topology does not establish biological causality."]
    if skill in {"biosequence-analysis", "phylogenetic-analysis"}:
        sequences = request.get("sequences")
        if not isinstance(sequences, dict) or not sequences:
            raise SkillExecutionError("Provide sequences as an identifier-to-sequence object.")
        clean = {str(key): re.sub(r"\s+", "", str(value)).upper() for key, value in sequences.items()}
        if any(not value for value in clean.values()):
            raise SkillExecutionError("Sequences must be non-empty after whitespace normalization.")
        invalid = {key: sorted(set(value) - set("ACGTUN-")) for key, value in clean.items() if set(value) - set("ACGTUN-")}
        if invalid: raise SkillExecutionError("Sequences contain unsupported symbols: %s." % invalid)
        metrics = {key: {"length": len(value), "gcFraction": (value.count("G") + value.count("C")) / max(1, len(value.replace("-", ""))), "ambiguous": value.count("N")} for key, value in clean.items()}
        result = {"sequences": metrics}
        if skill == "phylogenetic-analysis":
            ids = list(clean)
            distances = []
            for i, left in enumerate(ids):
                for right in ids[i + 1:]:
                    length = min(len(clean[left]), len(clean[right])); mismatch = sum(a != b for a, b in zip(clean[left][:length], clean[right][:length]))
                    distances.append({"left": left, "right": right, "pDistance": mismatch / max(1, length), "alignedSites": length})
            result["pairwiseDistances"] = distances
        return result, ["Confirm sequence alphabet, orientation, reference build, alignment method, and evolutionary model before inferential use."]
    if skill == "cheminformatics":
        formula = str(request.get("formula") or "")
        tokens = re.findall(r"([A-Z][a-z]?)(\d*)", formula)
        if not tokens or "".join(element + count for element, count in tokens) != formula:
            raise SkillExecutionError("Provide a plain molecular formula such as C9H8O4.")
        composition = {element: int(count or 1) for element, count in tokens}
        return {"molecule": {"name": request.get("name"), "formula": formula, "elementCounts": composition, "heavyAtoms": sum(count for element, count in composition.items() if element != "H")}}, ["Formula composition cannot replace structure normalization, stereochemistry, or RDKit-grade descriptors."]
    if skill == "citation-integrity":
        text = str(request.get("text") or "")[:MAX_TEXT_CHARS]
        dois = [value.rstrip(".,;)").casefold() for value in re.findall(r"10\.\d{4,9}/[-._;()/:A-Z0-9]+", text, flags=re.I)]
        bracket = re.findall(r"\[(\d{1,5})\]", text)
        return {"citations": {"doiCount": len(dois), "uniqueDois": sorted(set(dois)), "duplicateDois": sorted(key for key, count in Counter(dois).items() if count > 1), "numericCitationLabels": sorted(set(bracket), key=int)}}, ["Identifier syntax is not proof that a citation exists or supports the associated claim; resolve and inspect primary records."]
    if skill == "genome-variant-analysis":
        variants = request.get("variants")
        if not isinstance(variants, list) or not variants: raise SkillExecutionError("Provide a non-empty variants array.")
        types = Counter(); low_quality = 0
        for row in variants:
            if not isinstance(row, dict): raise SkillExecutionError("Each variant must be an object.")
            ref, alt = str(row.get("ref") or ""), str(row.get("alt") or "")
            if not ref or not alt: raise SkillExecutionError("Each variant requires ref and alt alleles.")
            types["SNV" if len(ref) == len(alt) == 1 else "insertion" if len(alt) > len(ref) else "deletion" if len(ref) > len(alt) else "MNV"] += 1
            quality = float(row.get("qual") or 0)
            if not math.isfinite(quality):
                raise SkillExecutionError("Variant quality values must be finite numbers.")
            low_quality += quality < float(request.get("minimum_quality", 30))
        return {"variants": {"count": len(variants), "types": dict(types), "belowQualityThreshold": low_quality}}, ["Variant interpretation requires genome build, normalization, allele frequency, consequence annotation, and sample provenance."]
    if skill == "markdown-mermaid-writing":
        nodes = request.get("nodes")
        if not isinstance(nodes, list) or len(nodes) < 2: raise SkillExecutionError("Provide at least two diagram nodes.")
        escaped = [re.sub(r"[^A-Za-z0-9 _-]", "", str(node))[:80] or f"Node {index}" for index, node in enumerate(nodes)]
        mermaid = "flowchart LR\n" + "\n".join(f"    N{i}[\"{node}\"] --> N{i + 1}[\"{escaped[i + 1]}\"]" for i, node in enumerate(escaped[:-1]))
        return {"diagram": {"title": str(request.get("title") or "Scientific workflow"), "mermaid": mermaid}}, []
    if skill == "mass-spectrometry-analysis":
        spectra = request.get("spectra")
        if not isinstance(spectra, list) or not spectra: raise SkillExecutionError("Provide spectra with precursor_mz and peaks.")
        rows = []
        for index, spectrum in enumerate(spectra):
            peaks = spectrum.get("peaks") if isinstance(spectrum, dict) else None
            if not isinstance(peaks, list) or not peaks: raise SkillExecutionError("Every spectrum requires non-empty peaks.")
            intensities = np.asarray([float(peak[1]) for peak in peaks], dtype=float)
            masses = np.asarray([float(peak[0]) for peak in peaks], dtype=float)
            precursor = float(spectrum.get("precursor_mz"))
            if not np.isfinite(masses).all() or not np.isfinite(intensities).all() or not math.isfinite(precursor):
                raise SkillExecutionError("Mass-spectrometry values must be finite numbers.")
            if np.any(masses <= 0) or np.any(intensities < 0) or precursor <= 0:
                raise SkillExecutionError("Masses and precursor m/z must be positive; intensities must be nonnegative.")
            rows.append({"spectrum": index + 1, "precursorMz": precursor, "peakCount": len(peaks), "basePeakMz": float(masses[int(np.argmax(intensities))]), "totalIonCurrent": float(intensities.sum())})
        return {"spectra": rows}, ["Peak summaries do not identify compounds; calibration, adducts, tolerances, libraries, and FDR controls are required."]
    if skill == "materials-science-analysis":
        lattice = request.get("lattice")
        if not isinstance(lattice, dict): raise SkillExecutionError("Provide lattice lengths and angles.")
        a, b, c = (float(lattice[key]) for key in ("a", "b", "c")); alpha, beta, gamma = (math.radians(float(lattice[key])) for key in ("alpha", "beta", "gamma"))
        radicand = 1 + 2 * math.cos(alpha) * math.cos(beta) * math.cos(gamma) - math.cos(alpha) ** 2 - math.cos(beta) ** 2 - math.cos(gamma) ** 2
        if not all(math.isfinite(value) and value > 0 for value in (a, b, c)) or not math.isfinite(radicand) or radicand <= 0:
            raise SkillExecutionError("Lattice lengths and angles do not define a positive finite unit-cell volume.")
        volume = a * b * c * math.sqrt(radicand)
        return {"material": {"formula": request.get("formula"), "cellVolume": volume, "lattice": lattice}}, ["Composition and unit-cell geometry alone do not establish phase identity, stability, or properties."]
    if skill == "metabolic-network-modeling":
        matrix = np.asarray(request.get("stoichiometry"), dtype=float); objective = np.asarray(request.get("objective"), dtype=float); bounds = request.get("bounds")
        if matrix.ndim != 2 or objective.ndim != 1 or matrix.shape[1] != objective.size: raise SkillExecutionError("Stoichiometry columns must match the objective length.")
        solution = optimize.linprog(-objective, A_eq=matrix, b_eq=np.zeros(matrix.shape[0]), bounds=bounds, method="highs")
        return {"fluxBalance": {"success": bool(solution.success), "objective": float(-solution.fun) if solution.success else None, "fluxes": [float(value) for value in solution.x] if solution.success else [], "message": str(solution.message)}}, ["FBA conclusions depend on reaction directionality, bounds, objective choice, and model curation."]
    if skill == "pathway-enrichment":
        genes, background, gene_sets = set(map(str, request.get("genes") or [])), set(map(str, request.get("background") or [])), request.get("gene_sets")
        if not genes or not background or not isinstance(gene_sets, dict): raise SkillExecutionError("Provide genes, background, and gene_sets.")
        genes &= background; rows = []
        for name, members_value in gene_sets.items():
            members = set(map(str, members_value)) & background; overlap = genes & members
            p = stats.hypergeom.sf(len(overlap) - 1, len(background), len(members), len(genes)) if members else 1.0
            rows.append({"pathway": str(name), "overlap": sorted(overlap), "overlapCount": len(overlap), "setSize": len(members), "pValue": float(p)})
        rows.sort(key=lambda row: (row["pValue"], row["pathway"])); count = max(1, len(rows))
        running_minimum = 1.0
        for rank in range(len(rows), 0, -1):
            running_minimum = min(running_minimum, rows[rank - 1]["pValue"] * count / rank)
            rows[rank - 1]["bhAdjustedP"] = min(1.0, running_minimum)
        return {"enrichment": rows}, ["Use a prespecified, measured-gene background and versioned gene sets; enrichment is not causal evidence."]
    if skill == "quantum-computing-analysis":
        gates = request.get("gates")
        if not isinstance(gates, list) or len(gates) > 100: raise SkillExecutionError("Provide no more than 100 single-qubit gates.")
        state = np.array([1 + 0j, 0 + 0j]); matrices = {"X": np.array([[0, 1], [1, 0]], complex), "Y": np.array([[0, -1j], [1j, 0]], complex), "Z": np.array([[1, 0], [0, -1]], complex), "H": np.array([[1, 1], [1, -1]], complex) / math.sqrt(2)}
        for gate in gates:
            if gate not in matrices: raise SkillExecutionError("Supported gates are H, X, Y, and Z.")
            state = matrices[gate] @ state
        return {"statevector": {"real": [float(v.real) for v in state], "imag": [float(v.imag) for v in state], "probabilities": [float(abs(v) ** 2) for v in state]}}, ["This baseline simulates one noiseless qubit only."]
    if skill == "reproducible-workflows":
        files = request.get("files") if isinstance(request.get("files"), list) else []
        manifest = []
        for value in files:
            path = safe_input(str(value)); manifest.append({"path": str(path), "bytes": path.stat().st_size, "sha256": sha256_file(path)})
        steps = [str(value) for value in request.get("steps", [])]
        if not steps: raise SkillExecutionError("Provide at least one workflow step.")
        return {"workflow": {"steps": steps, "inputManifest": manifest, "resumePolicy": "Only artifacts with verified hashes are complete."}}, []
    if skill == "simulation-optimization":
        initial = np.asarray(request.get("initial"), dtype=float)
        if initial.shape != (2,) or request.get("objective") != "rosenbrock": raise SkillExecutionError("The bounded baseline supports a two-variable Rosenbrock objective.")
        solution = optimize.minimize(optimize.rosen, initial, method="BFGS")
        return {"optimization": {"success": bool(solution.success), "x": [float(value) for value in solution.x], "objective": float(solution.fun), "iterations": int(solution.nit), "message": str(solution.message)}}, ["Optimization of a benchmark function does not validate a domain simulation or its objective."]
    if skill == "survival-analysis":
        time_values = np.asarray(request.get("time"), dtype=float); events = np.asarray(request.get("event"), dtype=int)
        if time_values.ndim != 1 or len(time_values) != len(events) or len(time_values) < 3 or np.any(time_values < 0) or not set(events).issubset({0, 1}): raise SkillExecutionError("Provide valid nonnegative time and binary event arrays.")
        at_risk = len(time_values); survival = 1.0; curve = []
        for point in sorted(set(time_values[events == 1])):
            deaths = int(((time_values == point) & (events == 1)).sum()); at_risk = int((time_values >= point).sum()); survival *= 1 - deaths / at_risk; curve.append({"time": float(point), "atRisk": at_risk, "events": deaths, "survival": float(survival)})
        return {"kaplanMeier": curve, "n": len(time_values), "events": int(events.sum())}, ["Check censoring assumptions, delayed entry, competing risks, clustering, and proportional hazards before further inference."]
    if skill in {"time-series-forecasting", "biomedical-signal-analysis"}:
        values = np.asarray(request.get("values"), dtype=float); horizon = int(request.get("horizon", 8))
        if values.ndim != 1 or len(values) < 16 or not np.isfinite(values).all() or horizon < 1 or horizon > 1000: raise SkillExecutionError("Provide at least 16 finite values and a bounded horizon.")
        x = np.arange(len(values)).reshape(-1, 1); model = LinearRegression().fit(x, values); future = model.predict(np.arange(len(values), len(values) + horizon).reshape(-1, 1))
        residual = values - model.predict(x); result = {"trend": {"slope": float(model.coef_[0]), "intercept": float(model.intercept_)}, "forecast": [float(value) for value in future], "residualStd": float(np.std(residual, ddof=2))}
        if skill == "biomedical-signal-analysis":
            frequency = np.fft.rfftfreq(len(values), d=1 / float(request.get("sampling_hz", 1))); power = np.abs(np.fft.rfft(values - values.mean())) ** 2; index = int(np.argmax(power[1:]) + 1)
            result["signal"] = {"dominantFrequencyHz": float(frequency[index]), "samplingHz": float(request.get("sampling_hz", 1))}
        return result, ["Linear extrapolation is a baseline; validate stationarity, leakage, autocorrelation, seasonality, and out-of-sample error."]
    if skill == "biomedical-database-search":
        records = request.get("records")
        if not isinstance(records, list): raise SkillExecutionError("Provide retrieved records from an EviMed source tool.")
        valid = [row for row in records if isinstance(row, dict) and row.get("id") and row.get("source")]
        return {"retrieval": {"query": request.get("query"), "recordCount": len(valid), "records": valid[:100]}}, ["A retrieval receipt proves traceability, not completeness, relevance, or evidentiary support."]
    raise SkillExecutionError("No deterministic baseline is registered for this skill.")


def render_report(skill: str, result: dict, warnings: list[str], input_sha256: str | None) -> str:
    lines = [f"# {skill} execution report", "", f"- Generated: {utc_now()}", f"- Engine schema: {SCHEMA_VERSION}"]
    if input_sha256: lines.append(f"- Input SHA-256: `{input_sha256}`")
    lines.extend(["", "## Executed result", "", "```json", json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True), "```"])
    if warnings:
        lines.extend(["", "## Interpretation boundaries", ""] + [f"- {warning}" for warning in warnings])
    lines.extend(["", "## Required next checks", "", "- Verify data provenance, units, cohort definitions, and missingness.", "- Inspect the generated numeric result before making a material scientific claim.", "- Escalate to a domain-specific implementation when the bounded baseline does not cover the required method.", ""])
    return "\n".join(lines)


def execute(skill: str, request: dict, output_dir: Path, input_path: Path | None) -> dict:
    started = utc_now()
    if skill in PLAN_SKILLS:
        result, warnings = analyze_plan(skill, request)
    elif skill in TABLE_SKILLS:
        result, warnings = analyze_table(skill, request)
    else:
        result, warnings = analyze_special(skill, request)
    input_hash = sha256_file(input_path) if input_path else None
    result_path = output_dir / "results.json"
    report_path = output_dir / f"{skill}-report.md"
    result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    report_path.write_text(render_report(skill, result, warnings, input_hash), encoding="utf-8")
    artifacts = []
    for path in (result_path, report_path):
        artifacts.append({"path": str(path), "bytes": path.stat().st_size, "sha256": sha256_file(path)})
    return {
        "schemaVersion": SCHEMA_VERSION,
        "status": "success" if not warnings else "warning",
        "summary": f"Executed the bounded deterministic baseline for {skill} and wrote {len(artifacts)} verified artifacts.",
        "skill": skill,
        "startedAt": started,
        "finishedAt": utc_now(),
        "input": {"path": str(input_path) if input_path else None, "sha256": input_hash, "smokeFixture": input_path is None},
        "warnings": warnings,
        "next_actions": ["Review the report boundaries before scientific interpretation."],
        "artifacts": artifacts,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skill", required=True)
    parser.add_argument("--input")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--smoke", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        input_path = safe_input(args.input)
        output_dir = safe_output_dir(args.output_dir)
        request = read_request(input_path, args.smoke, args.skill)
        receipt = execute(args.skill, request, output_dir, input_path)
        receipt_path = output_dir / "execution-receipt.json"
        receipt_path.write_text(json.dumps(receipt, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print(json.dumps(receipt, ensure_ascii=False, sort_keys=True))
        return 0
    except (OSError, ValueError, TypeError, SkillExecutionError) as error:
        print(json.dumps({"schemaVersion": SCHEMA_VERSION, "status": "error", "summary": str(error), "next_actions": ["Correct the input contract and retry."], "artifacts": []}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
