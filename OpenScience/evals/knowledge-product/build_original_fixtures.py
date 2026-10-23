"""Build deterministic PDF and ZIP fixtures without changing medical source bytes."""
import hashlib
import json
import pathlib
import textwrap
import zipfile

def build_pdf(root, b):
    source = next((s for s in b['sources'] if s['id'] == 'general-support'))
    text = (root / source['extractedTextPath']).read_text()
    lines = [line for para in text.splitlines() for line in textwrap.wrap(para, 88)]
    content = ('BT /F1 10 Tf 50 760 Td 13 TL\n' + '\n'.join((('T* ' if i else '') + '(' + line.replace('\\', '\\\\').replace('(', '\\(').replace(')', '\\)') + ') Tj' for (i, line) in enumerate(lines))) + '\nET\n').encode()
    objects = [b'<< /Type /Catalog /Pages 2 0 R >>', b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>', b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', f'<< /Length {len(content)} >>\nstream\n'.encode() + content + b'endstream']
    pdf = bytearray(b'%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')
    offsets = [0]
    for (i, obj) in enumerate(objects, 1):
        offsets.append(len(pdf))
        pdf.extend(f'{i} 0 obj\n'.encode() + obj + b'\nendobj\n')
    xref = len(pdf)
    pdf.extend(f'xref\n0 {len(objects) + 1}\n0000000000 65535 f \n'.encode())
    for offset in offsets[1:]:
        pdf.extend(f'{offset:010} 00000 n \n'.encode())
    pdf.extend(f'trailer << /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode())
    source['path'] = 'corpus/general-support.pdf'
    (root / source['path']).write_bytes(pdf)
    source['sha256'] = hashlib.sha256(pdf).hexdigest()
    next((c for c in b['cases'] if c['id'] == 'general-support'))['evaluation'].update(format='pdf', substrate='knowledge')

def build_zip(root, b):
    source = next((s for s in b['sources'] if s['id'] == 'general-budget'))
    text = (root / source['extractedTextPath']).read_bytes()
    target = root / 'corpus/general-budget.zip'
    with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_STORED) as z:
        info = zipfile.ZipInfo('policy.txt', date_time=(1980, 1, 1, 0, 0, 0))
        info.external_attr = 384 << 16
        z.writestr(info, text)
    source['path'] = 'corpus/general-budget.zip'
    source['sha256'] = hashlib.sha256(target.read_bytes()).hexdigest()
    source['originalOnly'] = True
    c = next((c for c in b['cases'] if c['id'] == 'general-budget'))
    c['evaluation'].update(format='archive', originalOnly=True, maliciousControl=False)

def main():
    root = pathlib.Path(__file__).parent
    b = json.loads((root / 'cases.json').read_text())
    for c in b['cases']:
        if c.get('evaluation', {}).get('originalOnly'):
            c['evaluation']['maliciousControl'] = c['evaluation'].get('format') == 'malicious-original'
    build_pdf(root, b)
    build_zip(root, b)
    b['coverage']['formats'] = list(dict.fromkeys([*b['coverage']['formats'], 'pdf', 'zip-original-only']))
    (root / 'cases.json').write_text(json.dumps(b, indent=2) + '\n')
if __name__ == '__main__':
    main()
