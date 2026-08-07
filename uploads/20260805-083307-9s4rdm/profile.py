"""Profile the TDM sample extract without printing direct identifiers.

Patients are re-labelled P1..Pn in stable order; PATIENT_ID, CASE_NO, MED_REC_NO
and BIRTHDATE are never emitted. Everything else is reported as it is, because
the point of the profile is to say what this dataset can and cannot support.
"""
import sys
from collections import Counter, defaultdict

import openpyxl

PATH = "uploads/20260805-083307-9s4rdm/20260803TDM.xlsx"
DIRECT_IDENTIFIERS = {"PATIENT_ID", "CASE_NO", "MED_REC_NO", "BIRTHDATE", "ID", "DOCTOR_ORDER_ID",
                      "RECORD_ID", "DIAGNOSTIC_RECORD_ID", "SAMPLENO"}


def load():
    wb = openpyxl.load_workbook(PATH, read_only=True, data_only=True)
    sheets = {}
    for ws in wb.worksheets:
        rows = ws.iter_rows(values_only=True)
        header = [str(h) if h is not None else "" for h in next(rows)]
        sheets[ws.title] = [dict(zip(header, r)) for r in rows if any(v is not None for v in r)]
    return sheets


def main():
    sheets = load()
    front = sheets["病案首页"]
    order = {row["PATIENT_ID"]: f"P{i + 1}" for i, row in enumerate(front)}

    print("=" * 78)
    print("1. 队列构成（病案首页）")
    for row in front:
        label = order[row["PATIENT_ID"]]
        print(f"  {label} | {row['SEX']} | {row['AGE']}{row['AGE_UNIT']} | 入院 {row['IN_DATE']} 出院 {row['DIS_DATE']} "
              f"| 住院 {row['DAY_TOTAL']} 天 | 科室 {row['ADM_DEPT_NAME']}→{row['DIS_DEPT_NAME']}")
        print(f"       主诊断 {row['MAIN_DIAGNOSIS_CODE']} {row['MAIN_DIAGNOSIS_NAME']}")
        other = str(row.get("OTHER_DIAGNOSIS_NAME") or "")
        print(f"       其他诊断 {other[:150]}")
        print(f"       离院方式 {row['DIS_WAY']} | 转归 {row['DIS_RESULT']} | 药物过敏 {row['DRUG_ALLERGY_MARK']} "
              f"{row.get('DRUG_ALLERGENS_NAME') or ''} | 费用 {row['FEE_TOTAL']}")

    print("=" * 78)
    print("2. 检验（TDM 相关）")
    for row in sheets["检验"]:
        print(f"  {order.get(row['PATIENT_ID'], '?')} | {row['TEST_DATE']} | {row['PROJECT_NAME']} "
              f"= {row['TEST_RESULT']} | 参考 {row['REFFR_SCOPE']} | 目的 {row['TEST_PURPOSE']} | 科室 {row['DEPT_NAME']}")

    print("=" * 78)
    print("3. 医嘱：药品种类与频次")
    orders = sheets["医嘱记录"]
    print(f"  医嘱总行数 {len(orders)}")
    print("  ORDER_TYPE:", dict(Counter(str(r["ORDER_TYPE"]) for r in orders)))
    print("  DRUG_FLAG:", dict(Counter(str(r["DRUG_FLAG"]) for r in orders)))
    drugs = Counter(str(r["DRUG_NAME"]) for r in orders if r.get("DRUG_NAME"))
    print(f"  去重药品数 {len(drugs)}；出现次数前 25：")
    for name, n in drugs.most_common(25):
        print(f"    {n:4d}  {name}")

    print("=" * 78)
    print("4. 每名患者的用药条目数与给药途径")
    per = defaultdict(Counter)
    ways = Counter()
    for r in orders:
        if r.get("DRUG_NAME"):
            per[order.get(r["PATIENT_ID"], "?")][str(r["DRUG_NAME"])] += 1
            ways[str(r.get("MEDICATION_WAY"))] += 1
    for label in sorted(per, key=lambda x: int(x[1:]) if x[1:].isdigit() else 99):
        print(f"  {label}: 医嘱行 {sum(per[label].values())}，去重药品 {len(per[label])}")
    print("  给药途径:", dict(ways.most_common(12)))

    print("=" * 78)
    print("5. 诊断记录")
    diag = sheets["诊断记录"]
    print("  DIAGNOSTIC_TYPE:", dict(Counter(str(r["DIAGNOSTIC_TYPE"]) for r in diag)))
    print("  中医类型:", dict(Counter(str(r.get("TCM_TYPE")) for r in diag)))
    names = Counter(str(r["DIAGNOSTIC_NAME"]) for r in diag)
    for name, n in names.most_common(30):
        print(f"    {n:3d}  {name}")

    print("=" * 78)
    print("6. 体征")
    signs = sheets["体征"]
    types = Counter(str(r["SIGN_TYPE"]) for r in signs)
    print("  SIGN_TYPE:", dict(types))
    per_pt = Counter(order.get(r["PATIENT_ID"], "?") for r in signs)
    print("  每人记录数:", dict(per_pt))


if __name__ == "__main__":
    sys.exit(main())
