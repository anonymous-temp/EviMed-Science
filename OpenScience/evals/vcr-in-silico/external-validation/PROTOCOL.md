# Frozen protocol: does the Alzheimer placebo progression predict placebo arms it never saw? (plan R27, with R28)

Frozen on 2026-11-09, before the first run. `trials.json` is the trial table (every published number with its source, every assumption named),
`protocol.json` carries the SHA-256 of that table and of the three engine files the run reads, `run_external.R` is the only code that produces the result and
it refuses to run when any of them differs. The RUN file (`RUN-<date>.md`) states the commit this protocol was committed in.

## The question

The model of `patients.progression` (the CAMD ADAS-cog 11 model of adsim 3.0, Rogers et al. 2012) was fitted to nine CAMD trials, ADNI and 73 literature
references, all published up to about 2012 (`AD-SOURCE.md` of the round: Table 5 of the EMA qualification opinion). For a placebo arm of a later trial,
simulated from nothing but that trial's published baseline table, how far is the predicted mean change from the observed one, and does the model's own
predictive interval for an arm mean of that size hold it? This is external validation in the sense of ICH M15 section 3, on a small set, and says nothing about
any drug.

What "never saw" claims: the published fit (2012, qualified 2013) predates the publication of every one of these arms (IDENTITY 2013, bapineuzumab 2014,
EPOCH and idalopirdine 2018, MINDSET 2021); the fit's literature references and CAMD trials are named by neither trial nor arm in what was read. IDENTITY was
stopped in August 2010 and bapineuzumab reported its toplines in 2012, so their data existed before the fit; it is not shown that none of these arms is in the CAMD
database the fit used. The trial table does not claim more than the publication dates.

## The set (all of it, nothing chosen after seeing a result)

Placebo arms of post-2011 randomized trials in mild-to-moderate Alzheimer disease that report an ADAS-cog 11 change from baseline as a number in text or table:
bapineuzumab 301 and 302, verubecestat EPOCH, intepirdine MINDSET, idalopirdine STARSHINE, STARBEAM and STARBRIGHT, semagacestat IDENTITY: eight arms.
Left out, each with its reason, in `trials.json` (`exclusions`): the bapineuzumab 3000/3001 pair (number only in a figure), solanezumab EXPEDITION 1 and 2
(placebo change not retrievable), latrepirdine and avagacestat (no placebo numbers). Two horizons: 76 to 78 weeks (four arms), 24 weeks (four arms).

## How each arm is simulated

One `patients.progression` job per arm, the beta_logit family, from the trial's published baseline table only:

| Field | Value |
|---|---|
| `design` | nTreat = nControl = the trial's placebo N (`nSimulated`), no treatment block besides the background below; only the control arm is read |
| `model.uncertainty` | `posterior_draws`: each simulated trial draws a posterior row, a new study from it, then its people |
| `population.mmseRange` | the trial's MMSE entry criterion, uniform (a uniform over the entry range gives mean and SD close to every trial that reports them: e.g. 16-26 gives 21 (2.9) against 20.7 (3.2)); the table's own mean and SD are listed beside it in `trials.json` and in the RUN |
| `population.femaleShare`, `ageMeanByApoe4`, `ageSd` | the trial's female share; its mean age for all three genotypes; its age SD |
| `population.apoe4` | the trial's genotype shares; where a trial reports only the carrier share, the split of the carriers is the 24.8% homozygous that bapineuzumab 301 reports (an assumption, marked `assumedSplit`); where it reports nothing, the model's own covariate default |
| `treatment.background` (primary arm) | donepezil 10 mg, `weeksBefore` = 13 (the three months of stable dose the trials require before screening; stated by EPOCH, assumed for the rest), for every trial: all eight report 89 to 100% of the placebo arm on a cholinesterase inhibitor or memantine, or (IDENTITY) are assumed to; the shares below 100% are not mixed in (memantine-only people are counted as on the inhibitor, a stated simplification) |
| `dropoutModel` | `parameter_set` (the model's own: age and MMSE, not arm or outcome); the trial's real dropout is not imposed. Reported completion is listed beside the model's in the RUN as a description, never fitted |
| `visits` | 0, 13, 26, 52, 78 (76 for IDENTITY) for the long trials, 0, 12, 24 for the short ones: a stated simplification of the real schedules |
| `analysis` | what the trial reported: `mmrm` for an MMRM, a longitudinal ANCOVA or a mixed model (bapineuzumab 301/302, EPOCH, MINDSET, IDENTITY), the control arm's least-squares mean at the final visit (at the mean baseline of everyone in the analysis); `change` for an observed mean (idalopirdine), the mean of the people still in |
| `replicates` | 20,000 simulated trials per arm (the null floor of the domain), 2 cores |
| `seed` | 20261109 + 101 x the trial's position in `trials.json` |

A second primary-adjacent arm, **no background** (the same scenario without the `treatment.background` block), is run for every trial and reported beside the
primary; the primary is the background one, decided here. A third, **the second structure** (below), is reported beside both and never averaged with them.

## What is recorded and how it is summarised

Per arm: the simulated control change (mean over trials, its Monte Carlo error, SD, 2.5 / 50 / 97.5 percentiles: `controlReading`), and against the observed LS mean:

- **bias** = predicted mean - observed (positive: the model predicts more worsening than happened);
- **z** = (observed - predicted mean) / predicted SD, where the predicted SD already contains the sampling error of a mean of that many people (the trial's own
  SE is not added a second time);
- **coverage** = whether the observed value lies inside the simulated 2.5 to 97.5 percentile interval (the predictive interval of an observed arm mean).

Per horizon (76 to 78 weeks; 24 weeks) and over all eight: mean bias, mean absolute bias, RMSE, mean z, the number covered of the number of arms. Also reported
per arm, descriptions only: the model's typical-study baseline ADAS-cog against the reported baseline, and the model's share of people still observed at the last
visit against the reported completion.

**No number is tuned after the run.** If the model does badly, that is the result; the parameters, the visits, the background rule and the analysis choices
above are not revised because of what the first run shows. A run that fails (an error, a refused scenario) is reported as it is and, if the cause is a defect of
the runner or the engine, amended below by a dated line, and the whole set run again, never one arm.

## The second structure (R28)

Conrado et al., J Pharmacokinet Pharmacodyn 2014;41:581-598 (DOI 10.1007/s10928-014-9375-z): a Richards growth toward the bound of 70 with a beta residual and
covariates on the slope, fitted to CAMD control arms; engine function `vcr_conrado_trials` (`patients_progression_alternative.R`; its header says what was and
was not read, and what is omitted: the paper's tables were not open, the values are the authors' NONMEM listing as transcribed by an open model library, and the
study-level random effects are not used). Each arm is run with the trial's N, its mean baseline score as the model's baseline (with the paper's variance of the
log baseline), the trial's mean age and SD, and the genotype shares the Rogers run used, on background medication. 4,000 simulated trials per arm. Reported: the
same bias, z and coverage columns **for its own spread only**, and the difference between its predicted mean and the primary's, which is the spread between the two
structures. There is no model averaging and no weight: none is validated.

Other candidates read for R28 and why they are not run: Samtani et al. 2012 (ADAS-cog, ADNI; its parameters and covariates -- hippocampal and ventricular
volume, serum cholesterol, Trail Making B -- are behind a paywall and not in any trial's baseline table); Delor et al. 2013 is a CDR-SB model (not ADAS-cog);
Ueckert et al.'s item-response models are fitted at item level and published parameters for ADAS-cog 11 were not found open. Ito 2010 is the same family as the
primary (summary-level literature data) and is not independent.

## Not claimed

That the model is validated for any drug effect (only placebo arms); that eight arms are enough to estimate a bias with a narrow interval (the RUN gives each
number with the count behind it); that a trial's reported MMRM and the model's least-squares mean share an estimand beyond what the table above says; that the
second structure is independent data (it rests on the same CAMD database; its structure is independent).
