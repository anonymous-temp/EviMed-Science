"""Stream the local drug-label workbooks and write (generic name, brand name) pair counts for chemical drugs.

Read-only over the gitignored database; only the derived counts are written (no label text). Runs one workbook at a time
and clears every parsed element, so memory stays small. Usage:
  python3 -I synthetic/med_m3_extract.py <database dir> <output json>
"""
import glob, json, os, re, sys, zipfile
import xml.etree.ElementTree as ET
from collections import Counter

NS = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
db, out = sys.argv[1], sys.argv[2]
pairs = Counter()
generics = Counter()
for path in sorted(glob.glob(os.path.join(db, '药品说明书数据库_医药数据查询(*).xlsx'))):
    z = zipfile.ZipFile(path)
    header = None
    for _, el in ET.iterparse(z.open('xl/worksheets/sheet1.xml')):
        if el.tag != NS + 'row':
            continue
        cells = {}
        for c in el:
            col = re.match(r'[A-Z]+', c.get('r')).group()
            if col in ('E', 'F', 'I'):
                v = c.find(NS + 'v')
                cells[col] = (''.join(t.text or '' for t in c.iter(NS + 't')) or (v.text if v is not None and c.get('t') != 's' and v.text else '')).strip()
        el.clear()
        if header is None:
            header = cells
            if header.get('E') != '通用名称' or header.get('F') != '商品名称':
                raise SystemExit(f'unexpected header in {path}: {header}')
            continue
        if cells.get('I') != '化学药品' or not cells.get('E'):
            continue
        generics[cells['E']] += 1
        if cells.get('F'):
            pairs[(cells['E'], cells['F'])] += 1
    print(os.path.basename(path), len(generics), len(pairs), file=sys.stderr)
json.dump({'source': 'drug-label database, columns 通用名称/商品名称, 药品分类=化学药品', 'generics': generics, 'pairs': [[g, b, n] for (g, b), n in pairs.items()]}, open(out, 'w'), ensure_ascii=False)
