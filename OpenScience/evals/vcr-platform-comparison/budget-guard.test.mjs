import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { installBudgetGuard } from './budget-guard.mjs';

const fake=()=>({reserveModel:async input=>input,settleModel:async(...args)=>args,release:async()=>({status:'released'}),markUncertain:async()=>null});
const request=(id,userId='a',cost=3)=>({id,userId,model:'deepseek-flash',purpose:'vcr',currency:'CNY',estimatedCost:cost,requestFingerprint:id});
test('all purposes including VCR are bounded atomically and survive account deletion/restart',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'vcr-budget-'));const file=path.join(root,'budget.json');let guard;
  try{
    const ledger=fake();guard=await installBudgetGuard(ledger,{file,totalLimit:7,accountLimit:5});
    const attempts=await Promise.allSettled([ledger.reserveModel(request('a')),ledger.reserveModel(request('b'))]);
    assert.deepEqual(attempts.map(r=>r.status),['fulfilled','rejected']);
    await ledger.markUncertain('a','a','network');
    await assert.rejects(ledger.reserveModel(request('c','a')),error=>error.code==='benchmark_budget_exceeded');
    await ledger.reserveModel({...request('d','other'),purpose:'open-domain'});
    await assert.rejects(ledger.reserveModel(request('e','third',2)));
    await guard.close();guard=null;
    const next=fake();guard=await installBudgetGuard(next,{file,totalLimit:7,accountLimit:5});
    await assert.rejects(next.reserveModel(request('f','new',2)),undefined,'deleting a test account does not reset the campaign total');
    await next.settleModel('other','d',{actualCost:.5,priced:true});
    await next.reserveModel(request('g','new',2));
    await next.release('new','g','refused');
    await assert.rejects(next.reserveModel({...request('pro'),model:'deepseek-v4-pro'}));
  }finally{await guard?.close();await fs.rm(root,{recursive:true,force:true});}
});

test('a swept uncertain ledger result is never released by the benchmark guard',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'vcr-budget-'));let guard;
  try{
    const ledger={...fake(),release:async()=>({status:'uncertain'})};
    guard=await installBudgetGuard(ledger,{file:path.join(root,'budget.json'),totalLimit:5,accountLimit:5});
    await ledger.reserveModel(request('first','a',5));
    await ledger.release('a','first','swept');
    await assert.rejects(ledger.reserveModel(request('second','a',5)));
  }finally{await guard?.close();await fs.rm(root,{recursive:true,force:true});}
});

test('late settlement on a closed guard cannot overwrite its successor',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'vcr-budget-'));const file=path.join(root,'budget.json');let current;
  try{
    const old=fake();const first=await installBudgetGuard(old,{file,totalLimit:20,accountLimit:10});
    await old.reserveModel(request('first'));await first.close();await first.close();
    const next=fake();current=await installBudgetGuard(next,{file,totalLimit:20,accountLimit:10});
    await next.reserveModel(request('second','b'));
    await old.release('a','first','late');await old.settleModel('a','first',{actualCost:.1,priced:true});await old.markUncertain('a','first','late');
    const saved=JSON.parse(await fs.readFile(file,'utf8'));assert.ok(saved.calls.second);assert.equal(saved.calls.first.status,'reserved');
  }finally{await current?.close();await fs.rm(root,{recursive:true,force:true});}
});
