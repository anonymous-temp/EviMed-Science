# Missed dialysis sessions and adherence in adults on maintenance haemodialysis

**An actionable research agenda for one community-hospital dialysis service**

Setting: community hospital, adults on maintenance haemodialysis. Available data: the hospital's existing
attendance and transport records; no biospecimens; no new recruitment. Resources: six months, one part-time
analyst.

---

## Bottom line

The field has settled the question of whether missed sessions matter, and it has settled much of the
"who misses" question at national scale. What a single community hospital can contribute is not another
association study but four things a national database cannot do: an explicit **definitional audit** of its own
missed-session rate; a **transport-mode analysis built on trip-level local records** rather than a once-only
questionnaire; a **local test of whether same-week make-up sessions offset the risk of a miss**; and a
**documented-reason triage** that asks which recorded reasons predict a return to the next session.

Nine candidate questions are set out below, each with its closest published competitor, the axis on which it
differs, the fields it needs, and the result that would falsify it. The strongest and cheapest first step is
Q3 (definition audit) run together with Q2 (transport mode), because both need only the records already held
and both change what every later number means; Q1 and Q4 are the natural second pair. Two directions that the
search showed to be already answered — "does missing dialysis harm patients" and "does inclement weather
increase missed appointments" — are dropped rather than re-proposed, and the reason is given in §9.

Confidence in the field map as a whole: **moderate**. The consequence literature is large, consistent and
mostly observational; the transport, weather and rescheduling literatures are each dominated by one or two
large database cohorts; and the interventions literature is heterogeneous in outcome choice, which is why
attendance rarely appears as a primary endpoint.

---

## 1. Search scope

Searches were run on 27 September 2026, in English and Chinese, and were recorded with identifier and URL in
`evidence-map.md` (one row per work).

| Channel | Query intent | What came back |
|---|---|---|
| PubMed | missed/skipped/non-attended haemodialysis sessions; non-adherence outcomes; day-of-week scheduling; measurement instruments | Records with MeSH indexing; abstract retrieval for every retained record |
| Europe PMC | full-text search for "missed dialysis" with mortality/hospitalisation; intervention reviews; psychosocial and single-centre non-attendance work | Candidate and comparator studies, incl. 2025–2026 single-centre reports |
| Europe PMC preprints (`SRC:PPR`) | what is not yet published on missed sessions | **Zero records** for the query used; recorded as an empty channel, not as absence of evidence |
| OpenAlex | size and shape of the adherence literature; older landmark studies; intervention precedents | 2008–2023 records with abstracts, citation context not used |
| Crossref | very recent and non-MEDLINE material (posted content, registrations, editorials) | Two Kidney Medicine items on rescheduling, an ISRCTN registration, recent logistics work |
| ClinicalTrials.gov | registered questions on dialysis adherence interventions | 11 registrations screened (motivational interviewing, peer mentorship, messaging, navigation, VR) |
| Guideline index | what practice already recommends about adherence and adequacy | 25 guideline records screened (KDOQI, KSN, UKKA/RA, Chinese evidence summaries) |
| Open web | society, registry and funder pages; leads only | Leads followed to primary records; nothing cited from an unreviewed page |
| Bibliometric feed | publication-volume shape of the topic | Job started; see §6 for what is and is not used |

Two channels did not answer. Europe PMC's preprint filter returned no records for the query shape used, and
Semantic Scholar returned HTTP 429 on the one attempt made (rate-limited without a key), so the citation-graph
channel is missing from this map. Neither is reported as evidence of an empty literature. The Chinese-language
index was searched but returned mostly cross-sectional adherence-factor studies with unusable detail for a
local audit; two are retained (see evidence map). No local data file was inspected: the brief supplies a
description of records, not access to them, and every "field exists" statement below is written as something
to verify.

**Conventions used below.** Every quantitative value in this agenda is either quoted from the publication
cited beside it, or explicitly marked as a projection with its inputs and assumptions stated — only the
event-count arithmetic in §6 is of the second kind. No value here is an output of an automated analysis of the
topic: the first-pass scan of the direction returned 16 records and is used as a first map only, and the
publication-shape analysis is reported as degraded in §6 rather than quoted.

---

## 2. Field map

### 2.1 What the consequence literature has settled

Skipping sessions is associated with death and hospitalisation in cohort after cohort. In the DOPPS
international study, skipping one or more sessions a month carried a mortality relative risk of 1.30
(P = 0.01) and a hospitalisation relative risk of 1.13 (PMID 12787417 [2]). A 15,340-patient US network cohort
found that the odds of missing at least one treatment in a month were higher below age 55 (OR 1.33), differed
by race, and were higher for Tuesday/Thursday/Saturday than Monday/Wednesday/Friday schedules (OR 1.33), with
misses most prevalent on Saturdays (DOI 10.1093/ckj/sfs071 [3]). The European ARO cohort analysed 3.8 million
sessions in 9,397 patients and found day-specific non-attendance of 0.6–1.4%; in the 48–72 hours after a
missed session, mortality rose from 4.86 to 51.9 per 100 patient-years and hospitalisation from 0.58 to
2.1 per year, with a hazard ratio for mortality of 2.04 (95% CI 1.27–3.29) when the miss was the first rather
than the second session of the week (PMID 32517695 [1]). A 360-patient incident cohort found dialysis
non-adherence independently associated with emergency-department use across all visit-count categories, with
an RRR of 7.34 (2.81–19.20) for more than three visits (PMID 42719390 [13]).

This is enough to stop treating "are missed sessions harmful?" as an open question. It is also entirely
observational: the confounder story (patients who miss sessions are sicker, poorer and more depressed) has
never been closed with a design that removes it, which is why the questions below are framed as
within-patient contrasts or strategy comparisons rather than as another adjusted association.

### 2.2 Measurement and definitions are the weakest joint

Reported missed-session rates in the retrieved literature are not one quantity. By dialysis day, non-attendance
was 0.6–1.4% of sessions in the ARO cohort [1]. One US network abstract measured 8.3% of sessions missed and
quoted earlier reports as ranging from 1% to 10% (Blume 2012; the evidence-map row for it has no public
identifier, so this figure rests on the abstract as retrieved). A single-centre psychology review classified 11.6% of its patients as missing four or more
sessions over two years [8]. A cross-sectional survey found 28% of patients missing at least one session in the
month before the survey [9]. A single English centre recorded any non-attendance in 32% of its patients [7].
Once fluid and diet are folded in, an integrative review describes non-adherence of roughly 60% [26].
The peritoneal-dialysis review makes the mechanism explicit: exchange non-adherence 2.6–53%, medication
3.9–85%, diet/fluid 14.4–67%, with the authors attributing the spread to measurement and definition
differences (DOI 10.1371/journal.pone.0089001 [27]). Domain matters even inside one cohort: in a Malaysian study,
self-reported dialysis compliance was 91.0% while dietary compliance was 27.7% and fluid 24.5%
(DOI 10.1371/journal.pone.0041362 [28]).

Two more measurement facts constrain what a local audit can claim. First, the field's instruments are
self-report (the ESRD-AQ was developed and validated for attendance, medication, fluid and diet;
OpenAlex W2200727227) and self-report agrees poorly with objective behaviour — in one study, reported
difficulty with adherence agreed with failure to reach clinical targets in only 52.9–65.3% of cases
(DOI 10.2147/ppa.s227191 [29]). Attendance records avoid that problem for the attendance domain only. Second,
"missed minutes" and "missed sessions" are different quantities: one 113-patient study re-displayed
attendance as missed minutes and produced categories (consistent underdialysis, inconsistent dialysis,
consistent dialysis) with heterogeneous behaviour inside each category (PMID 35243306 [11]).

### 2.3 Determinants: transport is now the best-evidenced modifiable exposure

A national cohort of 115,982 adults on in-centre haemodialysis found that 27% lacked private transport and
that every non-private mode carried a higher rate of missed treatments (aIRR 1.15–1.31; Medicaid transport
highest at 5.5 missed treatments per 100 expected versus 4.03 for private transport) and higher mortality
(aIRR 1.09–1.70). Transport-attributed misses were documented for only 0.21% of scheduled treatments against
4% missed for any reason other than hospitalisation — the authors suspect the documentation has low
sensitivity. Mediation analysis attributed 41% (Medicaid) and 29% (paratransit) of the transport–mortality
association to missed treatments, and each doubling of a smoothed missed-treatment rate was associated with
41% higher mortality (PMID 40512563 [6]). This is the single most useful comparator for a hospital whose records
are transport records.

Behavioural and clinical correlates are numerous and mostly cross-sectional: anxiety (missed-session IRR 1.32,
95% CI 1.18–1.47, PMID 39704368 [15]); mental-health history, smoking, alcohol excess and younger age (PMID
40051030); pruritus severity (PMID 37269433 [16]); social support (PMID 39408138 [25]); health literacy (Banda Aceh) [9].
Two findings cut against the tidy story and matter for interpretation: individual-level socioeconomic
deprivation in a 401-patient French multicentre study was associated with behavioural differences but **not**
with the frequency of missed dialysis sessions (PMID 40861382 [24]), and patient activation was associated with
mortality but **not** with missed treatment (PMID 39348206 [14]). Transport and psychology are not interchangeable
with deprivation, and a local analysis should not assume they move together.

### 2.4 Interventions exist, but attendance is rarely the endpoint

A systematic review of non-emergency medical transportation interventions pooled seven studies and found
fewer missed appointments with transport support (0.63, 95% CI 0.48–0.83), while concluding that evidence on
cost, utilisation and health outcomes was too sparse to support conclusions (PMID 35449011 [17]). In dialysis
specifically, the retrieved intervention trials target adherence indirectly: community-health-worker
navigation reduced shortened sessions (PMID 41203234 [32]), a pharmacist-led behaviour-change cluster-randomised
trial raised the good-adherence rate from 14.7% to 42.1% at one month (PMID 41023004 [33]), and a messaging
proof-of-concept raised median adherence in patients already identified as poor attenders
(DOI 10.1038/s41598-017-03184-z [31]; registration NCT02970201 [37]). A scoping review of 14 self-management RCTs found
outcomes concentrated on quality of life, self-management and self-efficacy rather than attendance
(PMID 40514662 [34]). Registered but not yet reported work is concentrated in motivational interviewing
(NCT05003115 [37], NCT05735743 [37]) and technology-assisted collaborative care (NCT06978127 [37]).

### 2.5 Method precedents that transfer

Three design families have direct precedent in this literature. Time-stratified **case-crossover** with
conditional Poisson regression was used to link inclement weather to missed appointments in 60,135 patients
(rainfall RR 1.03 per 10 mm; seven-day storm exposure RR 1.55, 95% CI 1.22–1.98; PMID 37071662 [10]) — the
precedent for a trigger analysis of missed sessions themselves. **Segmented regression interrupted time
series** is the standard for evaluating an operational change, with published tutorials and power methods
(PMID 27283160 [18], PMID 31429175 [20]) and a caution: in a methodological review of ITS quality-improvement studies,
72.5% were at high or very high risk of bias and only 55% modelled autocorrelation (PMID 33055094 [19]).
**Group-based trajectory modelling** is established for adherence in other chronic conditions
(PMID 24748809 [21], PMID 39912818 [22], PMID 40152795 [23]) but, in the retrieved dialysis literature, attendance has been
described categorically rather than modelled (PMID 35243306 [11]).

### 2.6 What practice guidance covers

The guideline records retrieved in this search are organised around dose, membrane and volume management and
monitoring. One of them is the KDOQI haemodialysis adequacy update (PMID 26498416 [36]); the national
haemodialysis guidelines retrieved alongside it are organised the same way. Across the whole retrieved set,
none sets a session-attendance target or a threshold at which non-attendance triggers a defined care response.
That gap is why a local audit can be directly actionable: there is no published benchmark to copy, so the
centre has to set and justify its own.

---

## 3. Evidence gaps, and where the literature contradicts itself

**Gap 1 — definitional, and completely open at any single centre.** No retrieved study compares alternative
operational definitions of "a missed session" inside one dataset, although published rates vary by more than
an order of magnitude and reviewers attribute that spread to definitions (DOI 10.1371/journal.pone.0089001 [27];
PMID 41003269 [26]). This is a gap a record audit closes in weeks. Confidence: **high** that the gap exists as
described within this search's scope.

**Gap 2 — transport as a recorded, repeated exposure rather than a baseline question.** The strongest
evidence uses one transport assessment per patient and chart-documented attribution that the authors
themselves suspect is insensitive (PMID 40512563 [6]). Trip-level records that change over time, and the
attribution question, are not answered by that design. Confidence: **moderate** — the absence is of a design,
not of the topic.

**Gap 3 — whether make-up sessions substitute for the missed session.** One large US analysis found
rescheduling attenuated but did not remove the hospitalisation excess (missed 2.09-fold, rescheduled
1.68-fold at seven days; PMID 32734224 [4]) and an accompanying editorial framed the operational question
(DOI 10.1016/j.xkme.2020.01.004 [5]). A payment-model evaluation showed rescheduling can be increased
(OR 1.09, 95% CI 1.05–1.14; PMID 35845340 [12]). No retrieved study estimates the strategy effect in a small
centre where make-up capacity is the binding constraint, and none is framed as a formal target trial.
Confidence: **moderate**.

**Gap 4 — documented reasons are collected but almost never used as predictors.** Single-centre work
catalogues nurse-recorded reasons (concurrent illness, limited disease understanding, family obligations,
logistics; PMID 42410327 [8]) and patient-level predictors (PMID 40051030 [7]), but no retrieved study tests whether
the reason recorded on the day predicts whether the patient returns for the next session. Confidence:
**moderate** (bounded search; a negative result here is weak because the search was not exhaustive).

**Contradictions worth naming.** (i) Deprivation versus attendance: individual-level deprivation was not
associated with missed sessions in the French multicentre study (PMID 40861382 [24]), while transport mode is
strongly associated with them in a US national cohort (PMID 40512563 [6]) — material hardship is not a single
construct. (ii) Psychological engagement versus behaviour: 88% of assessed frequent non-attenders had
pre-existing mental-health conditions, yet dialysis attendance improved in only 6 of 17 who engaged with
psychology (PMID 42410327 [8]) — presence of a psychological problem does not imply that treating it changes
attendance. (iii) Domain-specificity: resilience was associated with *better* medication adherence and
*worse* dialysis-session adherence in the same patients (DOI 10.1080/13548506.2016.1191658 [30]). Any local claim
about "adherence" as one thing is therefore at risk.

**Where this map disagrees with the first-pass specialist scan.** An automated first-pass scan of the same
direction (16 records, 2022–2026) proposed three opportunities: a psychosocial–physiological mediation chain,
exposure-phenotype standardisation, and target-trial emulation of rescheduling. The wider search in §2
changes two of them. Phenotype standardisation is partly occupied: missed-minutes categorisation already
exists in 113 patients (PMID 35243306 [11]), so it survives only as a definitions audit in a different setting
(Q3, Q5). The mediation chain requires psychological scales and laboratory variables that the supplied data
description does not include (no biospecimens, no recruitment), so it survives only as a field-availability
audit, which is exactly what §5 does. Target-trial emulation of rescheduling survives and is strengthened by
the 2019 comparator (Q4). The first-pass scan also did not surface the transport, weather or day-of-week
comparators, which is the main reason the agenda below is organised differently from it.

---

## 4. Candidate questions

Each question carries a labelled novelty line naming the closest published work, the axis of difference, and
what a reader would get that is not already available. Nine questions survive; §9 lists what was dropped.

### Q1 — Does the position of a missed session within the week modify the short-term risk of an acute care contact in this centre?

- **Population / exposure / outcome.** Adults on maintenance in-centre haemodialysis; exposure = a missed
  scheduled session classified by whether it was the first session after the two-day break or a later session
  of the week; outcome = unplanned emergency-department attendance or hospital admission within 7 and 30 days,
  and death where ascertainable.
- **Design and estimand.** Within-patient comparison (self-controlled) of event rates in the 0–7 day window
  after a missed first-of-week session versus after a missed later session, with the attended-session window
  as the reference. Estimand: rate ratio of acute care contact per 100 patient-weeks.
- **Data needed.** Date-level attendance with the prescribed weekly pattern; outcome dates (§5, fields A and G).
- **Falsification.** No difference in event rates by session position, or the difference disappears once the
  length of the scheduled interdialytic interval is in the model.
- **Feasibility.** Moderate but data-dependent: it collapses if outcome linkage (field G) is unavailable.
- **Novelty:** occupied but not in this setting. The ARO European cohort answered it at 9,397 patients and
  3.8 million sessions (PMID 32517695 [1]), giving non-attendance rates of 0.6–1.4% and an HR of 2.04 for missing
  the first session after the two-day break; what is left is a single community hospital where the transport
  mode of the missed trip is observable, so the question becomes whether the day-of-week effect is
  partly transport-mediated locally. A reader gains a local, transport-stratified replication rather than a
  new association.

### Q2 — Which transport arrangements predict missed sessions in this centre, and does the local ranking match the published one?

- **Population / exposure / outcome.** Adults on maintenance haemodialysis; exposure = transport mode
  (own or family car, hospital-arranged, public transport, taxi/paid, other) and any change in mode over the
  record period; outcome = missed sessions per 100 expected sessions, and transport-attributed misses.
- **Design and estimand.** Retrospective cohort of patient-months; log-linear (Poisson or negative binomial)
  model with the log of expected sessions as offset, clustered by patient. Estimand: adjusted incidence rate
  ratio of missed sessions per 100 expected sessions, by mode.
- **Data needed.** Fields A and F, plus a documented-reason field (B) for the attribution sub-question.
- **Falsification.** No mode-specific difference; or the difference vanishes after adjustment for dialysis
  vintage and comorbidity; or the local mode ranking is the reverse of published rankings.
- **Feasibility.** High, provided transport is recorded per patient at minimum; the strongest version needs
  trip-level records.
- **Novelty:** occupied at national scale, not locally. The comparator is the 115,982-patient CJASN cohort
  (aIRR 1.15–1.31 for missed treatments by non-private mode; PMID 40512563 [6]). The axes of difference are the
  transport system (that cohort's modes are US Medicaid/paratransit/public transit) and the exposure
  measurement (one assessment versus repeated trip records). A reader gains a mode ranking for a catchment
  the published cohorts do not represent, which is what a local transport decision would need.

### Q3 — How much does the centre's own missed-session rate move when the definition changes?

- **Population / exposure / outcome.** All scheduled sessions in the record period; exposure = none (this is
  a measurement study); outcome = the missed-session rate under six pre-specified definitions: (1) any
  non-attendance; (2) non-attendance excluding hospitalisation and other recorded excuses; (3) the same
  excluding sessions later made up; (4) missed minutes as a proportion of prescribed minutes; (5) patients
  rather than sessions as the denominator; (6) a "two or more misses" patient-level threshold.
- **Design and estimand.** Descriptive cross-tabulation with exact confidence intervals, plus the rank
  correlation between definitions at patient level. Estimand: the rate under each definition and the
  difference between the highest and lowest.
- **Data needed.** Fields A–E. No outcome linkage required, which is why this is the cheapest question here.
- **Falsification.** Definitions agree within ±10% relative, in which case definitional sensitivity is
  locally unimportant and can be dropped from all later reporting.
- **Feasibility.** High; this is the natural first analysis for a part-time analyst.
- **Novelty:** no direct answer identified in this search. Published rates span 0.6% of sessions to ~60% of
  patients depending on domain and definition (PMID 41003269 [26]; DOI 10.1371/journal.pone.0089001 [27];
  DOI 10.1371/journal.pone.0041362 [28]), and the 113-patient missed-minutes study defines categories rather than
  comparing definitions (PMID 35243306 [11]). Closest neighbours each fix one metric; the axis left is a
  head-to-head comparison inside one cohort. A reader gains the number they should quote and the error bars
  around it. Bounded-search caveat: the search would not reliably find an unpublished local definitional
  audit, and none is claimed to be absent from the field.

### Q4 — Does attending a make-up session offset the risk carried by a missed session?

- **Population / exposure / outcome.** Adults with at least one missed session; exposure = whether a make-up
  session was delivered before the next scheduled session (a strategy, not a patient trait); outcome =
  emergency-department attendance or admission at 7 and 30 days.
- **Design and estimand.** Target trial emulation: two strategies (make-up offered and delivered versus not),
  with the index miss as time zero, eligibility requiring attendance at the three preceding scheduled
  sessions, and adjustment for time-varying confounders that are themselves consequences of the miss
  (documented reason, acute illness). Estimand: per-protocol risk difference and risk ratio at 7 and 30 days,
  with a negative-control outcome (for example, a non-fluid, non-electrolyte admission category) as a
  bias check.
- **Data needed.** Fields A, B, C, G; the make-up link (field C) is the gating field.
- **Falsification.** No difference in 7- or 30-day event rates between make-up and no-make-up strategies;
  or the association attenuates to the null under the negative-control check.
- **Feasibility.** Moderate: needs outcome linkage plus a defensible make-up definition.
- **Novelty:** occupied in a large US cohort, not as a strategy comparison locally. The closest work is the
  2019 Medicare analysis (missed 2.09-fold and rescheduled 1.68-fold higher 7-day hospitalisation;
  PMID 32734224 [4]) with its editorial framing (DOI 10.1016/j.xkme.2020.01.004 [5]) and a payment-model study
  showing rescheduling can be increased (PMID 35845340 [12]). What is left: whether a small centre with fixed
  chair capacity can reproduce the attenuation, and whether the estimand survives a formal target-trial
  framing rather than propensity matching at a single index date.

### Q5 — Are there distinguishable attendance trajectories, and do they differ by transport and by documented reason?

- **Population / exposure / outcome.** Adults with at least 12 months of records; exposure = trajectory group
  membership (data-derived); outcome = group membership modelled against transport mode, documented reason
  categories and shortening.
- **Design and estimand.** Group-based trajectory modelling of monthly missed-session counts (or rate), with
  two- to five-class solutions compared by BIC and a minimum group-size rule; membership then described
  against exposures. Estimand: posterior group proportions and adjusted odds of membership.
- **Data needed.** Fields A, B, D, F, and at least 12 months of records; field H for adjustment.
- **Falsification.** A one-class solution preferred by BIC; or groups that do not replicate in a split-half
  check; or groups that differ in nothing observable.
- **Feasibility.** Low-to-moderate for a single centre: the published trajectory precedents use thousands of
  patients (3,249 in PMID 24748809 [21]; 15,667 in PMID 39912818 [22]). With 150–250 patients, a two- or three-class
  solution is the most that should be attempted, and trajectory modelling should be treated as exploratory
  rather than as a primary aim. This is a feasibility limit, not a claim about the literature.
- **Novelty:** occupied as a method, not in this population or setting. Dialysis attendance has been
  displayed categorically (consistent underdialysis / inconsistent / consistent in 113 patients;
  PMID 35243306 [11]) rather than modelled, while trajectory modelling is routine in medication adherence
  (PMID 24748809 [21]). The axis of difference is the exposure set (transport and documented reasons) and the
  setting. A reader gains a hypothesis about which attendance pattern is worth targeting, at best.

### Q6 — Do missed sessions cluster immediately before acute care contact?

- **Population / exposure / outcome.** Adults with at least one acute care event; exposure = a missed session
  in the 0–7 days before the event versus the patient's own event-free periods; outcome = the acute care event.
- **Design and estimand.** Self-controlled case series or time-stratified case-crossover with conditional
  Poisson regression and a distributed-lag structure for up to seven days. Estimand: incidence rate ratio for
  event days versus control days within the same patient.
- **Data needed.** Fields A and G with exact dates; event counts are the binding constraint.
- **Falsification.** Exposure frequency does not differ between hazard and control windows; or the estimate
  is not robust to the choice of control window.
- **Feasibility.** Low at one centre. The design's power depends on event counts, which §6 projects to be
  small; on the projection above it is worth attempting only if events exceed roughly 100.
- **Novelty:** not identified as answered in this setting, but the design precedent exists immediately next
  door. Weather and missed appointments were studied with exactly this design in 60,135 patients
  (PMID 37071662 [10]), while missed sessions as the trigger were studied with a fixed-window cohort design
  (PMID 32517695 [1]) and matched-cohort designs (PMID 32734224 [4]). What is left is a within-patient trigger
  estimate using only local data, which also removes between-patient confounding by frailty and comorbidity
  that no adjusted cohort fully removes.

### Q7 — Which documented reasons for missing a session predict whether the patient returns for the next scheduled session?

- **Population / exposure / outcome.** All missed sessions with a recorded reason; exposure = reason category
  as recorded on the day (concurrent illness, transport/logistics, family obligation, misunderstanding or
  refusal, unknown); outcome = attendance at the next scheduled session, and the 30-day rate of subsequent
  misses.
- **Design and estimand.** Session-level analysis with patient-clustered models and reason as a fixed effect;
  estimand: adjusted risk difference in next-session attendance by reason category, and the proportion of
  misses whose reason is unrecorded.
- **Data needed.** Fields A, B, C. Note that reason categories must be derived from what is actually written,
  not imposed from published taxonomies.
- **Falsification.** Next-session attendance does not differ by reason category; or recorded reasons are too
  incomplete to categorise (which is itself the finding, and is a prerequisite for any recall pathway).
- **Feasibility.** High: uses only the existing records and needs no linkage.
- **Novelty:** no direct answer identified in this search. The closest works catalogue reasons at patient
  level (PMID 42410327 [8], PMID 40051030 [7]) and study patient-level predictors of non-attendance (younger age,
  smoking, alcohol, mental-health history). The axis left is prospective-actionability: whether the reason
  written on the day carries information about the next session, which is what a nurse-recall pathway would
  need. Bounded-search caveat: quality-improvement audits of this shape are usually not published, so
  "no direct answer identified" means within this search, not across the field.

### Q8 — Do holiday and calendar periods carry a local attendance penalty?

- **Population / exposure / outcome.** All scheduled sessions; exposure = calendar period (public-holiday
  weeks, month boundaries, religious-festival periods identified from the local calendar); outcome = missed
  sessions per 100 expected, and make-up rates in the following week.
- **Design and estimand.** Interrupted time series or Poisson regression on daily/weekly counts with
  harmonic terms for seasonality, a pre-specified impact model, and explicit autocorrelation handling
  (PMID 27283160 [18]; power methods as in PMID 31429175 [20]). Estimand: rate ratio per holiday week and the
  proportion of those misses that are made up.
- **Data needed.** Fields A, C, plus an internally derived calendar (no external data linkage).
- **Falsification.** No holiday-period excess after seasonality is modelled; or an excess that is fully
  explained by the reduced make-up capacity of the same weeks.
- **Feasibility.** Moderate; the design is well-documented but seasonal modelling needs autocorrelation
  handling to avoid the trap described in the methodological review (PMID 33055094 [19]).
- **Novelty:** partly occupied, and the honest statement is that most of this question is already answered.
  Inclement weather and missed appointments were answered in a 60,135-patient case-crossover study
  (PMID 37071662 [10]), dialysis day of week in the ARO cohort (PMID 32517695 [1]), and a calendar-linked behaviour
  (Ramadan fasting, 635 patients, more misses among fasters) in a 2014–2015 observational study
  (DOI 10.1111/hdi.12369 [35]). What is left is only the internal holiday-period audit, which needs no external
  linkage. Priority is low; it is included because it is nearly free once the dataset is built.

### Q9 — Can a simple, pre-specified recall rule identify patients who would otherwise miss the next session, and what would it cost in nurse time?

- **Population / exposure / outcome.** Adults on maintenance haemodialysis; exposure = a rule combining the
  previous four weeks' misses, current transport mode and any late arrival or shortening in that period;
  outcome = a missed session in the following two weeks.
- **Design and estimand.** Retrospective evaluation of a rule fixed before examination of the data, reporting
  sensitivity, specificity, positive predictive value and the number needed to contact per prevented miss
  under stated assumptions. Not a machine-learning exercise: with this sample size a learned model would be
  uninterpretable and overfitted. Estimand: rule operating characteristics and expected contact volume
  (a process estimate, not a clinical effect).
- **Data needed.** Fields A, D, E, F. No outcome linkage required.
- **Falsification.** Positive predictive value no better than the base rate of missing a session; or rule
  performance not reproduced in a later time period within the same records.
- **Feasibility.** High for the retrospective evaluation; the prospective recall is a separate decision for
  the service, and any claim about its effect would require a design that this dataset cannot supply.
- **Novelty:** the prediction target is occupied in an industry abstract but not, in this search, in
  accessible peer-reviewed form. A conference abstract describes a model for unexcused no-shows built on
  1.55 million weekly records from 172,854 patients with an AUC of 0.87 and pilot sensitivity 0.57 /
  specificity 0.95 (no public identifier; see evidence map); the messaging intervention that followed the
  same line of work is registered (NCT02970201 [37]) and published as a proof-of-concept
  (DOI 10.1038/s41598-017-03184-z [31]). What is left is not model performance but the operational question: what
  a rule with interpretable inputs and a known contact volume looks like in a 200-patient unit, and whether
  its precision is acceptable to nurses. The abstract's numbers cannot be generalised to a community hospital
  and were not used as a benchmark here.

---

## 5. Data requirements, and the fields that must be verified before anything is promised

No file was inspected during this work; the brief describes records, it does not grant access to them. Every
row below is a field to **verify**, and the questions that stop if it is absent are named.

| Field | What it must contain | Questions that stop without it |
|---|---|---|
| A. Session-level attendance | One row per scheduled session: patient identifier, scheduled date/time, prescribed weekly pattern or shift, attended/not attended | All questions |
| B. Reason for non-attendance | A recorded reason or excuse code, with who recorded it and when | Q3 (definition 2), Q4 (confounder), Q7 |
| C. Make-up sessions | Whether a missed session was made up, on which date, and its link to the missed session | Q4, Q8 (make-up rates) |
| D. Shortened sessions | Prescribed versus delivered minutes (or an equivalent flag) | Q3 (missed-minutes definition), Q5, Q9 |
| E. Late arrival / delay | Any flag for late start or transport delay | Q9 |
| F. Transport | Mode per trip or per patient; whether arranged by the hospital; distance or travel time if held; mode changes over time | Q2 (strongest version), Q4, Q9 |
| G. Outcomes | Emergency-department visits, admissions with dates, death with date, transfer, transplantation | Q1, Q4, Q6 (they become process-outcome studies if absent) |
| H. Baseline covariates | Age, sex, dialysis vintage, primary renal disease, vascular access type, comorbidity, area-level deprivation proxy, payment/insurance category | Adjustment in Q1, Q2, Q5 |
| I. Session weights | Pre- and post-dialysis weight, for interdialytic weight gain | Optional; strengthens Q5 only |
| J. Laboratory values | Kt/V, potassium, phosphate, haemoglobin, albumin, C-reactive protein if held | Optional |

**Fields no available data can supply.** Because there is no recruitment and no biospecimen, the following
are out of reach and no question above depends on them: patient-reported reasons for missing sessions,
health-literacy instruments, depression and anxiety scales, employment and income, caregiver availability,
and the patient's actual out-of-pocket transport cost. Any proposal that needs these is a prospective study,
not this one. Two published findings are the reason this matters: self-reported difficulty agrees poorly with
objective adherence (DOI 10.2147/ppa.s227191 [29]), and 88% of assessed frequent non-attenders had pre-existing
mental-health conditions while only 6 of 17 who engaged with psychology improved their attendance
(PMID 42410327 [8]) — so the absence of psychological variables limits interpretation, but adding them would not
by itself have made the local analysis conclusive.

---

## 6. Feasibility under six months, one part-time analyst, no recruitment

**A projected arithmetic for event counts (derived, not measured).** Take 200 patients on thrice-weekly
schedules and one year of records: 200 × 156 = 31,200 scheduled sessions. Applying the missed-treatment rate
seen in the private-transport group of the national transport cohort (4.03 per 100 expected; PMID 40512563 [6])
gives ≈1,260 missed sessions per year; applying the 8.3% measured in a 2,341-patient US network abstract
gives ≈2,590. If 2% of missed sessions are followed within seven days by an admission, that is ≈25–52 events
per year. That supports one overall rate ratio with a wide interval, and does not support splitting by
transport mode or by reason category. Every term in this projection is an assumption from published rates and
the centre's own counts will replace them; the projection is a planning device and appears in no
recommendation.

**Sequence (working weeks, one part-time analyst).**

| Weeks | Work | Output |
|---|---|---|
| 1–2 | Field inventory against §5; data dictionary; confirm ethics/approval status for a record-only audit; fix the analysis plan including the definition list for Q3 | One-page data-readiness note naming any field that is missing |
| 3–4 | Cohort build; Q3 definitional audit; baseline description and event counts | Rate under each definition, with confidence intervals; the real event counts that replace §6's projection |
| 5–9 | Q2 transport-mode analysis; Q7 documented-reason → next-session analysis | Two tables; both need no outcome linkage |
| 10–14 | Q1 day-of-week analysis; Q4 make-up strategy analysis (Q4 only if field G is present) | Two analyses with pre-specified estimands |
| 15–18 | Q9 rule evaluation (fixed in advance); Q5 trajectories if sample size allows; Q8 calendar audit if time remains | Secondary analyses |
| 19–22 | Write-up, internal review, reporting of the record-based cohort with RECORD/STROBE items | Draft manuscript or internal report |
| 23–26 | Buffer: revisions, data-request responses, any resubmission of the analysis plan | — |

**Bibliometric context.** A publication-volume analysis of the topic was run and completed in a degraded
state: its formal MeSH strategy returned no records, it fell back to the raw topic and retrieved 32 records,
and citation coverage for those records was incomplete (one internal citation source served 31 of 32; the
OpenAlex key and the Semantic Scholar rate limit were both unavailable). Because those 32 records are far
narrower than the topic as searched here, no publication-shape figure from that run is used anywhere in this
agenda. It is recorded as a degraded channel, not as an estimate of the field's size.

---

## 7. Risks

1. **Outcome linkage may not exist.** Fields G is the single point of failure for Q1, Q4 and Q6. Verify in
   week 1; if it is absent, drop those three to process outcomes (next-session attendance, make-up rate) and
   say so in the paper.
2. **Small event counts.** §6's projection suggests 25–52 admission-linked events per year. Pre-specify the
   minimum detectable effect by simulation before any analysis, and report intervals rather than p-values.
3. **Definition drift across the record period.** Record-keeping changes and staffing changes move the
   recorded reason fields; plot the unrecorded-reason proportion by month before trusting any reason analysis.
4. **Confounding by indication for make-up sessions.** Sicker patients may be both more likely to be
   rescheduled and more likely to have events. The target-trial framing plus a negative-control outcome is
   the mitigation; it does not remove the risk.
5. **Transport records may be thinner than hoped.** If only "hospital-arranged yes/no" is held, Q2 becomes a
   two-group comparison and the trip-level version cannot be run. Say which version was run.
6. **Single centre, small n.** External validity is limited and groups will be small. Frame outputs as a local
   audit with an explicit denominator, not as a national estimate.
7. **Interpretation risk from the domain-specificity findings.** Because adherence does not move together
   across domains (DOI 10.1080/13548506.2016.1191658 [30]) and because deprivation and transport behave
   differently (PMID 40861382 [24] versus PMID 40512563 [6]), no finding here should be generalised from attendance to
   "adherence" as a whole.
8. **Scope creep into a prediction model.** With 150–250 patients, a learned model would be uninterpretable
   and unstable. Q9 is deliberately a fixed-rule evaluation.

---

## 8. Prioritisation and recommended first step

Ranking criteria, applied in this order: (i) does it change what the service would do; (ii) can it be
finished with the records in hand and no linkage; (iii) is it a real gap rather than a repetition; (iv) will
the event counts support an estimate.

| Rank | Question | Actionability | Executability now | Novelty strength | Count adequacy |
|---|---|---|---|---|---|
| 1 | Q3 definitional audit | High — changes what every other number means | High (fields A–E only) | Strong within scope | Not dependent |
| 2 | Q2 transport mode | High — transport is the best-evidenced modifiable exposure | High–moderate (field F) | Occupied nationally, new locally | Adequate (session-level) |
| 3 | Q7 documented reasons | High — feeds a recall pathway | High (fields A–C) | Not answered in scope | Adequate (session-level) |
| 4 | Q4 make-up strategy | High — operational, capacity-bound | Moderate (needs G) | Occupied, new as strategy | Marginal (event-driven) |
| 5 | Q1 day-of-week position | Moderate — mostly confirms | Moderate (needs G) | Occupied elsewhere | Marginal |
| 6 | Q9 recall rule | Moderate — process decision | High | Occupied in abstract form | Not dependent |
| 7 | Q5 trajectories | Low–moderate exploratory | Low–moderate (12+ months, n) | Method occupied | Weak at this n |
| 8 | Q8 calendar/holiday | Low | Moderate | Mostly answered | Adequate |
| 9 | Q6 trigger analysis | Low now, high if events are plentiful | Low (needs G, events) | Design precedent adjacent | Likely insufficient |

**Recommended next step.** Weeks 1–4 as written: verify fields A–G against §5, build the session-level file,
and run Q3 so that the centre can state its own missed-session rate under an explicit definition before any
hypothesis test is run. Then run Q2 and Q7, which need only the records already held. Treat Q4 and Q1 as the
next pair and decide on them once the real event counts from week 4 are known. Do not start with a
prediction model, a mediation analysis, or an external weather linkage: the first two are not supportable at
this sample size and the third was already answered at 60,135 patients (PMID 37071662 [10]).

---

## 9. Directions dropped, and why

**"Is missing dialysis associated with worse outcomes?" — answered; dropped.** DOPPS (RR 1.30 mortality,
PMID 12787417 [2]), the 15,340-patient network cohort (DOI 10.1093/ckj/sfs071 [3]), the ARO cohort (HR 2.04 for the
first session of the week, PMID 32517695 [1]), the rescheduling cohorts (PMID 32734224 [4]) and the incident
emergency-department cohort (RRR 7.34, PMID 42719390 [13]) have settled the association. Re-running it locally
would produce a smaller version of a known answer.

**"Does inclement weather increase missed appointments?" — answered; dropped.** A time-stratified
case-crossover study in 60,135 patients answered it, with rainfall, snowfall, storm and wind exposures and a
distributed-lag structure (PMID 37071662 [10]). Re-proposing it would require an external meteorological linkage
that the available data do not include. Only the internal calendar version survives, as Q8.

**"Do transport interventions reduce missed appointments?" — answered in general populations, not in
dialysis; folded into Q2.** The systematic review pools seven studies at 0.63 (95% CI 0.48–0.83) for missed
appointments (PMID 35449011 [17]), and dialysis-specific transport intervention trials were not identified in this
search; the local question therefore starts descriptively (Q2) rather than as an intervention.

**"Do missed sessions cause death?" — not answerable with this dataset; dropped as a causal claim.** Every
retrieved estimate is observational, and a single centre without randomisation cannot separate the miss from
the illness that caused it. Q6 is the nearest defensible substitute because it compares the patient with
themselves.

**Psychosocial mediation chain — kept only as a field-availability audit (§5).** The variables it needs
(psychological scales, laboratory markers, biospecimens) are outside the supplied data, and there is no
recruitment. It appears above as a feasibility limit rather than as a candidate question.

---

## References

Full source details, one row per work, with channel, axis of use and whether a complete text was read, are in
`evidence-map.md`. The works cited above, with the identifiers a reader needs to open them:

1. Fotheringham J, et al. Hospitalization and mortality following non-attendance for hemodialysis according
   to dialysis day of the week: a European cohort study. BMC Nephrol. 2020. PMID 32517695.
   https://pubmed.ncbi.nlm.nih.gov/32517695/
2. Saran R, et al. Nonadherence in hemodialysis: associations with mortality, hospitalization, and practice
   patterns in the DOPPS. Kidney Int. 2003. PMID 12787417. https://pubmed.ncbi.nlm.nih.gov/12787417/
3. Relationship of missed and shortened hemodialysis treatments to hospitalization and mortality:
   observations from a US dialysis network. Clin Kidney J. 2012. https://doi.org/10.1093/ckj/sfs071
4. Cohen DE, et al. Impact of Rescheduling a Missed Hemodialysis Treatment on Clinical Outcomes. Kidney Med.
   2019. PMID 32734224. https://pubmed.ncbi.nlm.nih.gov/32734224/
5. Does Rescheduling a Missed In-Center Hemodialysis Treatment Improve Clinical Outcomes? Kidney Med. 2020.
   https://doi.org/10.1016/j.xkme.2020.01.004
6. Transportation Insecurity and Outcomes in Hemodialysis Patients: A Retrospective Cohort Study. Clin J Am
   Soc Nephrol. 2025. PMID 40512563. https://europepmc.org/article/MED/40512563
7. Hemodialysis Nonattendance: Patient Characteristics and Outcomes in a Single Renal Center in North West
   England. Hemodial Int. 2025. PMID 40051030. https://pubmed.ncbi.nlm.nih.gov/40051030/
8. Psychosocial factors in patients who miss hemodialysis sessions: a single-center retrospective review.
   Ren Fail. 2026. PMID 42410327. https://pubmed.ncbi.nlm.nih.gov/42410327/
9. Missing In-Center Hemodialysis Sessions among Patients with End Stage Renal Disease in Banda Aceh,
   Indonesia. Int J Environ Res Public Health. 2021. https://doi.org/10.3390/ijerph18179215
10. Inclement Weather and Risk of Missing Scheduled Hemodialysis Appointments among Patients with Kidney
    Failure. Clin J Am Soc Nephrol. 2023. PMID 37071662. https://pubmed.ncbi.nlm.nih.gov/37071662/
11. African Americans' Hemodialysis Treatment Adherence Data Assessment and Presentation. Kidney Med. 2022.
    PMID 35243306. https://pubmed.ncbi.nlm.nih.gov/35243306/
12. Association of the Comprehensive ESRD Care Model with Treatment Adherence. Kidney360. 2022. PMID
    35845340. https://pubmed.ncbi.nlm.nih.gov/35845340/
13. Emergency Department Utilization after Initiation of Intermittent Hemodialysis. Can J Kidney Health Dis.
    2026. PMID 42719390. https://pubmed.ncbi.nlm.nih.gov/42719390/
14. Associations of Patient Activation with Outcomes among Patients on Chronic Hemodialysis. Kidney360.
    2024. PMID 39348206. https://pubmed.ncbi.nlm.nih.gov/39348206/
15. Impact of anxiety symptoms on dialysis adherence and complication rates. World J Psychiatry. 2024.
    PMID 39704368. https://pubmed.ncbi.nlm.nih.gov/39704368/
16. Chronic kidney disease-associated pruritus is associated with worse quality of life and increased
    healthcare utilization. Qual Life Res. 2023. PMID 37269433.
    https://pubmed.ncbi.nlm.nih.gov/37269433/
17. Shekelle PG, et al. Effect of interventions for non-emergent medical transportation: a systematic review
    and meta-analysis. BMC Public Health. 2022. PMID 35449011.
    https://pubmed.ncbi.nlm.nih.gov/35449011/
18. Bernal JL, Cummins S, Gasparrini A. Interrupted time series regression for the evaluation of public
    health interventions: a tutorial. Int J Epidemiol. 2017. PMID 27283160.
    https://pubmed.ncbi.nlm.nih.gov/27283160/
19. Hategeka C, et al. Use of interrupted time series methods in the evaluation of health system quality
    improvement interventions. BMJ Glob Health. 2020. PMID 33055094.
    https://pubmed.ncbi.nlm.nih.gov/33055094/
20. Zhang B, et al. Design, analysis, power, and sample size calculation for three-phase interrupted time
    series analysis. J Eval Clin Pract. 2019. PMID 31429175.
    https://pubmed.ncbi.nlm.nih.gov/31429175/
21. Li Y, et al. Group-based trajectory modeling to assess adherence to biologics among patients with
    psoriasis. Clinicoecon Outcomes Res. 2014. PMID 24748809.
    https://pubmed.ncbi.nlm.nih.gov/24748809/
22. Pennington EL, et al. Antidepressant adherence using group-based trajectory modeling among postpartum
    women with Texas Medicaid. J Manag Care Spec Pharm. 2025. PMID 39912818.
    https://pubmed.ncbi.nlm.nih.gov/39912818/
23. Cheruvu SS, et al. Group-based trajectory modeling to identify longitudinal patterns and predictors of
    adherence among older adults on concomitant triple therapy. J Manag Care Spec Pharm. 2025.
    PMID 40152795. https://pubmed.ncbi.nlm.nih.gov/40152795/
24. Impact of individual socioeconomic deprivation on hemodialysis care and patient behavior (Precadia).
    Clin Kidney J. 2025. PMID 40861382. https://europepmc.org/article/MED/40861382
25. Social Support and Adherence to Treatment Regimens among Patients Undergoing Hemodialysis. Healthcare
    (Basel). 2024. PMID 39408138. https://pubmed.ncbi.nlm.nih.gov/39408138/
26. Factors Contributing to Non-Adherence to Treatment Among Adult Patients with Long-Term Haemodialysis:
    An Integrative Review. Nurs Rep. 2025. PMID 41003269. https://pubmed.ncbi.nlm.nih.gov/41003269/
27. Non-Adherence in Patients on Peritoneal Dialysis: A Systematic Review. PLoS One. 2014.
    https://doi.org/10.1371/journal.pone.0089001
28. Determinants of Compliance Behaviours among Patients Undergoing Hemodialysis in Malaysia. PLoS One.
    2012. https://doi.org/10.1371/journal.pone.0041362
29. Association of Patient-Reported Difficulty with Adherence with Achievement of Clinical Targets Among
    Hemodialysis Patients. Patient Prefer Adherence. 2020. https://doi.org/10.2147/ppa.s227191
30. Resilience, religiosity and treatment adherence in hemodialysis patients: a prospective study.
    Psychol Health Med. 2016. https://doi.org/10.1080/13548506.2016.1191658
31. Improving Dialysis Adherence for High Risk Patients Using Automated Messaging: Proof of Concept.
    Sci Rep. 2017. https://doi.org/10.1038/s41598-017-03184-z
32. Community Health Worker Support for Hispanic and Latino Individuals Receiving Hemodialysis
    (Navigate-Kidney). JAMA Intern Med. 2026. PMID 41203234.
    https://pubmed.ncbi.nlm.nih.gov/41203234/
33. Pharmacist-led behavioral change intervention improves adherence and clinical outcomes among
    hemodialysis patients. Sci Rep. 2025. PMID 41023004. https://pubmed.ncbi.nlm.nih.gov/41023004/
34. Self-management interventions for adult haemodialysis patients: a scoping review of randomized
    controlled trials. BMC Nephrol. 2025. PMID 40514662.
    https://pubmed.ncbi.nlm.nih.gov/40514662/
35. Changes in biochemical, hemodynamic, and dialysis adherence parameters in hemodialysis patients during
    Ramadan. Hemodial Int. 2015. https://doi.org/10.1111/hdi.12369
36. KDOQI Clinical Practice Guideline for Hemodialysis Adequacy: 2015 Update. Am J Kidney Dis. 2015.
    PMID 26498416. https://pubmed.ncbi.nlm.nih.gov/26498416/
37. ClinicalTrials.gov registrations screened for overlap: NCT02970201, NCT05003115, NCT05735743,
    NCT03595748, NCT06978127, NCT03978806.
