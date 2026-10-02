/** Private local process composition. No environment, HTTP parameter or public configuration installs these factories. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { canonicalJson, canonicalExtensionCoordinate, roleAllows } from '@evimed/domain';
import { createExtensionAssessmentAuthority } from '../../apps/server/src/extensionAssessmentAuthority.mjs';
import { loadExtensionDeployment, deploymentProofIdentity, deploymentGenerationIdentities } from '../../apps/server/src/extensionDeployment.mjs';
import { ExtensionGenerationService } from '../../apps/server/src/extensionGenerationService.mjs';
import { ExtensionQualification } from '../../apps/server/src/extensionQualification.mjs';
import { composeExtensionExecution } from '../../apps/server/src/extensionHostedIntegration.mjs';
import { createControllerExtensionComposition } from '../../apps/server/src/extensionControllerComposition.mjs';
import { createRuntimeController } from '../../apps/server/src/runtimeControllerServer.mjs';
import { RuntimeManager } from '../../apps/server/src/runtimeManager.mjs';
import { RuntimeControllerClient } from '../../apps/server/src/runtimeControllerClient.mjs';
import { ControlPlaneDatabase } from '../../apps/server/src/controlPlaneDatabase.mjs';
import { loadConfig } from '../../apps/server/src/config.mjs';
import { createWebApiApp } from '../../apps/server/src/server.mjs';
import { assessmentDockerEnvironment } from './extension-saas-acceptance-docker.mjs';
import { assertAssessmentFixtureRoot } from './extension-saas-acceptance-manifest.mjs';
const execute = promisify(execFile), digest = value => 'sha256:' + createHash('sha256').update(canonicalJson(value)).digest('hex');
function constructorFailureDetails(error){
 const trustedRoot=fileURLToPath(new URL('../../../',import.meta.url)),frames=[];
 for(const match of String(error?.stack??'').matchAll(/(?:file:\/\/)?(\/[A-Za-z0-9_./%-]+\.(?:mjs|js|cjs)):(\d+):(\d+)/g)){const file=decodeURIComponent(match[1]);if(file.startsWith(trustedRoot)&&!file.includes('/.evimed-local/'))frames.push({file:path.relative(trustedRoot,file),line:Number(match[2]),column:Number(match[3])});if(frames.length===12)break;}
 const code=typeof error?.code==='string'&&/^[A-Za-z0-9_:-]{1,100}$/.test(error.code)?error.code:
  ['private_controller_ipc_refused','private_controller_setup_refused','private_controller_parent_disconnected','assessment_controller_unavailable','ordinary_controller_unavailable','campaign_relay_physical_boundary_unconfirmed','campaign_relay_cleanup_identity_unconfirmed','campaign_relay_physical_join_unconfirmed'].includes(error?.message)?error.message:'private_controller_constructor_failed';
 return{code,frames};
}
const daemon=async args=>(await execute('docker',args,{env:assessmentDockerEnvironment(),timeout:10000,maxBuffer:256*1024})).stdout.trim();
/** The candidate's only network is a newly owned internal bridge; an independently inspected relay is its fixed gateway peer. */
export async function createOwnedCampaignNetwork(root){
 const name='evimed-saas-network-'+randomUUID(),label=digest(root);
 await fs.writeFile(path.join(root,'network-intent.json'),canonicalJson({name,rootDigest:label,internal:true,operatorUid:process.getuid()})+'\n',{mode:0o400,flag:'wx'});
 await daemon(['network','create','--internal','--driver','bridge','--label','io.evimed.campaign-root='+label,name]);
 const observed=JSON.parse(await daemon(['network','inspect',name]))[0];
 if(observed.Name!==name||!/^[a-f0-9]{64}$/.test(observed.Id)||observed.Driver!=='bridge'||observed.Internal!==true||observed.Labels?.['io.evimed.campaign-root']!==label)throw new Error('campaign_internal_network_unconfirmed');
 return Object.freeze({name,id:observed.Id,rootDigest:label});
}
export async function removeOwnedCampaignNetwork(network){
 const observed=JSON.parse(await daemon(['network','inspect',network.id]))[0];
 if(observed.Id!==network.id||observed.Name!==network.name||observed.Internal!==true||observed.Labels?.['io.evimed.campaign-root']!==network.rootDigest||Object.keys(observed.Containers??{}).length)throw new Error('campaign_network_cleanup_unconfirmed');
 await daemon(['network','rm',network.id]);
}
/** Trusted transport code has no mount/secret/socket and forwards only these existing workload-authenticated paths to the actual fixture. */
export function campaignRelaySource(target){
 const url=new URL(target);if(url.protocol!=='http:'||!['host.lima.internal','host.docker.internal','127.0.0.1'].includes(url.hostname)||!url.port||url.pathname!=='/'||url.username||url.password||url.search||url.hash)throw new Error('campaign_relay_destination_refused');
 return `const http=require('node:http');const target=${JSON.stringify(url.origin)};const allowed=new Set(['/internal/model/v1/messages','/internal/extensions/v1/execute','/internal/extensions/v1/status','/internal/extensions/v1/cancel']);let active=0;const server=http.createServer((req,res)=>{if(req.method!=='POST'||!allowed.has(req.url)||active>=16){res.writeHead(403);res.end();return;}active++;let released=false;const done=()=>{if(!released){released=true;active--;}};const headers={};for(const[key,value]of Object.entries(req.headers)){if(['host','connection','keep-alive','transfer-encoding','proxy-authorization','proxy-authenticate','forwarded','upgrade'].includes(key)||key.startsWith('x-forwarded-'))continue;headers[key]=value;}let sent=0,received=0;const upstream=http.request(new URL(req.url,target),{method:'POST',headers},reply=>{const output={};for(const[key,value]of Object.entries(reply.headers)){if(['connection','keep-alive','transfer-encoding','upgrade','server','x-powered-by'].includes(key))continue;output[key]=value;}res.writeHead(reply.statusCode,output);reply.on('data',chunk=>{received+=chunk.length;if(received>12*1024*1024){reply.destroy();res.destroy();return;}res.write(chunk);});reply.on('end',()=>res.end());reply.on('error',()=>res.destroy());});const timer=setTimeout(()=>{upstream.destroy();res.destroy();},120000);const finish=()=>{clearTimeout(timer);done();};res.on('close',()=>{if(!res.writableEnded)upstream.destroy();finish();});req.on('aborted',()=>upstream.destroy());upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.on('data',chunk=>{sent+=chunk.length;if(sent>8*1024*1024){upstream.destroy();res.destroy();return;}upstream.write(chunk);});req.on('end',()=>upstream.end());});server.maxConnections=16;server.requestTimeout=120000;server.headersTimeout=10000;server.listen(8787,'0.0.0.0');`;
}
/** Removal authority is exact captured creation identity; a failed admission must not strand that owned object. */
export function assertOwnedRelayIdentity(actual,{id,name,imageId,rootDigest}){
 if(actual?.Id!==id||actual.Name!=='/'+name||actual.Image!==imageId||actual.Config?.Labels?.['io.evimed.campaign-root']!==rootDigest||actual.Config.Labels['io.evimed.campaign-component']!=='relay')throw new Error('campaign_relay_cleanup_identity_unconfirmed');
}
export function assertRelayPhysicalAdmission(actual,expected){
 assertOwnedRelayIdentity(actual,expected);
 const tmpfs=actual.HostConfig?.Tmpfs??{};
 if(actual.Config.User!=='10001:10001'||actual.HostConfig.ReadonlyRootfs!==true||actual.HostConfig.Privileged!==false
  ||!actual.HostConfig.CapDrop?.includes('ALL')||!actual.HostConfig.SecurityOpt?.some(value=>value==='no-new-privileges'||value==='no-new-privileges:true')
  ||actual.Mounts.some(mount=>mount.Type!=='tmpfs'||!['/runtime','/workspace'].includes(mount.Destination)||mount.Source||mount.RW!==false)
  ||Object.keys(tmpfs).sort().join(',')!=='/runtime,/workspace'||Object.values(tmpfs).some(options=>!['ro','noexec','nosuid','nodev','size=1m','mode=0555'].every(option=>options.split(',').includes(option)))
  ||actual.NetworkSettings.Networks[expected.networkName]?.NetworkID!==expected.networkId||!actual.NetworkSettings.Networks.bridge||Object.keys(actual.NetworkSettings.Networks).length!==2)throw new Error('campaign_relay_physical_boundary_unconfirmed');
}
export async function startOwnedCampaignRelay({root,imageId,network,fixtureUrl,gatewayHost}){
 const actual=new URL(fixtureUrl);if(actual.protocol!=='http:'||actual.hostname!=='127.0.0.1'||actual.pathname!=='/'||!actual.port)throw new Error('campaign_actual_fixture_url_required');
 actual.hostname=gatewayHost;const source=campaignRelaySource(actual.href),name='evimed-saas-relay-'+randomUUID(),rootDigest=digest(root);
 await fs.writeFile(path.join(root,name+'-intent.json'),canonicalJson({name,imageId,networkId:network.id,rootDigest,sourceDigest:digest(source),upstreamPinnedUrl:actual.origin})+'\n',{mode:0o400,flag:'wx'});
 const id=await daemon(['create','--pull','never','--name',name,'--label','io.evimed.campaign-root='+rootDigest,'--label','io.evimed.campaign-component=relay',
  '--network',network.name,'--network-alias','assessment-gateway','--read-only','--user','10001:10001','--cap-drop','ALL','--security-opt','no-new-privileges',
  '--tmpfs','/runtime:ro,noexec,nosuid,nodev,size=1m,mode=0555','--tmpfs','/workspace:ro,noexec,nosuid,nodev,size=1m,mode=0555',
  '--memory','128m','--pids-limit','32','--entrypoint','node',imageId,'-e',source]);
 if(!/^[a-f0-9]{64}$/.test(id))throw new Error('campaign_relay_id_unconfirmed');
 const expected={id,name,imageId,rootDigest,networkName:network.name,networkId:network.id};
 const close=async()=>{const observed=JSON.parse(await daemon(['inspect',id]))[0];assertOwnedRelayIdentity(observed,expected);
   const rechecked=JSON.parse(await daemon(['inspect',id]))[0];assertOwnedRelayIdentity(rechecked,expected);await daemon(['rm','-f','-v',id]);
   try{await daemon(['inspect',id]);throw new Error('campaign_relay_physical_join_unconfirmed');}catch(error){if(!/no such (?:object|container)/i.test(error.stderr??''))throw error;}};
 try{await daemon(['network','connect','bridge',id]);await daemon(['start',id]);
  const observed=JSON.parse(await daemon(['inspect',id]))[0];assertRelayPhysicalAdmission(observed,expected);
  return{close,containerId:id,sourceDigest:digest(source),upstreamPinnedUrl:actual.origin,scope:'Trusted fixed-path dual-network transport; no mounts/provider credentials/host-control socket; end-to-end workload authorization remains in real control plane'};
 }catch(error){try{await close();}catch(cleanupError){throw Object.assign(new Error('campaign_relay_cleanup_unconfirmed'),{originalFailure:constructorFailureDetails(error),cleanupFailure:constructorFailureDetails(cleanupError)});}throw error;}
}
/** Each reader independently reads protected deployment, actual image ID, database namespace and current epochs. */
export function createAssessmentCurrentFacts({ getConfig, getDatabase, catalogueId = 'cowork-portable' }) {
  if (typeof getConfig !== 'function' || typeof getDatabase !== 'function') throw new Error('invalid_assessment_fact_sources');
  return async context => {
    const config = getConfig(), database = getDatabase();
    if (!config || !database || !path.isAbsolute(config.dataDir)) throw new Error('assessment_fact_sources_unavailable');
    const fixtureRoot = await assertAssessmentFixtureRoot(config.dataDir);
    const deployment = loadExtensionDeployment(config), entry = deployment.catalogue.find(item => item.id === catalogueId),
      artifact = deployment.admittedArtifacts.find(item => item.id === catalogueId), descriptor = deployment.admittedDescriptors.find(item => item.id === catalogueId);
    if (deployment.status !== 'configured' || !entry || !artifact || !descriptor || entry.executionClass !== 'isolated-tool') throw new Error('assessment_deployment_unavailable');
    const inspected = await execute(config.runtimeContainerBin, ['image','inspect','--format','{{.Id}}',config.runtimeContainerImage],
      { timeout: 5000, maxBuffer: 8192, env: assessmentDockerEnvironment() });
    const image = inspected.stdout.trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('assessment_image_unconfirmed');
    const project = context.project, ownerId = project?.userId, projectId = project?.id,
      actorId = context.binding?.actorId ?? context.actor?.id ?? context.scope?.actorId;
    if (![ownerId, projectId, actorId].every(value => typeof value === 'string' && value)) throw new Error('assessment_subject_unavailable');
    const current = (await database.query(`SELECT current_database() AS namespace,o.created_at::text AS "ownerEpoch",
      a.created_at::text AS "actorEpoch",p.created_at::text AS "projectEpoch" FROM evimed_control.users o
      JOIN evimed_control.projects p ON p.user_id=o.id JOIN evimed_control.users a ON a.id=$3
      WHERE o.id=$1 AND p.id=$2`, [ownerId, projectId, actorId])).rows[0];
    if (!current || !/^evimed_test[a-z0-9_]*$/.test(current.namespace)) throw new Error('assessment_database_subject_unavailable');
    let membershipEpoch=null;
    if(actorId!==ownerId){
      const members=(await database.query(`SELECT s.id,m.role,m.created_at::text AS "createdAt" FROM evimed_vcr.studies s JOIN evimed_vcr.members m ON m.study_id=s.id
        WHERE s.project_id=$1 AND s.user_id=$2 AND s.deleted_at IS NULL AND m.user_id=$3 ORDER BY m.role`,[projectId,ownerId,actorId])).rows;
      if(!members.length||new Set(members.map(member=>member.id)).size!==1||!members.some(member=>roleAllows(member.role,'manage_study')))throw new Error('assessment_subject_unavailable');
      membershipEpoch=JSON.stringify({studyId:members[0].id,members:members.map(({role,createdAt})=>({role,createdAt}))});
    }
    const identity = deploymentProofIdentity(deployment, entry, image), surface = deployment.surfaces.get(entry.id);
    if (!surface) throw new Error('assessment_surface_unavailable');
    return { catalogueId: entry.id, coordinate: canonicalExtensionCoordinate(entry.coordinate), sourceCommit: identity.sourceCommit,
      packageIntegrity: entry.integrity, artifactDigest: artifact.artifactDigest, containedImageDigest: descriptor.imageId,
      adapterDigest: descriptor.adapterDigest, adapterRevision: identity.adapterRevision, runtimeImageDigest: image,
      dshVersion: identity.dshVersion, permissionProfileRevision: identity.permissionProfileRevision, suiteRevision: identity.suiteRevision,
      sourcePolicyDigest: digest(deployment.policy), descriptorDigest: surface.descriptorDigest, fixtureRootDigest: digest(fixtureRoot),
      databaseNamespace: current.namespace, ownerId, actorId, ownerAccountCreatedAt: current.ownerEpoch,
      actorAccountCreatedAt: current.actorEpoch, actorMembershipEpoch:membershipEpoch,installerMembershipEpoch:membershipEpoch,
      projectId, projectCreatedAt: current.projectEpoch, entry, artifact, identity };
  };
}
/** Installed only through createWebApiApp's second trusted JS argument; each app owns its lexical sources. */
export function createPrivateAssessmentFactories({ admission }) {
  let config = null, database = null;
  const currentFacts = createAssessmentCurrentFacts({ getConfig: () => config, getDatabase: () => database });
  const assessmentAuthority = createExtensionAssessmentAuthority({ ...admission, currentFacts });
  return Object.freeze({
    runtimeManagerFactory(currentConfig, hooks) {
      if (config) throw new Error('assessment_factory_reused');
      config = currentConfig;
      if (config.runtimeMode !== 'kernel') throw new Error('assessment_requires_real_kernel');
      return new RuntimeManager(config, { ...hooks, assessmentAuthority });
    },
    extensionIntegrationFactory(dependencies) {
      if (dependencies.config !== config || database) throw new Error('assessment_composition_sources_changed');
      database = dependencies.database;
      const { deployment, runtimeManager, extensions, plugins } = dependencies;
      const identities = async () => deploymentGenerationIdentities(loadExtensionDeployment(config), (await runtimeManager.inspectRuntimeImage()).imageId);
      const qualification = new ExtensionQualification({ root: deployment.qualificationRoot, secret: config.modelGatewaySigningSecret,
        currentIdentity: async entry => deploymentProofIdentity(loadExtensionDeployment(config), entry, (await runtimeManager.inspectRuntimeImage()).imageId),
        surfaces: entry => loadExtensionDeployment(config).surfaces.get(entry.id) });
      const generations = new ExtensionGenerationService(database, {
        config: { dataDir: config.dataDir, skillArtifactsRoot: path.join(config.dataDir, '.openscience', 'skill-library'),
          maxGlobalBytes: 1024 * 1024 * 1024, maxOwnerBytes: 256 * 1024 * 1024, minFreeBytes: 512 * 1024 * 1024 },
        extensionService: extensions, pluginService: plugins, admittedArtifacts: deployment.admittedArtifacts,
        identities, proofAuthority: ({ entry, identity }) => qualification.authority(entry, { identity }), assessmentAuthority });
      return composeExtensionExecution(dependencies, { qualification, generations });
    }
  });
}
/** The controller gets a new reader and fresh fact source, never the web reader or its authority callback. */
export function createPrivateAssessmentController({ config, database, admission }) {
  const currentFacts = createAssessmentCurrentFacts({ getConfig: () => config, getDatabase: () => database });
  const assessmentAuthority = createExtensionAssessmentAuthority({ ...admission, currentFacts });
  const composition = createControllerExtensionComposition({ config, database, deployment: loadExtensionDeployment(config), assessmentAuthority });
  if (!composition) throw new Error('assessment_controller_unavailable');
  const controller = createRuntimeController(config, { extensionTools: composition.tools, extensionGenerationAssessmentAuthority: assessmentAuthority });
  return { controller, composition };
}
/** Separate trusted Node process with closed inherited environment and its own database/authority reader. Same operator UID, not an OS privilege claim. */
export async function startPrivateAssessmentControllerProcess({ overrides, admission }) {
  const child=fork(fileURLToPath(import.meta.url),['--private-controller-child'],{env:assessmentDockerEnvironment(),stdio:['ignore','ignore','ignore','ipc'],serialization:'json'});
  let joined=false,ready=false,cleanupAcknowledged=false;
  const exited=new Promise(resolve=>child.once('exit',()=>{joined=true;resolve();}));
  const waitMessage=(type,timeout)=>new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{cleanup();reject(new Error('private_controller_'+type+'_deadline'));},timeout);
    const onMessage=message=>{if(message?.type===type){cleanup();resolve(message);}else if(message?.type==='failed'){cleanup();reject(Object.assign(new Error('private_controller_failed'),{code:message.code??'private_controller_failed',constructorFrames:message.frames??[]}));}};
    const onExit=()=>{cleanup();reject(new Error('private_controller_unexpected_exit'));};
    const cleanup=()=>{clearTimeout(timer);child.removeListener('message',onMessage);child.removeListener('exit',onExit);};
    child.on('message',onMessage);child.once('exit',onExit);
  });
  const close=async()=>{
    if(joined){if(!cleanupAcknowledged)throw new Error('private_controller_cleanup_unconfirmed');return;}
    const closing=waitMessage('joined',45000);closing.catch(()=>{});
    child.send({type:'close'});
    try{await closing;cleanupAcknowledged=true;await exited;}catch{child.kill('SIGTERM');await Promise.race([exited,new Promise(resolve=>setTimeout(resolve,5000))]);if(!joined)throw new Error('private_controller_physical_join_unconfirmed');throw new Error('private_controller_cleanup_unconfirmed');}
  };
  try{
    const starting=waitMessage('ready',30000);child.send({type:'start',overrides,admission});await starting;ready=true;
    return{close,processId:child.pid,scope:'Independent trusted Node controller/reader/database connection at operator UID; candidate code only in UID10001 containers'};
  }catch(error){if(!ready){child.kill('SIGTERM');await Promise.race([exited,new Promise(resolve=>setTimeout(resolve,5000))]);}throw error;}
}
/** Owned local process entry. Root first seeds ordinary accounts/preparation and signs their measured current epochs. */
export async function openPrivateAssessmentFixture({ overrides, admission }) {
  if (typeof overrides?.modelGatewaySigningSecret !== 'string' || overrides.modelGatewaySigningSecret.length < 32) throw new Error('explicit_fixture_signing_secret_required');
  const localOverrides = { ...overrides, deepseekApiKey: 'assessment-controlled-transport', deepseekApiKeyFile: '' };
  const config = loadConfig(localOverrides), url = new URL(config.databaseUrl);
  if (config.runtimeMode !== 'kernel' || config.runtimeControllerMode !== 'socket' || config.runtimeProvider !== 'docker'
    || !['postgres:','postgresql:'].includes(url.protocol) || !['127.0.0.1','localhost','[::1]'].includes(url.hostname)
    || url.search || url.hash || !/^\/evimed_test[a-z0-9_]*$/.test(url.pathname)
    || config.runtimeControllerSocket !== path.join(config.dataDir, '.openscience', 'runtime-controller.sock')) throw new Error('private_fixture_configuration_refused');
  if (config.deepseekProviderEnabled) {
    const model = new URL(config.deepseekBaseUrl);
    if (model.protocol !== 'http:' || !['127.0.0.1','localhost','[::1]'].includes(model.hostname)
      || config.deepseekApiKey !== 'assessment-controlled-transport') throw new Error('external_model_transport_refused');
  }
  const database = new ControlPlaneDatabase({ ...config, databasePoolMax: 2 });
  let privateController, app, closed = false;
  const close = async () => {
    if (closed) return;
    let failed = false;
    for (const release of [() => app?.close(), () => privateController?.controller.close(), () => privateController?.composition.close(), () => database.close()]) {
      try { await release(); } catch { failed = true; }
    }
    if (failed) throw new Error('private_assessment_cleanup_unconfirmed');
    closed = true;
  };
  try {
    await database.migrate();
    const child=await startPrivateAssessmentControllerProcess({overrides:localOverrides,admission});
    privateController={controller:{close:child.close},composition:{close:async()=>{}}};
    app = createWebApiApp({ ...localOverrides, skillValidationController: new RuntimeControllerClient(config) }, createPrivateAssessmentFactories({ admission }));
    const address = await app.listen(config.port, config.host);
    if (!app.hostedExtensions || !(app.runtimeManager instanceof RuntimeManager)) throw new Error('private_assessment_composition_missing');
    return { app, baseUrl: `http://127.0.0.1:${address.port}`, close, qualification: 'unverified',controllerProcess:child };
  } catch (error) { await close(); throw error; }
}
/** Fresh ordinary composition: no assessment authority, factory or admission record is created or supplied. */
export async function openOrdinaryQualificationFixture({overrides}){
  const config=loadConfig(overrides);
  if(config.runtimeMode!=='kernel'||config.runtimeControllerMode!=='socket'||config.runtimeProvider!=='docker'
    ||typeof overrides.modelGatewaySigningSecret!=='string'||overrides.modelGatewaySigningSecret.length<32
    ||config.deepseekApiKey!=='assessment-controlled-transport'||new URL(config.deepseekBaseUrl).protocol!=='http:'
    ||!['localhost','127.0.0.1','[::1]'].includes(new URL(config.deepseekBaseUrl).hostname))throw new Error('ordinary_fixture_configuration_refused');
  let child,app,closed=false;
  const close=async()=>{if(closed)return;let failed=false;for(const release of [()=>app?.close(),()=>child?.close()])try{await release();}catch{failed=true;}if(failed)throw new Error('ordinary_fixture_cleanup_unconfirmed');closed=true;};
  try{child=await startPrivateAssessmentControllerProcess({overrides,admission:null});
    app=createWebApiApp({...overrides,skillValidationController:new RuntimeControllerClient(config)});
    const address=await app.listen(config.port,config.host);if(!app.hostedExtensions)throw new Error('ordinary_qualification_integration_missing');
    return{app,baseUrl:`http://127.0.0.1:${address.port}`,close,controllerProcess:child,composition:'default-qualified-only'};
  }catch(error){await close();throw error;}
}
if(process.argv[1]===fileURLToPath(import.meta.url)&&process.argv[2]==='--private-controller-child'&&process.argv.length===3){
  if(typeof process.send!=='function')throw new Error('private_controller_requires_owned_ipc');
  let database=null,composition=null,controller=null,started=false,closing=false;
  const close=async()=>{
    if(closing)return;closing=true;let failed=false;
    for(const release of [()=>controller?.close(),()=>composition?.close(),()=>database?.close()])try{await release();}catch{failed=true;}
    if(process.connected){process.send({type:failed?'failed':'joined'});process.disconnect();}process.exitCode=failed?1:0;
  };
  process.on('SIGTERM',()=>{void close();});process.on('SIGINT',()=>{void close();});
  process.on('disconnect',()=>{void close();});
  process.on('message',async message=>{
    try{
      if(message?.type==='close'){await close();return;}
      if(message?.type!=='start'||started||Object.keys(message).sort().join(',')!=='admission,overrides,type')throw new Error('private_controller_ipc_refused');
      started=true;const config=loadConfig(message.overrides);
      if(config.runtimeControllerMode!=='socket'||config.runtimeMode!=='kernel'||message.admission!==null&&message.admission.expectedOwnerUid!==process.getuid())throw new Error('private_controller_setup_refused');
      database=new ControlPlaneDatabase({...config,databasePoolMax:2});await database.migrate();
      if(message.admission===null){composition=createControllerExtensionComposition({config,database,deployment:loadExtensionDeployment(config)});if(!composition)throw new Error('ordinary_controller_unavailable');controller=createRuntimeController(config,{extensionTools:composition.tools});}
      else{const built=createPrivateAssessmentController({config,database,admission:message.admission});composition=built.composition;controller=built.controller;}
      await controller.listen();
      if(!process.connected)throw new Error('private_controller_parent_disconnected');process.send({type:'ready',processId:process.pid});
    }catch(error){if(process.connected)process.send({type:'failed',...constructorFailureDetails(error)});await close();}
  });
}
