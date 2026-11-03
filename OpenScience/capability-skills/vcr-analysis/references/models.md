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

`fit_survival_model` also takes `distribution: "spline"` (a Royston-Parmar model of the log cumulative hazard, `knots` 0 to 4 interior knots, 2 by default): use it when the hazard rises and falls and the parametric families cannot follow. The result is the median, the survival at each time and the restricted mean to the last time, each with an interval, and each time is marked with how many times the longest follow-up it is; beyond the follow-up it is an extrapolation. The page puts three premises beside it (how far beyond the data the last time lies, how flexible the curve was with what 0 to 3 knots give, and the straight tail the model assumes after the last knot): carry all three when you tell the user an extrapolated number, never one figure alone. The interval holds only the sampling error of this one curve; the spread between numbers of knots is model-form uncertainty and is told beside it. Fewer than 5 events per parameter, or a curve whose hazard would fall, is refused by name and the fit is not repaired. A spline has no design adapter: it cannot serve as a control distribution of a trial scenario.

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
