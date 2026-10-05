import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEvolutionReferenceCuration, certifyEvolutionReferenceReview } from '../src/evolutionReferenceCuration.mjs';
import { createEvolutionDevelopmentValidation } from '../src/evolutionDevelopmentValidation.mjs';
import { createEvolutionCandidateEvaluator } from '../src/evolutionCandidateEvaluator.mjs';
import { pythonExecVerify } from './helpers/pythonExecVerify.mjs';

// A synthetic method (a risk ratio from two arms) and three synthetic "papers" that print its inputs and result.
const ARMS = [{ events: 13, total: 80, controlEvents: 31, controlTotal: 90 }, { events: 47, total: 300, controlEvents: 61, controlTotal: 280 }, { events: 7, total: 55, controlEvents: 19, controlTotal: 60 }];
const ratio = arm => (arm.events / arm.total) / (arm.controlEvents / arm.controlTotal);
const REFERENCE = `import json,sys
s=json.load(sys.stdin)["specification"]
if min(s["total"],s["controlTotal"],s["controlEvents"])<=0: raise ValueError("invalid")
print(json.dumps({"numeric":{"riskRatio":(s["events"]/s["total"])/(s["controlEvents"]/s["controlTotal"])}}))
`;
async function fixture(t, { mutate = () => {}, referenceCode = REFERENCE, reviewPassed = true, papers = 2 } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'evolution-reference-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cited = ['10.1234/one', '10.1234/two', '10.1234/three'].slice(0, papers).map(doi => ({ doi }));
  const printed = ARMS.map(arm => ratio(arm).toFixed(3));
  const text = i => `<article><p>In the treated arm ${ARMS[i].events} of ${ARMS[i].total} patients had the event, against ${ARMS[i].controlEvents} of ${ARMS[i].controlTotal} controls.</p><p>The risk ratio was ${printed[i]} in 1,250 screened.</p></article>`;
  const proposed = { callableContract: { argument: 'specification', result: 'riskRatio', description: 'Risk ratio of two arms.' },
    // The model proposes inputs only. An "expected" it types is not read (this one is wrong on purpose), and it supplies no ids.
    developmentCases: [{ input: { specification: { events: 10, total: 100, controlEvents: 20, controlTotal: 100 } }, expected: { riskRatio: 9 } }, { input: { specification: { events: 30, total: 60, controlEvents: 15, controlTotal: 60 } }, expected: { riskRatio: 9 } }],
    cases: cited.map((paper, i) => ({ publicationId: paper.doi, input: { specification: { ...ARMS[i] } },
      inputEvidence: Object.entries(ARMS[i]).map(([key, value]) => ({ path: `specification.${key}`, value, quote: `In the treated arm ${ARMS[i].events} of ${ARMS[i].total} patients had the event, against ${ARMS[i].controlEvents} of ${ARMS[i].controlTotal} controls.` })),
      // The model's tolerance would accept the null and the opposite direction; it is discarded.
      numeric: { riskRatio: { value: Number(printed[i]), absoluteTolerance: 0.9, quote: `The risk ratio was ${printed[i]} in 1,250 screened.`, quantity: 'ratio' } } })) };
  mutate(proposed);
  const requests = { write: [], review: [] };
  const record = { calls: [] }, controller = { execVerify: pythonExecVerify(record) };
  const curator = createEvolutionReferenceCuration({ config: { evaluationDataDir: root }, controller,
    fetchImpl: async url => {
      const link = String(url);
      if (link.startsWith('https://api.crossref.org/')) return new Response(JSON.stringify({ message: {} }));
      const i = ['one', 'two', 'three'].findIndex(name => decodeURIComponent(link).includes(name));
      if (link.includes('/search?')) return new Response(JSON.stringify({ resultList: { result: [{ id: String(i + 1), pmcid: `PMC${i + 1}`, doi: cited[i].doi, title: `Published reference ${['one', 'two', 'three'][i]}` }] } }));
      const index = Number(/PMC(\d)\/fullTextXML$/.exec(link)[1]) - 1;
      return new Response(text(index));
    },
    write: async input => { requests.write.push(input); return proposed; },
    review: async input => { requests.review.push(input); return { passed: reviewPassed, family: 'qwen', referenceCode }; } });
  return { root, curator, controller, record, requests, printed, card: { methodId: 'new-method', papers: cited } };
}
const frozenOf = async root => JSON.parse(await readFile(path.join(root, 'paper-gold/candidate-cases/new-method.json'), 'utf8'));

test('a new method gains independently executed primary references without returning hidden numbers', async t => {
  const f = await fixture(t), result = await f.curator.prepareCases(f.card);
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.publishedReferenceCount, 2); assert.equal(result.access, 'evaluation-only'); assert.equal('cases' in result, false);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(f.printed[0].replace('.', '\\.')));
  const frozen = await frozenOf(f.root);
  assert.equal(frozen.frozen, true);
  assert.ok(Math.abs(frozen.cases[0].independentImplementation.numeric.riskRatio - ratio(ARMS[0])) < 1e-12);
  assert.equal(frozen.referenceImplementation.language, 'python');
  assert.match(frozen.cases[0].id, /^published-[a-f0-9]{24}$/);
  assert.deepEqual([f.requests.write.length, f.requests.review.length], [1, 1]);
});

test('tolerance is derived from the printed precision; what the model wrote is discarded', async t => {
  const f = await fixture(t); await f.curator.prepareCases(f.card);
  const reference = (await frozenOf(f.root)).cases[0].numeric.riskRatio;
  assert.equal(reference.printed, f.printed[0]);
  assert.ok(Math.abs(reference.absoluteTolerance - 0.0005) < 1e-9, String(reference.absoluteTolerance));
  assert.equal(reference.toleranceBasis, 'printed-precision'); assert.equal(reference.quantity, 'ratio');
  // A paper that prints only the null value cannot tell an implementation from "always 1".
  const trivial = await fixture(t, { mutate: p => { for (const item of p.cases) { item.numeric.riskRatio.value = 1; item.numeric.riskRatio.quote = 'The risk ratio was 1.0 overall.'; } } });
  assert.equal((await trivial.curator.prepareCases(trivial.card)).resourceCode, 'primary_numeric_quotation_bond_failed', 'the quotation is not in the source');
});

test('a quotation bonds a number as a token: a digit inside another number is not a bond', async t => {
  // "5" is a substring of "1,250" and of the risk ratio's own digits; the old check accepted both.
  const substring = await fixture(t, { mutate: p => { p.cases[0].numeric.riskRatio.value = 5; } });
  assert.equal((await substring.curator.prepareCases(substring.card)).resourceCode, 'primary_numeric_quotation_bond_failed');
  const input = await fixture(t, { mutate: p => { p.cases[0].input.specification.events = 1; p.cases[0].inputEvidence[0].value = 1; } });
  assert.equal((await input.curator.prepareCases(input.card)).resourceCode, 'primary_input_quotation_bond_failed');
  assert.equal(input.record.calls.length, 0, 'an unbonded input never reaches reference execution');
  const invented = await fixture(t, { mutate: p => { p.cases[0].input.specification.events = 99; } });
  assert.equal((await invented.curator.prepareCases(invented.card)).resourceCode, 'primary_input_quotation_bond_failed');
});

test('the reviewer writes the reference without the answers, and the reference is tested before it is believed', async t => {
  const f = await fixture(t); await f.curator.prepareCases(f.card);
  const [request] = f.requests.review, sent = JSON.stringify(request);
  assert.deepEqual(Object.keys(request).sort(), ['callableContract', 'developmentInputs', 'inputs', 'methodId', 'outputFields', 'sources']);
  for (const value of f.printed.slice(0, 2)) assert.equal(sent.includes(value), false, `expected value ${value} reached the reviewer`);
  assert.match(sent, /The risk ratio was \[withheld\]/);
  assert.equal(/absoluteTolerance|"numeric"|"quote"|"expected"/.test(sent), false);
  assert.ok(sent.includes('In the treated arm 13 of 80'), 'the method and inputs stay readable');
  // A "reference" that recites the published numbers is refused on its own code, before it is ever compared with them.
  const table = `import json,sys\ns=json.load(sys.stdin)["specification"]\nprint(json.dumps({"numeric":{"riskRatio":{13:${f.printed[0]},47:${f.printed[1]}}[s["events"]]}}))\n`;
  const reciting = await fixture(t, { referenceCode: table });
  assert.equal((await reciting.curator.prepareCases(reciting.card)).resourceCode, 'independent_reference_recites_published_values');
  // One that hides the numbers from the literal scan still fails: it is not a function of its input.
  const hidden = `import json,sys\ns=json.load(sys.stdin)["specification"]\nvalues=json.loads('{"13": ${f.printed[0]}, "47": ${f.printed[1]}}')\nprint(json.dumps({"numeric":{"riskRatio":values.get(str(s["events"]),values["13"])}}))\n`;
  const constant = await fixture(t, { referenceCode: hidden });
  assert.equal((await constant.curator.prepareCases(constant.card)).resourceCode, 'independent_reference_not_a_function_of_its_input');
  // And a wrong formula disagrees with the published numbers.
  const wrong = await fixture(t, { referenceCode: REFERENCE.replace('(s["events"]/s["total"])/', '(s["events"]/s["total"])*') });
  assert.equal((await wrong.curator.prepareCases(wrong.card)).resourceCode, 'independent_reference_disagrees');
  for (const refused of [reciting, constant, wrong]) await assert.rejects(readFile(path.join(refused.root, 'paper-gold/candidate-cases/new-method.json')), /ENOENT/);
});

test('development examples get ids and executed expectations, and the build path accepts them', async t => {
  const f = await fixture(t); await f.curator.prepareCases(f.card);
  const contract = JSON.parse(await readFile(path.join(f.root, 'paper-gold/candidate-cases/new-method.development.json'), 'utf8'));
  assert.deepEqual(contract.cases.map(item => item.id), ['development-1', 'development-2']);
  // Computed by the reference, not the 9 the model typed.
  assert.deepEqual(contract.cases.map(item => item.expected), [{ riskRatio: 0.5 }, { riskRatio: 2 }]);
  assert.doesNotMatch(JSON.stringify(contract), new RegExp(`${f.printed[0].replace('.', '\\.')}|10\\.1234|Published reference`));
  // The join the review found broken: curation output straight into development validation.
  const validator = createEvolutionDevelopmentValidation({ controller: f.controller });
  const candidate = body => ({ entrypoint: 'scripts/risk_ratio.py:risk_ratio', files: { 'scripts/risk_ratio.py': `def risk_ratio(specification):\n    s = specification\n${body}` } });
  const honest = candidate('    return {"riskRatio": (s["events"] / s["total"]) / (s["controlEvents"] / s["controlTotal"]), "note": "two arms"}\n');
  const validated = await validator.validate(honest, { contract });
  assert.equal(validated.ok, true, JSON.stringify(validated.issues));
  assert.equal((await validator.validate(candidate('    return {"riskRatio": 9}\n'), { contract })).ok, false, 'a candidate bent to the typed expectation fails the executed one');
  // And on into the evaluator: the frozen reference gives every candidate fresh cases.
  const evaluator = createEvolutionCandidateEvaluator({ config: { evaluationDataDir: f.root, dataDir: f.root }, controller: f.controller, auditCandidateExposure: async () => ({ tier: 'unexposed' }), fetchImpl: async () => new Response(JSON.stringify({ message: {} })) });
  const evaluated = await evaluator.evaluate({ ...honest, id: 'honest' }, { card: { methodId: 'new-method' } });
  assert.equal(evaluated.ok, true, JSON.stringify(evaluated.behaviour));
  assert.equal(evaluated.verificationLevel, 'V2');
  assert.ok(evaluated.behaviour.freshCases >= 6);
});

test('a third publication is held in reserve for the sudden-perfect review', async t => {
  const f = await fixture(t, { papers: 3 }), result = await f.curator.prepareCases(f.card);
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.publishedReferenceCount, 3); assert.equal(result.reservedCaseCount, 1);
  const frozen = await frozenOf(f.root);
  assert.equal(frozen.cases.filter(item => item.reserve === true).length, 1);
  assert.equal(new Set(frozen.cases.filter(item => !item.reserve).map(item => item.publicationId)).size, 2);
});

test('a toy example copied from a hidden publication is rejected', async t => {
  const f = await fixture(t, { mutate: p => { p.developmentCases[0].input = p.cases[0].input; } });
  assert.equal((await f.curator.prepareCases(f.card)).resourceCode, 'development_examples_expose_reference');
});
test('rejected primary references remain unavailable and retries reuse paid extraction', async t => {
  const f = await fixture(t, { reviewPassed: false });
  assert.equal((await f.curator.prepareCases(f.card)).resourceCode, 'independent_primary_review_failed');
  assert.equal((await f.curator.prepareCases(f.card)).ok, false); assert.deepEqual([f.requests.write.length, f.requests.review.length, f.record.calls.length], [1, 1, 0]);
});

test('production reference reviewer cannot certify configured or model-supplied Qwen identity', async () => {
 const value={passed:true,referenceCode:'print(1)',family:'qwen',independent:true};
 for(const [config,result] of [
  [{reviewProvider:'dashscope'},{value,model:'qwen-max',modelReported:false}],
  [{reviewProvider:'dashscope'},{value,model:'deepseek-flash',modelReported:true}],
  [{reviewProvider:'deepseek'},{value,model:'qwen-max',modelReported:true}],
 ]) {
  const checked=certifyEvolutionReferenceReview(config,result);
  assert.equal(checked.family,'unknown');assert.equal(checked.independent,false);
 }
 const certified=certifyEvolutionReferenceReview({reviewProvider:'dashscope'},{value,model:'qwen3.8-max-0902',modelReported:true});
 assert.equal(certified.family,'qwen');assert.equal(certified.independent,true);assert.equal(certified.referenceCode,value.referenceCode);
 const composition=await readFile(new URL('../src/evolutionComposition.mjs',import.meta.url),'utf8');
 assert.ok(composition.includes('return certifyEvolutionReferenceReview(config, result);'));
 // The two prompts no longer ask a model for a tolerance, for typed expectations, or to review numbers it is shown.
 assert.equal(/numeric:\{output_path:\{value,absoluteTolerance,quote\}\}|developmentCases:\[\{input,expected\}\]|implausibly wide tolerances/.test(composition),false);
 assert.deepEqual(value,{passed:true,referenceCode:'print(1)',family:'qwen',independent:true});
});
