"""Paper prose must follow the numbers it reports (R023, R024, R025)."""

import pytest

from mr_agent.models import (
    HeterogeneityResult,
    MRAnalysisResult,
    MRResult,
    PleiotopyResult,
    SessionState,
)
from mr_agent.paper.generator import PaperGenerator


def _ivw(beta=0.4, pval=1e-6, nsnp=79):
    return MRResult(
        method="Inverse variance weighted", nsnp=nsnp, beta=beta, se=0.08,
        pval=pval, or_value=1.49, ci_lower=1.27, ci_upper=1.74,
    )


def _forward(pleiotropy_p=0.62, **extra):
    return MRAnalysisResult(
        exposure_id="ieu-a-2", outcome_id="ieu-a-7",
        exposure_name="BMI", outcome_name="CHD", n_instruments=79,
        mr_results=[_ivw()],
        heterogeneity=[HeterogeneityResult(method="IVW", q=120.0, q_df=78, q_pval=0.001)],
        pleiotropy=PleiotopyResult(egger_intercept=0.021, se=0.005, pval=pleiotropy_p),
        **extra,
    )


def _reverse():
    return MRAnalysisResult(
        exposure_id="ieu-a-7", outcome_id="ieu-a-2",
        exposure_name="CHD", outcome_name="BMI", n_instruments=25,
        mr_results=[_ivw(beta=0.01, pval=0.6, nsnp=25)],
    )


def _generator(results, language, bidirectional=False):
    state = SessionState()
    state.slots.exposure = "BMI"
    state.slots.outcome = "CHD"
    state.slots.bidirectional = bidirectional
    state.analysis_results = results
    return PaperGenerator(llm=None, state=state, language=language)


# --------------------------------------------------------------------- R023

@pytest.mark.parametrize("language,denial,verdict", [
    ("zh", "未检出显著方向性多效性", "存在方向性多效性证据"),
    ("en", "no significant directional pleiotropy was detected",
     "this is evidence of directional pleiotropy"),
])
def test_a_significant_egger_intercept_is_not_written_up_as_clean(language, denial, verdict):
    result = _forward(pleiotropy_p=0.0004)
    text = _generator([result], language)._grounded_results([result])
    assert verdict in text
    assert denial not in text


@pytest.mark.parametrize("language,denial", [
    ("zh", "未检出显著方向性多效性"),
    ("en", "no significant directional pleiotropy was detected"),
])
def test_a_non_significant_egger_intercept_still_reads_as_negative(language, denial):
    result = _forward(pleiotropy_p=0.62)
    text = _generator([result], language)._grounded_results([result])
    assert denial in text


def test_the_release_gate_rejects_a_denial_that_contradicts_the_intercept(tmp_path):
    import evimed_runner

    result = _forward(pleiotropy_p=0.0004)
    result.exposure_metadata = {
        "gwas_id": "ieu-a-2", "trait": "BMI", "sample_size": 339224,
        "population": "European", "year": 2015,
    }
    result.outcome_metadata = {
        "gwas_id": "ieu-a-7", "trait": "CHD", "sample_size": 184305,
        "population": "European", "year": 2015,
    }
    paper = (
        "# MR\n\nExposure ieu-a-2 (339224 participants), outcome ieu-a-7 (184305 participants). "
        "Heterogeneity was significant. "
        "MR-Egger intercept=0.0210, SE=0.0050, p=4.000e-04; "
        "no significant directional pleiotropy was detected.\n"
    )
    with pytest.raises(RuntimeError, match="denied directional pleiotropy"):
        evimed_runner._validate_release(paper, [result])


# --------------------------------------------------------------------- R024

@pytest.mark.parametrize("language,executed,absent", [
    ("zh", "反向MR（CHD→BMI，25个工具变量）已执行", "未运行反向MR"),
    ("en", "Reverse MR (CHD to BMI, 25 instruments) was executed",
     "Reverse, multivariable, and nonlinear MR and formal power analysis were not executed"),
])
def test_an_executed_reverse_pair_is_reported_as_executed(language, executed, absent):
    forward, reverse = _forward(), _reverse()
    generator = _generator([forward, reverse], language, bidirectional=True)
    discussion = generator._grounded_discussion([forward])
    assert executed in discussion
    assert absent not in discussion


@pytest.mark.parametrize("language,absent", [
    ("zh", "未完成反向或多变量MR"),
    ("en", "absence of reverse or multivariable MR"),
])
def test_limitations_drop_the_missing_reverse_MR_claim_when_it_ran(language, absent):
    forward, reverse = _forward(), _reverse()
    generator = _generator([forward, reverse], language, bidirectional=True)
    assert absent not in generator._grounded_limitations([forward])


@pytest.mark.parametrize("language,absent", [
    ("zh", "本次未运行反向MR"),
    ("en", "Reverse, multivariable, and nonlinear MR and formal power analysis were not executed"),
])
def test_a_one_way_run_still_says_reverse_MR_was_not_executed(language, absent):
    forward = _forward()
    assert absent in _generator([forward], language)._grounded_discussion([forward])


# --------------------------------------------------------------------- R025

@pytest.mark.parametrize("language,heading", [
    ("zh", "未执行的敏感性分析："),
    ("en", "Sensitivity analyses that did not run:"),
])
def test_skipped_analyses_are_rendered_in_the_results(language, heading):
    result = _forward(skipped_analyses=[
        "radial_mr: RadialMR package not installed",
        "steiger: not applicable to continuous outcomes",
    ])
    text = _generator([result], language)._grounded_results([result])
    assert heading in text
    assert "radial_mr: RadialMR package not installed" in text
    assert "steiger: not applicable to continuous outcomes" in text


@pytest.mark.parametrize("language,fragment", [
    ("zh", "Radial MR异质性Q检验p="),
    ("en", "Radial MR heterogeneity Q-test p="),
])
def test_parsed_radial_p_value_reaches_the_paper(language, fragment):
    result = _forward(radial_pval=0.031)
    assert fragment in _generator([result], language)._grounded_results([result])


@pytest.mark.parametrize("language,fragment", [
    ("zh", "污染混合（contamination mixture）检验p="),
    ("en", "Contamination-mixture test p="),
])
def test_parsed_conmix_p_value_reaches_the_paper(language, fragment):
    result = _forward(conmix_pval=0.44)
    assert fragment in _generator([result], language)._grounded_results([result])
