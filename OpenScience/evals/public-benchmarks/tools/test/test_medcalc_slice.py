"""Tests of medcalc_slice.py over a tiny synthetic bench (never the real data).

Run: python3 -I -m unittest discover -s tools/test -p 'test_medcalc_slice.py'   (from evals/public-benchmarks)
"""
import contextlib
import hashlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import medcalc_slice as ms  # noqa: E402

GOLD_MARK = 'GOLD-MARK-4242'
SALT, DEV_SALT = 'conf', 'screen'


def h(salt, ident):
    return hashlib.sha256(f'{salt}|{ident}'.encode()).hexdigest()


class Slice(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='medcalc-slice-test-')
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        # calculators: 1 (rows 1-8 baseline, accurate), 2 (rows 11-18 baseline, failing), 3 (rows 21-24 baseline, exactly at the threshold)
        # development rows 31-34 (calculator 1), confirmation rows 101-160: calculator 2 for the first 20 ids, 1 for the rest, 3 for 150-160
        rows = {}
        for r in range(1, 9):
            rows[str(r)] = 1
        for r in range(11, 19):
            rows[str(r)] = 2
        for r in range(21, 25):
            rows[str(r)] = 3
        for r in range(31, 35):
            rows[str(r)] = 1
        for r in range(101, 161):
            rows[str(r)] = 2 if r < 121 else 3 if r >= 150 else 1
        self.rows = rows
        lines = ['Row Number,Calculator ID,Calculator Name,Patient Note,Ground Truth Answer']
        lines += [f'{r},{c},calc {c},note {r},{GOLD_MARK}' for r, c in rows.items()]
        (self.dir / 'test_data.csv').write_text('\n'.join(lines) + '\n')
        (self.dir / 'pools.json').write_text(json.dumps({'digest': 'p' * 64, 'bench': 'medcalc', 'pools': {'main': {
            'development': [str(r) for r in range(31, 35)] + ['500'], 'confirmation': [str(r) for r in range(101, 161)]}}}))
        (self.dir / 'ppc.json').write_text(json.dumps({'domains': {'medcalc': {'ids': ['500']}}}))
        verdicts = [{'key': f'medcalc/{r}', 'verdict': 'correct'} for r in range(1, 9)]  # calculator 1: 8/8
        verdicts += [{'key': f'medcalc/{r}', 'verdict': 'correct' if r < 14 else 'incorrect'} for r in range(11, 19)]  # calculator 2: 3/8
        verdicts += [{'key': f'medcalc-rsi/base/{r}', 'verdict': 'correct' if r < 24 else 'incorrect'} for r in range(21, 25)]  # calculator 3: 3/4 = 0.75
        (self.dir / 'v1.jsonl').write_text(''.join(json.dumps(v) + '\n' for v in verdicts))
        score = {'families': {'medcalc': {'arms': {
            'base': {'runs': [{'row': str(r), 'state': 'ok', 'score': 1.0} for r in range(31, 35)]},
            'aa': {'runs': [{'row': '31', 'state': 'ok', 'score': 0.0}, {'row': '32', 'state': 'infra'}, {'row': '33', 'state': 'missing'}]}}}}}
        (self.dir / 'score.json').write_text(json.dumps(score))
        self.out = self.dir / 'slice.json'

    def run_tool(self, *extra, minimum='10'):
        argv = ['--data', str(self.dir / 'test_data.csv'), '--pools', str(self.dir / 'pools.json'), '--ppc', str(self.dir / 'ppc.json'), '--salt', SALT,
                '--development-salt', DEV_SALT, '--development-rows', '2', '--verdicts', str(self.dir / 'v1.jsonl'), '--score', str(self.dir / 'score.json'),
                '--arm', 'base', '--arm', 'aa', '--min-confirmation-in-slice', minimum, '--out', str(self.out), *extra]
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = ms.main(argv)
        return code, out.getvalue(), err.getvalue()

    def test_pooled_accuracy_strictly_below_the_threshold_is_the_slice(self):
        code, out, err = self.run_tool()
        self.assertEqual((code, err), (0, ''))
        document = json.loads(self.out.read_text())
        self.assertEqual(document['failureCalculators'], [2])  # calculator 3 sits at exactly 0.75: not below
        self.assertEqual(document['perCalculator']['1'], {'correct': 12, 'n': 13, 'accuracy': round(12 / 13, 6)})  # 8 verdicts + the base arm's 4 runs; the aa arm's one scored run is a miss
        self.assertEqual(document['perCalculator']['2'], {'correct': 3, 'n': 8, 'accuracy': 0.375})
        self.assertEqual(document['perCalculator']['3'], {'correct': 3, 'n': 4, 'accuracy': 0.75})
        self.assertEqual(document['observations'], 8 + 8 + 4 + 4 + 1)  # infrastructure and missing runs are not observations

    def test_the_confirmation_size_is_the_smallest_n_with_enough_rows_in_the_slice(self):
        code, out, _ = self.run_tool(minimum='10')
        self.assertEqual(code, 0)
        document = json.loads(self.out.read_text())
        ordered = sorted((str(r) for r in range(101, 161)), key=lambda i: h(SALT, i))
        expected = 0
        inside = 0
        for count, row in enumerate(ordered, 1):
            inside += self.rows[row] == 2
            if inside >= 10:
                expected = count
                break
        self.assertEqual(document['confirmation']['rows'], expected)
        self.assertEqual(document['confirmation']['rowsInSlice'], 10)
        self.assertEqual(document['confirmation']['available'], 60)

    def test_no_confirmation_row_or_answer_is_printed_or_written(self):
        code, out, err = self.run_tool()
        text = out + err + self.out.read_text()
        self.assertEqual(code, 0)
        self.assertNotIn(GOLD_MARK, text)
        for row in range(101, 161):
            self.assertNotRegex(text, rf'"{row}"')

    def test_a_confirmation_list_with_too_few_rows_in_the_slice_is_an_error(self):
        code, _, err = self.run_tool(minimum='21')  # only 20 confirmation rows belong to calculator 2
        self.assertEqual(code, 2)
        self.assertIn('holds only 20 rows of the slice', err)
        self.assertFalse(self.out.exists())


if __name__ == '__main__':
    unittest.main()
