# Missed Dialysis Sessions and Adherence: An Actionable Research Agenda for a Single Community Hospital

**Direction as given:** Identify actionable questions about missed dialysis sessions and adherence.

**Population:** Adults receiving maintenance hemodialysis.
**Setting:** Community hospital.
**Data available:** Existing attendance and transport records from one hospital; no biospecimens.
**Constraints:** six months; no new recruitment; one part-time analyst.

**Date of analysis:** 28 September 2026.

---

## 1. Summary

The field has settled the two questions that are easiest to ask and hardest to answer. Missing hemodialysis sessions is not a marker of nothing — it is associated with death, hospitalization and vascular access failure, and that association has been reported in cohorts of 3.8 million sessions and 115,982 patients respectively [1][2][3]. The three cohorts are not replications of one another: they differ in population, in how the exposure was defined, and in outcome ascertainment, so what they show is a consistent signal rather than a reproduced effect size. Nor is it random: it clusters by day of the week [2], rises with inclement weather [4], and is concentrated in people using non-private transport [3] and in people with mental illness, smoking and alcohol excess [5]. A single-centre non-attendance cohort with outcome follow-up has already been published in England [5].

What remains genuinely open is narrower, and it happens to sit exactly where this project's data sit. The published transport signal is measured almost entirely at the level of the *patient* — a transport mode, a deprivation score, a reported travel time [3][6][7]. Within the literature retrieved for this report, no study was found that links *session-level transport events* (a cancelled ride, a late pickup, a provider that never arrived) to the session a patient then missed, and none was found that reports how often the reason recorded in the dialysis chart ("did not attend") agrees with what the transport record shows happened. That is the gap this dataset can close and a national claims cohort cannot, because the event-level record does not exist in claims.

The agenda below proposes six testable questions and ranks them. The recommended first step is not a research question at all: it is a two-week field audit to establish whether the transport records carry event-level timestamps and reason codes, because four of the six questions live or die on that answer.

---

## 2. Search scope, and what it did not cover

**Channels used.** PubMed (MeSH-indexed subject search and abstract retrieval), Europe PMC (including full-text search), OpenAlex (citation context and field size), Crossref and DOI resolution via the indexed records, a guideline index covering Chinese and English guideline records, ClinicalTrials.gov, and the open web (for one guideline document). Six channels are represented in the evidence map.

**Queries and what they returned.** Subject-axis queries on missed and skipped sessions, non-attendance, no-shows and adherence; comparator-axis queries on prevalence, predictors and outcomes; method-axis queries on rescheduling, session shortening, day-of-week and weather designs; and absence-axis queries on recent reviews. A specialist topic-selection analysis was also run on the same brief; its run is identified as **topic-20260928043524-416fa9e331a9** in the run receipt, where its terminal state, the artefacts it returned and its own record counts (87 records, 2021–2026) are preserved verbatim. Figures taken from that analysis are reported here as the job returned them and are not re-derived. Every record count in this section is this run's own tally of what the retrieval channels returned, and the searches themselves are itemised in the same receipt. The largest single PubMed returns were 30 records (missed hemodialysis sessions) and two returns of 20 (adherence trajectory; transportation barriers); the remaining non-empty PubMed queries returned 1 to 3 records each, and seven returned nothing at all, as listed below. Europe PMC returned 30 records on a transport-and-attendance query and 15 on a trajectory query; OpenAlex returned 15 records; the guideline index returned 10 candidates of which 5 carried preserved text; ClinicalTrials.gov returned 11 registered studies. Abstracts were retrieved and preserved for 44 PubMed records and are quotable at abstract level; six open-access articles were retrieved in full and their Methods and Limitations sections read.

**Zero-result queries, recorded as coverage gaps rather than as absence of evidence.** Seven queries returned nothing and are listed so the reader can see which axes are thin: "travel distance transport burden and missed hemodialysis sessions attendance" (literature index); a Europe PMC query restricted to preprint records on missed haemodialysis and transport; "trajectory model patterns of dialysis attendance missed treatments day of week" (PubMed); "seasonal variation weather missed hemodialysis sessions attendance" (PubMed); "target trial emulation observational study dialysis treatment attendance adherence" (PubMed); "machine learning prediction missed dialysis sessions no-show risk model" (PubMed); "dialysis attendance weather winter season" (PubMed). The PubMed channel in this deployment answered short keyword queries and returned nothing for longer compound strings, so these nulls indicate query shape, not an empty literature.

**Explicit coverage limitations.**

- **Preprints are not covered.** The preprint-restricted route returned zero records. What is being done now and is not yet published is therefore invisible to this report, and every novelty statement below is bounded by that.
- **Chinese-language literature is not systematically covered.** One Chinese-language guideline knowledge-search was run and returned only adequacy, nutrition, restless legs, catheter-infection and hypotension evidence summaries — none addressing attendance or transport. No Chinese bibliographic database was searched. A Chinese community-hospital study on this topic could exist and this report would not have found it.
- **The citation graph was shallow.** OpenAlex was used to size the field and to locate the rescheduling and social-determinants work; Semantic Scholar was not successfully queried, so "who built on this and who did not" is only partly charted.
- **Full text was read for six works**, chosen because a recommended design depends on their Methods. Claims resting on anything else are worded at abstract level.

---

## 3. Field map

### 3.1 What practitioners are already told

The KDOQI 2006 hemodialysis adequacy guideline is the only practice document retrieved that speaks directly to this behaviour. Its clinical practice recommendation 4.4 is: "Efforts should be made to monitor and minimize the occurrence of missed or shortened treatments," graded B [41]. Two things follow. First, monitoring and minimising missed and shortened treatments is already recommended practice, so a project that only counts them adds little. Second, the guideline groups missed and shortened treatments in one recommendation while the literature almost never measures them as separate behaviours — a discrepancy that Question 3 takes up.

### 3.2 How "missed" and "adherence" are measured, and why the numbers do not agree

There is no gold standard, and the denominators differ between studies in ways that make headline rates non-comparable:

| Source | What was counted | Numerator / denominator | Rate |
|---|---|---|---|
| DOPPS phase 5, 20 countries [1] | ≥1 missed treatment not due to hospitalization | 4-month risk | <1% (Italy, Japan) to 24% (USA) |
| ARO cohort, 15 European countries [2] | non-attendance on a scheduled day, confirmed against attendance of the three preceding sessions | missed scheduled sessions / scheduled sessions in eligible patients | 0.6–1.4% of sessions by day of week |
| Single centre, North West England [5] | non-attendance recorded in incident reports, excluding hospitalization | patients with ≥1 non-attendance / 464 patients over ~2 years | 32% (17% with ≤2 episodes, 15% with >2) |
| US national transport cohort [3] | missed dialysis treatments (the facility-attributed subset of a broader analysis of transport mode and outcomes) | incident rate ratio by transport mode | — (ratio scale) |
| Banda Aceh, Indonesia [8] | ≥1 missed session in the prior month | 193 patients, cross-sectional | 28% |
| Bahrain, two public units [9] | missed sessions vs shortened sessions in the prior month | 266 patients, cross-sectional | 15.1% missed; 81.9% shortened |
| Hospital, Oklahoma/United States [7] | "no-shows" and "early sign-offs", prospective, 12 months | 31,212 sessions, mean 231 patients | 1.2%/month no-show; 6.8%/month early sign-off |

The last two rows are the same phenomenon measured two ways thirty years apart on different continents, and they agree on the ratio rather than the level: within each cohort, shortened sessions outnumber missed ones by roughly five to six to one ([7]: 6.8% versus 1.2% per month, about 5.7:1; [9]: 81.9% versus 15.1%, about 5.4:1). These are each cohort's own internal ratios, not a cross-cohort comparison. A project that defines non-adherence as "missed sessions" is therefore studying a minority of the non-adherence in its own unit.

Cross-sectional unit surveys add several more denominators that are not comparable with any of the above: any non-attendance in 12.8% of 172 patients over three months in Qassim [38], about 26% of 154 patients in Al-Ahsa [37], 28% of 193 patients over one month in Banda Aceh [8], and 55.96% of 361 patients classified adherent in Makkah [36]. A Nepali study of 283 patients reported that 91% rated adherence as important — but it measured perception, not attendance [50]. Reading these cross-sectional surveys as a prevalence range for "missed sessions" would be a category error, which is one reason the field's headline non-adherence figures vary so widely.

Two integrative reviews reach the same conclusion from opposite directions. A 29-study integrative review found adherence measured predominantly by self-report, with the ESRD-AQ used in 11 of 29 studies, only a few studies combining self-report with objective laboratory or record indicators, and no universal cut-off for any biochemical marker [10]. A qualitative synthesis of 12 studies concluded that "one-size-fits-all approaches to improving adherence among patients on hemodialysis are inadequate" [11]. Self-report and records measure different things, and this project has only records — an advantage for objectivity and a limitation for anything requiring motivation, belief or intent.

### 3.3 What is established (the comparators a new result would be placed against)

- **Harm.** DOPPS phase 5: ≥1 missed treatment in 4 months associated with all-cause mortality HR 1.68 (95% CI 1.37–2.05) [1]. A USRDS analysis reported as a conference abstract, n=134,372, and therefore not verified against a peer-reviewed full text: <38 sessions per 90 days vs 39, adjusted HR 1.18 (1.15–1.21) [12]. ARO cohort, 3.8 million sessions in 9,397 patients: over the 48–72 h after non-attendance, mortality rose from 4.86 to 51.9 per 100 patient-years and hospitalisation from 0.58 to 2.1 per year; missing the first session after the two-day break carried a mortality HR of 2.04 (1.27–3.29) compared with missing a later one [2]. US Medicare: a missed treatment was associated with a 2.09-fold higher 7-day hospitalization rate [6]. In a single-centre Canadian cohort of 360 incident patients, dialysis non-adherence was independently associated with emergency department use across all categories, with a multinomial-logistic-regression relative risk ratio of 7.34 (95% CI 2.81–19.20) for the more-than-three-visits category relative to no visits [42]. After Hurricane Katrina, 44% of 386 patients missed ≥1 session and ~17% missed ≥3; adjusted OR for hospitalization after ≥3 missed was 2.16 (1.05–4.43) [13]. Vascular access: among arteriovenous graft users, missing sessions was associated with thrombosis (OR 9.48, p≈0.041) [14].
- **Modifiability.** Missed-treatment risk varied more than 50-fold across 20 countries [1], and the Comprehensive ESRD Care Model raised the odds of rescheduled sessions (OR 1.09, 95% CI 1.05–1.14) [15] — an effect small in magnitude, but one of the few modifiable-system signals reported to date and one of the few arguments available that non-attendance may be partly a systems property rather than solely a fixed patient trait.
- **Predictors.** Younger age, shorter dialysis vintage, shorter treatment time, lower Kt/V, longer travel time to the unit, and more depressive symptoms [1]; mental illness (OR 3.01), alcohol excess (OR 3.49) and smoking (OR 2.01) in a single centre [5]; anxiety, with an incidence rate ratio for missed sessions of 1.32 (1.18–1.47) and partial mediation of complication risk [16]; transport mode, at national scale [3].
- **What does not work well.** Behavioural interventions pooled across 149 studies and 15,878 patients produced a small effect on dialysis adherence, g = 0.27 (95% CI 0.03–0.50) [17]. Trials of education, self-management, cognitive-behavioural and emotion-regulation approaches mostly move self-reported adherence, interdialytic weight gain or phosphate, and are mostly conducted by enrolling and randomising patients [18][19][20][21] — an option this project does not have.
- **Guideline-adjacent.** The guideline text itself records that US patients missed about 4% of treatments per month at the time of writing [41].

### 3.4 What is contested

Three tensions are worth naming because they determine what a new study should measure.

**(a) Transport: strong at national scale, inconclusive below it.** A national cohort of 115,982 patients found that lacking private transport was associated with missed treatments (Medicaid aIRR 1.31, 95% CI 1.27–1.35; paratransit 1.15, 1.11–1.20; public transit 1.24, 1.18–1.30) and with mortality (aIRRs 1.25, 1.21, 1.09; private-pay non-emergency medical transport 1.70) [3], and treatments attributed to transport were 1.83–2.78 times more likely in non-private-transport users [3]. A 266-patient cross-sectional study in Bahrain found the opposite for its transport item: "transportation issues… were not significantly associated with adherence across treatment domains" [9]. A small pilot of 25 cases and 24 controls reported an association in the same direction as the national cohort — cases were more dependent on public transport for dialysis (p = 0.03) — while finding no difference in health literacy, education, economic stability or family support [22]. The pilot is far too small to be set against the national cohort, and the Bahrain result is a null on a different transport measure; what the three together show is that the association's size depends heavily on how transport is measured and that no retrieved study resolves it at unit level.

**(b) Adherence improves but outcomes do not.** Anxiety reduction, education and behavioural techniques shift adherence measures [16][17], yet the field has not shown that reducing missed sessions causally reduces hard events. The DOPPS authors note their own temporal ambiguity [1], and the rescheduling study reports attenuation without full mitigation and explicitly cannot exclude unmeasured confounding [6].

**(c) Whether non-attendance tracks social disadvantage.** Transportation insecurity tracks it strongly at national scale [3], and a French multicentre study using individual-level deprivation found differences in health behaviours but *no* significant difference in the frequency of missed dialysis sessions [23]. A 2025 integrative review concluded that the cited factors "may vary based on the variables and measurement tools used in each study" [10].

---

## 4. Evidence gaps

**Gap 1 — Transport is measured as a patient attribute, not as an event.** Every retrieved transport signal is a person-level or area-level variable: mode of travel [3][9], dependence on public transport [22], self-reported travel time [1][24], distance or geocoded accessibility [25][26]. Where transport is documented as the mechanism of disruption it is at the level of the event or the system, not the trip: natural-disaster reviews record that loss of transport disrupted dialysis care and led to missed sessions [39], extreme-weather scoping work lists transportation barriers alongside power outages [40], and conflict studies report transport cost and availability as the barrier named by most displaced patients [43] and 28.7% of patients unable to reach at least one session in the previous year [44]. Within the channels searched here, no study was found that links a session-level transport record — booking, dispatch, pickup time, arrival time, cancellation, cost — to the session that was missed. This is the single clearest gap, and it is a data-availability gap rather than an oversight: claims and survey cohorts do not contain dispatch records. A hospital with its own transport records does.

**Gap 2 — The reason recorded in the chart was not found to have been validated against an independent record.** Non-attendance reasons in the retrieved literature come from patient interview [7][24][35], from nurse records [27], from incident reports [5], or are simply not available [24]. Where transport is recorded as the reason, no retrieved study checks whether the transport record agrees. Misattribution matters directly: if "no transport" is recorded when transport ran on time, the intervention target is wrong. The method for coding reasons out of existing administrative text rather than collecting new data is established outside this field, in a qualitative analysis of death records of people experiencing homelessness that reconstructed care barriers and delays from records alone [49].

**Gap 3 — Missed and shortened treatments are grouped in practice but separated in almost no study.** The guideline groups them [41]; the two studies that did separate them, thirty years apart, found different reason mixes and a roughly stable 5–6:1 ratio [7][9]. DOPPS relates prescribed session length to survival [28] and the Navigate-Kidney trial counted shortened sessions as a secondary outcome (P = .02 in favour of the intervention) [29], but delivered-versus-prescribed session time is rarely the estimand.

**Gap 4 — Rescheduling is studied in one health system only.** The only retrieved study of rescheduling as an exposure uses US Medicare beneficiaries on Monday/Wednesday/Friday schedules, matched 1:5 on day of week and propensity score, and reports that rescheduling attenuates but does not fully mitigate harm [6]. Its authors' own stated limitation is unknown generalizability to non-Medicare insurance [6]. The determinants of *whether* a missed session gets rescheduled — slot availability, transport recoverability, day of week — were not its question.

**Gap 5 — Within-patient persistence is not characterised.** Non-attendance is analysed as a binary (≥1 missed treatment) [1], a count band [12], or a threshold (more than two episodes [5]; more than four sessions in two years [27]). Whether non-attendance is a stable trait of a few patients or a state that any patient can enter — and whether a first missed session predicts a second — is not answered in the retrieved set. The psychosocial study found that of 464 patients, 54 (11.6%) met a "frequent non-attendance" threshold [27], which is a prevalence estimate, not a trajectory.

**Directions the field has already closed, recorded so they are not reopened.**

- *Day-of-week harm from non-attendance.* Answered, at scale. The ARO cohort analysed 3.8 million sessions in 9,397 patients by dialysis day and quantified the effect (see §3.3) [2]. A single-centre replication would add nothing.
- *Inclement weather as a cause of missed appointments.* Answered. A time-stratified case-crossover with conditional Poisson regression in 60,135 patients across the Northeastern United States quantified rainfall (RR 1.03 per 10 mm), snowfall (RR 1.02), hurricane and tropical storm (7-day RR 1.55, 95% CI 1.22–1.98), wind advisory (1.29) and wind gusts (1.34) [4]. The design is stronger than anything this project could mount, and it addresses weather-driven non-attendance directly, which is the mechanism this project would otherwise have to proxy. It is, however, a United States climate; a local seasonality analysis would be a service audit, not a novel question.
- *"Transport mode predicts missed sessions."* Largely answered at national scale with 115,982 patients and incident rate ratios [3]. Only the event-level mechanism survives as a question.
- *"Single-centre non-attendance characteristics and outcomes."* Answered in North West England with 464 patients, incident-report ascertainment and 35-month outcome follow-up [5]. The user's setting duplicates it unless the exposure is the transport record, which is the one element that study did not have.

---

## 5. Candidate questions

Six questions survive. Each carries a labelled novelty statement naming the closest published work, the axis of difference, and what a reader would gain.

### Q1 — Do session-level transport events, rather than transport mode, immediately precede missed dialysis sessions?

**Hypothesis.** In adults on maintenance hemodialysis at one community hospital, a session-level transport failure (provider cancellation, no vehicle dispatched, pickup later than the scheduled window, missed connection, or an out-of-pocket cost barrier recorded on that day) is associated with a missed session on the same scheduled day, and the association persists after adjustment for patient-level transport mode and clinical characteristics.

**Estimand.** The within-patient risk difference in the probability of missing a scheduled session on days with versus without a recorded transport failure, estimated from a person-period dataset; a secondary patient-level estimate is the incidence rate ratio of missed sessions per transport-failure day.

**Design.** Retrospective person-period cohort. Each scheduled session is one row. Exposure is a same-day transport event; outcome is attended, rescheduled, shortened or missed. Precedent for record-based exposure definition at session level exists in the day-of-week analysis [2] and in the rescheduling study's 2-day exposure window [6]; the analysis model would be a mixed-effects logistic or conditional (fixed-effects) logit regression with a patient intercept, or a negative binomial count model with a patient-level offset for scheduled sessions. The conditional-logit form is preferred because it compares a patient to themselves and removes all time-invariant confounding, which is the main threat given that transport mode, deprivation and comorbidity are all patient-level.

**Data fields required.** Transport record: booking date, scheduled pickup time, actual pickup time, arrival time, mode, provider type, whether the trip was completed, cancellation reason and cancelling party, cost or subsidy code, and whether a backup vehicle was used. Attendance record: scheduled session date and shift, attended/not attended, rescheduled-to date, session start and end time, and any recorded reason. Linkage: a patient identifier present in both, plus a session date key. *None of these is confirmed to exist. The field audit in §7 is the gate.*

**Precedent.** Session-level attendance ascertainment was done against pre-dialysis blood pressure, pre-dialysis weight and dialysis treatment time in the ARO cohort [2]; the rescheduling study defined exposure from attendance on an index date plus the following day and matched hard on day of week [6]. Both are transferable.

**Falsification.** The hypothesis fails if the within-patient association between same-day transport events and missed sessions is null after adjustment, or if transport-failure days predict missed sessions no better than the patient's own baseline missing rate. It also fails in the direction that matters most if transport failures are recorded on days the patient *attended* at the same rate as on days they missed — which would mean the transport record is not measuring what it appears to measure.

**Feasibility.** Best fit to the constraints of the six questions. It uses exactly the two record types reported as available, requires no recruitment, no specimens and no follow-up, and a person-period analysis with hundreds or thousands of session rows is well within one part-time analyst's capacity over six months. Its risk is entirely upstream: if the transport records are monthly invoices rather than event logs, Q1 collapses to a weaker patient-level version and Q2, Q5 and Q6 lose their strongest form with it. Contingent on the field audit.

**Novelty:** Occupied at patient level, not at event level. The closest work is a 115,982-patient national cohort in which the exposure was the *mode* of transportation to dialysis and the outcome included missed treatments attributed to transportation (aIRRs 1.83–2.78 for non-private modes) [3], together with a 25-case pilot in which cases were more dependent on public transport (p = 0.03) [22] and DOPPS, where longer self-reported travel time predicted missed treatments [1]. All three measure transport as a stable attribute of the person. The axis of difference is the unit of exposure: a dated transport event linked to the specific session missed, analysed within-patient. A reader gains the mechanism and its frequency — how many missed sessions are actually transport-caused, and which transport failure modes carry them — which a mode-level cohort cannot report because the event record does not exist in claims data.

### Q2 — When a session is missed, does rescheduling it in the same week attenuate the immediate harm, and what determines whether it can be rescheduled?

**Hypothesis.** Among missed sessions, those followed by a rescheduled session within 72 hours are associated with a lower rate of subsequent emergency department attendance or hospitalization than missed sessions not rescheduled; and the probability of rescheduling is itself higher when transport is recoverable within the week and when a vacant slot exists on an adjacent day.

**Estimand.** Two estimands. (i) The risk difference comparing rescheduled with not-rescheduled missed sessions, using the 7- and 30-day windows taken from the published precedent [6] — these two windows are that study's, adopted here for comparability, not this proposal's own choice. (ii) The probability of rescheduling conditional on day of week, transport recoverability and unit slot availability.

**Design.** Self-controlled episode analysis, with each missed session as the unit and the same patient contributing multiple episodes. The published design matched 5:1 on day of week and propensity score and used repeated-measures generalized linear models with negative binomial count outcomes [6]; the self-controlled variant used here removes the between-patient confounding that the matching approach can only balance, and is feasible at one centre because day-of-week and transport variation recur within patients.

**Data fields required.** Whether the attendance record distinguishes *scheduled but not attended* from *rescheduled and attended* — the rescheduling study's whole exposure definition rests on this distinction [6] and it is the first thing to verify. Then: date of the replacement session relative to the missed one; day of week; recorded reason; transport availability on the replacement date; unit slot or shift capacity on adjacent days; and an outcome source (emergency department attendance or admission dates) with a date field that can be linked.

**Precedent.** The exposure logic and the 7- and 30-day windows are taken directly from the rescheduling study [6]; the capacity moderator has precedent in the Comprehensive ESRD Care Model finding that rescheduled sessions rose under a payment model that incentivised prompt rescheduling (OR 1.09, 95% CI 1.05–1.14) [15].

**Falsification.** Fails if the rescheduled and not-rescheduled missed-session groups show no difference in 7- or 30-day emergency use, or if the apparent benefit disappears once the day of week and the patient are held fixed — which is exactly the explanation the original authors could not exclude, since they matched on day of week rather than conditioning on it [6].

**Feasibility.** High, conditional on the attendance record distinguishing rescheduled from simply-absent sessions. Requires an outcome source with dates; if the only outcome is "next attended session", the question degrades to a process measure (rescheduling rate and its determinants), which is still publishable as a service finding but is not the harm-attenuation question. No recruitment, no specimens.

**Novelty:** Occupied in a different health system and on a different question. The closest work is the US Medicare study — missed treatments N=3,852, rescheduled N=2,128, 7-day hospitalization 2.09-fold after a miss and 1.68-fold after a reschedule versus attending, 30-day 1.39- and 1.28-fold, no significant mortality association [6] — which concluded that rescheduling "attenuates but does not fully mitigate" harm and flagged unknown generalizability to non-Medicare populations [6]. The axes of difference are the health system (single community hospital outside the United States) and the second half of the question — what makes a missed session reschedulable, which that study did not ask. A reader gains whether the attenuation finding travels, and a modifiable operational target (slots, transport recoverability) rather than a patient-level exhortation.

### Q3 — Are shortened and missed sessions distinct behaviours with distinct drivers, or one behaviour on a continuum?

**Hypothesis.** In this unit, shortened sessions and full non-attendance have different associated factors — with transport failure and logistics weighting toward non-attendance, and symptom burden (intradialytic hypotension, cramping, post-dialysis fatigue) weighting toward early termination — and the delivered-versus-prescribed dose deficit differs in how far each recovers it.

**Estimand.** The difference in associated-factor profiles between the two behaviours, estimated as a multinomial outcome over session-level states (completed as prescribed / shortened / rescheduled / missed); and separately the mean per-session delivered-versus-prescribed time deficit attributable to each state.

**Design.** Session-level multinomial or competing-risks analysis on the same person-period dataset as Q1. The reason taxonomy has direct precedent: a prospective 12-month study of 31,212 sessions classified early sign-offs by reason and found cramping 17.9%, "feels bad or sick" 14.2%, personal business or errands 12.1%, lack of transportation later in the day 7.7% and refusal to comply with prescribed treatment time 6.4% [7]. The delivered-dose comparison has precedent in DOPPS, where longer treatment time was associated with lower mortality (HR 0.94 per 30 minutes, 95% CI 0.92–0.97) [28], and in the multicentre pandemic study, where missed sessions rose and urea reduction ratio and Kt/V fell [30].

**Data fields required.** Session start and end time (or actual duration) alongside prescribed duration; the recorded reason for early termination where present; a dialysis-dose field if the adequacy link is to be made — noting that Kt/V is a routine dialysis record field rather than a biospecimen, so its availability is an access question and not excluded by the "no biospecimens" constraint, but it is **not** confirmed by the brief and must be verified; and the same attendance state variable as Q1.

**Precedent.** Leggat and colleagues' prospective reason taxonomy [7] and the Bahrain cross-sectional definition of non-adherence as "missing one or more HD sessions per month or shortened one or more sessions by more than 10 min per month" [9] provide the operational definitions.

**Falsification.** Fails if shortened and missed sessions show the same associated-factor profile and the same reason distribution, or if session duration is recorded only as prescribed rather than delivered — in which case the question is unanswerable from this data and should be reported as such rather than approximated.

**Feasibility.** High, and it is the cheapest of the six because it needs one field (delivered session duration) that dialysis units record as a matter of course for adequacy monitoring. It is the natural fallback if the transport records prove to be coarse.

**Novelty:** Occupied but not in this era or population. The closest work is a 1993 prospective study in a single large southeastern United States unit (31,212 sessions, mean 231 patients) that measured both behaviours and their reasons but did not model them jointly or link them to delivered dose [7]. The Bahrain study separated the two behaviours in a cross-sectional design and reported that transportation issues were *not* significantly associated with adherence — a result that conflicts with the national transport cohort [3] and that this design could test [9]. The guideline groups the two behaviours in one recommendation [41]. The axis of difference is the era, the setting and the joint modelling: a modern community-hospital session-level model of both behaviours with delivered dose as a consequence. A reader gains the size of the non-adherence that "missed sessions" alone misses, and whether the two behaviours need different interventions.

### Q4 — Is missed-session behaviour persistent within patients, or a state any patient can enter?

**Hypothesis.** Non-attendance among adults on maintenance hemodialysis at this unit is better described by a small number of repeat non-attenders plus a larger group with sporadic episodes than by a single latent propensity; and a first missed session raises the probability of a second within a short window. The 30-day window used throughout this question is the proposal's own design choice, chosen to sit inside a single interdialytic-care cycle and to be computable from an attendance extract alone; it is not taken from a published study and should be varied in sensitivity analysis.

**Estimand.** Two quantities. (i) The number and size of latent attendance-pattern classes, or failing that, the empirical distribution of missed-session counts per patient compared with a Poisson or negative binomial expectation. (ii) The conditional probability of a subsequent missed session given a prior missed session, estimated with a within-patient lagged-exposure model over the 30-day design window defined under Design above. That 30-day window is a parameter of this proposal, not a figure taken from any study; it was chosen to sit inside a single interdialytic-care cycle and to be computable from an attendance extract alone, and its sensitivity to the choice should be reported.

**Design.** Retrospective person-period cohort on the same dataset, with a group-based trajectory or latent-class model as the primary descriptive tool and a discrete-time survival model with a lagged exposure as the confirmatory test. The recurrence window for that test is 30 days — a design parameter of this proposal rather than a figure drawn from a published study, chosen to sit inside a single interdialytic-care cycle and to be computable from an attendance extract alone. Latent-class modelling is not established as a precedent in the retrieved dialysis-attendance literature — the precedent is the threshold definitions used instead ("more than two episodes" [5]; "more than four sessions during the two-year study period" [27]) and the count bands used in USRDS [12]. That absence is itself a finding: the field has been describing persistence by threshold rather than by trajectory.

**Data fields required.** A complete session-level attendance history with dates and scheduled-versus-attended status, and enough observation time per patient to define a pattern. No new fields beyond Q1's attendance extract. A patient-level covariate set is needed only for the descriptive classes.

**Precedent.** Threshold definitions from the single-centre England cohort [5] and the psychosocial review [27]; count-band analysis from USRDS [12]; the "1 or more missed treatments in 4 months" binary from DOPPS [1].

**Falsification.** Fails if a single-class model fits as well as a multi-class model, or if the probability of a subsequent missed session over the proposal's 30-day design window is no higher following a missed session than following an attended one. A negative result here would be a substantive finding: it would mean non-attendance is a transient state driven by circumstance rather than a patient characteristic, which would redirect intervention from case-finding to real-time response.

**Feasibility.** Highest of the six. It requires only the attendance extract, no transport fields, no outcome linkage and no new data. Its limitation is the same as the whole project's: with one centre and an unknown patient number, latent-class models can be unstable, so the analysis must be pre-specified with a small maximum number of classes and reported with fit statistics rather than asserted.

**Novelty:** No direct answer identified within this search. The closest works are threshold-based descriptions rather than trajectory models: 149 of 464 patients (32%) with any non-attendance and 70 (15%) with more than two episodes [5]; 54 of 464 patients (11.6%) meeting a "more than four sessions in two years" threshold [27]; and count bands of sessions per 90 days in a 134,372-patient US registry cohort [12]. The search scope that produced this conclusion is bounded: subject, method, comparator and absence axes were searched across PubMed, Europe PMC, OpenAlex and the guideline and trial-registry indexes, but preprints and Chinese-language databases were not covered, so the statement is "no direct answer identified here" and not "unoccupied across the field". A reader gains the shape of the behaviour — the number of repeat non-attenders the unit should be resourced to follow, and whether reopening a missed session is a one-off rescue or a recurring need.

### Q5 — Does the reason recorded for a missed session agree with what the transport record shows happened?

**Hypothesis.** Among missed sessions, chart-recorded reasons and transport records disagree in a non-trivial fraction of episodes, and the disagreement is directional — transport failure is under-recorded when the patient also has a clinical or personal reason available — so using chart reasons alone misstates the modifiable share of non-attendance.

**Estimand.** The proportion of missed sessions with concordant, discordant and non-assessable reason coding, and the change in the estimated transport-attributable fraction of missed sessions when the transport record rather than the chart is used as the reference.

**Design.** Cross-sectional record-concordance study on the missed-session subset, with agreement quantified by Cohen's kappa or, if reasons are multi-category, by a weighted kappa plus a confusion matrix. No modelling beyond agreement statistics is required, which is what makes this the most robustly completable question within one part-time analyst's six months.

**Data fields required.** The free-text or coded reason field in the attendance record; the transport record's disposition for the corresponding trip; and a linkage key. The published precedent for coding reasons from how they were recorded is the nurse-recorded narrative used in the psychosocial single-centre review, which "cited concurrent illness, limited disease understanding, family obligations, and logistical barriers as common reasons for missed sessions" [27], and the DATIX incident-report ascertainment used in the England cohort [5].

**Precedent.** Agreement studies between record sources are not established in this literature — the retrieved studies take one source as given [1][5][7][22][27] — so this is a measurement study whose precedent comes from the general method of cross-source record validation rather than from the dialysis-adherence field. That absence is the reason to do it: every transport-attributable estimate in the field, including the national cohort's "missed dialysis treatments attributed to transportation" outcome [3], depends on a single unvalidated attribution.

**Falsification.** Fails if chart reasons and transport records agree closely, in which case the simpler and cheaper chart-reason ascertainment is adequate and should be adopted — a useful negative result, and a published one.

**Feasibility.** Highest along with Q4, and it is the natural first analysis because it is descriptive, needs no outcome data, and its result determines whether Q1 and Q2 are worth attempting in their strong form. If the transport record turns out to be coarse or the chart reason is almost always blank, this question converts a probable failure into a documented finding in weeks rather than months.

**Novelty:** No direct answer identified within this search. The closest works treat reason attribution as unproblematic: the national transport cohort's outcome "missed dialysis treatments attributed to transportation" is derived from facility attribution without an independent check [3]; the England cohort used incident reports [5]; the psychosocial review used nurse narratives on the day of non-attendance [27]. The bounded search behind this statement covered the subject, method, comparator and absence axes but not preprints or Chinese-language databases. The axis of difference is the object of study: not who misses sessions, but whether the reason attached to a missed session is true. A reader gains a direct estimate of misattribution and, with it, a correction to the modifiable fraction that all downstream intervention planning depends on.

### Q6 — Can attendance and transport records identify, with honest performance estimates, who to contact this week?

**Hypothesis.** A pre-specified model using only variables available before the start of a dialysis week (recent attendance history, transport mode and reliability, day-of-week and shift position) discriminates patients who will miss a session in the coming week better than the unit's current practice of contacting by clinical impression.

**Estimand.** Discrimination (AUROC with confidence interval) and calibration (calibration slope and intercept) of a prespecified model for the outcome "≥1 missed session in the coming dialysis week", reported against the unit's current referral rule, with internal validation only.

**Design.** Retrospective prediction-model development with internal validation — temporal split or bootstrapped optimism correction — reported against TRIPOD. **Not** a target-trial emulation and **not** an intervention evaluation: no new recruitment is permitted, so the model cannot be tested prospectively within this project, and any claim that it improves outcomes is out of scope.

**Data fields required.** Everything in Q1 and Q4 plus a clean weekly time index. The binding constraint is events per variable: with one centre, the number of patients and the number of missed-session weeks determine whether a multivariable model can be fitted at all. This must be computed from the audit, not assumed; if the event count is small the model must be restricted to two or three predictors or abandoned in favour of Q4.

**Precedent.** A predictive nomogram for medication non-adherence in hemodialysis patients exists [31] and suggests that prediction modelling has been applied in this population, but it predicts medication non-adherence rather than session attendance, it is based on questionnaires from 206 patients in a single Chinese city, and its predictor set is questionnaire-based — which is unavailable to a records-only project. It is therefore a weak precedent, cited for the acceptability of the approach rather than for its predictor structure. The absence of a session-attendance prediction model in the retrieved set is the gap.

**Falsification.** Fails if AUROC does not exceed the unit's existing rule, or if calibration is poor, or — the finding that matters most — if performance is no better than predicting every patient will attend, which is the base rate in a unit with a low missing rate [1][2] and would mean case-finding is the wrong intervention paradigm here.

**Feasibility.** Lowest of the six and honestly reported as such. Six months, one part-time analyst and no new recruitment mean the model can be developed and internally validated but not prospectively verified, and overfitting is a serious risk at single-centre scale. It is included because a research agenda that omits the question a hospital most wants answered is not useful, and because its feasibility is decidable from the same audit as the rest — but it should not be the first thing attempted.

**Novelty:** No direct answer identified within this search. The closest work is a nomogram for medication non-adherence in hemodialysis patients [31] and machine-learning-directed interventions to reduce fluid-related admissions [32], neither of which predicts session attendance from operational records. The bounded search behind this statement did not cover preprints or Chinese-language databases, and one PubMed query on this exact axis returned zero records, which in this deployment indicates query shape rather than an empty literature. The axis of difference is the exposure being predicted — objectively recorded session attendance, from fields that exist before the week begins. A reader gains a defensible answer to whether records alone can support case-finding, including the answer "no, the events are too few", which is worth knowing before a unit buys a system.

---

## 6. Overlap check against registered and ongoing studies

Registrations were searched to establish which questions are already committed. Eleven registered studies were retrieved on adherence and missed-session terms; the following are the ones whose endpoints overlap this agenda. A registration is a planned study, not an observed effect.

| Registration | Title | Status | Overlap |
|---|---|---|---|
| NCT05735743 [45] | MoVE Trial: Motivational Strategies to Empower African Americans to Improve Dialysis Adherence | Active, not recruiting | Overlaps the intervention space (motivational interviewing), not this agenda's observational questions |
| NCT05003115 [51] | Motivational Strategies To Empower African Americans To Improve Dialysis Adherence | Completed | The predecessor of NCT05735743, testing the same motivational-interviewing approach; it overlaps the intervention space and, like it, does not address any of this agenda's observational questions |
| NCT03595748 [48] | Peer Mentorship to Improve Outcomes in Patients on Maintenance Hemodialysis (PEER-HD) | Completed; protocol published [33] | Primary outcome is a composite count of ED visits and hospitalizations; dialysis adherence metrics are secondary [33]. Overlaps Q2's harm endpoint and Q6's use case, in a recruited RCT design unavailable here |
| NCT03978806 [47] | Prosperando: Fostering Resilience on Dialysis (Navigate-Kidney) | Completed; results published [29] | Randomised community-health-worker intervention; secondary outcomes included missed and shortened dialysis sessions and showed fewer shortened sessions with the intervention (P = .02) [29]. Overlaps Q3's behaviour separation and provides a comparator, but is an intervention trial |
| NCT02970201 [46] | Improving Adherence in Renal Dialysis Patients Through Electronic Interventions | Completed | Overlaps Q6's use case (electronic targeting) |

**Unresolved overlap.** The ClinicalTrials.gov query was keyword-based and returned 11 records; a systematic registry sweep by intervention and outcome was not performed, and the ICTRP and Chinese registry ChiCTR were not separately searched. The practical consequence is that the overlap check is weakest for the questions whose endpoints are least likely to appear in a keyword-indexed registry record and most likely to appear in a local quality-improvement project: **Q5** (reason-record concordance, which is rarely registered at all) and **Q4** (attendance persistence, which may exist as unpublished service data). For **Q1** and **Q6**, a registered study with the same exposure and endpoint is conceivable but would require a registry entry naming session-level transport linkage explicitly, which this search would have returned. Q2 and Q3 have published comparators identified above and rest less on the registry check. A registered study whose primary endpoint is session-level attendance linked to transport records could still exist and would not have been found. This is recorded as a limitation, not closed.

---

## 7. Prioritisation and the recommended next step

Ordering is by what can actually be delivered within six months by one part-time analyst on these records, weighted by how much of the answer would be new. The ordering is stated as at the start of the project, before the field audit; it is not the ordering that will apply afterwards, and the first two ranks are expected to swap if the audit is positive on transport event fields — see "What would change this agenda" below.

| Rank | Question | Why here | Principal risk |
|---|---|---|---|
| 1 | **Q5** — reason-record versus transport-record concordance | Descriptive, no outcome linkage, completes in weeks, and its result decides whether Q1 and Q2 are worth attempting in strong form | Chart reason field may be largely blank |
| 2 | **Q1** — session-level transport events and missed sessions | The one question only this dataset can answer; national cohorts have mode, not events | Transport records may be invoicing-level, not event-level |
| 3 | **Q4** — persistence and clustering | Needs only attendance; can be run regardless of the transport field audit; substantive either way | Single-centre sample may not support latent-class modelling |
| 4 | **Q2** — rescheduling and its determinants | Strong published comparator to place a result against [6]; operational target | Attendance record may not distinguish rescheduled from absent |
| 5 | **Q3** — shortened versus missed sessions | Cheap (one duration field); reframes the size of the problem [7][9] | Delivered duration may only be recorded as prescribed |
| 6 | **Q6** — records-only risk model | The question the hospital most wants answered | Likely too few events; no prospective verification possible |

**Recommended next step, in order, before any analysis is written.**

1. **Weeks 1–2: field audit.** Produce a data dictionary for the attendance and transport extracts. The decisive items are: does attendance record scheduled-versus-attended-versus-rescheduled; is there a delivered session duration; is there a reason field and how complete is it; does the transport record carry per-trip dates, pickup and arrival times, provider type, cancellation reason and cost; and is there a patient key linking the two. Report the audit as a deliverable in its own right. Four of the six questions change shape depending on its result.
2. **Weeks 2–3: ethics and data governance.** Confirm the approvals and data-sharing basis for record-level analysis. The brief does not state their status; they are a precondition and not an assumption.
3. **Weeks 3–4: event count.** Compute the number of patients, scheduled sessions, missed sessions and — if an outcome source exists — emergency or admission events. This number decides whether Q6 is attempted at all and whether Q1 is analysed at session level or only at patient level.
4. **Weeks 4–6: pre-register.** Fix the primary question from the ranking above, the estimand, the analysis model, the covariate set and the sensitivity analyses, before looking at associations. All six questions here are observational and none can be randomised, so pre-specification is the only protection available.
5. **Months 2–6: execute the pre-registered analysis** on the highest-ranked question that the audit did not disqualify, plus Q4 as the low-dependency fallback.

**What would change this agenda.** A positive audit on transport event fields moves Q1 to first rank and makes Q5 its prerequisite. An audit showing that transport records are aggregate invoices collapses Q1, removes the strongest form of Q2 and guts Q5, leaving Q4 and Q3 — both still publishable, both already partly occupied. A finding that the unit's missed-session rate is at the low end of the international range [1] would make Q6's base-rate problem acute and should trigger dropping it early rather than late.

---

## 8. Risks and limitations of this agenda

- **The novelty statements are bounded by an incomplete search.** Preprints and Chinese-language databases were not covered, and the citation graph was shallow. Each novelty line says what was searched and what the closest work is; none of them asserts that a question is unoccupied across the field, and one PubMed query on the prediction-model axis returned zero records in a deployment where that indicates query shape.
- **Everything here is observational.** No question can be randomised within the constraints, so no result will establish causation. The closest available designs are within-patient comparisons, which remove time-invariant confounding and nothing else.
- **The data are described but not inspected.** "Existing attendance and transport records" is a description, not a data dictionary. Every data-requirement list above is a specification of what would be needed, not a statement of what exists.
- **Sample size is unknown and is not estimated here.** No effect size, power calculation or expected missing rate is asserted, because none can be computed before the audit. Inventing one would be the easiest way to make this agenda look complete and be wrong.
- **The specialist analysis run for this report ranked a target-trial emulation first, and this report does not.** The reasoning is set out in §9 so the disagreement is visible rather than averaged away.
- **This is a research agenda, not clinical guidance.** Nothing here recommends a change to any patient's treatment, and no finding should be applied to an individual without local clinical and governance review.

---

## 9. Where this report disagrees with the specialist analysis run alongside it

A structured topic-selection analysis was run on the same brief (run **topic-20260928043524-416fa9e331a9**) and produced three ranked opportunities, preserved in the companion portfolio file [34]. It is a first map, and on three points the wider search in §2–§4 changes the picture. The disagreements are recorded because a reader should not have to reconcile two documents that quietly differ.

1. **It ranked a clone-censor-weight target trial emulation first; I rank it below all six questions above, and I do not recommend it.** The design is legitimate in principle, and its own entry is candid that feasibility is conditional on unconfirmed outcome and covariate fields. But clone-censor-weight estimation requires a reproducible time zero, a well-defined time-varying strategy, a correctly specified censoring model and enough events to support weighting. At one community hospital, with an unknown number of patients, unknown outcome linkage, six months and one part-time analyst, the most likely outcome is an uninterpretable estimate with unstable weights — and the method's failure mode is not a null result but a confident-looking number that no one can falsify. If the audit shows a large cohort with reliable outcome dates, a simpler within-patient design (Q2 here) captures most of the same question at a fraction of the risk.
2. **It ranked an instrumental-variable design using transport shocks second; I drop it.** The exclusion restriction — that a transport disruption affects outcomes only through dialysis attendance — is untestable in this data, and a single centre will experience too few disruptions to power a first stage. Its own entry concedes that if shocks are rare the design "degrades to a descriptive time series". A design that is only defensible when it degenerates should be presented as what it is: a descriptive interrupted-time-series audit of local transport disruptions, which is worth doing as service evaluation but is not a novel question and should not be the second-ranked research priority.
3. **It did not rank the rescheduling question (Q2 here) or the reason-concordance question (Q5 here), and I rank those above two of its three.** Rescheduling has a strong published comparator to place a result against [6] and an operational action attached to it; reason concordance is the cheapest way to find out whether the transport record is usable at all. Both exploit the specific records described in the brief more directly than the target-trial-emulation framing does.

One point of agreement is worth recording. Its third opportunity — a qualitative barrier taxonomy built from the free text of non-attendance records — is close to Q5 here in mechanism and identical in its precondition: it succeeds or fails on whether a free-text field exists at all. The differences above are about ranking and risk, not about the value of the underlying questions.

---

## References

[1] Missed Hemodialysis Treatments: International Variation, Predictors, and Outcomes in the Dialysis Outcomes and Practice Patterns Study (DOPPS). *Am J Kidney Dis.* 2018. https://pubmed.ncbi.nlm.nih.gov/30146421/

[2] Hospitalization and mortality following non-attendance for hemodialysis according to dialysis day of the week: a European cohort study. *BMC Nephrol.* 2020. https://pubmed.ncbi.nlm.nih.gov/32517695/

[3] Transportation Insecurity and Outcomes in Hemodialysis Patients: A Retrospective Cohort Study. *Clin J Am Soc Nephrol.* 2025. https://pubmed.ncbi.nlm.nih.gov/40512563/

[4] Inclement Weather and Risk of Missing Scheduled Hemodialysis Appointments among Patients with Kidney Failure. *Clin J Am Soc Nephrol.* 2023. https://pubmed.ncbi.nlm.nih.gov/37071662/

[5] Hemodialysis Nonattendance: Patient Characteristics and Outcomes in a Single Renal Center in North West England. *Hemodial Int.* 2025. https://pubmed.ncbi.nlm.nih.gov/40051030/

[6] Impact of Rescheduling a Missed Hemodialysis Treatment on Clinical Outcomes. *Kidney Med.* 2020. https://pubmed.ncbi.nlm.nih.gov/32734224/

[7] Prevalence of missed treatments and early sign-offs in hemodialysis patients. *J Am Soc Nephrol.* 1993. https://pubmed.ncbi.nlm.nih.gov/8305644/

[8] Missing In-Center Hemodialysis Sessions among Patients with End Stage Renal Disease in Banda Aceh, Indonesia. *Int J Environ Res Public Health.* 2021. https://pubmed.ncbi.nlm.nih.gov/34501804/

[9] Prevalence and Predictors of Nonadherence to Treatment in Adult Patients Undergoing In-Centre Haemodialysis in Public Dialysis Units. *Nurs Res Pract.* 2026. https://pubmed.ncbi.nlm.nih.gov/42787897/

[10] Factors Contributing to Non-Adherence to Treatment Among Adult Patients with Long-Term Haemodialysis: An Integrative Review. *Nurs Rep.* 2025. https://pubmed.ncbi.nlm.nih.gov/41003269/

[11] Context Matters: A Qualitative Synthesis of Adherence Literature for People on Hemodialysis. *Kidney360.* 2023. https://pubmed.ncbi.nlm.nih.gov/36700903/

[12] In-Center Hemodialysis Patients Who Miss Multiple Dialysis Sessions Experience Higher Mortality Rates. *Am J Kidney Dis.* 2012. **Conference abstract**, not a full paper; the cohort figures are as reported in the abstract. https://doi.org/10.1053/j.ajkd.2012.02.181

[13] Missed dialysis sessions and hospitalization in hemodialysis patients after Hurricane Katrina. *Kidney Int.* 2009. https://pubmed.ncbi.nlm.nih.gov/19212421/

[14] Vascular access thrombosis and interventions in patients missing hemodialysis sessions. *Clin Nephrol.* 2011. https://pubmed.ncbi.nlm.nih.gov/22105445/

[15] Association of the Comprehensive ESRD Care Model with Treatment Adherence. *Kidney360.* 2022. https://pubmed.ncbi.nlm.nih.gov/35845340/

[16] Impact of anxiety symptoms on dialysis adherence and complication rates: A longitudinal observational study. *World J Psychiatry.* 2024. https://pubmed.ncbi.nlm.nih.gov/39704368/

[17] Behavioral interventions targeting treatment adherence in chronic kidney disease: A systematic review and meta-analysis. *Soc Sci Med.* 2025. https://pubmed.ncbi.nlm.nih.gov/39842385/

[18] Hemodialysis Self-management Intervention Randomized Trial (HED-SMART): A Practical Low-Intensity Intervention to Improve Adherence and Clinical Markers in Patients Receiving Hemodialysis. *Am J Kidney Dis.* 2018. https://pubmed.ncbi.nlm.nih.gov/29198641/

[19] Effectiveness of a Multifaceted Educational Intervention to Enhance Therapeutic Regimen Adherence and Quality of Life Amongst Iranian Hemodialysis Patients (MEITRA). *J Multidiscip Healthc.* 2020. https://pubmed.ncbi.nlm.nih.gov/32341649/

[20] Comparing the effectiveness of emotion regulation therapy and cognitive behavioral therapy on treatment adherence in hemodialysis patients. *PLoS One.* 2025. https://pubmed.ncbi.nlm.nih.gov/41452823/

[21] Impact of a nurse-led educational intervention on knowledge and adherence to hemodialysis in Kiambu County, Kenya. *Front Public Health.* 2026. https://pubmed.ncbi.nlm.nih.gov/42422671/

[22] Social determinants of health associated with hemodialysis non-adherence and emergency department utilization: a pilot observational study. *BMC Nephrol.* 2020. https://pubmed.ncbi.nlm.nih.gov/31906871/

[23] Impact of individual socioeconomic deprivation on hemodialysis care and patient behavior: a multicenter French study (Precadia). *Clin Kidney J.* 2025. https://pubmed.ncbi.nlm.nih.gov/40861382/

[24] Predictors of missed hemodialysis in end-stage renal disease patients presenting to the emergency department. *Am J Emerg Med.* 2026. https://pubmed.ncbi.nlm.nih.gov/41448103/

[25] Geospatial Visualization of Dialysis Accessibility in Shiraz: A Nonanalytical Geographic Information System Approach. *Health Sci Rep.* 2025. https://pubmed.ncbi.nlm.nih.gov/40787128/

[26] Patients' Perspectives on Access to Dialysis and Kidney Transplantation in Rural Communities in Australia. *Kidney Int Rep.* 2022. https://pubmed.ncbi.nlm.nih.gov/35257071/

[27] Psychosocial factors in patients who miss hemodialysis sessions: a single-center retrospective review. *Ren Fail.* 2026. https://pubmed.ncbi.nlm.nih.gov/42410327/

[28] Longer dialysis session length is associated with better intermediate outcomes and survival among patients on in-center three times per week hemodialysis: results from DOPPS. *Nephrol Dial Transplant.* 2012. https://pubmed.ncbi.nlm.nih.gov/22431708/

[29] Community Health Worker Support for Hispanic and Latino Individuals Receiving Hemodialysis: The Navigate-Kidney Randomized Clinical Trial. *JAMA Intern Med.* 2026. https://pubmed.ncbi.nlm.nih.gov/41203234/

[30] Impact of COVID-19 pandemic on care of maintenance hemodialysis patients: a multicenter study. *Clin Exp Nephrol.* 2024. https://pubmed.ncbi.nlm.nih.gov/38702493/

[31] Development of a Predictive Nomogram for Estimating Medication Nonadherence in Hemodialysis Patients. *Med Sci Monit.* 2022. https://pubmed.ncbi.nlm.nih.gov/35290293/

[32] Use of machine learning directed interventions to reduce fluid related hospital admissions in hemodialysis patients. *Nephrol Dial Transplant.* 2024. **Conference abstract**, not a full paper. https://doi.org/10.1093/ndt/gfae069.824

[33] Peer mentorship to improve outcomes in patients on hemodialysis (PEER-HD): a randomized controlled trial protocol. *BMC Nephrol.* 2022. https://pubmed.ncbi.nlm.nih.gov/35247960/

[34] Specialist topic-selection analysis run on the same brief; its ranked opportunities, evidence IDs and reconciliation are preserved in the companion `research-portfolio.json` and its retrieval in `evidence-records.json`.

[35] In-center hemodialysis attendance: patient perceptions of risks, barriers, and recommendations. *Hemodial Int.* 2014. https://pubmed.ncbi.nlm.nih.gov/24447838/

[36] Factors Influencing Adherence to Hemodialysis Sessions among Patients with End-Stage Renal Disease in Makkah City. *Saudi J Kidney Dis Transpl.* 2021. https://pubmed.ncbi.nlm.nih.gov/35102919/

[37] Factors Affecting Adherence to Hemodialysis Therapy Among Patients With End-Stage Renal Disease Attending In-Center Hemodialysis in Al-Ahsa Region, Saudi Arabia. *Cureus.* 2023. https://pubmed.ncbi.nlm.nih.gov/38022334/

[38] FACTORS IMPACTING HEMODIALYSIS TREATMENT ADHERENCE IN END-STAGE RENAL DISEASE PATIENTS RECEIVING IN-CENTER HEMODIALYSIS IN QASSIM REGION. *Georg Med News.* 2025. https://pubmed.ncbi.nlm.nih.gov/41072515/

[39] Natural Disasters in the Americas, Dialysis Patients, and Implications for Emergency Planning: A Systematic Review. *Prev Chronic Dis.* 2020. https://pubmed.ncbi.nlm.nih.gov/32530396/

[40] The impact of Australian-related extreme weather events on healthcare delivery and services for patients with chronic kidney disease (CKD): a scoping review. *Rev Environ Health.* 2026. https://pubmed.ncbi.nlm.nih.gov/42467742/

[41] NKF KDOQI Clinical Practice Guidelines and Clinical Practice Recommendations, 2006 Updates: Hemodialysis Adequacy. Guideline 4, clinical practice recommendation 4.4 ("Missed and shortened treatments", grade B). https://kidneyfoundation.cachefly.net/professionals/KDOQI/guideline_upHD_PD_VA/hd_guide4.htm

[42] Emergency Department Utilization after Initiation of Intermittent Hemodialysis: A Retrospective Cohort Study in Regina, Saskatchewan. *Can J Kidney Health Dis.* 2026. https://pubmed.ncbi.nlm.nih.gov/42719390/

[43] Hemodialysis under fire: A cross-sectional study of health and socioeconomic impacts on internally displaced patients during the 2023 Sudan conflict. *Medicine (Baltimore).* 2026. https://pubmed.ncbi.nlm.nih.gov/41517738/

[44] End-stage kidney diseases in areas of conflict: patients' perspective and patient access to hemodialysis services in Northwest Syria. *BMC Health Serv Res.* 2025. https://pubmed.ncbi.nlm.nih.gov/40317027/

[45] MoVE Trial: Motivational Strategies to Empower African Americans to Improve Dialysis Adherence. ClinicalTrials.gov. https://clinicaltrials.gov/study/NCT05735743

[46] Improving Adherence in Renal Dialysis Patients Through Electronic Interventions. ClinicalTrials.gov. https://clinicaltrials.gov/study/NCT02970201

[47] Prosperando: Fostering Resilience on Dialysis. ClinicalTrials.gov. https://clinicaltrials.gov/study/NCT03978806

[48] Peer Mentorship to Improve Outcomes in Patients on Maintenance Hemodialysis. ClinicalTrials.gov. https://clinicaltrials.gov/study/NCT03595748

[49] Barriers and delays to healthcare at time of death: qualitative analysis of Los Angeles County death records of people experiencing homelessness. *BMC Public Health.* 2025. https://pubmed.ncbi.nlm.nih.gov/40369455/

[50] Factors influencing perceived importance of haemodialysis adherence among end stage kidney failure patients in tertiary care centres in Nepal. *PLoS One.* 2026. https://pubmed.ncbi.nlm.nih.gov/42308251/

[51] Motivational Strategies To Empower African Americans To Improve Dialysis Adherence. ClinicalTrials.gov. https://clinicaltrials.gov/study/NCT05003115
