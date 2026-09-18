"""Small label workbooks in both export layouts, and the index built from them.

Shared by the drug-label index tests here and the evidence adapter's tests.
The workbooks are written as real OOXML packages, with the features the real
exports use: a shared-string table with a rich-text run, Excel's `_x000D_`
escape, a hidden row and a code stored as a number in one; inline `str` cells
and `|` line breaks in the other."""

from __future__ import annotations

import pathlib
import sys
import zipfile
from xml.sax.saxutils import escape

ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import build_drug_label_index as builder  # noqa: E402

CR = chr(13)
PRECAUTIONS_200 = ("服药期间应定期复查血常规与肝功能" * 13)[:200]
assert len(PRECAUTIONS_200) == 200

DETAIL_COLUMNS = {
    "产品名称": "product_name",
    "批准文号": "approval",
    "生产厂家": "manufacturer",
    "商品名/商标": "trade_name",
    "详情链接": "source_url",
    "主分类": "category",
    "药品本位码": "national_code",
    "成份": "section:composition",
    "功能主治/适应症": "section:indications",
    "用法用量": "section:dosage",
    "不良反应": "section:adverse-reactions",
    "禁忌": "section:contraindications",
    "注意事项": "section:precautions",
    "药物相互作用": "section:interactions",
    "包装规格": "section:specification",
}
LABEL_COLUMNS = {
    "通用名称": "generic_name",
    "商品名称": "trade_name",
    "汉语拼音": "pinyin",
    "批准文号": "approval",
    "生产企业": "manufacturer",
    "标题链接": "source_url",
    "适应症": "section:indications",
    "用法用量": "section:dosage",
    "不良反应": "section:adverse-reactions",
    "禁忌": "section:contraindications",
    "注意事项": "section:precautions",
    "老人用药": "section:geriatric",
}
DATASETS = (
    {
        "id": "315jiage",
        "site": "https://www.315jiage.cn",
        "files": ("detail.xlsx",),
        "columns": DETAIL_COLUMNS,
        "ignored": ("价格",),
        "line_separator": None,
    },
    {
        "id": "yaozs",
        "site": "https://www.yaozs.com",
        "files": ("labels(1).xlsx",),
        "columns": LABEL_COLUMNS,
        "ignored": ("编号",),
        "line_separator": "|",
    },
)

ASPIRIN = {
    "产品名称": "阿司匹林肠溶片(拜阿司匹灵)",
    "批准文号": "国药准字J20130078",
    "生产厂家": "拜耳医药保健有限公司",
    "商品名/商标": "拜阿司匹灵",
    "详情链接": "https://www.315jiage.cn/mn1.aspx",
    "主分类": "西药",
    "药品本位码": 86900000000001,
    "成份": "本品每片含阿司匹林100mg。",
    "功能主治/适应症": "用于降低急性心肌梗死疑似患者的发病风险。",
    "用法用量": "口服，每日一次，每次100mg。",
    "不良反应": "胃肠道不适。" + CR + "\n可能增加出血风险。",
    "禁忌": "对阿司匹林过敏者禁用。活动性消化性溃疡者禁用。",
    "注意事项": ["与其他", "抗凝药", "合用时应监测出血。"],
    "药物相互作用": "与抗凝药合用增加出血风险。",
    "包装规格": "100mg*30片",
    "价格": "15.00",
}
DETAIL_ROWS = [
    ASPIRIN,
    # The same label under a second brand and pack: one version, two names.
    {**ASPIRIN, "产品名称": "阿司匹林肠溶片(拜阿司匹林)", "商品名/商标": "拜阿司匹林", "包装规格": "100mg*7片", "详情链接": "https://www.315jiage.cn/mn2.aspx"},
    # A health food, not a drug label.
    {"产品名称": "维生素C片", "批准文号": "国食健注G20230831", "生产厂家": "某保健品公司", "功能主治/适应症": "补充维生素C。"},
    # Hidden by the export's filter, still a drug label; less complete here
    # than in the other export.
    {"产品名称": "华法林钠片(信谊)", "批准文号": "国药准字H31022123", "生产厂家": "上海上药信谊药厂有限公司", "商品名/商标": "信谊",
     "功能主治/适应症": "适用于需长期持续抗凝的患者。", "注意事项": "定期监测INR。"},
    # No approval number at all.
    {"产品名称": "无名药片", "功能主治/适应症": "无。"},
    # An approval number and no label text.
    {"产品名称": "空白片", "批准文号": "国药准字H11111111"},
]
LABEL_ROWS = [
    # The aspirin label again, less complete: the fuller copy is kept.
    {"通用名称": "阿司匹林肠溶片", "商品名称": "拜阿司匹灵", "汉语拼音": "AMoSiPiLinChangRongPian", "批准文号": "国药准字J20130078",
     "生产企业": "拜耳医药保健有限公司(进口)", "标题链接": "https://www.yaozs.com/sms1/", "适应症": "用于心肌梗死二级预防。",
     "用法用量": "口服。", "禁忌": "过敏者禁用。", "注意事项": "----", "编号": "1"},
    # Warfarin, fuller here than in the other export: this copy is kept.
    {"通用名称": "华法林钠片", "汉语拼音": "HuaFaLinNaPian", "批准文号": "国药准字H31022123", "生产企业": "上海信谊药厂有限公司",
     "标题链接": "https://www.yaozs.com/sms2/", "适应症": "适用于需长期持续抗凝的患者。", "用法用量": "口服，剂量按INR调整。",
     "不良反应": "出血。", "禁忌": "妊娠期禁用。", "注意事项": "定期监测INR。|避免与其他抗凝药合用。", "老人用药": "老年患者应减量。"},
    # `|` is this export's line break.
    {"通用名称": "甲氨蝶呤片", "批准文号": "国药准字H31020644", "生产企业": "上海上药信谊药厂有限公司",
     "适应症": "类风湿关节炎。", "用法用量": "每周1次。|具体剂量遵医嘱。", "禁忌": "孕妇禁用。",
     # Cut at 200 characters mid-sentence, as the exports cut some fields.
     "注意事项": PRECAUTIONS_200},
    # An import registration written with its 注册证号 wording.
    {"通用名称": "氯吡格雷片", "商品名称": "波立维", "批准文号": "注册证号 H20140973", "生产企业": "赛诺菲",
     "适应症": "近期心肌梗死患者。", "禁忌": "活动性病理性出血。"},
]


def _cell(reference, value, shared, strings):
    if isinstance(value, int):
        # A code stored as a number, written the way Excel writes a large one.
        return '<c r="%s"><v>%s</v></c>' % (reference, "%.13E" % value)
    if shared:
        strings.append(value)
        return '<c r="%s" t="s"><v>%d</v></c>' % (reference, len(strings) - 1)
    return '<c r="%s" t="str"><v>%s</v></c>' % (reference, _xstring(value))


def _xstring(text):
    return escape(text.replace(CR, "_x000D_"))


def _string_item(value):
    if isinstance(value, list):
        return "<si>%s</si>" % "".join('<r><rPr><b/></rPr><t xml:space="preserve">%s</t></r>' % _xstring(part) for part in value)
    return '<si><t xml:space="preserve">%s</t></si>' % _xstring(value)


def _column(index):
    name = ""
    index += 1
    while index:
        index, remainder = divmod(index - 1, 26)
        name = chr(65 + remainder) + name
    return name


def write_workbook(path, headers, rows, shared=False, hidden=(), modified=None):
    """A one-sheet workbook with `headers` as its first row."""
    strings = []
    xml_rows = []
    for number, values in enumerate([dict(zip(headers, headers)), *rows], start=1):
        cells = []
        for index, header in enumerate(headers):
            value = values.get(header)
            if value in (None, ""):
                continue
            cells.append(_cell("%s%d" % (_column(index), number), value, shared, strings))
        flag = ' hidden="1"' if number - 1 in hidden else ""
        xml_rows.append('<row r="%d"%s>%s</row>' % (number, flag, "".join(cells)))
    main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    relationship = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
        archive.writestr("xl/workbook.xml", '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="%s" xmlns:r="%s"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>' % (main, relationship))
        archive.writestr("xl/_rels/workbook.xml.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="%s/worksheet" Target="worksheets/sheet1.xml"/></Relationships>' % relationship)
        archive.writestr("xl/worksheets/sheet1.xml", '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="%s"><sheetData>%s</sheetData></worksheet>' % (main, "".join(xml_rows)))
        if shared:
            archive.writestr("xl/sharedStrings.xml", '<?xml version="1.0" encoding="UTF-8"?><sst xmlns="%s" count="%d" uniqueCount="%d">%s</sst>' % (main, len(strings), len(strings), "".join(_string_item(value) for value in strings)))
        core = '<dcterms:modified xmlns:dcterms="http://purl.org/dc/terms/">%s</dcterms:modified>' % modified if modified else ""
        archive.writestr("docProps/core.xml", '<?xml version="1.0" encoding="UTF-8"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties">%s</cp:coreProperties>' % core)


def write_exports(directory):
    directory = pathlib.Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    write_workbook(directory / "detail.xlsx", [*DETAIL_COLUMNS, "价格"], DETAIL_ROWS, shared=True, hidden={4}, modified="2025-12-17T15:44:47Z")
    write_workbook(directory / "labels(1).xlsx", [*LABEL_COLUMNS, "编号"], LABEL_ROWS)
    return directory


def build_index(directory, name="labels.sqlite"):
    """Exports and an index built from them; returns (index path, build report)."""
    directory = pathlib.Path(directory)
    exports = write_exports(directory / "exports")
    output = directory / name
    report = builder.build(exports, output, datasets=DATASETS)
    return output, report
