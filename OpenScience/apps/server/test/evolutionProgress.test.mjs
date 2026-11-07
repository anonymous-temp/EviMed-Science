import test from 'node:test';
import assert from 'node:assert/strict';
import {evolutionProgress} from '../src/evolutionProgress.mjs';

test('a passing verdict enters progress only when its exact archive activates, in the activation window',()=>{
 const verdict={id:'v',payload:{candidateId:'tool',archiveId:'archive',moduleId:'tools',promote:true,confirmatory:true,receiptValid:true,at:'2026-10-05T12:00:00Z'}};
 const input={from:'2026-10-06T00:00:00Z',to:'2026-10-07T00:00:00Z',verdicts:[verdict]};
 assert.equal(evolutionProgress(input).confirmedVersions.length,0);
 const archive={id:'archive',payload:{status:'promoted',verdictId:'v',activatedAt:'2026-10-06T01:00:00Z'}};
 assert.equal(evolutionProgress({...input,archives:[archive]}).confirmedVersions.length,1);
 assert.equal(evolutionProgress({...input,archives:[{...archive,id:'another'}]}).confirmedVersions.length,0);
 assert.equal(evolutionProgress({...input,from:'2026-10-05T00:00:00Z',to:'2026-10-06T00:00:00Z',archives:[archive]}).confirmedVersions.length,0);
});

