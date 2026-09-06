// Isolated fixture: native host, complete shipped preset and evidence store.
// No model or external network runs; existing user persistence must stay unchanged.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createServer, request } from 'node:http';
import { createRequire } from 'node:module';
import { randomBytes, createHash } from 'node:crypto';
import { browserSessionCookie } from '/repo/apps/server/src/dshBrowserAuth.mjs';
import { createPublicSourceGatewayHandler } from '/repo/apps/server/src/publicSourceGateway.mjs';
const require=createRequire('/app/harness/package.json');
const yaml=require('js-yaml');
const base=fs.mkdtempSync('/tmp/evimed-plugin-proof-');
const lib=path.join(base,'node_modules');
fs.mkdirSync(path.join(lib,'@evimed'),{recursive:true});
for(const [name,folder] of [['domain','domain'],['harness-port','harness-port'],['dsh-socket','socket']]) {
  fs.cpSync(`/repo/packages/${folder}`,path.join(lib,'@evimed',name),{recursive:true,filter:file=>!file.split('/').includes('node_modules')&&!file.includes('/capability-skills')&&!file.includes('/capabilities')&&!file.includes('/test')});
}
fs.symlinkSync('/app/harness/node_modules/@deepseek-ai',path.join(lib,'@deepseek-ai'));
fs.symlinkSync('/cite',path.join(lib,'dsh-cite'));
for(const name of fs.readdirSync('/app/harness/node_modules')){if(!fs.existsSync(path.join(lib,name)))fs.symlinkSync(path.join('/app/harness/node_modules',name),path.join(lib,name));}
const presetText=fs.readFileSync('/repo/packages/socket/presets/evimed-universal/agent.cordis.yml','utf8');
const presets=path.join(base,'presets');
fs.mkdirSync(path.join(presets,'evimed-universal'),{recursive:true});
fs.writeFileSync(path.join(presets,'evimed-universal','agent.cordis.yml'),presetText);
const workspace=path.join(base,'workspace');fs.mkdirSync(workspace);
const privateTmp=path.join(base,'private-tmp');fs.mkdirSync(privateTmp);
const snapshot=directory=>{
  const entries=[];
  const walk=(dir,relative='')=>{
    if(!fs.existsSync(dir))return;
    for(const name of fs.readdirSync(dir).sort()){
      const location=path.join(dir,name),rel=path.join(relative,name),stat=fs.lstatSync(location);
      if(stat.isDirectory()){entries.push([rel,'directory']);walk(location,rel);}
      else if(stat.isFile())entries.push([rel,createHash('sha256').update(fs.readFileSync(location)).digest('hex')]);
      else entries.push([rel,'non-file']);
    }
  };
  walk(directory);return JSON.stringify(entries);
};
// Preset package resolution uses its own ancestor node_modules.
const tokenFile=path.join(base,'token');fs.writeFileSync(tokenFile,'fixture-token');
const requests=[];
let activeToken='fixture-token';let sourceStatus=200;let sourceDelay=0;
const handler=createPublicSourceGatewayHandler({}, {assertActiveModelGatewayToken(token){if(token!==activeToken)throw Error('revoked');}}, {
  fetchImpl:async(target,init)=>{
    requests.push(String(target));
    if(new URL(target).origin!=='https://api.crossref.org'||init.redirect!=='error')throw Error('Unexpected source');
    if(sourceDelay)await new Promise(resolve=>setTimeout(resolve,sourceDelay));
    const work={DOI:'10.1038/nphys1170',title:['Fixture source'],author:[{family:'Fixture'}]};
    return Response.json({message:String(target).includes('/works/10.')?work:{items:[work]}},{status:sourceStatus});
  },
});
const gateway=createServer((req,res)=>{void handler(req,res)});
await new Promise(resolve=>gateway.listen(0,'127.0.0.1',resolve));
const gatewayPort=gateway.address().port;
const cli='/app/harness/node_modules/.bin/dsh';
const version=execFileSync(cli,['--version'],{encoding:'utf8'}).trim();
if(version!==JSON.parse(fs.readFileSync('/repo/deps-version.json')).dsh.version)throw Error('CLI pin mismatch');
const results=[];
try {
for(const [index,enabled,timeoutMs] of [[1,true,2000],[2,true,4000],[3,false,4000]]) {
  const home=path.join(base,`home-${index}`);const profile=path.join(home,'profiles','fixture');fs.mkdirSync(profile,{recursive:true});
  fs.symlinkSync(lib,path.join(profile,'node_modules'));
  fs.writeFileSync(path.join(profile,'package.json'),JSON.stringify({dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app',...(enabled?['@evimed/dsh-socket','dsh-cite']:['dsh-cite','@evimed/dsh-socket'])]}}}));
  const secret=randomBytes(32).toString('base64url');
  fs.writeFileSync(path.join(home,'.credentials.yaml'),yaml.dump({version:1,records:{'client-connection/browser-session':{kind:'grant',payload:{version:1,secret}}}}),{mode:0o600});
  const patch=path.join(home,'patch.yml');
  fs.writeFileSync(patch,yaml.dump([
    {id:'cite',disabled:true},{id:'evimed-seam-probe',disabled:true},{id:'evimed-evidence-store',disabled:false},
    {id:'agent-presets',config:{roots:[{path:presets,trust:'system'}],default:'evimed-universal'}},
  ]));
  const port=32000+index;
  const child=spawn(cli,['--profile','fixture','--patch',patch,'--no-open','--port',String(port),'--trusted-host','dsh.runtime'],
    {cwd:workspace,env:{PATH:process.env.PATH,TMPDIR:privateTmp,DSH_HOME:home,EVIMED_CAPABILITIES_DIR:'/repo/packages/socket/capabilities',EVIMED_CAPABILITY_SKILLS_DIR:'/repo/capability-skills',EVIMED_PRESET_SKILLS_DIR:'/opt/evimed/socket/presets/evimed-universal/skills',EVIMED_CITE_ENABLED:enabled?'1':'0',EVIMED_CITE_TIMEOUT_MS:String(timeoutMs),EVIMED_CITE_CONFIG_REVISION:String(index),EVIMED_PUBLIC_SOURCE_GATEWAY_URL:`http://127.0.0.1:${gatewayPort}/internal/sources/v1/fetch`,EVIMED_MODEL_GATEWAY_TOKEN_FILE:tokenFile},stdio:['ignore','pipe','pipe']});
  child.stdout.resume();child.stderr.resume();
  const cookie=browserSessionCookie({secret,authority:'dsh.runtime'});
  const rpc=(method,args={})=>new Promise((resolve,reject)=>{
    const req=request({host:'127.0.0.1',port,path:`/api/${method}`,method:'POST',headers:{host:'dsh.runtime',cookie,'content-type':'application/json'}},res=>{
      let text='';res.on('data',chunk=>{text+=chunk});res.on('end',()=>{
        try{const value=JSON.parse(text);if(!value.result?.ok)throw Error(JSON.stringify(value.result?.error));resolve(value.result.value)}catch(error){reject(error)}
      });
    });
    req.on('error',reject);req.end(JSON.stringify({type:'client-request',rpcId:'fixture',method,payload:{args}}));
  });
  try {
    let ready=false;let lastError='';
    for(let n=0;n<500;n++){
      if(child.exitCode!==null)throw Error('Native host exited during isolated fixture startup');
      try{await rpc('evimedPlugins/status');ready=true;break}catch(error){lastError=String(error)}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    if(!ready)throw Error('Native probe unavailable: '+lastError);
    fs.rmSync(path.join(workspace,'.evimed-brief'),{recursive:true,force:true});
    await rpc('session/create',{request:{sessionId:`evimed_plugin_user_owned_${index}`,cwd:workspace,agentPreset:'evimed-universal'}});
    await new Promise(resolve=>setTimeout(resolve,1000));
    fs.mkdirSync(path.join(workspace,'.evimed-brief'),{recursive:true});
    fs.writeFileSync(path.join(workspace,'.evimed-brief/index.json'),JSON.stringify({runId:'finished-user-run',budget:{}}));
    fs.writeFileSync(path.join(workspace,'research-brief.md'),'Existing user research brief');
    fs.mkdirSync(path.join(workspace,'.evimed-run'),{recursive:true});
    fs.writeFileSync(path.join(workspace,'.evimed-run/state.json'),JSON.stringify({runId:'finished-user-run',sessionId:`evimed_plugin_user_owned_${index}`,plan:{revision:7,items:[{id:'existing',status:'done'}]},budget:{steps:12,tokens:345,children:2}}));
    const original=[snapshot(workspace),snapshot(path.join(home,'sessions')),snapshot(path.join(home,'storages')),snapshot(privateTmp)];
    const unchanged=async()=>{
      await new Promise(resolve=>setTimeout(resolve,1000));
      const after=[snapshot(workspace),snapshot(path.join(home,'sessions')),snapshot(path.join(home,'storages')),snapshot(privateTmp)];
      for(let n=0;n<original.length;n++)if(original[n]!==after[n])throw Error(`Probe mutated ${['user workspace','session persistence','storage and projection cache','private temporary resources'][n]}`);
    };
    const verify=async()=>{try{return await rpc('evimedPlugins/verify')}finally{await unchanged()}};
    results.push(await verify());
    const rejected=async()=>{let failed=false;try{await rpc('evimedPlugins/verify')}catch{failed=true}await unchanged();if(!failed)throw Error('Failed configuration was reported verified')};
    if(index===1){
      activeToken='fixture-token-rotated';fs.writeFileSync(tokenFile,activeToken);
      await verify();
      const beforeMissing=requests.length;fs.rmSync(tokenFile);await rejected();
      if(requests.length!==beforeMissing)throw Error('Missing token reached source');
      fs.writeFileSync(tokenFile,'revoked');await rejected();
      if(requests.length!==beforeMissing)throw Error('Revoked token reached source');
      fs.writeFileSync(tokenFile,activeToken);sourceStatus=503;await rejected();sourceStatus=200;
      sourceDelay=2500;await rejected();sourceDelay=0;
    }
    if(index===2){sourceDelay=2500;await verify();sourceDelay=0;}
    // Instance-local probe filtering must leave normal persistence observers live.
    const priorUserSessions=snapshot(path.join(home,'sessions'));
    const priorUserCache=snapshot(path.join(home,'storages','session_projcache'));
    fs.rmSync(path.join(workspace,'.evimed-brief'),{recursive:true,force:true});
    await rpc('session/create',{request:{sessionId:`after_probe_user_${index}`,cwd:workspace,agentPreset:'evimed-universal'}});
    await new Promise(resolve=>setTimeout(resolve,1000));
    if(snapshot(path.join(home,'sessions'))===priorUserSessions||snapshot(path.join(home,'storages','session_projcache'))===priorUserCache)throw Error('Probe disabled ordinary user persistence observers');
  }finally{if(child.exitCode===null){child.kill();await new Promise(resolve=>child.once('exit',resolve));}}
}
if(!requests.length||requests.some(url=>!['https://api.crossref.org/works?rows=1&select=DOI','https://api.crossref.org/works/10.1038%2Fnphys1170'].includes(url)))throw Error('Unexpected probe network call');
process.stdout.write(JSON.stringify(results));
}finally{gateway.closeAllConnections();gateway.close();fs.rmSync(base,{recursive:true,force:true});}
