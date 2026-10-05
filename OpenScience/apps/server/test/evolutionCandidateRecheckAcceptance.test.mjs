import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { HttpError } from '../src/security.mjs';
import { recheckEvolutionAcceptanceCandidate, isEvolutionRecheckWithoutCandidate } from '../../../scripts/ops/evolution-candidate-recheck.mjs';
test('acceptance records a missing preserved candidate and continues later rechecks without starting another build',async()=>{
 const calls=[],results=[];
 const perform=async job=>{calls.push(job);assert.equal(job.payload.action,'recheck-candidate');if(job.payload.attempt===3)throw new HttpError(409,'evolution_evaluation_invalid','Rechecking cannot dispatch new development work.');return{status:'published'};};
 for(const attempt of [3,6])results.push(await recheckEvolutionAcceptanceCandidate(perform,{kind:'evolution-build',payload:{dossierId:'dossier',action:'recheck-candidate',attempt}}));
 assert.deepEqual(results[0],{status:'no-preserved-candidate',skipped:true,reasonCode:'no-completed-development-run',productionCode:'evolution_evaluation_invalid'});
 assert.equal(results[1].status,'published');assert.deepEqual(calls.map(job=>job.payload.attempt),[3,6]);assert.equal(calls.length,2);
 const main=await readFile(new URL('../../../scripts/ops/evolution-acceptance.mjs',import.meta.url),'utf8');
 assert.ok(main.includes('built = await recheckEvolutionAcceptanceCandidate(job => app.evolution.worker.perform(job),'));
 assert.ok(main.includes('reasonCode: built.reasonCode'));
});
test('integrity, resource, unrelated 409 and misleading error messages remain fatal',async()=>{
 const errors=[new HttpError(409,'evolution_evaluation_invalid','The original pinned prediction run evidence changed.'),new HttpError(503,'evolution_evaluation_invalid','Rechecking cannot dispatch new development work.'),new HttpError(409,'evolution_version_immutable','Rechecking cannot dispatch new development work.'),Object.assign(new Error('Rechecking cannot dispatch new development work.'),{code:'EIO',status:409}),new Error('Rechecking cannot dispatch new development work.')];
 for(const error of errors){assert.equal(isEvolutionRecheckWithoutCandidate(error),false);let calls=0;await assert.rejects(recheckEvolutionAcceptanceCandidate(async()=>{calls++;throw error;},{kind:'evolution-build',payload:{action:'recheck-candidate',attempt:3}}),caught=>caught===error);assert.equal(calls,1);}
});


test('the acceptance helper refuses a normal build before invoking production',async()=>{
 let calls=0;await assert.rejects(recheckEvolutionAcceptanceCandidate(async()=>{calls++;return{status:'published'};},{kind:'evolution-build',payload:{dossierId:'dossier'}}),/explicit preserved candidate attempt/);assert.equal(calls,0);
});
