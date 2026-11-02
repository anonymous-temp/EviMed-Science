"""Tests of register_round.py over a tiny synthetic pools file (never the real data).

Run: python3 -I -m unittest discover -s tools/test -p 'test_register_round.py'   (from evals/public-benchmarks)
"""
import contextlib
import hashlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import register_round as rr  # noqa: E402

SALT = '20261028'
DEV = [str(i) for i in range(1, 41)]
CONF = [str(i) for i in range(101, 141)]


def h(salt, ident):
    return hashlib.sha256(f'{salt}|{ident}'.encode()).hexdigest()


class Fixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='register-round-test-')
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.pools = self.dir / 'drb.json'
        self.write_pools(DEV, CONF)

    def write_pools(self, dev, conf, digest='f' * 64):
        self.pools.write_text(json.dumps({'schema': 'bench-pools/1', 'bench': 'drb', 'salt': SALT, 'digest': digest,
                                          'pools': {'main': {'development': dev, 'confirmation': conf}, 'other': {'development': dev[:5], 'confirmation': conf[:5]}}}))

    def write(self, name, value):
        path = self.dir / name
        path.write_text(json.dumps(value))
        return path

    def run_main(self, argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = rr.main(argv)
        return code, out.getvalue(), err.getvalue()

    def args(self, out='reg.json', scorer='arb-deep', benchmark='autoresearchbench-deep', extra=()):
        base = ['--round', 'rsi1-test', '--family', 'drb', '--benchmark', benchmark, '--scorer', scorer, '--pools', str(self.pools),
                '--failure-slice', 'NLP,Vision', '--out', str(self.dir / out)]
        return base + list(extra)

    def register(self, **kw):
        code, out, err = self.run_main(self.args(**kw))
        self.assertEqual(code, 0, err)
        return json.loads((self.dir / kw.get('out', 'reg.json')).read_text())

    def judged_extra(self, **override):
        values = {'--judge-id': 'claude-judge-1', '--judge-provider': 'anthropic', '--judge-form': 'pairwise', '--judge-passes': '2',
                  '--judge-max-calls': '2000', '--judge-agreement': '0.95', '--judge-noise-sd': '0.0155', '--judge-noise-band': '0.0304',
                  '--judge-measured-on': 'judge-noise.txt@2026-10-31', '--judge-min-agreement': '0.9', '--judge-max-noise-band': '0.05'}
        values.update(override)
        return [x for pair in values.items() if pair[1] is not None for x in pair]


class Selection(Fixture):
    def test_hash_order_and_first_n(self):
        doc = self.register(extra=['--development-rows', '10', '--confirmation-rows', '12'])
        expected = sorted(DEV, key=lambda i: h(SALT, i))[:10]
        self.assertEqual(doc['rows']['development'], expected)
        self.assertEqual(doc['rows']['confirmation'], sorted(CONF, key=lambda i: h(SALT, i))[:12])
        self.assertEqual(doc['available'], {'development': 40, 'confirmation': 40})
        self.assertEqual(doc['hashOrder'], {'salt': SALT, 'rule': 'ascending sha256(salt|id)'})
        # the first rows are the same whatever number is asked for: the order does not depend on N
        again = self.register(out='reg2.json', extra=['--development-rows', '4', '--confirmation-rows', '4'])
        self.assertEqual(again['rows']['development'], expected[:4])

    def test_default_takes_every_available_row_and_the_pool_digest_is_recorded(self):
        doc = self.register()
        self.assertEqual((len(doc['rows']['development']), len(doc['rows']['confirmation'])), (40, 40))
        self.assertEqual(doc['pool'], {'file': 'drb.json', 'name': 'main', 'digest': 'f' * 64})
        self.assertEqual(self.register(out='reg3.json', extra=['--pool', 'other'])['rows']['development'], sorted(DEV[:5], key=lambda i: h(SALT, i)))

    def test_same_inputs_same_digest_and_the_digest_is_the_content_digest(self):
        one = self.register(out='a.json')
        two = self.register(out='b.json')
        self.assertEqual(one['digest'], two['digest'])
        body = {k: v for k, v in one.items() if k not in ('digest', 'registeredAt')}
        self.assertEqual(one['digest'], hashlib.sha256(json.dumps(body, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest())
        changed = self.register(out='c.json', extra=['--margin', '0.04'])
        self.assertNotEqual(one['digest'], changed['digest'])

    def test_a_short_pool_is_an_error_and_nothing_is_written(self):
        code, _, err = self.run_main(self.args(extra=['--development-rows', '41']))
        self.assertEqual(code, 2)
        self.assertIn('41 rows asked, 40 available', err)
        self.assertFalse((self.dir / 'reg.json').exists())

    def test_ids_on_both_lists_are_dropped_from_both(self):
        self.write_pools(DEV + ['101'], ['101'] + CONF[1:])
        doc = self.register()
        self.assertNotIn('101', doc['rows']['development'] + doc['rows']['confirmation'])
        self.assertEqual(doc['available'], {'development': 40, 'confirmation': 39})

    def test_ppc_ids_leave_both_roles_in_every_accepted_shape(self):
        shapes = {
            'list': ['3', '4', 105],
            'tasks': {'tasks': ['3', '4', '105']},
            'by-key': {'drb': ['3'], 'domain-x': ['4', 105]},
            'prefixed': ['drb/3', 'drb:4', 'main/105'.replace('main', 'drb')],
            'objects': [{'id': '3'}, {'id': 4}, {'id': '105'}],
        }
        for name, shape in shapes.items():
            doc = self.register(out=f'{name}.json', extra=['--ppc', str(self.write(f'ppc-{name}.json', shape))])
            used = set(doc['rows']['development'] + doc['rows']['confirmation'])
            self.assertTrue({'3', '4', '105'}.isdisjoint(used), name)
            self.assertEqual(doc['excluded']['ppc'], ['3', '4', '105'], name)
            self.assertEqual(doc['available'], {'development': 38, 'confirmation': 39}, name)
            self.assertEqual(doc['excluded']['ppcFile'], f'ppc-{name}.json')
            self.assertEqual(len(doc['excluded']['ppcFileSha256']), 64)

    def test_the_ppc_file_of_the_harness_adaptation_package_is_read_for_this_family_only(self):
        ppc = {'schema': 'rsi1-ppc-tasks/1', 'salt': 'x', 'domains': {'drb': {'ids': ['3', '4'], 'facts': {'3': {}}}, 'mbc': {'ids': ['5', '6']}}}
        doc = self.register(extra=['--ppc', str(self.write('ppc.json', ppc))])
        self.assertEqual(doc['excluded']['ppc'], ['3', '4'])  # another family's ids (5, 6) remove nothing here
        self.assertEqual(doc['available'], {'development': 38, 'confirmation': 40})
        for bad in ({'domains': {'mbc': {'ids': ['5']}}}, {'domains': {'drb': ['3']}}, {'domains': {'drb': {'ids': '3'}}}):
            code, _, err = self.run_main(self.args(out='bad.json', extra=['--ppc', str(self.write('bad-ppc.json', bad))]))
            self.assertEqual(code, 2, bad)
            self.assertIn('ppc', err)

    def test_opened_rows_of_earlier_campaigns_leave_both_roles_and_their_development_rows_leave_the_confirmation_role(self):
        # an earlier registration: its confirmation rows were opened, its development rows were seen
        earlier = self.register(out='earlier.json', extra=['--development-rows', '10', '--confirmation-rows', '12'])
        opened, seen = set(earlier['rows']['confirmation']), set(earlier['rows']['development'])
        earlier_path = self.dir / 'earlier.json'
        doc = self.register(out='round2.json', extra=['--development-rows', '10', '--confirmation-rows', '12', '--exclude-opened', str(earlier_path)])
        self.assertFalse(opened & set(doc['rows']['confirmation']) or opened & set(doc['rows']['development']), 'an opened row is in neither role')
        self.assertFalse(seen & set(doc['rows']['confirmation']), 'a row seen in an earlier development is not fresh for confirmation')
        self.assertEqual(doc['available']['confirmation'], 40 - len(opened) - len(seen & set(CONF)) - len(seen - set(CONF)) * 0)
        self.assertEqual(doc['excluded']['opened'], sorted(opened & (set(DEV) | set(CONF)), key=lambda i: int(i)))
        self.assertEqual(doc['excluded']['seen'], sorted(seen, key=lambda i: int(i)))
        self.assertEqual(doc['excluded']['openedFiles'][0]['name'], 'earlier.json')
        self.assertEqual(len(doc['excluded']['openedFiles'][0]['sha256']), 64)
        # fresh rows are the next ones in the hash order, nothing else moves
        expected = [i for i in sorted(CONF, key=lambda i: h(SALT, i)) if i not in opened and i not in seen][:12]
        self.assertEqual(doc['rows']['confirmation'], expected)
        # a plain list, {"opened": [...]} and the absence of the option
        for name, shape in (('list', ['101', '102']), ('keyed', {'opened': ['101', '102']})):
            listed = self.register(out=f'{name}.json', extra=['--exclude-opened', str(self.write(f'o-{name}.json', shape))])
            self.assertNotIn('101', listed['rows']['confirmation'])
            self.assertEqual(listed['excluded']['opened'], ['101', '102'])
        plain = self.register(out='plain-again.json')
        self.assertNotIn('opened', plain['excluded'], 'without the option a registration is what it was')
        self.assertNotIn('surface', plain)
        # the registration verifies only against the same files
        self.assertEqual(rr.check(str(self.dir / 'round2.json'), str(self.pools), 'main', None, [str(earlier_path)]), [])
        self.assertTrue(rr.check(str(self.dir / 'round2.json'), str(self.pools), 'main', None, []))
        self.assertTrue(rr.check(str(self.dir / 'round2.json'), str(self.pools), 'main', None, [str(self.dir / 'o-list.json')]))
        # too few rows left is an error that says how many are available
        code, _, err = self.run_main(self.args(out='toomany.json', extra=['--confirmation-rows', '39', '--exclude-opened', str(earlier_path)]))
        self.assertEqual(code, 2)
        self.assertIn('available', err)
        code, _, err = self.run_main(self.args(out='bad-opened.json', extra=['--exclude-opened', str(self.write('bad-o.json', {'rows': {'development': ['1']}}))]))
        self.assertEqual(code, 2)
        self.assertIn('rows hold the lists', err)

    def test_listed_ids_leave_both_roles_with_their_reason_and_the_registration_verifies_only_against_the_same_files(self):
        file = self.write('infeasible.json', {'reason': 'files over the upload limit; the request builder cannot name the capsule', 'ids': ['101', '3', '999']})
        doc = self.register(out='listed.json', extra=['--development-rows', '10', '--confirmation-rows', '12', '--exclude-ids', str(file)])
        self.assertFalse({'101', '3'} & set(doc['rows']['confirmation'] + doc['rows']['development']))
        listed, = doc['excluded']['listed']
        self.assertEqual((listed['name'], listed['reason'][:11], listed['removed']), ('infeasible.json', 'files over ', ['3', '101']))  # 999 is not in the pool: not listed as removed
        self.assertEqual(len(listed['sha256']), 64)
        self.assertEqual(doc['available'], {'development': 39, 'confirmation': 39})
        expected = [i for i in sorted(CONF, key=lambda i: h(SALT, i)) if i != '101'][:12]
        self.assertEqual(doc['rows']['confirmation'], expected)
        path = str(self.dir / 'listed.json')
        self.assertEqual(rr.check(path, str(self.pools), 'main', None, [], [str(file)]), [])
        self.assertTrue(rr.check(path, str(self.pools), 'main', None, [], []), 'the listed files are needed to re-derive the selection')
        other = self.write('other.json', {'reason': 'files over the upload limit; the request builder cannot name the capsule', 'ids': ['101', '3']})
        self.assertTrue(rr.check(path, str(self.pools), 'main', None, [], [str(other)]), 'another file is not the one recorded')
        self.assertNotIn('listed', self.register(out='plain-listed.json')['excluded'], 'without the option a registration is what it was')
        for bad in ({'ids': ['1']}, {'reason': ' ', 'ids': ['1']}, {'reason': 'x'}, ['1']):
            code, _, err = self.run_main(self.args(out='bad-listed.json', extra=['--exclude-ids', str(self.write('bad-l.json', bad))]))
            self.assertEqual(code, 2, bad)
            self.assertIn('--exclude-ids', err)

    def test_the_tool_patch_surface_is_recorded_and_the_default_writes_no_field(self):
        tool = self.register(out='tool.json', extra=['--surface', 'tool-patch'])
        self.assertEqual(tool['surface'], 'tool-patch')
        default = self.register(out='default.json')
        self.assertNotIn('surface', default)
        self.assertNotEqual(tool['digest'], default['digest'])
        code, _, err = self.run_main(self.args(out='bad.json', extra=['--surface', 'skill-patch']))
        self.assertEqual(code, 2)

    def test_a_development_salt_orders_the_development_role_only_and_is_recorded(self):
        doc = self.register(extra=['--development-rows', '10', '--confirmation-rows', '12', '--development-salt', 'screen'])
        self.assertEqual(doc['rows']['development'], sorted(DEV, key=lambda i: h('screen', i))[:10])
        self.assertEqual(doc['rows']['confirmation'], sorted(CONF, key=lambda i: h(SALT, i))[:12])
        self.assertEqual(doc['hashOrder'], {'salt': SALT, 'rule': 'ascending sha256(salt|id)', 'developmentSalt': 'screen'})
        same = self.register(out='same.json', extra=['--development-salt', SALT])
        plain = self.register(out='plain.json')
        self.assertEqual(same['hashOrder'], plain['hashOrder'])  # the same salt is no second salt, and the digest does not move
        self.assertEqual(same['digest'], plain['digest'])

    def test_ppc_ids_outside_the_pool_are_not_listed_as_removed(self):
        doc = self.register(extra=['--ppc', str(self.write('ppc.json', ['3', '999', 'other/77']))])
        self.assertEqual(doc['excluded']['ppc'], ['3'])

    def test_a_foreign_prefix_is_not_stripped_and_a_malformed_ppc_is_an_error(self):
        doc = self.register(extra=['--ppc', str(self.write('ppc.json', ['arb/3']))])
        self.assertEqual(doc['excluded']['ppc'], [])
        for bad in ('text', 7, {'drb': 'nope'}, [None], [['3']], [True]):
            code, _, err = self.run_main(self.args(out='bad.json', extra=['--ppc', str(self.write('bad-ppc.json', bad))]))
            self.assertEqual(code, 2, bad)
            self.assertIn('ppc', err)

    def test_the_observation_about_too_few_groups_is_recorded_not_decided(self):
        few = self.register(extra=['--confirmation-rows', '15'])
        self.assertTrue(few['groupsBelowMinimum'])
        enough = self.register(out='ok.json', extra=['--confirmation-rows', '25'])
        self.assertFalse(enough['groupsBelowMinimum'])
        self.assertEqual(enough['minimumGroups'], 25)


class Parameters(Fixture):
    def test_the_fixed_fields(self):
        doc = self.register()
        self.assertEqual((doc['schema'], doc['tool'], doc['round'], doc['family'], doc['benchmark'], doc['scorer']),
                         ('rsi-round-registration/1', 'register_round.py/1', 'rsi1-test', 'drb', 'autoresearchbench-deep', 'arb-deep'))
        self.assertEqual(doc['repeats'], {'development': 1, 'confirmation': 3})
        self.assertEqual((doc['margin'], doc['costRatio'], doc['candidatesMax'], doc['minimumGroups']), (0.05, 1.1, 3, 25))
        self.assertEqual(doc['alpha'], {'quarterTotal': 0.05, 'campaignsPerQuarter': 3, 'perCampaign': 0.05 / 3})
        self.assertEqual(doc['control']['arm'], 'aa')
        self.assertEqual(doc['control']['kind'], 'A/A')
        self.assertIn('absolute failure-slice difference', doc['control']['rule'])
        self.assertEqual((doc['failureSlice'], doc['failureSliceKey']), (['NLP', 'Vision'], 'failureSlice'))
        self.assertNotIn('judge', doc)
        self.assertRegex(doc['registeredAt'], r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$')

    def test_overrides(self):
        doc = self.register(extra=['--repeats-development', '2', '--repeats-confirmation', '4', '--campaigns-per-quarter', '6', '--candidates-max', '2',
                                   '--control-arm', 'aa', '--margin', '0.03', '--minimum-groups', '30'])
        self.assertEqual((doc['repeats'], doc['candidatesMax'], doc['margin'], doc['minimumGroups']), ({'development': 2, 'confirmation': 4}, 2, 0.03, 30))
        self.assertAlmostEqual(doc['alpha']['perCampaign'], 0.05 / 6)

    def test_medcalc_slice_must_be_calculator_ids(self):
        code, _, err = self.run_main(self.args(scorer='medcalc', benchmark='medcalc-bench', out='m.json'))
        self.assertEqual(code, 2)
        self.assertIn('integers', err)

    def test_medcalc_ints(self):
        code, _, err = self.run_main(['--round', 'r', '--family', 'medcalc', '--benchmark', 'medcalc-bench', '--scorer', 'medcalc', '--pools', str(self.pools),
                                      '--failure-slice', '33, 15,15', '--out', str(self.dir / 'm.json')])
        self.assertEqual(code, 0, err)
        doc = json.loads((self.dir / 'm.json').read_text())
        self.assertEqual((doc['failureSlice'], doc['failureSliceKey']), ([15, 33], 'failureCalculators'))

    def test_refusals(self):
        refused = [(['--cost-ratio', '1.2'], 'targeted-repair cost bound is 1.1'), (['--margin', '1.5'], '--margin'), (['--candidates-max', '0'], 'at least 1'),
                   (['--repeats-confirmation', '0'], 'repeats'), (['--failure-slice', ' ,a'], 'comma-separated')]
        for extra, needle in refused:
            args = self.args(out='x.json')
            if '--failure-slice' in extra:
                args = [a for i, a in enumerate(args) if a != '--failure-slice' and args[i - 1] != '--failure-slice']
            code, _, err = self.run_main(args + extra)
            self.assertEqual(code, 2, extra)
            self.assertIn(needle, err)
        code, _, err = self.run_main(self.args(scorer='arb-deep', benchmark='medcalc-bench'))
        self.assertEqual(code, 2)
        code, _, err = self.run_main(self.args(scorer='free-form'))
        self.assertEqual(code, 2)
        self.assertIn('closed table', err)
        args = self.args()
        args[args.index('--round') + 1] = 'r'
        self.assertEqual(self.run_main([a for a in args if a != '--scorer' and a != 'arb-deep'])[0], 2)

    def test_an_existing_file_is_not_overwritten_without_force(self):
        self.register()
        code, _, err = self.run_main(self.args())
        self.assertEqual(code, 2)
        self.assertIn('--force', err)
        self.assertEqual(self.run_main(self.args(extra=['--force']))[0], 0)

    def test_the_digest_is_printed(self):
        code, out, _ = self.run_main(self.args())
        self.assertEqual(code, 0)
        doc = json.loads((self.dir / 'reg.json').read_text())
        self.assertIn(doc['digest'], out)

    def test_a_sha256sum_sidecar_sits_beside_the_file(self):
        import hashlib
        code, _, _ = self.run_main(self.args())
        self.assertEqual(code, 0)
        raw = (self.dir / 'reg.json').read_bytes()
        self.assertEqual((self.dir / 'reg.json.sha256').read_text(), f'{hashlib.sha256(raw).hexdigest()}  reg.json\n')


class Judged(Fixture):
    def judged(self, **override):
        return self.run_main(self.args(scorer='judged-verdicts', benchmark='deepresearchbench', extra=self.judged_extra(**override)))

    def test_the_judge_block(self):
        code, _, err = self.judged()
        self.assertEqual(code, 0, err)
        doc = json.loads((self.dir / 'reg.json').read_text())
        self.assertEqual(doc['judge'], {'id': 'claude-judge-1', 'provider': 'anthropic', 'form': 'pairwise', 'passes': 2, 'maxCalls': 2000, 'callsRequired': 560,
                                        'qualification': {'agreement': 0.95, 'noiseSd': 0.0155, 'noiseBand95': 0.0304, 'measuredOn': 'judge-noise.txt@2026-10-31',
                                                          'minimumAgreement': 0.9, 'maximumNoiseBand': 0.05}})

    def test_the_call_budget_is_computed_from_the_registration_and_a_lower_maximum_is_refused(self):
        # 40 development rows x 1 repeat and 40 confirmation rows x 3 repeats; pairwise records the arms that are not the baseline:
        # development the A/A control and up to 3 candidates, confirmation the one candidate; 2 passes
        self.assertEqual(rr.judge_calls_required('pairwise', 2, 40, 40, 1, 3, 3), (40 * 1 * (1 + 3) + 40 * 3 * 1) * 2)
        # absolute judging scores every arm: the baseline too
        self.assertEqual(rr.judge_calls_required('absolute', 3, 12, 30, 1, 3, 1), (12 * 1 * (1 + 1 + 1) + 30 * 3 * 2) * 3)
        # round 1's drb: 12 development rows, 30 confirmation rows x 3, pairwise, 2 passes, K = 1, control: 228 records against a maximum of 200
        self.assertEqual(rr.judge_calls_required('pairwise', 2, 12, 30, 1, 3, 1), 228)
        code, _, err = self.judged(**{'--judge-max-calls': '559'})
        self.assertEqual(code, 2)
        self.assertIn('560 verdict records', err)
        self.assertFalse((self.dir / 'reg.json').exists())
        code, _, err = self.run_main(self.args(scorer='judged-verdicts', benchmark='deepresearchbench', extra=['--development-rows', '12', '--confirmation-rows', '30', '--candidates-max', '1']
                                               + self.judged_extra(**{'--judge-max-calls': '200'})))
        self.assertEqual(code, 2)
        self.assertIn('at least 228', err)
        code, _, err = self.run_main(self.args(scorer='judged-verdicts', benchmark='deepresearchbench', extra=['--development-rows', '12', '--confirmation-rows', '30', '--candidates-max', '1']
                                               + self.judged_extra(**{'--judge-max-calls': '228'})))
        self.assertEqual(code, 0, err)
        self.assertEqual(json.loads((self.dir / 'reg.json').read_text())['judge']['callsRequired'], 228)
        # a registration that was edited or written by an older tool is held to the same figure by --check
        doc = json.loads((self.dir / 'reg.json').read_text())
        doc['judge']['maxCalls'] = 200
        doc['digest'] = rr.content_digest(doc)
        (self.dir / 'low.json').write_text(json.dumps(doc))
        self.assertTrue(any('below the 228' in p for p in rr.check(str(self.dir / 'low.json'), None, None, None)))
        self.assertEqual(rr.check(str(self.dir / 'reg.json'), None, None, None), [])

    def test_bixbench_is_a_judged_benchmark_beside_the_deterministic_scorer_and_the_absolute_budget_counts_every_arm(self):
        code, _, err = self.run_main(self.args(out='bix-judged.json', scorer='judged-verdicts', benchmark='bixbench', extra=self.judged_extra(**{'--judge-form': 'absolute', '--judge-max-calls': '5000'})
                                               + ['--development-rows', '8', '--confirmation-rows', '7', '--repeats-confirmation', '3', '--candidates-max', '1']))
        self.assertEqual(code, 0, err)
        doc = json.loads((self.dir / 'bix-judged.json').read_text())
        self.assertEqual((doc['scorer'], doc['benchmark'], doc['judge']['form']), ('judged-verdicts', 'bixbench', 'absolute'))
        # absolute judging scores every arm: development baseline + A/A + 1 candidate, confirmation baseline + 1 candidate; 2 passes
        self.assertEqual(doc['judge']['callsRequired'], (8 * 1 * 3 + 7 * 3 * 2) * 2)
        code, _, err = self.run_main(self.args(out='bix-code.json', scorer='bixbench-deterministic', benchmark='bixbench'))
        self.assertEqual(code, 0, err)
        code, _, err = self.run_main(self.args(out='bix-wrong.json', scorer='judged-verdicts', benchmark='medcalc-bench', extra=self.judged_extra()))
        self.assertEqual(code, 2)
        self.assertIn('scorer judged-verdicts scores', err)

    def test_the_family_of_the_solver_is_refused(self):
        for override in ({'--judge-id': 'deepseek-v4-pro'}, {'--judge-provider': 'DeepSeek'}):
            code, _, err = self.judged(**override)
            self.assertEqual(code, 2)
            self.assertIn('solver', err)
        self.assertFalse((self.dir / 'reg.json').exists())

    def test_required_judge_arguments_and_their_ranges(self):
        for key in ('--judge-id', '--judge-max-calls', '--judge-min-agreement', '--judge-measured-on'):
            code, _, err = self.judged(**{key: None})
            self.assertEqual(code, 2, key)
            self.assertIn(key, err)
        cases = [({'--judge-form': 'pairwise', '--judge-passes': '3'}, 'even'), ({'--judge-form': 'absolute', '--judge-passes': '1'}, 'at least 2'),
                 ({'--judge-agreement': '1.2'}, 'agreement'), ({'--judge-max-noise-band': '0'}, 'above 0'), ({'--judge-form': 'ranking'}, 'absolute or pairwise')]
        for override, needle in cases:
            code, _, err = self.judged(**override)
            self.assertEqual(code, 2, override)
            self.assertIn(needle, err)
        self.assertEqual(self.judged(**{'--judge-form': 'absolute', '--judge-passes': '3'})[0], 0)

    def test_judge_arguments_without_the_judged_scorer_are_refused(self):
        code, _, err = self.run_main(self.args(extra=['--judge-id', 'claude-judge-1']))
        self.assertEqual(code, 2)
        self.assertIn('judged-verdicts only', err)
        code, _, err = self.run_main(self.args(scorer='judged-verdicts', benchmark='deepresearchbench'))
        self.assertEqual(code, 2)
        self.assertIn('judged-verdicts needs', err)

    def test_noise_read_from_the_judge_noise_file_and_explicit_values_win(self):
        noise = self.write('judge-noise.txt', {'drb': {'sd': 0.0155, 'band95': 0.0304}, 'rcb': {'sd': 2.26, 'band95': 4.43}, 'bixbench': {'flipRate': 0.04}})
        extra = self.judged_extra(**{'--judge-noise-sd': None, '--judge-noise-band': None, '--judge-measured-on': None}) + ['--judge-noise', str(noise), '--judge-noise-key', 'drb']
        code, _, err = self.run_main(self.args(scorer='judged-verdicts', benchmark='deepresearchbench', extra=extra))
        self.assertEqual(code, 0, err)
        quality = json.loads((self.dir / 'reg.json').read_text())['judge']['qualification']
        self.assertEqual((quality['noiseSd'], quality['noiseBand95'], quality['measuredOn']), (0.0155, 0.0304, 'judge-noise.txt:drb'))
        extra = self.judged_extra(**{'--judge-noise-sd': '0.02', '--judge-noise-band': None, '--judge-measured-on': None}) + ['--judge-noise', str(noise), '--judge-noise-key', 'rcb']
        self.assertEqual(self.run_main(self.args(out='r2.json', scorer='judged-verdicts', benchmark='researchclawbench', extra=extra))[0], 0)
        quality = json.loads((self.dir / 'r2.json').read_text())['judge']['qualification']
        self.assertEqual((quality['noiseSd'], quality['noiseBand95']), (0.02, 4.43))
        # bixbench has no sd / band95 in the file: it must be given
        extra = self.judged_extra(**{'--judge-noise-sd': None, '--judge-noise-band': None}) + ['--judge-noise', str(noise), '--judge-noise-key', 'bixbench']
        self.assertEqual(self.run_main(self.args(out='r3.json', scorer='judged-verdicts', benchmark='deepresearchbench', extra=extra))[0], 2)


class Check(Fixture):
    def test_a_fresh_file_verifies_and_every_tamper_is_found(self):
        doc = self.register(extra=['--development-rows', '8', '--confirmation-rows', '8', '--ppc', str(self.write('ppc.json', ['3']))])
        path = self.dir / 'reg.json'
        code, _, err = self.run_main(['--check', str(path)])
        self.assertEqual((code, err.strip()), (0, 'register_round: verified'))
        self.assertEqual(self.run_main(['--check', str(path), '--pools', str(self.pools), '--ppc', str(self.dir / 'ppc.json')])[0], 0)

        def tampered(mutate, name):
            copy = json.loads(json.dumps(doc))
            mutate(copy)
            target = self.dir / name
            target.write_text(json.dumps(copy))
            return target

        swapped = tampered(lambda d: d['rows']['development'].reverse(), 'swapped.json')
        code, _, err = self.run_main(['--check', str(swapped)])
        self.assertEqual(code, 1)
        self.assertIn('not in ascending', err)
        self.assertIn('digest differs', err)
        # a digest recomputed over reordered rows still fails the hash-order check
        reordered = tampered(lambda d: (d['rows']['development'].reverse(), d.__setitem__('digest', rr.content_digest(d))), 'reordered.json')
        code, _, err = self.run_main(['--check', str(reordered)])
        self.assertEqual(code, 1)
        self.assertNotIn('digest differs', err)
        self.assertIn('not in ascending', err)
        self.assertEqual(self.run_main(['--check', str(tampered(lambda d: d.__setitem__('margin', 0.5), 'margin.json'))])[0], 1)
        both = tampered(lambda d: (d['rows']['confirmation'].append(d['rows']['development'][0]), d.__setitem__('digest', rr.content_digest(d))), 'both.json')
        self.assertEqual(self.run_main(['--check', str(both)])[0], 1)

    def test_a_development_salt_is_checked_and_re_derived(self):
        self.register(extra=['--development-rows', '8', '--confirmation-rows', '8', '--development-salt', 'screen'])
        path = self.dir / 'reg.json'
        self.assertEqual(self.run_main(['--check', str(path), '--pools', str(self.pools)])[0], 0)
        doc = json.loads(path.read_text())
        doc['hashOrder']['developmentSalt'] = 'other'
        doc['digest'] = rr.content_digest(doc)
        path.write_text(json.dumps(doc))
        code, _, err = self.run_main(['--check', str(path), '--pools', str(self.pools)])
        self.assertEqual(code, 1)
        self.assertIn('sha256(other|id)', err)
        self.assertIn('differ', err)

    def test_rederiving_from_the_pools_finds_a_changed_pool_or_ppc(self):
        self.register(extra=['--development-rows', '8', '--confirmation-rows', '8', '--ppc', str(self.write('ppc.json', ['3']))])
        path = self.dir / 'reg.json'
        self.write_pools(DEV, CONF, digest='e' * 64)
        code, _, err = self.run_main(['--check', str(path), '--pools', str(self.pools), '--ppc', str(self.dir / 'ppc.json')])
        self.assertEqual(code, 1)
        self.assertIn('not the one registered', err)
        self.write_pools(DEV, CONF)
        code, _, err = self.run_main(['--check', str(path), '--pools', str(self.pools), '--ppc', str(self.write('ppc2.json', ['3', sorted(DEV, key=lambda i: h(SALT, i))[0]]))])
        self.assertEqual(code, 1)
        self.assertRegex(err, 'differ')


if __name__ == '__main__':
    unittest.main()
