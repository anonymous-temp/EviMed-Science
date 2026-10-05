import test from 'node:test';
import assert from 'node:assert/strict';
import { trustedEvolutionNativeName } from '../src/evolutionToolRouting.mjs';
test('public native identity is the bounded publisher receipt, never a candidate alias or fabricated legacy name',()=>{
  const trusted={nativeName:`platform-${'a'.repeat(24)}`};
  assert.equal(trustedEvolutionNativeName(trusted),trusted.nativeName);
  assert.equal(trustedEvolutionNativeName({}),undefined);
  assert.equal(trustedEvolutionNativeName({nativeName:'candidate_alias'}),undefined);
  assert.equal(trustedEvolutionNativeName({nativeName:`platform-${'a'.repeat(1000)}`}),undefined);
});
