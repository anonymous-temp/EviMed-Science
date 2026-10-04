#!/usr/bin/env python3
"""Minimal text extractor for simple ReportLab-generated PDFs (FlateDecode content streams)."""
import re, sys, zlib

data = open(sys.argv[1], 'rb').read()

# collect objects
objs = {}
for m in re.finditer(rb'(\d+)\s+0\s+obj(.*?)endobj', data, re.S):
    objs[int(m.group(1))] = m.group(2)

def decode_stream(body):
    sm = re.search(rb"stream\r?\n(.*?)endstream", body, re.S)
    if not sm:
        return None
    raw = sm.group(1)
    if b'ASCII85Decode' in body:
        import base64
        a = raw.strip()
        if a.endswith(b'~>'):
            a = a[:-2]
        try:
            raw = base64.a85decode(a, adobe=False)
        except Exception as e:
            print("[a85 fail]", e, file=sys.stderr)
            return None
    if b'FlateDecode' in body:
        try:
            return zlib.decompress(raw)
        except Exception:
            try:
                return zlib.decompressobj().decompress(raw)
            except Exception as e:
                print("[flate fail]", e, file=sys.stderr)
                return None
    return raw

def unescape(s):
    out = bytearray()
    i = 0
    while i < len(s):
        c = s[i:i+1]
        if c == b'\\':
            nxt = s[i+1:i+2]
            mp = {b'n': b'\n', b'r': b'\r', b't': b'\t', b'b': b'\b', b'f': b'\f',
                  b'(': b'(', b')': b')', b'\\': b'\\'}
            if nxt in mp:
                out += mp[nxt]; i += 2; continue
            om = re.match(rb'[0-7]{1,3}', s[i+1:i+4])
            if om:
                out.append(int(om.group(0), 8) & 0xFF); i += 1 + len(om.group(0)); continue
            out += nxt; i += 2; continue
        out += c; i += 1
    return bytes(out)

def extract_text(content):
    """Walk the content stream, emitting text with line breaks on positioning ops."""
    lines = []
    cur = []
    tok = re.compile(rb'''\((?:[^()\\]|\\.|\((?:[^()\\]|\\.)*\))*\)|\[[^\]]*\]|<[0-9A-Fa-f\s]*>|\bT[dDmJj\*]\b|\b(Tj|TJ|ET|BT)\b|[-+]?[0-9]*\.?[0-9]+''', re.S)
    for m in tok.finditer(content):
        t = m.group(0)
        if t in (b'Td', b'TD', b'T*'):
            if cur:
                lines.append(b''.join(cur)); cur = []
        elif t in (b'Tj', b'TJ'):
            pass
        elif t.startswith(b'('):
            cur.append(unescape(t[1:-1]))
        elif t.startswith(b'['):
            for sm in re.finditer(rb'\((?:[^()\\]|\\.)*\)', t, re.S):
                cur.append(unescape(sm.group(0)[1:-1]))
            if b'ET' not in t:
                cur.append(b' ')
    if cur:
        lines.append(b''.join(cur))
    txt = b'\n'.join(lines)
    return txt.decode('cp1252', errors='replace')

pages = []
for num in sorted(objs):
    body = objs[num]
    if b'/Contents' in body and b'/Page' in body:
        cm = re.search(rb'/Contents\s+(\d+)\s+0\s+R', body)
        if cm:
            pages.append(int(cm.group(1)))

# fall back: all streams that look like content
if not pages:
    pages = [n for n in sorted(objs) if decode_stream(objs[n]) and b'Tj' in (decode_stream(objs[n]) or b'')]

for i, p in enumerate(pages, 1):
    body = objs.get(p, b'')
    s = decode_stream(body)
    print(f"\n========== PAGE {i} (obj {p}) ==========")
    if s is None:
        print("[undecodable stream]")
        continue
    print(extract_text(s))
