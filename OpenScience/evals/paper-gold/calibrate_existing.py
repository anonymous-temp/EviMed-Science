"""Execute existing independently anchored engine tests; never call synthetic fixtures published gold."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
from datetime import datetime, timezone

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--data-dir', required=True)
    args = parser.parse_args()
    repository = Path(__file__).resolve().parents[3]
    directory = Path(args.data_dir).resolve() / 'paper-gold' / 'engine-calibration'
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    suites = [
        ('meta', 'meta', ['tests/test_published_reference_cases.py']),
        ('pharmacovigilance', '药物安全分析agent', ['tests/test_published_signal_references.py', 'tests/test_faers_paper_regression.py', 'tests/test_class_publication_regression.py']),
        ('mr', '孟德尔随机化', ['tests/test_local_r_statistics.py']),
    ]
    report = {'at': datetime.now(timezone.utc).isoformat(), 'scope': 'existing_engine_reference_calibration_not_end_to_end_research_reproduction', 'suites': []}
    for engine, subtree, tests in suites:
        root = repository / '项目代码' / subtree
        interpreter = root / '.venv' / 'bin' / 'python'
        if not interpreter.exists():
            interpreter = Path(sys.executable)
        command = [str(interpreter), '-m', 'pytest', *tests, '-q']
        environment = dict(os.environ, PYTHONPATH=str(root / 'src') + os.pathsep + str(root))
        process = subprocess.run(command, cwd=root, env=environment, capture_output=True, text=True, timeout=600)
        output = process.stdout + process.stderr
        output_path = directory / (engine + '.log')
        output_path.write_text(output)
        os.chmod(output_path, 0o600)
        report['suites'].append({'engine': engine, 'returncode': process.returncode, 'logHash': hashlib.sha256(output.encode()).hexdigest(), 'publishedNumericGold': engine != 'mr', 'limitation': 'MR tests contain synthetic/deterministic fixtures; not five published-paper reproductions.' if engine == 'mr' else 'Preserve source-defined tolerances and FAERS population/date mismatches.'})
    result = directory / 'report.json'
    result.write_text(json.dumps(report, indent=2) + '\n')
    os.chmod(result, 0o600)
    print(json.dumps(report))
    return int(any(row['returncode'] for row in report['suites']))

if __name__ == '__main__':
    raise SystemExit(main())
