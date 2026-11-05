import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { exportArtifacts } from './artifact-export.mjs';

/** Real hosted conversations. A result is evidence, not an automatic accuracy score. */
export async function runConversations({base,headers,installations,output,budget,budgetLimit=4,caseIds=null,readSkills=null,suite='formal',installationsForCase=null,afterTurn=null}) {
  if(!['formal','native-chain','completion','post-audit'].includes(suite))throw new Error('Invalid frozen suite');
  const formal=JSON.parse(await readFile(new URL('./conversation-cases.json',import.meta.url),'utf8'));
  const frozen=suite==='formal'?formal:suite==='post-audit'?[...formal.filter(item=>['11','13'].includes(item.id)),JSON.parse(await readFile(new URL('./post-audit-trial.json',import.meta.url),'utf8'))]:JSON.parse(await readFile(new URL(suite==='native-chain'?'./native-chain-cases.json':'./completion-cases.json',import.meta.url),'utf8'));
  if(caseIds&&(!Array.isArray(caseIds)||new Set(caseIds).size!==caseIds.length||caseIds.some(id=>!frozen.some(item=>item.id===id))))throw new Error('Invalid frozen-case selection');
  const cases=caseIds?frozen.filter(item=>caseIds.includes(item.id)):frozen;
  const results=[];
  await mkdir('/data/conversation-artifacts',{recursive:true,mode:0o700});
  const save=async()=>{const temporary=output+'.next';await writeFile(temporary,JSON.stringify({schemaVersion:1,denominator:cases.length,results},null,2)+'\n',{mode:0o600});await rename(temporary,output);};
  await save();
  for(const item of cases){
    const spend=await budget();
    if(spend>=budgetLimit){results.push({id:item.id,intent:item.intent,status:'not_run_budget'});await save();continue;}
    const projectId=`nativecase-${item.id}-${randomUUID().slice(0,8)}`;
    const result={id:item.id,intent:item.intent,projectId,status:'started',startedAt:new Date().toISOString()};results.push(result);await save();
    const deadline=Date.now()+(['explanation_no_tool','missing_input'].includes(item.intent)?180000:300000);
    const call=async(method,route,body,cleanup=false)=>{
      const remaining=cleanup?15000:Math.min(30000,deadline-Date.now());if(remaining<=0)throw new Error('Run exceeded its case wall deadline');
      const response=await fetch(base+route,{method,headers:{...headers,origin:base,'x-evimed-automated':'1','x-open-science-project':projectId},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(Math.max(1,remaining))});
      const value=await response.json();if(!response.ok)throw new Error(`${method} ${route} HTTP ${response.status} ${value.code??''}`);return value.data;
    };
    try {
      const selected=installationsForCase?installationsForCase(item):installations;
      await call('POST','/api/projects',{id:projectId,name:`Native case ${item.id}`});
      await call('PUT',`/api/projects/${projectId}/extensions`,{expectedRevision:0,selections:selected.map(id=>({installationId:id,enabled:true,settings:{},connectionRefs:[]}))});
      let view;
      for(let n=0;n<180;n++){view=await call('GET',`/api/projects/${projectId}/extensions`);if(view.selections.length===selected.length&&view.selections.every(row=>row.effective))break;await new Promise(resolve=>setTimeout(resolve,1000));}
      if(!view?.selections.every(row=>row.effective))throw new Error('Native project activation did not complete');
      const session=await call('POST','/api/runtime/sessions',{});result.sessionId=session.id;
      if(readSkills)result.researchSkills=await readSkills(projectId,session.id);
      await call('PUT',`/api/research-sessions/${session.id}`,{mode:'open-domain'});
      const run=await call('POST','/api/agent-runs/dispatch',{sessionId:session.id,dispatchId:`native-${randomUUID()}`,text:item.prompt,automated:true,line:'answer'});result.runId=run.id;
      while(Date.now()<deadline){
        const rows=await call('GET','/api/agent-runs');const current=(rows.items??rows.runs??rows).find(row=>row.id===run.id);
        if(current&& !['running','queued','waiting'].includes(current.status)){result.run=current;break;}
        await new Promise(resolve=>setTimeout(resolve,2000));
      }
      if(!result.run){await call('POST',`/api/agent-runs/${run.id}/cancel`,{},true);result.status='timed_out';throw new Error('Run exceeded its case wall deadline');}
      await exportArtifacts({result,caseId:item.id,base,headers,projectId,save});
      result.transcript=await call('GET',`/api/runtime/sessions/${session.id}/transcript`);
      result.status=['completed','succeeded','done'].includes(result.run.status)?'completed':'run_failed';
      await save();
      if(afterTurn)await afterTurn({projectId,result,call});
    } catch(error){if(Date.now()>=deadline){result.status='timed_out';if(result.runId){await call('POST',`/api/agent-runs/${result.runId}/cancel`,{},true).catch(()=>{});const latest=await call('GET','/api/agent-runs',undefined,true).catch(()=>null);const list=latest?.items??latest?.runs??latest;if(Array.isArray(list))result.run=list.find(row=>row.id===result.runId)??null;}if(result.sessionId)result.transcript=await call('GET',`/api/runtime/sessions/${result.sessionId}/transcript`,undefined,true).catch(()=>null);}else if(result.status!=='timed_out')result.status='error';result.error=String(error.message).slice(0,300);}
    finally {await call('POST','/api/commands/stop_runtime',{},true).catch(()=>{});result.finishedAt=new Date().toISOString();await save();}
  }
  return results;
}
