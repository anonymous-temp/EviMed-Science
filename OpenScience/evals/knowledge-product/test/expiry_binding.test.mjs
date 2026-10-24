import test from 'node:test';import assert from 'node:assert/strict';
import { validateExpiryBinding } from '../native_lifecycle.mjs';
const receipt={arm:'baseline',collectorBase:'http://127.0.0.1:48841',database:'evimed_test_knowledge_evaluation_baseline_20261023',userId:'owner',projectId:'project'};
const actual={...receipt,databaseUrl:'postgresql://role:private@127.0.0.1:5432/'+receipt.database};
test('expiry refuses remote endpoints, other arm databases and forged context bindings',()=>{
 assert.equal(validateExpiryBinding(actual,receipt),true);
 for(const change of [{databaseUrl:actual.databaseUrl.replace('127.0.0.1','192.0.2.1')},{databaseUrl:actual.databaseUrl.replace('_baseline_','_candidate_')},{arm:'candidate'},{collectorBase:'http://127.0.0.1:48842'},{userId:'other'}])assert.throws(()=>validateExpiryBinding({...actual,...change},receipt),/binding/);
 assert.throws(()=>validateExpiryBinding(actual,null),/binding/);
});
