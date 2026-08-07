# Data-Standards Audit — 20260803TDM.xlsx

**Source:** `/home/coder/workspace/EviMedScience/uploads/20260805-083307-9s4rdm/20260803TDM.xlsx` · 5 sheets · subjects referred to as S1–S5 by ascending internal ID.

**Headline:** this is a well-formed relational extract from a Chinese psychiatric HIS with **four separate coding systems in one diagnosis column**, a **local order-scheduling vocabulary that decodes cleanly against co-occurrence**, and **three silent corruption traps** (a 100%-null join key, a D/M/Y date format that 51.4% of values cannot self-disambiguate, and pipe-delimited code/name lists sorted under different collations). All three are detectable and all three are fixable in the extract spec. Every number below is computed from the file.

---

## 0. The canonical loader

Everything downstream depends on three decisions. Each is forced by evidence in §2.

```python
import pandas as pd, numpy as np, re, warnings
warnings.filterwarnings('ignore')
XL='.../20260803TDM.xlsx'
SH=['病案首页','医嘱记录','检验','诊断记录','体征']
D={s:pd.read_excel(XL,sheet_name=s,dtype=object) for s in SH}   # dtype=object is mandatory

def P(x):                                    # D/M/Y + Oracle zero-date sentinel
    s=str(x).strip()
    return pd.NaT if s.startswith('0/0/0') else pd.to_datetime(s,dayfirst=True,errors='coerce')

def K(x):                                    # keys are zero-padded strings, never numeric
    return None if pd.isna(x) else str(x)
```

`pd.read_excel` without `dtype=object`, or `pd.to_datetime` without `dayfirst=True`, both **fail loudly on this file** — verified: default parsing raises `ValueError: time data "17/1/2021 19:51:55" doesn't match format "%m/%d/%Y"` only *after* silently accepting the first three rows as M/D/Y.

---

## 1. Coding-system audit

### 1.1 诊断记录.DIAGNOSIS_CODE — four systems in one column

```python
def fam(c):
    if pd.isna(c): return 'NULL (uncoded)'
    c=str(c)
    if re.fullmatch(r'[A-Z]\d{2}\.\d{3}x\d{3}',c): return 'ICD-10 CN national extension'
    if re.fullmatch(r'[A-Z]\d{2}\.\d{3}',c):       return 'ICD-10 CN 6-char clinical'
    if re.fullmatch(r'[A-Z]{3}[A-Z0-9]\d{2}',c):   return 'TCM alphanumeric (GB/T 15657 family)'
    if re.fullmatch(r'[A-Z]\d{2}(\.\d{2})+',c):    return 'TCM dotted hierarchical'
    return 'UNCLASSIFIED'
```

| Family | Distinct codes | Rows | Exemplars | Standard |
|---|---|---|---|---|
| ICD-10 CN 6-char clinical | 11 | 17 | `F20.300` 未分化型精神分裂症, `F41.101` 焦虑状态, `B18.101` 慢性活动型乙型病毒性肝炎, `K72.905` 肝功能不全, `G24.901` 迟发性运动障碍, `Z03.200` | ICD-10 with the Chinese 6-character clinical extension (`国家临床版`), root of GB/T 14396-2016 |
| ICD-10 CN national extension | 5 | 7 | `F31.000x001`, `F31.500x001`, `F31.900x001`, `E22.100x001` 高泌乳素血症, `G24.900x003` | Same standard, `x`+3-digit national sub-classification (医保版/国临版 convention) |
| TCM alphanumeric | 4 | 10 | `BNX071` 癫病, `BNG110` 郁病, `ZZXP60` 心脾两虚证, `ZYTV10` 痰气互结证 | GB/T 15657 中医病证分类与代码 |
| TCM dotted hierarchical | 4 | 8 | `A04.01.20.01` 癫病, `A05.01` 郁病, `B04.06.01.03.02` 心脾两虚证, `B04.06.02.03.01.02` 肝郁脾虚证 | 中医临床诊疗术语·证候部分 (GB/T 16751.2 family) |
| **NULL** | — | **11** | 心脾两虚证, 痰气互结证, 痰气郁结证, 肝郁脾虚证 | uncoded free-text TCM syndrome |
| **UNCLASSIFIED** | **0** | **0** | — | every code fits a named standard |

**Zero codes fall outside a named standard.** 24 distinct codes across the whole workbook (the 病案首页 diagnosis columns introduce no new ones).

`TCM_TYPE` is the system discriminator, and it is **one-directional**:

```
TCM_TYPE x family
family    ICD10-6char  ICD10-ext  NULL  TCM-alnum  TCM-dotted
1                  17          7     0          3           4
2                   0          0    11          7           4
```

`TCM_TYPE=2` → **never** an ICD-10 code (0/22). `TCM_TYPE=1` → 24/34 ICD-10 but still carries 7 TCM codes. So **`TCM_TYPE=2` is a safe TCM filter; `TCM_TYPE=1` is not a safe Western filter.** Filter on the code regex, not the flag.

The same concept is double-coded across systems — 癫病 = `BNX071` **and** `A04.01.20.01`; 心脾两虚证 = `ZZXP60` **and** `B04.06.01.03.02`. A distinct-code count over-counts distinct conditions.

### 1.2 Provenance leak: whitespace padding identifies the source subsystem

```
DIAGNOSTIC_NAME: raw distinct = 27, after .strip() = 22   (5 phantom concepts)
padding x DIAGNOSTIC_TYPE
padding    1    2    3
leading   11    0   10
none       6   24    5
```

`DIAGNOSTIC_TYPE=2` rows are **never** padded (0/24); types 1 and 3 are padded 21/32. Two different upstream modules write this table — one emits fixed-width `CHAR`, the other `VARCHAR`. Same effect in the drug dictionary: `DRUG_CODE 6750 -> ['制半夏', '半夏 ']`. **Always `.strip()` before grouping any name field**, or 27 names collapse to 22 only after you notice.

Punctuation is also unnormalised: `F31.000` carries 双相情感障碍**，**目前为轻躁狂发作 (fullwidth comma) while `F31.000x001` carries the same text with an **ASCII** comma. Name-based matching across the two code versions fails.

### 1.3 FREQUENCY — full decode table, 30 codes

The vocabulary is local (no ISO/HL7 lineage). Two structural facts drive the decode:

```python
print(((od.FREQUENCY=="ONCE")==(od.LONG_D_NO==0)).sum(), '/', len(od))   # 915 / 915
```

**`FREQUENCY=='ONCE'` ⟺ `LONG_D_NO==0`, exactly 915/915.** `LONG_D_NO` is the 长期/临时医嘱 flag, and ONCE is the temporary-order frequency. Confirmed by duration: ONCE median duration **0.00 d** (max 0.06 d) vs 3.0–19.4 d for every other code.

Two hypotheses I tested and **refuted**:

| Hypothesis | Test | Result |
|---|---|---|
| trailing digit = hour of administration | `START_DATETIME.hour == digit` | **1/45 (2.2%)** — refuted |
| `W<n>` = ISO weekday of first dose | `START_DATETIME.dayofweek+1 == n` | **11/59 (18.6%)** — refuted |

Both failed for the same reason, which is itself a finding: **`START_DATETIME` is the order-entry timestamp, not the first-administration time.** Proof — QN ("every night") orders have an entry-hour profile identical to QD's:

```
QD      n= 82 median_hour=11.0 IQR=(10.0,13.0) entered 22:00-06:00 = 3
QN      n= 33 median_hour=11.0 IQR=(10.0,13.0) entered 22:00-06:00 = 2
ALWAYS  n= 40 median_hour=11.0 IQR=(10.0,13.0) entered 22:00-06:00 = 4
```

No nightly order is entered at night. Entry clusters at ward-round hours for every code.

**Decode table** (evidence column states what each decode rests on):

| Code | n | Decode | Evidence | Conf. |
|---|---|---|---|---|
| `ONCE` | 629 | one-off / stat (临时医嘱) | ⟺`LONG_D_NO=0` 915/915; median duration 0.00 d; 104 of 105 zero-date ENDs | **certain** |
| `QD` | 82 | once daily | Latin standard; duration 11.8 d median | certain |
| `QN` | 33 | at night | Latin standard; 18/33 are 口服 drug orders | certain |
| `BID` | 10 | twice daily | Latin standard | certain |
| `TID` | 4 | three times daily | Latin standard | certain |
| `QOD` | 11 | alternate days | Latin standard; longest median duration 17.9 d | certain |
| `PRN` | 2 | as needed | Latin standard; both `ORDER_TYPE=3` (保护性约束PRN) | certain |
| `ALWAYS` | 40 | continuous standing (持续) | 40/40 `DRUG_FLAG=0`, `MEDICATION_WAY=无`; contents are 普食, 精神病护理, 二级护理, 精神科监护 — nursing states, not dosed events | **certain** |
| `BID4 BID5 BID8 BID1` | 19 | BID + execution-slot ID | 19/19 `DRUG_FLAG=1` **and** `MEDICATION_WAY=口服`; base decodes, suffix does not map to hour | **base certain, suffix unresolved** |
| `TID4` | 4 | TID + slot ID | 4/4 口服 drug orders | base certain |
| `QD9 QD11 QD12 QD15 QD16 QD20` | 18 | QD + slot ID | suffixes ⊂ {9,11,12,15,16,20} ⊂ [0,23] — all valid clock hours, none >23 | base certain, suffix **plausible** hour-slot |
| `ALWAYS1` | 1 | ALWAYS + slot ID | single row, `ORDER_TYPE=2` | base certain |
| `W1D8 W2D8 W3D8 W4D8 W5D8 W6D8` | 49 | **weekly, on weekday n, 08:00 slot** | see below | **high** |
| `W1D W2D W5D` | 9 | weekly scheduling, no slot | 9/9 are therapy sessions (森田疗法, 脑电生物反馈治疗, 耳针, 超声药物透入治疗, 行为观察和治疗) | high |
| `W2D1` | 1 | weekly, weekday 2, slot 1 | single row (测血压) | moderate |

**The W-family decode rests on three computed facts:**

1. **59/59 W-coded orders are non-drug** (`DRUG_FLAG=0`, `MEDICATION_WAY=无`, `ORDER_TYPE∈{2,3}`). This is a *therapy/assessment scheduling* vocabulary, not a dosing vocabulary. Never feed it to a dose calculator.
2. **The decisive test** — 测血压 is ordered as **two rows, `W1D8` + `W4D8`, with byte-identical `START_DATETIME` and `END_DATETIME`**, and this occurs independently in **two subjects (S2 and S3)**. A single therapy at a single moment split across two W-digits means `W<n>` is a *within-week position*, not a count of days.
3. **`W7` never occurs** (`distinct W-digits = [1,2,3,4,5,6]`, n=59) while `W6` occurs once — a six-day therapy week with no Sunday sessions.

The residual unknown is the trailing slot digit (49/59 are `D8`). Resolving it costs one lookup in the hospital's 频次字典 table; nothing in this extract can settle it.

### 1.4 MEDICATION_WAY — a genuinely bilingual preparation vocabulary

15 values (3 more than previously inventoried: `塞肛`, `肌注+注射器5ml`, `退药`, `领药`). It mixes four distinct semantic classes in one column:

| Class | Values | Rows |
|---|---|---|
| TCM preparation method | 煎服 116, 外用 216, 先煎 12, 另包 9, 冲服 1 | 354 |
| Western route | 口服 79, 静滴 12, 塞肛 1, `肌注+注射器5ml` 1 | 93 |
| Workflow / dispensing state | 出院带药 25, 副药 19, 领药 4, 退药 2 | 50 |
| Not-applicable sentinel | 无 314 | 314 |

`先煎` (decoct first), `另包` (package separately), `冲服` (infuse) are *preparation instructions*, not routes. `出院带药`/`退药`/`领药` are *dispensing events*. `肌注+注射器5ml` concatenates a route with a consumable. **This column is three columns wearing a trenchcoat**; splitting it is a prerequisite for any route-based analysis.

### 1.5 DOSAGE_UNIT — g-vs-mg is **not** the herb/Western discriminator

This is a widely-assumed heuristic and it is **false in this data**:

```python
g=dr[dr.DOSAGE_UNIT=='g']
g[g.MEDICATION_WAY.isin(['口服','出院带药','副药','领药'])].DRUG_NAME.unique()
```
```
g rows total: 389
  decoction route (煎服/先煎/另包/冲服): 137
  外用:                                216
  Western tablets dosed in g:           36   <-- the failure
['(益君康)复方嗜酸乳杆菌片','*富马酸替诺福韦二吡呋酯片','便通胶囊','加巴喷丁片','吴茱萸粉(J)',
 '奥卡西平片（万仪）','氯化钾缓释片','碳酸锂缓释片','维生素B6注射液','维生素C注射液']
```

**36 of 389 g-rows (9.3%) are Western drugs** — including 碳酸锂缓释片 (10 rows, the lithium whose TDM is ordered in this very dataset) and 富马酸替诺福韦二吡呋酯片 (6 rows, the tenofovir that anchors the hepatic covariate). A `DOSAGE_UNIT=='g'` herb filter silently swallows both.

The correct discriminator is `MEDICATION_WAY`:

```
herb-route (煎服/先煎/另包/冲服/外用):  354 rows, 76 distinct names, 353 g + 1 ml
non-herb:                              143 rows, 45 distinct names, 81 mg + 36 g + 23 ml + 3 other
```

`UNIT` is **100% redundant with `DOSAGE_UNIT`** (915/915 identical). `AMOUNT` equals `DOSAGE` on all 497 drug rows — there is **no dispensed-quantity field distinct from dose**, so quantity-based adherence analysis is impossible from this schema.

### 1.6 ORDER_TYPE / DRUG_FLAG / ORDER_STATE / LONG_D_NO

Perfect determinations (all 915/915):

```python
(od.DRUG_FLAG==1)==(od.ORDER_TYPE==1)          # 915/915
(od.DRUG_FLAG==1)==(od.DRUG_CODE.notna())      # 915/915
(od.ORDER_TYPE==4)==(od.MEDICATION_WAY=='化验') # 915/915
(od.FREQUENCY=='ONCE')==(od.LONG_D_NO==0)      # 915/915
```

| Field | Value | n | Decode | Evidence |
|---|---|---|---|---|
| `ORDER_TYPE` | 1 | 497 | **drug order** | ⟺`DRUG_FLAG=1` ⟺`DRUG_CODE` present; only type with real dose units (g/mg/ml/支/瓶) and 13 routes |
| | 2 | 268 | **treatment & nursing** | `DOSAGE_UNIT=无`, no `DRUG_CODE`; contents 一般专项护理, 穴位贴敷治疗, SANS/SAPS scales, 普食, 煎药机煎药 |
| | 3 | 20 | **free-text nursing instruction** | 测体重, 保护性约束, 服药到口, 防消极, 转61床, 眼科会诊 — ward instructions incl. transfers/consults |
| | 4 | 104 | **laboratory order** | ⟺`MEDICATION_WAY=化验`, 104/104, exact |
| | 5 | 26 | **imaging / examination order** | 26/26 `LONG_D_NO=0`; contents 常规心电图, 颅内多普勒(TCD), 脑电图, 头颅CT平扫, 心脏彩超 |
| `DRUG_FLAG` | 0/1 | 418/497 | **is-a-drug** | fully redundant with `ORDER_TYPE==1`; carries no independent information |
| `LONG_D_NO` | 0/1 | 629/286 | **临时 / 长期医嘱** | ⟺`FREQUENCY=='ONCE'` 915/915; median duration 0.00 d vs 3.0–19.4 d |
| `ORDER_STATE` | 已停止 913, 已作废 2 | | **stopped / voided** | **no 已执行 or active state exists** — every order is terminal, so this is a post-discharge snapshot with zero state variance. Useless as a covariate; the 2 已作废 rows must be excluded from exposure |

`DRUG_FLAG` and `LONG_D_NO` are both fully derivable — 2 of 22 order columns carry zero independent information, alongside `UNIT` (= `DOSAGE_UNIT`) and `AMOUNT` (= `DOSAGE` where it matters). **4 of 22 columns are redundant.**

### 1.7 Drug vocabulary — `DRUG_CODE` is a package SKU, not a drug identifier

```
drug rows 497 | distinct DRUG_CODE 130 | distinct DRUG_NAME 120
19 DRUG_NAMEs map to >1 DRUG_CODE;  9 DRUG_CODEs map to >1 DRUG_NAME
```

Every one of the 19 name→multi-code cases differs **only by pack size**:

```
阿立哌唑口崩片(国产) -> [11757, 12310]  specs: ['5mg*1片', '5mg*20片']
*氯氮平片          -> [16205, 16367]  specs: ['25mg*1', '25mg*100片']
碳酸锂缓释片        -> [14127, 15323]  specs: ['0.3g*1', '0.3g*100片']
```

The `*1片` code is the ward unit-dose; the `*20片`/`*100片` code is the discharge take-home pack. `DRUG_CODE` is a **物价/库存项目码 (item-price/inventory code)**, so a distinct-`DRUG_CODE` count over-counts drugs by ~8%.

**The harder problem — brand/generic aliasing.** The same ingredient appears under multiple names, and grouping by *either* name *or* code fails:

| Ingredient | Names in file | Distinct `DRUG_CODE` |
|---|---|---|
| aripiprazole | 阿立哌唑口崩片(国产), 阿立哌唑片(安律凡), **博思清** | **4** |
| escitalopram | *草酸艾司西酞普兰片(国产), **来士普** | 2 |
| sertraline | *盐酸舍曲林片, 舍曲林片((左洛复片)) | 3 |
| valproate | 丙戊酸钠缓释片(德巴金）, 德巴金片 | 2 |
| **trihexyphenidyl** | 苯海索片, **安坦片** | 2 |
| ligustrazine | 川芎嗪针（川青）, 川青 | 1 |

Two consequences with teeth:

- **博思清 is aripiprazole.** A `DRUG_NAME.str.contains('阿立哌唑')` exposure filter — the obvious one — **drops S5 entirely**, who is on 博思清 10 mg and has an aripiprazole TDM result.
- **安坦片 is trihexyphenidyl.** Filtering on `苯海索片` alone finds 3 subjects; the ingredient-mapped filter finds **4/5** — a 33% understatement of the standard EPS surrogate.

The `*` name prefix marks 6 names (23 rows), all Western prescription drugs (*奥氮平片, *氯氮平片, *富马酸喹硫平片, *盐酸舍曲林片, *草酸艾司西酞普兰片, *富马酸替诺福韦二吡呋酯片), zero herbs. Consistent with a formulary/reimbursement marker; the extract carries no dictionary to confirm which.

### 1.8 Lab vocabulary

`PROJECT_CODE` is a **4-character zero-padded local code**, 7 values, strictly 1:1 with `PROJECT_NAME` in both directions. It carries the **same leading-zero hazard as `PATIENT_ID`** — and it lands precisely on the two analytes the science depends on:

```
values: ['0448','0449','2008','3018','4236','4241','8001']
storage types: str=12, int=10       # '0448','0449' str; 2008,3018,4236,4241,8001 int
```

`0448` = 总阿立哌唑, `0449` = 脱氢阿立哌唑. Casting `PROJECT_CODE` to int turns these into `448`/`449` and detaches the total and the active metabolite from any lab dictionary.

**The metabolite has no reference range.** `REFFR_SCOPE` is null in **6/6** 脱氢阿立哌唑 rows while all 16 other rows parse as `lo-hi`. The lab measures the active metabolite, reports it, and declines to interpret it — which is exactly why the metabolite/parent ratio is unexploited clinically and available as research signal.

There is **no result-unit column at all** (`RESULT_UNIT` absent). ng/mL is inferable only from the magnitude of `REFFR_SCOPE`.

`TEST_PURPOSE` is a `+`-delimited analyte request list (`阿立哌唑+氯硝西泮+帕利哌酮（帕潘立酮）+氯氮平`) — a fourth delimiter convention in the workbook, after `|`, `/` (blood pressure) and `*` (drug spec).

### 1.9 Mapping onto international standards

| Field | Target | Coverage in this file | Mapping cost |
|---|---|---|---|
| `DIAGNOSIS_CODE` ICD-10 CN 6-char (11 codes) | **ICD-10 → SNOMED CT** | truncate to 3–4 char for ICD-10 WHO; national ext is a superset | **Low.** Deterministic prefix truncation; WHO↔SNOMED maps exist. Lossy on the 6th char (clinical detail) |
| `DIAGNOSIS_CODE` ICD-10 CN ext `xNNN` (5) | ICD-10 → SNOMED CT | strip `x\d{3}` → base 6-char code | **Low.** But `F31.000` and `F31.000x001` are the *same concept* under two codes — dedupe before counting |
| `DIAGNOSIS_CODE` TCM (8 codes, 18 rows) + 11 uncoded syndromes | **SNOMED CT TCM extension / ICD-11 Ch.26** | 心脾两虚证, 肝郁脾虚证, 痰气互结证, 癫病, 郁病 | **High.** No public GB/T 15657→SNOMED crosswalk; ICD-11 Chapter 26 covers TCM patterns but mapping is manual, expert-adjudicated. ~19 concepts here → weeks per 1000 at scale |
| `DRUG_NAME`/`DRUG_CODE` Western (45 names, 59 codes) | **RxNorm + ATC** | aripiprazole→N05AX12, clozapine→N05AH02, valproate→N03AG01, trihexyphenidyl→N04AA01, tenofovir→J05AF07 | **Medium.** Requires an explicit ingredient table first (§1.7): 6 alias families in 45 names = **13% alias rate**. RxNorm has poor Chinese trade-name coverage — 博思清/安坦片/来士普/芮达 need manual resolution |
| `DRUG_NAME` herbs (76 names) | **RxNorm / ATC** | 石菖蒲, 珍珠母, 制远志, 夜交藤… | **Not mappable.** RxNorm and ATC have no single-herb granularity. Only SNOMED CT (limited) or a Chinese Pharmacopoeia (中国药典) code set applies. Treat as a separate namespace |
| `DRUG_SPEC` (52 distinct) | **UCUM** | grammar parses: `<strength><unit>*<count><packunit>` covers 136/497; `1g`/`*1g` herb forms are the rest | **Low–medium.** 4 regex families cover the file; `支`/`瓶`/`袋`/`片`/`粒` are pack units needing a UCUM `{tablet}`-style annotation |
| `DOSAGE_UNIT` (6 values) | **UCUM** | g→`g`, mg→`mg`, ml→`mL`; 支/瓶→annotations; 无→null | **Trivial**, 6 values |
| `PROJECT_CODE`/`PROJECT_NAME` (7 analytes) | **LOINC** | aripiprazole, dehydro-aripiprazole, olanzapine, clozapine, clonazepam, paliperidone (serum mass concentration) | **Low.** LOINC has TDM codes for most of these; **dehydro-aripiprazole is the risky one** — confirm a LOINC part exists or request a new one. 7 codes = hours of work |
| `SIGN_TYPE` (7 values) | **LOINC + UCUM** | 体温→8310-5, 脉搏→8867-4, 呼吸→9279-1, 血压→85354-9 (panel), 体重→29463-7, 身高→8302-2, 血氧饱和度→59408-5 | **Trivial for codes**, but `RECORD_UNIT` is **0/537 populated** — units must be *asserted* from `SIGN_TYPE`, and 血压 must be split into 8480-6/8462-4 first |
| `ORDER_CONTENT` type 2/3 (107 distinct) | **SNOMED CT procedures** | 穴位贴敷治疗, 脑电生物反馈治疗, 森田疗法, 耳针, 拔罐疗法 | **High.** Half are TCM procedures with weak SNOMED coverage; the psychiatric scales (SANS/SAPS/社会功能评定量表) map better to LOINC survey panels than to SNOMED |
| `ORDER_CONTENT` type 4/5 (36+15) | LOINC / SNOMED / RadLex | 血常规（五分类）, 生化系列（全）, 头颅CT平扫, TCD | **Medium.** Chinese panel names are composite; `生化系列（全）` expands to ~20 LOINC codes |
| `FREQUENCY` (30 codes) | **HL7 v3 GTS / FHIR Timing** | QD/BID/TID/QN/QOD/PRN map directly | **Medium.** 8 Latin codes map free; the **19 slot-suffixed and 59 W-family codes need the hospital 频次字典** — not derivable from the extract (§1.3) |
| `MEDICATION_WAY` (15) | **SNOMED CT route** | 口服→26643006, 静滴→47625008, 塞肛→37161004 | **Medium.** Only 4/15 are true routes; the rest are preparation methods or dispensing states and belong in different FHIR elements (§1.4) |

---

## 2. Internal consistency checks — 22 run, real counts

```python
def chk(name,npass,nfail,note=''): R.append((name,npass,nfail,'PASS' if nfail==0 else 'FAIL',note))
```

| # | Check | Pass | Fail | Verdict |
|---|---|---:|---:|---|
| C1 | 总阿立哌唑 = 阿立哌唑 + 脱氢阿立哌唑 (machine epsilon) | 4 | 2 | **FAIL** → see below |
| C2 | 检验 `APPLY_DATE` ≤ `TEST_DATE` | 22 | 0 | PASS (turnaround 1/3/5 d min/med/max) |
| C3 | `IN_DATE` < `DIS_DATE` | 5 | 0 | PASS |
| C4 | `BIRTHDATE` < `IN_DATE` | 5 | 0 | PASS |
| C5 | `DAY_TOTAL` == floor(`DIS_DATE`) − floor(`IN_DATE`) | 5 | 0 | PASS (all diffs exactly 0) |
| C6 | `AGE` == floor((`IN_DATE`−`BIRTHDATE`)/365.2425) | 5 | 0 | PASS (all diffs exactly 0) |
| C7 | 检验.`AGE` == 病案首页.`AGE` | 22 | 0 | PASS |
| C8 | `MED_REC_DATE` ≥ `DIS_DATE` | 5 | 0 | PASS |
| C9 | 医嘱 `START` ≤ `END` (non-sentinel) | 810 | 0 | PASS (105 excluded: `0/0/0` sentinel) |
| C10 | 医嘱 `START` within [`IN_DATE`, `DIS_DATE`+1d] | 915 | 0 | PASS |
| C10b | 医嘱 `END` ≤ `DIS_DATE`+1d | 810 | 0 | PASS |
| C11 | 体征 `RECORD_DATE` within admission | 537 | 0 | PASS |
| C12 | 检验 `TEST_DATE` within admission | 22 | 0 | PASS |
| C13 | 诊断记录 `RECORD_DATE` within admission | 29 | **27** | **FAIL** — 27 records 1 or 4 days *after* discharge |
| C14 | 体征 血压 parses as SYS/DIA | 52 | **1** | **FAIL** — `'126/7'` |
| C14b | 血压 SBP > DBP | 52 | 0 | PASS |
| C15 | TDM lab order has matching 检验 result | 9 | **17** | **FAIL** → decomposed below |
| C16 | 体征 `RECORD_UNIT` populated | 0 | **537** | **FAIL** — column exists, 100% empty |
| C17 | 病案首页 `AGE_UNIT` populated | 0 | **5** | **FAIL** — `AGE` carries `岁` inline |
| C18 | 诊断记录 `DIAGNOSIS_CODE` populated | 45 | **11** | **FAIL** — all 11 are TCM syndromes |
| C19 | 诊断记录 `PATIENT_ID` populated | 0 | **56** | **FAIL** — 100% null |
| C20 | 医嘱 (`CASE_NO`,`ORDER_NO`,`ORDER_SUB_NO`) unique | 915 | 0 | PASS |

**14 pass / 8 fail.** Three failures need decomposition, because the raw verdict is misleading.

### C1 is a rounding artifact, not a data error

```
 set  parent  metab   sum  total_reported  residual  dp_inputs  dp_total     MR
set1   317.0   55.0 372.0           372.0       0.0          0         0 0.1735
set2    63.0   31.0  94.0            94.0       0.0          0         0 0.4921
set3   400.0  103.0 503.0           503.0       0.0          0         0 0.2575
set4   354.0   79.0 433.0           433.0       0.0          0         0 0.2232
set5    79.9   27.4 107.3           107.0       0.3          1         0 0.3429
set6   100.0   26.6 126.6           127.0      -0.4          1         0 0.2660

identity holds at tol=1e-06: 4/6   |   at tol=0.5: 6/6
```

The residual is non-zero in **exactly** the two sets where parent and metabolite carry one decimal but the total is reported to zero decimals. **This corrects the established fact**: the identity does not hold "exactly" — it holds to ±0.5, i.e. to half of the last reported digit. The total is a *rounded* sum, not an independent measurement. Verdict: **PASS at the instrument's reporting precision.** Any pipeline asserting exact equality will reject 33% of valid samples.

### C13 is discharge-coding lag, and it is systematic

27 diagnosis records are dated 1 day (17 records) or 4 days (10 records) after discharge — the 病案首页 coding pass. A cohort defined by `RECORD_DATE BETWEEN IN_DATE AND DIS_DATE` **loses 48% of all diagnosis rows, and preferentially the discharge diagnoses**, which are the coded, authoritative ones. Extend the window to `DIS_DATE + 7d`.

### C15 decomposes into a panel fan-out (benign) and a filtered extract (critical)

```
result_rows == 3 x draws for every subject: True
```

One `阿立哌唑` lab order returns three analyte rows (parent, metabolite, total) — a clean 1→3 panel expansion, not a mismatch. The real finding is the other side:

```
total lab orders (ORDER_TYPE=4): 104   |   result rows in 检验: 22
  TDM drug-level orders: 27  |  non-TDM lab orders: 77 (28 distinct panels)
  result rows for ANY non-TDM panel: 0
  => 0 of 77 non-TDM lab orders have results in this extract
```

**检验 is not a lab table — it is an analyte-filtered TDM extract.** Ordered and therefore *present in the source LIS*, but absent here: 肝功能常规 (6), 生化系列（全） (7), 肾功能常规 (3), 生殖激素常规 (6, i.e. prolactin), 血常规（五分类） (8), 糖化血红蛋白 (4), 甲状腺功能系列 (3), 电解质常规 (3), 乙肝病毒-DNA (1), 凝血功能+D二聚体 (3).

This is the single most actionable finding for scaling: **hepatic function, renal function, prolactin, glucose and haematology all exist upstream and were simply not requested.** Given the cohort carries `B18.101` chronic hepatitis B + `K72.905` hepatic failure + tenofovir + 天晴甘平, the hepatic covariate that most directly modifies aripiprazole metabolism is one line in the extract spec away.

Separately, **7 of 16 subject×analyte TDM orders have no result at all** (丙戊酸钠 ×2 subjects, 碳酸锂 ×3, 艾司西酞普兰, 帕利哌酮 for S4) — a genuine ordered-but-unresulted gap, distinct from the filtering.

### The three silent corruption traps

**Trap 1 — 诊断记录 has a 100% null `PATIENT_ID`.**

```
医嘱记录 ⋈ 病案首页 on PATIENT_ID+CASE_NO : left=915 matched=915 lost=  0 (  0.0%)
诊断记录 ⋈ 病案首页 on PATIENT_ID+CASE_NO : left= 56 matched=  0 lost= 56 (100.0%)
诊断记录 ⋈ 病案首页 on CASE_NO            : left= 56 matched= 56 lost=  0 (  0.0%)
```

The natural "join every table the same way" pattern returns an **empty diagnosis set with no error**. `CASE_NO` is the only viable key.

**Trap 2 — `PATIENT_ID` is a zero-padded 8-char string, and 2/5 subjects carry leading zeros.**

```
病案首页 S1 types=['str'] leading_zero=True | S3 types=['int'] leading_zero=False
=> hypothesis: str-stored IDs are exactly the leading-zero ones: True
S1: str->int cast changes length 8 -> 6  (JOIN BREAKS)
S2: str->int cast changes length 8 -> 7  (JOIN BREAKS)
int-stored subject: str(float(x)) appends '.0' -> length 10 vs 8  (JOIN BREAKS)
```

The mixed int/str dtype is *per subject*, so the naive merge accidentally works — until someone normalises the column, at which point **40% of subjects vanish**. `MED_REC_NO` and `PROJECT_CODE` have the identical hazard.

**Trap 3 — pipe-delimited comorbidity lists are sorted under different collations.**

`OTHER_DIAGNOSIS_CODE` and `OTHER_DIAGNOSIS_NAME` are `|`-delimited and equal-length, which makes `zip()` look safe. Validated against 诊断记录, where code and name sit on the **same row**:

```
S4: 6 codes, 6 names, lengths match=True
   zip: B18.101      <-> 迟发性运动障碍       *** WRONG *** (truth: 慢性活动型乙型病毒性肝炎)
   zip: E22.100x001  <-> 肝功能不全          *** WRONG *** (truth: 高泌乳素血症)
   zip: F41.900      <-> 高泌乳素血症         *** WRONG *** (truth: 焦虑障碍)
   zip: G24.901      <-> 焦虑障碍            *** WRONG *** (truth: 迟发性运动障碍)
   zip: H11.300      <-> 慢性活动型乙型病毒性肝炎 *** WRONG *** (truth: 右眼 结膜出血)
   zip: K72.905      <-> 右眼 结膜出血        *** WRONG *** (truth: 肝功能不全)

Positional zip accuracy: 3/9 correct
codes sorted asc=True | names sorted asc(unicode)=False
```

**6/6 wrong for the only subject with more than one comorbidity.** The 3 "correct" pairs are single-element lists, where zip cannot fail. Codes are sorted ascending by code; names are sorted by a different (GBK/pinyin) collation, so the orders diverge whenever k>1 — i.e. **precisely on the multimorbid patients**, who are the ones a comorbidity analysis is about. Never zip these fields; use 诊断记录.

### Minor defects

- `'126/7'` — a blood pressure with DBP=7. Caught by the format check; **passed by the SBP>DBP check** (126>7), so range-plausibility alone is insufficient.
- 体征 contains **one exact duplicate measurement pair** (S5, 体重 54 kg, same timestamp, two distinct `RECORD_ID`s) — 1 pair in 537 rows (0.19%), a double-save.
- 体征 has a stray `Unnamed: 9` column with **5 populated cells, every one of them a `CASE_NO` value** — a spreadsheet spillover carrying identifiers outside their declared column. Drop it, and flag it to whoever writes the export.
- 诊断记录 contains a same-code re-entry 2 minutes apart with `IS_PRIMARY` flipped 1→0 — a correction, not a duplicate. This is why `RECORD_DATE` belongs in the primary key.
- `FEE_TOTAL` carries 3 decimal places (`29185.157`) on a currency amount.

---

## 3. Grain and key structure

```python
def grain(nm,df,cands):
    for k in cands:
        d=df.astype(str).duplicated(subset=k).sum()
        print(f'{nm} key {k} dups={d} {"UNIQUE" if d==0 else ""}')
```

| Table | Rows | Grain | True primary key | Notes |
|---|---:|---|---|---|
| 病案首页 | 5 | one **admission** | `CASE_NO` | `ID`, `PATIENT_ID`, `MED_REC_NO`, (`PATIENT_ID`,`CURRENT_TIMES`) are all unique **here only because the sample is 1 admission per patient**. At scale `PATIENT_ID` is *not* unique — `CURRENT_TIMES` runs 1–19, so patients recur. **Use `CASE_NO`.** |
| 医嘱记录 | 915 | one **order line** | `DOCTOR_ORDER_ID` (`ORDER_NO` also unique) | (`CASE_NO`,`ORDER_NO`,`ORDER_SUB_NO`) also unique. `ORDER_SUB_NO` has 554 distinct values across 915 rows → sub-numbering groups composite orders (a decoction and its 副药/另包 components) |
| 检验 | 22 | one **analyte result** | (`SAMPLENO`,`PROJECT_CODE`) | `SAMPLENO` alone is **not** a key (16 dups): 6 draws → 3,3,3,3,4,6 analyte rows. Two grains stacked: sample-level and analyte-level |
| 诊断记录 | 56 | one **diagnosis assertion at a coding event** | (`CASE_NO`,`RECORD_DATE`,`DIAGNOSTIC_TYPE`,`DIAGNOSTIC_NAME`) | `DIAGNOSTIC_RECORD_ID` unique but opaque. (`CASE_NO`,`DIAGNOSIS_CODE`) has **24 dups** — the same diagnosis is restated under types 1/2/3. `RECORD_DATE` is required to separate the re-entry correction |
| 体征 | 537 | one **vital measurement** | `RECORD_ID` | (`CASE_NO`,`RECORD_DATE`,`SIGN_TYPE`) has 1 dup (the double-save). 126 distinct timestamps × 7 sign types |

### Join paths, with measured reachability

| Join | Key | Reachability | Verdict |
|---|---|---:|---|
| 医嘱记录 → 病案首页 | `PATIENT_ID` or `CASE_NO` | **915/915 = 100%** | **safe** (with string keys) |
| 检验 → 病案首页 | `PATIENT_ID` or `CASE_NO` | **22/22 = 100%** | **safe** |
| 体征 → 病案首页 | `PATIENT_ID` or `CASE_NO` | **537/537 = 100%** | **safe** |
| 诊断记录 → 病案首页 | **`CASE_NO`** | **56/56 = 100%** | **safe — `CASE_NO` only** |
| 诊断记录 → 病案首页 | `PATIENT_ID` | **0/56 = 0%** | **SILENT TOTAL LOSS** |
| 检验 → 医嘱记录 (result→order) | `CASE_NO` + analyte name↔`ORDER_CONTENT` | 9/16 subject×analyte pairs | **lossy by construction** — string matching on a free-text field, and 7 orders have no result |
| 医嘱记录 → 检验 (dose at draw) | `CASE_NO` + interval overlap on `START`/`END` | **5/6 draws** | **lossy** — S2 has a result with no in-stay order |

**Universal rule: `CASE_NO` is the only key present and populated in all five tables.** Standardise on it; treat `PATIENT_ID` as a subject-level attribute for repeat-admission linkage only, and always as a string.

---

## 4. What the structure supports at scale

Two facts must gate every projection below, because both are computed and both are severe.

**Steady state.** Aripiprazole parent t½ ≈ 75 h, so 5 half-lives ≈ 15.6 d.

```
 S       draw  days_since_first_ari  days_since_current_order_row  steady_state_5half
S3 2021-01-04                   9.0                           9.0               False
S4 2021-01-04                  27.0                          17.0                True
S4 2020-12-21                  13.0                           3.0               False
S1 2021-03-01                   0.0                           0.0               False
S5 2021-03-19                  10.0                           9.0               False
S2 2020-12-30                   NaN                           NaN               False
draws meeting 5 x t1/2: 1/6
```

**Only 1 of 6 draws is at steady state**, and this is *invisible* without joining 医嘱 to 检验 — the lab result carries no exposure history. Note also that `days_since_current_order_row` **understates** exposure: S4's order was re-issued on 2020-12-17 at the same 20 mg already running since 2020-12-10, so order re-issue manufactures a false dose-change boundary. Merge contiguous same-dose orders before computing time-on-dose.

**Linkability and dose ambiguity.**
- **S2 has an aripiprazole concentration (63 ng/mL) and zero aripiprazole orders** — 0 rows matching any of the 3 trade names. With `CURRENT_TIMES=19`, this is almost certainly pre-admission medication, invisible to an inpatient-only extract. 1/6 draws unlinkable.
- **S5 has two concurrent aripiprazole orders** (博思清 QD16 10 mg and 阿立哌唑口崩片 QD 10 mg) overlapping for 8 days. Summing gives TDD=20 mg → C/D_total = 6.35, the lowest of six; at 10 mg it would be 12.70, mid-range. This is a detectable un-stopped duplicate, and it is only detectable because the ingredient map unified two trade names.

```
usable for a clean steady-state C/D analysis: 1/6 = 16.7%
=> to obtain N clean observations, pull ~6x N draws
```

**Dispersion, computed from this extract**, which is what powers the sample-size column:

```python
MR=np.array([0.223164,0.257500,0.173502,0.342929,0.266000,0.492063])
cv=MR.std(ddof=1)/MR.mean()          # 38.5%
sd_log=np.sqrt(np.log(1+cv**2))      # 0.3713
z=1.959964+0.8416212                 # alpha=0.05 two-sided, power=0.80
n=2*(z**2)*(sd_log**2)/(np.log(ratio)**2)
```
```
MR n=6 mean=0.2925 sd=0.1125 CV=38.5%  fold-spread 2.84x
detect a 20% MR difference: n/group =  66   (total 132)
detect a 30% MR difference: n/group =  32   (total  64)
detect a 50% MR difference: n/group =  14   (total  28)
```

### Analysis families

| Analysis family | Exact fields consumed | Sample size needed | What a hospital-scale pull of this same schema yields |
|---|---|---|---|
| **Metabolite/parent ratio as CYP2D6 phenotype proxy** | 检验 `PROJECT_CODE` 3018/0449, `TEST_RESULT`, `SAMPLENO`, `TEST_DATE` | **n=32/group** for a 30% MR difference; **n=100** for ±7.5% precision on geometric-mean MR; **n≈1000** to expect ≥10 PMs at 1% Han-Chinese prevalence | Self-contained in 检验 — needs **no** order linkage, so it survives the 83% linkability ceiling. **The highest-yield design in this schema.** Runs on the analyte-filtered extract exactly as delivered |
| **Concentration/dose (C/D) ratio modelling** | + 医嘱 `DRUG_NAME`(ingredient-mapped), `DOSAGE`, `FREQUENCY`, `START/END_DATETIME`, `MEDICATION_WAY='口服'` | 10–15 obs per covariate → **n=50–75** for 5 covariates; inflate **×6** for the steady-state/linkability filter → **~300–450 raw draws** | Requires the ingredient map (§1.7) and the frequency multiplier table (§1.3). ONCE/出院带药 rows must be excluded as non-maintenance. Duplicate-order detection is mandatory (S5) |
| **Population PK (sparse, NONMEM/nlmixr)** | + 体征 `体重`/`身高`, 病案首页 `AGE`,`SEX` | conventionally **≥50 subjects / ≥100 concentrations** for CL/F with 1–2 covariates | 体重 available for **5/5 subjects** within 1–4 d of every draw (n=3–7 weights each). **Blocker: `TEST_DATE` has no clock time** (`contains(':') == False`) — trough status is unverifiable, so only steady-state trough-*assumed* models are defensible |
| **Hepatic impairment × aripiprazole exposure** | + 诊断 `DIAGNOSIS_CODE` B18.101/K72.905 (via `CASE_NO`), 医嘱 tenofovir/天晴甘平, **+ 肝功能常规 results** | **n=32/group** at 30% effect; hepatic-impairment prevalence drives the pull size | **Requires re-specifying the extract**: 肝功能常规 was ordered 6× and 生化系列（全） 7× but 0 results are present (§C15). One line in the extract spec unlocks the covariate that most directly modifies this drug's metabolism |
| **Hyperprolactinaemia / metabolic adverse effects** | + 生殖激素常规, 糖化血红蛋白, 血脂; 诊断 E22.100x001 | **n=200** for a 5%-prevalence outcome | Same fix: 生殖激素常规 ordered 6×, 糖化血红蛋白 4× — results exist upstream, absent here. `E22.100x001` 高泌乳素血症 already present as a coded outcome |
| **EPS / anticholinergic burden** | 医嘱 ingredient-mapped 苯海索+安坦, `DIAGNOSIS_CODE` G24.901/G24.900x003 | **n=50** at 20% prevalence | **4/5 subjects** carry an anticholinergic — but only with the alias map; name-matching finds 3/5. Both dyskinesia codes already present. Highest-density signal per row in the file |
| **TCM co-prescription × Western drug interaction** | 医嘱 `MEDICATION_WAY∈{煎服,先煎,另包,冲服}`, `DRUG_NAME` (76 herbs), `DOSAGE` g | **n=32/group** per herb at 30% effect; herb prevalence is the binding constraint | **354 herb-route rows, 76 distinct herbs in 5 subjects.** Unique to this schema — no Western TDM dataset carries it. Requires the `MEDICATION_WAY` discriminator, not `DOSAGE_UNIT` (§1.5). Individual herbs will be rare; needs formula-level or category-level grouping |
| **TCM syndrome (证候) × drug response** | 诊断 `TCM_TYPE=2` rows, `DIAGNOSTIC_NAME` | **n=50** per syndrome at 20% prevalence | 22 TCM-typed rows in 5 subjects. **11/22 have no code at all** — syndrome must be matched on stripped text until the 证候 dictionary is added to the extract |
| **Longitudinal vitals / safety monitoring** | 体征 all 7 `SIGN_TYPE`, `RECORD_DATE` | **n=30–45** for 3 covariates | **4.23 vital rows per admission-day**, 107 per admission. Densest table by far. Requires 血压 split and unit assertion (`RECORD_UNIT` 0/537) |
| **Readmission / trajectory** | 病案首页 `PATIENT_ID`+`CURRENT_TIMES`, `IN/DIS_DATE`, `DAY_TOTAL` | **n=200+** for readmission modelling | `CURRENT_TIMES` runs 1–19 here — the source system retains full admission history. **The one analysis where `PATIENT_ID` (string!) is the required key.** This extract is 1 admission/patient; a scale pull is not |

### Volume projection

Measured per-subject yield, which is what scales:

```
     医嘱   体征  检验  诊断  LOS_d  TDM_draws
S1  102   67   4  10     17          1
S2  229  134   6  10     28          1
S3  154   70   3   9     18          1
S4  255  189   6  17     49          2
S5  175   77   3  10     15          1
mean: 医嘱 183.0, 体征 107.4, 检验 4.4, 诊断 11.2, LOS 25.4 d, draws 1.2
per admission-day: 医嘱 7.2, 体征 4.23
```

Per **1,000 admissions carrying an aripiprazole TDM order**, the same schema yields ≈ **183,000 order rows, 107,000 vital rows, 11,200 diagnosis rows, and ~1,200 TDM draws → ~3,600 aripiprazole analyte rows**. After the measured filters — 83% order-linkable, 17% steady-state — that is **≈200 clean steady-state C/D observations**, comfortably powering the C/D and MR designs above and approaching the ~1,000 needed to characterise a 1%-prevalence poor-metaboliser subgroup.

### The extract spec this audit implies

Six changes, all cheap, that convert the schema from analysable-with-effort to analysable-as-delivered:

1. **Populate `诊断记录.PATIENT_ID`** (or document `CASE_NO` as the sole key).
2. **Emit dates as ISO-8601** — removes 51.4% ambiguity and the `0/0/0` sentinel at once.
3. **Add a clock time to `检验.TEST_DATE`** — without it, no trough can ever be verified and popPK is capped.
4. **Drop the non-TDM analyte filter** — 肝功能, 肾功能, 生殖激素, 血常规, 糖化血红蛋白 already exist upstream (77 orders, 0 results) and carry the decisive covariates.
5. **Ship the two dictionaries**: the drug ingredient/ATC map (13% alias rate) and the 频次字典 (the only unresolved decode in §1.3).
6. **Normalise the pipe-delimited diagnosis fields into rows**, or drop them — positional zip is wrong on every multimorbid patient.

---

**Scripts:** `/tmp/tdm/{load,keys,join,idform,diag,diag2,dates,enddt,enddt2,orders,otype,freq,freq2,wcodes,drugs,drugs2,lab,signs,pipe,checks,refine,pk,final,dups,mapcost,power}.py`