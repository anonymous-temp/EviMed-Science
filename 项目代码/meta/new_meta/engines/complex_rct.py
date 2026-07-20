"""Design-aware pooling for cluster, crossover, and correlated multi-arm RCTs."""
from __future__ import annotations

from collections import Counter, defaultdict
import math
from typing import Any

import numpy as np
from pydantic import BaseModel, Field, model_validator

from new_meta.engines.meta_engine import random_effects_hksj, random_effects_reml
from new_meta.schemas.meta_result import StudyEffect


_RATIO_MEASURES = {"OR", "RR", "HR", "IRR"}
_SUPPORTED_DESIGNS = {"cluster_rct", "crossover_rct", "multi_arm_rct", "parallel_rct"}
_Z_975 = 1.959963984540054


class ComplexRCTRecord(BaseModel):
    result_id: str = Field(min_length=1)
    study_id: str = Field(min_length=1)
    design: str = Field(min_length=1)
    measure: str = Field(min_length=1)
    estimate: float
    standard_error: float | None = Field(default=None, gt=0)
    variance: float | None = Field(default=None, gt=0)
    ci_lower: float | None = None
    ci_upper: float | None = None
    scale: str = "original"
    precision_basis: str = Field(min_length=1)
    estimand_id: str = Field(min_length=1)
    treatment: str = Field(min_length=1)
    comparator: str = Field(min_length=1)
    contrast_id: str = Field(min_length=1)
    covariance_with: dict[str, float] = Field(default_factory=dict)
    paired_analysis: bool = False
    intracluster_correlation: float | None = Field(default=None, ge=0, lt=1)
    mean_cluster_size: float | None = Field(default=None, gt=1)

    @model_validator(mode="after")
    def validate_precision(self):
        if self.standard_error is None and self.variance is None and (
            self.ci_lower is None or self.ci_upper is None
        ):
            raise ValueError("standard error, variance, or confidence interval is required")
        if self.design not in _SUPPORTED_DESIGNS:
            raise ValueError(f"unsupported RCT design: {self.design}")
        if self.treatment.strip().casefold() == self.comparator.strip().casefold():
            raise ValueError("treatment and comparator must differ")
        return self


class ComplexRCTResult(BaseModel):
    schema_version: int = 1
    estimator: str = "DESIGN_AWARE_REML_HKSJ"
    measure: str
    n_studies: int
    n_contrasts: int
    pooled_effect: float
    ci_lower: float
    ci_upper: float
    pooled_analysis_scale: float
    standard_error_analysis_scale: float
    tau_squared: float = Field(ge=0)
    i_squared: float = Field(ge=0, le=100)
    q: float = Field(ge=0)
    prediction_interval: tuple[float, float] | None = None
    design_counts: dict[str, int]
    study_effects: list[dict[str, Any]]
    sensitivity: dict[str, Any] = Field(default_factory=dict)
    converged: bool = True
    diagnostics: dict[str, Any] = Field(default_factory=dict)


def run_complex_rct(records: list[ComplexRCTRecord | dict]) -> ComplexRCTResult:
    """Pool one coherent estimand after resolving every design dependency.

    Cluster trials must provide either source-reported cluster-adjusted precision
    or the ICC and mean cluster size needed for a design-effect correction.
    Crossover trials must provide a source-reported paired analysis. Multiple
    eligible contrasts from one multi-arm trial are first consolidated with
    explicit within-study GLS, producing one independent contribution per trial.
    """
    rows = [
        item if isinstance(item, ComplexRCTRecord) else ComplexRCTRecord.model_validate(item)
        for item in records
    ]
    if len(rows) < 2:
        raise ValueError("complex RCT synthesis requires at least two contrasts")
    measures = {item.measure.upper() for item in rows}
    if len(measures) != 1:
        raise ValueError("all complex RCT contrasts must use the same effect measure")
    estimands = {_norm(item.estimand_id) for item in rows}
    if len(estimands) != 1:
        raise ValueError("all complex RCT contrasts must target the same estimand")
    measure = next(iter(measures))

    prepared: list[dict[str, Any]] = []
    for row in rows:
        yi, vi = _analysis_effect(row, measure)
        design_effect = None
        if row.design == "cluster_rct":
            if row.precision_basis == "reported_cluster_adjusted":
                pass
            elif row.precision_basis == "design_effect_adjusted":
                if row.intracluster_correlation is None or row.mean_cluster_size is None:
                    raise ValueError(
                        "cluster-adjusted precision requires a reported adjustment or both ICC and mean cluster size"
                    )
                design_effect = 1.0 + (row.mean_cluster_size - 1.0) * row.intracluster_correlation
                vi *= design_effect
            else:
                raise ValueError(
                    "cluster-adjusted precision is required for every cluster RCT contrast"
                )
        elif row.design == "crossover_rct":
            if row.precision_basis != "reported_paired_effect" or not row.paired_analysis:
                raise ValueError(
                    "crossover RCT synthesis requires a source-reported paired analysis and paired precision"
                )
        prepared.append({
            "record": row,
            "yi": yi,
            "vi": vi,
            "design_effect": design_effect,
        })

    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in prepared:
        grouped[item["record"].study_id].append(item)
    if len(grouped) < 2:
        raise ValueError("complex RCT synthesis requires at least two independent studies")

    effects: list[StudyEffect] = []
    study_effects: list[dict[str, Any]] = []
    for study_id, group in sorted(grouped.items()):
        yi, vi = _consolidate_study(study_id, group)
        effects.append(
            StudyEffect(
                study_id=study_id,
                study_label=study_id,
                yi=yi,
                vi=vi,
                se=math.sqrt(vi),
            )
        )
        designs = sorted({item["record"].design for item in group})
        if len(designs) != 1:
            raise ValueError(f"study {study_id} cannot mix RCT design labels")
        study_effects.append({
            "study_id": study_id,
            "design": designs[0],
            "n_contrasts": len(group),
            "analysis_effect": yi,
            "variance": vi,
            "design_effect": group[0]["design_effect"],
        })

    reml = random_effects_reml(effects, measure, "Design-aware treatment effect")
    hksj = random_effects_hksj(effects, measure, "Design-aware treatment effect")
    reml_se = _ci_se(reml, measure)
    design_counts = Counter(item["design"] for item in study_effects)
    return ComplexRCTResult(
        measure=measure,
        n_studies=len(effects),
        n_contrasts=len(rows),
        pooled_effect=reml.pooled_effect,
        ci_lower=reml.ci_lower,
        ci_upper=reml.ci_upper,
        pooled_analysis_scale=float(
            reml.pooled_log if reml.pooled_log is not None else reml.pooled_effect
        ),
        standard_error_analysis_scale=reml_se,
        tau_squared=reml.tau_squared,
        i_squared=reml.i_squared,
        q=reml.q_statistic,
        prediction_interval=reml.prediction_interval,
        design_counts=dict(sorted(design_counts.items())),
        study_effects=study_effects,
        sensitivity={
            "HKSJ": {
                "estimate": hksj.pooled_effect,
                "ci_lower": hksj.ci_lower,
                "ci_upper": hksj.ci_upper,
            }
        },
        diagnostics={
            "analysis_scale": "log" if measure in _RATIO_MEASURES else "original",
            "cluster_adjustment": "reported_or_design_effect",
            "crossover_precision": "paired_only",
            "multi_arm_covariance": "explicit_gls_consolidation",
            "independent_study_units": True,
            "estimand_id": rows[0].estimand_id,
        },
    )


def _analysis_effect(record: ComplexRCTRecord, measure: str) -> tuple[float, float]:
    ratio = measure in _RATIO_MEASURES
    estimate = float(record.estimate)
    lower, upper = record.ci_lower, record.ci_upper
    scale = record.scale.strip().lower()
    if ratio and scale == "original":
        if estimate <= 0 or (lower is not None and lower <= 0) or (upper is not None and upper <= 0):
            raise ValueError(f"{measure} estimates and confidence bounds must be positive")
        yi = math.log(estimate)
        ci_se = (
            (math.log(float(upper)) - math.log(float(lower))) / (2 * _Z_975)
            if lower is not None and upper is not None
            else None
        )
    else:
        yi = estimate
        ci_se = (
            (float(upper) - float(lower)) / (2 * _Z_975)
            if lower is not None and upper is not None
            else None
        )
    if ci_se is not None:
        vi = ci_se * ci_se
    elif record.standard_error is not None:
        vi = float(record.standard_error) ** 2
    else:
        vi = float(record.variance)
    if not math.isfinite(yi) or not math.isfinite(vi) or vi <= 0:
        raise ValueError("effect and precision must be finite with positive variance")
    return yi, vi


def _consolidate_study(study_id: str, group: list[dict[str, Any]]) -> tuple[float, float]:
    if len(group) == 1:
        return float(group[0]["yi"]), float(group[0]["vi"])
    if any(item["record"].design != "multi_arm_rct" for item in group):
        raise ValueError(
            f"study {study_id} has multiple contrasts but is not declared as a multi-arm RCT"
        )
    ids = [item["record"].contrast_id for item in group]
    if len(ids) != len(set(ids)):
        raise ValueError(f"study {study_id} contrast_id values must be unique")
    n = len(group)
    covariance = np.diag([float(item["vi"]) for item in group])
    for left in range(n):
        for right in range(left + 1, n):
            left_row = group[left]["record"]
            right_row = group[right]["record"]
            value = left_row.covariance_with.get(right_row.contrast_id)
            reverse = right_row.covariance_with.get(left_row.contrast_id)
            if value is None and reverse is None:
                raise ValueError(
                    f"multi-arm study {study_id} requires explicit covariance between dependent contrasts"
                )
            if value is not None and reverse is not None and not math.isclose(
                float(value), float(reverse), rel_tol=1e-8, abs_tol=1e-12
            ):
                raise ValueError(f"multi-arm study {study_id} covariance entries disagree")
            covariance[left, right] = covariance[right, left] = float(
                value if value is not None else reverse
            )
    if np.any(np.linalg.eigvalsh(covariance) <= 0):
        raise ValueError(f"multi-arm study {study_id} covariance matrix must be positive-definite")
    precision = np.linalg.inv(covariance)
    ones = np.ones(n, dtype=float)
    y = np.array([float(item["yi"]) for item in group], dtype=float)
    denominator = float(ones @ precision @ ones)
    return float(ones @ precision @ y / denominator), float(1.0 / denominator)


def _ci_se(result, measure: str) -> float:
    if measure in _RATIO_MEASURES:
        return float(result.ci_upper_log - result.ci_lower_log) / (2 * _Z_975)
    return float(result.ci_upper - result.ci_lower) / (2 * _Z_975)


def _norm(value: str) -> str:
    return " ".join(str(value).strip().casefold().replace("_", " ").split())
