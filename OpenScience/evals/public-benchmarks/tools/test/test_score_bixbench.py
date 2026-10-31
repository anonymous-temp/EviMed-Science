"""Tests of tools/score_bixbench.py: the official str_verifier / range_verifier ports, parsing, aggregation and the judge comparison.

Run: python3 -I -m unittest discover -s tools/test -p 'test_score_bixbench.py'   (from evals/public-benchmarks)
"""
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import score_bixbench as sb  # noqa: E402


def q(n, mode, ideal, rng=None):
    return {'n': n, 'qid': f'q{n}', 'eval_mode': mode, 'ideal': ideal, 'range': rng}


GOLD = {'questions': [
    q(1, 'range_verifier', '(1.50,1.54)', [1.5, 1.54]),
    q(2, 'str_verifier', '1.9E-05'),
    q(3, 'str_verifier', '166'),
    q(4, 'llm_verifier', '0.05'),
    q(5, 'range_verifier', '(24,26)', [24, 26]),
]}


class StrVerifier(unittest.TestCase):
    """graders.py `_grade_str_verifier` with partial_match=True: [^a-zA-Z0-9] removed and lower-cased, equal, or prediction inside target."""

    def test_exact_after_cleaning(self):
        self.assertEqual(sb.str_verdict('1.9E-05', '1.9e-05')[:2], ('correct', 'exact'))
        self.assertEqual(sb.str_verdict('1-50', '1 - 50')[:2], ('correct', 'exact'))
        self.assertEqual(sb.str_verdict('Neutrophil activation', 'neutrophil-activation!')[:2], ('correct', 'exact'))

    def test_partial_is_prediction_inside_target_not_the_reverse(self):
        self.assertEqual(sb.str_verdict('166', '16')[:2], ('correct', 'partial'))     # official: a substring of the target passes
        self.assertEqual(sb.str_verdict('16', '166')[0], 'needs_judge')                # a longer prediction does not
        self.assertEqual(sb.str_verdict('166', '16', partial=False)[0], 'needs_judge')

    def test_no_match_goes_to_the_llm_step(self):
        self.assertEqual(sb.str_verdict('10.6%', 'about 10.6 percent of the genes')[:2], ('needs_judge', 'llm'))

    def test_empty_cleaned_prediction_is_not_a_pass(self):
        # graders.py would return correct (the empty string is inside every target); here it is incorrect.
        self.assertEqual(sb.str_verdict('7', '---')[:2], ('incorrect', 'no-alphanumeric'))
        self.assertEqual(sb.str_verdict('7', '')[0], 'incorrect')


class RangeVerifier(unittest.TestCase):
    """`lower <= float(predicted) <= upper`; the whole-answer float is the official input, the first number is our extraction."""

    def test_official_float_forms(self):
        r = GOLD['questions'][4]
        for answer, want in (('25', 'correct'), ('25%', 'correct'), (' **25.0** ', 'correct'), ('24', 'correct'), ('26', 'correct'),
                             ('26.5', 'incorrect'), ('1,025', 'incorrect'), ('−25', 'incorrect')):
            got = sb.range_verdict(r, answer)
            self.assertEqual((got['verdict'], got['rule']), (want, 'official-float'), answer)

    def test_first_number_extraction_and_later_number_is_a_judge_matter(self):
        r = GOLD['questions'][0]
        self.assertEqual(sb.range_verdict(r, 'The odds ratio is 1.52 (95% CI 1.1-2.0)')['verdict'], 'correct')
        later = sb.range_verdict(r, 'OR 1.9 (CI 1.50-1.54)')
        self.assertEqual((later['verdict'], later['rule']), ('needs_judge', 'first-number'))
        self.assertEqual(sb.range_verdict(r, 'about 3 in 7')['verdict'], 'incorrect')
        self.assertEqual(sb.range_verdict(r, 'unknown')['verdict'], 'incorrect')

    def test_official_only_does_not_extract(self):
        r = GOLD['questions'][0]
        self.assertEqual(sb.range_verdict(r, 'OR = 1.52 (95% CI 1.15-2.00)', official_only=True)['verdict'], 'needs_judge')
        self.assertEqual(sb.range_verdict(r, '1.52', official_only=True)['verdict'], 'correct')

    def test_range_read_from_the_ideal_when_the_item_has_none(self):
        self.assertEqual(sb.range_verdict({'eval_mode': 'range_verifier', 'ideal': '(0.1, 0.2)'}, '0.15')['verdict'], 'correct')
        self.assertEqual(sb.range_verdict({'eval_mode': 'range_verifier', 'ideal': 'n/a'}, '0.15')['verdict'], 'needs_judge')


class Capsule(unittest.TestCase):
    TEXT = ('analysis...\n\n**Final answers:**\n1. The odds ratio is 1.52 (95% CI 1.1-2.0)\n2. 1.9e-05\n3. the count was 166 genes\n'
            '4. 0.05\n5. 25%\n')

    def test_per_question_verdicts(self):
        r = sb.score(self.TEXT, GOLD)
        self.assertEqual(r['extraction'], 'final')
        self.assertEqual([(x['verdict'], x['rule']) for x in r['questions']],
                         [('correct', 'first-number'), ('correct', 'exact'), ('needs_judge', 'llm'), ('correct', 'exact-shortcut'), ('correct', 'official-float')])

    def test_missing_answer_is_incorrect(self):
        r = sb.score('Final answers:\n1. 1.52\n', GOLD)
        self.assertEqual([x['verdict'] for x in r['questions']], ['correct', 'incorrect', 'incorrect', 'incorrect', 'incorrect'])
        self.assertEqual(r['questions'][1]['rule'], 'no-answer')

    def test_aggregate_strict_and_upper_bound_cover_range_and_str_only(self):
        agg = sb.aggregate(sb.score(self.TEXT, GOLD)['questions'])
        d = agg['deterministic']
        self.assertEqual((d['n'], d['correct'], d['incorrect'], d['needs_judge']), (4, 3, 0, 1))
        self.assertAlmostEqual(d['accuracy_strict'], 0.75)
        self.assertAlmostEqual(d['accuracy_upper_bound'], 1.0)
        self.assertEqual(agg['by_mode']['llm_verifier']['n'], 1)


class Compare(unittest.TestCase):
    def test_agreement_disagreement_and_unsettled(self):
        rows = {f'cap#q{n}': r for n, r in enumerate(sb.score(Capsule.TEXT, GOLD)['questions'], 1)}
        judge = {'cap#q1': 'correct', 'cap#q2': 'incorrect', 'cap#q3': 'correct', 'cap#q4': 'correct', 'cap#q5': 'correct'}
        c = sb.compare(rows, judge)
        self.assertEqual((c['settled_by_code'], c['agree'], c['disagree'], c['unsettled_for_judge']), (4, 3, 1, 1))
        self.assertEqual(c['disagreements'][0]['key'], 'cap#q2')
        self.assertEqual(c['unsettled'][0]['key'], 'cap#q3')
        self.assertAlmostEqual(c['agreement'], 0.75)
        self.assertEqual(c['by_mode']['str_verifier']['judge_correct_among_unsettled'], 1)

    def test_a_question_the_judge_did_not_see_is_missing_not_agreed(self):
        rows = {'cap#q1': sb.score(Capsule.TEXT, GOLD)['questions'][0]}
        self.assertEqual(sb.compare(rows, {})['missing_judge_verdict'], 1)


class Cli(unittest.TestCase):
    def test_selftest_and_files(self):
        script = str(HERE.parent / 'score_bixbench.py')
        self.assertEqual(subprocess.run([sys.executable, '-I', script, '--selftest'], capture_output=True).returncode, 0)
        with tempfile.TemporaryDirectory() as tmp:
            tmp = pathlib.Path(tmp)
            (tmp / 'items.jsonl').write_text(json.dumps({'key': 'bixbench/cap', 'gold': GOLD}) + '\n')
            (tmp / 'answers.jsonl').write_text(json.dumps({'key': 'bixbench/cap', 'text': Capsule.TEXT, 'status': 'succeeded'}) + '\n' +
                                               json.dumps({'key': 'bixbench/ignored', 'text': 'x', 'status': 'succeeded'}) + '\n')
            (tmp / 'judge.jsonl').write_text(''.join(json.dumps({'key': f'bixbench/cap#q{n}', 'verdict': 'correct'}) + '\n' for n in range(1, 6)))
            done = subprocess.run([sys.executable, '-I', script, '--items', str(tmp / 'items.jsonl'), '--answers', str(tmp / 'answers.jsonl'),
                                   '--compare', str(tmp / 'judge.jsonl'), '--deterministic-only', '--out', str(tmp / 'scored.jsonl')], capture_output=True, text=True)
            self.assertEqual(done.returncode, 0, done.stderr)
            summary = json.loads(done.stdout)
            self.assertEqual(summary['capsules'], 1)
            self.assertEqual(summary['deterministic']['correct'], 3)
            self.assertEqual(summary['compare']['disagree'], 0)
            scored = [json.loads(l) for l in (tmp / 'scored.jsonl').read_text().splitlines()]
            self.assertEqual(len(scored[0]['questions']), 5)
            # a run that did not succeed has no answer to score, whatever text it left
            (tmp / 'answers.jsonl').write_text(json.dumps({'key': 'bixbench/cap', 'text': Capsule.TEXT, 'status': 'timeout'}) + '\n')
            timed = subprocess.run([sys.executable, '-I', script, '--items', str(tmp / 'items.jsonl'), '--answers', str(tmp / 'answers.jsonl'),
                                    '--deterministic-only'], capture_output=True, text=True)
            self.assertEqual(json.loads(timed.stdout)['deterministic']['correct'], 0)


if __name__ == '__main__':
    unittest.main()
