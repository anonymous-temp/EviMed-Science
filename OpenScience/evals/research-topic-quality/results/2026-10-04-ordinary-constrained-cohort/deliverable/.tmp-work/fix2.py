import io
M = "/workspace/deliverables/dialysis-adherence-agenda/evidence-map.md"
s = io.open(M, encoding="utf-8").read()

pairs = []
def P(old, new, tag):
    pairs.append((old, new, tag))

# 16
P("| Factors contributing to non-adherence to treatment in patients receiving hemodialysis: an integrative review (Nurs Rep, 2025) |",
  "| Factors Contributing to Non-Adherence to Treatment Among Adult Patients with Long-Term Haemodialysis: An Integrative Review (Nurs Rep, 2025) |", "16")
# 17
P("| Evidence that measured and self-reported non-adherence diverge; located as a measurement-discordance lead only | record only |",
  "| Screened as a measurement-discordance lead because its title sets objectively measured against self-reported non-adherence; reached at bibliographic level only, so no divergence is quantified here | record only |", "17")
# 19
P("| RECORD-PE: reporting of pharmacoepidemiological studies using routinely collected data | PMID 30429167 | https://pubmed.ncbi.nlm.nih.gov/30429167/ | pubmed | method | Extension of the routinely-collected-data reporting standard | record only |",
  "| The reporting of studies conducted using observational routinely collected health data statement for pharmacoepidemiology (RECORD-PE) (BMJ, 2018) | PMID 30429167 | https://doi.org/10.1136/bmj.k3532 | pubmed | method | Extension of the routinely-collected-data reporting standard, screened for whether it adds attendance-specific reporting requirements | abstract read |", "19")
# 20
P("| Rationale and design of the RECORD statement | PMID 27799820 | https://pubmed.ncbi.nlm.nih.gov/27799820/ | pubmed | method | Rationale for reporting completeness in routinely-collected-data studies | record only |",
  "| The RECORD reporting guidelines: meeting the methodological and ethical demands of transparency in research using routinely-collected health data (Clin Epidemiol, 2016) | PMID 27799820 | https://pubmed.ncbi.nlm.nih.gov/27799820/ | pubmed | method | Rationale for reporting completeness in routinely-collected-data studies; screened for the obligations it places on a study built from hospital records | abstract read |", "20")
# 21
P("| Insufficiency of routinely-collected data reporting in a cohort of published studies | PMID 27343981 | https://pubmed.ncbi.nlm.nih.gov/27343981/ | pubmed | method | Evidence that reporting against this standard is commonly incomplete, motivating the Aim-level reporting plan | record only |",
  "| The reporting of studies using routinely collected health data was often insufficient (J Clin Epidemiol, 2016) | PMID 27343981 | https://pubmed.ncbi.nlm.nih.gov/27343981/ | pubmed | method | Evidence that reporting against this standard is commonly incomplete \u2014 of 124 sampled studies, 31.5% set out the design in title or abstract, 20.5% of those needing code or algorithm definitions reported them adequately, and database linkage was reported adequately in 29.3% \u2014 which is why the reporting plan is written at Aim level | abstract read |", "21")
# 22
P("| TRIPOD+AI statement: updated guidance for reporting clinical prediction models that use regression or machine learning methods (BMJ, 2024) | PMID 38626949 | https://pubmed.ncbi.nlm.nih.gov/38626949/ |",
  "| TRIPOD+AI statement: updated guidance for reporting clinical prediction models that use regression or machine learning methods (BMJ, 2024) | PMID 38626948 | https://pubmed.ncbi.nlm.nih.gov/38626948/ |", "22")
# 23
P("| Patients' experience of maintenance haemodialysis: a qualitative study, Ethiopia | PMID 37252918 |",
  "| Patients' experience of undergoing maintenance hemodialysis. An interview study from Ethiopia (PLOS ONE, 2023) | PMID 37252918 |", "23")
# 25
P("| Evidence that skipped treatments have been treated as a nutritional non-adherence marker rather than a scheduling outcome | record only |",
  "| Screened because its title places skipped treatments among markers of nutritional non-adherence; reached at bibliographic level only, so the framing is not quoted as a finding | record only |", "25")
# 26
P("| Editorial framing of missed treatments as a modifiable and unequally distributed burden | record only |",
  "| Editorial located by title as framing missed treatments as a modifiable and unequally distributed burden; reached at bibliographic level only | record only |", "26")
# 27
P("| Missed hemodialysis treatments and mortality in Puerto Rico before and after the 2017 hurricanes (Kidney Int Rep, 2020) |",
  "| SUN-192 Missed hemodialysis treatments and mortality in Puerto Rico before and after the 2017 hurricanes: a medium dialysis organization experience (Kidney Int Rep, 2020, conference abstract) |", "27a")
P("| Disaster-related disruption of attendance; comparator for the weather-exposure strand | record only |",
  "| Abstract book entry on disaster-related disruption of attendance; the abstract text was not retrievable, so no result or sample size is reported from it | record only |", "27b")
# 28
P("| Effect of missed hemodialysis treatments on mortality in patients with end-stage renal disease (Am J Nephrol) |",
  "| Effect of Missed Hemodialysis Treatments on Mortality in Patients with End-Stage Renal Disease (Nephron, 1998) |", "28a")
P("| Earlier mortality association for missed treatments | record only |",
  "| Screened as an earlier report of the missed-treatment mortality association; reached at bibliographic level only, so it bounds how long that association has been reported and carries no estimate here | record only |", "28b")
# 32
P("| Non-Emergent Medical Transportation Coordination for On-Time Treatments Among Hemodialysis Patients (Am J Kidney Dis, 2022) |",
  "| 285 Non-Emergent Medical Transportation Coordination for On-Time Treatments Among Hemodialysis Patients (Am J Kidney Dis, 2022, conference abstract) |", "32")
# 33
P("| Automated messaging to improve appointment adherence and outcomes in haemodialysis patients: a randomized controlled trial (Sci Rep, 2017) |",
  "| Improving Dialysis Adherence for High Risk Patients Using Automated Messaging: Proof of Concept (Sci Rep, 2017) |", "33")
# 38
P("| Peer education and treatment adherence in haemodialysis: a randomized controlled trial | PMID 38333339 | https://pubmed.ncbi.nlm.nih.gov/38333339/ | pubmed | comparator | Recent randomised intervention on adherence; part of the registered-and-reported intervention set | record only |",
  "| The Effects of Peer Education on Treatment Adherence among Patients Receiving Hemodialysis: A Randomized Controlled Trial (Iran J Nurs Midwifery Res, 2024) | PMID 38333339 | https://pubmed.ncbi.nlm.nih.gov/38333339/ | pubmed | comparator | The most recent located randomised test of an adherence intervention measured attendance to regular sessions directly and found no between-group difference (t = 0.19, p = 0.85), while fluid restriction improved (t = 2.86, p = 0.006) | abstract read |", "38")
# 39
P("| Patient education with nurse-led telephone follow-up in haemodialysis: a randomized controlled trial (BMC Nephrol, 2021) | PMID 33827478 | https://pubmed.ncbi.nlm.nih.gov/33827478/ | pubmed | comparator | Recent randomised intervention on adherence | record only |",
  "| Do the patient education program and nurse-led telephone follow-up improve treatment adherence in hemodialysis patients? A randomized controlled trial (BMC Nephrol, 2021) | PMID 33827478 | https://pubmed.ncbi.nlm.nih.gov/33827478/ | pubmed | comparator | Randomised intervention reporting higher adherence at every follow-up (p < .001) across four End-Stage Renal Disease Adherence Questionnaire dimensions, attendance among them; adherence measured as questionnaire sub-scores rather than from session records | abstract read |", "39")
# 40
P("| Comprehensive End-Stage Renal Disease Care Model and treatment adherence | PMID 35845340 | https://pubmed.ncbi.nlm.nih.gov/35845340/ | pubmed | subject | Payment-model strand of adherence research; full text not open access, so cited at abstract level only | abstract read |",
  "| Association of the Comprehensive ESRD Care Model with Treatment Adherence (Kidney360, 2022) | PMID 35845340 | https://pubmed.ncbi.nlm.nih.gov/35845340/ | pubmed | subject | Payment-model evaluation that identified a skipped treatment from dates of service and reported as-scheduled attendance (odds ratio 1.02, 95% CI 1.00\u20131.04, p = 0.08) separately from rescheduled sessions (odds ratio 1.09, 95% CI 1.05\u20131.14, p < 0.001); the full text is not open access, so these values are read from the abstract | abstract read |", "40")
# 41
P("| PEER-HD: peer mentorship in haemodialysis study protocol | PMID 35247960 | https://pubmed.ncbi.nlm.nih.gov/35247960/ | pubmed | trial-registry | Registered overlapping study of peer mentorship | record only |",
  "| Peer mentorship to improve outcomes in patients on hemodialysis (PEER-HD): a randomized controlled trial protocol (BMC Nephrol, 2022) | PMID 35247960 | https://pubmed.ncbi.nlm.nih.gov/35247960/ | pubmed | trial-registry | Registered overlapping study; its registration is NCT03595748, its primary outcome is a composite of emergency visits and hospitalisations, and dialysis adherence appears among the secondary outcomes | abstract read |", "41")
# 42
P("| HED-SMART: self-management intervention in haemodialysis | PMID 29198641 | https://pubmed.ncbi.nlm.nih.gov/29198641/ | pubmed | trial-registry | Registered overlapping self-management study | abstract read |",
  "| Hemodialysis Self-management Intervention Randomized Trial (HED-SMART): A Practical Low-Intensity Intervention to Improve Adherence and Clinical Markers in Patients Receiving Hemodialysis (Am J Kidney Dis, 2018) | PMID 29198641 | https://pubmed.ncbi.nlm.nih.gov/29198641/ | pubmed | trial-registry | Registered overlapping self-management trial (ISRCTN31434033) whose adherence outcome is a self-report instrument, not session attendance | abstract read |", "42")

# registry rows 43-53: locate by NCT id
reg = [
 ("Peer Mentorship to Improve Outcomes in Patients on Maintenance Hemodialysis", "NCT03595748", "registry status completed, 199 participants enrolled; the intervention arm discusses fluid intake and dialysis adherence in weekly calls"),
 ("Improving Adherence in Renal Dialysis Patients Through Electronic Interventions", "NCT02970201", "registry status completed, 26 participants; automated text or voice messages on session reminders with direct call routing for rescheduling"),
 ("Motivational Strategies To Empower African Americans To Improve Dialysis Adherence", "NCT05003115", "registry status completed, 30 participants; motivational interviewing on dialysis adherence"),
 ("MoVE Trial: Motivational Strategies to Empower African Americans to Improve Dialysis Adherence", "NCT05735743", "registry status active, not recruiting, 176 participants; a larger motivational-interviewing test on the same adherence question"),
 ("Prosperando: Fostering Resilience on Dialysis", "NCT03978806", "registry status completed, 139 participants; a peer navigator providing support with social challenges and adherence"),
 ("Technology Assisted Collaborative Care Intervention to Improve Patient-centered Outcomes in Dialysis Patients", "NCT06978127", "registry status recruiting, 424 participants; stepped collaborative care for pain, fatigue and depression, registered without an attendance outcome"),
 ("Virtual Reality in Hemodialysis to Improve Psychological Well-being", "NCT05642364", "registry status active, not recruiting, 61 participants"),
 ("Animal Assisted Intervention for Hemodialysis Outpatients", "NCT06030050", "registry status withdrawn, 0 participants enrolled"),
 ("Enhancing the Cardiovascular Safety of Hemodialysis Care (Dialysafe)", "NCT03171545", "registry status completed, 1431 participants; cluster-assigned patient-activation and provider-education interventions"),
 ("Reducing Arrhythmia in Dialysis by Adjusting the Rx Electrolytes/Ultrafiltration, Study A", "NCT03519347", "registry status completed, 19 participants"),
 ("A Trial of Sertraline vs. CBT for End-stage Renal Disease Patients With Depression {ASCEND}", "NCT02358343", "registry status completed, phase 3, 184 participants; depression treatment rather than attendance"),
]
for title, nct, used in reg:
    old = None
    for line in s.splitlines():
        if line.startswith("| ") and ("| %s |" % nct) in line:
            old = line
            break
    assert old is not None, "registry row not found: " + nct
    new = "| %s | %s | https://clinicaltrials.gov/study/%s | trial-registry | trial-registry | %s | record only |" % (title, nct, nct, used)
    P(old, new, "reg " + nct)

def find(prefix):
    hits = [l for l in s.splitlines() if l.startswith(prefix)]
    assert len(hits) == 1, "prefix ambiguous: %s -> %d" % (prefix, len(hits))
    return hits[0]

P(find("| KDOQI Clinical Practice Guideline for Hemodialysis Adequacy: 2015 Update"),
  "| KDOQI Clinical Practice Guideline for Hemodialysis Adequacy: 2015 Update (Am J Kidney Dis, 2015) | DOI 10.1053/j.ajkd.2015.07.015 | https://doi.org/10.1053/j.ajkd.2015.07.015 | guideline | absence | Guideline position on the prescription: individualised targets with flexibility in initiation timing, frequency, duration and ultrafiltration rate; no session-attendance metric or minimum attendance standard is defined, and the only adherence quantity in the document is trial-level \u2014 77.7% of participants in the Frequent Hemodialysis Network Daily Trial received more than 80% of their prescribed treatments | full text read |", "54")
P(find("| KDOQI Clinical Practice Guidelines for Hemodialysis Adequacy: 2006 Update"),
  "| Clinical Practice Guidelines for Hemodialysis Adequacy, Update 2006 (Am J Kidney Dis, 2006) | DOI 10.1053/j.ajkd.2006.03.051 | https://doi.org/10.1053/j.ajkd.2006.03.051 | guideline | comparator | The earlier adequacy guidance does address attendance: a grade B statement that efforts should be made to monitor and minimise missed or shortened treatments, a rationale headed *Avoiding Missed Treatments* (CPG 4.3) holding that a delivered Kt/V has validity only if treatments are delivered reliably three times per week on a regular basis, a recorded 4% of treatments per month missed among US patients against fewer elsewhere, and the Work Group's position that every dialysis centre should have a mechanism in place to monitor and minimise them \u2014 a monitoring mandate that defines no metric | full text read |", "55")
P(find("| KDOQI Clinical Practice Guidelines and Clinical Practice Recommendations for Vascular Access"),
  "| KDOQI Clinical Practice Guidelines and Clinical Practice Recommendations for Vascular Access: 2006 Update | screened document | https://www.kidney.org/professionals/kdoqi/guidelines-vascular-access | guideline | subject | Screened as a candidate source for vascular-access covariates; the document itself was not retrievable and no claim rests on it | not retrievable |", "56")
P(find("| KDOQI Clinical Practice Guidelines for Peritoneal Dialysis Adequacy"),
  "| KDOQI Clinical Practice Guidelines for Peritoneal Dialysis Adequacy: 2006 Update | screened document | https://www.kidney.org/professionals/kdoqi/guidelines-peritoneal-dialysis-adequacy | guideline | absence | Screened to confirm that modality-specific adequacy guidance for peritoneal dialysis sets no attendance metric for haemodialysis | screened |", "57")
P(find("| KDOQI 2015 update"),
  "| KDOQI 2015 update commentary on the timing of initiation of dialysis | screened document | https://www.kidney.org/professionals/kdoqi/guideline-hemodialysis-adequacy | guideline | subject | Screened as commentary on when to start dialysis; it bears on the prescription, not on attendance | screened |", "58")
P(find("| Optimal Hemodialysis Treatment: Korean Society of Nephrology"),
  "| Executive summary of the Korean Society of Nephrology 2021 clinical practice guideline for optimal hemodialysis treatment (Korean J Intern Med, 2022) | PMID 35811360 | https://doi.org/10.3904/kjim.2021.543 | guideline | absence | Non-US national guidance screened for the same question: the executive summary describes eight sections and fifteen key questions covering preparation, initiation and maintenance of haemodialysis, and names no attendance or adherence standard | abstract read |", "59")
P(find("| Inclement Weather and Risk of Missing Scheduled Hemodialysis Appointments"),
  "| Inclement Weather and Risk of Missing Scheduled Hemodialysis Appointments among Patients with Kidney Failure (Clin J Am Soc Nephrol, 2023) | PMID 37071662 | https://pubmed.ncbi.nlm.nih.gov/37071662/ | pubmed | subject | Weather as an exposure on attendance: 60,135 patients at in-centre clinics across north-eastern US counties, 2001\u20132019, time-stratified case-crossover with conditional Poisson regression and a distributed lag model; incidence rate ratios for a missed appointment of 1.03 per 10 mm of rainfall (95% CI 1.02\u20131.03) and 1.02 for snowfall (1.01\u20131.02) on the day of exposure, and over a seven-day window 1.55 (1.22\u20131.98) for hurricane or tropical-storm exposure, 1.29 (1.25\u20131.31) for sustained wind advisories and 1.34 (1.29\u20131.39) for wind-gust advisories; read from the abstract, the full text not being retrievable | abstract read |", "60")
P(find("| Weather forecasting and missed dialysis appointments"),
  "| What's the Weather Like Today? Forecasting a Chance of Shower, Snow, and\u2026 Missing Dialysis (Clin J Am Soc Nephrol, 2023, editorial) | PMID 39074303 | https://pubmed.ncbi.nlm.nih.gov/39074303/ | pubmed | absence | Editorial accompanying the weather study, located as a lead to other weather work; it has no abstract, so nothing is claimed from it | record only |", "61")
P(find("| Effects of oral nutritional supplements"),
  "| Effects of Oral Nutritional Supplements on Mortality, Missed Dialysis Treatments, and Nutritional Markers in Hemodialysis Patients (J Ren Nutr, 2018) | DOI 10.1053/j.jrn.2017.10.002 | https://doi.org/10.1053/j.jrn.2017.10.002 | crossref | comparator | Screened because missed treatments appear among its outcomes; reached at bibliographic level only, so nothing is claimed about the intervention or its results | record only |", "62")
P(find("| AI and target trial emulation"),
  "| Artificial intelligence and target trial emulation: toward scalable and credible real-world evidence (J Clin Epidemiol, 2026, commentary) | PMID 42716449 | https://pubmed.ncbi.nlm.nih.gov/42716449/ | pubmed | method | Method commentary read at abstract level; used to bound how the target-trial framing is described, not as a source of design rules for this dataset | abstract read |", "63")
P(find("| Target trial emulation: a practical framework"),
  "| Target trial emulation: A practical framework for credible real-world evidence of healthcare interventions (Chin Med J, 2026) | PMID 42260752 | https://pubmed.ncbi.nlm.nih.gov/42260752/ | pubmed | method | Framework located at bibliographic level only \u2014 it has no abstract \u2014 so it bounds the existence of the framework and supplies no design rule here | record only |", "64")
P(find("| Dialysis treatment time, mortality and hospitalization"),
  "| The Associations Between Dialysis Treatment Time, Mortality, and Hospitalizations in a Large Hemodialysis Cohort (Kidney Int Rep, 2026) | PMID 42022337 | https://pubmed.ncbi.nlm.nih.gov/42022337/ | pubmed | subject | Screened to check whether the burden of shorter delivered sessions has already been quantified at scale: in 146,127 in-centre patients, a mean delivered treatment time of 240\u2013254 minutes was associated with lower all-cause mortality than 180\u2013194 minutes (hazard ratio 0.73, 95% CI 0.69\u20130.76), with no such association below a single-pool Kt/V of 1.4; the exposure is delivered duration, not shortened against prescribed sessions, so evidence gap 4 stays open | abstract read |", "65")
P(find("| Open-access full text for the inclement-weather study"),
  "| Open-access full text for the comprehensive care model study | europe-pmc | Retrieval failed; the study is cited from its abstract only | Keeps an abstract-level record from being presented as a read full text |\n| Open-access full text for the inclement-weather study | europe-pmc | Retrieval failed; the study is cited from its abstract only | Same bound for the weather evidence; its effect estimates come from the abstract, not from the full text |", "80")

out = s
for old, new, tag in pairs:
    n = out.count(old)
    assert n == 1, "%s: found %d occurrences" % (tag, n)
    out = out.replace(old, new)
io.open(M, "w", encoding="utf-8").write(out)
print("map replacements applied:", len(pairs), "lines:", len(out.splitlines()))
