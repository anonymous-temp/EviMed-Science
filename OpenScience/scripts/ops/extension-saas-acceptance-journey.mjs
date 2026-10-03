/** Ordinary local accounts and actual HTTP/PG/native preparation. Runtime execution follows a separately qualified campaign. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { nativeSkillSnapshotArchive } from '../../apps/server/src/nativeSkillCatalogue.mjs';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createWebApiApp } from '../../apps/server/src/server.mjs';
import { createGeoTestDatabase } from '../../apps/server/test/helpers/geoTestDatabase.mjs';
import { createNativeValidationFixture } from '../../apps/server/test/helpers/nativeSkillValidationFixture.mjs';
import { createControllerExtensionComposition } from '../../apps/server/src/extensionControllerComposition.mjs';
import { ExtensionPreparationWorker } from '../../apps/server/src/extensionPreparationWorker.mjs';
import { readAcceptanceInputs } from './extension-saas-acceptance-inputs.mjs';
import { createAssessmentDescriptor, prepareAssessmentDeployment, ASSESSMENT_BOOTSTRAP, ASSESSMENT_SHORT_PARENT } from './extension-saas-acceptance-manifest.mjs';
import { bindNativeLinuxRelay, observeNativeLinuxPrerequisites, nativeLinuxDockerEnvironment, validateNativeRelayListenPort } from './extension-saas-acceptance-linux.mjs';
import { assessmentDockerEnvironment, bindAssessmentDockerLauncher } from './extension-saas-acceptance-docker.mjs';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { canonicalJson } from '@evimed/domain';
import { openScopedFileNoFollow, readStableFileHandle } from '../../apps/server/src/security.mjs';
import { ASSESSMENT_FACT_FIELDS, writeMeasurementAdmission } from './extension-saas-acceptance-authority.mjs';
import { createAssessmentCurrentFacts, openPrivateAssessmentFixture, openOrdinaryQualificationFixture, createOwnedCampaignNetwork, removeOwnedCampaignNetwork, startOwnedCampaignRelay } from './extension-saas-acceptance-composition.mjs';
import { ExtensionQualification } from '../../apps/server/src/extensionQualification.mjs';
import { loadExtensionDeployment, deploymentProofIdentity } from '../../apps/server/src/extensionDeployment.mjs';
import { createFixtures } from '../runtime/extensions/cowork/fixtures.mjs';
import { createCampaignReport } from './extension-saas-acceptance.mjs';
import { extensionRequestObject } from '../../apps/server/src/extensionAccess.mjs';
import { observeRuntimeBusyDeferral, runRuntimeCandidateFailureControl, observeQueuedOperationRevocation } from './extension-saas-acceptance-native.mjs';
import { ConnectorCredentialStore } from '../../apps/server/src/connectorCredentials.mjs';
import { gunzipSync } from 'node:zlib';
import { delegatedChildrenOf } from '../../apps/server/src/dshRuntimeAdapter.mjs';
const execute = promisify(execFile);
const repo = path.resolve(new URL('../../../', import.meta.url).pathname);
const digest = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
/** Protected data-only tuple. No caller boolean, provider credential or executable pathname is accepted. */
export function validatePrivateCampaignInputs(value) {
  extensionRequestObject(value, ['nativeRelayListenPort','operatorPlatform','schemaVersion','phase','acceptanceInputsPath','runtimeImageId','databaseUrl','gatewayHost','mountMode','statePath','qualificationRecordPath','signingKeyPath','deadlineMs'], ['schemaVersion','phase','deadlineMs']);
  if(value.operatorPlatform!==undefined&&value.operatorPlatform!=='linux-native')throw new Error('invalid_private_campaign_inputs');
  if(Object.hasOwn(value,'nativeRelayListenPort')){if(value.operatorPlatform!=='linux-native'||value.phase==='measure')throw new Error('invalid_private_campaign_inputs');validateNativeRelayListenPort(value.nativeRelayListenPort);}
  const inputKeys=Object.keys(value).filter(key=>!['operatorPlatform','nativeRelayListenPort'].includes(key)).sort().join(',');
  if(value.phase!=='measure'&&value.operatorPlatform==='linux-native'&&value.gatewayHost!=='127.0.0.1')throw new Error('invalid_private_campaign_inputs');
  if (value.schemaVersion !== 1 || !['setup','measure','qualified-smoke'].includes(value.phase) || !Number.isSafeInteger(value.deadlineMs)
    || value.deadlineMs < 30000 || value.deadlineMs > 900000) throw new Error('invalid_private_campaign_inputs');
  if(value.phase==='qualified-smoke'){
    if(inputKeys!=='deadlineMs,gatewayHost,mountMode,phase,qualificationRecordPath,schemaVersion,signingKeyPath,statePath'
      ||![value.statePath,value.qualificationRecordPath,value.signingKeyPath].every(file=>typeof file==='string'&&path.isAbsolute(file))
      ||path.basename(value.statePath)!=='campaign-state.json'||path.basename(value.signingKeyPath)!=='qualification-signing.key'
      ||!['host.lima.internal','host.docker.internal','127.0.0.1'].includes(value.gatewayHost)||!['bind','volume-subpath'].includes(value.mountMode))throw new Error('invalid_ordinary_qualified_smoke_inputs');
  }else if (value.phase === 'measure') {
    if (inputKeys !== 'deadlineMs,phase,schemaVersion,statePath' || !path.isAbsolute(value.statePath) || path.basename(value.statePath) !== 'campaign-state.json') throw new Error('invalid_private_campaign_state');
  } else {
    if (inputKeys !== 'acceptanceInputsPath,databaseUrl,deadlineMs,gatewayHost,mountMode,phase,runtimeImageId,schemaVersion'
      || !path.isAbsolute(value.acceptanceInputsPath) || !/^sha256:[a-f0-9]{64}$/.test(value.runtimeImageId)
      || !['host.lima.internal','host.docker.internal','127.0.0.1'].includes(value.gatewayHost) || !['bind','volume-subpath'].includes(value.mountMode)) throw new Error('invalid_private_campaign_tuple');
    const db = new URL(value.databaseUrl);
    if (!['postgres:','postgresql:'].includes(db.protocol) || !['localhost','127.0.0.1','[::1]'].includes(db.hostname)
      || db.search || db.hash || !/^\/evimed_test[a-z0-9_]*$/.test(db.pathname)) throw new Error('invalid_private_campaign_database');
  }
  return Object.freeze({ ...value });
}
async function protectedCampaignJson(file, basename) {
  return JSON.parse((await protectedCampaignBytes(file,basename)).toString('utf8'));
}
async function protectedCampaignBytes(file, basename) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.basename(file) !== basename) throw new Error('invalid_private_campaign_path');
  const root = path.dirname(file), stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o700 || await fs.realpath(root) !== root) throw new Error('untrusted_private_campaign_parent');
  const opened = await openScopedFileNoFollow(root, file);
  try { if (opened.stat.uid !== process.getuid() || (opened.stat.mode & 0o7777) !== 0o400 || opened.stat.size > 1024 * 1024) throw new Error('untrusted_private_campaign_record'); const bytes=await readStableFileHandle(opened.handle, opened.stat);return bytes; }
  finally { await opened.handle.close(); }
}
const saveProtected = async (file, value) => fs.writeFile(file, canonicalJson(value) + '\n', { mode: 0o400, flag: 'wx' });
/** A production image may leave Docker's default user empty; the launch plan, then the actual container, must independently pin UID10001. */
export function validateFullRuntimeImagePreflight(image,{imageId,platform,launchUser}){
  const defaultUser=image?.Config&&Object.hasOwn(image.Config,'User')?image.Config.User:'';
  if(image?.Id!==imageId||image.Os!=='linux'||'linux/'+image.Architecture!==platform||launchUser!=='10001:10001'
    ||!image.Config||typeof defaultUser!=='string'||!['','10001:10001'].includes(defaultUser))throw new Error('full_runtime_image_preflight_refused');
  return{imageId,platform,defaultImageUser:defaultUser,configuredLaunchUser:launchUser,physicalContainerUidProof:'required-before-measurement'};
}
const INTERNAL_CAMPAIGN_CODES=new Set(['native_linux_relay_listen_port_refused','assessment_installer_unavailable','native_campaign_run_terminal','native_campaign_doc_jobs_incomplete','private_campaign_session_binding_unconfirmed','native_linux_operator_uid_refused','native_linux_remote_docker_refused','native_linux_sandbox_prerequisite_refused','native_linux_docker_socket_untrusted','native_linux_bridge_identity_refused','native_linux_bridge_interface_refused','native_linux_relay_binding_refused','native_linux_relay_target_rebind_refused','native_linux_relay_target_refused','full_runtime_image_preflight_refused','invalid_private_campaign_inputs','invalid_private_campaign_state','invalid_private_campaign_tuple','invalid_private_campaign_database','invalid_private_campaign_path','untrusted_private_campaign_parent','untrusted_private_campaign_record','private_runtime_identity_unconfirmed','private_runtime_resource_limits_unconfirmed','private_runtime_internal_network_unconfirmed','runtime_host_control_socket_refused','private_runtime_volume_identity_unconfirmed','private_runtime_mount_type_unconfirmed','protected_authority_runtime_mount_refused','runtime_provider_or_telemetry_configuration_refused','private_campaign_setup_required','explicit_owned_campaign_context_required','private_campaign_setup_untrusted','private_campaign_measure_required','private_campaign_deadline','private_campaign_http_failure','private_campaign_preparation_failed','private_campaign_setup_cleanup_unconfirmed','private_campaign_cleanup_unconfirmed','private_fixture_configuration_refused','assessment_requires_real_kernel','assessment_fact_sources_unavailable','assessment_fixture_root_changed','assessment_deployment_unavailable','assessment_image_unconfirmed','assessment_subject_unavailable','assessment_database_subject_unavailable','assessment_surface_unavailable','assessment_controller_unavailable','private_assessment_composition_missing','explicit_fixture_signing_secret_required','external_model_transport_refused','private_assessment_cleanup_unconfirmed','private_controller_failed','private_controller_unexpected_exit','private_controller_ready_deadline','private_controller_joined_deadline','private_controller_physical_join_unconfirmed','private_controller_cleanup_unconfirmed','campaign_internal_network_unconfirmed','campaign_network_cleanup_unconfirmed','campaign_relay_destination_refused','campaign_actual_fixture_url_required','campaign_relay_id_unconfirmed','campaign_relay_cleanup_identity_unconfirmed','campaign_relay_physical_boundary_unconfirmed','campaign_relay_cleanup_unconfirmed','campaign_volume_ownership_unconfirmed','unexpected_controlled_campaign_stage','unsupported_controlled_transport_route','controlled_transport_request_unbounded','campaign_canary_scan_unbounded','campaign_export_unbounded','foreign_generation_claim_refused','candidate_fault_identity_unconfirmed','candidate_fault_setup_incomplete','candidate_fault_manifest_changed','candidate_startup_identity_not_observed','real_generation_campaign_required','real_queued_revocation_campaign_required','invalid_completed_artifact','completed_artifact_unbounded','ordinary_smoke_protected_tuple_unavailable','ordinary_smoke_signing_configuration_invalid','ordinary_smoke_receipt_path_invalid','ordinary_smoke_genuine_receipt_required','ordinary_fixture_configuration_refused','ordinary_qualification_integration_missing','ordinary_controller_unavailable','ordinary_fixture_cleanup_unconfirmed','ordinary_preparation_failed','ordinary_smoke_cleanup_unconfirmed']);
for(const code of ['invalid_measurement_admission','invalid_measurement_window','unowned_assessment_root','invalid_measurement_admissions','duplicate_measurement_subject','assessment_factory_reused','assessment_composition_sources_changed','invalid_assessment_fact_sources','invalid_assessment_artifact','invalid_assessment_root','assessment_descriptor_changed','unsafe_assessment_root','assessment_deployment_refused'])INTERNAL_CAMPAIGN_CODES.add(code);
export function safeCampaignDiagnosticCode(error){
  if(typeof error?.code==='string'&&/^[A-Za-z0-9_:-]{1,100}$/.test(error.code))return error.code;
  if(INTERNAL_CAMPAIGN_CODES.has(error?.message))return error.message;
  if(error?.message==='timeout exceeded when trying to connect')return 'private_campaign_database_pool_timeout';
  if(error?.message==='Connection terminated due to connection timeout')return 'private_campaign_database_connect_timeout';
  if(/^native_campaign_tool_not_registered:(?:doc_read|doc_write|evimed_plan|evimed_delegate|run_code)$/.test(error?.message??''))return 'native_campaign_tool_not_registered';
  return ['AssertionError','TypeError','AbortError','TimeoutError'].includes(error?.name)?error.name:'assessment_failed';
}
export function safeCampaignStackFrames(error){
  const frames=[];
  for(const match of String(error?.stack??'').matchAll(/(?:file:\/\/)?(\/[A-Za-z0-9_./%-]+\.(?:mjs|js|cjs)):(\d+):(\d+)/g)){
    const file=decodeURIComponent(match[1]);if(!file.startsWith(repo+path.sep)||file.includes('/.evimed-local/'))continue;
    frames.push({file:path.relative(repo,file),line:Number(match[2]),column:Number(match[3])});if(frames.length===12)break;
  }
  return frames;
}
/** Shared phase diagnostics never serialize exception messages, payloads or provider stderr. */
export function safeCampaignFailureDetails(error){
 const names=['Error','TypeError','ReferenceError','RangeError','SyntaxError','AssertionError','AbortError','TimeoutError','HttpError'];
 const protocolNumbers={};for(const key of ['status','statusCode','actual','expected'])if(Number.isSafeInteger(error?.[key])&&error[key]>=0&&error[key]<=999)protocolNumbers[key]=error[key];
 return{code:safeCampaignDiagnosticCode(error),errorName:names.includes(error?.name)?error.name:'UnknownError',frames:safeCampaignStackFrames(error).slice(0,8),...(Object.keys(protocolNumbers).length?{protocolNumbers}:{})};
}
async function removeCampaignVolume(root,name){
  const volume=JSON.parse((await execute('docker',['volume','inspect',name],{env:assessmentDockerEnvironment(),timeout:5000,maxBuffer:16384})).stdout)[0];
  if(!/^evimed-saas-campaign-[a-f0-9-]{36}$/.test(name)||volume.Name!==name||volume.Options?.device!==root||volume.Labels?.['io.evimed.campaign-root']!==digest(canonicalJson(root)))throw new Error('campaign_volume_ownership_unconfirmed');
  await execute('docker',['volume','rm',name],{env:assessmentDockerEnvironment(),timeout:10000,maxBuffer:8192});
}
/** Explicit trusted QA limits cross the closed controller IPC boundary; parent environment is never inherited. */
export const CAMPAIGN_RUNTIME_LIMITS=Object.freeze({runtimeCpuLimit:'1',runtimeMemoryLimit:'1536m'});
/** Linux-native fixtures use the same nonroot owner as the production web/controller/runtime mounts and mode0600 socket. */
export function assertNativeCampaignOperator(platform,uid){if(platform!=='linux'||uid!==10001)throw new Error('native_linux_operator_uid_refused');}
/** A physical inspection is required. Paths, labels and nonroot DAC are checked, never a supplied green flag. */
export function validatePrivateRuntimeMounts(actual, { imageId, ownerId, projectId, authorityRoot, qualificationRoot, dataDir=null, dataVolume='', volume=null, network }) {
  if (!/^[a-f0-9]{64}$/.test(actual?.Id ?? '') || actual.Image !== imageId || actual.Config?.User !== '10001:10001'
    || actual.Config.Labels?.['open-science.user'] !== ownerId || actual.Config.Labels?.['open-science.project'] !== projectId
    || actual.State?.Running !== true || actual.HostConfig?.ReadonlyRootfs !== true || actual.HostConfig?.Privileged!==false
    ||!actual.HostConfig?.CapDrop?.includes('ALL')||!actual.HostConfig?.SecurityOpt?.some(value=>value==='no-new-privileges'||value==='no-new-privileges:true')) throw new Error('private_runtime_identity_unconfirmed');
  if(!network||network.Internal!==true||network.Driver!=='bridge'||network.Labels?.['io.evimed.campaign-root']!==digest(canonicalJson(dataDir))
    ||actual.HostConfig.NetworkMode!==network.Name||Object.keys(actual.NetworkSettings?.Networks??{}).length!==1
    ||actual.NetworkSettings.Networks[network.Name]?.NetworkID!==network.Id)throw new Error('private_runtime_internal_network_unconfirmed');
  if(actual.HostConfig.NanoCpus!==1_000_000_000||actual.HostConfig.Memory!==1536*1024*1024)throw new Error('private_runtime_resource_limits_unconfirmed');
  const protectedRoots = [authorityRoot, qualificationRoot].map(root => path.resolve(root));
  if (!Array.isArray(actual.Mounts) || !actual.Mounts.length) throw new Error('private_runtime_mounts_unconfirmed');
  for (const mount of actual.Mounts) {
    if(['/var/run/docker.sock','/run/docker.sock'].includes(mount.Destination)||/docker\.sock$/.test(mount.Source??''))throw new Error('runtime_host_control_socket_refused');
    if(mount.Type==='tmpfs'&&!mount.Source)continue;
    let source;
    if(mount.Type==='bind')source=path.resolve(mount.Source);
    else if(mount.Type==='volume'){
      const planned=actual.HostConfig.Mounts?.find(item=>item.Target===mount.Destination),subpath=planned?.VolumeOptions?.Subpath,readOnly=planned&&Object.hasOwn(planned,'ReadOnly')?planned.ReadOnly:false;
      if(!dataDir||!dataVolume||!volume||volume.Name!==dataVolume||volume.Driver!=='local'||volume.Options?.type!=='none'||volume.Options?.o!=='bind'||volume.Options?.device!==dataDir
        ||volume.Labels?.['io.evimed.campaign-root']!==digest(canonicalJson(dataDir))||mount.Name!==dataVolume
        ||planned?.Type!=='volume'||planned.Source!==dataVolume||typeof subpath!=='string'||subpath.split('/').some(part=>!part||part==='.'||part==='..')
        ||typeof readOnly!=='boolean'||typeof mount.RW!=='boolean'||readOnly!==!mount.RW)throw new Error('private_runtime_volume_identity_unconfirmed');
      source=path.resolve(dataDir,subpath);
    }else throw new Error('private_runtime_mount_type_unconfirmed');
    if (protectedRoots.some(root => root === source || root.startsWith(source + path.sep) || source.startsWith(root + path.sep))) throw new Error('protected_authority_runtime_mount_refused');
  }
  const forbiddenEnv = (actual.Config.Env ?? []).filter(value => /^(?:DEEPSEEK_API_KEY|DASHSCOPE_API_KEY|OTEL_EXPORTER_OTLP_ENDPOINT)=/.test(value));
  if (forbiddenEnv.length) throw new Error('runtime_provider_or_telemetry_configuration_refused');
  return { containerId: actual.Id, imageId, uid: 10001,resources:{nanoCpus:actual.HostConfig.NanoCpus,memoryBytes:actual.HostConfig.Memory},privileged:false,capDropAll:true,noNewPrivileges:true,network:{Id:network.Id,Name:network.Name,Internal:network.Internal,Driver:network.Driver}, mounts: actual.Mounts.map(({ Source,Destination,RW,Type,Name }) => ({ Source,Destination,RW,Type,Name:Name??null })),volumeIdentity:volume?{Name:volume.Name,Options:volume.Options,Labels:volume.Labels}:null };
}
/** Allowlisted physical failure evidence excludes runtime environment values and unrelated labels. */
export function campaignPhysicalInspectionMetadata(actual,volume,network){
 const host=actual?.HostConfig??{},config=actual?.Config??{};
 return{container:{Id:actual?.Id,Image:actual?.Image,User:config.User,Labels:{'open-science.user':config.Labels?.['open-science.user'],'open-science.project':config.Labels?.['open-science.project']},Running:actual?.State?.Running,
  HostConfig:{ReadonlyRootfs:host.ReadonlyRootfs,Privileged:host.Privileged,CapDrop:host.CapDrop,SecurityOpt:host.SecurityOpt,NetworkMode:host.NetworkMode,NanoCpus:host.NanoCpus,Memory:host.Memory,Mounts:(host.Mounts??[]).map(m=>({Type:m.Type,Source:m.Source,Target:m.Target,...(Object.hasOwn(m,'ReadOnly')?{ReadOnly:m.ReadOnly}:{}),VolumeOptions:{Subpath:m.VolumeOptions?.Subpath}}))},
  Mounts:(actual?.Mounts??[]).map(m=>({Source:m.Source,Destination:m.Destination,RW:m.RW,Type:m.Type,Name:m.Name})),Networks:Object.fromEntries(Object.entries(actual?.NetworkSettings?.Networks??{}).map(([name,value])=>[name,{NetworkID:value.NetworkID}]))},
  volume:volume?{Name:volume.Name,Driver:volume.Driver,Options:{type:volume.Options?.type,o:volume.Options?.o,device:volume.Options?.device},Labels:{'io.evimed.campaign-root':volume.Labels?.['io.evimed.campaign-root']}}:null,
  network:network?{Id:network.Id,Name:network.Name,Internal:network.Internal,Driver:network.Driver,Labels:{'io.evimed.campaign-root':network.Labels?.['io.evimed.campaign-root']}}:null};
}
/** Controlled loopback upstream implements only the model transport; numerical/content quality is not measured. */
export function controlledCampaignTurn(body, plans, counts) {
  const text = [...(body.messages ?? [])].reverse().filter(item => item.role === 'user').map(item => typeof item.content === 'string' ? item.content : JSON.stringify(item.content)).join('\n');
  const stage = /EVIMED_ASSESSMENT_STAGE:([a-f0-9-]+):([a-z-]+)/.exec(text);
  if (!stage) return { text: 'Controlled assessment transport; no model-quality claim.', stage: null };
  const key = stage[1] + ':' + stage[2], plan = plans.get(key);
  if (!plan) throw new Error('unexpected_controlled_campaign_stage');
  // Native title/ancillary requests can contain the same question but have no tool registry. They never consume the execution plan.
  if(!(body.tools??[]).length)return{text:'Controlled document assessment',stage:key,ancillary:true};
  const count = counts.get(key) ?? 0; counts.set(key, count + 1);
  const step = plan[count];
  if (!step) return { text: 'Controlled document operation complete. This is a synthetic transport exercise.', stage: key };
  if(step.hold===true)return{...step,stage:key};
  if (!(body.tools ?? []).some(tool => tool.name === step.name)&&!(step.permissionProbe===true&&['doc_read','run_code'].includes(step.name))) throw new Error('native_campaign_tool_not_registered:' + step.name);
  return { ...step, id: 'assessment_' + stage[1].replaceAll('-', '') + '_' + count, stage: key };
}
/** Actual OpenAI ancillary and Messages wire shapes, matching the production gateway fixtures. */
export function controlledCampaignResponse(body,turn,protocol){
 const tool=Boolean(turn.name),text=turn.text??'Controlled assessment transport; no model-quality claim.',usage={input_tokens:1,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:1},stream=body.stream===true;
 if(protocol==='openai'){
  const message=tool?{role:'assistant',content:null,tool_calls:[{id:turn.id,type:'function',function:{name:turn.name,arguments:JSON.stringify(turn.input)}}]}:{role:'assistant',content:text},finish=tool?'tool_calls':'stop',meter={prompt_tokens:1,completion_tokens:1,total_tokens:2,prompt_cache_hit_tokens:0,prompt_cache_miss_tokens:1};
  if(!stream)return{contentType:'application/json',text:JSON.stringify({id:'assessment',object:'chat.completion',created:0,model:body.model,choices:[{index:0,message,finish_reason:finish}],usage:meter}),protocol:'openai-json'};
  const delta=tool?{role:'assistant',tool_calls:[{index:0,id:turn.id,type:'function',function:{name:turn.name,arguments:JSON.stringify(turn.input)}}]}:{role:'assistant',content:text};
  const chunks=[{id:'assessment',object:'chat.completion.chunk',created:0,model:body.model,choices:[{index:0,delta,finish_reason:null}]},{id:'assessment',object:'chat.completion.chunk',created:0,model:body.model,choices:[{index:0,delta:{},finish_reason:finish}],usage:meter}];
  return{contentType:'text/event-stream',text:chunks.map(chunk=>'data: '+JSON.stringify(chunk)+'\n\n').join('')+'data: [DONE]\n\n',protocol:'openai-sse'};
 }
 const content=tool?{type:'tool_use',id:turn.id,name:turn.name,input:turn.input}:{type:'text',text},reason=tool?'tool_use':'end_turn';
 if(!stream)return{contentType:'application/json',text:JSON.stringify({id:'assessment',type:'message',role:'assistant',model:body.model,content:[content],stop_reason:reason,stop_sequence:null,usage}),protocol:'anthropic-json'};
 const events=[['message_start',{type:'message_start',message:{id:'assessment',type:'message',role:'assistant',content:[],model:body.model,stop_reason:null,stop_sequence:null,usage:{...usage,output_tokens:0}}}],
  ['content_block_start',{type:'content_block_start',index:0,content_block:tool?{type:'tool_use',id:turn.id,name:turn.name,input:{}}:{type:'text',text:''}}],
  ['content_block_delta',{type:'content_block_delta',index:0,delta:tool?{type:'input_json_delta',partial_json:JSON.stringify(turn.input)}:{type:'text_delta',text}}],
  ['content_block_stop',{type:'content_block_stop',index:0}],['message_delta',{type:'message_delta',delta:{stop_reason:reason,stop_sequence:null},usage:{output_tokens:1}}],['message_stop',{type:'message_stop'}]];
 return{contentType:'text/event-stream',text:events.map(([event,data])=>'event: '+event+'\ndata: '+JSON.stringify(data)+'\n\n').join(''),protocol:'anthropic-sse'};
}
export async function controlledCampaignTransport(){
 const plans=new Map(),counts=new Map(),holds=new Map(),requests=[],errors=[];
 const server=http.createServer(async(req,res)=>{
  const protocol=req.url==='/anthropic/v1/messages'?'anthropic':['/chat/completions','/v1/chat/completions'].includes(req.url)?'openai':null;
  const record={path:protocol?req.url:'unknown',method:req.method==='POST'?'POST':'other',protocol,status:null,responseProtocol:null,responseFinished:false};
  if(requests.length>=128){res.writeHead(429);res.end();return;}requests.push(record);res.on('finish',()=>{record.responseFinished=true;});
  try{
   if(req.method!=='POST'||!protocol)throw new Error('unsupported_controlled_transport_route');
   let bytes='';for await(const chunk of req){bytes+=chunk;if(Buffer.byteLength(bytes)>8*1024*1024)throw new Error('controlled_transport_request_unbounded');}
   const body=JSON.parse(bytes),normalized=protocol==='openai'?{...body,tools:(body.tools??[]).map(tool=>tool.function??tool)}:body,turn=controlledCampaignTurn(normalized,plans,counts);
   Object.assign(record,{stage:turn.stage,requestDigest:digest(canonicalJson(body)),model:['deepseek-flash','deepseek-v4-flash','deepseek-pro','deepseek-v4-pro'].includes(body.model)?body.model:'unknown',tools:(normalized.tools??[]).slice(0,256).map(tool=>['doc_read','doc_write','evimed_plan','evimed_delegate','run_code'].includes(tool.name)?tool.name:'other'),toolCount:(normalized.tools??[]).length,toolSchemaDigest:digest(canonicalJson(body.tools??[]))});
   if(turn.hold===true)await new Promise(resolve=>holds.set(turn.stage,resolve));
   const response=controlledCampaignResponse(body,turn,protocol);Object.assign(record,{status:200,responseProtocol:response.protocol,emittedUsage:{inputTokens:1,outputTokens:1,totalTokens:2},responseBytes:Buffer.byteLength(response.text),emittedWrites:1,emittedDataFrames:(response.text.match(/^data:/gm)??[]).length});res.writeHead(200,{'content-type':response.contentType});res.end(response.text);
  }catch(error){const code=safeCampaignDiagnosticCode(error);if(errors.length<32)errors.push(code);record.errorCode=code;record.errorName=safeCampaignFailureDetails(error).errorName;record.status=res.headersSent?res.statusCode:500;if(!res.headersSent)res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:{type:'controlled_transport_error',message:'Controlled assessment transport failed.'}}));}
 });server.maxConnections=16;server.headersTimeout=10000;server.requestTimeout=120000;
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 return{plans,counts,holds,requests,errors,url:'http://127.0.0.1:'+server.address().port,release:key=>{const release=holds.get(key);if(release){holds.delete(key);release();}},close:()=>{for(const release of holds.values())release();holds.clear();server.closeAllConnections();return new Promise(resolve=>server.close(resolve));}};
}
async function campaignRequest(base, actor, route, method='GET', body=undefined, expected=200, signal=null) {
  const response = await fetch(base + route, { method, headers:{ ...actor?.headers,'content-type':'application/json' },
    ...(body === undefined ? {} : { body:JSON.stringify(body) }), signal:signal?AbortSignal.any([signal,AbortSignal.timeout(180000)]):AbortSignal.timeout(180000) });
  const value = await response.json();
  if (response.status !== expected) throw Object.assign(new Error('private_campaign_http_failure'), { code:value.code ?? 'unexpected_http_status', campaignRoute:route, expected, actual:response.status });
  return value.data;
}
/** Ordinary public session binding precedes answer-line dispatch; a raw kernel session alone is not a research conversation. */
export async function dispatchOrdinaryCampaignTurn(base,actor,{dispatchId,text},signal=null,request=campaignRequest){
 const session=await request(base,actor,'/api/runtime/sessions','POST',{},200,signal);
 if(typeof session?.id!=='string'||!session.id||session.id.startsWith('web_mock_'))throw new Error('real_generation_campaign_required');
 const binding=await request(base,actor,'/api/research-sessions/'+encodeURIComponent(session.id),'PUT',{mode:'open-domain'},200,signal);
 if(binding?.sessionId!==session.id||binding.mode!=='open-domain')throw new Error('private_campaign_session_binding_unconfirmed');
 const run=await request(base,actor,'/api/agent-runs/dispatch','POST',{sessionId:session.id,dispatchId,automated:true,line:'answer',text},202,signal);
 return{session,run};
}
/** Bootstrap selects only a real successful prepared installation; the independent reader still rechecks its database history and current epochs. */
export function campaignPreparedInstallerBinding(descriptor,actor,installation,job){
 const target=job?.payload?.projectTarget;
 if(!descriptor||!installation||job?.kind!=='extension-prepare'||job.status!=='succeeded'||job.userId!==actor?.user?.id||job.payload?.installationId!==installation?.id
  ||job.payload?.installationRevision!==installation.revision||job.result?.installationId!==installation.id||job.result?.installationRevision!==installation.revision
  ||job.result?.artifactDigest!==descriptor.artifactDigest||job.result?.integrity!==descriptor.integrity||!target||target.projectId!==actor.projectId
  ||!Object.hasOwn(target,'membershipEpoch')||target.membershipEpoch!==null&&(typeof target.membershipEpoch!=='string'||!target.membershipEpoch))throw new Error('assessment_installer_unavailable');
 return Object.freeze({extensionId:descriptor.id,artifactDigest:descriptor.artifactDigest,installationId:installation.id,installationRevision:installation.revision,prepareJobId:job.id,actorId:job.userId,actorMembershipEpoch:target.membershipEpoch});
}
/** HTTP user DTOs intentionally have no filesystem roots. Hydrate the current store actor before the trusted project resolver. */
export async function resolveCampaignProject(app,actor){
  const user=await app.store.userById(actor.user.id);
  if(!user||user.id!==actor.user.id)throw new Error('campaign_actor_unavailable');
  return app.store.requireProject(user,actor.projectId);
}
export async function createShortCampaignRoot(){
  const parent=ASSESSMENT_SHORT_PARENT;if(!parent)throw new Error('campaign_transport_platform_unsupported');await fs.mkdir(parent,{mode:0o700,recursive:true});
  const stat=await fs.lstat(parent);if(await fs.realpath(parent)!==parent||!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid()||(stat.mode&0o7777)!==0o700)throw new Error('campaign_transport_parent_not_canonical');
  const rootId=randomUUID().replaceAll('-',''),root=path.join(parent,rootId.slice(0,10));await fs.mkdir(root,{mode:0o700});
  await saveProtected(path.join(root,'root-ownership.json'),{schemaVersion:1,kind:'extension-saas-assessment',rootId,operatorUid:process.getuid()});
  // The full128-bit marker identity is retained. A collided40-bit directory name fails exclusive mkdir rather than reusing any prior tree.
  // This already shared canonical parent keeps the existing hashed socket, including NUL, within Darwin104 and Linux108.
  if(Buffer.byteLength(path.join(root,'.runtime-sockets','a'.repeat(24),'dsh.sock'))+1>104)throw new Error('campaign_transport_root_too_long');
  return root;
}
async function campaignPoll(check, deadline, signal) {
  while (Date.now() < deadline) { signal?.throwIfAborted(); const result = await check(); if (result) return result; await new Promise(resolve=>setTimeout(resolve,200)); }
  throw Object.assign(new Error('private_campaign_deadline'), { code:'private_campaign_deadline' });
}
/** Diagnostic-only preparation adapter retains actual receiver/arguments and never changes timeout, error or result. */
export function observeCampaignPreparation(controller,record,now=Date.now){
 const original=controller.prepare;if(typeof original!=='function'||typeof record!=='function')throw new Error('assessment_controller_unavailable');
 const emit=async evidence=>{try{await record(evidence);}catch{ /* Actual preparation outcome always has precedence over its diagnostic sink. */ }};
 return{admissionAvailable:(...args)=>controller.admissionAvailable(...args),cancelPreparation:(...args)=>controller.cancelPreparation(...args),
  async prepare(...args){const started=now();try{const result=await original.apply(controller,args);await emit({outcome:'succeeded',elapsedMs:Math.max(0,Math.floor(now()-started)),joined:result?.joined===true});return result;}catch(error){await emit({outcome:'failed',elapsedMs:Math.max(0,Math.floor(now()-started)),code:safeCampaignDiagnosticCode(error),canceled:typeof error?.canceled==='boolean'?error.canceled:null,frames:safeCampaignStackFrames(error).slice(0,8)});throw error;}}
 };
}
/** Private observer preserves the real probe's return/error unchanged; evidence is written before the worker's rollback summarises it. */
export function observeCampaignGenerationProbe(manager,record){
 const original=manager.probeGeneration;
 if(typeof original!=='function'||typeof record!=='function')throw new Error('real_generation_campaign_required');
 manager.probeGeneration=async function(...args){
  const candidate=args[1];try{return await original.apply(this,args);}catch(error){
   const codes=['extension_probe_config_invalid','extension_probe_registrations_invalid','citation_probe_runtime_busy','citation_probe_agent_unavailable','citation_probe_config_invalid','citation_probe_registrations_invalid','runtime_transport_error','extension_contract_invalid','plugin_apply_failed'];
   const nativeCode=codes.find(code=>String(error?.message??'').includes(code))??null;
   try{await record({code:safeCampaignDiagnosticCode(error),nativeCode,frames:safeCampaignStackFrames(error).slice(0,8),generationHash:typeof candidate?.reference?.generationHash==='string'&&/^[a-f0-9]{64}$/.test(candidate.reference.generationHash)?candidate.reference.generationHash:null,referencePresent:Boolean(candidate?.reference)});}catch{ /* Probe errors retain precedence; no observer failure can become a successful generation. */ }
   throw error;
  }
 };
 return()=>{manager.probeGeneration=original;};
}
/** Four real lifecycle stages, observed only in the private driver. Summary booleans never replace the worker's independent proof assertion. */
export function observeCampaignGenerationLifecycle(manager,record,now=Date.now){
 const names=['prepareGeneration','replaceGeneration','probeGeneration','restoreGeneration'],originals=new Map(),wrappers=new Map();let emitted=0;
 if(typeof record!=='function'||names.some(name=>typeof manager[name]!=='function'))throw new Error('real_generation_campaign_required');
 const emit=async value=>{if(emitted>=32)return;emitted++;try{await record({...value,sequence:emitted});}catch{ /* An unavailable diagnostic sink cannot alter real execution. */ }};
 const hashed=value=>digest(canonicalJson(value??null));
 for(const stage of names){const original=manager[stage];originals.set(stage,original);
  const wrapper=async function(...args){const project=args[0],candidate=args[1],started=now(),generationHash=typeof candidate?.reference?.generationHash==='string'&&/^[a-f0-9]{64}$/.test(candidate.reference.generationHash)?candidate.reference.generationHash:null;
   await emit({stage,outcome:'begin',elapsedMs:0,generationHash,referencePresent:Boolean(candidate?.reference)});
   try{const result=await original.apply(this,args);let summary={};
    try{summary={joined:typeof result?.joined==='boolean'?result.joined:null,manifestDigestMatch:typeof result?.manifestDigest==='string'?result.manifestDigest===hashed(candidate):null};
     if(stage==='probeGeneration'){
      const expectedInventory=candidate.projection.plugins.map(plugin=>({extensionId:plugin.extensionId,artifactDigest:plugin.artifactDigest,configRevision:plugin.configRevision,configDigest:plugin.configDigest,enabled:plugin.enabled})),epoch=this.runtimeGeneration(project);
      const pairs={reference:[result?.reference??null,candidate.reference??null],inventory:[result?.inventory,expectedInventory],personal:[result?.personal,candidate.projection.personal],baseRuntimeImageDigest:[result?.baseRuntimeImageDigest,candidate.identity.baseRuntimeImageDigest],adapterRevision:[result?.adapterRevision,candidate.identity.adapterRevision],permissionProfileRevision:[result?.permissionProfileRevision,candidate.identity.permissionProfileRevision]};
      summary.proofMatches={runtimeEpoch:typeof result?.runtimeGeneration==='string'&&Boolean(result.runtimeGeneration)&&result.runtimeGeneration===epoch};summary.proofDigests={runtimeEpoch:{actual:hashed(result?.runtimeGeneration),expected:hashed(epoch)}};
      for(const[key,[actual,expected]]of Object.entries(pairs)){summary.proofMatches[key]=key==='baseRuntimeImageDigest'||key==='adapterRevision'||key==='permissionProfileRevision'?actual===expected:canonicalJson(actual??null)===canonicalJson(expected??null);summary.proofDigests[key]={actual:hashed(actual),expected:hashed(expected)};}
      summary.inventoryCounts={actual:Array.isArray(result?.inventory)?result.inventory.length:null,expected:expectedInventory.length};
     }
    }catch{summary={summaryUnavailable:true};}
    await emit({stage,outcome:'succeeded',generationHash,elapsedMs:Math.max(0,Math.floor(now()-started)),...summary});return result;
   }catch(error){const codes=['extension_probe_config_invalid','extension_probe_registrations_invalid','citation_probe_runtime_busy','citation_probe_agent_unavailable','citation_probe_config_invalid','citation_probe_registrations_invalid'];await emit({stage,outcome:'failed',generationHash,elapsedMs:Math.max(0,Math.floor(now()-started)),code:safeCampaignDiagnosticCode(error),nativeCode:codes.find(code=>String(error?.message??'').includes(code))??null,frames:safeCampaignStackFrames(error).slice(0,8)});throw error;}
  };wrappers.set(stage,wrapper);manager[stage]=wrapper;
 }
 return()=>{for(const name of names)if(manager[name]===wrappers.get(name))manager[name]=originals.get(name);};
}
/** Bounded owned state evidence. No job payload, lease token, error message, provider value or native session token is returned. */
export async function campaignGenerationStatus(app,project,current=null){
 current??=await app.hostedExtensions.generations.current(project);
 const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)?value:null;
 const desired=hash(current?.payload.desired?.reference?.generationHash),effective=hash(current?.payload.effective?.reference?.generationHash);
 const phase=['waiting','effective','rolled-back','failed'].includes(current?.payload.phase)?current.payload.phase:'unknown';
 let job=null;if(desired){const rows=(await app.store.database.query("SELECT id,status,error,result,attempts FROM evimed_product.jobs WHERE user_id=$1 AND project_id=$2 AND kind='plugin-apply' AND payload->>'variant'='extension-generation-v1' AND payload->'reference'->>'generationHash'=$3 ORDER BY created_at DESC LIMIT 1",[project.userId,project.id,desired])).rows;
  const actual=rows[0];if(actual)job={id:typeof actual.id==='string'?actual.id.slice(0,100):null,status:['queued','running','succeeded','failed','canceled'].includes(actual.status)?actual.status:'unknown',attempts:Number.isSafeInteger(actual.attempts)?actual.attempts:null,errorCode:actual.error?.code?safeCampaignDiagnosticCode({code:actual.error.code}):null,resultPhase:['effective','rolled-back','failed'].includes(actual.result?.phase)?actual.result.phase:null,resultErrorCode:actual.result?.error?safeCampaignDiagnosticCode({code:actual.result.error}):null,superseded:actual.result?.superseded===true};
 }
 return{phase,revision:Number.isSafeInteger(current?.revision)?current.revision:null,desiredHash:desired,effectiveHash:effective,hasAssessmentProjection:Boolean(current?.payload.desired?.projection?.plugins?.some(plugin=>Object.hasOwn(plugin,'assessmentAdmissionDigest'))),job};
}
/** A succeeded leased job may truthfully record a failed/rolled-back candidate, which is terminal for this desired hash. */
export async function campaignGenerationReady(app,project){
 const current=await app.hostedExtensions.generations.current(project),status=await campaignGenerationStatus(app,project,current);
 if(status.desiredHash&&status.phase==='effective'&&status.effectiveHash===status.desiredHash&&current.payload.effective?.projection.plugins.some(plugin=>Object.hasOwn(plugin,'assessmentAdmissionDigest')))return current;
 const job=status.job;if(job&&(['failed','canceled'].includes(job.status)||job.status==='succeeded'&&['failed','rolled-back'].includes(job.resultPhase))){
  throw Object.assign(new Error('candidate_generation_terminal'),{code:job.errorCode??job.resultErrorCode??'candidate_generation_terminal',terminalJob:{id:job.id,status:job.status,resultPhase:job.resultPhase,generationHash:status.desiredHash},generationStatus:status});
 }
 return null;
}
/** Inspect only after the real invocation resolver has refused; diagnostic reads cannot turn that refusal into admission. */
export function observeCampaignInvocationRefusal(app,project,record){
 const service=app.hostedExtensions.operations,original=service.resolveInvocation;let count=0;
 service.resolveInvocation=async function(...args){try{return await original.apply(this,args);}catch(error){
  if(count++<8)try{const [auth,raw,request]=args,invocation=typeof raw==='string'?JSON.parse(raw):raw,evidence={...safeCampaignFailureDetails(error),snapshotTiming:'after-original-refusal',authMatchesOwnedProject:auth.userId===project.userId&&auth.projectId===project.id,rootCallMatches:invocation?.rootCallId===invocation?.callId,agentMatchesSession:invocation?.agentId===invocation?.sessionId,generationMatches:invocation?.runtimeGeneration===auth.runtimeGeneration,toolMatches:invocation?.toolName===request.operation};
   if(evidence.authMatchesOwnedProject&&typeof invocation?.sessionId==='string'){
    const facts=await app.runtimeManager.extensionInvocationFacts(project,invocation.sessionId),transcript=await app.runtimeManager.sessionTranscript(project,invocation.sessionId,{wake:false}),matches=(transcript.messages??[]).flatMap(message=>(message.parts??[]).filter(part=>part.type==='tool'&&part.callId===invocation.callId).map(part=>({message,part}))),turn=transcript.turns?.at(-1),match=matches[0];
    evidence.nativeFacts={running:facts.running,origin:facts.origin,toolPermitted:facts.tools?.includes(invocation.toolName),generationMatches:facts.runtimeGeneration===auth.runtimeGeneration};evidence.callMatches=matches.length;evidence.pending=match?.part.status==='pending';evidence.nativeToolMatches=match?.part.tool===invocation.toolName;evidence.turnOpen=turn?.end===null;evidence.turnMatches=match?.message.turnStartSeq===turn?.startSeq;evidence.transcriptTruncated=transcript.truncated===true;
    if(match){const input=match.part.input,users=(transcript.messages??[]).filter(message=>message.role==='user'&&message.seq<=match.message.seq&&message.turnStartSeq===match.message.turnStartSeq).sort((a,b)=>b.seq-a.seq);const inputKeys=input&&typeof input==='object'?Object.keys(input):[],schemaKeys=['resourceId','options','targetId','format','spec','operation'];evidence.nativeInputFields=inputKeys.filter(key=>schemaKeys.includes(key)).sort();evidence.nativeInputTotalCount=inputKeys.length;evidence.nativeInputUnknownCount=inputKeys.filter(key=>!schemaKeys.includes(key)).length;evidence.requestDigestMatches=digest(canonicalJson({operation:invocation.toolName,...input}))===digest(canonicalJson(request));evidence.userInputCount=users.length;evidence.sourceRequestIdPresent=typeof users[0]?.sourceRequestId==='string';evidence.actorResolved=Boolean(await app.hostedExtensions.actors.resolve(auth,invocation,match.message,transcript));}
   }
   await record(evidence);
  }catch{ /* The original authority refusal retains precedence over any diagnostic failure. */ }throw error;}};
 return()=>{service.resolveInvocation=original;};
}
/** Do not wait for nonexistent tool jobs after an actual native run has already failed. */
export async function campaignDocumentJobs(app,project,runId,sessionId,startedAt){
 if(typeof sessionId!=='string'||!sessionId||sessionId.length>200)throw new Error('real_generation_campaign_required');
 const rows=(await app.store.database.query("SELECT id,status,payload,result FROM evimed_product.jobs WHERE user_id=$1 AND project_id=$2 AND kind='extension-execute' AND created_at >= $3::timestamptz AND payload->'invocation'->>'sessionId'=$4 ORDER BY created_at",[project.userId,project.id,startedAt,sessionId])).rows.filter(row=>{
  if(row.payload?.invocation?.sessionId!==sessionId)return false;
  if(!row.payload.auth||!Object.hasOwn(row.payload.auth,'invocation'))return true;
  const raw=row.payload.auth.invocation;if(typeof raw==='string'&&Buffer.byteLength(raw)>16384)return false;
  try{const invocation=typeof raw==='string'?JSON.parse(raw):raw;return invocation?.sessionId===sessionId;}catch{return false;}
 });
 if(rows.length>=2&&rows.every(row=>['succeeded','failed','canceled'].includes(row.status)))return rows;
 const run=(await app.agentRuns.list(project)).find(item=>item.id===runId);
 if(run&&['failed','canceled','succeeded'].includes(run.status))throw Object.assign(new Error('native_campaign_run_terminal'),{code:run.status==='succeeded'?'native_campaign_doc_jobs_incomplete':safeCampaignDiagnosticCode({code:run.errorCode??'native_campaign_run_terminal'}),terminalRun:{id:run.id,sessionId,status:run.status,errorCode:run.errorCode?safeCampaignDiagnosticCode({code:run.errorCode}):null,documentJobs:rows.length}});
 return null;
}
/** Native error DTO only; no prompt, provider message, profile or token text enters diagnostics. */
export function campaignNativeFailureFacts(transcript){
 const errors=(transcript?.messages??[]).flatMap(message=>[message?.info?.error,...(message.parts??[]).filter(part=>part.type==='error'||part.type==='tool'&&part.status!=='completed'&&part.status!=='pending').map(part=>part.error??part.state?.error??part)]).filter(Boolean).slice(0,8);
 return errors.map(error=>({code:typeof error.code==='string'&&/^[A-Za-z][A-Za-z0-9_.:-]{0,99}$/.test(error.code)?error.code:null,subCode:typeof error.subCode==='string'&&/^[A-Za-z][A-Za-z0-9_.:-]{0,99}$/.test(error.subCode)?error.subCode:null,type:['Error','TypeError','LlmError','APIError','HttpError','network','model','runtime'].includes(error.type??error.name)?error.type??error.name:'unknown',status:Number.isSafeInteger(error.status)&&error.status>=100&&error.status<=599?error.status:null,frames:safeCampaignStackFrames(error).slice(0,8)}));
}
/** Actual owned ledger settlement facts; no request payload, provider secret or header is selected. */
export async function campaignUsageFacts(app,project,startedAt){
 const rows=(await app.store.database.query("SELECT id,run_id,purpose,model,status,error_code,cache_hit_tokens,cache_miss_tokens,output_tokens FROM evimed_usage.model_requests WHERE user_id=$1 AND project_id=$2 AND created_at >= $3::timestamptz ORDER BY created_at LIMIT 64",[project.userId,project.id,startedAt])).rows;
 const count=value=>Number.isSafeInteger(Number(value))&&value!==null&&value!==undefined&&Number(value)>=0?Number(value):null;
 return rows.map(row=>({id:row.id,runId:row.run_id??null,purpose:row.purpose,model:row.model,status:row.status,errorCode:row.error_code?safeCampaignDiagnosticCode({code:row.error_code}):null,usage:{cacheHitTokens:count(row.cache_hit_tokens),cacheMissTokens:count(row.cache_miss_tokens),outputTokens:count(row.output_tokens)}}));
}
async function scanOwnedCampaignTree(root,needle){
  let files=0,bytes=0,symlinksSkipped=0;const matches=[];
  const visit=async directory=>{for(const entry of await fs.readdir(directory,{withFileTypes:true})){const target=path.join(directory,entry.name),stat=await fs.lstat(target);
    if(stat.isSymbolicLink()){symlinksSkipped++;continue;}if(stat.isDirectory()){await visit(target);continue;}if(!stat.isFile())continue;
    if(++files>10000||stat.size>8*1024*1024||bytes+stat.size>64*1024*1024)throw new Error('campaign_canary_scan_unbounded');
    const opened=await openScopedFileNoFollow(root,target);try{const value=await readStableFileHandle(opened.handle,opened.stat);bytes+=value.length;if(value.includes(needle))matches.push(path.relative(root,target));}finally{await opened.handle.close();}
  }};
  try{await visit(root);}catch(error){if(error.code!=='ENOENT')throw error;}
  return{files,bytes,symlinksSkipped,matches};
}
/** Explicit setup stage launches an idle candidate only to obtain physical image/mount proof; it issues no native prompt. */
export async function setupPrivateCampaign(inputs, { signal=null }={}) {
  inputs = validatePrivateCampaignInputs(inputs); if (inputs.phase !== 'setup') throw new Error('private_campaign_setup_required');
  const nativeLinux=inputs.operatorPlatform==='linux-native';
  if(nativeLinux){assertNativeCampaignOperator(process.platform,process.getuid?.());nativeLinuxDockerEnvironment();await observeNativeLinuxPrerequisites(inputs.runtimeImageId);}
  if (!nativeLinux&&assessmentDockerEnvironment().DOCKER_CONTEXT !== 'colima-evimed-extension-acceptance') throw new Error('explicit_owned_campaign_context_required');
  const prepared = await readAcceptanceInputs(inputs.acceptanceInputsPath),root=await createShortCampaignRoot();
  const isolated = await createGeoTestDatabase(inputs.databaseUrl,'campaign'), transport = await controlledCampaignTransport();
  let app,composition,privateFixture,candidateProject,success=false,state,volumeName='',network,relay,stage='image-and-fixture-preflight',failure=null,result;
  try {
    const image = JSON.parse((await execute('docker',['image','inspect',inputs.runtimeImageId],{env:assessmentDockerEnvironment(),timeout:10000,maxBuffer:256*1024})).stdout)[0];
    const imagePreflight=validateFullRuntimeImagePreflight(image,{imageId:inputs.runtimeImageId,platform:prepared.platform,launchUser:'10001:10001'});
    network=await createOwnedCampaignNetwork(root);
    if(inputs.mountMode==='volume-subpath'){
      volumeName='evimed-saas-campaign-'+randomUUID();
      await execute('docker',['volume','create','--label','io.evimed.campaign-root='+digest(canonicalJson(root)),'--driver','local','--opt','type=none','--opt','o=bind','--opt','device='+root,volumeName],{env:assessmentDockerEnvironment(),timeout:10000,maxBuffer:8192});
    }
    const validator = await createNativeValidationFixture({dataDir:root,image:prepared.images.nativeSdkImageId}); await validator.close();
    await bindAssessmentDockerLauncher(path.join(root,'docker-fixture.mjs'));
    const descriptor=prepared.descriptor,suiteRevision=digest(await fs.readFile(new URL(import.meta.url))),deployment=await prepareAssessmentDeployment(root,descriptor,suiteRevision);
    await fs.mkdir(deployment.qualificationRoot,{mode:0o700,recursive:true});
    const ephemeralSecret=randomBytes(32).toString('hex'),webPort=await new Promise(resolve=>{const probe=http.createServer();probe.listen(0,'127.0.0.1',()=>{const port=probe.address().port;probe.close(()=>resolve(port));});});
    if(nativeLinux)relay=await bindNativeLinuxRelay({root,network,listenPort:inputs.nativeRelayListenPort??0});
    const gateway=relay?.gatewayUrl??'http://assessment-gateway:8787';
    const overrides={...CAMPAIGN_RUNTIME_LIMITS,dataDir:root,databaseUrl:isolated.url,databasePoolMax:2,databaseConnectionTimeoutMs:1000,stateStore:'postgres',
      production:false,localAutoConfig:false,devAuth:false,authMode:'local',selfRegistrationEnabled:true,
      bootstrapUser:'assessment-bootstrap',bootstrapPassword:randomBytes(24).toString('hex'),operatorUsers:'assessment-bootstrap',
      modelGatewaySigningSecret:ephemeralSecret,evimedWorkloadSigningSecret:randomBytes(32).toString('hex'),
      deepseekApiKey:'assessment-controlled-transport',deepseekApiKeyFile:'',dashscopeApiKey:'',dashscopeApiKeyFile:'',
      deepseekBaseUrl:transport.url,deepseekProviderEnabled:false,llmRoutingEnabled:false,learningEnabled:false,reviewEnabled:false,
      geoEnabled:false,vcrEnabled:false,frontierEnabled:false,imEnabled:false,evimedCreditsEnabled:false,runtimeReviewEnabled:false,runtimeProvider:'docker',runtimeSandboxMode:'docker',
      runtimeContainerBin:path.join(root,'docker-fixture.mjs'),runtimeContainerImage:inputs.runtimeImageId,runtimeContainerUser:'10001:10001',
      runtimeDataVolume:volumeName,runtimeControllerMode:'socket',runtimeControllerSocket:path.join(root,'.openscience/runtime-controller.sock'),
      runtimeTransport:'unix',runtimeNetworkMode:network.name,runtimeInternalNetworkName:network.name,allowRuntimeNetworkEgress:false,allowRuntimeHostNetwork:false,
      host:nativeLinux?'127.0.0.1':'0.0.0.0',port:webPort,modelGatewayInternalUrl:gateway+'/internal/model/v1',extensionGatewayInternalUrl:gateway+'/internal/extensions/v1'};
    stage='ordinary-registration-and-owned-preparation';app=createWebApiApp({...overrides,runtimeMode:'mock'});const address=await app.listen(0,'127.0.0.1'),base=`http://127.0.0.1:${address.port}`;
    const actors=[];
    for(const username of ['campaign-owner','campaign-other']){
      const response=await fetch(base+'/api/auth/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password:randomBytes(24).toString('hex'),name:username,warm:false}),signal:signal??AbortSignal.timeout(30000)});
      const body=await response.json();assert.equal(response.status,201);const actor={user:body.data.user,headers:{Cookie:response.headers.get('set-cookie').split(';')[0],'X-Open-Science-CSRF':body.data.csrfToken}};
      const me=await campaignRequest(base,actor,'/api/me');assert.equal(me.operator,false);actor.projectId=me.project.id;actor.headers['X-Open-Science-Project']=actor.projectId;actors.push(actor);
    }
    const owner=actors[0],installed=await campaignRequest(base,owner,'/api/extensions/installations','POST',{coordinate:descriptor.coordinate,scope:'project',projectId:owner.projectId,idempotencyKey:'campaign-install'},201,signal);
    composition=createControllerExtensionComposition({config:app.config,database:app.store.database,deployment});
    const observedController=observeCampaignPreparation(composition.tools,evidence=>saveProtected(path.join(root,'preparation-debug-'+randomUUID()+'.json'),evidence));
    const preparation=new ExtensionPreparationWorker({service:app.extensionService,controller:observedController,admittedArtifacts:deployment.admittedArtifacts});
    await preparation.tick();const job=await app.extensionService.jobs.get(owner.user.id,installed.job.id);if(job.status!=='succeeded')throw Object.assign(new Error('private_campaign_preparation_failed'),{code:job.error?.code??'private_campaign_preparation_failed'});assert.equal(job.result.artifactDigest,descriptor.artifactDigest);
    stage='independent-current-tuple-and-epoch-facts';const factsReader=createAssessmentCurrentFacts({getConfig:()=>app.config,getDatabase:()=>app.store.database}),admissions=[];
    const installerBinding=campaignPreparedInstallerBinding(descriptor,owner,installed.installation,job);
    // The other ordinary account is a negative scope control, not a prepared addon installer.
    const bootstrapProject=await resolveCampaignProject(app,owner),facts=await factsReader({project:bootstrapProject,actor:owner.user,installerBinding});
    admissions.push({...Object.fromEntries(ASSESSMENT_FACT_FIELDS.map(field=>[field,facts[field]])),assessmentId:'campaign-'+randomUUID(),issuedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString(),allowedOperations:['doc_read','doc_write']});
    stage='protected-measurement-admission';const admission=await writeMeasurementAdmission({root,admissions});
    await composition.close();composition=null;await app.close();app=null;
    stage='independent-controller-real-candidate-application';privateFixture=await openPrivateAssessmentFixture({overrides:{...overrides,runtimeMode:'kernel'},admission});
    if(nativeLinux)relay.bindTarget(privateFixture.baseUrl+'/');else relay=await startOwnedCampaignRelay({root,imageId:inputs.runtimeImageId,network,fixtureUrl:privateFixture.baseUrl+'/',gatewayHost:inputs.gatewayHost});
    const privateApp=privateFixture.app,project=await resolveCampaignProject(privateApp,owner),view=await campaignRequest(privateFixture.baseUrl,owner,`/api/projects/${encodeURIComponent(owner.projectId)}/extensions`);
    candidateProject=project;
    observeCampaignGenerationLifecycle(privateApp.runtimeManager,evidence=>saveProtected(path.join(root,'generation-lifecycle-'+evidence.sequence+'.json'),evidence));
    await campaignRequest(privateFixture.baseUrl,owner,`/api/projects/${encodeURIComponent(owner.projectId)}/extensions`,'PUT',{expectedRevision:view.revision,selections:[{installationId:installed.installation.id,enabled:true,settings:{},connectionRefs:[]}]},200,signal);
    await campaignPoll(()=>campaignGenerationReady(privateApp,project),Date.now()+inputs.deadlineMs,signal);
    stage='physical-runtime-image-uid-mount-verification';const runtime=privateApp.runtimeManager.runtimes.get(privateApp.runtimeManager.key(project));assert(runtime?.containerName);
    const actual=JSON.parse((await execute(path.join(root,'docker-fixture.mjs'),['inspect','--format','{{json .}}',runtime.containerName],{timeout:10000,maxBuffer:256*1024,env:assessmentDockerEnvironment()})).stdout);
    const volume=volumeName?JSON.parse((await execute('docker',['volume','inspect',volumeName],{env:assessmentDockerEnvironment(),timeout:5000,maxBuffer:16384})).stdout)[0]:null;
    const inspectedNetwork=JSON.parse((await execute('docker',['network','inspect',network.id],{env:assessmentDockerEnvironment(),timeout:5000,maxBuffer:65536})).stdout)[0];
    await saveProtected(path.join(root,'physical-inspection-before-admission.json'),campaignPhysicalInspectionMetadata(actual,volume,inspectedNetwork));
    const physical=validatePrivateRuntimeMounts(actual,{imageId:inputs.runtimeImageId,ownerId:owner.user.id,projectId:owner.projectId,authorityRoot:admission.root,qualificationRoot:deployment.qualificationRoot,dataDir:root,dataVolume:volumeName,volume,network:inspectedNetwork});
    assert.equal(transport.requests.length,0);
    const current=await privateApp.hostedExtensions.generations.current(project);
    state={nativeRelayListenPort:inputs.nativeRelayListenPort??0,operatorPlatform:inputs.operatorPlatform??'darwin-colima',schemaVersion:1,status:'setup-physical-observed-not-measured',root,databaseName:isolated.name,databaseUrl:isolated.url,overrides,actors,network,gatewayHost:inputs.gatewayHost,
      admission,descriptor,sourcePolicy:deployment.policy,preparerInputSHA:prepared.recordSHA256,installedId:installed.installation.id,
      qualificationRoot:deployment.qualificationRoot,physicalSetup:{...physical,imagePreflight,relay:{bridge:relay.bridge??null,containerId:relay.containerId??null,sourceDigest:relay.sourceDigest,upstreamPinnedUrl:relay.upstreamPinnedUrl,scope:relay.scope},generationHash:current.payload.effective.reference.generationHash,manifestDigest:digest(canonicalJson(current.payload.effective)),observedAt:new Date().toISOString(),operatorUid:process.getuid(),controllerProcessId:privateFixture.controllerProcess.processId,scope:privateFixture.controllerProcess.scope},qualified:false};
    await privateFixture.close();privateFixture=null;
    await saveProtected(path.join(root,'campaign-state.json'),state);success=true;
    result={status:state.status,qualified:false,statePath:path.join(root,'campaign-state.json'),physicalSetup:state.physicalSetup};
  }catch(error){failure=error;let generationStatus=error.generationStatus??null;
    if(privateFixture&&candidateProject)try{generationStatus=await campaignGenerationStatus(privateFixture.app,candidateProject);await saveProtected(path.join(root,'generation-status-at-failure.json'),generationStatus);}catch(snapshotError){generationStatus={snapshotUnavailable:safeCampaignDiagnosticCode(snapshotError)};}
    error.campaignStage=stage;error.reportPath=path.join(root,'setup-incomplete.json');await saveProtected(error.reportPath,{status:'incomplete',qualified:false,stage,...safeCampaignFailureDetails(error),constructorFrames:error.constructorFrames??[],originalFailure:error.originalFailure??null,cleanupFailure:error.cleanupFailure??null,terminalJob:error.terminalJob??null,generationStatus,databaseNamespace:isolated.name,root,modelRequests:transport.requests.length,observationsAreNotCasePasses:true});
  }finally{
    let cleanupFailed=false;const cleanupFailures=[];
    for(const [resource,release] of [['private-app-controller',()=>privateFixture?.close()],['bootstrap-controller',()=>composition?.close()],['bootstrap-app',()=>app?.close()],['owned-relay',()=>relay?.close()],['controlled-upstream',()=>transport.close()]])try{await release();}catch(error){cleanupFailed=true;cleanupFailures.push({resource,code:safeCampaignDiagnosticCode(error),frames:safeCampaignStackFrames(error)});}
    if(!success&&!cleanupFailed){try{if(volumeName)await removeCampaignVolume(root,volumeName);if(network)await removeOwnedCampaignNetwork(network);await isolated.drop();}catch(error){cleanupFailed=true;cleanupFailures.push({resource:'owned-volume-network-database-drop',code:safeCampaignDiagnosticCode(error),frames:safeCampaignStackFrames(error)});}if(!failure&&!cleanupFailed)await fs.rm(root,{recursive:true,force:true});}
    try{await isolated.close();}catch(error){cleanupFailed=true;cleanupFailures.push({resource:'preserved-database-admin-connection',code:safeCampaignDiagnosticCode(error),frames:safeCampaignStackFrames(error)});}
    if(cleanupFailed){const originalCode=failure?safeCampaignDiagnosticCode(failure):null,reportPath=failure?.reportPath??null;
      await saveProtected(path.join(root,'setup-cleanup-incomplete.json'),{qualified:false,originalCode,cleanupFailures,databaseNamespace:isolated.name,databasePreserved:true});
      failure=Object.assign(new Error('private_campaign_setup_cleanup_unconfirmed'),{code:'private_campaign_setup_cleanup_unconfirmed',originalCode,reportPath});}
  }
  if(failure)throw failure;return result;
}
/** Explicit measurement stage starts only after re-reading the operator-owned physical setup record and re-inspecting the new live runtime. */
export async function measurePrivateCampaign(inputs,{signal=null}={}){
  inputs=validatePrivateCampaignInputs(inputs);if(inputs.phase!=='measure')throw new Error('private_campaign_measure_required');
  const state=await protectedCampaignJson(inputs.statePath,'campaign-state.json');
  if(state.schemaVersion!==1||state.status!=='setup-physical-observed-not-measured'||state.qualified!==false||state.physicalSetup?.operatorUid!==process.getuid()
    ||state.root!==path.dirname(inputs.statePath)||state.overrides.dataDir!==state.root||state.overrides.databaseUrl!==state.databaseUrl)throw new Error('private_campaign_setup_untrusted');
  if(state.operatorPlatform==='linux-native')assertNativeCampaignOperator(process.platform,process.getuid?.());
  const transport=await controlledCampaignTransport(),observations=[];let fixture,relay,report,measurementProject,failure=null,cleanupConfirmed=false;
  const measurementStartedAt=new Date().toISOString(),deadline=Date.now()+inputs.deadlineMs;let stage='independent-controller-start';
  try{
    const nativeLinux=state.operatorPlatform==='linux-native';if(nativeLinux){await observeNativeLinuxPrerequisites(state.overrides.runtimeContainerImage);relay=await bindNativeLinuxRelay({root:state.root,network:state.network,listenPort:state.nativeRelayListenPort??0});}
    const gatewayOverrides=nativeLinux?{host:'127.0.0.1',modelGatewayInternalUrl:relay.gatewayUrl+'/internal/model/v1',extensionGatewayInternalUrl:relay.gatewayUrl+'/internal/extensions/v1'}:{};
    fixture=await openPrivateAssessmentFixture({overrides:{...state.overrides,...CAMPAIGN_RUNTIME_LIMITS,...gatewayOverrides,runtimeMode:'kernel',deepseekProviderEnabled:true,deepseekBaseUrl:transport.url},admission:state.admission});
    if(nativeLinux)relay.bindTarget(fixture.baseUrl+'/');else relay=await startOwnedCampaignRelay({root:state.root,imageId:state.overrides.runtimeContainerImage,network:state.network,fixtureUrl:fixture.baseUrl+'/',gatewayHost:state.gatewayHost});
    const {app,baseUrl}=fixture,owner=state.actors[0],other=state.actors[1],project=await resolveCampaignProject(app,owner);measurementProject=project;observeCampaignInvocationRefusal(app,project,evidence=>saveProtected(path.join(state.root,'invocation-refusal-'+randomUUID()+'.json'),evidence));stage='ordinary-selection-and-current-candidate-apply';
    const view=await campaignRequest(baseUrl,owner,`/api/projects/${encodeURIComponent(owner.projectId)}/extensions`);
    await campaignRequest(baseUrl,owner,`/api/projects/${encodeURIComponent(owner.projectId)}/extensions`,'PUT',{expectedRevision:view.revision,selections:[{installationId:state.installedId,enabled:true,settings:{},connectionRefs:[]}]},200,signal);
    const effective=await campaignPoll(async()=>{const current=await app.hostedExtensions.generations.current(project);return current?.payload.phase==='effective'&&current.payload.effective?.bindings.desiredRevision===view.revision+1?current:null;},deadline,signal);
    stage='current-physical-runtime-verification';const runtime=app.runtimeManager.runtimes.get(app.runtimeManager.key(project)),actual=JSON.parse((await execute(app.config.runtimeContainerBin,['inspect','--format','{{json .}}',runtime.containerName],{timeout:10000,maxBuffer:256*1024,env:assessmentDockerEnvironment()})).stdout);
    const volume=state.overrides.runtimeDataVolume?JSON.parse((await execute('docker',['volume','inspect',state.overrides.runtimeDataVolume],{env:assessmentDockerEnvironment(),timeout:5000,maxBuffer:16384})).stdout)[0]:null;
    const inspectedNetwork=JSON.parse((await execute('docker',['network','inspect',state.network.id],{env:assessmentDockerEnvironment(),timeout:5000,maxBuffer:65536})).stdout)[0];
    await saveProtected(path.join(state.root,'physical-inspection-measure-'+randomUUID()+'.json'),campaignPhysicalInspectionMetadata(actual,volume,inspectedNetwork));
    const physical=validatePrivateRuntimeMounts(actual,{imageId:state.overrides.runtimeContainerImage,ownerId:owner.user.id,projectId:owner.projectId,authorityRoot:state.admission.root,qualificationRoot:state.qualificationRoot,dataDir:state.root,dataVolume:state.overrides.runtimeDataVolume,volume,network:inspectedNetwork});
    await campaignRequest(baseUrl,other,'/api/extensions/installations/'+encodeURIComponent(state.installedId),'GET',undefined,404,signal);
    const catalogue=await campaignRequest(baseUrl,owner,'/api/extensions/catalogue');assert.equal(JSON.stringify(catalogue).includes('saas-qualified'),false);
    const credentialCanary='assessment-key-'+randomUUID()+'@example.invalid';
    await campaignRequest(baseUrl,owner,'/api/connectors/unpaywall','PUT',{value:credentialCanary},200,signal);
    const ownedCredentials=new ConnectorCredentialStore({database:app.store.database,secret:app.config.modelGatewaySigningSecret,config:app.config});
    assert.equal(await ownedCredentials.resolveOwn(owner.user.id,'unpaywall'),credentialCanary);assert.equal(await ownedCredentials.resolveOwn(other.user.id,'unpaywall'),null);
    stage='trusted-public-fixture-capture';const publicFixtures=path.join(state.root,'public-fixtures'),files=await createFixtures(publicFixtures),pdf=await fs.readFile(path.join(publicFixtures,files.res_pdf.file));
    const principal={userId:owner.user.id,projectId:owner.projectId,jti:app.runtimeManager.runtimeGeneration(project)},captured=await app.hostedExtensions.documents.prepareCapture(principal);
    const resource=await app.hostedExtensions.documents.capturePdf(principal,pdf,{doi:'synthetic-public-fixture',origin:'https://example.invalid/synthetic-public-fixture'},captured,async()=>{
      assert.equal(app.runtimeManager.runtimeGeneration(project),principal.jti);return principal;
    });assert(resource?.resourceId);
    stage='ordinary-native-prompt-and-real-document-execution';const stageId=randomUUID(),targetId='assessment_result_ipynb';
    transport.plans.set(stageId+':read-write',[{name:'doc_read',input:{resourceId:resource.resourceId}},{name:'doc_write',input:{targetId,format:'ipynb',spec:{kind:'create',cells:[{type:'markdown',source:'Public PDF fixture 42. Controlled transport result; not scientific evidence.'},{type:'code',source:'raise SystemExit("must remain inert")'}]}}}]);
    const documentJobsStartedAt=new Date().toISOString();
    const {session,run}=await dispatchOrdinaryCampaignTurn(baseUrl,owner,{dispatchId:'assessment-'+stageId,text:`EVIMED_ASSESSMENT_STAGE:${stageId}:read-write\nUse the selected public document tools to read the supplied bounded public fixture and produce its inert notebook.`},signal);
    const jobs=await campaignPoll(()=>campaignDocumentJobs(app,project,run.id,session.id,documentJobsStartedAt),deadline,signal);
    assert.equal(jobs.filter(job=>job.status==='succeeded'&&job.payload.request.operation==='doc_read').length,1);
    assert.equal(jobs.filter(job=>job.status==='succeeded'&&job.payload.request.operation==='doc_write').length,1);
    stage='workspace-output-and-native-transcript-verification';const workspace=await app.runtimeManager.workspaceRootForDelivery(project),outputPath=path.join(workspace,'outputs/extensions/'+targetId+'.ipynb'),output=await fs.readFile(outputPath),notebook=JSON.parse(output);
    assert(notebook.cells.some(cell=>cell.cell_type==='code'&&cell.execution_count===null&&(cell.outputs??[]).length===0));
    const transcript=await campaignRequest(baseUrl,owner,'/api/runtime/sessions/'+encodeURIComponent(session.id)+'/transcript');
    const toolParts=(transcript.messages??[]).flatMap(message=>message.parts??[]).filter(part=>part.type==='tool'&&['doc_read','doc_write'].includes(part.tool));assert.equal(toolParts.length,2);
    assert(toolParts.every(part=>part.status==='completed'));
    observations.push({caseId:'SAAS-04',scope:'actual-private-native-prompt-gateway-ledger-controller-workspace',setup:'Ordinary registered account and actual kernel/mux/actor/job/controller; signed private measurement admission; synthetic loopback model and explicitly trusted public fixture capture, not real scholarly retrieval/model quality',expected:'Real pending native doc_read/doc_write preserve owner scope and reach contained tools and active workspace',actual:{sessionId:session.id,runId:run.id,runtimeGeneration:principal.jti,jobIds:jobs.map(job=>job.id),operations:jobs.map(job=>job.payload.request.operation),outputDigest:digest(output),nativeToolCalls:toolParts.length,admissionDigest:state.admission.assessmentAdmissionDigest,metadataQualified:false,physicalRuntime:physical}});
    observations.push({caseId:'SAAS-01',scope:'actual-ordinary-http-private-execution-owner-isolation',setup:'Two real local-auth accounts; real concealed installation metadata; no operator account executes native tools',expected:'Foreign installation hidden and own optional extension remains unqualified while controlled native operations succeed',actual:{foreignInstallationStatus:404,ordinaryActors:state.actors.map(actor=>actor.user.id),ownExecutionJobs:2}});
    observations.push({caseId:'SAAS-18',scope:'actual-idle-private-generation-application',setup:'Normal selection/reconcile/preparation/apply workers; real RuntimeManager and independently verifying controller',expected:'Exact private generation applies and is observed physically without fabricated qualified receipt',actual:{generationHash:effective.payload.effective.reference.generationHash,manifestDigest:digest(canonicalJson(effective.payload.effective)),uncovered:'Busy deferral and failed candidate rollback still require additional controlled stages'}});
    const append = value => { const { qualified: _qualified, ...observation }=value; observations.push(observation); };
    const completedArtifact='outputs/extensions/'+targetId+'.ipynb';
    await campaignPoll(async()=>!(await app.runtimeManager.pluginRuntimeBusy(project))&&!(await app.agentRuns.activeRuns(project)).length,deadline,signal);
    await app.pluginApplyWorker.close();
    const claimGeneration=()=>campaignPoll(async()=>{const claimed=await app.hostedExtensions.generations.jobs.claim(['plugin-apply'],'private-campaign-'+randomUUID(),{leaseMs:300000});if(!claimed)return null;
      if(claimed.userId!==owner.user.id||claimed.projectId!==project.id||!app.pluginApplyWorker.generationWorker.canHandle(claimed))throw new Error('foreign_generation_claim_refused');return claimed;},deadline,signal);
    const reselection=async()=>{const selected=await campaignRequest(baseUrl,owner,`/api/projects/${encodeURIComponent(owner.projectId)}/extensions`);return campaignRequest(baseUrl,owner,`/api/projects/${encodeURIComponent(owner.projectId)}/extensions`,'PUT',{expectedRevision:selected.revision,selections:[{installationId:state.installedId,enabled:true,settings:{},connectionRefs:[]}]},200,signal);};
    const dispatchStage=async(kind,plan)=>{const id=randomUUID(),key=id+':'+kind;transport.plans.set(key,plan);
      const {session:stageSession,run:dispatched}=await dispatchOrdinaryCampaignTurn(baseUrl,owner,{dispatchId:'assessment-'+id,text:'EVIMED_ASSESSMENT_STAGE:'+key+'\nControlled extension boundary exercise using only the supplied public fixture.'},signal);return{key,sessionId:stageSession.id,runId:dispatched.id};};
    stage='real-native-busy-generation-deferral';
    const held=await dispatchStage('hold',[{hold:true,text:'Controlled held turn released.'}]);
    await campaignPoll(()=>transport.holds.has(held.key)?app.runtimeManager.pluginRuntimeBusy(project):false,deadline,signal);
    await reselection();const busyJob=await claimGeneration();append(await observeRuntimeBusyDeferral({app,project,job:busyJob,completedArtifact}));
    transport.release(held.key);
    await campaignPoll(async()=>!(await app.runtimeManager.pluginRuntimeBusy(project))&&!(await app.agentRuns.activeRuns(project)).length,deadline,signal);
    stage='idle-apply-after-real-busy-turn';const idleJob=await claimGeneration();assert.equal(idleJob.id,busyJob.id);
    await app.pluginApplyWorker.generationWorker.runClaimed(idleJob);const idleState=await app.hostedExtensions.generations.current(project);assert.equal(idleState.payload.phase,'effective');
    assert.equal(digest(await fs.readFile(outputPath)),digest(output));
    observations.push({caseId:'SAAS-18',scope:'actual-runtime-idle-apply-after-busy-release',setup:'The actual pending native turn ended; same previously deferred normal leased job applies without changing its candidate',expected:'Deferred current generation applies once idle and prior completed notebook survives',actual:{jobId:idleJob.id,generationHash:idleState.payload.effective.reference.generationHash,completedArtifactDigest:digest(output)}});
    stage='actual-parent-child-native-document-permission-refusal';
    const childStageId=randomUUID(),childKey=childStageId+':child-refusal';transport.plans.set(childKey,[{name:'doc_read',input:{resourceId:resource.resourceId},permissionProbe:true}]);
    const childCountBefore=(await app.store.database.query("SELECT count(*)::int AS count FROM evimed_product.jobs WHERE user_id=$1 AND kind='extension-execute'",[owner.user.id])).rows[0].count;
    const delegation=await dispatchStage('delegate',[{name:'evimed_plan',input:{action:'write',clarifications:['Only a synthetic public fixture is supplied; this exercise measures permission, not research quality.'],deliverables:[{id:'permission_probe',contractKind:'dataset-scoping-package',capability:'dataset-research-scoping',title:'Public fixture permission probe',dependsOn:[],acceptance:['Identify the supplied public source.','Keep patient records outside the request.','Preserve unknown and measured values distinctly.','Keep notebook code inert.','State the bounded source limitations.']}]}},
      {name:'evimed_delegate',input:{deliverableId:'permission_probe',brief:'EVIMED_ASSESSMENT_STAGE:'+childKey+'\nAttempt doc_read on the supplied opaque public resource to measure child permission. No research package or clinical conclusion is requested.',inputs:{}}}]);
    const child=await campaignPoll(async()=>{const parentTranscript=await app.runtimeManager.sessionTranscript(project,delegation.sessionId,{wake:false});const parts=(parentTranscript.messages??[]).flatMap(message=>message.parts??[]);const children=parts.flatMap(part=>delegatedChildrenOf(part.tool,part.output));return children[0]??null;},deadline,signal);
    const childTranscript=await campaignPoll(async()=>{const value=await app.runtimeManager.sessionTranscript(project,child.childSessionId,{wake:false,parentSessionId:delegation.sessionId});const part=(value.messages??[]).flatMap(message=>message.parts??[]).find(item=>item.type==='tool'&&item.tool==='doc_read'&&item.status!=='pending');return part?{value,part}:null;},deadline,signal);
    assert(/UNKNOWN_TOOL|unknown tool|extension_access_denied|not permitted|not available/i.test(canonicalJson(childTranscript.part)));
    assert.equal((await app.store.database.query("SELECT count(*)::int AS count FROM evimed_product.jobs WHERE user_id=$1 AND kind='extension-execute'",[owner.user.id])).rows[0].count,childCountBefore);
    observations.push({caseId:'SAAS-13',scope:'actual-native-delegated-child-document-tool-refusal',setup:'Real evimed_plan/evimed_delegate create an actual catalogue-bound child through the deployed subagent provider; controlled child attempts doc_read; no forged invocation header or copied caller context',expected:'The actual child cannot borrow parent document permission or enqueue an operation',actual:{parentSessionId:delegation.sessionId,childSessionId:child.childSessionId,transcriptDigest:digest(canonicalJson(childTranscript.value)),newOperationJobs:0}});
    await campaignPoll(async()=>!(await app.runtimeManager.pluginRuntimeBusy(project))&&!(await app.agentRuns.activeRuns(project)).length,deadline,signal);
    stage='actual-native-blocked-ptc-transport-refusal';
    const ptcCountBefore=(await app.store.database.query("SELECT count(*)::int AS count FROM evimed_product.jobs WHERE user_id=$1 AND kind='extension-execute'",[owner.user.id])).rows[0].count;
    const ptc=await dispatchStage('ptc-refusal',[{name:'run_code',input:{code:'return await tools.doc_read({ resourceId: '+JSON.stringify(resource.resourceId)+' });',description:'Inspect permitted fixture through nested tool transport',timeoutMs:1000},permissionProbe:true}]);
    const ptcTranscript=await campaignPoll(async()=>{const value=await app.runtimeManager.sessionTranscript(project,ptc.sessionId,{wake:false});const part=(value.messages??[]).flatMap(message=>message.parts??[]).find(item=>item.type==='tool'&&item.tool==='run_code'&&item.status!=='pending');return part?{value,part}:null;},deadline,signal);
    assert(/UNKNOWN_TOOL|unknown tool|extension_access_denied|not permitted|not available|CODE_RUN_FAILED/i.test(canonicalJson(ptcTranscript.part)));
    assert.equal((await app.store.database.query("SELECT count(*)::int AS count FROM evimed_product.jobs WHERE user_id=$1 AND kind='extension-execute'",[owner.user.id])).rows[0].count,ptcCountBefore);
    observations.push({caseId:'SAAS-13',scope:'actual-native-ptc-transport-permission-refusal',setup:'Actual native run_code attempt uses the pinned SDK code/description protocol; normal preset remains unchanged and may refuse the outer transport before nested dispatch',expected:'Blocked code/nested document transport cannot borrow root document authority',actual:{sessionId:ptc.sessionId,transcriptDigest:digest(canonicalJson(ptcTranscript.value)),newOperationJobs:0,outerTransportRefusalMayPrecedeNested:true}});
    await campaignPoll(async()=>!(await app.runtimeManager.pluginRuntimeBusy(project))&&!(await app.agentRuns.activeRuns(project)).length,deadline,signal);
    stage='real-candidate-startup-fault-and-rollback';await reselection();const faultJob=await claimGeneration();append(await runRuntimeCandidateFailureControl({app,project,job:faultJob,completedArtifact,signal}));
    stage='actual-native-forged-actor-before-gateway-refusal';
    const countBefore=(await app.store.database.query("SELECT count(*)::int AS count FROM evimed_product.jobs WHERE user_id=$1 AND kind='extension-execute'",[owner.user.id])).rows[0].count;
    const forged=await dispatchStage('forged-actor',[{name:'doc_read',input:{resourceId:resource.resourceId,actorId:other.user.id}}]);
    const refusedTranscript=await campaignPoll(async()=>{const value=await campaignRequest(baseUrl,owner,'/api/runtime/sessions/'+encodeURIComponent(forged.sessionId)+'/transcript');const parts=(value.messages??[]).flatMap(message=>message.parts??[]).filter(part=>part.type==='tool'&&part.tool==='doc_read');return parts.some(part=>part.status==='completed')?{value,parts}:null;},deadline,signal);
    assert(refusedTranscript.parts.some(part=>/extension_contract_invalid|extension_access_denied/.test(canonicalJson(part))));
    assert.equal((await app.store.database.query("SELECT count(*)::int AS count FROM evimed_product.jobs WHERE user_id=$1 AND kind='extension-execute'",[owner.user.id])).rows[0].count,countBefore);
    observations.push({caseId:'SAAS-04',scope:'actual-native-forged-actor-refused-before-gateway',setup:'Actual root native registry invokes fixed bridge with foreign actor argument; boundedRequest rejects it before gateway/ledger',expected:'Forged actor cannot borrow authority or enqueue operation',actual:{sessionId:forged.sessionId,refusalTranscriptDigest:digest(canonicalJson(refusedTranscript.value)),newOperationJobs:0,uncovered:'Actual child/PTC producer must still be exercised; root-only policy is not an observed nested call'}});
    await campaignPoll(async()=>!(await app.runtimeManager.pluginRuntimeBusy(project))&&!(await app.agentRuns.activeRuns(project)).length,deadline,signal);
    stage='actual-credential-canary-public-export-cache-log-environment-scan';
    const statuses=[await campaignRequest(baseUrl,owner,'/api/connectors'),await campaignRequest(baseUrl,other,'/api/connectors'),await campaignRequest(baseUrl,owner,'/api/extensions/installations/'+encodeURIComponent(state.installedId))];
    assert(statuses.every(value=>!canonicalJson(value).includes(credentialCanary)));
    const archiveResponse=await fetch(baseUrl+'/api/account/export',{headers:owner.headers,signal:signal??AbortSignal.timeout(30000)});assert.equal(archiveResponse.status,200);
    const archiveBytes=Buffer.from(await archiveResponse.arrayBuffer());if(archiveBytes.length>32*1024*1024)throw new Error('campaign_export_unbounded');
    const archive=gunzipSync(archiveBytes,{maxOutputLength:64*1024*1024});assert.equal(archive.includes(Buffer.from(credentialCanary)),false);
    const cache=await scanOwnedCampaignTree(path.join(state.root,'.openscience/extension-controller'),Buffer.from(credentialCanary));assert.equal(cache.matches.length,0);
    const currentRuntime=app.runtimeManager.runtimes.get(app.runtimeManager.key(project)),currentInspect=JSON.parse((await execute(app.config.runtimeContainerBin,['inspect','--format','{{json .}}',currentRuntime.containerName],{env:assessmentDockerEnvironment(),timeout:5000,maxBuffer:256*1024})).stdout);
    assert.equal(canonicalJson(currentInspect.Config.Env??[]).includes(credentialCanary),false);assert((currentInspect.Config.Env??[]).includes('DSH_TELEMETRY_DISABLED=1'));
    const logs=await execute(app.config.runtimeContainerBin,['logs','--tail','1000',currentInspect.Id],{env:assessmentDockerEnvironment(),timeout:5000,maxBuffer:1024*1024});assert.equal((logs.stdout+logs.stderr).includes(credentialCanary),false);
    observations.push({caseId:'SAAS-06',scope:'actual-ordinary-secret-canary-export-controller-cache-runtime-scan',setup:'Synthetic canary entered via ordinary connector PUT; real intended decrypt and foreign refusal; account gzip export decompressed, bounded owned controller cache and actual runtime logs/env scanned',expected:'Synthetic connector plaintext stays out of public metadata, user export, codec cache and runtime diagnostics',actual:{canaryDigest:digest(credentialCanary),intendedResolveMatched:true,foreignResolve:null,metadataSurfaces:statuses.length,archiveDigest:digest(archiveBytes),archiveDecompressedBytes:archive.length,controllerCache:cache,runtimeLogsDigest:digest(logs.stdout+logs.stderr),plaintextMatches:0,uncovered:'Other package/library caches and full operator/web log inventory not yet scanned'}});
    observations.push({caseId:'SAAS-21',scope:'actual-runtime-telemetry-env-and-bounded-diagnostic-scan',setup:'Actual serving candidate environment and logs; controlled loopback upstream request ledger retained with scope, no external provider request',expected:'Telemetry-disabled environment and credential-canary-free actual diagnostics; intended controlled requests remain attributed',actual:{telemetryDisabled:true,canaryMatches:0,controlledRequests:transport.requests.length,logDigest:digest(logs.stdout+logs.stderr),uncovered:'Actual full outbound packet/DNS/telemetry collector capture is not established by an environment flag'}});
    stage='ordinary-connector-credential-revocation';await campaignRequest(baseUrl,owner,'/api/connectors/unpaywall','DELETE',undefined,200,signal);
    assert.equal(await ownedCredentials.resolveOwn(owner.user.id,'unpaywall'),null);assert.equal(await ownedCredentials.resolveOwn(other.user.id,'unpaywall'),null);assert.equal(digest(await fs.readFile(outputPath)),digest(output));
    observations.push({caseId:'SAAS-05',scope:'actual-ordinary-connector-delete-current-credential-revocation',setup:'Ordinary authenticated connector DELETE and fresh real encrypted store resolve; fixed document adapter deliberately has no connectionRefs or connector consumer',expected:'Revoked personal connector cannot resolve its credential again; another actor cannot resolve it; completed document bytes survive',actual:{afterOwnerRevocation:null,foreignResolve:null,completedArtifactDigest:digest(output),uncovered:'Cowork executionClass explicitly requires connectionRefs=[]; no queued native connector-consuming operation exists in this artifact, so unrelated document reads are not claimed revoked'}});
    stage='real-queued-private-admission-revocation';await app.hostedExtensions.worker.close();
    const queuedStage=await dispatchStage('queued-read',[{name:'doc_read',input:{resourceId:resource.resourceId}}]);
    const queued=await campaignPoll(async()=>{const rows=(await app.store.database.query("SELECT id,payload FROM evimed_product.jobs WHERE user_id=$1 AND project_id=$2 AND kind='extension-execute' AND status='queued' AND payload->>'dispatch' IS NULL ORDER BY created_at",[owner.user.id,project.id])).rows;return rows.find(row=>row.payload.auth?.invocation&&JSON.parse(row.payload.auth.invocation).sessionId===queuedStage.sessionId)??null;},deadline,signal);
    const revokedPath=path.join(state.admission.root,'revoked-admission.json');
    const revoked=await observeQueuedOperationRevocation({app,project,jobId:queued.id,completedArtifact,revoke:()=>fs.rename(state.admission.recordPath,revokedPath)});
    revoked.scope='actual-private-admission-queued-operation-revocation';revoked.setup+='; revoked measurement admission only, ordinary membership/credential revocation remains unmeasured';append(revoked);
    assert.equal(digest(await fs.readFile(outputPath)),digest(output));
    report=createCampaignReport({artifactDigest:state.descriptor.artifactDigest,sourcePolicy:state.sourcePolicy,nativeImage:state.overrides.runtimeContainerImage,descriptor:state.descriptor},observations);
    report.privateJourney={status:'observed-main-path-partial',qualified:false,providerQualityMeasured:false,controlledTransport:{requests:transport.requests,errors:transport.errors},physicalSetupDigest:digest(canonicalJson(state.physicalSetup)),remaining:['Queued ordinary membership/credential revocation (private measurement admission revocation is measured separately)','Full outbound capture and other package/web-log canary scans','All22 complete current-identity outcomes and separate qualified ordinary smoke']};
  }catch(error){failure=error;error.campaignStage=stage;report=createCampaignReport({artifactDigest:state.descriptor.artifactDigest,sourcePolicy:state.sourcePolicy,nativeImage:state.overrides.runtimeContainerImage,descriptor:state.descriptor},observations);report.privateJourney={status:'incomplete',stage,...safeCampaignFailureDetails(error),route:error.campaignRoute??null,terminalRun:error.terminalRun??null,controlledTransport:{requests:transport.requests,errors:transport.errors},qualified:false};}
  finally{if(fixture&&measurementProject&&report&&failure?.terminalRun?.sessionId)try{const transcript=await fixture.app.runtimeManager.sessionTranscript(measurementProject,failure.terminalRun.sessionId,{wake:false});report.privateJourney.nativeFailureFacts=campaignNativeFailureFacts(transcript);}catch(error){report.privateJourney.nativeFailureUnavailable=safeCampaignDiagnosticCode(error);}
    if(report)report.privateJourney.relayIngress=relay?.observations??[];
    if(fixture&&measurementProject&&report)try{report.privateJourney.usageFacts=await campaignUsageFacts(fixture.app,measurementProject,measurementStartedAt);}catch(error){report.privateJourney.usageFactsUnavailable=safeCampaignDiagnosticCode(error);}for(const key of transport.holds.keys())transport.release(key);try{await fixture?.close();await relay?.close();await transport.close();cleanupConfirmed=true;}catch{cleanupConfirmed=false;}}
  report.cleanup={physicallyJoined:cleanupConfirmed};report.qualified=false;
  const reportPath=path.join(state.root,'campaign-measurement-'+randomUUID()+'.json');await saveProtected(reportPath,report);
  if(!cleanupConfirmed)throw Object.assign(new Error('private_campaign_cleanup_unconfirmed'),{code:'private_campaign_cleanup_unconfirmed',reportPath});
  if(failure)throw Object.assign(failure,{reportPath});
  return{status:report.privateJourney.status,qualified:false,reportPath,cases:report.cases.map(({caseId,status,componentOutcome})=>({caseId,status,componentOutcome}))};
}
/** Separate post-qualification admission smoke. Protected genuine receipt verifies before any new DB/root/controller is created. */
export async function ordinaryQualifiedSmoke(inputs,{signal=null}={}){
  inputs=validatePrivateCampaignInputs(inputs);if(inputs.operatorPlatform==='linux-native')assertNativeCampaignOperator(process.platform,process.getuid?.());if(inputs.phase!=='qualified-smoke')throw new Error('explicit_ordinary_qualified_smoke_required');
  const prior=await protectedCampaignJson(inputs.statePath,'campaign-state.json'),oldDeployment=loadExtensionDeployment({dataDir:prior.root}),entry=oldDeployment.catalogue.find(item=>item.id===prior.descriptor?.id);
  if(oldDeployment.status!=='configured'||!entry||inputs.signingKeyPath.startsWith(prior.root+path.sep))throw new Error('ordinary_smoke_protected_tuple_unavailable');
  const secret=(await protectedCampaignBytes(inputs.signingKeyPath,'qualification-signing.key')).toString('utf8').trim();if(Buffer.byteLength(secret)<32||Buffer.byteLength(secret)>8192)throw new Error('ordinary_smoke_signing_configuration_invalid');
  const recordName=createHash('sha256').update(entry.id).digest('hex')+'.json';
  if(path.basename(inputs.qualificationRecordPath)!==recordName)throw new Error('ordinary_smoke_receipt_path_invalid');
  const envelopeBytes=await protectedCampaignBytes(inputs.qualificationRecordPath,recordName);
  const genuine=new ExtensionQualification({root:path.dirname(inputs.qualificationRecordPath),secret,
    currentIdentity:async()=>deploymentProofIdentity(loadExtensionDeployment({dataDir:prior.root}),entry,prior.overrides.runtimeContainerImage),surfaces:async()=>oldDeployment.surfaces.get(entry.id)});
  const authority=await genuine.authority(entry);if(!authority)throw new Error('ordinary_smoke_genuine_receipt_required');
  const root=await createShortCampaignRoot();
  const isolated=await createGeoTestDatabase(prior.databaseUrl,'smoke'),transport=await controlledCampaignTransport();
  let fixture,relay,network,volumeName='',stage='fresh-ordinary-controller-start',failure=null,result,cleanupConfirmed=false;
  try{
    const descriptor=await createAssessmentDescriptor({imageId:prior.descriptor.imageId,integrity:prior.descriptor.integrity,closureExpectedSHA:prior.descriptor.closureExpectedSHA});assert.equal(canonicalJson(descriptor),canonicalJson(prior.descriptor));
    const deployment=await prepareAssessmentDeployment(root,descriptor,authority.currentIdentity.suiteRevision);
    network=await createOwnedCampaignNetwork(root);
    await fs.mkdir(deployment.qualificationRoot,{mode:0o700,recursive:true});await fs.writeFile(path.join(deployment.qualificationRoot,recordName),envelopeBytes,{mode:0o400,flag:'wx'});
    const validator=await createNativeValidationFixture({dataDir:root,image:prior.overrides.runtimeContainerImage});await validator.close();await bindAssessmentDockerLauncher(path.join(root,'docker-fixture.mjs'));
    if(inputs.mountMode==='volume-subpath'){volumeName='evimed-saas-campaign-'+randomUUID();await execute('docker',['volume','create','--label','io.evimed.campaign-root='+digest(canonicalJson(root)),'--driver','local','--opt','type=none','--opt','o=bind','--opt','device='+root,volumeName],{env:assessmentDockerEnvironment(),timeout:10000,maxBuffer:8192});}
    const webPort=await new Promise(resolve=>{const probe=http.createServer();probe.listen(0,'127.0.0.1',()=>{const port=probe.address().port;probe.close(()=>resolve(port));});});
    const nativeLinux=inputs.operatorPlatform==='linux-native';if(nativeLinux){await observeNativeLinuxPrerequisites(prior.overrides.runtimeContainerImage);relay=await bindNativeLinuxRelay({root,network,listenPort:inputs.nativeRelayListenPort??0});}
    const overrides={...prior.overrides,...CAMPAIGN_RUNTIME_LIMITS,dataDir:root,databaseUrl:isolated.url,modelGatewaySigningSecret:secret,evimedWorkloadSigningSecret:randomBytes(32).toString('hex'),bootstrapPassword:randomBytes(24).toString('hex'),
      runtimeContainerBin:path.join(root,'docker-fixture.mjs'),runtimeDataVolume:volumeName,runtimeControllerSocket:path.join(root,'.openscience/runtime-controller.sock'),runtimeMode:'kernel',
      runtimeNetworkMode:network.name,runtimeInternalNetworkName:network.name,allowRuntimeNetworkEgress:false,allowRuntimeHostNetwork:false,
      deepseekProviderEnabled:true,deepseekApiKey:'assessment-controlled-transport',deepseekApiKeyFile:'',deepseekBaseUrl:transport.url,port:webPort,
      host:nativeLinux?'127.0.0.1':prior.overrides.host,modelGatewayInternalUrl:(relay?.gatewayUrl??'http://assessment-gateway:8787')+'/internal/model/v1',extensionGatewayInternalUrl:(relay?.gatewayUrl??'http://assessment-gateway:8787')+'/internal/extensions/v1'};
    fixture=await openOrdinaryQualificationFixture({overrides});const {app,baseUrl}=fixture;
    if(nativeLinux)relay.bindTarget(baseUrl+'/');else relay=await startOwnedCampaignRelay({root,imageId:overrides.runtimeContainerImage,network,fixtureUrl:baseUrl+'/',gatewayHost:inputs.gatewayHost});
    stage='fresh-ordinary-registration-install-prepare';const response=await fetch(baseUrl+'/api/auth/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'ordinary-qualified-smoke',password:randomBytes(24).toString('hex'),name:'Ordinary qualified smoke',warm:false}),signal:signal??AbortSignal.timeout(30000)});
    const body=await response.json();assert.equal(response.status,201);const actor={user:body.data.user,headers:{Cookie:response.headers.get('set-cookie').split(';')[0],'X-Open-Science-CSRF':body.data.csrfToken}},me=await campaignRequest(baseUrl,actor,'/api/me');assert.equal(me.operator,false);
    actor.projectId=me.project.id;actor.headers['X-Open-Science-Project']=me.project.id;const project=await resolveCampaignProject(app,actor),catalogue=await campaignRequest(baseUrl,actor,'/api/extensions/catalogue');
    const qualifiedEntry=catalogue.items.find(item=>item.id===descriptor.id);assert.equal(qualifiedEntry.evidenceState,'saas-qualified');assert.equal(qualifiedEntry.qualification.receiptDigest,authority.receipt.receiptDigest);
    const installed=await campaignRequest(baseUrl,actor,'/api/extensions/installations','POST',{coordinate:descriptor.coordinate,scope:'project',projectId:project.id,idempotencyKey:'ordinary-qualified-smoke'},201,signal);
    const deadline=Date.now()+inputs.deadlineMs;
    await campaignPoll(async()=>{const prepared=await app.extensionService.jobs.get(actor.user.id,installed.job.id);if(prepared.status==='failed')throw Object.assign(new Error('ordinary_preparation_failed'),{code:prepared.error?.code});return prepared.status==='succeeded'?prepared:null;},deadline,signal);
    stage='ordinary-qualified-select-and-real-runtime';const selected=await campaignRequest(baseUrl,actor,`/api/projects/${encodeURIComponent(project.id)}/extensions`);
    await campaignRequest(baseUrl,actor,`/api/projects/${encodeURIComponent(project.id)}/extensions`,'PUT',{expectedRevision:selected.revision,selections:[{installationId:installed.installation.id,enabled:true,settings:{},connectionRefs:[]}]},200,signal);
    const effective=await campaignPoll(async()=>{const current=await app.hostedExtensions.generations.current(project);return current?.payload.phase==='effective'&&current.payload.effective.bindings.desiredRevision===selected.revision+1?current:null;},deadline,signal);
    for(const plugin of effective.payload.effective.projection.plugins)assert.equal(Object.hasOwn(plugin,'assessmentAdmissionDigest'),false);
    assert.equal(effective.payload.effective.projection.plugins.find(plugin=>plugin.extensionId===descriptor.id).receiptDigest,authority.receipt.receiptDigest);
    const runtime=app.runtimeManager.runtimes.get(app.runtimeManager.key(project)),actual=JSON.parse((await execute(app.config.runtimeContainerBin,['inspect','--format','{{json .}}',runtime.containerName],{env:assessmentDockerEnvironment(),timeout:5000,maxBuffer:256*1024})).stdout),volume=volumeName?JSON.parse((await execute('docker',['volume','inspect',volumeName],{env:assessmentDockerEnvironment(),timeout:5000,maxBuffer:16384})).stdout)[0]:null;
    const inspectedNetwork=JSON.parse((await execute('docker',['network','inspect',network.id],{env:assessmentDockerEnvironment(),timeout:5000,maxBuffer:65536})).stdout)[0];
    await saveProtected(path.join(root,'physical-inspection-ordinary-smoke.json'),campaignPhysicalInspectionMetadata(actual,volume,inspectedNetwork));
    const physical=validatePrivateRuntimeMounts(actual,{imageId:overrides.runtimeContainerImage,ownerId:actor.user.id,projectId:project.id,authorityRoot:deployment.qualificationRoot,qualificationRoot:deployment.qualificationRoot,dataDir:root,dataVolume:volumeName,volume,network:inspectedNetwork});
    stage='ordinary-qualified-native-gateway-ledger-controller-documents';const publicRoot=path.join(root,'public-fixtures'),files=await createFixtures(publicRoot),pdf=await fs.readFile(path.join(publicRoot,files.res_pdf.file)),principal={userId:actor.user.id,projectId:project.id,jti:app.runtimeManager.runtimeGeneration(project)},captured=await app.hostedExtensions.documents.prepareCapture(principal);
    const resource=await app.hostedExtensions.documents.capturePdf(principal,pdf,{doi:'synthetic-public-fixture',origin:'https://example.invalid/synthetic-public-fixture'},captured,async()=>{assert.equal(app.runtimeManager.runtimeGeneration(project),principal.jti);return principal;});
    const id=randomUUID(),key=id+':read-write',target='qualified_result_ipynb';transport.plans.set(key,[{name:'doc_read',input:{resourceId:resource.resourceId}},{name:'doc_write',input:{targetId:target,format:'ipynb',spec:{kind:'create',cells:[{type:'markdown',source:'Controlled ordinary qualification smoke; public PDF fixture 42.'},{type:'code',source:'raise SystemExit("must remain inert")'}]}}}]);
    const {session}=await dispatchOrdinaryCampaignTurn(baseUrl,actor,{dispatchId:'qualified-smoke-'+id,text:'EVIMED_ASSESSMENT_STAGE:'+key+'\nRead the supplied public fixture and write an inert notebook with the selected document tools.'},signal);
    const jobs=await campaignPoll(async()=>{const rows=(await app.store.database.query("SELECT id,status,payload,result FROM evimed_product.jobs WHERE user_id=$1 AND project_id=$2 AND kind='extension-execute' ORDER BY created_at",[actor.user.id,project.id])).rows;return rows.length===2&&rows.every(row=>row.status==='succeeded')?rows:null;},deadline,signal);
    const workspace=await app.runtimeManager.workspaceRootForDelivery(project),output=await fs.readFile(path.join(workspace,'outputs/extensions/'+target+'.ipynb')),notebook=JSON.parse(output);assert(notebook.cells.some(cell=>cell.cell_type==='code'&&cell.execution_count===null&&(cell.outputs??[]).length===0));
    result={status:'ordinary-qualified-admission-smoke-observed',sessionId:session.id,receiptDigest:authority.receipt.receiptDigest,assessmentAuthorityUsed:false,ordinaryActor:actor.user.id,
      freshDatabaseNamespace:isolated.name,physicalRuntime:physical,jobIds:jobs.map(job=>job.id),operations:jobs.map(job=>job.payload.request.operation),outputDigest:digest(output),controlledTransportOnly:true,
      note:'Separate post-qualification ordinary admission smoke; does not amend or retroactively supply prior22 measurement outcomes.'};
  }catch(error){failure=error;result={status:'ordinary-qualified-smoke-incomplete',stage,...safeCampaignFailureDetails(error),receiptDigest:authority.receipt.receiptDigest,assessmentAuthorityUsed:false};}
  finally{try{await fixture?.close();await relay?.close();await transport.close();if(volumeName)await removeCampaignVolume(root,volumeName);if(network)await removeOwnedCampaignNetwork(network);await isolated.drop();cleanupConfirmed=true;}catch{cleanupConfirmed=false;}}
  result.cleanup={physicallyJoined:cleanupConfirmed};const reportPath=path.join(path.dirname(inputs.signingKeyPath),'ordinary-qualified-smoke-'+randomUUID()+'.json');await saveProtected(reportPath,result);
  if(!cleanupConfirmed)throw Object.assign(new Error('ordinary_smoke_cleanup_unconfirmed'),{code:'ordinary_smoke_cleanup_unconfirmed',reportPath});if(failure)throw Object.assign(failure,{reportPath});
  return{status:result.status,receiptDigest:result.receiptDigest,reportPath,assessmentAuthorityUsed:false};
}
/** Only local fixture connection/image inputs; credentials never enter observations. */
export async function runOrdinaryAssessmentJourney({ databaseUrl, coworkImage, validatorImage, closureExpectedSHA, integrity, acceptanceInputsPath = null, signal = null }) {
  assessmentDockerEnvironment();
  const preparedInputs = acceptanceInputsPath ? await readAcceptanceInputs(acceptanceInputsPath) : null;
  if (preparedInputs) { coworkImage = preparedInputs.images.coworkImageId; validatorImage = preparedInputs.images.nativeSdkImageId; closureExpectedSHA = preparedInputs.artifact.closureExpectedSHA; integrity = preparedInputs.artifact.integrity; }
  const parsed = new URL(databaseUrl);
  assert(['postgres:', 'postgresql:'].includes(parsed.protocol)); assert.equal(parsed.search, ''); assert.equal(parsed.hash, '');
  assert(['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)); assert.match(parsed.pathname, /^\/evimed_test[a-z0-9_]*$/);
  assert.match(coworkImage, /^sha256:[a-f0-9]{64}$/); assert.match(validatorImage, /^sha256:[a-f0-9]{64}$/);
  const fixtureRoot = path.join(repo, '.evimed-local/extensions/build/fixtures'); await fs.mkdir(fixtureRoot, { recursive: true });
  const root = path.join(await fs.realpath(fixtureRoot), 'extension-saas-' + randomUUID()); await fs.mkdir(root, { mode: 0o700 });
  const isolated = await createGeoTestDatabase(databaseUrl, 'saas');
  const observations = [], timings = [], exchanges = [], started = performance.now();
  let app, validator, composition, report, failure = null, cleanupUnconfirmed = false, preparationDiagnostic = null, phase = 'bootstrap';
  const checkInterrupted = () => signal?.throwIfAborted();
  const requestSignal = () => signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
  try {
    checkInterrupted();
    const descriptor = await createAssessmentDescriptor({ imageId: coworkImage, integrity, closureExpectedSHA });
    const deployment = await prepareAssessmentDeployment(root, descriptor, digest(await fs.readFile(new URL(import.meta.url))));
    validator = await createNativeValidationFixture({ dataDir: root, image: validatorImage });
    await bindAssessmentDockerLauncher(path.join(root, 'docker-fixture.mjs'));
    app = createWebApiApp({ dataDir: root, databaseUrl: isolated.url, databasePoolMax: 1, databaseConnectionTimeoutMs: 1000,
      stateStore: 'postgres', runtimeMode: 'mock', localAutoConfig: false, devAuth: false, authMode: 'local', selfRegistrationEnabled: true,
      bootstrapUser: 'assessment-bootstrap', bootstrapPassword: randomBytes(24).toString('hex'),
      deepseekProviderEnabled: false, learningEnabled: false, reviewEnabled: false, geoEnabled: false, vcrEnabled: false, frontierEnabled: false,
      operatorUsers: 'assessment-bootstrap', modelGatewaySigningSecret: randomBytes(32).toString('hex'), runtimeContainerBin: path.join(root, 'docker-fixture.mjs'), runtimeContainerImage: validatorImage,
      skillValidationController: { validatePersonalSkill: reference => validator.validate(reference) },
    });
    const address = await app.listen(0, '127.0.0.1'), base = `http://127.0.0.1:${address.port}`;
    phase = 'ordinary-registration';
    const accounts = [];
    for (const username of ['ordinary-a', 'ordinary-b']) {
      const response = await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password: randomBytes(24).toString('hex'), name: username, warm: false }), signal: requestSignal() });
      const body = await response.json(); assert.equal(response.status, 201, body.code);
      assert.notEqual(body.data.user.id, app.config.bootstrapUser);
      accounts.push({ username, user: body.data.user, headers: { Cookie: response.headers.get('set-cookie').split(';')[0], 'X-Open-Science-CSRF': body.data.csrfToken } });
    }
    const request = async (actor, route, method = 'GET', value = undefined, expected = 200) => {
      checkInterrupted();
      const before = performance.now();
      const response = await fetch(base + route, { method, headers: { ...actor.headers, 'content-type': 'application/json' },
        ...(value === undefined ? {} : { body: JSON.stringify(value) }), signal: requestSignal() });
      const body = await response.json(); assert.equal(response.status, expected, body.code);
      exchanges.push({ method, route, status: response.status, code: body.code ?? null, responseDigest: digest(JSON.stringify(body)) });
      timings.push({ operation: method + ' ' + route.replace(/skill%3A[^/]+/g, 'skill:owned'), elapsedMs: performance.now() - before, status: response.status });
      return body.data;
    };
    phase = 'personal-lifecycle';
    const [alice, bob] = accounts, content = { expectedRevision: 0, title: 'Local authored method', description: 'Compare supplied public sources', instructions: 'Preserve quotation provenance and distinguish unknown from zero.' };
    const aliceMe = await request(alice, '/api/me'), bobMe = await request(bob, '/api/me');
    assert.equal(aliceMe.operator, false); assert.equal(bobMe.operator, false);
    const projectId = aliceMe.project.id;
    const skill = await request(alice, '/api/skills', 'POST', content, 201), skillUrl = '/api/skills/' + encodeURIComponent(skill.id);
    assert.equal(skill.payload.prepared, true);
    await request(bob, skillUrl, 'GET', undefined, 404); await request(bob, skillUrl + '/portable', 'GET', undefined, 404);
    const archiveEntries = { 'SKILL.md': Buffer.from('---\nname: account-resource-check\ndescription: Owned public resource\n---\n\nRead references/public.txt and retain provenance.\n'), 'references/public.txt': Buffer.from('Synthetic public evidence canary; no patient rows.') };
    const archive = await nativeSkillSnapshotArchive(Object.entries(archiveEntries).map(([name, bytes]) => ({ path: name, size: bytes.length, digest: digest(bytes), bytesBase64: bytes.toString('base64') })));
    const uploaded = await fetch(base + '/api/skills/uploads?kind=tar-gzip', { method: 'POST', headers: { ...alice.headers, 'content-type': 'application/octet-stream' }, body: archive, signal: requestSignal() });
    assert.equal(uploaded.status, 201); const resourceId = (await uploaded.json()).data.resourceId;
    const imported = await request(alice, '/api/skills/import', 'POST', { resourceId, title: 'Owned source with resource' }, 201);
    const resource = imported.payload.resources[0]; assert(resource);
    await request(bob, '/api/skills/' + encodeURIComponent(imported.id) + '/resources/' + encodeURIComponent(resource.id) + '?revision=1', 'GET', undefined, 404);
    const own = await request(bob, '/api/skills', 'POST', { ...content, title: 'Other ordinary account method' }, 201); assert.notEqual(own.id, skill.id);
    const changed = await request(alice, skillUrl, 'PUT', { ...content, expectedRevision: 1, instructions: content.instructions + '\nRetain failed tool observations.' });
    assert.equal(changed.revision, 2); await request(alice, skillUrl, 'PUT', { ...content, expectedRevision: 1 }, 409);
    const restored = await request(alice, skillUrl + '/restore', 'POST', { expectedRevision: 2, revision: 1 }); assert.equal(restored.revision, 3);
    assert.equal(restored.payload.digest, skill.payload.digest);
    phase = 'extension-install-prepare';
    const installed = await request(alice, '/api/extensions/installations', 'POST', { coordinate: descriptor.coordinate, scope: 'project', projectId, idempotencyKey: 'ordinary-install' }, 201);
    await request(bob, '/api/extensions/installations/' + encodeURIComponent(installed.installation.id), 'GET', undefined, 404);
    await request(bob, '/api/extensions/installations/' + encodeURIComponent(installed.installation.id) + '/revisions', 'GET', undefined, 404);
    await request(bob, '/api/extensions/jobs/' + encodeURIComponent(installed.job.id), 'GET', undefined, 404);
    const again = await request(alice, '/api/extensions/installations', 'POST', { coordinate: descriptor.coordinate, scope: 'project', projectId, idempotencyKey: 'ordinary-install' }, 201);
    assert.equal(again.installation.id, installed.installation.id); assert.equal(again.job.id, installed.job.id);
    phase = 'controller-composition';
    composition = createControllerExtensionComposition({ config: app.config, deployment, database: app.store.database }); assert(composition, JSON.stringify({ deploymentConfigured: deployment.status === 'configured', databaseConfigured: Boolean(app.config.databaseUrl), signerConfigured: typeof app.config.modelGatewaySigningSecret === 'string' && app.config.modelGatewaySigningSecret.length >= 32 }));
    const controller = {
      admissionAvailable: () => composition.tools.admissionAvailable(),
      cancelPreparation: identity => composition.tools.cancelPreparation(identity),
      prepare: async (body, options) => {
        try {
          const signals = [options?.signal, signal].filter(Boolean);
          return await composition.tools.prepare(body, { ...options, ...(signals.length ? { signal: AbortSignal.any(signals) } : {}) });
        }
        catch (error) { preparationDiagnostic = { code: error?.code ?? 'unknown', name: error?.name ?? 'Error', frames: String(error.stack ?? '').split('\n').slice(1, 9) }; throw error; }
      },
    };
    class ObservedPreparationWorker extends ExtensionPreparationWorker {
      async guard(job) {
        try { return await super.guard(job); }
        catch (error) { preparationDiagnostic = { boundary: 'worker-current-scope', code: error?.code ?? 'unknown', name: error?.name ?? 'Error', frames: String(error.stack ?? '').split('\n').slice(1, 9) }; throw error; }
      }
    }
    const preparation = new ObservedPreparationWorker({ service: app.extensionService, controller, admittedArtifacts: deployment.admittedArtifacts });
    phase = 'contained-preparation';
    await preparation.tick();
    const current = await request(alice, '/api/extensions/installations/' + encodeURIComponent(installed.installation.id));
    assert.equal(current.prepareJobId, installed.job.id); assert.equal(current.effective, false);
    const job = await app.extensionService.jobs.get(alice.user.id, installed.job.id);
    if (job.status !== 'succeeded') throw Object.assign(new Error('controlled_preparation_failed'), { code: job.error?.code ?? 'unknown_preparation_outcome', expected: 'succeeded', actual: job.status, preparationDiagnostic }); assert.equal(job.result.artifactDigest, descriptor.artifactDigest);
    observations.push({ caseId: 'SAAS-01', scope: 'actual-local-http-pg-native-preparation', setup: ASSESSMENT_BOOTSTRAP,
      expected: 'foreign metadata/history/resource/job/export denied; independent ordinary account operations usable', actual: { requests: exchanges, ownPrepared: own.payload.prepared },
      ordinaryActors: accounts.map(actor => ({ userId: actor.user.id, platformOperator: false })), artifactDigest: descriptor.artifactDigest });
    observations.push({ caseId: 'SAAS-16', scope: 'actual-default-controller-image-admission', setup: 'real leased preparation job; no qualification dependency used',
      expected: 'exact contained immutable artifact prepares without claiming effective or SaaS-qualified', actual: { status: job.status, artifactDigest: job.result.artifactDigest, effective: current.effective } });
    report = { status: 'partial', qualified: false, defaultNativeHostedJourney: 'pending-real-campaign-receipt', identity: { descriptor, sourcePolicy: deployment.policy, nativeImage: validatorImage },
      observations, timing: { elapsedMs: performance.now() - started, operations: timings }, cleanup: 'owned processes and database joined in finally' };
  } catch (error) { error.assessmentStage = phase; failure = error; } finally {
    let failed = false;
    for (const close of [() => composition?.close(), () => validator?.close(), () => app?.close()]) { try { await close(); } catch { failed = true; } }
    try { await isolated.drop(); } catch { failed = true; }
    if (!failed) await fs.rm(root, { recursive: true, force: true });
    cleanupUnconfirmed = failed;
  }
  if (cleanupUnconfirmed) throw new Error('assessment_cleanup_unconfirmed');
  if (failure) throw failure;
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const abort = new AbortController(), interrupted = () => abort.abort(new DOMException('Assessment interrupted.','AbortError'));
  process.once('SIGTERM', interrupted); process.once('SIGINT', interrupted);
  try {
    let report;
    if (process.argv.length === 3 && process.argv[2] === '--private-campaign') {
      const inputs=validatePrivateCampaignInputs(await protectedCampaignJson(process.env.EVIMED_EXTENSION_PRIVATE_CAMPAIGN_INPUTS,'private-campaign-inputs.json'));
      report=await (inputs.phase==='setup'?setupPrivateCampaign:inputs.phase==='measure'?measurePrivateCampaign:ordinaryQualifiedSmoke)(inputs,{signal:abort.signal});
    } else {
      if(process.argv.length!==2)throw new Error('unknown_assessment_arguments');
      report = await runOrdinaryAssessmentJourney({ databaseUrl: process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, coworkImage: process.env.COWORK_TEST_IMAGE, validatorImage: process.env.NATIVE_SKILL_VALIDATOR_IMAGE, closureExpectedSHA: process.env.COWORK_TEST_CLOSURE_SHA256, integrity: process.env.COWORK_TEST_INTEGRITY, acceptanceInputsPath: process.env.EVIMED_EXTENSION_ACCEPTANCE_INPUTS ?? null, signal: abort.signal });
    }
    process.stdout.write(JSON.stringify(report) + '\n');
  } catch (error) { process.stderr.write(JSON.stringify({ status: 'failed', qualified: false, code: safeCampaignDiagnosticCode(error), originalCode:error.originalCode??error.originalFailure?.code??null, phase: error?.campaignStage ?? error?.assessmentStage ?? 'input', reportPath:error.reportPath??null, expected: ['string', 'number', 'boolean'].includes(typeof error?.expected) ? error.expected : undefined, actual: ['string', 'number', 'boolean'].includes(typeof error?.actual) ? error.actual : undefined, detail: error?.assessmentStage === 'controller-composition' ? error.message : undefined, preparationDiagnostic: error?.preparationDiagnostic ?? null }) + '\n'); process.exitCode = 1; }
  finally { process.removeListener('SIGTERM', interrupted); process.removeListener('SIGINT', interrupted); }
}
