#!/usr/bin/env python3
"""Compare the lab's levers (stack.py) with production's non-secret levers as read on 2026-11-01 (prod-levers-20261101.txt).

  env_diff.py            print, per production lever: same / differs / not set in the lab / lab only

The comparison is the evidence behind ENV-DIFFERENCES.md; a lever production sets that the lab neither copies nor overrides is left at
the code's default (or does not exist in the lab's stack), and is listed so the document can say which.
"""
import importlib.util
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("stack", HERE / "stack.py")
stack = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stack)

production = {}
for line in (HERE / "prod-levers-20261101.txt").read_text().splitlines():
    if "=" in line:
        name, _, value = line.partition("=")
        production[name] = value
lab = dict(stack.PARITY)
lab.update({name: value for name, (value, _why) in stack.lab_overrides(3).items()})

same = [n for n in production if n in lab and production[n] == lab[n]]
differs = [(n, production[n], lab[n]) for n in production if n in lab and production[n] != lab[n]]
missing = [n for n in production if n not in lab]
lab_only = [n for n in lab if n not in production]
print(f"production levers read: {len(production)}; the lab sets {len(lab)}")
print(f"\nsame value ({len(same)}): " + ", ".join(sorted(same)))
print(f"\ndiffers ({len(differs)}):")
for name, was, now in sorted(differs):
    print(f"  {name}: production {was!r} -> lab {now!r}")
print(f"\nproduction only, not set in the lab ({len(missing)}):")
for name in sorted(missing):
    print(f"  {name}={production[name]}")
print(f"\nlab only ({len(lab_only)}): " + ", ".join(sorted(lab_only)))
