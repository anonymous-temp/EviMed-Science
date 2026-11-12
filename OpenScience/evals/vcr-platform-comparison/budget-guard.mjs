/** A local benchmark-only ingress budget, covering every model purpose/account.
 * The durable journal survives throwaway-account deletion. Unknown calls retain
 * their entire reservation. It uses the platform's reference-price estimates.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export async function installBudgetGuard(ledger,{file,totalLimit=200,accountLimit=5}) {
  if(!ledger||!path.isAbsolute(file)||![totalLimit,accountLimit].every(n=>Number.isFinite(n)&&n>0))throw new Error('Invalid benchmark budget');
  await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
  const lock=await fs.open(file+'.lock','wx',0o600);
  await lock.writeFile(JSON.stringify({pid:process.pid,createdAt:new Date().toISOString()})+'\n');
  let book;
  try{book=JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code!=='ENOENT'){await lock.close();await fs.unlink(file+'.lock');throw error;}book={version:1,totalLimit,accountLimit,calls:{}};}
  if(book.version!==1||book.totalLimit!==totalLimit||book.accountLimit!==accountLimit){await lock.close();await fs.unlink(file+'.lock');throw new Error('Frozen budget differs');}
  let queue=Promise.resolve(),closed=false,closing=null;
  const serial=fn=>{const result=queue.then(fn);queue=result.catch(()=>{});return result;};
  const save=async()=>{await fs.writeFile(file+'.tmp',JSON.stringify(book,null,2)+'\n',{mode:0o600});await fs.rename(file+'.tmp',file);};
  const cost=row=>row.status==='released'?0:row.status==='settled'?row.actualCost:row.reservedCost;
  const originals=Object.fromEntries(['reserveModel','settleModel','release','markUncertain'].map(name=>[name,ledger[name].bind(ledger)]));
  const deny=message=>Object.assign(new Error(message),{status:402,code:'benchmark_budget_exceeded'});
  ledger.reserveModel=input=>serial(async()=>{
    if(closed)throw deny('Benchmark budget is closed');
    if(!['deepseek-flash','deepseek-v4-flash'].includes(input.model)||input.currency!=='CNY'
      ||!Number.isFinite(input.estimatedCost)||input.estimatedCost<0)throw deny('Only priced Flash calls are admitted');
    const previous=book.calls[input.id];
    if(previous){
      if(previous.userId!==input.userId||previous.fingerprint!==input.requestFingerprint)throw deny('Reservation ownership differs');
      return originals.reserveModel(input);
    }
    const held=Object.values(book.calls);
    if(held.reduce((sum,row)=>sum+cost(row),0)+input.estimatedCost>totalLimit
       ||held.filter(row=>row.userId===input.userId).reduce((sum,row)=>sum+cost(row),0)+input.estimatedCost>accountLimit)throw deny('Benchmark model budget exhausted');
    const row={userId:input.userId,purpose:input.purpose,model:input.model,fingerprint:input.requestFingerprint,
      reservedCost:input.estimatedCost,status:'reserved',startedAt:new Date().toISOString()};
    book.calls[input.id]=row;await save();
    try{return await originals.reserveModel(input);}
    catch(error){row.status='released';row.reason='reservation_refused_before_provider';await save();throw error;}
  });
  ledger.settleModel=(userId,id,input)=>closed?originals.settleModel(userId,id,input):serial(async()=>{
    const result=await originals.settleModel(userId,id,input);const row=book.calls[id];
    if(row&&row.userId===userId&&input.priced&&Number.isFinite(input.actualCost)&&input.actualCost>=0){
      row.status='settled';row.actualCost=input.actualCost;row.exceededReservation=input.actualCost>row.reservedCost;await save();
    }
    return result;
  });
  ledger.release=(userId,id,errorCode)=>closed?originals.release(userId,id,errorCode):serial(async()=>{
    const result=await originals.release(userId,id,errorCode);const row=book.calls[id];
    if(row&&row.userId===userId&&result?.status==='released'){row.status='released';await save();}return result;
  });
  ledger.markUncertain=(...args)=>closed?originals.markUncertain(...args):serial(async()=>{const result=await originals.markUncertain(...args);await save();return result;});
  await save();
  return {file,totalLimit,accountLimit,close(){closed=true;return closing??=(async()=>{await queue;await save();await lock.close();await fs.unlink(file+'.lock');})();}};
}
