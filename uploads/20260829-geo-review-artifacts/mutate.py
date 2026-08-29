"""Neuter each BLOCK check in turn and see whether the suite notices.

A rule that can be switched off with the tests still green is a rule nothing
proves. That is the same discipline this repository applies to its own gates:
a check without a negative control is a check that will pass forever.
"""
import io, re, subprocess, sys, yaml

SRC = 'validate.py'
original = io.open(SRC, encoding='utf-8').read()
cat = yaml.safe_load(open('../rules/catalogue.yaml'))
block = [r for r in (cat.get('rules') or []) if r.get('severity') == 'BLOCK' and str(r.get('check','')).startswith('validate.')]

survived, caught, skipped = [], [], []
for rule in block:
    fn = rule['check'].split('.')[-1]
    m = re.search(rf"(def {re.escape(fn)}\([^)]*\)[^:]*:\n)", original)
    if not m:
        skipped.append(rule['id']); continue
    # Make the check return no issues at all: the rule can no longer block.
    mutated = original[:m.end(1)] + "    return []\n" + original[m.end(1):]
    io.open(SRC, 'w', encoding='utf-8').write(mutated)
    proc = subprocess.run([sys.executable, '-m', 'pytest', 'tests', '-q', '--no-header', '--deselect', 'tests/test_core.py::TestDocsMatchReality::test_readme_test_count_is_current'],
                          capture_output=True, text=True, timeout=300)
    (caught if proc.returncode != 0 else survived).append(rule['id'])
io.open(SRC, 'w', encoding='utf-8').write(original)

print(f"BLOCK checks mutated: {len(caught) + len(survived)}")
print(f"  caught by the suite : {len(caught)}")
print(f"  SURVIVED (no test)  : {len(survived)}")
if survived:
    print("  survived:", ", ".join(survived))
if skipped:
    print("  not locatable:", ", ".join(skipped))
