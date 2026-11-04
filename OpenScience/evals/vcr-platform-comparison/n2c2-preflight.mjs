/** Dataset-specific admission for protected n2c2 inputs. No model calls or gold-label reads. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {spawnSync} from 'node:child_process';

const protocolPath=fileURLToPath(new URL('./n2c2-protocol.json',import.meta.url));
export const sha=value=>createHash('sha256').update(value).digest('hex');
const assert=(condition,code)=>{if(!condition)throw Object.assign(new Error(code),{code});};
const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));
function fields(value,names) {
  return value&&typeof value==='object'&&!Array.isArray(value)
    &&Object.keys(value).sort().join('|')===[...names].sort().join('|');
}
export async function privateFile(file) {
  assert(path.isAbsolute(file),'n2c2_private_absolute_path_required');
  const actual=await fs.realpath(file);
  assert(actual===path.resolve(file)&&actual.split(path.sep).some((part,i,parts)=>part==='.evimed-local'&&parts[i+1]==='acceptance'),'n2c2_private_path_required');
  const info=await fs.lstat(file);
  assert(info.isFile()&&!info.isSymbolicLink()&&(info.mode&0o077)===0,'n2c2_private_file_required');
  return fs.readFile(file);
}
export function validateAuthorization(record,definition,experimentId=null) {
  assert(fields(record,['schema','dataset','userConfirmed','provider','destination','purpose','confirmationReference','experimentId','dataProvenance'])
    &&record.schema===1&&record.dataset==='n2c2-2018-t1'&&record.userConfirmed===true
    &&record.provider==='deepseek-official'&&record.destination==='https://api.deepseek.com'
    &&record.purpose==='vcr-platform-evaluation'&&/^[A-Za-z0-9_.:/-]{1,200}$/.test(record.confirmationReference)
    &&/^vcrbench-[a-z0-9][a-z0-9-]{3,33}$/.test(record.experimentId)
    &&(!experimentId||record.experimentId===experimentId),'n2c2_provider_authorization_required');
  assert(fields(record.dataProvenance,['kind','sourceRoot','archiveSha256'])
    &&record.dataProvenance.kind==='user-supplied'&&path.isAbsolute(record.dataProvenance.sourceRoot)
    &&JSON.stringify(Object.entries(record.dataProvenance.archiveSha256).sort())===JSON.stringify(Object.entries(definition.source.archiveSha256).sort()),
    'n2c2_provenance_mismatch');
  return record;
}
export function protocolText(protocol) {
  const lines=['n2c2 2018 Track 1 research cohort-assessment protocol',
    'Source: Annotation Guidelines: Clinical Trial Cohort Selection, version 3, section 3.',
    'Assess the thirteen original propositions separately as positive inclusion requirements.',
    'Preserve each complete source clause and its tag in the saved protocol.',
    'Keep a clinical unknown when evidence does not establish the proposition.',
    'This protocol records research criteria, with no clinical enrollment action.','',
    'Chronology from the original annotation guide',
    ...protocol.chronology.map(rule=>'- '+rule),'','Inclusion Criteria',
    ...protocol.criteria.map(row=>'['+row.tag+'] '+row.text)];
  return lines.join('\n')+'\n';
}
export async function authorizationBinding(file,experimentId=null,{verifyHostSources=true,controllerFile=false}={}) {
  let bytes;
  if(controllerFile){
    assert(file==='/audit/n2c2-authorization.json','n2c2_controller_binding_path');
    const info=await fs.lstat(file);
    assert(info.isFile()&&!info.isSymbolicLink()&&(info.mode&0o077)===0,'n2c2_controller_binding_permissions');
    bytes=await fs.readFile(file);
  }else bytes=await privateFile(file);
  const binding=JSON.parse(bytes);
  const definition=await read(protocolPath);
  assert(fields(binding,['schema','dataset','authorization','authorizationSha256','authorizationFile','manifests','preparedAt','preparerSha256'])
    &&binding.schema===1&&binding.dataset==='n2c2-2018-t1'
    &&/^[a-f0-9]{64}$/.test(binding.authorizationSha256)
    &&Array.isArray(binding.manifests)&&binding.manifests.length===2
    &&new Set(binding.manifests.map(row=>row.split)).size===2
    &&binding.manifests.every(row=>['train','test'].includes(row.split)&&/^[a-f0-9]{64}$/.test(row.manifestSha256)),
    'n2c2_authorization_binding_invalid');
  validateAuthorization(binding.authorization,definition,experimentId);
  if(verifyHostSources){
    const originalBytes=await privateFile(binding.authorizationFile);
    assert(sha(originalBytes)===binding.authorizationSha256,'n2c2_authorization_changed');
    const authoritative=JSON.parse(originalBytes);
    assert(isDeepStrictEqual(authoritative,binding.authorization),'n2c2_authorization_snapshot_mismatch');
    validateAuthorization(authoritative,definition,experimentId);
    binding.authorization=authoritative;
    for(const[relative,expected]of Object.entries(definition.source.archiveSha256)){
      const source=path.join(binding.authorization.dataProvenance.sourceRoot,relative);
      const info=await fs.lstat(source);
      assert(info.isFile()&&!info.isSymbolicLink()&&sha(await fs.readFile(source))===expected,'n2c2_source_archive_changed');
    }
  }
  return {binding,sha256:sha(bytes),definition};
}
export async function verifyN2c2Manifest(manifestPath,startup=null) {
  const bytes=await privateFile(manifestPath),manifest=JSON.parse(bytes);
  assert(manifest.version===1&&manifest.task==='protocol_matching'&&manifest.dataset==='n2c2-2018-t1'
    &&['train','test'].includes(manifest.split)&&manifest.priorExposure===true
    &&manifest.criteriaPerPatient===13&&Array.isArray(manifest.cases),'n2c2_manifest_invalid');
  const expectedCount=manifest.split==='train'?202:86;
  assert(manifest.patients===expectedCount&&manifest.cases.length===expectedCount
    &&new Set(manifest.cases.map(row=>row.id)).size===expectedCount,'n2c2_split_count_mismatch');
  const checked=await authorizationBinding(manifest.authorizationBinding);
  const entry=checked.binding.manifests.find(row=>row.split===manifest.split);
  assert(entry?.manifestPath===manifestPath&&entry.manifestSha256===sha(bytes)
    &&manifest.authorizationSha256===checked.binding.authorizationSha256,'n2c2_manifest_binding_mismatch');
  assert(manifest.protocolDefinitionSha256===sha(await fs.readFile(protocolPath))
    &&manifest.guideSha256===checked.definition.source.guideSha256
    &&manifest.sourceArchiveSha256===checked.definition.source.archiveSha256[manifest.split==='train'?'raw/train.zip':'raw/unannotated_test_data.zip']
    &&manifest.sealedGoldSha256===checked.definition.source.archiveSha256['sealed/n2c2-t1_gold_standard_test_data.zip'],'n2c2_dataset_pin_mismatch');
  const base=path.dirname(manifestPath);
  const provenanceBytes=await privateFile(path.join(base,'provenance.json'));
  assert(sha(provenanceBytes)===manifest.provenanceSha256,'n2c2_provenance_changed');
  const provenance=JSON.parse(provenanceBytes),byId=new Map(provenance.cases.map(row=>[row.caseId,row]));
  const expectedProtocol=protocolText(checked.definition);
  for(const example of manifest.cases){
    assert(fields(example,['id','asOf','files','provenanceSha256'])&&new RegExp('^n2c2-'+manifest.split+'-[0-9]{3}$').test(example.id)
      &&example.files.length===2&&example.files.map(row=>row.name).sort().join('|')==='patient.txt|protocol.txt','n2c2_case_input_whitelist');
    const original=byId.get(example.id);
    assert(original&&sha(Buffer.from(JSON.stringify(original,null,2)+'\n'))===example.provenanceSha256&&example.asOf===original.asOf&&/^\d{4}-\d{2}-\d{2}$/.test(example.asOf),'n2c2_date_provenance_mismatch');
    for(const file of example.files){
      const expected=path.join(base,'model-inputs',example.id,file.name);
      assert(file.path===expected,'n2c2_case_input_scope');
      const content=await privateFile(file.path);
      assert(sha(content)===file.sha256&&content.length===file.bytes,'n2c2_input_hash_mismatch');
      if(file.name==='protocol.txt')assert(content.toString('utf8')===expectedProtocol,'n2c2_protocol_changed');
      else assert(file.sha256===original.textSha256&&!/<TAGS\b|<\/?PatientMatching\b|<[A-Z0-9-]+\s+[^>]*\bmet=/i.test(content.toString('utf8')),'n2c2_labels_in_runtime_input');
    }
  }
  const originalCheck=spawnSync('python3',[fileURLToPath(new URL('./n2c2-prepare.py',import.meta.url)),
    '--verify-manifest',manifestPath],{encoding:'utf8',timeout:30000,maxBuffer:4096});
  assert(originalCheck.status===0,'n2c2_original_input_verification_failed');
  if(startup){
    const scope=startup.n2c2Authorization;
    assert(scope&&scope.dataset==='n2c2-2018-t1'&&scope.bindingSha256===checked.sha256
      &&scope.experimentId===checked.binding.authorization.experimentId&&scope.instance===startup.instance
      &&scope.destination==='https://api.deepseek.com'&&startup.resolvedConfig.deepseekModel==='deepseek-flash'
      &&startup.resolvedConfig.deepseekBaseUrl==='https://api.deepseek.com','n2c2_launch_authorization_mismatch');
  }
  return {manifest,authorization:checked.binding.authorization,bindingSha256:checked.sha256,
    manifestSha256:sha(bytes),provenanceSha256:sha(provenanceBytes)};
}
export function n2c2Prompt(manifest,example) {
  assert(manifest.dataset==='n2c2-2018-t1'&&manifest.task==='protocol_matching'
    &&/^n2c2-(train|test)-[0-9]{3}$/.test(example.id)&&/^\d{4}-\d{2}-\d{2}$/.test(example.asOf),'n2c2_prompt_scope_invalid');
  return [
    'Use the virtual clinical research protocol-to-patient matching workflow for the attached patient.txt and protocol.txt.',
    'These are authorized, protected n2c2-2018-t1 records for a research evaluation.',
    'Create the study protocol from the thirteen full published textual criteria in protocol.txt and assess this one patient.',
    'Use positive inclusion propositions for each independent question. Preserve the original full text and criterion tag.',
    'The evaluation date is '+example.asOf+', sourced from the latest original Record date header.',
    'Read all longitudinal records, dates and later corrections. Preserve exact evidence and any genuinely missing information.',
    'Save the protocol and matching assessment through the normal workflow, then read the trial_to_patient matching result for this patient.',
    'Save matching-assessment.json for download. Finish accessible work in this automated turn without waiting for a human answer.',
    'Keep clinical unknown, pending work and failed processing distinct. Do not infer negative findings from silence.',
    'This is a supplied research protocol. Registry search and candidate-trial matching are outside this task.',
    'Case '+example.id+'. Both files are attached under inputs/.',
  ].join('\n');
}
