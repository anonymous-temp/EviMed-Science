# Initial dosage optimization of olanzapine in patients with bipolar disorder based on model-informed precision dosing: a study from the real world

- PMCID: PMC11371603
- DOI: 10.3389/fphar.2024.1444169
- Primary source: https://europepmc.org/articles/PMC11371603
- Retrieved: 2026-08-07T07:07:05.787213Z

## Abstract

Objectives Olanzapine is used for treating bipolar disorder (BPD); however, the optimal initial dosing regimen is unclear. The present study aimed to investigate the optimal olanzapine initial dosage in patients with BPD via model-informed precision dosing (MIPD) based on a real-world study. Methods Thirty-nine patients with BPD from the real-world study were collected to construct the MIPD model. Results Weight, combined used quetiapine influenced olanzapine clearances in patients with BPD, where the clearance rates were 0.152:1 in patients with or without quetiapine under the same weight. We simulated olanzapine doses once a day or twice a day, of which twice a day was optimal. Without quetiapine, for twice-a-day olanzapine doses, 0.80, 0.70, and 0.60 mg/kg/day were suitable for 40- to 56-kg BPD patients, 56- to 74-kg BPD patients, and 74- to 100-kg BPD patients, respectively. With quetiapine, for twice-a-day olanzapine doses, 0.05 mg/kg/day was suitable for 40- to 100-kg BPD patients. Conclusion This study was the first to investigate the optimal olanzapine initial dosage in patients with BPD via MIPD based on a real-world study, providing clinical reference for the precision medication of olanzapine in BPD patients.

## 1 Introduction

Bipolar disorder (BPD) is a common psychiatric disorder, affecting more than 1% of the population ( Grande et al., 2016 ). In contrast to other affective disorders, BPD is characterized by recurrent alternating manic or hypomanic episodes and depressive episodes. The World Health Organization (WHO) states that approximately 60 million people suffer from BPD ( Dilsaver, 2011 ). With the development of society, the prevalence rate of BPD increases with each passing year. Currently, BPD ranks 17th among all diseases in the world and is the main cause of disability ( Vigo et al., 2016 ). According to the World Mental Health Survey Report, the lifetime prevalence of BPD is estimated to be 2.4%, and the 12-month prevalence is 1.5% ( Merikangas et al., 2011 ). BPD has become the most heavily insured mental illness in the United States alone. The economic burden is estimated at $30.7 billion in direct medical costs and $120.3 billion in indirect medical costs ( Dilsaver, 2011 ; McIntyre et al., 2020 ). BPD usually causes more pronounced dysfunction and has a greater impact on the quality of life than other mood disorders.

The current treatment of BPD is mainly drug therapy, that is, second-generation antipsychotics, anticonvulsants, and lithium salt treatment ( Lopez-Munoz et al., 2018 ). In addition, studies have shown that olanzapine also can be used for the treatment of BPD ( Novick et al., 2017 ; Uguz and Kirkas, 2021 ; Shoshina et al., 2022 ), where olanzapine is well absorbed and probably needs 6 h after an oral dose to reach the maximum plasma concentration, of which 93% olanzapine is bound primarily to albumin and α1-acid glycoproteins ( Callaghan et al., 1999 ; Mauri et al., 2018 ; Mao et al., 2023 ). In addition, olanzapine is mainly metabolized by cytochrome P450 (CYP) 1A2, CYP2D6, and uridine diphosphate glucuronosyltransferase (UGT) 1A4, UGT2B10, and only 7% dose is excreted unchanged through urine ( Sheehan et al., 2010 ; Soderberg and Dahl, 2013 ; Mao et al., 2023 ).

The curative effect of olanzapine is closely related to the blood drug concentration; a higher concentration is associated with adverse reactions and low levels with poor efficacy ( Gex-Fabry et al., 2003 ; Ascher-Svanum et al., 2010 ; Chen et al., 2011 ; Kang et al., 2022 ; Fekete et al., 2023 ). Usually, in the clinical treatment of olanzapine, therapeutic drug monitoring (TDM) is applied for adjusting the next dose of olanzapine. However, there are no monitoring values for olanzapine therapy for initial administration. Therefore, how to formulate the optimal initial drug administration program is an urgent clinical problem. Xiao et al. (2022) reported the population pharmacokinetics and dosing optimization of olanzapine in Chinese pediatric patients based on the impact of sex and concomitant valproate on clearance. Zhang et al. (2024) reported the effects of aripiprazole on olanzapine population pharmacokinetics and initial dosage optimization in schizophrenic patients. Thus, the present study aimed to investigate the optimal olanzapine initial dosage in patients with BPD via model-informed precision dosing (MIPD) based on a real-world study.

## 2 Methods

### 2.1 Data collection

Patients with BPD who were treated with olanzapine from Xuzhou Oriental Hospital Affiliated to Xuzhou Medical University between July 2020 and August 2023 were included for the analysis (ethics approval no. 20220725011). The collected information mainly included olanzapine concentrations, physiological and biochemical indexes, and concomitant drugs.

### 2.2 Modeling

NONMEM software (edition 7, ICON Development Solutions, Ellicott City, MD, United States) was used for establishing an olanzapine population pharmacokinetic model of BPD patients, where apparent oral clearance (CL/F), volume of distribution (V/F), and absorption rate constant [Ka, fixed at 0.861/h ( Sun et al., 2021 )] were taken into consideration.

Formula 1 assessed inter-individual variabilities: Q i = TV Q × ⁡ exp η i . (1) Here, Q i represents the individual parameter, TV(Q) represents the typical individual parameter, and η i represents the symmetrical distribution (0, ω 2 ).

Formula 2 assessed random residual variabilities: P i = R i + R i * ε 1 + ε 2 . (2) Here, P i represents the observed concentration, R i represents the individual predicted concentration, and ε n represents the symmetrical distribution (0, σ 2 ).

Formula 3 assessed the weight relationship: T i = T s t d × U i / U s t d w . (3) Here, T i is the ith individual parameter, U i is the ith individual weight, U std represents 70 kg, and T std represents the typical individual parameter. W represents the allometric coefficient (CL/F was 0.75 and V/F was 1 [ Anderson and Holford, 2008 ]).

Formulas 4 , 5 described the pharmacokinetic parameters between continuous covariates and categorical covariates: Q i = T V Q × C o v i C o v m θ , (4) Q i = TV Q × 1 + θ × Cov i . (5) Here, Q i represents the individual parameter, TV(Q) represents the typical individual parameter, and θ needs to be evaluated. Cov i represents the ith individual covariate and Cov m represents the population covariate median. The covariate model was built up in a stepwise manner. Objective function value reduction > 6.63 ( p < 0.01) and increase > 10.8 ( p < 0.001) were selected as the inclusion and exclusion standards, respectively.

### 2.3 Model validation

Observations vs. population predictions, observations vs. individual predictions, absolute value of weighted residuals of the individual (│iWRES│) vs. individual predictions, weighted residuals vs. time, density vs. weighted residuals, quantiles of weighted residuals vs. quantiles of normal, visual predictive check (VPC) of the model, and individual plot were used for evaluating the final model. Furthermore, the median and 2.5th–97.5th percentiles of bootstrap (n = 1,000) were used for comparing with the final model parameters.

### 2.4 Simulation

Initial dosage optimization of olanzapine in patients with BPD was done via Monte Carlo simulation, in which the therapeutic range of olanzapine in patients with BPD was 20–80 ng/mL ( Ding et al., 2022 ). In the final population pharmacokinetic model, weight and combined used quetiapine influenced olanzapine clearances in patients with BPD. Thus, on the basis of whether quetiapine was used in combination, and once-a-day or twice-a-day olanzapine doses, we simulated four different situations, where each situation contained 1,000 virtual patients with BPD, 11 doses (0.05, 0.10, 0.20, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90, and 1.00 mg/kg/day) for 7 weight groups (40, 50, 60, 70, 80, 90, and 100 kg), respectively, where the probability of achieving the target concentration was selected as the evaluation criterion. The twice-a-day olanzapine doses were split evenly into two dosages a day.

## 3 Results

### 3.1 Patient information

A total of 39 patients with BPD from the real-world study, including 25 men and 14 women, whose ages ranged from 14.99 to 73.09 years and weights ranged from 45.00 to 85.00 kg, participated in the study. Patient information and drug use are shown in Tables 1 , 2 , respectively

**TABLE 1.** Demographic data of patients with bipolar disorder (n = 39).

**TABLE 2.** Drug combination in patients with bipolar disorder (n = 39).

### 3.2 Modeling

Weight and combined used quetiapine influenced olanzapine clearances in patients with BPD, which were shown in Formulas 6 , 7 : C L F = 18.5 × w e i g h t 70 0.75 × 1 − 0.848 × Q U E , (6) V / F = 106 × weight / 70 . (7)

Here, QUE denotes quetiapine. When patients took quetiapine, QUE was 1; otherwise, QUE was 0.

### 3.3 Evaluation

Observations vs. population predictions, observations vs. individual predictions,│iWRES│ vs. individual predictions, weighted residuals vs. time, density vs. weighted residuals, quantiles of weighted residuals vs. quantiles of normal, and VPC of the model are shown in Figures 1A–G , indicating that the final model predicted well. The clearance rates were 0.152:1 in patients with or without quetiapine under the same weight, as shown in Figure 1H . The individual plot is shown in Figure 2 , and the bootstrap results are shown in Table 3 . The above results showed that the model is robust and reliable.

**FIGURE 1.** Model evaluation. (A) Observations vs. population predictions. (B) Observations vs. individual predictions. (C) Absolute value of weighted residuals of the individual (│iWRES│) vs. individual predictions. (D) Weighted residuals vs. time. (E) Density vs. weighted residuals. (F) Quantiles of weighted residuals vs. quantiles of normal. (G) Visual predictive check (VPC) of the model. (H) Olanzapine clearance: (a) without quetiapine and (b) with quetiapine.

**FIGURE 2.** Individual plot. ID, patient ID number; DV, measured concentration value; IPRED, individual predictive value; PRED, population predictive value.

**TABLE 3.** Parameter estimates and bootstrap validation in patients with bipolar disorder.

### 3.4 Simulation

In our model, we simulated four different situations: 1) once-a-day olanzapine doses without quetiapine, 2) twice-a-day olanzapine doses without quetiapine, 3) once-a-day olanzapine doses with quetiapine, and 4) twice-a-day olanzapine doses with quetiapine. Figures 3A–G , 6A–G show the concentration–dosage plots for BPD patients of 40 kg–100 kg. Figure 7 shows the probabilities of achieving the target concentrations, where Figures 7A–D represent once-a-day olanzapine doses without quetiapine, twice-a-day olanzapine doses without quetiapine, once-a-day olanzapine doses with quetiapine, and twice-a-day olanzapine doses with quetiapine, respectively.

**FIGURE 3.** Simulated olanzapine concentrations of once-daily olanzapine administration dosages without quetiapine. (A) BPD patients of 40 kg, (B) BPD patients of 50 kg, (C) BPD patients of 60 kg, (D) BPD patients of 70 kg, (E) BPD patients of 80 kg, (F) BPD patients of 90 kg, and (G) BPD patients of 100 kg. The lower and upper red dashed lines denote 20 and 80 ng/mL, respectively.

**FIGURE 4.** Simulated olanzapine concentrations of twice-daily olanzapine administration dosages without quetiapine. (A) BPD patients of 40 kg, (B) BPD patients of 50 kg, (C) BPD patients of 60 kg, (D) BPD patients of 70 kg, (E) BPD patients of 80 kg, (F) BPD patients of 90 kg, and (G) BPD patients of 100 kg. The lower and upper red dashed lines denote 20 and 80 ng/mL, respectively.

**FIGURE 5.** Simulated olanzapine concentrations of once-daily olanzapine administration dosages with quetiapine. (A) BPD patients of 40 kg, (B) BPD patients of 50 kg, (C) BPD patients of 60 kg, (D) BPD patients of 70 kg, (E) BPD patients of 80 kg, (F) BPD patients of 90 kg, and (G) BPD patients of 100 kg. The lower and upper red dashed lines denote 20 and 80 ng/mL, respectively.

**FIGURE 6.** Simulated olanzapine concentrations of twice-daily olanzapine administration dosages with quetiapine. (A) BPD patients of 40 kg, (B) BPD patients of 50 kg, (C) BPD patients of 60 kg, (D) BPD patients of 70 kg, (E) BPD patients of 80 kg, (F) BPD patients of 90 kg, and (G) BPD patients of 100 kg. The lower and upper red dashed lines denote 20 and 80 ng/mL, respectively.

**FIGURE 7.** Probabilities of achieving the therapeutic window: (A) once-daily olanzapine administration dosages without quetiapine, (B) twice-daily olanzapine administration dosages without quetiapine, (C) once-daily olanzapine administration dosages with quetiapine, and (D) twice-daily olanzapine administration dosages with quetiapine.

According to simulation results, Table 4 shows the optimal olanzapine initial dosages for patients with BPD. Without quetiapine, for once-a-day olanzapine doses, the probability of achieving the target concentrations from all dosages (0.05–1.00 mg/kg/day) was less than 50.2%. For twice-a-day olanzapine doses, 0.80, 0.70, and 0.60 mg/kg/day were recommended for 40- to 56-kg BPD patients, 56- to 74-kg BPD patients, and 74- to 100-kg BPD patients, respectively; simultaneously, the probabilities of achieving the target concentrations for the dosages of 0.80, 0.70, and 0.60 mg/kg/day were 88.6%–91.0%, 91.0%–92.1%, and 92.0%–93.5%, respectively. With quetiapine, for once-a-day olanzapine dose, 0.05 mg/kg/day was recommended for 40- to 100-kg BPD patients, and the probability of achieving the target concentrations was 96.3%–99.9%. For the twice-a-day olanzapine dose, 0.05 mg/kg/day was recommended for 40- to 100-kg BPD patients, and the probability of achieving the target concentrations was 99.8%–100.0%.

**TABLE 4.** Initial dosage recommendation of olanzapine in bipolar disorder patients without or with quetiapine.

## 4 Discussion

According to the latest psychiatric drug monitoring guidelines issued by the German Association of Neuropsychopharmacology and Pharmacopsychiatry (AGNP) ( Hiemke et al., 2018 ), olanzapine is a “class I (highly recommended)” drug for TDM. The steady-state plasma concentration of olanzapine is correlated with its efficacy/adverse reactions. The AGNP consensus guidelines also emphasize that the interpretation of the measured drug concentrations needs to take into account pharmacokinetic variations that should be considered when optimizing olanzapine administration regimens in clinical practice. Therefore, it is urgent to solve the individualized administration of olanzapine in BPD patients.

In this study, we selected the most commonly used population pharmacokinetic model from MIPD to optimize the initial dosage of olanzapine in patients with BPD; this approach has been reported in previous studies of individualized therapy of other drugs ( Jaruratanasirikul et al., 2019 ; Gil Candel et al., 2020 ; Nguyen et al., 2021 ; Chung and Seto, 2023 ; Salcedo-Mingoarranz et al., 2023 ). Therefore, the present study aimed to investigate the optimal olanzapine initial dosage in patients with BPD via a population pharmacokinetic model based on the real-world study.

In a previous study ( Sun et al., 2021 ), the final population pharmacokinetic model for olanzapine featured a two-compartment disposition model with a lag time for absorption. In the current study, a one-compartment model was selected as the final model. This was mainly due to the difference in datasets affecting our choice of structural models. For example, in the previous study ( Sun et al., 2021 ), olanzapine data were obtained from intense sampling and sparse sampling, and in the current study, olanzapine data were obtained from clinical sparse sampling of TDM.

In the present study, 39 patients with BPD from the real-world study, including 25 men and 14 women, participated in the study. Demographic data of patients with BPD and drug combinations were used to analyze potential influencing factors. In the final model, the olanzapine typical value of CL/F was 18.5 L/h in BPD patients, which was similar to the olanzapine typical value of CL/F (27.6 L/h) in schizophrenic patients ( Zhang et al., 2024 ). In addition, weight and combined used quetiapine influenced olanzapine clearances in patients with BPD, where the clearance rates were 0.152:1 in patients with or without quetiapine under the same weight. The drug interaction between quetiapine and olanzapine was mainly due to quetiapine, and its metabolites could inhibit CYP1A2 and CYP2D6, whereas olanzapine was metabolized through CYP1A2 and CYP2D6 ( Carrillo et al., 2003 ; Shirley et al., 2003 ; Bakken et al., 2012 ), and quetiapine inhibited the metabolism of olanzapine.

Similarly, in the drug interactions of olanzapine, Zhang et al. (2024) reported the effects of aripiprazole on olanzapine in schizophrenic patients. The previous study found that without aripiprazole, for once-daily olanzapine administration dosages, 0.6 and 0.5 mg/kg/day were recommended for 40- to 70-kg schizophrenic patients and 70- to 100-kg schizophrenic patients, respectively; for twice-daily olanzapine administration dosages, 0.6 and 0.5 mg/kg/day were recommended for 40- to 60-kg schizophrenic patients and 60- to 100-kg schizophrenic patients, respectively ( Zhang et al., 2024 ). With aripiprazole, for once-daily olanzapine administration dosages, 0.4 and 0.3 mg/kg/day were recommended for 40- to 53-kg schizophrenic patients and 53- to 100-kg schizophrenia patients, respectively; for twice-daily olanzapine administration dosages, 0.4 mg/kg/day was recommended for 40- to 100-kg schizophrenic patients ( Zhang et al., 2024 ).

Furthermore, we simulated once-a-day or twice-a-day olanzapine doses, of which twice-a-day was optimal. Without quetiapine, for twice-a-day olanzapine doses, 0.80, 0.70, and 0.60 mg/kg/day were recommended for 40- to 56-kg BPD patients, 56- to 74-kg BPD patients, and 74- to 100-kg BPD patients, respectively. With quetiapine, for the twice-a-day olanzapine dose, 0.05 mg/kg/day was recommended for 40- to 100-kg BPD patients. In other words, there are differences in the optimal administration regimen of olanzapine in different diseases, and the optimal administration regimen should be selected clinically according to the specific disease.

There were some limitations in this study. As our olanzapine data were collected from the real-world clinical sparse trough concentrations, the ability to predict was objectively deficient. However, it did not influence the overall model and its clinical application. In the future, we will design prospective olanzapine intensive sampling sites to further carry out relevant studies. In addition, at present, there were some obstacles in realizing the precise drug delivery scheme of olanzapine products, so it was recommended to develop appropriate dosage forms in drug research and development. At the same time, further studies should be conducted to verify the safety and effectiveness of the recommended dosages.

## 5 Conclusion

This study was the first to investigate the optimal olanzapine initial dosage in patients with BPD via MIPD based on the real-world study, providing a clinical reference for the precision medication of olanzapine in BPD patients.

## References

1. Anderson B. J. Holford N. H. ( 2008 ). Mechanism-based concepts of size and maturity in pharmacokinetics . Annu. Rev. Pharmacol. Toxicol. 48 , 303 – 332 . 10.1146/annurev.pharmtox.48.113006.094708 17914927
2. Ascher-Svanum H. Nyhuis A. W. Stauffer V. Kinon B. J. Faries D. E. Phillips G. A. ( 2010 ). Reasons for discontinuation and continuation of antipsychotics in the treatment of schizophrenia from patient and clinician perspectives . Curr. Med. Res. Opin. 26 ( 10 ), 2403 – 2410 . 10.1185/03007995.2010.515900 20812791
3. Bakken G. V. Molden E. Knutsen K. Lunder N. Hermann M. ( 2012 ). Metabolism of the active metabolite of quetiapine, N-desalkylquetiapine in vitro . Drug Metab. Dispos. 40 ( 9 ), 1778 – 1784 . 10.1124/dmd.112.045237 22688609
4. Callaghan J. T. Bergstrom R. F. Ptak L. R. Beasley C. M. ( 1999 ). Olanzapine. Pharmacokinetic and pharmacodynamic profile . Clin. Pharmacokinet. 37 ( 3 ), 177 – 193 . 10.2165/00003088-199937030-00001 10511917
5. Carrillo J. A. Herraiz A. G. Ramos S. I. Gervasini G. Vizcaino S. Benitez J. ( 2003 ). Role of the smoking-induced cytochrome P450 (CYP)1A2 and polymorphic CYP2D6 in steady-state concentration of olanzapine . J. Clin. Psychopharmacol. 23 ( 2 ), 119 – 127 . 10.1097/00004714-200304000-00003 12640212
6. Chen J. Ascher-Svanum H. Nyhuis A. W. Case M. G. Phillips G. A. Schuh K. J. ( 2011 ). Reasons for continuing or discontinuing olanzapine in the treatment of schizophrenia from the perspectives of patients and clinicians . Patient Prefer Adherence 5 , 547 – 554 . 10.2147/PPA.S23255 22114469 PMC3218116
7. Chung E. Seto W. ( 2023 ). Using population pharmacokinetics to optimize initial vancomycin dosing guidelines for neonates to treat sepsis caused by coagulase-negative staphylococcus . Pharmacotherapy 43 , 1262 – 1276 . 10.1002/phar.2865 37574774
8. Dilsaver S. C. ( 2011 ). An estimate of the minimum economic burden of bipolar I and II disorders in the United States: 2009 . J. Affect Disord. 129 ( 1-3 ), 79 – 83 . 10.1016/j.jad.2010.08.030 20888048
9. Ding J. Zhang Y. Zhang Y. Yang L. Zhang S. Cui X. ( 2022 ). Effects of age, sex, and comedication on the plasma concentrations of olanzapine in Chinese patients with schizophrenia based on therapeutic drug monitoring data . J. Clin. Psychopharmacol. 42 ( 6 ), 552 – 559 . 10.1097/JCP.0000000000001618 36286707
10. Fekete F. Menus A. Toth K. Kiss A. F. Minus A. Sirok D. ( 2023 ). CYP1A2 expression rather than genotype is associated with olanzapine concentration in psychiatric patients . Sci. Rep. 13 ( 1 ), 18507 . 10.1038/s41598-023-45752-6 37898643 PMC10613299
11. Gex-Fabry M. Balant-Gorgia A. E. Balant L. P. ( 2003 ). Therapeutic drug monitoring of olanzapine: the combined effect of age, gender, smoking, and comedication . Ther. Drug Monit. 25 ( 1 ), 46 – 53 . 10.1097/00007691-200302000-00007 12548144
12. Gil Candel M. Gascon Canovas J. J. Gomez Espin R. Nicolas de Prado I. Rentero Redondo L. Urbieta Sanz E. ( 2020 ). Usefulness of population pharmacokinetics to optimize the dosage regimen of infliximab in inflammatory bowel disease patients . Rev. Esp. Enferm. Dig. 112 ( 8 ), 590 – 597 . 10.17235/reed.2020.6857/2020 32686429
13. Grande I. Berk M. Birmaher B. Vieta E. ( 2016 ). Bipolar disorder . Lancet 387 ( 10027 ), 1561 – 1572 . 10.1016/S0140-6736(15)00241-X 26388529
14. Hiemke C. Bergemann N. Clement H. W. Conca A. Deckert J. Domschke K. ( 2018 ). Consensus guidelines for therapeutic drug monitoring in Neuropsychopharmacology: update 2017 . Pharmacopsychiatry 51 ( 1-02 ), 9 – 62 . 10.1055/s-0043-116492 28910830
15. Jaruratanasirikul S. Nitchot W. Wongpoowarak W. Samaeng M. Nawakitrangsan M. ( 2019 ). Population pharmacokinetics and Monte Carlo simulations of sulbactam to optimize dosage regimens in patients with ventilator-associated pneumonia caused by Acinetobacter baumannii . Eur. J. Pharm. Sci. 136 , 104940 . 10.1016/j.ejps.2019.05.018 31132402
16. Kang D. Lu J. Liu W. Shao P. Wu R. ( 2022 ). Association between olanzapine concentration and metabolic dysfunction in drug-naive and chronic patients: similarities and differences . Schizophr. (Heidelb) 8 ( 1 ), 9 . 10.1038/s41537-022-00211-5 PMC8885747 35228573
17. Lopez-Munoz F. Shen W. W. D'Ocon P. Romero A. Alamo C. ( 2018 ). A history of the pharmacological treatment of bipolar disorder . Int. J. Mol. Sci. 19 ( 7 ), 2143 . 10.3390/ijms19072143 30041458 PMC6073684
18. Mao J. H. Han L. Liu X. Q. Jiao Z. ( 2023 ). Significant predictors for olanzapine pharmacokinetics: a systematic review of population pharmacokinetic studies . Expert Rev. Clin. Pharmacol. 16 ( 6 ), 575 – 588 . 10.1080/17512433.2023.2219055 37231707
19. Mauri M. C. Paletta S. Di Pace C. Reggiori A. Cirnigliaro G. Valli I. ( 2018 ). Clinical pharmacokinetics of atypical antipsychotics: an update . Clin. Pharmacokinet. 57 ( 12 ), 1493 – 1528 . 10.1007/s40262-018-0664-3 29915922
20. McIntyre R. S. Berk M. Brietzke E. Goldstein B. I. Lopez-Jaramillo C. Kessing L. V. ( 2020 ). Bipolar disorders . Lancet 396 ( 10265 ), 1841 – 1856 . 10.1016/S0140-6736(20)31544-0 33278937
21. Merikangas K. R. Jin R. He J. P. Kessler R. C. Lee S. Sampson N. A. ( 2011 ). Prevalence and correlates of bipolar spectrum disorder in the world mental health survey initiative . Arch. Gen. Psychiatry 68 ( 3 ), 241 – 251 . 10.1001/archgenpsychiatry.2011.12 21383262 PMC3486639
22. Nguyen T. Oualha M. Briand C. Bendavid M. Beranger A. Benaboud S. ( 2021 ). Population pharmacokinetics of intravenous ganciclovir and oral valganciclovir in a pediatric population to optimize dosing regimens . Antimicrob. Agents Chemother. 65 ( 3 ). 10.1128/AAC.02254-20 PMC8092537 33318012
23. Novick D. Montgomery W. Treuer T. Koyanagi A. Aguado J. Kraemer S. ( 2017 ). Comparison of clinical outcomes with orodispersible versus standard oral olanzapine tablets in nonadherent patients with schizophrenia or bipolar disorder . Patient Prefer Adherence 11 , 1019 – 1025 . 10.2147/PPA.S124581 28652711 PMC5476712
24. Salcedo-Mingoarranz A. L. Medellin-Garibay S. E. Barcia-Hernandez E. Garcia-Diaz B. ( 2023 ). Population pharmacokinetics of digoxin in nonagenarian patients: optimization of the dosing regimen . Clin. Pharmacokinet. 62 , 1725 – 1738 . 10.1007/s40262-023-01313-8 37816957
25. Sheehan J. J. Sliwa J. K. Amatniek J. C. Grinspan A. Canuso C. M. ( 2010 ). Atypical antipsychotic metabolism and excretion . Curr. Drug Metab. 11 ( 6 ), 516 – 525 . 10.2174/138920010791636202 20540690
26. Shirley K. L. Hon Y. Y. Penzak S. R. Lam Y. W. Spratlin V. Jann M. W. ( 2003 ). Correlation of cytochrome P450 (CYP) 1A2 activity using caffeine phenotyping and olanzapine disposition in healthy volunteers . Neuropsychopharmacology 28 ( 5 ), 961 – 966 . 10.1038/sj.npp.1300123 12644842
27. Shoshina I. I. Almeida N. L. Oliveira M. E. C. Trombetta B. N. T. Silva G. M. Fars J. ( 2022 ). Serum levels of olanzapine are associated with acute cognitive effects in bipolar disorder . Psychiatry Res. 310 , 114443 . 10.1016/j.psychres.2022.114443 35286918
28. Soderberg M. M. Dahl M. L. ( 2013 ). Pharmacogenetics of olanzapine metabolism . Pharmacogenomics 14 ( 11 ), 1319 – 1336 . 10.2217/pgs.13.120 23930678
29. Sun L. Mills R. Sadler B. M. Rege B. ( 2021 ). Population pharmacokinetics of olanzapine and samidorphan when administered in combination in healthy subjects and patients with schizophrenia . J. Clin. Pharmacol. 61 ( 11 ), 1430 – 1441 . 10.1002/jcph.1911 34018607 PMC8596792
30. Uguz F. Kirkas A. ( 2021 ). Olanzapine and quetiapine in the prevention of a new mood episode in women with bipolar disorder during the postpartum period: a retrospective cohort study . Braz J. Psychiatry 43 ( 6 ), 617 – 620 . 10.1590/1516-4446-2020-1629 33825764 PMC8639011
31. Vigo D. Thornicroft G. Atun R. ( 2016 ). Estimating the true global burden of mental illness . Lancet Psychiatry 3 ( 2 ), 171 – 178 . 10.1016/S2215-0366(15)00505-2 26851330
32. Xiao T. Hu J. Q. Liu S. J. Lu H. Q. Li X. L. Kong W. ( 2022 ). Population pharmacokinetics and dosing optimization of olanzapine in Chinese paediatric patients: based on the impact of sex and concomitant valproate on clearance . J. Clin. Pharm. Ther. 47 ( 11 ), 1811 – 1819 . 10.1111/jcpt.13770 36101489
33. Zhang C. Jiang L. Hu K. Chen L. Zhang Y. J. Shi H. Z. ( 2024 ). Effects of aripiprazole on olanzapine population pharmacokinetics and initial dosage optimization in schizophrenia patients . Neuropsychiatr. Dis. Treat. 20 , 479 – 490 . 10.2147/NDT.S455183 38469209 PMC10925492
