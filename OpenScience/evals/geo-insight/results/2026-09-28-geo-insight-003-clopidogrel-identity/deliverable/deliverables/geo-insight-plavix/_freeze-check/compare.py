# -*- coding: utf-8 -*-
"""Freeze-check: compare the pre-edit copy with the edited report.

Protected set: citation marks, reference entries, every number, headings,
quoted passages in 「」/『』 and the percentage/ratio strings.
"""
import re, sys, hashlib, os

A = "geo-insight.md"
B = "_freeze-check/geo-insight.pass3-before.md"

a = open(A, encoding="utf-8").read()
b = open(B, encoding="utf-8").read()

if a == b:
    print("NOT RUN: the two sides are identical — the comparison would prove nothing")
    sys.exit(1)

def marks(t):
    return sorted(set(re.findall(r"\[(\d{1,3})\]", t)))

def refs(t):
    return sorted(re.findall(r"^\[(\d{1,3})\]\s", t, re.M))

def nums(t):
    return sorted(re.findall(r"\d+(?:\.\d+)?", t))

def heads(t):
    return re.findall(r"^#{1,6}\s.*$", t, re.M)

def quotes(t):
    return re.findall(r"[「『][^」』]{2,}[」』]", t) + re.findall(r"【[^】]{1,12}】", t)

def bigq(t):
    return re.findall(r"\*\*[^*]{2,}\*\*", t)

checks = {
    "citation marks in text": (marks(a), marks(b)),
    "reference entries": (refs(a), refs(b)),
    "numbers (multiset)": (nums(a), nums(b)),
    "headings": (heads(a), heads(b)),
    "quoted passages": (quotes(a), quotes(b)),
    "bold spans": (bigq(a), bigq(b)),
}
bad = 0
for name, (x, y) in checks.items():
    if x == y:
        print("OK   %-24s identical (%d)" % (name, len(x)))
    else:
        bad += 1
        sx, sy = set(x) - set(y), set(y) - set(x)
        print("FAIL %-24s only-now: %r ; only-before: %r" % (name, list(sx)[:8], list(sy)[:8]))

print()
print("pre-edit bytes : %d  sha256 %s" % (os.path.getsize(B), hashlib.sha256(open(B,'rb').read()).hexdigest()[:16]))
print("edited   bytes : %d  sha256 %s" % (os.path.getsize(A), hashlib.sha256(open(A,'rb').read()).hexdigest()[:16]))
print("byte delta     : %+d" % (os.path.getsize(A) - os.path.getsize(B)))
print("RESULT:", "PROTECTED SET INTACT" if bad == 0 else "PROTECTED SET CHANGED in %d check(s)" % bad)
sys.exit(0 if bad == 0 else 1)
