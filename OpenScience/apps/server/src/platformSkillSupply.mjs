import { validatePlatformSkillPackage } from './platformSkillPackage.mjs';
import { PLATFORM_SKILL_GENERATION_MAX_PINS, PLATFORM_SKILL_MAX_TOOLS } from './platformSkillLimits.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {canonicalJson,parseSkillFrontmatter} from '@evimed/domain';
import {HttpError,assertNoSymlinkPath,writeFileExclusiveNoFollow,writeFileAtomicNoFollow} from './security.mjs';
import {verificationRequest} from './evolutionVerificationController.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
const invalid=()=>new HttpError(400,'extension_contract_invalid','Invalid platform skill generation.');
export const PLATFORM_SKILLS_RUNTIME_DIR='/opt/evimed/platform-skills';
/** @param {any} config @param {any} reference */
export function platformSkillGenerationRoot(config,reference){
  if(!reference||Object.keys(reference).sort().join(',')!=='generationHash,schemaVersion'||reference.schemaVersion!==1||!/^[a-f0-9]{64}$/.test(reference.generationHash))throw invalid();
  return path.join(config.dataDir,'.openscience','platform-skills','generations',reference.generationHash);
}
/** Verify the immutable manifest and every supplied byte, never load candidate code.
 * @param {any} config @param {any} reference */
export async function verifyPlatformSkillGeneration(config,reference){
  const root=platformSkillGenerationRoot(config,reference);await assertNoSymlinkPath(config.dataDir,root);
  const manifest=JSON.parse(await fs.readFile(path.join(root,'manifest.json'),'utf8'));
  if(sha(canonicalJson(manifest))!==reference.generationHash||manifest.schemaVersion!==1||!Array.isArray(manifest.pins)||manifest.pins.length>PLATFORM_SKILL_GENERATION_MAX_PINS)throw invalid();
  const expected=new Set(['manifest.json']);
  for(const pin of manifest.pins){
    if(!/^platform-[a-f0-9]{24}$/.test(pin.nativeName)||!/^sha256:[a-f0-9]{64}$/.test(pin.digest)||!Array.isArray(pin.files))throw invalid();
    for(const file of pin.files){
      const relative=`skills/${pin.nativeName}/${file.path}`;verificationRequest({files:{[file.path]:''},code:''});expected.add(relative);
      const target=path.join(root,relative);await assertNoSymlinkPath(root,target);const stat=await fs.lstat(target);
      if(!stat.isFile()||stat.nlink!==1||(stat.mode&0o777)!==0o444||stat.size>4*1024*1024||`sha256:${sha(await fs.readFile(target))}`!==file.digest)throw invalid();
    }
  }
  async function walk(directory,prefix=''){
    for(const name of await fs.readdir(directory)){const relative=prefix?`${prefix}/${name}`:name,target=path.join(directory,name),stat=await fs.lstat(target);
      if(stat.isDirectory()&&!stat.isSymbolicLink())await walk(target,relative);else if(!stat.isFile()||!expected.delete(relative))throw invalid();}
  }
  await walk(root);if(expected.size)throw invalid();return{reference,manifest,pins:manifest.pins};
}
/** Immutable shared methods only; researcher data/results never enter this store.
 * Active selection is copied to a generation at runtime launch and never changed during a run.
 * @param {any} config @param {{listActive?:()=>Promise<any[]>}} [dependencies] */
export function createPlatformSkillSupply(config,{listActive}={}){
  const root=path.join(config.dataDir,'.openscience','platform-skills'),activeFile=path.join(root,'active.json');
  let mutation=Promise.resolve();
  async function active(){try{return JSON.parse(await fs.readFile(activeFile,'utf8'));}catch(error){if(error.code==='ENOENT')return[];throw error;}}
  async function materialize(pins){
    if(pins.length>PLATFORM_SKILL_GENERATION_MAX_PINS)throw invalid();
    const manifest={schemaVersion:1,pins:pins.map(pin=>({...pin,files:Object.entries(pin.content).sort(([a],[b])=>a.localeCompare(b)).map(([file,content])=>({path:file,digest:`sha256:${sha(content)}`})),content:undefined,sourceFiles:undefined}))};
    const reference={schemaVersion:1,generationHash:sha(canonicalJson(manifest))},target=platformSkillGenerationRoot(config,reference);
    if(await fs.stat(target).catch(()=>null))return verifyPlatformSkillGeneration(config,reference);
    const staging=path.join(root,'staging',randomUUID());await fs.mkdir(staging,{recursive:true,mode:0o755});
    try{
      for(const pin of pins)for(const [relative,content]of Object.entries(pin.content)){
        const file=path.join(staging,'skills',pin.nativeName,relative);await writeFileExclusiveNoFollow(config.dataDir,file,content,{mode:0o444});await fs.chmod(file,0o444);
      }
      await fs.mkdir(path.join(staging,'skills'),{recursive:true,mode:0o755});
      await writeFileExclusiveNoFollow(config.dataDir,path.join(staging,'manifest.json'),canonicalJson(manifest)+'\n',{mode:0o444});
      const readable = async directory => {await fs.chmod(directory,0o755);for(const item of await fs.readdir(directory,{withFileTypes:true}))if(item.isDirectory())await readable(path.join(directory,item.name));};
      await readable(staging);await fs.mkdir(path.dirname(target),{recursive:true,mode:0o755});await fs.rename(staging,target);
    }catch(error){await fs.rm(staging,{recursive:true,force:true});if(error.code!=='EEXIST')throw error;}
    return verifyPlatformSkillGeneration(config,reference);
  }
  return{
    async publish(candidate,{card=undefined,evaluation=undefined,activate=true}={}){
      if(config.evolutionEnabled!==true||evaluation?.ok!==true||!['V0','V1','V2','V3','V4'].includes(evaluation.verificationLevel))throw invalid();
      const packageCheck=validatePlatformSkillPackage(candidate,{card});
      if(!packageCheck.ok)throw new HttpError(400,'extension_contract_invalid',packageCheck.issues.map(issue=>`${issue.field}: ${issue.message}`).join(' '));
      const {files,skillBody,hasFrontmatter,id}=packageCheck;
      if(card?.toolKind==='workflow'&&evaluation.verificationLevel==='V0'&&evaluation.smokePassed!==true)throw invalid();
      if(card?.toolKind!=='workflow'&&evaluation.verificationLevel==='V0')throw invalid();
      const digest=`sha256:${sha(canonicalJson(files))}`,nativeName=`platform-${sha(id+'\0'+digest).slice(0,24)}`;
      // Discovery metadata is platform-owned; frozen candidate bytes remain untouched.
      const runtimeSkill=hasFrontmatter?skillBody.replace(/^name:.*$/m,`name: ${nativeName}`):`---\nname: ${nativeName}\ndescription: ${JSON.stringify(String(candidate.title??card?.title??id).replace(/[\r\n]/g,' ').slice(0,500))}\n---\n\n${skillBody}`;
      const content={...files,'SKILL.md':runtimeSkill};
      if(candidate.publicationKind==='skill'){
        const scripts=Object.keys(files).filter(name=>/^scripts\/[A-Za-z0-9_-]+\.py$/.test(name));
        if(scripts.length)content['SKILL.md']+='\n\nExecute the implementation with python3 and its full immutable path beneath $EVIMED_PLATFORM_SKILLS_DIR/'+nativeName+'/. Do not copy the script into the workspace; the run records execution of this exact revision.\n';
      }
      if(candidate.publicationKind==='isolated-tool'){
        // Candidate implementations, schemas and tests remain in the private frozen revision.
        for(const name of Object.keys(content))if(name!=='SKILL.md')delete content[name];
        // The only network-bearing file is a platform-authored gateway client, not candidate code.
        const client=`import json,os,pathlib,sys,urllib.request\nbase=os.environ['EVIMED_EVOLUTION_GATEWAY_URL']\ntoken=pathlib.Path(os.environ['EVIMED_WORKLOAD_TOKEN_FILE']).read_text().strip()\nargs=json.load(sys.stdin)\nbody=json.dumps({'toolId':${JSON.stringify(id)},'digest':${JSON.stringify(digest)},'args':args}).encode()\nrequest=urllib.request.Request(base+'/execute',data=body,headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})\nclass NoRedirect(urllib.request.HTTPRedirectHandler):\n def redirect_request(self,*a,**k): return None\nwith urllib.request.build_opener(NoRedirect).open(request,timeout=75) as response: print(response.read(1048576).decode())\n`;
        content['scripts/invoke_isolated.py']=client;
        content['SKILL.md']+=`\n\nExecute this method exclusively through the platform gateway client with a JSON object of named function arguments on stdin: \`python3 "$EVIMED_PLATFORM_SKILLS_DIR/${nativeName}/scripts/invoke_isolated.py"\`. Keys must match the documented function parameters; for a function taking specification, send {"specification": {...}}, not the unwrapped specification fields. Calculations execute in a disposable job with no network.\n`;
      }
      const pin={id,digest,nativeName,publicationKind:candidate.publicationKind,entrypoint:candidate.entrypoint,dependencies:candidate.dependencies??[],sourceFiles:files,verificationLevel:evaluation.verificationLevel,executionTools:(candidate.executionTools??card?.executionTools??[]).filter(value=>typeof value==='string'&&/^[A-Za-z0-9_/-]{1,160}$/.test(value)),capabilityIds:candidate.capabilityIds??card?.capabilityIds??[],track:candidate.track??card?.track,content};
      /** @type {any} */
      let result=null;const task=mutation.then(async()=>{
        const prior=await active(),directory=path.join(root,'revisions',sha(id));
        await fs.mkdir(directory,{recursive:true,mode:0o700});
        await assertNoSymlinkPath(config.dataDir,directory);
        const names=await fs.readdir(directory).catch(error=>{if(error.code==='ENOENT')return[];throw error;});
        let maximumRevision=0,existing=null;
        for(const name of names){
          if(!/^[a-f0-9]{64}\.json$/.test(name))throw invalid();
          const target=path.join(directory,name);await assertNoSymlinkPath(config.dataDir,target);
          const historical=JSON.parse(await fs.readFile(target,'utf8'));
          if(historical.id!==id||!Number.isSafeInteger(historical.revision)||historical.revision<1)throw invalid();
          maximumRevision=Math.max(maximumRevision,historical.revision);
          if(historical.digest===digest)existing=historical;
        }
        pin.revision=existing?.revision??maximumRevision+1;
        if(existing){
          const certificateFile=path.join(root,'activation-certificates',sha(id),digest.slice(7)+'.json');
          await assertNoSymlinkPath(config.dataDir,certificateFile);
          let certificate;try{certificate=JSON.parse(await fs.readFile(certificateFile,'utf8'));}catch(error){if(error.code!=='ENOENT'||canonicalJson(existing.content)!==canonicalJson(pin.content))throw error;}
          if(certificate&&(certificate.id!==id||certificate.digest!==digest||certificate.revision!==existing.revision||certificate.pinDigest!==sha(canonicalJson(existing))))throw invalid();
          // A newer gateway instruction template cannot rewrite a certified historical pin.
          pin.content=existing.content;
        }
        // An unchanged byte digest cannot silently acquire a different entrypoint, scope or dependency closure.
        if(existing&&canonicalJson(existing)!==canonicalJson(pin))throw invalid();
        const selected=[...prior.filter(item=>item.id!==id),pin].sort((a,b)=>a.id.localeCompare(b.id));if(selected.length>PLATFORM_SKILL_MAX_TOOLS)throw invalid();result=await materialize(selected);
        await writeFileExclusiveNoFollow(config.dataDir,path.join(root,'revisions',sha(id),digest.slice(7)+'.json'),canonicalJson(pin)+'\n',{mode:0o444}).catch(error=>{if(error.code!=='EEXIST')throw error;});
        const certificate={reference:result.reference,id,revision:pin.revision,digest,pinDigest:sha(canonicalJson(pin))};
        await writeFileExclusiveNoFollow(config.dataDir,path.join(root,'activation-certificates',sha(id),digest.slice(7)+'.json'),canonicalJson(certificate)+'\n',{mode:0o444}).catch(error=>{if(error.code!=='EEXIST')throw error;});
        if(activate)await writeFileAtomicNoFollow(config.dataDir,activeFile,canonicalJson(selected)+'\n',{mode:0o600});
      });mutation=task.catch(()=>{});await task;
      if (!result) throw invalid();
      return{...result.reference,id,revision:pin.revision,digest,nativeName};
    },
    async activate(publication){
      if(config.evolutionEnabled!==true||!/^[A-Za-z0-9_-]{1,100}$/.test(publication?.id??'')||!/^sha256:[a-f0-9]{64}$/.test(publication?.digest??''))throw invalid();
      let result;const task=mutation.then(async()=>{
        const saved=path.join(root,'revisions',sha(publication.id),publication.digest.slice(7)+'.json');await assertNoSymlinkPath(config.dataDir,saved);
        const pin=JSON.parse(await fs.readFile(saved,'utf8'));
        const certificateFile=path.join(root,'activation-certificates',sha(publication.id),publication.digest.slice(7)+'.json');await assertNoSymlinkPath(config.dataDir,certificateFile);
        const certificate=JSON.parse(await fs.readFile(certificateFile,'utf8'));
        if(certificate.id!==pin.id||certificate.digest!==pin.digest||certificate.revision!==pin.revision||certificate.pinDigest!==sha(canonicalJson(pin)))throw invalid();
        const frozen=await verifyPlatformSkillGeneration(config,certificate.reference);
        if(!frozen.pins.some(item=>item.id===pin.id&&item.digest===pin.digest&&item.revision===pin.revision))throw invalid();
        if(pin.id!==publication.id||pin.digest!==publication.digest||pin.revision!==publication.revision||`sha256:${sha(canonicalJson(pin.sourceFiles))}`!==pin.digest)throw invalid();
        const selected=[...(await active()).filter(item=>item.id!==pin.id),pin].sort((a,b)=>a.id.localeCompare(b.id));
        if(selected.length>PLATFORM_SKILL_MAX_TOOLS)throw invalid();result=await materialize(selected);await writeFileAtomicNoFollow(config.dataDir,activeFile,canonicalJson(selected)+'\n',{mode:0o600});
      });mutation=task.catch(()=>{});await task;return result;
    },
    async candidateForEvaluation(publication){
      if(config.evolutionEnabled!==true||!/^[A-Za-z0-9_-]{1,100}$/.test(publication?.id??'')||!/^sha256:[a-f0-9]{64}$/.test(publication?.digest??''))throw invalid();
      const saved=path.join(root,'revisions',sha(publication.id),publication.digest.slice(7)+'.json');await assertNoSymlinkPath(config.dataDir,saved);
      const pin=JSON.parse(await fs.readFile(saved,'utf8'));
      const certificateFile=path.join(root,'activation-certificates',sha(publication.id),publication.digest.slice(7)+'.json');await assertNoSymlinkPath(config.dataDir,certificateFile);
      const certificate=JSON.parse(await fs.readFile(certificateFile,'utf8'));
      if(pin.id!==publication.id||pin.digest!==publication.digest||pin.revision!==publication.revision||certificate.id!==pin.id||certificate.digest!==pin.digest||certificate.revision!==pin.revision||certificate.pinDigest!==sha(canonicalJson(pin))||`sha256:${sha(canonicalJson(pin.sourceFiles))}`!==pin.digest)throw invalid();
      const frozen=await verifyPlatformSkillGeneration(config,certificate.reference);
      if(!frozen.pins.some(item=>item.id===pin.id&&item.digest===pin.digest&&item.revision===pin.revision))throw invalid();
      return structuredClone({id:pin.id,digest:pin.digest,revision:pin.revision,files:pin.sourceFiles,sourceFiles:pin.sourceFiles,entrypoint:pin.entrypoint,dependencies:pin.dependencies,track:pin.track,capabilityIds:pin.capabilityIds,publicationKind:pin.publicationKind,executionTools:pin.executionTools,verificationLevel:pin.verificationLevel});
    },
    async prepareForRuntime(project){
      if(config.evolutionEnabled!==true)return null;
      const pins=listActive?await listActive():await active();
      if(pins.length>PLATFORM_SKILL_MAX_TOOLS)throw invalid();
      // An ordinary project gets methods only, not development inputs or evaluator assets.
      const selected=pins.filter(pin=>(!project.capabilityId||!pin.capabilityIds?.length||pin.capabilityIds.includes(project.capabilityId))&&(!project.track||pin.track===project.track));
      if(!selected.length)return null;
      if(project.capabilityId&&selected.length<=30)return materialize(selected);
      // Unknown-scope sessions and large libraries expose one search entry. Tool bodies remain
      // exact immutable resources, without SKILL.md files the native registry would eagerly list.
      const hidden=selected.map(pin=>({...pin,content:Object.fromEntries(Object.entries(pin.content).map(([name,value])=>[name==='SKILL.md'?'INSTRUCTIONS.md':name,value]))}));
      const index=selected.map(pin=>({id:pin.id,revision:pin.revision,digest:pin.digest,nativeName:pin.nativeName,capabilityIds:pin.capabilityIds,track:pin.track,verificationLevel:pin.verificationLevel,description:parseSkillFrontmatter(pin.content['SKILL.md']).frontmatter?.description??''}));
      const nativeName=`platform-${sha('search-tools').slice(0,24)}`;
      const script=`import argparse,json,pathlib\np=argparse.ArgumentParser();p.add_argument('--capability');p.add_argument('--track');p.add_argument('--query',default='');a=p.parse_args()\nroot=pathlib.Path(__file__).resolve().parent.parent\nitems=json.loads((root/'tools.json').read_text())\nif not a.capability and not a.track:\n print(json.dumps({'required':'Select --capability or --track','capabilities':sorted({c for i in items for c in i['capabilityIds']}),'tracks':sorted({i['track'] for i in items if i.get('track')})}));raise SystemExit(0)\nterms=a.query.lower().split()\nitems=[i for i in items if (not a.capability or not i['capabilityIds'] or a.capability in i['capabilityIds']) and (not a.track or i.get('track')==a.track)]\nitems.sort(key=lambda i:(-sum(term in (i['id']+' '+i['description']).lower() for term in terms),i['id']))\nprint(json.dumps({'tools':[{**i,'file':str(root.parent/i['nativeName']/'INSTRUCTIONS.md')} for i in items[:30]]}))\n`;
      const content={'SKILL.md':`---\nname: ${nativeName}\ndescription: Search validated platform research tools by capability or research track.\n---\n\nUse search_tools to find a platform tool. Select the current capability or track; tool instructions load only after choosing a result.\n\nRun: \`python3 "$EVIMED_PLATFORM_SKILLS_DIR/${nativeName}/scripts/search_tools.py" --capability CAPABILITY_ID --query "METHOD"\`. Alternatively use --track E/P/M/U/X/T. Read the returned file before using its tool.\n`,'scripts/search_tools.py':script,'tools.json':canonicalJson(index)+'\n'};
      return materialize([...hidden,{id:'platform-tool-search',revision:1,digest:`sha256:${sha(canonicalJson(content))}`,nativeName,publicationKind:'skill',capabilityIds:[],track:null,content}]);
    },
    async executeIsolated(project,request,execute,{signal=undefined,pins=[],batch=false}={}){
      if(config.evolutionEnabled!==true||!request||Object.keys(request).sort().join(',')!=='args,digest,toolId'||typeof request.args!=='object'||!request.args||Array.isArray(request.args))throw invalid();
      const selected=pins.find(item=>item.id===request.toolId&&item.digest===request.digest&&item.publicationKind==='isolated-tool');
      if(!selected||!/^[A-Za-z0-9_-]{1,100}$/.test(request.toolId)||!/^sha256:[a-f0-9]{64}$/.test(request.digest))throw new HttpError(404,'product_document_not_found','The tool revision is unavailable.');
      const pin=await this.candidateForEvaluation({id:request.toolId,digest:request.digest,revision:selected.revision});
      const metadata=['entrypoint','dependencies','capabilityIds','track','publicationKind'];
      if(canonicalJson(metadata.map(key=>selected[key]??null))!==canonicalJson(metadata.map(key=>pin[key]??null)))throw invalid();
      if(project.capabilityId&&pin.capabilityIds.length&&!pin.capabilityIds.includes(project.capabilityId))throw invalid();
      const [file,fn]=pin.entrypoint.split(':');
      const code=isolatedArgumentBindingProgram(file,fn,batch);
      const result=await execute({files:pin.sourceFiles,dependencyIds:pin.dependencies,code,input:request.args},{signal});
      if(result?.ok!==true)throw new HttpError(422,'extension_contract_invalid','The isolated implementation did not complete successfully.');
      let output;try{output=JSON.parse(String(result.output).trim().split('\n').at(-1));}catch{throw invalid();}
      const binding=output?.__evimed_argument_binding_error;
      if(binding&&binding.code==='argument-binding-invalid'&&[binding.expectedParameters,binding.receivedKeys].every(keys=>Array.isArray(keys)&&keys.length<=128&&keys.every(key=>typeof key==='string'&&/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)))){const error=new HttpError(422,'extension_contract_invalid','Supply a JSON object whose keys match the named function parameters.');Object.assign(error,{argumentBinding:binding});throw error;}
      return output;
    },
    async executeIsolatedBatch(project,request,inputs,execute,options={}){
      if(!Array.isArray(inputs)||!inputs.length||inputs.length>2048||inputs.some(input=>!input||typeof input!=='object'||Array.isArray(input)))throw invalid();
      return this.executeIsolated(project,{toolId:request.toolId,digest:request.digest,args:{__evolution_batch:inputs}},execute,{...options,batch:true});
    },
    verify:reference=>verifyPlatformSkillGeneration(config,reference),
    async retire(id){const task=mutation.then(async()=>{const selected=(await active()).filter(pin=>pin.id!==id);await writeFileAtomicNoFollow(config.dataDir,activeFile,canonicalJson(selected)+'\n',{mode:0o600});});mutation=task.catch(()=>{});await task;},
  };
}

/** Trusted adapter diagnostics contain names only, never input values or implementation exceptions.
 * @param {string} file @param {string} fn @param {boolean} batch */
export function isolatedArgumentBindingProgram(file,fn,batch=false){
 return `import inspect,json,runpy,sys\nnamespace=runpy.run_path(${JSON.stringify('/candidate/'+file)},run_name='candidate_module')\nfunction=namespace[${JSON.stringify(fn)}]\nsignature=inspect.signature(function)\ndef call(args):\n try:\n  signature.bind(**args)\n except TypeError:\n  expected=[name for name in signature.parameters if len(name)<=128 and name.isascii() and name.isidentifier()][:128]\n  received=sorted(key for key in args if isinstance(key,str) and len(key)<=128 and key.isascii() and key.isidentifier())[:128] if isinstance(args,dict) else []\n  print(json.dumps({'__evimed_argument_binding_error':{'code':'argument-binding-invalid','expectedParameters':expected,'receivedKeys':received}}))\n  raise SystemExit(0)\n return function(**args)\n${batch?`inputs=json.load(sys.stdin)['__evolution_batch']\nassert isinstance(inputs,list) and 1<=len(inputs)<=2048\nresult=[call(item) for item in inputs]`:`result=call(json.load(sys.stdin))`}\nprint(json.dumps(result,allow_nan=False))\n`;
}
