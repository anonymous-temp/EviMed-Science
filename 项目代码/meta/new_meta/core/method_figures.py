"""Deterministic publication figures for compiled synthesis families."""
from __future__ import annotations

import math
from pathlib import Path
from typing import Any

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

from new_meta.core.result_rob import load_effective_rob_assessments
from new_meta.engines import visualization


_RATIO_MEASURES = {"OR", "RR", "HR", "IRR"}


def generate_method_figures(
    project,
    *,
    lang: str = "en",
    extracted_studies: list | None = None,
    rob_results: list | None = None,
) -> list[str]:
    """Render only figures supported by the current compiled synthesis."""
    synthesis = project.load_json("synthesis_result.json", subdir="analysis") or {}
    if not synthesis:
        raise ValueError("compiled method figures require synthesis_result.json")
    figures_dir = Path(project.base_dir) / "figures"
    figures_dir.mkdir(parents=True, exist_ok=True)
    created: list[str] = []
    family = str(synthesis.get("family") or "")
    payload = synthesis.get("engine_payload") or {}
    label_map = _study_label_map(extracted_studies or [])

    if family == "dose_response":
        curve = [item for item in payload.get("curve") or [] if isinstance(item, dict)]
        if curve:
            path = figures_dir / "dose_response_curve.png"
            _dose_response_plot(
                curve,
                dose_unit=str(payload.get("dose_unit") or "dose"),
                measure=str(payload.get("measure") or "effect"),
                path=path,
                lang=lang,
            )
            created.append(path.name)
    else:
        rows = _interval_rows(synthesis, label_map=label_map)
        estimates = synthesis.get("primary_estimates") or []
        if rows and estimates:
            primary = estimates[0]
            path = figures_dir / "forest_plot.png"
            _interval_plot(
                rows,
                pooled=primary if family in {"intervention_rct", "ipd_meta"} else None,
                measure=str(primary.get("measure") or "effect"),
                title=(
                    "网络Meta分析效应估计" if lang == "zh" and family == "network_meta"
                    else "Network meta-analysis estimates" if family == "network_meta"
                    else "主要结局森林图" if lang == "zh"
                    else "Forest plot for the primary outcome"
                ),
                path=path,
            )
            created.append(path.name)

    if family == "network_meta":
        geometry = payload.get("network_geometry") or {}
        if geometry.get("nodes"):
            path = figures_dir / "nma_network.png"
            visualization.network_plot(
                geometry,
                str(path),
                title="网络Meta分析证据网络" if lang == "zh" else "Network meta-analysis evidence geometry",
            )
            created.append(path.name)
        league = payload.get("league_table") or []
        treatments = payload.get("treatments") or []
        if league and treatments:
            path = figures_dir / "nma_league_table.png"
            visualization.league_table_heatmap(
                league,
                [str(item) for item in treatments],
                str(path),
                title="网络Meta分析联赛表" if lang == "zh" else "Network meta-analysis league table",
            )
            created.append(path.name)

    assessments = load_effective_rob_assessments(project, rob_results or [])
    required = {str(item) for item in synthesis.get("input_result_ids") or []}
    rob_data = []
    for assessment in assessments:
        result_id = str(getattr(assessment, "result_id", "") or "")
        if required and (not result_id or result_id not in required):
            continue
        domains = {
            str(domain.domain): _normalise_rob_judgment(domain.judgment)
            for domain in getattr(assessment, "domains", []) or []
        }
        if domains:
            study_id = str(getattr(assessment, "study_id", "") or result_id)
            rob_data.append({
                "study_label": label_map.get(study_id, study_id),
                "domains": domains,
            })
    if rob_data:
        path = figures_dir / "rob_summary.png"
        visualization.rob_summary_plot(
            rob_data,
            str(path),
            tool=str(getattr(assessments[0], "tool_used", "RoB 2") or "RoB 2"),
            lang=lang,
        )
        created.append(path.name)
    return created


def _study_label_map(studies: list) -> dict[str, str]:
    labels: dict[str, str] = {}
    for study in studies:
        characteristics = getattr(study, "characteristics", None)
        if characteristics is None:
            continue
        study_id = str(getattr(characteristics, "study_id", "") or "")
        authors = getattr(characteristics, "authors", "") or ""
        author = (
            str(authors[0]).strip()
            if isinstance(authors, (list, tuple)) and authors
            else str(authors).split(",")[0].strip()
        )
        year = getattr(characteristics, "year", None)
        title = str(getattr(characteristics, "title", "") or "").strip()
        label = " ".join(item for item in (author, str(year or "")) if item).strip() or title or study_id
        if study_id:
            labels[study_id] = label
            labels[f"study:{study_id}"] = label
    return labels


def _interval_rows(synthesis: dict[str, Any], *, label_map: dict[str, str]) -> list[dict[str, Any]]:
    family = str(synthesis.get("family") or "")
    payload = synthesis.get("engine_payload") or {}
    measure = str((synthesis.get("primary_estimates") or [{}])[0].get("measure") or "").upper()
    analysis_scale = str((payload.get("diagnostics") or {}).get("analysis_scale") or "").lower()
    rows: list[dict[str, Any]] = []
    if family == "intervention_rct":
        for item in payload.get("study_effects") or []:
            if item.get("analysis_effect") is None or item.get("variance") is None:
                continue
            effect = float(item["analysis_effect"])
            se = math.sqrt(float(item["variance"]))
            lower, upper = effect - 1.96 * se, effect + 1.96 * se
            if measure in _RATIO_MEASURES and "log" in analysis_scale:
                effect, lower, upper = math.exp(effect), math.exp(lower), math.exp(upper)
            study_id = str(item.get("study_id") or "")
            rows.append({
                "label": label_map.get(study_id, study_id),
                "estimate": effect,
                "ci_lower": lower,
                "ci_upper": upper,
            })
    elif family == "ipd_meta":
        for item in payload.get("study_effects") or []:
            study_id = str(item.get("study_id") or "")
            if item.get("effect") is None:
                continue
            rows.append({
                "label": label_map.get(study_id, study_id),
                "estimate": float(item["effect"]),
                "ci_lower": _float_or_none(item.get("ci_lower")),
                "ci_upper": _float_or_none(item.get("ci_upper")),
            })
    elif family == "network_meta":
        for item in synthesis.get("primary_estimates") or []:
            rows.append({
                "label": str(item.get("label") or item.get("estimate_id") or "comparison"),
                "estimate": float(item["estimate"]),
                "ci_lower": _float_or_none(item.get("ci_lower")),
                "ci_upper": _float_or_none(item.get("ci_upper")),
            })
    else:
        for item in synthesis.get("primary_estimates") or []:
            rows.append({
                "label": str(item.get("label") or item.get("estimate_id") or "estimate"),
                "estimate": float(item["estimate"]),
                "ci_lower": _float_or_none(item.get("ci_lower")),
                "ci_upper": _float_or_none(item.get("ci_upper")),
            })
    return [row for row in rows if row.get("ci_lower") is not None and row.get("ci_upper") is not None]


def _interval_plot(
    rows: list[dict[str, Any]],
    *,
    pooled: dict[str, Any] | None,
    measure: str,
    title: str,
    path: Path,
) -> None:
    height = max(4.0, 1.4 + 0.55 * (len(rows) + (1 if pooled else 0)))
    fig, ax = plt.subplots(figsize=(10, height))
    y_values = list(range(len(rows), 0, -1))
    for row, y in zip(rows, y_values):
        estimate = float(row["estimate"])
        lower = float(row["ci_lower"])
        upper = float(row["ci_upper"])
        ax.plot([lower, upper], [y, y], color="#263238", linewidth=1.2)
        ax.scatter([estimate], [y], marker="s", s=45, color="#1976D2", edgecolor="black", linewidth=0.5)
    labels = [f"{row['label']}  {float(row['estimate']):.3g} [{float(row['ci_lower']):.3g}, {float(row['ci_upper']):.3g}]" for row in rows]
    ticks = list(y_values)
    if pooled:
        estimate = float(pooled["estimate"])
        lower = float(pooled["ci_lower"])
        upper = float(pooled["ci_upper"])
        ax.fill([lower, estimate, upper, estimate], [0, 0.28, 0, -0.28], color="#D32F2F", edgecolor="black")
        ticks.append(0)
        labels.append(f"Pooled  {estimate:.3g} [{lower:.3g}, {upper:.3g}]")
    ax.set_yticks(ticks)
    ax.set_yticklabels(labels, fontsize=8)
    if str(measure).upper() in _RATIO_MEASURES:
        ax.axvline(1.0, color="#757575", linestyle="--", linewidth=1)
        if all(float(row["ci_lower"]) > 0 for row in rows):
            ax.set_xscale("log")
    else:
        ax.axvline(0.0, color="#757575", linestyle="--", linewidth=1)
    ax.set_xlabel(measure)
    ax.set_title(title, fontweight="bold")
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    fig.tight_layout()
    fig.savefig(path, dpi=300, bbox_inches="tight")
    plt.close(fig)


def _dose_response_plot(curve: list[dict[str, Any]], *, dose_unit: str, measure: str, path: Path, lang: str) -> None:
    ordered = sorted(curve, key=lambda item: float(item["dose"]))
    x = [float(item["dose"]) for item in ordered]
    y = [float(item["effect"]) for item in ordered]
    lower = [float(item["ci_lower"]) for item in ordered]
    upper = [float(item["ci_upper"]) for item in ordered]
    fig, ax = plt.subplots(figsize=(8, 5))
    ax.plot(x, y, color="#1976D2", linewidth=2)
    ax.fill_between(x, lower, upper, color="#90CAF9", alpha=0.45)
    ax.axhline(1.0 if str(measure).upper() in _RATIO_MEASURES else 0.0, color="#757575", linestyle="--")
    ax.set_xlabel(f"剂量（{dose_unit}）" if lang == "zh" else f"Dose ({dose_unit})")
    ax.set_ylabel(measure)
    ax.set_title("剂量-反应曲线" if lang == "zh" else "Dose-response curve", fontweight="bold")
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    fig.tight_layout()
    fig.savefig(path, dpi=300, bbox_inches="tight")
    plt.close(fig)


def _float_or_none(value: Any) -> float | None:
    return None if value is None else float(value)


def _normalise_rob_judgment(value: str) -> str:
    text = str(value or "").strip().lower()
    if "high" in text or "高" in text:
        return "High risk"
    if "some" in text or "concern" in text or "担忧" in text or "关注" in text:
        return "Some concerns"
    if "low" in text or "低" in text:
        return "Low risk"
    return "Some concerns"
