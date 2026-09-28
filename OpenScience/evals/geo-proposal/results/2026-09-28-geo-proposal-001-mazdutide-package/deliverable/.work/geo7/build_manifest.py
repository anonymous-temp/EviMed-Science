import hashlib, json, os

ROOT = "/workspace/deliverables/proposal-package"
FILES = os.path.join(ROOT, "files")
D = json.load(open(os.path.join(ROOT, "dataset.json"), encoding="utf-8"))


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


KIND = {
    "01_GEO投入优化全案.xlsx": ("xlsx", "客户版工作簿，15 页：总表、现状实测、逐引擎预期、语义问句与缺口、三档目标、增量与投放、产品竞品档案、问句与语义群、监测计划、指标定义、假设与未做、信源表、证据与主张库、证据空白与未核实、数据与来源"),
    "02_GEO可行性评估报告.docx": ("docx", "客户版报告一：语义问句评估诊断与可行性（能不能做、主战场在哪、承诺与不承诺）"),
    "03_GEO策略与执行方案.docx": ("docx", "客户版报告二：投入优化全案及实施方案（四池策略、信源、内容、投放、监测与验收）"),
    "04_GEO投入优化提案.pptx": ("pptx", "客户版演示稿（PowerPoint，17 页，16:9）"),
    "05_GEO投入优化提案.html": ("html", "客户版演示稿（自包含 HTML，同一套数字，浏览器直接放映）"),
}

files = []
for name, (kind, role) in KIND.items():
    path = os.path.join(FILES, name)
    files.append({"path": f"files/{name}", "kind": kind, "role": role,
                  "sha256": sha256(path), "bytes": os.path.getsize(path)})

ds_path = os.path.join(ROOT, "dataset.json")
files.append({"path": "dataset.json", "kind": "json",
              "role": "包内唯一数据源：所有文件里的重复数字都取自这里（本轮一次性读取的项目数据）",
              "sha256": sha256(ds_path), "bytes": os.path.getsize(ds_path)})

manifest = {
    "mode": "proposal",
    "product": f'{D["product"]["brandName"]}（通用名：{D["product"]["genericName"]}）',
    "dataset": {
        "frozenAt": D["frozenAt"],
        "rounds": ["gr_fd37ae22560ccf0bb6899426ec1c0828（基线 2026-09-25）",
                   "gr_0bcf3b9a8529572439815a900cac7cc7（补充轮次，2026-09-28，样本不足，不进基线读数）"],
        "snapshotCount": None,
        "note": "快照总数未逐条枚举；基线轮次的有效回答数为 351（计划 440）。",
    },
    "files": files,
}

with open(os.path.join(ROOT, "proposal-package.json"), "w", encoding="utf-8") as fh:
    json.dump(manifest, fh, ensure_ascii=False, indent=1)
print(json.dumps({"files": len(files), "bytes": sum(f["bytes"] for f in files)}, ensure_ascii=False))
