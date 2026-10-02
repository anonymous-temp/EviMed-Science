import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {browserSessionCookie,generateBrowserSessionSecret} from '/fixture/platform/server/dshBrowserAuth.mjs';
const home='/tmp/home',profile=home+'/profiles/catalogue';await fs.mkdir(profile,{recursive:true});await fs.mkdir('/tmp/workspace',{recursive:true});
const secret=generateBrowserSessionSecret();await fs.writeFile(home+'/.credentials.yaml',JSON.stringify({version:1,records:{'client-connection/browser-session':{kind:'grant',payload:{version:1,secret}}},refs:{}}),{mode:0o600});
await fs.writeFile(profile+'/package.json',JSON.stringify({name:'evimed-scoped-catalogue-fixture',private:true,dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']}}}));await fs.writeFile(profile+'/cordis.yml','[]\n');
await fs.writeFile(profile+'/cordis.patch.yml',`
- id: session-log-deepseek
  disabled: true
- id: hmr
  disabled: true
- id: plugin-manager
  disabled: true
- id: llm-deepseek-account
  disabled: true
- id: skill-filesystem
  disabled: true
- id: preset-standard
  disabled: true
- id: preset-minimal
  disabled: true
- id: preset-ptc
  disabled: true
- id: preset-cordis
  disabled: true
- id: agent-preset-registry
  config:
    default: catalogue-proof
- insert:
    - id: catalogue
      name: /fixture/platform/catalogue.mjs
    - id: preset-catalogue-proof
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: catalogue-proof
        plugins:
          - id: skill-filesystem
            name: '@deepseek-ai/dsh-skill-filesystem'
            config:
              includeDefaultRoots: false
              watch: false
              customSkillDirs:
                - /opt/evimed/socket/presets/evimed-universal/skills/core
                - /opt/evimed/socket/presets/evimed-universal/skills/community
                - /opt/evimed/personal-skills
          - id: tool-skill
            name: '@deepseek-ai/dsh-tool-skill'
`);
const child=spawn(process.execPath,['/opt/sdk/node_modules/@deepseek-ai/dsh/lib/bin.js','--profile','catalogue','--host','127.0.0.1','--port','19091','--no-open'],{cwd:'/tmp/workspace',env:{PATH:process.env.PATH,HOME:home,DSH_HOME:home,DSH_TELEMETRY_DISABLED:'1',NARB_DISABLE_NATIVE_CACHE:'1'},stdio:['ignore','pipe','pipe']});let diagnostic='';for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>{diagnostic=(diagnostic+bytes).slice(-12000);});
const call=async(method,request)=>{const response=await fetch('http://127.0.0.1:19091/api/'+method,{method:'POST',headers:{cookie:browserSessionCookie({secret,authority:'127.0.0.1:19091'}),'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:'catalogue-proof',method,payload:{args:method==='session/list'?{_request:{}}:{request}}}),signal:AbortSignal.timeout(5000)});const result=await response.json();if(!result.result?.ok)throw Error(JSON.stringify(result.result?.error));return result.result.value;};
try{
 let ready=false;for(let i=0;i<120;i++){try{await call('session/list',null);ready=true;break;}catch{ /* The bounded startup poll retries before reporting retained diagnostics. */ }if(child.exitCode!==null)break;await new Promise(resolve=>setTimeout(resolve,100));}if(!ready)throw Error('catalogue_kernel_not_ready '+diagnostic.replace(/token=[^\s]+/g,'token=[fixture]'));
 const sessionId='catalogue-session';await call('session/create',{sessionId,cwd:'/tmp/workspace',agentPreset:'catalogue-proof'});
 const list=await call('evimedSkills/list',{sessionId});assert.equal(list.complete,true);assert(list.items.some(item=>item.name==='catalogue-template'&&item.source==='builtin'&&!item.invocation.userInvocable));assert(list.items.some(item=>item.source==='community'));assert(list.items.some(item=>item.source==='personal'&&!item.canDuplicate));
 const personal=list.items.find(item=>item.source==='personal');const personalBody=await call('evimedSkills/read',{sessionId,key:personal.key});assert(personalBody.resources.some(item=>item.path==='资料/证据.csv'));assert.equal(personalBody.canDuplicate,false);assert.equal(Object.hasOwn(personalBody,'entries'),false);await assert.rejects(call('evimedSkills/snapshotBuiltin',{sessionId,key:personal.key}));
 const key=list.items.find(item=>item.name==='catalogue-template').key;const body=await call('evimedSkills/read',{sessionId,key});assert.equal(body.instructions,'Use the preserved Chinese resource.');assert.equal(body.resources[0].path,'资料/证据.csv');
 const snapshot=await call('evimedSkills/snapshotBuiltin',{sessionId,key});assert.equal(Buffer.from(snapshot.entries.find(item=>item.path==='资料/证据.csv').bytesBase64,'base64').toString(),'来源,结果\n真实,1\n');
 const alias=list.items.find(item=>item.name==='alias-control');await assert.rejects(call('evimedSkills/snapshotBuiltin',{sessionId,key:alias.key}));
 await assert.rejects(call('evimedSkills/list',{sessionId:'foreign-session'}));await assert.rejects(call('evimedSkills/read',{sessionId,key,path:'/private-plane'}));
 console.log(JSON.stringify({kernel:'0.1.7-rc.2',uid:process.getuid(),list,body,snapshot,personalBody,physicalNfcNfdAliasRefused:true,modelCalls:0,qualification:'actual Linux read-only SDK scoped catalogue/resource snapshot; no hosted actor/runtime qualification'}));
}finally{child.kill('SIGTERM');await new Promise(resolve=>{if(child.exitCode!==null)return resolve();const timer=setTimeout(()=>child.kill('SIGKILL'),5000);child.once('close',()=>{clearTimeout(timer);resolve();});});}
