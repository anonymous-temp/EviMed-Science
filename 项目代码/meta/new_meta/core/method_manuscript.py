"""Fact-locked manuscript rendering for non-pairwise method families."""
from __future__ import annotations

import re
from typing import Any

from new_meta.core.manuscript_facts import build_manuscript_facts
from new_meta.schemas.synthesis_result import SynthesisResultEnvelope


def build_method_manuscript(
    *,
    project,
    protocol,
    extracted_studies: list,
    rob_results: list,
    prisma_data: dict,
    search_query: str,
    lang: str = "en",
) -> str:
    envelope = SynthesisResultEnvelope.model_validate(
        project.load_json("synthesis_result.json", subdir="analysis")
    )
    if not envelope.primary_estimates:
        raise ValueError("method manuscript requires at least one synthesis estimate")

    facts = build_manuscript_facts(
        protocol=protocol,
        extracted_studies=extracted_studies,
        rob_results=rob_results,
        prisma_data=prisma_data,
        search_query=search_query,
        project=project,
    )
    facts["output_language"] = "zh" if str(lang).lower().startswith("zh") else "en"
    method_audit = project.load_json("method_input_audit.json", subdir="analysis") or {}
    certainty = project.load_json("method_certainty.json", subdir="analysis") or {}
    common = {
        "protocol": protocol,
        "studies": extracted_studies,
        "rob_results": rob_results,
        "prisma": prisma_data,
        "search_query": search_query,
        "envelope": envelope,
        "certainty": certainty,
    }
    if envelope.family.value == "ipd_meta":
        manuscript = (
            _render_ipd_meta_zh(**common)
            if facts["output_language"] == "zh"
            else _render_ipd_meta_en(**common)
        )
    elif envelope.family.value == "dose_response":
        manuscript = (
            _render_dose_response_zh(**common)
            if facts["output_language"] == "zh"
            else _render_dose_response_en(**common)
        )
    elif envelope.family.value == "network_meta":
        manuscript = (
            _render_network_meta_zh(**common)
            if facts["output_language"] == "zh"
            else _render_network_meta_en(**common)
        )
    elif envelope.family.value == "intervention_rct":
        manuscript = (
            _render_complex_rct_zh(**common)
            if facts["output_language"] == "zh"
            else _render_complex_rct_en(**common)
        )
    elif envelope.family.value == "prevalence_incidence":
        common["estimate"] = envelope.primary_estimates[0]
        if envelope.primary_estimates[0].measure == "PROP":
            manuscript = (
                _render_prevalence_zh(**common)
                if facts["output_language"] == "zh"
                else _render_prevalence_en(**common)
            )
        elif envelope.primary_estimates[0].measure == "IR":
            manuscript = (
                _render_incidence_zh(**common)
                if facts["output_language"] == "zh"
                else _render_incidence_en(**common)
            )
        else:
            raise ValueError("prevalence/incidence manuscript requires a PROP or IR synthesis result")
    elif envelope.family.value == "diagnostic_accuracy":
        measures = {item.measure for item in envelope.primary_estimates}
        if not {"SENS", "SPEC"} <= measures:
            raise ValueError("diagnostic manuscript requires joint SENS and SPEC estimates")
        manuscript = (
            _render_dta_zh(**common)
            if facts["output_language"] == "zh"
            else _render_dta_en(**common)
        )
    elif envelope.family.value == "intervention_nrsi":
        manuscript = (
            _render_nrsi_zh(**common)
            if facts["output_language"] == "zh"
            else _render_nrsi_en(**common)
        )
    elif envelope.family.value == "prognostic_factor":
        manuscript = (
            _render_prognostic_zh(**common)
            if facts["output_language"] == "zh"
            else _render_prognostic_en(**common)
        )
    elif envelope.family.value == "prediction_model":
        if envelope.primary_estimates[0].measure == "CALIBRATION_SLOPE":
            manuscript = (
                _render_prediction_slope_zh(**common)
                if facts["output_language"] == "zh"
                else _render_prediction_slope_en(**common)
            )
        elif envelope.primary_estimates[0].measure == "OE_RATIO":
            manuscript = (
                _render_prediction_oe_zh(**common)
                if facts["output_language"] == "zh"
                else _render_prediction_oe_en(**common)
            )
        else:
            manuscript = (
                _render_prediction_zh(**common)
                if facts["output_language"] == "zh"
                else _render_prediction_en(**common)
            )
    else:
        raise ValueError(
            f"method manuscript renderer is not implemented for {envelope.family.value}"
        )
    validation = _validate_method_manuscript(
        manuscript,
        envelope=envelope,
        method_input_audit=method_audit,
        method_certainty=certainty,
        lang=facts["output_language"],
    )
    project.save_json("manuscript_facts.json", facts, subdir="manuscript")
    project.save_json("manuscript_validation.json", validation, subdir="manuscript")
    project.save_text("draft.md", manuscript, subdir="manuscript")
    return manuscript


def merge_method_manuscript_validation(
    *,
    project,
    manuscript: str,
    lang: str = "en",
) -> dict[str, Any]:
    """Merge compiled-method invariants into the generic article validation."""
    envelope = SynthesisResultEnvelope.model_validate(
        project.load_json("synthesis_result.json", subdir="analysis")
    )
    method_validation = _validate_method_manuscript(
        manuscript,
        envelope=envelope,
        method_input_audit=(
            project.load_json("method_input_audit.json", subdir="analysis") or {}
        ),
        method_certainty=(
            project.load_json("method_certainty.json", subdir="analysis") or {}
        ),
        lang="zh" if str(lang).lower().startswith("zh") else "en",
    )
    generic = project.load_json("manuscript_validation.json", subdir="manuscript") or {}
    merged = dict(generic)
    generic_issues = [item for item in generic.get("issues") or [] if isinstance(item, dict)]
    method_issues = [item for item in method_validation.get("issues") or [] if isinstance(item, dict)]
    merged.update({
        key: value
        for key, value in method_validation.items()
        if key not in {"issues", "facts_summary", "passed"}
    })
    merged["issues"] = generic_issues + method_issues
    merged["passed"] = bool(generic.get("passed") is True and method_validation.get("passed") is True)
    merged["facts_summary"] = {
        **(generic.get("facts_summary") or {}),
        **(method_validation.get("facts_summary") or {}),
    }
    project.save_json("manuscript_validation.json", merged, subdir="manuscript")
    return merged


def _ipd_study_table(envelope: SynthesisResultEnvelope, *, zh: bool) -> str:
    header = (
        "| 研究 | 参与者 | 研究特异效应 | 95% CI | 模型 |\n|---|---:|---:|---:|---|"
        if zh
        else "| Study | Participants | Study effect | 95% CI | Model |\n|---|---:|---:|---:|---|"
    )
    rows = [
        f"| {item['study_id']} | {item['n_participants']} | {_effect(item['effect'])} | "
        f"{_effect(item['ci_lower'])} to {_effect(item['ci_upper'])} | {item['model']} |"
        for item in envelope.engine_payload.get("study_effects") or []
    ]
    return header + "\n" + "\n".join(rows)


def _render_ipd_meta_en(*, protocol, studies, rob_results, prisma, search_query, envelope, certainty) -> str:
    payload = envelope.engine_payload
    estimate = envelope.primary_estimates[0]
    identified, deduplicated, full_text, included = _prisma_counts(prisma, envelope.n_studies)
    rob_text = _rob_summary(rob_results, zh=False)
    certainty_text = _certainty_summary(certainty, zh=False)
    covariates = (payload.get("diagnostics") or {}).get("covariates") or []
    modifier = (payload.get("diagnostics") or {}).get("effect_modifier")
    modification = payload.get("effect_modification") or {}
    one_stage = payload.get("one_stage_sensitivity") or {}
    hksj = payload.get("hksj_sensitivity") or {}
    prediction = estimate.prediction_lower, estimate.prediction_upper
    prediction_text = (
        f"; 95% prediction interval {_effect(prediction[0])} to {_effect(prediction[1])}"
        if prediction[0] is not None and prediction[1] is not None
        else ""
    )
    modifier_text = (
        f"Treatment-{modifier} interaction coefficients were estimated after centering "
        f"{modifier} within each study and were pooled separately."
        if modifier
        else "No treatment-covariate interaction was prespecified."
    )
    modification_result = (
        f" The pooled treatment-{modifier} interaction coefficient was "
        f"{_effect(modification.get('coefficient'))} (95% CI "
        f"{_effect(modification.get('ci_lower'))} to "
        f"{_effect(modification.get('ci_upper'))})."
        if modification
        else ""
    )
    return f"""# Individual participant data meta-analysis of {protocol.pico.intervention} for {protocol.pico.outcome_primary}

## Abstract

**Background:** This review estimated the treatment effect of {protocol.pico.intervention} versus {protocol.pico.comparator} for {protocol.pico.outcome_primary} using individual participant data from eligible parallel randomized trials.

**Methods:** We searched {', '.join(protocol.databases) or 'the prespecified sources'} and fitted one participant-level {payload.get('diagnostics', {}).get('study_model', 'outcome-specific')} model per study. Study treatment coefficients were pooled by two-stage restricted maximum likelihood; Hartung-Knapp-Sidik-Jonkman and one-stage common-effect models were sensitivity analyses. Required model data were analyzed only when complete.

**Results:** {envelope.n_studies} studies contributed {payload.get('n_participants')} participants. The pooled {estimate.measure} was {_effect(estimate.estimate)} (95% CI {_effect(estimate.ci_lower)} to {_effect(estimate.ci_upper)}{prediction_text}). Tau-squared was {float(payload.get('tau_squared') or 0):.4f} and I-squared was {float(payload.get('i_squared') or 0):.1f}%.

**Conclusions:** The participant-level primary and sensitivity models produced the estimates reported below. Interpretation depends on trial bias, outcome and covariate harmonization, missing-data availability, and the assumptions of the outcome-specific models.

## Introduction

Individual participant data permit a common outcome definition, consistent covariate coding, participant-level adjustment, and treatment-covariate interaction analyses that aggregate reports cannot reproduce. They do not remove study bias or compensate for unavailable participant rows. This review therefore used a prespecified two-stage model as the primary analysis and retained an independently fitted one-stage sensitivity analysis.

## Methods

### Eligibility and search

The review question was: {protocol.research_question} We identified {identified} records, retained {deduplicated} after deduplication, assessed {full_text} full texts, and included {included} studies. The final query was:

```text
{search_query or 'Not reported'}
```

Eligible datasets came from parallel randomized trials in {protocol.pico.population}, contained both randomized arms, and supplied the participant-level fields required for the prespecified {payload.get('outcome_type')} model. {rob_text}

### Data preparation

Treatment was coded 0/1 within every trial. The modeled covariates were {', '.join(covariates) or 'none'}. Missing required outcomes, event times, event indicators, treatment values, or modeled covariates stopped analysis rather than being silently deleted or imputed. {modifier_text}

### Statistical analysis

For each study, {'logistic regression estimated a log odds ratio' if estimate.measure == 'OR' else 'a Cox partial-likelihood model estimated a log hazard ratio' if estimate.measure == 'HR' else 'linear regression estimated a mean difference'}. Study coefficients and model-based variances were combined with inverse-variance random effects using restricted maximum likelihood. Wald intervals formed the primary result; Hartung-Knapp-Sidik-Jonkman inference was retained as a small-sample sensitivity. The one-stage sensitivity model used fixed study intercepts for binary or continuous outcomes and a study-stratified Cox model for time-to-event outcomes. The exact participant rows, dataset hashes, compiled method plan, study-level coefficients, and deterministic outputs were retained.

## Results

### Included participant datasets

{_ipd_study_table(envelope, zh=False)}

### Primary and sensitivity analyses

The two-stage pooled {estimate.measure} was {_effect(estimate.estimate)} (95% CI {_effect(estimate.ci_lower)} to {_effect(estimate.ci_upper)}{prediction_text}). The HKSJ sensitivity estimate was {_effect(hksj.get('effect'))} (95% CI {_effect(hksj.get('ci_lower'))} to {_effect(hksj.get('ci_upper'))}). The one-stage sensitivity {estimate.measure} was {_effect(one_stage.get('effect'))} (95% CI {_effect(one_stage.get('ci_lower'))} to {_effect(one_stage.get('ci_upper'))}).{modification_result}

### Risk of bias and certainty

{rob_text} {certainty_text}

## Discussion

The primary analysis respects randomization within each study, preserves study-specific baseline risk through separate participant-level models, and allows treatment heterogeneity across trials. The one-stage common-effect sensitivity checks whether a jointly fitted participant model yields a materially different estimate, but it does not replace the random-effects primary analysis. Within-study centering separates participant-level effect modification from ecological differences in study means.

Limitations include unavailable participant datasets, incompatible variable definitions, complete-required-data analysis, possible non-proportional hazards for time-to-event outcomes, sparse binary outcomes, and limited power for treatment-covariate interactions. Cluster, crossover, observational, count, multiple-imputation, and non-proportional-hazards IPD models are outside this validated capability and are not converted to ordinary pairwise analyses.

## Conclusions

Across {envelope.n_studies} parallel randomized trials and {payload.get('n_participants')} participants, the pooled {estimate.measure} was {_effect(estimate.estimate)} (95% CI {_effect(estimate.ci_lower)} to {_effect(estimate.ci_upper)}). The primary estimate should be interpreted together with the prediction interval, HKSJ and one-stage sensitivities, risk of bias, and certainty assessment.

## Declarations

**Funding and conflicts of interest:** Not reported in the supplied project data.

**Data availability:** The project artifacts record dataset hashes, verified participant-level model inputs, study-specific estimates, the exact analysis set, and deterministic outputs. Participant rows are not reproduced in this manuscript.
""".strip()


def _render_ipd_meta_zh(*, protocol, studies, rob_results, prisma, search_query, envelope, certainty) -> str:
    payload = envelope.engine_payload
    estimate = envelope.primary_estimates[0]
    identified, deduplicated, full_text, included = _prisma_counts(prisma, envelope.n_studies)
    rob_text = _rob_summary(rob_results, zh=True)
    certainty_text = _certainty_summary(certainty, zh=True)
    covariates = (payload.get("diagnostics") or {}).get("covariates") or []
    modifier = (payload.get("diagnostics") or {}).get("effect_modifier")
    modification = payload.get("effect_modification") or {}
    one_stage = payload.get("one_stage_sensitivity") or {}
    hksj = payload.get("hksj_sensitivity") or {}
    prediction = estimate.prediction_lower, estimate.prediction_upper
    prediction_text = (
        f"；95%预测区间{_effect(prediction[0])}至{_effect(prediction[1])}"
        if prediction[0] is not None and prediction[1] is not None
        else ""
    )
    modifier_text = (
        f"{modifier}在各研究内中心化后构建治疗-{modifier}交互项，并单独合并交互系数。"
        if modifier
        else "未预设治疗-协变量交互分析。"
    )
    modification_result = (
        f"治疗-{modifier}交互系数为{_effect(modification.get('coefficient'))}"
        f"（95% CI {_effect(modification.get('ci_lower'))}至"
        f"{_effect(modification.get('ci_upper'))}）。"
        if modification
        else ""
    )
    study_model = payload.get("diagnostics", {}).get("study_model", "结局特异模型")
    return f"""# {protocol.pico.intervention}治疗{protocol.pico.outcome_primary}的个体参与者数据Meta分析

## 摘要

**背景：** 本评价使用平行随机试验的个体参与者数据，估计{protocol.pico.intervention}相对于{protocol.pico.comparator}对{protocol.pico.outcome_primary}的治疗效果。

**方法：** 检索{('、'.join(protocol.databases) or '预设来源')}，每项研究拟合一个参与者层面的{study_model}，再以两阶段限制性最大似然合并治疗系数；Hartung-Knapp-Sidik-Jonkman和单阶段共同效应模型为敏感性分析。所需模型数据必须完整。

**结果：** {envelope.n_studies}项研究共纳入{payload.get('n_participants')}名参与者。合并{estimate.measure}为{_effect(estimate.estimate)}（95% CI {_effect(estimate.ci_lower)}至{_effect(estimate.ci_upper)}{prediction_text}），τ²={float(payload.get('tau_squared') or 0):.4f}，I²={float(payload.get('i_squared') or 0):.1f}%。

**结论：** 个体层面主要分析和敏感性分析得到下述结果；解释依赖试验偏倚、结局及协变量协调、缺失数据可得性和结局特异模型假设。

## 引言

个体参与者数据能够统一结局定义和协变量编码，进行参与者层面调整，并检验汇总报告无法可靠重建的治疗-协变量交互作用；但它不能消除研究偏倚，也不能补齐无法获得的数据。本评价预设两阶段随机效应模型为主要分析，并保留独立拟合的单阶段敏感性分析。

## 方法

### 纳入标准与检索

研究问题为：{protocol.research_question}。共识别{identified}条记录，去重后{deduplicated}条，评估全文{full_text}篇，纳入{included}项研究。检索式为：

```text
{search_query or '未报告'}
```

合格数据集来自{protocol.pico.population}的平行随机试验，包含两个随机分组，并提供预设{payload.get('outcome_type')}模型所需的参与者字段。{rob_text}

### 数据准备

每项试验内治疗编码为0/1，模型协变量为{'、'.join(covariates) or '无'}。所需结局、事件时间、事件指示、治疗值或模型协变量缺失时停止分析，不静默删除或插补。{modifier_text}

### 统计分析

每项研究采用{'Logistic回归估计log优势比' if estimate.measure == 'OR' else 'Cox部分似然模型估计log风险比' if estimate.measure == 'HR' else '线性回归估计均数差'}，再用限制性最大似然的逆方差随机效应模型合并研究系数及模型方差。主要结果采用Wald区间，HKSJ推断为小样本敏感性分析。二分类和连续结局的单阶段敏感性模型纳入固定研究截距，生存结局采用研究分层Cox模型。精确参与者行、数据集哈希、方法计划、研究系数和确定性输出均被保存。

## 结果

### 纳入的参与者数据集

{_ipd_study_table(envelope, zh=True)}

### 主要与敏感性分析

两阶段合并{estimate.measure}为{_effect(estimate.estimate)}（95% CI {_effect(estimate.ci_lower)}至{_effect(estimate.ci_upper)}{prediction_text}）。HKSJ敏感性估计为{_effect(hksj.get('effect'))}（95% CI {_effect(hksj.get('ci_lower'))}至{_effect(hksj.get('ci_upper'))}）；单阶段敏感性分析{estimate.measure}为{_effect(one_stage.get('effect'))}（95% CI {_effect(one_stage.get('ci_lower'))}至{_effect(one_stage.get('ci_upper'))}）。{modification_result}

### 偏倚风险与确定性

{rob_text}{certainty_text}

## 讨论

主要分析在各研究内保留随机化，并通过独立参与者模型保留研究特异基线风险，同时允许试验间治疗效应异质性。单阶段共同效应模型检验联合拟合是否得到明显不同的结果，但不替代随机效应主要分析。研究内中心化可将参与者层面效应修饰与研究均值间的生态差异分开。

限制包括部分参与者数据不可获得、变量定义不兼容、所需数据完整病例分析、生存结局可能不满足比例风险、二分类稀疏事件及交互分析效能不足。整群、交叉、观察性、计数、多重插补及非比例风险IPD模型不属于当前已验证能力，也不会被伪装为普通两两分析。

## 结论

{envelope.n_studies}项平行随机试验、{payload.get('n_participants')}名参与者的合并{estimate.measure}为{_effect(estimate.estimate)}（95% CI {_effect(estimate.ci_lower)}至{_effect(estimate.ci_upper)}）。应结合预测区间、HKSJ与单阶段敏感性分析、偏倚风险和证据确定性解释。

## 声明

**资助与利益冲突：** 当前项目数据未报告。

**数据可得性：** 项目产物记录数据集哈希、经核验的参与者层面模型输入、研究特异估计、精确分析集和确定性输出；本文不复现参与者行。
""".strip()


def _dose_curve_table(envelope: SynthesisResultEnvelope, *, zh: bool) -> str:
    payload = envelope.engine_payload
    curve = payload.get("curve") or []
    knots = {round(float(value), 10) for value in payload.get("knots") or []}
    selected = [
        item for item in curve
        if round(float(item["dose"]), 10) in knots
        or float(item["dose"]) == float(payload.get("reference_dose") or 0)
        or item is curve[-1]
    ]
    header = (
        "| 剂量 | 效应量 | 95% CI |\n|---:|---:|---:|"
        if zh
        else "| Dose | Effect | 95% CI |\n|---:|---:|---:|"
    )
    rows = [
        f"| {float(item['dose']):g} {payload.get('dose_unit')} | {_effect(item['effect'])} | "
        f"{_effect(item['ci_lower'])} to {_effect(item['ci_upper'])} |"
        for item in selected
    ]
    return header + "\n" + "\n".join(rows)


def _render_dose_response_en(*, protocol, studies, rob_results, prisma, search_query, envelope, certainty) -> str:
    payload = envelope.engine_payload
    estimate = envelope.primary_estimates[0]
    identified, deduplicated, full_text, included = _prisma_counts(prisma, len(studies))
    rob_text = _rob_summary(rob_results, zh=False)
    certainty_text = _certainty_summary(certainty, zh=False)
    curve_table = _dose_curve_table(envelope, zh=False)
    adjustment = (payload.get("diagnostics") or {}).get("observational_adjustment_set") or []
    nonlinearity = payload.get("nonlinearity") or {}
    return f"""# Dose-response association of {protocol.pico.intervention} with {protocol.pico.outcome_primary}: a systematic review and meta-analysis

## Abstract

**Background:** This review estimated the shape of the dose-response association between {protocol.pico.intervention} and {protocol.pico.outcome_primary} in {protocol.pico.population}.

**Methods:** We searched {', '.join(protocol.databases) or 'the prespecified sources'} and analyzed verified category-level effects with a two-stage restricted cubic spline. Dependent dose contrasts retained their within-study covariance. Study-specific spline coefficients were pooled by multivariate restricted maximum likelihood; a linear random-effects model was retained as sensitivity analysis.

**Results:** {envelope.n_studies} studies contributed {payload.get('n_contrasts')} non-reference dose contrasts in {payload.get('dose_unit')}. At {max(item['dose'] for item in payload.get('curve') or [dict(dose=0)]):g} {payload.get('dose_unit')} versus {payload.get('reference_dose'):g} {payload.get('dose_unit')}, the estimated {estimate.measure} was {_effect(estimate.estimate)} (95% CI {_effect(estimate.ci_lower)} to {_effect(estimate.ci_upper)}). The Wald test for nonlinearity gave p={_rate(nonlinearity.get('p_value'))}.

**Conclusions:** The multivariate spline characterized the dose-response curve without treating correlated categories as independent. Interpretation is limited to the observed dose range and the recorded adjustment set.

## Introduction

A single high-versus-low contrast cannot show whether an association is linear, has a threshold, plateaus, or changes direction. Dose-response meta-analysis uses all reported exposure categories, but those contrasts share a reference group and are statistically dependent. The objective was to estimate the curve for {protocol.pico.outcome_primary}, test nonlinearity, and compare it with a linear trend.

## Methods

### Eligibility and search

The question was: {protocol.research_question} We identified {identified} records, retained {deduplicated} after deduplication, assessed {full_text} full texts, and included {included} studies. The final query was:

```text
{search_query or 'Not reported'}
```

### Dose extraction, adjustment, and risk of bias

For each study we retained the reference dose, non-reference category dose, unit, adjusted effect, precision, source quotation, and covariance with every dependent category. Units were converted only within a declared physical dimension. Observational estimates used the common adjustment set {', '.join(adjustment) or 'not applicable'}. {rob_text} {certainty_text}

### Statistical analysis

Ratio measures were analyzed on the log scale. Three restricted cubic spline knots were locked at {', '.join(f'{value:g}' for value in payload.get('knots') or [])} {payload.get('dose_unit')}. Each study required at least two non-reference categories with a positive-definite within-study covariance matrix. Generalized least squares produced two study-specific spline coefficients, which were pooled by multivariate restricted maximum likelihood. The second spline coefficient was tested with a one-degree-of-freedom Wald test for nonlinearity. A linear REML slope was the prespecified sensitivity analysis. Doses outside the observed range were not extrapolated.

## Results

### Included evidence

The analysis included {envelope.n_studies} studies and {payload.get('n_contrasts')} dependent dose contrasts. The harmonized unit was {payload.get('dose_unit')} and the reference dose was {payload.get('reference_dose'):g}.

### Dose-response curve

{curve_table}

The nonlinearity statistic was z={float(nonlinearity.get('wald_z') or 0):.3f}, p={_rate(nonlinearity.get('p_value'))}. At the maximum observed dose, the estimated {estimate.measure} was {_effect(estimate.estimate)} (95% CI {_effect(estimate.ci_lower)} to {_effect(estimate.ci_upper)}). The linear sensitivity coefficient was {float((payload.get('linear_sensitivity') or {}).get('coefficient') or 0):.4f} per {payload.get('dose_unit')}.

## Discussion

The analysis preserved the correlation induced by shared reference categories and allowed a nonlinear curve. Its validity depends on correct dose assignment, unit conversion, covariance recovery, and comparability of adjusted estimands. Category midpoints and open-ended intervals can introduce exposure error, and the curve should not be extrapolated beyond the observed range. In observational evidence, residual confounding remains possible even when adjustment sets match.

## Conclusions

Across {envelope.n_studies} studies, the dose-response curve showed an estimated {estimate.measure} of {_effect(estimate.estimate)} at the maximum observed dose versus the reference. The evidence should be interpreted from the full curve, confidence intervals, nonlinearity test, and risk-of-bias assessment.

## Declarations

**Funding and conflicts of interest:** Not reported in the supplied project data.

**Data availability:** Project artifacts contain verified category doses, adjusted effects, within-study covariance matrices, unit conversions, spline inputs, and deterministic outputs. No individual participant data were used.
""".strip()


def _render_dose_response_zh(*, protocol, studies, rob_results, prisma, search_query, envelope, certainty) -> str:
    payload = envelope.engine_payload
    estimate = envelope.primary_estimates[0]
    identified, deduplicated, full_text, included = _prisma_counts(prisma, len(studies))
    rob_text = _rob_summary(rob_results, zh=True)
    certainty_text = _certainty_summary(certainty, zh=True)
    curve_table = _dose_curve_table(envelope, zh=True)
    adjustment = (payload.get("diagnostics") or {}).get("observational_adjustment_set") or []
    nonlinearity = payload.get("nonlinearity") or {}
    return f"""# {protocol.pico.intervention}与{protocol.pico.outcome_primary}的剂量-反应关系：系统评价与Meta分析

## 摘要

**背景：** 本评价估计{protocol.pico.population}中{protocol.pico.intervention}与{protocol.pico.outcome_primary}之间剂量-反应关系的形状。

**方法：** 检索{('、'.join(protocol.databases) or '预设来源')}，采用两阶段限制性立方样条分析经核验的分类剂量效应，并保留研究内协方差。研究特异样条系数用多变量限制性最大似然合并，同时保留线性随机效应敏感性分析。

**结果：** {envelope.n_studies}项研究提供{payload.get('n_contrasts')}个非参照剂量对比，统一单位为{payload.get('dose_unit')}。最大观察剂量相对{payload.get('reference_dose'):g} {payload.get('dose_unit')}的{estimate.measure}为{_effect(estimate.estimate)}（95% CI {_effect(estimate.ci_lower)}至{_effect(estimate.ci_upper)}）；非线性Wald检验p={_rate(nonlinearity.get('p_value'))}。

**结论：** 多变量样条在不把相关剂量分类误当作独立观察的前提下刻画了剂量-反应曲线；解释限于观察剂量范围和记录的调整集。

## 引言

单一高低剂量对比不能判断关联是线性、存在阈值、平台期还是方向变化。剂量-反应Meta分析可利用所有暴露分类，但共享参照组导致这些对比相关。本研究估计完整曲线、检验非线性，并与线性趋势比较。

## 方法

### 纳入标准与检索

研究问题为：{protocol.research_question}。共识别{identified}条记录，去重后{deduplicated}条，评估全文{full_text}篇，纳入{included}项研究。检索式为：

```text
{search_query or '未报告'}
```

### 剂量提取、调整与偏倚风险

逐项保存参照剂量、非参照分类剂量、单位、调整后效应、精度、来源引文及所有相关分类之间的协方差。仅在同一物理维度内转换单位。观察性估计采用共同调整集：{'、'.join(adjustment) or '不适用'}。{rob_text}{certainty_text}

### 统计分析

比值类效应在log尺度分析。限制性立方样条结点锁定为{('、'.join(f'{value:g}' for value in payload.get('knots') or []))} {payload.get('dose_unit')}。每项研究至少需要两个非参照分类及正定研究内协方差矩阵；先用广义最小二乘估计两个研究特异样条系数，再用多变量限制性最大似然合并。第二个样条系数采用1个自由度的Wald非线性检验；线性REML斜率为敏感性分析。不外推到观察范围之外。

## 结果

### 纳入证据

共纳入{envelope.n_studies}项研究和{payload.get('n_contrasts')}个相关剂量对比；统一单位为{payload.get('dose_unit')}，参照剂量为{payload.get('reference_dose'):g}。

### 剂量-反应曲线

{curve_table}

非线性检验z={float(nonlinearity.get('wald_z') or 0):.3f}，p={_rate(nonlinearity.get('p_value'))}。最大观察剂量的{estimate.measure}为{_effect(estimate.estimate)}（95% CI {_effect(estimate.ci_lower)}至{_effect(estimate.ci_upper)}）。

## 讨论

本分析保留共享参照分类产生的相关性，并允许非线性曲线。有效性依赖剂量赋值、单位转换、协方差恢复和调整后估计目标的可比性。分类中点及开放区间可能引入暴露误差，曲线不能外推到观察范围之外；观察性研究即使调整集一致仍可能存在残余混杂。

## 结论

{envelope.n_studies}项研究的剂量-反应曲线显示，最大观察剂量相对参照剂量的{estimate.measure}为{_effect(estimate.estimate)}。应结合完整曲线、置信区间、非线性检验和偏倚风险解释。

## 声明

**资助与利益冲突：** 当前项目数据未报告。

**数据可得性：** 项目产物包含经核验的分类剂量、调整后效应、研究内协方差、单位转换、样条输入和确定性输出；未使用个体参与者数据。
""".strip()


def _network_league_table(envelope: SynthesisResultEnvelope, *, zh: bool) -> str:
    header = (
        "| 治疗 | 对照 | 效应量 | 95% CI |\n|---|---|---:|---:|"
        if zh
        else "| Treatment | Comparator | Effect | 95% CI |\n|---|---|---:|---:|"
    )
    rows = [
        f"| {item.label.split(' versus ')[0]} | {item.label.split(' versus ')[-1]} | "
        f"{_effect(item.estimate)} | {_effect(item.ci_lower)} to {_effect(item.ci_upper)} |"
        for item in envelope.primary_estimates
    ]
    return header + "\n" + "\n".join(rows)


def _render_network_meta_en(*, protocol, studies, rob_results, prisma, search_query, envelope, certainty) -> str:
    payload = envelope.engine_payload
    identified, deduplicated, full_text, included = _prisma_counts(prisma, len(studies))
    rob_text = _rob_summary(rob_results, zh=False)
    certainty_text = _certainty_summary(certainty, zh=False)
    league = _network_league_table(envelope, zh=False)
    rankings = ", ".join(
        f"{name} {score:.3f}" for name, score in sorted(
            (payload.get("rankings") or {}).items(), key=lambda item: (-item[1], item[0])
        )
    )
    transitivity = payload.get("transitivity_assessment") or {}
    dbt = (payload.get("diagnostics") or {}).get("design_by_treatment") or {}
    split_count = len(payload.get("node_splitting") or {})
    return f"""# Comparative effects of {', '.join(payload.get('treatments') or protocol.interventions)}: a systematic review and network meta-analysis

## Abstract

**Background:** This review compared multiple treatments for {protocol.pico.outcome_primary} in {protocol.pico.population} by combining direct and indirect randomized evidence.

**Methods:** We searched {', '.join(protocol.databases) or 'the prespecified sources'} and fitted a contrast-based random-effects network meta-analysis with restricted maximum likelihood. Shared-control multi-arm covariance was retained. Transitivity was assessed from prespecified effect modifiers; global inconsistency used a design-by-treatment interaction model and local inconsistency used node-splitting with a separately refitted indirect network.

**Results:** {envelope.n_studies} studies and {payload.get('n_contrasts', 0)} contrasts formed a connected network of {len(payload.get('treatments') or [])} treatments. The reference was {payload.get('reference')}. Tau-squared was {float(payload.get('tau_squared') or 0):.4f}; the global inconsistency p-value was {_rate(payload.get('inconsistency_p'))}. Rankings were {rankings or 'not estimable'}.

**Conclusions:** The network estimates quantify comparative effects across all connected treatments. Rankings are descriptive uncertainty summaries and do not by themselves establish clinical superiority.

## Introduction

When several active treatments are available, pairwise meta-analysis cannot provide a coherent set of all comparisons. Network meta-analysis can combine direct and indirect evidence if the treatment network is connected and the distributions of effect modifiers support transitivity. The objective was to estimate all relative effects for {protocol.pico.outcome_primary}, examine inconsistency, and describe ranking uncertainty.

## Methods

### Eligibility and search

The review question was: {protocol.research_question} We identified {identified} records, retained {deduplicated} after deduplication, assessed {full_text} full texts, and included {included} studies. The final query was:

```text
{search_query or 'Not reported'}
```

### Data extraction, risk of bias, and transitivity

Each verified contrast retained treatment labels, effect and precision, study design, source quotation, and covariance with other contrasts from the same multi-arm study. The prespecified effect modifiers were {', '.join(transitivity.get('effect_modifiers') or [])}; transitivity was rated {transitivity.get('status', 'not assessed')} because {transitivity.get('rationale', 'no rationale was recorded')}. {rob_text} {certainty_text}

### Statistical analysis

Ratio measures were analyzed on the log scale in a frequentist contrast-based network model. A common heterogeneity variance was estimated by restricted maximum likelihood, with tau-squared/2 random-effects covariance for dependent contrasts from multi-arm trials. Network connectivity was required. Global inconsistency was tested with a design-by-treatment interaction model that separates within-design heterogeneity from between-design inconsistency. For every comparison with direct and indirect paths, node-splitting pooled the direct evidence and independently refitted the network after removing that direct comparison. Treatment ranking followed the prespecified outcome direction and was interpreted descriptively.

## Results

### Network geometry

The connected network contained {len(payload.get('treatments') or [])} treatments, {len((payload.get('network_geometry') or {}).get('edges') or [])} direct-comparison edges, {envelope.n_studies} studies, and {payload.get('n_contrasts', 0)} contrasts.

### League table

{league}

### Heterogeneity, inconsistency, and ranking

Tau-squared was {float(payload.get('tau_squared') or 0):.4f}. The design-by-treatment statistic was {float(dbt.get('q_inconsistency') or 0):.3f} on {int(dbt.get('df') or 0)} degree(s) of freedom (p={_rate(dbt.get('p_value'))}). Node-splitting was estimable for {split_count} comparison(s). Ranking scores were {rankings or 'not estimable'}; larger scores indicate a more favorable rank under the declared outcome direction, not certainty of superiority.

## Discussion

This network meta-analysis preserved multi-arm covariance and evaluated both the transitivity assumption and statistical inconsistency. Agreement between direct and indirect evidence strengthens coherence, whereas an inconsistency signal requires examination of effect-modifier imbalance, outcome definitions, follow-up, dose, design, and risk of bias. Sparse loops can make local tests imprecise or non-estimable. Rankings should therefore be read together with effect sizes, confidence intervals, risk of bias, and certainty rather than used as a standalone treatment hierarchy.

## Conclusions

The connected evidence network produced relative-effect estimates for all treatment pairs. Interpretation depends on the recorded transitivity assessment, global and local inconsistency diagnostics, and the uncertainty shown in the league table.

## Declarations

**Funding and conflicts of interest:** Not reported in the supplied project data.

**Data availability:** Project artifacts contain the verified aggregate contrasts, source locators, covariance matrices, transitivity assessment, method plan, and deterministic NMA outputs. No individual participant data were used.
""".strip()


def _render_network_meta_zh(*, protocol, studies, rob_results, prisma, search_query, envelope, certainty) -> str:
    payload = envelope.engine_payload
    identified, deduplicated, full_text, included = _prisma_counts(prisma, len(studies))
    rob_text = _rob_summary(rob_results, zh=True)
    certainty_text = _certainty_summary(certainty, zh=True)
    league = _network_league_table(envelope, zh=True)
    rankings = "、".join(
        f"{name} {score:.3f}" for name, score in sorted(
            (payload.get("rankings") or {}).items(), key=lambda item: (-item[1], item[0])
        )
    )
    transitivity = payload.get("transitivity_assessment") or {}
    dbt = (payload.get("diagnostics") or {}).get("design_by_treatment") or {}
    return f"""# {('、'.join(payload.get('treatments') or protocol.interventions))}的比较效果：系统评价与网络Meta分析

## 摘要

**背景：** 本评价通过直接和间接随机证据比较{protocol.pico.population}中多种治疗对{protocol.pico.outcome_primary}的效果。

**方法：** 检索{('、'.join(protocol.databases) or '预设来源')}，采用限制性最大似然的对比型随机效应网络Meta分析，保留多臂试验共享对照的协方差。基于预设效应修饰因素评价传递性，采用设计-治疗交互模型检验全局不一致性，并用重新拟合独立间接网络的节点拆分检验局部不一致性。

**结果：** {envelope.n_studies}项研究、{payload.get('n_contrasts', 0)}个对比构成{len(payload.get('treatments') or [])}种治疗的连通网络。参照治疗为{payload.get('reference')}，τ²={float(payload.get('tau_squared') or 0):.4f}，全局不一致性p值为{_rate(payload.get('inconsistency_p'))}。排序分数为{rankings or '不可估计'}。

**结论：** 网络估计给出了所有连通治疗之间的比较效果；排序仅为描述性不确定性摘要，不能单独证明临床优越性。

## 引言

当存在多种治疗时，两两Meta分析不能给出一致的全比较结果。在网络连通且效应修饰因素分布支持传递性的前提下，网络Meta分析可合并直接与间接证据。本研究估计所有相对效应，检验不一致性并描述排序不确定性。

## 方法

### 纳入标准与检索

研究问题为：{protocol.research_question}。共识别{identified}条记录，去重后{deduplicated}条，评估全文{full_text}篇，纳入{included}项研究。检索式为：

```text
{search_query or '未报告'}
```

### 数据提取、偏倚风险与传递性

逐项保存治疗标签、效应及精度、研究设计、来源引文，以及同一多臂试验内其他对比的协方差。预设效应修饰因素为{'、'.join(transitivity.get('effect_modifiers') or [])}；传递性评价为{transitivity.get('status', '未评价')}，理由为：{transitivity.get('rationale', '未记录')}。{rob_text}{certainty_text}

### 统计分析

比值类效应在log尺度分析。用限制性最大似然估计共同异质性方差，多臂试验相关对比的随机效应协方差为τ²/2。仅分析连通网络。全局不一致性采用设计-治疗交互模型，将设计内异质性与设计间不一致性分开；对同时存在直接和间接路径的比较，节点拆分先合并直接证据，再删除该直接比较并独立重拟合间接网络。治疗排序按预设结局方向计算，仅作描述性解释。

## 结果

### 网络结构

连通网络包含{len(payload.get('treatments') or [])}种治疗、{len((payload.get('network_geometry') or {}).get('edges') or [])}条直接比较边、{envelope.n_studies}项研究和{payload.get('n_contrasts', 0)}个对比。

### 联赛表

{league}

### 异质性、不一致性与排序

τ²={float(payload.get('tau_squared') or 0):.4f}。设计-治疗交互统计量为{float(dbt.get('q_inconsistency') or 0):.3f}，自由度{int(dbt.get('df') or 0)}，p={_rate(dbt.get('p_value'))}。排序分数为{rankings or '不可估计'}；分数更高表示在既定结局方向下排序更有利，而非确定优越。

## 讨论

本网络Meta分析保留了多臂协方差，并同时评价传递性与统计不一致性。若直接和间接证据不一致，应回到效应修饰因素、结局定义、随访、剂量、设计和偏倚风险查找原因。稀疏闭环可能使局部检验不精确或不可估计，因此排序必须与效应量、置信区间、偏倚风险和证据确定性共同解释。

## 结论

连通证据网络给出了全部治疗对的相对效应；解释取决于传递性评价、全局及局部不一致性诊断和联赛表中的不确定性。

## 声明

**资助与利益冲突：** 当前项目数据未报告。

**数据可得性：** 项目产物包含经核验的聚合对比、来源位置、协方差矩阵、传递性评价、方法计划和确定性网络分析输出；未使用个体参与者数据。
""".strip()


def _render_complex_rct_en(*, protocol, studies, rob_results, prisma, search_query, envelope, certainty) -> str:
    estimate = envelope.primary_estimates[0]
    effect = _effect(estimate.estimate)
    lower = _effect(estimate.ci_lower)
    upper = _effect(estimate.ci_upper)
    prediction = _effect_prediction_text(estimate, zh=False)
    identified, deduplicated, full_text, included = _prisma_counts(prisma, len(studies))
    rows = _study_table(studies, zh=False)
    rob_text = _rob_summary(rob_results, zh=False)
    certainty_text = _certainty_summary(certainty, zh=False)
    payload = envelope.engine_payload
    designs = payload.get("design_counts") or {}
    design_text = ", ".join(f"{key}: {value}" for key, value in sorted(designs.items()))
    return f"""# {protocol.pico.intervention} versus {protocol.pico.comparator} in complex randomized designs: a systematic review and meta-analysis

## Abstract

**Background:** Cluster-randomized, crossover, and multi-arm trials require design-specific precision and dependency handling. This review estimated the effect of {protocol.pico.intervention} versus {protocol.pico.comparator} on {protocol.pico.outcome_primary} without treating correlated contrasts as independent.

**Methods:** We searched {', '.join(protocol.databases) or 'the prespecified sources'}. Cluster-randomized trials contributed cluster-adjusted precision, crossover trials contributed paired effects, and dependent multi-arm contrasts were consolidated by generalized least squares using their within-study covariance. Independent study estimates were pooled by restricted maximum likelihood, with Hartung-Knapp sensitivity inference.

**Results:** {envelope.n_studies} independent studies contributed {payload.get('n_contrasts', envelope.n_studies)} contrasts. The pooled {_measure_label(estimate.measure, zh=False)} was {effect} (95% CI {lower} to {upper}){prediction}. Design composition was {design_text or 'not reported'}.

**Conclusions:** Design-aware synthesis yielded a pooled effect of {effect}. The result retains the precision corrections and covariance structure required by the included randomized designs.

## Introduction

Standard pairwise meta-analysis is biased when cluster allocation is analyzed as individual randomization, crossover pairing is ignored, or several effects sharing one control group are counted as independent. The objective was to synthesize {protocol.pico.outcome_primary} while preserving those design features.

## Methods

### Eligibility and search

The question was: {protocol.research_question} Eligible studies used cluster-randomized, crossover, or multi-arm randomized designs and estimated the same prespecified treatment contrast. The search identified {identified} records, retained {deduplicated} after deduplication, assessed {full_text} full texts, and included {included} studies. The final query was:

```text
{search_query or 'Not reported'}
```

### Data extraction and risk of bias

For every contrast we retained the reported effect, precision, design, treatment labels, analysis basis, source quotation, and locator. Cluster trials required cluster-adjusted precision or a prespecified design-effect reconstruction from the intracluster correlation and mean cluster size. Crossover trials required a paired effect. Multi-arm trials required an explicit positive-definite within-study covariance matrix and one common estimand. {rob_text} {certainty_text}

### Statistical analysis

Ratio measures were analyzed on the log scale. Correlated contrasts from the same multi-arm study were consolidated with generalized least squares before pooling, so each study contributed one independent estimate. Between-study variance was estimated by restricted maximum likelihood; the primary normal-theory interval and Hartung-Knapp sensitivity interval were retained, together with a prediction interval when estimable. Unresolved design dependencies caused analysis to stop rather than fall back to ordinary pairwise pooling.

## Results

### Included studies

{rows}

### Synthesis

The pooled {_measure_label(estimate.measure, zh=False)} was {effect} (95% CI {lower} to {upper}){prediction}. The analysis included {envelope.n_studies} independent study units and {payload.get('n_contrasts', envelope.n_studies)} verified contrasts. Tau-squared was {float(payload.get('tau_squared') or 0):.4f}, and I-squared was {float(payload.get('i_squared') or 0):.1f}%.

## Discussion

This synthesis explicitly retained cluster adjustment, within-person crossover pairing, and shared-control covariance. Its main limitation is that valid inference still depends on the source analyses: an incorrectly reported intracluster correlation, paired standard error, or covariance cannot be repaired by the meta-analysis. The common-estimand requirement also means clinically distinct doses or treatment variants must be analyzed separately.

## Conclusions

Across {envelope.n_studies} independent studies, the design-aware pooled {_measure_label(estimate.measure, zh=False)} was {effect} (95% CI {lower} to {upper}).

## Declarations

**Funding and conflicts of interest:** Not reported in the supplied project data.

**Data availability:** The project artifacts contain the verified aggregate contrasts, design adjustments, within-study covariance, analysis code inputs, and deterministic outputs. No individual participant data were used.
""".strip()


def _render_complex_rct_zh(*, protocol, studies, rob_results, prisma, search_query, envelope, certainty) -> str:
    estimate = envelope.primary_estimates[0]
    effect = _effect(estimate.estimate)
    lower = _effect(estimate.ci_lower)
    upper = _effect(estimate.ci_upper)
    prediction = _effect_prediction_text(estimate, zh=True)
    identified, deduplicated, full_text, included = _prisma_counts(prisma, len(studies))
    rows = _study_table(studies, zh=True)
    rob_text = _rob_summary(rob_results, zh=True)
    certainty_text = _certainty_summary(certainty, zh=True)
    payload = envelope.engine_payload
    return f"""# 复杂随机设计中{protocol.pico.intervention}与{protocol.pico.comparator}的比较：系统评价与Meta分析

## 摘要

**背景：** 整群随机、交叉试验和多臂试验需要保留设计特异的精度与相关结构。本评价分析{protocol.pico.outcome_primary}，不把相关效应误当作独立观察。

**方法：** 检索{('、'.join(protocol.databases) or '预设来源')}。整群随机试验使用整群校正后的精度，交叉试验使用配对效应，多臂试验依据研究内协方差用广义最小二乘合并相关对比；随后采用限制性最大似然合并独立研究，并保留Hartung-Knapp敏感性推断。

**结果：** {envelope.n_studies}项独立研究提供{payload.get('n_contrasts', envelope.n_studies)}个对比。合并{_measure_label(estimate.measure, zh=True)}为{effect}（95% CI {lower}至{upper}）{prediction}。

**结论：** 设计感知分析得到合并效应{effect}，并保留了纳入随机设计所需的精度校正和协方差结构。

## 引言

若把整群分配当作个体随机、忽略交叉试验的个体内配对，或把共享对照的多个效应视为独立，普通两两Meta分析会给出错误精度。本研究目标是在保留这些设计特征的前提下合成{protocol.pico.outcome_primary}。

## 方法

### 纳入标准与检索

研究问题为：{protocol.research_question}。共识别{identified}条记录，去重后{deduplicated}条，评估全文{full_text}篇，纳入{included}项研究。完整检索式为：

```text
{search_query or '未报告'}
```

### 数据提取与偏倚风险

逐项保存效应、精度、设计、干预标签、分析依据、来源引文和定位。整群试验必须报告整群校正精度，或提供组内相关系数与平均整群大小以计算设计效应；交叉试验必须提供配对效应；多臂试验必须提供正定的研究内协方差矩阵并对应同一估计目标。{rob_text}{certainty_text}

### 统计分析

比值类效应在log尺度分析。多臂试验的相关对比先用广义最小二乘合并，使每项研究只贡献一个独立估计；研究间方差采用限制性最大似然估计，并保留Hartung-Knapp敏感性区间及可估计时的预测区间。若设计依赖关系未解决，分析直接停止，不降级为普通两两合并。

## 结果

### 纳入研究

{rows}

### 合并结果

合并{_measure_label(estimate.measure, zh=True)}为{effect}（95% CI {lower}至{upper}）{prediction}。分析包含{envelope.n_studies}个独立研究单元和{payload.get('n_contrasts', envelope.n_studies)}个经核验对比；τ²={float(payload.get('tau_squared') or 0):.4f}，I²={float(payload.get('i_squared') or 0):.1f}%。

## 讨论

本分析显式保留整群校正、交叉试验的个体内配对和共享对照协方差。主要限制是推断仍依赖来源分析的正确性；错误的组内相关系数、配对标准误或协方差不能由Meta分析自动修复。临床上不同的剂量或治疗变体也不能仅因统计相关而强行归为同一估计目标。

## 结论

{envelope.n_studies}项独立研究的设计感知合并{_measure_label(estimate.measure, zh=True)}为{effect}（95% CI {lower}至{upper}）。

## 声明

**资助与利益冲突：** 当前项目数据未报告。

**数据可得性：** 项目产物包含经核验的聚合对比、设计校正、研究内协方差、精确分析输入和确定性输出；未使用个体参与者数据。
""".strip()


def _render_prevalence_en(*, protocol, studies, rob_results, prisma, search_query, estimate, envelope, certainty) -> str:
    condition = _prevalence_subject(protocol.pico.outcome_primary)
    pooled = _pct(estimate.estimate)
    lower = _pct(estimate.ci_lower)
    upper = _pct(estimate.ci_upper)
    prediction = _prediction_text(estimate, zh=False)
    identified, deduplicated, full_text, included = _prisma_counts(prisma, len(studies))
    total_events, total_participants = _prevalence_totals(envelope)
    rob_text = _rob_summary(rob_results, zh=False)
    rows = _study_table(studies, zh=False)
    heterogeneity = _heterogeneity_text(envelope, zh=False)
    title = f"Prevalence of {condition} in {protocol.pico.population}: a systematic review and meta-analysis"
    return f"""# {title}

## Abstract

**Background:** This review estimated the prevalence of {condition} in {protocol.pico.population} using study-level numerator and denominator data.

**Methods:** We searched {', '.join(protocol.databases) or 'the prespecified bibliographic sources'} and synthesized verified single-arm proportions with a binomial-normal generalized linear mixed model using a logit link. The review included {envelope.n_studies} studies. Statistical uncertainty is reported as a 95% confidence interval and, where estimable, a 95% prediction interval.

**Results:** Across {envelope.n_studies} studies, {total_events} events were observed among {total_participants} participants. The pooled prevalence was {pooled} (95% CI {lower} to {upper}){prediction}. {heterogeneity}

**Conclusions:** The available studies yielded a pooled prevalence of {pooled}. Interpretation should account for between-study heterogeneity, sampling-frame differences, and the risk-of-bias and certainty limitations described below.

## Introduction

The frequency of {condition} in {protocol.pico.population} is the prespecified focus of this systematic review. Prevalence estimates can differ across studies because of sampling frames, eligibility criteria, setting, measurement procedures, and case definitions. A synthesis therefore needs to preserve the binomial structure of each study rather than treat transformed proportions as ordinary continuous outcomes.

The objective was to identify eligible studies, verify each numerator and denominator against its source, assess study limitations, and estimate the pooled prevalence and its uncertainty.

## Methods

### Protocol and eligibility

The review question was: {protocol.research_question} Eligible designs were {', '.join(protocol.study_designs) or 'prespecified observational prevalence designs'}. The target population was {protocol.pico.population}, and the primary outcome was {protocol.pico.outcome_primary}.

### Information sources and search

The prespecified databases were {', '.join(protocol.databases) or 'not reported'}. The exact search query was:

```text
{search_query or 'Not reported'}
```

After deduplication, {deduplicated} records remained from {identified} identified records; {full_text} full texts were assessed and {included} studies were included in the synthesis.

### Data extraction and risk of bias

For each study, the event count, denominator, outcome definition, time point, and source locator were retained in a versioned evidence record. Only result rows with a verified source quotation or a completed human adjudication were eligible for statistical execution. {rob_text}

### Statistical analysis

The primary analysis used a binomial-normal generalized linear mixed model with a logit link and maximum-likelihood estimation. The marginal likelihood was evaluated with high-order Gauss–Hermite quadrature. The pooled logit and its Wald interval were transformed to the proportion scale. Between-study variance was estimated on the logit scale; a 95% prediction interval was reported when estimable. No transformed-proportion approximation was used for primary inference. The method plan, exact input result identifiers, source locators, ledger head hash, estimator settings, and numerical output were retained for reproducibility.

## Results

### Study selection and characteristics

The synthesis included {envelope.n_studies} studies with {total_events} events among {total_participants} participants.

{rows}

### Pooled prevalence

The pooled prevalence of {condition} was {pooled} (95% CI {lower} to {upper}){prediction}. {heterogeneity} The model convergence status was {str(envelope.execution_converged).lower()}.

### Risk of bias and certainty

{rob_text} A formal adapted certainty rating was not generated by this statistical phase; submission readiness therefore requires completion and review of the method-appropriate risk-of-bias and certainty assessments.

## Discussion

This synthesis estimated a prevalence of {pooled} for {condition} in {protocol.pico.population}. The confidence interval describes uncertainty around the mean prevalence across the included evidence, while the prediction interval describes the wider range expected for a comparable future setting when between-study heterogeneity is estimable.

The estimate should not be interpreted as a universal constant. Differences in sampling frames, geography, eligibility criteria, measurement thresholds, outcome definitions, and calendar period can change prevalence. The aggregate-data model cannot resolve unreported case-mix differences, and sparse study counts limit the reliability of heterogeneity and small-study-effect assessments. These limitations should be considered alongside the result-level source audit and risk-of-bias judgments.

Future updates should preserve the same outcome definition and time horizon, add newly eligible reports through the versioned evidence ledger, and re-run the compiled method plan without changing previously adjudicated evidence.

## Conclusions

Verified aggregate data from {envelope.n_studies} studies produced a pooled prevalence of {pooled} (95% CI {lower} to {upper}). The estimate is suitable for interpretation only together with its study-context, heterogeneity, risk-of-bias, and certainty limitations.

## Declarations

**Registration:** No registration identifier was asserted by the automated evidence record; authors should add a verified identifier if applicable.

**Funding and conflicts of interest:** Not supplied; author confirmation is required.

**Data availability:** The reproducibility package contains the search strategy, extracted aggregate data, source locators, method policy snapshot, exact statistical inputs, and analysis outputs. No individual participant data were analyzed.
""".strip()


def _render_prevalence_zh(*, protocol, studies, rob_results, prisma, search_query, estimate, envelope, certainty) -> str:
    condition = _prevalence_subject(protocol.pico.outcome_primary)
    pooled, lower, upper = _pct(estimate.estimate), _pct(estimate.ci_lower), _pct(estimate.ci_upper)
    prediction = _prediction_text(estimate, zh=True)
    identified, deduplicated, full_text, included = _prisma_counts(prisma, len(studies))
    total_events, total_participants = _prevalence_totals(envelope)
    rob_text = _rob_summary(rob_results, zh=True)
    rows = _study_table(studies, zh=True)
    heterogeneity = _heterogeneity_text(envelope, zh=True)
    return f"""# {protocol.pico.population}中{condition}的患病率：系统评价与Meta分析

## 摘要

**背景：** 本系统评价基于研究层面的分子与分母数据，估计{protocol.pico.population}中{condition}的患病率。

**方法：** 检索{('、'.join(protocol.databases) or '预先设定的文献来源')}，仅纳入来源引文已核验或已经人工裁决的单组比例数据。采用logit链接的二项-正态广义线性混合模型进行合并。

**结果：** 共纳入{envelope.n_studies}项研究，{total_participants}名参与者中发生{total_events}例。合并患病率为{pooled}（95% CI {lower}至{upper}）{prediction}。{heterogeneity}

**结论：** 当前证据的合并患病率为{pooled}；解释时需同时考虑研究间异质性、抽样框架、偏倚风险和证据确定性限制。

## 引言

本评价关注{protocol.pico.population}中{condition}的发生频率。不同研究的抽样框架、纳排标准、场景、检测流程和病例定义可能造成患病率差异，因此统计合成应保留每项研究的二项分布结构。

研究目的为系统检索合格研究，逐条核验分子、分母及来源位置，评价研究局限，并估计合并患病率及其不确定性。

## 方法

### 方案与纳入标准

研究问题为：{protocol.research_question}。目标人群为{protocol.pico.population}，主要结局为{protocol.pico.outcome_primary}。

### 信息来源与检索

预设数据库为{('、'.join(protocol.databases) or '未报告')}。完整检索式如下：

```text
{search_query or '未报告'}
```

共识别{identified}条记录，去重后{deduplicated}条，评估全文{full_text}篇，最终{included}项研究进入合成。

### 数据提取与偏倚风险

逐项保存事件数、分母、结局定义、时间点和来源位置；只有来源引文已核验或完成人工裁决的结果行才可进入统计分析。{rob_text}

### 统计分析

主要分析采用logit链接的二项-正态广义线性混合模型，以最大似然法估计，并用高阶Gauss–Hermite求积计算边际似然。将logit尺度的合并值及Wald置信区间反变换到比例尺度；研究间方差在logit尺度估计，并在可估计时报告95%预测区间。主要推断未采用变换比例的近似方法。方法计划、输入结果标识、来源位置、证据账本头哈希、估计器设置和数值输出均保留用于复现。

## 结果

### 研究筛选与特征

共纳入{envelope.n_studies}项研究，{total_participants}名参与者中发生{total_events}例。

{rows}

### 合并患病率

{condition}的合并患病率为{pooled}（95% CI {lower}至{upper}）{prediction}。{heterogeneity}模型收敛状态为{str(envelope.execution_converged).lower()}。

### 偏倚风险与确定性

{rob_text}本统计阶段未自动给出适配患病率问题的正式证据确定性等级；提交前必须完成并复核方法匹配的偏倚风险和确定性评价。

## 讨论

本研究估计{protocol.pico.population}中{condition}的患病率为{pooled}。置信区间描述平均患病率的不确定性；在能够估计研究间异质性时，预测区间描述类似未来场景中可能观察到的更宽范围。

该结果不应被解释为跨场景不变的常数。抽样框架、地区、纳排标准、检测阈值、结局定义和年代均可能改变患病率。汇总数据模型无法解决未报告的病例组合差异；研究数量较少时，异质性和小样本研究效应评价也不稳定。

后续更新应保持相同结局定义和时间范围，将新增研究写入版本化证据账本，并在不改写既往裁决记录的前提下重新执行已编译方法计划。

## 结论

{envelope.n_studies}项研究的已核验汇总数据得到合并患病率{pooled}（95% CI {lower}至{upper}）。该结果必须结合研究场景、异质性、偏倚风险和证据确定性限制进行解释。

## 声明

**注册：** 当前证据记录未声明注册号；如适用，应由作者补充经核验的注册信息。

**资助与利益冲突：** 尚未提供，需作者确认。

**数据可得性：** 复现包包含检索策略、汇总提取数据、来源位置、方法政策快照、精确统计输入和分析输出；未使用个体参与者数据。
""".strip()


def _render_incidence_en(*, protocol, studies, rob_results, prisma, search_query, estimate, envelope, certainty) -> str:
    subject = _incidence_subject(protocol.pico.outcome_primary)
    unit = _display_time_unit(envelope.engine_payload.get("time_unit"))
    pooled = _rate_per_1000(estimate.estimate, unit=unit)
    lower = _rate_per_1000(estimate.ci_lower, unit=unit)
    upper = _rate_per_1000(estimate.ci_upper, unit=unit)
    prediction = _incidence_prediction_text(estimate, unit=unit, zh=False)
    identified, deduplicated, full_text, included = _prisma_counts(prisma, len(studies))
    total_events, total_time = _incidence_totals(envelope)
    rob_text = _rob_summary(rob_results, zh=False)
    certainty_text = _certainty_summary(certainty, zh=False)
    rows = _incidence_study_table(studies, zh=False)
    heterogeneity = _heterogeneity_text(envelope, zh=False)
    native_limits = _native_rate_limits(estimate, unit=unit, zh=False)
    return f"""# Incidence of {subject} in {protocol.pico.population}: a systematic review and meta-analysis

## Abstract

**Background:** This review estimated the incidence of {subject} in {protocol.pico.population} from verified event counts and person-time denominators.

**Methods:** We searched {', '.join(protocol.databases) or 'the prespecified bibliographic sources'} and synthesized one harmonized incidence-rate stratum with a log-link Poisson-normal generalized linear mixed model. The analysis included {envelope.n_studies} studies and retained the source location for every event count, person-time denominator, and time unit.

**Results:** Across {total_time:g} {unit}, {total_events} events were observed. The pooled incidence rate was {pooled} (95% CI {lower} to {upper}){prediction}. {heterogeneity}

**Conclusions:** The available evidence yielded a pooled incidence of {pooled}. Interpretation should account for differences in surveillance, follow-up, outcome ascertainment, competing events, and the certainty assessment.

## Introduction

Incidence combines an event count with time at risk and therefore cannot be analyzed as a prevalence proportion. Differences in follow-up, surveillance intensity, outcome definitions, and censoring can materially change reported rates. This review aimed to identify eligible studies, verify the numerator and person-time denominator, harmonize the time unit, and estimate a pooled incidence rate.

## Methods

### Protocol and eligibility

The review question was: {protocol.research_question} The target population was {protocol.pico.population}, and the primary outcome was {protocol.pico.outcome_primary}. Eligible records had to report an event count, positive person-time, a defined time unit, and a source-verifiable result.

### Information sources and search

The prespecified databases were {', '.join(protocol.databases) or 'not reported'}. The exact search query was:

```text
{search_query or 'Not reported'}
```

After deduplication, {deduplicated} records remained from {identified} identified records; {full_text} full texts were assessed and {included} studies entered the synthesis.

### Data extraction and risk of bias

For each study, the event count, person-time, time unit, outcome definition, and source locator were retained in the evidence ledger. Only verified or adjudicated result rows were eligible. Mixed time units were not pooled. {rob_text}

### Statistical analysis

The primary model was a Poisson-normal generalized linear mixed model with a log link and maximum-likelihood estimation. Person-time entered as an offset. The marginal likelihood was evaluated with high-order Gauss–Hermite quadrature. The pooled log rate and Wald interval were exponentiated; between-study variance was estimated on the log-rate scale, and a 95% prediction interval was reported. All-zero strata use an exact aggregate Poisson interval because heterogeneity is not identifiable. {native_limits}

## Results

### Study selection and characteristics

The synthesis included {envelope.n_studies} studies, {total_events} events, and {total_time:g} {unit}.

{rows}

### Pooled incidence

The pooled incidence of {subject} was {pooled} (95% CI {lower} to {upper}){prediction}. {heterogeneity} Model convergence was {str(envelope.execution_converged).lower()}. {native_limits}

### Risk of bias and certainty

{rob_text}{certainty_text}

## Discussion

This synthesis preserves the Poisson event-count structure and the amount of observed person-time in each study. The confidence interval quantifies uncertainty around the mean incidence rate; the prediction interval describes the wider range expected in a comparable future setting when between-study variance is estimable.

The pooled value is not a universal background rate. Surveillance intensity, loss to follow-up, recurrent-event handling, competing risks, eligibility criteria, calendar time, and healthcare setting may all affect incidence. Aggregate person-time data cannot reconstruct individual follow-up or distinguish first from recurrent events unless the source explicitly reports that estimand.

Future updates should retain the same event definition and canonical time unit, add newly verified result rows to the ledger, and re-run the compiled Poisson-normal method without mixing prevalence or incidence-rate-ratio estimands.

## Conclusions

Verified aggregate data from {envelope.n_studies} studies produced a pooled incidence of {pooled} (95% CI {lower} to {upper}). The result should be interpreted together with its prediction interval, study context, risk of bias, and certainty rating.

## Declarations

**Registration:** No registration identifier was asserted by the evidence record; authors may add a verified identifier if applicable.

**Funding and conflicts of interest:** Not supplied.

**Data availability:** The reproducibility package contains the search strategy, source-linked event and person-time data, canonical time unit, method snapshot, exact inputs, and statistical output. No individual participant data were analyzed.
""".strip()


def _render_incidence_zh(*, protocol, studies, rob_results, prisma, search_query, estimate, envelope, certainty) -> str:
    subject = _incidence_subject(protocol.pico.outcome_primary)
    unit = _display_time_unit(envelope.engine_payload.get("time_unit"), zh=True)
    pooled = _rate_per_1000(estimate.estimate, unit=unit, zh=True)
    lower = _rate_per_1000(estimate.ci_lower, unit=unit, zh=True)
    upper = _rate_per_1000(estimate.ci_upper, unit=unit, zh=True)
    prediction = _incidence_prediction_text(estimate, unit=unit, zh=True)
    identified, deduplicated, full_text, included = _prisma_counts(prisma, len(studies))
    total_events, total_time = _incidence_totals(envelope)
    rob_text = _rob_summary(rob_results, zh=True)
    certainty_text = _certainty_summary(certainty, zh=True)
    rows = _incidence_study_table(studies, zh=True)
    heterogeneity = _heterogeneity_text(envelope, zh=True)
    native_limits = _native_rate_limits(estimate, unit=unit, zh=True)
    return f"""# {protocol.pico.population}中{subject}的发生率：系统评价与Meta分析

## 摘要

**背景：** 本评价基于经来源核验的事件数和人时分母，估计{protocol.pico.population}中{subject}的发生率。

**方法：** 检索{('、'.join(protocol.databases) or '预先设定的文献来源')}，将时间单位统一后，采用log链接的Poisson-正态广义线性混合模型合并{envelope.n_studies}项研究。

**结果：** 共观察{total_time:g}{unit}和{total_events}个事件。合并发生率为{pooled}（95% CI {lower}至{upper}）{prediction}。{heterogeneity}

**结论：** 当前证据的合并发生率为{pooled}；解释时需考虑监测方式、随访、结局确认、竞争事件和证据确定性。

## 引言

发生率由事件数和风险暴露时间共同定义，不能按患病率比例处理。监测强度、随访时间、删失、病例定义和重复事件处理均可改变报告值。本评价旨在系统检索合格研究，核验事件数、人时和时间单位，并估计合并发生率。

## 方法

### 方案与纳入标准

研究问题为：{protocol.research_question}。目标人群为{protocol.pico.population}，主要结局为{protocol.pico.outcome_primary}。纳入结果必须报告事件数、正的人时分母、明确时间单位和可核验来源。

### 信息来源与检索

预设数据库为{('、'.join(protocol.databases) or '未报告')}。完整检索式如下：

```text
{search_query or '未报告'}
```

共识别{identified}条记录，去重后{deduplicated}条，评估全文{full_text}篇，最终{included}项研究进入合成。

### 数据提取与偏倚风险

逐项保存事件数、人时、时间单位、结局定义和来源位置；只有已核验或完成人工裁决的结果行可进入分析，不合并未统一的时间单位。{rob_text}

### 统计分析

主要分析采用log链接的Poisson-正态广义线性混合模型，以人时作为offset并进行最大似然估计；使用高阶Gauss–Hermite求积计算边际似然。将合并log发生率及Wald区间指数转换，并在可估计时报告log发生率尺度的研究间方差和95%预测区间。全零事件层使用精确合并Poisson区间。{native_limits}

## 结果

### 研究筛选与特征

共纳入{envelope.n_studies}项研究、{total_events}个事件和{total_time:g}{unit}。

{rows}

### 合并发生率

{subject}的合并发生率为{pooled}（95% CI {lower}至{upper}）{prediction}。{heterogeneity}模型收敛状态为{str(envelope.execution_converged).lower()}。{native_limits}

### 偏倚风险与确定性

{rob_text}{certainty_text}

## 讨论

本分析保留各研究的Poisson事件数结构和观察人时。置信区间反映平均发生率的不确定性；预测区间反映在相似新场景中可能观察到的更宽范围。

合并值不是普适背景率。监测强度、失访、重复事件、竞争风险、纳排标准、历年变化和医疗场景均可能影响发生率。若原文未明确，聚合人时数据无法重建个体随访，也不能区分首次事件和重复事件。

后续更新应保持相同事件定义和规范时间单位，将新增经核验结果写入证据账本，并用同一Poisson-正态方法重算，不混入患病率或发生率比。

## 结论

{envelope.n_studies}项研究的经核验聚合数据得到合并发生率{pooled}（95% CI {lower}至{upper}）。应结合预测区间、研究场景、偏倚风险和确定性等级解释。

## 声明

**注册：** 当前证据记录未声明注册号；如适用可补充经核验信息。

**资助与利益冲突：** 尚未提供。

**数据可得性：** 复现包包含检索式、来源链接的事件数与人时、规范时间单位、方法快照、精确输入和统计输出；未使用个体参与者数据。
""".strip()


def _render_dta_en(*, protocol, studies, rob_results, prisma, search_query, envelope, certainty) -> str:
    estimates = {item.measure: item for item in envelope.primary_estimates}
    sensitivity, specificity = estimates["SENS"], estimates["SPEC"]
    index_test = _index_test_name(protocol.pico.intervention)
    condition = _diagnostic_condition(protocol.research_question)
    threshold = str(
        (envelope.engine_payload.get("diagnostics") or {}).get("common_threshold")
        or "not reported"
    )
    identified, deduplicated, full_text, included = _prisma_counts(prisma, len(studies))
    rows = _dta_study_table(studies, zh=False)
    rob_text = _rob_summary(rob_results, zh=False)
    certainty_text = _certainty_summary(certainty, zh=False)
    payload = envelope.engine_payload
    dor = float(payload.get("diagnostic_odds_ratio") or 0)
    auc = float(payload.get("sroc_auc") or 0)
    tau_sens = float((payload.get("model_parameters") or {}).get("tau_sensitivity") or 0)
    tau_fpr = float((payload.get("model_parameters") or {}).get("tau_false_positive_rate") or 0)
    rho = float(payload.get("between_correlation") or 0)
    corrected = int((payload.get("diagnostics") or {}).get("continuity_corrected_studies") or 0)
    return f"""# Diagnostic accuracy of {index_test} for {condition}: a systematic review and meta-analysis

## Abstract

**Background:** This review evaluated the diagnostic accuracy of {index_test} for {condition} in {protocol.pico.population}.

**Methods:** We searched {', '.join(protocol.databases) or 'the prespecified bibliographic sources'} and included verified study-level 2×2 tables reported at the common threshold {threshold}. Sensitivity and false-positive rate were synthesized jointly with a Reitsma bivariate random-effects model estimated by restricted maximum likelihood.

**Results:** The synthesis included {envelope.n_studies} studies. Summary sensitivity was {_pct(sensitivity.estimate)} (95% CI {_pct(sensitivity.ci_lower)} to {_pct(sensitivity.ci_upper)}), and summary specificity was {_pct(specificity.estimate)} (95% CI {_pct(specificity.ci_lower)} to {_pct(specificity.ci_upper)}). The diagnostic odds ratio was {dor:.2f}, and the SROC AUC was {auc:.3f}.

**Conclusions:** At the recorded common threshold {threshold}, {index_test} had the jointly estimated sensitivity and specificity reported above. Clinical use requires interpretation of both measures, the consequences of false results, applicability, heterogeneity, risk of bias, and certainty.

## Introduction

Diagnostic decisions require both the probability of a positive result among people with the target condition and the probability of a negative result among people without it. Evaluating either measure alone can hide the trade-off caused by the test threshold. This review therefore prespecified a joint synthesis of sensitivity and specificity for {index_test} against {protocol.pico.comparator or 'the reference standard'}.

The objective was to identify eligible accuracy studies, verify every 2×2 table and threshold against its source, assess limitations with QUADAS-2, and estimate summary sensitivity, specificity, and the SROC curve.

## Methods

### Protocol and eligibility

The review question was: {protocol.research_question} Eligible studies used {protocol.pico.comparator or 'an eligible reference standard'} in {protocol.pico.population} and reported a complete 2×2 table at {threshold}. Two-gate case-control studies, mixed thresholds, and rows without a recorded threshold were outside the released statistical capability.

### Information sources and search

The prespecified databases were {', '.join(protocol.databases) or 'not reported'}. The exact search query was:

```text
{search_query or 'Not reported'}
```

From {identified} identified records, {deduplicated} remained after deduplication; {full_text} full texts were assessed and {included} studies were included.

### Data extraction and risk of bias

True-positive, false-negative, false-positive, and true-negative counts, the index-test threshold, reference standard, outcome identity, and source locator were retained in a versioned evidence ledger. Only source-verified or human-adjudicated result rows were eligible. {rob_text}

### Statistical analysis

The primary analysis used the Reitsma bivariate random-effects model with logit sensitivity and logit false-positive rate as the joint outcomes. An unstructured between-study covariance matrix was estimated by restricted maximum likelihood. If any 2×2 cell was zero, the validation-locked mada-compatible rule added 0.5 to all four cells in all studies; this affected {corrected} studies. Summary specificity was calculated as one minus the modeled false-positive rate. Wald confidence intervals were transformed to the probability scale. The SROC curve and AUC used the Rutter–Gatsonis parameterization derived from the fitted Reitsma model. The method plan, exact result identifiers, source locators, ledger head hash, estimator settings, and outputs were retained for reproducibility.

## Results

### Study selection and characteristics

The synthesis included {envelope.n_studies} studies evaluated at the common threshold {threshold}.

{rows}

### Summary diagnostic accuracy

Summary sensitivity was {_pct(sensitivity.estimate)} (95% CI {_pct(sensitivity.ci_lower)} to {_pct(sensitivity.ci_upper)}), and summary specificity was {_pct(specificity.estimate)} (95% CI {_pct(specificity.ci_lower)} to {_pct(specificity.ci_upper)}). The diagnostic odds ratio was {dor:.2f}; the SROC AUC was {auc:.3f}. Between-study standard deviations were {tau_sens:.3f} for logit sensitivity and {tau_fpr:.3f} for logit false-positive rate, with correlation {rho:.3f}. Model convergence was {str(envelope.execution_converged).lower()}.

### Risk of bias and certainty

{rob_text} {certainty_text}

## Discussion

This joint model preserves the statistical relationship between sensitivity and false-positive rate and avoids treating the two measures as independent univariate outcomes. The summary values apply to the recorded threshold {threshold}; they must not be transferred to a different threshold without a separately validated multiple-threshold analysis.

The aggregate normal-normal model does not replace an exact binomial hierarchical model, individual-level threshold analysis, or a paired comparative-test model. Sparse studies, spectrum differences, reference-standard limitations, verification pathways, and selective threshold reporting may affect applicability. The SROC AUC is a model summary and should not replace threshold-specific sensitivity and specificity in clinical decisions.

Future updates should preserve test version, specimen handling, threshold, reference standard, and patient spectrum as explicit evidence entities and should re-run the compiled plan after source and QUADAS-2 adjudication.

## Conclusions

Verified aggregate data from {envelope.n_studies} studies produced summary sensitivity {_pct(sensitivity.estimate)} and specificity {_pct(specificity.estimate)} at {threshold}. Use of the result requires joint interpretation with confidence intervals, false-result consequences, applicability, risk of bias, and certainty.

## Declarations

**Registration:** No registration identifier was asserted by the automated evidence record; authors should add a verified identifier if applicable.

**Funding and conflicts of interest:** Not supplied; author confirmation is required.

**Data availability:** The reproducibility package contains the search strategy, verified 2×2 tables, thresholds, source locators, method policy snapshot, exact statistical inputs, and outputs. No individual participant data were analyzed.
""".strip()


def _render_dta_zh(*, protocol, studies, rob_results, prisma, search_query, envelope, certainty) -> str:
    estimates = {item.measure: item for item in envelope.primary_estimates}
    sensitivity, specificity = estimates["SENS"], estimates["SPEC"]
    index_test = _index_test_name(protocol.pico.intervention)
    condition = _diagnostic_condition(protocol.research_question)
    threshold = str(
        (envelope.engine_payload.get("diagnostics") or {}).get("common_threshold")
        or "未报告"
    )
    identified, deduplicated, full_text, included = _prisma_counts(prisma, len(studies))
    rows = _dta_study_table(studies, zh=True)
    rob_text = _rob_summary(rob_results, zh=True)
    certainty_text = _certainty_summary(certainty, zh=True)
    payload = envelope.engine_payload
    dor = float(payload.get("diagnostic_odds_ratio") or 0)
    auc = float(payload.get("sroc_auc") or 0)
    tau_sens = float((payload.get("model_parameters") or {}).get("tau_sensitivity") or 0)
    tau_fpr = float((payload.get("model_parameters") or {}).get("tau_false_positive_rate") or 0)
    rho = float(payload.get("between_correlation") or 0)
    corrected = int((payload.get("diagnostics") or {}).get("continuity_corrected_studies") or 0)
    return f"""# {index_test}诊断{condition}的准确性：系统评价与Meta分析

## 摘要

**背景：** 本评价评估{index_test}在{protocol.pico.population}中诊断{condition}的准确性。

**方法：** 检索{('、'.join(protocol.databases) or '预设文献来源')}，仅合并共同阈值{threshold}下来源已核验的研究层面2×2表。采用Reitsma双变量随机效应模型，以限制性最大似然法联合合并敏感度和假阳性率。

**结果：** 共纳入{envelope.n_studies}项研究。汇总敏感度为{_pct(sensitivity.estimate)}（95% CI {_pct(sensitivity.ci_lower)}至{_pct(sensitivity.ci_upper)}），汇总特异度为{_pct(specificity.estimate)}（95% CI {_pct(specificity.ci_lower)}至{_pct(specificity.ci_upper)}）。诊断比值比为{dor:.2f}，SROC AUC为{auc:.3f}。

**结论：** 在共同阈值{threshold}下，{index_test}的敏感度和特异度如上；临床解释必须同时考虑两者、错误结果后果、适用性、异质性、偏倚风险和证据确定性。

## 引言

诊断决策同时依赖患病者检测阳性的概率与非患病者检测阴性的概率。单独评价其中一项会掩盖阈值造成的权衡，因此本评价预设联合合并敏感度与特异度，并以{protocol.pico.comparator or '参考标准'}为参照。

研究目的为检索合格诊断准确性研究，逐项核验2×2表及阈值，采用QUADAS-2评价局限，并估计汇总敏感度、特异度和SROC曲线。

## 方法

### 方案与纳入标准

研究问题为：{protocol.research_question}。纳入研究需在{protocol.pico.population}中使用合格参考标准，并在{threshold}报告完整2×2表。两门式病例对照设计、混合阈值及未记录阈值的数据不属于已发布统计能力。

### 信息来源与检索

预设数据库为{('、'.join(protocol.databases) or '未报告')}。完整检索式如下：

```text
{search_query or '未报告'}
```

共识别{identified}条记录，去重后{deduplicated}条，评估全文{full_text}篇，最终纳入{included}项研究。

### 数据提取与偏倚风险

逐项保存真阳性、假阴性、假阳性、真阴性、检测阈值、参考标准、结局标识和来源位置；仅来源已核验或经人工裁决的结果行可进入分析。{rob_text}

### 统计分析

主要分析采用Reitsma双变量随机效应模型，联合建模logit敏感度与logit假阳性率，并以限制性最大似然估计无结构研究间协方差矩阵。若任一2×2格为零，采用与mada基准一致且已锁定的规则，对全部研究四格均加0.5；本次影响{corrected}项研究。特异度由1减去假阳性率得到。将Wald置信区间转换到概率尺度；SROC曲线及AUC采用由Reitsma模型推导的Rutter–Gatsonis参数化。方法计划、结果标识、来源位置、账本头哈希、估计器设置及输出均保留用于复现。

## 结果

### 研究筛选与特征

共同阈值{threshold}下共纳入{envelope.n_studies}项研究。

{rows}

### 汇总诊断准确性

汇总敏感度为{_pct(sensitivity.estimate)}（95% CI {_pct(sensitivity.ci_lower)}至{_pct(sensitivity.ci_upper)}），汇总特异度为{_pct(specificity.estimate)}（95% CI {_pct(specificity.ci_lower)}至{_pct(specificity.ci_upper)}）。诊断比值比为{dor:.2f}，SROC AUC为{auc:.3f}。logit敏感度与logit假阳性率的研究间标准差分别为{tau_sens:.3f}和{tau_fpr:.3f}，相关系数为{rho:.3f}；模型收敛状态为{str(envelope.execution_converged).lower()}。

### 偏倚风险与确定性

{rob_text}{certainty_text}

## 讨论

该联合模型保留敏感度与假阳性率之间的统计关系，避免将两者当作相互独立的单变量结局。汇总结果仅适用于记录阈值{threshold}，未经单独验证的多阈值分析不得外推至其他阈值。

汇总数据正态-正态模型不能替代精确二项分层模型、个体层面阈值分析或配对比较检测模型。患者谱、参考标准、核实路径、稀疏研究和选择性阈值报告均可能影响适用性；SROC AUC不能替代临床决策所需的阈值特异敏感度与特异度。

后续更新应将检测版本、标本处理、阈值、参考标准和患者谱作为明确证据实体，并在来源及QUADAS-2裁决后重新执行已编译方法计划。

## 结论

{envelope.n_studies}项研究的已核验汇总数据在阈值{threshold}下得到汇总敏感度{_pct(sensitivity.estimate)}和特异度{_pct(specificity.estimate)}。应用时必须同时解释置信区间、错误结果后果、适用性、偏倚风险及确定性。

## 声明

**注册：** 当前证据记录未声明注册号；如适用，应由作者补充经核验信息。

**资助与利益冲突：** 尚未提供，需作者确认。

**数据可得性：** 复现包包含检索式、已核验2×2表、阈值、来源位置、方法政策快照、精确统计输入和输出；未使用个体参与者数据。
""".strip()


def _render_nrsi_en(*, protocol, studies, rob_results, prisma, search_query, envelope, certainty) -> str:
    estimate = envelope.primary_estimates[0]
    measure = estimate.measure
    label = _measure_label(measure, zh=False)
    exposure = str(protocol.pico.intervention or "the exposure")
    outcome = str(protocol.pico.outcome_primary or "the outcome")
    adjustment_set = (envelope.engine_payload.get("adjustment_sets") or [[]])[0]
    adjustment_text = _natural_list(adjustment_set, conjunction="and") or "not reported"
    identified, deduplicated, full_text, included = _prisma_counts(prisma, len(studies))
    rows = _adjusted_study_table(studies, zh=False)
    rob_text = _rob_summary(rob_results, zh=False)
    certainty_text = _certainty_summary(certainty, zh=False)
    prediction = _effect_prediction_text(estimate, zh=False)
    tau2 = float(envelope.heterogeneity.get("tau_squared") or 0)
    i2 = float(envelope.heterogeneity.get("i_squared") or 0)
    sensitivity = envelope.engine_payload.get("sensitivity", {}).get("HKSJ", {})
    return f"""# Adjusted association of {exposure} with {outcome}: a systematic review and meta-analysis of cohort studies

## Abstract

**Background:** This review assessed the adjusted association of {exposure}, compared with {protocol.pico.comparator or 'the unexposed comparator'}, with {outcome} in {protocol.pico.population}.

**Methods:** We searched {', '.join(protocol.databases) or 'the prespecified bibliographic sources'} and pooled source-verified adjusted {label}s from cohort studies. Every included model adjusted for the same canonical covariate set: {adjustment_text}. A random-effects model was estimated by restricted maximum likelihood; Hartung-Knapp inference was retained as a sensitivity analysis.

**Results:** {envelope.n_studies} studies were synthesized. The pooled adjusted {label} was {_effect(estimate.estimate)} (95% CI {_effect(estimate.ci_lower)} to {_effect(estimate.ci_upper)}){prediction}. Between-study variance was tau-squared={tau2:.4f} and I-squared={i2:.1f}%.

**Conclusions:** The adjusted observational evidence yielded the pooled association above. It does not establish randomization or eliminate residual confounding; interpretation requires ROBINS-I, applicability, precision, reporting-bias, and certainty judgments.

## Introduction

Non-randomized evidence may be required when random allocation is unavailable, infeasible, or insufficient for the target population and time horizon. Such evidence is vulnerable to confounding and selective model reporting. A valid synthesis therefore needs to preserve the reported adjusted estimand and must not mix incompatible adjustment sets or substitute unadjusted results.

The objective was to identify eligible cohort studies, verify the reported adjusted effect and precision against each source, assess result-level risk of bias with ROBINS-I, and synthesize estimates targeting the same association.

## Methods

### Protocol and eligibility

The review question was: {protocol.research_question} Eligible studies enrolled {protocol.pico.population}, compared {exposure} with {protocol.pico.comparator or 'the prespecified comparator'}, and reported an adjusted {label} for {outcome}. The released method required one independent estimate per study and exact agreement of the canonical adjustment set.

### Information sources and search

The prespecified databases were {', '.join(protocol.databases) or 'not reported'}. The exact search query was:

```text
{search_query or 'Not reported'}
```

From {identified} identified records, {deduplicated} remained after deduplication; {full_text} full texts were assessed and {included} studies were included.

### Data extraction and risk of bias

For each result, the reported adjusted effect measure, point estimate, confidence limits or standard error, analysis scale, adjustment covariates, outcome time horizon, and source locator were retained in the versioned evidence ledger. Unadjusted estimates were not pooled. Rows without a verified quotation or completed human adjudication were ineligible. {rob_text}

### Statistical analysis

Reported {label}s were analyzed on the log scale with inverse-variance weights. The between-study variance was estimated by restricted maximum likelihood. The pooled log effect and Wald interval were exponentiated; a prediction interval was reported when estimable. Hartung-Knapp-Sidik-Jonkman inference was computed as a sensitivity analysis. The primary analysis required one effect measure, one exact canonical adjustment set ({adjustment_text}), and one independent estimate per study. No claim was made that covariate adjustment removed unmeasured or residual confounding. The method plan, result identifiers, source locators, ledger head hash, and numerical outputs were retained for reproduction.

## Results

### Study selection and characteristics

The synthesis included {envelope.n_studies} cohort studies.

{rows}

### Pooled adjusted association

The pooled adjusted {label} was {_effect(estimate.estimate)} (95% CI {_effect(estimate.ci_lower)} to {_effect(estimate.ci_upper)}){prediction}. The REML estimate of tau-squared was {tau2:.4f}, with I-squared={i2:.1f}%. The Hartung-Knapp sensitivity estimate was {_effect(sensitivity.get('estimate'))} (95% CI {_effect(sensitivity.get('ci_lower'))} to {_effect(sensitivity.get('ci_upper'))}). Model convergence was {str(envelope.execution_converged).lower()}.

### Risk of bias and certainty

{rob_text} {certainty_text}

## Discussion

This synthesis combines only source-verified adjusted estimates with a common declared adjustment set. That restriction aligns the reported models more closely than pooling whichever estimate happens to be available, but it cannot prove that the same causal estimand was identified in every study. Differences in covariate measurement, functional form, missing-data handling, exposure definition, and follow-up can remain important.

The result is an adjusted association, not a randomized treatment effect. Residual and unmeasured confounding, selection mechanisms, exposure misclassification, outcome measurement, selective model choice, and dependent estimates can bias the pooled value. The prediction interval and Hartung-Knapp analysis should be considered alongside the primary interval; neither corrects confounding.

Future updates should preserve the exact model specification and covariate definitions, adjudicate incompatible estimates before analysis, and use an explicit covariance model before including multiple effects from one study.

## Conclusions

Source-verified cohort evidence produced a pooled adjusted {label} of {_effect(estimate.estimate)} for {outcome}. The result is suitable for interpretation only as an adjusted observational association together with its ROBINS-I and GRADE limitations.

## Declarations

**Registration:** No registration identifier was asserted by the automated evidence record; authors should add a verified identifier if applicable.

**Funding and conflicts of interest:** Not supplied; author confirmation is required.

**Data availability:** The reproducibility package contains the search strategy, adjusted estimates, declared covariate sets, source locators, method snapshots, exact inputs, and outputs. No individual participant data were analyzed.
""".strip()


def _render_nrsi_zh(*, protocol, studies, rob_results, prisma, search_query, envelope, certainty) -> str:
    estimate = envelope.primary_estimates[0]
    measure = estimate.measure
    exposure = str(protocol.pico.intervention or "暴露")
    outcome = str(protocol.pico.outcome_primary or "结局")
    adjustment_set = (envelope.engine_payload.get("adjustment_sets") or [[]])[0]
    adjustment_text = "、".join(adjustment_set) or "未报告"
    identified, deduplicated, full_text, included = _prisma_counts(prisma, len(studies))
    rows = _adjusted_study_table(studies, zh=True)
    rob_text = _rob_summary(rob_results, zh=True)
    certainty_text = _certainty_summary(certainty, zh=True)
    prediction = _effect_prediction_text(estimate, zh=True)
    tau2 = float(envelope.heterogeneity.get("tau_squared") or 0)
    i2 = float(envelope.heterogeneity.get("i_squared") or 0)
    sensitivity = envelope.engine_payload.get("sensitivity", {}).get("HKSJ", {})
    return f"""# {exposure}与{outcome}的调整后关联：队列研究系统评价与Meta分析

## 摘要

**背景：** 本评价分析{protocol.pico.population}中{exposure}相对于{protocol.pico.comparator or '未暴露对照'}与{outcome}的调整后关联。

**方法：** 检索{('、'.join(protocol.databases) or '预设文献来源')}，仅合并来源已核验的队列研究调整后风险比（{measure}）。所有模型采用同一规范化调整集：{adjustment_text}。以限制性最大似然估计随机效应模型，并以Hartung-Knapp推断作为敏感性分析。

**结果：** 共合并{envelope.n_studies}项研究，调整后{measure}为{_effect(estimate.estimate)}（95% CI {_effect(estimate.ci_lower)}至{_effect(estimate.ci_upper)}）{prediction}。研究间方差τ²={tau2:.4f}，I²={i2:.1f}%。

**结论：** 当前观察性证据得到上述调整后关联；该结果不等同于随机分配，也不能消除残余混杂，必须结合ROBINS-I、适用性、精确性、报告偏倚和确定性评价解释。

## 引言

在随机分配不可获得、不可行或不足以覆盖目标人群和时间范围时，非随机证据具有价值，但容易受到混杂和选择性模型报告影响。因此，统计合成必须保存原文报告的调整后目标量，不能混合不兼容的调整集，也不能以未调整结果替代。

研究目的为检索合格队列研究，逐项核验调整后效应及其精度，采用ROBINS-I评价结果层面偏倚风险，并合并目标一致的关联估计。

## 方法

### 方案与纳入标准

研究问题为：{protocol.research_question}。纳入研究需比较{exposure}与{protocol.pico.comparator or '预设对照'}，报告{outcome}的调整后{measure}；已发布方法要求每项研究仅纳入一个独立估计，且规范化调整集完全一致。

### 信息来源与检索

预设数据库为{('、'.join(protocol.databases) or '未报告')}。完整检索式如下：

```text
{search_query or '未报告'}
```

共识别{identified}条记录，去重后{deduplicated}条，评估全文{full_text}篇，最终纳入{included}项研究。

### 数据提取与偏倚风险

逐项保存调整后效应量、点估计、置信限或标准误、分析尺度、调整协变量、结局时间范围和来源位置。未调整估计不进入合并；来源引文未核验且未经人工裁决的结果行不合格。{rob_text}

### 统计分析

在log尺度对调整后风险比进行逆方差加权，以限制性最大似然估计研究间方差，将合并值及Wald区间指数变换回比值尺度，并在可估计时报告预测区间。Hartung-Knapp-Sidik-Jonkman推断作为敏感性分析。主要分析要求同一效应量、完全相同的规范化调整集（{adjustment_text}）以及每研究一个独立估计。协变量调整不能被解释为已消除未测量或残余混杂。方法计划、结果标识、来源位置、账本头哈希和数值输出均保留用于复现。

## 结果

### 研究筛选与特征

共纳入{envelope.n_studies}项队列研究。

{rows}

### 合并调整后关联

合并调整后{measure}为{_effect(estimate.estimate)}（95% CI {_effect(estimate.ci_lower)}至{_effect(estimate.ci_upper)}）{prediction}。REML估计τ²={tau2:.4f}，I²={i2:.1f}%；Hartung-Knapp敏感性估计为{_effect(sensitivity.get('estimate'))}（95% CI {_effect(sensitivity.get('ci_lower'))}至{_effect(sensitivity.get('ci_upper'))}）。模型收敛状态为{str(envelope.execution_converged).lower()}。

### 偏倚风险与确定性

{rob_text}{certainty_text}

## 讨论

本分析仅合并来源已核验、且声明相同调整集的估计。这比任意选择可用模型更接近共同目标量，但不能证明每项研究识别了完全相同的因果效应；协变量测量、函数形式、缺失数据处理、暴露定义和随访仍可能不同。

结果属于调整后观察性关联，而非随机治疗效应。残余及未测量混杂、选择机制、暴露错分、结局测量、选择性模型报告和相关多估计均可能造成偏倚；预测区间和Hartung-Knapp分析不能纠正混杂。

后续更新应保存精确模型设定和协变量定义，在分析前裁决不兼容估计，并在纳入同一研究多个效应前建立明确协方差模型。

## 结论

来源已核验的队列证据得到{outcome}的合并调整后{measure}为{_effect(estimate.estimate)}。该结果只能作为调整后观察性关联，并结合ROBINS-I和GRADE限制解释。

## 声明

**注册：** 当前证据记录未声明注册号；如适用，应由作者补充经核验信息。

**资助与利益冲突：** 尚未提供，需作者确认。

**数据可得性：** 复现包包含检索式、调整后估计、声明的协变量集、来源位置、方法快照、精确输入和输出；未使用个体参与者数据。
""".strip()


def _render_prognostic_en(*, protocol, studies, rob_results, prisma, search_query, envelope, certainty) -> str:
    estimate = envelope.primary_estimates[0]
    factor = str(protocol.pico.intervention or "the prognostic factor")
    outcome = str(protocol.pico.outcome_primary or "the outcome")
    horizon = _common_timepoint(studies) or "the prespecified horizon"
    label = _measure_label(estimate.measure, zh=False)
    adjustment_set = (envelope.engine_payload.get("adjustment_sets") or [[]])[0]
    adjustment_text = _natural_list(adjustment_set, conjunction="and") or "not reported"
    identified, deduplicated, full_text, included = _prisma_counts(prisma, len(studies))
    rows = _adjusted_study_table(studies, zh=False)
    rob_text = _rob_summary(rob_results, zh=False)
    certainty_text = _certainty_summary(certainty, zh=False)
    prediction = _effect_prediction_text(estimate, zh=False)
    tau2 = float(envelope.heterogeneity.get("tau_squared") or 0)
    i2 = float(envelope.heterogeneity.get("i_squared") or 0)
    sensitivity = envelope.engine_payload.get("sensitivity", {}).get("HKSJ", {})
    return f"""# Prognostic association of {factor} with {outcome}: a systematic review and meta-analysis

## Abstract

**Background:** This review evaluated whether {factor}, compared with {protocol.pico.comparator or 'the reference level'}, was associated with {outcome} in {protocol.pico.population}.

**Methods:** We searched {', '.join(protocol.databases) or 'the prespecified bibliographic sources'} and pooled source-verified adjusted {label}s from prognostic cohort studies at {horizon}. All estimates used the same canonical adjustment set: {adjustment_text}. Random effects were estimated by restricted maximum likelihood, with Hartung-Knapp inference as a sensitivity analysis.

**Results:** {envelope.n_studies} studies were synthesized. The pooled adjusted {label} was {_effect(estimate.estimate)} (95% CI {_effect(estimate.ci_lower)} to {_effect(estimate.ci_upper)}){prediction}. Between-study variance was tau-squared={tau2:.4f} and I-squared={i2:.1f}%.

**Conclusions:** {factor} showed the adjusted prognostic association reported above at {horizon}. The result should be interpreted with factor measurement, case mix, model specification, QUIPS, residual confounding, and certainty limitations.

## Introduction

Prognostic-factor evidence addresses associations between a patient or disease characteristic and a future outcome. It is distinct from intervention efficacy and from prediction-model performance. Combining these studies requires a common outcome horizon, compatible factor contrast, adjusted estimand, and transparent handling of confounding.

The objective was to identify eligible prognostic cohorts, verify adjusted associations against their sources, assess result-level limitations with QUIPS, and synthesize estimates for {outcome} at {horizon}.

## Methods

### Protocol and eligibility

The review question was: {protocol.research_question} Eligible studies enrolled {protocol.pico.population}, compared {factor} with {protocol.pico.comparator or 'the prespecified reference'}, and reported an adjusted {label} for {outcome} at {horizon}. The released method required one outcome, time horizon, subgroup, effect measure, canonical adjustment set, and independent estimate per study.

### Information sources and search

The prespecified databases were {', '.join(protocol.databases) or 'not reported'}. The exact search query was:

```text
{search_query or 'Not reported'}
```

From {identified} identified records, {deduplicated} remained after deduplication; {full_text} full texts were assessed and {included} studies were included.

### Data extraction and risk of bias

The prognostic-factor definition and contrast, outcome definition, {horizon} horizon, adjusted effect and precision, analysis scale, adjustment covariates, and source locator were retained in a versioned evidence ledger. Unadjusted estimates and estimates at other horizons were not pooled. Only source-verified or human-adjudicated result rows were eligible. {rob_text}

### Statistical analysis

Source-verified adjusted {label}s were analyzed on the log scale with inverse-variance weights. Between-study variance was estimated by restricted maximum likelihood; pooled values and Wald intervals were exponentiated. A prediction interval was reported when estimable, and Hartung-Knapp-Sidik-Jonkman inference was retained as a sensitivity analysis. Exact canonical agreement was required for the adjustment set ({adjustment_text}). Pooling does not remove residual confounding or harmonize differently measured factors. The method plan, analysis set, result identifiers, source locators, ledger head hash, and outputs were retained for reproduction.

## Results

### Study selection and characteristics

The synthesis included {envelope.n_studies} prognostic cohort studies at {horizon}.

{rows}

### Pooled prognostic association

The pooled adjusted {label} was {_effect(estimate.estimate)} (95% CI {_effect(estimate.ci_lower)} to {_effect(estimate.ci_upper)}){prediction}. REML tau-squared was {tau2:.4f}, with I-squared={i2:.1f}%. The Hartung-Knapp sensitivity estimate was {_effect(sensitivity.get('estimate'))} (95% CI {_effect(sensitivity.get('ci_lower'))} to {_effect(sensitivity.get('ci_upper'))}). Model convergence was {str(envelope.execution_converged).lower()}.

### Risk of bias and certainty

{rob_text} {certainty_text}

## Discussion

This review preserves a single prognostic outcome horizon and one declared adjustment set across studies. The pooled association summarizes the available adjusted evidence but cannot establish that factor measurement, functional form, treatment context, missing-data handling, or residual confounding were identical.

The estimate is not a prediction model: it does not provide calibrated absolute risk for an individual. It also does not quantify intervention efficacy. Nonlinearity, cut-point selection, competing events, treatment after factor measurement, selective model reporting, and case-mix differences may change the association.

Future updates should retain factor assay and cut-point versions, the exact horizon, covariate definitions, model specification, and dependent-effect structure as explicit evidence entities.

## Conclusions

At {horizon}, source-verified prognostic cohorts yielded a pooled adjusted {label} of {_effect(estimate.estimate)} for the association of {factor} with {outcome}. Interpretation requires the accompanying QUIPS and certainty judgments.

## Declarations

**Registration:** No registration identifier was asserted by the automated evidence record; authors should add a verified identifier if applicable.

**Funding and conflicts of interest:** Not supplied; author confirmation is required.

**Data availability:** The reproducibility package contains the search strategy, adjusted prognostic estimates, horizons, covariate sets, source locators, method snapshots, exact inputs, and outputs. No individual participant data were analyzed.
""".strip()


def _render_prognostic_zh(*, protocol, studies, rob_results, prisma, search_query, envelope, certainty) -> str:
    estimate = envelope.primary_estimates[0]
    factor = str(protocol.pico.intervention or "预后因素")
    outcome = str(protocol.pico.outcome_primary or "结局")
    horizon = _common_timepoint(studies) or "预设时间范围"
    adjustment_set = (envelope.engine_payload.get("adjustment_sets") or [[]])[0]
    adjustment_text = "、".join(adjustment_set) or "未报告"
    identified, deduplicated, full_text, included = _prisma_counts(prisma, len(studies))
    rows = _adjusted_study_table(studies, zh=True)
    rob_text = _rob_summary(rob_results, zh=True)
    certainty_text = _certainty_summary(certainty, zh=True)
    prediction = _effect_prediction_text(estimate, zh=True)
    tau2 = float(envelope.heterogeneity.get("tau_squared") or 0)
    i2 = float(envelope.heterogeneity.get("i_squared") or 0)
    sensitivity = envelope.engine_payload.get("sensitivity", {}).get("HKSJ", {})
    return f"""# 预后因素{factor}与{outcome}的关联：系统评价与Meta分析

## 摘要

**背景：** 本评价分析{protocol.pico.population}中{factor}相对于{protocol.pico.comparator or '参考水平'}与{outcome}的预后关联。

**方法：** 检索{('、'.join(protocol.databases) or '预设文献来源')}，仅合并{horizon}时来源已核验的预后队列研究调整后风险比（{estimate.measure}）。所有估计采用同一规范化调整集：{adjustment_text}。以限制性最大似然估计随机效应，并以Hartung-Knapp推断作为敏感性分析。

**结果：** 共纳入{envelope.n_studies}项研究，合并调整后{estimate.measure}为{_effect(estimate.estimate)}（95% CI {_effect(estimate.ci_lower)}至{_effect(estimate.ci_upper)}）{prediction}。τ²={tau2:.4f}，I²={i2:.1f}%。

**结论：** {factor}在{horizon}显示上述调整后预后关联；解释时需考虑因素测量、病例组合、模型设定、QUIPS、残余混杂和证据确定性。

## 引言

预后因素研究关注患者或疾病特征与未来结局之间的关联，不等同于干预疗效或预测模型性能。有效合成要求共同结局时间范围、兼容的因素对比、调整后目标量及透明的混杂处理。

研究目的为检索合格预后队列，逐项核验调整后关联，采用QUIPS评价结果层面局限，并合并{horizon}时{outcome}的估计。

## 方法

### 方案与纳入标准

研究问题为：{protocol.research_question}。纳入研究需比较{factor}与{protocol.pico.comparator or '预设参考水平'}，并报告{horizon}时{outcome}的调整后{estimate.measure}。已发布方法要求同一结局、时间范围、亚组、效应量、规范化调整集及每研究一个独立估计。

### 信息来源与检索

预设数据库为{('、'.join(protocol.databases) or '未报告')}。完整检索式如下：

```text
{search_query or '未报告'}
```

共识别{identified}条记录，去重后{deduplicated}条，评估全文{full_text}篇，最终纳入{included}项研究。

### 数据提取与偏倚风险

逐项保存预后因素定义及对比、结局定义、{horizon}时间范围、调整后效应及精度、分析尺度、调整协变量和来源位置。未调整估计及其他时间范围估计不进入合并；仅来源已核验或人工裁决的结果行合格。{rob_text}

### 统计分析

在log尺度对来源已核验的调整后风险比进行逆方差加权，以限制性最大似然估计研究间方差，并将合并值及Wald区间指数变换；可估计时报告预测区间，Hartung-Knapp-Sidik-Jonkman推断作为敏感性分析。调整集必须完全一致（{adjustment_text}）。统计合并不能消除残余混杂，也不能自动协调不同测量方式。方法计划、分析集、结果标识、来源位置、账本头哈希及输出均保留用于复现。

## 结果

### 研究筛选与特征

{horizon}时共纳入{envelope.n_studies}项预后队列研究。

{rows}

### 合并预后关联

合并调整后{estimate.measure}为{_effect(estimate.estimate)}（95% CI {_effect(estimate.ci_lower)}至{_effect(estimate.ci_upper)}）{prediction}。REML估计τ²={tau2:.4f}，I²={i2:.1f}%；Hartung-Knapp敏感性估计为{_effect(sensitivity.get('estimate'))}（95% CI {_effect(sensitivity.get('ci_lower'))}至{_effect(sensitivity.get('ci_upper'))}）。模型收敛状态为{str(envelope.execution_converged).lower()}。

### 偏倚风险与确定性

{rob_text}{certainty_text}

## 讨论

本评价在研究间保持单一预后结局时间范围和声明的调整集。合并关联概括当前调整后证据，但不能证明因素测量、函数形式、治疗背景、缺失数据处理或残余混杂完全一致。

该估计不是预测模型，不能提供个体校准绝对风险，也不量化干预疗效。非线性、切点选择、竞争事件、因素测量后的治疗、选择性模型报告和病例组合差异均可能改变关联。

后续更新应将因素检测及切点版本、精确时间范围、协变量定义、模型设定和相关效应结构作为明确证据实体保存。

## 结论

在{horizon}，来源已核验的预后队列得到{factor}与{outcome}关联的合并调整后{estimate.measure}为{_effect(estimate.estimate)}；解释时必须结合QUIPS和证据确定性判断。

## 声明

**注册：** 当前证据记录未声明注册号；如适用，应由作者补充经核验信息。

**资助与利益冲突：** 尚未提供，需作者确认。

**数据可得性：** 复现包包含检索式、调整后预后估计、时间范围、协变量集、来源位置、方法快照、精确输入及输出；未使用个体参与者数据。
""".strip()


def _render_prediction_slope_en(
    *, protocol, studies, rob_results, prisma, search_query, envelope, certainty
) -> str:
    estimate = envelope.primary_estimates[0]
    payload = envelope.engine_payload
    model_id = str(payload.get("model_id") or protocol.pico.intervention or "the model")
    model_version = str(payload.get("model_version") or "unspecified")
    horizon = str(payload.get("time_horizon") or _common_timepoint(studies) or "not reported")
    identified, deduplicated, full_text, included = _prisma_counts(prisma, len(studies))
    rows = _prediction_study_table(studies, zh=False)
    rob_text = _rob_summary(rob_results, zh=False)
    certainty_text = _certainty_summary(certainty, zh=False)
    tau2 = float(envelope.heterogeneity.get("tau_squared") or 0)
    i2 = float(envelope.heterogeneity.get("i_squared") or 0)
    total_n = payload.get("total_participants") or "not fully reported"
    total_events = payload.get("total_events") or "not fully reported"
    pooled = _cstat(estimate.estimate)
    lower = _cstat(estimate.ci_lower)
    upper = _cstat(estimate.ci_upper)
    pred_lower = _cstat(estimate.prediction_lower)
    pred_upper = _cstat(estimate.prediction_upper)
    direction = (
        "predictions that are too extreme on average"
        if estimate.estimate < 1
        else "predictions that are not extreme enough on average"
        if estimate.estimate > 1
        else "an ideal average spread of predicted risks"
    )
    return f"""# Calibration slope of {model_id} version {model_version} for {protocol.pico.outcome_primary}: a systematic review and meta-analysis

## Abstract

**Background:** This review summarized the external-validation calibration slope of {model_id} version {model_version} for {protocol.pico.outcome_primary} in {protocol.pico.population}.

**Methods:** We searched {', '.join(protocol.databases) or 'the prespecified bibliographic sources'} and synthesized source-verified calibration slopes with reported precision at {horizon}. Slopes were pooled on their original scale using restricted maximum likelihood and Hartung-Knapp inference.

**Results:** {envelope.n_studies} external validations, including {total_n} participants and {total_events} events when fully reported, were synthesized. The pooled calibration slope was {pooled} (95% CI {lower} to {upper}); the 95% prediction interval was {pred_lower} to {pred_upper}. Tau-squared was {tau2:.4f}.

**Conclusions:** Relative to the ideal value of 1, the pooled point estimate suggests {direction}. The interval estimates include 1. Calibration slope does not establish calibration-in-the-large, discrimination, or clinical utility.

## Introduction

External validation evaluates an unchanged prediction model outside its development data. A calibration slope of 1 is ideal. A slope below 1 indicates predictions that are too extreme, whereas a slope above 1 indicates predictions that are not extreme enough. This metric complements, but does not replace, calibration-in-the-large and discrimination.

The objective was to identify external validations of the exact {model_id} version {model_version}, verify reported calibration slopes and precision, assess bias and applicability with PROBAST, and synthesize slope performance at {horizon}.

## Methods

### Protocol and eligibility

The review question was: {protocol.research_question} Eligible studies externally validated the unchanged {model_id} version {model_version} in {protocol.pico.population} for {protocol.pico.outcome_primary} at {horizon}. Development or internal-validation performance, recalibrated or updated versions, other outcomes, and other horizons were outside this analysis set.

### Information sources and search

The prespecified databases were {', '.join(protocol.databases) or 'not reported'}. The exact search query was:

```text
{search_query or 'Not reported'}
```

From {identified} identified records, {deduplicated} remained after deduplication; {full_text} full texts were assessed and {included} validations were included. Reporting was structured for a prediction-model review and should be checked against TRIPOD-SRMA before submission.

### Data extraction and risk of bias

The exact model identity and version, validation type, population, outcome, {horizon} horizon, calibration slope, standard error or confidence limits, sample size, event count, and source locator were retained in the evidence ledger. Only source-verified external validations were eligible. {rob_text}

### Statistical analysis

Calibration slopes were analyzed on the original scale, for which an approximately normal between-study distribution is recommended. Sampling variances came from source-reported standard errors or were restored from confidence limits. Between-study variance was estimated by restricted maximum likelihood. Hartung-Knapp inference with a t distribution was used for the mean slope, and the prediction interval followed metafor's t-based prediction method. No slope was reconstructed from sample size or event count alone. Exact inputs, precision sources, result identifiers, and outputs were retained for reproduction.

## Results

### Study selection and characteristics

The synthesis included {envelope.n_studies} external validations of {model_id} version {model_version} at {horizon}.

{rows}

### Pooled calibration slope

The pooled calibration slope was {pooled} (95% CI {lower} to {upper}); the 95% prediction interval was {pred_lower} to {pred_upper}. Tau-squared={tau2:.4f}, with I-squared={i2:.1f}%. Model convergence was {str(envelope.execution_converged).lower()}. The point estimate indicates {direction}, while both confidence and prediction intervals include the ideal value of 1.

### Risk of bias and certainty

{rob_text} {certainty_text}

## Discussion

The pooled slope describes the average spread of predicted risks for one exact model version and horizon. Its prediction interval indicates how calibration slope may differ in a comparable future setting. Case mix, predictor measurement, outcome ascertainment, missing-data handling, and validation methods can change this performance.

Calibration slope does not establish calibration-in-the-large, discrimination, or clinical utility. O:E or calibration intercept, c-statistic, decision-curve performance, subgroup fairness, and implementation effects were not jointly evaluated, so this result cannot by itself support deployment.

## Conclusions

Across {envelope.n_studies} external validations, {model_id} version {model_version} had a pooled calibration slope of {pooled} at {horizon}. Interpretation should retain the confidence and prediction intervals and complementary prediction-performance metrics.

## Declarations

**Registration:** No registration identifier was supplied in the review input.

**Funding and conflicts of interest:** Not supplied in the review input.

**Data availability:** The reproducibility package contains the search strategy, model identity, calibration slopes, precision data, source locators, exact analysis inputs, and outputs. No individual participant data were analyzed.
""".strip()


def _render_prediction_slope_zh(
    *, protocol, studies, rob_results, prisma, search_query, envelope, certainty
) -> str:
    estimate = envelope.primary_estimates[0]
    payload = envelope.engine_payload
    model_id = str(payload.get("model_id") or protocol.pico.intervention or "预测模型")
    model_version = str(payload.get("model_version") or "未说明")
    horizon = str(payload.get("time_horizon") or _common_timepoint(studies) or "未报告")
    identified, deduplicated, full_text, included = _prisma_counts(prisma, len(studies))
    rows = _prediction_study_table(studies, zh=True)
    rob_text = _rob_summary(rob_results, zh=True)
    certainty_text = _certainty_summary(certainty, zh=True)
    tau2 = float(envelope.heterogeneity.get("tau_squared") or 0)
    i2 = float(envelope.heterogeneity.get("i_squared") or 0)
    total_n = payload.get("total_participants") or "未完整报告"
    total_events = payload.get("total_events") or "未完整报告"
    pooled = _cstat(estimate.estimate)
    lower = _cstat(estimate.ci_lower)
    upper = _cstat(estimate.ci_upper)
    pred_lower = _cstat(estimate.prediction_lower)
    pred_upper = _cstat(estimate.prediction_upper)
    direction = (
        "预测过于极端"
        if estimate.estimate < 1
        else "预测变化幅度不足"
        if estimate.estimate > 1
        else "预测风险变化幅度平均理想"
    )
    return f"""# {model_id} {model_version}版预测{protocol.pico.outcome_primary}的校准斜率：系统评价与Meta分析

## 摘要

**背景：** 本评价汇总{model_id} {model_version}版在{protocol.pico.population}中的外部验证校准斜率。

**方法：** 检索{('、'.join(protocol.databases) or '预设文献来源')}，合并{horizon}时来源已核验且报告精度的校准斜率。在原始尺度采用限制性最大似然随机效应模型和Hartung-Knapp推断。

**结果：** 共纳入{envelope.n_studies}项外部验证；完整报告时合计{total_n}名参与者和{total_events}个事件。合并校准斜率为{pooled}（95% CI {lower}至{upper}），95%预测区间为{pred_lower}至{pred_upper}；τ²={tau2:.4f}。

**结论：** 相对于理想值1，点估计提示{direction}，但置信区间和预测区间均包含1。校准斜率不能证明总体校准、判别力或临床效用。

## 引言

外部验证评价未经改变的预测模型在开发数据之外的表现。校准斜率理想值为1；低于1表示预测过于极端，高于1表示预测变化幅度不足。它与总体校准和判别力互补，但不能替代这些指标。

研究目的为检索{model_id} {model_version}版外部验证，核验校准斜率及精度，以PROBAST评价偏倚与适用性，并合并{horizon}时的斜率性能。

## 方法

### 方案与纳入标准

研究问题为：{protocol.research_question}。纳入研究需在{protocol.pico.population}中外部验证未经改变的{model_id} {model_version}版，预测{horizon}时{protocol.pico.outcome_primary}。开发或内部验证、重校准或更新版本、其他结局及其他时间范围均不进入本分析集。

### 信息来源与检索

预设数据库为{('、'.join(protocol.databases) or '未报告')}。完整检索式如下：

```text
{search_query or '未报告'}
```

共识别{identified}条记录，去重后{deduplicated}条，评估全文{full_text}篇，最终纳入{included}项外部验证；投稿前应按TRIPOD-SRMA复核报告。

### 数据提取与偏倚风险

逐项保存模型标识及版本、验证类型、人群、结局、{horizon}时间范围、校准斜率、标准误或置信限、样本量、事件数和来源位置；仅来源已核验的外部验证合格。{rob_text}

### 统计分析

校准斜率在原始尺度合并，该尺度通常具有较合理的研究间正态分布。抽样方差来自报告标准误或由置信限恢复；不根据样本量或事件数推算斜率精度。研究间方差以限制性最大似然估计，平均斜率采用Hartung-Knapp t推断，预测区间遵循metafor的t分布方法。精确输入、精度来源、结果标识和输出均保留用于复现。

## 结果

### 研究筛选与特征

{horizon}时共纳入{envelope.n_studies}项{model_id} {model_version}版外部验证。

{rows}

### 合并校准斜率

合并校准斜率为{pooled}（95% CI {lower}至{upper}），95%预测区间为{pred_lower}至{pred_upper}。τ²={tau2:.4f}，I²={i2:.1f}%；模型收敛状态为{str(envelope.execution_converged).lower()}。点估计提示{direction}，但置信区间和预测区间均包含理想值1。

### 偏倚风险与确定性

{rob_text}{certainty_text}

## 讨论

合并斜率概括单一模型版本和时间范围内预测风险变化幅度的平均校准，并以预测区间表示相似新场景中的可能变化。病例组合、预测变量测量、结局确认、缺失数据处理和验证方法均可能影响结果。

校准斜率不能证明总体校准、判别力或临床效用。本合成未联合评价O:E或校准截距、C统计量、决策曲线、亚组公平性及实施效果，因此不能单独支持模型部署。

## 结论

{envelope.n_studies}项外部验证中，{model_id} {model_version}版在{horizon}的合并校准斜率为{pooled}。解释时应保留置信区间、预测区间和互补的预测性能指标。

## 声明

**注册：** 评价输入中未提供注册号。

**资助与利益冲突：** 评价输入中未提供。

**数据可得性：** 复现包包含检索式、模型标识、校准斜率、精度数据、来源位置、精确分析输入和输出；未使用个体参与者数据。
""".strip()


def _render_prediction_oe_en(
    *, protocol, studies, rob_results, prisma, search_query, envelope, certainty
) -> str:
    estimate = envelope.primary_estimates[0]
    payload = envelope.engine_payload
    model_id = str(payload.get("model_id") or protocol.pico.intervention or "the model")
    model_version = str(payload.get("model_version") or "unspecified")
    horizon = str(payload.get("time_horizon") or _common_timepoint(studies) or "not reported")
    identified, deduplicated, full_text, included = _prisma_counts(prisma, len(studies))
    rows = _prediction_study_table(studies, zh=False)
    rob_text = _rob_summary(rob_results, zh=False)
    certainty_text = _certainty_summary(certainty, zh=False)
    tau2 = float(envelope.heterogeneity.get("tau_squared") or 0)
    i2 = float(envelope.heterogeneity.get("i_squared") or 0)
    total_n = payload.get("total_participants") or "not fully reported"
    total_events = payload.get("total_events") or "not fully reported"
    pooled = _cstat(estimate.estimate)
    lower = _cstat(estimate.ci_lower)
    upper = _cstat(estimate.ci_upper)
    pred_lower = _cstat(estimate.prediction_lower)
    pred_upper = _cstat(estimate.prediction_upper)
    direction = (
        "more events occurred than the model expected, consistent with average risk underprediction"
        if estimate.estimate > 1
        else "fewer events occurred than the model expected, consistent with average risk overprediction"
        if estimate.estimate < 1
        else "observed and expected event totals were equal on average"
    )
    return f"""# Calibration-in-the-large of {model_id} version {model_version} for {protocol.pico.outcome_primary}: a systematic review and meta-analysis

## Abstract

**Background:** This review summarized calibration-in-the-large of {model_id} version {model_version} for {protocol.pico.outcome_primary} in {protocol.pico.population}.

**Methods:** We searched {', '.join(protocol.databases) or 'the prespecified bibliographic sources'} and synthesized source-verified observed-to-expected event ratios from external validation cohorts at {horizon}. Log O:E ratios were pooled with a normal random-effects model using restricted maximum likelihood and Hartung-Knapp inference.

**Results:** {envelope.n_studies} external validations, including {total_n} participants and {total_events} observed events when fully reported, were synthesized. The pooled observed-to-expected ratio was {pooled} (95% CI {lower} to {upper}); the 95% prediction interval was {pred_lower} to {pred_upper}. Tau-squared on the log O:E scale was {tau2:.4f}.

**Conclusions:** The pooled O:E ratio indicates that {direction}. An O:E ratio measures calibration-in-the-large only and does not establish a calibration slope, individual-risk calibration, or clinical utility.

## Introduction

External validation evaluates an unchanged prediction model in data distinct from model development. Calibration concerns agreement between predicted and observed risks. The observed-to-expected event ratio evaluates overall calibration: 1 denotes equality, values above 1 indicate more observed than expected events and average underprediction, and values below 1 indicate average overprediction.

O:E does not describe whether predictions are too extreme or too moderate across the risk range, and it does not measure ranking ability or decision consequences. The objective was to identify external validations of the exact {model_id} version {model_version}, verify observed and expected event data, assess bias and applicability with PROBAST, and synthesize calibration-in-the-large at {horizon}.

## Methods

### Protocol and eligibility

The review question was: {protocol.research_question} Eligible studies externally validated the unchanged {model_id} version {model_version} in {protocol.pico.population} for {protocol.pico.outcome_primary} at {horizon}. Development performance, internal validation, recalibrated or updated model versions, different outcomes, and different horizons were excluded from this analysis set.

### Information sources and search

The prespecified databases were {', '.join(protocol.databases) or 'not reported'}. The exact search query was:

```text
{search_query or 'Not reported'}
```

From {identified} identified records, {deduplicated} remained after deduplication; {full_text} full texts were assessed and {included} validations were included. Reporting was structured for a prediction-model review and should be checked against TRIPOD-SRMA before submission.

### Data extraction and risk of bias

The exact model identity and version, validation type, population, outcome definition, {horizon} horizon, observed events, model-expected events, sample size, any reported O:E estimate and precision, and source locator were retained in the versioned evidence ledger. Only external validations with verified quotations or completed human adjudication were eligible. {rob_text}

### Statistical analysis

The primary analysis followed the metamisc valmeta normal/log approach for O:E. For studies reporting observed events O, expected events E, and sample size N, the analysis value was log(O/E) with sampling variance (1-O/N)/O. Source-reported positive O:E ratios with standard errors or confidence limits could also be used. Studies with zero observed events required a source-reported estimate with restorable precision and were not assigned an arbitrary continuity correction. Between-study variance was estimated by restricted maximum likelihood. Hartung-Knapp inference used a t distribution for the pooled interval, and a t-based prediction interval was exponentiated back to the O:E scale. The exact model version, analysis set, result identifiers, precision source, ledger head hash, and outputs were retained for reproducibility.

## Results

### Study selection and validation characteristics

The synthesis included {envelope.n_studies} external validations of {model_id} version {model_version} at {horizon}.

{rows}

### Pooled calibration-in-the-large

The pooled observed-to-expected ratio was {pooled} (95% CI {lower} to {upper}); the 95% prediction interval was {pred_lower} to {pred_upper}. On the log observed-to-expected ratio scale, tau-squared={tau2:.4f}, with I-squared={i2:.1f}%. Model convergence was {str(envelope.execution_converged).lower()}. Relative to the ideal value of 1, {direction}.

### Risk of bias and certainty

{rob_text} {certainty_text}

## Discussion

This review isolates one exact prediction-model version and external-validation horizon. The mean O:E ratio summarizes calibration-in-the-large across included settings, while the prediction interval shows how overall calibration may vary in a comparable new setting. Differences in baseline risk, case mix, predictor measurement, missing-data handling, outcome ascertainment, and validation design can affect transportability.

The O:E ratio does not establish a calibration slope, individual-risk calibration, or clinical utility. Discrimination, calibration curves, decision-curve net benefit, subgroup fairness, usability, and implementation effects were not jointly evaluated by this metric-level synthesis. The result therefore cannot by itself support deployment or model-selection decisions.

Future reviews should synthesize compatible calibration slopes and discrimination for the same model version, outcome, and horizon, and evaluate clinical utility against explicit decision thresholds where data permit.

## Conclusions

Across {envelope.n_studies} external validations, the pooled O:E ratio for {model_id} version {model_version} was {pooled} at {horizon}. This estimates calibration-in-the-large only and should be interpreted with the prediction interval, PROBAST judgments, certainty appraisal, and complementary performance metrics.

## Declarations

**Registration:** No registration identifier was present in the automated evidence record; a verified identifier should be added if applicable.

**Funding and conflicts of interest:** Not supplied in the review inputs.

**Data availability:** The reproducibility package contains the search strategy, model identity, observed and expected event rows, precision derivations, source locators, method snapshots, exact inputs, and outputs. No individual participant data were analyzed.
""".strip()


def _render_prediction_oe_zh(
    *, protocol, studies, rob_results, prisma, search_query, envelope, certainty
) -> str:
    estimate = envelope.primary_estimates[0]
    payload = envelope.engine_payload
    model_id = str(payload.get("model_id") or protocol.pico.intervention or "预测模型")
    model_version = str(payload.get("model_version") or "未说明")
    horizon = str(payload.get("time_horizon") or _common_timepoint(studies) or "未报告")
    identified, deduplicated, full_text, included = _prisma_counts(prisma, len(studies))
    rows = _prediction_study_table(studies, zh=True)
    rob_text = _rob_summary(rob_results, zh=True)
    certainty_text = _certainty_summary(certainty, zh=True)
    tau2 = float(envelope.heterogeneity.get("tau_squared") or 0)
    i2 = float(envelope.heterogeneity.get("i_squared") or 0)
    total_n = payload.get("total_participants") or "未完整报告"
    total_events = payload.get("total_events") or "未完整报告"
    pooled = _cstat(estimate.estimate)
    lower = _cstat(estimate.ci_lower)
    upper = _cstat(estimate.ci_upper)
    pred_lower = _cstat(estimate.prediction_lower)
    pred_upper = _cstat(estimate.prediction_upper)
    direction = (
        "实际事件多于模型预期，提示模型平均低估风险"
        if estimate.estimate > 1
        else "实际事件少于模型预期，提示模型平均高估风险"
        if estimate.estimate < 1
        else "实际事件总数与模型预期平均一致"
    )
    return f"""# {model_id} {model_version}版预测{protocol.pico.outcome_primary}的总体校准：系统评价与Meta分析

## 摘要

**背景：** 本评价汇总{model_id} {model_version}版在{protocol.pico.population}中预测{protocol.pico.outcome_primary}的总体校准。

**方法：** 检索{('、'.join(protocol.databases) or '预设文献来源')}，合并{horizon}时来源已核验的外部验证观察/预期事件比（O:E）。在log O:E尺度采用正态随机效应模型，以限制性最大似然估计研究间方差，并采用Hartung-Knapp推断。

**结果：** 共纳入{envelope.n_studies}项外部验证；完整报告时合计{total_n}名参与者和{total_events}个实际事件。合并观察/预期事件比为{pooled}（95% CI {lower}至{upper}），95%预测区间为{pred_lower}至{pred_upper}；log O:E尺度τ²={tau2:.4f}。

**结论：** 合并O:E显示{direction}。O:E仅衡量总体校准，不能证明校准斜率、个体风险校准或临床效用。

## 引言

外部验证评价未经改写的预测模型在开发数据之外的表现。观察/预期事件比衡量总体校准：1表示实际与预期事件总数相等；大于1表示实际事件更多、模型平均低估风险；小于1表示模型平均高估风险。

O:E不能描述整个风险范围内预测是否过于极端或保守，也不衡量排序能力或决策后果。本研究旨在检索{model_id} {model_version}版外部验证，核验实际和预期事件数据，以PROBAST评价偏倚与适用性，并合并{horizon}时的总体校准。

## 方法

### 方案与纳入标准

研究问题为：{protocol.research_question}。纳入研究需在{protocol.pico.population}中外部验证未经改变的{model_id} {model_version}版，预测{horizon}时{protocol.pico.outcome_primary}。开发集性能、内部验证、重校准或更新版本、其他结局及其他时间范围均不进入本分析集。

### 信息来源与检索

预设数据库为{('、'.join(protocol.databases) or '未报告')}。完整检索式如下：

```text
{search_query or '未报告'}
```

共识别{identified}条记录，去重后{deduplicated}条，评估全文{full_text}篇，最终纳入{included}项外部验证；投稿前应按TRIPOD-SRMA复核报告。

### 数据提取与偏倚风险

逐项保存模型标识及版本、验证类型、人群、结局定义、{horizon}时间范围、实际事件数、模型预期事件数、样本量、报告的O:E及精度和来源位置；仅来源已核验或已完成裁决的外部验证结果行合格。{rob_text}

### 统计分析

主要分析遵循metamisc valmeta的O:E正态/log方法。对报告实际事件O、预期事件E和样本量N的研究，分析值为log(O/E)，抽样方差为(1-O/N)/O；也可使用来源明确且具有标准误或置信限的正O:E。零实际事件研究必须报告可恢复精度的估计，不任意加入连续性校正。研究间方差以限制性最大似然估计；合并区间采用Hartung-Knapp t推断，t分布预测区间反变换回O:E尺度。模型版本、分析集、结果标识、精度来源、账本头哈希及输出均保留用于复现。

## 结果

### 研究筛选与验证特征

{horizon}时共纳入{envelope.n_studies}项{model_id} {model_version}版外部验证。

{rows}

### 合并总体校准

合并观察/预期事件比为{pooled}（95% CI {lower}至{upper}），95%预测区间为{pred_lower}至{pred_upper}。log O:E尺度τ²={tau2:.4f}，I²={i2:.1f}%；模型收敛状态为{str(envelope.execution_converged).lower()}。相对于理想值1，{direction}。

### 偏倚风险与确定性

{rob_text}{certainty_text}

## 讨论

本评价锁定单一预测模型版本和外部验证时间范围。平均O:E概括纳入场景中的总体校准，预测区间显示相似新场景中总体校准的可能变化；基线风险、病例组合、预测变量测量、缺失数据处理、结局确认及验证设计均会影响可迁移性。

O:E不能证明校准斜率、个体风险校准或临床效用。本指标级合成也未联合评价判别力、校准曲线、决策曲线净获益、亚组公平性、可用性及实施效果，因此不能单独支持部署或模型选择。

后续评价应在相同模型版本、结局和时间范围内合并相容的校准斜率和判别力，并在数据允许时针对明确决策阈值评价临床效用。

## 结论

{envelope.n_studies}项外部验证中，{model_id} {model_version}版在{horizon}的合并O:E为{pooled}。该指标仅估计总体校准，解释时应结合预测区间、PROBAST、证据确定性及互补性能指标。

## 声明

**注册：** 当前证据记录未包含注册号；如适用，应补充经核验信息。

**资助与利益冲突：** 评价输入中未提供。

**数据可得性：** 复现包包含检索式、模型标识、实际和预期事件数据、精度推导、来源位置、方法快照、精确输入及输出；未使用个体参与者数据。
""".strip()


def _render_prediction_en(*, protocol, studies, rob_results, prisma, search_query, envelope, certainty) -> str:
    estimate = envelope.primary_estimates[0]
    payload = envelope.engine_payload
    model_id = str(payload.get("model_id") or protocol.pico.intervention or "the model")
    model_version = str(payload.get("model_version") or "unspecified")
    horizon = str(payload.get("time_horizon") or _common_timepoint(studies) or "not reported")
    identified, deduplicated, full_text, included = _prisma_counts(prisma, len(studies))
    rows = _prediction_study_table(studies, zh=False)
    rob_text = _rob_summary(rob_results, zh=False)
    certainty_text = _certainty_summary(certainty, zh=False)
    tau2 = float(envelope.heterogeneity.get("tau_squared") or 0)
    i2 = float(envelope.heterogeneity.get("i_squared") or 0)
    total_n = payload.get("total_participants") or "not fully reported"
    total_events = payload.get("total_events") or "not fully reported"
    return f"""# External validation performance of {model_id} version {model_version} for {protocol.pico.outcome_primary}: a systematic review and meta-analysis

## Abstract

**Background:** This review summarized external-validation discrimination of {model_id} version {model_version} for {protocol.pico.outcome_primary} in {protocol.pico.population}.

**Methods:** We searched {', '.join(protocol.databases) or 'the prespecified bibliographic sources'} and synthesized source-verified c-statistics from external validation cohorts at {horizon}. A normal random-effects model was fitted to the logit c-statistic using restricted maximum likelihood and Hartung-Knapp inference.

**Results:** {envelope.n_studies} external validations, including {total_n} participants and {total_events} events when fully reported, were synthesized. The pooled c-statistic was {estimate.estimate:.3f} (95% CI {estimate.ci_lower:.3f} to {estimate.ci_upper:.3f}); the 95% prediction interval was {estimate.prediction_lower:.3f} to {estimate.prediction_upper:.3f}. Tau-squared on the logit scale was {tau2:.4f}.

**Conclusions:** {model_id} version {model_version} showed the summarized discrimination at {horizon}. Calibration was not synthesized, and this discrimination-only result must not be used to recommend clinical deployment.

## Introduction

External validation evaluates how an unchanged prediction model performs in data distinct from model development. Discrimination measures ranking ability, whereas calibration assesses agreement between predicted and observed risks. A model can discriminate while being systematically miscalibrated, so a c-statistic alone is insufficient for implementation decisions.

The objective was to identify external validations of the exact {model_id} version {model_version}, verify reported performance and precision, assess bias and applicability with PROBAST, and synthesize discrimination at {horizon}.

## Methods

### Protocol and eligibility

The review question was: {protocol.research_question} Eligible studies externally validated the unchanged {model_id} version {model_version} in {protocol.pico.population} for {protocol.pico.outcome_primary} at {horizon}. Apparent development performance, internal validation, updated or recalibrated model versions, different outcomes, and different horizons were outside this analysis set.

### Information sources and search

The prespecified databases were {', '.join(protocol.databases) or 'not reported'}. The exact search query was:

```text
{search_query or 'Not reported'}
```

From {identified} identified records, {deduplicated} remained after deduplication; {full_text} full texts were assessed and {included} validations were included. Reporting was structured for a prediction-model review and should be checked against TRIPOD-SRMA before submission.

### Data extraction and risk of bias

The exact model identity and version, validation type, population, outcome definition, {horizon} horizon, c-statistic, standard error or confidence limits, sample size, event count, and source locator were retained in the versioned evidence ledger. Only external validations with verified quotations or completed human adjudication were eligible. {rob_text}

### Statistical analysis

The primary model followed the metamisc valmeta normal/logit approach. Each c-statistic was transformed to a logit. Reported standard errors were transformed by the delta method; when absent, precision was restored first from reported confidence limits and then, if necessary, with Newcombe method 4 using sample size and event count. Between-study variance was estimated by restricted maximum likelihood. Hartung-Knapp inference with a t distribution was used for the pooled interval, and a t-based prediction interval was transformed back to the c-statistic scale. The exact model version, analysis set, result identifiers, precision source, ledger head hash, and outputs were retained for reproducibility.

## Results

### Study selection and validation characteristics

The synthesis included {envelope.n_studies} external validations of {model_id} version {model_version} at {horizon}.

{rows}

### Pooled discrimination

The pooled c-statistic was {estimate.estimate:.3f} (95% CI {estimate.ci_lower:.3f} to {estimate.ci_upper:.3f}); the 95% prediction interval was {estimate.prediction_lower:.3f} to {estimate.prediction_upper:.3f}. On the logit c-statistic scale, tau-squared={tau2:.4f}, with I-squared={i2:.1f}%. Model convergence was {str(envelope.execution_converged).lower()}.

### Risk of bias and certainty

{rob_text} {certainty_text}

## Discussion

This review isolates one exact prediction-model version and external-validation horizon. The pooled c-statistic summarizes ranking performance across the included settings, while the prediction interval shows how discrimination may vary in a comparable new setting. Differences in case mix, predictor measurement, missing-data handling, outcome ascertainment, and validation design can affect transportability.

Calibration was not synthesized. Clinical utility, decision-curve net benefit, fairness across subgroups, usability, and implementation effects were also not evaluated by this metric-level capability. Consequently, the result must not be used to recommend clinical deployment, even if discrimination appears acceptable.

Future updates should synthesize compatible O:E ratios, calibration-in-the-large, calibration slopes, and decision-analytic performance for the same model version, outcome, and horizon, using metric-specific validated methods.

## Conclusions

Across {envelope.n_studies} external validations, {model_id} version {model_version} had a pooled c-statistic of {estimate.estimate:.3f} at {horizon}. This is a discrimination result only and requires calibration, utility, fairness, and implementation evidence before clinical use can be considered.

## Declarations

**Registration:** No registration identifier was asserted by the automated evidence record; authors should add a verified identifier if applicable.

**Funding and conflicts of interest:** Not supplied; author confirmation is required.

**Data availability:** The reproducibility package contains the search strategy, model identity, external-validation performance rows, precision derivations, source locators, method snapshots, exact inputs, and outputs. No individual participant data were analyzed.
""".strip()


def _render_prediction_zh(*, protocol, studies, rob_results, prisma, search_query, envelope, certainty) -> str:
    estimate = envelope.primary_estimates[0]
    payload = envelope.engine_payload
    model_id = str(payload.get("model_id") or protocol.pico.intervention or "预测模型")
    model_version = str(payload.get("model_version") or "未说明")
    horizon = str(payload.get("time_horizon") or _common_timepoint(studies) or "未报告")
    identified, deduplicated, full_text, included = _prisma_counts(prisma, len(studies))
    rows = _prediction_study_table(studies, zh=True)
    rob_text = _rob_summary(rob_results, zh=True)
    certainty_text = _certainty_summary(certainty, zh=True)
    tau2 = float(envelope.heterogeneity.get("tau_squared") or 0)
    i2 = float(envelope.heterogeneity.get("i_squared") or 0)
    total_n = payload.get("total_participants") or "未完整报告"
    total_events = payload.get("total_events") or "未完整报告"
    return f"""# {model_id} {model_version}版预测{protocol.pico.outcome_primary}的外部验证性能：系统评价与Meta分析

## 摘要

**背景：** 本评价汇总{model_id} {model_version}版在{protocol.pico.population}中预测{protocol.pico.outcome_primary}的外部验证判别力。

**方法：** 检索{('、'.join(protocol.databases) or '预设文献来源')}，仅合并{horizon}时来源已核验的外部验证C统计量。对logit C统计量建立正态随机效应模型，以限制性最大似然估计研究间方差，并采用Hartung-Knapp推断。

**结果：** 共纳入{envelope.n_studies}项外部验证；完整报告时合计{total_n}名参与者、{total_events}个事件。合并C统计量为{estimate.estimate:.3f}（95% CI {estimate.ci_lower:.3f}至{estimate.ci_upper:.3f}），95%预测区间为{estimate.prediction_lower:.3f}至{estimate.prediction_upper:.3f}；logit尺度τ²={tau2:.4f}。

**结论：** {model_id} {model_version}版在{horizon}的判别力如上。未合并校准，该判别力结果不得用于建议临床部署。

## 引言

外部验证评价未经改写的预测模型在开发数据之外的表现。判别力反映排序能力，校准反映预测风险与实际风险的一致程度；模型可能具有判别力但系统性失准，因此C统计量不足以支持实施决策。

研究目的为检索{model_id} {model_version}版的外部验证，逐项核验性能及精度，采用PROBAST评价偏倚与适用性，并合并{horizon}时的判别力。

## 方法

### 方案与纳入标准

研究问题为：{protocol.research_question}。纳入研究需在{protocol.pico.population}中外部验证未经改变的{model_id} {model_version}版，预测{horizon}时{protocol.pico.outcome_primary}。开发集表观性能、内部验证、更新或重校准版本、其他结局及其他时间范围不进入本分析集。

### 信息来源与检索

预设数据库为{('、'.join(protocol.databases) or '未报告')}。完整检索式如下：

```text
{search_query or '未报告'}
```

共识别{identified}条记录，去重后{deduplicated}条，评估全文{full_text}篇，最终纳入{included}项外部验证；投稿前应按TRIPOD-SRMA复核报告。

### 数据提取与偏倚风险

逐项保存模型标识及版本、验证类型、人群、结局定义、{horizon}时间范围、C统计量、标准误或置信限、样本量、事件数和来源位置；仅来源已核验或人工裁决的外部验证结果行合格。{rob_text}

### 统计分析

主要模型遵循metamisc valmeta的正态/logit方法。将C统计量转换到logit尺度；报告标准误时采用delta法转换，缺失时依次由置信限及基于样本量和事件数的Newcombe方法4恢复精度。研究间方差用限制性最大似然估计，合并区间采用Hartung-Knapp t推断，预测区间也使用t分布，最后反变换回C统计量尺度。模型版本、分析集、结果标识、精度来源、账本头哈希和输出均保留用于复现。

## 结果

### 研究筛选与验证特征

{horizon}时共纳入{envelope.n_studies}项{model_id} {model_version}版外部验证。

{rows}

### 合并判别力

合并C统计量为{estimate.estimate:.3f}（95% CI {estimate.ci_lower:.3f}至{estimate.ci_upper:.3f}），95%预测区间为{estimate.prediction_lower:.3f}至{estimate.prediction_upper:.3f}。logit C统计量尺度τ²={tau2:.4f}，I²={i2:.1f}%；模型收敛状态为{str(envelope.execution_converged).lower()}。

### 偏倚风险与确定性

{rob_text}{certainty_text}

## 讨论

本评价锁定单一预测模型版本及外部验证时间范围。合并C统计量概括纳入场景中的排序性能，预测区间显示相似新场景中的可能变化；病例组合、预测变量测量、缺失数据处理、结局确认和验证设计均会影响可迁移性。

未合并校准，也未评价决策曲线净获益、公平性、可用性或实施效果。因此，无论判别力是否可接受，该结果均不得用于建议临床部署。

后续更新应对同一模型版本、结局及时间范围的O:E比、总体校准、校准斜率和决策性能采用各自已验证的方法进行合成。

## 结论

{envelope.n_studies}项外部验证显示，{model_id} {model_version}版在{horizon}的合并C统计量为{estimate.estimate:.3f}。这仅是判别力结果，临床使用前仍需校准、效用、公平性及实施证据。

## 声明

**注册：** 当前证据记录未声明注册号；如适用，应由作者补充经核验信息。

**资助与利益冲突：** 尚未提供，需作者确认。

**数据可得性：** 复现包包含检索式、模型标识、外部验证性能行、精度推导、来源位置、方法快照、精确输入和输出；未使用个体参与者数据。
""".strip()


def _validate_method_manuscript(
    manuscript: str,
    *,
    envelope: SynthesisResultEnvelope,
    method_input_audit: dict[str, Any],
    method_certainty: dict[str, Any],
    lang: str,
) -> dict[str, Any]:
    values = []
    for estimate in envelope.primary_estimates:
        formatter = (
            _cstat
            if estimate.measure in {"OE_RATIO", "CALIBRATION_SLOPE"}
            else _pct
            if estimate.scale == "proportion"
            else _cstat
            if estimate.scale == "c_statistic"
            else _rate
            if estimate.scale == "incidence_rate"
            else _effect
        )
        values.extend([
            formatter(estimate.estimate),
            formatter(estimate.ci_lower),
            formatter(estimate.ci_upper),
        ])
        if estimate.prediction_lower is not None and estimate.prediction_upper is not None:
            values.extend([
                formatter(estimate.prediction_lower),
                formatter(estimate.prediction_upper),
            ])
    exact_values = all(value in manuscript for value in values)
    required = (
        ["## 摘要", "## 引言", "## 方法", "## 结果", "## 讨论", "## 结论", "## 声明"]
        if lang == "zh"
        else [
            "## Abstract", "## Introduction", "## Methods", "## Results",
            "## Discussion", "## Declarations",
        ]
    )
    missing_sections = [heading for heading in required if heading not in manuscript]
    if lang != "zh" and not any(
        heading in manuscript for heading in ("## Conclusion", "## Conclusions")
    ):
        missing_sections.append("## Conclusion(s)")
    inputs = method_input_audit.get("inputs") or []
    source_inputs_valid = bool(inputs) and all(
        item.get("evidence_state") in {"verified", "adjudicated"}
        and any(locator.get("quote_verified") is True for locator in item.get("source_locators") or [])
        for item in inputs
    )
    if envelope.family.value == "ipd_meta":
        forbidden_terms = ("DerSimonian-Laird", "pooled prevalence")
    elif envelope.family.value == "dose_response":
        forbidden_terms = ("DerSimonian-Laird", "pooled prevalence")
    elif envelope.family.value == "network_meta":
        forbidden_terms = ("DerSimonian-Laird", "pooled prevalence")
    elif envelope.family.value == "intervention_rct":
        forbidden_terms = ("DerSimonian-Laird", "pooled prevalence")
    elif envelope.family.value == "diagnostic_accuracy":
        forbidden_terms = (
            "DerSimonian-Laird", "risk ratio", "pooled prevalence",
            "binomial-normal generalized",
        )
    elif envelope.family.value == "intervention_nrsi":
        forbidden_terms = (
            "DerSimonian-Laird", "pooled prevalence", "randomized controlled trial",
        )
    elif envelope.family.value == "prognostic_factor":
        forbidden_terms = (
            "DerSimonian-Laird", "pooled prevalence", "treatment effect",
            "randomized controlled trial",
        )
    elif envelope.family.value == "prediction_model":
        forbidden_terms = (
            "DerSimonian-Laird", "pooled prevalence", "hazard ratio",
            "treatment effect",
        )
    else:
        forbidden_terms = ("DerSimonian-Laird", "risk ratio", "odds ratio")
    forbidden = [term for term in forbidden_terms if term.lower() in manuscript.lower()]
    issues = []
    if missing_sections:
        issues.append({"kind": "missing_sections", "severity": "error", "items": missing_sections})
    if not exact_values:
        issues.append({"kind": "result_value_mismatch", "severity": "error"})
    if not source_inputs_valid:
        issues.append({"kind": "method_inputs_not_source_verified", "severity": "error"})
    if forbidden:
        issues.append({"kind": "wrong_method_family_language", "severity": "error", "items": forbidden})
    return {
        "schema_version": 1,
        "passed": not issues,
        "method_family": envelope.family.value,
        "method_plan_fingerprint": envelope.method_plan_fingerprint,
        "method_certainty_revision": int(method_certainty.get("revision") or 0),
        "method_certainty_status": str(method_certainty.get("status") or "missing"),
        "method_certainty_synthesis_fingerprint": str(
            method_certainty.get("synthesis_fingerprint") or ""
        ),
        "method_certainty_ledger_head_hash": str(
            method_certainty.get("input_ledger_head_hash") or ""
        ),
        "exact_result_values_present": exact_values,
        "source_inputs_valid": source_inputs_valid,
        "missing_sections": missing_sections,
        "issues": issues,
        "facts_summary": {
            "report_type": "meta",
            "main_word_count": len(re.findall(r"[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)?|[\u4e00-\u9fff]", manuscript)),
            "n_studies": envelope.n_studies,
        },
    }


def _index_test_name(intervention: str) -> str:
    text = str(intervention or "the index test").strip()
    return re.sub(r"\s+at\s+.+$", "", text, flags=re.I) or "the index test"


def _diagnostic_condition(question: str) -> str:
    match = re.search(r"\bfor\s+(.+?)(?:\?|$)", str(question or ""), flags=re.I)
    return (match.group(1).strip() if match else "the target condition") or "the target condition"


def _certainty_summary(certainty: dict[str, Any], *, zh: bool) -> str:
    status = str(certainty.get("status") or "missing")
    outcomes = certainty.get("outcomes") or []
    if status != "completed" or not outcomes:
        return (
            "证据确定性评价需要人工裁决；已生成明确选项供确认。"
            if zh
            else "Certainty assessment requires human adjudication; explicit options were generated for confirmation."
        )
    ratings = [
        str(item.get("certainty") or "not assessed").replace("_", " ")
        for item in outcomes
    ]
    rating = ratings[0]
    family = str(certainty.get("family") or "")
    subject_zh = (
        "随机干预证据"
        if family == "intervention_rct"
        else "网络比较证据"
        if family == "network_meta"
        else "剂量-反应证据"
        if family == "dose_response"
        else "个体参与者数据证据"
        if family == "ipd_meta"
        else "诊断准确性证据"
        if family == "diagnostic_accuracy"
        else "调整后非随机证据"
        if family == "intervention_nrsi"
        else "预后因素证据"
        if family == "prognostic_factor"
        else "预测模型性能证据"
        if family == "prediction_model"
        else "患病率证据"
    )
    subject_en = (
        "randomized-intervention evidence"
        if family == "intervention_rct"
        else "network comparisons"
        if family == "network_meta"
        else "dose-response evidence"
        if family == "dose_response"
        else "individual-participant-data evidence"
        if family == "ipd_meta"
        else "diagnostic-accuracy evidence"
        if family == "diagnostic_accuracy"
        else "adjusted non-randomized evidence"
        if family == "intervention_nrsi"
        else "prognostic-factor evidence"
        if family == "prognostic_factor"
        else "prediction-model performance evidence"
        if family == "prediction_model"
        else "prevalence evidence"
    )
    automatic = str(certainty.get("adjudicated_by") or "").startswith("automatic:")
    if len(outcomes) > 1:
        detail_en = "; ".join(
            f"{item.get('outcome_label')}: {value}"
            for item, value in zip(outcomes, ratings)
        )
        detail_zh = "；".join(
            f"{item.get('outcome_label')}：{value}"
            for item, value in zip(outcomes, ratings)
        )
        return (
            f"采用保守自动判断后，各{subject_zh}的确定性为：{detail_zh}。"
            if zh and automatic
            else f"各{subject_zh}的确定性为：{detail_zh}。"
            if zh
            else f"Using conservative automatic judgments, certainty by {subject_en} was {detail_en}."
            if automatic
            else f"Certainty by {subject_en} was {detail_en}."
        )
    if automatic:
        return (
            f"采用保守自动判断后，{subject_zh}确定性为{rating}。"
            if zh
            else f"Using conservative automatic judgments, certainty in the {subject_en} was {rating}."
        )
    return (
        f"根据已确认的判断，{subject_zh}确定性为{rating}。"
        if zh
        else f"With the selected judgments, certainty in the {subject_en} was {rating}."
    )


def _dta_study_table(studies: list, *, zh: bool) -> str:
    headers = (
        "| 研究 | 年份 | 阈值 | TP | FN | FP | TN |\n|---|---:|---|---:|---:|---:|---:|"
        if zh
        else "| Study | Year | Threshold | TP | FN | FP | TN |\n|---|---:|---|---:|---:|---:|---:|"
    )
    rows = []
    for study in studies:
        c = study.characteristics
        outcome = next(
            (
                item for item in study.outcomes
                if all(
                    value is not None
                    for value in (
                        item.true_positive,
                        item.false_negative,
                        item.false_positive,
                        item.true_negative,
                    )
                )
            ),
            None,
        )
        author = c.authors[0].split()[0] if c.authors else (c.study_id or "Unknown")
        rows.append(
            f"| {author} | {c.year or 'NR'} | "
            f"{(outcome.diagnostic_threshold if outcome else 'NR') or 'NR'} | "
            f"{outcome.true_positive if outcome else 'NR'} | "
            f"{outcome.false_negative if outcome else 'NR'} | "
            f"{outcome.false_positive if outcome else 'NR'} | "
            f"{outcome.true_negative if outcome else 'NR'} |"
        )
    return headers + "\n" + "\n".join(rows)


def _adjusted_study_table(studies: list, *, zh: bool) -> str:
    headers = (
        "| 研究 | 年份 | 设计 | 调整后效应 | 95% CI | 调整集 |\n|---|---:|---|---:|---|---|"
        if zh
        else "| Study | Year | Design | Adjusted effect | 95% CI | Adjustment set |\n|---|---:|---|---:|---|---|"
    )
    rows = []
    for study in studies:
        c = study.characteristics
        outcome = next(
            (item for item in study.outcomes if item.reported_effect_adjusted),
            None,
        )
        author = c.authors[0].split()[0] if c.authors else (c.study_id or "Unknown")
        measure = outcome.reported_effect_measure if outcome else "NR"
        point = _effect(outcome.effect_size) if outcome else "NR"
        interval = (
            f"{_effect(outcome.ci_lower)} to {_effect(outcome.ci_upper)}"
            if outcome else "NR"
        )
        covariates = ", ".join(outcome.adjustment_covariates) if outcome else "NR"
        rows.append(
            f"| {author} | {c.year or 'NR'} | {c.study_design or 'NR'} | "
            f"{measure} {point} | {interval} | {covariates or 'NR'} |"
        )
    return headers + "\n" + "\n".join(rows)


def _prediction_study_table(studies: list, *, zh: bool) -> str:
    outcomes = [
        item
        for study in studies
        for item in study.outcomes
        if item.prediction_performance_measure
    ]
    is_oe = bool(outcomes) and all(
        item.prediction_performance_measure.upper() == "OE_RATIO" for item in outcomes
    )
    is_slope = bool(outcomes) and all(
        item.prediction_performance_measure.upper() == "CALIBRATION_SLOPE"
        for item in outcomes
    )
    if is_oe:
        headers = (
            "| 研究 | 年份 | 模型版本 | 验证类型 | 时间范围 | O:E | 实际/预期事件 | 样本量 |\n|---|---:|---|---|---|---:|---:|---:|"
            if zh
            else "| Study | Year | Model version | Validation | Horizon | O:E | Observed/expected | N |\n|---|---:|---|---|---|---:|---:|---:|"
        )
    elif is_slope:
        headers = (
            "| 研究 | 年份 | 模型版本 | 验证类型 | 时间范围 | 校准斜率 | 精度 | 样本量/事件数 |\n|---|---:|---|---|---|---:|---|---:|"
            if zh
            else "| Study | Year | Model version | Validation | Horizon | Calibration slope | Precision | N/events |\n|---|---:|---|---|---|---:|---|---:|"
        )
    else:
        headers = (
            "| 研究 | 年份 | 模型版本 | 验证类型 | 时间范围 | C统计量 | 精度 | 样本量/事件数 |\n|---|---:|---|---|---|---:|---|---:|"
            if zh
            else "| Study | Year | Model version | Validation | Horizon | C-statistic | Precision | N/events |\n|---|---:|---|---|---|---:|---|---:|"
        )
    rows = []
    for study in studies:
        c = study.characteristics
        outcome = next(
            (item for item in study.outcomes if item.prediction_performance_measure),
            None,
        )
        author = c.authors[0].split()[0] if c.authors else (c.study_id or "Unknown")
        if outcome and is_oe:
            precision = (
                f"{outcome.prediction_events if outcome.prediction_events is not None else 'NR'}/"
                f"{outcome.prediction_expected_events:g}"
                if outcome.prediction_expected_events is not None
                else "NR"
            )
            n_events = str(outcome.prediction_sample_size or "NR")
        elif outcome:
            precision = (
                f"SE {outcome.prediction_performance_se:.3f}"
                if outcome.prediction_performance_se is not None
                else (
                    f"{outcome.prediction_performance_ci_lower:.3f} to "
                    f"{outcome.prediction_performance_ci_upper:.3f}"
                    if outcome.prediction_performance_ci_lower is not None
                    and outcome.prediction_performance_ci_upper is not None
                    else "restored from N/events"
                )
            )
            n_events = f"{outcome.prediction_sample_size or 'NR'}/{outcome.prediction_events or 'NR'}"
        else:
            precision, n_events = "NR", "NR"
        point = None
        if outcome is not None:
            point = outcome.prediction_performance_estimate
            if (
                point is None
                and is_oe
                and outcome.prediction_events is not None
                and outcome.prediction_expected_events
            ):
                point = outcome.prediction_events / outcome.prediction_expected_events
        rows.append(
            f"| {author} | {c.year or 'NR'} | "
            f"{(outcome.prediction_model_version if outcome else 'NR') or 'NR'} | "
            f"{(outcome.prediction_validation_type if outcome else 'NR') or 'NR'} | "
            f"{(outcome.accepted_timepoint or outcome.timepoint if outcome else 'NR') or 'NR'} | "
            f"{_cstat(point)} | {precision} | {n_events} |"
        )
    return headers + "\n" + "\n".join(rows)


def _common_timepoint(studies: list) -> str:
    values = {
        " ".join(str(item.accepted_timepoint or item.timepoint or "").split())
        for study in studies
        for item in study.outcomes
        if str(item.accepted_timepoint or item.timepoint or "").strip()
    }
    return next(iter(values)) if len(values) == 1 else ""


def _prevalence_subject(outcome: str) -> str:
    text = re.sub(r"\s+prevalence\s*$", "", str(outcome or "").strip(), flags=re.I)
    return text or str(outcome or "the condition")


def _incidence_subject(outcome: str) -> str:
    text = re.sub(r"\s+incidence(?:\s+rate)?\s*$", "", str(outcome or "").strip(), flags=re.I)
    return text or str(outcome or "the outcome")


def _pct(value: float | None) -> str:
    return "not estimable" if value is None else f"{100 * float(value):.1f}%"


def _effect(value: float | None) -> str:
    return "not estimable" if value is None else f"{float(value):.2f}"


def _rate(value: float | None) -> str:
    return "not estimable" if value is None else f"{float(value):.6g}"


def _cstat(value: float | None) -> str:
    return "not estimable" if value is None else f"{float(value):.3f}"


def _display_time_unit(value: str | None, *, zh: bool = False) -> str:
    normalized = str(value or "person_time").strip().lower()
    if zh:
        labels = {
            "person_years": "人年",
            "person_months": "人月",
            "person_days": "人日",
            "catheter_days": "导管日",
        }
        return labels.get(normalized, normalized.replace("_", ""))
    return normalized.replace("_", "-")


def _rate_per_1000(value: float | None, *, unit: str, zh: bool = False) -> str:
    if value is None:
        return "不可估计" if zh else "not estimable"
    if zh:
        return f"每1,000{unit}{1000 * float(value):.1f}例"
    return f"{1000 * float(value):.1f} per 1,000 {unit}"


def _incidence_prediction_text(estimate, *, unit: str, zh: bool) -> str:
    if estimate.prediction_lower is None or estimate.prediction_upper is None:
        return ""
    lower = _rate_per_1000(estimate.prediction_lower, unit=unit, zh=zh)
    upper = _rate_per_1000(estimate.prediction_upper, unit=unit, zh=zh)
    return f"，95%预测区间{lower}至{upper}" if zh else f"; 95% prediction interval {lower} to {upper}"


def _native_rate_limits(estimate, *, unit: str, zh: bool) -> str:
    prediction = ""
    if estimate.prediction_lower is not None and estimate.prediction_upper is not None:
        prediction = (
            f"；95%预测区间{_rate(estimate.prediction_lower)}至{_rate(estimate.prediction_upper)}"
            if zh
            else f"; 95% prediction interval {_rate(estimate.prediction_lower)} to {_rate(estimate.prediction_upper)}"
        )
    if zh:
        return (
            f"原始单位尺度为每{unit}{_rate(estimate.estimate)}例"
            f"（95% CI {_rate(estimate.ci_lower)}至{_rate(estimate.ci_upper)}{prediction}）。"
        )
    return (
        f"On the native scale, the rate was {_rate(estimate.estimate)} per {unit} "
        f"(95% CI {_rate(estimate.ci_lower)} to {_rate(estimate.ci_upper)}{prediction})."
    )


def _measure_label(measure: str, *, zh: bool) -> str:
    labels = {
        "HR": ("hazard ratio", "风险比"),
        "RR": ("risk ratio", "风险比"),
        "OR": ("odds ratio", "比值比"),
        "IRR": ("incidence rate ratio", "发生率比"),
    }
    pair = labels.get(str(measure).upper(), (str(measure), str(measure)))
    return pair[1] if zh else pair[0]


def _natural_list(values: list[str], *, conjunction: str) -> str:
    cleaned = [str(value) for value in values if str(value).strip()]
    if len(cleaned) < 2:
        return "".join(cleaned)
    if len(cleaned) == 2:
        return f"{cleaned[0]} {conjunction} {cleaned[1]}"
    return ", ".join(cleaned[:-1]) + f", {conjunction} {cleaned[-1]}"


def _prediction_text(estimate, *, zh: bool) -> str:
    if estimate.prediction_lower is None or estimate.prediction_upper is None:
        return ""
    if zh:
        return f"，95%预测区间{_pct(estimate.prediction_lower)}至{_pct(estimate.prediction_upper)}"
    return f"; 95% prediction interval {_pct(estimate.prediction_lower)} to {_pct(estimate.prediction_upper)}"


def _effect_prediction_text(estimate, *, zh: bool) -> str:
    if estimate.prediction_lower is None or estimate.prediction_upper is None:
        return ""
    if zh:
        return f"，95%预测区间{_effect(estimate.prediction_lower)}至{_effect(estimate.prediction_upper)}"
    return (
        f"; 95% prediction interval {_effect(estimate.prediction_lower)} "
        f"to {_effect(estimate.prediction_upper)}"
    )


def _prevalence_totals(envelope: SynthesisResultEnvelope) -> tuple[int, int]:
    return (
        int(envelope.engine_payload.get("total_events") or 0),
        int(envelope.engine_payload.get("total_participants") or 0),
    )


def _incidence_totals(envelope: SynthesisResultEnvelope) -> tuple[int, float]:
    return (
        int(envelope.engine_payload.get("total_events") or 0),
        float(envelope.engine_payload.get("total_person_time") or 0.0),
    )


def _prisma_counts(prisma: dict, fallback: int) -> tuple[int, int, int, int]:
    identification = prisma.get("identification") or {}
    eligibility = prisma.get("eligibility") or {}
    included = prisma.get("included") or {}
    return (
        int(identification.get("records_identified") or prisma.get("records_identified") or 0),
        int(identification.get("records_after_dedup") or prisma.get("records_after_dedup") or 0),
        int(eligibility.get("full_text_assessed") or prisma.get("full_text_assessed") or 0),
        int(included.get("studies_included") or prisma.get("studies_included") or fallback),
    )


def _study_table(studies: list, *, zh: bool) -> str:
    headers = (
        "| 研究 | 年份 | 设计 | 国家/地区 | 样本量 | 事件数/总数 |\n|---|---:|---|---|---:|---:|"
        if zh
        else "| Study | Year | Design | Country/region | Sample size | Events/total |\n|---|---:|---|---|---:|---:|"
    )
    rows = []
    for study in studies:
        c = study.characteristics
        outcome = next(
            (item for item in study.outcomes if item.events is not None and item.total_n is not None),
            None,
        )
        author = c.authors[0].split()[0] if c.authors else (c.study_id or "Unknown")
        events_total = f"{outcome.events}/{outcome.total_n}" if outcome else "NR"
        rows.append(
            f"| {author} | {c.year or 'NR'} | {c.study_design or 'NR'} | "
            f"{c.country or 'NR'} | {c.total_sample_size or (outcome.total_n if outcome else 'NR')} | {events_total} |"
        )
    return headers + "\n" + "\n".join(rows)


def _incidence_study_table(studies: list, *, zh: bool) -> str:
    headers = (
        "| 研究 | 年份 | 设计 | 国家/地区 | 事件数 | 人时 | 时间单位 |\n|---|---:|---|---|---:|---:|---|"
        if zh
        else "| Study | Year | Design | Country/region | Events | Person-time | Time unit |\n|---|---:|---|---|---:|---:|---|"
    )
    rows = []
    for study in studies:
        c = study.characteristics
        outcome = next(
            (
                item for item in study.outcomes
                if item.events is not None and item.person_time is not None
            ),
            None,
        )
        author = c.authors[0].split()[0] if c.authors else (c.study_id or "Unknown")
        rows.append(
            f"| {author} | {c.year or 'NR'} | {c.study_design or 'NR'} | "
            f"{c.country or 'NR'} | {outcome.events if outcome else 'NR'} | "
            f"{outcome.person_time if outcome else 'NR'} | "
            f"{_display_time_unit(outcome.person_time_unit, zh=zh) if outcome else 'NR'} |"
        )
    return headers + "\n" + "\n".join(rows)


def _rob_summary(rob_results: list, *, zh: bool) -> str:
    if not rob_results:
        return (
            "尚未完成方法匹配的正式偏倚风险评价；提交前必须补充。"
            if zh
            else "A method-appropriate formal risk-of-bias assessment was not completed and is required before submission."
        )
    counts: dict[str, int] = {}
    tools = set()
    for item in rob_results:
        counts[str(item.overall_judgment or "Not assessed")] = counts.get(
            str(item.overall_judgment or "Not assessed"), 0
        ) + 1
        if item.tool_used:
            tools.add(item.tool_used)
    summary = ", ".join(f"{key}: {value}" for key, value in sorted(counts.items()))
    return (
        f"采用{'、'.join(sorted(tools)) or '设计匹配工具'}评价偏倚风险，结果为：{summary}。"
        if zh
        else f"Risk of bias was assessed with {', '.join(sorted(tools)) or 'a design-appropriate tool'}: {summary}."
    )


def _heterogeneity_text(envelope: SynthesisResultEnvelope, *, zh: bool) -> str:
    tau2 = envelope.heterogeneity.get("tau_squared")
    i2 = envelope.heterogeneity.get("i_squared")
    if tau2 is None:
        return "研究间方差不可估计。" if zh else "Between-study variance was not estimable."
    if zh:
        return f"logit尺度研究间方差τ²={float(tau2):.4f}" + (
            f"，潜在尺度I²={float(i2):.1f}%。" if i2 is not None else "。"
        )
    return f"Between-study variance on the logit scale was tau-squared={float(tau2):.4f}" + (
        f", with latent-scale I-squared={float(i2):.1f}%." if i2 is not None else "."
    )
