"""Public-data reference comparisons and real file/figure checks, independent of model grading."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET

import numpy as np
import pandas as pd
import pytest
from scipy import stats
import statsmodels.formula.api as smf
from statsmodels.stats.anova import anova_lm

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[2] / "capabilities/statistical-analysis/scripts"))
import analysis_methods as methods


def r_json(code, packages=("jsonlite", "survival")):
    """R is the reference these comparisons are held to; a machine without it skips them by name, it does not fail them."""
    if not shutil.which("Rscript"):
        pytest.skip("Rscript is not installed")
    probe = "cat(all(sapply(c(%s), requireNamespace, quietly=TRUE)))" % ",".join('"%s"' % name for name in packages)
    if subprocess.check_output(["Rscript", "--vanilla", "-e", probe], text=True).strip() != "TRUE":
        pytest.skip("R lacks one of: " + ", ".join(packages))
    return json.loads(subprocess.check_output(["Rscript", "--vanilla", "-e", code], text=True))


def test_public_fixture_bytes_are_frozen():
    manifest = json.loads((HERE / "datasets.json").read_text())
    for source in manifest["sources"]:
        raw = (HERE / source["path"]).read_bytes()
        assert len(raw) == source["bytes"]
        assert hashlib.sha256(raw).hexdigest() == source["sha256"]


def test_paired_subjects_match_r_without_treating_visits_as_independent():
    frame = pd.read_csv(HERE / "fixtures/sleep.csv")
    actual = methods.compare_groups(frame.extra, frame.group, contrast=(2, 1), test="paired", subject=frame.ID)
    expected = r_json('d<-datasets::sleep; x<-t.test(d$extra[d$group==2],d$extra[d$group==1],paired=TRUE);cat(jsonlite::toJSON(list(estimate=unname(x$estimate),interval=x$conf.int,p=x$p.value),auto_unbox=TRUE,digits=16))')
    assert frame.ID.nunique() == 10 and len(frame) == 20
    assert actual["estimate"] == pytest.approx(expected["estimate"])
    assert actual["pValue"] == pytest.approx(expected["p"])
    assert [actual["interval"]["lower"], actual["interval"]["upper"]] == pytest.approx(expected["interval"])


def test_heart_failure_survival_matches_r_with_real_censoring():
    frame = pd.read_csv(HERE / "fixtures/heart-failure.csv")
    actual = methods.kaplan_meier(frame.time, frame.DEATH_EVENT)
    expected = r_json(f'd<-read.csv("{HERE}/fixtures/heart-failure.csv");s<-summary(survival::survfit(survival::Surv(time,DEATH_EVENT)~1,data=d),times=90);cat(jsonlite::toJSON(list(survival=s$surv,lower=s$lower,upper=s$upper,nrisk=s$n.risk),auto_unbox=TRUE,digits=16))')
    curve = actual["values"]["curves"]["all"]["table"]
    at = [row for row in curve if row["time"] <= 90][-1]
    assert len(frame) == 299 and int(frame.DEATH_EVENT.sum()) == 96
    assert at["survival"] == pytest.approx(expected["survival"])
    assert at["lower"] == pytest.approx(expected["lower"])
    assert at["upper"] == pytest.approx(expected["upper"])
    assert int((frame.time >= 90).sum()) == expected["nrisk"]


def test_pbc_randomized_and_observational_populations_do_not_merge():
    frame = pd.read_csv(HERE / "fixtures/pbc.csv")
    randomized = frame[frame.trt.notna()]
    assert len(frame) == 418 and len(randomized) == 312
    assert frame.trt.isna().sum() == 106
    assert set(frame.status) == {0, 1, 2}
    assert sum(frame.status == 2) != sum(frame.status != 0), "Transplant and death are distinct events."
    expected = r_json('d<-survival::pbc;cat(jsonlite::toJSON(list(events=as.integer(table(factor(d$status,levels=0:2))),arms=as.integer(table(d$trt))),auto_unbox=TRUE))')
    assert [int((frame.status == value).sum()) for value in range(3)] == expected["events"]
    assert randomized.groupby("trt").size().tolist() == expected["arms"]


def test_factorial_interaction_matches_native_r():
    frame = pd.read_csv(HERE / "fixtures/tooth-growth.csv")
    actual = anova_lm(smf.ols("len ~ C(dose) * C(supp)", data=frame).fit(), typ=1)
    expected = r_json('d<-datasets::ToothGrowth;d$dose<-factor(d$dose);a<-anova(lm(len~dose*supp,d));cat(jsonlite::toJSON(list(F=a[3,"F value"],p=a[3,"Pr(>F)"]),auto_unbox=TRUE,digits=16))')
    interaction = actual.loc["C(dose):C(supp)"]
    assert len(frame) == 60 and len(frame.groupby(["dose", "supp"])) == 6
    assert interaction["F"] == pytest.approx(expected["F"])
    assert interaction["PR(>F)"] == pytest.approx(expected["p"])


@pytest.mark.parametrize("format", ["csv", "xlsx", "json", "parquet"])
def test_scientific_table_formats_preserve_subject_codes_and_missing_values(tmp_path, format):
    original = pd.DataFrame({"subject": ["001", "002", "003"], "measurement": [1.25, np.nan, 3.5], "event": [1, 0, 1]})
    target = tmp_path / f"cohort.{format}"
    if format == "csv":
        original.to_csv(target, index=False)
        restored = pd.read_csv(target, dtype={"subject": str})
    elif format == "xlsx":
        original.to_excel(target, index=False)
        restored = pd.read_excel(target, dtype={"subject": str})
    elif format == "json":
        original.to_json(target, orient="table", index=False)
        restored = pd.read_json(target, orient="table")
    else:
        pytest.importorskip("pyarrow")
        original.to_parquet(target, index=False)
        restored = pd.read_parquet(target)
    pd.testing.assert_frame_equal(original, restored, check_dtype=False)


def test_headless_png_and_svg_plot_actual_estimates(tmp_path):
    matplotlib = pytest.importorskip("matplotlib")
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from PIL import Image

    frame = pd.read_csv(HERE / "fixtures/sleep.csv").pivot(index="ID", columns="group", values="extra")
    differences = frame[2] - frame[1]
    mean, se = differences.mean(), stats.sem(differences)
    lower, upper = stats.t.interval(.95, len(differences) - 1, loc=mean, scale=se)
    plotted = pd.DataFrame({"estimate": [mean], "lower": [lower], "upper": [upper], "unit": ["hours"]})
    plotted.to_csv(tmp_path / "figure-data.csv", index=False)
    with plt.rc_context({"svg.fonttype": "none"}):
        fig, axis = plt.subplots(figsize=(5, 3))
        axis.errorbar(mean, 0, xerr=[[mean-lower], [upper-mean]], fmt="o")
        axis.set_xlabel("Drug 2 minus drug 1 (hours)")
        axis.set_yticks([0], ["10 paired participants"])
        fig.tight_layout()
        fig.savefig(tmp_path / "effect.png", dpi=150)
        fig.savefig(tmp_path / "effect.svg")
        plt.close(fig)
    with Image.open(tmp_path / "effect.png") as png:
        assert png.size == (750, 450)
        png.verify()
    text = " ".join(ET.parse(tmp_path / "effect.svg").getroot().itertext())
    assert "Drug 2 minus drug 1 (hours)" in text and "10 paired participants" in text
    assert pd.read_csv(tmp_path / "figure-data.csv").estimate.iloc[0] == pytest.approx(mean)
