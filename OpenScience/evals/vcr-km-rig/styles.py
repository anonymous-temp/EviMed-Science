"""The figure styles of the Kaplan-Meier rig, and the function that draws a trial in one of them.

A style is a set of overrides on BASE. The grid changes one thing at a time from the base (so a row of the result says which
property moved the error) and then a few things together the way real journals do. Every figure is drawn from the SAMPLE curve of a
simulated trial, so the drawn staircase, the censoring marks and the numbers at risk are exact.
"""

from __future__ import annotations

import io
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

BLUE, RED, GREEN = "#1f77b4", "#d62728", "#2ca02c"

BASE = {
    "colors": (BLUE, RED, GREEN),   # control, treatment A, treatment B
    "lw": 1.5,
    "grid": None,                   # None | "light" | "dark"
    "risk": None,                   # None | "text" (numbers under the plot) | "axes" (a panel of its own with axis, labels, frame)
    "censor": "|",                  # None | "|" | "+"
    "censorSize": 6,
    "linestyles": ("-", "-", "-"),
    "arms": 2,
    "yscale": "fraction",           # "fraction" | "percent"
    "dpi": 150,
    "format": "png",                # "png" | "jpeg"
    "jpegQuality": 75,
    "spines": "L",                  # "L" (left and bottom only) | "box"
    "pad": False,                   # axes run past the first and last tick, as ggplot's expansion does
    "ticks": "out",                 # "out" | "in"
    "band": False,                  # a shaded 95% band round each curve
    "legend": True,
    "figsize": (6.4, 4.8),
}

# (name, group, overrides, what it stands for)
STYLES = [
    ("base", "base", {}, "两条曲线蓝/红，线宽 1.5，无网格，无风险表，竖线删失标记，实线，分数坐标，150 dpi，PNG，L 形坐标轴"),
    # line width
    ("lw_1.0", "线宽", {"lw": 1.0}, "线宽 1.0"),
    ("lw_2.5", "线宽", {"lw": 2.5}, "线宽 2.5"),
    ("lw_4.0", "线宽", {"lw": 4.0, "censorSize": 8}, "线宽 4.0"),
    # colour
    ("col_green_purple", "颜色", {"colors": ("#2ca02c", "#9467bd", "#ff7f0e")}, "绿/紫"),
    ("col_orange_teal", "颜色", {"colors": ("#ff7f0e", "#17becf", "#8c564b")}, "橙/青"),
    ("col_black_grey", "颜色", {"colors": ("#000000", "#808080", "#b0b0b0")}, "黑/灰（黑白印刷）"),
    ("col_black_dashed", "颜色", {"colors": ("#000000", "#000000", "#000000"), "linestyles": ("-", "--", ":")},
     "两条都是黑色，一实一虚（黑白印刷常见）"),
    # grid
    ("grid_light", "网格", {"grid": "light"}, "浅灰网格"),
    ("grid_dark", "网格", {"grid": "dark"}, "深灰网格"),
    # risk table
    ("risk_text", "风险表", {"risk": "text", "figsize": (6.4, 5.6)}, "图下方一行行数字（无独立坐标轴）"),
    ("risk_axes", "风险表", {"risk": "axes", "figsize": (6.4, 5.8)}, "图下方有自己的坐标轴和边框的风险表面板"),
    # censoring marks
    ("cens_none", "删失标记", {"censor": None}, "没有删失标记"),
    ("cens_plus", "删失标记", {"censor": "+"}, "十字删失标记"),
    ("cens_big", "删失标记", {"censor": "|", "censorSize": 11}, "大号竖线删失标记"),
    # line styles
    ("dash_treat", "线型", {"linestyles": ("-", "--", "-")}, "第二条曲线虚线（颜色不同）"),
    ("dash_dotted", "线型", {"linestyles": ("-", ":", "-.")}, "点线 / 点划线（颜色不同）"),
    # number of arms
    ("arms_1", "组数", {"arms": 1}, "只有一条曲线"),
    ("arms_3", "组数", {"arms": 3}, "三条曲线（按两两对照组分别数字化）"),
    # axis scale
    ("y_percent", "纵轴", {"yscale": "percent"}, "纵轴为百分数 0–100"),
    # resolution and format
    ("dpi_72", "分辨率与格式", {"dpi": 72}, "72 dpi（网页截图）"),
    ("dpi_100", "分辨率与格式", {"dpi": 100}, "100 dpi"),
    ("dpi_300", "分辨率与格式", {"dpi": 300}, "300 dpi（印刷）"),
    ("jpeg_q75", "分辨率与格式", {"format": "jpeg", "jpegQuality": 75}, "JPEG，质量 75"),
    ("jpeg_q40", "分辨率与格式", {"format": "jpeg", "jpegQuality": 40, "dpi": 100}, "JPEG，质量 40，100 dpi（压得很狠的网页图）"),
    # axes
    ("box_axes", "坐标轴", {"spines": "box"}, "四边封闭的坐标框"),
    ("axes_padded", "坐标轴", {"pad": True}, "坐标轴比首末刻度各长出一截（ggplot 风格）"),
    ("ticks_in", "坐标轴", {"ticks": "in"}, "刻度朝内"),
    ("ticks_in_padded", "坐标轴", {"ticks": "in", "pad": True}, "刻度朝内且坐标轴长出一截"),
    # shaded band
    ("ci_band", "置信带", {"band": True}, "曲线外有 95% 置信带阴影"),
    # combinations
    ("combo_journal", "组合", {"colors": ("#000000", "#808080", "#b0b0b0"), "lw": 1.0, "grid": None, "risk": "text", "figsize": (6.4, 5.6),
                               "censor": "+", "dpi": 300, "spines": "box", "linestyles": ("-", "-", "-")},
     "黑白期刊：黑/灰，细线，十字删失，风险表，300 dpi，坐标框"),
    ("combo_web", "组合", {"dpi": 72, "format": "jpeg", "jpegQuality": 60, "grid": "light", "lw": 2.5, "colors": ("#2ca02c", "#9467bd", "#ff7f0e")},
     "网页图：绿/紫，粗线，网格，72 dpi，JPEG 质量 60"),
    ("combo_survminer", "组合", {"risk": "axes", "figsize": (6.4, 5.8), "pad": True, "grid": "light", "censor": "+", "lw": 1.2,
                                 "colors": ("#e7b800", "#2e9fdf", "#fc4e07")},
     "survminer 风格：黄/蓝，风险表面板，坐标轴长出一截，浅网格，十字删失"),
]

STYLE_BY_NAME = {name: {**BASE, **overrides} for name, _, overrides, _ in STYLES}
STYLE_GROUP = {name: group for name, group, _, _ in STYLES}
STYLE_NOTE = {name: note for name, _, _, note in STYLES}


def km_steps(arm: dict):
    """The staircase a plotting library draws: starts at (0, 1), ends at the last observation, flat after the last event."""
    time = [0.0] + list(arm["km"]["time"])
    surv = [1.0] + list(arm["km"]["surv"])
    end = float(arm["lastTime"])
    if end > time[-1]:
        time.append(end)
        surv.append(surv[-1])
    return np.asarray(time), np.asarray(surv)


def survival_at(arm: dict, t: np.ndarray) -> np.ndarray:
    times = np.asarray(arm["km"]["time"], dtype=float)
    surv = np.asarray(arm["km"]["surv"], dtype=float)
    out = np.ones(len(t))
    for i, x in enumerate(np.asarray(t, dtype=float)):
        j = np.searchsorted(times, x, side="right") - 1
        out[i] = surv[j] if j >= 0 else 1.0
    return out


def greenwood_band(arm: dict):
    """Pointwise 95% band (linear), at the event times."""
    km = arm["km"]
    n, d, s = np.asarray(km["atRisk"], float), np.asarray(km["events"], float), np.asarray(km["surv"], float)
    with np.errstate(divide="ignore", invalid="ignore"):
        term = np.where(n - d > 0, d / (n * (n - d)), 0.0)
    se = s * np.sqrt(np.cumsum(term))
    return np.concatenate(([1.0], np.clip(s - 1.96 * se, 0, 1))), np.concatenate(([1.0], np.clip(s + 1.96 * se, 0, 1)))


def draw(trial: dict, style: dict, path: Path) -> dict:
    """Draw the trial in the style. Returns what the stated calibration is (the values at the first and last tick of each axis)."""
    arms = trial["arms"][:style["arms"]]
    scale = 100.0 if style["yscale"] == "percent" else 1.0
    tmax, tick = float(trial["tmax"]), float(trial["tick"])
    ticks = np.arange(0, tmax + 1e-9, tick)
    with_risk = style["risk"] is not None
    fig = plt.figure(figsize=style["figsize"], dpi=style["dpi"])
    if with_risk:
        grid = fig.add_gridspec(2, 1, height_ratios=(4, 1 if style["risk"] == "text" else 1.15), hspace=0.32 if style["risk"] == "axes" else 0.28,
                                left=0.19, right=0.96, top=0.96, bottom=0.11)
        ax = fig.add_subplot(grid[0])
        rax = fig.add_subplot(grid[1])
    else:
        ax = fig.add_subplot(111)
        fig.subplots_adjust(left=0.13, right=0.96, top=0.96, bottom=0.14)
        rax = None

    for index, arm in enumerate(arms):
        color, ls = style["colors"][index], style["linestyles"][index]
        t, s = km_steps(arm)
        if style["band"]:
            lo, hi = greenwood_band(arm)
            end = float(arm["lastTime"])
            tt = np.concatenate((t[:len(lo)], [end])) if len(t) > len(lo) else t[:len(lo)]
            lo2 = np.concatenate((lo, [lo[-1]])) if len(tt) > len(lo) else lo
            hi2 = np.concatenate((hi, [hi[-1]])) if len(tt) > len(hi) else hi
            ax.fill_between(tt, lo2 * scale, hi2 * scale, step="post", color=color, alpha=0.18, linewidth=0)
        ax.step(t, s * scale, where="post", color=color, lw=style["lw"], ls=ls, label=arm["name"])
        if style["censor"]:
            ct = np.asarray([x for x, e in zip(arm["time"], arm["status"]) if e == 0], dtype=float)
            ct = ct[ct < float(arm["lastTime"]) - 1e-9]
            if len(ct):
                ax.plot(ct, survival_at(arm, ct) * scale, ls="", marker=style["censor"], ms=style["censorSize"], mew=1.0, color=color)

    if style["pad"]:
        ax.set_xlim(-0.05 * tmax, 1.05 * tmax)
        ax.set_ylim(-0.05 * scale, 1.05 * scale)
    else:
        ax.set_xlim(0, tmax)
        ax.set_ylim(0, 1.0 * scale)
    ax.set_xticks(ticks)
    yticks = np.arange(0, 1.0001, 0.2) * scale
    ax.set_yticks(yticks)
    if style["yscale"] == "percent":
        ax.set_yticklabels(["%d" % round(v) for v in yticks])
        ax.set_ylabel("Overall survival (%)")
    else:
        ax.set_yticklabels(["%.1f" % v for v in yticks])
        ax.set_ylabel("Probability of survival")
    if not with_risk:
        ax.set_xlabel("Time (months)")
    ax.tick_params(direction=style["ticks"], length=4.5, width=0.9)
    if style["spines"] == "L":
        ax.spines["top"].set_visible(False)
        ax.spines["right"].set_visible(False)
    if style["grid"] == "light":
        ax.grid(True, color="#dddddd", lw=0.6)
        ax.set_axisbelow(True)
    elif style["grid"] == "dark":
        ax.grid(True, color="#888888", lw=0.8)
        ax.set_axisbelow(True)
    if style["legend"]:
        ax.legend(loc="upper right", frameon=False)

    if rax is not None:
        times = trial["riskTimes"]
        if style["risk"] == "text":
            rax.set_xlim(ax.get_xlim())
            rax.set_ylim(-0.5, len(arms) - 0.5)
            for k, arm in enumerate(arms):
                for t0, n0 in zip(times, arm["atRisk"]):
                    rax.text(t0, len(arms) - 1 - k, "%d" % n0, ha="center", va="center", fontsize=8, color=style["colors"][k])
                rax.text(-0.035, len(arms) - 1 - k, arm["name"], ha="right", va="center", fontsize=8, color=style["colors"][k], transform=rax.get_yaxis_transform())
            for side in ("top", "right", "left", "bottom"):
                rax.spines[side].set_visible(False)
            rax.set_yticks([])
            rax.set_xticks([])
            ax.set_xlabel("Time (months)")
        else:
            rax.set_xlim(ax.get_xlim())
            rax.set_ylim(-0.5, len(arms) - 0.5)
            rax.set_yticks(range(len(arms)))
            rax.set_yticklabels([arm["name"] for arm in reversed(arms)], fontsize=8)
            rax.set_xticks(ticks)
            rax.tick_params(direction=style["ticks"], length=3)
            for k, arm in enumerate(arms):
                for t0, n0 in zip(times, arm["atRisk"]):
                    rax.text(t0, len(arms) - 1 - k, "%d" % n0, ha="center", va="center", fontsize=8, color=style["colors"][k])
            rax.set_xlabel("Time (months)")
            ax.set_xlabel("")
            if style["spines"] == "L":
                rax.spines["top"].set_visible(False)
                rax.spines["right"].set_visible(False)

    fig.canvas.draw()
    # where the axes really are, for the caller's records only (the digitizer is never told)
    box = ax.get_window_extent()
    info = {"calibration": {"x": {"min": 0.0, "max": tmax, "unit": "months"},
                            "y": {"min": 0.0, "max": 1.0 * scale, "scale": style["yscale"]}},
            "axesPixels": [round(box.x0), round(box.y0), round(box.x1), round(box.y1)]}
    buffer = io.BytesIO()
    fig.savefig(buffer, format="png", dpi=style["dpi"])
    plt.close(fig)
    image = Image.open(io.BytesIO(buffer.getvalue())).convert("RGB")
    if style["format"] == "jpeg":
        image.save(path, format="JPEG", quality=int(style["jpegQuality"]))
    else:
        image.save(path, format="PNG")
    info["size"] = list(image.size)
    return info
