"""Evaluate downloaded API artifacts against independent, evaluator-owned numeric bindings."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
from pathlib import Path
import subprocess
import xml.etree.ElementTree as ET

import pandas as pd
from scipy import stats
from PIL import Image

HERE = Path(__file__).resolve().parent
REQUIRED = {
    "paired-sleep": {"n", "estimate", "lower", "upper", "pValue"},
    "diagnostic-interpretation": {"nA", "nB", "estimate", "lower", "upper", "pValue"},
    "heart-survival": {"n", "events", "censored", "survival", "lower", "upper", "nRisk"},
    "lung-native-r": {"n", "events", "censored", "survival", "median"},
    "pbc-population": {"n", "randomized", "observational", "censored", "transplant", "death"},
    "factorial-tooth": {"n", "interactionF", "interactionP"},
}
MAX_ARTIFACT_BYTES = 50 * 1024 * 1024


def reference(case: str, scale: float = 1, conf_type: str = "log") -> dict:
    if conf_type not in {"log", "log-log", "plain"}:
        raise ValueError("Unsupported confidence interval definition")
    if case == "paired-sleep":
        frame = pd.read_csv(HERE / "fixtures/sleep.csv").pivot(index="ID", columns="group", values="extra")
        difference = frame[2] - frame[1]
        lower, upper = stats.t.interval(.95, len(difference)-1, loc=difference.mean(), scale=stats.sem(difference))
        return {"n": len(difference), "estimate": difference.mean()*scale, "lower": lower*scale,
                "upper": upper*scale, "pValue": stats.ttest_1samp(difference, 0).pvalue}
    if case == "diagnostic-interpretation":
        frame = pd.read_csv(HERE.parent / "live/fixtures/diagnostic.csv")
        a, b = (frame.loc[frame.group == group, "measurement"] for group in ["A", "B"])
        result = stats.ttest_ind(b, a, equal_var=False)
        interval = result.confidence_interval()
        return {"nA": len(a), "nB": len(b), "estimate": b.mean()-a.mean(), "lower": interval.low,
                "upper": interval.high, "pValue": result.pvalue}
    if case in ("heart-survival", "lung-native-r"):
        if case == "heart-survival":
            source, horizon = HERE / "fixtures/heart-failure.csv", 90
            preparation = "d$event<-d$DEATH_EVENT"
        else:
            source, horizon = HERE.parent / "fixtures/lung.csv", 180
            preparation = "d$event<-as.integer(d$status==2)"
        code = f'd<-read.csv("{source}");{preparation};f<-survival::survfit(survival::Surv(time,event)~1,data=d,conf.type="{conf_type}");s<-summary(f,times={horizon});cat(jsonlite::toJSON(list(n=nrow(d),events=sum(d$event),censored=sum(d$event==0),survival=s$surv,lower=s$lower,upper=s$upper,nRisk=s$n.risk,median=unname(summary(f)$table["median"])),auto_unbox=TRUE,digits=16))'
        return json.loads(subprocess.check_output(["Rscript", "--vanilla", "-e", code], text=True))
    if case == "pbc-population":
        frame = pd.read_csv(HERE / "fixtures/pbc.csv")
        return {"n": len(frame), "randomized": int(frame.trt.notna().sum()), "observational": int(frame.trt.isna().sum()),
                "censored": int((frame.status == 0).sum()), "transplant": int((frame.status == 1).sum()), "death": int((frame.status == 2).sum())}
    if case == "factorial-tooth":
        code = 'd<-datasets::ToothGrowth;d$dose<-factor(d$dose);a<-anova(lm(len~dose*supp,d));cat(jsonlite::toJSON(list(n=nrow(d),interactionF=a[3,"F value"],interactionP=a[3,"Pr(>F)"]),auto_unbox=TRUE,digits=16))'
        return json.loads(subprocess.check_output(["Rscript", "--vanilla", "-e", code], text=True))
    raise ValueError("Unknown reference case")


def get_value(document, pointer):
    value = document
    for component in pointer:
        value = value[component]
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError("Binding is not a finite number")
    return float(value)


def judge(directory: Path, bindings: dict) -> dict:
    turns = bindings.get("turns")
    if bindings.get("case") not in REQUIRED or not isinstance(turns, list) or not turns:
        raise ValueError("A known case and nonempty turn list are required")
    indices = [turn.get("index") for turn in turns]
    if any(type(index) is not int or index < 0 for index in indices) or len(set(indices)) != len(indices):
        raise ValueError("Turn indices must be unique nonnegative integers")
    verdict = {"schemaVersion": 1, "case": bindings["case"], "checks": [], "figures": [], "passed": True,
               "passScope": "required-primary-numerics-and-file-readability-only",
               "interpretation": "requires-independent-review", "stateReuse": "requires-transcript-and-state-review"}
    for turn in turns:
        folder = directory / f"turn-{int(turn['index'])}"
        result = json.loads((folder / "result.json").read_text())
        scale = turn.get("scale", 1)
        if type(scale) not in (float, int) or not math.isfinite(scale) or scale <= 0:
            raise ValueError("Scale must be finite and positive")
        expected = reference(bindings["case"], scale, turn.get("confType", "log"))
        if not turn.get("required") or set(turn["required"]) - set(turn["bindings"]) or REQUIRED[bindings["case"]] - set(turn["required"]):
            raise ValueError("Every required primary quantity needs an evaluator binding")
        for name in turn["required"]:
            binding = turn["bindings"][name]
            actual = get_value(result, binding["path"])
            tolerance = binding.get("absoluteTolerance", 1e-7)
            relative = binding.get("relativeTolerance", 1e-6)
            if any(type(value) not in (float, int) or value < 0 or not math.isfinite(value) for value in (tolerance, relative)):
                raise ValueError("Invalid numerical tolerance")
            passed = math.isclose(actual, expected[name], abs_tol=tolerance, rel_tol=relative)
            verdict["checks"].append({"turn": turn["index"], "quantity": name, "actual": actual, "reference": expected[name], "passed": passed})
            verdict["passed"] &= passed
        downloads = json.loads((folder / "downloads.json").read_text())
        for item in downloads:
            if Path(item["stored"]).name != item["stored"]:
                raise ValueError("Download path is not local")
            source = folder / item["stored"]
            if source.is_symlink() or not source.is_file() or source.stat().st_size > MAX_ARTIFACT_BYTES:
                raise ValueError("Artifact must be a bounded regular file")
            raw = source.read_bytes()
            if hashlib.sha256(raw).hexdigest() != item["sha256"] or len(raw) != item["bytes"]:
                raise ValueError("Downloaded artifact changed after capture")
            if item["role"] == "figure" and source.suffix.lower() in (".png", ".svg"):
                if source.suffix.lower() == ".png":
                    with Image.open(source) as image:
                        width, height = image.size
                        image.verify()
                    passed = width >= 100 and height >= 100
                else:
                    root = ET.fromstring(raw)
                    valid_root = root.tag in {"svg", "{http://www.w3.org/2000/svg}svg"}
                    view_box = root.get("viewBox", "").split()
                    dimensions = [root.get("width", ""), root.get("height", "")]
                    dimensioned = (len(view_box) == 4 and all(math.isfinite(float(v)) for v in view_box)
                                   and float(view_box[2]) > 0 and float(view_box[3]) > 0)
                    if not dimensioned:
                        dimensioned = all(re.fullmatch(r"[0-9]+(?:\.[0-9]+)?(?:px|pt|in|cm|mm)?", value)
                                          and float(re.sub(r"[a-z]+$", "", value)) > 0 for value in dimensions)
                    drawing = any(node.tag.split("}")[-1] in {"path", "line", "polyline", "polygon", "circle", "ellipse", "rect", "text", "image"} for node in root.iter() if node is not root)
                    passed = valid_root and dimensioned and drawing
                verdict["figures"].append({"turn": turn["index"], "filename": item["filename"], "readable": passed})
                verdict["passed"] &= passed
        if turn.get("requireFigure", True) and not any(item["turn"] == turn["index"] for item in verdict["figures"]):
            verdict["passed"] = False
    verdict["bindingsSha256"] = hashlib.sha256(json.dumps(bindings, sort_keys=True).encode()).hexdigest()
    verdict["judgeSha256"] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    return verdict


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts", type=Path, required=True)
    parser.add_argument("--bindings", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    result = judge(args.artifacts, json.loads(args.bindings.read_text()))
    args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"case": result["case"], "passed": result["passed"], "quantities": len(result["checks"]), "figures": len(result["figures"])}))
    raise SystemExit(0 if result["passed"] else 1)
