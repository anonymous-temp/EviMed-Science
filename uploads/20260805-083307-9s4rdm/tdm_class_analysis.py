#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Class-level antipsychotic TDM analysis on a hospital extract.

Design: treat the antipsychotics as ONE drug class, not five separate drugs.
Everything downstream (range normalisation, dose equivalence, polypharmacy burden)
is defined once for the class and parameterised per molecule.

De-identification: subjects are relabelled S1..S5 by ascending numeric PATIENT_ID.
No PATIENT_ID / CASE_NO / MED_REC_NO / SAMPLENO / BIRTHDATE is ever printed.
"""
import math, re, collections, datetime as dt
import openpyxl

XLSX = "/home/coder/workspace/EviMedScience/uploads/20260805-083307-9s4rdm/20260803TDM.xlsx"

# ----------------------------------------------------------------------------
# 1. Class dictionary. One row per molecule; everything else reads from here.
#    TRR  = therapeutic reference range, AGNP consensus (Hiemke 2018, Pharmacopsychiatry 51:9-62)
#    DDD  = WHO Collaborating Centre for Drug Statistics Methodology, ATC/DDD Index (oral)
#    CPZ  = chlorpromazine equivalent by the DDD method (Leucht 2016, Schizophr Bull 42:S90):
#           chlorpromazine 300 mg/d == 1 DDD  =>  factor = 300 / DDD_drug
#    t12  = elimination half-life, h (AGNP 2018 / product labels)
# ----------------------------------------------------------------------------
CLASS = {
    # generic       ATC        DDDmg  t12   TRRlow TRRhigh  is_antipsychotic  moiety label
    "aripiprazole":  dict(atc="N05AX12", ddd=15.0,  t12=75.0, trr=(150.0, 500.0), ap=True,
                          trr_parent=(100.0, 350.0),
                          moiety="active moiety (aripiprazole + dehydroaripiprazole)"),
    "clozapine":     dict(atc="N05AH02", ddd=300.0, t12=12.0, trr=(350.0, 600.0), ap=True,
                          moiety="parent"),
    "olanzapine":    dict(atc="N05AH03", ddd=10.0,  t12=33.0, trr=(20.0, 80.0),   ap=True,
                          moiety="parent"),
    "quetiapine":    dict(atc="N05AH04", ddd=400.0, t12=7.0,  trr=(100.0, 500.0), ap=True,
                          moiety="parent"),
    "paliperidone":  dict(atc="N05AX13", ddd=6.0,   t12=23.0, trr=(20.0, 60.0),   ap=True,
                          moiety="parent (= 9-OH-risperidone)"),
    "clonazepam":    dict(atc="N03AE01", ddd=8.0,   t12=35.0, trr=(4.0, 80.0),    ap=False,
                          moiety="parent"),
    "lithium":       dict(atc="N05AN01", ddd=None,  t12=24.0, trr=None,           ap=False,
                          moiety="parent"),      # DDD is 24 mmol Li+, not mg -> handled separately
    "valproate":     dict(atc="N03AG01", ddd=1500., t12=14.0, trr=(50.0, 100.0),  ap=False,
                          moiety="parent (mg/L)"),
    "lorazepam":     dict(atc="N05BA06", ddd=2.5,   t12=14.0, trr=None,           ap=False, moiety="parent"),
    "trihexyphenidyl": dict(atc="N04AA01", ddd=10.0, t12=10.0, trr=None,          ap=False, moiety="parent"),
    "sertraline":    dict(atc="N06AB06", ddd=50.0,  t12=26.0, trr=(10.0, 150.0),  ap=False, moiety="parent"),
}
for k, v in CLASS.items():
    v["cpz"] = (300.0 / v["ddd"]) if v["ddd"] else None

# Local trade / Chinese names -> generic. Built by inspecting DRUG_NAME + ORDER_CONTENT.
NAME2GEN = [
    ("阿立哌唑", "aripiprazole"), ("博思清", "aripiprazole"), ("安律凡", "aripiprazole"),
    ("氯氮平", "clozapine"),
    ("奥氮平", "olanzapine"),
    ("喹硫平", "quetiapine"),
    ("帕利哌酮", "paliperidone"), ("帕潘立酮", "paliperidone"), ("芮达", "paliperidone"),
    ("氯硝西泮", "clonazepam"), ("氯硝安定", "clonazepam"),
    ("碳酸锂", "lithium"),
    ("丙戊酸", "valproate"), ("德巴金", "valproate"),
    ("劳拉西泮", "lorazepam"), ("罗拉", "lorazepam"),
    ("苯海索", "trihexyphenidyl"), ("安坦", "trihexyphenidyl"),
    ("舍曲林", "sertraline"), ("左洛复", "sertraline"),
]
# Lab analyte PROJECT_NAME -> (generic, role)
ANALYTE = {
    "阿立哌唑": ("aripiprazole", "parent"),
    "脱氢阿立哌唑": ("aripiprazole", "metabolite"),
    "总阿立哌唑": ("aripiprazole", "active_moiety"),
    "氯氮平": ("clozapine", "parent"),
    "奥氮平": ("olanzapine", "parent"),
    "帕利哌酮（帕潘立酮）": ("paliperidone", "parent"),
    "氯硝西泮": ("clonazepam", "parent"),
}


def to_generic(text):
    t = str(text or "")
    for pat, gen in NAME2GEN:
        if pat in t:
            return gen
    return None


# ----------------------------------------------------------------------------
# 2. FREQUENCY decoder.
#    The suffix digit is a schedule/administration-slot code, not a count: QD9,
#    QD11, QD12, QD15, QD16, QD20 all coexist and cannot be "9 times a day".
#    Doses/day therefore comes from the alphabetic prefix only.
# ----------------------------------------------------------------------------
FREQ_PREFIX = [("QOD", 0.5), ("QID", 4.0), ("TID", 3.0), ("BID", 2.0),
               ("QD", 1.0), ("QN", 1.0), ("QAM", 1.0), ("QPM", 1.0)]
NON_STANDING = {"ONCE", "PRN"}          # single event / as-needed, not a daily rate
UNQUANTIFIED_PREFIX = ("ALWAYS", "W")   # 'ALWAYS', weekly W#D# codes


def doses_per_day(freq):
    f = str(freq or "").upper().strip()
    if f in NON_STANDING or f.startswith(("ONCE", "PRN")):
        return None
    if f.startswith(UNQUANTIFIED_PREFIX):
        return None
    for p, n in FREQ_PREFIX:
        if f.startswith(p):
            return n
    return None


def parse_dt(s):
    s = str(s or "").strip()
    if not s or s.startswith("0/0/0"):
        return None
    m = re.match(r"^(\d+)/(\d+)/(\d+)\s+(\d+):(\d+):(\d+)$", s)
    if m:
        d, mo, y, H, M, S = map(int, m.groups())
        return dt.datetime(y, mo, d, H, M, S)
    m = re.match(r"^(\d+)/(\d+)/(\d+)$", s)
    if m:
        d, mo, y = map(int, m.groups())
        return dt.datetime(y, mo, d)
    return None


# ----------------------------------------------------------------------------
# 3. Load + de-identify
# ----------------------------------------------------------------------------
wb = openpyxl.load_workbook(XLSX, data_only=True)


def sheet(name):
    rows = list(wb[name].iter_rows(values_only=True))
    hdr = rows[0]
    return [dict(zip(hdr, r)) for r in rows[1:]]


lab = sheet("检验")
orders = sheet("医嘱记录")
dx = sheet("诊断记录")
signs = sheet("体征")
face = sheet("病案首页")

pids = sorted({str(r["PATIENT_ID"]) for r in lab}, key=lambda x: int(x))
SUBJ = {p: "S%d" % (i + 1) for i, p in enumerate(pids)}          # never printed
CASE2S = {}
for r in lab:
    CASE2S[r["CASE_NO"]] = SUBJ[str(r["PATIENT_ID"])]


def sid(pid=None, case=None):
    if pid is not None:
        return SUBJ.get(str(pid))
    return CASE2S.get(case)


# ----------------------------------------------------------------------------
# 4. Regimen reconstruction: standing drug orders -> (subject, generic, mg/day, [start,end))
#    Excluded: ORDER_TYPE 4 / MEDICATION_WAY 化验 (lab requisitions living in the
#    order table) and MEDICATION_WAY 出院带药 (discharge dispensing, not an
#    in-hospital administration rate).
# ----------------------------------------------------------------------------
regimen = []
excluded = collections.Counter()
for r in orders:
    s = sid(pid=r["PATIENT_ID"])
    gen = to_generic(r["DRUG_NAME"] or r["ORDER_CONTENT"])
    if not s or not gen:
        continue
    if r["MEDICATION_WAY"] == "化验" or r["DRUG_FLAG"] == 0:
        excluded["lab requisition row"] += 1
        continue
    if r["MEDICATION_WAY"] == "出院带药":
        excluded["discharge dispensing"] += 1
        continue
    n = doses_per_day(r["FREQUENCY"])
    if n is None:
        excluded["non-standing frequency %s" % r["FREQUENCY"]] += 1
        continue
    dose = float(r["DOSAGE"] or 0)
    unit = str(r["DOSAGE_UNIT"] or "")
    if unit == "g":
        dose *= 1000.0
    st, en = parse_dt(r["START_DATETIME"]), parse_dt(r["END_DATETIME"])
    if st is None:
        continue
    regimen.append(dict(s=s, gen=gen, mgday=dose * n, per_dose=dose, npd=n,
                        freq=r["FREQUENCY"], start=st, end=en or dt.datetime(2099, 1, 1)))
regimen.sort(key=lambda x: (x["s"], x["gen"], x["start"]))


def dose_at(s, gen, when):
    """mg/day of `gen` for subject `s` at datetime `when` (0 if no active order)."""
    tot = 0.0
    for o in regimen:
        if o["s"] == s and o["gen"] == gen and o["start"] <= when < o["end"]:
            tot += o["mgday"]
    return tot


def dose_series(s, gen, t0, t1, step_h=1):
    """Hourly mg/day step function, median-filtered to erase order-rewrite artefacts.

    A rewritten order routinely overlaps its predecessor by <1 min (double dose for
    one hour) or leaves a 1-2 h gap (zero dose). Left raw, those spikes reset any
    'dose unchanged since' test. A 5-point median filter removes transients shorter
    than ~3 h while preserving every real titration step.
    """
    grid, t = [], t0
    while t <= t1:
        grid.append((t, dose_at(s, gen, t)))
        t += dt.timedelta(hours=step_h)
    vals = [v for _, v in grid]
    sm = []
    for i in range(len(vals)):
        w = vals[max(0, i - 2):i + 3]
        sm.append(sorted(w)[len(w) // 2])
    return [(grid[i][0], sm[i]) for i in range(len(grid))]


def stable_since(s, gen, when, t0=None):
    """Datetime from which the total mg/day of `gen` has been unchanged up to `when`."""
    if dose_at(s, gen, when) == 0:
        return None
    t0 = t0 or (when - dt.timedelta(days=120))
    ser = dose_series(s, gen, t0, when)
    cur = ser[-1][1]
    if cur == 0:
        return None
    since = ser[0][0]
    for t, v in ser:
        if abs(v - cur) > 1e-9:
            since = None
        elif since is None:
            since = t
    return since


def simulate(s, gen, t0, t1, t12, t12_met=None, fm=1.0, step_h=1.0):
    """One-compartment superposition on the reconstructed dose history.

    dC/dt = R(t)*F/V - k*C, integrated on an hourly grid. F/V cancels in any
    ratio of two timepoints, so predicted C(t2)/C(t1) depends only on the dose
    history and k -- no PK parameters have to be assumed beyond the half-life.
    Optional metabolite compartment: dM/dt = fm*k*C - k_m*M (formation-rate model).
    """
    k = math.log(2) / t12
    km = math.log(2) / t12_met if t12_met else None
    C = M = 0.0
    out, t = [], t0
    while t <= t1:
        R = dose_at(s, gen, t) / 24.0            # mg per hour
        C += (R - k * C) * step_h
        if km:
            M += (fm * k * C - km * M) * step_h
        out.append((t, C, M))
        t += dt.timedelta(hours=step_h)
    return out


# ----------------------------------------------------------------------------
# 5. TDM events. Collection date is recovered from the sample-barcode date prefix
#    (the barcode itself is never printed); TEST_DATE is the analysis/report date.
# ----------------------------------------------------------------------------
events = collections.defaultdict(dict)     # (subject, collection_date) -> {analyte_key: value}
LAG = {}                                   # (subject, collection_date) -> report lag, days
ranges_seen = {}
for r in lab:
    s = sid(pid=r["PATIENT_ID"])
    coll = dt.datetime.strptime(str(r["SAMPLENO"])[:8], "%Y%m%d")
    gen, role = ANALYTE[r["PROJECT_NAME"]]
    events[(s, coll)][(gen, role)] = float(r["TEST_RESULT"])
    if r["REFFR_SCOPE"]:
        lo, hi = [float(x) for x in str(r["REFFR_SCOPE"]).split("-")]
        ranges_seen[(gen, role)] = (lo, hi)
    LAG[(s, coll)] = (parse_dt(r["TEST_DATE"]) - coll).days

# ----------------------------------------------------------------------------
# 6. Class normalisation
# ----------------------------------------------------------------------------
def prp_linear(c, lo, hi):
    return 100.0 * (c - lo) / (hi - lo)


def lrp_log(c, lo, hi):
    return 100.0 * (math.log(c) - math.log(lo)) / (math.log(hi) - math.log(lo))


def z_trr(c, lo, hi):
    """z on the log scale, treating [lo,hi] as the central 95% (mu -/+ 1.96 sigma)."""
    mu = 0.5 * (math.log(lo) + math.log(hi))
    sd = (math.log(hi) - math.log(lo)) / 3.92
    return (math.log(c) - mu) / sd


def band(c, lo, hi):
    return "below" if c < lo else ("above" if c > hi else "within")


# ============================ OUTPUT ========================================
P = print
P("=" * 78)
P("[A] REFERENCE RANGES IN THE EXTRACT vs AGNP CONSENSUS (Hiemke 2018)")
P("=" * 78)
P("%-14s %-14s %14s %14s %8s" % ("analyte", "role", "extract", "AGNP", "match"))
for (gen, role), (lo, hi) in sorted(ranges_seen.items()):
    ref = CLASS[gen].get("trr_parent", CLASS[gen]["trr"]) if role == "parent" and "trr_parent" in CLASS[gen] else CLASS[gen]["trr"]
    P("%-14s %-14s %14s %14s %8s" % (gen, role, "%g-%g" % (lo, hi), "%g-%g" % ref,
                                     "YES" if (lo, hi) == ref else "NO"))
P("\nRange geometry (why linear normalisation is not class-comparable):")
P("%-14s %10s %10s %10s %12s %12s" % ("drug", "low", "high", "fold", "lin.width", "PRP@geo-mid"))
for gen in ["aripiprazole", "clozapine", "olanzapine", "paliperidone", "quetiapine", "clonazepam"]:
    lo, hi = CLASS[gen]["trr"]
    g = math.sqrt(lo * hi)
    P("%-14s %10.1f %10.1f %10.2f %12.1f %12.1f" % (gen, lo, hi, hi / lo, hi - lo, prp_linear(g, lo, hi)))
P("(log position at the geometric mid-point is 50.0 for every drug by construction)")

P()
P("=" * 78)
P("[B] CLASS DOSE-EQUIVALENCE TABLE (DDD method, Leucht 2016)")
P("=" * 78)
P("%-16s %-9s %8s %10s %10s" % ("generic", "ATC", "DDD mg", "CPZ/mg", "TRR ng/mL"))
for gen in ["aripiprazole", "clozapine", "olanzapine", "quetiapine", "paliperidone",
            "clonazepam", "valproate", "lorazepam", "trihexyphenidyl", "sertraline"]:
    v = CLASS[gen]
    P("%-16s %-9s %8s %10s %10s" % (gen, v["atc"], v["ddd"],
                                    ("%.2f" % v["cpz"]) if v["cpz"] and v["ap"] else "-",
                                    ("%g-%g" % v["trr"]) if v["trr"] else "-"))

P()
P("=" * 78)
P("[C] RECONSTRUCTED STANDING REGIMENS (mg/day; in-hospital administration only)")
P("=" * 78)
P("excluded rows: " + ", ".join("%s=%d" % kv for kv in sorted(excluded.items())))
P("%-4s %-16s %9s %8s %-7s %-12s %-12s" % ("subj", "generic", "mg/day", "per-dose", "freq", "from", "to"))
for o in regimen:
    P("%-4s %-16s %9.2f %8.2f %-7s %-12s %-12s" % (
        o["s"], o["gen"], o["mgday"], o["per_dose"], o["freq"],
        o["start"].strftime("%Y-%m-%d"),
        o["end"].strftime("%Y-%m-%d") if o["end"].year < 2099 else "open"))

# ---- overlapping same-drug orders -----------------------------------------
P()
P("=" * 78)
P("[C2] OVERLAPPING ORDERS FOR THE SAME MOLECULE (must be summed, or flagged)")
P("=" * 78)
P("%-4s %-14s %-11s %-11s %8s %8s %-24s" % ("subj", "generic", "overlap fr", "overlap to",
                                            "mg/d A", "mg/d B", "reading"))
for i, a in enumerate(regimen):
    for b in regimen[i + 1:]:
        if a["s"] != b["s"] or a["gen"] != b["gen"]:
            continue
        lo, hi = max(a["start"], b["start"]), min(a["end"], b["end"])
        if lo >= hi:
            continue
        same = abs(a["per_dose"] - b["per_dose"]) < 1e-9 and a["freq"][:3] == b["freq"][:3]
        note = "AMBIGUOUS: identical dose" if same else "split regimen (genuine)"
        P("%-4s %-14s %-11s %-11s %8.1f %8.1f %-24s" % (
            a["s"], a["gen"], lo.strftime("%Y-%m-%d"), hi.strftime("%Y-%m-%d"),
            a["mgday"], b["mgday"], note))

# ---- per-event class table -------------------------------------------------
P()
P("=" * 78)
P("[D] CLASS-LEVEL DOSE-NORMALISED CONCENTRATION TABLE")
P("=" * 78)
P("%-4s %-11s %-13s %8s %8s %8s %8s %7s %7s %7s %-6s %6s" % (
    "subj", "coll.date", "drug", "C", "D mg/d", "C/D", "CPZeq", "PRPlin", "LRPlog", "z_TRR",
    "band", "SS?"))
rowsD = []
for (s, coll), vals in sorted(events.items()):
    for gen in ["aripiprazole", "clozapine", "olanzapine", "paliperidone", "clonazepam", "quetiapine"]:
        key = ("aripiprazole", "active_moiety") if gen == "aripiprazole" else (gen, "parent")
        if key not in vals:
            continue
        c = vals[key]
        lo, hi = CLASS[gen]["trr"]
        d = dose_at(s, gen, coll)
        since = stable_since(s, gen, coll)
        if since:
            hrs = (coll - since).total_seconds() / 3600.0
            frac = 1 - math.exp(-math.log(2) * hrs / CLASS[gen]["t12"])
            ss = "%.0f%%" % (100 * frac)
        else:
            ss = "n/a"
        cd = (c / d) if d else float("nan")
        cpz = d * CLASS[gen]["cpz"] if (d and CLASS[gen]["ap"]) else 0.0
        row = dict(s=s, coll=coll, gen=gen, c=c, d=d, cd=cd, cpz=cpz,
                   prp=prp_linear(c, lo, hi), lrp=lrp_log(c, lo, hi), z=z_trr(c, lo, hi),
                   band=band(c, lo, hi), ss=ss, ap=CLASS[gen]["ap"])
        rowsD.append(row)
        P("%-4s %-11s %-13s %8.1f %8.1f %8s %8.0f %7.1f %7.1f %7.2f %-6s %6s" % (
            s, coll.strftime("%Y-%m-%d"), gen, c, d,
            ("%.2f" % cd) if d else "  n/a", cpz, row["prp"], row["lrp"], row["z"], row["band"], ss))
P("C = ng/mL (active moiety for aripiprazole, parent otherwise); C/D = ng/mL per mg/day;")
P("CPZeq = mg chlorpromazine/day; SS? = %% of steady state reached on the unchanged dose.")

# ---- dose-ambiguity sensitivity on C/D ------------------------------------
P()
P("Sensitivity of C/D to the ambiguous duplicate order (aripiprazole, S5):")
for assumed in (10.0, 20.0):
    c = events[("S5", dt.datetime(2021, 3, 19))][("aripiprazole", "active_moiety")]
    P("  assumed dose %4.0f mg/d -> C/D = %5.2f ng/mL per mg/day, CPZeq = %4.0f mg/d" %
      (assumed, c / assumed, assumed * CLASS["aripiprazole"]["cpz"]))
cds = [r["cd"] for r in rowsD if r["gen"] == "aripiprazole" and r["d"] > 0]
P("  aripiprazole C/D across all evaluable samples: " + ", ".join("%.2f" % v for v in sorted(cds)))
P("  fold-spread (max/min) = %.2f" % (max(cds) / min(cds)))

# ---- linear vs log disagreement -------------------------------------------
P()
P("Linear-vs-log disagreement on the measured points (|PRPlin - LRPlog|):")
for r in sorted(rowsD, key=lambda r: -abs(r["prp"] - r["lrp"]))[:8]:
    P("  %-4s %-13s C=%7.1f  PRPlin=%6.1f  LRPlog=%6.1f  diff=%5.1f pts" %
      (r["s"], r["gen"], r["c"], r["prp"], r["lrp"], abs(r["prp"] - r["lrp"])))

# ---- polypharmacy ----------------------------------------------------------
P()
P("=" * 78)
P("[E] ANTIPSYCHOTIC POLYPHARMACY AND TOTAL CLASS BURDEN")
P("=" * 78)
subjects = sorted(set(SUBJ.values()))
adm = {}
for r in face:
    s = sid(case=r["CASE_NO"])
    adm[s] = (parse_dt(r["IN_DATE"]), parse_dt(r["DIS_DATE"]), r["DAY_TOTAL"])

P("Whole-admission antipsychotic exposure (daily grid, in-hospital standing orders):")
P("%-4s %6s %6s %8s %8s %10s %10s %9s" % ("subj", "LOS d", "APdays", "maxAP", "meanAP",
                                          "peakCPZ", "meanCPZ", "peakDDD"))
poly = {}
for s in subjects:
    st, en, los = adm[s]
    day = st.replace(hour=12, minute=0, second=0)
    ncounts, cpzs, ddds = [], [], []
    while day <= en:
        aps = [g for g in CLASS if CLASS[g]["ap"] and dose_at(s, g, day) > 0]
        ncounts.append(len(aps))
        cpzs.append(sum(dose_at(s, g, day) * CLASS[g]["cpz"] for g in aps))
        ddds.append(sum(dose_at(s, g, day) / CLASS[g]["ddd"] for g in aps))
        day += dt.timedelta(days=1)
    poly[s] = dict(max=max(ncounts), mean=sum(ncounts) / len(ncounts),
                   apdays=sum(1 for n in ncounts if n >= 1),
                   polydays=sum(1 for n in ncounts if n >= 2),
                   peakcpz=max(cpzs), meancpz=sum(cpzs) / len(cpzs), peakddd=max(ddds))
    P("%-4s %6d %6d %8d %8.2f %10.0f %10.0f %9.2f" % (
        s, los, poly[s]["apdays"], poly[s]["max"], poly[s]["mean"],
        poly[s]["peakcpz"], poly[s]["meancpz"], poly[s]["peakddd"]))
P("polypharmacy days (>=2 antipsychotics simultaneously): " +
  ", ".join("%s=%d" % (s, poly[s]["polydays"]) for s in subjects))

P()
P("At the TDM sampling moment - PRESCRIBED vs MEASURED antipsychotic count:")
P("%-4s %-11s %-38s %-38s" % ("subj", "coll.date", "prescribed AP (mg/d)", "measured AP (ng/mL)"))
disc = []
for (s, coll), vals in sorted(events.items()):
    pres = {g: dose_at(s, g, coll) for g in CLASS if CLASS[g]["ap"] and dose_at(s, g, coll) > 0}
    meas = {}
    for (gen, role), v in vals.items():
        if CLASS[gen]["ap"] and role in ("parent", "active_moiety"):
            if gen == "aripiprazole" and role != "active_moiety":
                continue
            meas[gen] = v
    ps = ", ".join("%s %g" % (g[:4], d) for g, d in sorted(pres.items())) or "(none)"
    ms = ", ".join("%s %g" % (g[:4], v) for g, v in sorted(meas.items())) or "(none)"
    P("%-4s %-11s %-38s %-38s" % (s, coll.strftime("%Y-%m-%d"), ps, ms))
    only_meas = set(meas) - set(pres)
    only_pres = set(pres) - set(meas)
    if only_meas or only_pres:
        disc.append((s, coll, only_meas, only_pres))
for s, coll, om, op in disc:
    if om:
        P("  !! %s %s: detected but NOT prescribed in hospital: %s" %
          (s, coll.strftime("%Y-%m-%d"), ", ".join(sorted(om))))
    if op:
        P("  !! %s %s: prescribed but NOT measured: %s" %
          (s, coll.strftime("%Y-%m-%d"), ", ".join(sorted(op))))

# ---- class burden index ----------------------------------------------------
P()
P("=" * 78)
P("[F] TOTAL CLASS EXPOSURE INDEX (TCEI) vs DOSE-EQUIVALENT BURDEN")
P("=" * 78)
P("TCEI = sum of z_TRR over all measured antipsychotics at one sampling moment.")
P("%-4s %-11s %8s %8s %8s %9s %7s" % ("subj", "coll.date", "nAP_meas", "sum_z", "mean_z",
                                      "CPZeq", "DDD/d"))
burden = []
for (s, coll), vals in sorted(events.items()):
    zs, cpz, ddd, n = [], 0.0, 0.0, 0
    for r in rowsD:
        if r["s"] == s and r["coll"] == coll and r["ap"]:
            zs.append(r["z"]); n += 1
    for g in CLASS:
        if CLASS[g]["ap"]:
            d = dose_at(s, g, coll)
            if d:
                cpz += d * CLASS[g]["cpz"]; ddd += d / CLASS[g]["ddd"]
    b = dict(s=s, coll=coll, n=n, sumz=sum(zs), meanz=sum(zs) / n if n else 0, cpz=cpz, ddd=ddd)
    burden.append(b)
    P("%-4s %-11s %8d %8.2f %8.2f %9.0f %7.2f" % (s, coll.strftime("%Y-%m-%d"), n,
                                                  b["sumz"], b["meanz"], cpz, ddd))
P()
P("Measured class burden in therapeutic-range units (TRU), the concentration-side")
P("analogue of DDD/day: TRU_d = C_d / geomean(TRR_d); a drug at the geometric centre")
P("of its own range contributes exactly 1.0, exactly as 1 DDD does on the dose side.")
P("%-4s %-11s %28s %9s %9s %9s" % ("subj", "coll.date", "per-drug TRU", "sumTRU", "DDD/d", "TRU/DDD"))
for b in burden:
    parts, tot = [], 0.0
    for r in rowsD:
        if r["s"] == b["s"] and r["coll"] == b["coll"] and r["ap"]:
            lo, hi = CLASS[r["gen"]]["trr"]
            tru = r["c"] / math.sqrt(lo * hi)
            parts.append("%s %.2f" % (r["gen"][:4], tru)); tot += tru
    b["tru"] = tot
    b["ratio"] = tot / b["ddd"] if b["ddd"] else float("nan")
    P("%-4s %-11s %28s %9.2f %9.2f %9.2f" % (b["s"], b["coll"].strftime("%Y-%m-%d"),
                                             ", ".join(parts), tot, b["ddd"], b["ratio"]))
rr = [b["ratio"] for b in burden]
P("  measured-to-prescribed exposure ratio spans %.2f - %.2f (%.1f-fold across %d moments)"
  % (min(rr), max(rr), max(rr) / min(rr), len(rr)))

P()
P("Ranking of sampling moments, dose-side vs measurement-side:")
by_cpz = [b["s"] + "@" + b["coll"].strftime("%m-%d") for b in sorted(burden, key=lambda b: -b["cpz"])]
by_z = [b["s"] + "@" + b["coll"].strftime("%m-%d") for b in sorted(burden, key=lambda b: -b["sumz"])]
P("  by total CPZ-equivalent dose : " + " > ".join(by_cpz))
P("  by total measured exposure   : " + " > ".join(by_z))
P("  concordant order? %s" % (by_cpz == by_z))

# Spearman between CPZeq and sum_z
def spearman(x, y):
    def rank(v):
        o = sorted(range(len(v)), key=lambda i: v[i])
        r = [0.0] * len(v); i = 0
        while i < len(o):
            j = i
            while j + 1 < len(o) and v[o[j + 1]] == v[o[i]]:
                j += 1
            avg = (i + j) / 2.0 + 1
            for k in range(i, j + 1):
                r[o[k]] = avg
            i = j + 1
        return r
    rx, ry = rank(x), rank(y)
    n = len(x)
    mx, my = sum(rx) / n, sum(ry) / n
    num = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    den = math.sqrt(sum((a - mx) ** 2 for a in rx) * sum((b - my) ** 2 for b in ry))
    return num / den if den else float("nan")


xs = [b["cpz"] for b in burden]
ys = [b["sumz"] for b in burden]
P("  Spearman rho(total CPZeq, total measured z) = %.3f over %d sampling moments" %
  (spearman(xs, ys), len(burden)))

# ---- conversion-table sensitivity -----------------------------------------
P()
P("=" * 78)
P("[G] SENSITIVITY OF THE CPZ-EQUIVALENT RANKING TO THE CONVERSION TABLE")
P("=" * 78)
P("Multiply one drug's CPZ factor by k and ask when the subject ranking changes.")
base = {b["s"] + "@" + b["coll"].strftime("%m-%d"): b["cpz"] for b in burden}
base_order = [k for k, _ in sorted(base.items(), key=lambda kv: -kv[1])]
for gen in ["aripiprazole", "clozapine", "olanzapine", "paliperidone"]:
    flip = None
    k = 1.0
    while k <= 5.0:
        cur = {}
        for b in burden:
            tot = 0.0
            for g in CLASS:
                if CLASS[g]["ap"]:
                    d = dose_at(b["s"], g, b["coll"])
                    if d:
                        tot += d * CLASS[g]["cpz"] * (k if g == gen else 1.0)
            cur[b["s"] + "@" + b["coll"].strftime("%m-%d")] = tot
        if [kk for kk, _ in sorted(cur.items(), key=lambda kv: -kv[1])] != base_order:
            flip = k
            break
        k += 0.01
    dn = None
    k = 1.0
    while k >= 0.05:
        cur = {}
        for b in burden:
            tot = 0.0
            for g in CLASS:
                if CLASS[g]["ap"]:
                    d = dose_at(b["s"], g, b["coll"])
                    if d:
                        tot += d * CLASS[g]["cpz"] * (k if g == gen else 1.0)
            cur[b["s"] + "@" + b["coll"].strftime("%m-%d")] = tot
        if [kk for kk, _ in sorted(cur.items(), key=lambda kv: -kv[1])] != base_order:
            dn = k
            break
        k -= 0.01
    P("  %-14s ranking survives factor x%s .. x%s" %
      (gen, ("%.2f" % dn) if dn else "0.05", ("%.2f" % flip) if flip else ">5.00"))

# ---- within-subject repeat -------------------------------------------------
P()
P("=" * 78)
P("[H] WITHIN-SUBJECT REPEAT: NON-STEADY-STATE AND THE METABOLITE RATIO")
P("=" * 78)
P("Assumed trough collection time 07:00 on the collection date.")
rep = collections.defaultdict(list)
for (s_, coll), vals in events.items():
    rep[s_].append((coll, vals))
for s_, lst in sorted(rep.items()):
    if len(lst) < 2:
        continue
    lst.sort()
    (c1, v1), (c2, v2) = lst[0], lst[1]
    c1 = c1.replace(hour=7); c2 = c2.replace(hour=7)
    t0 = min(o["start"] for o in regimen if o["s"] == s_)
    since = stable_since(s_, "aripiprazole", c2, t0)
    t12, t12m = CLASS["aripiprazole"]["t12"], 94.0
    sim = simulate(s_, "aripiprazole", t0, c2, t12, t12m)
    P("  %s: aripiprazole %g mg/day, dose unchanged since %s" %
      (s_, dose_at(s_, "aripiprazole", c2), since.strftime("%Y-%m-%d %H:%M")))
    for lbl, ci in [("sample 1", c1), ("sample 2", c2)]:
        hrs = (ci - since).total_seconds() / 3600.0
        P("    %s: %.1f d (%.2f parent half-lives) on the unchanged dose -> naive %.1f%% of Css"
          % (lbl, hrs / 24, hrs / t12, 100 * (1 - math.exp(-math.log(2) * hrs / t12))))
    def at(sim, when):
        best = min(sim, key=lambda r: abs((r[0] - when).total_seconds()))
        return best[1], best[2]
    k1p, k1m = at(sim, c1); k2p, k2m = at(sim, c2)
    P("    %-9s %8s %8s %9s %9s %9s" % ("analyte", "obs t1", "obs t2", "obs ratio", "sim ratio", "resid %"))
    pairs = [("parent", ("aripiprazole", "parent"), k2p / k1p),
             ("dehydro", ("aripiprazole", "metabolite"), k2m / k1m),
             ("moiety", ("aripiprazole", "active_moiety"),
              (k2p + k2m) / (k1p + k1m))]
    for lbl, key, simr in pairs:
        a, b = v1[key], v2[key]
        P("    %-9s %8.1f %8.1f %9.3f %9.3f %+9.1f" %
          (lbl, a, b, b / a, simr, 100 * ((b / a) / simr - 1)))
    mr1 = v1[("aripiprazole", "metabolite")] / v1[("aripiprazole", "parent")]
    mr2 = v2[("aripiprazole", "metabolite")] / v2[("aripiprazole", "parent")]
    P("    metabolite ratio %.3f -> %.3f  (observed +%.1f%%)" % (mr1, mr2, 100 * (mr2 / mr1 - 1)))
    P("    simulated MR     %.3f -> %.3f  (predicted +%.1f%% from non-steady-state alone)"
      % (k1m / k1p, k2m / k2p, 100 * ((k2m / k2p) / (k1m / k1p) - 1)))
    P("    => an MR measured before the metabolite reaches steady state is biased DOWN;")
    P("       %.0f%% of the observed within-subject MR change is explained by sampling time."
      % (100 * (math.log((k2m / k2p) / (k1m / k1p)) / math.log(mr2 / mr1))))

P()
P("Steady-state adequacy of every antipsychotic measurement in the extract:")
P("%-4s %-11s %-13s %9s %9s %-8s" % ("subj", "coll.date", "drug", "days on", "t12 units", "usable?"))
nss = 0
for r in rowsD:
    if not r["ap"]:
        continue
    t0 = min(o["start"] for o in regimen if o["s"] == r["s"])
    since = stable_since(r["s"], r["gen"], r["coll"].replace(hour=7), t0)
    if since is None:
        P("%-4s %-11s %-13s %9s %9s %-8s" % (r["s"], r["coll"].strftime("%Y-%m-%d"), r["gen"],
                                             "-", "-", "NO (no order)"))
        continue
    hrs = (r["coll"].replace(hour=7) - since).total_seconds() / 3600.0
    n12 = hrs / CLASS[r["gen"]]["t12"]
    ok = n12 >= 5
    nss += ok
    P("%-4s %-11s %-13s %9.1f %9.2f %-8s" % (r["s"], r["coll"].strftime("%Y-%m-%d"), r["gen"],
                                             hrs / 24, n12, "yes" if ok else "NO (<5 t12)"))
P("  %d of %d antipsychotic measurements meet the >=5 half-life steady-state criterion (%.0f%%)"
  % (nss, sum(1 for r in rowsD if r["ap"]), 100.0 * nss / sum(1 for r in rowsD if r["ap"])))

# ---- outcomes available in the schema --------------------------------------
P()
P("=" * 78)
P("[I] CLASS-LEVEL OUTCOME VARIABLES PRESENT IN THIS SCHEMA")
P("=" * 78)
EPS_CODES = {"G24": "extrapyramidal / dystonia / tardive dyskinesia",
             "E22.1": "hyperprolactinaemia", "G21": "secondary parkinsonism"}
P("%-4s %-46s %-28s" % ("subj", "dopaminergic AE codes (ICD-10)", "anticholinergic cover"))
for s in subjects:
    codes = []
    for r in dx:
        if sid(case=r["CASE_NO"]) == s and r["DIAGNOSIS_CODE"]:
            cd = str(r["DIAGNOSIS_CODE"])
            for pref, lbl in EPS_CODES.items():
                if cd.startswith(pref):
                    codes.append("%s %s" % (cd, str(r["DIAGNOSTIC_NAME"]).strip()))
    codes = sorted(set(codes))
    thx = [o for o in regimen if o["s"] == s and o["gen"] == "trihexyphenidyl"]
    stat = sum(1 for r in orders if sid(pid=r["PATIENT_ID"]) == s and
               to_generic(r["DRUG_NAME"] or r["ORDER_CONTENT"]) == "trihexyphenidyl" and
               str(r["FREQUENCY"]).startswith("ONCE") and r["MEDICATION_WAY"] not in ("化验", "出院带药"))
    thxs = ("%g mg/d x %dd" % (thx[0]["mgday"], sum((min(o["end"], dt.datetime(2099, 1, 1)) - o["start"]).days
                                                    for o in thx))) if thx else ("none (%d stat dose)" % stat if stat else "none")
    P("%-4s %-46s %-28s" % (s, "; ".join(codes) if codes else "-", thxs))

P()
P("Peak class burden vs coded dopaminergic AE (the class-level exposure-response cell):")
P("%-4s %10s %10s %8s %8s %-10s" % ("subj", "peakCPZ", "peakDDD", "maxAP", "TCEI", "AE coded"))
for s in subjects:
    aes = any(str(r["DIAGNOSIS_CODE"] or "").startswith(("G24", "E22.1", "G21"))
              for r in dx if sid(case=r["CASE_NO"]) == s)
    tc = max([b["sumz"] for b in burden if b["s"] == s], default=float("nan"))
    P("%-4s %10.0f %10.2f %8d %8.2f %-10s" % (s, poly[s]["peakcpz"], poly[s]["peakddd"],
                                              poly[s]["max"], tc, "YES" if aes else "no"))

# ---- power ------------------------------------------------------------------
P()
P("=" * 78)
P("[J] SAMPLE SIZE THE CLASS DESIGN NEEDS AT HOSPITAL SCALE")
P("=" * 78)
zvals = [r["z"] for r in rowsD if r["ap"]]
n = len(zvals)
mz = sum(zvals) / n
sdz = math.sqrt(sum((v - mz) ** 2 for v in zvals) / (n - 1))
P("Observed z_TRR across all %d antipsychotic measurements: mean %.3f, SD %.3f" % (n, mz, sdz))
P("(z is unitless and pooled across five molecules only because of the TRR normalisation)")
for d_eff in (0.3, 0.5, 0.8):
    npg = 2 * ((1.959964 + 0.8416212) ** 2) / (d_eff ** 2)
    P("  two-group comparison of mean z_TRR, alpha=.05 two-sided, power=.80, "
      "Cohen d=%.1f -> n=%d per group" % (d_eff, math.ceil(npg)))
P("  logistic model of a coded dopaminergic AE on TCEI + CPZeq + age + sex + "
  "hepatic-impairment flag (5 predictors), 10 events per variable (Peduzzi 1996)")
P("    -> 50 events; at a 10%% AE-coding rate that is n=500 admissions with paired TDM")
P("  mixed model for within-subject repeats: %d of %d subjects here contribute a repeat "
  "(%.0f%%)" % (sum(1 for s in rep if len(rep[s]) > 1), len(rep),
                100.0 * sum(1 for s in rep if len(rep[s]) > 1) / len(rep)))


# ============================================================================
P()
P("=" * 78)
P("[K] DNR - DOSE-NORMALISED RANGE ATTAINMENT (the cross-drug comparable quantity)")
P("=" * 78)
P("DNR_d = TRU_d / (D_d / DDD_d) = [C_d / geomean(TRR_d)] / [D_d / DDD_d]")
P("DNR = 1.0 means: on exactly one defined daily dose the patient sits at the")
P("geometric centre of that drug's own therapeutic reference range, i.e. exactly")
P("population-typical pharmacokinetics. DNR is unitless and comparable ACROSS")
P("molecules; C/D (ng/mL per mg) is not.")
P()
bw = {}
for r in signs:
    s_ = sid(case=r["CASE_NO"])
    if r["SIGN_TYPE"] == "体重" and s_:
        bw.setdefault(s_, []).append((parse_dt(r["RECORD_DATE"]), float(r["RECORD_CONTENT"])))
ht = {}
for r in signs:
    s_ = sid(case=r["CASE_NO"])
    if r["SIGN_TYPE"] == "身高" and s_:
        ht[s_] = float(r["RECORD_CONTENT"])

P("%-4s %-11s %-13s %8s %8s %8s %8s %8s %8s" % ("subj", "coll.date", "drug", "TRU", "D/DDD",
                                                "DNR", "lnDNR", "mg/kg/d", "BMI"))
dnr_rows = []
for r in rowsD:
    if not r["ap"] or r["d"] == 0:
        continue
    lo, hi = CLASS[r["gen"]]["trr"]
    tru = r["c"] / math.sqrt(lo * hi)
    du = r["d"] / CLASS[r["gen"]]["ddd"]
    dnr = tru / du
    w = min(bw.get(r["s"], [(None, float("nan"))]), key=lambda x: abs((x[0] - r["coll"]).days))[1]
    bmi = w / (ht[r["s"]] / 100.0) ** 2 if r["s"] in ht else float("nan")
    dnr_rows.append(dict(s=r["s"], coll=r["coll"], gen=r["gen"], dnr=dnr, ln=math.log(dnr)))
    P("%-4s %-11s %-13s %8.2f %8.2f %8.2f %8.3f %8.3f %8.1f" %
      (r["s"], r["coll"].strftime("%Y-%m-%d"), r["gen"], tru, du, dnr, math.log(dnr), r["d"] / w, bmi))

P()
P("Is exposure attainment a property of the PATIENT or of the MOLECULE?")
P("Subjects with >=2 different antipsychotics measured at the SAME moment:")
pairs = []
bym = collections.defaultdict(list)
for r in dnr_rows:
    bym[(r["s"], r["coll"])].append(r)
for (s_, coll), rs in sorted(bym.items()):
    if len(rs) < 2:
        continue
    P("  %s %s: %s" % (s_, coll.strftime("%Y-%m-%d"),
                       ", ".join("%s DNR=%.3f" % (x["gen"], x["dnr"]) for x in rs)))
    for i in range(len(rs)):
        for j in range(i + 1, len(rs)):
            d = rs[i]["ln"] - rs[j]["ln"]
            pairs.append(d)
            P("      within-patient across molecules: DNR ratio %.3f (ln diff %.4f)"
              % (math.exp(abs(d)), abs(d)))
k = len(pairs)
sd_within = math.sqrt(sum(d * d for d in pairs) / (2.0 * k)) if k else float("nan")
per_subj = {}
for r in dnr_rows:
    per_subj.setdefault(r["s"], []).append(r["ln"])
means = [sum(v) / len(v) for v in per_subj.values()]
m = sum(means) / len(means)
sd_between = math.sqrt(sum((x - m) ** 2 for x in means) / (len(means) - 1))
P()
P("  within-patient  SD of ln(DNR) across molecules = %.4f  (from %d concurrent pairs)"
  % (sd_within, k))
P("  between-patient SD of ln(DNR)                  = %.4f  (from %d subjects)"
  % (sd_between, len(means)))
P("  variance ratio (ICC-like) = %.3f  -- %.0f%% of the spread in exposure attainment"
  % (sd_between ** 2 / (sd_between ** 2 + sd_within ** 2),
     100 * sd_between ** 2 / (sd_between ** 2 + sd_within ** 2)))
P("     sits BETWEEN patients, not between molecules within a patient.")
P("  fold-range of DNR across subjects: %.2f (%.2f to %.2f)"
  % (max(r["dnr"] for r in dnr_rows) / min(r["dnr"] for r in dnr_rows),
     min(r["dnr"] for r in dnr_rows), max(r["dnr"] for r in dnr_rows)))
P("  CAVEAT: k=%d concurrent pairs. Point estimate only; the CI is uninformative." % k)
P("  n needed to estimate an ICC of 0.90 with a 95%% CI half-width of 0.05,")
P("  2 measurements per subject (Bonett 2002 approximation):")
for icc in (0.7, 0.8, 0.9):
    w = 0.10
    n = 8 * ((1 - icc) ** 2) * ((1 + icc) ** 2) / (2 * (w / 1.959964) ** 2) + 1
    P("     ICC=%.1f, CI half-width 0.05 -> n = %d patients with 2 concurrent antipsychotic levels"
      % (icc, math.ceil(n)))
