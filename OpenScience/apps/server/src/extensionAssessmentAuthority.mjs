import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { canonicalJson, canonicalExtensionCoordinate, extensionProofAdapterRevision } from '@evimed/domain';
import { HttpError, openScopedFileNoFollow, readStableFileHandle } from './security.mjs';

export const EXTENSION_ASSESSMENT_DOMAIN = 'evimed-extension-assessment-admission-v1';
const authorities = new WeakSet();
const denied = () => new HttpError(403, 'extension_access_denied', 'The assessment admission is unavailable.');
const factKeys = ['catalogueId','coordinate','sourceCommit','packageIntegrity','artifactDigest','containedImageDigest','adapterDigest','adapterRevision','runtimeImageDigest','dshVersion','permissionProfileRevision','suiteRevision','sourcePolicyDigest','descriptorDigest','fixtureRootDigest','databaseNamespace','ownerId','actorId','ownerAccountCreatedAt','actorAccountCreatedAt','actorMembershipEpoch','installerMembershipEpoch','projectId','projectCreatedAt'];
const nullableFacts=new Set(['sourceCommit','actorMembershipEpoch','installerMembershipEpoch']);
const digest = value => 'sha256:' + createHash('sha256').update(canonicalJson(value)).digest('hex');
/** Constructor-only authority objects cannot be reconstructed from serialized flags. @param {any} value */
export function assertExtensionAssessmentAuthority(value) { if (value !== null && !authorities.has(value)) throw denied(); }
/** The independent controller constructs its own reader with its pinned verifier key and protected current facts.
 * @param {{root:string,recordPath:string,publicKey:any,currentFacts:(context:any)=>Promise<any>,now?:()=>number,expectedOwnerUid?:number}} options */
export function createExtensionAssessmentAuthority({ root, recordPath, publicKey, currentFacts, now = Date.now, expectedOwnerUid = process.getuid?.() }) {
  if (!Number.isSafeInteger(expectedOwnerUid) || expectedOwnerUid < 0 || typeof currentFacts !== 'function' || typeof now !== 'function' || !path.isAbsolute(root) || !path.isAbsolute(recordPath)) throw denied();
  const key = createPublicKey(publicKey);
  if (key.asymmetricKeyType !== 'ed25519') throw denied();
  const protectedRoot = path.resolve(root), protectedRecord = path.resolve(recordPath);
  if(protectedRoot!==root || protectedRecord!==recordPath || !protectedRecord.startsWith(protectedRoot+path.sep))throw denied();
  const assertProtectedParents = async () => {
    const rootStat=await fs.lstat(protectedRoot);
    if(!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid!==expectedOwnerUid || (rootStat.mode&0o7777)!==0o700 || await fs.realpath(protectedRoot)!==protectedRoot)throw denied();
    let directory=path.dirname(protectedRecord);
    while(directory){
      const stat=await fs.lstat(directory), inside=directory===protectedRoot||directory.startsWith(protectedRoot+path.sep);
      if(!stat.isDirectory() || stat.isSymbolicLink() || (inside ? stat.uid!==expectedOwnerUid || (stat.mode&0o7777)!==0o700 : ![0,expectedOwnerUid].includes(stat.uid) || (stat.mode&0o022)!==0 && !(stat.uid===0&&(stat.mode&0o1000)!==0)))throw denied();
      const parent=path.dirname(directory);if(parent===directory)break;directory=parent;
    }
  };
  const read = async () => {
    await assertProtectedParents();
    const file = await openScopedFileNoFollow(root, recordPath);
    try {
      if (file.stat.uid!==expectedOwnerUid || (file.stat.mode & 0o7777) !== 0o400 || file.stat.size > 1024 * 1024) throw denied();
      const bytes = await readStableFileHandle(file.handle, file.stat);await assertProtectedParents();
      const envelope = JSON.parse(bytes.toString());
      if (Object.keys(envelope).sort().join(',') !== 'domain,payload,signature' || envelope.domain !== EXTENSION_ASSESSMENT_DOMAIN
        || canonicalJson(envelope) + '\n' !== bytes.toString() || envelope.payload?.schemaVersion !== 1
        || Object.keys(envelope.payload).sort().join(',') !== 'admissions,schemaVersion' || !Array.isArray(envelope.payload.admissions)
        || !verify(null, Buffer.from(canonicalJson({ domain: envelope.domain, payload: envelope.payload })), key, Buffer.from(envelope.signature, 'base64'))) throw denied();
      return { envelope, assessmentAdmissionDigest: digest(envelope) };
    } finally { await file.handle.close(); }
  };
  const admit = async context => {
    const { envelope, assessmentAdmissionDigest } = await read(), facts = await currentFacts(context);
    if(!facts||factKeys.some(field=>!Object.hasOwn(facts,field)||facts[field]===undefined))throw denied();
    const matches = envelope.payload.admissions.filter(record => factKeys.every(field => canonicalJson(record[field] ?? null) === canonicalJson(facts?.[field] ?? null)));
    if (matches.length !== 1) throw denied();
    const record = matches[0];
    if (Object.keys(record).sort().join(',') !== [...factKeys,'assessmentId','issuedAt','expiresAt','allowedOperations'].sort().join(',')
      || factKeys.some(field => record[field] === undefined || (record[field] === null && !nullableFacts.has(field)))
      || (record.actorId===record.ownerId ? record.actorMembershipEpoch!==null||record.installerMembershipEpoch!==null
        : typeof record.actorMembershipEpoch!=='string'||!record.actorMembershipEpoch||typeof record.installerMembershipEpoch!=='string'||!record.installerMembershipEpoch)
      || typeof record.assessmentId !== 'string' || !record.assessmentId || !Number.isFinite(Date.parse(record.issuedAt))
      || !Number.isFinite(Date.parse(record.expiresAt)) || Date.parse(record.issuedAt) > now() || Date.parse(record.expiresAt) <= now()
      || Date.parse(record.expiresAt) <= Date.parse(record.issuedAt) || !Array.isArray(record.allowedOperations)
      || record.allowedOperations.length === 0 || new Set(record.allowedOperations).size !== record.allowedOperations.length
      || record.allowedOperations.some(operation => !['doc_read','doc_write'].includes(operation))) throw denied();
    const { entry, artifact, identity, scope } = context;
    if (!entry || !artifact || !identity || !scope || entry.executionClass !== 'isolated-tool'
      || record.catalogueId !== entry.id || record.coordinate !== canonicalExtensionCoordinate(entry.coordinate)
      || record.packageIntegrity !== entry.integrity || record.artifactDigest !== artifact.artifactDigest
      || record.sourceCommit !== identity.sourceCommit || record.adapterRevision !== identity.adapterRevision
      || record.runtimeImageDigest !== identity.runtimeImageDigest || record.dshVersion !== identity.dshVersion
      || record.permissionProfileRevision !== identity.permissionProfileRevision || record.suiteRevision !== identity.suiteRevision
      || ['ownerId','actorId','ownerAccountCreatedAt','actorAccountCreatedAt','actorMembershipEpoch','projectId','projectCreatedAt'].some(field => record[field] !== scope[field])
      || (context.operation !== undefined && !record.allowedOperations.includes(context.operation))) throw denied();
    return Object.freeze({ assessmentAdmissionDigest });
  };
  const verifyManifest = async (manifest, project, options = {}) => {
    for(const binding of manifest.bindings.installations){
      if(!Object.hasOwn(binding,'assessmentAdmissionDigest'))continue;
      const pins=manifest.projection.plugins.filter(plugin=>plugin.extensionId===binding.extensionId&&Object.hasOwn(plugin,'assessmentAdmissionDigest'));
      if(pins.length!==1||pins[0].assessmentAdmissionDigest!==binding.assessmentAdmissionDigest)throw denied();
    }
    for (const plugin of manifest.projection.plugins) {
      if (!Object.hasOwn(plugin, 'assessmentAdmissionDigest')) continue;
      const binding = manifest.bindings.installations.find(item => item.extensionId === plugin.extensionId);
      if (!binding || binding.assessmentAdmissionDigest !== plugin.assessmentAdmissionDigest || Object.hasOwn(binding,'receiptDigest')
        || Object.hasOwn(plugin,'compatibility') || Object.hasOwn(plugin,'sourceDocumentId')
        || plugin.connectionRefs.length || Object.keys(plugin.settings).length || manifest.scope.ownerId !== project.userId || manifest.scope.projectId !== project.id) throw denied();
      const context = { manifest, project, plugin, binding, operation: options.operation };
      const facts = await currentFacts(context);
      const sha = value => createHash('sha256').update(value).digest('hex');
      if(plugin.extensionId!==facts.catalogueId || canonicalExtensionCoordinate(plugin.coordinate)!==facts.coordinate
        || plugin.integrity!==facts.packageIntegrity || plugin.artifactDigest!==facts.artifactDigest
        || plugin.adapterRevision!==facts.adapterRevision || plugin.executionClass!=='isolated-tool'
        || (plugin.coordinate.kind==='github'?plugin.coordinate.commit:null)!==facts.sourceCommit
        || manifest.identity.baseRuntimeImageDigest!==facts.runtimeImageDigest
        || manifest.identity.permissionProfileRevision!==facts.permissionProfileRevision
        || extensionProofAdapterRevision(facts.artifact.adapterRevision,manifest.identity.adapterRevision,sha)!==facts.adapterRevision
        || manifest.identity.ownerId!==manifest.scope.ownerId || manifest.identity.projectId!==manifest.scope.projectId
        || binding.coordinate!==facts.coordinate || binding.integrity!==plugin.integrity || binding.artifactDigest!==plugin.artifactDigest
        || binding.configDigest!==plugin.configDigest || manifest.scope.actorId!==binding.actorId
        || binding.actorMembershipEpoch!==facts.installerMembershipEpoch
        || ['ownerId','actorId','ownerAccountCreatedAt','actorAccountCreatedAt','actorMembershipEpoch','projectId','projectCreatedAt'].some(field=>manifest.scope[field]!==facts[field]))throw denied();
      const admission = await admit({ ...context, entry: facts.entry, artifact: facts.artifact, identity: facts.identity,
        scope: { ...manifest.scope, actorId: binding.actorId, actorAccountCreatedAt: facts.actorAccountCreatedAt } });
      if (admission.assessmentAdmissionDigest !== plugin.assessmentAdmissionDigest) throw denied();
    }
  };
  const authority = Object.freeze({ admit, verifyManifest }); authorities.add(authority); return authority;
}
