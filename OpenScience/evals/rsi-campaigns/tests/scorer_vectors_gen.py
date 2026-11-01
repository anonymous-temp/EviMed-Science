"""Test vectors for the lab's deterministic scorers (skill_scorers.mjs), from the Python side.

  python3 -I evals/rsi-campaigns/tests/scorer_vectors_gen.py            # rewrite tests/fixtures/scorer-vectors.json

Every input is SYNTHETIC (invented titles, invented numbers); nothing here comes from a benchmark's questions or answers.
The expected values are produced by code that is not the JS port:
  arb-deep / arb-wide  evals/public-benchmarks/tools/score_arb.py itself (imported read-only: score_deep, score_wide)
  ratio                the standard library's difflib.SequenceMatcher(None, a, b).ratio(), the function score_arb.py's title
                       similarity is built on (the JS port reimplements it, autojunk included)
  bixbench             `bixbench_reference` below: a small independent Python implementation of the OFFICIAL graders
                       (Future-House/BixBench bixbench/graders.py, read 2026-10-31) over score_bixbench.py's answer parsing.
tests/test_scorer_vectors.py rebuilds the vectors from these functions and fails when the file or either scorer has drifted;
tests/skillScorers.test.mjs asserts the JS ports reproduce the file.
"""
import difflib
import importlib.util
import json
import random
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
FIXTURE = HERE / 'fixtures' / 'scorer-vectors.json'
TOOLS = HERE.parents[1] / 'public-benchmarks' / 'tools'


def _load(name):
    spec = importlib.util.spec_from_file_location(name, TOOLS / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ---------------------------------------------------------------------------------------------------------- BixBench
FINAL = re.compile(r'final\s*answers?\s*(?:\*\*)?\s*[:：]?\s*(?:\*\*)?\s*$', re.IGNORECASE | re.MULTILINE)
LINE_NO = re.compile(r'^\s*(?:[-*>]\s*)?\**\s*(\d{1,2})\s*[.):]\s*\**\s*(.*)$')
NUM = re.compile(r'(?<![\w.])[-+]?\d+(?:,\d{3})*(?:\.\d+)?(?:[eE][-+]?\d+)?')


def strip_md(s):
    return re.sub(r'[*`_]+', '', s or '').strip()


def parse_answers(text):
    marks = list(FINAL.finditer(text or ''))
    region, extraction = (text[marks[-1].end():], 'final') if marks else (text or '', 'fallback')
    raw, cur = {}, None
    for line in region.splitlines():
        m = LINE_NO.match(line)
        if m:
            cur = int(m.group(1))
            raw[cur] = m.group(2).strip()
        elif cur is not None and line.strip():
            raw[cur] += ' ' + line.strip()
    return {n: strip_md(a) for n, a in raw.items()}, extraction


def alnum(s):
    return re.sub(r'[^a-zA-Z0-9]', '', s).lower()


def deterministic(q):
    return q['eval_mode'] == 'str_verifier' or (q['eval_mode'] == 'range_verifier' and q.get('range') is not None)


def verdict(q, answer):
    """The official graders for open answers, with the one stated deviation (an empty cleaned answer is not correct)."""
    if answer is None or not answer.strip():
        return 'incorrect'
    if q['eval_mode'] == 'str_verifier':
        got, want = alnum(answer), alnum(q['ideal'])
        if not got:
            return 'incorrect'
        return 'correct' if got == want or got in want else 'needs_judge'
    if q['eval_mode'] == 'range_verifier' and q.get('range') is not None:
        lo, hi = q['range']
        nums = []
        for m in NUM.finditer(answer):
            try:
                nums.append(float(m.group(0).replace(',', '')))
            except ValueError:
                pass
        if not nums:
            return 'incorrect'
        if lo <= nums[0] <= hi:
            return 'correct'
        return 'needs_judge' if any(lo <= n <= hi for n in nums[1:]) else 'incorrect'
    return 'needs_judge'


def bixbench_reference(text, gold):
    answers, extraction = parse_answers(text)
    verdicts = [verdict(q, answers.get(q['n'])) for q in gold['questions']]
    flags = [deterministic(q) for q in gold['questions']]
    scored = [v for v, f in zip(verdicts, flags) if f]
    return {'extraction': extraction, 'answers': {str(n): a for n, a in sorted(answers.items())}, 'verdicts': verdicts,
            'deterministic': flags, 'score': sum(v == 'correct' for v in scored) / len(scored)}


def q(n, mode, ideal, rng=None):
    return {'n': n, 'qid': f'syn-q{n}', 'eval_mode': mode, 'ideal': ideal, 'range': rng}


BIX_GOLD = {'questions': [q(1, 'range_verifier', '(1.50,1.54)', [1.5, 1.54]), q(2, 'str_verifier', '1-50'), q(3, 'llm_verifier', '35%'),
                          q(4, 'range_verifier', '(0.024,0.026)', [0.024, 0.026]), q(5, 'str_verifier', '166'), q(6, 'range_verifier', '(24,26)', [24, 26])]}
BIX_CASES = [
    ('all-right-bold-marker', '**Final answers:**\n1. OR = 1.52 (95% CI 1.1-2.0)\n2. 1-50\n3. about 35 percent\n4. p = 0.025\n5. 166\n6. 25%', BIX_GOLD),
    ('en-dash-and-case', 'notes\nFinal answers:\n1. 1.5\n2. 1–50\n3. 35%\n4. 0.0251\n5. one hundred sixty six\n6. 24', BIX_GOLD),
    ('later-number-inside', 'Final answers:\n1. The CI is 1.1-2.0 and the odds ratio is 1.52\n2. 51-100\n3. n/a\n4. 0.031\n5. 17\n6. 25.5', BIX_GOLD),
    ('first-number-wins', 'Final answers:\n1. 2 groups, OR 1.52\n2. 1-50\n3. 1\n4. 0.025 (permutation 0.4)\n5. 166 genes\n6. 0.25 (25%)', BIX_GOLD),
    ('partial-substring-is-official', 'Final answers:\n1. 1.51\n2. 1\n3. 35\n4. 0.0255\n5. 6\n6. 26', BIX_GOLD),
    ('empty-and-markdown-only', 'Final answers:\n1. **\n2. ***\n3.\n4. __\n5. `166`\n6. not available', BIX_GOLD),
    ('missing-questions', 'Final answers:\n1. 1.52\n5. 166', BIX_GOLD),
    ('no-marker-fallback', 'Some analysis first.\n1. 1.52\n2. 1-50\n3. 35%\n4. 0.025\n5. 166\n6. 25', BIX_GOLD),
    ('last-marker-wins', 'Final answers:\n1. 9.9\n2. 9\n\nrevised below\n\n**Final answers**\n1. 1.52\n2. 1-50\n3. 35%\n4. 0.025\n5. 166\n6. 24.5', BIX_GOLD),
    ('numbering-styles', 'Final answer\n1) 1.52\n  2: 1-50\n- 3. 35%\n**4.** 0.025\n> 5. 166\n6. 25', BIX_GOLD),
    ('continuation-lines', 'Final answers:\n1. The odds ratio\n   is 1.52 overall\n2. 1-50\n   patients\n4. p =\n0.025', BIX_GOLD),
    ('crlf-and-fullwidth-colon', 'Final answers：\r\n1. 1.52\r\n2. 1-50\r\n4. 0.025\r\n5. 166\r\n6. 25', BIX_GOLD),
    ('thousands-sign-exponent', 'Final answers:\n1. 1,52\n2. -1-50\n3. 1\n4. 2.5e-2\n5. 1,66\n6. +25', BIX_GOLD),
    ('unicode-letter-before-number', 'Final answers:\n1. x1.52\n2. 1-50\n3. 1\n4. α0.025\n5. 166\n6. n25', BIX_GOLD),
    ('range-given-as-text-only', 'Final answers:\n1. 1.52\n2. 1-50',
     {'questions': [q(1, 'range_verifier', 'between 1 and 2', None), q(2, 'str_verifier', '1-50'), q(3, 'llm_verifier', 'x')]}),
    ('str-ideal-with-punctuation', 'Final answers:\n1. 1.9e-05\n2. 1.9E-05\n3. Neutrophil activation\n4. 10.6 %',
     {'questions': [q(1, 'str_verifier', '1.9E-05'), q(2, 'str_verifier', '1.9E-05'), q(3, 'str_verifier', 'neutrophil  activation'), q(4, 'str_verifier', '10.6%')]}),
]


# --------------------------------------------------------------------------------------------------------------- ARB
DEEP_GOLD = {'type': 'deep', 'titles': ['Gradient Methods For Sparse Tensor Completion Under Adversarial Noise'], 'arxiv_ids': ['2208.01234'], 'is_none': False}
DEEP_NONE = {'type': 'deep', 'titles': ['None'], 'arxiv_ids': [''], 'is_none': True}
DEEP_OLD = {'type': 'deep', 'titles': ['A Study Of Lattice Embeddings In Graph Spectra'], 'arxiv_ids': ['math/9811157'], 'is_none': False}
LONG_TITLE = ('A Comprehensive Empirical Investigation Of Hierarchical Attention Mechanisms For Long Context Sequence Modeling '
              'In Low Resource Settings With Applications To Clinical Text Retrieval And Biomedical Question Answering Systems '
              'Evaluated Across Multiple Languages And Domains')
DEEP_LONG = {'type': 'deep', 'titles': [LONG_TITLE], 'arxiv_ids': ['2301.99999'], 'is_none': False}
DEEP_CASES = [
    ('id-in-parentheses', 'work...\nFinal answer: Sparse tensors (arXiv:2208.01234)', DEEP_GOLD),
    ('id-with-version', 'Final answer: another wording entirely arXiv:2208.01234v3', DEEP_GOLD),
    ('title-exact-bold', '**Final answer:** Gradient Methods For Sparse Tensor Completion Under Adversarial Noise', DEEP_GOLD),
    ('title-truncated', 'Final answer: Gradient Methods For Sparse Tensor Completion ...', DEEP_GOLD),
    ('title-short-prefix-not-enough', 'Final answer: Gradient Methods For Sparse', DEEP_GOLD),
    ('title-case-and-punctuation', 'Final answer: gradient methods for sparse tensor completion: under adversarial noise (arXiv:2001.00001)', DEEP_GOLD),
    ('title-one-word-different', 'Final answer: Gradient Methods For Sparse Tensor Completion Under Adversarial Noises', DEEP_GOLD),
    ('title-two-words-different', 'Final answer: Gradient Methods For Dense Tensor Factorization Under Adversarial Noise', DEEP_GOLD),
    ('title-close-wording', 'Final answer: Sparse Tensor Completion With Gradient Methods Under Noise', DEEP_GOLD),
    ('wrong-paper', 'Final answer: Attention Is All You Need (arXiv:1706.03762)', DEEP_GOLD),
    ('answered-none', 'Final answer: None', DEEP_GOLD),
    ('no-marker-last-lines', 'I searched.\nThe paper is Gradient Methods For Sparse Tensor Completion Under Adversarial Noise', DEEP_GOLD),
    ('no-marker-no-title', 'I could not find it.', DEEP_GOLD),
    ('empty', '', DEEP_GOLD),
    ('first-candidate-only', 'Final answer:\n1. Attention Is All You Need (arXiv:1706.03762)\n2. Gradient Methods For Sparse Tensor Completion Under Adversarial Noise (arXiv:2208.01234)', DEEP_GOLD),
    ('markdown-link', 'Final answer: [Whatever it is called](https://arxiv.org/abs/2208.01234v2)', DEEP_GOLD),
    ('old-style-id', 'Final answer: Lattice things (arXiv:math/9811157v2)', DEEP_OLD),
    ('old-style-id-wrong', 'Final answer: Lattice things (arXiv:math/9811158)', DEEP_OLD),
    ('gold-none-right', 'reasoning\n**Final answer:** **None**.', DEEP_NONE),
    ('gold-none-no-paper-found', 'Final answer: no paper found', DEEP_NONE),
    ('gold-none-wrong', 'Final answer: Some Paper Title Here (arXiv:2001.00001)', DEEP_NONE),
    ('gold-none-no-marker', 'None', DEEP_NONE),
    ('last-marker-wins', 'Final answer: None\n\nFinal answer: Gradient Methods For Sparse Tensor Completion Under Adversarial Noise', DEEP_GOLD),
    ('long-title-exact', f'Final answer: {LONG_TITLE}', DEEP_LONG),
    ('long-title-word-swapped', 'Final answer: ' + LONG_TITLE.replace('Hierarchical', 'Recurrent').replace('Biomedical', 'Clinical'), DEEP_LONG),
    ('long-title-tail-cut', 'Final answer: ' + LONG_TITLE[:-40], DEEP_LONG),
    ('long-title-reordered', 'Final answer: Evaluated Across Multiple Languages And Domains ' + LONG_TITLE[:120], DEEP_LONG),
]
WIDE_GOLD = {'type': 'wide', 'titles': ['Alpha Beta Gamma Method For Signals', 'Delta Epsilon Zeta Study Of Networks', 'Old Style Paper On Random Graphs', 'Fourth Paper Title About Kernels'],
             'arxiv_ids': ['2301.00001', '2302.12345', 'cs/0409043', '2303.00004'], 'is_none': False}
WIDE_CASES = [
    ('all-four', 'x\nFinal answer:\n1. Alpha Beta Gamma Method For Signals (arXiv:2301.00001)\n2. Delta Epsilon Zeta Study Of Networks (arXiv:2302.12345)\n'
                 '3. Old Style Paper On Random Graphs (arXiv:cs/0409043)\n4. Fourth Paper Title About Kernels (arXiv:2303.00004v2)', WIDE_GOLD),
    ('half-with-extras', 'Final answer:\n- Alpha Beta Gamma Method For Signals (arXiv:2301.00001)\n- Delta Epsilon Zeta Study Of Networks (arXiv:2302.12345)\n'
                         '- Unrelated Extra Paper Here (arXiv:2399.99999)\n- Another Extra Paper Here (arXiv:2399.99998)', WIDE_GOLD),
    ('links', 'Final answer:\n* [Alpha Beta Gamma Method For Signals](https://arxiv.org/abs/2301.00001)\n* [Old Style Paper On Random Graphs](https://arxiv.org/abs/cs/0409043v1)', WIDE_GOLD),
    ('title-only-rescued', 'Final answer:\nAlpha Beta Gamma Method For Signals\nDelta Epsilon Zeta Study Of Networks', WIDE_GOLD),
    ('wrong-id-right-title', 'Final answer:\nAlpha Beta Gamma Method For Signals (arXiv:2301.99999)', WIDE_GOLD),
    ('short-title-not-rescued', 'Final answer:\nAlpha Beta', WIDE_GOLD),
    ('none-answer', 'Final answer: None', WIDE_GOLD),
    ('nothing', 'I give up.', WIDE_GOLD),
    ('no-marker-whole-reply', 'Candidates I found: Alpha Beta Gamma Method For Signals arXiv:2301.00001 and Fourth Paper Title About Kernels (arXiv:2303.00004)', WIDE_GOLD),
    ('last-marker-wins', 'Final answer:\nWrong One Paper Title (arXiv:2399.99999)\n\nFinal answer:\nAlpha Beta Gamma Method For Signals (arXiv:2301.00001)', WIDE_GOLD),
    ('duplicates-and-headings', 'Final answer:\n## Results\n---\n1. Alpha Beta Gamma Method For Signals (arXiv:2301.00001)\n2. Alpha Beta Gamma Method For Signals (arXiv:2301.00001v2)\n3. Delta Epsilon Zeta Study Of Networks (arXiv:2302.12345)', WIDE_GOLD),
    ('old-style-uppercase', 'Final answer:\nSomething Old (arXiv:CS/0409043)\nFourth Paper Title About Kernels (arXiv:2303.00004)', WIDE_GOLD),
    ('four-extras-only', 'Final answer:\n1. Extra One Paper Title (arXiv:2399.00001)\n2. Extra Two Paper Title (arXiv:2399.00002)\n3. Extra Three Paper Title (arXiv:2399.00003)\n4. Extra Four Paper Title (arXiv:2399.00004)', WIDE_GOLD),
]


def ratio_pairs():
    """Pairs of strings (a seeded generator): small alphabets and repeats, short and past the autojunk threshold of 200."""
    rng = random.Random(20261031)
    pairs = []
    for index in range(48):
        alphabet = 'ab cd' if index % 3 == 0 else 'abcdefghij klm' if index % 3 == 1 else 'abcdefghijklmnopqrstuvwxyz0123456789  '
        length = rng.choice([0, 1, 5, 12, 40, 90, 199, 200, 201, 260, 400])
        a = ''.join(rng.choice(alphabet) for _ in range(length))
        # b is a perturbed copy of a most of the time, a fresh string otherwise
        if index % 4 == 3:
            b = ''.join(rng.choice(alphabet) for _ in range(rng.choice([1, 30, 210, 350])))
        else:
            chars = list(a)
            for _ in range(max(1, len(chars) // 8)):
                if chars and rng.random() < 0.5:
                    del chars[rng.randrange(len(chars))]
                else:
                    chars.insert(rng.randrange(len(chars) + 1), rng.choice(alphabet))
            b = ''.join(chars)
        pairs.append([a, b])
    return pairs


def build():
    arb = _load('score_arb')
    return {
        'schema': 1,
        'note': ('Synthetic inputs; expected values come from score_arb.py (arb-deep, arb-wide), difflib (ratio) and the independent official-grader reference in '
                 'tests/scorer_vectors_gen.py (bixbench). Regenerate with python3 -I tests/scorer_vectors_gen.py.'),
        'bixbenchWiring': ('score_bixbench.py is being rewritten to the official verifiers (2026-10-31). Once it exposes a per-question verdict, compare it with '
                           'these verdicts (correct / incorrect / needs_judge; needs_judge is a judge call, which the deterministic consumer counts as not correct) '
                           'and with `answers`; the lead wires that comparison, nothing here depends on its API.'),
        'ratio': [{'a': a, 'b': b, 'ratio': difflib.SequenceMatcher(None, a, b).ratio()} for a, b in ratio_pairs()],
        'arbDeep': [{'name': name, 'text': text, 'gold': gold, 'verdict': (r := arb.score_deep(text, gold))['verdict'], 'score': 1 if r['verdict'] == 'correct' else 0}
                    for name, text, gold in DEEP_CASES],
        'arbWide': [{'name': name, 'text': text, 'gold': gold, 'iou': arb.score_wide(text, gold)['iou']} for name, text, gold in WIDE_CASES],
        'bixbench': [{'name': name, 'text': text, 'gold': gold, **bixbench_reference(text, gold)} for name, text, gold in BIX_CASES],
    }


if __name__ == '__main__':
    FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE.write_text(json.dumps(build(), ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    print(f'wrote {FIXTURE}')
