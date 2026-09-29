"""Reader-facing descriptions of recorded execution, never inferred from tau²."""
from new_meta.schemas.meta_result import PoolingMethod


def describe_pooling_method(method, *, zh: bool = False) -> str:
    if not method:
        return "实际合并及区间方法未记录。" if zh else "The executed pooling and interval methods were not recorded."
    if not isinstance(method, PoolingMethod):
        method = PoolingMethod.model_validate(method)
    models = {"fixed": ("固定效应逆方差合并", "fixed-effect inverse-variance pooling"),
              "random": ("随机效应逆方差合并", "random-effects inverse-variance pooling")}
    intervals = {
        "normal_wald": ("正态Wald置信区间", "normal-Wald confidence intervals"),
        "modified_hksj_t": ("修正Hartung-Knapp-Sidik-Jonkman（HKSJ）t置信区间（方差缩放因子下限为1）",
                            "modified Hartung-Knapp-Sidik-Jonkman (HKSJ) t confidence intervals (variance factor bounded below by 1)"),
        "hksj_t": ("Hartung-Knapp（HKSJ）t置信区间", "Hartung-Knapp (HKSJ) t confidence intervals"),
    }
    index = 0 if zh else 1
    model = models.get(method.model, ("未记录的合并方法", "an unrecorded pooling method"))[index]
    interval = intervals.get(method.ci_method, ("未记录的区间方法", "an unrecorded interval method"))[index]
    text = f"实际采用{model}及{interval}。" if zh else f"The analysis used {model} with {interval}."
    tau = {"REML": ("限制性最大似然（REML）", "restricted maximum likelihood (REML)"),
           "DL": ("DerSimonian-Laird（DL）", "DerSimonian-Laird (DL)")}.get(method.tau_estimator)
    if tau:
        text += f" τ²由{tau[0]}估计。" if zh else f" Tau-squared was estimated by {tau[1]}."
    elif method.tau_estimator == "none":
        text += " 合并权重未估计或使用研究间方差。" if zh else " No between-study variance was estimated or used for the pooling weights."
    if method.fallback_reason == "fewer_than_three_studies":
        text += ("贡献研究少于3项，预设随机效应方法回退为固定效应，未计算预测区间。" if zh else
                 " With fewer than three studies, the requested random-effects method fell back to fixed effects; no prediction interval was computed.")
    elif method.fallback_reason == "reml_optimizer_failed":
        text += ("REML优化失败，保留DL回退结果；不声称REML已收敛。" if zh else
                 " REML optimization failed, so the DL fallback was retained; REML convergence is not claimed.")
    return text


def sensitivity_method_text(payload: dict, *, zh: bool = False) -> str:
    sensitivity = (payload.get("sensitivity") or {}).get("HKSJ") or payload.get("hksj_sensitivity")
    if not sensitivity:
        return ""
    method = sensitivity.get("executed_method") or {}
    if method.get("fallback_reason") == "fewer_than_three_studies":
        return ("预设HKSJ敏感性分析使用同一固定效应回退，未另行计算HKSJ区间。" if zh else
                "The prespecified HKSJ sensitivity used the same fixed-effect fallback; no separate HKSJ interval was computed.")
    prefix = "敏感性分析：" if zh else "Sensitivity analysis: "
    return prefix + describe_pooling_method(method, zh=zh)


def primary_method_text(payload: dict, *, zh: bool = False) -> str:
    return " ".join(filter(None, [describe_pooling_method(payload.get("executed_method"), zh=zh),
                                   sensitivity_method_text(payload, zh=zh)]))
