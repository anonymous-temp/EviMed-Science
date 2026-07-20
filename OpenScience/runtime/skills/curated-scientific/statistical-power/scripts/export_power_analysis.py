#!/usr/bin/env python3
"""Export a reproducible two-group power analysis as Markdown, CSV, and PNG."""

from __future__ import annotations

import argparse
import csv
import math
from pathlib import Path

from power import power_curve, sample_size


def bounded_probability(value: str) -> float:
    number = float(value)
    if not 0 < number < 1:
        raise argparse.ArgumentTypeError("value must be between 0 and 1")
    return number


def positive_effect(value: str) -> float:
    number = float(value)
    if not math.isfinite(number) or number <= 0:
        raise argparse.ArgumentTypeError("effect size must be positive and finite")
    return number


def positive_int(value: str) -> int:
    number = int(value)
    if number <= 0:
        raise argparse.ArgumentTypeError("value must be positive")
    return number


def export_analysis(
    output_dir: Path,
    effect_size: float,
    alpha: float,
    target_power: float,
    minimum_n: int,
    maximum_n: int,
    step: int,
) -> dict[str, Path]:
    if minimum_n >= maximum_n:
        raise ValueError("minimum_n must be smaller than maximum_n")
    output_dir.mkdir(parents=True, exist_ok=True)
    markdown_path = output_dir / "power-analysis.md"
    csv_path = output_dir / "power-curve.csv"
    figure_path = output_dir / "power-curve.png"

    required = int(sample_size("t_ind", effect_size=effect_size, alpha=alpha, power=target_power))
    stop = max(maximum_n, required + step)
    sample_sizes, powers = power_curve(
        "t_ind",
        effect_size=effect_size,
        n_range=range(minimum_n, stop + 1, step),
        alpha=alpha,
        power_target=target_power,
        save=figure_path,
    )

    with csv_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["n_per_group", "power"])
        for sample, achieved in zip(sample_sizes, powers, strict=True):
            writer.writerow([int(sample), f"{float(achieved):.8f}"])

    total = required * 2
    markdown_path.write_text(
        "\n".join(
            [
                "# Two-group power analysis",
                "",
                f"- Standardized effect (Cohen's d): {effect_size:g}",
                f"- Alpha (two-sided): {alpha:g}",
                f"- Target power: {target_power:g}",
                f"- Required sample size: {required} per group ({total} total)",
                "- Method: statsmodels two-independent-samples t-test power solver",
                "",
                "The CSV and PNG in this directory contain the corresponding sensitivity curve.",
                "",
            ]
        ),
        encoding="utf-8",
    )
    return {"markdown": markdown_path, "csv": csv_path, "figure": figure_path}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--effect-size", default=0.5, type=positive_effect)
    parser.add_argument("--alpha", default=0.05, type=bounded_probability)
    parser.add_argument("--target-power", default=0.8, type=bounded_probability)
    parser.add_argument("--minimum-n", default=10, type=positive_int)
    parser.add_argument("--maximum-n", default=120, type=positive_int)
    parser.add_argument("--step", default=5, type=positive_int)
    args = parser.parse_args()
    artifacts = export_analysis(
        args.output_dir,
        args.effect_size,
        args.alpha,
        args.target_power,
        args.minimum_n,
        args.maximum_n,
        args.step,
    )
    for name, artifact in artifacts.items():
        print(f"{name}={artifact}")


if __name__ == "__main__":
    main()
