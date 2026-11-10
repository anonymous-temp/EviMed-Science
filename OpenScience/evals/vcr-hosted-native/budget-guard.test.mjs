import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installBudgetGuard } from './budget-guard.mjs';
test('budget serializes all-account reservations and retains uncertain spend',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'native-budget-'));const file=path.join(root,'budget.json');
  const ledger={reserveModel:async()=>({}),settleModel:async()=>({}),release:async()=>({status:'released'}),markUncertain:async()=>({})};
  try{const guard=await installBudgetGuard(ledger,{file,limit:4});const make=(id,user,estimatedCost)=>({id,userId:user,model:'deepseek-flash',currency:'CNY',estimatedCost,requestFingerprint:id,purpose:'test'});
    const results=await Promise.allSettled([ledger.reserveModel(make('one','a',2.5)),ledger.reserveModel(make('two','b',2.5))]);assert.deepEqual(results.map(r=>r.status),['fulfilled','rejected']);
    await ledger.markUncertain('a','one',{});await assert.rejects(ledger.reserveModel(make('three','a',2)));
    await ledger.settleModel('a','one',{priced:true,actualCost:1});await ledger.reserveModel(make('three','a',2));
    const snapshot=JSON.parse(await readFile(file));assert.equal(snapshot.calls.one.status,'settled');assert.equal(snapshot.calls.three.status,'reserved');await guard.close();
  }finally{await rm(root,{recursive:true,force:true});}
});
