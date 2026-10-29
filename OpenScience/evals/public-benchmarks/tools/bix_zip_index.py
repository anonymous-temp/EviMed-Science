#!/usr/bin/env python3 -I
"""List the entries of remote HF zip files WITHOUT downloading them (HTTP Range on the zip's central directory).

Usage: bix_zip_index.py <out.json> <CapsuleFolder-uuid.zip> [...]
Writes {zip_name: {"zip_bytes": int, "entries": [{"name","size","csize"}...]}}.
"""
import json, struct, sys, urllib.request

BASE = "https://huggingface.co/datasets/futurehouse/BixBench/resolve/main/"


def rng(url, start=None, end=None, suffix=None):
    h = {"User-Agent": "evimed-bench-index/1"}
    h["Range"] = f"bytes=-{suffix}" if suffix else f"bytes={start}-{end}"
    req = urllib.request.Request(url, headers=h)
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read()
        cr = r.headers.get("Content-Range", "")
    total = int(cr.split("/")[-1]) if "/" in cr else None
    return data, total


def index(name):
    url = BASE + name
    tail, total = rng(url, suffix=131072)
    i = tail.rfind(b"PK\x05\x06")
    if i < 0:
        raise RuntimeError("no EOCD")
    (_, _, _, n_this, n_total, cd_size, cd_off, _) = struct.unpack("<IHHHHIIH", tail[i:i + 22])
    z64 = tail.rfind(b"PK\x06\x07", 0, i)
    if cd_off == 0xFFFFFFFF or n_total == 0xFFFF:
        j = tail.rfind(b"PK\x06\x06")
        (_, _, _, _, _, _, n_total, _, cd_size, cd_off) = struct.unpack("<IQHHIIQQQQ", tail[j:j + 56])
    start_tail = total - len(tail)
    if cd_off >= start_tail:
        cd = tail[cd_off - start_tail: cd_off - start_tail + cd_size]
    else:
        cd, _ = rng(url, cd_off, cd_off + cd_size - 1)
    entries, p = [], 0
    while p + 46 <= len(cd) and cd[p:p + 4] == b"PK\x01\x02":
        (_, _, _, _, _, _, _, _, csize, usize, nlen, elen, clen, *_rest) = struct.unpack("<IHHHHHHIIIHHHHHII", cd[p:p + 46])
        fname = cd[p + 46:p + 46 + nlen].decode("utf-8", "replace")
        entries.append({"name": fname, "size": usize, "csize": csize})
        p += 46 + nlen + elen + clen
    return {"zip_bytes": total, "entries": entries}


if __name__ == "__main__":
    out, names = sys.argv[1], sys.argv[2:]
    res = {}
    for n in names:
        try:
            res[n] = index(n)
            e = res[n]["entries"]
            print(n, res[n]["zip_bytes"], len(e), sum(x["size"] for x in e), flush=True)
        except Exception as ex:  # noqa
            print("FAIL", n, ex, flush=True)
    json.dump(res, open(out, "w"), indent=1)
