// Native evaluation transport, shared by clinical and conversation probes.
// No inference SDK, reference loader, provider credential or production route.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export async function createNativeDsh({root,executable,dump,gateway,token,maxTokens=4000,mcpGateway=null}) {
  const disabled=[...dump.matchAll(/^- id: (tool-[^\n]+)/gm)].map(row=>row[1]).concat([
    'session-telemetry-otel','session-title-llm','llm-deepseek-account','skill-filesystem',
    'agent-instructions','permission','session-log-deepseek','plugin-package-inventory-deepseek']);
  let patch=[...disabled.map(id=>`- id: ${id}\n  disabled: true`),
    `- id: llm-deepseek\n  config:\n    baseURL: ${JSON.stringify(gateway)}\n    apiKeyEnv: CLINICAL_EVAL_WORKLOAD_TOKEN\n    thinking: disabled\n    reasoningEffort: off\n    maxTokens: ${maxTokens}`,
    '- id: approval\n  config:\n    policy: never'].join('\n');
  if(mcpGateway){
    const tokenFile=path.join(root,'workload-token');await fs.writeFile(tokenFile,token,{mode:0o600});
    patch+=`\n- insert:\n    - id: mcp-evimed\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        transport: stdio\n        serverName: evimed\n        failOnStartupError: true\n        command: python3\n        args: [${JSON.stringify(fileURLToPath(new URL('./native_vcr_mcp.py',import.meta.url)))}]\n        env:\n          EVIMED_VCR_GATEWAY_URL: ${JSON.stringify(mcpGateway)}\n          EVIMED_PUBLIC_SOURCE_GATEWAY_URL: ${JSON.stringify(mcpGateway)}\n          EVIMED_MODEL_GATEWAY_TOKEN_FILE: ${JSON.stringify(tokenFile)}\n`;
  }
  await fs.writeFile(path.join(root,'patch.yml'),patch,{mode:0o600});
  return async({prompt,filename,sessionId=null})=>{
    const cwd=path.join(root,'workspace');await fs.mkdir(cwd,{recursive:true});
    const args=['headless','--patch',path.join(root,'patch.yml'),'--json',...(sessionId?['--session-id',sessionId]:[]),prompt];
    const child=spawn(executable,args,{cwd,env:{PATH:process.env.PATH,DSH_HOME:path.join(root,'sessions'),DSH_TELEMETRY_MODE:'DISABLED',CLINICAL_EVAL_WORKLOAD_TOKEN:token},stdio:['ignore','pipe','pipe']});
    let output='',diagnostics='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>diagnostics+=x);
    const timer=setTimeout(()=>child.kill('SIGTERM'),180000);const started=Date.now();
    const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});clearTimeout(timer);
    await fs.writeFile(path.join(root,filename+'.events.jsonl'),output,{mode:0o600});
    await fs.writeFile(path.join(root,filename+'.diagnostics.log'),diagnostics,{mode:0o600});
    const events=output.split('\n').filter(Boolean).map(line=>{try{return JSON.parse(line);}catch{return{type:'unparsed'};}});
    return {code,events,latencyMs:Date.now()-started,sessionId:events.find(e=>e.type==='session')?.sessionId??sessionId,
      text:events.findLast(e=>e.type==='final')?.text??'',diagnosticBytes:diagnostics.length};
  };
}
