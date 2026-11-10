import fs from 'node:fs/promises';
/** Bound every account and purpose before provider dispatch; uncertain calls retain their reservations. */
export async function installBudgetGuard(ledger,{file,limit}) {
  if(!ledger||!Number.isFinite(limit)||limit<=0||limit>4)throw new Error('Invalid formal budget');
  const calls={},book={schemaVersion:1,limitCny:limit,calls,rejections:[]};let queue=Promise.resolve(),closed=false;
  const serial=fn=>{const task=queue.then(fn);queue=task.catch(()=>{});return task;};
  const save=async()=>{await fs.writeFile(file+'.next',JSON.stringify(book)+'\n',{mode:0o600});await fs.rename(file+'.next',file);};
  const original=Object.fromEntries(['reserveModel','settleModel','release','markUncertain'].map(name=>[name,ledger[name].bind(ledger)]));
  const charge=row=>row.status==='released'?0:row.status==='settled'?row.actualCost:row.reservedCost;
  const deny=async(input,reason)=>{const held=Object.values(calls).reduce((sum,row)=>sum+charge(row),0);book.rejections.push({at:new Date().toISOString(),reason,heldCny:held,requestedCny:input?.estimatedCost??null,limitCny:limit,purpose:input?.purpose??null,model:input?.model??null});await save();await fs.writeFile(file+'.exhausted','budget_or_model_refused\n',{mode:0o600});return Object.assign(new Error('Formal model budget exhausted or unpriced model refused'),{status:402,code:'benchmark_budget_exceeded'});};
  ledger.reserveModel=input=>serial(async()=>{
    if(closed||!['deepseek-flash','deepseek-v4-flash'].includes(input.model)||input.currency!=='CNY'||!Number.isFinite(input.estimatedCost)||input.estimatedCost<0)throw await deny(input,'unpriced_or_closed');
    const existing=calls[input.id];if(existing){if(existing.userId!==input.userId||existing.fingerprint!==input.requestFingerprint)throw await deny(input,'identity_mismatch');return original.reserveModel(input);}
    if(Object.values(calls).reduce((sum,row)=>sum+charge(row),0)+input.estimatedCost>limit)throw await deny(input,'limit');
    const row={userId:input.userId,purpose:input.purpose,model:input.model,fingerprint:input.requestFingerprint,reservedCost:input.estimatedCost,status:'reserved'};
    calls[input.id]=row;await save();
    try{return await original.reserveModel(input);}catch(error){row.status='released';await save();throw error;}
  });
  ledger.settleModel=(userId,id,input)=>serial(async()=>{const result=await original.settleModel(userId,id,input),row=calls[id];if(row&&row.userId===userId&&input.priced&&Number.isFinite(input.actualCost)&&input.actualCost>=0){row.status='settled';row.actualCost=input.actualCost;row.exceededReservation=input.actualCost>row.reservedCost;}await save();return result;});
  ledger.release=(userId,id,code)=>serial(async()=>{const result=await original.release(userId,id,code),row=calls[id];if(row&&row.userId===userId&&result?.status==='released')row.status='released';await save();return result;});
  ledger.markUncertain=(...args)=>serial(async()=>{const result=await original.markUncertain(...args);await save();return result;});
  await save();
  return {close:async()=>{closed=true;await queue;await save();}};
}
