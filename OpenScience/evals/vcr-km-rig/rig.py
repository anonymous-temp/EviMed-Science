#!/usr/bin/env python3
"""Kaplan-Meier figure rig: how far off is a digitized and reconstructed curve, for each style of figure?

    python3 rig.py --work /tmp/vcr-km-rig [--out results.json] [--only base,risk_axes] [--jobs 2] [--fresh]

Pipeline (every stage keeps its files under --work and is skipped when its output exists, so an interrupted run resumes):

1. ``truth.R`` simulates five trials of three arms with the engine's own generator; the sample curve, median, event count, numbers
   at risk and Cox log hazard ratio of each arm are the truth.
2. ``styles.py`` draws each trial in each style (matplotlib); the stated calibration is the value at the first and last tick of each
   axis, as a run would state it from the axis labels.
3. ``vcr_curve_digitize.py`` runs on the picture through its container entry (``main``: request.json, input dir, output dir), with
   the request the control plane builds (``vcrCurveDigitizer.mjs``: the calibration, the curves by colour, the pixel limit). The
   control plane's own check of the answer (``checkDigitization``) is applied too. A ``plot_area_ambiguous`` refusal lists the
   candidate boxes; the rig then does what a run does and states the largest one as ``plotArea`` (counted as a retry).
4. The engine's ``evidence.reconstruct_km`` job (method 1.1.0) runs on the digitized curves at the four information levels, through
   ``batch_jobs.R`` (the engine's ``vcr_read_job`` / ``vcr_run_job`` of ``service/run_job.R`` with the engine loaded once; the rig
   checks on a sample that ``run_job.R`` writes the same result and the same pseudo-patient table, the run's clock aside).
5. The result is scored against the truth and aggregated per style and level.

What the model never does here: every number comes from the simulator, the digitizer or the engine; the rig only subtracts.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import shutil
import subprocess
import sys
import time
from multiprocessing import Pool
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]                                    # OpenScience/
DIGITIZER_DIR = REPO / "runtime" / "mcp" / "evimed-research"
ENGINE = Path(os.environ.get("VCR_ENGINE_ROOT") or REPO.parent / "项目代码" / "vcr-engine")
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(DIGITIZER_DIR))

import styles as styles_module  # noqa: E402
import vcr_curve_digitize as digitizer  # noqa: E402

# (a risk table printed, the total number of events printed): the engine's four information levels
LEVELS = {1: (True, True), 2: (True, False), 3: (False, True), 4: (False, False)}
LEVEL_KEYS = {1: "risk_table_and_events", 2: "risk_table", 3: "events_only", 4: "curve_only"}
# the calibration variants: the value stated for the last tick of an axis is wrong by 10%
WRONG = {"x110": ("x", 1.1), "x90": ("x", 0.9), "y110": ("y", 1.1), "y90": ("y", 0.9)}
WRONG_STYLES = ("base", "ticks_in", "axes_padded")
TOOL = "EviMed curve digitizer"


# ---------------------------------------------------------------------------
# truth
# ---------------------------------------------------------------------------


def run(cmd, **kw):
    return subprocess.run(cmd, check=True, capture_output=True, text=True, **kw)


def ensure_truth(work: Path) -> list:
    path = work / "trials.json"
    if not path.exists():
        run(["Rscript", str(HERE / "truth.R"), str(path)], cwd=str(work))
    return json.loads(path.read_text(encoding="utf-8"))


def km_curve(time_, status):
    """Kaplan-Meier from rows: event times and survival after each."""
    time_ = np.asarray(time_, float)
    status = np.asarray(status, int)
    order = np.argsort(time_, kind="stable")
    time_, status = time_[order], status[order]
    events = np.unique(time_[status == 1])
    if not len(events):
        return np.array([]), np.array([])
    at_risk = len(time_) - np.searchsorted(time_, events, side="left")
    died = np.array([np.sum((time_ == t) & (status == 1)) for t in events])
    return events, np.cumprod(1 - died / at_risk)


def step_at(times, surv, grid):
    times, surv = np.asarray(times, float), np.asarray(surv, float)
    index = np.searchsorted(times, grid, side="right") - 1
    return np.where(index >= 0, surv[np.clip(index, 0, None)], 1.0)


def check_truth(trials):
    """The python Kaplan-Meier agrees with the engine's on the simulated rows (so the scoring uses a verified one)."""
    worst = 0.0
    for trial in trials:
        for arm in trial["arms"]:
            t, s = km_curve(arm["time"], arm["status"])
            worst = max(worst, float(np.max(np.abs(s - np.asarray(arm["km"]["surv"])))), float(np.max(np.abs(t - np.asarray(arm["km"]["time"])))))
    if worst > 1e-9:
        raise SystemExit("python Kaplan-Meier disagrees with the engine's on the simulated rows: %g" % worst)
    return worst


def truth_on(arm, grid):
    return step_at(arm["km"]["time"], arm["km"]["surv"], grid)


def curve_rmse(times, surv, arm, last_time):
    """RMSE of a step curve against the arm's true sample curve over [0, last_time]."""
    grid = np.linspace(0.0, last_time, 721)
    return float(math.sqrt(np.mean((step_at(times, surv, grid) - truth_on(arm, grid)) ** 2)))


# ---------------------------------------------------------------------------
# digitization of one cell (style x trial x calibration variant)
# ---------------------------------------------------------------------------


def accepted_by_control_plane(curve_points) -> bool:
    """The check `checkDigitization` applies to every returned curve (shape, order, range)."""
    if not 3 <= len(curve_points) <= 2000:
        return False
    time_, surv = -math.inf, math.inf
    for point in curve_points:
        t, s = point["time"], point["surv"]
        if not (math.isfinite(t) and math.isfinite(s)) or t < time_ or s > surv or s <= 0 or s > 1 or t < 0:
            return False
        time_, surv = t, s
    return True


def call_digitizer(work: Path, figure: Path, calibration, colors, names, key: str, plot_area=None):
    request = {"file": {"name": figure.name, "sha256": hashlib.sha256(figure.read_bytes()).hexdigest()}, "calibration": calibration, "plotArea": plot_area,
               "curves": [{"name": name, "color": color} for name, color in zip(names, colors)], "limits": {"maxPixels": 24_000_000}}
    scratch = work / "scratch" / key
    scratch.mkdir(parents=True, exist_ok=True)
    (scratch / "request.json").write_text(json.dumps(request), encoding="utf-8")
    started = time.time()
    digitizer.main(["--request", str(scratch / "request.json"), "--input-dir", str(figure.parent), "--output-dir", str(scratch)])
    result = json.loads((scratch / "result.json").read_text(encoding="utf-8"))
    shutil.rmtree(scratch, ignore_errors=True)
    result["_seconds"] = round(time.time() - started, 3)
    return result


def digitize_cell(spec):
    work, style_name, trial_index, variant = spec
    work = Path(work)
    key = "%s__%s__%s" % (style_name, variant, trial_index)
    cache = work / "digit" / (key + ".json")
    if cache.exists():
        return json.loads(cache.read_text(encoding="utf-8"))
    trial = json.loads((work / "trials.json").read_text(encoding="utf-8"))[trial_index]
    style = styles_module.STYLE_BY_NAME[style_name]
    figures = work / "figs"
    figures.mkdir(parents=True, exist_ok=True)
    figure = figures / ("%s__%s.%s" % (style_name, trial["id"], "jpg" if style["format"] == "jpeg" else "png"))
    info = styles_module.draw(trial, style, figure)
    calibration = json.loads(json.dumps(info["calibration"]))
    if variant != "exact":
        axis, factor = WRONG[variant]
        calibration[axis]["max"] = calibration[axis]["max"] * factor
    arms = style["arms"]
    pairs = [(0,)] if arms == 1 else ([(0, 1)] if arms == 2 else [(0, 1), (0, 2)])
    cell = {"style": style_name, "variant": variant, "trial": trial["id"], "figure": {"size": info["size"], "bytes": figure.stat().st_size}, "pairs": []}
    for pair in pairs:
        names = [trial["arms"][i]["name"] for i in pair]
        colors = [style["colors"][i] for i in pair]
        first = call_digitizer(work, figure, calibration, colors, names, key + "_" + "".join(map(str, pair)))
        outcome, retried, used = first, False, first
        if first["outcome"] == "refused" and first.get("reason") == "plot_area_ambiguous":
            boxes = (first.get("detail") or {}).get("candidates") or []
            if boxes:
                biggest = max(boxes, key=lambda b: (b["right"] - b["left"]) * (b["bottom"] - b["top"]))
                area = {k: float(biggest[k]) for k in ("left", "top", "right", "bottom")}
                used = call_digitizer(work, figure, calibration, colors, names, key + "_" + "".join(map(str, pair)) + "r", plot_area=area)
                retried = True
        entry = {"pair": list(pair), "firstPass": {"outcome": first["outcome"], "reason": first.get("reason"), "seconds": first["_seconds"]},
                 "retried": retried, "outcome": used["outcome"], "reason": used.get("reason"), "warnings": used.get("warnings", []),
                 "anchor": used.get("anchor"), "accepted": False, "curves": []}
        if used["outcome"] == "digitized":
            entry["accepted"] = all(accepted_by_control_plane(curve["points"]) for curve in used["curves"])
            for index, curve in zip(pair, used["curves"]):
                points = curve["points"]
                last = min(points[-1]["time"], trial["arms"][index]["lastTime"])
                entry["curves"].append({
                    "arm": index, "points": [{"time": p["time"], "surv": p["surv"]} for p in points], "lastTime": points[-1]["time"],
                    "rmse": curve_rmse([p["time"] for p in points], [p["surv"] for p in points], trial["arms"][index], last),
                    "quality": {k: curve["quality"].get(k) for k in ("monotonicityRepairs", "startSurvival", "xCoverage")}})
        cell["pairs"].append(entry)
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(cell), encoding="utf-8")
    return cell


# ---------------------------------------------------------------------------
# reconstruction jobs
# ---------------------------------------------------------------------------


def build_job(trial, pair, curves, level, version, job_id):
    def one(index, points):
        arm = trial["arms"][index]
        table, events = LEVELS[level]
        scenario = {"curve": points}
        if table:
            scenario["riskTable"] = [{"time": t, "atRisk": n} for t, n in zip(trial["riskTimes"], arm["atRisk"])]
        else:
            scenario["initialAtRisk"] = arm["n"]
        if events:
            scenario["totalEvents"] = arm["events"]
        return scenario
    scenario = one(pair[0], curves[0]["points"])
    if len(pair) == 2:
        scenario["treatmentArm"] = one(pair[1], curves[1]["points"])
    scenario["provenance"] = {"kind": "digitizer", "tool": TOOL, "toolVersion": version}
    return {"jobId": job_id, "studyId": "std_rig", "kind": "reconstruct_km", "method": "evidence.reconstruct_km", "methodVersion": "1.1.0",
            "protocolVersion": 1, "scenario": scenario, "inputs": [{"kind": "evidence", "id": "ev_rig@1"}], "seed": 1, "cpuSecondsLimit": 600, "cores": 1}


def write_jobs(work: Path, cells):
    jobs = []
    folder = work / "jobs"
    folder.mkdir(exist_ok=True)
    trials = {t["id"]: t for t in json.loads((work / "trials.json").read_text(encoding="utf-8"))}
    version = digitizer.VERSION
    for cell in cells:
        for entry in cell["pairs"]:
            if entry["outcome"] != "digitized" or not entry["accepted"]:
                continue
            for level in LEVELS:
                name = "%s__%s__%s__%s__L%d" % (cell["style"], cell["variant"], cell["trial"], "".join(map(str, entry["pair"])), level)
                path = folder / (name + ".json")
                if not (folder / (name + ".out") / "result.json").exists():
                    path.write_text(json.dumps(build_job(trials[cell["trial"]], entry["pair"], entry["curves"], level, version, "job_" + name)), encoding="utf-8")
                    jobs.append(path)
    return jobs


def run_batches(jobs, workers: int):
    if not jobs:
        return
    chunks = [jobs[i::workers] for i in range(workers)]
    processes = []
    for number, chunk in enumerate(chunks):
        if not chunk:
            continue
        listing = jobs[0].parent / ("list_%d.txt" % number)
        listing.write_text("\n".join(str(p) for p in chunk) + "\n", encoding="utf-8")
        processes.append(subprocess.Popen(["Rscript", str(HERE / "batch_jobs.R"), str(listing)], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True))
    for process in processes:
        out, _ = process.communicate()
        if process.returncode != 0:
            raise SystemExit("batch_jobs.R failed:\n" + out[-2000:])


def without_clock(value):
    """A result minus the three fields that are the clock of the run (when it started and finished, the CPU it took)."""
    if isinstance(value, dict):
        return {k: without_clock(v) for k, v in value.items() if k not in ("startedAt", "finishedAt", "cpuSeconds")}
    if isinstance(value, list):
        return [without_clock(v) for v in value]
    return value


def check_entry_equivalence(work: Path):
    """The batch runner writes the same result as the engine's own service entry (run_job.R) on one job per level, the clock aside."""
    folder = work / "jobs"
    checked = []
    for level in LEVELS:
        job = next(iter(sorted(folder.glob("base__exact__T1__01__L%d.json" % level))), None)
        if job is None:
            continue
        out = work / "equiv" / ("L%d" % level)
        shutil.rmtree(out, ignore_errors=True)
        run(["Rscript", str(ENGINE / "service" / "run_job.R"), str(job), str(out)])
        mine = json.loads((folder / (job.stem + ".out") / "result.json").read_text(encoding="utf-8"))
        theirs = json.loads((out / "result.json").read_text(encoding="utf-8"))
        checked.append(without_clock(mine) == without_clock(theirs) and (out / "reconstructed-ipd.csv").read_bytes() == (folder / (job.stem + ".out") / "reconstructed-ipd.csv").read_bytes())
    return checked


# ---------------------------------------------------------------------------
# scoring
# ---------------------------------------------------------------------------


def read_ipd(path: Path):
    with path.open(encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    return {"time": np.array([float(r["time"]) for r in rows]), "status": np.array([int(float(r["status"])) for r in rows]),
            "arm": np.array([int(float(r["arm"])) for r in rows])}


def score_job(trial, entry, level, out_dir: Path):
    result = json.loads((out_dir / "result.json").read_text(encoding="utf-8"))
    record = {"level": level, "status": result.get("status")}
    if result.get("status") == "failed":
        record["issues"] = [i.get("code") for i in (result.get("diagnostics") or {}).get("issues", [])][:4]
        return record
    if result.get("status") != "succeeded":
        qc = (result.get("diagnostics") or {}).get("qualityControl")
        qc = qc if isinstance(qc, list) else [qc]
        record["qcFailed"] = sorted({str(q.get("detail")) for q in qc if isinstance(q, dict) and q.get("detail")})
        return record
    measures = {m["name"]: m["value"] for m in result["measures"]}
    ipd = read_ipd(out_dir / "reconstructed-ipd.csv")
    pair = entry["pair"]
    record.update({"median": [], "rmse": [], "atRisk": [], "events": []})
    for position, index in enumerate(pair):
        arm = trial["arms"][index]
        rows = ipd["arm"] == position
        t, s = km_curve(ipd["time"][rows], ipd["status"][rows])
        truth_last = arm["lastTime"]
        digitized_last = entry["curves"][position]["lastTime"]
        last = min(truth_last, digitized_last)
        grid = np.linspace(0.0, last, 721)
        record["rmse"].append(float(math.sqrt(np.mean((step_at(t, s, grid) - truth_on(arm, grid)) ** 2))))
        name = "median_survival" if len(pair) == 1 else "median_survival_" + ("control" if position == 0 else "treatment")
        if arm["median"] is not None and name in measures:
            record["median"].append({"abs": measures[name] - arm["median"], "rel": (measures[name] - arm["median"]) / arm["median"]})
        elif arm["median"] is not None:
            record["median"].append({"abs": None, "rel": None, "notReached": True})
        counts = [int(np.sum(ipd["time"][rows] >= t0)) for t0 in trial["riskTimes"]]
        diffs = [abs(c - n) for c, n, t0 in zip(counts, arm["atRisk"], trial["riskTimes"]) if t0 > 0]
        record["atRisk"].append({"mae": float(np.mean(diffs)) if diffs else 0.0, "maePct": float(np.mean(diffs)) / arm["n"] * 100 if diffs else 0.0,
                                 "max": float(max(diffs)) if diffs else 0.0})
        record["events"].append(abs(int(np.sum(ipd["status"][rows])) - arm["events"]) / arm["events"])
    if len(pair) == 2 and "log_hazard_ratio" in measures:
        truth = trial["logHR"][pair[1] - 1]["sample"]
        record["logHR"] = {"err": measures["log_hazard_ratio"] - truth, "estimable": True}
    elif len(pair) == 2:
        record["logHR"] = {"err": None, "estimable": False}
    return record


def mean(values):
    values = [v for v in values if v is not None and math.isfinite(v)]
    return float(np.mean(values)) if values else None


def median_of(values):
    values = [v for v in values if v is not None and math.isfinite(v)]
    return float(np.median(values)) if values else None


def r(value, digits=4):
    return None if value is None else round(float(value), digits)


def summarize(cells, scores):
    """Aggregate per (style, variant): the digitizer's side, then each information level."""
    by_cell = {}
    for cell in cells:
        by_cell.setdefault((cell["style"], cell["variant"]), []).append(cell)
    rows = []
    for (style, variant), group in by_cell.items():
        entries = [(cell, entry) for cell in group for entry in cell["pairs"]]
        refused_first = [(c, e) for c, e in entries if e["firstPass"]["outcome"] == "refused"]
        reasons = {}
        for _, e in refused_first:
            reasons[e["firstPass"]["reason"]] = reasons.get(e["firstPass"]["reason"], 0) + 1
        final_refused = [(c, e) for c, e in entries if e["outcome"] == "refused"]
        final_reasons = {}
        for _, e in final_refused:
            final_reasons[e["reason"]] = final_reasons.get(e["reason"], 0) + 1
        digitized = [(c, e) for c, e in entries if e["outcome"] == "digitized"]
        warning_kinds = {}
        for _, e in digitized:
            for w in e["warnings"]:
                kind = w.split(":")[0]
                warning_kinds[kind] = warning_kinds.get(kind, 0) + 1
        rmses = [curve["rmse"] for _, e in digitized for curve in e["curves"]]
        row = {"style": style, "variant": variant, "group": styles_module.STYLE_GROUP[style],
               "digitizer": {"attempts": len(entries), "refusedFirstPass": len(refused_first), "refusalReasonsFirstPass": reasons,
                             "retriedWithPlotArea": sum(1 for _, e in entries if e["retried"]), "refusedAfterRetry": len(final_refused),
                             "refusalReasonsFinal": final_reasons, "rejectedByControlPlane": sum(1 for _, e in digitized if not e["accepted"]),
                             "warnings": warning_kinds, "curves": len(rmses), "rmse": r(mean(rmses)), "rmseMedian": r(median_of(rmses)), "rmseMax": r(max(rmses) if rmses else None),
                             "anchorPlotArea": sum(1 for _, e in digitized if e["anchor"] == "plot_area"),
                             "seconds": r(mean([e["firstPass"]["seconds"] for _, e in entries]), 2)},
               "levels": {}}
        for level in LEVELS:
            items = [s for cell, entry in digitized if entry["accepted"] for s in [scores.get((style, variant, cell["trial"], tuple(entry["pair"]), level))] if s]
            ok = [s for s in items if s["status"] == "succeeded"]
            qc = [s for s in items if s["status"] == "not_estimable"]
            failed = [s for s in items if s["status"] == "failed"]
            med_rel = [abs(m["rel"]) for s in ok for m in s["median"] if m.get("rel") is not None]
            med_signed = [m["rel"] for s in ok for m in s["median"] if m.get("rel") is not None]
            med_abs = [abs(m["abs"]) for s in ok for m in s["median"] if m.get("abs") is not None]
            hr = [abs(s["logHR"]["err"]) for s in ok if s.get("logHR", {}).get("err") is not None]
            hr_signed = [s["logHR"]["err"] for s in ok if s.get("logHR", {}).get("err") is not None]
            qc_reasons = {}
            for s in qc:
                for reason in s.get("qcFailed", []):
                    qc_reasons[reason] = qc_reasons.get(reason, 0) + 1
            row["levels"][str(level)] = {
                "key": LEVEL_KEYS[level], "jobs": len(items), "succeeded": len(ok), "qcFailed": len(qc), "failed": len(failed), "qcFailedChecks": qc_reasons,
                "curveRmse": r(mean([v for s in ok for v in s["rmse"]])), "medianRelErr": r(mean(med_rel)), "medianRelErrBias": r(mean(med_signed)),
                "medianAbsErrMonths": r(mean(med_abs), 3), "medianNotReached": sum(1 for s in ok for m in s["median"] if m.get("notReached")),
                "logHrAbsErr": r(mean(hr)), "logHrBias": r(mean(hr_signed)), "logHrWorst": r(max(hr) if hr else None), "logHrNotEstimable": sum(1 for s in ok if s.get("logHR") and not s["logHR"]["estimable"]),
                "atRiskMaePatients": r(mean([a["mae"] for s in ok for a in s["atRisk"]]), 2), "atRiskMaePct": r(mean([a["maePct"] for s in ok for a in s["atRisk"]]), 2),
                "atRiskMaxPatients": r(max([a["max"] for s in ok for a in s["atRisk"]] or [None]), 1), "eventsRelErr": r(mean([v for s in ok for v in s["events"]]))}
        rows.append(row)
    return rows


def pooled(rows, predicate):
    """Across the styles chosen, per level: the mean, the median and the worst of the per-style figures."""
    chosen = [row for row in rows if predicate(row)]
    out = {}
    for level in LEVELS:
        cells = [row["levels"][str(level)] for row in chosen]
        entry = {"key": LEVEL_KEYS[level], "styles": len(cells), "jobs": sum(c["jobs"] for c in cells), "qcFailed": sum(c["qcFailed"] for c in cells)}
        for field, digits in (("curveRmse", 4), ("medianRelErr", 4), ("logHrAbsErr", 4), ("atRiskMaePct", 2)):
            values = [c[field] for c in cells if c[field] is not None]
            entry[field] = {"mean": r(mean(values), digits), "median": r(median_of(values), digits), "worst": r(max(values) if values else None, digits)}
        out[str(level)] = entry
    return out


def by_trial(cells, scores):
    """Per trial and level, over every figure style of the exact calibration that the digitizer read: the same errors, to show what the trial itself costs."""
    out = {}
    for (style, variant, trial, pair, level), score in scores.items():
        if variant != "exact" or score["status"] != "succeeded":
            continue
        bucket = out.setdefault(trial, {}).setdefault(str(level), {"medianRelErr": [], "logHrAbsErr": [], "curveRmse": [], "atRiskMaePct": [], "n": 0, "qcFailed": 0})
        bucket["n"] += 1
        bucket["medianRelErr"] += [abs(m["rel"]) for m in score["median"] if m.get("rel") is not None]
        bucket["curveRmse"] += score["rmse"]
        bucket["atRiskMaePct"] += [a["maePct"] for a in score["atRisk"]]
        if score.get("logHR", {}).get("err") is not None:
            bucket["logHrAbsErr"].append(abs(score["logHR"]["err"]))
    for (style, variant, trial, pair, level), score in scores.items():
        if variant == "exact" and score["status"] == "not_estimable":
            out.setdefault(trial, {}).setdefault(str(level), {"medianRelErr": [], "logHrAbsErr": [], "curveRmse": [], "atRiskMaePct": [], "n": 0, "qcFailed": 0})["qcFailed"] += 1
    return {trial: {level: {"figures": b["n"], "qcFailed": b["qcFailed"], "medianRelErr": r(mean(b["medianRelErr"])), "logHrAbsErr": r(mean(b["logHrAbsErr"])),
                            "curveRmse": r(mean(b["curveRmse"])), "atRiskMaePct": r(mean(b["atRiskMaePct"]), 2)} for level, b in sorted(levels.items())}
            for trial, levels in sorted(out.items())}


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------


def write_results(path: Path, results: dict):
    """Readable at the top, one line a row below (a style's row is its own line, so a diff of two runs reads per style)."""
    parts = []
    for key, value in results.items():
        if key in ("perStyle", "wrongCalibration", "styles"):
            rows = ",\n".join("  " + json.dumps(row, ensure_ascii=False, separators=(",", ":")) for row in value)
            parts.append(" %s: [\n%s\n ]" % (json.dumps(key), rows))
        else:
            parts.append(" %s: %s" % (json.dumps(key), json.dumps(value, ensure_ascii=False, indent=1).replace("\n", "\n ")))
    path.write_text("{\n" + ",\n".join(parts) + "\n}\n", encoding="utf-8")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--work", default="/tmp/vcr-km-rig")
    parser.add_argument("--out", default=str(HERE / "results.json"))
    parser.add_argument("--only", default="", help="comma-separated style names")
    parser.add_argument("--jobs", type=int, default=2)
    parser.add_argument("--fresh", action="store_true")
    args = parser.parse_args(argv)
    work = Path(args.work)
    if args.fresh:
        shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True, exist_ok=True)
    started = time.time()
    trials = ensure_truth(work)
    worst = check_truth(trials)
    names = [n for n in args.only.split(",") if n] or [name for name, *_ in styles_module.STYLES]
    specs = [(str(work), name, index, "exact") for name in names for index in range(len(trials))]
    specs += [(str(work), name, index, variant) for name in names if name in WRONG_STYLES for variant in WRONG for index in range(len(trials))]
    with Pool(max(1, args.jobs)) as pool:
        cells = pool.map(digitize_cell, specs, chunksize=2)
    print("digitized %d cells in %.0f s" % (len(cells), time.time() - started), flush=True)
    jobs = write_jobs(work, cells)
    run_batches(jobs, max(1, args.jobs))
    print("ran %d reconstruction jobs, %.0f s since start" % (len(jobs), time.time() - started), flush=True)
    equivalence = check_entry_equivalence(work) if "base" in names else []
    trial_by_id = {t["id"]: t for t in trials}
    scores = {}
    for cell in cells:
        for entry in cell["pairs"]:
            if entry["outcome"] != "digitized" or not entry["accepted"]:
                continue
            for level in LEVELS:
                out_dir = work / "jobs" / ("%s__%s__%s__%s__L%d.out" % (cell["style"], cell["variant"], cell["trial"], "".join(map(str, entry["pair"])), level))
                scores[(cell["style"], cell["variant"], cell["trial"], tuple(entry["pair"]), level)] = score_job(trial_by_id[cell["trial"]], entry, level, out_dir)
    rows = summarize(cells, scores)
    exact = [row for row in rows if row["variant"] == "exact"]
    results = {
        "schema": "vcr-km-rig/1",
        "digitizer": {"name": digitizer.NAME, "version": digitizer.VERSION}, "reconstruction": {"method": "evidence.reconstruct_km", "version": "1.1.0"},
        "trials": [{"id": t["id"], "label": t["label"], "n": t["n"], "axisMax": t["tmax"], "riskTimes": t["riskTimes"],
                    "medians": [r(a["median"], 2) for a in t["arms"]], "events": [a["events"] for a in t["arms"]],
                    "logHrSample": [r(l["sample"]) for l in t["logHR"]], "logHrPopulation": [r(l["population"]) for l in t["logHR"]]} for t in trials],
        "levels": {str(k): {"riskTable": v[0], "totalEvents": v[1], "key": LEVEL_KEYS[k]} for k, v in LEVELS.items()},
        "checks": {"pythonKmMatchesEngine": worst, "batchRunnerEqualsServiceEntry": equivalence},
        "pooledExact": pooled(rows, lambda row: row["variant"] == "exact" and row["digitizer"]["refusedAfterRetry"] < row["digitizer"]["attempts"]),
        "byTrial": by_trial(cells, scores),
        "styles": [{"style": name, "group": styles_module.STYLE_GROUP[name], "note": styles_module.STYLE_NOTE[name]} for name in names],
        "perStyle": exact,
        "wrongCalibration": [row for row in rows if row["variant"] != "exact"],
    }
    write_results(Path(args.out), results)
    print("wrote %s in %.0f s" % (args.out, time.time() - started))
    return 0


if __name__ == "__main__":
    sys.exit(main())
