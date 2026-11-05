import assert from 'node:assert/strict'
import test from 'node:test'
import { loadHarnessModule } from '@evimed/harness-port'
import { nativeResponseSchema } from '../src/manifest.mjs'
import { patientMatchingOutputSchema } from '../../../apps/server/src/patientMatchingOutputSchema.mjs'
import { fixture } from './fixture.mjs'
const { assertObjectJsonSchema, validateJsonSchemaValue } = await loadHarnessModule('@deepseek-ai/dsh-tools')
test('the actual full host response schema compiles on the pinned native kernel, including nullable priority', () => {
  const f = fixture(), schema = nativeResponseSchema(patientMatchingOutputSchema({ scope: f.scope, profileDigest: f.prepared.profileDigest, executionId: f.prepared.executionId, maxPairs: 1 }))
  assert.doesNotThrow(() => assertObjectJsonSchema(schema))
  for (const priority of [null, 0.15]) assert.deepEqual(validateJsonSchemaValue(schema, { decisions: [{ ...f.decision, recommendation: { ...f.decision.recommendation, priority } }] }), [])
  assert.ok(validateJsonSchemaValue(schema, { decisions: [{ ...f.decision, recommendation: { priority: 'invented', rationale: 'Invalid type' } }] }).length > 0)
})
test('nullable object, array and scalar fields recursively retain exact native type alternatives', () => {
  const schema = nativeResponseSchema({ type: 'object', additionalProperties: false, required: ['metadata', 'tags'], properties: {
    metadata: { type: ['object', 'null'], additionalProperties: false, required: ['label'], properties: { label: { type: ['string', 'null'] } } },
    tags: { type: ['array', 'null'], items: { type: ['string', 'null'] } },
  } })
  assert.doesNotThrow(() => assertObjectJsonSchema(schema))
  for (const value of [{ metadata: null, tags: null }, { metadata: { label: null }, tags: [null, 'text'] }]) assert.deepEqual(validateJsonSchemaValue(schema, value), [])
  for (const value of [{ metadata: {}, tags: null }, { metadata: null, tags: 0 }, { metadata: { label: false }, tags: [] }]) assert.ok(validateJsonSchemaValue(schema, value).length > 0)
})
test('the exact0to1priority domain and concise all-pair guidance are visible after native schema conversion',()=>{
 const f=fixture(),schema=nativeResponseSchema(patientMatchingOutputSchema({scope:f.scope,profileDigest:f.prepared.profileDigest,executionId:f.prepared.executionId,maxPairs:1}));
 assert.match(JSON.stringify(schema),/priority from 0 to 1 inclusive/);assert.match(schema.description,/every selected/);assert.match(schema.properties.decisions.items.properties.criteria.items.properties.reason.description,/brief source-backed/);
});
test('formal criterion identity is constrained without discarding registry demographic authority',()=>{
 const f=fixture(),schema=nativeResponseSchema(patientMatchingOutputSchema({scope:f.scope,profileDigest:f.prepared.profileDigest,executionId:f.prepared.executionId,maxPairs:1,criterionIds:['c1']}));
 assert.match(schema.properties.decisions.items.properties.criteria.items.properties.criterionId.description,/Provided formal IDs: \["c1"\]/);
 const valid={decisions:[f.decision]},invented=structuredClone(valid);invented.decisions[0].criteria[0].criterionId='demographics-age';
 assert.deepEqual(validateJsonSchemaValue(schema,valid),[]);assert.deepEqual(validateJsonSchemaValue(schema,invented),[],'the envelope remains structural; the core enforces identity per decision');
 assert.match(schema.properties.decisions.items.properties.clinicalEligibility.description,/AND the trial profile demographics/);assert.match(schema.properties.decisions.items.properties.criteria.items.properties.basis.description,/successful match_compute receipt/);
});
