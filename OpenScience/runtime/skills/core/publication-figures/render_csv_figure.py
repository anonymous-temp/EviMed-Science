#!/usr/bin/env python3
"""Render a simple publication-style line figure from a two-column CSV."""

from __future__ import annotations

import argparse
import csv
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--x-label", required=True)
    parser.add_argument("--y-label", required=True)
    parser.add_argument("--title", required=True)
    args = parser.parse_args()

    import matplotlib.pyplot as plt

    with args.input.open(encoding="utf-8-sig", newline="") as handle:
        reader = csv.reader(handle)
        header = next(reader)
        rows = list(reader)
    if len(header) != 2 or not 1 <= len(rows) <= 10_000:
        parser.error("input must contain exactly two columns and 1-10000 data rows")
    x = [row[0] for row in rows if len(row) == 2]
    try:
        y = [float(row[1]) for row in rows if len(row) == 2]
    except ValueError:
        parser.error("the second column must be numeric")
    if len(x) != len(rows) or not all(value == value and abs(value) != float("inf") for value in y):
        parser.error("input contains invalid or non-finite values")

    style = Path(__file__).with_name("openscience.mplstyle")
    plt.style.use(str(style))
    figure, axis = plt.subplots(figsize=(7.2, 4.2))
    axis.plot(x, y, color="#2a78d6", marker="o", linewidth=2)
    axis.set(title=args.title, xlabel=args.x_label, ylabel=args.y_label)
    figure.tight_layout()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    figure.savefig(args.output, bbox_inches="tight")
    plt.close(figure)
    print(args.output)


if __name__ == "__main__":
    main()
