#!/usr/bin/env python3
"""Regenerate the synthetic fixtures of the general-task baseline.

Everything here is invented: no real person, company, customer or patient. The generator is deterministic (seeded) so the
committed files can be rebuilt byte-for-byte except where LibreOffice stamps a PDF; the judges read the committed files
and `ground_truth.json`, never this script.

    python3 evals/general-tasks/fixtures/make_fixtures.py [--out DIR]

Needs openpyxl, python-docx, Pillow, numpy and LibreOffice (`soffice`) for the two PDFs.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

import numpy as np
from docx import Document
from docx.enum.text import WD_BREAK
from docx.shared import Pt
from openpyxl import Workbook
from PIL import Image

HERE = Path(__file__).resolve().parent
REGIONS = ["华东", "华北", "华南", "西南", "东北", "西北"]
PRODUCTS = [("办公椅", 480.0), ("升降桌", 1280.0), ("显示器支架", 168.0), ("机械键盘", 299.0), ("降噪耳机", 599.0), ("移动硬盘", 359.0)]


def sales_xlsx(out: Path, truth: dict) -> None:
    rng = np.random.default_rng(20251013)
    wb = Workbook()
    ws = wb.active
    ws.title = "销售明细"
    ws.append(["订单号", "日期", "地区", "产品", "销量", "单价", "销售额"])
    start = dt.date(2025, 1, 1)
    for i in range(5000):
        day = start + dt.timedelta(days=int(rng.integers(0, 365)))
        region = REGIONS[int(rng.choice(len(REGIONS), p=[0.28, 0.22, 0.2, 0.12, 0.1, 0.08]))]
        product, price = PRODUCTS[int(rng.integers(0, len(PRODUCTS)))]
        qty = int(rng.integers(1, 9))
        unit = round(price * float(rng.uniform(0.92, 1.05)), 2)
        ws.append([f"SO-{20250000 + i:08d}", day, region, product, qty, unit, round(qty * unit, 2)])
    for row in ws.iter_rows(min_row=2, min_col=2, max_col=2):
        row[0].number_format = "yyyy-mm-dd"
    wb.save(out / "sales.xlsx")
    truth["sales"] = {"rows": 5000, "sheet": "销售明细", "regions": REGIONS}


def orders_csv(out: Path, truth: dict) -> None:
    rng = np.random.default_rng(20251014)
    rows = []
    end = dt.date(2025, 9, 30)
    start = dt.date(2024, 1, 1)
    span = (end - start).days
    n_customers = 1200
    for cid in range(1, n_customers + 1):
        channel = "promo" if rng.random() < 0.35 else "organic"
        first = start + dt.timedelta(days=int(rng.integers(0, span - 60)))
        # Promo customers go quiet earlier: the signal a good answer can find.
        lifetime = int(rng.exponential(150 if channel == "promo" else 320))
        last = min(end, first + dt.timedelta(days=lifetime))
        day = first
        while day <= last:
            rows.append((f"O{len(rows) + 1:06d}", f"C{cid:05d}", day.isoformat(), round(float(rng.gamma(4.0, 38.0)), 2), channel))
            day += dt.timedelta(days=int(rng.integers(12, 75)))
    with (out / "orders.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["order_id", "customer_id", "order_date", "amount", "channel"])
        writer.writerows(rows)
    truth["orders"] = {"rows": len(rows), "customers": n_customers, "asOf": end.isoformat()}


def _page_break(doc: Document) -> None:
    doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)


def contract_docx(out: Path, truth: dict) -> None:
    doc = Document()
    doc.core_properties.author = "示例公司法务部"
    doc.core_properties.title = "设备采购与维护服务合同"
    section = doc.sections[0]
    section.header.paragraphs[0].text = "设备采购与维护服务合同 · 合同编号 EX-2025-017"
    section.footer.paragraphs[0].text = "示例科技有限公司 与 样例制造有限公司 · 机密"
    doc.add_heading("设备采购与维护服务合同", level=0)
    doc.add_paragraph("甲方（买方）：示例科技有限公司　　乙方（卖方）：样例制造有限公司")
    clauses = [
        ("第一条　合同标的", "乙方向甲方供应工业数据网关共 40 台，型号 GW-300，规格以附件一为准。乙方保证设备为全新、未使用，并附出厂检验报告。"),
        ("第二条　交付", "乙方应在合同生效后 20 个工作日内将设备运至甲方指定仓库，运输和保险费用由乙方承担。甲方应在到货后 5 个工作日内完成验收。"),
        ("第三条　价款与付款", "合同总价为人民币 640,000 元（含税）。付款期限为收到合格发票之日起 30 天内，甲方以银行转账方式一次性支付。逾期付款的，每逾期一日按未付款项的万分之三向乙方支付违约金。"),
        ("第四条　质量保证", "质保期为验收合格之日起 24 个月。质保期内因设备本身缺陷造成的故障，乙方应在接到通知后 48 小时内响应，并免费修理或更换。"),
        ("第五条　维护服务", "乙方提供每年两次的现场巡检和 7×12 小时远程技术支持。巡检报告应在巡检完成后 10 个工作日内提交甲方。"),
        ("第六条　保密", "双方对在履行本合同过程中知悉的对方商业秘密负有保密义务，保密期限为合同终止后 3 年。"),
        ("第七条　违约责任", "任何一方违反本合同约定的，应赔偿对方由此造成的直接损失。因不可抗力造成的延误，经书面通知并提供证明后可相应顺延。"),
        ("第八条　争议解决", "因本合同引起的争议，双方应先友好协商；协商不成的，提交甲方所在地有管辖权的人民法院诉讼解决。"),
    ]
    for index, (title, body) in enumerate(clauses):
        doc.add_heading(title, level=1)
        doc.add_paragraph(body)
        sub = doc.add_paragraph("相关说明：", style="List Number")
        sub.add_run(f"本条的具体执行细则见附件{['一', '二', '三', '四', '五', '六', '七', '八'][index]}。")
        if index in (2, 5):
            _page_break(doc)
    doc.add_paragraph()
    doc.add_paragraph("甲方（盖章）：＿＿＿＿＿＿　　　　乙方（盖章）：＿＿＿＿＿＿")
    doc.save(out / "contract.docx")
    truth["contract"] = {"clause": "第三条", "before": "30 天", "after": "45 天", "pages": 3}


def _docx_to_pdf(docx_path: Path, out_dir: Path) -> Path:
    with tempfile.TemporaryDirectory(prefix="gt-fixture-") as profile:
        subprocess.run(["soffice", f"-env:UserInstallation=file://{profile}", "--headless", "--convert-to", "pdf", "--outdir", str(out_dir), str(docx_path)],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=240)
    return out_dir / (docx_path.stem + ".pdf")


def _filler(doc: Document, topic: str, facts: list[str], paragraphs: int = 5) -> None:
    for i in range(paragraphs):
        doc.add_paragraph(f"{topic}方面，本季度的运营数据显示出稳定的趋势。{facts[i % len(facts)]} " + "管理团队在例会上逐项复核了流程、人员排班和设备状态，并记录了需要跟进的改进事项。" * 3)


def report_pdf(out: Path, truth: dict) -> None:
    """Twenty pages; a five-column table on page 5; short facts a summary can quote."""
    doc = Document()
    doc.core_properties.title = "2025 年度华东区域仓储运营分析报告"
    style = doc.styles["Normal"]
    style.font.size = Pt(11)
    table_rows = [
        ["仓库", "入库量（吨）", "出库量（吨）", "库存周转天数", "破损率（%）"],
        ["上海一仓", "18,420", "17,980", "21.5", "0.42"],
        ["苏州二仓", "12,305", "12,110", "24.0", "0.55"],
        ["杭州三仓", "9,870", "9,640", "26.8", "0.38"],
        ["南京四仓", "7,215", "7,090", "29.3", "0.61"],
        ["合肥五仓", "5,480", "5,360", "31.2", "0.70"],
    ]
    page_facts = {
        1: ["全年总入库量为 53,290 吨，同比增长 8.4%。"],
        2: ["自动分拣线覆盖率从 62% 提升到 81%。"],
        3: ["人均日处理订单 142 单，较上年提高 11 单。"],
        4: ["冷链仓的温度达标率为 99.2%。"],
        6: ["全年工伤事故 2 起，均为轻伤。"],
        7: ["夜班差错率下降到 0.18%。"],
        8: ["新增叉车 14 台，其中电动叉车 11 台。"],
    }
    for page in range(1, 21):
        doc.add_heading(f"第 {page} 部分　{'概述' if page == 1 else '运营专题' if page != 5 else '仓库运营指标汇总'}", level=1)
        if page == 5:
            doc.add_paragraph("下表汇总五个主要仓库全年的入库、出库、库存周转和破损指标。")
            table = doc.add_table(rows=len(table_rows), cols=5)
            table.style = "Table Grid"
            for r, row in enumerate(table_rows):
                for c, value in enumerate(row):
                    table.cell(r, c).text = value
            doc.add_paragraph("注：库存周转天数按日均库存除以日均出库量计算。")
        else:
            _filler(doc, f"专题 {page}", page_facts.get(page, ["本部分无新增的量化结论。"]), paragraphs=4)
        if page < 20:
            _page_break(doc)
    with tempfile.TemporaryDirectory(prefix="gt-report-") as scratch:
        docx_path = Path(scratch) / "operations-report-20p.docx"
        doc.save(docx_path)
        pdf = _docx_to_pdf(docx_path, Path(scratch))
        shutil.copy(pdf, out / "operations-report-20p.pdf")
    truth["report"] = {"pages": 20, "tablePage": 5, "table": table_rows,
                       "facts": ["53,290 吨", "8.4%", "62%", "81%", "142 单", "99.2%", "0.18%", "14 台"]}


def project_files(out: Path, truth: dict) -> None:
    root = out / "project"
    root.mkdir(exist_ok=True)
    (root / "pricing.py").write_text('''"""Price helpers for the demo shop."""


def apply_discount(price: float, percent: float) -> float:
    """Return the price after taking `percent` percent off."""
    return round(price * (percent / 100), 2)


def with_tax(price: float, rate: float = 0.13) -> float:
    return round(price * (1 + rate), 2)
''', encoding="utf-8")
    (root / "cart.py").write_text('''"""A tiny shopping cart."""
from pricing import apply_discount, with_tax


class Cart:
    def __init__(self):
        self.items = []

    def add(self, name: str, price: float, qty: int = 1) -> None:
        self.items.append((name, price, qty))

    def subtotal(self) -> float:
        return round(sum(price * qty for _, price, qty in self.items), 2)

    def total(self, discount_percent: float = 0.0, taxed: bool = False) -> float:
        value = self.subtotal()
        if discount_percent:
            value = apply_discount(value, discount_percent)
        return with_tax(value) if taxed else value
''', encoding="utf-8")
    (root / "test_cart.py").write_text('''import unittest

from cart import Cart


class CartTest(unittest.TestCase):
    def setUp(self):
        self.cart = Cart()
        self.cart.add("pen", 2.5, 4)
        self.cart.add("notebook", 10.0, 2)

    def test_subtotal(self):
        self.assertEqual(self.cart.subtotal(), 30.0)

    def test_tax(self):
        self.assertEqual(self.cart.total(taxed=True), 33.9)

    def test_discount(self):
        # 20 percent off 30.00 is 24.00
        self.assertEqual(self.cart.total(discount_percent=20), 24.0)


if __name__ == "__main__":
    unittest.main()
''', encoding="utf-8")
    truth["project"] = {"files": ["cart.py", "pricing.py", "test_cart.py"], "failing": "test_discount"}


def photos(out: Path, truth: dict) -> None:
    root = out / "photos"
    root.mkdir(exist_ok=True)
    spec = [("IMG_0001.jpg", "2024:03:05 09:12:00"), ("IMG_0002.jpg", "2024:03:05 17:40:10"), ("DSC_7781.jpg", "2024:04:21 08:00:00"),
            ("IMG_0003.jpg", "2024:07:14 13:30:45"), ("holiday-a.jpg", "2025:01:02 19:05:00"), ("holiday-b.jpg", "2025:01:02 19:07:30")]
    for index, (name, taken) in enumerate(spec):
        image = Image.new("RGB", (48, 32), (30 + index * 30, 90, 160 - index * 20))
        exif = image.getexif()
        exif[0x0132] = taken
        ifd = exif.get_ifd(0x8769)
        ifd[0x9003] = taken
        exif[0x8769] = ifd
        image.save(root / name, exif=exif)
    truth["photos"] = {name: taken.split(" ")[0].replace(":", "") for name, taken in spec}


def policy_docs(out: Path, truth: dict) -> None:
    root = out / "policies"
    root.mkdir(exist_ok=True)
    leave = Document()
    leave.add_heading("员工请假管理办法", level=0)
    leave.add_paragraph("第一条　适用范围：本办法适用于示例科技有限公司全体正式员工。")
    leave.add_paragraph("第二条　请假审批：请假 3 天（含）以内，由直属主管审批；请假超过 3 天的，须在直属主管审批后提交部门总监审批，并抄送人力资源部备案；请假超过 10 天的，另须总经理审批。")
    leave.add_paragraph("第三条　申请时限：请假超过 3 天的，应至少提前 5 个工作日在 OA 系统提交《请假申请单》；因突发情况无法提前申请的，应在当日 10:00 前电话告知直属主管，并在返岗后 2 个工作日内补办手续。")
    leave.add_paragraph("第四条　病假：病假超过 2 天的，需提交二级以上医院出具的诊断证明或病假条；病假期间工资按基本工资的 80% 发放。")
    leave.add_paragraph("第五条　年假：工作满一年的员工享有 5 天带薪年假，满五年的享有 10 天，满十年的享有 15 天。")
    leave.save(root / "员工请假管理办法.docx")
    travel = Document()
    travel.add_heading("差旅费报销制度", level=0)
    travel.add_paragraph("第一条　出差须提前在 OA 系统提交出差申请，经部门总监审批后方可订票。")
    travel.add_paragraph("第二条　住宿标准：一线城市每晚不超过 600 元，其他城市每晚不超过 400 元。")
    travel.add_paragraph("第三条　报销时限：出差结束后 15 个自然日内提交报销单和全部发票原件，逾期不予受理。")
    travel.add_paragraph("第四条　交通：高铁二等座、经济舱机票可全额报销；商务座需总经理书面批准。")
    travel.save(root / "差旅费报销制度.docx")
    security = Document()
    security.add_heading("信息安全管理规定", level=0)
    security.add_paragraph("第一条　员工账号须启用双因素认证，密码每 90 天更换一次，长度不少于 12 位。")
    security.add_paragraph("第二条　涉密文件不得通过个人邮箱或个人网盘传输；确需外发的，须经信息安全部审批。")
    security.add_paragraph("第三条　发现可疑邮件或账号异常，应在 1 小时内报告信息安全部。")
    with tempfile.TemporaryDirectory(prefix="gt-policy-") as scratch:
        docx_path = Path(scratch) / "信息安全管理规定.docx"
        security.save(docx_path)
        shutil.copy(_docx_to_pdf(docx_path, Path(scratch)), root / "信息安全管理规定.pdf")
    repo = out / "repo"
    (repo / "src").mkdir(parents=True, exist_ok=True)
    (repo / "README.md").write_text("# jobqueue\n\nA small in-memory job queue for demo services.\n\n## Usage\n\n```ts\nimport { Queue } from './src/queue';\nconst q = new Queue<string>();\nq.push('a');\n```\n\nSee `src/queue.ts` and `src/utils.ts`.\n", encoding="utf-8")
    (repo / "src" / "queue.ts").write_text("export class Queue<T> {\n  private items: T[] = [];\n  push(item: T): void { this.items.push(item); }\n  shift(): T | undefined { return this.items.shift(); }\n  get size(): number { return this.items.length; }\n}\n", encoding="utf-8")
    (repo / "src" / "utils.ts").write_text("export function chunk<T>(list: T[], size: number): T[][] {\n  const out: T[][] = [];\n  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));\n  return out;\n}\n", encoding="utf-8")
    truth["policies"] = {"leaveFile": "员工请假管理办法.docx", "facts": ["部门总监", "5 个工作日", "人力资源部", "总经理"], "files": 3, "repoFiles": 3}


def glucometer_pdf(out: Path, truth: dict) -> None:
    doc = Document()
    doc.core_properties.title = "YS-200 血糖监测系统临床性能验证报告"
    doc.add_heading("YS-200 血糖监测系统临床性能验证报告", level=0)
    doc.add_paragraph("申请人：示例医疗器械有限公司　　报告编号：EX-CV-2025-03　　报告日期：2025 年 8 月 12 日")
    sections = [
        ("1. 概述", ["本报告汇总 YS-200 血糖监测系统（以下简称“本系统”）在三家示例医院开展的临床性能验证结果。验证目的是评价本系统在毛细血管全血样本上的测量准确性，并与实验室参比方法对照。"]),
        ("2. 研究设计", ["前瞻性、多中心、单臂对照研究，共入组 120 名受试者（糖尿病患者 96 名，非糖尿病者 24 名），年龄 19–78 岁，男性 58 名。每名受试者在同一时刻采集指尖毛细血管血糖仪读数和静脉血实验室参比值（己糖激酶法）。", "样本血糖浓度覆盖 2.4–28.6 mmol/L，其中低于 4.2 mmol/L 的样本 14 份。"]),
        ("3. 准确度结果", ["平均绝对相对差（MARD）为 6.8%。", "在 ±15% 或 ±0.83 mmol/L 范围内的读数占比为 98.3%（118/120），高于 95% 的验收标准；在 ±10% 范围内的占比为 84.2%。", "在 Clarke 误差网格分析中，A 区占 96.7%，B 区占 3.3%，C–E 区为 0。"]),
        ("4. 干扰与重复性", ["红细胞压积在 30%–55% 范围内，读数偏差不超过 ±8%。维生素 C 浓度达到 0.17 mmol/L 时无显著干扰。", "批内重复性变异系数（CV）为 2.9%，批间 CV 为 3.4%。"]),
        ("5. 使用条件", ["工作温度 10–40 ℃，相对湿度 10%–90%；样本量 0.5 μL，测量时间 5 秒；测量范围 1.1–33.3 mmol/L。"]),
        ("6. 结论与局限", ["在研究范围内，本系统的准确度满足 ISO 15197:2013 的 95% 验收标准。本研究未入组血糖低于 2.4 mmol/L 的受试者，也未评价危重症患者，结论不适用于这些人群。"]),
    ]
    for heading, paragraphs in sections:
        doc.add_heading(heading, level=1)
        for text in paragraphs:
            doc.add_paragraph(text)
        if heading.startswith("3."):
            rows = [["血糖区间（mmol/L）", "样本数", "±15% 内占比"], ["< 4.2", "14", "100%"], ["4.2–10.0", "62", "98.4%"], ["10.1–16.7", "30", "96.7%"], ["> 16.7", "14", "100%"]]
            table = doc.add_table(rows=len(rows), cols=3)
            table.style = "Table Grid"
            for r, row in enumerate(rows):
                for c, value in enumerate(row):
                    table.cell(r, c).text = value
    with tempfile.TemporaryDirectory(prefix="gt-gluco-") as scratch:
        docx_path = Path(scratch) / "glucometer-validation-report.docx"
        doc.save(docx_path)
        shutil.copy(_docx_to_pdf(docx_path, Path(scratch)), out / "glucometer-validation-report.pdf")
    truth["glucometer"] = {"numbers": ["120", "96", "24", "6.8%", "98.3%", "118/120", "84.2%", "96.7%", "3.3%", "30%", "55%", "2.9%", "3.4%", "0.5 μL", "5 秒", "95%", "98.4%", "14", "62", "30"]}


def rct_csv(out: Path, truth: dict) -> None:
    rows = [("示例试验 A", 2018, 1210, 1198, 0.82, 0.68, 0.99), ("示例试验 B", 2019, 860, 871, 0.74, 0.58, 0.94), ("示例试验 C", 2020, 2400, 2395, 0.88, 0.77, 1.01),
            ("示例试验 D", 2021, 540, 552, 0.69, 0.47, 1.02), ("示例试验 E", 2022, 1760, 1744, 0.91, 0.79, 1.05), ("示例试验 F", 2023, 980, 975, 0.78, 0.62, 0.98)]
    with (out / "rct_effects.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["study", "year", "n_treatment", "n_control", "hazard_ratio", "ci_lower", "ci_upper"])
        writer.writerows(rows)
    truth["rct"] = {"rows": len(rows), "measure": "hazard_ratio"}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=HERE)
    out = parser.parse_args().out
    out.mkdir(parents=True, exist_ok=True)
    truth: dict = {}
    sales_xlsx(out, truth)
    orders_csv(out, truth)
    contract_docx(out, truth)
    report_pdf(out, truth)
    project_files(out, truth)
    photos(out, truth)
    policy_docs(out, truth)
    glucometer_pdf(out, truth)
    rct_csv(out, truth)
    (out / "ground_truth.json").write_text(json.dumps(truth, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print("fixtures written to", out)


if __name__ == "__main__":
    main()
