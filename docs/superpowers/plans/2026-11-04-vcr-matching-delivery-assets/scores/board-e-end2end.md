### end to end

ndcg10 and p10 are the official measures. The judged columns drop trials nobody assessed first: a fairer read of a run made after the track was pooled, not a figure to set against the track's runs.

| cohort | topics | ndcg10 | p10 | j10 | ndcg10Judged | p10Judged | retrievalOrderNdcg10 | retrievalOrderP10 |
|---|---|---|---|---|---|---|---|---|
| 2021 | 65 | 0.4750 [0.4005, 0.5484] | 0.4338 [0.3631, 0.5062] | 0.5308 [0.4538, 0.6046] | 0.8192 [0.7745, 0.8609] | 0.7108 [0.6492, 0.7708] | 0.4640 [0.3970, 0.5302] | 0.3523 [0.2923, 0.4138] |
| 2022 | 40 | 0.5286 [0.4446, 0.6159] | 0.4825 [0.4000, 0.5650] | 0.6750 [0.5975, 0.7525] | 0.7408 [0.6613, 0.8168] | 0.6750 [0.5825, 0.7600] | 0.4743 [0.3841, 0.5672] | 0.3900 [0.3025, 0.4850] |
| 2023 | 28 | 0.3663 [0.2700, 0.4676] | 0.3464 [0.2536, 0.4464] | 0.4036 [0.3036, 0.5071] | 0.8548 [0.7979, 0.9088] | 0.7393 [0.6357, 0.8357] | 0.4753 [0.4025, 0.5493] | 0.3071 [0.2214, 0.4000] |
| pooled | 133 | 0.4682 [0.4190, 0.5176] | 0.4301 [0.3835, 0.4782] | 0.5474 [0.4962, 0.5977] | 0.8031 [0.7682, 0.8374] | 0.7060 [0.6609, 0.7504] | 0.4695 [0.4242, 0.5153] | 0.3541 [0.3105, 0.4000] |
| mean of cohort means | | 0.4566 | 0.4209 | 0.5364 | 0.8049 | 0.7084 | 0.4712 | 0.3498 |

### What the track published (NIST's per-run files, whole judged topic sets; not the dev subsets above)

| year | topics | runs | top run | nDCG@10 | P@10 | median run nDCG@10 | median run P@10 |
|---|---|---|---|---|---|---|---|
| 2021 | 75 | 113 | tdminerrun3 / tdminerrun4 (TDMiner, manual) | 0.7150 | 0.5707 | 0.3417 | 0.2093 |
| 2022 | 50 | 41 | frocchio_monot5_e (h2oloo, automatic) | 0.6125 | 0.5080 | 0.4045 | 0.2860 |
| 2023 | 37 | 33 | gpt_weighted (patient2trial, automatic) | 0.8109 | 0.7351 | 0.6414 | 0.4189 |

These are whole-set means. Run on the 28 scorable 2023 test topics, the track's runs read: top gpt_weighted 0.8070 / 0.7071, median 0.6680 / 0.4321, CSIRO-UQ 0.7623 / 0.5429, CSIROmed 0.7435 / 0.5464. Per-topic values for 2021 and 2022 are published only as charts, so a test-topic figure for those years is set against the whole-set mean.

Second-hand figures quoted before, as checked against those files:

- 2021 top nDCG@10 0.715 / P@10 0.576 (TDMiner): confirmed for nDCG@10 (tdminerrun3 and tdminerrun4: 0.7150); P@10 0.576 is tdminerrun4's, the track's best P@10 is 0.5933 (f_t_mt5_2)
- 2021 top 0.84 (a survey): not the track's figure: no run reaches 0.84 on the 75 judged topics (the best is 0.715). A 0.84 for a TREC cohort exists in TrialGPT 2.0's figure of judged pairs only, with no retrieval, a different protocol; the survey's own source was not found
- 2022 top nDCG@10 0.6125 / P@10 0.508 (h2oloo): confirmed (frocchio_monot5_e)
- 2023 CSIRO-UQ 0.7363, CSIROmed 0.738, median 0.648: CSIRO-UQ confirmed (GPT4 0.7363); CSIROmed 0.7378 (qe_prr_ft_rf); the median over the 33 runs is 0.6414, not 0.648; the best run is higher than both: gpt_weighted 0.8109

