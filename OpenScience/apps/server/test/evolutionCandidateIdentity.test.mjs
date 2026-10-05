import test from 'node:test';
import assert from 'node:assert/strict';
import { bindEvolutionCandidateIdentity } from '../src/evolutionCandidateIdentity.mjs';
test('missing or invented candidate identity cannot replace trusted dossier track, method or capability scope',()=>{
  const card={track:'M',methodId:'cohort-state-transition',toolKind:'calculation',capabilityIds:['statistical-analysis']};
  const files={'scripts/tool.py':'source'};
  const result=bindEvolutionCandidateIdentity({track:'clinical',methodId:'invented',toolKind:'workflow',capabilityIds:['unsafe-other'],files},card);
  assert.deepEqual({track:result.track,methodId:result.methodId,toolKind:result.toolKind,capabilityIds:result.capabilityIds},card);
  assert.equal(result.files,files);assert.equal(bindEvolutionCandidateIdentity({files},card).track,'M');
  result.capabilityIds.push('changed');assert.deepEqual(card.capabilityIds,['statistical-analysis']);
  assert.deepEqual(bindEvolutionCandidateIdentity({capabilityIds:['model-invented']},{track:'M'}).capabilityIds,[]);
});
