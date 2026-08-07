"""Field-level capability profile of the TDM sample extract.

The sample is five patients, so its values prove nothing. What it does show is
the schema: which fields exist, how they are populated, what vocabulary they
carry, and therefore what a full extract of the same shape could and could not
support. That is what this profiles — every column, not every patient.
"""
import re
from collections import Counter, defaultdict

import openpyxl

PATH = "uploads/20260805-083307-9s4rdm/20260803TDM.xlsx"
# Never printed, even as examples.
DIRECT_IDENTIFIERS = {
    "PATIENT_ID", "CASE_NO", "MED_REC_NO", "BIRTHDATE", "ID", "DOCTOR_ORDER_ID",
    "RECORD_ID", "DIAGNOSTIC_RECORD_ID", "SAMPLENO", "ORDER_NO", "ORDER_SUB_NO", "LONG_D_NO",
}


def load():
    wb = openpyxl.load_workbook(PATH, read_only=True, data_only=True)
    out = {}
    for ws in wb.worksheets:
        rows = ws.iter_rows(values_only=True)
        header = [str(h) if h is not None else "" for h in next(rows)]
        out[ws.title] = (header, [r for r in rows if any(v is not None for v in r)])
    return out


def kind(values):
    """What the column actually holds, judged from its populated values."""
    sample = [v for v in values if v is not None and str(v).strip() != ""]
    if not sample:
        return "空"
    if all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in sample):
        return "数值"
    text = [str(v) for v in sample]
    if all(re.match(r"^\d{1,2}/\d{1,2}/\d{4}", t) for t in text):
        return "日期" if not any(re.search(r"\d:\d\d", t) for t in text) else "日期时间"
    if all(re.fullmatch(r"-?\d+(\.\d+)?", t) for t in text):
        return "数值（文本存储）"
    return "文本"


def main():
    sheets = load()
    print("=" * 92)
    print("字段级剖析：每列的填充率、取值基数、类型与可用性")
    print("=" * 92)

    for name, (header, rows) in sheets.items():
        total = len(rows)
        print(f"\n\n■ {name}　（{total} 行 × {len(header)} 列）")
        print(f"  {'字段':<26}{'填充':>7}{'基数':>7}  {'类型':<14}{'取值/示例'}")
        print("  " + "-" * 88)
        for index, column in enumerate(header):
            if not column:
                continue
            values = [r[index] if index < len(r) else None for r in rows]
            filled = [v for v in values if v is not None and str(v).strip() != ""]
            distinct = {str(v) for v in filled}
            rate = f"{len(filled) / total * 100:.0f}%" if total else "—"
            if column in DIRECT_IDENTIFIERS:
                shown = "（标识符，未显示）"
            elif len(distinct) <= 8:
                shown = " | ".join(sorted(distinct)[:8])[:64]
            else:
                common = Counter(str(v) for v in filled).most_common(3)
                shown = "、".join(f"{v}({n})" for v, n in common)[:64]
            print(f"  {column:<26}{rate:>7}{len(distinct):>7}  {kind(values):<14}{shown}")

    # ---- what the join graph permits -------------------------------------
    print("\n\n" + "=" * 92)
    print("表间关联与可构造的分析单元")
    print("=" * 92)
    front_header, front_rows = sheets["病案首页"]
    pid_index = front_header.index("PATIENT_ID")
    case_index = front_header.index("CASE_NO")
    patients = {r[pid_index] for r in front_rows}
    cases = {r[case_index] for r in front_rows}
    print(f"  病案首页：{len(patients)} 名患者 / {len(cases)} 次住院 → 每次住院一行")
    for name in ("医嘱记录", "检验", "诊断记录", "体征"):
        header, rows = sheets[name]
        pi, ci = header.index("PATIENT_ID"), header.index("CASE_NO")
        linked = sum(1 for r in rows if r[pi] in patients)
        print(f"  {name:<8}：{len(rows):>4} 行，{linked} 行可经 PATIENT_ID 关联到病案首页"
              f"（{len({r[ci] for r in rows})} 个 CASE_NO）")
    print("\n  → 可构造的分析单元：患者 / 住院次 / 医嘱条目 / 检验项目 / 体征时点")
    print("  → 缺失的分析单元：给药执行（无执行记录）、采血时刻（仅到日期）")

    # ---- vocabulary that decides feasibility ------------------------------
    print("\n\n" + "=" * 92)
    print("决定可行性的三类词表")
    print("=" * 92)

    order_header, order_rows = sheets["医嘱记录"]
    def col(header, rows, name):
        i = header.index(name)
        return [r[i] if i < len(r) else None for r in rows]

    print("\n  ① FREQUENCY（给药频次）—— 院内编码，非标准词表")
    for value, n in Counter(str(v) for v in col(order_header, order_rows, "FREQUENCY") if v).most_common():
        print(f"      {n:>4}  {value}")

    print("\n  ② MEDICATION_WAY（给药途径）—— 给药与发药混在同一字段")
    for value, n in Counter(str(v) for v in col(order_header, order_rows, "MEDICATION_WAY") if v).most_common():
        print(f"      {n:>4}  {value}")

    print("\n  ③ 检验项目与参考范围")
    test_header, test_rows = sheets["检验"]
    pairs = defaultdict(set)
    for r in test_rows:
        project = r[test_header.index("PROJECT_NAME")]
        scope = r[test_header.index("REFFR_SCOPE")]
        pairs[str(project)].add(str(scope))
    for project, scopes in sorted(pairs.items()):
        print(f"      {project:<16} 参考范围 {' / '.join(sorted(scopes))}")

    print("\n  ④ 体征类型与记录密度")
    sign_header, sign_rows = sheets["体征"]
    for value, n in Counter(str(v) for v in col(sign_header, sign_rows, "SIGN_TYPE") if v).most_common():
        print(f"      {n:>4}  {value}")


if __name__ == "__main__":
    main()
