"""Tests of tools/claude_judge.py against a fake `claude` binary (fake_claude_judge.py): the Claude-only rule, blindness and confinement of a call,
validation of verdicts, resume, quota stop, and the remap into the shape export_harness_arms.py reads.

Run: python3 -I -m unittest discover -s tools/test -p 'test_claude_judge.py'   (from evals/public-benchmarks)
"""
import contextlib
import io
import json
import os
import pathlib
import sys
import tempfile
import types
import unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import claude_judge as cj  # noqa: E402
import export_harness_arms as eha  # noqa: E402

FAKE = HERE / 'fake_claude_judge.py'
BRIEF = 'You judge one packet. Your packet is your current working directory.\n'
CRITERIA = {'dimension_weight': {'insight': 0.5, 'readability': 0.5},
            'criterions': {'insight': [{'criterion': 'a', 'weight': 1.0}, {'criterion': 'b', 'weight': 1.0}], 'readability': [{'criterion': 'c', 'weight': 1.0}]}}


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text if isinstance(text, str) else json.dumps(text), encoding='utf-8')


def make_packets(root):
    """bixbench (2 passes, 2 questions), rcb (2 passes, the second linked to the first like judged_packets_round.py writes it), drb pairwise and absolute."""
    judge = pathlib.Path(root) / 'judge'
    for k in (1, 2):
        d = judge / 'bixbench' / 'b1' / f'pass{k}'
        write(d / 'questions.json', {'questions': [{'qid': 'q1', 'ideal': 'x'}, {'qid': 'q2', 'ideal': 'y'}]})
        write(d / 'answer.md', 'answers')
        write(d / 'meta.json', {'key': 'bixbench/b1', 'pass': k, 'delivery': 'complete'})
    first = judge / 'rcb' / 'r1' / 'pass1'
    write(first / 'target_study' / 'checklist.json', [{'id': 0}, {'id': 1}, {'id': 2}])
    write(first / 'run_files' / 'fig.txt', 'figure')
    for k in (1, 2):
        d = judge / 'rcb' / 'r1' / f'pass{k}'
        write(d / 'task.txt', 'task')
        write(d / 'report.md', '# report')
        write(d / 'meta.json', {'key': 'rcb/r1', 'pass': k, 'delivery': 'complete'})
        if k == 2:
            for name in ('target_study', 'run_files'):
                (d / name).symlink_to(os.path.relpath(first / name, d))
    write(judge / 'drb-pair-1' / '30' / 'pass1' / 'criteria.json', CRITERIA)
    write(judge / 'drb-pair-1' / '30' / 'pass1' / 'report_1.md', 'one')
    write(judge / 'drb-pair-1' / '30' / 'pass1' / 'report_2.md', 'two')
    write(judge / 'drb-pair-1' / '30' / 'pass1' / 'meta.json', {'key': 'drb-pair/30/p1', 'criteria': 3})
    write(judge / 'drb-abs' / 'a1' / 'pass1' / 'criteria.json', CRITERIA)
    write(judge / 'drb-abs' / 'a1' / 'pass1' / 'target.md', 'target')
    write(judge / 'drb-abs' / 'a1' / 'pass1' / 'reference.md', 'reference')
    write(judge / 'drb-abs' / 'a1' / 'pass1' / 'meta.json', {'key': 'drb-abs/a1', 'pass': 1, 'delivery': 'complete'})
    return judge


class Judge(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix='claude-judge-test-'))
        self.addCleanup(__import__('shutil').rmtree, self.tmp, True)
        self.judge = make_packets(self.tmp / 'packets')
        self.parts = self.tmp / 'parts'
        self.brief = self.tmp / 'brief.md'
        self.brief.write_text(BRIEF)
        self.log = self.tmp / 'fake.jsonl'
        (self.tmp / 'state').mkdir()
        self.env = {'FAKE_JUDGE_LOG': str(self.log), 'FAKE_JUDGE_STATE': str(self.tmp / 'state')}
        saved = {k: os.environ.get(k) for k in self.env}
        os.environ.update(self.env)
        self.addCleanup(lambda: [os.environ.pop(k, None) if v is None else os.environ.__setitem__(k, v) for k, v in saved.items()])
        self.addCleanup(lambda: [os.environ.pop(k, None) for k in ('FAKE_JUDGE_MODE', 'FAKE_JUDGE_FAIL_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'DEEPSEEK_API_KEY',
                                                                   'DASHSCOPE_API_KEY')])

    def run_judge(self, packets, dialect, *extra, model='claude-sonnet-5-5', effort='medium', judge_id='claude-judge-test', parts=None):
        argv = ['judge', str(packets), '--model', model, '--dialect', dialect, '--brief', str(self.brief), '--parts', str(parts or self.parts),
                '--claude', str(FAKE), '--retry-wait', '0', '--concurrency', '2', *(['--effort', effort] if effort else []),
                *(['--judge-id', judge_id] if judge_id else []), *extra]
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = cj.main(argv)
        return code, out.getvalue(), err.getvalue()

    def calls(self):
        return [json.loads(l) for l in self.log.read_text().splitlines()] if self.log.exists() else []

    def part(self, name, parts=None):
        return [json.loads(l) for l in ((parts or self.parts) / name).read_text().splitlines()]

    # ---- who judges
    def test_a_model_that_is_not_claude_is_refused_before_anything_runs(self):
        for model in ('deepseek-v4-pro', 'deepseek-flash', 'qwen3.8-max', 'claude-opus-5-5[1m]', 'Claude-opus-5-5', '', 'gpt-5.5', 'claude-opus-5-5\n'):
            code, _, err = self.run_judge(self.judge / 'bixbench', 'questions', model=model)
            self.assertEqual(code, 2, model)
            self.assertIn('Claude', err)
        # the effort and the judge id are part of what judges: both are required, the effort one of the CLI's levels
        for kw in ({'effort': None}, {'effort': 'turbo'}, {'judge_id': None}, {'judge_id': 'two words'}):
            with contextlib.redirect_stderr(io.StringIO()):
                try:
                    code = self.run_judge(self.judge / 'bixbench', 'questions', **kw)[0]
                except SystemExit as stop:
                    code = stop.code
            self.assertEqual(code, 2, kw)
        self.assertEqual(self.calls(), [])
        self.assertFalse(self.parts.exists())

    def test_one_independent_call_per_packet_and_pass_on_the_chosen_model(self):
        code, out, err = self.run_judge(self.judge / 'bixbench', 'questions', model='claude-opus-5-5')
        self.assertEqual(code, 0, err)
        calls = self.calls()
        self.assertEqual(sorted((c['key'], c['pass']) for c in calls), [('bixbench/b1', 1), ('bixbench/b1', 2)])
        self.assertTrue(all((c['model'], c['effort']) == ('claude-opus-5-5', 'medium') for c in calls))
        self.assertEqual(sorted(p.name for p in self.parts.glob('*.jsonl')), ['bixbench__b1.p1.jsonl', 'bixbench__b1.p2.jsonl'])
        record = json.loads((self.parts / 'judge.json').read_text())
        self.assertEqual({k: record[k] for k in ('schema', 'model', 'effort', 'judge', 'dialect')},
                         {'schema': 'claude-judge/2', 'model': 'claude-opus-5-5', 'effort': 'medium', 'judge': 'claude-judge-test', 'dialect': 'questions'})
        # the same model at another effort is another judge: a resume with it is refused
        code, _, err = self.run_judge(self.judge / 'bixbench', 'questions', model='claude-opus-5-5', effort='high')
        self.assertEqual(code, 2)
        self.assertIn('effort', err)

    # ---- what a call can see and do
    def test_a_call_is_confined_blind_and_keeps_no_session(self):
        os.environ.update({'ANTHROPIC_AUTH_TOKEN': 'x', 'ANTHROPIC_BASE_URL': 'https://api.deepseek.com/anthropic', 'DEEPSEEK_API_KEY': 'y', 'DASHSCOPE_API_KEY': 'z'})
        code, _, err = self.run_judge(self.judge / 'rcb', 'score')
        self.assertEqual(code, 0, err)
        for call in self.calls():
            for flag in ('-p', '--safe-mode', '--restricted', '--no-session-persistence', '--permission-mode', '--tools'):
                self.assertIn(flag, call['flags'])
            self.assertNotIn('--dangerously-skip-permissions', call['flags'])
            self.assertEqual((call['tools'], call['permission_mode']), ('Read,Glob,Grep', 'dontAsk'))
            self.assertEqual(call['leaked_env'], [])  # no credential, endpoint or login override of the starting shell
            self.assertEqual(call['links'], [])  # the linked trees of a pass-2 packet are real files in the copy
            self.assertEqual(call['files'], ['meta.json', 'report.md', 'run_files/fig.txt', 'target_study/checklist.json', 'task.txt'])
            self.assertEqual(call['cwd_name'], 'packet')
            self.assertFalse(call['cwd_path'].startswith(str(self.judge)))  # not the packet's own directory, and nothing of its name in the path
        # one brief for every call, the packets themselves untouched
        self.assertEqual(len({c['prompt_sha'] for c in self.calls()}), 1)
        self.assertEqual(sorted(p.name for p in (self.judge / 'rcb' / 'r1' / 'pass1').iterdir()), ['meta.json', 'report.md', 'run_files', 'target_study', 'task.txt'])
        self.assertTrue((self.judge / 'rcb' / 'r1' / 'pass2' / 'target_study').is_symlink())

    def test_the_scratch_copies_are_gone_afterwards(self):
        scratch = self.tmp / 'scratch'
        scratch.mkdir()
        code, _, err = self.run_judge(self.judge / 'bixbench', 'questions', '--scratch', str(scratch))
        self.assertEqual(code, 0, err)
        self.assertEqual(list(scratch.iterdir()), [])

    # ---- the four dialects
    def test_bixbench_verdicts_are_written_per_question_and_stamped(self):
        self.run_judge(self.judge / 'bixbench', 'questions', '--judge-id', 'claude-sonnet-5-5-bix')
        lines = self.part('bixbench__b1.p2.jsonl')
        self.assertEqual([(l['key'], l['verdict']) for l in lines], [('bixbench/b1#q1', 'correct'), ('bixbench/b1#q2', 'incorrect')])
        self.assertTrue(all((l['pass'], l['delivery'], l['judge'], l['model'], l['effort']) == (2, 'complete', 'claude-sonnet-5-5-bix', 'claude-sonnet-5-5', 'medium') for l in lines))

    def test_rcb_race_and_pairwise_verdicts(self):
        rcb = self.tmp / 'p-rcb'
        self.assertEqual(self.run_judge(self.judge / 'rcb', 'score', parts=rcb)[0], 0)
        self.assertEqual(self.part('rcb__r1.p1.jsonl', rcb)[0]['score'], 60)
        race = self.tmp / 'p-race'
        self.assertEqual(self.run_judge(self.judge / 'drb-abs', 'race', parts=race)[0], 0)
        self.assertEqual(self.part('drb-abs__a1.p1.jsonl', race)[0]['race'], 0.4)
        pair = self.tmp / 'p-pair'
        self.assertEqual(self.run_judge(self.judge / 'drb-pair-1', 'pairwise', parts=pair)[0], 0)
        row = self.part('drb-pair__30__p1.p1.jsonl', pair)[0]
        self.assertEqual(row['key'], 'drb-pair/30/p1')
        self.assertNotIn('pass', row)  # the pairwise packet's meta has no pass: nothing is invented
        self.assertEqual(sorted(row['scores']), ['insight', 'readability'])

    def test_an_answer_in_a_code_fence_is_read(self):
        os.environ['FAKE_JUDGE_MODE'] = 'fence'
        self.assertEqual(self.run_judge(self.judge / 'drb-abs', 'race')[0], 0)
        self.assertEqual(self.run_judge(self.judge / 'bixbench', 'questions', parts=self.tmp / 'fb')[0], 0)
        self.assertEqual(len(self.part('bixbench__b1.p1.jsonl', self.tmp / 'fb')), 2)

    def test_a_verdict_that_does_not_match_its_packet_is_never_written(self):
        os.environ['FAKE_JUDGE_MODE'] = 'short'  # one question, one rubric item, one criterion missing
        for name, dialect in (('bixbench', 'questions'), ('rcb', 'score'), ('drb-pair-1', 'pairwise')):
            parts = self.tmp / f'short-{name}'
            code, out, _ = self.run_judge(self.judge / name, dialect, '--attempts', '2', parts=parts)
            self.assertEqual(code, 3, name)
            self.assertEqual(list(parts.glob('*.jsonl')), [], name)
            self.assertIn('failed', out)
        log = (self.tmp / 'short-bixbench' / 'judge.log').read_text()
        self.assertIn('FAILED bixbench/b1 p1: judge_verdict_mismatch', log)

    def test_race_must_be_target_over_target_plus_reference(self):
        os.environ['FAKE_JUDGE_MODE'] = 'bad_race'
        code, _, _ = self.run_judge(self.judge / 'drb-abs', 'race', '--attempts', '1')
        self.assertEqual(code, 3)
        self.assertEqual(list(self.parts.glob('*.jsonl')), [])

    # ---- resume, retries, stops
    def test_an_invalid_answer_is_asked_again(self):
        os.environ['FAKE_JUDGE_MODE'] = 'bad_first'
        code, _, err = self.run_judge(self.judge / 'bixbench', 'questions')
        self.assertEqual(code, 0, err)
        self.assertEqual(sorted(c['call'] for c in self.calls()), [1, 1, 2, 2])

    def test_a_run_continues_where_it_stopped(self):
        parts = self.tmp / 'resume'
        os.environ.update({'FAKE_JUDGE_MODE': 'fail_key', 'FAKE_JUDGE_FAIL_KEY': 'bixbench/b1'})
        self.assertEqual(self.run_judge(self.judge / 'bixbench', 'questions', '--attempts', '1', parts=parts)[0], 3)  # both passes fail
        self.assertEqual(list(parts.glob('*.jsonl')), [])
        (parts / 'bixbench__b1.p1.jsonl').write_text('{"key": "kept"}\n')  # a verdict from an earlier run is never asked for again
        self.log.unlink()
        os.environ['FAKE_JUDGE_MODE'] = 'ok'
        self.assertEqual(self.run_judge(self.judge / 'bixbench', 'questions', parts=parts)[0], 0)
        self.assertEqual([(c['key'], c['pass']) for c in self.calls()], [('bixbench/b1', 2)])
        self.assertEqual(self.part('bixbench__b1.p1.jsonl', parts), [{'key': 'kept'}])

    def test_a_resume_with_another_model_brief_or_dialect_is_refused(self):
        self.assertEqual(self.run_judge(self.judge / 'bixbench', 'questions')[0], 0)
        before = len(self.calls())
        code, _, err = self.run_judge(self.judge / 'bixbench', 'questions', model='claude-opus-5-5')
        self.assertEqual(code, 2)
        self.assertIn('model', err)
        self.brief.write_text(BRIEF + 'more\n')
        code, _, err = self.run_judge(self.judge / 'bixbench', 'questions')
        self.assertEqual((code, 'briefSha256' in err), (2, True))
        self.assertEqual(len(self.calls()), before)

    def test_a_quota_stop_ends_the_run_at_once_and_says_to_come_back(self):
        os.environ['FAKE_JUDGE_MODE'] = 'quota'
        code, out, err = self.run_judge(self.judge / 'bixbench', 'questions', '--attempts', '3', '--concurrency', '1')
        self.assertEqual(code, 3)
        self.assertEqual(len(self.calls()), 1)  # not three attempts, not the second packet
        self.assertIn('judge_quota', err)
        self.assertIn('0 failed', out)
        self.assertIn('FAILED bixbench/b1 p1: judge_quota', (self.parts / 'judge.log').read_text())
        os.environ['FAKE_JUDGE_MODE'] = 'ok'
        self.assertEqual(self.run_judge(self.judge / 'bixbench', 'questions')[0], 0)

    def test_a_refused_login_stops_the_run_and_an_overloaded_service_is_asked_again(self):
        os.environ['FAKE_JUDGE_MODE'] = 'auth'
        code, _, err = self.run_judge(self.judge / 'bixbench', 'questions', '--attempts', '3', '--concurrency', '1', parts=self.tmp / 'auth')
        self.assertEqual((code, len(self.calls())), (3, 1))
        self.assertIn('judge_auth', err)
        # overloaded is the service's moment, not the login's window: asked again, never a stop
        self.log.unlink()
        (self.tmp / 'state-busy').mkdir()
        os.environ.update({'FAKE_JUDGE_MODE': 'overloaded_first', 'FAKE_JUDGE_STATE': str(self.tmp / 'state-busy')})  # call counters from 1 again
        code, _, err = self.run_judge(self.judge / 'bixbench', 'questions', '--concurrency', '1', parts=self.tmp / 'busy')
        self.assertEqual(code, 0, err)
        self.assertEqual(sorted(c['call'] for c in self.calls()), [1, 1, 2, 2])
        self.log.unlink()
        os.environ['FAKE_JUDGE_MODE'] = 'overloaded'
        code, out, err = self.run_judge(self.judge / 'bixbench', 'questions', '--attempts', '2', '--concurrency', '1', parts=self.tmp / 'down')
        self.assertEqual(code, 3)
        self.assertEqual(len(self.calls()), 4, 'two packets, two attempts each: no stop')
        self.assertIn('2 failed', out)
        self.assertNotIn('stopped', err)
        self.assertIn('FAILED bixbench/b1 p1: judge_transport', (self.tmp / 'down' / 'judge.log').read_text())

    def test_nothing_the_cli_printed_reaches_the_log_or_an_error(self):
        for mode, dialect, packets in (('quota', 'questions', 'bixbench'), ('auth', 'questions', 'bixbench'), ('overloaded', 'questions', 'bixbench'),
                                       ('crash', 'race', 'drb-abs'), ('always_bad', 'race', 'drb-abs')):
            os.environ['FAKE_JUDGE_MODE'] = mode
            parts = self.tmp / f'leak-{mode}'
            code, out, err = self.run_judge(self.judge / packets, dialect, '--attempts', '2', parts=parts)
            self.assertEqual(code, 3, mode)
            log = (parts / 'judge.log').read_text()
            for text in (log, out, err):
                self.assertNotIn('LEAK', text, mode)
            codes = {line.split(': ')[-1].split(' (')[0] for line in log.splitlines() if 'FAILED' in line}
            self.assertTrue(codes and codes <= set(cj.CALL_FAILURES), (mode, codes))

    def test_a_crashed_cli_and_a_call_past_its_time_are_failed_attempts(self):
        os.environ['FAKE_JUDGE_MODE'] = 'crash'
        self.assertEqual(self.run_judge(self.judge / 'drb-abs', 'race', '--attempts', '2')[0], 3)
        self.assertEqual(len(self.calls()), 2)
        os.environ['FAKE_JUDGE_MODE'] = 'hang'
        parts = self.tmp / 'hang'
        code, _, _ = self.run_judge(self.judge / 'drb-abs', 'race', '--attempts', '1', '--timeout', '1', parts=parts)
        self.assertEqual(code, 3)
        self.assertIn('judge_timeout', (parts / 'judge.log').read_text())

    # ---- refusals about the inputs
    def test_no_packet_two_packets_of_one_name_and_parts_inside_a_packet_are_refused(self):
        empty = self.tmp / 'empty'
        empty.mkdir()
        self.assertEqual(self.run_judge(empty, 'questions')[0], 2)
        twin = make_packets(self.tmp / 'twin')
        write(twin / 'bixbench' / 'copy' / 'pass1' / 'meta.json', {'key': 'bixbench/b1', 'pass': 1})
        code, _, err = self.run_judge(twin / 'bixbench', 'questions')
        self.assertEqual(code, 2)
        self.assertIn('share the verdict file', err)
        code, _, err = self.run_judge(self.judge / 'bixbench', 'questions', parts=self.judge / 'bixbench' / 'b1' / 'pass1' / 'parts')
        self.assertEqual(code, 2)
        self.assertIn('inside a packet', err)

    def test_concurrency_is_capped(self):
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            cj.main(['judge', str(self.judge), '--model', 'claude-sonnet-5-5', '--effort', 'medium', '--judge-id', 'j', '--dialect', 'questions', '--brief', str(self.brief),
                     '--parts', str(self.parts), '--concurrency', '9'])


class Briefs(unittest.TestCase):
    """The shipped briefs (judge/briefs) ask for exactly the answer each dialect's check accepts, and nothing that needs a write tool."""
    BRIEFS = pathlib.Path(__file__).resolve().parents[2] / 'judge' / 'briefs'
    WORDS = {'questions': ('bixbench', '"verdict"'), 'score': ('rcb', '"items"'), 'race': ('drb-abs', '"race"'), 'pairwise': ('drb-pair', '"pref"')}

    def test_every_dialect_has_a_brief_that_answers_in_the_reply(self):
        self.assertEqual(sorted(self.WORDS), sorted(cj.DIALECTS))
        for dialect, (name, word) in self.WORDS.items():
            text = (self.BRIEFS / f'{name}.md').read_text()
            self.assertIn('Your final answer is the verdict', text, name)
            self.assertIn('current working directory', text, name)
            self.assertIn('meta.json', text, name)
            self.assertIn(word, text, name)
            self.assertIn('e-mail', text, name)  # no contact header in a verdict
            for forbidden in ('Append', '/home/', 'BENCH_ROOT', 'subagent'):
                self.assertNotIn(forbidden, text, f'{name}: {forbidden}')


WHO = {'judge': 'claude-judge-test', 'model': 'claude-sonnet-5-5', 'effort': 'medium'}


class Remap(unittest.TestCase):
    """judge -> remap -> the exporter's own reader (absolute_records / question_records), no copy of its rules."""

    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix='claude-judge-remap-'))
        self.addCleanup(__import__('shutil').rmtree, self.tmp, True)
        self.keys = {'rcb/aa': {'arm': 'baseline', 'row': 'Life_001', 'repeat': 0}, 'rcb/bb': {'arm': 'cand-0123456789ab', 'row': 'Life_001', 'repeat': 0}}
        write(self.tmp / 'keys.json', self.keys)

    def claim(self, parts, dialect='score', **who):
        write(parts / 'judge.json', {'schema': cj.SCHEMA, **WHO, **who, 'dialect': dialect, 'briefSha256': 'ab' * 32})

    def parts(self, scores, passes=(1, 2)):
        parts = self.tmp / 'parts'
        for k in passes:
            for key, score in scores.items():
                write(parts / (key.replace('/', '__') + f'.p{k}.jsonl'), json.dumps({'key': key, 'score': score + k, 'items': [], 'pass': k, **WHO}) + '\n')
        self.claim(parts)
        return parts

    def remap(self, parts, dialect='score', repeats=1, template=None):
        argv = ['remap', '--keys', str(self.tmp / 'keys.json'), '--parts', str(parts), '--dialect', dialect, '--bench-key', 'rcb-rsi', '--repeats', str(repeats),
                '--out', str(self.tmp / 'out' / 'verdicts')]
        if template:
            argv += ['--key-template', template]
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = cj.main(argv)
        self.stdout = out.getvalue()
        return code, err.getvalue()

    def test_the_exporter_reads_what_remap_writes(self):
        self.assertEqual(self.remap(self.parts({'rcb/aa': 40, 'rcb/bb': 60}))[0], 0)
        files = [str(self.tmp / 'out' / f'verdicts.p{k}.jsonl') for k in (1, 2)]
        self.assertEqual(json.loads(pathlib.Path(files[0]).read_text().splitlines()[0]), {'key': 'rcb-rsi/base/Life_001', 'score': 41, **WHO})
        args = types.SimpleNamespace(verdicts=files, dialect='percent', judge_id='claude-judge-test', key_template=eha.DEFAULT_KEY_TEMPLATE, bench_key='rcb-rsi', repeats=1)
        found, calls = eha.absolute_records(args, [{'id': 'Life_001'}], [('baseline', None), ('cand-0123456789ab', None)], WHO)
        self.assertEqual(found, {('baseline', 'Life_001', 0, 1): 0.41, ('baseline', 'Life_001', 0, 2): 0.42,
                                 ('cand-0123456789ab', 'Life_001', 0, 1): 0.61, ('cand-0123456789ab', 'Life_001', 0, 2): 0.62})
        self.assertEqual(calls, 4)
        # the exporter holds every line to the registered judge: another effort is another judge
        with self.assertRaises(eha.ExportError) as caught:
            eha.absolute_records(args, [{'id': 'Life_001'}], [('baseline', None), ('cand-0123456789ab', None)], {**WHO, 'effort': 'high'})
        self.assertIn("effort 'medium' is not the registered judge", str(caught.exception))

    def test_remap_names_the_judge_and_needs_the_record_of_what_judged(self):
        parts = self.parts({'rcb/aa': 40, 'rcb/bb': 60})
        self.assertEqual(self.remap(parts)[0], 0)
        self.assertIn('judged by claude-judge-test (claude-sonnet-5-5 at medium)', self.stdout)
        self.assertEqual(sorted(p.name for p in (self.tmp / 'out').iterdir()), ['verdicts.p1.jsonl', 'verdicts.p2.jsonl'])  # judge.json is not a verdict file
        # without judge.json, with one of another dialect or an older schema, or with a line another judge stamped: nothing is written
        for change, needle in (({'unlink': True}, 'judge.json is missing'), ({'dialect': 'race'}, 'of the score dialect'), ({'schema': 'claude-judge/1'}, 'of the score dialect'),
                               ({'line': {**WHO, 'effort': 'high'}}, 'not judged by the judge judge.json names'), ({'line': {'judge': 'claude-judge-test'}}, 'not judged by the judge')):
            __import__('shutil').rmtree(self.tmp / 'out', True)
            parts = self.parts({'rcb/aa': 40, 'rcb/bb': 60})
            if change.get('unlink'):
                (parts / 'judge.json').unlink()
            elif 'line' in change:
                write(parts / 'rcb__bb.p2.jsonl', json.dumps({'key': 'rcb/bb', 'score': 1, 'pass': 2, **change['line']}) + '\n')
            else:
                record = json.loads((parts / 'judge.json').read_text())
                write(parts / 'judge.json', {**record, **change})
            code, err = self.remap(parts)
            self.assertEqual(code, 2, change)
            self.assertIn(needle, err)
            self.assertFalse((self.tmp / 'out').exists(), change)

    def test_repeats_and_the_judge_stamp_agree_with_the_exporter(self):
        keys = {'rcb/aa': {'arm': 'baseline', 'row': 'Life_001', 'repeat': 2}}
        write(self.tmp / 'keys.json', keys)
        parts = self.tmp / 'parts'
        write(parts / 'rcb__aa.p1.jsonl', json.dumps({'key': 'rcb/aa', 'score': 50, 'pass': 1, **WHO}) + '\n')
        self.claim(parts)
        self.assertEqual(self.remap(parts, repeats=3)[0], 0)
        line = json.loads((self.tmp / 'out' / 'verdicts.p1.jsonl').read_text())
        self.assertEqual(line, {'key': 'rcb-rsi/base/Life_001#r2', 'score': 50, **WHO})

    def test_questions_remap_to_run_key_and_question(self):
        parts = self.tmp / 'parts'
        for key in self.keys:
            write(parts / (key.replace('/', '__') + '.p1.jsonl'),
                  '\n'.join(json.dumps({'key': f'{key}#q{i}', 'verdict': 'correct' if i == 1 else 'incorrect', 'rationale': 'r', 'pass': 1, **WHO}) for i in (1, 2)) + '\n')
        self.claim(parts, 'questions')
        self.assertEqual(self.remap(parts, dialect='questions')[0], 0)
        out = self.tmp / 'out' / 'verdicts.p1.jsonl'
        args = types.SimpleNamespace(verdicts=[str(out)], dialect='questions', judge_id='claude-judge-test', key_template=eha.DEFAULT_KEY_TEMPLATE, bench_key='rcb-rsi', repeats=1,
                                     question_ids_map={'Life_001': ['q1', 'q2']})
        found, _ = eha.question_records(args, [{'id': 'Life_001'}], [('baseline', None), ('cand-0123456789ab', None)], WHO)
        self.assertEqual(found, {('baseline', 'Life_001', 0, 1): 0.5, ('cand-0123456789ab', 'Life_001', 0, 1): 0.5})

    def test_a_packet_without_a_verdict_in_a_pass_is_never_a_half_set(self):
        parts = self.parts({'rcb/aa': 40, 'rcb/bb': 60})
        (parts / 'rcb__bb.p2.jsonl').unlink()
        code, err = self.remap(parts)
        self.assertEqual(code, 2)
        self.assertIn('no verdict for pass 2', err)
        self.assertFalse((self.tmp / 'out').exists())

    def test_a_verdict_file_of_no_packet_is_refused(self):
        parts = self.parts({'rcb/aa': 40, 'rcb/bb': 60})
        write(parts / 'rcb__zz.p1.jsonl', '{"key": "rcb/zz", "score": 1}\n')
        code, err = self.remap(parts)
        self.assertEqual(code, 2)
        self.assertIn('rcb__zz.p1.jsonl', err)


if __name__ == '__main__':
    unittest.main()
