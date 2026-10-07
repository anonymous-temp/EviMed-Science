import test from 'node:test';import assert from 'node:assert/strict';
import {driftSummaryFromRows} from '../src/judgePersistence.mjs';
const config={reviewJevModel:'jev-1.13.0',jevSites:{J2:{baselineAgreement:.95,promptFingerprint:'pin'}}};
const at=new Date('2026-10-08T12:00:00Z');const rows=Array.from({length:7},(_,i)=>({site:'J2',model:config.reviewJevModel,prompt_fingerprint:'pin',day:`2026-10-0${i+1}`,observations:4,agreement:.9}));
test('seven completed observed UTC days below calibrated baseline alert',()=>{assert.equal(driftSummaryFromRows(rows,config,at)[0].belowBaselineSevenDays,true);});
test('missing day, changed model or changed policy never invents seven-day drift',()=>{for(const data of [rows.slice(1),rows.map(row=>({...row,model:'jev-2.0.0'})),rows.map(row=>({...row,prompt_fingerprint:'other'})),rows.map((row,i)=>i===0?{...row,agreement:.96}:row)])assert.equal(driftSummaryFromRows(data,config,at)[0].belowBaselineSevenDays,false);});
