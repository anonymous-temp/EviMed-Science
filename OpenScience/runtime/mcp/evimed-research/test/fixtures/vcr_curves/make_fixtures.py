#!/usr/bin/env python3
"""Regenerates the Kaplan-Meier figures the digitizer's numerical tests read.

Each figure is drawn from a known step function, so the digitizer's error is
measured against the truth and not against another digitizer. The outputs are
committed (``*.png``, ``*.jpg`` and one ``*.truth.json`` each); CI does not run
this script, because matplotlib is in the runtime image but not in the test
job. Run it with a Python that has matplotlib, numpy and Pillow::

    python3 make_fixtures.py

The truth file holds, per curve, the knots of the true step function
(``times[k], surv[k]``: survival is ``surv[k]`` from ``times[k]`` until the next
knot), the calibration a reader would state from the axis labels, the plot area
in pixels where matplotlib reports it, and the figure's size.
"""
import json
import pathlib

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

HERE = pathlib.Path(__file__).resolve().parent
DPI = 100


def km_arm(seed, n, median, censor_rate, horizon):
    """A Kaplan-Meier step function from simulated exponential survival with uniform censoring."""
    rng = np.random.default_rng(seed)
    event_time = rng.exponential(median / np.log(2), n)
    censor_time = rng.uniform(0, horizon / max(censor_rate, 1e-9), n) if censor_rate > 0 else np.full(n, np.inf)
    time = np.minimum(np.minimum(event_time, censor_time), horizon)
    event = (event_time <= censor_time) & (event_time <= horizon)
    order = np.argsort(time, kind="stable")
    time, event = time[order], event[order]
    at_risk = n
    survival = 1.0
    knots = [(0.0, 1.0)]
    censored = []
    for t, e in zip(time, event):
        if e:
            survival *= 1.0 - 1.0 / at_risk
            knots.append((float(t), float(survival)))
        else:
            censored.append((float(t), float(survival)))
        at_risk -= 1
    return knots, censored


def level(knots, t):
    value = 1.0
    for time, survival in knots:
        if time <= t:
            value = survival
        else:
            break
    return value


def draw(path, arms, *, xlim, ylim, xticks, yticks, xlabel, ylabel, percent=False, grid=False, legend=False, despine=False,
         ticks_length=None, annotation=None, marker="+", size=(6.4, 4.8), linestyles=None, line_width=2.0):
    fig, ax = plt.subplots(figsize=size, dpi=DPI)
    for index, (name, color, knots, censored) in enumerate(arms):
        times = [t for t, _ in knots] + [xlim[1] if knots[-1][0] < xlim[1] else knots[-1][0]]
        values = [s for _, s in knots] + [knots[-1][1]]
        scale = 100.0 if percent else 1.0
        style = (linestyles or {}).get(name, "-")
        ax.step(times, [v * scale for v in values], where="post", color=color, lw=line_width, label=name, linestyle=style)
        if censored:
            ax.plot([t for t, _ in censored], [s * scale for _, s in censored], linestyle="none", marker=marker, color=color, ms=7, mew=1.2)
    ax.set_xlim(*xlim)
    ax.set_ylim(*ylim)
    ax.set_xticks(xticks)
    ax.set_yticks(yticks)
    ax.set_xlabel(xlabel)
    ax.set_ylabel(ylabel)
    if grid:
        ax.grid(True, color="#d0d0d0", lw=0.8)
    if legend:
        ax.legend(loc="upper right")
    if despine:
        ax.spines["top"].set_visible(False)
        ax.spines["right"].set_visible(False)
    if ticks_length is not None:
        ax.tick_params(length=ticks_length)
    if annotation:
        ax.text(0.45, 0.55, annotation, transform=ax.transAxes, fontsize=10, color="black")
    fig.tight_layout()
    fig.canvas.draw()
    box = ax.get_window_extent()
    width, height = fig.canvas.get_width_height()
    area = {"left": float(box.x0), "top": float(height - box.y1), "right": float(box.x1), "bottom": float(height - box.y0)}
    fig.savefig(path, dpi=DPI)
    plt.close(fig)
    return area, {"width": int(width), "height": int(height)}


def truth(path_stem, arms, calibration, area, size, extra=None):
    body = {
        "calibration": calibration, "plotArea": area, "size": size,
        "curves": [{"name": name, "color": color, "times": [t for t, _ in knots], "surv": [s for _, s in knots]} for name, color, knots, _ in arms],
        **(extra or {}),
    }
    pathlib.Path(str(path_stem) + ".truth.json").write_text(json.dumps(body, indent=1), encoding="utf-8")


def jpeg(png, jpg, quality):
    Image.open(png).convert("RGB").save(jpg, quality=quality, subsampling=2)


def main():
    cal_months = {"x": {"min": 0, "max": 60, "unit": "months"}, "y": {"min": 0, "max": 1, "scale": "fraction"}}

    # 1. one curve, a frame, censoring crosses
    knots, censored = km_arm(11, 140, 22.0, 1.2, 60)
    arms = [("Treatment", "#1f77b4", knots, censored)]
    area, size = draw(HERE / "km_single.png", arms, xlim=(0, 60), ylim=(0, 1.05), xticks=range(0, 61, 10), yticks=np.arange(0, 1.01, 0.2),
                      xlabel="Months", ylabel="Overall survival")
    truth(HERE / "km_single", arms, cal_months, area, size)

    # 2. two colours, gridlines, censoring crosses, a legend inside the plot
    a_knots, a_cens = km_arm(21, 220, 24.0, 1.0, 48)
    b_knots, b_cens = km_arm(22, 220, 15.0, 1.0, 48)
    arms = [("Control", "#d62728", b_knots, b_cens), ("Experimental", "#1f77b4", a_knots, a_cens)]
    cal48 = {"x": {"min": 0, "max": 48, "unit": "months"}, "y": {"min": 0, "max": 1, "scale": "fraction"}}
    area, size = draw(HERE / "km_two_colors.png", arms, xlim=(0, 48), ylim=(0, 1.05), xticks=range(0, 49, 6), yticks=np.arange(0, 1.01, 0.2),
                      xlabel="Months since randomisation", ylabel="Progression-free survival", grid=True, legend=True)
    truth(HERE / "km_two_colors", arms, cal48, area, size, {"legendOrder": ["Control", "Experimental"]})
    jpeg(HERE / "km_two_colors.png", HERE / "km_two_colors.jpg", 60)

    # 3. a black curve, survminer-like (no top or right spine), percent axis, annotation text in the plot, vertical censor ticks
    k_knots, k_cens = km_arm(31, 300, 5.5, 0.15, 10)
    arms = [("All patients", "#000000", k_knots, k_cens)]
    cal_pct = {"x": {"min": 0, "max": 10, "unit": "years"}, "y": {"min": 0, "max": 100, "scale": "percent"}}
    area, size = draw(HERE / "km_black_percent.png", arms, xlim=(0, 10), ylim=(0, 105), xticks=range(0, 11, 2), yticks=range(0, 101, 20),
                      xlabel="Time (years)", ylabel="Survival probability (%)", percent=True, grid=True, despine=True,
                      annotation="HR 0.62 (0.48-0.80)\np < 0.001", marker="|")
    truth(HERE / "km_black_percent", arms, cal_pct, area, size)

    # 4. no tick marks at all: the axis lines' ends carry the stated values
    n_knots, n_cens = km_arm(41, 120, 14.0, 1.0, 36)
    arms = [("Cohort", "#2ca02c", n_knots, n_cens)]
    cal36 = {"x": {"min": 0, "max": 36, "unit": "months"}, "y": {"min": 0, "max": 1, "scale": "fraction"}}
    area, size = draw(HERE / "km_no_ticks.png", arms, xlim=(0, 36), ylim=(0, 1.0), xticks=[], yticks=[], xlabel="Months", ylabel="Survival",
                      ticks_length=0)
    truth(HERE / "km_no_ticks", arms, cal36, area, size)

    # 5. a dashed second curve
    d1, c1 = km_arm(51, 200, 20.0, 1.0, 48)
    d2, c2 = km_arm(52, 200, 12.0, 1.0, 48)
    arms = [("Placebo", "#ff7f0e", d2, c2), ("Active", "#9467bd", d1, c1)]
    area, size = draw(HERE / "km_dashed.png", arms, xlim=(0, 48), ylim=(0, 1.05), xticks=range(0, 49, 12), yticks=np.arange(0, 1.01, 0.25),
                      xlabel="Months", ylabel="Event-free survival", linestyles={"Placebo": (0, (5, 3))})
    truth(HERE / "km_dashed", arms, cal48, area, size)

    # 6. a risk table panel under the curves: two panels, two axes
    t1, tc1 = km_arm(61, 160, 20.0, 1.0, 36)
    t2, tc2 = km_arm(62, 160, 13.0, 1.0, 36)
    for black in (False, True):
        fig, (top, bottom) = plt.subplots(2, 1, figsize=(6.4, 5.6), dpi=DPI, gridspec_kw={"height_ratios": [4, 1]})
        colors = ("#000000", "#555555") if black else ("#d62728", "#1f77b4")
        for knots, color in ((t2, colors[0]), (t1, colors[1])):
            times = [t for t, _ in knots] + [36]
            top.step(times, [s for _, s in knots] + [knots[-1][1]], where="post", color=color, lw=2.0)
        top.set_xlim(0, 36); top.set_ylim(0, 1.05); top.set_xticks(range(0, 37, 6)); top.set_yticks(np.arange(0, 1.01, 0.2))
        top.set_ylabel("Survival")
        bottom.set_xlim(0, 36); bottom.set_ylim(0, 1); bottom.set_xticks(range(0, 37, 6)); bottom.set_yticks([0.25, 0.75])
        bottom.set_yticklabels(["Active", "Placebo"])
        for index, value in enumerate(range(0, 37, 6)):
            bottom.text(value, 0.25, str(160 - 10 * index), ha="center", va="center", fontsize=8)
            bottom.text(value, 0.75, str(160 - 12 * index), ha="center", va="center", fontsize=8)
        bottom.set_xlabel("Months")
        fig.tight_layout()
        fig.canvas.draw()
        box = top.get_window_extent()
        width, height = fig.canvas.get_width_height()
        area = {"left": float(box.x0), "top": float(height - box.y1), "right": float(box.x1), "bottom": float(height - box.y0)}
        name = "km_two_panels_black" if black else "km_two_panels"
        fig.savefig(HERE / (name + ".png"), dpi=DPI)
        plt.close(fig)
        arms = [("Placebo", colors[0], t2, tc2), ("Active", colors[1], t1, tc1)]
        truth(HERE / name, arms, cal36, area, {"width": int(width), "height": int(height)})
    print("wrote", len(list(HERE.glob("*.truth.json"))), "figures")


if __name__ == "__main__":
    main()
