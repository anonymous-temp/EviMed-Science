import assert from 'node:assert/strict';
import test from 'node:test';
import { patientMatchingConfiguration } from '../src/patientMatchingConfiguration.mjs';

test('matching has its own Flash-only provider profile, independent of memory and general model choices', () => {
  const profile = patientMatchingConfiguration({ deepseekModel: 'deepseek-v4-pro', memoryRerankModel: 'other', memoryRerankApiBase: 'https://memory.example/rerank' }, {});
  assert.equal(profile.reasoningModel, 'deepseek-flash');
  assert.equal(profile.rerankModel, 'qwen3.7-text-rerank');
  assert.equal(profile.embeddingModel, 'qwen3.7-text-embedding');
  assert.equal(profile.rerankApiBase, 'https://dashscope.aliyuncs.com/compatible-api/v1/reranks');
  assert.equal(profile.proEscalation, false);
});

test('explicit matching deployment settings apply without reading memory settings', () => {
  const profile = patientMatchingConfiguration({ vcrMatchRerankModel: 'qwen3-rerank' }, { OPEN_SCIENCE_VCR_MATCH_RERANK_API_BASE: 'https://rerank.example/v1/reranks' });
  assert.equal(profile.rerankModel, 'qwen3-rerank');
  assert.equal(profile.rerankApiBase, 'https://rerank.example/v1/reranks');
});

test('a matching reasoning override cannot silently introduce another model', () => {
  assert.throws(() => patientMatchingConfiguration({ vcrMatchModel: 'deepseek-v4-pro' }, {}), { code: 'patient_matching_flash_required' });
  assert.throws(() => patientMatchingConfiguration({}, { OPEN_SCIENCE_VCR_MATCH_MODEL: 'deepseek-v4-pro' }), { code: 'patient_matching_flash_required' });
});

test('an explicitly empty matching endpoint remains disabled', () => {
  assert.equal(patientMatchingConfiguration({ vcrMatchRerankApiBase: '' }, {}).rerankApiBase, '');
});

test('blank deployment environment entries preserve code defaults', () => {
  const blank = Object.fromEntries(['MODEL', 'EMBEDDING_MODEL', 'RERANK_MODEL', 'RERANK_API_BASE'].map(name => [`OPEN_SCIENCE_VCR_MATCH_${name}`, '']));
  assert.deepEqual(patientMatchingConfiguration({}, blank), patientMatchingConfiguration({}, {}));
});
