import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluationCells } from '../coverage.mjs';
import benchmark from '../cases.json' with {type:'json'};
test('90 unique question groups expand across size, material and memory arms without pseudoreplication',()=>{
 const cells=evaluationCells(benchmark);
 assert.equal(new Set(cells.map(c=>c.caseId)).size,90);
 for(const dimension of ['small','medium','large','knowledge','memory','combined','zh','en','office','table','code','malicious-original'])assert.ok(cells.some(c=>Object.values(c).includes(dimension)),dimension);
});
test('frozen inputs include genuine PDF and original-only ZIP within the same 90 groups',()=>{
 assert.ok(benchmark.sources.some(s=>s.path.endsWith('.pdf')));
 assert.ok(benchmark.sources.some(s=>s.path.endsWith('.zip')));
 assert.ok(benchmark.cases.some(c=>c.evaluation?.format==='archive'&&c.evaluation.originalOnly));
});
