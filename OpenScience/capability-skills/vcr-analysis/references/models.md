# Source-bound models

Part of the vcr-analysis skill: read it with [../SKILL.md](../SKILL.md), which holds what applies to every analysis. This part is for a published equation applied to a population, a fitted survival baseline and how a source's coefficients are read.

## Source-bound model paths

Read `mcp__evimed__vcr_read` what `models`; use what `model_source` with `filter.sourceId` for
preserved numeric occurrences and exact source identity. Register executable
published equations only through their typed/source-bound profile. Explicitly
state transforms, centering, scaling, units and the Cox baseline reference.
Unknown reference or baseline cannot produce absolute Cox risks.

`fit_survival_model` fits an intercept-only population survival baseline using
exponential, Weibull, lognormal or loglogistic distributions. Reconstructed curves
remain pseudo-IPD. Select and declare the original treatment group before using a
fit as a control baseline; unobserved treatment intervals remain unknown. Fitted
curves are not individual clinical models. Current reference-patient/design
adapters cover exponential and Weibull; retain other fitted curves without
silently replacing their distributions.

`fit_survival_model` also takes `distribution: "spline"` (a Royston-Parmar model of the log cumulative hazard, `knots` 0 to 4 interior knots, 2 by default): use it when the hazard rises and falls and the parametric families cannot follow. The result is the median, the survival at each time and the restricted mean to the last time, each with an interval, and each time is marked with how many times the longest follow-up it is; beyond the follow-up it is an extrapolation. The patients page puts three premises beside it (how far beyond the data the last time lies, how flexible the curve was with what 0 to 3 knots give, and the straight tail the model assumes after the last knot): carry all three when you tell the user an extrapolated number, never one figure alone. The interval holds only the sampling error of this one curve; the spread between numbers of knots is model-form uncertainty and is told beside it. Fewer than 5 events per parameter, or a curve whose hazard would fall, is refused by name and the fit is not repaired. A median that lies beyond the longest follow-up (spline or parametric) is marked as an extrapolation (`median_beyond_follow_up`, a premise row on the patients page): say that the median was read off the curve and that nobody was observed that long. A spline has no design adapter: it cannot serve as a control distribution of a trial scenario.

`apply_prognostic_model` applies a saved, immutable linear/logistic/Cox equation to
the selected authorized baseline population. It must not change the requested
endpoint, discard a selected cohort or switch to an unrelated snapshot. Missing
predictors/units/categories stay unavailable. Published equations with fixed
coefficients do not quantify coefficient uncertainty. A continuous design needs
outcome variance including residual variance, not the SE of predicted means.

`apply_prognostic_model` can hold the equation against an outcome the table itself has: `calibration: {"outcomeColumn": "..."}` for a linear or logistic equation (a binary outcome is 0/1), `{"timeColumn": "...", "statusColumn": "..."}` for a Cox equation. The result then gives the calibration intercept (ideal 0) and slope (ideal 1) with intervals, and the observed and the predicted risk. The slope needs at least 10 events and 10 non-events (10 pairs for a continuous outcome); with fewer only the intercept is reported and the result says why, with none of one kind there is no intercept either. The outcome must be observed, never a synthetic or predicted column. It is calibration in this table, not clinical validation, and says nothing about another population: say so, and do not call the model validated.

A model card may carry TRIPOD-style words beside its inputs and limits (`developmentPopulation`, `validationStudy`, `outcomeHorizon`, `intendedUse`). Write the ones the source states; none is required, and a card without them is a card.

Trial configurations may reference a saved `modelResultId`, `modelResultVersion`
and `modelParameterQuantile` (`p10`, `p50`, `p90`, default `p50`). A grid can use
these references in `dimensions.base` and request `modelParameterQuantile: "all"`.
These are fitted-median parameter-uncertainty scenarios with shape held fixed,
not patient-time percentiles, a joint posterior or assurance. Treatment effect
always comes from separate evidence or an explicitly labeled assumption. A single
survival-risk horizon must not silently become an exponential survival curve.

## Source equation interpretation

Every coefficient binding must explicitly state `coefficientScale: "linear_predictor" | "ratio"`. Ratios must be positive and belong to Cox/logistic equations; the preserved ratio is converted once with `log_of_ratio` to canonical beta. Linear equations do not accept ratio coefficients. For nonidentity numeric predictor transforms, each center binding explicitly states `centerScale: "transformed" | "source_raw"`; raw centers undergo the same predictor transform before centering/scaling. Centered Cox baseline references require preserved numeric bindings for every center, including literal zero. A zero placeholder is never evidence of a reference mean.

## 用自己的历史数据训练预后分（`train_prognostic_model`）

用户有一张历史对照的表，问“预后分在我的人群里相关有多高，保守地能省多少样本”时用。平台不带预后模型，这里训练的是**用户自己数据上**的那一个：事件时间结局用 Cox，0/1 结局用逻辑回归，连续结局用线性回归（`endpoint.type`），每个预测因子写明单位（文本列写 `category`，每个水平一个指示项，人数少于 10 的水平没有项，也不会被点名）。
- 所有指标都是**留出折上**的（默认 5 折交叉拟合，每个人的预测来自没见过他的模型）：C 指数、AUC 或 R²，校准斜率和截距，预后分与结局的相关 rho 及区间。事件时间结局的 rho 是“风险分与到时间点前是否发生事件”的相关，只算时间点上状态已知的人，并按“没被删失的概率”的倒数加权，让时间点前就被删失的人由相似的人代表（删失多了它不会跟着变小），是近似（样本量节省的公式本来是为连续结局写的），要这样告诉用户。事件少于 10 个、或少于每个参数 5 个时（二分类结局看事件和非事件中较少的一边；事件时间结局只数事件，被删失的人多少不碍事），结果是“不可估计”，照实说，不要换一种做法凑出一个模型。
- **样本量节省的表**：rho 打 λ 折、对照组标准差放大 γ 倍时，用预后分做协变量调整，所需总人数是不调整时的几倍，和 `design.procova` 用的是同一个公式；按估计的 rho 和按它的区间下限各给一列。转述时把两列和折扣一起说，不要只报最好看的格子；节省只在预后分的相关在新人群里还成立时才有（EMA 对 PROCOVA 的意见要求先打折）。
- 保存下来的方程是用户自己数据训练的、**没有在别的人群验证过**，这句话要跟着方程一起说。随机森林只作对照，结果里的“比回归多出的区分度”接近 0 或为负，就是没有漏掉的非线性；它不保存，也不会拿去应用。方程的形状正是 `model.prognostic_apply` 接受的。要用它预测别的表里的人：用 `vcr_write what="model"` 把这次训练的结果存成模型（`card.trainedResultId` 写这个结果的 id，名字和版本自己起；卡片里的方程、终点和单位平台从结果里读，你写什么都不算），再用 `vcr_simulate` 的 `apply_prognostic_model`，`modelId`、`modelVersion` 写刚存的模型，`inputs` 和 `scenario.inputId`、`idColumn` 指向要预测的表；方程、终点、来源条件和单位平台自己填进去，不要抄系数，写了不同的方程会被拒。这个模型到哪里都带着“用你自己的历史数据训练，未经外部验证”，预测结果旁边也有这句，转述预测时要带上。要接着往下算样本量，把打过折的 rho 交给 `design.procova`。
