#!/usr/bin/env python3
"""Print the README's tables from results.json (so no number in the README is typed by hand).

    python3 tables.py [results.json]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
LEVEL_NAMES = {"1": "风险表+总事件数", "2": "只有风险表", "3": "只有总事件数", "4": "只有曲线"}


def pct(value, digits=1):
    return "-" if value is None else ("%.*f%%" % (digits, 100 * value))


def num(value, digits=3):
    return "-" if value is None else ("%.*f" % (digits, value))


def pp(value):
    """A survival RMSE as percentage points."""
    return "-" if value is None else "%.2f" % (100 * value)


def main(argv):
    results = json.loads(Path(argv[1] if len(argv) > 1 else HERE / "results.json").read_text(encoding="utf-8"))
    notes = {s["style"]: s["note"] for s in results["styles"]}
    print("### 表 A：按图的样式（%d 种样式 × 5 个试验）\n" % len(results["perStyle"]))
    print("| 样式 | 说明 | 拒绝 | 数字化曲线 RMSE（百分点） | 风险表+事件数：中位数误差 / log HR 误差 | 只有风险表：中位数 / log HR | 只有事件数：中位数 / log HR | 只有曲线：中位数 |")
    print("|---|---|---|---|---|---|---|---|")
    for row in results["perStyle"]:
        d, L = row["digitizer"], row["levels"]

        def cell(level, hr=True):
            v = L[str(level)]
            if not v["jobs"]:
                return "-"
            text = pct(v["medianRelErr"]) + ((" / " + num(v["logHrAbsErr"])) if hr else "")
            if v["qcFailed"]:
                text += "（%d/%d 个被重建的质检拒绝）" % (v["qcFailed"], v["jobs"])
            return text
        refused = "%d/%d" % (d["refusedAfterRetry"], d["attempts"])
        if d["refusalReasonsFinal"]:
            refused += "（" + "、".join("%s×%d" % (k, v) for k, v in d["refusalReasonsFinal"].items()) + "）"
        print("| `%s` | %s | %s | %s | %s | %s | %s | %s |" % (row["style"], notes.get(row["style"], ""), refused, pp(d["rmse"]), cell(1), cell(2), cell(3), cell(4, hr=False)))
    print("\n### 表 B：把能读的样式合在一起（每一格是各样式的均值，括号里是中位数和最差的样式）\n")
    print("| 论文给了什么 | 重建曲线 RMSE（百分点） | 中位数相对误差 | log HR 绝对误差 | 重建的风险人数与原文的差（占该组人数） |")
    print("|---|---|---|---|---|")
    for level, v in results["pooledExact"].items():
        def trio(field, fmt):
            x = v[field]
            return "-" if x["mean"] is None else "%s（%s，%s）" % (fmt(x["mean"]), fmt(x["median"]), fmt(x["worst"]))
        hr = trio("logHrAbsErr", lambda z: "%.3f" % z) if v["logHrAbsErr"]["mean"] is not None else "不可估计"
        print("| %s | %s | %s | %s | %s |" % (LEVEL_NAMES[level], trio("curveRmse", lambda z: "%.2f" % (100 * z)), trio("medianRelErr", lambda z: "%.1f%%" % (100 * z)), hr,
                                           trio("atRiskMaePct", lambda z: "%.1f%%" % z)))
    print("\n### 表 C：按试验（所有读得出的样式合在一起）\n")
    print("| 试验 | 论文给了什么 | 图数 | 被质检拒绝 | 重建曲线 RMSE（百分点） | 中位数相对误差 | log HR 绝对误差 |")
    print("|---|---|---|---|---|---|---|")
    labels = {t["id"]: "%s（%s）" % (t["id"], t["label"]) for t in results["trials"]}
    for trial, levels in results["byTrial"].items():
        for level, v in levels.items():
            print("| %s | %s | %d | %d | %s | %s | %s |" % (labels[trial] if level == "1" else "", LEVEL_NAMES[level], v["figures"], v["qcFailed"], pp(v["curveRmse"]), pct(v["medianRelErr"]), num(v["logHrAbsErr"])))
    print("\n### 表 D：故意把声明的坐标轴写错 10%\n")
    print("| 图的样式 | 写错的是 | 数字化器自己报了什么 | 数字化曲线 RMSE（百分点） | 有风险表+事件数：重建拒绝 / 给出结果（中位数误差） | 只有事件数：给出结果（中位数误差） | 只有曲线：给出结果（中位数误差） |")
    print("|---|---|---|---|---|---|---|")
    names = {"x110": "时间轴末刻度×1.1", "x90": "时间轴末刻度×0.9", "y110": "生存率轴末刻度×1.1", "y90": "生存率轴末刻度×0.9"}
    for row in results["wrongCalibration"]:
        d, L = row["digitizer"], row["levels"]
        warned = "、".join("%s×%d" % (k, v) for k, v in d["warnings"].items() if k != "curve_start_not_one") or "没有报"
        if "curve_start_not_one" in d["warnings"]:
            warned += "、curve_start_not_one×%d" % d["warnings"]["curve_start_not_one"]

        def cell(level):
            v = L[str(level)]
            return "%d 拒绝 / %d 给出（%s）" % (v["qcFailed"], v["succeeded"], pct(v["medianRelErr"]))
        print("| `%s` | %s | %s | %s | %s | %s | %s |" % (row["style"], names[row["variant"]], warned, pp(d["rmse"]), cell(1), cell(3).split(" / ")[1], cell(4).split(" / ")[1]))


if __name__ == "__main__":
    main(sys.argv)
