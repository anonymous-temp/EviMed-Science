import fs from 'node:fs/promises';
import pg from '../../apps/server/node_modules/pg/lib/index.js';
const client=new pg.Client({connectionString:process.env.VCR_TEST_DATABASE});await client.connect();
const rows=await client.query("SELECT id FROM evimed_control.users WHERE id LIKE 'native_%' ORDER BY created_at DESC LIMIT 1");await client.end();
if(rows.rows.length!==1)throw new Error('test account unavailable');
const base='http://127.0.0.1:8787';
const response=await fetch(base+'/api/auth/login',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({username:rows.rows[0].id,password:'native-test-password-47'})});
if(!response.ok)throw new Error('test account login failed');const data=await response.json();
const auth={cookie:response.headers.get('set-cookie').split(';')[0],'x-open-science-csrf':data.data.csrfToken,'content-type':'application/json',origin:base,'x-evimed-automated':'1'};
const stopped=new Set();
while(true){
  try{
    const target=(await fs.readFile('/data/watchdog-target.txt','utf8')).trim();if(!['conversation-results.json','native-chain-results.json'].includes(target))throw new Error('invalid watchdog target');
    const p='/data/'+target, stat=await fs.stat(p), results=JSON.parse(await fs.readFile(p,'utf8')).results, last=results.at(-1);
    if(last?.status==='started'&&!stopped.has(last.id)){
      const deadline=['explanation_no_tool','missing_input'].includes(last.intent)?180000:300000;
      if(Date.now()-stat.mtimeMs>=deadline){
        const h={...auth,'x-open-science-project':last.projectId};
        const list=await fetch(base+'/api/agent-runs',{headers:h,signal:AbortSignal.timeout(15000)});const json=await list.json();const items=json.data?.items??json.data?.runs??json.data??[];
        const active=items.filter(run=>['running','queued','waiting'].includes(run.status)&&run.automated===true);
        for(const run of active){const cancel=await fetch(base+`/api/agent-runs/${encodeURIComponent(run.id)}/cancel`,{method:'POST',headers:h,body:'{}',signal:AbortSignal.timeout(15000)});if(cancel.ok){await fs.appendFile('/data/conversation-watchdog.jsonl',JSON.stringify({id:last.id,runId:run.id,reason:'case_wall_deadline',at:new Date().toISOString()})+'\n',{mode:0o600});stopped.add(last.id);}}
      }
    }
  }catch(error){await fs.appendFile('/data/conversation-watchdog.jsonl',JSON.stringify({event:'watchdog_error',message:String(error.message).slice(0,120)})+'\n',{mode:0o600});}
  await new Promise(resolve=>setTimeout(resolve,5000));
}
