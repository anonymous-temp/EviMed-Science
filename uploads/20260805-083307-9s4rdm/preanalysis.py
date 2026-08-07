"""Pre-analysis supporting the research-direction report.

Computes what a TDM study actually turns on — dose-normalised concentration,
metabolite-to-parent ratio, position against the therapeutic reference range the
laboratory itself printed, and whether the sample could have been drawn at
steady state — so the report's claims are checkable rather than asserted.

Two data properties had to be handled before any of it is meaningful, and both
are findings in their own right:

  * FREQUENCY is a local code, not a standard: BID4, QD11, BID8, TID4. The
    trailing digit is a schedule slot, not a multiplier, so the daily dose is
    the dosage times the base frequency. Reading "10 mg BID4" as 10 mg/day
    understates P1's exposure by half and inflates its C/D ratio accordingly.
  * 410 of 497 drug rows carry FREQUENCY=ONCE, and most are 出院带药 —
    dispensing records, not regimens. Matching a level against them attributes
    a discharge-day supply to the day the blood was drawn.

Patients are P1..P5; no direct identifier is emitted.
"""
import re
from collections import defaultdict
from datetime import datetime

import openpyxl

PATH = "uploads/20260805-083307-9s4rdm/20260803TDM.xlsx"

# Doses per day for the local frequency codes. The trailing digit is a schedule
# slot in this hospital's system, so BID4 is twice daily like BID.
FREQ_PER_DAY = {"QD": 1, "QN": 1, "QM": 1, "BID": 2, "TID": 3, "QID": 4}
# Routes that record a supply rather than an administration schedule.
DISPENSING_WAYS = {"出院带药", "领药", "退药"}

PSYCHOTROPIC = ["阿立哌唑", "奥氮平", "氯氮平", "氯硝西泮", "帕利哌酮", "碳酸锂", "劳拉西泮",
                "喹硫平", "利培酮", "舍曲林", "文拉法辛", "丙戊酸", "度洛西汀", "米氮平", "曲唑酮"]

# Herbal constituents with documented human CYP modulation, which is what makes
# the co-prescription in this dataset a testable exposure rather than noise.
CYP_ACTIVE_HERBS = {
    "五味子": "Schisandra，CYP3A4 抑制（人体研究证据）",
    "甘草": "甘草/甘草酸，CYP3A 调节",
    "陈皮": "柑橘属，CYP3A4 抑制成分",
    "北柴胡": "柴胡皂苷，CYP 调节报道",
    "当归": "CYP 调节报道",
    "香附": "CYP 调节报道",
    "浙贝母": "生物碱，CYP 调节报道",
}


def parse_dt(value):
    if isinstance(value, datetime):
        return value
    text = str(value).strip()
    for fmt in ("%d/%m/%Y %H:%M:%S", "%d/%m/%Y", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(text, fmt)
        except (ValueError, TypeError):
            continue
    match = re.match(r"(\d{1,2}/\d{1,2}/\d{4})", text)
    return datetime.strptime(match.group(1), "%d/%m/%Y") if match else None


def number(value):
    if value is None:
        return None
    match = re.search(r"-?\d+(?:\.\d+)?", str(value))
    return float(match.group(0)) if match else None


def doses_per_day(freq):
    base = re.match(r"([A-Za-z]+)", str(freq or ""))
    return FREQ_PER_DAY.get(base.group(1).upper()) if base else None


def load():
    wb = openpyxl.load_workbook(PATH, read_only=True, data_only=True)
    out = {}
    for ws in wb.worksheets:
        rows = ws.iter_rows(values_only=True)
        header = [str(h) if h is not None else "" for h in next(rows)]
        out[ws.title] = [dict(zip(header, r)) for r in rows if any(v is not None for v in r)]
    return out


def main():
    sheets = load()
    front = sheets["病案首页"]
    label = {row["PATIENT_ID"]: f"P{i + 1}" for i, row in enumerate(front)}
    demog = {label[r["PATIENT_ID"]]: (r["SEX"], r["AGE"], r["MAIN_DIAGNOSIS_NAME"]) for r in front}

    weight = defaultdict(list)
    for row in sheets["体征"]:
        if str(row.get("SIGN_TYPE")) == "体重":
            value = number(row.get("RECORD_CONTENT"))
            if value:
                weight[label.get(row["PATIENT_ID"], "?")].append(value)

    # ---- regimens (administration rows only) -------------------------------
    regimens = defaultdict(list)
    herbs = defaultdict(list)
    formulas = defaultdict(lambda: defaultdict(list))
    for row in sheets["医嘱记录"]:
        name = str(row.get("DRUG_NAME") or "")
        if not name:
            continue
        pid = label.get(row["PATIENT_ID"], "?")
        way = str(row.get("MEDICATION_WAY") or "")
        start, end = parse_dt(row.get("START_DATETIME")), parse_dt(row.get("END_DATETIME"))
        if way in {"煎服", "先煎", "另包", "冲服"}:
            item = {"name": name, "start": start, "end": end, "grams": number(row.get("AMOUNT"))}
            herbs[pid].append(item)
            formulas[pid][str(row.get("ORDER_SUB_NO"))].append(item)
            continue
        if way in DISPENSING_WAYS:
            continue
        base = next((p for p in PSYCHOTROPIC if p in name), None)
        if not base:
            continue
        per_day = doses_per_day(row.get("FREQUENCY"))
        dosage = number(row.get("DOSAGE"))
        regimens[pid].append({
            "drug": base, "name": name, "dosage": dosage, "unit": row.get("DOSAGE_UNIT"),
            "freq": row.get("FREQUENCY"), "per_day": per_day,
            "daily": dosage * per_day if dosage and per_day else None,
            "start": start, "end": end,
        })

    def active(pid, when, drug=None):
        out = []
        for r in regimens[pid]:
            if drug and r["drug"] != drug:
                continue
            if r["start"] and when and r["start"].date() <= when.date() and (not r["end"] or r["end"].date() >= when.date()):
                out.append(r)
        return out

    # ---- levels ------------------------------------------------------------
    levels = defaultdict(dict)
    ranges = {}
    for row in sheets["检验"]:
        pid = label.get(row["PATIENT_ID"], "?")
        analyte = str(row["PROJECT_NAME"])
        when = parse_dt(row["TEST_DATE"])
        levels[(pid, when)][analyte] = number(row["TEST_RESULT"])
        if row.get("REFFR_SCOPE"):
            low, _, high = str(row["REFFR_SCOPE"]).partition("-")
            ranges[analyte] = (number(low), number(high))

    order = sorted(levels, key=lambda k: (k[0], k[1] or datetime.min))

    print("=" * 80)
    print("表 1  每次 TDM 采样的结果与同期暴露")
    outside = inside = 0
    for key in order:
        pid, when = key
        sex, age, dx = demog[pid]
        kg = f"{min(weight[pid]):.0f} kg" if weight[pid] else "体重缺失"
        print(f"\n  {pid}  {'女' if str(sex)=='2' else '男'}/{age}岁/{kg}  {dx}   采样 {when:%Y-%m-%d}")
        for analyte, value in levels[key].items():
            low, high = ranges.get(analyte, (None, None))
            if low is None or value is None:
                print(f"      {analyte:<12} {value:>7.1f}   —（实验室未给参考范围）")
                continue
            if value < low:
                verdict, sign = "低于", "↓"
                outside += 1
            elif value > high:
                verdict, sign = "高于", "↑"
                outside += 1
            else:
                verdict, sign = "范围内", "="
                inside += 1
            print(f"      {analyte:<12} {value:>7.1f}   参考 {low:g}–{high:g}  {sign} {verdict}")
        conc = [f"{r['drug']} {r['dosage']:g}{r['unit'] or ''} {r['freq']}"
                + (f"（{r['daily']:g}mg/日）" if r["daily"] else "（日剂量无法判定）")
                for r in active(pid, when)]
        print(f"      同期精神科方案: {'; '.join(sorted(set(conc))) or '本次采样当日无在用长期医嘱'}")
        active_herbs = sorted({h['name'] for h in herbs[pid]
                               if h['start'] and when and h['start'].date() <= when.date()
                               and (not h['end'] or h['end'].date() >= when.date())})
        flagged = [f"{h}（{CYP_ACTIVE_HERBS[h]}）" for h in active_herbs if h in CYP_ACTIVE_HERBS]
        print(f"      同期中药: {len(active_herbs)} 味" + (f"；其中已知 CYP 相关: {'; '.join(flagged)}" if flagged else "；无已知 CYP 相关药味"))

    print(f"\n  合计：有参考范围的结果 {inside + outside} 项，其中 {outside} 项在范围外（{outside/(inside+outside)*100:.0f}%）")

    print("\n" + "=" * 80)
    print("表 2  阿立哌唑：剂量归一化浓度、代谢比与采样时点")
    print("  C/D = 总阿立哌唑(ng/mL) ÷ 日剂量(mg/日)；MR = 脱氢阿立哌唑 ÷ 阿立哌唑")
    print("  稳态：阿立哌唑 t½ 约 75 h，脱氢代谢物约 94 h，达稳态需约 14 天")
    print(f"  {'患者':<5}{'采样日':<13}{'母药':>7}{'代谢物':>8}{'总浓度':>8}{'日剂量':>9}{'C/D':>8}{'MR':>7}  {'距方案起始':<10}")
    rows_cd = []
    for key in order:
        pid, when = key
        parent, metab, total = (levels[key].get(k) for k in ("阿立哌唑", "脱氢阿立哌唑", "总阿立哌唑"))
        if parent is None:
            continue
        regs = active(pid, when, "阿立哌唑")
        daily = regs[0]["daily"] if regs and regs[0]["daily"] else None
        since = (when.date() - regs[0]["start"].date()).days if regs and regs[0]["start"] else None
        cd = total / daily if total and daily else None
        mr = metab / parent if parent and metab else None
        if cd:
            rows_cd.append((pid, cd))
        print(f"  {pid:<5}{when:%Y-%m-%d}   {parent:>7.1f}{metab if metab else 0:>8.1f}{total if total else 0:>8.1f}"
              f"{daily if daily else 0:>9.1f}{cd if cd else 0:>8.1f}{mr if mr else 0:>7.2f}  "
              f"{f'{since} 天' if since is not None else '无在用医嘱'}")
    if rows_cd:
        values = [c for _, c in rows_cd]
        print(f"\n  C/D 跨度 {min(values):.1f} – {max(values):.1f} ng/mL per mg/日，"
              f"最大/最小 = {max(values)/min(values):.1f} 倍（n={len(values)}）")

    print("\n" + "=" * 80)
    print("表 3  中药暴露构成（按 ORDER_SUB_NO 归为一张方）")
    print("  注：每味药 START=END，为单日发药记录；处方载明药味与克数，未载帖数与疗程，")
    print("      故服药窗口不能由本表直接判定——这是可行性约束，不是缺失值。")
    for pid in sorted(formulas):
        print(f"\n  {pid}: {len(formulas[pid])} 张方")
        for sub, items in sorted(formulas[pid].items(), key=lambda kv: min(i["start"] or datetime.max for i in kv[1])):
            day = min((i["start"] for i in items if i["start"]), default=None)
            names = sorted({i["name"] for i in items})
            flagged = [n for n in names if n.strip() in CYP_ACTIVE_HERBS]
            grams = sum(i["grams"] for i in items if i["grams"])
            print(f"    {day:%Y-%m-%d} 共 {len(names)} 味 / {grams:g} g"
                  + (f"；已知 CYP 相关：{'、'.join(flagged)}" if flagged else "；无已知 CYP 相关药味"))
            print(f"      {'、'.join(names)}")

    print("\n" + "=" * 80)
    print("表 4  可行性约束：本数据集回答不了什么")
    print(f"  患者数 {len(front)}；TDM 采样次数 {len(levels)}；测定项目 {sum(len(v) for v in levels.values())}")
    no_range = sorted({a for v in levels.values() for a in v if a not in ranges})
    print(f"  实验室未提供参考范围的项目：{'、'.join(no_range)}")
    missing_daily = [(p, r["name"], r["freq"]) for p in regimens for r in regimens[p] if r["daily"] is None]
    print(f"  日剂量无法从 FREQUENCY 判定的给药医嘱：{len(missing_daily)} 条")
    print(f"  体重记录：{sum(len(v) for v in weight.values())} 条，覆盖 {len(weight)}/{len(front)} 名患者")
    print("  无基因型（CYP2D6/CYP3A4）、无疗效量表（PANSS/HAMD）、无不良反应结构化记录、无给药与采血精确时刻")


if __name__ == "__main__":
    main()
