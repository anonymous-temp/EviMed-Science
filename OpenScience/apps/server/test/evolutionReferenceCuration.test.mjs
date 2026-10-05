import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEvolutionReferenceCuration, certifyEvolutionReferenceReview } from '../src/evolutionReferenceCuration.mjs';
async function fixture(t, mutate = () => {}, reviewPassed = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'evolution-reference-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const papers = [{ doi: '10.1234/one' }, { doi: '10.1234/two' }];
  const proposed = { callableContract: { argument: 'specification', result: 'sum' },
    developmentCases: [{ input: { specification: { x: 10 } }, expected: { sum: 11 } }, { input: { specification: { x: 20 } }, expected: { sum: 21 } }],
    cases: papers.map((paper, i) => ({ publicationId: paper.doi, input: { specification: { x: i + 1 } },
      inputEvidence: [{ path: 'specification.x', value: i + 1, quote: `input ${i + 1}` }], numeric: { sum: { value: i + 2, absoluteTolerance: 0, quote: `output ${i + 2}` } } })) };
  mutate(proposed); let writes = 0, reviews = 0, executions = 0;
  const curator = createEvolutionReferenceCuration({ config: { evaluationDataDir: root },
    fetchImpl: async url => {
      const link = String(url);
      if (link.startsWith('https://api.crossref.org/')) return new Response(JSON.stringify({ message: {} }));
      if (link.includes('/search?')) { const i = decodeURIComponent(link).includes('one') ? 0 : 1; return new Response(JSON.stringify({ resultList: { result: [{ id: String(i + 1), pmcid: `PMC${i + 1}`, doi: papers[i].doi, title: `Published reference ${i + 1}` }] } })); }
      assert.match(link, /^https:\/\/www.ebi.ac.uk\/europepmc\/webservices\/rest\/PMC[12]\/fullTextXML$/);
      const i = link.includes('PMC1/') ? 0 : 1;
      return new Response(`<article><p>input ${i + 1}</p><p>output ${i + 2}</p></article>`);
    },
    write: async () => { writes++; return proposed; },
    review: async () => { reviews++; return { passed: reviewPassed, family: 'qwen', referenceCode: 'independent-formula' }; },
    controller: { execVerify: async ({ input }) => { executions++; return { ok: true, joined: true, output: JSON.stringify({ numeric: { sum: input.specification.x + 1 } }) }; } },
  });
  return { root, curator, card: { methodId: 'new-method', papers }, counts: () => ({ writes, reviews, executions }) };
}
test('a new method gains independently executed primary references without returning hidden numbers', async t => {
  const f = await fixture(t), result = await f.curator.prepareCases(f.card);
  assert.equal(result.ok, true); assert.equal(result.publishedReferenceCount, 2); assert.equal(result.access, 'evaluation-only'); assert.equal('cases' in result, false);
  const frozen = JSON.parse(await readFile(path.join(f.root, 'paper-gold/candidate-cases/new-method.json'), 'utf8'));
  assert.equal(frozen.frozen, true); assert.equal(frozen.cases[0].independentImplementation.numeric.sum, 2);
  assert.deepEqual(f.counts(), { writes: 1, reviews: 1, executions: 2 });
});
test('invented inputs cannot reach independent reference execution', async t => {
  const f = await fixture(t, p => { p.cases[0].input.specification.x = 99; });
  assert.equal((await f.curator.prepareCases(f.card)).resourceCode, 'primary_input_quotation_bond_failed'); assert.equal(f.counts().executions, 0);
});
test('a toy example copied from a hidden publication is rejected', async t => {
  const f = await fixture(t, p => { p.developmentCases[0].input = p.cases[0].input; });
  assert.equal((await f.curator.prepareCases(f.card)).resourceCode, 'development_examples_expose_reference');
});
test('rejected primary references remain unavailable and retries reuse paid extraction', async t => {
  const f = await fixture(t, () => {}, false);
  assert.equal((await f.curator.prepareCases(f.card)).resourceCode, 'independent_primary_review_failed');
  assert.equal((await f.curator.prepareCases(f.card)).ok, false); assert.deepEqual(f.counts(), { writes: 1, reviews: 1, executions: 0 });
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
 assert.deepEqual(value,{passed:true,referenceCode:'print(1)',family:'qwen',independent:true});
});
