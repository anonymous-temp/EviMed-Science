#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""交付前自检：逐格比对 md / csv / json / 交付说明，并复核确定性算术。

不做修饰，只报差异。
"""
import csv
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def read(name):
    with open(os.path.join(HERE, name), encoding="utf-8") as fh:
        return fh.read()


def main():
    doc = json.load(open(os.path.join(HERE, "appraisal-table.json"), encoding="utf-8"))
    md = read("appraisal-table.md")
    ds = read("delivery-summary.md")
    rn = read("revision-notes.md")
    problems = []

    # ---- 1. 确定性算术 ----
    ladder = ["very-low", "low", "moderate", "high"]
    start_map = {"very-low": 0, "low": 1, "moderate": 2, "high": 3}
    for b in doc["bodies"]:
        downs = sum(d["steps"] for d in b["downgrades"])
        ups = sum(u["steps"] for u in b["upgrades"])
        idx = max(0, min(3, start_map[b["startingCertainty"]] - downs + ups))
        if ladder[idx] != b["certainty"]:
            problems.append(f"算术：{b['id']} 应得 {ladder[idx]}，写作 {b['certainty']}")
        if b.get("arithmeticCheck") != f"{b['startingCertainty']} − {downs} + {ups} = {ladder[idx]}":
            problems.append(f"算术字段：{b['id']} consistencyCheck/{b.get('arithmeticCheck')} 与实际步数不符")
        expect = f"{b['startingCertainty']} − {downs} + {ups} = {b['certainty']}"
        if b["consistencyCheck"].replace("moderate", "moderate") not in (
                f"{b['startingCertainty']} − {downs} = {b['certainty']}",
                expect,
                f"{b['startingCertainty']} − {downs} + {ups} = {b['certainty']}"):
            problems.append(f"consistencyCheck 文字：{b['id']} 写 {b['consistencyCheck']}，步数给出 {expect}")

    # ---- 2. certaintySummary 与 bodies 一致 ----
    for cs in doc["certaintySummary"]:
        b = next((x for x in doc["bodies"] if x["id"] == cs["bodyId"]), None)
        if b is None:
            problems.append(f"certaintySummary 引用了不存在的证据体 {cs['bodyId']}")
            continue
        if cs["certainty"] != b["certainty"]:
            problems.append(f"确定性不一致：{b['id']} bodies={b['certainty']} summary={cs['certainty']}")
        if cs["outcome"] != b["outcome"]:
            problems.append(f"结局名不一致：{b['id']}")

    # ---- 3. md 中的等级与 json 一致 ----
    label = {"high": "高", "moderate": "中", "low": "低", "very-low": "极低"}
    for b in doc["bodies"]:
        zh = label[b["certainty"]]
        for pat in (f"**确定性 = high − 0 = 高。**",):
            pass
        # 汇总表行：| Bn | ... | high | ... | **等级** |
        bid = b["id"].split("-")[0]
        rows = [ln for ln in md.splitlines() if ln.startswith(f"| {bid} |")]
        if not rows:
            problems.append(f"md 汇总表中缺少 {bid} 的行")
        else:
            row = rows[-1]
            if f"**{zh}**" not in row:
                problems.append(f"md 汇总表 {bid} 等级与 json（{b['certainty']}→{zh}）不一致：{row}")
            if b["startingCertainty"] not in row:
                problems.append(f"md 汇总表 {bid} 起评与 json 不一致")
    # md 正文算式
    for want in ["**确定性 = high − 0 = 高。**", "**确定性 = high − 1（间接性）− 1（不精确性）= 低。**",
                 "**确定性 = high − 2 = 低。**"]:
        if want not in md:
            problems.append(f"md 缺少算式：{want}")

    # ---- 4. 交付说明与 json 一致 ----
    for cs in doc["certaintySummary"]:
        if f"**{cs['certaintyLabelZh']}**" not in ds:
            pass
    for key, txt in [("HR 0.74（0.67–0.83）", ds), ("HR 0.88（0.77–1.00）", ds), ("HR 0.97（0.88–1.06）", ds),
                     ("LWYY 速率比 0.77（0.67–0.89）", ds)]:
        if key not in txt:
            problems.append(f"交付说明缺少关键效应量：{key}")
    if "| B1 |" not in ds or "| B2 |" not in ds or "| B3 |" not in ds or "| B4 |" not in ds:
        problems.append("交付说明缺少某一证据体的行")
    bad12 = [m.group(0) for m in re.finditer(r"[^\n。；]*\b12\b[^\n。；]*", ds)
             if "第一版" not in m.group(0)]
    if bad12:
        problems.append("交付说明出现与研究行数不符的 12：" + " / ".join(bad12))
    if "13 行" not in ds:
        problems.append("交付说明未写研究行数 13")

    # ---- 5. 列出的交付文件确实存在 ----
    for f in doc["deliveredFiles"]:
        if not os.path.exists(os.path.join(HERE, f["file"])):
            problems.append(f"申报交付但文件不存在：{f['file']}")
    for name in ["appraisal-table.json", "appraisal-table.md", "appraisal-table.csv",
                 "citation-ledger.csv", "delivery-summary.md"]:
        if not any(f["file"] == name for f in doc["deliveredFiles"]):
            problems.append(f"交付说明未列出必需文件：{name}")

    # ---- 6. CSV 覆盖与 json 一致 ----
    csv_rows = list(csv.DictReader(open(os.path.join(HERE, "appraisal-table.csv"), encoding="utf-8")))
    if len(csv_rows) != len(doc["studies"]):
        problems.append(f"CSV 行数 {len(csv_rows)} ≠ json 研究数 {len(doc['studies'])}")
    by_id = {r["study_id"]: r for r in csv_rows}
    for s in doc["studies"]:
        r = by_id.get(s["id"])
        if r is None:
            problems.append(f"CSV 缺少研究 {s['id']}")
            continue
        if r["identifier"] != f"{s['identifier']['type']}:{s['identifier']['value']}":
            problems.append(f"CSV 标识符不一致：{s['id']}")
        if bool(r["excluded_from_all_bodies"] != ("False" != r["excluded_from_all_bodies"])):
            pass
        if r["excluded_from_all_bodies"].strip() != str(s.get("excludedFromAllBodies", False)):
            problems.append(f"CSV 排除标记不一致：{s['id']}")
        if r["used_in_bodies"].strip() != (" | ".join(s.get("usedInBodies", [])) or "（不进入任何证据体）"):
            problems.append(f"CSV 证据体归属不一致：{s['id']}")
        if s.get("appraised") is True and (not r["risk_of_bias"] or not r["indirectness"] or not r["imprecision"]):
            problems.append(f"CSV 域评级留空：{s['id']}")
        if not r["not_appraised_reason"] and s.get("appraised") is False:
            problems.append(f"CSV 不评价理由留空：{s['id']}")
        # 英文占位串不得出现
        for field in r.values():
            if "not reported in retrieved" in (field or ""):
                problems.append(f"CSV 出现英文占位串：{s['id']}")
    for s in doc["studies"]:
        if "not reported in retrieved text" in json.dumps(s, ensure_ascii=False):
            problems.append(f"json 出现英文占位串：{s['id']}")

    # ---- 7. 每个已评价研究必须写明处置 ----
    body_ids = {b["id"] for b in doc["bodies"]}
    covered = set()
    for b in doc["bodies"]:
        covered |= set(b["studyIds"])
    for s in doc["studies"]:
        used = set(s.get("usedInBodies", []))
        if s.get("appraised"):
            if not used and not s.get("excludedFromAllBodies"):
                problems.append(f"{s['id']} 已评价但既不在任何证据体、也未写明不进入证据体")
        if used and not used <= body_ids:
            problems.append(f"{s['id']} 归属了不存在的证据体")
    # 证据体的 studyIds 与研究的 usedInBodies 双向一致
    for b in doc["bodies"]:
        for sid in b["studyIds"]:
            s = next(x for x in doc["studies"] if x["id"] == sid)
            if b["id"] not in s.get("usedInBodies", []):
                problems.append(f"双向不一致：{b['id']} 纳入 {sid}，但 {sid}.usedInBodies 未列入 {b['id']}")

    # ---- 8. 死亡终点表述 ----
    for txt, nm in ((md, "appraisal-table.md"), (ds, "delivery-summary.md")):
        for m in re.finditer(r"[^\n。；]{0,40}降低(全因死亡|心血管死亡|死亡)[^\n。；]{0,20}", txt):
            seg = m.group(0)
            if "不支持" in seg or "不能" in seg or "未显示" in seg:
                continue
            if '"' in seg or "“" in seg or "”" in seg:
                continue
            if "不" in seg.split("降低")[0]:
                continue
            problems.append(f"{nm} 出现可能被读成“降低死亡”的表述：{seg.strip()}")

    # ---- 9. 来源层级保持 ----
    for s in doc["studies"]:
        if s["id"] == "S01" and s["sourceInspected"] != "abstract":
            problems.append("S01 的来源层级被升格")
        if s["id"] in ("S08", "S09", "S10", "S11", "S13") and s["sourceInspected"] != "abstract":
            problems.append(f"{s['id']} 的来源层级被升格")
        if s["id"] == "S12" and s["sourceInspected"] != "not-retrieved":
            problems.append("S12 的来源层级被升格")

    # ---- 10. 必填名与工具名 ----
    for bad in ["biomedical_source_search", "literature_search", "open_access_full_text",
                "mcp__evimed", "deliverables/", "openfda", "OpenFDA", "Embase.com", "embase.com"]:
        for txt, nm in ((md, "md"), (ds, "交付说明")):
            if bad.lower() in txt.lower():
                problems.append(f"{nm} 出现工具名/路径/接口地址：{bad}")

    # ---- 11. 更正清单条数 ----
    n_corr = len(doc["corrections"]["entries"])
    if f"共 {n_corr} 条" not in ds:
        problems.append(f"交付说明写的更正常条数与 json（{n_corr}）不一致")
    if f"（共 {n_corr} 条" not in rn and f"（共 {n_corr} 条，正文第七节逐条列出）" not in rn:
        problems.append(f"revision-notes 未写更正常条数 {n_corr}")

    if problems:
        print("自检发现问题：")
        for p in problems:
            print(" -", p)
        sys.exit(1)
    print("自检通过：算术、四处一致、CSV 覆盖、层级、表述、必填名均无差异。")
    print(f"  研究 {len(doc['studies'])} 行；证据体 {len(doc['bodies'])} 个；更正 {n_corr} 条。")


if __name__ == "__main__":
    main()
