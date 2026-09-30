# Mean radius in malignant versus benign breast tumours

**Profiling of the supplied Wisconsin Diagnostic Breast Cancer (WDBC) dataset and an independent-sample comparison of the mean radius feature**

Analytical package: statistical analysis package
Source data: the WDBC file supplied with this task, as a CSV table of 569 records
Executed code: the analysis script re-computes every number reported below and writes a structured JSON results file and two figures. It does not write this report; the accompanying execution receipt is produced by the runner that invoked it.

---

## 1. Headline result

In the 569 supplied tumour records, mean radius is larger in malignant than in benign tumours by **5.32 units** (malignant 17.46, benign 12.15), with a **95% confidence interval of 4.85 to 5.79** from Welch's unequal-variance t interval, and **p = 1.7 × 10⁻⁶⁴** from the corresponding two-sided Welch t-test (t = 22.21, df = 289.7). Every denominator is the full 569 records: 212 malignant and 357 benign, no exclusions, no missing values.

The direction and the order of magnitude are stable under every alternative method tried — a pooled-variance t interval (4.91 to 5.73), a 10,000-resample bootstrap percentile interval (4.86 to 5.79), and a rank-based Mann-Whitney test (p = 2.7 × 10⁻⁶⁸). One caveat governs interpretation much more than the choice of test does: **the two groups' distributions overlap over most of their range.** 115 of the 212 malignant records (54%) fall below the largest benign value, and the best single cut-point on this one feature placed correctly only 507 of the 569 records in this sample — 62 records, about 11%, are on the wrong side of it. Mean radius therefore separates these groups on average; it does not identify which group an individual record belongs to.

---

## 2. Target coding

**The target column is `breast_cancer_yn`, coded 0 = malignant and 1 = benign.** The coding is not self-evident from the column name, which reads as a yes/no flag and does not say which of "yes" and "no" is malignancy. **The supplied source metadata states the encoding directly** — its coding field maps 0 to malignant and 1 to benign — and that statement, not anything computed here, is what establishes the category meanings used throughout this report. Corroborating it, the repository that distributes the underlying dataset describes its target as `Diagnosis`, a categorical variable with values M = malignant and B = benign [4], and the supplied file has re-encoded that variable numerically. Because a direction error would invert the sign of the entire comparison, three checks were run against the data: they test whether the measurements are *consistent with* the declared encoding, and all three are.

1. **Feature direction.** Comparing the two groups' means one feature at a time, the label-0 mean exceeds the label-1 mean on **26 of 30 features**; the remaining **4** go the other way (and 26 + 4 exhausts the 30 features, which the analysis script asserts). The comparison is made on values standardised within the whole sample — each feature's 569-record mean subtracted and its standard deviation divided out — which puts the 30 features on a common scale. That standardisation is a single linear rescaling of all 569 records and so cannot change which group is the larger for any feature; the counts would be identical on the raw scale. This is the pattern expected if label 0 is the group with enlarged, more irregular nuclei, which is a description of the malignant phenotype. The four exceptions are low-variance shape and texture measures.
2. **Level of the analysis variable.** Label 0 has the larger mean radius: **17.46 versus 12.15**.
3. **Class sizes.** The supplied file contains **212 records labelled 0 and 357 labelled 1**. These match the class sizes of the published WDBC cohort (212 malignant, 357 benign) and 569 records in total.

These checks are consistency checks, not proof. Each one is a statement about the shape of the data that the declared encoding predicts, and each could in principle hold under a different labelling scheme; what makes the declared encoding correct is the source metadata, and what the checks add is that the data behave as that metadata says they should. If the encoding were nevertheless reversed, every reported difference would change sign. The three checks are what rules out a *mislabelled file*; they are not what rules out a *misstated encoding*.

**What this means for the rest of the report:** in the tables and figures below, "malignant" means `breast_cancer_yn == 0` and "benign" means `breast_cancer_yn == 1`, and the reported difference is malignant minus benign.

---

## 3. Denominators and data profile

| Item | Value |
|---|---|
| Records loaded | 569 |
| Records analysed | 569 |
| Records excluded | 0 |
| Reason for any difference | None — the leading unnamed column is a row index and was dropped; no record was removed |
| Columns loaded | 32 (1 row index + 30 features + 1 target) |
| Feature columns analysed | 30 |
| Missing cells (analysed table) | 0 of 17,639 (0.000) |
| Exact duplicate feature columns | 0 |
| Constant feature columns | 0 |
| Fully duplicated rows (features + target) | 0 |
| Non-numeric columns | 0 |
| Analysis variable | `mean radius` |
| Malignant denominator | 212 |
| Benign denominator | 357 |

The supplied file and its accompanying source metadata — which record the numerical encoding of the target, the CC-BY-4.0 attribution, the pinned upstream commit and the pre-computed input hash — are the provenance basis for everything below [5].

The leading column `Unnamed: 0` holds 0, 1, 2, … 568 — unique and strictly increasing, i.e. a serialised row index, not an analytical variable. It was dropped, which is the only reason the loaded and analysed column counts differ; **the loaded and analysed record counts are identical at 569**. A complete-case analysis is therefore the same thing as the full analysis, and this was verified (zero missing cells) rather than assumed.

Two structural limitations should be stated plainly. The file carries **no patient identifier**, so the number of independent patients behind the 569 records cannot be checked from the data, and no repeated-measure or clustering structure is declared; the analysis therefore treats each row as one independent observation, which is the only defensible reading of this file but is an assumption about the source, not a fact the file establishes. And the file is a **pre-extracted feature table**: `mean radius` is a single derived summary of each aspirate, not a measurement the analyst can recompute from images.

Unit: the file states no unit for `mean radius`, and the repository's variable table likewise lists no unit for the radius features. The repository describes the underlying ten base features — including radius, the mean of distances from the centre to points on the perimeter, and the "mean", "error" and "worst" variants the file's column names follow — and confirms 569 instances, 30 features and no missing values [4]. Because no unit is defined anywhere in the chain, all values below are reported in the dataset's raw unit and are **not** labelled micrometres.

---

## 4. Group comparison of mean radius

### 4.1 Descriptive statistics

| Group | n | Mean | SD | Variance | Median | Q1–Q3 | Min | Max |
|---|---|---|---|---|---|---|---|---|
| Malignant | 212 | 17.463 | 3.204 | 10.265 | 17.325 | 15.075–19.590 | 10.950 | 28.110 |
| Benign | 357 | 12.147 | 1.781 | 3.170 | 12.200 | 11.080–13.370 | 6.981 | 17.850 |
| **Difference (malignant − benign)** | | **5.316** | | | **5.125** (median shift) | | | |

The malignant group is higher on the mean, the median and both quartiles, so the difference is not an artefact of skew or of the few extreme values flagged in Section 4.7. It is also substantially **more dispersed**: SD 3.204 versus 1.781, a variance ratio of **3.24** (SD ratio 1.80).

### 4.2 Choice of test, and why

The choice rule was fixed when this analysis was specified, before the tests were run:

> Use Welch's unequal-variance t-test if the variance ratio exceeds 2 **or** Levene's median-centred test is significant at α = 0.05; otherwise use the pooled-variance t-test.

This is an analysis-time rule, not a pre-registration: no protocol was registered for this dataset, and the rule is recorded here so that the choice can be checked against it.

Applied to these data, the rule selects Welch:

| Variance diagnostic | Value | Reading |
|---|---|---|
| Variance ratio (malignant / benign) | 3.238 | exceeds the prespecified threshold of 2 |
| SD ratio | 1.799 | — |
| Levene (median-centred) | W = 90.48, p = 5.3 × 10⁻²⁰ | equal variances rejected |
| Bartlett | χ² = 95.43, p = 1.5 × 10⁻²² | agrees |

The pooled-variance ("Student") t-test assumes a single common variance. That assumption is decisively false here: one group's variance is 3.2 times the other's, and the effect is not marginal. Using the pooled test would not change the conclusion in this instance — the difference survives either way — but it would report a narrower interval (half-width 0.410 versus 0.471) and a p value that is smaller than the Welch one by **31.3 orders of magnitude** (8.47 × 10⁻⁹⁶ against 1.68 × 10⁻⁶⁴, computed as a base-10 log ratio of the two executed p values). Welch's test is the appropriate independent-sample test, and it is reported as primary.

### 4.3 Primary result

**Welch's unequal-variance two-sample t-test** (two-sided), Satterthwaite degrees of freedom:

| Quantity | Value |
|---|---|
| Estimate (malignant − benign) | **+5.316 units** |
| 95% CI | **4.845 to 5.787** |
| Standard error of the difference | 0.2394 |
| t statistic | 22.209 |
| Degrees of freedom | 289.71 |
| p value | **1.68 × 10⁻⁶⁴** |

### 4.4 Sensitivity analyses

| Method | Estimate | 95% interval | Test statistic | p |
|---|---|---|---|---|
| Welch t (primary) | 5.316 | 4.845 to 5.787 | t = 22.209, df = 289.7 | 1.68 × 10⁻⁶⁴ |
| Pooled-variance (Student) t | 5.316 | 4.906 to 5.727 | t = 25.436, df = 567 | 8.47 × 10⁻⁹⁶ |
| Bootstrap percentile (10,000 resamples, seed 20240930) | 5.316 | 4.860 to 5.787 | — | not applicable (percentile interval only) |
| Mann-Whitney U (rank-based) | 5.190 (Hodges-Lehmann median shift) | not derived | U = 70,955 | 2.69 × 10⁻⁶⁸ |

**These methods agree, and the agreement is informative.** The three mean-difference intervals (Welch, pooled-variance and bootstrap) all lie wholly above zero; their upper limits span only **0.061 units** (5.727 to 5.787) and their lower limits likewise span 0.061 (4.845 to 4.906), so no two of the three intervals disagree about the size of the difference. The rank-based test — which makes no normality or mean-based assumption at all, and for which no interval is derived — reaches the same conclusion on a parallel estimand. The rank-biserial correlation is **0.8750**, which corresponds to a common-language effect size of 0.9375: a randomly drawn malignant record exceeds a randomly drawn benign record about 93.8% of the time. The Mann-Whitney estimate is a median of pairwise differences (Hodges-Lehmann shift of 5.190), not a difference of means, and is quoted as such.

The one place the methods disagree is precision, not direction: the pooled-variance interval is the narrowest and its p value the smallest, which is the expected consequence of the violated equal-variance assumption it rests on — with unequal variances the pooled t statistic and its interval are both anti-conservative. That is presented as a check on the test-selection rule, not as a better estimate.

### 4.5 Effect size

| Measure | Value | 95% CI |
|---|---|---|
| Cohen's d (pooled SD 2.411) | 2.205 | 1.993 to 2.418 |
| Hedges' g (bias-corrected) | 2.203 | — |
| Glass' Δ (benign SD as reference) | 2.986 | — |

The conventional label for d > 0.8 is "large"; the entire confidence interval lies well above that anchor. The three measures in this table are not interchangeable, because they divide by different reference denominators: Cohen's d and Hedges' g divide the difference by the pooled SD of the two groups (2.411), whereas Glass' Δ divides it by the SD of the benign group alone (1.781). Glass' Δ is the larger number (2.986 against 2.205) purely because its denominator is the smaller of the two; it is not a more cautious or more conservative estimate, and a reader who wants the magnitude on the pooled-SD scale should read Cohen's d. In this sample the standardised separation is very large on either scale.

**A large effect size is not a statement about clinical importance, and a small p value is not either.** p = 1.7 × 10⁻⁶⁴ reflects both a real difference and a large sample; it would remain tiny for a difference of no clinical consequence. The reason to be cautious here is not the p value at all — it is the overlap in Sections 4.6 and 6.

### 4.6 Overlap: the property that limits interpretation

| Overlap measure | Value |
|---|---|
| Malignant range | 10.950 to 28.110 |
| Benign range | 6.981 to 17.850 |
| Ranges overlap | yes, from 10.950 to 17.850 |
| Malignant records below the benign maximum (17.850) | 115 of 212 (54.2%) |
| Benign records above the malignant minimum (10.950) | 275 of 357 (77.0%) |
| Malignant records above the benign Q3 (13.370) | 195 of 212 |
| Benign records below the malignant Q1 (15.075) | 346 of 357 |
| Largest two-decimal cut-point that attains the highest count in this sample | 15.04 (a record is called malignant if its mean radius is strictly above 15.04, i.e. > 15.04; otherwise benign) |

The cut-point in the last row is an **exploratory rule fitted to this same sample**: it was found by searching for the threshold that maximises the number of records placed correctly, and it is then reported as achieving that number, on the same 569 records. It has no validation of any kind — no held-out data, no split, no cross-validation — so it describes this sample's overlap and nothing beyond it. The count-maximising thresholds are not unique: every cut-point from 15.045 up to just below 15.05 gives the same count, and the value reported is the largest two-decimal number **within that plateau**, re-checked under the stated "above" operator. The rule also changes stepwise at each observed value, so a nearby round number gives a slightly different count (15.05, for instance, gives 506).

At that cut-point, **507 of 569 records (89.1%)** are placed correctly **in this sample** — which means **62 records are not**: 51 malignant records at or below 15.04 and 11 benign records above it. That figure is a descriptive measure of how much the distributions overlap. It is not an estimate of diagnostic accuracy and should not be cited as one.

The practical implication is a one-way one. A group-level statement — malignant aspirates are on average larger by about five units — is well supported. An individual-level statement — this aspirate is large, therefore it is malignant — is not supported by anything in this analysis: a fitted cut-point gets roughly one record in nine wrong even before it meets a new sample, and the 54% / 77% figures show why.

### 4.7 Assumptions actually checked

| Assumption | Diagnostic | Outcome |
|---|---|---|
| Independence of observations | no patient identifier in the file; no repeated-measure structure declared | **assumed, not verifiable from this file** |
| Equal variances (for the pooled test) | Levene p = 5.3 × 10⁻²⁰; variance ratio 3.24 | **equal variances rejected** — Welch used instead |
| Normality of the malignant group | Shapiro-Wilk W = 0.978, p = 0.0019; skewness 0.498 | **normality rejected at α = 0.05**; mildly right-skewed |
| Normality of the benign group | Shapiro-Wilk W = 0.997, p = 0.668; skewness −0.083 | not rejected |
| Absence of influential outliers | IQR fences: 3 records outside in each group (1.4% of malignant, 0.8% of benign) | values listed below; no record removed |
| Normality-free robustness | bootstrap and rank-based results reported alongside | conclusions unchanged |

Two points about this table. First, **a non-significant diagnostic does not prove its assumption**: the benign group passing Shapiro-Wilk means normality was not rejected at this sample size, not that the group is normal. Second, the normality violation in the malignant group is exactly why the bootstrap and rank-based analyses are reported rather than mentioned in passing — with n = 212 and n = 357 the t-test is robust through the central limit theorem, but robustness is an argument, and the two assumption-light methods are the evidence that the argument holds in this dataset.

The six IQR-flagged records are identified here by group and value rather than characterised. Both groups' fences are the usual Q1 − 1.5 × IQR and Q3 + 1.5 × IQR on the values given in Section 4.1. In the malignant group (Q1 15.075, Q3 19.59, IQR 4.515, so the upper fence is 19.59 + 1.5 × 4.515 = 26.363) the three records above the fence have mean radius **27.22, 27.42 and 28.11**, all near that group's maximum of 28.110. In the benign group (Q1 11.08, Q3 13.37, IQR 2.29, so the fences are 11.08 − 1.5 × 2.29 = 7.645 and 13.37 + 1.5 × 2.29 = 16.805) they are one record **below** the lower fence at **6.981**, and two above the upper fence at **16.84 and 17.85**, the latter being that group's maximum. Whether any of these is an entry error cannot be established from the file: it carries no measurement provenance, no repeat measurements and no case notes, and the values are not impossible for the feature. No record was excluded — removing data points post hoc because they sit in the tail of the effect being estimated is not a defensible cleaning step — and the rank-based analysis, which is driven by order rather than by magnitude, shows the conclusion does not depend on them.

---

## 5. What the cited literature does and does not add

Two of these records were retrieved at abstract level and are cited at that level: their abstracts report the findings summarised below, and no full text was read. Reference [3] is cited only as a bibliographic record — a title, a venue and a year — and therefore supports no statement about what that paper found or how it was designed.

- The abstract of a study using image analysis on 20 benign and 20 malignant aspirates reports significant differences in nuclear area, perimeter and diameter between benign and malignant lesions [1].
- The abstract of a study of 30 malignant and 30 benign aspirates reports nuclear area, perimeter, diameter, compactness and concave points as statistically significant discriminators [2].
- The paper behind this dataset's automated nuclear-feature extraction [3] is listed as that dataset's introductory paper by the repository distributing it [4]. This is recorded here as provenance for where the feature definition comes from; [3] was retrieved as a bibliographic record only, and nothing is claimed here about its results.

What these add is context: the direction found here is consistent with a body of work in which quantitative nuclear morphometry separates benign from malignant breast aspirates. They do **not** corroborate the specific estimate of 5.32 units — they are different cohorts, sample sizes, imaging and measurement pipelines, and none uses this feature definition on this dataset. The comparison in this report stands on its own executed analysis; the background literature is here to place it, not to support it.

---

## 6. Limitations

1. **Single dataset, single source, single population.** The 569 records come from one cohort collected at one institution. Nothing in this analysis estimates how the difference would generalise to another population, another imaging pipeline or another cytopathology service.
2. **Descriptive estimand, not causal.** "Malignant minus benign" describes how a property of aspirates differs between two already-determined diagnostic groups. Malignancy is not an intervention, and no causal quantity is being estimated. The contrast also cannot be read as "malignancy increases radius by 5.3 units" in any temporal sense.
3. **One feature, not a diagnostic model.** No classifier was fitted, no discrimination or calibration was assessed, and no threshold was validated. The cut-point in Section 4.6 is an exploratory rule fitted in this sample, and the 89.1% figure beside it is a within-sample overlap measure; neither may be cited as diagnostic accuracy.
4. **Independence is assumed.** The file contains no patient identifier and declares no repeated measurements. Where multiple aspirates from one patient are present, the effective sample size is smaller than 569 and the confidence interval reported here is correspondingly too narrow. This cannot be checked from the supplied data and is the single largest threat to the reported precision.
5. **Significance is not importance.** The very small p value is a joint product of the difference and the sample size; it carries no information about clinical relevance.
6. **The comparison is unadjusted.** No covariate (age, lesion size, menopausal status, cytological adequacy) is present in the file, and none was controlled for.
7. **Normality is violated in the malignant group.** The primary interval relies on the central limit theorem; the bootstrap and rank-based analyses support it, but the exact calibration of the interval is an approximation.
8. **No units are stated in the file.** The difference is 5.32 raw units; converting that to a physical scale would require a unit definition this file does not provide.
9. **Label provenance.** The coding direction comes from the supplied source metadata and is corroborated by the three consistency checks in Section 2, but the file's provenance chain runs through a redistributed copy of the UCI dataset rather than the repository itself. The checks make a direction error very unlikely, but they cannot audit the upstream extraction.
10. **No verification of the underlying measurements.** The features are pre-extracted; whether the aspiration, digitisation and segmentation steps were performed consistently across all 569 records cannot be assessed from a feature table.

---

## 7. Reproducibility

Everything numerical in this report is regenerated by one script.

```bash
# from the workspace root
python deliverables/wdbc-mean-radius/analysis.py
```

| Artifact | Contents | Written by |
|---|---|---|
| `analysis.py` | The complete analysis; reads the CSV by relative path, computes every statistic, writes the results file and both figures | — |
| `analysis-results.json` | Structured results, with per-analysis identifier, status, method, estimand, n, estimate, interval and p value, plus the profiling, coding, diagnostics, overlap and self-check blocks | the analysis script |
| `figures/mean-radius-by-diagnosis.png` | Violin plus jittered points by group, with group means and the estimated difference | the analysis script |
| `figures/mean-radius-distribution.png` | Overlaid histograms showing the extent of the overlap | the analysis script |
| `analysis-run.json` | Execution receipt: interpreter, library versions, input and results file hashes, timestamps, exit code, appended one record per run | the runner that invoked the script, not the script |

Scope, stated precisely: the script regenerates the structured results and the two figures from the source CSV. It does **not** regenerate this report — the prose, its tables and its rounding are written by the analyst from those outputs — and it does not write the execution receipt. Every value quoted in this report is taken from the structured results file produced by a run recorded in that receipt.

Determinism: the bootstrap uses NumPy `default_rng` with the fixed seed **20240930**, and 10,000 resamples. Input file SHA-256: `30c0edd07dac8c886b9ad11627caed4eb92d91756aaeddd23921bdafc2582971`, matching the hash recorded in the accompanying source metadata.

The script writes six internal self-checks and asserts on them, so a silent inconsistency fails the run rather than reaching this report: the reported difference must equal the difference of the two group means; the group denominators must sum to the analysed record count; the confidence interval must contain its own point estimate; the label-direction counts must be exhaustive over the 30 features (26 + 4 = 30); the displayed cut-point together with its stated comparison operator must reproduce the reported number of correctly placed records; and the pooled effect-size denominator must be larger than the benign-group denominator quoted for Glass' Δ.

The self-checks apply to the intervals that are constructed to be centred on the estimate. The percentile bootstrap interval is not one of them: a percentile interval is read off the quantiles of the resampled estimates and does not guarantee containment of the point estimate, so no such assertion is made for it — in this run it does contain the estimate (4.860 to 5.787 around 5.316), but that is a property of this sample and not an assertion the script relies on.

This report's prose, its tables and its rounding are written by the analyst from the structured results; the script does not regenerate them.

Environment: Python 3.11.2; NumPy 2.2.6; pandas 2.2.3; SciPy 1.15.3; Matplotlib 3.10.3 for figures. No package beyond these is required. The script does not modify the input file and re-derives every number it reports rather than reading any value from a literal.

---

## 8. References

[1] Niranjan Pandian DJ, Ramdas A, Ambroise MM. Image analysis-assisted nuclear morphometric study of benign and malignant breast aspirates. *Journal of Microscopy and Ultrastructure*. 2021;9(3):114–118. https://doi.org/10.4103/jmau.jmau_17_20

[2] Narasimha A, Vasavi B, Kumar HM. Significance of nuclear morphometry in benign and malignant breast aspirates. *International Journal of Applied and Basic Medical Research*. 2013. https://doi.org/10.4103/2229-516X.112237

[3] Street W, Wolberg W, Mangasarian O. Nuclear feature extraction for breast tumor diagnosis. *Electronic Imaging: Science and Technology*, SPIE Proceedings. 1993. https://doi.org/10.1117/12.148698

[4] Breast Cancer Wisconsin (Diagnostic). UCI Machine Learning Repository. 569 instances, 30 features, no missing values; target `Diagnosis` coded M = malignant, B = benign. https://archive.ics.uci.edu/dataset/17/breast+cancer+wisconsin+diagnostic (DOI: https://doi.org/10.24432/C5DW2B)

[5] Supplied dataset file and its accompanying source metadata, including the numerical target encoding, the CC-BY-4.0 attribution and the pinned upstream commit. Upstream copy: https://github.com/YMa-lab/TableMage-Analysis
