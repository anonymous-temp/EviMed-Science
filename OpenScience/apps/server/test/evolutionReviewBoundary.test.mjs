import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {canonicalJson} from '@evimed/domain';
import {ExtensionToolController} from '../src/extensionToolController.mjs';
import {spawnSync} from 'node:child_process';
import {createEvolutionDependencyPreparer} from '../src/evolutionDependencyPreparation.mjs';
import {createEvolution} from '../src/evolutionComposition.mjs';
import {EVOLUTION_CONFIG_SCHEMA} from '../src/evolutionConfiguration.mjs';

test('dependency downloader rejects private DNS answers and connects to its validated address',async()=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'evolution-dns-'));let program;
  try{
    const item={id:'source',version:'1',digest:`sha256:${'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'}`,filename:'source.zip',url:'https://example.com/source.zip'};
    const preparer=createEvolutionDependencyPreparer({dataDir,evolutionEnabled:true,evolutionDependencyAllowlist:[item]},{imageId:async()=>`sha256:${'a'.repeat(64)}`,tools:{run:async(_descriptor,_identity,args)=>{program=args.command[1];return JSON.stringify([{filename:item.filename,content:''}]);}}});
    await preparer.prepare([{id:item.id,version:item.version,digest:item.digest}]);
    assert.ok(program.includes('ProxyHandler({})'));assert.ok(program.includes('NoRedirect'));
    const check=program.replace('items=json.load(sys.stdin)','items=[]')+`\nsocket.getaddrinfo=lambda *a,**k:[(0,0,0,'',('127.0.0.1',443))]\ntry:\n PublicHTTPS('example.com').connect()\n raise AssertionError('private address accepted')\nexcept ValueError as error: assert str(error)=='dependency_address_denied'\nsocket.getaddrinfo=lambda *a,**k:[(0,0,0,'',('8.8.8.8',443))]\nobserved=[]\nsocket.create_connection=lambda address,timeout,source_address=None: observed.append(address)\nhttp.client.HTTPSConnection.connect=lambda self:self._create_connection((self.host,self.port),1)\nconnection=PublicHTTPS('example.com');connection.connect()\nassert connection.host=='example.com' and observed==[('8.8.8.8',443)]\n`;
    const result=spawnSync('python3',['-c',check],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
  }finally{await fs.rm(dataDir,{recursive:true,force:true});}
});
test('the optional composition is absent by default and enabled wiring supplies all real lifecycle handlers',()=>{
  assert.equal(createEvolution({config:{evolutionEnabled:false}}),null);
  assert.equal(createEvolution({config:{evolutionEnabled:true}}),null);
  const config={...Object.fromEntries(Object.entries(EVOLUTION_CONFIG_SCHEMA).map(([key,field])=>[key,field.default])),evolutionEnabled:true,dataDir:os.tmpdir(),operatorUsers:[],frontierEnabled:false,evolutionDependencyAllowlist:[]};
  const module=createEvolution({config,database:{},documents:{},jobs:{},usageLedger:{},store:{},runtimeManager:{},registry:Promise.resolve({}),controller:{},agentRuns:{},evaluationIsolation:{},autopilot:{},dataSemantics:{}});
  for(const key of ['gateway','routes','finishRun'])assert.equal(typeof module[key],'function');
  for(const key of ['supply','worker','runs','candidateEvaluator','paperGold'])assert.ok(module[key]);
  assert.equal(module.worker.status().enabled,true);
});

test('restart recovery proves immutable owned container absence and preserves uncertain reservations',async()=>{
  const stateRoot=await fs.mkdtemp(path.join(os.tmpdir(),'evolution-recover-'));
  const tools=new ExtensionToolController({admittedDescriptors:[],stateRoot,adapterRoot:stateRoot,inputRoot:stateRoot});
  const name='evimed-extension-tool-12345678-1234-1234-1234-123456789abc',identity={jobId:'ephemeral',evolution:true},artifactDigest=`sha256:${'b'.repeat(64)}`,containerId='a'.repeat(64),marker=path.join(stateRoot,name+'.json');let removed=false;
  const record={name,identity,artifactDigest,containerId,state:'reserved',ownerProcessId:2147483647,ownerProcessStart:'0',ownerBootInstance:'previous-controller-boot'};
  tools.command=async args=>{
    assert.equal(args.at(-1),containerId);
    if(args[0]==='rm'){removed=true;return {stdout:''};}
    if(args[2]==='{{json .Config.Labels}}')return {stdout:JSON.stringify({'com.evimed.extension-tool':'owned','com.evimed.extension-scope':name,'com.evimed.extension-artifact':artifactDigest,'com.evimed.extension-attempt':createHash('sha256').update(canonicalJson(identity)).digest('hex')})};
    throw Object.assign(new Error('absent'),{missing:true});
  };
  try{
    await fs.mkdir(path.join(stateRoot,name));await fs.writeFile(marker,JSON.stringify(record));
    await tools.reconcileEvolutionAttempts();assert.equal(removed,true);assert.equal(await fs.stat(marker).catch(()=>null),null);
    await fs.writeFile(marker,JSON.stringify({...record,containerId:null,ownerBootInstance:undefined}));
    await assert.rejects(()=>tools.reconcileEvolutionAttempts());assert.ok(await fs.stat(marker));
    await fs.writeFile(marker,JSON.stringify({...record,...await tools.ownerIdentity()}));removed=false;
    await tools.reconcileEvolutionAttempts();assert.equal(removed,false);assert.ok(await fs.stat(marker));
  }finally{await fs.rm(stateRoot,{recursive:true,force:true});}
});
