import path from 'node:path';
import {assertExtensionAssessmentAdmission} from './extensionAssessmentAdmission.mjs';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { canonicalJson } from '@evimed/domain';
import { ControlPlaneDatabase } from './controlPlaneDatabase.mjs';
import { ProductJobs } from './productStore.mjs';
import { ExtensionOperationGrants } from './extensionOperationGrants.mjs';
import { ExtensionToolController, extensionExecutionIdentity } from './extensionToolController.mjs';
import { ExtensionQualification } from './extensionQualification.mjs';
import { deploymentGenerationIdentities, deploymentProofIdentity } from './extensionDeployment.mjs';
import { verifyExtensionGeneration, extractExtensionGenerationOperationIdentity } from './extensionGenerationService.mjs';
import { HttpError } from './security.mjs';

const execute = promisify(execFile);
const refused = () => new HttpError(403, 'extension_access_denied', 'The extension attempt is unavailable.');

/** Privileged operations read only control-plane-issued signed requests and
 * the same durable job/epoch/generation records the web boundary owns.
 * Native caller facts are established before that boundary issues a grant.
 * @param {{config:any,deployment:any,database?:any,assessmentAdmission?:any}} dependencies */
export function createControllerExtensionComposition({ config, deployment, database: supplied = null, assessmentAdmission = null }) {
  if (deployment.status !== 'configured' || !config.databaseUrl || typeof config.modelGatewaySigningSecret !== 'string'
    || config.modelGatewaySigningSecret.length < 32) return null;
  if(assessmentAdmission)assertExtensionAssessmentAdmission(assessmentAdmission,config);
  const database = supplied ?? new ControlPlaneDatabase({ ...config, databasePoolMax: 2 });
  const jobs = new ProductJobs(database);
  const imageId = async () => {
    const result = await execute(config.runtimeContainerBin, ['image', 'inspect', '--format', '{{.Id}}', config.runtimeContainerImage],
      { timeout: 5000, maxBuffer: 8192 });
    return result.stdout.trim();
  };
  const qualification = new ExtensionQualification({ root: deployment.qualificationRoot, secret: config.modelGatewaySigningSecret,
    currentIdentity: async entry => deploymentProofIdentity(deployment, entry, await imageId()), surfaces: entry => deployment.surfaces.get(entry.id) });
  /** Current protected facts, independently of anything in an HTTP body.
   * @param {any} scope @param {any} request */
  const authorize = async (scope, request) => {
    try {
      await database.migrate();
      const job = (await database.query(`SELECT payload FROM evimed_product.jobs WHERE user_id=$1 AND kind='extension-execute'
        AND status='running' AND lease_expires_at>clock_timestamp() AND payload->'scope'=$2::jsonb
        AND payload->'request'=$3::jsonb AND payload->>'cancelRequested'='false' LIMIT 2`, [scope.userId, canonicalJson(scope), canonicalJson(request)])).rows;
      if (job.length !== 1 || !job[0].payload.dispatch || job[0].payload.auth?.runtimeGeneration !== scope.runtimeGeneration) return false;
      const current = (await database.query(`SELECT u.created_at::text AS "accountCreatedAt",p.created_at::text AS "projectCreatedAt",d.payload
        FROM evimed_control.users u JOIN evimed_control.projects p ON p.user_id=u.id
        JOIN evimed_product.documents d ON d.user_id=u.id AND d.project_id=p.id AND d.kind='extension-generation'
          AND d.id=$3 AND d.deleted_at IS NULL WHERE u.id=$1 AND p.id=$2`,
      [scope.userId, scope.projectId, `extensions:generation-state:${scope.projectId}`])).rows[0];
      if (!current || current.accountCreatedAt !== scope.accountCreatedAt || current.projectCreatedAt !== scope.projectCreatedAt
        || !['effective', 'rolled-back'].includes(current.payload.phase) || current.payload.runtimeGeneration !== scope.runtimeGeneration) return false;
      const candidate = current.payload.effective;
      if (!candidate || candidate.scope.ownerAccountCreatedAt !== scope.accountCreatedAt || candidate.scope.projectCreatedAt !== scope.projectCreatedAt) return false;
      const actualImage = await imageId(), identities = deploymentGenerationIdentities(deployment, actualImage);
      if (['baseRuntimeImageDigest', 'adapterRevision', 'permissionProfileRevision'].some(key => candidate.identity[key] !== identities[key])) return false;
      const manifest = await verifyExtensionGeneration(config, { id: scope.projectId, userId: scope.userId }, candidate.reference, assessmentAdmission);
      const observed = extractExtensionGenerationOperationIdentity(manifest, { userId: scope.userId, ownerId: scope.userId,
        projectId: scope.projectId, accountCreatedAt: scope.accountCreatedAt, projectCreatedAt: scope.projectCreatedAt,
        runtimeGeneration: scope.runtimeGeneration }, scope.descriptorId);
      if (canonicalJson(observed) !== canonicalJson(scope)) return false;
      const pin = manifest.projection.plugins.find(item => item.extensionId === scope.descriptorId && item.enabled);
      if (!pin || pin.connectionRefs.length !== 0) return false;
      const entry = deployment.catalogue.find(item => item.id === scope.descriptorId), artifact = deployment.admittedArtifacts.find(item => item.id === scope.descriptorId);
      if (!entry || !artifact || artifact.artifactDigest !== scope.artifactDigest) return false;
      const installation = manifest.bindings.installations.find(item => item.installationId === scope.installationId && item.installationRevision === scope.installationRevision);
      if (!installation || installation.actorId !== scope.userId) return false;
      const prepared = await jobs.get(installation.actorId, installation.prepareJobId);
      if (prepared?.status !== 'succeeded' || prepared.kind !== 'extension-prepare' || prepared.result?.artifactDigest !== scope.artifactDigest
        || prepared.payload.accountCreatedAt !== scope.accountCreatedAt || prepared.payload.installationId !== scope.installationId
        || prepared.payload.installationRevision !== scope.installationRevision || prepared.result.installationId !== scope.installationId
        || prepared.result.installationRevision !== scope.installationRevision || prepared.result.integrity !== pin.integrity) return false;
      if(assessmentAdmission)return Boolean(pin.assessmentAdmissionDigest)&&!pin.receiptDigest&&await assessmentAdmission.verifyManifest(config,manifest);
      const proof = await qualification.authority(entry);
      return proof?.receipt.receiptDigest === pin.receiptDigest;
    } catch { return false; }
  };
  const grants = new ExtensionOperationGrants({ dataDir: config.dataDir, secret: config.modelGatewaySigningSecret, authorize,
    withAdmission: () => { throw refused(); } });
  /** @param {string} operationId @param {any} request @param {any} expected @param {any} attempt */
  const resolveOperation = async (operationId, request, expected, attempt) => {
    const identity = extensionExecutionIdentity(attempt), job = await jobs.get(identity.userId, identity.jobId);
    if (!job || job.kind !== 'extension-execute' || job.status !== 'running' || job.leaseToken !== identity.leaseToken
      || job.attempts !== identity.attempts || Date.parse(job.leaseExpiresAt) <= Date.now() || job.payload.cancelRequested
      || job.payload.operationId !== operationId || canonicalJson(job.payload.dispatch) !== canonicalJson(identity)
      || canonicalJson(job.payload.request) !== canonicalJson(request)) throw refused();
    const verified = await grants.verify(operationId, request, job.payload.scope);
    if (verified.scope.descriptorId !== expected.descriptorId || verified.scope.artifactDigest !== expected.artifactDigest) throw refused();
    return verified.scope;
  };
  const tools = new ExtensionToolController({ admittedDescriptors: deployment.admittedDescriptors,
    stateRoot: path.join(config.dataDir, '.openscience', 'extension-controller'),
    dataDir: config.dataDir, runtimeDataVolume: config.runtimeDataVolume,
    adapterRoot: fileURLToPath(new URL('../../../scripts/runtime/extensions/cowork/', import.meta.url)),
    inputRoot: grants.root, dockerBin: config.runtimeContainerBin, resolveOperation,
    resolvePreparation: async (identity, descriptor) => {
      await database.migrate();
      const located = (await database.query("SELECT user_id FROM evimed_product.jobs WHERE id=$1 AND kind='extension-prepare'", [identity.jobId])).rows[0];
      if (!located) throw refused();
      const job = await jobs.get(located.user_id, identity.jobId);
      if (!job || job.status !== 'running' || job.leaseToken !== identity.leaseToken || job.attempts !== identity.attempts
        || Date.parse(job.leaseExpiresAt) <= Date.now() || job.payload.installationId !== identity.installationId
        || job.payload.installationRevision !== identity.installationRevision || job.payload.accountCreatedAt !== identity.accountCreatedAt
        || job.payload.catalogueId !== descriptor.id || canonicalJson(job.payload.projectTarget ?? null) !== canonicalJson(identity.projectTarget)) throw refused();
      const current = (await database.query(`SELECT u.created_at::text AS epoch,d.revision,d.payload FROM evimed_control.users u
        JOIN evimed_product.documents d ON d.user_id=u.id AND d.kind='extension-installation' AND d.id=$2 AND d.deleted_at IS NULL WHERE u.id=$1`,
      [job.userId, identity.installationId])).rows[0];
      if (!current || current.epoch !== identity.accountCreatedAt || current.revision !== identity.installationRevision
        || current.payload.prepareJobId !== job.id || current.payload.integrity !== descriptor.integrity
        || canonicalJson(current.payload.coordinate) !== canonicalJson(descriptor.coordinate)) throw refused();
      if (identity.projectTarget) {
        if (identity.projectTarget.ownerId !== job.userId) throw refused();
        const project = (await database.query("SELECT created_at::text AS epoch FROM evimed_control.projects WHERE user_id=$1 AND id=$2", [job.userId, identity.projectTarget.projectId])).rows[0];
        if (!project || project.epoch !== identity.projectTarget.projectCreatedAt) throw refused();
      }
      return { identity, descriptorId: descriptor.id, artifactDigest: descriptor.artifactDigest };
    },
    canRetireAttempt: async identity => {
      const row = (await database.query("SELECT user_id,status,lease_token,attempts,payload FROM evimed_product.jobs WHERE id=$1", [identity.jobId])).rows[0];
      if (!row) return true;
      if (!['succeeded', 'failed', 'canceled'].includes(row.status) || row.lease_token || row.attempts < identity.attempts) return false;
      if (identity.operationId) return row.user_id === identity.userId && canonicalJson(row.payload.dispatch) === canonicalJson(identity);
      return row.payload.installationId === identity.installationId && row.payload.installationRevision === identity.installationRevision
        && row.payload.accountCreatedAt === identity.accountCreatedAt;
    },
    resolveInputSnapshot: async (operationId, resourceId, attempt) => {
      const identity = extensionExecutionIdentity(attempt), job = await jobs.get(identity.userId, identity.jobId);
      if (!job) throw refused();
      await resolveOperation(operationId, job.payload.request, identity, identity);
      return grants.inputSnapshot(operationId, job.payload.request, resourceId, job.payload.scope);
    },
  });
  return { tools, close: async () => { await tools.close(); if (!supplied) await database.close(); } };
}
