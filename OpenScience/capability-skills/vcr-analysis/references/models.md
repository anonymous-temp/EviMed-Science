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

`apply_prognostic_model` applies a saved, immutable linear/logistic/Cox equation to
the selected authorized baseline population. It must not change the requested
endpoint, discard a selected cohort or switch to an unrelated snapshot. Missing
predictors/units/categories stay unavailable. Published equations with fixed
coefficients do not quantify coefficient uncertainty. A continuous design needs
outcome variance including residual variance, not the SE of predicted means.

Trial configurations may reference a saved `modelResultId`, `modelResultVersion`
and `modelParameterQuantile` (`p10`, `p50`, `p90`, default `p50`). A grid can use
these references in `dimensions.base` and request `modelParameterQuantile: "all"`.
These are fitted-median parameter-uncertainty scenarios with shape held fixed,
not patient-time percentiles, a joint posterior or assurance. Treatment effect
always comes from separate evidence or an explicitly labeled assumption. A single
survival-risk horizon must not silently become an exponential survival curve.

## Source equation interpretation

Every coefficient binding must explicitly state `coefficientScale: "linear_predictor" | "ratio"`. Ratios must be positive and belong to Cox/logistic equations; the preserved ratio is converted once with `log_of_ratio` to canonical beta. Linear equations do not accept ratio coefficients. For nonidentity numeric predictor transforms, each center binding explicitly states `centerScale: "transformed" | "source_raw"`; raw centers undergo the same predictor transform before centering/scaling. Centered Cox baseline references require preserved numeric bindings for every center, including literal zero. A zero placeholder is never evidence of a reference mean.
