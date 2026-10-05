import {canonicalJson} from '@evimed/domain';
import {runDecisionNetBenefitPlasmode} from './evolutionDecisionPlasmode.mjs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {openScopedFileNoFollow,readStableFileHandle,HttpError} from './security.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
/** Bounded CSV reader; only requested numeric covariates leave this function.
 * @param {string} text @param {string[]} columns @param {number} limit */
function covariateRows(text,columns,limit){
  const records=[];let row=[],cell='',quoted=false;
  for(let index=0;index<text.length;index++){
    const char=text[index];
    if(char==='"'){if(quoted&&text[index+1]==='"'){cell+='"';index++;}else quoted=!quoted;}
    else if(!quoted&&(char===','||char==='\n')){row.push(cell.replace(/\r$/,''));cell='';if(char==='\n'){records.push(row);row=[];}}
    else cell+=char;
  }
  if(quoted)throw new HttpError(400,'semantics_dataset_invalid','The bound CSV is malformed.');
  if(cell||row.length){row.push(cell);records.push(row);}
  const header=records.shift()??[],indices=columns.map(name=>header.indexOf(name));
  if(indices.some(index=>index<0)||columns.some(name=>header.filter(value=>value===name).length!==1))return[];
  return records.filter(values=>values.length===header.length&&indices.every(index=>values[index].trim()!=='')).slice(0,limit).map(values=>Object.fromEntries(columns.map((name,index)=>[name,Number(values[indices[index]])])))
    .filter(values=>Object.values(values).every(Number.isFinite));
}
/** Plasmode labels are researcher-owned diagnostics. Never mount customer workspaces or record
 * patient rows in shared evolution records. Unsupported methods stay explicitly untested.
 * @param {{service:any,dataSemantics:any,store:any,controller:any,supply:any,config?:any}} dependencies */
export function createEvolutionSelfCheck({service,dataSemantics,store,controller,supply,config={}}){
  return{async run({userId,projectId,datasetId,toolId}){
    const user=await store.userById(userId),project=user?await store.requireProject(user,projectId):null;
    if(!project||project.userId!==userId)throw new HttpError(404,'project_not_found','Project not found.');
    const semantics=await dataSemantics.get(userId,projectId,datasetId),tool=await service.get(toolId),spec=tool?.payload?.selfCheck;
    const generation=typeof supply.prepareForRuntime==='function'?await supply.prepareForRuntime(project):null;
    const pin=generation?.pins.find(item=>item.id===toolId&&item.publicationKind==='isolated-tool');
    const selfCheckSpecHash=sha(canonicalJson({spec:spec??null,protocolVersion:2,sampleRows:config.evolutionSelfCheckSampleRows??256,maxRows:config.evolutionSelfCheckMaxRows??10000,maxBytes:config.evolutionSelfCheckMaxBytes??4*1024*1024}));
    const datasetSemanticsHash=sha(canonicalJson(semantics??null));
    const identity=`evolution-self-check-${sha(canonicalJson([userId,projectId,datasetId,toolId,pin?.digest??null,pin?.revision??null,selfCheckSpecHash,datasetSemanticsHash])).slice(0,32)}`;
    const saved=await service.get(identity,userId);if(saved)return saved;
    const result={projectId,datasetId,toolId,datasetRevision:semantics?.revision??null,toolRevision:pin?.revision??null,artifactDigest:pin?.digest??null,selfCheckSpecHash,datasetSemanticsHash,dataLevel:'D0',status:'unsupported',reason:'No admitted self-check procedure.',origin:'tool-result',empiricalEvidence:false};
    const finish=()=>{if(result.status==='passed')result.dataLevel='D3';return service.save('self-check',identity,result,null,userId);};
    if(!semantics?.asset)return finish();
    if(!spec||!['linear-effect','decision-net-benefit'].includes(spec.kind)||!Array.isArray(spec.covariates)||spec.covariates.length>12||!spec.covariates.length||spec.covariates.some(name=>typeof name!=='string'||!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)||/^(?:id|patient_id|subject_id|name|email|phone)$/i.test(name)))return finish();
    const binding=semantics.asset.bindings.find(item=>item.path.endsWith('.csv')&&spec.covariates.every(name=>item.columns?.some(column=>column.name===name)));
    if(!binding){result.status='pending';result.reason='Required numeric covariates are unavailable.';return finish();}
    if(binding.bytes>(config.evolutionSelfCheckMaxBytes??4*1024*1024)||binding.rows>(config.evolutionSelfCheckMaxRows??10000)){result.status='pending';result.reason='Dataset exceeds the bounded self-check profile.';return finish();}
    const root=project.workspaceDir,relative=binding.path;if(path.isAbsolute(relative)||relative.split('/').some(part=>part==='..'))throw new HttpError(400,'path_forbidden','Dataset binding must be workspace-relative.');
    const opened=await openScopedFileNoFollow(root,path.resolve(root,relative));let bytes;
    try{if(opened.stat.size!==binding.bytes)throw new HttpError(409,'semantics_binding_changed','The bound dataset changed.');bytes=await readStableFileHandle(opened.handle,opened.stat);}finally{await opened.handle.close();}
    if(sha(bytes)!==binding.sha256.replace(/^sha256:/,''))throw new HttpError(409,'semantics_binding_changed','The bound dataset changed.');
    const covariates=covariateRows(bytes.toString('utf8'),spec.covariates,config.evolutionSelfCheckSampleRows??256);
    if(covariates.length<Math.max(20,spec.covariates.length+5)){result.status='pending';result.reason='Too few complete numeric covariate rows.';return finish();}
    if(!pin){result.reason='The tool has no admitted isolated self-check entrypoint.';return finish();}
    result.dataLevel='D2';
    if(spec.kind==='decision-net-benefit'){
      try{
        const diagnostic=await runDecisionNetBenefitPlasmode({covariates,columns:spec.covariates,specification:spec,
          executeSpecifications:inputs=>supply.executeIsolatedBatch(project,{toolId,digest:pin.digest},inputs,(body,options)=>controller.execVerify(body,options),{pins:generation.pins})});
        Object.assign(result,diagnostic,{measurementCompleted:true,status:diagnostic.passed?'passed':'failed',reason:'Known-signal recovery on preserved covariates.',bindingDigest:binding.sha256,rows:covariates.length,toolRevision:pin.revision,artifactDigest:pin.digest});
      }catch{result.status='failed';result.reason='The admitted decision self-check did not complete.';}
      return finish();
    }
    const effect=Number(spec.knownEffect??2),tolerance=Number(spec.tolerance??0.01);
    if(!Number.isFinite(effect)||Math.abs(effect)>100||!Number.isFinite(tolerance)||tolerance<=0||tolerance>1)return finish();
    const runCase=async magnitude=>{
      const rows=covariates.map((values,index)=>({...values,__evolution_exposure:index%2,__evolution_outcome:magnitude*(index%2)+spec.covariates.reduce((sum,key,i)=>sum+values[key]*(i+1)/100,0)}));
      const input={rows,exposure:'__evolution_exposure',outcome:'__evolution_outcome',covariates:spec.covariates};
      const measured=await supply.executeIsolated(project,{toolId,digest:pin.digest,args:input},(body,options)=>controller.execVerify(body,options),{pins:generation.pins});
      const estimate=Number(measured?.estimate);return{expected:magnitude,estimate:Number.isFinite(estimate)?estimate:null,passed:Number.isFinite(estimate)&&Math.abs(estimate-magnitude)<=tolerance};
    };
    try{
      const injected=await runCase(effect),negative=spec.negativeControl===true?await runCase(0):null;
      result.status=injected.passed&&(!negative||negative.passed)?'passed':'failed';result.reason='Known-effect recovery on preserved covariates.';
      Object.assign(result,{measurementCompleted:true,procedure:'linear-effect',bindingDigest:binding.sha256,rows:covariates.length,tolerance,injected,negativeControl:negative,toolRevision:pin.revision,artifactDigest:pin.digest});
    }catch{result.status='failed';result.reason='The isolated self-check execution failed.';}
    return finish();
  }};
}
